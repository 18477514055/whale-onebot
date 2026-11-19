import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { OneBotCore } from '../src/core.mjs';
import { BridgeError } from '../src/bridge/error.mjs';
import { createTransport } from '../src/transport/index.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

class Bridge extends EventEmitter {
  calls=[];
  capabilities(){return ['send_group_msg','get_friend_list'];}
  async probe(){return {user_id:Number(BOT_UIN),online:true,sessionId:'synthetic-rate'};}
  async call(action,params){this.calls.push({action,params,time:performance.now()});return {message_id:this.calls.length};}
}
const send=(text='synthetic')=>({action:'send_group_msg_rate_limited',params:{group_id:123,message:text}});
async function until(check){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw new Error('Observation deadline');await turn();}}

test('rate-limited real HTTP accepts async envelope and executes FIFO with configured interval',async t=>{
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,rateLimitIntervalMs:30,minimumWriteIntervalMs:0});
  const token='synthetic-rate-http-token';
  const transport=await createTransport({dispatch:core.dispatch,events:core,token,heartbeatMs:0});
  t.after(async()=>{core.close();await transport.close();});
  const url=`http://127.0.0.1:${transport.address.port}/`;
  for(const text of ['first','second','third']){
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...send(text),echo:[text,null]})});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'async',retcode:1,data:null,echo:[text,null]});
  }
  await until(()=>core.metrics.rateCompleted===3);
  assert.deepEqual(bridge.calls.map(c=>c.params.message[0].data.text),['first','second','third']);
  for(let i=1;i<bridge.calls.length;i++)assert.ok(bridge.calls[i].time-bridge.calls[i-1].time>=30);
  assert.equal(core.metrics.calls,3);assert.equal(core.metrics.asyncAccepted,0);
});

test('queued writes wait for direct-call capacity and minimum write spacing, never busy-drop',async t=>{
  const bridge=new Bridge();let release,entered;
  const began=new Promise(resolve=>{entered=resolve;});
  bridge.call=async(action,params)=>{
    bridge.calls.push({action,params,time:performance.now()});
    if(params.message[0].data.text==='direct'){entered();await new Promise(resolve=>{release=resolve;});}
    return {message_id:bridge.calls.length};
  };
  const core=new OneBotCore({ freezeOnUnknown: true,bridge,rateLimitIntervalMs:10,minimumWriteIntervalMs:50});t.after(()=>core.close());
  const direct=core.dispatch({...send('direct'),action:'send_group_msg'});await began;
  assert.equal((await core.dispatch(send('queue-1'))).retcode,1);
  assert.equal((await core.dispatch(send('queue-2'))).retcode,1);
  await turn();assert.equal(bridge.calls.length,1);release();assert.equal((await direct).retcode,0);
  await until(()=>core.metrics.rateCompleted===2);
  assert.deepEqual(bridge.calls.map(c=>c.params.message[0].data.text),['direct','queue-1','queue-2']);
  for(let i=1;i<bridge.calls.length;i++)assert.ok(bridge.calls[i].time-bridge.calls[i-1].time>=50);
  assert.equal(core.metrics.rateFailed,0);
});

test('slow identity preparation cannot consume the spacing between actual queued bridge calls',async t=>{
  let now=1000,first=true;
  const bridge=new Bridge();
  bridge.probe=async()=>{if(first){first=false;now+=100;}return {user_id:Number(BOT_UIN),online:true,sessionId:'synthetic-rate'};};
  const core=new OneBotCore({ freezeOnUnknown: true,bridge,clock:()=>now,rateLimitIntervalMs:30,minimumWriteIntervalMs:0});
  t.after(()=>core.close());
  await core.dispatch(send('slow-proof'));await core.dispatch(send('following'));
  await until(()=>core.metrics.rateCompleted>=1);
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(bridge.calls.length,1,'preparation time must not allow an immediate second call');
  now+=30;
  await until(()=>core.metrics.rateCompleted===2);
  assert.deepEqual(bridge.calls.map(c=>c.params.message[0].data.text),['slow-proof','following']);
});

test('direct writes retain their quiet interval after a slow completion',async t=>{
  let now=1000,submitted=0;
  const bridge=new Bridge();
  bridge.call=async()=>{submitted++;if(submitted===1)now+=100;return {message_id:submitted};};
  const core=new OneBotCore({ freezeOnUnknown: true,bridge,clock:()=>now,minimumWriteIntervalMs:50});
  t.after(()=>core.close());
  const direct={...send(),action:'send_group_msg'};
  assert.equal((await core.dispatch(direct)).retcode,0);
  assert.equal((await core.dispatch(direct)).retcode,1429);
  assert.equal(submitted,1);
  now+=50;
  assert.equal((await core.dispatch(direct)).retcode,0);
  assert.equal(submitted,2);
});

test('queued generation invalidation and close cancel without submitting and release quota',async()=>{
  for(const action of ['invalidate','close']){
    const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,maxRatePending:1,maxRateBytes:100,rateLimitIntervalMs:0,minimumWriteIntervalMs:0});
    assert.equal((await core.dispatch(send('one'))).retcode,1);core[action]();await turn();
    assert.equal(bridge.calls.length,0);assert.equal(core.metrics.rateCancelled,1);
    if(action==='invalidate'){assert.equal((await core.dispatch(send('two'))).retcode,1);await until(()=>core.metrics.rateCompleted===1);}
    core.close();
  }
});

test('bounded count and bytes include running jobs; accepted params are snapshotted',async t=>{
  const bridge=new Bridge();let release,entered;
  const began=new Promise(resolve=>{entered=resolve;});
  bridge.call=async(action,params)=>{bridge.calls.push({action,params});entered();await new Promise(resolve=>{release=resolve;});return {};};
  const core=new OneBotCore({ freezeOnUnknown: true,bridge,maxRatePending:1,maxRateBytes:100,rateLimitIntervalMs:0,minimumWriteIntervalMs:0});t.after(()=>core.close());
  assert.equal((await core.dispatch(send('x'.repeat(200)))).retcode,1429);
  const request=send('original');assert.equal((await core.dispatch(request)).retcode,1);request.params.message='altered';await began;
  assert.equal((await core.dispatch(send('excess'))).retcode,1429);assert.equal(bridge.calls[0].params.message[0].data.text,'original');
  release();await until(()=>core.metrics.rateCompleted===1);assert.equal(core.metrics.rateAccepted,1);
});

test('maximum queue wait expires under busy direct operation using controlled clock',async t=>{
  let now=1000,release,entered;const began=new Promise(resolve=>{entered=resolve;});
  const bridge=new Bridge();bridge.call=async()=>{bridge.calls.push('submitted');entered();await new Promise(resolve=>{release=resolve;});return {};};
  const core=new OneBotCore({ freezeOnUnknown: true,bridge,clock:()=>now,maxRateWaitMs:100,minimumWriteIntervalMs:0});t.after(()=>core.close());
  const direct=core.dispatch({...send(),action:'send_group_msg'});await began;
  await core.dispatch(send('expires'));now+=101;release();await direct;
  await until(()=>core.metrics.rateExpired===1);
  assert.equal(bridge.calls.length,1);assert.equal(core.metrics.rateFailed,0);
});

test('identity is checked after queue wait and changed account never reaches bridge.call',async t=>{
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,minimumWriteIntervalMs:0});t.after(()=>core.close());
  assert.equal((await core.dispatch(send())).retcode,1);
  bridge.probe=async()=>({user_id:Number(OWNER_UIN),online:true,sessionId:'wrong'});
  await until(()=>core.metrics.rateFailed===1);assert.equal(bridge.calls.length,0);
});



test('local/read actions work; mixed suffixes, invalid params and protected targets reject before acceptance',async t=>{
  const core=new OneBotCore();t.after(()=>core.close());assert.equal(core.rateLimitIntervalMs,500);
  assert.deepEqual(await core.dispatch({action:'get_version_info_rate_limited',echo:false}),{status:'async',retcode:1,data:null,echo:false});
  await until(()=>core.metrics.rateCompleted===1);
  assert.equal((await core.dispatch({action:'get_status_async_rate_limited'})).retcode,1404);
  assert.equal((await core.dispatch({action:'get_status_rate_limited_async'})).retcode,1404);
  assert.equal((await core.dispatch({action:'send_group_msg_rate_limited',params:{}})).retcode,1400);
  assert.equal((await core.dispatch({action:'send_private_msg_rate_limited',params:{user_id:Number(OWNER_UIN),message:'synthetic'}})).retcode,1403);
  assert.equal(core.metrics.rateAccepted,1);
});

test('default monotonic proof and queue deadlines survive a wall-clock rollback',async t=>{
  // node:test restores this scoped method mock. Tests in this file are serial;
  // other test files execute in their own processes. Do not mock actual timers.
  let wall=Date.now();t.mock.method(Date,'now',()=>wall);
  let release,entered;const began=new Promise(resolve=>{entered=resolve;});
  const bridge=new Bridge();bridge.call=async()=>{bridge.calls.push('direct');entered();await new Promise(resolve=>{release=resolve;});return {};};
  const core=new OneBotCore({ freezeOnUnknown: true,bridge,proofMaxAgeMs:20,maxRateWaitMs:20,minimumWriteIntervalMs:0});
  let direct;
  t.after(async()=>{core.close();release?.();await direct;});
  direct=core.dispatch({...send('direct'),action:'send_group_msg'});await began;
  assert.equal(core.status().online,true);
  assert.equal((await core.dispatch(send('expires'))).retcode,1);
  wall-=24*60*60*1000;
  // Wide margin, no assertion on exact scheduling latency; both 20ms deadlines
  // must expire even if the OS clock is now one day behind acceptance time.
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(core.status().online,false);
  assert.equal(core.metrics.rateExpired,1);
  assert.equal(bridge.calls.length,1);
});


test('an unknown send outcome never latches later sends (P4)', async t => {
  // P4 的核心契约：一次发送拿不到回执 ⇒ 按已接受放行，且**后续发送不被挡住**。
  // 这里用直连（不走限速队列）验证，避免把调度器时序混进契约判断。
  const bridge = new Bridge();
  bridge.call = async () => { bridge.calls.push('submitted'); throw new BridgeError('UNCONFIRMED', 'synthetic receipt lost', { outcome: 'unknown' }); };
  const core = new OneBotCore({ freezeOnUnknown: true, bridge, minimumWriteIntervalMs: 0 });
  t.after(() => core.close());
  assert.equal((await core.dispatch({ ...send('first'), action: 'send_group_msg' })).retcode, 0);
  assert.equal(core.metrics.unknownOutcomes, 1);
  assert.equal((await core.dispatch({ ...send('second'), action: 'send_group_msg' })).retcode, 0);
  assert.equal(bridge.calls.length, 2, '每条请求只提交一次，不重放');
});
