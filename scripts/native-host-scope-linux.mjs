// Original real-libuv regression for the host adapter. Never loads QQ.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(script),'..');
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const digest=value=>createHash('sha256').update(value).digest('hex');
const headerSha256='31cc9885cdf4ff0783419e821af00162c35e77a4e81fa135498f6020572e817d';
const probeSha256='6089f8e43687afc430d231331fe5adce0bc701ccc6d3b59b0f9eca15eb712551';
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v24.20.0');
assert.equal(hash(process.execPath),'89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7');
assert.equal(digest(JSON.stringify(process.config)),'597675b4796f5de9bf52b9ebc9ac977ae624d45c2fdd7ae98f2f5fa748e08d7a');
assert.equal(hash(path.join(root,'src/native/node-host.h')),headerSha256);
assert.equal(hash(path.join(root,'experiments/native-host-scope/probe.cc')),probeSha256);
if(process.argv[2]==='--child'){
  assert.equal(process.argv.length,5);const mode=process.argv[3];assert(['old','baseline','stop'].includes(mode));
  const recordPath=fs.realpathSync(process.argv[4]);assert(recordPath.startsWith(root+'/.tmp/native-host-scope-'));
  const artifacts=JSON.parse(fs.readFileSync(recordPath,'utf8'));
  for(const a of Object.values(artifacts))assert.equal(hash(a.path),a.sha256);
  const require=createRequire(import.meta.url);
  assert.deepEqual(require(artifacts[mode==='old'?'oldLoader':'loader'].path),{providerLoaded:true});
  require(artifacts.probe.path).start(mode==='stop');
}else{
  assert.equal(process.argv.length,2);
  const work=fs.mkdtempSync(path.join(root,'.tmp/native-host-scope-'));
  const pins=JSON.parse(fs.readFileSync(path.join(root,'experiments/native-host/pins.json'),'utf8'));
  // Reuse every fixed original dependency pin, except the intentionally corrected
  // owned helper whose new literal expectation is checked above. Old pins stay unchanged.
  for(const [relative,expected]of Object.entries(pins.files))if(relative!=='src/native/node-host.h')assert.equal(hash(path.join(root,relative)),expected,relative);
  const prior=JSON.parse(fs.readFileSync(path.join(root,'evidence/native-stopping-linux.json'),'utf8'));
  assert.equal(digest(JSON.stringify(prior.build.args)),'188e4f50be4ec53cd33892b01fb8218699c51a2029433371de2ad57b5fe0fe1e');
  assert.equal(hash(prior.compiler.path),prior.compiler.sha256);
  const base=JSON.parse(fs.readFileSync(path.join(root,'experiments/first-native-load/manifest.json'),'utf8'));
  assert.equal(hash(base.provider.source),base.provider.sha256);
  const gcc=path.join(root,'.tools/gcc-linux/extracted/usr'),crtBegin=path.join(gcc,'lib/gcc/x86_64-linux-gnu/14/crtbeginS.o'),crtEnd=path.join(gcc,'lib/gcc/x86_64-linux-gnu/14/crtendS.o');
  const index=prior.build.args.indexOf(crtBegin);assert(index>0);const common=prior.build.args.slice(0,index);
  const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TMPDIR:work};
  const run=(exe,args,compile=false)=>{const r=spawnSync(exe,args,{cwd:work,env:compile?{...env,LD_LIBRARY_PATH:path.join(gcc,'lib/x86_64-linux-gnu')}:env,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});return {status:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.message??null};};
  const providerPath=path.join(work,'libonebot-node-host.so');
  const builds=[
    ['provider','src/native/node-host.cc','libonebot-node-host.so',[`-Wl,--version-script=${path.join(root,'experiments/native-host/exports.map')}`]],
    ['loader','experiments/native-host/bootstrap.cc','loader.node',[`-DPROVIDER_PATH="${providerPath}"`]],
    ['oldLoader','experiments/native-host/bootstrap.cc','old-loader.node',[`-DPROVIDER_PATH="${base.provider.source}"`]],
    ['probe','experiments/native-host-scope/probe.cc','probe.node',[]],
  ];
  const artifacts={},compilation=[];
  for(const [name,source,filename,extra]of builds){
    const file=path.join(work,filename),args=[...common,...extra,crtBegin,path.join(root,source),crtEnd,'-o',file];
    const result=run(prior.compiler.path,args,true);assert.equal(result.status,0,result.stderr);
    artifacts[name]={path:file,sha256:hash(file),bytes:fs.statSync(file).size};compilation.push({name,source,sourceSha256:hash(path.join(root,source)),args,...result});
  }
  const symbols=run('/usr/bin/nm',['-D','--defined-only','--format=posix',providerPath]);assert.equal(symbols.status,0);
  assert.deepEqual(symbols.stdout.trim().split('\n').map(line=>line.split(/\s+/)[0]).sort(),['_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE','qq_magic_napi_register']);
  const manifest=path.join(work,'artifacts.json');fs.writeFileSync(manifest,JSON.stringify(artifacts,null,2));
  const cases=[];
  for(const mode of ['old','baseline','stop']){
    const processResult=run(process.execPath,[script,'--child',mode,manifest]);let observed=null;
    if(mode==='old'){
      assert.equal(processResult.signal,'SIGABRT');assert.match(processResult.stderr,/Cannot create a handle without a HandleScope/);
    }else{
      assert.equal(processResult.signal,null);assert.equal(processResult.status,mode==='stop'?1:0,JSON.stringify(processResult));assert.equal(processResult.stderr,'');
      observed=JSON.parse(processResult.stdout);assert.equal(observed.callback,'uv_async');
      assert.equal(observed.sameIsolate,true);assert.equal(observed.inContext,true);assert.equal(observed.before,false);assert.equal(observed.after,mode==='stop');assert.equal(observed.stopResult,mode==='stop'?0:-1);
      assert.equal(observed.nullResult,true);assert.equal(observed.foreignCurrent,false);assert.equal(observed.foreignResult,true);assert.equal(observed.threadCreated,0);assert.equal(observed.threadJoined,0);
    }
    cases.push({mode,passed:true,process:processResult,observed});
  }
  assert.equal(hash(path.join(root,'src/native/node-host.h')),headerSha256);assert.equal(hash(base.provider.source),base.provider.sha256);
  const report={schemaVersion:1,at:new Date().toISOString(),passed:true,scope:'Original shared host correction and uv_async consumers only; no QQ',
    node:{path:process.execPath,sha256:hash(process.execPath),version:process.version},headerSha256,probeSha256,runnerSha256:hash(script),
    oldProvider:base.provider,artifacts,compilation,providerSymbols:symbols.stdout,cases,
    rationale:'Node SpinEventLoopInternal seals its outer handles. The host must create a local HandleScope before GetCurrentContext; checking thread/current isolate still precedes all instance access.',
    sources:['https://github.com/nodejs/node/blob/v24.20.0/src/api/embed_helpers.cc#L21-L40','https://github.com/nodejs/node/blob/v24.20.0/src/README.md#local-handles'],
    limitations:['Synthetic original consumers prove host behavior outside a N-API call stack; they do not prove QQ login or arbitrary native ABI.','Old evidence and fixed candidate artifacts deliberately remain unchanged.']};
  const destination=path.join(root,'evidence/native-host-scope-linux.json');fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:true,cases:cases.map(c=>({mode:c.mode,status:c.process.status,signal:c.process.signal,observed:c.observed})),provider:artifacts.provider,evidence:destination,evidenceSha256:hash(destination),headerSha256},null,2));
}
