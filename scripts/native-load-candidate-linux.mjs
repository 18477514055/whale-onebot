// Complete fixed candidate. --execute MUST NOT be invoked without the user's explicit exception.
// --plan and --rehearse never mount or execute Tencent files. There is no arbitrary target API.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2]??'--plan';
assert(process.argv.length<=3&&['--plan','--rehearse','--execute'].includes(mode),'Only fixed --plan / --rehearse / --execute modes exist');
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
const script=fileURLToPath(import.meta.url),root=fs.realpathSync(path.resolve(path.dirname(script),'..'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifestPath=path.join(root,'experiments/native-load-candidate/manifest.json');
// Manually repinned after independent review added stage journals and LD_BIND_NOW observation.
const expectedManifestSha256='18cab930da889b84c5f3ad8911220801ed0ffbb53c21e89fd16efba668b6d895';
assert.equal(hash(manifestPath),expectedManifestSha256,'Candidate manifest changed; never automatically re-pin');
const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const basePath=path.join(root,manifest.baseManifest.path);
assert.equal(hash(basePath),manifest.baseManifest.sha256);
const base=JSON.parse(fs.readFileSync(basePath,'utf8'));
assert.equal(root,base.root);assert.equal(process.version,base.version);
assert.equal(hash(process.execPath),base.node.sha256);
assert.equal(createHash('sha256').update(JSON.stringify(process.config)).digest('hex'),base.nodeConfigSha256);
function checkedDirectory(p){assert.equal(fs.realpathSync(p),p);assert(fs.lstatSync(p).isDirectory());}
for(const p of ['runtime','evidence','experiments/native-load-candidate'])checkedDirectory(path.join(root,p));
function checkFile(p,expected,bytes){
  assert.equal(fs.realpathSync(p),p,'Input path is not its canonical path');assert(fs.lstatSync(p).isFile());
  if(bytes!==undefined)assert.equal(fs.statSync(p).size,bytes,p);assert.equal(hash(p),expected,p);
}
function verifyAll(){
  assert.equal(hash(manifestPath),expectedManifestSha256);assert.equal(hash(basePath),manifest.baseManifest.sha256);
  checkFile(path.join(root,manifest.buildEvidence.path),manifest.buildEvidence.sha256);
  for(const files of [base.staticEvidence,base.sources,base.headers,manifest.sources])for(const [relative,digest]of Object.entries(files)){
    assert(!path.isAbsolute(relative)&&!relative.split('/').includes('..'));checkFile(path.join(root,relative),digest);
  }
  for(const m of [base.archive,base.node,base.provider,base.bwrap,base.compiler,base.linker,...base.normalMounts,...base.qqMounts,...Object.values(manifest.artifacts)])checkFile(m.source,m.sha256,m.bytes);
}
function writeReport(relative,value){
  const p=path.join(root,relative);assert(p.startsWith(root+'/evidence/native-load-candidate'));
  const old=fs.lstatSync(p,{throwIfNoEntry:false});if(old){assert(old.isFile()&&!old.isSymbolicLink());assert.equal(old.nlink,1);assert.equal(fs.realpathSync(p),p);}
  fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n');return p;
}
verifyAll();
assert.equal(base.normalMounts.length,43);assert.equal(base.qqMounts.length,7);
const childSource=path.join(root,'experiments/native-load-candidate/driver.mjs');
const childMount={source:childSource,target:'/input/driver.mjs',sha256:hash(childSource),bytes:fs.statSync(childSource).size,kind:'original-driver'};
function makeMounts(scenario){
  assert(['approved-real-candidate',...manifest.expectedRehearsals].includes(scenario));
  const real=scenario==='approved-real-candidate';
  const mounts=[...base.normalMounts,base.node,childMount,{...manifest.artifacts.loader,target:'/input/loader.node'}];
  if(scenario!=='rehearsal-missing-provider')mounts.push(base.provider);
  mounts.push(...base.qqMounts.map(m=>{
    if(real)return m;
    const artifact=m.kind==='qq-wrapper'?manifest.artifacts[scenario==='rehearsal-missing-registration'?'missingRegistration':'wrapper']:manifest.artifacts.library;
    return {...artifact,target:m.target};
  }));
  assert.equal(new Set(mounts.map(m=>m.target)).size,mounts.length);
  if(!real)assert(mounts.every(m=>!m.source.includes('/.tools/qq-linux-inspection/')&&!m.kind.startsWith('qq-')));
  return mounts;
}
const namespaceArgs=['--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv'];
function makeArgs(mounts,input,output){
  return [...namespaceArgs,...mounts.flatMap(m=>['--ro-bind',m.source,m.target]),
    '--symlink','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2',
    '--ro-bind',input,'/input/candidate.json','--bind',output,'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
    '--setenv','HOME','/output/home','--setenv','XDG_CONFIG_HOME','/output/config','--setenv','XDG_CACHE_HOME','/output/cache','--setenv','TMPDIR','/tmp',
    '--chdir','/output','--remount-ro','/','/bin/node','/input/driver.mjs'];
}
const identity={candidateManifestSha256:expectedManifestSha256,runnerSha256:hash(script),driverSha256:hash(childSource),baseManifestSha256:manifest.baseManifest.sha256,
  nodeSha256:base.node.sha256,providerSha256:base.provider.sha256,loaderSha256:manifest.artifacts.loader.sha256,wrapperSha256:manifest.target.sha256};
const plan={schemaVersion:1,createdAt:new Date().toISOString(),mode:'plan-only',realQQExecuted:false,requiresExplicitUserException:true,
  identity,exactFutureCommand:manifest.exactFutureCommand,executionCount:1,noAutomaticRetry:true,
  realBinding:manifest.target.binding,normalBinding:manifest.normalLibraryBinding,providerBinding:manifest.providerBinding,
  realMounts:makeMounts('approved-real-candidate'),namespaceArgs,
  runtimePattern:root+'/runtime/first-native-load-XXXXXX',onlyWritableHostBind:'fresh runtime directory/output',
  commandInsideSandbox:['/bin/node','/input/driver.mjs'],fullArgsTemplate:makeArgs(makeMounts('approved-real-candidate'),'<FRESH_RUNTIME>/candidate.json','<FRESH_RUNTIME>/output'),
  limits:manifest.limits,claimPath:root+'/runtime/first-native-load-claim-'+expectedManifestSha256+'.json',
  remainingUnknowns:['Real constructors/addon initializer can execute code and may fail before names are available.',
    'Twelve wifiphoto lazy PLT references remain unresolved; initializer reachability is unknown.',
    'No real QQ execution evidence, login proof, account proof or lower kick-rate claim.'],
  limitsNotClaimed:['No hostile-code escape proof','No aggregate filesystem/memory/CPU hard quota','No Windows equivalent','No protection against malicious concurrent host file replacement']};
if(mode==='--plan'){
  const report=writeReport('evidence/native-load-candidate-plan.json',plan);
  console.log(JSON.stringify({mode,realQQExecuted:false,identity,exactFutureCommand:manifest.exactFutureCommand,evidence:report}));process.exit(0);
}
// Only an explicit --execute enters this branch. No environment variable or target path can select it.
// User authorization is an external prerequisite; preparation must NEVER invoke this mode.
const real=mode==='--execute';
if(real){
  const claim=plan.claimPath;
  // Exclusive durable claim prevents accidental re-execution of this same fixed candidate.
  const fd=fs.openSync(claim,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),identity,state:'claimed-before-first-load',authorizationRequired:'explicit user exception'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const parentNamespaces=Object.fromEntries(['user','net','mnt','pid','ipc'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));
let hostConnections=0;
const server=net.createServer(s=>{hostConnections++;s.end();});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const probePort=server.address().port;
await new Promise((resolve,reject)=>{const s=net.createConnection({host:'127.0.0.1',port:probePort});s.on('connect',()=>{s.end();resolve();});s.on('error',reject);});
const cases=[];
function readSmallJSON(p){
  const stat=fs.lstatSync(p,{throwIfNoEntry:false});if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)return {unreadable:'not a bounded regular report'};
  try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return {unreadable:'invalid JSON'};}
}
function inventory(directory){
  const list=[];let budget=4*1024*1024;
  const visit=(p,depth)=>{if(depth>4||list.length>=512)return;const dir=fs.opendirSync(p);try{let child;while(list.length<512&&(child=dir.readSync())){
    const f=path.join(p,child.name),s=fs.lstatSync(f),entry={path:path.relative(directory,f),bytes:s.size,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':'other'};
    if(s.isFile()&&!s.isSymbolicLink()&&s.size<=1024*1024&&s.size<=budget){entry.sha256=hash(f);budget-=s.size;}list.push(entry);
    if(s.isDirectory()&&!s.isSymbolicLink())visit(f,depth+1);
  }}finally{dir.closeSync();}};visit(directory,0);return {entries:list,truncated:list.length>=512,depthLimit:4,hashBudgetBytes:4*1024*1024};
}
function readStages(output){
  const p=path.join(output,'driver-stages.jsonl'),s=fs.lstatSync(p,{throwIfNoEntry:false});if(!s)return null;
  if(!s.isFile()||s.isSymbolicLink()||s.size>8192)return {untrusted:true,unreadable:'not a bounded regular journal'};
  try{return {untrusted:true,records:fs.readFileSync(p,'utf8').trim().split('\n').map(line=>JSON.parse(line))};}catch{return {untrusted:true,unreadable:'invalid journal'};}
}
async function oneCase(scenario){
  const directory=fs.mkdtempSync(path.join(root,'runtime/first-native-load-'));checkedDirectory(directory);
  const output=path.join(directory,'output');fs.mkdirSync(output);for(const n of ['home','config','cache'])fs.mkdirSync(path.join(output,n));
  const canaryPath=path.join(directory,'unmounted-canary.txt');fs.writeFileSync(canaryPath,'synthetic-host-canary',{flag:'wx'});const canarySha256=hash(canaryPath);
  const mounts=makeMounts(scenario),input=path.join(directory,'candidate.json');
  const config={schemaVersion:1,scenario,binding:manifest.target.binding,wrapperPath:'/app/wrapper.node',wrapperSha256:mounts.find(m=>m.target==='/app/wrapper.node').sha256,
    parentNamespaces,probePort,canaryPath,mounts};
  fs.writeFileSync(input,JSON.stringify(config,null,2)+'\n',{flag:'wx'});
  const args=makeArgs(mounts,input,output);for(const m of mounts)checkFile(m.source,m.sha256,m.bytes);
  const result=await new Promise(resolve=>{
    const child=spawn(base.bwrap.source,args,{cwd:directory,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',WHALE_SYNTHETIC_SECRET:'synthetic-only'},stdio:['ignore','pipe','pipe']});
    const capture={stdout:[],stderr:[]},counts={stdout:0,stderr:0};let stopReason=null,spawnError=null;
    const stop=reason=>{stopReason??=reason;child.kill('SIGKILL');};
    const timer=setTimeout(()=>stop('wall-clock-15s'),manifest.limits.wallMs);
    for(const name of ['stdout','stderr'])child[name].on('data',data=>{
      const max=manifest.limits[name+'Bytes'],remaining=Math.max(0,max-counts[name]);
      if(remaining)capture[name].push(data.subarray(0,remaining));counts[name]+=data.length;if(counts[name]>max)stop(name+'-limit');
    });
    child.on('error',e=>{spawnError={code:e.code??null,message:String(e.message).slice(0,2048)};});
    // close, not kill() or exit alone, is the final lifecycle observation.
    child.on('close',(status,signal)=>{clearTimeout(timer);resolve({pid:child.pid??null,status,signal,stopReason,spawnError,bytesObserved:counts,
      stdout:Buffer.concat(capture.stdout).toString('utf8'),stderr:Buffer.concat(capture.stderr).toString('utf8')});});
  });
  let hashesAfterPassed=true,hashError=null;
  try{for(const m of mounts)checkFile(m.source,m.sha256,m.bytes);assert.equal(hash(canaryPath),canarySha256);verifyAll();}
  catch(error){hashesAfterPassed=false;hashError=String(error.message).slice(0,2048);}
  const record={scenario,directory,output,args,mounts,configSha256:hash(input),process:result,
    preflight:readSmallJSON(path.join(output,'preflight.json')),observed:readSmallJSON(path.join(output,'driver-result.json')),stageJournal:readStages(output),
    outputInventory:inventory(output),hashesAfterPassed,hashError,identity,realQQFilesMounted:scenario==='approved-real-candidate'?7:0,
    businessExportsInvokedByDriver:0,claimedTargetExecution:scenario==='approved-real-candidate'};
  // Parent-owned archive is outside the only writable child bind, including failure/crash cases.
  fs.writeFileSync(path.join(directory,'parent-record.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  return record;
}
let failure=null;
try{
  for(const scenario of real?['approved-real-candidate']:manifest.expectedRehearsals){
    const record=await oneCase(scenario);cases.push(record);
    assert(record.hashesAfterPassed,record.hashError);
    assert(record.preflight&&Object.values(record.preflight.checks??{}).every(Boolean),'preflight did not complete');
    if(!real){
      assert.equal(record.process.signal,null);assert.equal(record.process.stopReason,null);
      if(scenario==='rehearsal-positive'){
        assert.equal(record.process.status,0,record.process.stderr);assert.equal(record.observed.loadError,null);
        assert.deepEqual(record.observed.names,['engine','login','qr','session']);assert(Object.values(record.observed.checks).every(Boolean));
        for(const n of ['synthetic-constructor.txt','synthetic-initializer.txt'])assert.equal(fs.readFileSync(path.join(record.output,n),'utf8'),'synthetic-only\n');
      }else if(scenario==='rehearsal-missing-provider'){
        assert.equal(record.process.status,2);assert.equal(record.observed.loadError.code,'NODE_PROVIDER_LOAD_FAILED');
        assert.equal(record.observed.stage,'normal-and-node-provider');assert(!fs.existsSync(path.join(record.output,'synthetic-constructor.txt')));
      }else{
        assert.equal(record.process.status,127);assert.match(record.process.stderr,/first_native_candidate_missing_registration/);
        assert.equal(record.observed,null);assert.equal(fs.readFileSync(path.join(record.output,'synthetic-constructor.txt'),'utf8'),'synthetic-only\n');
        assert(!fs.existsSync(path.join(record.output,'synthetic-initializer.txt')));
      }
      assert(!fs.existsSync(path.join(record.output,'UNEXPECTED_BUSINESS_CALL')));
    }
  }
  assert.equal(hostConnections,1,'Sandbox reached host listener');
}catch(error){failure=String(error.message).slice(0,4096);}
finally{await new Promise(resolve=>server.close(resolve));}
const actual=cases[0];
const realLoadSucceeded=real&&!failure&&actual?.process.status===0&&actual?.process.signal===null&&actual?.observed?.stage==='completed'&&actual?.observed?.loadError===null;
const passed=real?realLoadSucceeded:!failure;
const report={schemaVersion:1,at:new Date().toISOString(),mode,identity,cases,parentNamespaces,hostPositiveConnections:hostConnections,
  passed,harnessCompleted:!failure,realLoadSucceeded:real?realLoadSucceeded:null,...(failure?{failure}:{}),realQQExecutionAttempted:real,realQQExecutionAuthorizedByThisTool:false,
  authorizationNotice:'This program cannot infer conversational approval. --execute requires the separate explicit user exception; rehearsals do not authorize it.',
  noRetry:true,limits:manifest.limits,limitations:plan.limitsNotClaimed};
const reportPath=writeReport(real?'evidence/native-load-candidate-execution.json':'evidence/native-load-candidate-rehearsal.json',report);
console.log(JSON.stringify({mode,passed,realQQExecutionAttempted:real,evidence:reportPath,cases:cases.map(c=>({scenario:c.scenario,status:c.process.status,signal:c.process.signal,names:c.observed?.names??[],directory:c.directory,checks:Object.keys(c.observed?.checks??c.preflight?.checks??{}).length})),...(failure?{failure}:{})}));
process.exitCode=passed?0:1;
