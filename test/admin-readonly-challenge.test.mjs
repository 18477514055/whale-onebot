import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { InboundChallenge, isVerifiedProtectedChallenge } from '../src/host/inbound-challenge.mjs';
import { CalibrationControl } from '../src/host/calibration-control.mjs';
import { OneBotCore } from '../src/core.mjs';
import { ACTIONS } from '../src/actions.mjs';
import { openReadOnlySession, verifyReadOnlySession } from '../src/host/read-only-session.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

// All native sessions, accounts, messages and client traffic below are synthetic.
const ADMIN = OWNER_UIN;
const BOT = BOT_UIN;
const GROUP = '20001';
const OTHER_GROUP = '20002';
const TEXT = 'whale-check-' + 'a'.repeat(32);
const nativeMessage = (text, overrides = {}) => ({
  chatType: 2, senderUin: ADMIN, peerUid: GROUP, msgId: '90071992547409931', msgTime: '1700000000',
  elements: [{ elementType: 1, textElement: { content: text } }], ...overrides,
});
const event = (overrides = {}) => ({
  self_id: Number(BOT), time: 1700000000, post_type: 'message', message_type: 'group', sub_type: 'normal',
  group_id: Number(GROUP), user_id: Number(ADMIN), message_id: 1,
  raw_message: TEXT, message: [{ type: 'text', data: { text: TEXT } }],
  sender: { user_id: Number(ADMIN), nickname: 'Synthetic administrator' }, ...overrides,
});
function matchedChallenge({ readbackOnly = true, allowAdminChallenge = true, clock = () => 0 } = {}) {
  const inbound = new InboundChallenge(clock, { allowProtectedSender: true });
  const { text } = inbound.arm(1, GROUP, { readbackOnly, allowAdminChallenge });
  inbound.observe([nativeMessage(text)], 1);
  assert.equal(inbound.status(1).state, 'matched');
  const challenge = inbound.takeRecent(1, readbackOnly, allowAdminChallenge);
  assert(challenge, 'The explicitly opted-in administrator challenge must be consumable');
  return challenge;
}

test('admin readback requires both the host opt-in and the arm opt-in', () => {
  for (const allowProtectedSender of [false, true]) {
    for (const allowAdminChallenge of [false, true]) {
      const inbound = new InboundChallenge(() => 0, { allowProtectedSender });
      const { text } = inbound.arm(1, GROUP, { readbackOnly: true, allowAdminChallenge });
      inbound.observe([nativeMessage(text)], 1);
      const allowed = allowProtectedSender && allowAdminChallenge;
      assert.equal(inbound.status(1).state, allowed ? 'matched' : 'waiting',
        JSON.stringify({ allowProtectedSender, allowAdminChallenge }));
      assert.equal(inbound.canTakeRecent(1, true, true), allowed);
    }
  }
  const defaults = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = defaults.arm(1, GROUP, { readbackOnly: true });
  defaults.observe([nativeMessage(text)], 1);
  assert.equal(defaults.status(1).state, 'waiting');
});

test('admin challenge arm without readbackOnly throws before creating a challenge', () => {
  const inbound = new InboundChallenge(() => 0, { allowProtectedSender: true });
  assert.throws(() => inbound.arm(1, GROUP, { allowAdminChallenge: true }));
  assert.throws(() => inbound.arm(1, GROUP, { readbackOnly: false, allowAdminChallenge: true }));
  assert.equal(inbound.status(1).state, 'unarmed');
  assert.match(inbound.arm(1, GROUP, { readbackOnly: true, allowAdminChallenge: true }).text,
    /^whale-check-[a-f0-9]{32}$/);
});

test('admin readback matches only exact plain text, group, generation and a non-bot sender', () => {
  const inbound = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = inbound.arm(1, GROUP, { readbackOnly: true, allowAdminChallenge: true });
  assert.match(text, /^whale-check-[a-f0-9]{32}$/);
  inbound.observe([nativeMessage(text)], 2);
  for (const invalid of [
    nativeMessage(text, { chatType: 1 }), nativeMessage(text, { peerUid: OTHER_GROUP }),
    nativeMessage(text, { senderUin: BOT }), nativeMessage(text + ' '), nativeMessage(text.toUpperCase()),
    nativeMessage(text, { sendStatus: 1 }), nativeMessage(text, { msgId: '' }),
    nativeMessage(text, { elements: [{ elementType: 1, textElement: { content: text, atType: 2 } }] }),
    nativeMessage(text, { elements: [{ elementType: 2, picElement: { fileName: text } }] }),
  ]) {
    inbound.observe([invalid], 1);
    assert.equal(inbound.status(1).state, 'waiting');
  }
  inbound.observe([nativeMessage(text, { senderUin: Number(ADMIN), peerUid: Number(GROUP),
    elements: [text.slice(0, 13), text.slice(13)].map(content => ({ elementType: 1, textElement: { content } })) })], 1);
  assert.equal(inbound.status(1).state, 'matched');
  assert.equal(inbound.takeRecent(1, true, true).senderUin, ADMIN);
});

test('admin readback is branded, deeply frozen, detached from raw input and explicitly consumed once', () => {
  const inbound = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = inbound.arm(1, GROUP, { readbackOnly: true, allowAdminChallenge: true });
  const raw = nativeMessage(text);
  inbound.observe([raw], 1);
  raw.elements[0].textElement.content = 'changed after callback';
  assert.equal(isVerifiedProtectedChallenge(raw), false);
  for (const [generation, readbackOnly, allowAdminChallenge] of [[2, true, true], [1, false, true],
    [1, false, false], [1, true, false]]) {
    assert.equal(inbound.canTakeRecent(generation, readbackOnly, allowAdminChallenge), false);
    assert.equal(inbound.takeRecent(generation, readbackOnly, allowAdminChallenge), null);
  }
  assert.equal(inbound.takeRecent(1, true), null);
  assert.equal(inbound.status(1).consumed, false);
  const verified = inbound.takeRecent(1, true, true);
  assert.equal(verified.elements[0].textElement.content, text);
  assert.equal(isVerifiedProtectedChallenge(verified), true);
  for (const value of [verified, verified.elements, verified.elements[0], verified.elements[0].textElement])
    assert.equal(Object.isFrozen(value), true);
  for (const clone of [structuredClone(verified), JSON.parse(JSON.stringify(verified)), { ...verified }])
    assert.equal(isVerifiedProtectedChallenge(clone), false);
  assert.throws(() => { verified.peerUid = OTHER_GROUP; }, TypeError);
  assert.throws(() => { verified.elements[0].textElement.content = 'changed'; }, TypeError);
  assert.equal(inbound.canTakeRecent(1, true, true), false);
  assert.equal(inbound.takeRecent(1, true, true), null);
  assert.equal(inbound.status(1).consumed, true);
});

test('ordinary readback keeps its existing consumption path and does not acquire a protected brand', () => {
  const inbound = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = inbound.arm(1, GROUP, { readbackOnly: true, allowAdminChallenge: true });
  inbound.observe([nativeMessage(text, { senderUin: '10001' })], 1);
  assert.equal(inbound.takeRecent(1), null);
  assert.equal(inbound.canTakeRecent(1, true), true);
  const verified = inbound.takeRecent(1, true);
  assert.equal(verified.senderUin, '10001');
  assert.equal(isVerifiedProtectedChallenge(verified), false);
});

test('an administrator readback cannot be consumed after the freshness boundary', () => {
  let now = 100;
  const inbound = new InboundChallenge(() => now, { allowProtectedSender: true });
  const { text } = inbound.arm(1, GROUP, { readbackOnly: true, allowAdminChallenge: true });
  inbound.observe([nativeMessage(text)], 1);
  now += 29999;
  assert.equal(inbound.canTakeRecent(1, true, true), true);
  now++;
  assert.equal(inbound.canTakeRecent(1, true, true), false);
  assert.equal(inbound.takeRecent(1, true, true), null);
});

function command(control, params, extra = {}) {
  const snapshot = control.snapshot();
  return { runId: snapshot.runId, seq: snapshot.lastSeq + 1, command: 'arm_inbound_challenge', params,
    generation: snapshot.generation, authBinding: snapshot.authBinding, ...extra };
}
function controlFixture(t) {
  const calls = [];
  const control = new CalibrationControl({ runId: 'synthetic-admin-readback-control', operations: {
    arm_inbound_challenge(context) { calls.push(context); return { armed: true }; },
  } });
  t.after(() => control.close());
  const authenticate = () => control.bindAuthentication({ user_id: BOT,
    sessionId: 'synthetic-admin-readback-session', eventId: 'synthetic-admin-readback-event' });
  return { control, calls, authenticate };
}
const adminParams = () => ({ groupId: GROUP, readbackOnly: true, allowAdminChallenge: true });

test('calibration accepts the exact authenticated administrator readback parameters', async t => {
  const { control, calls, authenticate } = controlFixture(t);
  authenticate();
  const result = await control.execute(command(control, adminParams()));
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.data, { armed: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, adminParams());
  assert.equal(Object.isFrozen(calls[0].params), true);
  assert.equal(calls[0].authentication.user_id, BOT);
  assert.equal(result.onlineProof, false);
});

test('calibration administrator readback requires authentication and the current binding', async t => {
  const { control, calls, authenticate } = controlFixture(t);
  const request = command(control, adminParams());
  assert.equal((await control.execute(request)).code, 'AUTHENTICATION_REQUIRED');
  authenticate();
  assert.equal((await control.execute({ ...request, generation: control.snapshot().generation })).code,
    'STALE_AUTHENTICATION_BINDING');
  assert.equal(calls.length, 0);
  assert.equal(control.snapshot().lastSeq, 0);
  assert.equal((await control.execute(command(control, adminParams()))).status, 'completed');
  assert.equal(calls.length, 1);
});

test('calibration rejects false, mistyped, unknown and unsafe administrator arm combinations', async t => {
  const { control, calls, authenticate } = controlFixture(t);
  authenticate();
  for (const params of [
    { ...adminParams(), allowAdminChallenge: false }, { ...adminParams(), allowAdminChallenge: 'true' },
    { ...adminParams(), allowAdminChallenge: null }, { ...adminParams(), allowAdminChallenge: 1 },
    { groupId: GROUP, allowAdminChallenge: true }, { ...adminParams(), readbackOnly: false },
    { ...adminParams(), requireRoundtripMethods: true }, { ...adminParams(), requireRoundtripMethods: false },
    { ...adminParams(), unknown: true }, { ...adminParams(), groupId: OTHER_GROUP + 'x' },
  ]) {
    const result = await control.execute(command(control, params));
    assert.equal(result.accepted, false, JSON.stringify(params));
    assert.equal(result.code, 'INVALID_PARAMS', JSON.stringify(params));
    assert.equal(control.snapshot().lastSeq, 0);
  }
  assert.equal(calls.length, 0);
  assert.equal((await control.execute(command(control, adminParams()))).status, 'completed');
});

class CoreBridge extends EventEmitter {
  calls = [];
  capabilities() { return Object.keys(ACTIONS); }
  async probe() { return { user_id: Number(BOT), online: true, sessionId: 'synthetic-admin-core' }; }
  async call(action, params) { this.calls.push({ action, params }); return { group_id: Number(GROUP) }; }
}
async function coreFixture(t, options = {}) {
  const bridge = new CoreBridge();
  const core = new OneBotCore({ bridge, readOnly: true, readOnlyGroup: GROUP,
    readOnlyChallengeText: TEXT, ...options });
  t.after(() => core.close());
  assert.equal((await core.dispatch({ action: 'get_login_info' })).retcode, 0);
  const received = [];
  core.on('event', value => received.push(value));
  return { bridge, core, received };
}

test('core challenge text requires explicit read-only mode, group and a 32-hex nonce', () => {
  for (const options of [
    { readOnlyChallengeText: TEXT }, { readOnly: true, readOnlyChallengeText: TEXT },
    { readOnly: false, readOnlyGroup: GROUP, readOnlyChallengeText: TEXT },
    ...['', TEXT + ' ', 'whale-check-' + 'A'.repeat(32), 'whale-check-' + 'a'.repeat(31),
      'whale-check-' + 'a'.repeat(33), null, true, 1].map(readOnlyChallengeText =>
      ({ readOnly: true, readOnlyGroup: GROUP, readOnlyChallengeText })),
  ]) assert.throws(() => new OneBotCore(options), TypeError, JSON.stringify(options));
});

test('scoped core keeps administrator events blocked without a challenge exception', async t => {
  const { bridge, received } = await coreFixture(t, { readOnlyChallengeText: undefined });
  bridge.emit('event', event());
  assert.deepEqual(received, []);
});

test('scoped core ignores mismatches without spending its one administrator event', async t => {
  const { bridge, received } = await coreFixture(t);
  const invalid = [
    event({ raw_message: 'ordinary administrator message', message: [{ type: 'text', data: { text: 'ordinary administrator message' } }] }),
    event({ group_id: Number(OTHER_GROUP) }), event({ message_type: 'private', group_id: undefined }),
    event({ post_type: 'message_sent' }), event({ post_type: 'notice', notice_type: 'group_increase' }),
    event({ raw_message: TEXT + ' ' }), event({ message: [{ type: 'text', data: { text: TEXT + '!' } }] }),
    event({ message: [{ type: 'image', data: { file: 'synthetic.png' } }] }),
    event({ self_id: Number(ADMIN) }),
  ];
  invalid.forEach(value => bridge.emit('event', value));
  assert.deepEqual(received, []);
  bridge.emit('event', event({ message_id: 20 }));
  assert.equal(received.length, 1);
  assert.equal(received[0].user_id, Number(ADMIN));
  assert.equal(received[0].raw_message, TEXT);
  bridge.emit('event', event({ message_id: 21 }));
  assert.equal(received.length, 1, 'A second message id must not reopen the exception');
});

test('mutating a delivered core event clone cannot extend or reset its administrator exception', async t => {
  const { bridge, core, received } = await coreFixture(t);
  core.prependListener('event', value => {
    value.group_id = Number(OTHER_GROUP);
    value.raw_message = 'mutated subscriber copy';
    value.message[0].data.text = 'mutated subscriber text';
  });
  bridge.emit('event', event());
  assert.equal(received.length, 1);
  assert.equal(received[0].group_id, Number(GROUP));
  assert.equal(received[0].raw_message, TEXT);
  assert.equal(received[0].message[0].data.text, TEXT);
  bridge.emit('event', { ...structuredClone(received[0]), message_id: 2 });
  bridge.emit('event', event({ group_id: Number(OTHER_GROUP), message_id: 3 }));
  assert.equal(received.length, 1);
});

test('the administrator event exception grants no writes or main-account query rights', async t => {
  const { bridge, core, received } = await coreFixture(t);
  bridge.emit('event', event());
  assert.equal(received.length, 1);
  const quick = core.prepareQuickOperation(received[0]);
  assert.equal(typeof quick, 'function');
  assert.equal(quick({ reply: 'must not send' }).accepted, false);
  for (const action of Object.keys(ACTIONS).filter(name => ACTIONS[name].mutates)) {
    for (const suffix of ['', '_async', '_rate_limited']) {
      const result = await core.dispatch({ action: action + suffix, params: { group_id: Number(GROUP), user_id: Number(ADMIN) } });
      assert.equal(result.retcode, 1403, action + suffix);
    }
  }
  for (const [action, params] of [
    ['get_group_member_info', { group_id: Number(GROUP), user_id: Number(ADMIN) }],
    ['get_stranger_info', { user_id: Number(ADMIN) }], ['get_friend_list', {}],
    ['get_group_info', { group_id: Number(OTHER_GROUP) }],
    ['get_group_msg_history', { group_id: Number(OTHER_GROUP) }],
  ]) {
    for (const suffix of ['', '_async', '_rate_limited'])
      assert.equal((await core.dispatch({ action: action + suffix, params })).retcode, 1403, action + suffix);
  }
  assert.equal(bridge.calls.length, 0, 'No forbidden request may reach even the synthetic adapter');
  assert.equal((await core.dispatch({ action: 'get_group_info', params: { group_id: Number(GROUP) } })).retcode, 0);
  assert.equal(bridge.calls.length, 1);
});

function sessionFixture(t) {
  const tmp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const parent = fs.mkdtempSync(path.join(tmp, 'admin-readonly-challenge-'));
  const projectRoot = path.join(parent, 'qq-onebot');
  fs.mkdirSync(projectRoot);
  let messageListener, groupListener, added = 0, removed = 0;
  const nativeCalls = { sendMsg: 0, generateMsgUniqueId: 0, getMsgsByMsgId: 0,
    getAioFirstViewLatestMsgs: 0, getMsgs: 0, getGroupDetailInfo: 0 };
  const forbiddenNative = name => () => {
    nativeCalls[name]++;
    throw new Error('Unexpected synthetic read-only native call: ' + name);
  };
  const closers = [];
  const groupService = {
    addKernelGroupListener(value) { groupListener = value; return 2; },
    removeKernelGroupListener() {},
    getGroupDetailInfo(code) {
      nativeCalls.getGroupDetailInfo++;
      queueMicrotask(() => groupListener.onGroupDetailInfoChange({ groupCode: code,
        groupName: 'Synthetic administrator test group', memberNum: 2, maxMemberNum: 100 }));
      return { result: 0 };
    },
  };
  const session = { getMsgService: () => ({
    addKernelMsgListener(value) { messageListener = value; added++; return 1; },
    removeKernelMsgListener() { removed++; },
    sendMsg: forbiddenNative('sendMsg'),
    generateMsgUniqueId: forbiddenNative('generateMsgUniqueId'),
    getMsgsByMsgId: forbiddenNative('getMsgsByMsgId'),
    getAioFirstViewLatestMsgs: forbiddenNative('getAioFirstViewLatestMsgs'),
    getMsgs: forbiddenNative('getMsgs'),
  }), getGroupService: () => groupService };
  t.after(async () => {
    try { for (const close of closers.reverse()) await close(); }
    finally {
      // Resolve and prove the precise project-owned cleanup target before deleting.
      const resolved = fs.realpathSync(parent);
      assert.equal(path.dirname(resolved), fs.realpathSync(tmp));
      assert.equal(path.basename(resolved).startsWith('admin-readonly-challenge-'), true);
      assert.equal(fs.lstatSync(parent).isSymbolicLink(), false);
      fs.rmSync(resolved, { recursive: true, force: true });
      assert.equal(fs.existsSync(parent), false);
      for (const name of ['sendMsg', 'generateMsgUniqueId', 'getMsgsByMsgId', 'getAioFirstViewLatestMsgs', 'getMsgs'])
        assert.equal(nativeCalls[name], 0, 'The available native method must never run: ' + name);
    }
  });
  return { projectRoot, session, signal: AbortSignal.timeout(15000), nativeCalls: () => ({ ...nativeCalls }),
    identityProbe: async () => ({ user_id: Number(BOT), online: true, sessionId: 'synthetic-admin-session' }),
    emit: message => messageListener.onRecvMsg([message]), closers,
    counts: () => ({ added, removed }) };
}
async function watchEndpoint(endpoint, token, fixture) {
  const ws = new WebSocket('ws://127.0.0.1:' + endpoint.wsPort + '/', { headers: { Authorization: 'Bearer ' + token } });
  ws.on('error', () => {});
  fixture.closers.push(() => ws.terminate());
  const events = [];
  ws.on('message', bytes => { const value = JSON.parse(bytes.toString()); if (value.post_type === 'message') events.push(value); });
  await once(ws, 'open', { signal: fixture.signal });
  const call = async (action, params = {}) => {
    const response = await fetch('http://127.0.0.1:' + endpoint.port + '/' + action, { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: fixture.signal });
    return response.json();
  };
  assert.equal((await call('get_login_info')).data.user_id, Number(BOT));
  return { ws, events, call };
}

test('read-only session forwards only the verified native administrator object, once', { timeout: 15000 }, async t => {
  const fixture = sessionFixture(t);
  const challenge = matchedChallenge();
  const token = 'synthetic-admin-session-token';
  const endpoint = await openReadOnlySession({ ...fixture, group: GROUP, token, challenge });
  fixture.closers.push(() => endpoint.close());
  const { ws, events, call } = await watchEndpoint(endpoint, token, fixture);
  for (const message of [structuredClone(challenge), nativeMessage('ordinary administrator text'),
    { ...structuredClone(challenge), peerUid: OTHER_GROUP }]) {
    fixture.emit(message);
  }
  await delay(100);
  assert.deepEqual(events, []);
  const delivered = once(ws, 'message', { signal: fixture.signal });
  endpoint.replayChallenge(challenge);
  await delivered;
  await delay(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, Number(ADMIN));
  assert.equal(events[0].group_id, Number(GROUP));
  assert.equal(events[0].raw_message, challenge.elements[0].textElement.content);
  try { endpoint.replayChallenge(challenge); } catch { /* Explicit one-shot rejection is also fail-closed. */ }
  fixture.emit(structuredClone(challenge));
  await delay(100);
  assert.equal(events.length, 1);
  assert.equal((await call('send_group_msg', { group_id: Number(GROUP), message: 'must not send' })).retcode, 1403);
  assert.equal((await call('get_group_member_info', { group_id: Number(GROUP), user_id: Number(ADMIN) })).retcode, 1403);
  assert.equal((await call('get_msg', { message_id: events[0].message_id })).retcode, 1403);
  assert.equal((await call('get_group_msg_history', { group_id: Number(OTHER_GROUP) })).retcode, 1403);
  await endpoint.close();
  assert.equal(endpoint.active(), false);
  assert.deepEqual(fixture.counts(), { added: 1, removed: 1 });
});

test('a branded administrator challenge lease cannot be reused across closed sessions', { timeout: 15000 }, async t => {
  const fixture = sessionFixture(t);
  const challenge = matchedChallenge();
  const token = 'synthetic-single-lease-admin-token';
  const originalFork = childProcess.fork;
  let forks = 0;
  // Observe the actual protocol-child creation, not a mocked session opener.
  childProcess.fork = function (...args) { forks++; return Reflect.apply(originalFork, this, args); };
  syncBuiltinESMExports();
  try {
    await assert.rejects(openReadOnlySession({ ...fixture, group: OTHER_GROUP, token, challenge }),
      { name: 'TypeError' });
    assert.equal(forks, 0, 'A cross-group error must precede process creation');
    assert.deepEqual(fixture.counts(), { added: 0, removed: 0 });

    // The previous cross-group rejection must not consume the valid group lease.
    const endpoint = await openReadOnlySession({ ...fixture, group: GROUP, token, challenge });
    fixture.closers.push(() => endpoint.close());
    assert.equal(forks, 1);
    const { ws, events } = await watchEndpoint(endpoint, token, fixture);
    const delivered = once(ws, 'message', { signal: fixture.signal });
    endpoint.replayChallenge(challenge);
    await delivered;
    assert.equal(events.length, 1);
    assert.equal(events[0].raw_message, challenge.elements[0].textElement.content);
    await endpoint.close();
    assert.equal(endpoint.active(), false);
    assert.deepEqual(fixture.counts(), { added: 1, removed: 1 });
    for (const port of [endpoint.port, endpoint.wsPort])
      await assert.rejects(fetch('http://127.0.0.1:' + port + '/get_status', { signal: AbortSignal.timeout(1000) }));

    await assert.rejects(openReadOnlySession({ ...fixture, group: GROUP, token, challenge }),
      { name: 'TypeError', message: /already.*leased/i });
    assert.equal(forks, 1, 'A reused object must be rejected before spawning a second protocol child');
    assert.deepEqual(fixture.counts(), { added: 1, removed: 1 },
      'Reusing a consumed lease must not register another native listener');
  } finally {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  }
});

for (const scenario of ['unbranded clone', 'different group']) {
  test('read-only session gives no administrator exception to ' + scenario, { timeout: 15000 }, async t => {
    const fixture = sessionFixture(t);
    const verified = matchedChallenge();
    const challenge = scenario === 'unbranded clone' ? structuredClone(verified) : verified;
    const token = 'synthetic-rejected-admin-token';
    let endpoint;
    try { endpoint = await openReadOnlySession({ ...fixture, group: scenario === 'different group' ? OTHER_GROUP : GROUP,
      token, challenge }); }
    catch (error) { assert(error instanceof Error); return; }
    fixture.closers.push(() => endpoint.close());
    const { events } = await watchEndpoint(endpoint, token, fixture);
    try { endpoint.replayChallenge(challenge); } catch { /* No permission is granted by opening a session. */ }
    fixture.emit(challenge);
    await delay(100);
    assert.deepEqual(events, []);
  });
}

test('read-only verifier proves the administrator event through an authenticated ordinary WebSocket', { timeout: 15000 }, async t => {
  const fixture = sessionFixture(t);
  const result = await verifyReadOnlySession({ ...fixture, group: GROUP, challenge: matchedChallenge() });
  assert.deepEqual(result, { authenticatedLoopback: true, readOnly: true, groupScoped: true,
    groupInfoVerified: true, webSocketVerified: true, challengeEventVerified: true });
  assert.deepEqual(fixture.nativeCalls(), { sendMsg: 0, generateMsgUniqueId: 0, getMsgsByMsgId: 0,
    getAioFirstViewLatestMsgs: 0, getMsgs: 0, getGroupDetailInfo: 1 });
  assert.deepEqual(fixture.counts(), { added: 1, removed: 1 });
});

test('read-only verifier proves matching traffic using a test AgentClient over real loopback', { timeout: 15000 }, async t => {
  const fixture = sessionFixture(t);
  let connections = 0, calls = 0, messages = 0, closed = 0;
  class TestAgentClient {
    constructor(options) { this.options = options; fixture.closers.push(() => this.socket?.terminate()); }
    async call(action, params, _timeoutMs, signal) {
      calls++;
      const response = await fetch(this.options.httpUrl + '/' + action, { method: 'POST',
        headers: { Authorization: 'Bearer ' + this.options.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(params), signal });
      const result = await response.json();
      assert.equal(result.retcode, 0);
      return result.data;
    }
    async connect() {
      connections++;
      this.socket = new WebSocket(this.options.wsUrl, { headers: { Authorization: 'Bearer ' + this.options.accessToken } });
      this.socket.on('error', () => {});
      this.socket.on('message', bytes => {
        const value = JSON.parse(bytes.toString());
        if (value.post_type === 'message') { messages++; this.options.onEvent(value); }
      });
      await once(this.socket, 'open', { signal: fixture.signal });
      this.selfId = String((await this.call('get_login_info', {}, 2000, fixture.signal)).user_id);
    }
    close() { closed++; this.socket?.terminate(); }
  }
  const result = await verifyReadOnlySession({ ...fixture, group: GROUP, challenge: matchedChallenge(), AgentClient: TestAgentClient });
  assert.deepEqual(result, { authenticatedLoopback: true, readOnly: true, groupScoped: true,
    groupInfoVerified: true, webSocketVerified: true, challengeEventVerified: true, agentClientVerified: true });
  assert.deepEqual({ connections, calls, messages, closed }, { connections: 1, calls: 2, messages: 1, closed: 1 });
  assert.deepEqual(fixture.nativeCalls(), { sendMsg: 0, generateMsgUniqueId: 0, getMsgsByMsgId: 0,
    getAioFirstViewLatestMsgs: 0, getMsgs: 0, getGroupDetailInfo: 2 });
  assert.deepEqual(fixture.counts(), { added: 1, removed: 1 });
});
