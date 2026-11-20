import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root='/mnt/d/qq-onebot';assert.equal(process.platform,'linux');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
const imported=read('evidence/phone-agent-current-copy-20261115.json');
const runtime=read('evidence/phone-agent-current-runtime-20261115.json');
const deps=read('evidence/phone-agent-current-linux-deps-phone-agent-deps-OkS7xy-20261115.json');
assert(imported.passed&&deps.passed&&runtime.linuxWork.startsWith(root+'/.tmp/phone-agent-runtime-'));
const work=runtime.linuxWork,app=work+'/app';
if(!fs.existsSync(app)){
  fs.cpSync(imported.linuxDestination+'/app',app,{recursive:true,dereference:false,errorOnExist:true,force:false});
  fs.mkdirSync(app+'/node_modules');
}
const args=['-k','5','225',root+'/.tools/bubblewrap/extracted/usr/bin/bwrap',
  '--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent',
  '--cap-drop','ALL','--clearenv','--ro-bind','/usr/lib/x86_64-linux-gnu','/lib/x86_64-linux-gnu',
  '--symlink','/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib64/ld-linux-x86-64.so.2',
  '--ro-bind',process.execPath,'/bin/node','--proc','/proc','--dev','/dev','--tmpfs','/tmp',
  '--ro-bind',app,'/app','--ro-bind',deps.app+'/node_modules','/app/node_modules',
  '--bind',work+'/data','/working','--bind',work+'/home','/lab-home',
  '--bind',work+'/data','/data/data/com.termux/files/home/qqagent/data',
  '--ro-bind',app,'/data/data/com.termux/files/home/qqagent/app',
  '--ro-bind',deps.app+'/node_modules','/data/data/com.termux/files/home/qqagent/app/node_modules',
  '--ro-bind',root+'/experiments/boot-phone-agent-actual-data.mjs','/project/boot.mjs',
  '--setenv','HOME','/lab-home','--setenv','TMPDIR','/tmp','--setenv','TZ','Asia/Shanghai',
  '--chdir','/working','--remount-ro','/','/bin/node','/project/boot.mjs'];
const capture=await new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/timeout',args,{cwd:work,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{
    if(name==='stdout')stdout+=bytes;else stderr+=bytes;if(stdout.length+stderr.length>10485760)child.kill('SIGTERM');});
  child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
});
let observed;try{observed=JSON.parse(capture.stdout.trim());}catch{}
const report={at:new Date().toISOString(),passed:capture.code===0&&observed?.passed===true,
  work,applicationVersion:imported.applicationVersion,importedSource:imported.linuxDestination,
  dependencies:deps.work,observed,capture};
const output=path.join(root,'evidence/phone-agent-actual-data-boot-warm-20261115.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:report.passed,output,health:observed?.health,exit:observed?.exit,
  stderr:capture.stderr,appStderr:observed?.logs?.stderr,...(!report.passed?{errorCode:observed?.errorCode,stdout:capture.stdout}:{})}));
if(!report.passed)process.exitCode=1;
