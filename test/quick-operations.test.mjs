import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { OneBotCore } from '../src/core.mjs';
import { BridgeError, NativeBridge } from '../src/bridge/native-bridge.mjs';
import { createWebhook } from '../src/transport/outbound.mjs';
import { planQuickOperations } from '../src/quick-operations.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';
const BOT=Number(BOT_UIN), token='synthetic-quick-operation-token';
const wire=value=>JSON.parse(JSON.stringify(value));
const event=(extra={})=>({self_id:BOT,post_type:'message',message_type:'group',group_id:123,user_id:456,message_id:1,anonymous:null,...extra});
class Bridge extends EventEmitter {
  calls=[];session='synthetic-quick';
  available=['send_group_msg','send_private_msg','delete_msg','set_group_ban','set_group_kick','set_group_anonymous_ban','set_friend_add_request','set_group_add_request'];
  capabilities(){return this.available;}
  async probe(){return {user_id:BOT,online:true,sessionId:this.session};}
  async call(action,params){this.calls.push({action,params});return {message_id:88};}
}
async function until(check){const limit=Date.now()+3000;while(!check()){if(Date.now()>limit)throw Error('Observation deadline');await turn();}}
async function setup(t,options={}){
  const bridge=new Bridge(),core=new OneBotCore({ freezeOnUnknown: true,bridge,minimumWriteIntervalMs:0,rateLimitIntervalMs:0,...options});
  t.after(()=>core.close());assert.equal((await core.dispatch({action:'get_login_info'})).retcode,0);
  return {bridge,core};
}
function capture(core,bridge,input=event()){
  let delivered;core.once('event',value=>{delivered=value;});bridge.emit('event',input);
  assert(delivered);return {delivered,handle:core.prepareQuickOperation(delivered)};
}
async function webhookServer(t,handler){
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.close();server.closeAllConnections();});return `http://127.0.0.1:${server.address().port}/`;
}

test('quick-operation contracts cover CQ escape, group mention, anonymous moderation and explicit rejection',()=>{
  const privatePlan=planQuickOperations(event({message_type:'private'}),{reply:'[CQ:face,id=1]',auto_escape:true});
  assert.deepEqual(wire(privatePlan),[{action:'send_private_msg',params:{user_id:456,message:[{type:'text',data:{text:'[CQ:face,id=1]'}}]}}]);
  const normal=planQuickOperations(event(),{reply:'hello',delete:true,kick:true,ban:true});
  assert.deepEqual(normal.map(x=>x.action),['send_group_msg','delete_msg','set_group_kick','set_group_ban']);
  assert.deepEqual(wire(normal[0].params.message),[{type:'at',data:{qq:'456'}},{type:'text',data:{text:' '}},{type:'text',data:{text:'hello'}}]);
  assert.equal(normal[2].params.reject_add_request,false);assert.equal(normal[3].params.duration,1800);
  const anonymous=planQuickOperations(event({anonymous:{id:4,name:'synthetic',flag:'anonymous-flag'}}),{reply:'hello',kick:true,ban:true,ban_duration:0});
  assert.deepEqual(anonymous.map(x=>x.action),['send_group_msg','set_group_anonymous_ban']);
  assert.equal(anonymous[0].params.message[0].type,'text');assert.equal(anonymous[1].params.duration,0);
  const request=event({post_type:'request',request_type:'group',sub_type:'invite',flag:'synthetic-flag'});
  assert.deepEqual(planQuickOperations(request,{approve:false,reason:'declined'}),[{action:'set_group_add_request',params:{flag:'synthetic-flag',sub_type:'invite',approve:false,reason:'declined'}}]);
  assert.deepEqual(planQuickOperations(request,{}),[]);
  assert.throws(()=>planQuickOperations(event({user_id:Number(OWNER_UIN)}),{reply:'no'}));
  assert.throws(()=>planQuickOperations(event(),{reply:'hello',ban:'true'}));
});

test('only genuine emitted event objects create one-shot contexts and listener mutation cannot redirect reply',async t=>{
  const {bridge,core}=await setup(t);
  assert.equal(core.prepareQuickOperation(event()),null);
  const {delivered,handle}=capture(core,bridge);delivered.group_id=999;delivered.user_id=Number(OWNER_UIN);
  assert.equal(core.prepareQuickOperation(delivered),null);
  assert.deepEqual(handle({reply:'safe',at_sender:false}),{accepted:true,queued:1});
  assert.deepEqual(handle({reply:'again'}),{accepted:false,reason:'already_used',queued:0});
  await until(()=>core.metrics.rateCompleted===1);
  assert.equal(bridge.calls[0].params.group_id,123);
});

test('unsupported and capacity-limited multi-operation responses are rejected before accepting any action',async t=>{
  const {bridge,core}=await setup(t,{maxRatePending:1});
  bridge.available=['send_group_msg'];
  assert.deepEqual(capture(core,bridge).handle({reply:'x',delete:true}),{accepted:false,reason:'unsupported_operation',queued:0});
  bridge.available.push('delete_msg');
  assert.deepEqual(capture(core,bridge,event({message_id:2})).handle({reply:'x',delete:true}),{accepted:false,reason:'capacity',queued:0});
  await turn();assert.equal(bridge.calls.length,0);assert.equal(core.metrics.rateAccepted,0);
});

test('synchronous earlier subscriber cannot rebind an old event to the next session epoch',async t=>{
  const {bridge,core}=await setup(t);let firstHandler,secondDelivered=false;
  core.on('event',value=>{
    firstHandler=core.prepareQuickOperation(value);
    core.invalidate();bridge.session='synthetic-next';
  });
  core.on('event',value=>{secondDelivered=true;core.prepareQuickOperation(value)({reply:'wrong-session'});});
  bridge.emit('event',event());
  assert.equal(secondDelivered,false);
  assert.equal((await core.dispatch({action:'get_login_info'})).retcode,0);
  assert.equal(firstHandler({reply:'also-old'}).reason,'stale_event');
  await turn();assert.equal(bridge.calls.length,0);
});

test('subscriber cannot change later event context by mutating the original bridge object',async t=>{
  const {bridge,core}=await setup(t);const original=event();let later;
  core.on('event',()=>{original.group_id=999;original.user_id=777;});
  core.on('event',value=>{later=value;core.prepareQuickOperation(value)({reply:'stable',at_sender:false});});
  bridge.emit('event',original);await until(()=>core.metrics.rateCompleted===1);
  assert.equal(later.group_id,123);assert.equal(bridge.calls[0].params.group_id,123);
});

test('real webhook response queues reply and ban through normal dispatch in order',async t=>{
  const {bridge,core}=await setup(t,{minimumWriteIntervalMs:5});const deliveries=[];
  const url=await webhookServer(t,async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);
    let body='';for await(const chunk of req)body+=chunk;assert.equal(JSON.parse(body).group_id,123);
    res.end(JSON.stringify({reply:'response',at_sender:false,ban:true,ban_duration:4}));
  });
  const webhook=createWebhook({url,token,events:core,onDelivery:value=>deliveries.push(value)});t.after(()=>webhook.close());
  bridge.emit('event',event());await until(()=>core.metrics.rateCompleted===2);
  assert.deepEqual(deliveries[0].quickOperations,{accepted:true,queued:2});
  assert.deepEqual(bridge.calls.map(x=>x.action),['send_group_msg','set_group_ban']);
  assert.equal(bridge.calls[1].params.duration,4);
});

test('late HTTP response cannot cross session invalidation even after a new proof succeeds',async t=>{
  const {bridge,core}=await setup(t);let response;const deliveries=[];
  const url=await webhookServer(t,(req,res)=>{response=res;});
  const webhook=createWebhook({url,token,events:core,onDelivery:value=>deliveries.push(value)});t.after(()=>webhook.close());
  bridge.emit('event',event());await until(()=>response);
  core.invalidate();bridge.session='synthetic-next';assert.equal((await core.dispatch({action:'get_login_info'})).retcode,0);
  response.end('{"reply":"late"}');await until(()=>deliveries.length);
  assert.deepEqual(deliveries[0].quickOperations,{accepted:false,reason:'stale_event',queued:0});assert.equal(bridge.calls.length,0);
});

test('event deadline is rechecked after a slow runtime proof and prevents native submission',async t=>{
  let now=0,entered=false,release;const {bridge,core}=await setup(t,{clock:()=>now,proofMaxAgeMs:20});
  const {handle}=capture(core,bridge);
  bridge.probe=async()=>{entered=true;await new Promise(resolve=>{release=resolve;});return {user_id:BOT,online:true,sessionId:bridge.session};};
  assert.equal(handle({reply:'late'}).accepted,true);await until(()=>entered);now=21;release();
  await until(()=>core.metrics.rateFailed===1);assert.equal(bridge.calls.length,0);assert.equal(core.metrics.unknownOutcomes,0);
});

test('unknown first action does not cancel the remaining quick operations (P4)',async t=>{
  // P4：发送类动作结果未知时按「已接受」放行，**不再冻结队列**；后续操作照常执行。
  const {bridge,core}=await setup(t);
  bridge.call=async(action,params)=>{bridge.calls.push({action,params});throw new BridgeError('UNCONFIRMED','synthetic',{outcome:'unknown'});};
  assert.equal(capture(core,bridge).handle({reply:'one',delete:true}).queued,2);
  await until(()=>bridge.calls.length>=2);await turn();
  assert.equal(bridge.calls.length,2,'第二条不应该被第一条的未知结果取消');
  assert.equal(core.metrics.rateCancelled,0);
  assert(core.metrics.unknownOutcomes>=1);
});

test('quick cancellation and expiry during native UID preparation prevent the later mutation, with positive control',async t=>{
  for(const mode of ['positive','abort','expired']){
    let now=0,resolveUid,entered=false,writes=0;
    const bridge=new NativeBridge({session:{
      getMsgService:()=>({addKernelMsgListener(){return 1;},removeKernelMsgListener(){}}),
      getGroupService:()=>({
        getUidByUins(){entered=true;return new Promise(resolve=>{resolveUid=resolve;});},
        async setMemberShutUp(){writes++;return {result:0};},
      }),
    },identityProbe:async()=>({user_id:BOT,online:true,sessionId:'synthetic-native-quick'}),timeoutMs:1000});
    await bridge.attach();const core=new OneBotCore({ freezeOnUnknown: true,bridge,clock:()=>now,proofMaxAgeMs:2000,minimumWriteIntervalMs:0,rateLimitIntervalMs:0});
    t.after(()=>{core.close();bridge.detach();});
    assert.equal((await core.dispatch({action:'get_login_info'})).retcode,0);
    const controller=new AbortController(),{handle}=capture(core,bridge);
    assert.equal(handle({ban:true},{signal:controller.signal}).queued,1);await until(()=>entered);
    if(mode==='abort')controller.abort();if(mode==='expired')now=2001;
    resolveUid({errCode:0,uids:new Map([['456','u_synthetic']])});
    await until(()=>core.metrics.rateCompleted+core.metrics.rateFailed===1);
    assert.equal(writes,mode==='positive'?1:0,mode);
    assert.equal(core.metrics.rateCompleted,mode==='positive'?1:0,mode);
    assert.equal(core.metrics.unknownOutcomes,0,mode);
  }
});

test('webhook close after response acceptance cancels not-yet-submitted quick actions',async t=>{
  const {bridge,core}=await setup(t);let delivered;
  const url=await webhookServer(t,(req,res)=>res.end('{"reply":"cancel"}'));
  const webhook=createWebhook({url,token,events:core,onDelivery:value=>{delivered=value;webhook.close();}});t.after(()=>webhook.close());
  bridge.emit('event',event());await until(()=>delivered);await until(()=>core.metrics.rateFailed===1);
  assert.equal(delivered.quickOperations.accepted,true);assert.equal(bridge.calls.length,0);
});

test('oversize, invalid JSON and failed HTTP responses never produce a quick action or replay',async t=>{
  const {bridge,core}=await setup(t);let requests=0;const deliveries=[];
  const url=await webhookServer(t,(req,res)=>{
    requests++;
    if(requests===1){res.write('{"reply":"');res.end('x'.repeat(100)+'"}');}
    else if(requests===2)res.end('{broken');
    else {res.statusCode=503;res.end('{"reply":"not accepted"}');}
  });
  const webhook=createWebhook({url,token,events:core,maxResponseBytes:64,onDelivery:value=>deliveries.push(value)});t.after(()=>webhook.close());
  for(let i=1;i<=3;i++){bridge.emit('event',event({message_id:i}));await until(()=>deliveries.length===i);}
  assert.equal(requests,3);assert.equal(bridge.calls.length,0);
  assert.equal(deliveries[0].delivered,true);assert.equal(deliveries[0].quickOperations.reason,'invalid_response');
  assert.equal(deliveries[1].quickOperations.reason,'invalid_response');assert.equal(deliveries[2].status,503);
});

test('webhook byte budget includes active requests and becomes available after timeout',async t=>{
  const events=new EventEmitter(),deliveries=[];let requests=0;
  const url=await webhookServer(t,()=>{requests++;});
  const webhook=createWebhook({url,token,events,timeoutMs:500,maxPendingBytes:50,onDelivery:value=>deliveries.push(value)});t.after(()=>webhook.close());
  events.emit('event',{payload:'x'.repeat(20)});events.emit('event',{payload:'y'.repeat(20)});
  await until(()=>requests===1);
  await until(()=>deliveries.some(x=>x.outcome==='unknown'));
  assert.equal(deliveries.filter(x=>x.outcome==='dropped').length,1);assert.equal(requests,1);
  events.emit('event',{payload:'z'.repeat(20)});await until(()=>requests===2);
  await until(()=>deliveries.filter(x=>x.outcome==='unknown').length===2);assert.equal(requests,2);
});
