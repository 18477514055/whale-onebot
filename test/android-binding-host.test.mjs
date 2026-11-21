import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {projectManifest,launchBoundHost} from '../android/binding-host.mjs';
const binding={id:'desk-b',platform:'bilibili',accountId:'723',httpUrl:'http://127.0.0.1:12345',wsUrl:'ws://127.0.0.1:12346',memoryMode:'shared'};
const bot={id:'r1',runtimeKind:'builtin',bindings:[binding]};
const manifest=(b)=>projectManifest({bots:[b]},b.id,{ports:[24000,24001]});
test('Bili-only projection whitelists fields and supports distinct protocols and account IDs',()=>{
  const m=manifest({...bot,bindings:[{...binding,irrelevant:'not-exported'}]});assert.deepEqual(m.bindings.map(b=>b.platform),['bilibili']);assert.equal(m.bindings[0].selfId,'723');assert.equal(m.bindings[0].isolated,false);assert.ok(!JSON.stringify(m).includes('not-exported'));
  const mixed=manifest({...bot,bindings:[binding,{...binding,id:'qq',platform:'qq',memoryMode:'isolated'}]});assert.equal(mixed.bindings.length,2);assert.equal(mixed.bindings[1].isolated,true);assert.notEqual(mixed.bindings[0].tokenEnv,mixed.bindings[1].tokenEnv);
});
test('real runtime accepts projected mixed registry, isolates each token, honors robot memory scope',async t=>{
  const {loadBot}=await import('../input/agent-app/src/binding-supervisor.mjs');
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'binding-contract-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
  const model={...bot,bindings:[binding,{...binding,id:'qq-2',platform:'qq',httpUrl:'http://127.0.0.1:12401',wsUrl:'ws://127.0.0.1:12402',memoryMode:'isolated'}]};
  const m=manifest(model),file=path.join(tmp,'manifest.json');await fs.writeFile(file,JSON.stringify(m));
  const env=Object.fromEntries(m.bindings.map((b,i)=>[b.tokenEnv,`fixture-${i}`]));
  const loaded=loadBot(file,env);assert.deepEqual(loaded.rows.map(x=>x.env.WHALE_AGENT_PLATFORM),['bilibili','qq']);
  assert.deepEqual(loaded.rows.map(x=>x.env.QQ_AGENT_MEMORY_SCOPE),['robot','binding']);
  for(const [i,r] of loaded.rows.entries()){assert.equal(r.env.WHALE_ONEBOT_TOKEN,`fixture-${i}`);assert.ok(!Object.keys(r.env).some(k=>k.startsWith('WHALE_BINDING_TOKEN_')));}
});
test('reject ambiguity, traversal, unassigned accounts, URL secrets and nonlocal endpoints',()=>{
  for(const mod of [{id:'../x'},{accountId:''},{wsUrl:'ws://127.0.0.1:123/?access_token=example'},{httpUrl:'http://user@127.0.0.1:8888'},{wsUrl:'ws://example.test:80'},{platform:'unknown'},{memoryMode:'oops'}])assert.throws(()=>manifest({...bot,bindings:[{...binding,...mod}]}));assert.throws(()=>manifest({...bot,bindings:[binding,binding]}));
});
test('launches one independent runtime process with scoped transient auth; no inherited secrets or disk token',async t=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'binding-host-'));t.after(()=>fs.rm(tmp,{recursive:true,force:true})); const entry=path.join(tmp,'fixture.mjs');
  const src=`import fs from 'node:fs';const m=JSON.parse(fs.readFileSync(process.argv[2]));const token=process.env[m.bindings[0].tokenEnv];process.exitCode=(token===('fixture'+'-only')&&!process.env.ANDROID_HOST_SENTINEL&&m.bindings.length===1&&m.bindings[0].platform==='bilibili')?0:1;`;
  await fs.writeFile(entry,src);process.env.ANDROID_HOST_SENTINEL='unused';try{const child=await launchBoundHost({bot,tokens:{[binding.id]:'fixture-only'}},{root:tmp,entry});assert.deepEqual(await once(child,'exit'),[0,null]);}finally{delete process.env.ANDROID_HOST_SENTINEL;}
  const files=await fs.readdir(path.join(tmp,bot.id));assert.deepEqual(files,['manifest.json']);assert.ok(!(await fs.readFile(path.join(tmp,bot.id,files[0]),'utf8')).includes('fixture-only'));
  for(const value of [null,'SESSDATA=placeholder'])await assert.rejects(launchBoundHost({bot,tokens:{[binding.id]:value}},{root:tmp,entry}));
  await assert.rejects(launchBoundHost({bot:{...bot,runtimeKind:'custom'},tokens:{}},{root:tmp,entry}));
});
