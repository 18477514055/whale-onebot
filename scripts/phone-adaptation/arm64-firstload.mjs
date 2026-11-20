#!/usr/bin/env node
// Fixed, one-shot Linux ARM64/QEMU QQ initialization. Never a phone/login launcher.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {FIXED} from './constants.mjs';
import {physicalPath,readPhysical,readJson,digest} from './safe-files.mjs';
import {loadBaseline} from './core.mjs';

assert.equal(process.platform,'linux'); assert.equal(process.arch,'x64');
const root=path.resolve(import.meta.dirname,'../..');
assert.equal(root,'/mnt/d/qq-onebot');
const scope=path.join(root,'experiments/phone-arm64-firstload');
const mode=process.argv[2]??'--preview';
assert(process.argv.length<=3&&['--preview','--execute'].includes(mode),'Only fixed --preview / --execute modes exist');
const sha=file=>{const h=createHash('sha256');const fd=fs.openSync(file,'r');try{const buf=Buffer.alloc(1024*1024);let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))h.update(buf.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');};
const cleanEnv={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:'/nonexistent',TMPDIR:scope};
const tools={
  qemu:{file:'/usr/bin/qemu-aarch64',sha256:'73cc2584f119f9e74c85c0a8549dbb6fd104ae3897a06a7500797f9e5b4d0943'},
  bwrap:{file:path.join(root,'.tools/bubblewrap/extracted/usr/bin/bwrap'),sha256:'573236e5328ac2ebb08f59ae3a9805b4f8d12bdef14be8af4450d5463294985f'},
  prlimit:{file:'/usr/bin/prlimit',sha256:'b757b97b3489e9d61e478435b3d94fa854d8b8783f266394b7fe31a15ebf456d'},
  timeout:{file:'/usr/bin/timeout',sha256:'6ca1891dfc0b05d7680770c2884c0391b92467c7bb6500a5c84677e6481739f1'},
  compiler:{file:path.join(root,'.tools/gcc-linux-arm64/extracted/usr/bin/aarch64-linux-gnu-g++-14'),sha256:'ebf50622610283dd2a7ad6b50947bebccb33f994e3e9ba8c11d04d5ab6bd4850'},
};
const limits={wallSeconds:45,parentKillMs:48000,cpuSeconds:30,addressSpaceBytes:17179869184,
  openFiles:256,perFileBytes:2097152,coreBytes:0,tmpfsBytes:16777216,stdoutBytes:1048576,stderrBytes:1048576,nodeOldSpaceMiB:256};
const baseline=loadBaseline(root);
// v2 is the explicitly reviewed preview-only cleanup-race correction. The first
// candidate/preview is retained; it never invoked QQ and is not auto-repinned.
const candidateFile=path.join(scope,'candidate-v2.json');
physicalPath(root,'experiments/phone-arm64-firstload',{directory:true});
assert.equal(sha(process.execPath),'89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7');
for(const t of Object.values(tools)){assert(fs.statSync(t.file).isFile());assert.equal(sha(t.file),t.sha256);}
function writeNew(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function record(file,guest,expected){
  assert(file.startsWith(root+'/')||file===tools.qemu.file);
  const source=fs.realpathSync(file);
  if(source.startsWith(root+'/'))physicalPath(root,path.relative(root,source));
  const info=fs.lstatSync(source);assert(info.isFile()&&!info.isSymbolicLink());
  const actual=sha(source);if(expected)assert.equal(actual,expected);
  return {source,guest,bytes:info.size,sha256:actual};
}
function verifyMounts(mounts){for(const m of mounts){assert.equal(fs.statSync(m.source).size,m.bytes);assert.equal(sha(m.source),m.sha256);}}
function build(){
  assert(!fs.existsSync(candidateFile),'Candidate already prepared; no overwrite or automatic repinning');
  const libraryInput=readJson(root,'evidence/linux-arm64-runtime-libraries.json',1024*1024);
  assert.equal(libraryInput.sha256,'16ff959c0d7377fa19b775da26e033f3322c7b151e5b23595ecd2f26e1569a24');
  const libraries=libraryInput.value;
  assert.equal(libraries.overlay,'.tools/debian-arm64-runtime/libraries-pHOiTb/lib');
  const audit=readJson(root,'evidence/native-dependencies-linux-arm64-supplemental.json',16*1024*1024).value;
  const extras=Object.fromEntries(libraries.acquisitions.flatMap(({staged})=>staged.map(item=>[item.name,item])));
  assert(Object.keys(extras).every(n=>/^[A-Za-z0-9_.+-]+$/.test(n)));
  const normalNames=[...new Set([...audit.supplementalSymbolCandidates.symbols.filter(s=>s.providers.length).map(s=>{
    const provider=s.providers.find(p=>/\.so\.\d+$/.test(p.file));assert(provider&&Object.hasOwn(extras,provider.file));return provider.file;
  }),'libX11.so.6','libX11-xcb.so.1','libXext.so.6','libgssapi_krb5.so.2','libgcrypt.so.20'])].sort();
  assert.equal(normalNames.length,14);
  const work=fs.mkdtempSync(path.join(scope,'build-'));
  const normalRoots=normalNames.map(n=>'/lib/aarch64-linux-gnu/'+n);
  writeNew(path.join(work,'normal-roots.h'),'#define NORMAL_ROOT_COUNT '+normalRoots.length+'\nstatic const char *normal_roots[] = {'+normalRoots.map(p=>JSON.stringify(p)).join(',')+'};\n');
  const loader=path.join(work,'loader.node');
  const args=['-B',path.join(root,'.tools/gcc-linux-arm64/extracted/usr/aarch64-linux-gnu/bin')+'/',
    '-x','c','-fPIC','-shared','-nostdlib','-Wl,-z,noexecstack','-I',work,
    '-I',path.join(root,'.tools/node-v24.20.0-linux-arm64/include/node'),path.join(scope,'loader.c'),'-o',loader];
  const compilerResult=spawnSync(tools.compiler.file,args,{cwd:work,env:{...cleanEnv,TMPDIR:work,
    LD_LIBRARY_PATH:[path.join(root,'.tools/gcc-linux-arm64/extracted/usr/lib/x86_64-linux-gnu'),path.join(root,'.tools/gcc-linux/extracted/usr/lib/x86_64-linux-gnu')].join(':')},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  writeNew(path.join(work,'compiler.json'),{program:tools.compiler,args,status:compilerResult.status,signal:compilerResult.signal,
    stdout:compilerResult.stdout,stderr:compilerResult.stderr,error:compilerResult.error?.code??null});
  assert.equal(compilerResult.status,0,'ARM64 loader build failed; inspect compiler.json, do not run QQ');
  const mounts=[record(tools.qemu.file,'/bin/qemu',tools.qemu.sha256),
    record(path.join(root,FIXED.nodePath),'/bin/node',FIXED.nodeElfSha256),
    record(path.join(root,FIXED.wrapperPath),'/app/wrapper.node',FIXED.wrapperSha256),
    record(path.join(root,FIXED.providerPath),'/host/libonebot-node-host.so',FIXED.providerSha256),
    record(loader,'/input/loader.node'),record(path.join(scope,'driver.mjs'),'/input/driver.mjs')];
  const sysroot=path.join(root,'.tools/arm64-linux-sysroot/usr/aarch64-linux-gnu/lib');
  const baseNames=fs.readdirSync(sysroot).filter(n=>/^(?:ld-|lib)[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)*$/.test(n)).sort();
  assert(baseNames.length>0&&baseNames.length<256);
  for(const name of baseNames){assert(!Object.hasOwn(extras,name));const source=fs.realpathSync(path.join(sysroot,name));assert.equal(path.dirname(source),sysroot);mounts.push(record(source,'/lib/aarch64-linux-gnu/'+name));}
  for(const [name,item] of Object.entries(extras))mounts.push(record(path.join(root,libraries.overlay,name),'/lib/aarch64-linux-gnu/'+name,item.sha256));
  const packagePrefix='/mnt/d/qq-onebot/.tools/qq-linux-arm64-inspection-NGwyZl/dependencies/files/opt/QQ/resources/app/';
  for(const m of audit.modules.filter(m=>m.kind==='package')){
    assert(m.path.startsWith(packagePrefix));const rel=m.path.slice(packagePrefix.length);
    assert(/^[A-Za-z0-9_.+\/-]+$/.test(rel)&&!rel.split('/').includes('..'));
    mounts.push(record(m.path,'/app/'+rel,m.sha256));
  }
  assert.equal(new Set(mounts.map(m=>m.guest)).size,mounts.length);
  const c={schema:1,kind:'fixed-arm64-qq-initial-load',phoneAccessed:false,loginAllowed:false,businessCallsAllowed:false,
    wrapperBinding:'RTLD_LAZY|RTLD_LOCAL',providerBinding:'RTLD_NOW|RTLD_GLOBAL',normalLibraryBinding:'RTLD_NOW|RTLD_GLOBAL',
    tools,limits,normalRoots,mounts,baseline,
    sources:[record(path.join(scope,'loader.c'),'/not-mounted-loader-source'),
      record(path.join(root,'scripts/phone-adaptation/arm64-firstload.mjs'),'/not-mounted-runner'),
      record(path.join(work,'normal-roots.h'),'/not-mounted-generated-header')],
    resourceLimitNotes:['RLIMIT_AS is a hard virtual-address ceiling, not RSS/cgroup quota.',
      'Node old-space limits JS heap, not all native allocations. No hostile-code containment claim.'],
    unresolved:['12 same-mangled wireless-photo imports remain unresolved; no stubs or changed wrapper binding.',
      'A successful first load does not prove calls to those imports, Android, login or business compatibility.']};
  verifyMounts(mounts);writeNew(candidateFile,c);return c;
}
function namespaces(){return Object.fromEntries(['user','net','mnt','pid','ipc'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));}
async function run(c,actual){
  verifyMounts(c.mounts);for(const s of c.sources)assert.equal(sha(s.source),s.sha256);
  assert.deepEqual(c.tools,tools);assert.deepEqual(c.limits,limits);
  if(actual)writeNew(path.join(scope,'execution-claim.json'),{schema:1,claimedAt:new Date().toISOString(),candidateSha256:sha(candidateFile),oneShot:true});
  const work=fs.mkdtempSync(path.join(scope,actual?'execution-':'preview-'));
  const server=net.createServer(socket=>socket.end());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const ownProbePort=server.address().port;
  await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port:ownProbePort});socket.on('connect',()=>{socket.end();resolve();});socket.on('error',reject);});
  const config={schema:1,mode:actual?'approved-real':'preflight-only',wrapperBinding:c.wrapperBinding,mounts:c.mounts,parentNamespaces:namespaces(),ownProbePort};
  const configPath=path.join(work,'input.json');writeNew(configPath,config);
  const bargs=['--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--cap-drop','ALL',
    '--new-session','--die-with-parent','--clearenv','--info-fd','3',
    ...c.mounts.flatMap(m=>['--ro-bind',m.source,m.guest]),'--ro-bind',configPath,'/input/candidate.json',
    '--symlink','/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1','/lib/ld-linux-aarch64.so.1',
    '--proc','/proc','--dev','/dev','--size',String(limits.tmpfsBytes),'--tmpfs','/tmp',
    '--size',String(limits.tmpfsBytes),'--tmpfs','/output','--dir','/output/home','--dir','/output/cache','--dir','/output/config',
    '--setenv','HOME','/output/home','--setenv','XDG_CACHE_HOME','/output/cache','--setenv','XDG_CONFIG_HOME','/output/config',
    '--setenv','TMPDIR','/tmp','--setenv','LANG','C','--chdir','/output','--remount-ro','/',
    '/bin/qemu','/bin/node','--max-old-space-size='+limits.nodeOldSpaceMiB,'/input/driver.mjs'];
  const args=['--signal=KILL',String(limits.wallSeconds),tools.prlimit.file,
    '--as='+limits.addressSpaceBytes,'--cpu='+limits.cpuSeconds,'--nofile='+limits.openFiles,'--fsize='+limits.perFileBytes,'--core=0','--',tools.bwrap.file,...bargs];
  const startedAt=new Date().toISOString();
  let result;
  try{
    result=await new Promise(resolve=>{
      const child=spawn(tools.timeout.file,args,{cwd:work,env:cleanEnv,stdio:['ignore','pipe','pipe','pipe']});
      const output={stdout:[],stderr:[],info:[]},counts={stdout:0,stderr:0,info:0};let stopReason=null,spawnError=null;
      const timer=setTimeout(()=>{stopReason='parent-hard-deadline';child.kill('SIGKILL');},limits.parentKillMs);
      for(const [index,name] of [[1,'stdout'],[2,'stderr'],[3,'info']])child.stdio[index].on('data',chunk=>{
        const max=name==='info'?65536:limits[name+'Bytes'];const remaining=Math.max(0,max-counts[name]);
        if(remaining)output[name].push(chunk.subarray(0,remaining));counts[name]+=chunk.length;
        if(counts[name]>max&&!stopReason){stopReason=name+'-limit';child.kill('SIGKILL');}
      });
      child.on('error',e=>{spawnError=e.code??'SPAWN_ERROR';});
      child.on('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal,stopReason,spawnError,counts,
        stdout:Buffer.concat(output.stdout).toString('utf8'),stderr:Buffer.concat(output.stderr).toString('utf8'),
        info:Buffer.concat(output.info).toString('utf8'),stderrComplete:counts.stderr<=limits.stderrBytes,
        stdoutComplete:counts.stdout<=limits.stdoutBytes});});
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
  const parseLine=prefix=>{const lines=result.stdout.split('\n').filter(s=>s.startsWith(prefix));if(lines.length!==1)return null;try{return JSON.parse(lines[0].slice(prefix.length));}catch{return null;}};
  const preflight=parseLine('WHALE_PREFLIGHT='),observed=parseLine('WHALE_RESULT=');
  const stages=result.stdout.split('\n').filter(s=>s.startsWith('WHALE_STAGE=')).map(s=>{try{return JSON.parse(s.slice(12));}catch{return {invalid:true};}});
  let containerInfo=null;try{containerInfo=JSON.parse(result.info);}catch{}
  const childPid=containerInfo?.['child-pid'];
  // bwrap/timeout close can precede kernel reaping of the namespace child by a
  // scheduling tick. Wait at most 2s for this exact reported PID; never kill or
  // inspect unrelated processes and never treat close alone as cleanup proof.
  const cleanupStart=Date.now();
  if(Number.isInteger(childPid))while(fs.existsSync('/proc/'+childPid)&&Date.now()-cleanupStart<2000)
    await new Promise(resolve=>setTimeout(resolve,25));
  const cleanup={transportClosed:true,containerChildPid:childPid??null,cleanupWaitMs:Date.now()-cleanupStart,
    containerChildAbsent:Number.isInteger(childPid)?!fs.existsSync('/proc/'+childPid):null,
    writableHostBindCount:0,privateOutputDiscardedOnNamespaceExit:true};
  verifyMounts(c.mounts);for(const s of c.sources)assert.equal(sha(s.source),s.sha256);
  const passed=result.status===0&&!result.stopReason&&result.stderrComplete&&result.stdoutComplete&&
    preflight&&Object.values(preflight.checks).every(Boolean)&&observed&&observed.stage===(actual?'completed':'preflight-only-complete')&&cleanup.containerChildAbsent===true;
  const report={schema:1,startedAt,endedAt:new Date().toISOString(),kind:actual?'actual-linux-arm64-qq-firstload':'arm64-candidate-preview',
    passed:Boolean(passed),candidateSha256:sha(candidateFile),command:{program:tools.timeout.file,args},limits,
    process:result,preflight,observed,stages,cleanup,inputsVerifiedAfter:true,
    phoneAccessed:false,loginInvoked:false,businessExportsInvoked:0,
    actualQqAttempted:actual,actualQqReachedWrapper:stages.some(s=>s.stage==='wrapper-dlopen:start'),
    limitations:c.unresolved,resourceLimitNotes:c.resourceLimitNotes};
  writeNew(path.join(work,'parent-record.json'),report);
  const evidence=path.join(root,'evidence/phone-arm64-firstload-'+(actual?'execution':'preview')+'-'+path.basename(work)+'.json');
  writeNew(evidence,report);
  console.log(JSON.stringify({mode,passed:report.passed,candidate:path.relative(root,candidateFile),evidence:path.relative(root,evidence),
    work:path.relative(root,work),status:result.status,signal:result.signal,stderr:result.stderr,stderrComplete:result.stderrComplete,
    stages,exportCount:observed?.names?.length??0,cleanup},null,2));
  return report;
}
if(mode==='--preview'){
  const candidate=build();const report=await run(candidate,false);
  console.log(JSON.stringify({prepared:true,qqExecuted:false,inputCount:candidate.mounts.length,normalProviderRoots:candidate.normalRoots.length,
    bindings:{wrapper:candidate.wrapperBinding,normal:candidate.normalLibraryBinding,provider:candidate.providerBinding},limits,
    exactExecutionCommand:['wsl','-d','Debian','--','/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C','LC_ALL=C',
      path.join(root,'.tools/node-v24.20.0-linux-x64/bin/node'),path.join(root,'scripts/phone-adaptation/arm64-firstload.mjs'),'--execute']},null,2));
  if(!report.passed)process.exitCode=1;
}else{
  const c=readJson(root,'experiments/phone-arm64-firstload/candidate-v2.json',1024*1024).value;
  const report=await run(c,true);if(!report.passed)process.exitCode=1;
}
