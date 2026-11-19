import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';
const control=fs.readFileSync(new URL('../src/host/calibration-control.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const source=control+'\n'+fs.readFileSync(new URL('../experiments/status-calibration/driver.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
function fixture({ready=true,dependsFailure=false,reentrantLogout}={}){
 const files=new Map(),queue=[],timers=[];let listener,sessionListener,profileListener,initCalls=0,startCalls=0,qrCalls=0,exitCode,commandVersion=0,registrationCalls=0,selfStatusCalls=0;
 const denied=()=>{const e=new Error('synthetic');e.code='EROFS';throw e;};
 const fakeFs={
  readFileSync(p){if(p==='/input/login.json')return JSON.stringify({runId:'synthetic_calibration_run',mounts:[],parentNamespaces:{user:'parent',net:'same',mnt:'parent',pid:'parent',ipc:'parent'}});if(p==='/proc/self/mountinfo')return '1 0 0 / /input/login.json ro\n2 0 0 / /control ro';if(p==='/proc/self/status')return 'CapEff: 0000';if(files.has(p))return Buffer.from(files.get(p));throw Error('Unexpected read');},
  readlinkSync:p=>p.endsWith('/net')?'same':'child',existsSync:p=>files.has(p),openSync:denied,lstatSync:p=>p==='/control/command.json'&&files.has(p)?{isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:Buffer.byteLength(files.get(p)),ino:commandVersion,dev:1,mtimeMs:commandVersion}:undefined,mkdirSync:p=>files.set(p,'directory'),
  writeFileSync(p,value){if(p==='/unexpected-write'||p.startsWith('/control/'))return denied();files.set(p,String(value));},renameSync(a,b){files.set(b,files.get(a));files.delete(a);},
 };
 const msg={async setStatus(value){registrationCalls++;assert.equal(value.status,10);assert.equal(value.customStatus.faceType,'1');return {result:0,errMsg:'SYNTHETIC_SECRET'};}};
 const profile={addKernelProfileListener(value){profileListener=value;return 7;},removeKernelProfileListener(){},async getSelfStatus(...args){selfStatusCalls++;assert.equal(args.length,0);return {result:0,token:'SYNTHETIC_SECRET',uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'};}};
 const session={init(config,depends,dispatcher,l){initCalls++;assert.equal(config.selfUid,'u_SYNTHETIC_PRIVATE');assert.equal(config.deviceInfo.guid,'SYNTHETIC_PRIVATE_GUID');assert.equal(config.appid,'537403759');assert.equal(config.platform,5);sessionListener=l;if(dependsFailure)depends.getGroupCode();else if(ready)l.onSessionInitComplete(0);},getMsgService(){if(reentrantLogout==='service')listener.onLogoutSucceed();return msg;},getProfileService:()=>profile,getSessionId(){if(reentrantLogout==='id')listener.onLogoutSucceed();return 'SYNTHETIC_PRIVATE_SESSION';}};
 const login={initConfig(){},getMachineGuid(){if(reentrantLogout==='guid')listener.onLogoutSucceed();return 'SYNTHETIC_PRIVATE_GUID';},addKernelLoginListener:l=>{listener=l;return 1;},connect:()=>listener.onLoginConnected(),getQRCodePicture(){qrCalls++;return true;}};
 const exports={NodeIO3MiscService:{get:()=>({addO3MiscListener(){}})},NodeIQQNTWrapperEngine:{get:()=>({initWithDeskTopConfig(){}})},NodeIQQNTStartupSessionWrapper:{create:()=>({start(){startCalls++;}})},NodeIQQNTWrapperSession:{getNTWrapperSession:()=>session},NodeIKernelLoginService:{get:()=>login}};
 const context=vm.createContext({BOT_UIN,OWNER_UIN,fs:fakeFs,os:{constants:{dlopen:{RTLD_NOW:2,RTLD_LOCAL:0,RTLD_LAZY:1}},version:()=>'Synthetic OS',release:()=>'Synthetic kernel',hostname:()=>'Synthetic host',type:()=>'Linux'},createHash,randomUUID,AbortController,assert,performance:{now:()=>1000},Buffer,
  process:{env:{},on(){},dlopen(m,p){if(p==='/input/loader.node')m.exports.providerLoaded=true;else m.exports=exports;},exit(code){exitCode=code;}},
  setImmediate:fn=>queue.push(fn),setTimeout:(fn,ms)=>{const t={fn,ms,cancelled:false};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;},setInterval:()=>0,
 });
 vm.runInContext(source,context,{timeout:1000});
 const flush=()=>{let n=0;while(queue.length){assert(++n<20);queue.shift()();}};
 return {files,login:()=>listener,session:()=>sessionListener,profile:()=>profileListener,timers,flush,status:()=>JSON.parse(files.get('/output/status.json')),counts:()=>({initCalls,startCalls,qrCalls,exitCode,registrationCalls,selfStatusCalls}),async command(command,seq,overrides={}){const binding=JSON.parse(files.get('/output/status.json')).control??{};files.set('/control/command.json',JSON.stringify({runId:'synthetic_calibration_run',seq,command,params:{},generation:binding.generation,authBinding:binding.authBinding,...overrides}));commandVersion++;await vm.runInContext('pollControl()',context);return JSON.parse(files.get('/output/control-result.json'));}};
}
test('session driver consumes real-shaped authentication once, observes ready without online claim or identity persistence',()=>{
 const f=fixture();assert.equal(f.counts().qrCalls,1);
 f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();
 assert.equal(f.status().phase,'session-ready-observed');assert.equal(f.status().businessOnlineVerified,false);
 assert.equal(f.counts().initCalls,1);assert.equal(f.counts().startCalls,1);
 f.session().onUserOnlineResult({result:0,opaque:'DO_NOT_PERSIST',SYNTHETIC_PRIVATE_DICTIONARY_KEY:123});
 f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();assert.equal(f.counts().initCalls,1);
 const persisted=[...f.files.values()].join('\n');for(const secret of ['u_SYNTHETIC_PRIVATE','SYNTHETIC_PRIVATE_GUID','SYNTHETIC_PRIVATE_SESSION','DO_NOT_PERSIST','SYNTHETIC_PRIVATE_DICTIONARY_KEY'])assert(!persisted.includes(secret));
});
test('wrong authentication identity never initializes, and unresolved dependency callback prevents start',()=>{
 const wrong=fixture();wrong.login().onQRCodeLoginSucceed({uin:OWNER_UIN,uid:'u_wrong'});wrong.flush();assert.equal(wrong.counts().initCalls,0);assert.equal(wrong.status().phase,'unexpected-login-identity');
 const f=fixture({dependsFailure:true});f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();assert.equal(f.counts().initCalls,1);assert.equal(f.counts().startCalls,0);assert.equal(f.status().phase,'unresolved-depends-callback');
});
test('missing ready callback times out; late callback cannot reopen failed driver',()=>{
 const f=fixture({ready:false});f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();assert.equal(f.status().phase,'waiting-session-ready');
 f.timers.find(t=>t.ms===30000&&!t.cancelled).fn();f.flush();assert.equal(f.status().phase,'session-init-timeout');
 f.session().onSessionInitComplete(0);f.flush();assert.equal(f.status().phase,'session-init-timeout');assert.equal(f.status().businessOnlineVerified,false);
});
test('unknown session completion value stays pending until independent known initialization callback',()=>{
 const f=fixture({ready:false});f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();
 f.session().onSessionInitComplete('synthetic-unknown-id');f.flush();assert.equal(f.status().phase,'waiting-session-ready');assert.equal(f.status().initCompletionUnclassified,true);
 f.session().onSessionInitComplete(1234);f.flush();assert.equal(f.status().phase,'waiting-session-ready');
 f.session().onOpentelemetryInit({is_init:true,is_report:false});f.flush();assert.equal(f.status().phase,'session-ready-observed');assert.equal(f.status().businessOnlineVerified,false);
});
test('synchronous native getter logout prevents subsequent init or ready despite a good returned value',()=>{
 for(const reentrantLogout of ['guid','service','id']){
  const f=fixture({reentrantLogout});f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();
  assert.equal(f.status().phase,'logged-out');assert.equal(f.status().businessOnlineVerified,false);
  if(reentrantLogout==='guid'){assert.equal(f.counts().initCalls,0);assert.equal(f.counts().startCalls,0);}
 }
});
test('fixed control queries and one status registration are bound, redacted and never assert online proof',async()=>{
 const f=fixture();f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();
 const methods=await f.command('inspect_service_methods',1);assert.equal(methods.code,'COMPLETED');assert(methods.data.profile.includes('getSelfStatus'));
 const self=await f.command('read_self_status',2);assert.equal(self.code,'COMPLETED');assert.equal(self.data.known.uidMatchesExpected,true);assert.equal(f.counts().selfStatusCalls,1);
 f.profile().onSelfStatusChanged({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE',status:10,extStatus:0,offlineType:0,token:'SYNTHETIC_SECRET'});
 const online=await f.command('read_online_status',3);assert.equal(online.data.events.onSelfStatusChanged.value.known.status,10);assert.equal(online.data.onlineProof,false);
 const registration=await f.command('register_online',4);assert.equal(registration.code,'COMPLETED');assert.equal(registration.data.known.result,0);assert.equal(registration.onlineProof,false);
 assert.equal((await f.command('register_online',5)).code,'ALREADY_REGISTERED');assert.equal(f.counts().registrationCalls,1);
 const stopped=await f.command('stop',5);f.flush();assert.equal(stopped.status,'stopped');assert.equal(f.status().phase,'closed');
 const persisted=[...f.files.entries()].filter(([p])=>p!=='/control/command.json').map(([,v])=>v).join('\n');for(const secret of ['u_SYNTHETIC_PRIVATE','SYNTHETIC_PRIVATE_GUID','SYNTHETIC_PRIVATE_SESSION','SYNTHETIC_SECRET'])assert(!persisted.includes(secret));
});
test('stale binding and arbitrary commands never invoke native status methods',async()=>{
 const f=fixture();f.login().onQRCodeLoginSucceed({uin:BOT_UIN,uid:'u_SYNTHETIC_PRIVATE'});f.flush();
 assert.equal((await f.command('read_self_status',1,{authBinding:'wrong'})).code,'STALE_AUTHENTICATION_BINDING');
 assert.equal((await f.command('send_group_msg',1)).code,'UNSUPPORTED_COMMAND');
 assert.equal(f.counts().registrationCalls,0);assert.equal(f.counts().selfStatusCalls,0);
 assert.equal((await f.command('read_self_status',1)).code,'COMPLETED');
});
