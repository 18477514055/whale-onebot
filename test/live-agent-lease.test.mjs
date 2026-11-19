import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveAgentTrigger, D6_SCOPE } from '../src/host/live-agent-trigger.mjs';
import { LiveAgentLeaseGate } from '../src/host/live-agent-lease.mjs';
import { OWNER_UIN, TEST_GROUP } from '../src/config/account.mjs';

const SESSION = '1'.repeat(64), RUN = '2'.repeat(64);
const binding = { generation: 1, sessionDigest: SESSION };
function syntheticStore() {
  const events = [], slots = [], permits = new WeakMap(); let state = 'active', epoch = 1;
  const store = {
    events, slots,
    status: () => ({ ...D6_SCOPE, state: state === 'frozen' ? 'frozen' : slots.length === 3 ? 'exhausted' : 'active',
      used: slots.length, remaining: state === 'frozen' ? 0 : 3 - slots.length, ownerEpoch: epoch }),
    reserve(input) {
      assert.equal(state, 'active'); assert(slots.length < 3);
      assert(!slots.some(slot => slot.triggerDigest === input.triggerDigest));
      const row = { ...input, state: 'reserved' }; slots.push(row); events.push('reserve');
      const permit = Object.freeze(Object.create(null)); permits.set(permit, row); return permit;
    },
    markSubmitted(permit) { const row = permits.get(permit); assert.equal(row?.state, 'reserved');
      row.state = 'submitted'; events.push('submitted'); return true; },
    confirm(permit, input) { const row = permits.get(permit); assert.equal(row?.state, 'submitted');
      assert.match(input.receiptDigest, /^[a-f0-9]{64}$/); row.state = 'confirmed'; events.push('confirmed'); return true; },
    rejectConsumed(permit) { const row = permits.get(permit); assert(row); row.state = 'rejectedConsumed'; return true; },
    markUnknown(permit) { const row = permits.get(permit); assert(row); state = 'frozen';
      for (const slot of slots) if (['reserved','submitted'].includes(slot.state)) slot.state = 'unknownConsumed';
      events.push('unknown'); return true; },
    changeEpoch() { epoch++; },
  }; return store;
}
function fixture(store = syntheticStore(), options = {}) {
  let wall = Date.now(), mono = 100;
  const time = { wallClock: () => wall, clock: () => mono };
  const trigger = new LiveAgentTrigger(time);
  const challenge = trigger.arm({ ...binding, expiresAt: wall + 30000 });
  const raw = { chatType: 2, peerUid: D6_SCOPE.group, senderUin: D6_SCOPE.tester,
    msgId: '42', msgTime: Math.floor(wall / 1000), elements: [{ elementType: 1, textElement: { content: challenge.challengeText } }] };
  trigger.observe([raw], binding);
  const record = trigger.take(binding); assert(record);
  const calls = []; let finalGuard, proofOverride, adapterOverride;
  const proof = () => ({ user_id: D6_SCOPE.bot, online: true, ...binding,
    observedAt: wall, expiresAt: wall + 1000, authority: 'independent-current', ...proofOverride });
  const view = text => ({ groupId: D6_SCOPE.group, text, ...binding, correlationId: '100' });
  const receipt = () => ({ groupId: D6_SCOPE.group, bot: D6_SCOPE.bot, ...binding,
    correlationId: '100', finalMessageId: '101', message_id: 200, sendStatus: 2 });
  const nativeSubmit = async (payload, context) => {
    calls.push(payload); finalGuard = context.beforeNative;
    if (adapterOverride) return adapterOverride(payload, context);
    context.beforeNative(view(payload.message[0].data.text)); store.events.push('native');
    return receipt();
  };
  const gate = new LiveAgentLeaseGate({ store, identityProbe: proof, nativeSubmit, ...time, ...options });
  return { store, gate, record, trigger, calls, proof, view, receipt,
    get guard() { return finalGuard; },
    setProof(value) { proofOverride = value; },
    setAdapter(value) { adapterOverride = value; },
    tick(ms) { wall += ms; mono += ms; },
    wallOnly(ms) { wall += ms; },
    async ready() {
      const granted = await gate.authorize(record, { runDigest: RUN });
      return { ...granted, params: { group_id: Number(D6_SCOPE.group),
        message: [{ type: 'text', data: { text: granted.descriptor.marker + ' synthetic reply' } }] } };
    },
  };
}
const stopped = promise => assert.rejects(promise, e => e.code === 'D6_SEND_STOPPED' && e.outcome === 'unknown');

test('no default authority, storage or native implementation can be enabled accidentally', () => {
  assert.throws(() => new LiveAgentLeaseGate(), /D6_DEPENDENCY_REQUIRED/);
});
test('exactly reserve, submitted, native, correlated confirm; late guard cannot send twice', async () => {
  const f = fixture(), r = await f.ready();
  const result = await f.gate.submit(r.permit, 'send_group_msg', r.params);
  assert.deepEqual(result, { message_id: 200 });
  assert.deepEqual(f.store.events, ['reserve','submitted','native','confirmed']);
  assert.equal(f.calls.length, 1); assert.equal(f.store.slots[0].state, 'confirmed');
  assert(Object.isFrozen(f.calls[0].message[0].data));
  assert.equal(f.gate.status().state, 'disarmed');
  assert.throws(() => f.guard(f.view(r.params.message[0].data.text)), /D6_NATIVE_GUARD_DENIED/);
  assert.equal(f.store.events.filter(v => v === 'native').length, 1);
});
test('three successful serial triggers consume fixed store across new host coordinator instances', async () => {
  const store = syntheticStore();
  for (let slot = 1; slot <= 3; slot++) {
    const f = fixture(store), r = await f.ready(); assert.equal(r.descriptor.slot, slot);
    await f.gate.submit(r.permit, 'send_group_msg', r.params); f.gate.close();
  }
  const f = fixture(store);
  await assert.rejects(f.ready(), /D6_AUTHORIZATION_FAILED/);
  assert.equal(store.slots.length, 3); assert.equal(f.calls.length, 0);
});
test('JSON/structuredClone run permits and live records have no authority', async () => {
  const f = fixture(), r = await f.ready();
  for (const permit of [{}, structuredClone(r.permit), JSON.parse(JSON.stringify(r.permit))])
    await assert.rejects(f.gate.submit(permit, 'send_group_msg', r.params), /D6_PERMIT_DENIED/);
  const other = fixture();
  await assert.rejects(other.gate.authorize(structuredClone(other.record), { runDigest: RUN }), /D6_TRIGGER_DENIED/);
  assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
});
test('one claimed trigger cannot authorize another gate', async () => {
  const f = fixture(); await f.ready();
  const other = fixture(f.store);
  await assert.rejects(other.gate.authorize(f.record, { runDigest: RUN }), /D6_TRIGGER_DENIED/);
});
for (const action of ['send_msg','send_message','send_private_msg','send_group_msg_async',
  'send_group_msg_rate_limited','get_group_msg_history','get_msg','set_online_status','.handle_quick_operation']) {
  test(`action denied without reserve/native: ${action}`, async () => {
    const f = fixture(), r = await f.ready();
    await assert.rejects(f.gate.submit(r.permit, action, r.params), /D6_ACTION_DENIED/);
    assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
  });
}
const malformed = {
  'wrong group': r => ({ ...r.params, group_id: 123456 }),
  'private target': r => ({ ...r.params, user_id: Number(OWNER_UIN) }),
  'string message': r => ({ ...r.params, message: r.params.message[0].data.text }),
  'two texts': r => ({ ...r.params, message: [...r.params.message, ...r.params.message] }),
  'at main': r => ({ ...r.params, message: [{ type: 'at', data: { qq: D6_SCOPE.tester } }] }),
  'quote main': r => ({ ...r.params, message: [{ type: 'reply', data: { id: 42 } }] }),
  'media': r => ({ ...r.params, message: [{ type: 'image', data: { file: 'not-opened' } }] }),
  'wrong marker': r => ({ ...r.params, message: [{ type: 'text', data: { text: 'unmarked reply' } }] }),
  'CQ code': r => ({ ...r.params, message: [{ type: 'text', data: { text: r.descriptor.marker + ' [cq:at,qq=all]' } }] }),
  'control': r => ({ ...r.params, message: [{ type: 'text', data: { text: r.descriptor.marker + ' \u0000' } }] }),
  'too long': r => ({ ...r.params, message: [{ type: 'text', data: { text: r.descriptor.marker + ' ' + 'x'.repeat(512) } }] }),
  'auto_escape extra': r => ({ ...r.params, auto_escape: true }),
  'inherited props': r => Object.create(r.params),
  'getter': r => Object.defineProperties({}, { group_id: { value: Number(TEST_GROUP), enumerable: true },
    message: { get() { throw new Error('getter must not run'); }, enumerable: true } }),
};
for (const [name, transform] of Object.entries(malformed)) test(`static payload denied: ${name}`, async () => {
  const f = fixture(), r = await f.ready();
  await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', transform(r)), /^BridgeError: D6_/);
  assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
});
for (const [name, change] of Object.entries({ offline: { online: false }, main: { user_id: D6_SCOPE.tester },
  numericBot: { user_id: Number(D6_SCOPE.bot) }, wrongSession: { sessionDigest: '3'.repeat(64) },
  staleGeneration: { generation: 2 }, callerProof: { authority: 'verified:true' },
  staleProof: { observedAt: 1, expiresAt: 2 }, extra: { verified: true } })) {
  test(`independent identity fails closed before native: ${name}`, async () => {
    const f = fixture(); f.setProof(change);
    await assert.rejects(f.ready(), /D6_AUTHORIZATION_FAILED/);
    assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
  });
}
test('grant deadlines are absolute and clock rollback is not renewal', async () => {
  for (const change of [f => f.tick(30000), f => f.wallOnly(-1), f => f.trigger.cancel()]) {
    const f = fixture(), r = await f.ready(); change(f);
    await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', r.params), /D6_SEND_STOPPED/);
    assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
  }
});
test('owner epoch changes invalidate the run before reservation', async () => {
  const f = fixture(), r = await f.ready(); f.store.changeEpoch();
  await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', r.params), /D6_SEND_STOPPED/);
  assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
});
for (const field of ['groupId','text','generation','sessionDigest','correlationId']) {
  test(`native final view mismatch freezes durable slot: ${field}`, async () => {
    const f = fixture(), r = await f.ready(); f.setAdapter(async (p, c) => {
      c.beforeNative({ ...f.view(p.message[0].data.text), [field]: field === 'generation' ? 2 : 'wrong' });
      f.store.events.push('native'); return f.receipt();
    });
    await stopped(f.gate.submit(r.permit, 'send_group_msg', r.params));
    assert.equal(f.store.status().state, 'frozen'); assert.equal(f.store.slots.length, 1);
    assert(!f.store.events.includes('native'));
  });
}
for (const mode of ['duplicateGuard','noGuard','throwAfterGuard','staleFinalProof','storeConfirmFailure','missingReceipt']) {
  test(`uncertain native/receipt/confirmation stops phase: ${mode}`, async () => {
    const f = fixture(), r = await f.ready();
    if (mode === 'storeConfirmFailure') f.store.confirm = () => { throw new Error('synthetic-private-detail'); };
    f.setAdapter(async (p, c) => {
      if (mode === 'noGuard') return f.receipt();
      c.beforeNative(f.view(p.message[0].data.text)); f.store.events.push('native');
      if (mode === 'duplicateGuard') { try { c.beforeNative(f.view(p.message[0].data.text)); } catch {} }
      if (mode === 'throwAfterGuard') throw new Error('synthetic-private-detail');
      if (mode === 'staleFinalProof') f.setProof({ online: false });
      if (mode === 'missingReceipt') return { result: 0 };
      return f.receipt();
    });
    await stopped(f.gate.submit(r.permit, 'send_group_msg', r.params));
    assert.equal(f.store.status().state, 'frozen');
    assert(f.store.events.filter(e => e === 'native').length <= 1);
    await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', r.params), /D6_PERMIT_DENIED/);
  });
}
for (const [field, value] of Object.entries({ groupId: '123456', bot: D6_SCOPE.tester, generation: 2,
  sessionDigest: '3'.repeat(64), correlationId: '102', finalMessageId: '100', message_id: 0, sendStatus: 0 })) {
  test(`receipt cannot substitute final confirmation: ${field}`, async () => {
    const f = fixture(), r = await f.ready(); f.setAdapter(async (p, c) => {
      c.beforeNative(f.view(p.message[0].data.text)); f.store.events.push('native');
      return { ...f.receipt(), [field]: value };
    });
    await stopped(f.gate.submit(r.permit, 'send_group_msg', r.params));
    assert.equal(f.store.status().state, 'frozen'); assert.equal(f.calls.length, 1);
  });
}
test('concurrent tools cannot double spend; cancellation revokes late final callback', async () => {
  const f = fixture(), r = await f.ready(); let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.setAdapter((p, c) => { entered(c); return new Promise(() => {}); });
  const controller = new AbortController();
  const first = f.gate.submit(r.permit, 'send_group_msg', r.params, { signal: controller.signal });
  const c = await waiting;
  await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', r.params), /D6_PERMIT_DENIED/);
  controller.abort(); await stopped(first);
  assert.throws(() => c.beforeNative(f.view(r.params.message[0].data.text)), /D6_NATIVE_GUARD_DENIED/);
  assert.equal(f.store.slots.length, 1); assert(!f.store.events.includes('native'));
});
test('timeout settles an adapter that never returns and freezes; no retry', async () => {
  const f = fixture(undefined, { timeoutMs: 20 }), r = await f.ready();
  f.setAdapter(() => new Promise(() => {}));
  await stopped(f.gate.submit(r.permit, 'send_group_msg', r.params));
  assert.equal(f.calls.length, 1); assert.equal(f.store.status().state, 'frozen');
});
test('final gate rechecks deadline after durable submission IO', async () => {
  const f = fixture(), r = await f.ready(), original = f.store.markSubmitted;
  f.store.markSubmitted = p => { const result = original(p); f.tick(30001); return result; };
  await stopped(f.gate.submit(r.permit, 'send_group_msg', r.params));
  assert(!f.store.events.includes('native')); assert.equal(f.store.status().state, 'frozen');
});
test('validated receipt is snapshotted before the final asynchronous identity probe', async () => {
  let f, resolveProof, entered, probes = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  f = fixture(undefined, { identityProbe: () => {
    if (++probes === 3) { entered(); return new Promise(resolve => { resolveProof = resolve; }); }
    return f.proof();
  } });
  const r = await f.ready(), observed = f.receipt();
  f.setAdapter(async (p, c) => { c.beforeNative(f.view(p.message[0].data.text)); return observed; });
  const pending = f.gate.submit(r.permit, 'send_group_msg', r.params);
  await waiting;
  observed.message_id = 999; observed.correlationId = '999'; observed.sendStatus = 0;
  resolveProof(f.proof());
  assert.deepEqual(await pending, { message_id: 200 });
  assert.equal(f.store.slots[0].state, 'confirmed'); f.gate.close();
});
test('close during a pending native adapter stays closed after asynchronous rejection', async () => {
  const f = fixture(), r = await f.ready(); let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.setAdapter((p, c) => { entered(c); return new Promise(() => {}); });
  const pending = f.gate.submit(r.permit, 'send_group_msg', r.params);
  const context = await waiting; f.gate.close(); await stopped(pending);
  assert.equal(f.gate.status().state, 'closed'); assert.equal(f.store.status().state, 'frozen');
  assert.equal(f.store.events.filter(e => e === 'unknown').length, 1);
  assert.throws(() => context.beforeNative(f.view(r.params.message[0].data.text)), /D6_NATIVE_GUARD_DENIED/);
  assert.equal(f.gate.status().state, 'closed');
});
test('payload proxies and hidden array symbols are rejected without running traps', async () => {
  const f = fixture(), r = await f.ready(); let traps = 0;
  const trap = () => { traps++; throw new Error('synthetic-private-detail'); };
  const proxy = new Proxy(r.params, { getPrototypeOf: trap, ownKeys: trap, get: trap });
  const arrayProxy = { ...r.params, message: new Proxy(r.params.message, { get: trap, ownKeys: trap }) };
  const hiddenSymbol = { ...r.params, message: Object.assign([...r.params.message], { [Symbol('x')]: true }) };
  for (const p of [proxy, arrayProxy, hiddenSymbol])
    await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', p), /^BridgeError: D6_/);
  assert.equal(traps, 0); assert.equal(f.store.slots.length, 0); assert.equal(f.calls.length, 0);
});
test('static pre-abort does not consume, while restart/cancel invalidates old permit', async () => {
  const f = fixture(), r = await f.ready(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', r.params, { signal: controller.signal }), /D6_CANCELLED/);
  assert.equal(f.store.slots.length, 0);
  f.gate.cancel();
  await assert.rejects(f.gate.submit(r.permit, 'send_group_msg', r.params), /D6_PERMIT_DENIED/);
  f.gate.close(); assert.deepEqual(f.gate.status(), { state: 'closed', deployed: false });
});
