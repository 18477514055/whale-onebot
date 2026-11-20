// Current user-authorized phone -> project copy; never writes phone or old project.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
assert.equal(process.platform,'win32');
const root=path.resolve(import.meta.dirname,'..');
const destination=fs.mkdtempSync(path.join(root,'.tmp/phone-agent-current-'));
const linuxDestination='/mnt/d/qq-onebot/.tmp/'+path.basename(destination);
const source=fs.readFileSync(path.join(root,'experiments/phone-agent-current-snapshot.py'));
const phoneCommand=`echo ${source.toString('base64')} | base64 -d | python3 -`;
// The already-verified phone python3 parses the whole program before execution;
// the minimal WSL image need not install Python just to extract its tar stream.
const ssh=spawn('ssh.exe',['-T','-i','D:/QQ-Agent/phone-deploy/ssh/phone_key','-p','8022',
  '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5',
  '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','u0_a254@100.75.35.64',phoneCommand],
  {stdio:['ignore','pipe','pipe']});
const tar=spawn('wsl.exe',['-d','Debian','--exec','tar','--extract','--file=-','--no-same-owner',
  '--no-same-permissions','--directory',linuxDestination],{stdio:['pipe','ignore','pipe']});
let transferred=0,lastProgress=0;
ssh.stdout.on('data',bytes=>{transferred+=bytes.length;if(transferred-lastProgress>=268435456){
  lastProgress=transferred;console.log(JSON.stringify({status:'copying',transferredBytes:transferred}));}});
const capture=(child,label)=>new Promise((resolve,reject)=>{
  let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>65536)child.kill();});
  child.once('error',reject);child.once('close',(code,signal)=>resolve({label,code,signal,stderr}));
});
const captures=[capture(ssh,'phone-export'),capture(tar,'project-extraction')];
const deadline=setTimeout(()=>{ssh.kill();tar.kill();},15*60000);
console.log(JSON.stringify({status:'copying',destination,linuxDestination,authority:'current-phone-business-data-copy'}));
let result;
try{
  const [processes]=await Promise.all([Promise.all(captures),pipeline(ssh.stdout,tar.stdin)]);
  if(processes.some(p=>p.code!==0)){
    // Exporter errors are fixed codes; SSH/tar errors are retained locally only.
    const errorFile=path.join(destination,'copy-process-errors.json');
    fs.writeFileSync(errorFile,JSON.stringify(processes,null,2)+'\n',{flag:'wx'});
    throw Error('PHONE_COPY_PROCESS_FAILED');
  }
  console.log(JSON.stringify({status:'verifying',transferredBytes:transferred}));
  const manifest=JSON.parse(fs.readFileSync(path.join(destination,'snapshot-manifest.json'),'utf8'));
  const summary=JSON.parse(fs.readFileSync(path.join(destination,'snapshot-summary.json'),'utf8'));
  let files=0,bytes=0,sqlite=0,changed=0;
  const observed=[];
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name),s=fs.lstatSync(full);assert(!s.isSymbolicLink());
    if(s.isDirectory())walk(full);else{assert(s.isFile());observed.push(path.relative(destination,full).split(path.sep).join('/'));}}}
  for(const tree of ['app','data'])walk(path.join(destination,tree));
  assert.equal(observed.length,Object.keys(manifest).length);
  for(const name of observed){
    const expected=manifest[name];assert(expected);
    assert(/^(app|data)\//.test(name)&&path.posix.normalize(name)===name&&!name.split('/').includes('..'));
    const full=path.join(destination,...name.split('/')),s=fs.lstatSync(full);assert.equal(s.size,expected.bytes);
    const hash=createHash('sha256');for await(const chunk of fs.createReadStream(full))hash.update(chunk);
    assert.equal(hash.digest('hex'),expected.sha256,'SNAPSHOT_DIGEST_MISMATCH');
    files++;bytes+=s.size;if(expected.changedDuringRead)changed++;
    if(expected.sqlite){const db=new DatabaseSync(full,{readOnly:true});
      try{assert.deepEqual(db.prepare('PRAGMA quick_check').all().map(row=>row.quick_check),['ok']);}
      finally{db.close();}sqlite++;}
  }
  assert.equal(files,summary.files);assert.equal(bytes,summary.bytes);assert.equal(sqlite,summary.sqlite);
  for(const name of ['app/src/server.js','app/package.json','data/config.json','data/messages.sqlite'])assert(manifest[name]);
  for(const prefix of ['data/memory/','data/knowledge-lib/','data/sessions/'])assert(Object.keys(manifest).some(name=>name.startsWith(prefix)));
  const config=JSON.parse(fs.readFileSync(path.join(destination,'data/config.json'),'utf8'));
  function checkConfig(value){if(Array.isArray(value)){for(const item of value)checkConfig(item);return;}
    if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
      if(/(?:api.?keys?|token|password|passwd|secret|authorization|credentials?)$/i.test(key))assert(item===''||item===null);
      else checkConfig(item);}}
  checkConfig(config);
  const packageInfo=JSON.parse(fs.readFileSync(path.join(destination,'app/package.json'),'utf8'));
  result={at:new Date().toISOString(),passed:true,source:'phone-current:/data/data/com.termux/files/home/qqagent',
    destination,linuxDestination,applicationVersion:packageInfo.version,files,bytes,sqlite,changedDuringRead:changed,
    credentialFilesOmitted:summary.credentialFilesOmitted,sanitizedConfigFiles:summary.sanitizedConfigFiles,
    originalPhoneModified:false,qqLoginStateCopied:false,globalSnapshotTime:false,
    exporterSha256:createHash('sha256').update(source).digest('hex'),
    limitations:['Each SQLite is a consistent individual snapshot, not a global transaction across all files.',
      'Configuration credential fields and standalone credential files excluded; no claim that arbitrary historical text never contained secrets.',
      'No actual App startup, real QQ/model send or persistent authorization backend proof in this copy step.'],
    processes};
  const output=path.join(root,'evidence/phone-agent-current-copy-20261115.json');
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...result,output}));
}finally{
  clearTimeout(deadline);if(ssh.exitCode===null)ssh.kill();if(tar.exitCode===null)tar.kill();
}
