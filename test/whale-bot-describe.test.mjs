import test from 'node:test';
import assert from 'node:assert/strict';
import {describeBot} from '../scripts/whale-bot-describe.mjs';
const b=(id,platform,selfId,port)=>({id,platform,selfId,httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}`,tokenEnv:'WHALE_BINDING_TOKEN_SENSITIVE',consolePort:20000+port});
const qq=b('qq-main','qq','42',14000),bili=b('bili-main','bilibili','42',14010);
test('public runtime-neutral manifest expresses shared logical robot, independent accounts and optional isolation',()=>{
  const doc=describeBot({version:1,botId:'whale-a',bindings:[qq,bili,{...b('bili-side','bilibili','43',14020),isolated:true}]});
  const [a,c,d]=doc.bindings;assert.equal(a.memoryScope,c.memoryScope);assert.equal(a.knowledgeScope,c.knowledgeScope);assert.notEqual(a.memoryScope,d.memoryScope);assert.notEqual(a.bindingId,c.bindingId);
  assert.notEqual(describeBot({version:1,botId:'whale-b',bindings:[bili]}).bindings[0].memoryScope,c.memoryScope);
  assert(!JSON.stringify(doc).includes('TOKEN'));assert(!JSON.stringify(doc).includes('online'));
});
test('descriptor never advertises duplicate accounts or credential-bearing endpoints',()=>{
  for(const bindings of [[qq,qq],[qq,{...qq,id:'other'}],[{...bili,httpUrl:'http://127.0.0.1:14100/?access_token=fake'}]])assert.throws(()=>describeBot({version:1,botId:'whale',bindings}));
});
