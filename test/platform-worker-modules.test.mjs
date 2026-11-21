// Actual subset installations. No production data, tokens, devices, or external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createTransport } from '../src/transport/index.mjs';
const root=path.join(import.meta.dirname,'..'), source=path.join(root,'input','agent-app');
function stage(from,to,omit){
 if(from===omit) return;
 const s=fs.lstatSync(from);if(s.isSymbolicLink()) throw Error('Unexpected link in source');
 if(s.isDirectory()){fs.mkdirSync(to);for(const f of fs.readdirSync(from))stage(path.join(from,f),path.join(to,f),omit);}else if(s.isFile())fs.copyFileSync(from,to);else throw Error('Nonregular source');
}
for(const platform of ['qq','bilibili'])test(`${platform}-only install: real guarded HTTP+WS reply, absent module fails before spawn`,{timeout:15000},async t=>{
 const other=platform==='qq'?'bilibili':'qq',scratch=fs.mkdtempSync(path.join(root,'.tmp','module-worker-')),app=path.join(scratch,'runtime');fs.mkdirSync(app);
 const omit=path.join(source,'src','platform-modules',other);stage(path.join(source,'src'),path.join(app,'src'),omit);stage(path.join(source,'package.json'),path.join(app,'package.json'));assert.ok(!fs.existsSync(path.join(app,'src','platform-modules',other)));
 const token=randomUUID(), selfId='990091',peer=990092,events=new EventEmitter(),sends=[];
 const transport=await createTransport({token,platform,selfId:+selfId,events,heartbeatMs:0,dispatch:async q=>{if(q.action==='send_private_msg')sends.push(q.params);return {status:'ok',retcode:0,data:q.action==='get_login_info'?{user_id:selfId,platform}:{message_id:1001}};}});
 const binding={id:'worker',selfId,platform,httpUrl:`http://127.0.0.1:${transport.address.port}`,wsUrl:`ws://127.0.0.1:${transport.wsAddress.port}`,consolePort:24091,tokenEnv:'WHALE_BINDING_TOKEN_SYNTHETIC'};
 for(const [filename,p,kind] of [['binding',platform,'builtin'],['missing',other,'builtin'],['external',other,'custom']])fs.writeFileSync(path.join(scratch,filename+'.json'),JSON.stringify({version:1,botId:'fixture',runtimeKind:kind,bindings:[{...binding,platform:p}]}));
 const script=`import {loadBot} from './src/binding-supervisor.mjs';import assert from 'node:assert/strict';
 assert.throws(()=>loadBot('../missing.json'),{code:'PLATFORM_MODULE_MISSING'});assert.equal(loadBot('../external.json').rows[0].row.state,'external');
 Object.assign(process.env,loadBot('../binding.json').rows[0].env);const {agentInstance}=await import('./src/core/platform-instance.js');const {createAgentOneBotClient}=await import('./src/onebot/onebot.js');
 const {activePlatformModule}=await import('./src/core/platform-modules.js');const adapter=activePlatformModule();assert.equal(adapter.platform,process.env.WHALE_AGENT_PLATFORM);
 const c=createAgentOneBotClient(agentInstance(),{heartbeat:'off',onEvent:async f=>{if(f.post_type!=='message')return;await c.sendText('private',f.user_id,'reply:'+f.raw_message);c.close();process.disconnect();}});
 const up=new Promise(ok=>c.onStatus(s=>s.connected&&ok()));await c.connect();await up;await c.call('get_login_info');assert.ok(c.dualVerified);process.send('verified');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:app,env:{SystemRoot:process.env.SystemRoot || '',[binding.tokenEnv]:token},stdio:['ignore','ignore','inherit','ipc']});
 const closed=once(child,'close');t.after(async()=>{if(child.exitCode===null && child.signalCode===null)child.kill();await closed;await transport.close();fs.rmSync(scratch,{recursive:true,force:true});});
 const up=await Promise.race([once(child,'message'),closed]);assert.equal(up[0],'verified');events.emit('event',{self_id:+selfId,platform,post_type:'message',message_type:'private',user_id:peer,raw_message:'module-fixture'});assert.equal((await closed)[0],0);assert.equal(sends.length,1);assert.ok(JSON.stringify(sends[0].message).includes('reply:module-fixture'));
});
