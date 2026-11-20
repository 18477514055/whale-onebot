// User-authorized isolated manual QR plus one session-readiness experiment.
// Default preflight does not execute QQ. No message send or production bridge.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { BOT_UIN } from '../src/config/account.mjs';
const mode=process.argv[2]??'--preflight';
assert(process.argv.length<=3&&['--preflight','--start','--connect-check'].includes(mode));
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const check=(p,h)=>{assert.equal(fs.realpathSync(p),p);const s=fs.lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(hash(p),h);};
const baseFile=path.join(root,'experiments/first-native-load/manifest.json');check(baseFile,'25825a05c94eabdd905eca379c57fe40a693cb133f306c9b6aae42ae3f0a6d79');
const base=JSON.parse(fs.readFileSync(baseFile,'utf8'));
const candidateFile=path.join(root,'experiments/native-load-candidate/manifest.json');check(candidateFile,'18cab930da889b84c5f3ad8911220801ed0ffbb53c21e89fd16efba668b6d895');
const candidate=JSON.parse(fs.readFileSync(candidateFile,'utf8'));
const scopeEvidence=path.join(root,'evidence/native-host-scope-linux.json');
check(scopeEvidence,'c1468d133250e43a3ae69e702ffdec14456cde6890de60c07ca2032b5d99a4ca');
const scope=JSON.parse(fs.readFileSync(scopeEvidence,'utf8'));assert.equal(scope.passed,true);
check(path.join(root,'src/native/node-host.h'),'31cc9885cdf4ff0783419e821af00162c35e77a4e81fa135498f6020572e817d');
const provider={source:scope.artifacts.provider.path,target:base.provider.target,sha256:'8076d233a6c9894e4eef1aa2e89929958eb1283b24980bb25e9e3ddae4fe01a3'};
check(provider.source,provider.sha256);
check(process.execPath,base.node.sha256);assert.equal(process.version,base.version);
assert.equal(createHash('sha256').update(JSON.stringify(process.config)).digest('hex'),base.nodeConfigSha256);
check(path.join(root,'.tools/qq-linux-inspection/dependencies/files/opt/QQ/resources/app/major.node'),'30c0494e84316f63d80487df7b4f366fbc42288f2abeaeb81ade10377997b582');
check(base.archive.source,base.archive.sha256);check(base.bwrap.source,base.bwrap.sha256);
const driver=path.join(root,'experiments/session-ready/driver.mjs'),driverSha256=hash(driver);
for(const directory of [root,path.join(root,'runtime')]){assert.equal(fs.realpathSync(directory),directory);assert(fs.lstatSync(directory).isDirectory());}
if(mode!=='--preflight'){
  const attemptIdentity=createHash('sha256').update(driverSha256+provider.sha256).digest('hex');
  const fd=fs.openSync(path.join(root,'runtime/session-ready-claim-'+mode.slice(2)+'-'+attemptIdentity+'.json'),'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),driverSha256,providerSha256:provider.sha256,account:BOT_UIN,state:'one-manual-login-attempt'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const directory=fs.mkdtempSync(path.join(root,'runtime/session-ready-')),output=path.join(directory,'output');fs.mkdirSync(output,{mode:0o700});
for(const n of ['home','config','cache','global'])fs.mkdirSync(path.join(output,n),{mode:0o700});
const mounts=[...base.normalMounts,base.node,provider,...base.qqMounts,
  {...candidate.artifacts.loader,target:'/input/loader.node'},
  {source:driver,target:'/input/driver.mjs',sha256:driverSha256}];
// Only public OS network configuration; no inherited private search suffix/proxy.
const resolver=fs.readFileSync('/etc/resolv.conf','utf8').split('\n').filter(line=>/^nameserver\s+[0-9a-fA-F:.]+\s*$/.test(line));
assert(resolver.length>0&&resolver.length<=3);
for(const [name,content,target]of [['resolv.conf',resolver.join('\n')+'\n','/etc/resolv.conf'],['nsswitch.conf','hosts: files dns\n','/etc/nsswitch.conf'],['hosts','127.0.0.1 localhost\n::1 localhost\n','/etc/hosts']]){
  const source=path.join(directory,name);fs.writeFileSync(source,content,{flag:'wx'});mounts.push({source,target,sha256:hash(source)});
}
const certificates='/etc/ssl/certs/ca-certificates.crt';
if(fs.existsSync(certificates))mounts.push({source:fs.realpathSync(certificates),target:certificates,sha256:hash(certificates)});
for(const m of mounts)check(m.source,m.sha256);
assert.equal(new Set(mounts.map(m=>m.target)).size,mounts.length);
const parentNamespaces=Object.fromEntries(['user','net','mnt','pid','ipc'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));
const config=path.join(directory,'login.json');fs.writeFileSync(config,JSON.stringify({mounts,parentNamespaces,preflightOnly:mode==='--preflight',connectOnly:mode==='--connect-check'}),{flag:'wx'});
const args=['--unshare-all','--share-net','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv',
  ...mounts.flatMap(m=>['--ro-bind',m.source,m.target]),'--ro-bind',config,'/input/login.json',
  '--symlink','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2',
  '--bind',output,'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
  '--setenv','HOME','/output/home','--setenv','XDG_CONFIG_HOME','/output/config','--setenv','XDG_CACHE_HOME','/output/cache','--setenv','TMPDIR','/tmp',
  '--chdir','/output','--remount-ro','/','/bin/node','/input/driver.mjs'];
const identity={driverSha256,runnerSha256:hash(fileURLToPath(import.meta.url)),providerSha256:provider.sha256,wrapperSha256:base.qqMounts.find(m=>m.kind==='qq-wrapper').sha256};
fs.writeFileSync(path.join(directory,'launch.json'),JSON.stringify({mode,identity,args,mounts,network:'shared-for-authorized-manual-login',nativeOutput:'counted-and-discarded',existingProfilesMounted:false},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode,directory,output,identity}));
const child=spawn(base.bwrap.source,args,{cwd:directory,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','pipe']});
const counts={stdout:0,stderr:0};let stopReason=null;
// Emit only fixed diagnostic labels, never raw native output or matched payloads.
const diagnosticLabels=new Set(),diagnosticSymbols=new Set();let diagnosticTail='';
const knownFatalLabels=['FATAL ERROR','Cannot create a handle without a HandleScope','Entering the V8 API without proper locking','Empty MaybeLocal','v8::ToLocalChecked','v8::api_internal::ToLocalEmpty','HandleScope','Assertion','assertion failed','stack smashing detected','pure virtual method called','terminate called','std::bad_alloc','symbol lookup error','invalid pointer','double free','napi_fatal_error','napi_get_named_property','napi_call_function','napi_create_object','napi_get_reference_value','napi_make_callback','uv_async'];
const stop=reason=>{stopReason??=reason;child.kill('SIGKILL');};
for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{
  counts[name]+=bytes.length;
  if(name==='stderr'&&mode!=='--preflight'){
    const text=diagnosticTail+bytes.toString('utf8');for(const label of knownFatalLabels)if(text.includes(label))diagnosticLabels.add(label);
    for(const match of text.matchAll(/\b(?:v8::|node::)[A-Za-z0-9_:~]{1,160}|\b(?:napi|uv)_[a-z_]{1,80}\b/g))if(diagnosticSymbols.size<64)diagnosticSymbols.add(match[0]);
    diagnosticTail=text.slice(-256);
  }
  if(counts[name]>8*1024*1024)stop('native-output-limit');
});
const timer=setTimeout(()=>stop('wall-clock-limit'),mode==='--preflight'?15000:mode==='--connect-check'?45000:20*60*1000);
const poll=setInterval(()=>{
  const file=path.join(output,'status.json');
  try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>16384)return;const status=JSON.parse(fs.readFileSync(file,'utf8'));
    const phase=status.phase;if(typeof phase==='string'&&phase!==poll.last){poll.last=phase;console.log(JSON.stringify({phase,qrFile:phase==='qr-ready'?path.join(output,'qr.png'):undefined,identityMatches:status.identityMatches===true,errorType:status.errorType,errorCode:status.errorCode}));}}
  catch{}
},500);
let spawnError=null;child.on('error',e=>{spawnError=e.code??'spawn-failed';});
process.on('SIGTERM',()=>stop('parent-requested-stop'));
child.on('close',(status,signal)=>{
  clearTimeout(timer);clearInterval(poll);
  let inputsUnchanged=true;try{for(const m of mounts)check(m.source,m.sha256);}catch{inputsUnchanged=false;}
  const report={at:new Date().toISOString(),mode,status,signal,stopReason,spawnError,counts,diagnosticLabels:[...diagnosticLabels],diagnosticSymbols:[...diagnosticSymbols],identity,inputsUnchanged,directory,existingProfilesMounted:false};
  fs.writeFileSync(path.join(directory,'parent-result.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(report));process.exitCode=status===0&&inputsUnchanged?0:1;
});
