import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { OneBotCore } from '../src/core.mjs';
import { createTransport } from '../src/transport/server.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

class Bridge extends EventEmitter {
  calls=[];
  capabilities(){return ['get_friend_list','send_group_msg'];}
  async probe(){return {user_id:Number(BOT_UIN),online:true,sessionId:'synthetic-async'};}
  async call(action,params){this.calls.push({action,params});return {message_id:123};}
}
async function until(predicate){
  const limit=Date.now()+2000;
  while(!predicate()){if(Date.now()>limit)throw new Error('Async observation deadline');await turn();}
}

test('async local action returns accepted envelope and arbitrary echo before execution',async t=>{
  const core=new OneBotCore();t.after(()=>core.close());
  const echo={nested:[null,17,'x']};
  assert.deepEqual(await core.dispatch({action:'get_version_info_async',echo}),{status:'async',retcode:1,data:null,echo});
  assert.equal(core.metrics.asyncCompleted,0);
  await until(()=>core.metrics.asyncCompleted===1);
  assert.equal(core.metrics.calls,1);
});
test('async parameters are snapshotted and identity is checked at execution',async t=>{
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,minimumWriteIntervalMs:0});t.after(()=>core.close());
  const request={action:'send_group_msg_async',params:{group_id:123,message:'original'}};
  assert.equal((await core.dispatch(request)).retcode,1);
  request.params.message='changed';
  await until(()=>core.metrics.asyncCompleted===1);
  assert.equal(bridge.calls.length,1);assert.equal(bridge.calls[0].params.message[0].data.text,'original');
  bridge.probe=async()=>({user_id:Number(OWNER_UIN),online:true,sessionId:'wrong'});
  assert.equal((await core.dispatch({action:'send_group_msg_async',params:{group_id:123,message:'blocked'}})).retcode,1);
  await until(()=>core.metrics.asyncFailed===1);
  assert.equal(bridge.calls.length,1);assert.equal(core.status().online,false);
});
test('async rejects unsupported, malformed, nested suffix and protected targets before acceptance',async t=>{
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge});t.after(()=>core.close());
  assert.equal((await core.dispatch({action:'send_group_msg_async',params:{group_id:123}})).retcode,1400);
  assert.equal((await core.dispatch({action:'send_private_msg_async',params:{user_id:Number(OWNER_UIN),message:'x'}})).retcode,1403);
  assert.equal((await core.dispatch({action:'get_forward_msg_async',params:{id:'x'}})).retcode,1404);
  assert.equal((await core.dispatch({action:'get_status_async_async'})).retcode,1404);
  assert.equal(core.metrics.asyncAccepted,0);assert.equal(bridge.calls.length,0);
});
test('pending count and byte bounds reject excess without queue growth',async t=>{
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,maxAsyncPending:1,maxAsyncBytes:100});t.after(()=>core.close());
  assert.equal((await core.dispatch({action:'send_group_msg_async',params:{group_id:123,message:'x'.repeat(200)}})).retcode,1429);
  assert.equal((await core.dispatch({action:'get_friend_list_async'})).retcode,1);
  assert.equal((await core.dispatch({action:'get_friend_list_async'})).retcode,1429);
  await until(()=>core.metrics.asyncCompleted===1);
  assert.equal((await core.dispatch({action:'get_friend_list_async'})).retcode,1);
  await until(()=>core.metrics.asyncCompleted===2);
});
test('close and session invalidation discard accepted but unstarted jobs',async()=>{
  for(const event of ['close','invalidate']){
    const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge});
    assert.equal((await core.dispatch({action:'get_friend_list_async'})).retcode,1);
    core[event]();await turn();
    assert.equal(bridge.calls.length,0);assert.equal(core.metrics.asyncCancelled,1);core.close();
  }
});
test('unknown async write is accepted once and never retried (P4)',async t=>{
  // P4：异步发送结果未知 ⇒ 按已接受放行（不再回 1503 闩锁），但**绝不重试**。
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,minimumWriteIntervalMs:0});t.after(()=>core.close());
  bridge.call=async()=>{bridge.calls.push('submitted');throw new Error('lost receipt');};
  const request={action:'send_group_msg_async',params:{group_id:123,message:'x'}};
  assert.equal((await core.dispatch(request)).retcode,1);
  await until(()=>core.metrics.asyncCompleted===1);
  const again=await core.dispatch(request);
  assert.equal(again.retcode,1,'后续异步发送不被闩锁挡住');
  await until(()=>core.metrics.asyncCompleted>=2);
  assert.equal(bridge.calls.filter(c=>c==='submitted').length,2,'每次请求只提交一次，没有自动重试');
  assert(core.metrics.unknownOutcomes>=1,'未知结果仍然记账，运行端查得到');
});
test('real HTTP async response preserves echo and never returns action result',async t=>{
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge});
  const token='synthetic-async-token';
  const transport=await createTransport({dispatch:core.dispatch,events:core,token,heartbeatMs:0});
  t.after(async()=>{core.close();await transport.close();});
  const address=transport.address;
  const response=await fetch(`http://127.0.0.1:${address.port}/`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'get_friend_list_async',echo:[1,null]})});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'async',retcode:1,data:null,echo:[1,null]});
  await until(()=>core.metrics.asyncCompleted===1);assert.equal(bridge.calls.length,1);
});
