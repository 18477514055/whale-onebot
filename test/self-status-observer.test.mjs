import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { SelfStatusObserver } from '../src/host/self-status-observer.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const UID = 'u_synthetic_observer';
const frame = overrides => ({ uin: BOT_UIN, uid: UID, status: 10, extStatus: 0, batteryStatus: 0, offlineType: 0, activeState: 0, ...overrides });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 1000; i++) { if (check()) return; await turn(); } throw new Error('Synthetic callback did not start'); }
function fixture(t, options = {}) {
  const calls = [];
  const state = { sessionId: 'synthetic-native-session', now: 100, get: () => ({ result: 0 }), remove: () => undefined, listener: null };
  const profileService = {
    addKernelProfileListener(listener) { calls.push(['add']); state.listener = listener; return 42; },
    removeKernelProfileListener(handle) { calls.push(['remove', handle]); return state.remove(); },
    getSelfStatus(...args) { calls.push(['get', args]); return state.get(); },
  };
  const observer = new SelfStatusObserver({ profileService, session: { getSessionId: () => state.sessionId }, expectedUid: UID, timeoutMs: 100, clock: () => state.now, ...options });
  t.after(() => observer.close());
  const emit = value => state.listener.onSelfStatusChanged(value ?? frame());
  return { observer, state, calls, emit, profileService };
}

test('constructor is inert, attach is deduplicated and cleanup removes the exact listener once', async t => {
  const f = fixture(t); assert.deepEqual(f.calls, []);
  assert.equal(f.observer.attach().state, 'attached'); f.observer.attach();
  assert.deepEqual(f.calls, [['add']]);
  const snapshot = f.observer.snapshot(); assert.equal(snapshot.onlineProof, false);
  assert.equal('uid' in snapshot, false); assert.equal('sessionId' in snapshot, false);
  await f.observer.close(); await f.observer.close();
  assert.deepEqual(f.calls, [['add'], ['remove', 42]]);
  assert.throws(() => f.observer.attach(), { code: 'OBSERVER_REVOKED' });
});

test('zero-argument ACK plus new native identity frame yields client observation without online proof', async t => {
  const f = fixture(t, { readContext: () => ({ registered: true, transportState: 3, ignoredSecret: 'MUST-NOT-ESCAPE' }) });
  f.observer.attach();
  f.state.get = () => { f.state.now = 110; f.emit(); f.state.now = 115; return { result: 0, unknownTicket: 'MUST-NOT-ESCAPE' }; };
  const result = await f.observer.observe();
  assert.deepEqual(f.calls.filter(c => c[0] === 'get'), [['get', []]]);
  assert.deepEqual(result, { kind: 'native-client-observation', source: 'ProfileService.onSelfStatusChanged', epoch: 1,
    uin: BOT_UIN, uidMatchesExpected: true, status: 10, extStatus: 0, batteryStatus: 0, offlineType: 0, activeState: 0,
    observedAtMonotonicMs: 110, queryStartedAtMonotonicMs: 100, ageMs: 5, onlineProof: false, serverFreshnessVerified: false, queryCausalityVerified: false,
    context: { source: 'injected-native-context-getter', registered: true, transportState: 3 } });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(UID), false); assert.equal(serialized.includes(f.state.sessionId), false);
  assert.equal(serialized.includes('MUST-NOT-ESCAPE'), false);
});

test('a callback before actual native invocation cannot satisfy a query queued in the same turn', async t => {
  const f = fixture(t); f.observer.attach();
  f.emit(frame({ status: 11 }));
  const query = f.observer.observe();
  f.emit(frame({ status: 12 })); // observe() exists, but the native call has not begun.
  await until(() => f.calls.some(c => c[0] === 'get'));
  let settled = false; query.then(() => { settled = true; }); await turn();
  assert.equal(settled, false);
  f.state.now = 120; f.emit(frame({ status: 13 }));
  assert.equal((await query).status, 13);
});

test('callback and ACK are separate completion requirements in either order', async t => {
  for (const order of ['callback-first', 'ack-first']) {
    const f = fixture(t), ack = deferred(); f.observer.attach(); f.state.get = () => ack.promise;
    const query = f.observer.observe(); let settled = false; query.then(() => { settled = true; });
    await until(() => f.calls.some(c => c[0] === 'get'));
    if (order === 'callback-first') f.emit(); else ack.resolve({ result: 0 });
    await turn(); assert.equal(settled, false);
    if (order === 'callback-first') ack.resolve({ result: 0 }); else f.emit();
    assert.equal((await query).kind, 'native-client-observation');
  }
});

test('a good identity frame never turns rejected, missing or accessor ACK into success', async t => {
  let getters = 0;
  const getterAck = {}; Object.defineProperty(getterAck, 'result', { get() { getters++; return 0; } });
  for (const ack of [{ result: 1 }, { result: '0' }, {}, getterAck]) {
    const f = fixture(t); f.observer.attach(); f.state.get = () => { f.emit(); return ack; };
    await assert.rejects(f.observer.observe(), error => ['ACK_REJECTED', 'INVALID_NATIVE_FRAME'].includes(error.code));
    assert.equal(f.observer.snapshot().state, 'invalidated');
  }
  assert.equal(getters, 0);
});

test('only one native read can be in flight and successful sequential reads require new callbacks', async t => {
  const f = fixture(t); f.observer.attach();
  const first = f.observer.observe(); await until(() => f.calls.some(c => c[0] === 'get'));
  await assert.rejects(f.observer.observe(), { code: 'BUSY' });
  f.emit(); await first;
  f.state.now = 200;
  const second = f.observer.observe(); let settled = false; second.then(() => { settled = true; });
  await until(() => f.calls.filter(c => c[0] === 'get').length === 2); await turn();
  assert.equal(settled, false); f.emit(frame({ extStatus: 2003 }));
  assert.equal((await second).extStatus, 2003);
  assert.equal(f.calls.filter(c => c[0] === 'add').length, 1);
});

test('account or native UID mismatch revokes the observer even outside a pending query', async t => {
  for (const wrong of [frame({ uin: OWNER_UIN }), frame({ uid: 'u_wrong' })]) {
    const f = fixture(t); f.observer.attach(); f.emit(wrong);
    await assert.rejects(f.observer.observe(), { code: 'OBSERVER_REVOKED' });
    assert.equal(f.calls.some(c => c[0] === 'get'), false);
    assert.equal(f.observer.snapshot().state, 'invalidated');
  }
});

test('session changes before invocation, during callbacks or during async context prevent results', async t => {
  for (const phase of ['before-query', 'callback', 'context']) {
    const context = deferred();
    const f = fixture(t, phase === 'context' ? { readContext: () => context.promise } : {});
    f.observer.attach();
    if (phase === 'before-query') {
      f.state.sessionId = 'different'; await assert.rejects(f.observer.observe(), { code: 'SESSION_CHANGED' });
      assert.equal(f.calls.some(c => c[0] === 'get'), false); continue;
    }
    const query = f.observer.observe(); const rejected = assert.rejects(query, { code: 'SESSION_CHANGED' });
    await until(() => f.calls.some(c => c[0] === 'get'));
    if (phase === 'callback') { f.state.sessionId = 'different'; f.emit(); }
    else { f.emit(); await turn(); f.state.sessionId = 'different'; context.resolve({ registered: true }); }
    await rejected;
  }
});

test('timeout with no frame or no ACK revokes permanently and late results cannot satisfy another query', async t => {
  for (const missing of ['frame', 'ack']) {
    const f = fixture(t, { timeoutMs: 15 }), ack = deferred(); f.observer.attach();
    if (missing === 'ack') f.state.get = () => { f.emit(); return ack.promise; };
    await assert.rejects(f.observer.observe(), { code: 'TIMEOUT' });
    f.emit(); ack.resolve({ result: 0 }); await turn();
    await assert.rejects(f.observer.observe(), { code: 'OBSERVER_REVOKED' });
    assert.throws(() => f.observer.attach(), { code: 'OBSERVER_REVOKED' });
    assert.equal(f.calls.filter(c => c[0] === 'get').length, 1);
    assert.equal(f.observer.snapshot().stats.completed, 0);
  }
});

test('abort before query starts does not invoke native, while active abort removes listener and rejects late callback', async t => {
  const before = fixture(t); before.observer.attach(); const already = new AbortController(); already.abort();
  await assert.rejects(before.observer.observe({ signal: already.signal }), { code: 'CANCELLED' });
  assert.equal(before.calls.some(c => c[0] === 'get'), false); assert.equal(before.observer.snapshot().state, 'attached');
  const active = fixture(t); active.observer.attach(); const controller = new AbortController();
  const query = active.observer.observe({ signal: controller.signal }); const rejected = assert.rejects(query, { code: 'CANCELLED' });
  await until(() => active.calls.some(c => c[0] === 'get')); controller.abort(); await rejected;
  active.emit(); await active.observer.close();
  assert.equal(active.observer.snapshot().stats.completed, 0);
  assert.equal(active.calls.filter(c => c[0] === 'remove').length, 1);
});

test('disconnect invalidation and close revoke in-flight work and retained old listeners cannot revive state', async t => {
  for (const action of ['invalidate', 'close']) {
    const f = fixture(t); f.observer.attach(); const oldListener = f.state.listener;
    const query = f.observer.observe(); const rejected = assert.rejects(query, { code: action === 'close' ? 'CLOSED' : 'DISCONNECTED' });
    await until(() => f.calls.some(c => c[0] === 'get')); await f.observer[action](); await rejected;
    oldListener.onSelfStatusChanged(frame()); await turn();
    assert.equal(f.observer.snapshot().stats.completed, 0); assert.equal(f.calls.filter(c => c[0] === 'remove').length, 1);
  }
});

test('async context read is within total deadline and late context never restores a timed-out observation', async t => {
  const context = deferred(); let signal;
  const f = fixture(t, { timeoutMs: 15, readContext: input => { signal = input.signal; return context.promise; } }); f.observer.attach();
  f.state.get = () => { f.emit(); return { result: 0 }; };
  await assert.rejects(f.observer.observe(), { code: 'TIMEOUT' }); assert.equal(signal.aborted, true);
  context.resolve({ registered: true, transportState: 3 }); await turn();
  assert.equal(f.observer.snapshot().stats.completed, 0);
});

test('malformed frames and selected context fields are rejected without reading unrelated secret getters', async t => {
  let getters = 0;
  const value = frame(); Object.defineProperty(value, 'unusedCredential', { get() { getters++; return 'SECRET'; } });
  const f = fixture(t, { readContext: () => { const x = { registered: false, transportState: 0 }; Object.defineProperty(x, 'secret', { get() { getters++; return 'SECRET'; } }); return x; } });
  f.observer.attach(); f.state.get = () => { f.emit(value); return { result: 0 }; };
  assert.equal((await f.observer.observe()).context.registered, false); assert.equal(getters, 0);
  for (const invalidFrame of [frame({ status: '10' }), frame({ extStatus: NaN }), frame({ activeState: undefined })]) {
    const bad = fixture(t); bad.observer.attach(); bad.state.get = () => { bad.emit(invalidFrame); return { result: 0 }; };
    await assert.rejects(bad.observer.observe(), { code: 'INVALID_NATIVE_FRAME' });
  }
  const selectedGetter = frame(); Object.defineProperty(selectedGetter, 'status', { get() { getters++; return 10; } });
  const bad = fixture(t); bad.observer.attach(); bad.state.get = () => { bad.emit(selectedGetter); return { result: 0 }; };
  await assert.rejects(bad.observer.observe(), { code: 'INVALID_NATIVE_FRAME' }); assert.equal(getters, 0);
});

test('native and context failures are sanitized; cleanup failure is explicit without retries', async t => {
  const query = fixture(t); query.observer.attach(); query.state.get = () => { throw new Error('SECRET-TICKET'); };
  await assert.rejects(query.observer.observe(), error => error.code === 'QUERY_FAILED' && !error.message.includes('SECRET'));
  const context = fixture(t, { readContext: () => { throw new Error('SECRET-CONTEXT'); } }); context.observer.attach();
  context.state.get = () => { context.emit(); return { result: 0 }; };
  await assert.rejects(context.observer.observe(), error => error.code === 'CONTEXT_UNAVAILABLE' && !error.message.includes('SECRET'));
  const cleanup = fixture(t, { timeoutMs: 15 }); cleanup.observer.attach(); cleanup.state.remove = () => new Promise(() => {});
  const closed = await cleanup.observer.close(); assert.equal(closed.cleanupIncomplete, true);
  await cleanup.observer.close(); assert.equal(cleanup.calls.filter(c => c[0] === 'remove').length, 1);
});

test('clock rollback cannot manufacture a negative-age or pre-query observation', async t => {
  const f = fixture(t); f.observer.attach();
  f.state.get = () => { f.state.now = 99; f.emit(); return { result: 0 }; };
  await assert.rejects(f.observer.observe(), { code: 'CLOCK_REGRESSED' });
  assert.equal(f.observer.snapshot().stats.completed, 0);
});
