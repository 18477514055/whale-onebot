import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Executes only the fixed original synthetic script. No QQ/native paths accepted.
if(process.platform!=='linux'||process.arch!=='x64'||process.argv.length!==2)throw Error('Linux x64 synthetic isolation probe only');
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bwrap=path.join(root,'.tools/bubblewrap/extracted/usr/bin/bwrap');
const source=path.join(root,'experiments/linux-isolation/probe.mjs');
const native=path.join(root,'.tmp/native-stopping/stopping.node');
const nativeEvidence=JSON.parse(fs.readFileSync(path.join(root,'evidence/native-stopping-linux.json'),'utf8'));
assert.equal(hash(native),nativeEvidence.fixture.sha256,'Original C++ fixture changed since verification');
assert.equal(hash(process.execPath),nativeEvidence.node.sha256,'Native fixture requires the verified Node executable');
const work=fs.mkdtempSync(path.join(root,'.tmp/isolation-'));
for(const p of [bwrap,source,work,process.execPath,native])assert(fs.realpathSync(p).startsWith(root+'/'));
const output=path.join(work,'output');fs.mkdirSync(output);
for(const name of ['home','config','cache'])fs.mkdirSync(path.join(output,name));
const canary=path.join(work,'not-mounted.txt'),input=path.join(work,'readonly.txt');
fs.writeFileSync(canary,'synthetic-host-canary');fs.writeFileSync(input,'synthetic-read-only');
const canaryHash=hash(canary);
const namespaces=Object.fromEntries(['user','net','mnt','pid','ipc'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));
let connections=0;
const server=net.createServer(socket=>{connections++;socket.end();});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.on('connect',()=>{socket.end();resolve();});socket.on('error',reject);});
const args=['--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv',
 '--ro-bind','/usr/lib/x86_64-linux-gnu','/lib/x86_64-linux-gnu',
 '--symlink','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2',
 '--ro-bind',process.execPath,'/bin/node','--ro-bind',source,'/input/probe.mjs','--ro-bind',input,'/input/readonly.txt','--ro-bind',native,'/input/stopping.node',
 '--bind',output,'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
 '--setenv','HOME','/output/home','--setenv','XDG_CONFIG_HOME','/output/config','--setenv','XDG_CACHE_HOME','/output/cache',
 '--setenv','TMPDIR','/tmp','--setenv','CANARY_PATH',canary,'--setenv','PROBE_PORT',String(port),
 '--chdir','/output','--remount-ro','/','/bin/node','/input/probe.mjs'];
let observed;
try{
 observed=await new Promise((resolve,reject)=>{
  const child=spawn(bwrap,args,{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C',WHALE_SYNTHETIC_SECRET:'synthetic-only'},cwd:work});
  let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  child.stdout.on('data',data=>{stdout+=data;if(stdout.length>65536)child.kill('SIGKILL');});
  child.stderr.on('data',data=>{stderr+=data;if(stderr.length>65536)child.kill('SIGKILL');});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',(code,signal)=>{
   clearTimeout(timer);
   if(code!==0||signal){reject(Error(JSON.stringify({code,signal,stderr})));return;}
   try{
    const records=stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(records.length,2);
    assert.deepEqual(records[0],{mode:'baseline',before:'running',after:'running',beforeBoolean:false,afterBoolean:false,sameEnvironment:true,stopResult:-1});
    resolve({...records[1],nativeBaseline:records[0]});
   }catch(error){reject(error);}
  });
 });
}finally{await new Promise(resolve=>server.close(resolve));}
assert.equal(connections,1,'namespace reached host listener');
assert.equal(hash(canary),canaryHash);assert.equal(fs.readFileSync(input,'utf8'),'synthetic-read-only');
assert.equal(fs.readFileSync(path.join(output,'probe-ok.txt'),'utf8'),'synthetic-output');
for(const n of Object.keys(namespaces))assert.notEqual(observed.namespaces[n],namespaces[n]);
const report={at:new Date().toISOString(),platform:process.platform,node:process.version,
 tool:{path:bwrap,sha256:hash(bwrap),version:execFileSync(bwrap,['--version'],{encoding:'utf8'}).trim(),archiveSha256:'70aca4fa8daeacb677ec00e8063eb586f08ae3d94b1f11e684370b5524c43431'},
 sourceSha256:hash(source),runnerSha256:hash(fileURLToPath(import.meta.url)),nodeSha256:hash(process.execPath),nativeFixtureSha256:hash(native),args,
 observed,parentNamespaces:namespaces,hostPositiveConnections:connections,canaryUnchanged:true,allowedOutputVisible:true,
 limits:['Synthetic file, environment, process namespace and host-loopback checks only','No QQ executed or files accessed','Not a complete hostile-code containment proof','No Windows isolation claim','Only per-run output directory is bound writable; proc/dev/tmp are private runtime mounts']};
fs.writeFileSync(path.join(root,'evidence/linux-isolation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,checks:observed.checks,hostPositiveConnections:connections,canaryUnchanged:true},null,2));
