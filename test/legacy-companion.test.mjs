import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadBot} from '../input/agent-app/src/binding-supervisor.mjs';

test('peerless companion verifies actual HTTP and WS but cannot dispatch business calls or ingest', {timeout:7000}, async t=>{
 const {createTransport}=await import('../src/transport/index.mjs'); const {EventEmitter}=await import('node:events'); const {createAgentOneBotClient}=await import('../input/agent-app/src/onebot/onebot.js'); const {projectLegacyCompanion}=await import('../input/agent-app/src/core/legacy-companion.js');
 const events=new EventEmitter(),calls=[],seen=[],token=randomUUID(),id='991008'; const transport=await createTransport({token,events,selfId:+id,heartbeatMs:0,dispatch:async q=>{calls.push(q.action);return {status:'ok',retcode:0,data:{user_id:id,platform:'bilibili'}};}});
 const env={QQ_AGENT_LEGACY_COMPANION:'1',WHALE_BINDING_PEER_ID:'',WHALE_ONEBOT_TOKEN:token,WHALE_ONEBOT_HTTP_URL:`http://127.0.0.1:${transport.address.port}`,WHALE_ONEBOT_WS_URL:`ws://127.0.0.1:${transport.wsAddress.port}`}; const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])); Object.assign(process.env,env);
 const instance={selfId:id,platform:'bilibili',botId:'whale-1'}; const c=createAgentOneBotClient(instance,{heartbeat:'off',onEvent:f=>seen.push(f)});t.after(async()=>{c.close();await transport.close();for(const [k,v] of Object.entries(old)){if(v===undefined) delete process.env[k];else process.env[k]=v;}});
 const cfg=projectLegacyCompanion({runtime:{mode:'active'},allowAllWhenEmpty:true},instance,'');assert.deepEqual(cfg.runtime,{mode:'observe',paused:true});assert.deepEqual(cfg.bindingAccess['bilibili:'+id].allow.private,[]);
 const up=new Promise(ok=>c.onStatus(s=>{if(s.connected)ok();}));await c.connect();await up;await c.call('get_login_info');assert.equal(c.dualVerified,true);events.emit('event',{self_id:+id,post_type:'message',message_type:'private',platform:'bilibili',user_id:991009,message:'blocked'});await c.callViaWs('get_login_info');await assert.rejects(c.sendText('private',991009,'blocked'),{code:'LOCAL_ACCOUNT_GUARD'});assert.equal(seen.length,0);assert.ok(calls.length>=2 && calls.every(a=>a==='get_login_info'));
});

test('running Bili companion follows existing primary config without copying secrets, adopting QQ ACLs or writing to primary',{timeout:10000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'primary-companion-')), primary=path.join(dir,'primary'),managed=path.join(dir,'companion');
 fs.mkdirSync(primary);fs.mkdirSync(managed);const config=path.join(primary,'config.json'),file=path.join(managed,'manifest.json');
 const p={persona:{botName:'existing',templateId:'',roleText:'original'},api:{provider:'a',baseUrl:'http://127.0.0.1:33333',model:'fixture'},providers:[{id:'a'},{id:'b'}],providerKeys:{a:'fixture-a',b:'fixture-other'},allow:{groups:['991100'],private:['991101']},admin:{ownerUin:'991101'},allowAllWhenEmpty:true,knowledge:{enabled:false},personaPerChat:{'private:991009':{botName:'QQ-only'}}};
 const setPrimary=()=>fs.writeFileSync(config,JSON.stringify(p));setPrimary();const before=fs.readFileSync(config,'utf8');
 const b={id:'companion',platform:'bilibili',selfId:'991008',peerId:'991009',httpUrl:'http://127.0.0.1:34011',wsUrl:'ws://127.0.0.1:34012',consolePort:34013,tokenEnv:'WHALE_BINDING_TOKEN_COMPANION'};
 const setManifest=(rows,id='whale-1')=>fs.writeFileSync(file,JSON.stringify({version:1,botId:id,bindings:rows}));setManifest([b]);
 const env={QQ_AGENT_LEGACY_COMPANION:'1',QQ_AGENT_BOT_CONFIG:config,[b.tokenEnv]:randomUUID(),SystemRoot:process.env.SystemRoot || ''};
 assert.throws(()=>loadBot(file,{...env,QQ_AGENT_BOT_CONFIG:''}));setManifest([b],'other');assert.throws(()=>loadBot(file,env));setManifest([{...b,platform:'qq'}]);assert.throws(()=>loadBot(file,env));setManifest([{...b,peerId:'00'}]);assert.throws(()=>loadBot(file,env));for(const peerId of ['',undefined]){setManifest([{...b,peerId}]);assert.equal(loadBot(file,env).rows[0].env.WHALE_BINDING_PEER_ID,'');}setManifest([b]);
 const childEnv=loadBot(file,env).rows[0].env;
 const script=`import {getConfig, updateConfig} from './input/agent-app/src/core/config.js'; process.on('message',()=>{try{const c=getConfig();let reject;try{updateConfig({admin:{ownerUin:'991101'}})}catch(e){reject=e.code}process.send([c.persona.botName,c.api.model,Object.keys(c.providerKeys),c.allow,c.admin.ownerUin,c.allowAllWhenEmpty,c.knowledge.enabled,Object.keys(c.personaPerChat),reject]);}catch(e){process.send({error:e.message});}});`;
 const child=spawn(process.execPath,['--permission',`--allow-fs-read=${path.resolve('input/agent-app')}`,`--allow-fs-read=${dir}`,`--allow-fs-write=${managed}`,'--input-type=module','-e',script],{env:childEnv,stdio:['ignore','ignore','inherit','ipc']});
 t.after(async()=>{const done=once(child,'close');child.kill();await done;fs.rmSync(dir,{recursive:true,force:true});});
 const read=async()=>{const ready=once(child,'message',{signal:AbortSignal.timeout(3000)});child.send('read');return (await ready)[0];};
 assert.deepEqual(await read(),['existing','fixture',['a'],{groups:[],private:['991009']},'',false,false,[],'CONFIG_LOCKED']);assert.equal(fs.readFileSync(config,'utf8'),before);
 p.persona.botName='renewed';p.api.model='next';setPrimary();await delay(1100);assert.deepEqual((await read()).slice(0,2),['renewed','next']);
 fs.writeFileSync(config,'{');await delay(1100);assert.deepEqual(await read(),{error:'Unreadable managed bot configuration'});assert.deepEqual(fs.readdirSync(primary),['config.json']);assert.ok(!fs.existsSync(path.join(childEnv.QQ_AGENT_DATA_DIR,'config.json')));
});
