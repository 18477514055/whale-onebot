// Original synthetic uv_async regression and corrected Windows host build. No QQ.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createExportPlan,renderForwarderDef} from './windows-host-exports.mjs';
import {inspectPE} from './inspect-pe.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex'),hash=p=>sha(fs.readFileSync(p));
assert.equal(process.argv.length,2);assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');
assert.equal(process.version,'v24.20.0');
assert.equal(hash(process.execPath),'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5');
assert.equal(sha(JSON.stringify(process.config)),'cef8c4e3f5021ff106d9d0a910912e6336d56faaec280e8000ee84227fa86a96');
const pinned={
 'evidence/native-stopping-win32.json':'27611a27aad8e130b7a9fa0cbf5c28713f4653e885c6c6731c319999be872d09',
 'evidence/native-host-win32.json':'0ac9d076223812aad71f55323c55b7a798b05329d397932bdf4b126277d2b68b',
 'src/native/node-host.h':'31cc9885cdf4ff0783419e821af00162c35e77a4e81fa135498f6020572e817d',
 'experiments/native-host-scope/probe.cc':'6089f8e43687afc430d231331fe5adce0bc701ccc6d3b59b0f9eca15eb712551',
};
for(const [p,h]of Object.entries(pinned))assert.equal(hash(path.join(root,p)),h,p);
const prior=JSON.parse(fs.readFileSync(path.join(root,'evidence/native-stopping-win32.json')));
const old=JSON.parse(fs.readFileSync(path.join(root,'evidence/native-host-win32.json')));
for(const [p,h]of Object.entries(old.pins.files))if(p!=='src/native/node-host.h')assert.equal(hash(path.join(root,p)),h,p);
const nativePins=JSON.parse(fs.readFileSync(path.join(root,'experiments/native-host/pins.json')));
for(const [p,h]of Object.entries(nativePins.files))if(p.startsWith('.tools/'))assert.equal(hash(path.join(root,p)),h,p);
function treeHash(dir,extensions){
 const entries=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){
  const f=path.join(p,e.name);assert(!e.isSymbolicLink());if(e.isDirectory())walk(f);else{assert(e.isFile());if(!extensions||extensions.includes(path.extname(f).toLowerCase()))entries.push([path.relative(dir,f).replaceAll('\\','/'),hash(f)]);}
 }}walk(dir);entries.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return sha(entries.map(([p,h])=>`${p}\0${h}\n`).join(''));
}
for(const t of old.pins.buildTrees)assert.equal(treeHash(path.join(root,t.path),t.extensions),t.sha256,t.path);
for(const [p,h]of [[prior.build.compiler,prior.build.compilerSha256],[prior.build.linker,prior.build.linkerSha256],[old.provider.path,old.provider.sha256]])assert.equal(hash(p),h);
const temp=path.join(root,'.tmp');assert.equal(fs.realpathSync(temp),temp);
const work=fs.mkdtempSync(path.join(temp,'native-host-scope-win32-'));
const positive=path.join(work,'corrected'),negative=path.join(work,'old');fs.mkdirSync(positive);fs.mkdirSync(negative);
const report={schemaVersion:1,at:new Date().toISOString(),scope:'original Windows uv_async callback consumer only; no QQ',work,pinned,oldProvider:{path:old.provider.path,sha256:old.provider.sha256},build:[],cases:[],passed:false};
const target=path.join(root,'evidence/native-host-scope-win32.json');
function save(){if(fs.existsSync(target)){const st=fs.lstatSync(target);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1);}fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');}
const env={...process.env,TEMP:work,TMP:work};for(const k of ['NODE_OPTIONS','NODE_PATH','CL','_CL_','LINK','_LINK_','INCLUDE','LIB'])delete env[k];env.PATH=path.join(process.env.SystemRoot,'System32');
function run(exe,args,cwd=work){const r=spawnSync(exe,args,{cwd,env,windowsHide:true,timeout:30000,encoding:'utf8',maxBuffer:1024*1024});return {status:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout??'',stderr:r.stderr??''};}
const plan=createExportPlan(JSON.parse(fs.readFileSync(path.join(root,'evidence/native-abi.json'))));
const def=path.join(positive,'provider.def');fs.writeFileSync(def,renderForwarderDef(plan,'node.exe'));
const provider=path.join(positive,'onebot-node-host.dll'),library=path.join(positive,'onebot-node-host.lib'),consumer=path.join(positive,'consumer.node');
for(const [name,source,dest,extras]of [['provider','src/native/node-host-win32.cc',provider,[`/DEF:${def}`]],['consumer','experiments/native-host-scope/probe.cc',consumer,[library]]]){
 const object=path.join(positive,name+'.obj');
 const compile=[...prior.build.commonCompileArgs,`/Fo${object}`,path.join(root,source)];
 const a=run(prior.build.compiler,compile);report.build.push({name,phase:'compile',args:compile,...a});save();assert.equal(a.status,0,JSON.stringify(a));
 const link=[...prior.build.commonLinkArgs,`/OUT:${dest}`,`/IMPLIB:${name==='provider'?library:path.join(positive,'consumer.lib')}`,...extras,object,...prior.build.additionalObjects];
 const b=run(prior.build.linker,link);report.build.push({name,phase:'link',args:link,...b});save();assert.equal(b.status,0,JSON.stringify(b));
}
const pe=inspectPE(fs.readFileSync(provider));assert.equal(pe.exports.entries.filter(x=>x.kind!=='unused').length,99);assert.equal(pe.exports.entries.filter(x=>x.kind==='forwarder').length,97);
report.provider={path:provider,sha256:hash(provider),bytes:fs.statSync(provider).size,pe};report.consumer={path:consumer,sha256:hash(consumer)};
fs.copyFileSync(old.provider.path,path.join(negative,'onebot-node-host.dll'));fs.copyFileSync(consumer,path.join(negative,'consumer.node'));
for(const dir of [positive,negative])fs.writeFileSync(path.join(dir,'child.cjs'),"require('./consumer.node').start(process.argv[2] === 'stop');\n");
for(const [mode,dir]of [['old',negative],['running',positive],['stop',positive]]){
 assert.equal(hash(path.join(dir,'consumer.node')),report.consumer.sha256);assert.equal(hash(path.join(dir,'onebot-node-host.dll')),mode==='old'?old.provider.sha256:report.provider.sha256);
 const r=run(process.execPath,[path.join(dir,'child.cjs'),mode],dir);report.cases.push({mode,...r});save();
 if(mode==='old'){assert.notEqual(r.status,0);assert.match(r.stderr,/Cannot create a handle without a HandleScope/);assert.equal(r.stdout,'');}
 else{assert.equal(r.status,mode==='stop'?1:0,JSON.stringify(r));assert.equal(r.stderr,'');const v=JSON.parse(r.stdout);assert.equal(v.callback,'uv_async');assert.equal(v.before,false);assert.equal(v.after,mode==='stop');assert.equal(v.stopResult,mode==='stop'?0:-1);assert.equal(v.sameIsolate,true);assert.equal(v.inContext,true);assert.equal(v.nullResult,true);assert.equal(v.foreignCurrent,false);assert.equal(v.foreignResult,true);assert.equal(v.threadCreated,0);assert.equal(v.threadJoined,0);report.cases.at(-1).observed=v;}
 report.cases.at(-1).passed=true;save();
}
report.passed=true;report.scriptSha256=hash(fileURLToPath(import.meta.url));report.limitations=['No QQ or Tencent code executed','Exact Node binary/config and current official header/toolchain pins only','New callback evidence supersedes the old missing-scope implementation; old reports remain historical'];save();
console.log(JSON.stringify({passed:true,provider:report.provider.path,providerSha256:report.provider.sha256,cases:report.cases.map(({mode,status,passed,observed})=>({mode,status,passed,observed}))},null,2));
