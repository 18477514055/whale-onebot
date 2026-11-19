import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { NativeBridge, BridgeError } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { IPCBridge, serveBridgeIPC } from '../src/host/bridge-ipc.mjs';
import { startOneBotProcess } from '../src/host/onebot-process.mjs';
import { createSessionService, createOneBotService } from '../src/service.mjs';
import { OutcomeStore } from '../src/outcome-store.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = Number(BOT_UIN);
const POLICY = 'native-session';
const proof = (extra = {}) => ({ user_id: BOT, uid: 'u_synthetic_bot', sessionId: 'synthetic-session',
  authenticated: true, sessionAuthorized: true, online: false, online_known: false, ...extra });
const readyStatus = (extra = {}) => ({ online: true, good: true, service_ready: true,
  session_authorized: true, write_ready: true, online_known: true, platform_state: 'unknown',
  lastUnknownAction: null, lastUnknownLatching: false, ...extra });
const turn = () => new Promise(resolve => setImmediate(resolve));
const signal = () => new AbortController().signal;
const event = (id = 1) => ({ self_id: BOT, post_type: 'message', message_type: 'group', group_id: 20001,
  user_id: 10001, message_id: id, message: [{ type: 'text', data: { text: 'synthetic' } }], raw_message: 'synthetic' });
const request = { action: 'send_group_msg', params: { group_id: 20001, message: 'synthetic' } };

function nativeFixture(t, options = {}) {
  let current = proof();
  let sessionId = current.sessionId;
  let listener;
  let removals = 0;
  const msg = { addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() { removals++; } };
  const session = { getSessionId: () => sessionId, getMsgService: () => msg };
  const bridge = new NativeBridge({ session, identityProbe: async () => current, ...options });
  t.after(() => bridge.detach());
  return { bridge, msg, session, get listener() { return listener; }, get removals() { return removals; },
    update(value) { current = value; }, changeSession(value) { sessionId = value; } };
}
class Fixture extends EventEmitter {
  identity = proof();
  calls = [];
  capabilities() { return ['get_login_info', 'send_group_msg', 'get_group_list']; }
  async probe() { return this.identity; }
  async call(action, params) { this.calls.push({ action, params }); return action === 'get_group_list' ? [] : { message_id: 11 }; }
}
function coreFixture(t, options = {}) {
  const bridge = new Fixture();
  const core = new OneBotCore({ bridge, minimumWriteIntervalMs: 0, ...options });
  t.after(() => core.close());
  return { bridge, core };
}
function tempRoot(t, cleanup = () => {}) {
  const base = path.resolve('.tmp');
  fs.mkdirSync(base, { recursive: true });
  const parent = fs.mkdtempSync(path.join(base, 'native-session-test-'));
  const root = path.join(parent, 'qq-onebot');
  fs.mkdirSync(root);
  t.after(async () => {
    await cleanup();
    const absolute = fs.realpathSync(parent);
    assert.equal(path.dirname(absolute), fs.realpathSync(base));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return root;
}

// The boolean authorization fields are a trusted-host contract. These fixtures do
// not constitute native authentication evidence, a current UID getter or QQ proof.
test('default NativeBridge refuses self-reported session authorization and keeps strict output unchanged', async t => {
  const f = nativeFixture(t);
  await assert.rejects(f.bridge.attach(), { code: 'IDENTITY_REJECTED' });
  f.update(proof({ online: true, authorizationPolicy: POLICY }));
  const value = await f.bridge.attach();
  assert.deepEqual(value, { user_id: BOT, nickname: '', online: true, sessionId: 'synthetic-session', uid: 'u_synthetic_bot' });
});

test('explicit NativeBridge mode permits SDK access with unknown online without inventing true', async t => {
  const f = nativeFixture(t, { authorizationPolicy: POLICY });
  const value = await f.bridge.attach();
  assert.equal(value.online, false);
  assert.equal(value.online_known, false);
  assert.equal(value.platform_state, 'unknown');
  assert.equal(value.sessionAuthorized, true);
  assert.equal((await f.bridge.call('get_login_info')).user_id, BOT);
  const incoming = once(f.bridge, 'event', { signal: AbortSignal.timeout(1000) });
  f.listener.onRecvMsg([{ chatType: 2, peerUid: '20001', senderUin: '10001', msgId: '123456', msgTime: '1700000000',
    elements: [{ elementType: 1, textElement: { content: 'synthetic' } }] }]);
  assert.equal((await incoming)[0].group_id, 20001);
});

test('native-session NativeBridge and Core confirm one actual synthetic SDK send while online stays unknown', async t => {
  const f = nativeFixture(t, { authorizationPolicy: POLICY });
  let submissions = 0;
  f.msg.generateMsgUniqueId = () => '12345678';
  f.msg.sendMsg = (_first, peer, elements) => {
    submissions++;
    f.listener.onMsgInfoListUpdate([{ ...peer, elements, senderUin: String(BOT), senderUid: 'u_synthetic_bot',
      msgId: '12345679', sendStatus: 2, msgTime: '1700000000' }]);
    return { result: 0 };
  };
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge, authorizationPolicy: POLICY, minimumWriteIntervalMs: 0 });
  t.after(() => core.close());
  const result = await core.dispatch(request);
  assert.equal(result.retcode, 0);
  assert(Number.isSafeInteger(result.data.message_id));
  assert.equal(submissions, 1);
  assert.deepEqual(core.status(), readyStatus());
});

test('NativeBridge new policy rejects absent/wrong authentication, UID and BOT instead of treating online as authority', async t => {
  for (const extra of [{ authenticated: false }, { sessionAuthorized: false }, { uid: undefined }, { uid: 'invalid' },
    { user_id: Number(OWNER_UIN) }, { sessionId: '' }, { online_known: true, online: undefined }]) {
    const f = nativeFixture(t, { authorizationPolicy: POLICY });
    f.update(proof({ online: true, ...extra }));
    await assert.rejects(f.bridge.attach(), { code: 'IDENTITY_REJECTED' });
    assert.equal(f.bridge.attached, false);
  }
});

test('NativeBridge rejects changed actual session ID and changed retained UID, revoking listeners', async t => {
  for (const change of [f => f.changeSession('other'), f => f.update(proof({ uid: 'u_other' }))]) {
    const f = nativeFixture(t, { authorizationPolicy: POLICY });
    await f.bridge.attach();
    change(f);
    await assert.rejects(f.bridge.probe());
    assert.equal(f.bridge.attached, false);
    assert.equal(f.removals, 1);
  }
});

test('native-session policy rechecks at SDK invocation after asynchronous preparation', async t => {
  const f = nativeFixture(t, { authorizationPolicy: POLICY });
  let calls = 0;
  f.msg.generateMsgUniqueId = () => '12345678';
  f.msg.sendMsg = () => { calls++; return { result: 0 }; };
  await f.bridge.attach();
  f.bridge.elements = async () => { f.changeSession('replaced-during-prepare'); return [{ elementType: 1, textElement: { content: 'synthetic' } }]; };
  await assert.rejects(f.bridge.call('send_group_msg', request.params));
  assert.equal(calls, 0);
  assert.equal(f.bridge.attached, false);
});

test('native-session policy does not remove protected MAIN receive or mention guards', async t => {
  const f = nativeFixture(t, { authorizationPolicy: POLICY });
  await f.bridge.attach();
  let events = 0;
  f.bridge.on('event', () => events++);
  f.listener.onRecvMsg([{ chatType: 2, peerUid: '20001', senderUin: OWNER_UIN, msgId: '123456', msgTime: '1700000000',
    elements: [{ elementType: 1, textElement: { content: 'synthetic' } }] }]);
  await turn();
  assert.equal(events, 0);
  await assert.rejects(f.bridge.elements([{ type: 'at', data: { qq: OWNER_UIN } }], { chatType: 2, peerUid: '20001' }, false, {}),
    { code: 'PROTECTED_ACCOUNT' });
});

test('Core default refuses public request/proof policy downgrade and retains exact legacy status', async t => {
  const { core, bridge } = coreFixture(t);
  bridge.identity.authorizationPolicy = POLICY;
  assert.notEqual((await core.dispatch({ ...request, authorizationPolicy: POLICY })).retcode, 0);
  assert.equal(bridge.calls.length, 0);
  assert.deepEqual(core.status(), { online: false, good: false });
  bridge.identity.online = true;
  assert.equal((await core.dispatch(request)).retcode, 0);
  assert.deepEqual(core.status(), { online: true, good: true });
});

test('Core native session readiness, action advertisement and ingress do not depend on a 30-second human window', async t => {
  let now = 0;
  const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY, clock: () => now, proofMaxAgeMs: 30,
    statusFromBackground: true });
  assert(await core.refreshIdentity(signal()));
  assert.deepEqual(core.status(), readyStatus());
  assert((await core.dispatch({ action: 'get_supported_actions' })).data.includes('send_group_msg'));
  now += 3600000;
  assert.deepEqual((await core.dispatch({ action: 'get_status' })).data, readyStatus());
  let received = 0;
  core.on('event', () => received++);
  bridge.emit('event', event());
  assert.equal(received, 1);
  assert.equal((await core.dispatch(request)).retcode, 0);
  bridge.emit('offline');
  assert.deepEqual(core.status(), readyStatus({ online: false, online_known: false, good: false, service_ready: false, session_authorized: false, write_ready: false }));
  bridge.emit('event', event(2));
  assert.equal(received, 1);
});

test('Core native mode requires authentication flags and consistent BOT/UID/session', async t => {
  for (const extra of [{ authenticated: false }, { sessionAuthorized: false }, { uid: '' }, { user_id: Number(OWNER_UIN) }, { sessionId: '' }]) {
    const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY });
    bridge.identity = proof(extra);
    assert.equal(await core.refreshIdentity(signal()), null);
    assert.equal(core.status().service_ready, false);
  }
  for (const extra of [{ uid: 'u_changed' }, { sessionId: 'changed' }]) {
    const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY });
    assert(await core.refreshIdentity(signal()));
    bridge.identity = proof(extra);
    assert.equal(await core.refreshIdentity(signal()), null);
    assert.equal(core.status().session_authorized, false);
  }
});

test('Core telemetry knownness is separate from SDK authorization and stale telemetry becomes unknown', async t => {
  let now = 0;
  const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY, clock: () => now, proofMaxAgeMs: 20 });
  bridge.identity = proof({ online: true }); // Uncalibrated true is not published.
  assert(await core.refreshIdentity(signal()));
  assert.deepEqual(core.status(), readyStatus());
  bridge.identity = proof({ online: true, online_known: true });
  assert(await core.refreshIdentity(signal()));
  assert.deepEqual(core.status(), readyStatus({ online: true, online_known: true, platform_state: 'online' }));
  now = 20;
  assert.deepEqual(core.status(), readyStatus());
  bridge.identity = proof({ online: false, online_known: true });
  assert(await core.refreshIdentity(signal()));
  assert.deepEqual(core.status(), readyStatus({ online_known: true, platform_state: 'offline' }));
});

test('unknown submitted write keeps durable latch and native ingress/reads available, never retries', async t => {
  let store;
  const projectRoot = tempRoot(t, () => store?.close());
  store = new OutcomeStore(projectRoot);
  t.after(() => store.close());
  const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY, outcomeStore: store });
  const original = bridge.call.bind(bridge);
  bridge.call = async (action, params) => {
    if (action !== 'send_group_msg') return original(action, params);
    bridge.calls.push({ action, params });
    throw new BridgeError('SYNTHETIC_UNKNOWN', 'synthetic', { retcode: 1502, outcome: 'unknown' });
  };
  // P4：发送未知 ⇒ 按已接受回成功（message_id:null），不留未决记录、不关闸。
  const acceptedUnknown = await core.dispatch(request);
  assert.equal(acceptedUnknown.retcode, 0);
  assert.equal(acceptedUnknown.data.message_id, null);
  assert.equal(store.pending, false);
  assert.deepEqual(core.status(), readyStatus({ write_ready: true,
    lastUnknownAction: 'send_group_msg', lastUnknownLatching: true }));
  let received = 0;
  core.on('event', () => received++);
  bridge.emit('event', event());
  assert.equal(received, 1);
  assert.equal((await core.dispatch({ action: 'get_group_list' })).retcode, 0);
  assert.equal((await core.dispatch(request)).retcode, 0, 'P4：第二次发送不被闩锁挡住');
  assert.equal(bridge.calls.filter(x => x.action === 'send_group_msg').length, 2);
  assert((await core.dispatch({ action: 'get_supported_actions' })).data.includes('send_group_msg'));
  assert.equal(fs.existsSync(store.file), false, '没有未决记录要人工对账');
});

test('submitted timeout without native invalidation preserves native monitoring, but revocation still wins', async t => {
  const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY, timeoutMs: 20 });
  const pending = Promise.withResolvers();
  bridge.call = async action => {
    bridge.calls.push({ action });
    return action === 'send_group_msg' ? pending.promise : [];
  };
  // P4：发送超时 ⇒ 按已接受回成功（message_id:null），会话保持可用。
  const timedOutSend = await core.dispatch(request);
  assert.equal(timedOutSend.retcode, 0);
  assert.equal(timedOutSend.data.message_id, null);
  assert.deepEqual(core.status(), readyStatus({ write_ready: true,
    lastUnknownAction: 'send_group_msg', lastUnknownLatching: true }));
  assert.equal((await core.dispatch({ action: 'get_group_list' })).retcode, 0);
  assert.equal((await core.dispatch(request)).retcode, 0);
  pending.resolve({ message_id: 11 });
  await turn();
  assert.equal(core.status().write_ready, true); // 外发优先：迟到的成功不再需要人工解锁
  bridge.emit('offline');
  assert.equal(core.status().service_ready, false);
});

test('ordinary read and rejected-write errors do not revoke native authorization', async t => {
  const { core, bridge } = coreFixture(t, { authorizationPolicy: POLICY });
  bridge.call = async action => { throw new BridgeError('SYNTHETIC_REJECTION', 'synthetic',
    { retcode: action === 'send_group_msg' ? 1500 : 1403, outcome: 'rejected' }); };
  assert.equal((await core.dispatch(request)).retcode, 1500);
  assert.equal((await core.dispatch({ action: 'get_group_list' })).retcode, 1403);
  assert.deepEqual(core.status(), readyStatus());
});

function channelPair() {
  const left = new EventEmitter(), right = new EventEmitter();
  for (const [from, to] of [[left, right], [right, left]]) {
    from.connected = true;
    from.sent = [];
    from.send = (message, done = () => {}) => {
      from.sent.push(message);
      queueMicrotask(() => { if (from.connected && to.connected) to.emit('message', structuredClone(message)); done(); });
    };
    from.disconnect = () => {
      if (!from.connected) return;
      left.connected = right.connected = false;
      left.emit('disconnect'); right.emit('disconnect');
    };
  }
  return [left, right];
}

test('IPC default rejects bridge self-reported policy; native policy only comes from private constructor', async t => {
  const bridge = new Fixture();
  bridge.identity.authorizationPolicy = POLICY;
  const [server, client] = channelPair();
  const serving = serveBridgeIPC(server, bridge);
  const ipc = new IPCBridge(client);
  t.after(() => { ipc.close(); serving.close(); });
  await assert.rejects(ipc.probe(), { code: 'BRIDGE_IPC_UNAVAILABLE' });
  assert.deepEqual(ipc.capabilities(), []);
});

test('IPC native mode waits for Core commit then releases first buffered event in the same generation', async t => {
  const bridge = new Fixture();
  const [server, client] = channelPair();
  const serving = serveBridgeIPC(server, bridge);
  const ipc = new IPCBridge(client, { authorizationPolicy: POLICY, requireIdentityCommit: true });
  const core = new OneBotCore({ bridge: ipc, authorizationPolicy: POLICY });
  t.after(() => { core.close(); ipc.close(); serving.close(); });
  const observed = [];
  core.on('event', value => observed.push(value.message_id));
  const value = await ipc.probe();
  bridge.emit('event', event(1));
  await turn();
  assert.deepEqual(observed, []);
  assert.equal(client.sent.filter(x => x.type === 'events-ready').length, 0);
  // Wrong UID cannot commit the already accepted session.
  ipc.identityAccepted({ ...value, uid: 'u_wrong' });
  await turn();
  assert.deepEqual(observed, []);
  assert(await core.refreshIdentity(signal()));
  await turn();
  assert.deepEqual(observed, [1]);
  assert.deepEqual(core.status(), readyStatus());
  assert(client.sent.some(x => x.type === 'events-ready' && x.generation === 0));
  bridge.emit('offline');
  bridge.emit('event', event(2));
  await turn();
  assert.equal(core.status().service_ready, false);
  assert.deepEqual(observed, [1]);
});

test('IPC native policy rejects changed UID/session in the same generation', async t => {
  for (const extra of [{ uid: 'u_other' }, { sessionId: 'other-session' }, { sessionAuthorized: false }]) {
    const bridge = new Fixture();
    const [server, client] = channelPair();
    const serving = serveBridgeIPC(server, bridge);
    const ipc = new IPCBridge(client, { authorizationPolicy: POLICY });
    t.after(() => { ipc.close(); serving.close(); });
    await ipc.probe();
    bridge.identity = proof(extra);
    await assert.rejects(ipc.probe());
    assert.deepEqual(ipc.capabilities(), []);
  }
});

test('service composes native policy without detaching unknown-online owned bridge', async t => {
  const f = nativeFixture(t, { authorizationPolicy: POLICY });
  let app;
  app = await createSessionService({ projectRoot: tempRoot(t, () => app?.close()), token: 'synthetic-native-session-token',
    port: 0, authorizationPolicy: POLICY, session: f.session, identityProbe: async () => proof(),
    timeoutMs: 500, proofMaxAgeMs: 100, verifyEveryMs: 10 });
  t.after(() => app.close());
  assert.deepEqual(app.core.status(), readyStatus());
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(app.bridge.attached, true);
  const response = await fetch('http://127.0.0.1:' + app.address.port + '/get_status',
    { headers: { Authorization: 'Bearer synthetic-native-session-token' } });
  assert.deepEqual((await response.json()).data, readyStatus());
  await app.close();
});

test('real fork private child startup carries native policy while public API cannot change default', async t => {
  const bridge = new Fixture();
  let child, strict;
  const projectRoot = tempRoot(t, async () => { await child?.close(); await strict?.close(); });
  child = await startOneBotProcess(bridge, { projectRoot, token: 'synthetic-private-native-token', port: 0,
    authorizationPolicy: POLICY, verifyEveryMs: 20, proofMaxAgeMs: 1000 });
  t.after(() => child.close());
  const status = await fetch('http://127.0.0.1:' + child.port + '/get_status',
    { headers: { Authorization: 'Bearer synthetic-private-native-token' } });
  assert.deepEqual((await status.json()).data, readyStatus());
  await child.close();
  strict = await createOneBotService({ bridge: new Fixture(), projectRoot, port: 0,
    token: 'synthetic-strict-default-token', startOffline: true, verifyEveryMs: 20, proofMaxAgeMs: 1000 });
  t.after(() => strict.close());
  const rejected = await strict.core.dispatch({ ...request, authorizationPolicy: POLICY,
    params: { ...request.params, authorizationPolicy: POLICY } });
  assert.notEqual(rejected.retcode, 0);
  assert.deepEqual(strict.core.status(), { online: false, good: false });
  await strict.close();
});

test('invalid constructor policies are rejected rather than silently selecting weaker semantics', async t => {
  assert.throws(() => new NativeBridge({ session: {}, identityProbe: async () => proof(), authorizationPolicy: 'other' }));
  assert.throws(() => new OneBotCore({ bridge: new Fixture(), authorizationPolicy: 'other' }));
  const [channel] = channelPair();
  assert.throws(() => new IPCBridge(channel, { authorizationPolicy: 'other' }));
  await assert.rejects(createOneBotService({ authorizationPolicy: 'other', bridge: new Fixture(),
    projectRoot: tempRoot(t), token: 'synthetic-invalid-policy-token', port: 0 }));
});
