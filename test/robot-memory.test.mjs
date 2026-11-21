import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Real concurrent Node processes; they retain store/index instances between requests.
test('managed workers share committed durable facts, persona and knowledge but never handoffs or other robots', {timeout:30000}, async t=>{
  const tmp = fileURLToPath(new URL('../.tmp/',import.meta.url));
  fs.mkdirSync(tmp,{recursive:true});
  const root=fs.mkdtempSync(path.join(tmp,'robot-memory-test-'));
  const workers=new Set();
  t.after(async()=>{ await Promise.all([...workers].map(w=>w.stop())); fs.rmSync(root,{recursive:true,force:true}); });
  async function worker(robot,binding,platform,uid,scope='robot',dir,legacy=false) {
    const data=path.join(root,'workers',robot,binding,`${platform}-${uid}`);
    const managed=dir ?? (scope==='robot' ? path.join(root,'durable',robot) : path.join(data,'durable'));
    const proc=fork(new URL('./fixtures/robot-memory-worker.mjs',import.meta.url),[],{silent:true,execArgv:[],env:{
      PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ROBOT_MEMORY_TEST:'1', QQ_AGENT_DATA_DIR:data,
      ...(legacy?{QQ_AGENT_LEGACY_COMPANION:'1',WHALE_BINDING_PEER_ID:'78921'}:{}),QQ_AGENT_BOT_CONFIG:legacy?path.join(root,'primary','config.json'):path.join(root,robot+'-config.json'), QQ_AGENT_ROBOT_ID:robot, QQ_AGENT_BINDING_ID:binding,QQ_AGENT_MEMORY_SCOPE:scope,QQ_AGENT_DURABLE_DIR:managed,
      QQ_AGENT_KNOWLEDGE_ENV:path.join(root,'no-embedding.env'), WHALE_AGENT_PLATFORM:platform,WHALE_BINDING_SELF_ID:uid,WHALE_BINDING_CONSOLE_PORT:'3411', WHALE_ONEBOT_TOKEN:'offline-fixture',
      WHALE_ONEBOT_HTTP_URL:'http://127.0.0.1:3412',WHALE_ONEBOT_WS_URL:'ws://127.0.0.1:3413'}});
    let stderr=''; proc.stderr.on('data',d=>stderr+=d); proc.stdout.resume();
    const exit=once(proc,'exit'); let ended=false;
    const w={async stop(){if(!ended){proc.kill(); await exit;} workers.delete(w);},async call(op,args){ const response=receive(); proc.send({op,args}); return (await response).value; }};
    workers.add(w); exit.then(()=>{ended=true;});
    function receive(){return new Promise((resolve,reject)=>{
      function msg(m){clear(); if(m.error) reject(Error(m.error)); else resolve(m);}
      function die(){clear(); reject(Error(stderr||'worker exited'));}
      function clear(){proc.off('message',msg);proc.off('exit',die);}
      proc.once('message',msg);proc.once('exit',die);
    });}
    assert.ok((await receive()).ready); return w;
  }
  const [a,b,foreign]=await Promise.all([worker('r1','one','qq','11111'),worker('r1','two','qq','22222'),worker('r1','three','bilibili','33333')]);
  assert.equal((await b.call('read')).hits.length,0);
  await b.call('catalogSnapshot');
  await a.call('libraryBuild');
  assert.equal((await foreign.call('libraryRead'))[0].text,'saffron anthology');
  await assert.rejects(b.call('saveStale'),/catalog changed/);
  await assert.rejects(b.call('badCorpus'),/inside the durable corpus/);
  await assert.rejects(a.call('libraryFail'),/fixture interruption/);
  assert.equal((await b.call('libraryRead'))[0].text,'saffron anthology');
  await a.call('put');
  const snap=await b.call('read');
  assert.equal(snap.person.relationship.interactions,1); assert.equal(snap.person.impressions[0].content,'cobalt hiking');
  assert.equal(snap.hits[0].snippet,'saffron manual'); assert.ok(snap.persona>0); assert.equal(snap.handoff,null);
  const cross=await foreign.call('read'); assert.equal(cross.search[0].userId,'qq:42'); assert.equal(cross.recall[0].userId,'qq:42');
  assert.equal(cross.person.impressions.length,0); assert.equal(cross.hits[0].snippet,'saffron manual'); assert.equal(cross.persona,snap.persona);
  assert.deepEqual(await foreign.call('strict'),[]);
  assert.deepEqual(await b.call('strict'),[]); // same numeric private chat on another account is not the same session
  await Promise.all([a.call('append',['amber',12]),b.call('append',['ivory',12])]);
  await Promise.all([a.stop(),b.stop(),foreign.stop()]);
  const restarted=await worker('r1','two','qq','22222'); const after=await restarted.call('read');
  assert.equal(new Set(after.person.impressions.map(e=>e.content)).size,25); assert.equal(after.person.relationship.interactions,25);
  assert.equal((await restarted.call('libraryRead'))[0].text,'saffron anthology');
  assert.equal(after.hits.length,1); assert.equal(after.handoff,null); assert.equal(after.persona,snap.persona);
  for(const separate of [await worker('r2','two','qq','22222'),await worker('r1','solo','qq','44444','binding')]) {
    assert.deepEqual(await separate.call('libraryRead'),[]);
    const r=await separate.call('read'); assert.deepEqual(r.recall,[]); assert.deepEqual(r.hits,[]); assert.equal(r.persona,0);
  }
  await assert.rejects(worker('r2','wrong','qq','55555','robot',path.join(root,'durable','r1')),/ownership mismatch/i);
  await assert.rejects(worker('r1','wrong2','qq','55556','binding',path.join(root,'durable','r1')),/ownership mismatch/i);
  // Legacy primary stays in place. Start with nonempty synthetic canonical files.
  const primary=path.join(root,'primary');
  function put(name,value){const p=path.join(primary,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value));}
  put('config.json',{asr:{provider:'openai'},knowledge:{enabled:true}});
  put('persona-state.json',{example:{mood:7,lastInteractionAt:1234,updatedAt:1234,savedAt:1234}});
  put('memory/people/42.json',{userId:'42',name:'Walker',impressions:[{content:'saffron day',sourceChatKeys:['group:9']},{content:'saffron secret',sourceChatKeys:['private:42']}]});
  put('knowledge/manual.md','saffron old manual'); put('knowledge-lib/libraries.json',{libraries:{guide:{enabled:true},hidden:{enabled:false}}});
  const {DatabaseSync}=await import('node:sqlite');const index=new DatabaseSync(path.join(primary,'knowledge-lib','index.sqlite'));
  index.exec("CREATE TABLE docs(lib,source,text); INSERT INTO docs VALUES('guide','guide','saffron old guide'),('hidden','x','saffron hidden')");index.close();
  function image(){return fs.readdirSync(primary,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>[path.relative(primary,path.join(e.parentPath,e.name)),fs.readFileSync(path.join(e.parentPath,e.name)).toString('base64')]).sort();}
  const before=image();const companion=await worker('whale-1','comp','bilibili','54327','robot',undefined,true);
  assert.equal((await companion.call('read')).persona,1234);assert.equal((await companion.call('read')).hits[0].snippet,'saffron old manual');
  assert.deepEqual((await companion.call('libraryRead')).map(x=>x.text),['saffron old guide']);
  assert.deepEqual((await companion.call('legacySearch','qq:42')).map(x=>x.content),['saffron day']);assert.deepEqual(await companion.call('legacySearch','42'),[]);
  await companion.call('strict');assert.deepEqual(await companion.call('legacySearch','qq:42'),[]);
  await companion.call('put');await companion.call('drop');assert.equal((await companion.call('read')).hits[0].snippet,'saffron old manual');
  const solo=await worker('whale-1','solo','bilibili','54328','binding',undefined,true);assert.deepEqual((await solo.call('read')).hits,[]);assert.equal((await solo.call('read')).persona,0);assert.deepEqual(await solo.call('libraryRead'),[]);assert.deepEqual(await solo.call('legacySearch','qq:42'),[]);
  assert.deepEqual(image(),before);
  put('knowledge/manual.md','saffron edited by the QQ primary');
  assert.equal((await companion.call('read')).hits[0].snippet,'saffron edited by the QQ primary');
  const doomed=await worker('r1','indexer','qq','54321');
  await assert.rejects(doomed.call('libraryCrash'));
  const recovered=await worker('r1','indexer','qq','54321');
  assert.equal((await recovered.call('libraryRead'))[0].text,'saffron anthology');
  const writer=await worker('r1','one','qq','11111'); await writer.call('drop'); assert.deepEqual((await restarted.call('read')).hits,[]);
});
