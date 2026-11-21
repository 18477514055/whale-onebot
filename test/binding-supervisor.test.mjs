import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createTransport } from '../src/transport/index.mjs';
import { spawnSync } from 'node:child_process';
import { loadBot, startSupervisor, publishStatus } from '../input/agent-app/src/binding-supervisor.mjs';
import { agentInstance } from '../input/agent-app/src/core/bili-instance.js';
import { createAgentOneBotClient } from '../input/agent-app/src/onebot/onebot.js';

function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bindings-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file:path.join(dir,'manifest.json')};}
function binding(n,platform='qq'){return {id:`acct-${n}`,platform,selfId:String(900100+n),httpUrl:`http://127.0.0.1:${25000+n*3}`,wsUrl:`ws://127.0.0.1:${25001+n*3}`,consolePort:25002+n*3,tokenEnv:'WHALE_BINDING_TOKEN_'+n};}
function store(file,bindings,extras={}){fs.writeFileSync(file,JSON.stringify({version:1,botId:'testbot',bindings,...extras}));}
test('preflight: no arbitrary credential reads, duplicate routing or shared worker data',t=>{
 const {file}=setup(t); const a=binding(1),b=binding(2,'bilibili'),c={...binding(3),isolated:true};const env=Object.fromEntries([a,b,c].map(r=>[r.tokenEnv,randomUUID()]));
 store(file,[a,b,c]);const {rows}=loadBot(file,env); const [aa,bb,cc]=rows.map(r=>r.env);
 assert.equal(aa.QQ_AGENT_DURABLE_DIR,bb.QQ_AGENT_DURABLE_DIR);assert.notEqual(aa.QQ_AGENT_DURABLE_DIR,cc.QQ_AGENT_DURABLE_DIR);assert.notEqual(aa.QQ_AGENT_DATA_DIR,bb.QQ_AGENT_DATA_DIR);
 assert.equal(aa.QQ_AGENT_BOT_CONFIG,bb.QQ_AGENT_BOT_CONFIG);assert.deepEqual(Object.keys(aa).filter(k=>k.startsWith('WHALE_BINDING_TOKEN_')),[]);
 assert.equal(aa.WHALE_ONEBOT_TOKEN,env[a.tokenEnv]);assert.deepEqual(agentInstance(aa),{id:a.id,botId:'testbot',platform:'qq',selfId:a.selfId,port:a.consolePort});
 assert.throws(()=>agentInstance({...aa,QQ_AGENT_ROBOT_ID:'second'}),/ownership/);assert.throws(()=>agentInstance({QQ_AGENT_DATA_DIR:aa.QQ_AGENT_DATA_DIR}),/managed/i);
 for (const bad of [{tokenFile:'not-allowed'},{tokenEnv:'HOME'},{id:'../a'},{id:b.id},{httpUrl:'http://example.invalid:3000'},{httpUrl:b.httpUrl},{consolePort:+new URL(b.wsUrl).port},{selfId:'0012'},{selfId:42}]){store(file,[{...a,...bad},b]); assert.throws(()=>loadBot(file,env));}
});
test('scoped tools, credentials and peer authority do not leak across workers',t=>{
 const {file,dir}=setup(t);const a=binding(1),b={...binding(2,'bilibili'),biliTools:{bili_video_info:{bvid:'string'}},biliWrites:true};
 const env={...Object.fromEntries([a,b].map(r=>[r.tokenEnv,randomUUID()])),SystemRoot:process.env.SystemRoot || '',SESSDATA:'not-a-credential',QQ_PASSWORD:'not-a-credential',WHALE_BILI_AGENT_WRITES:'1'};
 store(file,[a,b]);fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({admin:{ownerUin:'991234'},allowAllWhenEmpty:true,allow:{private:['991234']},bindingAccess:{[`bilibili:${b.selfId}`]:{ownerUin:'991234',allow:{private:['995555']}}}}));
 const [aa,bb]=loadBot(file,env).rows.map(r=>r.env);
 assert.equal(aa.WHALE_BILI_AGENT_WRITES,undefined);assert.equal(bb.WHALE_BILI_AGENT_WRITES,'1');assert.deepEqual(JSON.parse(bb.WHALE_BILI_AGENT_TOOLS),b.biliTools);
 for(const v of [aa,bb]){assert.equal(v.SESSDATA,undefined);assert.equal(v.QQ_PASSWORD,undefined);
 const c=spawnSync(process.execPath,['--input-type=module','-e',`import {getConfig} from './input/agent-app/src/core/config.js'; const c=getConfig(); console.log(JSON.stringify([c.allow.private,c.admin.ownerUin,c.allowAllWhenEmpty]));`],{env:v,encoding:'utf8'});
 assert.equal(c.status,0,c.stderr);assert.deepEqual(JSON.parse(c.stdout.trim().split('\n').at(-1)),[v===bb?['995555']:[],'',false]);}
 for(const bad of [{...b,biliTools:{bili_a:{cookie:'string'}}},{...a,biliTools:b.biliTools}]){store(file,[bad]); assert.throws(()=>loadBot(file,env));}
});
test('atomic status retries transient sharing conflicts only',()=>{let attempts=0;publishStatus('a','b',()=>{if (++attempts<3) throw Object.assign(Error(),{code:'EPERM'});});assert.equal(attempts,3);assert.throws(()=>publishStatus('a','b',()=>{throw Object.assign(Error(),{code:'ENOENT'});}),{code:'ENOENT'});});
test('external runtime is not launched and never reads a bearer',async t=>{
 const {file,dir}=setup(t);const b=binding(1);store(file,[b],{runtimeKind:'custom'});assert.equal(await startSupervisor(file,{}).done,0);
 const status=JSON.parse(fs.readFileSync(path.join(dir,'binding-status.json')));assert.deepEqual(status.bindings,[{id:b.id,platform:b.platform,selfId:b.selfId,consolePort:b.consolePort,state:'external'}]);assert.equal(fs.existsSync(path.join(dir,'workers')),false);
});
test('two explicit QQ accounts sharing peer ID: real WS input and original HTTP reply, wrong identity never writes',{timeout:12000},async t=>{
 const {file}=setup(t), services=[], rows=[], env={}, clients=[],writes=[[],[]], received=[new EventEmitter(),new EventEmitter()];
 const prior={};t.after(async()=>{clients.forEach(c=>c.close());await Promise.all(services.map(s=>s.transport.close()));for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 for(let i=0;i<2;i++){
  const b=binding(i+1);const token=randomUUID(),events=new EventEmitter();const s={events,observed:b.selfId};
  s.transport=await createTransport({token,selfId:+b.selfId,events,heartbeatMs:0,dispatch:async req=>{if(req.action==='send_private_msg')writes[i].push(req.params);return {status:'ok',retcode:0,data:req.action==='get_login_info'?{user_id:s.observed}:{message_id:700+i}};}});
  services.push(s);Object.assign(b,{httpUrl:`http://127.0.0.1:${s.transport.address.port}`,wsUrl:`ws://127.0.0.1:${s.transport.wsAddress.port}`});rows.push(b);env[b.tokenEnv]=token;
 }
 store(file,rows);
 for(const [i,item] of loadBot(file,env).rows.entries()){
  for(const [k,v] of Object.entries(item.env)){if(!Object.hasOwn(prior,k))prior[k]=process.env[k];process.env[k]=v;}
  const c=createAgentOneBotClient(agentInstance(item.env),{heartbeat:'off',onEvent:f=>received[i].emit(f.post_type,f)});clients.push(c);
  const up=new Promise(ok=>c.onStatus(s=>{if(s.connected)ok();}));await c.connect();await up;assert.equal((await c.call('get_login_info')).user_id,item.row.selfId);assert.ok(c.dualVerified);
 }
 await Promise.all(clients.map(async(c,i)=>{const p=once(received[i],'message',{signal:AbortSignal.timeout(3000)});services[i].events.emit('event',{post_type:'message',self_id:+rows[i].selfId,user_id:991122,message_type:'private',message:`from ${i}`});const [f]=await p;await c.sendText('private',f.user_id,'reply '+f.message);}));
 for(let i=0;i<2;i++){assert.equal(writes[i].length,1);assert.equal(String(writes[i][0].user_id),'991122');assert.ok(JSON.stringify(writes[i][0].message).includes(`reply from ${i}`));}
 services[0].observed=rows[1].selfId;await assert.rejects(clients[0].sendText('private',991122,'not sent'),{code:'LOCAL_ACCOUNT_GUARD'});assert.equal(writes[0].length,1);assert.equal(clients[0].dualVerified,false);
});
