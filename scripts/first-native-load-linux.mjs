// Preparation and original synthetic rehearsal only. Real QQ execution is not implemented.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode=process.argv[2]??'--verify';
if(process.argv.length>3||!['--verify','--synthetic'].includes(mode)){
  console.error('REAL_QQ_EXECUTION_REFUSED: only --verify and --synthetic exist; no override flag or environment switch.');
  process.exit(64);
}
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
const script=fileURLToPath(import.meta.url),root=fs.realpathSync(path.resolve(path.dirname(script),'..'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// Manually repinned after measurement corrections and explicit future LAZY plan.
const expectedManifestSha256='25825a05c94eabdd905eca379c57fe40a693cb133f306c9b6aae42ae3f0a6d79';
const manifestPath=path.join(root,'experiments/first-native-load/manifest.json');
assert.equal(hash(manifestPath),expectedManifestSha256,'Fixed manifest changed; no automatic re-pinning');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
assert.equal(root,manifest.root);assert.equal(manifest.status,'PREPARATION_ONLY_REAL_QQ_EXECUTION_REFUSED');
function checkFile(p,expected,bytes){
  assert.equal(fs.realpathSync(p),p,'Symlink/canonical path mismatch: '+p);
  assert(fs.lstatSync(p).isFile(),'Not a regular file: '+p);
  if(bytes!==undefined)assert.equal(fs.statSync(p).size,bytes,p);
  assert.equal(hash(p),expected,p);
}
function checkInputs(){
  for(const files of [manifest.staticEvidence,manifest.sources,manifest.headers])
    for(const [relative,digest] of Object.entries(files)){
      assert(!path.isAbsolute(relative)&&!relative.split('/').includes('..'));
      checkFile(path.join(root,relative),digest);
    }
  for(const m of [manifest.archive,manifest.node,manifest.provider,manifest.bwrap,manifest.compiler,manifest.linker,...manifest.normalMounts,...manifest.qqMounts])
    checkFile(m.source,m.sha256,m.bytes);
}
checkInputs();assert.equal(hash(process.execPath),manifest.node.sha256);assert.equal(process.version,manifest.version);
assert.equal(createHash('sha256').update(JSON.stringify(process.config)).digest('hex'),manifest.nodeConfigSha256);
assert.equal(manifest.qqMounts.length,7);assert.equal(manifest.normalMounts.length,43);
if(mode==='--verify'){
  console.log(JSON.stringify({verified:true,realQQExecution:'REFUSED',manifestSha256:expectedManifestSha256,normalLibraries:43,qqFilesStaticallyHashed:7,qqFilesMounted:0,qqFilesExecuted:0}));process.exit(0);
}
for(const dir of ['.tmp','evidence','experiments/first-native-load'])assert.equal(fs.realpathSync(path.join(root,dir)),path.join(root,dir));
const work=fs.mkdtempSync(path.join(root,'.tmp/first-native-load-'));
const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TMPDIR:work};
const commands=[];
function run(exe,args){
  const r=spawnSync(exe,args,{cwd:work,env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  commands.push({exe,args,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr});
  assert.equal(r.status,0,r.stderr||r.error?.message);assert.equal(r.signal,null);return r.stdout;
}
const sourceDir=path.join(root,'experiments/first-native-load');
const compilerRoot=path.join(root,'.tools/tinycc-linux');
const header='#define NORMAL_ROOT_COUNT '+manifest.normalPreloadOrder.length+'\nstatic const char *normal_roots[] = {'+manifest.normalPreloadOrder.map(p=>JSON.stringify(p)).join(',')+'};\n';
fs.writeFileSync(path.join(work,'normal-roots.h'),header,{flag:'wx'});
const artifacts={};
for(const name of ['loader','wrapper','library']){
  const object=path.join(work,name+'.o'),file=path.join(work,name+'.node');
  run(manifest.compiler.source,['-B',path.join(compilerRoot,'extracted/usr/lib/x86_64-linux-gnu/tcc'),'-c','-nostdlib',
    '-I',path.join(root,'.tools/node-v24.20.0-linux-x64/include/node'),'-I',work,
    '-I',path.join(compilerRoot,'libc-headers/usr/include'),'-I',path.join(compilerRoot,'libc-headers/usr/include/x86_64-linux-gnu'),
    path.join(sourceDir,name+'.c'),'-o',object]);
  run(manifest.linker.source,['-shared','-z','noexecstack',...(name==='wrapper'?['-init','register_synthetic']:[]),'-o',file,object]);
  artifacts[name]={source:file,sha256:hash(file),bytes:fs.statSync(file).size,kind:'original-synthetic'};
}
const canary=path.join(work,'unmounted-canary.txt');fs.writeFileSync(canary,'synthetic-host-canary',{flag:'wx'});
const canaryHash=hash(canary);
const parentNamespaces=Object.fromEntries(['user','net','mnt','pid','ipc'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));
let connections=0;
const server=net.createServer(s=>{connections++;s.end();});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port});s.on('connect',()=>{s.end();resolve();});s.on('error',reject);});
const nsArgs=['--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv'];
function sandboxArgs(mounts,input,output){
  // This function is called only with synthetic replacements for all seven QQ slots.
  assert(mounts.every(m=>!m.source.includes('/.tools/qq-linux-inspection/')));
  assert(mounts.every(m=>m.kind!=='qq-wrapper'&&m.kind!=='qq-library'));
  return [...nsArgs,...mounts.flatMap(m=>['--ro-bind',m.source,m.target]),
    '--symlink','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2',
    '--ro-bind',input,'/input/rehearsal.json','--bind',output,'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
    '--setenv','HOME','/output/home','--setenv','XDG_CONFIG_HOME','/output/config','--setenv','XDG_CACHE_HOME','/output/cache',
    '--setenv','TMPDIR','/tmp','--setenv','CANARY_PATH',canary,'--setenv','PROBE_PORT',String(port),
    '--chdir','/output','--remount-ro','/','/bin/node','/input/child.mjs'];
}
const cases=[];
try{
  for(const scenario of ['no-provider','positive']){
    const directory=path.join(work,scenario);fs.mkdirSync(directory);const output=path.join(directory,'output');fs.mkdirSync(output);
    for(const n of ['home','config','cache'])fs.mkdirSync(path.join(output,n));
    const mounts=[...manifest.normalMounts,manifest.node,
      {source:path.join(sourceDir,'child.mjs'),target:'/input/child.mjs',sha256:hash(path.join(sourceDir,'child.mjs')),kind:'original-script'},
      {...artifacts.loader,target:'/input/loader.node'},
      ...manifest.qqMounts.map(m=>({...artifacts[m.kind==='qq-wrapper'?'wrapper':'library'],target:m.target}))];
    if(scenario==='positive')mounts.push(manifest.provider);
    assert.equal(new Set(mounts.map(m=>m.target)).size,mounts.length);
    const input=path.join(directory,'rehearsal.json');
    const caseManifest={kind:'original-synthetic-only',mode:scenario,syntheticWrapperSha256:artifacts.wrapper.sha256,
      forbiddenQQWrapperSha256:manifest.qqMounts.find(m=>m.kind==='qq-wrapper').sha256,mounts};
    fs.writeFileSync(input,JSON.stringify(caseManifest,null,2)+'\n',{flag:'wx'});
    const args=sandboxArgs(mounts,input,output);
    const processResult=await new Promise((resolve,reject)=>{
      const child=spawn(manifest.bwrap.source,args,{cwd:work,env:{...env,WHALE_SYNTHETIC_SECRET:'synthetic-only'},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='',killedForLimit=null;const timer=setTimeout(()=>{killedForLimit='wall-clock-15s';child.kill('SIGKILL');},15000);
      child.stdout.on('data',d=>{stdout+=d;if(Buffer.byteLength(stdout)>1024*1024){killedForLimit='stdout-1MiB';child.kill('SIGKILL');}});
      child.stderr.on('data',d=>{stderr+=d;if(Buffer.byteLength(stderr)>1024*1024){killedForLimit='stderr-1MiB';child.kill('SIGKILL');}});
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,stdout,stderr,killedForLimit});});
    });
    assert.equal(processResult.status,0,JSON.stringify(processResult));assert.equal(processResult.signal,null);assert.equal(processResult.killedForLimit,null);
    const observed=JSON.parse(processResult.stdout);
    assert(Object.values(observed.checks).every(Boolean));assert.equal(observed.businessFunctionsCalled,0);
    for(const n of Object.keys(parentNamespaces))assert.notEqual(observed.namespaces[n],parentNamespaces[n]);
    const completed=JSON.parse(fs.readFileSync(path.join(output,'completed.json')));assert.equal(completed.mode,scenario);
    for(const m of mounts)checkFile(m.source,m.sha256,m.bytes);
    cases.push({mode:scenario,args,mounts,inputManifestSha256:hash(input),output,process:processResult,observed,passed:true});
  }
}finally{await new Promise(resolve=>server.close(resolve));}
assert.equal(connections,1);assert.equal(hash(canary),canaryHash);
const guards=[];
for(const argument of ['--real','--qq',manifest.qqMounts[0].source]){
  const r=spawnSync(process.execPath,[script,argument],{cwd:work,env,encoding:'utf8',timeout:5000,maxBuffer:8192});
  assert.equal(r.status,64);assert.match(r.stderr,/REAL_QQ_EXECUTION_REFUSED/);guards.push({argument,status:r.status,stderr:r.stderr});
}
assert.throws(()=>checkFile(artifacts.wrapper.source,'0'.repeat(64)),/AssertionError/);
checkInputs();assert.equal(hash(manifestPath),expectedManifestSha256);
const plannedMounts=[...manifest.normalMounts,manifest.node,manifest.provider,...manifest.qqMounts];
fs.writeFileSync(path.join(work,'future-mount-plan.json'),JSON.stringify({execution:'DISABLED_NO_TARGET_DRIVER',binding:manifest.plannedWrapperBinding,mounts:plannedMounts,namespaceArgs:nsArgs,
  privateMounts:['/proc','/dev','/tmp'],onlyWritableHostBind:'NEW_PER_RUN_OUTPUT',command:null},null,2)+'\n',{flag:'wx'});
const report={schemaVersion:1,observedAt:new Date().toISOString(),scope:'Linux original synthetic rehearsal and static QQ hashing only',
  passed:true,realQQExecution:'REFUSED',qqFilesMounted:0,qqFilesExecuted:0,binding:manifest.plannedWrapperBinding,manifestSha256:expectedManifestSha256,runnerSha256:hash(script),
  work,artifacts,commands,cases,guards,wrongHashRejected:true,parentNamespaces,hostPositiveConnections:connections,canaryUnchanged:true,
  plannedNormalLibraries:manifest.normalMounts.length,plannedQQFiles:manifest.qqMounts.length,
  limitations:['No real QQ constructor, addon initializer, export or library was executed.',
    'Synthetic replacement mount geometry does not validate QQ dependency relocation, constructors, ABI, hidden dlopen paths or behavior.',
    'Namespace network isolation prevents host/external communication, but permits processes to use their private network namespace.',
    'Wall time and captured output are bounded; aggregate file growth, memory and CPU are not hard-limited. No hostile-code containment claim.',
    'Fixed paths/hashes are checked before and after; concurrent malicious host replacement is not covered.',
    'No automatic retry; no arbitrary target/command/manifest arguments; no unlock environment variable.']};
const destination=path.join(root,'evidence/first-native-load-linux.json');
const existing=fs.lstatSync(destination,{throwIfNoEntry:false});
if(existing){assert(!existing.isSymbolicLink());assert.equal(fs.realpathSync(destination),destination);assert.equal(existing.nlink,1);assert(existing.isFile());}
fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,realQQExecution:'REFUSED',cases:cases.map(c=>({mode:c.mode,names:c.observed.names,checks:c.observed.checks})),guards:guards.length,evidence:destination}));
