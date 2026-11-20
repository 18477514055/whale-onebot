import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectPE } from './inspect-pe.mjs';
import { createExportPlan, renderForwarderDef } from './windows-host-exports.mjs';
const script=fileURLToPath(import.meta.url), root=path.resolve(path.dirname(script),'..');
const output=path.join(root,'.tmp/native-forwarders-win32');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=file=>sha(fs.readFileSync(file));
const nodeSha='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
const cases=['node','node.exe','missing-provider','wrong-address'];
function physicalFile(filename) {
  assert.equal(fs.realpathSync(path.dirname(filename)),path.dirname(filename),'Linked artifact parent');
  if(fs.existsSync(filename)){
    const stat=fs.lstatSync(filename);
    assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'Linked or non-regular artifact');
    assert.equal(fs.realpathSync(filename),filename,'Artifact resolves elsewhere');
  }else{
    // existsSync follows links: an existing dangling link must also be rejected.
    try{fs.lstatSync(filename);assert.fail('Dangling artifact link');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
assert.equal(process.platform,'win32'); assert.equal(process.arch,'x64');
assert.equal(digest(process.execPath),nodeSha); assert.equal(path.basename(process.execPath).toLowerCase(),'node.exe');
const env={...process.env,TEMP:output,TMP:output};delete env.NODE_OPTIONS;delete env.NODE_PATH;
const run=(exe,args)=>{const r=spawnSync(exe,args,{cwd:output,env,encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:2*1024*1024});return {status:r.status,signal:r.signal,error:r.error?.message??null,stdout:r.stdout??'',stderr:r.stderr??''};};
if(process.argv[2]==='--child'){
  assert.equal(process.argv.length,6); assert(cases.includes(process.argv[3]));
  const base=path.join(output,process.argv[3]);
  assert.equal(fs.realpathSync(base),base);
  physicalFile(path.join(base,'probe.node'));physicalFile(path.join(base,'provider.dll'));
  assert.equal(digest(path.join(base,'probe.node')),process.argv[4]);
  assert.equal(digest(path.join(base,'provider.dll')),process.argv[5]);
  process.stdout.write(JSON.stringify(createRequire(import.meta.url)(path.join(base,'probe.node'))));
}else{
  assert.equal(process.argv.length,2);
  fs.mkdirSync(output,{recursive:true});assert.equal(fs.realpathSync(output),output);
  const guardDirectory=fs.mkdtempSync(path.join(output,'guards-'));
  const original=path.join(guardDirectory,'original.txt'),hardlink=path.join(guardDirectory,'hardlink.txt');
  fs.writeFileSync(original,'synthetic-only');fs.linkSync(original,hardlink);
  assert.throws(()=>physicalFile(hardlink),/Linked or non-regular/);
  fs.unlinkSync(hardlink);assert.equal(fs.readFileSync(original,'utf8'),'synthetic-only');
  const linkedParent=path.join(guardDirectory,'junction');fs.symlinkSync(guardDirectory,linkedParent,'junction');
  assert.throws(()=>physicalFile(path.join(linkedParent,'new.txt')),/Linked artifact parent/);
  fs.unlinkSync(linkedParent);
  const raw=fs.readFileSync(path.join(root,'evidence/native-abi.json'));
  assert.equal(sha(raw),'6a2a059e3cce149f81e09424a52601eb9d791cc18c983211ec461dd5a9f281a0');
  const plan=createExportPlan(JSON.parse(raw));
  const linker=path.join(root,'.tools/msvc-windows/.stage/toolchain/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/link.exe');
  const compiler=path.join(root,'.tools/tinycc-0.9.27/tcc/tcc.exe');
  const include=path.join(root,'.tools/node-v24.20.0-linux-x64/include/node');
  const source=path.join(root,'experiments/native-host-win32/forwarder-probe.c');
  const evidence={generatedAt:new Date().toISOString(),scope:'original forwarder DLL only; no QQ load',nodeSha256:nodeSha,
    pathGuards:{hardlinkRejected:true,linkedParentRejected:true,syntheticTargetUnchanged:true},
    linker:{path:linker,sha256:digest(linker)},compiler:{path:compiler,sha256:digest(compiler)},
    sourceSha256:digest(source),scriptSha256:digest(script),generatorSha256:digest(path.join(root,'scripts/windows-host-exports.mjs')),
    headerSha256:Object.fromEntries(['node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'].map(name=>[name,digest(path.join(include,name))])),staticEvidenceSha256:sha(raw),cases:[]};
  for(const name of cases){
    const base=path.join(output,name);fs.mkdirSync(base,{recursive:true});assert.equal(fs.realpathSync(base),base);
    let definition=renderForwarderDef(plan,name==='node'?'node':'node.exe',{includeImplementations:false});
    if(name==='missing-provider')definition=definition.replaceAll('node.exe.','onebot_nonexistent_provider.');
    if(name==='wrong-address')definition=definition.replace('napi_call_function=node.exe.napi_call_function','napi_call_function=node.exe.napi_create_uint32');
    const def=path.join(base,'provider.def'),dll=path.join(base,'provider.dll'),fixture=path.join(base,'probe.node');
    for(const file of ['provider.def','provider.dll','provider.lib','provider.exp','probe.node','probe.def','probe-config.h'])physicalFile(path.join(base,file));
    fs.writeFileSync(def,definition);
    const linked=run(linker,['/nologo','/dll','/noentry','/machine:x64','/def:'+def,'/out:'+dll,'/implib:'+path.join(base,'provider.lib')]);
    assert.equal(linked.status,0,JSON.stringify(linked));
    const pe=inspectPE(fs.readFileSync(dll)), exports=pe.exports.entries.filter(x=>x.kind!=='unused');
    assert.equal(exports.length,97);assert(exports.every(x=>x.kind==='forwarder'));assert.equal(pe.imports.length,0);
    assert.deepEqual(exports.flatMap(x=>x.names.map(n=>n.name)).sort(),plan.forwards);
    for(const item of exports){const prefix=name==='missing-provider'?'onebot_nonexistent_provider':name==='node'?'node':'node.exe';const symbol=name==='wrong-address'&&item.names[0].name==='napi_call_function'?'napi_create_uint32':item.names[0].name;assert.equal(item.forwarder,prefix+'.'+symbol);}
    fs.writeFileSync(path.join(base,'probe-config.h'),`#define PROVIDER_PATH ${JSON.stringify(dll)}\nstatic const char* symbols[]={${plan.forwards.map(x=>JSON.stringify(x)).join(',')}};\n`);
    const compiled=run(compiler,['-shared','-I',include,'-I',base,source,'-o',fixture]);
    assert.equal(compiled.status,0,JSON.stringify(compiled));
    const result=run(process.execPath,[script,'--child',name,digest(fixture),digest(dll)]);
    assert.equal(result.status,0,JSON.stringify(result));
    const observed=JSON.parse(result.stdout);
    assert.equal(observed.loaded,1);
    // Empirically pinned for this executable: the .exe suffix is required.
    if(name==='node.exe')assert.deepEqual(observed,{answer:42,loaded:1,resolved:97,equal:97,called:3});
    else if(name==='wrong-address')assert.deepEqual(observed,{loaded:1,resolved:97,equal:96,called:0});
    else assert.deepEqual(observed,{loaded:1,resolved:0,equal:0,called:0});
    evidence.cases.push({name,linked,compiled,process:result,observed,providerSha256:digest(dll),fixtureSha256:digest(fixture),exports:exports.map(x=>({names:x.names.map(n=>n.name),forwarder:x.forwarder}))});
  }
  fs.writeFileSync(path.join(root,'evidence/native-forwarders-win32.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence.cases.map(x=>({name:x.name,observed:x.observed})),null,2));
  assert(evidence.cases.some(x=>x.name!=='missing-provider'&&x.observed.equal===97&&x.observed.called===3),'No working forwarder contract');
}
