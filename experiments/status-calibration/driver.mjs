// Original one-attempt manual QR, initialization and fixed-command calibration.
// Calibration hold is bounded to 24 hours; stop remains available, no auto-relogin.
// Authentication event is observed, never converted into a current-online proof.
// No business bridge, message sends, ticket imports, debugger or eval control.
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {CalibrationControl,CalibrationOperationError} from './calibration-control.mjs';
import { BOT_UIN } from '../../src/config/account.mjs';
const cfg=JSON.parse(fs.readFileSync('/input/login.json','utf8'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for(const m of cfg.mounts)assert.equal(hash(m.target),m.sha256);
const namespaces=Object.fromEntries(['user','net','mnt','pid','ipc'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));
const mountFlags=new Map(fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>{const f=line.split(' ');return [f[4],f[5].split(',')];}));
const denied=fn=>{try{fn();return false;}catch(e){return ['EROFS','EACCES','ETXTBSY'].includes(e.code);}};
const checks={
  oldRootsAbsent:['/mnt','/home','/root'].every(p=>!fs.existsSync(p)),
  rootReadOnly:denied(()=>fs.writeFileSync('/unexpected-write','x')),
  inputsReadOnly:[...cfg.mounts.map(m=>m.target),'/input/login.json'].every(p=>mountFlags.get(p)?.includes('ro')&&denied(()=>{const fd=fs.openSync(p,'a');fs.closeSync(fd);})),
  nonNetworkNamespacesChanged:['user','mnt','pid','ipc'].every(n=>namespaces[n]!==cfg.parentNamespaces[n]),
  networkSharedForAuthorizedLogin:namespaces.net===cfg.parentNamespaces.net,
  capabilitiesDropped:/^CapEff:\s+0+$/m.test(fs.readFileSync('/proc/self/status','utf8')),
  controlDirectoryReadOnly:mountFlags.get('/control')?.includes('ro')&&denied(()=>fs.writeFileSync('/control/unapproved-write','x')),
  environmentCleared:['LD_PRELOAD','LD_AUDIT','LD_LIBRARY_PATH','LD_BIND_NOW','NODE_OPTIONS','NODE_PATH','HTTP_PROXY','HTTPS_PROXY'].every(k=>process.env[k]===undefined),
};
assert(Object.values(checks).every(Boolean));
fs.writeFileSync('/output/preflight.json',JSON.stringify({checks,namespaces},null,2),{flag:'wx',mode:0o600});
if(cfg.preflightOnly)process.exit(0);
let state={phase:'loading',at:new Date().toISOString(),expectedAccount:BOT_UIN,businessOnlineVerified:false,qrRequests:0,sessionInitAttempts:0,sessionGeneration:1},finished=false,authenticated=false,qrTimer,connectTimer,holdTimer,initTimer,readyPoll;
let authObservedAt=-Infinity,initAccepted=false,initStarted=false;
let calibration,profileListenerHandle,lastCommandFingerprint=null;
const recentOnline={};
assert(typeof cfg.runId==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(cfg.runId));
function save(phase,extra={}){
  state={...state,...extra,phase,at:new Date().toISOString()};
  fs.writeFileSync('/output/status.next',JSON.stringify(state),{mode:0o600});
  fs.renameSync('/output/status.next','/output/status.json');
}
function stop(phase,extra={}){if(finished)return;finished=true;calibration?.close();for(const timer of [qrTimer,connectTimer,holdTimer,initTimer,readyPoll])clearTimeout(timer);save(phase,{failedDuring:state.phase,sessionGeneration:state.sessionGeneration+1,businessOnlineVerified:false,control:calibration?.snapshot()??null,...extra});setImmediate(()=>process.exit(['closed','connection-observed-no-qr'].includes(phase)?0:2));}
process.on('uncaughtException',()=>stop('native-or-driver-exception'));
process.on('unhandledRejection',()=>stop('native-or-driver-rejection'));
process.on('SIGTERM',()=>stop('closed'));
const loader={exports:{}};process.dlopen(loader,'/input/loader.node',os.constants.dlopen.RTLD_NOW|os.constants.dlopen.RTLD_LOCAL);
assert.deepEqual(loader.exports,{providerLoaded:true});
const module={exports:{}};process.dlopen(module,'/app/wrapper.node',os.constants.dlopen.RTLD_LAZY|os.constants.dlopen.RTLD_LOCAL);
const w=module.exports;
save('registering-misc');
const misc=w.NodeIO3MiscService.get();
misc.addO3MiscListener({getOnAmgomDataPiece(){ /* Fixed reference declares a notification without a consumed return. */ }});
save('creating-engine');
const engine=w.NodeIQQNTWrapperEngine.get();
const startup=w.NodeIQQNTStartupSessionWrapper.create();
const session=w.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
// Retain native owners for this one process, never reconstruct/import a session ticket.
globalThis.loginOwners={misc,engine,startup,session};
const callbacks={};
for(const name of ['onLog','onGetSrvCalTime','onShowErrUITips','onInstallFinished','onUpdateGeneralFlag','onGetOfflineMsg'])callbacks[name]=()=>{};
// No invented value for callbacks whose return contract has not been calibrated.
for(const name of ['fixPicImgType','getAppSetting'])callbacks[name]=()=>{stop('unresolved-global-callback',{callback:name});};
save('initializing-engine');
engine.initWithDeskTopConfig({base_path_prefix:'',platform_type:5,app_type:4,app_version:'3.2.35-54395',os_version:os.version(),use_xlog:true,
  qua:'V1_LNX_NQ_3.2.35_54395_GW_B',global_path_config:{desktopGlobalPath:'/output/global'},thumb_config:{maxSide:324,minSide:48,longLimit:6,density:2}},callbacks);
if(finished)process.exit(2);
save('initializing-login');
const login=w.NodeIKernelLoginService.get();globalThis.loginOwners.login=login;
login.initConfig({machineId:'',appid:'537403759',platVer:'Linux '+os.release(),commonPath:'/output/global',clientVer:'3.2.35-54395',hostName:os.hostname(),externalVersion:false});
// Bounded type-only diagnostics; never log callback values, UID, GUID or messages.
function shape(value){
  if(value===null)return {type:'null'};
  if(Array.isArray(value))return {type:'array',length:Math.min(value.length,33)};
  if(typeof value!=='object')return {type:typeof value};
  const fields=[];let otherFieldCount=0;
  const allowed=new Set(['is_init','is_report','result','retCode','errCode','code','status','extStatus','batteryStatus','offlineType','activeState','state','uin','uid','sessionId','online','authenticated','errorType','errorCode']);
  for(const key of Object.getOwnPropertyNames(value)){
    // Unknown dictionary keys may themselves be identifiers or tokens.
    if(!allowed.has(key)){otherFieldCount=Math.min(otherFieldCount+1,100000);continue;}
    const d=Object.getOwnPropertyDescriptor(value,key);
    fields.push({name:key,type:Object.hasOwn(d,'value')?(d.value===null?'null':Array.isArray(d.value)?'array':typeof d.value):'accessor'});
  }
  return {type:'object',fields,otherFieldCount};
}
function observe(name,value){
  if(finished)return;
  const observations={...(state.observations??{})};
  observations[name]={count:Math.min((observations[name]?.count??0)+1,100000),shape:shape(value)};
  save(state.phase,{observations});
}
// Raw native values never enter disk reports. Known identity fields yield only
// equality booleans; unknown dictionary keys and all arbitrary strings are omitted.
function redact(value){
  const summary=shape(value),known={};
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    for(const key of ['status','extStatus','batteryStatus','offlineType','activeState','result','retCode','errCode','code','online','authenticated']){
      const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))continue;
      if(typeof d.value==='boolean'||(typeof d.value==='number'&&Number.isSafeInteger(d.value)))known[key]=d.value;
    }
    for(const key of ['uin','user_id','uid']){
      const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))continue;
      const expected=key==='uid'?globalThis.loginOwners.authenticatedIdentity?.uid:BOT_UIN;
      known[key+'MatchesExpected']=(typeof d.value==='string'||typeof d.value==='number')&&expected!==undefined&&String(d.value)===expected;
    }
  }
  return {shape:summary,known};
}
function recordOnline(name,value){
  if(finished)return;
  recentOnline[name]={generation:state.sessionGeneration,observedAtMonotonicMs:performance.now(),value:redact(value)};
  observe(name,value);
}
function currentSession(context,sideEffectStarted=false){
  const fail=()=>{if(sideEffectStarted)throw new Error('Registration outcome cannot be confirmed');throw new CalibrationOperationError('not_started');};
  if(finished||!authenticated||state.phase!=='session-ready-observed'||context.signal.aborted)return fail();
  const id=session.getSessionId();
  if(finished||context.signal.aborted||id!==globalThis.loginOwners.nativeSessionId){calibration.invalidate();return fail();}
}
function methodNames(service){
  const names=new Set();let object=service;
  for(let depth=0;object&&depth<4;depth++,object=Object.getPrototypeOf(object)){
    for(const key of Object.getOwnPropertyNames(object)){
      if(names.size>=512)throw new CalibrationOperationError('not_started');
      if(!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)||key==='constructor')continue;
      const descriptor=Object.getOwnPropertyDescriptor(object,key);
      if(descriptor&&Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='function')names.add(key);
    }
  }
  return [...names].sort();
}
calibration=new CalibrationControl({runId:cfg.runId,timeoutMs:5000,operations:{
  async inspect_service_methods(context){currentSession(context);const msg=session.getMsgService();currentSession(context);const profile=session.getProfileService();currentSession(context);return {msg:methodNames(msg),profile:methodNames(profile)};},
  async register_online(context){
    currentSession(context);const msg=session.getMsgService();currentSession(context);
    if(typeof msg?.setStatus!=='function')throw new CalibrationOperationError('not_started');
    const result=await msg.setStatus({status:10,extStatus:0,batteryStatus:0,customStatus:{faceId:'',wording:'',faceType:'1'}});
    currentSession(context,true);
    const code=result&&typeof result==='object'?Object.getOwnPropertyDescriptor(result,'result')?.value:undefined;
    if(typeof code!=='number'||!Number.isFinite(code))throw new Error('Registration has no explicit result');
    if(code!==0)throw new CalibrationOperationError('rejected');
    return redact(result); // ACK is not an online proof.
  },
  async read_self_status(context){currentSession(context);const profile=session.getProfileService();currentSession(context);if(typeof profile?.getSelfStatus!=='function')throw new CalibrationOperationError('not_started');const value=await profile.getSelfStatus();currentSession(context);return redact(value);},
  async read_online_status(context){currentSession(context);return {events:{...recentOnline},onlineProof:false};},
}});
async function pollControl(){
  if(finished)return;
  const file='/control/command.json',s=fs.lstatSync(file,{throwIfNoEntry:false});if(!s)return;
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<2||s.size>4096){stop('invalid-control-file');return;}
  const bytes=fs.readFileSync(file),fingerprint=`${s.ino}:${s.mtimeMs}:`+createHash('sha256').update(bytes).digest('hex');if(fingerprint===lastCommandFingerprint)return;
  const after=fs.lstatSync(file);if(after.ino!==s.ino||after.dev!==s.dev||after.size!==s.size||after.mtimeMs!==s.mtimeMs)return;
  let request;try{request=JSON.parse(bytes);}catch{lastCommandFingerprint=fingerprint;save(state.phase,{controlInputRejected:true});return;}
  lastCommandFingerprint=fingerprint;
    const response=await calibration.execute(request);if(finished)return;
    fs.writeFileSync('/output/control-result.next',JSON.stringify(response),{mode:0o600});fs.renameSync('/output/control-result.next','/output/control-result.json');
    save(state.phase,{control:calibration.snapshot()});
    if(response.accepted&&request.command==='stop')stop('closed');
}
setInterval(()=>{void pollControl();},250);
function initializationStillValid(){
  if(finished||!authenticated)return false;
  if(performance.now()-authObservedAt>30000){stop('authentication-event-too-old-for-init');return false;}
  return true;
}
function completeReady(){
  if(finished||!initStarted||!initAccepted||state.phase==='session-ready-observed')return;
  if(performance.now()-authObservedAt>30000){stop('authentication-event-too-old-for-init');return;}
  const msgService=session.getMsgService();
  if(!initializationStillValid())return;
  if(msgService===null||msgService===undefined){readyPoll=setTimeout(completeReady,50);return;}
  const nativeId=typeof session.getSessionId==='function'?session.getSessionId():null;
  if(!initializationStillValid())return;
  if(typeof nativeId!=='string'||!nativeId||nativeId.length>256){stop('invalid-native-session-id');return;}
  globalThis.loginOwners.nativeSessionId=nativeId;
  calibration.bindAuthentication({user_id:BOT_UIN,sessionId:nativeId,eventId:cfg.runId+'-manual-qr-1'});
  const profile=session.getProfileService();if(!initializationStillValid())return;
  if(typeof profile?.addKernelProfileListener==='function'&&typeof profile?.removeKernelProfileListener==='function'){
    const profileListener={onSelfStatusChanged:info=>recordOnline('onSelfStatusChanged',info)};
    globalThis.loginOwners.profileListener=profileListener;
    profileListenerHandle=profile.addKernelProfileListener(profileListener);if(!initializationStillValid())return;
  }
  clearTimeout(initTimer);clearTimeout(readyPoll);
  save('session-ready-observed',{initCallbackAccepted:true,messageServiceAvailable:true,sessionIdentifierPresent:true,businessOnlineVerified:false,profileStatusListenerRegistered:Number.isInteger(profileListenerHandle),calibrationHoldLimitMs:24*60*60*1000,control:calibration.snapshot()});
  holdTimer=setTimeout(()=>stop('manual-session-hold-expired'),24*60*60*1000);
}
function initializeSession(){
  if(finished||!authenticated||state.sessionInitAttempts!==0)return;
  if(performance.now()-authObservedAt>30000){stop('authentication-event-too-old-for-init');return;}
  save('initializing-session',{sessionInitAttempts:1});
  if(typeof login.getMachineGuid!=='function'){stop('machine-guid-unavailable');return;}
  const guid=login.getMachineGuid();
  if(!initializationStillValid())return;
  if(typeof guid!=='string'||!guid||guid.length>1024){stop('machine-guid-unavailable');return;}
  fs.mkdirSync('/output/downloads',{mode:0o700});
  const nativeConfig={selfUin:BOT_UIN,selfUid:globalThis.loginOwners.authenticatedIdentity.uid,
    desktopPathConfig:{account_path:'/output/global'},clientVer:'3.2.35-54395',a2:'',d2:'',d2Key:'',machineId:'',platform:5,
    platVer:'Linux '+os.release(),appid:'537403759',defaultFileDownloadPath:'/output/downloads',
    deviceInfo:{guid,buildVer:'3.2.35-54395',localId:2052,devName:os.hostname(),devType:'Linux',vendorName:'',osVer:os.version()||os.type(),vendorOsName:'Linux',setMute:false,vendorType:0},
    deviceConfig:'{"appearance":{"isSplitViewMode":true},"msg":{}}',
    rdeliveryConfig:{appKey:'',systemId:0,appId:'',logicEnvironment:'',platform:5,language:'',sdkVersion:'',userId:'',appVersion:'',osVersion:'',bundleId:'',serverUrl:'',fixedAfterHitKeys:['']}};
  const depends={onMSFStatusChange:(...args)=>observe('onMSFStatusChange',args),onMSFSsoError:(...args)=>observe('onMSFSsoError',args),getGroupCode:()=>stop('unresolved-depends-callback',{callback:'getGroupCode'})};
  const dispatcher={dispatchRequest:arg=>observe('dispatchRequest',arg),dispatchCall:arg=>observe('dispatchCall',arg),dispatchCallWithJson:arg=>observe('dispatchCallWithJson',arg)};
  const sessionListener={
    onNTSessionCreate:arg=>observe('onNTSessionCreate',arg),onGProSessionCreate:arg=>observe('onGProSessionCreate',arg),onGetSelfTinyId:arg=>observe('onGetSelfTinyId',arg),
    onUserOnlineResult:arg=>recordOnline('onUserOnlineResult',arg),
    onOpentelemetryInit(info){if(finished)return;observe('onOpentelemetryInit',info);if(info?.is_init===true){initAccepted=true;setImmediate(completeReady);}},
    // The fixed type is unknown and the adapter calls this argument sessionId.
    // Only known zero is accepted; other values are observations, not invented failures.
    onSessionInitComplete(result){if(finished)return;observe('onSessionInitComplete',result);if(result===0||result==='0'){initAccepted=true;setImmediate(completeReady);}else save(state.phase,{initCompletionUnclassified:true});},
  };
  globalThis.loginOwners.sessionCallbacks={depends,dispatcher,sessionListener};
  initTimer=setTimeout(()=>stop('session-init-timeout'),30000);
  session.init(nativeConfig,depends,dispatcher,sessionListener);
  if(!initializationStillValid())return;
  save('starting-session');startup.start();if(!initializationStillValid())return;
  initStarted=true;save('waiting-session-ready');completeReady();
}
const requestQr=()=>{
  if(finished||authenticated||state.qrRequests)return;
  if(cfg.connectOnly){clearTimeout(connectTimer);stop('connection-observed-no-qr');return;}
  clearTimeout(connectTimer);save('requesting-qr',{qrRequests:1});
  // Return is only trigger acknowledgment; success requires the image callback.
  const acknowledged=login.getQRCodePicture();
  if(finished||authenticated)return;
  if(acknowledged===false){stop('qr-trigger-rejected');return;}
  qrTimer=setTimeout(()=>stop('qr-wait-timeout'),180000);
};
const listener={
  onLoginConnecting(){if(!finished&&!state.qrRequests)save('connecting');},
  onLoginConnected(){requestQr();},
  onLoginDisConnected(){stop('login-disconnected');},
  onQRCodeGetPicture(value){
    if(finished||authenticated)return;
    let encoded=value?.pngBase64QrcodeData;
    if(typeof encoded!=='string'||encoded.length>2*1024*1024){stop('invalid-qr-image');return;}
    encoded=encoded.replace(/^data:image\/png;base64,/,'');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)){stop('invalid-qr-image');return;}
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.length<32||bytes.length>1024*1024||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))){stop('invalid-qr-image');return;}
    if(fs.existsSync('/output/qr.png')){stop('unexpected-extra-qr');return;}
    fs.writeFileSync('/output/qr.png',bytes,{flag:'wx',mode:0o600});save('qr-ready',{qrFile:'qr.png'});
  },
  onQRCodeLoginPollingStarted(){if(!finished&&!authenticated&&!state.qrFile)save('qr-polling');},
  onQRCodeSessionUserScaned(){if(!finished&&!authenticated)save('scanned-awaiting-confirmation');},
  onQRCodeSessionFailed(errType,errCode){if(!authenticated)stop('qr-session-failed',{errorType:Number.isInteger(errType)?errType:null,errorCode:Number.isInteger(errCode)?errCode:null});},
  onQRCodeLoginSucceed(value){
    if(finished)return;
    if(String(value?.uin)!==BOT_UIN||typeof value?.uid!=='string'||!value.uid){stop('unexpected-login-identity');return;}
    if(authenticated){if(value.uid!==globalThis.loginOwners.authenticatedIdentity.uid)stop('changed-login-identity');return;}
    authenticated=true;
    authObservedAt=performance.now();
    clearTimeout(qrTimer);clearTimeout(connectTimer);
    // Identity remains in memory only. This callback is NOT a session/online proof.
    globalThis.loginOwners.authenticatedIdentity={uin:value.uin,uid:value.uid};
    save('authenticated-initialization-authorized',{identityMatches:true,authenticationSource:'native-manual-qr-callback',businessOnlineVerified:false});
    setImmediate(initializeSession);
  },
  onLoginFailed(){stop('login-failed');},
  onLogoutSucceed(){stop('logged-out');},
  onQQLoginNumLimited(){stop('login-account-limit');},
  onQRCodeSessionQuickLoginFailed(){if(!authenticated)stop('unexpected-quick-login-event');},
};
login.addKernelLoginListener(listener);globalThis.loginOwners.listener=listener;
save('connecting');
connectTimer=setTimeout(()=>stop('connection-timeout'),30000);
login.connect();
if(!finished&&!authenticated&&!state.qrRequests)save('connect-returned-awaiting-event');
// Fixed stop-only control; no arbitrary paths, commands or code evaluation.
setInterval(()=>{if(finished)return;const s=fs.lstatSync('/output/stop.request',{throwIfNoEntry:false});if(s&&s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size===0)stop('closed');},1000);
