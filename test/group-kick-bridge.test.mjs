import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as turn } from 'node:timers/promises';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { OutcomeStore } from '../src/outcome-store.mjs';
import { createTransport } from '../src/transport/index.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN, MAIN = OWNER_UIN, TARGET = '10001', UID = 'u_synthetic_target';
const request = extra => ({ group_id: 20001, user_id: TARGET, ...extra });
const goodAck = () => ({ errCode: 0, errMsg: '', resultList: [{ uid: UID, result: 0 }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 1000; i++) { if (check()) return; await turn(); } throw new Error('Synthetic phase did not arrive'); }
async function fixture(t, { timeoutMs = 1000, omit } = {}) {
  const calls = [];
  const state = { identity: { user_id: BOT, online: true, sessionId: 'synthetic-kick-A' }, uid: UID, removed: false, listReads: 0,
    ack: goodAck(), kick: null, list: null, resolve: null, proof: null };
  const members = () => [
    { uin: BOT, uid: 'u_synthetic_bot' }, { uin: MAIN, uid: 'u_synthetic_protected' },
    ...(!state.removed ? [{ uin: TARGET, uid: UID }] : []),
  ];
  const complete = (values = members()) => ({ errCode: 0, result: { finish: true, infos: new Map(values.map((value, index) => ['unrelated-key-' + index, { ...value }])) } });
  const group = {
    async getUidByUins(values) { calls.push(['uid', [...values]]); return state.resolve ? state.resolve(values) : { errCode: 0, uids: new Map([[TARGET, state.uid]]) }; },
    async getAllMemberList(code, force) { calls.push(['members', code, force]); const phase = state.listReads++; return state.list ? state.list(phase) : complete(); },
    async kickMember(...args) { calls.push(['kick', ...args]); if (state.kick) return state.kick(...args); if (state.ack.errCode === 0 && state.ack.resultList?.[0]?.result === 0) state.removed = true; return state.ack; },
    kickMemberV2() { throw new Error('Uncalibrated V2 must not be called'); },
  };
  if (omit) delete group[omit];
  const bridge = new NativeBridge({ session: { getMsgService: () => ({ addKernelMsgListener: () => 1, removeKernelMsgListener() {} }), getGroupService: () => group },
    identityProbe: async () => state.proof ? state.proof() : state.identity, timeoutMs });
  await bridge.attach(); t.after(() => bridge.detach());
  return { bridge, group, calls, state, members, complete };
}
function storeFixture(t) {
  const tmp = fileURLToPath(new URL('../.tmp/', import.meta.url)); fs.mkdirSync(tmp, { recursive: true });
  const parent = fs.mkdtempSync(path.join(tmp, 'kick-integration-')), root = path.join(parent, 'qq-onebot'); fs.mkdirSync(root);
  const stores = [];
  const open = () => { const store = new OutcomeStore(root); stores.push(store); return store; };
  t.after(() => {
    for (const store of stores) store.close();
    const resolved = fs.realpathSync(parent); assert(resolved.startsWith(fs.realpathSync(tmp) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, open };
}

test('legacy kick maps one exact UID and default/true rejection flag, then requires complete refreshed absence', async t => {
  for (const flag of [undefined, true]) {
    const f = await fixture(t);
    assert(f.bridge.capabilities().includes('set_group_kick'));
    assert.equal(await f.bridge.call('set_group_kick', request(flag === undefined ? {} : { reject_add_request: flag })), null);
    assert.deepEqual(f.calls, [
      ['uid', [TARGET]], ['members', '20001', true], ['kick', '20001', [UID], flag ?? false, ''], ['members', '20001', true],
    ]);
  }
});

test('kick requires all three exact methods and never falls back to V2', async t => {
  for (const omit of ['kickMember', 'getUidByUins', 'getAllMemberList']) {
    const f = await fixture(t, { omit }); assert.equal(f.bridge.capabilities().includes('set_group_kick'), false);
    await assert.rejects(f.bridge.call('set_group_kick', request()), { code: 'UNSUPPORTED', outcome: 'not_started' });
    assert.deepEqual(f.calls, []);
  }
});

for (const scenario of ['all confirmed', 'partially rejected', 'all rejected', 'duplicate receipt', 'member still present']) {
  test(`batch kick with ${scenario} uses one native submission and checks exact target outcomes`, async t => {
    const f = await fixture(t);
    const second = '10002', secondUid = 'u_second';
    f.state.resolve = () => ({ errCode: 0, uids: new Map([[TARGET, UID], [second, secondUid]]) });
    f.state.list = phase => f.complete(phase && scenario !== 'member still present' ? f.members().slice(0, 2) :
      [...f.members(), { uin: second, uid: secondUid }]);
    f.state.kick = () => ({ errCode: 0, resultList: [
      { uid: secondUid, result: ['partially rejected', 'all rejected'].includes(scenario) ? 1 : 0 },
      { uid: scenario === 'duplicate receipt' ? secondUid : UID, result: scenario === 'all rejected' ? 1 : 0 },
    ] });
    const core = new OneBotCore({ bridge: f.bridge, minimumWriteIntervalMs: 0, outcomeStore: storeFixture(t).open() });
    t.after(() => core.close());
    const params = { ...request(), user_id: [TARGET, second], reject_add_request: 'true' };
    const action = 'set_group_kick_members';
    const result = await core.dispatch({ action, params });
    assert.equal(result.retcode, scenario === 'all confirmed' ? 0 : scenario === 'all rejected' ? 1500 : 1504);
    // 外发优先（2026-11-19）：未知结果只记账，不再把写闸关掉，也不再从能力表摘动作。
    if (result.retcode === 1504) {
      // 外发优先：写闸不再因为一次未知而关（旧行为这里 good 会变 false）。
      assert.equal(core.status().good, true);
      assert.equal(core.metrics.blocked, 0);
    }
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'kick'), [['kick', '20001', [UID, secondUid], true, '']]);
    assert.equal(f.state.listReads, ['all confirmed', 'member still present'].includes(scenario) ? 2 : 1);
  });
}

test('batch kick rejects protected, duplicate and unresolved targets before submission', async t => {
  const f = await fixture(t);
  const action = 'set_group_kick_members';
  for (const user_id of [[TARGET, MAIN], [TARGET, Number(TARGET)], [TARGET, BOT], [], TARGET])
    await assert.rejects(f.bridge.call(action, request({ user_id })), error => error.outcome === 'not_started');
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.bridge.call(action, request({ user_id: [TARGET, '10002'] })), { code: 'MEMBER_IDENTITY_UNCONFIRMED' });
  assert.deepEqual(f.calls, [['uid', [TARGET, '10002']]]);
});

test('authenticated batch kick rejects protected members and quarantines partial outcomes', async t => {
  const f = await fixture(t);
  const local = storeFixture(t);
  const token = 'synthetic-group-kick-token';
  const core = new OneBotCore({ bridge: f.bridge, minimumWriteIntervalMs: 0, outcomeStore: local.open() });
  const transport = await createTransport({ token, dispatch: core.dispatch, events: core, status: core.status, port: 0 });
  t.after(async () => { await transport.close(); core.close(); });
  const call = async user_id => {
    const response = await fetch(`http://127.0.0.1:${transport.address.port}/set_group_kick_members`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request({ user_id })),
    });
    return response.json();
  };
  assert.equal((await call([TARGET, MAIN])).retcode, 1403);
  assert.deepEqual(f.calls, []);
  const second = '10002', secondUid = 'u_second';
  f.state.resolve = () => ({ errCode: 0, uids: new Map([[TARGET, UID], [second, secondUid]]) });
  f.state.list = () => f.complete([...f.members(), { uin: second, uid: secondUid }]);
  f.state.kick = () => ({ errCode: 0, resultList: [{ uid: UID, result: 0 }, { uid: secondUid, result: 1 }] });
  assert.equal((await call([TARGET, second])).retcode, 1504);
  assert(fs.existsSync(path.join(local.root, 'runtime', 'outcomes', 'pending.json')));
  // 未知不再冻结：第二次照样提交（仍拿不到确认 ⇒ 1504），并把陈旧记录隔离留证。
  assert.equal((await call([TARGET, second])).retcode, 1504);
  assert.equal(f.calls.filter(([kind]) => kind === 'kick').length, 2);
  assert(fs.readdirSync(path.join(local.root, 'runtime', 'outcomes')).some(n => n.startsWith('pending.superseded-')));
});

test('protected main account, multiple targets and malformed flags reject the whole request before native reads', async t => {
  const f = await fixture(t);
  const variants = [request({ user_id: MAIN }), request({ user_id: [TARGET] }), request({ user_id: [TARGET, MAIN] }), request({ group_id: [20001] }),
    request({ reject_add_request: 'false' }), request({ reject_add_request: 1 }), request({ user_ids: [TARGET, MAIN] }), request({ reason: 'ignored reason forbidden' })];
  for (const value of variants) await assert.rejects(f.bridge.call('set_group_kick', value), error => ['PROTECTED_ACCOUNT', 'INVALID_PARAMS'].includes(error.code) && error.outcome === 'not_started');
  assert.deepEqual(f.calls, []);
});

test('runtime account failure prevents UID lookup and every mutation', async t => {
  const f = await fixture(t); f.state.identity = { user_id: MAIN, online: true, sessionId: 'wrong' };
  await assert.rejects(f.bridge.call('set_group_kick', request()), { code: 'IDENTITY_REJECTED', outcome: 'not_started' });
  assert.deepEqual(f.calls, []);
});

test('preflight verifies complete member value UIN/UID pairs and does not infer identity from Map keys', async t => {
  for (const variant of ['uid-mismatch', 'target-absent', 'incomplete', 'duplicate-uin', 'duplicate-uid', 'key-only-target', 'missing-uid']) {
    const f = await fixture(t);
    if (variant === 'uid-mismatch') f.state.uid = 'u_synthetic_protected';
    if (variant === 'target-absent') f.state.removed = true;
    if (variant === 'incomplete') f.state.list = () => ({ errCode: 0, result: { finish: false, infos: new Map() } });
    if (variant === 'duplicate-uin') f.state.list = () => f.complete([...f.members(), { uin: TARGET, uid: 'u_other' }]);
    if (variant === 'duplicate-uid') f.state.list = () => f.complete([...f.members(), { uin: '10002', uid: UID }]);
    if (variant === 'key-only-target') f.state.list = () => ({ errCode: 0, result: { finish: true, infos: new Map([[UID, { uin: '10002', uid: 'u_other' }]]) } });
    if (variant === 'missing-uid') f.state.list = () => f.complete([{ uin: TARGET }]);
    await assert.rejects(f.bridge.call('set_group_kick', request()), error => error.outcome === 'not_started');
    assert.equal(f.calls.some(call => call[0] === 'kick'), false);
  }
});

test('identity or submit guard change after preflight never calls kickMember', async t => {
  for (const changed of ['identity', 'guard']) {
    const f = await fixture(t); let allow = true;
    f.state.proof = () => {
      if (f.state.listReads) {
        if (changed === 'identity') return { user_id: BOT, online: true, sessionId: 'other-session' };
        allow = false;
      }
      return f.state.identity;
    };
    await assert.rejects(f.bridge.call('set_group_kick', request(), { shouldSubmit: () => allow }), error => error.outcome === 'not_started');
    assert.equal(f.calls.some(call => call[0] === 'kick'), false);
  }
});

test('missing, wrong, duplicate or malformed target ACK is unknown even when outer errCode is zero', async t => {
  const variants = [undefined, {}, { result: 0 }, { errCode: 0 }, { errCode: 0, resultList: [] },
    { errCode: 0, resultList: [{ uid: 'u_other', result: 0 }] },
    { errCode: 0, resultList: [{ uid: UID, result: 0 }, { uid: UID, result: 0 }] },
    { errCode: 0, resultList: [{ uid: UID, result: 0 }, { uid: 'u_other', result: 7 }] },
    { errCode: 0, resultList: [{ uid: UID }] }, { errCode: '0', resultList: [{ uid: UID, result: 0 }] },
    { errCode: 0, resultList: [{ uid: UID, result: '0' }] }, { errCode: 0, resultList: [{ uid: UID, result: NaN }] },
    { errCode: 7, resultList: [{ uid: UID, result: 0 }] },
  ];
  for (const ack of variants) {
    const f = await fixture(t); f.state.kick = () => ack;
    await assert.rejects(f.bridge.call('set_group_kick', request()), { code: 'UNCONFIRMED', outcome: 'unknown' });
    assert.equal(f.calls.filter(call => call[0] === 'kick').length, 1); assert.equal(f.state.listReads, 1);
  }
});

test('a valid exact-target nonzero member result is explicit rejection and no readback is reported', async t => {
  for (const outerCode of [0, 7]) {
    const f = await fixture(t); f.state.ack = { errCode: outerCode, resultList: [{ uid: UID, result: 9 }] };
    await assert.rejects(f.bridge.call('set_group_kick', request()), { code: 'NATIVE_REJECTED', outcome: 'rejected' });
    assert.equal(f.state.listReads, 1); assert.equal(f.calls.filter(c => c[0] === 'kick').length, 1);
  }
});

test('post-kick readback must be complete and exclude both target UIN and target UID', async t => {
  for (const mode of ['incomplete', 'missing', 'error', 'still-present', 'same-uin-new-uid', 'same-uid-new-uin', 'duplicate-other', 'malformed-other']) {
    const f = await fixture(t);
    f.state.list = phase => {
      if (!phase) return f.complete();
      if (mode === 'incomplete') return { errCode: 0, result: { infos: new Map(), finish: false } };
      if (mode === 'missing') return { errCode: 0, result: {} };
      if (mode === 'error') throw new Error('SECRET-NATIVE-ERROR');
      if (mode === 'still-present') return f.complete([{ uin: TARGET, uid: UID }]);
      if (mode === 'same-uin-new-uid') return f.complete([{ uin: TARGET, uid: 'u_rebound' }]);
      if (mode === 'same-uid-new-uin') return f.complete([{ uin: '10002', uid: UID }]);
      if (mode === 'duplicate-other') return f.complete([{ uin: '10002', uid: 'u_other' }, { uin: '10002', uid: 'u_second' }]);
      return f.complete([{ uin: 'not-a-uin', uid: 'u_other' }]);
    };
    await assert.rejects(f.bridge.call('set_group_kick', request()), error => error.outcome === 'unknown' && !error.message.includes('SECRET'));
    assert.equal(f.calls.filter(call => call[0] === 'kick').length, 1); assert.equal(f.state.listReads, 2);
  }
});

test('readback ignores map keys even if an unrelated value is stored under the removed target UID', async t => {
  const f = await fixture(t);
  f.state.list = phase => phase === 0 ? f.complete() : { errCode: 0, result: { finish: true, infos: new Map([[UID, { uin: '10002', uid: 'u_other' }]]) } };
  assert.equal(await f.bridge.call('set_group_kick', request()), null);
});

test('abort before submission is not-started, but kick/readback timeout or abort after submission remains unknown', async t => {
  const before = await fixture(t), resolver = deferred(), abortBefore = new AbortController();
  before.state.resolve = () => resolver.promise;
  const first = before.bridge.call('set_group_kick', request(), { signal: abortBefore.signal });
  const firstRejected = assert.rejects(first, error => error.outcome === 'not_started');
  await until(() => before.calls.some(c => c[0] === 'uid')); abortBefore.abort(); await firstRejected;
  resolver.resolve({ errCode: 0, uids: new Map([[TARGET, UID]]) }); await turn();
  assert.equal(before.calls.some(c => c[0] === 'kick'), false);
  for (const phase of ['kick', 'readback']) for (const stop of ['abort', 'timeout', 'detach']) {
    const f = await fixture(t, { timeoutMs: stop === 'timeout' ? 20 : 1000 }), pending = deferred(), controller = new AbortController();
    if (phase === 'kick') f.state.kick = () => pending.promise;
    else f.state.list = n => n === 0 ? f.complete() : pending.promise;
    const operation = f.bridge.call('set_group_kick', request(), { signal: controller.signal });
    const rejected = assert.rejects(operation, { code: 'UNCONFIRMED', outcome: 'unknown' });
    await until(() => phase === 'kick' ? f.calls.some(c => c[0] === 'kick') : f.state.listReads === 2);
    if (stop === 'abort') controller.abort(); if (stop === 'detach') f.bridge.detach(); await rejected;
    pending.resolve(phase === 'kick' ? goodAck() : f.complete([])); await turn();
    assert.equal(f.calls.filter(c => c[0] === 'kick').length, 1);
  }
});

test('identity replacement after ACK or during readback cannot confirm the mutation', async t => {
  for (const phase of ['ack', 'readback']) {
    const f = await fixture(t);
    if (phase === 'ack') f.state.kick = () => { f.state.identity = { user_id: MAIN, online: true, sessionId: 'wrong' }; return goodAck(); };
    else f.state.list = n => { if (!n) return f.complete(); f.state.identity = { user_id: BOT, online: true, sessionId: 'replaced' }; return f.complete([]); };
    await assert.rejects(f.bridge.call('set_group_kick', request()), { code: 'UNCONFIRMED', outcome: 'unknown' });
    assert.equal(f.state.listReads, phase === 'ack' ? 1 : 2);
    assert.equal(f.calls.filter(c => c[0] === 'kick').length, 1);
  }
});

test('native ACK/member accessors are not invoked as confirmation', async t => {
  let getters = 0;
  const f = await fixture(t), ack = { errCode: 0 };
  Object.defineProperty(ack, 'resultList', { get() { getters++; return [{ uid: UID, result: 0 }]; } });
  f.state.kick = () => ack;
  await assert.rejects(f.bridge.call('set_group_kick', request()), { outcome: 'unknown' });
  const pre = await fixture(t), member = { uin: TARGET };
  Object.defineProperty(member, 'uid', { get() { getters++; return UID; } });
  pre.state.list = () => ({ errCode: 0, result: { finish: true, infos: new Map([['key', member]]) } });
  await assert.rejects(pre.bridge.call('set_group_kick', request()), { outcome: 'not_started' });
  assert.equal(getters, 0); assert.equal(pre.calls.some(c => c[0] === 'kick'), false);
});

test('core normalizes boolean flag and clears durable latch only after successful kick confirmation', async t => {
  const f = await fixture(t), disk = storeFixture(t), store = disk.open();
  const core = new OneBotCore({ bridge: f.bridge, outcomeStore: store, minimumWriteIntervalMs: 0 }); t.after(() => core.close());
  const result = await core.dispatch({ action: 'set_group_kick', params: request({ reject_add_request: 'true' }), echo: { synthetic: true } });
  assert.equal(result.retcode, 0); assert.equal(result.data, null); assert.deepEqual(result.echo, { synthetic: true });
  assert.equal(f.calls.find(c => c[0] === 'kick')[3], true); assert.equal(store.pending, false);
  assert.equal(fs.existsSync(path.join(disk.root, 'runtime/outcomes/pending.json')), false);
});

test('core clears not-started and explicit rejection, permitting only a later explicit request', async t => {
  for (const phase of ['preflight', 'rejected']) {
    const f = await fixture(t), disk = storeFixture(t), store = disk.open();
    const core = new OneBotCore({ bridge: f.bridge, outcomeStore: store, minimumWriteIntervalMs: 0 }); t.after(() => core.close());
    if (phase === 'preflight') f.state.uid = 'u_wrong'; else f.state.ack = { errCode: 0, resultList: [{ uid: UID, result: 7 }] };
    const result = await core.dispatch({ action: 'set_group_kick', params: request() });
    assert.notEqual(result.retcode, 0); assert.equal(store.pending, false); assert.equal(core.metrics.unknownOutcomes, 0);
    assert.equal(f.calls.filter(c => c[0] === 'kick').length, phase === 'preflight' ? 0 : 1);
    f.state.uid = UID; f.state.ack = goodAck();
    assert.equal((await core.dispatch({ action: 'set_group_kick', params: request() })).retcode, 0);
    assert.equal(f.calls.filter(c => c[0] === 'kick').length, phase === 'preflight' ? 1 : 2);
  }
});

test('unknown kick result is recorded but no longer blocks retries after bridge reattachment and core reconstruction', async t => {
  for (const phase of ['ack', 'readback']) {
    const f = await fixture(t), disk = storeFixture(t), firstStore = disk.open();
    if (phase === 'ack') f.state.ack = { errCode: 0, resultList: [] };
    else f.state.list = n => n === 0 ? f.complete() : { errCode: 0, result: { finish: false, infos: new Map() } };
    const core = new OneBotCore({ bridge: f.bridge, outcomeStore: firstStore, minimumWriteIntervalMs: 0 }); t.after(() => core.close());
    assert.equal((await core.dispatch({ action: 'set_group_kick', params: request() })).retcode, 1504);
    assert.equal(firstStore.pending, true); assert.equal(core.metrics.unknownOutcomes, 1);
    // 外发优先：同一会话里第二次不会被「上一次未知」拒发（1503 是旧闩锁的码）。
    assert.notEqual((await core.dispatch({ action: 'set_group_kick', params: request() })).retcode, 1503);
    // 第二次提交时旧记录被隔离成 pending.superseded-*（它自己又写了一条新的未决记录）。
    assert.equal(core.metrics.blocked, 0, '写闸没有被未知结果关掉');
    core.close(); firstStore.close(); f.bridge.detach(); await f.bridge.attach();
    const secondStore = disk.open(), recreated = new OneBotCore({ bridge: f.bridge, outcomeStore: secondStore, minimumWriteIntervalMs: 0 }); t.after(() => recreated.close());
    // 裸 store 不带 adoptForeign：重建后的 core 也不会因为磁盘上那条记录而拒发（1503 是旧闩锁的码）。
    assert.notEqual((await recreated.dispatch({ action: 'set_group_kick', params: request() })).retcode, 1503);
  }
});
