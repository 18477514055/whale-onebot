import test from 'node:test';
import assert from 'node:assert/strict';
import {createIntegratedHostPlan} from '../src/host/integrated-plan.mjs';
import { BOT_UIN } from '../src/config/account.mjs';
const linux=()=>({platform:'linux',projectRoot:'/mnt/d/qq-onebot',profileId:'synthetic_profile_01',inputs:[
 {kind:'node',source:'/mnt/d/qq-onebot/.tools/node/bin/node',guest:'/bin/node',sha256:'89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7',bytes:1},
 {kind:'provider',source:'/mnt/d/qq-onebot/.tmp/corrected/libonebot-node-host.so',guest:'/host/libonebot-node-host.so',sha256:'8076d233a6c9894e4eef1aa2e89929958eb1283b24980bb25e9e3ddae4fe01a3',bytes:1},
 {kind:'wrapper',source:'/mnt/d/qq-onebot/.tools/qq/wrapper.node',guest:'/app/wrapper.node',sha256:'dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328',bytes:1},
 {kind:'loader',source:'/mnt/d/qq-onebot/.tmp/corrected/loader.node',guest:'/input/loader.node',sha256:'24924d280660325402234f435178c576cc0acb9479c21240df5f0367fb4b9a45',bytes:1},
 {kind:'source',source:'/mnt/d/qq-onebot/src/core.mjs',guest:'/qq-onebot/src/core.mjs',sha256:'a'.repeat(64),bytes:1},
 {kind:'dependency',source:'/mnt/d/qq-onebot/node_modules/sharp/package.json',guest:'/qq-onebot/node_modules/sharp/package.json',sha256:'b'.repeat(64),bytes:1},
]});
test('pure integrated plan binds deterministic input inventory and declares fresh writable profile only',()=>{
 const input=linux(),p=createIntegratedHostPlan(input);assert.equal(p.executable,false);assert.equal(p.nodeVersion,'v24.20.0');assert.equal(p.account,BOT_UIN);
 assert.equal(p.profile.automaticReuse,false);assert.equal(p.profile.mustCreateExclusively,true);assert.equal(p.inputManifest.actualBytesVerified,false);assert.equal(p.inputManifest.completeTreesVerified,false);
 assert.equal(p.mounts.find(x=>x.guest==='/qq-onebot/runtime').source,'/mnt/d/qq-onebot/runtime/integrated/synthetic_profile_01');
 assert.equal(p.mounts.filter(x=>x.access.includes('write')).length,2);assert.equal(p.decoder.sharesNativeAddressSpaceWithQq,false);
 input.inputs.reverse();assert.equal(createIntegratedHostPlan(input).inputManifest.sha256,p.inputManifest.sha256);
 input.inputs[0].sha256='c'.repeat(64);assert.notEqual(createIntegratedHostPlan(input).inputManifest.sha256,p.inputManifest.sha256);
 assert.throws(()=>{p.currentBusinessGate.open=true;},TypeError);assert.equal(p.currentBusinessGate.open,false);
});
test('both official three-argument online observations are present without inventing identity or online proof',()=>{
 const p=createIntegratedHostPlan(linux());for(const name of ['onUserOnlineResult','onRegisterProxyOnlineResp']){const o=p.observations.find(x=>x.name===name);assert.equal(o.arity,3);assert.equal(o.record.rawPayload,false);assert.equal(o.record.identityValues,'compare-only');}
 assert.equal(p.threeArgumentOnlineObservation.identityPresentInResponse,false);assert(p.threeArgumentOnlineObservation.freeTextFieldsOmitted.includes('serverTime'));
 assert.equal(p.currentBusinessGate.readRuntimeProofImplemented,false);assert.equal(p.currentBusinessGate.onlineClassifierImplemented,false);
 assert.equal(p.sequence.at(-1).implemented,false);assert(p.sequence.some(s=>s.noImmediateRestartOfLive===true));
 assert.equal(p.control.eval,false);assert.equal(p.control.arbitraryMethod,false);
});
test('guest content fingerprint survives workspace relocation and changes when mounted bytes or paths change', () => {
 const input = linux();
 const original = createIntegratedHostPlan(input).inputManifest;
 const relocated = structuredClone(input);
 relocated.projectRoot = '/mnt/d/other/qq-onebot';
 relocated.profileId = 'synthetic_profile_02';
 for (const entry of relocated.inputs)
   entry.source = entry.source.replace(input.projectRoot, relocated.projectRoot);
 relocated.inputs.reverse();
 const moved = createIntegratedHostPlan(relocated).inputManifest;
 assert.notEqual(moved.sha256, original.sha256);
 assert.equal(moved.contentSha256, original.contentSha256);
 const source = relocated.inputs.find(entry => entry.kind === 'source');
 source.sha256 = 'c'.repeat(64);
 assert.notEqual(createIntegratedHostPlan(relocated).inputManifest.contentSha256, original.contentSha256);
 source.sha256 = 'a'.repeat(64);
 relocated.inputs.push({ ...source, source: '/mnt/d/other/qq-onebot/src/other.mjs', guest: '/qq-onebot/src/other.mjs' });
 assert.notEqual(createIntegratedHostPlan(relocated).inputManifest.contentSha256, original.contentSha256);
});
test('old data paths, mount escape, duplicate identities and old provider cannot form a runnable-looking plan',()=>{
 for(const change of [
  x=>x.inputs[0].source='/mnt/d/QQ-Agent/data/config.json',x=>x.inputs[0].source='/mnt/d/qq-onebot/runtime/old/node',
  x=>x.inputs[0].guest='/qq-onebot/runtime/overwrite',x=>x.inputs[0].guest='/native/../runtime/node',
  x=>x.inputs.push({...x.inputs[0]}),x=>x.inputs[1].sha256='f53b2b221ad74969eaf123d7bc7ad6483da70ac912df77c435c0c9f23acdcec4',
  x=>x.inputs.splice(3,1),x=>x.profileId='../old-profile',x=>x.inputs[4].guest='/qq-onebot/src/other.mjs',
  x=>x.inputs[0].source='/mnt/d/qq-onebot/.tmp/integrated-synthetic_profile_01/node',
  x=>x.inputs[4].kind='metadata',x=>x.inputs[0].guest='/bin/another-node',
 ]){const x=linux();change(x);assert.throws(()=>createIntegratedHostPlan(x),TypeError);}
});
test('inert JSON-like inputs only: accessors and native callbacks never execute',()=>{
 let calls=0;const input=linux();Object.defineProperty(input.inputs[0],'source',{get(){calls++;return 'unused';}});assert.throws(()=>createIntegratedHostPlan(input));assert.equal(calls,0);
 const top=linux();Object.defineProperty(top,'projectRoot',{get(){calls++;return '/mnt/d/qq-onebot';}});assert.throws(()=>createIntegratedHostPlan(top));assert.equal(calls,0);
 const extra=linux();extra.spawn=()=>calls++;assert.throws(()=>createIntegratedHostPlan(extra));assert.equal(calls,0);
});
test('Windows records unsupported isolation and supplies no executable launcher',()=>{
 const p=createIntegratedHostPlan({platform:'win32',projectRoot:'D:\\qq-onebot',profileId:'synthetic_windows_01',inputs:[
 {kind:'node',source:'D:\\qq-onebot\\.tools\\node.exe',guest:'/bin/node.exe',sha256:'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',bytes:1},
 {kind:'provider',source:'D:\\qq-onebot\\.tmp\\onebot-node-host.dll',guest:'/native/onebot-node-host.dll',sha256:'afdc328060dd4c1cd3f3c8482ef49c835b7b857483a63c5145ecf3a032104189',bytes:1},
 ]});assert.equal(p.status,'blocked-windows-isolation');assert.equal(p.executable,false);assert.equal('command' in p,false);assert.equal(p.currentBusinessGate.open,false);
});
