// Pure offline plan: never imports fs, starts processes, or touches a native object.
import path from 'node:path';
import {createHash} from 'node:crypto';
import { BOT_UIN } from '../config/account.mjs';
const BOT=BOT_UIN;
const PINS={
  linux:{node:'89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7',provider:'8076d233a6c9894e4eef1aa2e89929958eb1283b24980bb25e9e3ddae4fe01a3',wrapper:'dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328',loader:'24924d280660325402234f435178c576cc0acb9479c21240df5f0367fb4b9a45'},
  win32:{node:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',provider:'afdc328060dd4c1cd3f3c8482ef49c835b7b857483a63c5145ecf3a032104189'},
};
function invalid(){throw new TypeError('Invalid integrated host plan input');}
function record(value,keys){
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const out={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(d,'value'))invalid();out[key]=d.value;}return out;
}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function absolute(value,api,windows=false){
  if(typeof value!=='string'||value.length>4096||!api.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value)||value.split(/[\\/]/).some(x=>x==='.'||x==='..'))invalid();
  if(windows){if(!/^[A-Za-z]:[\\/]/.test(value)||value.slice(2).includes(':')||value.slice(3).split(/[\\/]/).some(x=>/[. ]$|[<>"|?*]/.test(x)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)))invalid();}
  else if(value.includes('\\')||value.startsWith('//'))invalid();
  return api.normalize(value);
}
function inside(api,parent,child){const relative=api.relative(parent,child);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+api.sep)&&!api.isAbsolute(relative);}
const commands=['stop','inspect_service_methods','register_online','read_self_status','read_online_status'];
const responseFields=['result','helloInterval','status','extStatus','batteryInterval','statusInterval'];
export function fingerprintIntegratedContents(entries) {
  return createHash('sha256').update(JSON.stringify(entries.map(({ kind, guest, bytes, sha256 }) =>
    [kind, guest, bytes, sha256]))).digest('hex');
}
function observation(owner,name,arity,scalarFields=[]){return {owner,name,arity,record:{argumentTypes:true,scalarFields,identityValues:'compare-only',unknownKeys:'count-only',freeText:false,rawPayload:false},bindTo:['processRunId','authenticationEvent','nativeSessionIdInMemory','generation','monotonicObservationTime']};}
export function createIntegratedHostPlan(options){
  const input=record(options,['projectRoot','platform','profileId','inputs']);
  if(!['linux','win32'].includes(input.platform)||typeof input.profileId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/.test(input.profileId))invalid();
  const windows=input.platform==='win32',api=windows?path.win32:path.posix;
  const root=absolute(input.projectRoot,api,windows);
  if(api.basename(root).toLowerCase()!=='qq-onebot'||root.split(/[\\/]/).some(s=>/^(qq-agent|tencent files|qqnt_\d+)$/i.test(s)))invalid();
  const profile=api.join(root,'runtime','integrated',input.profileId),temporary=api.join(root,'.tmp','integrated-'+input.profileId),control=api.join(root,'runtime','integrated-control',input.profileId);
  if(!Array.isArray(input.inputs)||input.inputs.length<1||input.inputs.length>10000)invalid();
  const entries=[],guests=new Set(),sources=new Set(),kinds=new Map();
  for(let i=0;i<input.inputs.length;i++){
    const d=Object.getOwnPropertyDescriptor(input.inputs,String(i));if(!d||!Object.hasOwn(d,'value'))invalid();
    const e=record(d.value,['kind','source','guest','sha256','bytes']);
    if(!['node','provider','wrapper','loader','source','dependency','library','metadata'].includes(e.kind))invalid();
    const source=absolute(e.source,api,windows),guest=absolute(e.guest,path.posix);
    if(!inside(api,root,source)||/^(runtime|data|sessions|backups)$/i.test(api.relative(root,source).split(api.sep)[0]))invalid();
    if(source===temporary||inside(api,temporary,source)||!/^\/(app|bin|host|input|native|lib|lib64|qq-onebot)\//.test(guest)||guest==='/qq-onebot/runtime'||guest.startsWith('/qq-onebot/runtime/')||guest==='/qq-onebot/.tmp'||guest.startsWith('/qq-onebot/.tmp/'))invalid();
    if(typeof e.sha256!=='string'||!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isSafeInteger(e.bytes)||e.bytes<0)invalid();
    if(guests.has(guest)||sources.has(windows?source.toLowerCase():source))invalid();guests.add(guest);sources.add(windows?source.toLowerCase():source);
    if(guest.startsWith('/qq-onebot/src/')&&e.kind!=='source')invalid();
    if(guest.startsWith('/qq-onebot/node_modules/')&&e.kind!=='dependency')invalid();
    if(PINS[input.platform][e.kind]){if(kinds.has(e.kind)||PINS[input.platform][e.kind]!==e.sha256)invalid();kinds.set(e.kind,true);}
    const fixedGuest={node:windows?'/bin/node.exe':'/bin/node',provider:windows?'/native/onebot-node-host.dll':'/host/libonebot-node-host.so',wrapper:windows?'/native/wrapper.node':'/app/wrapper.node',loader:windows?'/native/loader.node':'/input/loader.node'}[e.kind];
    if(fixedGuest&&guest!==fixedGuest)invalid();
    if(e.kind==='source'&&(!inside(api,api.join(root,'src'),source)||guest!=='/qq-onebot/'+api.relative(root,source).split(api.sep).join('/')))invalid();
    if(e.kind==='dependency'&&(!inside(api,api.join(root,'node_modules'),source)||guest!=='/qq-onebot/'+api.relative(root,source).split(api.sep).join('/')))invalid();
    entries.push({kind:e.kind,source,guest,sha256:e.sha256,bytes:e.bytes,readOnly:true});
  }
  for(const kind of Object.keys(PINS[input.platform]))if(!kinds.has(kind))invalid();
  entries.sort((a,b)=>a.guest<b.guest?-1:a.guest>b.guest?1:0);
  const manifestSha256=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  // The mount manifest authenticates host paths. Compare the same build across
  // newly allocated workspaces using only the identities of its guest inputs.
  const inputContentSha256 = fingerprintIntegratedContents(entries);
  return freeze({schemaVersion:1,kind:'integrated-host-offline-plan',executable:false,
    status:windows?'blocked-windows-isolation':'awaiting-real-launcher-verification',platform:input.platform,account:BOT,nodeVersion:'v24.20.0',
    profile:{id:input.profileId,path:profile,mustCreateExclusively:true,mustBeEmptyAtFirstLaunch:true,persistent:true,automaticReuse:false,importExistingProfiles:false,ownerLock:'exclusive-no-auto-steal'},
    mounts:[{source:api.join(root,'src'),guest:'/qq-onebot/src',access:'read-only',exactInventoryRequired:true},{source:api.join(root,'node_modules'),guest:'/qq-onebot/node_modules',access:'read-only',exactInventoryRequired:true},
      {source:profile,guest:'/qq-onebot/runtime',access:'new-profile-only-write'},{source:temporary,guest:'/qq-onebot/.tmp',access:'new-temp-only-write'},{source:control,guest:'/control',access:'parent-owned-read-only'}],
    inputManifest:{entries,sha256:manifestSha256,contentSha256:inputContentSha256,actualBytesVerified:false,completeTreesVerified:false,physicalPathsVerified:false},
    environment:{cwd:'/qq-onebot/runtime',HOME:'/qq-onebot/runtime/home',TMPDIR:'/qq-onebot/.tmp',XDG_CONFIG_HOME:'/qq-onebot/runtime/config',XDG_CACHE_HOME:'/qq-onebot/runtime/cache',inheritNodeOrLoaderOptions:false},
    decoder:{mode:'separate-node-process',sharpVersion:'0.35.5',sharesNativeAddressSpaceWithQq:false,worker:'/qq-onebot/src/media/decoder-worker.mjs',tempRoot:'/qq-onebot/.tmp'},
    observations:[observation('login','onLoginConnecting',null),observation('login','onLoginConnected',null),observation('login','onLoginDisConnected',null),observation('login','onQRCodeGetPicture',1),observation('login','onQRCodeLoginPollingStarted',null),observation('login','onQRCodeSessionUserScaned',null),observation('login','onQRCodeLoginSucceed',1),observation('login','onQRCodeSessionFailed',3,['errType','errCode']),observation('login','onLoginFailed',1),observation('login','onLogoutSucceed',null),observation('login','onLogoutFailed',null),observation('login','onUserLoggedIn',1),observation('login','onQRCodeSessionQuickLoginFailed',null),observation('login','onPasswordLoginFailed',null),observation('login','onQQLoginNumLimited',null),observation('login','onLoginState',null),
      observation('session','onNTSessionCreate',1),observation('session','onGProSessionCreate',1),observation('session','onGetSelfTinyId',1),observation('session','onSessionInitComplete',1),observation('session','onOpentelemetryInit',1,['is_init','is_report']),observation('session','onUserOnlineResult',3,responseFields),observation('depends','onRegisterProxyOnlineResp',3,responseFields),
      observation('depends','onMSFStatusChange',2),observation('depends','onMSFSsoError',2),observation('profile','onSelfStatusChanged',1,['status','extStatus','batteryStatus','offlineType','activeState'])],
    callbacksWithUnresolvedReturns:{global:['fixPicImgType','getAppSetting'],depends:['getGroupCode'],policy:'stop-unsupported-rather-than-invent-return'},
    otherNotifications:{misc:['getOnAmgomDataPiece'],global:['onLog','onGetSrvCalTime','onShowErrUITips','onInstallFinished','onUpdateGeneralFlag','onGetOfflineMsg'],dispatcher:['dispatchRequest','dispatchCall','dispatchCallWithJson'],policy:'bounded-type-observation-no-payload-or-fabricated-response'},
    qrPresentation:{temporaryUserVisibleImage:true,rawImageInEvidence:false,urlOrBase64InLogs:false,accountMustMatch:BOT},
    threeArgumentOnlineObservation:{argument0:'int32-observation-not-classifier',argument1:'string-type-only-no-value',argument2:'response-object-safe-fields-only',freeTextFieldsOmitted:['msg','serverTime'],identityPresentInResponse:false},
    control:{commands,arbitraryMethod:false,eval:false,replay:false,unknownWriteAutoRetry:false,runIdAndSequenceRequired:true,authenticationBindingRequired:true},
    sequence:[
      {id:'verify-new-layout',requires:['exact-full-file-hashes-and-tree-membership','physical-no-links','exclusive-new-profile-and-temp','fixed-node-config-and-corrected-provider','platform-isolation-verified']},
      {id:'start-once',requires:['no-conflicting-owned-instance'],noImmediateRestartOfLive:true},
      {id:'register-observers-before-login',requires:['complete-version-bound-login-session-depends-observation-contracts']},
      {id:'manual-qr-once',requires:['human-scans-bot-account'],automaticRefresh:false,quickLogin:false},
      {id:'initialize-once',requires:['actual-native-auth-event-matches-bot','actual-guid-in-memory','same-generation'],businessGate:'closed'},
      {id:'restricted-calibration',requires:['session-ready-observation'],businessGate:'closed'},
      {id:'future-reviewed-adapter',requires:['actual-independent-current-identity-and-online-classifier','freshness-and-offline-negative-controls','same-session-binding','explicit-reviewed-integration'],implemented:false,businessGate:'closed-until-all-evidence-exists'},
    ],
    currentBusinessGate:{open:false,readRuntimeProofImplemented:false,onlineClassifierImplemented:false,configurationIsNotProof:true,setStatusAckIsNotOnlineProof:true},
    unresolved:windows?['No supported Windows isolation launcher verified','No Windows QQ initialization or login equivalence proven','No independent online classifier']:['Exact mounted source/dependency inventories must be checked by future launcher','Network-enabled isolation must be verified for this expanded layout','Independent online classifier and negative controls remain missing'],
  });
}
