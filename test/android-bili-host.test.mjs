import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {appendOwnedBili} from '../scripts/project-legacy-bili-registry.mjs';
import {launchBoundHost} from '../android/binding-host.mjs';import {once} from 'node:events';
const registry={schemaVersion:1,future:{a:1},bots:[{id:'whale-1',name:'primary',enabled:true,runtimeKind:'builtin',platforms:['qq'],futureField:[1,2]}]};
test('new offline output only; inactive registry round trip preserves original bytes and unknown fields',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registry-rollback-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const orig=JSON.stringify(registry,null,4)+'\r\n',source=path.join(dir,'original.json'),dest=path.join(dir,'proposed.json'),live=path.join(dir,'inactive.json');await fs.writeFile(source,orig);await fs.copyFile(source,live);
 const args=['scripts/project-legacy-bili-registry.mjs',source,dest,'456'];assert.equal(spawnSync(process.execPath,args).status,0);assert.notEqual(spawnSync(process.execPath,args).status,0);assert.equal(await fs.readFile(source,'utf8'),orig);
 await fs.copyFile(dest,live);const applied=JSON.parse(await fs.readFile(live));assert.deepEqual(applied.bots[0].futureField,[1,2]);assert.deepEqual(applied.future,registry.future);assert.deepEqual(applied.bots[0].bindings.map(x=>[x.platform,x.accountId]),[['qq',''],['bilibili','456']]);assert.deepEqual(appendOwnedBili(applied,'456'),applied);
 await fs.copyFile(source,live);assert.equal(await fs.readFile(live,'utf8'),orig);assert.throws(()=>appendOwnedBili(registry,'../x'));
});
test('hybrid starts only a Bili child and passes primary config by reference, leaves bytes unchanged',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hybrid-'));t.after(()=>fs.rm(root,{recursive:true,force:true})); const data=path.join(root,'data','bots');await fs.mkdir(data,{recursive:true});const cfg=path.join(root,'data','config.json'), orig='{ "untouched": 1 }\n';await fs.writeFile(cfg,orig);
 const bot=appendOwnedBili(registry,'456').bots[0];bot.bindings=bot.bindings.filter(b=>b.platform!=='qq');Object.assign(bot.bindings[0],{httpUrl:'http://127.0.0.1:17310',wsUrl:'ws://127.0.0.1:17310',peerId:'123'});
 const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,`import fs from 'node:fs';const m=JSON.parse(fs.readFileSync(process.argv[2]));process.exitCode=(m.botId==='whale-1'&&m.bindings.length===1&&m.bindings[0].platform==='bilibili'&&m.bindings[0].peerId==='123'&&process.env.QQ_AGENT_LEGACY_COMPANION==='1'&&process.env.QQ_AGENT_BOT_CONFIG===${JSON.stringify(cfg)})?0:1`);
 const child=await launchBoundHost({bot,tokens:{'bili-456':'fixtureonly'},companion:true},{root:path.join(root,'bindings'),data,entry});assert.deepEqual(await once(child,'exit'),[0,null]);assert.equal(await fs.readFile(cfg,'utf8'),orig);
});
