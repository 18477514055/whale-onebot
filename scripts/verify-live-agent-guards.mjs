// Bounded synthetic-only runner. Linux optionally composes the frozen SQLite
// draft inside private volatile tmpfs. No real authorization paths or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const linux = process.argv.includes('--linux-posix');
if (linux && process.platform !== 'linux') throw Error('LINUX_REQUIRED');
const names = ['src/host/live-agent-trigger.mjs','src/host/live-agent-lease.mjs','src/host/inbound-challenge.mjs',
  'src/bridge/error.mjs','test/live-agent-trigger.test.mjs','test/live-agent-lease.test.mjs',
  ...(linux ? ['.tmp/live-agent-stage-store-draft.mjs','.tmp/live-agent-lease-posix-integration.mjs'] : [])];
const work = fs.mkdtempSync(path.join(root,'.tmp/live-agent-guard-verification-'));
const inputs = names.map(name => {
  const source=path.join(root,name),before=fs.lstatSync(source,{bigint:true});
  if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1n)throw Error('INPUT_TYPE');
  const bytes=fs.readFileSync(source),after=fs.lstatSync(source,{bigint:true});
  if(before.ino!==after.ino || before.dev!==after.dev || before.size!==after.size || before.mtimeNs!==after.mtimeNs)throw Error('INPUT_CHANGED');
  const target=path.join(work,name); fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  return {name,target,sha256:createHash('sha256').update(bytes).digest('hex')};
});
let executable=process.execPath,args=['--test','--test-timeout=15000','--test-reporter=tap',
  ...names.filter(name=>name.startsWith('test/')).map(name=>path.join(work,name))];
if(linux){
  executable='/usr/bin/timeout';
  args=['-k','2','45',path.join(root,'.tools/bubblewrap/extracted/usr/bin/bwrap'),
    '--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent',
    '--cap-drop','ALL','--clearenv','--ro-bind','/usr/lib/x86_64-linux-gnu','/lib/x86_64-linux-gnu',
    '--symlink','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2',
    '--ro-bind',process.execPath,'/bin/node','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
    '--dir','/project','--perms','0700','--tmpfs','/project/.tmp',
    ...inputs.flatMap(item=>['--ro-bind',item.target,'/project/'+item.name]),
    '--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--chdir','/project/.tmp','--remount-ro','/',
    '/bin/node','--test','--test-timeout=15000','--test-reporter=tap',
    '/project/test/live-agent-trigger.test.mjs','/project/test/live-agent-lease.test.mjs',
    '/project/.tmp/live-agent-lease-posix-integration.mjs'];
}
const capture=await new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:work,env:linux?{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}:{...process.env},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',overLimit=false;
  const collect=name=>bytes=>{ if(name==='stdout')stdout+=bytes;else stderr+=bytes;
    if(stdout.length+stderr.length>2*1048576){overLimit=true;child.kill('SIGTERM');} };
  child.stdout.on('data',collect('stdout')); child.stderr.on('data',collect('stderr'));
  child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,overLimit}));
});
const count=name=>Number(new RegExp('^# '+name+' (\\d+)','m').exec(capture.stdout)?.[1]??NaN);
const tests=count('tests'),pass=count('pass'),fail=count('fail'),skipped=count('skipped');
const report={at:new Date().toISOString(),platform:process.platform,node:process.version,
  passed:capture.code===0&&!capture.overLimit&&Number.isInteger(tests)&&tests>0&&pass===tests&&fail===0&&skipped===0,
  authority:linux?'Synthetic guards plus actual frozen SQLite draft, private POSIX tmpfs; not deployed/persistent authority.'
    :'Synthetic in-memory trigger/lease boundary tests; not real QQ/model/persistent-store deployment.',
  tests,pass,fail,skipped,inputs:inputs.map(({name,sha256})=>({name,sha256})),capture,
  realQQ:false,realModel:false,realPhaseInitialized:false,
  limitations:['DrvFS permission guard is unchanged; no real phase or runtime path opened.',
    'Trusted store/identity/native dependencies remain unwired; no verified live online classifier.',
    'Linux tmpfs reopen is volatile SQLite semantics, not host restart, ACL or power-loss persistence.',
    'Native callback provenance and actual beforeNative placement require a separately reviewed adapter.']};
const output=path.join(root,`evidence/live-agent-guards-${linux?'linux-posix':process.platform}-20261115.json`);
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,tests,pass,fail,skipped,output,stderr:capture.stderr,
  ...(!report.passed?{stdout:capture.stdout}:{})}));
if(!report.passed)process.exitCode=1;
