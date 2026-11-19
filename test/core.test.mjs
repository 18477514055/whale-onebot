import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OneBotCore } from '../src/core.mjs';
import { ACTIONS, validateParams } from '../src/actions.mjs';
import { normalizeMessage, toCQ } from '../src/segments.mjs';
import { BridgeError } from '../src/bridge/native-bridge.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

class Fixture extends EventEmitter {
  identity={user_id:Number(BOT_UIN),nickname:'Synthetic whale',online:true,sessionId:'fixture-session-1'};
  calls=[];
  capabilities(){return ['send_group_msg','send_private_msg','get_group_list'];}
  async probe(){return this.identity;}
  async call(action,params){this.calls.push({action,params});return action==='get_group_list'?[]:{message_id:11};}
}
function setup(t, options={}){const bridge=new Fixture();const core=new OneBotCore({bridge,minimumWriteIntervalMs:0,...options});t.after(()=>core.close());return {bridge,core};}
test('resident status reads the expiring proof without starting or waiting for identity probes', async t => {
  let now = 100;
  const { core, bridge } = setup(t, { clock: () => now, proofMaxAgeMs: 100, statusFromBackground: true });
  const proof = Promise.withResolvers();
  let probes = 0;
  bridge.probe = () => { probes++; return proof.promise; };
  const refresh = core.refreshIdentity(new AbortController().signal);
  assert.equal(probes, 1);
  const status = () => core.dispatch({ action: 'get_status', echo: 'health' });
  assert.deepEqual(await status(), { status: 'ok', retcode: 0, data: { online: false, good: false }, echo: 'health' });
  assert.equal(probes, 1);
  proof.resolve(bridge.identity);
  await refresh;
  assert.deepEqual((await status()).data, { online: true, good: true });
  now += 100;
  assert.deepEqual((await status()).data, { online: false, good: false });
  assert.equal(probes, 1);
  assert.equal((await core.dispatch({ action: 'send_group_msg', params: { group_id: 20001, message: 'fixture' } })).retcode, 0);
  assert.equal(probes, 2);
  assert.equal(bridge.calls.length, 1);
});

test('background identity refresh times out, revokes stale proof, and can recover with an older probe still pending', async t => {
  const { core, bridge } = setup(t, { timeoutMs: 25, proofMaxAgeMs: 10000, statusFromBackground: true });
  const signal = new AbortController().signal;
  assert(await core.refreshIdentity(signal));
  const stalled = Promise.withResolvers();
  bridge.probe = () => stalled.promise;
  assert.equal(await core.refreshIdentity(signal), null);
  assert.deepEqual(core.status(), { online: false, good: false });

  bridge.probe = async () => bridge.identity;
  assert(await core.refreshIdentity(signal));
  stalled.resolve({ ...bridge.identity, user_id: Number(OWNER_UIN) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(core.status(), { online: true, good: true });
});

test('background refresh bounds unresolved probes that ignore cancellation', async t => {
  const { core, bridge } = setup(t, { timeoutMs: 20 });
  const pending = [];
  bridge.probe = () => {
    const probe = Promise.withResolvers();
    pending.push(probe);
    return probe.promise;
  };
  const signal = new AbortController().signal;
  for (let attempt = 0; attempt < 4; attempt++) assert.equal(await core.refreshIdentity(signal), null);
  assert.equal(pending.length, 2);
  for (const probe of pending) probe.resolve(bridge.identity);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(core.status(), { online: false, good: false });
  bridge.probe = async () => bridge.identity;
  assert(await core.refreshIdentity(signal));
});

test('older background failure does not revoke a newer successful business probe', async t => {
  const { core, bridge } = setup(t, { timeoutMs: 40, statusFromBackground: true });
  const signal = new AbortController().signal;
  for (const failure of ['invalid-result', 'timeout']) {
    const stalled = Promise.withResolvers();
    bridge.probe = () => stalled.promise;
    const refresh = core.refreshIdentity(signal);
    bridge.probe = async () => bridge.identity;
    const response = await core.dispatch({ action: 'get_login_info' });
    assert.equal(response.retcode, 0);
    if (failure === 'invalid-result') stalled.resolve({ ...bridge.identity, online: false });
    assert.equal(await refresh, null);
    assert.deepEqual(core.status(), { online: true, good: true });
    stalled.resolve(bridge.identity);
  }
});
test('older business probes fail without submitting or revoking a newer proof', async t => {
  const { core, bridge } = setup(t, { timeoutMs: 1000 });
  for (const finish of [
    probe => probe.resolve(bridge.identity),
    probe => probe.resolve({ ...bridge.identity, online: false }),
    probe => probe.reject(new Error('Earlier probe failed')),
  ]) {
    const previous = Promise.withResolvers();
    bridge.probe = () => previous.promise;
    const send = core.dispatch({ action: 'send_group_msg', params: { group_id: 20001, message: 'fixture' } });
    bridge.probe = async () => bridge.identity;
    assert.equal((await core.dispatch({ action: 'get_login_info' })).retcode, 0);
    finish(previous);
    assert.equal((await send).retcode, 1503);
    assert.deepEqual(core.status(), { online: true, good: true });
    assert.deepEqual(bridge.calls, []);
  }
  assert.equal((await core.dispatch({ action: 'send_group_msg', params: { group_id: 20001, message: 'fixture' } })).retcode, 0);
  assert.equal(bridge.calls.length, 1);
});

test('wrong identity blocks outbound and inbound; same path positive control sends once',async t=>{
  const {core,bridge}=setup(t); let events=0;core.on('event',()=>events++);
  bridge.identity={...bridge.identity,user_id:Number(OWNER_UIN)};
  const req={action:'send_group_msg',params:{group_id:900001,message:'synthetic'},echo:{nested:[0,false]}};
  assert.equal((await core.dispatch(req)).retcode,1503);assert.equal(bridge.calls.length,0);
  bridge.emit('event',{self_id:Number(BOT_UIN),post_type:'message'});assert.equal(events,0);
  bridge.identity={...bridge.identity,user_id:Number(BOT_UIN)};
  const response=await core.dispatch(req);assert.equal(response.retcode,0);assert.deepEqual(response.echo,req.echo);assert.equal(bridge.calls.length,1);
  bridge.emit('event',{self_id:Number(BOT_UIN),post_type:'message'});assert.equal(events,1);
});
test('online flag and nonempty native session identity both required',async t=>{
  const {core,bridge}=setup(t);
  for(const invalid of [{online:false},{sessionId:''},{user_id:undefined}]){
    bridge.identity={user_id:Number(BOT_UIN),online:true,sessionId:'synthetic',...invalid};
    assert.notEqual((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}})).retcode,0);
  }assert.equal(bridge.calls.length,0);
});
test('epoch revokes proof and discards late business response after disconnect',async t=>{
  const {core,bridge}=setup(t);let finish;
  bridge.call=()=>new Promise(resolve=>{finish=resolve;});
  const pending=core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}});
  await new Promise(resolve=>setImmediate(resolve));bridge.emit('offline');finish({message_id:99});
  // P4：发送类动作拿不到确定结果时按「已接受」回（成功 + message_id:null），不再回 1504。
  assert.equal((await pending).retcode,0);assert.equal(core.status().good,false);
  // 外发优先（2026-11-19）：未知结果不再关闸，下一次写照样提交（这次同样拿不到回执 ⇒ 1504）。
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}})).retcode,0);
});
test('typed read failures retain session and do not cancel a concurrent submitted write', async t => {
  const {core,bridge}=setup(t);
  let completeWrite;
  let enteredWrite;
  const started=new Promise(resolve=>{enteredWrite=resolve;});
  let readCode=1404;
  bridge.call=async action=>{
    if(action==='get_group_list')
      throw new BridgeError('SYNTHETIC_QUERY_FAILURE','internal text', {retcode:readCode});
    return new Promise(resolve=>{completeWrite=resolve;enteredWrite();});
  };
  const write=core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'synthetic'}});
  await started;
  for(const code of [1400,1403,1404,1500,1502]){
    readCode=code;
    const reply=await core.dispatch({action:'get_group_list',echo:'query'});
    assert.equal(reply.retcode,code);
    assert.equal(reply.echo,'query');
    assert.doesNotMatch(JSON.stringify(reply),/internal text/);
    assert.deepEqual(core.status(),{online:true,good:true});
  }
  completeWrite({message_id:11});
  assert.equal((await write).retcode,0);
});

test('identity probe errors and read errors after session invalidation do not become action failures', async t => {
  const {core,bridge}=setup(t);
  const missing=()=>new BridgeError('SYNTHETIC_MISSING','internal text',{retcode:1404});
  bridge.call=async()=>{bridge.emit('offline');throw missing();};
  assert.equal((await core.dispatch({action:'get_group_list'})).retcode,1503);
  assert.deepEqual(core.status(),{online:false,good:false});
  bridge.probe=async()=>{throw missing();};
  assert.equal((await core.dispatch({action:'get_group_list'})).retcode,1503);
});

test('a query deadline preserves an unrelated write and charges capacity until the adapter settles', async t => {
  const {core,bridge}=setup(t,{timeoutMs:25,maxConcurrent:2});
  let finishRead, finishWrite, readSignal, writeSignal;
  let enteredRead, enteredWrite;
  const readStarted=new Promise(resolve=>{enteredRead=resolve;});
  const writeStarted=new Promise(resolve=>{enteredWrite=resolve;});
  let readCalls=0;
  bridge.call=async(action,_params,{signal})=>{
    if(action==='get_group_list'){
      readCalls++;
      readSignal=signal;
      return new Promise(resolve=>{finishRead=resolve;enteredRead();});
    }
    writeSignal=signal;
    return new Promise(resolve=>{finishWrite=resolve;enteredWrite();});
  };
  const query={action:'get_group_list',echo:'query'};
  const read=core.dispatch(query);
  await readStarted;
  // Give the concurrent write its own deadline independent of wall-clock jitter.
  core.timeoutMs=1000;
  const write=core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'synthetic'}});
  await writeStarted;
  assert.equal((await read).retcode,1502);
  assert.equal(readSignal.aborted,true);
  assert.equal(writeSignal.aborted,false);
  assert.deepEqual(core.status(),{online:true,good:true});
  assert.equal((await core.dispatch(query)).retcode,1429);
  assert.equal(readCalls,1);
  assert.equal(core.metrics.unknownOutcomes,0);
  finishRead([{group_id:900001}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await core.dispatch({action:'get_login_info'})).retcode,0);
  finishWrite({message_id:11});
  assert.equal((await write).retcode,0);
});
test('side effect timeout is recorded but no longer latches later sends',async t=>{
  const {core,bridge}=setup(t,{timeoutMs:20,minimumWriteIntervalMs:0});let calls=0;
  bridge.call=async()=>{calls++;return new Promise(()=>{});};
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}})).retcode,0);
  assert.equal((await core.dispatch({action:'get_login_info'})).retcode,0);
  // 会话本身没坏：good 保持 true，写闸也不会因为一次未知而关闭。
  assert.equal(core.status().good,true);
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'x'}})).retcode,0);
  assert.equal(calls,2);
});
test('timed out identity probe cannot submit a late action',async t=>{
  const {core,bridge}=setup(t,{timeoutMs:20,maxConcurrent:1,statusFromBackground:true});
  const probe = Promise.withResolvers();
  let probes = 0;
  bridge.probe = () => { probes++; return probe.promise; };
  const send = {action:'send_group_msg',params:{group_id:900001,message:'x'}};
  // P4：身份校验阶段就超时 ⇒ 我们确知「没提交」⇒ 回「未提交(1503)」，不回「未知(1504)」。
  assert.equal((await core.dispatch(send)).retcode,1503);
  assert.equal((await core.dispatch({action:'get_login_info'})).retcode,1429);
  assert.deepEqual((await core.dispatch({action:'get_status'})).data,{online:false,good:false});
  assert.equal(probes,1);
  probe.resolve(bridge.identity);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(bridge.calls.length,0);
  assert.equal((await core.dispatch(send)).retcode,0);
  assert.equal(bridge.calls.length,1);
});
test('proof expires and duplicate events suppressed; bad subscriber isolated',async t=>{
  let now=100;const {core,bridge}=setup(t,{clock:()=>now,proofMaxAgeMs:1000});await core.dispatch({action:'get_login_info'});
  let received=0;core.on('event',()=>{throw new Error('fixture');});core.on('event',()=>received++);
  const event={self_id:Number(BOT_UIN),post_type:'message',message_type:'group',group_id:900001,message_id:8};
  bridge.emit('event',event);bridge.emit('event',event);assert.equal(received,1);
  now=1100;bridge.emit('event',{...event,message_id:9});assert.equal(received,1);assert.equal(core.status().online,false);
});
test('backpressure and per-bot rate limit reject before submission',async t=>{
  let now=0;const {core,bridge}=setup(t,{clock:()=>now,minimumWriteIntervalMs:500});
  const request={action:'send_group_msg',params:{group_id:900001,message:'x'}};
  assert.equal((await core.dispatch(request)).retcode,0);assert.equal((await core.dispatch(request)).retcode,1429);
  now=500;assert.equal((await core.dispatch(request)).retcode,0);assert.equal(bridge.calls.length,2);
});
test('writes to different chats run in parallel; the same chat stays serialized',async t=>{
  // 2026-11-19：写锁从「全局一把」改成「按会话一把」—— A 群等回执不该挡住 B 群。
  const {core,bridge}=setup(t,{minimumWriteIntervalMs:0});
  const pending=[];
  bridge.call=action=>new Promise(resolve=>{pending.push(()=>resolve({message_id:pending.length}));});
  const first=core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'a'}});
  const second=core.dispatch({action:'send_group_msg',params:{group_id:900002,message:'b'}});
  const sameChat=await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'c'}});
  assert.equal(sameChat.retcode,1429,'同一个群仍然串行');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending.length,2,'两个不同的群应同时进入原生调用');
  for(const settle of pending)settle();
  assert.equal((await first).retcode,0);
  assert.equal((await second).retcode,0);
});
test('protected account, unknown capabilities and malformed requests fail without native call',async t=>{
  const {core,bridge}=setup(t);
  assert.equal((await core.dispatch({action:'send_private_msg',params:{user_id:Number(OWNER_UIN),message:'x'}})).retcode,1403);
  assert.equal((await core.dispatch({action:'set_restart'})).retcode,1404);
  assert.equal((await core.dispatch({action:'constructor'})).retcode,1404);
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:0,message:'x'}})).retcode,1400);
  assert.equal((await core.dispatch({action:'send_group_msg_rate_limited_async',params:{group_id:900001,message:'x'}})).retcode,1404);
  assert.equal(bridge.calls.length,0);
});
test('offline reports honest status and only implemented capabilities',async()=>{
  const core=new OneBotCore();
  assert.deepEqual((await core.dispatch({action:'get_status'})).data,{online:false,good:false});
  assert.equal((await core.dispatch({action:'get_login_info'})).retcode,1503);
  const caps=(await core.dispatch({action:'get_supported_actions'})).data;
  assert(!caps.includes('send_group_msg'));assert(caps.length<Object.keys(ACTIONS).length);core.close();
});

test('QQ system face metadata is available offline and independent of the bridge', async t => {
  const core = new OneBotCore();
  t.after(() => core.close());
  const catalog = () => core.dispatch({ action: 'fetch_sys_faces' });
  assert((await core.dispatch({ action: 'get_supported_actions' })).data.includes('fetch_sys_faces'));
  const first = await catalog();
  assert.equal(first.retcode, 0);
  assert.deepEqual(first.data.packs[0].emojis.find(face => face.q_sid === '14'), { q_sid: '14', q_des: '/微笑' });
  first.data.packs[0].emojis.length = 0;
  assert.equal((await catalog()).data.packs[0].emojis.length, 12);
  assert.equal((await core.dispatch({ action: 'fetch_sys_faces', params: { user_id: 1 } })).retcode, 1400);
  assert.equal(core.status().online, false);
});

test('capability advertisement follows identity freshness and keeps writes after an unknown result', async t=>{
  let now=100, probes=0;
  const {core,bridge}=setup(t,{clock:()=>now,proofMaxAgeMs:50});
  const originalProbe=bridge.probe.bind(bridge);
  bridge.probe=async()=>{probes++;return originalProbe();};
  const listed=async()=>(await core.dispatch({action:'get_supported_actions'})).data;
  assert(!(await listed()).includes('get_group_list'));
  assert.equal(probes,0);
  await core.dispatch({action:'get_login_info'});
  assert((await listed()).includes('send_group_msg'));
  assert((await listed()).includes('get_group_list'));
  now=150;
  assert(!(await listed()).includes('send_group_msg'));
  assert.equal(probes,1);
  bridge.call=async()=>{throw new Error('Synthetic lost receipt');};
  assert.equal((await core.dispatch({action:'send_group_msg',params:{group_id:900001,message:'synthetic'}})).retcode,0);
  await core.dispatch({action:'get_login_info'});
  const afterUnknown=await listed();
  assert(afterUnknown.includes('get_group_list'));
  // 外发优先：未知结果不再从能力表里摘掉写动作。
  assert(afterUnknown.includes('send_group_msg'));
  bridge.emit('offline');
  assert(!(await listed()).includes('get_group_list'));
});

test('accepted writes are never submitted when identity verification withdraws the action', async t => {
  for (const suffix of ['', '_async', '_rate_limited']) {
    await t.test(suffix || 'synchronous', async subtest => {
      let writes = 0;
      const outcomeStore = { pending: false, begin() { writes++; }, confirmed() {} };
      const { core, bridge } = setup(subtest, { outcomeStore, rateLimitIntervalMs: 0 });
      const probing = Promise.withResolvers();
      const release = Promise.withResolvers();
      let capabilities = ['send_group_msg', 'get_group_list'];
      bridge.capabilities = () => capabilities;
      bridge.probe = async () => { probing.resolve(); await release.promise; return bridge.identity; };
      const response = core.dispatch({ action: `send_group_msg${suffix}`, params: { group_id: 20001, message: 'synthetic' } });
      if (suffix) assert.equal((await response).retcode, 1);
      await probing.promise;
      capabilities = ['get_group_list'];
      release.resolve();
      if (!suffix) assert.equal((await response).retcode, 1404);
      const deadline = Date.now() + 1000;
      while (suffix && core.metrics.asyncFailed + core.metrics.rateFailed === 0) {
        assert(Date.now() < deadline, 'Queued request did not finish');
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.deepEqual(core.status(), { online: true, good: true });
      assert.equal(writes, 0);
      assert.deepEqual(bridge.calls, []);
      capabilities = ['send_group_msg', 'get_group_list'];
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await core.dispatch({ action: 'send_group_msg', params: { group_id: 20001, message: 'new request' } })).retcode, 0);
      assert.equal(writes, 1);
      assert.equal(bridge.calls.length, 1);
      assert.deepEqual(bridge.calls[0].params.message, [{ type: 'text', data: { text: 'new request' } }]);
    });
  }
});
test('CQ escapes roundtrip literals and parameters without recursive unescaping',()=>{
  const message=[{type:'text',data:{text:'& [CQ:at,qq=9]'}},{type:'at',data:{qq:'all',name:'a,b&[c]'}}];
  assert.equal(toCQ(normalizeMessage(toCQ(message))),toCQ(message));
  assert.equal(normalizeMessage('&amp;#91;')[0].data.text,'&#91;');
  assert.deepEqual(normalizeMessage('[CQ:at,qq=123]',true),[{type:'text',data:{text:'[CQ:at,qq=123]'}}]);
  assert.throws(()=>normalizeMessage('[CQ:at,__proto__=x]'));
  assert.throws(()=>normalizeMessage('[CQ:at,qq=1,qq=2]'));
  assert.throws(()=>normalizeMessage([{type:'text',data:{text:null}}]));
});
test('validated ban defaults differ from zero unban and false remains false',()=>{
  assert.equal(validateParams('set_group_ban',{group_id:900001,user_id:900002}).duration,1800);
  assert.equal(validateParams('set_group_ban',{group_id:900001,user_id:900002,duration:'0'}).duration,0);
  assert.equal(validateParams('set_group_admin',{group_id:900001,user_id:900002,enable:'false'}).enable,false);
  assert.throws(()=>validateParams('set_group_ban',{group_id:900001,user_id:900002,duration:-1}));
});
test('CQ and nested forward segments share bounded complexity',()=>{
  assert.throws(()=>normalizeMessage('[CQ:face,id=1]'.repeat(1001)),/budget/);
  let nested=[{type:'text',data:{text:'x'}}];
  for(let i=0;i<18;i++)nested=[{type:'node',data:{content:nested}}];
  assert.throws(()=>normalizeMessage(nested),/nesting/);
});
test('trusted native rejection is reported without unknown latch; generic errors remain unknown',async t=>{
  const {core,bridge}=setup(t);
  bridge.call=async()=>{throw new BridgeError('UNSUPPORTED_SEGMENT','redacted',{retcode:1404,outcome:'not_started'});};
  const req={action:'send_group_msg',params:{group_id:900001,message:'x'}};
  assert.equal((await core.dispatch(req)).retcode,1404);
  bridge.call=async()=>({message_id:5});assert.equal((await core.dispatch(req)).retcode,0);
  bridge.call=async()=>{throw Object.assign(new Error('secret'),{retcode:1404,outcome:'not_started'});};
  assert.equal((await core.dispatch(req)).retcode,0);
});
