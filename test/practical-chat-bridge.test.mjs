import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import { createPracticalChatBridge } from '../src/host/practical-chat-bridge.mjs';
import { serveBridgeIPC, IPCBridge } from '../src/host/bridge-ipc.mjs';
import { EventEmitter } from 'node:events';
import { BOT_UIN, OWNER_UIN, TEST_GROUP } from '../src/config/account.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BOT = BOT_UIN, GROUP = TEST_GROUP, MAIN = OWNER_UIN;
const phaseSeed = () => ({ phaseId: 'd6-live-agent-2026-11-15', bot: BOT, group: GROUP,
  tester: MAIN, limit: 3, count: 0, pending: false, frozen: false });

function fixture(t, { phase: initial = phaseSeed(), sendMode = 'confirmed' } = {}) {
  // All values, messages, services and JSON files are NEW synthetic fixtures.
  // The adapter under test still creates the real production NativeBridge.
  const directory = fs.mkdtempSync(path.join(ROOT, '.tmp', 'practical-chat-synthetic-'));
  const phaseFile = path.join(directory, 'phase.json');
  fs.writeFileSync(phaseFile, JSON.stringify(initial));
  const phase = () => JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
  let msgListener, groupListener, removed = 0, current = true, sessionId = 'synthetic-session';
  let nextRequest = 90071992547400000n, nextMessage = 91071992547400000n;
  const calls = [], updates = [], unknown = [], diagnostics = [], sent = new Map();
  const raw = (overrides = {}) => ({ msgId: String(nextMessage++), msgSeq: '1',
    msgTime: String(Math.floor(Date.now() / 1000)), chatType: 2, peerUid: GROUP,
    senderUid: 'u_synthetic_main', senderUin: MAIN, sendNickName: 'Synthetic tester',
    elements: [{ elementType: 1, textElement: { content: 'ordinary synthetic hello' } }], ...overrides });
  const msg = {
    addKernelMsgListener(listener) { msgListener = listener; return 11; },
    removeKernelMsgListener(handle) { assert.equal(handle, 11); removed++; },
    generateMsgUniqueId() { return String(nextRequest++); },
    sendMsg(...args) {
      assert.equal(this, msg, 'native method keeps its real receiver');
      // Budget/pending must already be durable AT the final native call.
      calls.push({ args, phase: phase() });
      if (sendMode === 'throw') throw new Error('synthetic native fault');
      const receipt = raw({ msgId: String(nextMessage++), senderUin: BOT, senderUid: 'u_synthetic_bot',
        guildId: args[1].guildId, sendStatus: 2, elements: args[2] });
      sent.set(receipt.msgId, receipt);
      queueMicrotask(() => msgListener.onMsgInfoListUpdate([receipt]));
      return { result: 0 };
    },
    getMsgsByMsgId(peer, ids) {
      assert.equal(peer.peerUid, GROUP);
      return { result: 0, msgList: ids.map(id => sent.get(id)).filter(Boolean) };
    },
  };
  const group = {
    addKernelGroupListener(listener) { groupListener = listener; return 12; },
    removeKernelGroupListener(handle) { assert.equal(handle, 12); },
    getGroupDetailInfo(code) {
      queueMicrotask(() => groupListener.onGroupDetailInfoChange({ groupCode: code,
        groupName: 'Synthetic group', memberNum: 2, maxMemberNum: 10 }));
      return { result: 0 };
    },
    getAllMemberList() {
      return { errCode: 0, result: { infos: new Map([['u_synthetic_bot',
        { uin: BOT, uid: 'u_synthetic_bot', nick: 'Synthetic BOT', role: 2 }]]), finish: true } };
    },
  };
  const session = { getSessionId() { return sessionId; }, getMsgService() { return msg; }, getGroupService() { return group; } };
  const options = { session, identity: { user_id: BOT, uid: 'u_synthetic_bot', sessionId },
    isCurrent: () => current, authObservedAt: Date.now(), phaseFile,
    onUpdate: event => updates.push(event), onUnknown: event => unknown.push(event),
    onDiagnostics: event => diagnostics.push(event) };
  const bridge = createPracticalChatBridge(options);
  t.after(() => { bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { bridge, options, phase, phaseFile, calls, updates, unknown, diagnostics, raw, msg,
    receive(list) { msgListener.onRecvMsg(list); }, get removed() { return removed; },
    setCurrent(value) { current = value; }, setSessionId(value) { sessionId = value; } };
}

async function settle() { await tick(); await tick(); }

function ipcPair() {
  const host = new EventEmitter(), child = new EventEmitter();
  host.connected = child.connected = true;
  host.send = (message, callback) => { queueMicrotask(() => child.emit('message', message)); callback?.(); };
  child.send = (message, callback) => { queueMicrotask(() => host.emit('message', message)); callback?.(); };
  return { host, child };
}

test('actual NativeBridge translates ordinary MAIN ingress and confirms marked native text/get_msg', async t => {
  const f = fixture(t), events = [];
  f.bridge.on('event', event => events.push(event));
  await f.bridge.attach();
  assert.equal((await f.bridge.probe()).online, true);
  f.bridge.beginManualChat();
  const future = f.raw({ msgTime: String(Math.floor(Date.now() / 1000) + 3600),
    unrelatedNativeBuffer: Buffer.from([1, 2]), unrelatedNativeCounter: 1n });
  future.elements[0].textElement.unrelatedNativeBuffer = Buffer.from([3]);
  const nativeTimestamp = future.msgTime;
  const receiptSeconds = Math.floor(Date.now() / 1000);
  f.receive([future, f.raw({ senderUin: '100001', senderUid: 'u_synthetic_other' })]);
  assert.equal((await f.bridge.probe()).online, true);
  await settle();
  assert.equal(future.msgTime, nativeTimestamp, 'the native SDK object is never modified');
  assert(events[0].time >= receiptSeconds && events[0].time <= Math.floor(Date.now() / 1000), 'OneBot envelope uses observed receipt time, not the remote future clock');
  assert.equal(events.length, 1, 'non-MAIN group messages never reach the App, including during fresh QR reachability');
  const inbound = f.updates.filter(event => event.stage === 'inbound-observed');
  assert.deepEqual(inbound, [{ stage: 'inbound-observed', phaseId: 'd6-live-agent-2026-11-15',
    count: 0, pending: false, frozen: false, remaining: 3 }]);
  assert.equal(events[0].user_id, Number(MAIN));
  assert.equal(events[0].group_id, Number(GROUP));
  assert.equal(events[0].raw_message, 'ordinary synthetic hello');
  assert.deepEqual(f.bridge.capabilities(), ['get_login_info', 'send_group_msg', 'get_msg', 'get_group_info', 'get_group_member_info']);
  assert.equal((await f.bridge.call('get_group_info', { group_id: GROUP })).group_name, 'Synthetic group');
  assert.equal((await f.bridge.call('get_group_member_info', { group_id: GROUP, user_id: BOT })).user_id, Number(BOT));
  const result = await f.bridge.call('send_group_msg', { group_id: GROUP, message: 'synthetic reply' });
  assert(Number.isSafeInteger(result.message_id));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[0], '0');
  assert.equal(f.calls[0].args[1].peerUid, GROUP);
  assert.deepEqual(f.calls[0].args[2], [{ elementType: 1, textElement: { content: '[Linux试跑] synthetic reply' } }]);
  assert.equal(f.calls[0].phase.count, 1);
  assert.equal(f.calls[0].phase.pending, true);
  assert.equal(f.phase().pending, false);
  const readback = await f.bridge.call('get_msg', { message_id: result.message_id });
  assert.equal(readback.raw_message, '&#91;Linux试跑&#93; synthetic reply');
  assert.equal(readback.message[0].data.text, '[Linux试跑] synthetic reply');
  assert(f.updates.some(event => event.stage === 'confirmed'));
  assert.equal(f.unknown.length, 0);
});

test('three durable slots across reopen, no fourth native invocation and one owner only', async t => {
  const f = fixture(t);
  assert.throws(() => createPracticalChatBridge(f.options), { code: 'PHASE_OWNED' });
  await f.bridge.attach();
  for (let count = 1; count <= 3; count++) {
    await f.bridge.call('send_group_msg', { group_id: GROUP, message: `synthetic ${count}` });
    assert.deepEqual(f.phase(), { ...phaseSeed(), count });
  }
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message: 'fourth' }), { code: 'SEND_BLOCKED' });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => call.phase.count), [1, 2, 3]);
  f.bridge.close();
  assert.equal(fs.existsSync(f.phaseFile + '.owner'), false);
  const reopened = createPracticalChatBridge(f.options);
  t.after(() => reopened.close());
  await reopened.attach();
  await assert.rejects(reopened.call('send_group_msg', { group_id: GROUP, message: 'no refund on reopen' }), { code: 'SEND_BLOCKED' });
  reopened.close();
});

test('post-native uncertainty freezes pending durably, and reopening cannot refund or retry', async t => {
  const f = fixture(t, { sendMode: 'throw' });
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message: 'synthetic fault' }),
    { code: 'SEND_FROZEN', outcome: 'unknown' });
  assert.deepEqual(f.phase(), { ...phaseSeed(), count: 1, pending: true, frozen: true });
  assert.equal(f.unknown.length, 1);
  assert.equal(f.unknown[0].code, 'NATIVE_OUTCOME_UNCERTAIN');
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message: 'no retry' }), { code: 'SEND_BLOCKED' });
  assert.equal(f.calls.length, 1);
  f.bridge.close();
  const reopened = createPracticalChatBridge(f.options);
  await reopened.attach();
  await assert.rejects(reopened.call('send_group_msg', { group_id: GROUP, message: 'still no retry' }), { code: 'SEND_BLOCKED' });
  reopened.close();
});

test('pre-created pending is frozen; missing authorization is not silently created', async t => {
  const f = fixture(t, { phase: { ...phaseSeed(), count: 1, pending: true } });
  assert.equal(f.phase().frozen, true);
  assert.equal(f.unknown[0].code, 'PENDING_ON_OPEN');
  const missing = path.join(path.dirname(f.phaseFile), 'missing.json');
  assert.throws(() => createPracticalChatBridge({ ...f.options, phaseFile: missing }), { code: 'PHASE_REQUIRED' });
  assert.equal(fs.existsSync(missing), false);
  assert.equal(fs.existsSync(missing + '.owner'), false);
});

test('wrong group, aliases, async/history/friends, non-BOT queries and nonplain sends never consume a slot', async t => {
  const f = fixture(t);
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: '100001', message: 'wrong group' }), { code: 'GROUP_BLOCKED' });
  for (const action of ['send_msg', 'send_message', 'send_group_msg_async', 'get_group_msg_history', 'get_friend_list'])
    await assert.rejects(f.bridge.call(action, { group_id: GROUP, message: 'no' }), { code: 'ACTION_BLOCKED' });
  await assert.rejects(f.bridge.call('get_group_member_info', { group_id: GROUP, user_id: MAIN }), { code: 'MEMBER_BLOCKED' });
  await assert.rejects(f.bridge.call('get_msg', { message_id: 1 }), { code: 'MESSAGE_BLOCKED' });
  for (const message of ['[CQ:at,qq=all]', [{ type: 'at', data: { qq: MAIN } }],
    [{ type: 'reply', data: { id: '1' } }], [{ type: 'image', data: { file: 'synthetic.png' } }]])
    await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message }), { code: 'PLAIN_TEXT_REQUIRED' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
});

test('expired facade keeps real listener; new MAIN receive -> bridge-ready -> successful IPC probe -> FIFO original events', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), order = [], received = [];
  let readyCount = 0;
  const pair = ipcPair();
  const server = serveBridgeIPC(pair.host, f.bridge), client = new IPCBridge(pair.child);
  t.after(() => { client.close(); server.close(); });
  f.bridge.on('bridge-ready', () => order.push('ready'));
  client.on('bridge-ready', () => { readyCount++; });
  client.on('event', event => { order.push('event'); received.push(event); });
  await f.bridge.attach();
  await client.probe();
  f.bridge.beginManualChat();
  await settle();
  now += 31000;
  assert.equal((await f.bridge.probe()).online, false);
  await assert.rejects(client.probe());
  assert.equal(f.bridge.attached, true);
  assert.equal(f.removed, 0);
  const beforeRecoveryReady = readyCount;
  const fresh = f.raw(), second = f.raw({ elements: [{ elementType: 1, textElement: { content: 'second synthetic message' } }] });
  f.receive([fresh, second]);
  await settle();
  assert.equal(received.length, 0, 'buffer does not publish before protocol proof succeeds');
  assert.equal(order.at(-1), 'ready');
  assert.equal(readyCount, beforeRecoveryReady + 1, 'IPC receives the recoverable bridge-ready notification');
  assert.equal((await client.probe()).online, true);
  order.push('proof');
  await settle();
  assert.deepEqual(order.slice(-4), ['ready', 'proof', 'event', 'event']);
  assert.deepEqual(received.map(event => event.raw_message), ['ordinary synthetic hello', 'second synthetic message']);
  assert.equal(f.removed, 0);
  now += 31000;
  f.receive([fresh]); // duplicate/old native receive cannot keep the bridge online.
  assert.equal((await f.bridge.probe()).online, false);
  f.receive([f.raw({ peerUid: '100001' }), f.raw({ senderUin: '100001' })]);
  assert.equal((await f.bridge.probe()).online, false);
  f.setSessionId('synthetic-replaced-session');
  f.receive([f.raw()]);
  assert.equal((await f.bridge.probe()).online, false);
  assert.equal(f.calls.length, 0);
});

test('prefilter diagnostics distinguish callback, envelope, numeric peer and clock rejection without bodies or IDs', async t => {
  const f = fixture(t);
  await f.bridge.attach();
  assert.equal(f.diagnostics.at(-1).listenerOwners, 1);
  assert.equal(f.diagnostics.at(-1).handleUsable, true);
  f.receive({ notAList: 'DO_NOT_REPORT_BODY' });
  assert.equal(f.diagnostics.at(-1).receiveCallbacks, 1);
  assert.equal(f.diagnostics.at(-1).rejectedBatches, 1);
  f.receive([f.raw({ peerUid: Number(GROUP) })]);
  assert.equal(f.diagnostics.at(-1).lastShape.coercedGroupMatch, true);
  assert.equal(f.diagnostics.at(-1).lastShape.strictGroupMatch, false);
  f.receive([f.raw({ msgTime: String(Math.floor(Date.now() / 1000) + 60) })]);
  assert.equal(f.diagnostics.at(-1).lastShape.nativeTimeBand, 'future');
  assert.equal(f.diagnostics.at(-1).lastMainShape.rejectionReason, 'before-chat-ready');
  f.receive([f.raw({ msgTime: String(Date.now()) })]);
  const scoped = f.diagnostics.at(-1).lastMainShape;
  assert.equal(scoped.msgTimeDigits, 13);
  assert.equal(scoped.secondsInterpretation, 'future');
  assert.equal(scoped.millisecondsInterpretation, 'fresh');
  f.receive([f.raw({ peerUid: '100001', senderUin: '100001' })]);
  assert.deepEqual(f.diagnostics.at(-1).lastMainShape, scoped, 'unrelated traffic cannot overwrite tested MAIN diagnostics');
  f.receive([f.raw({ msgId: 'DO_NOT_REPORT_ID', elements: [] })]);
  assert.equal(f.diagnostics.at(-1).lastShape.decimalId, false);
  assert.equal(f.diagnostics.at(-1).lastShape.elementCount, 0);
  assert.equal(f.diagnostics.at(-1).freshMainCandidates, 0);
  assert.doesNotThrow(() => f.receive([{ chatType: 1, peerUid: { toString() { throw Error('SYNTHETIC_DIAGNOSTIC_COERCION'); } } }]));
  assert.equal(f.diagnostics.at(-1).observationErrors, 1, 'metadata failures cannot escape the native callback');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
  const report = JSON.stringify(f.diagnostics);
  for (const forbidden of ['DO_NOT_REPORT_BODY', 'DO_NOT_REPORT_ID', 'ordinary synthetic hello', GROUP, MAIN])
    assert.equal(report.includes(forbidden), false);
  f.bridge.close();
  assert.equal(f.diagnostics.at(-1).listenerOwners, 0);
});

test('startup MAIN input never enters App; replay after ready cannot renew receipt proof', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), events = [];
  f.bridge.on('event', event => events.push(event));
  await f.bridge.attach();
  await f.bridge.probe();
  const startup = f.raw({ msgTime: String(Math.floor(now / 1000) + 7200) });
  f.receive([startup]);
  await settle();
  assert.equal(events.length, 0);
  f.bridge.beginManualChat();
  assert.equal((await f.bridge.probe()).online, false, 'QR proof does not enable manual sends after ready');
  f.receive([startup]);
  assert.equal((await f.bridge.probe()).online, false, 'startup replay never becomes new human receipt');
  f.receive([f.raw({ msgTime: String(Math.floor(now / 1000) + 7200) })]);
  assert.equal((await f.bridge.probe()).online, true);
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].time, Math.floor(now / 1000));
  now += 31000;
  f.bridge.beginManualChat();
  assert.equal((await f.bridge.probe()).online, false, 'rearming is idempotent, not a lease renewal');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
});

test('MAIN identity memory never evicts startup IDs; fixed-capacity overflow disables reachability', async t => {
  const f = fixture(t);
  await f.bridge.attach();
  const first = f.raw();
  f.receive([first]);
  for (let remaining = 9999; remaining > 0;) {
    const size = Math.min(remaining, 500);
    f.receive(Array.from({ length: size }, () => f.raw()));
    remaining -= size;
  }
  assert.equal(f.diagnostics.at(-1).rememberedIds, 10000);
  f.bridge.beginManualChat();
  f.receive([first]);
  assert.equal((await f.bridge.probe()).online, false);
  f.receive([f.raw()]);
  assert.equal(f.diagnostics.at(-1).receiveOverflow, true);
  assert.equal(f.diagnostics.at(-1).rememberedIds, 10000);
  assert.equal((await f.bridge.probe()).online, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
});

test('native accessor/copy failure cannot escape or renew the receipt window', async t => {
  const f = fixture(t);
  await f.bridge.attach();
  f.bridge.beginManualChat();
  let getterCalls = 0;
  const malformed = f.raw();
  Object.defineProperty(malformed, 'sendNickName', { enumerable: true, get() { getterCalls++; throw Error('SYNTHETIC_NATIVE_GETTER'); } });
  assert.doesNotThrow(() => f.receive([malformed]));
  assert.equal(getterCalls, 0, 'top-level getter is rejected without evaluation');
  assert.equal(f.diagnostics.at(-1).copyFailures, 1);
  assert.equal((await f.bridge.probe()).online, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
});

test('unusable native listener handle fails attachment once, never reports attached or retries', async t => {
  const f = fixture(t);
  let registrations = 0;
  f.msg.addKernelMsgListener = () => { registrations++; return undefined; };
  await assert.rejects(f.bridge.attach());
  assert.equal(registrations, 1);
  await assert.rejects(f.bridge.attach());
  assert.equal(registrations, 1, 'even an explicit second attach cannot repeat uncertain native registration');
  assert.equal(f.bridge.attached, false);
  assert.equal(f.diagnostics.at(-1).handleUsable, false);
  assert.equal(f.diagnostics.at(-1).listenerOwners, 1, 'uncertain native acceptance keeps the exact callback owner');
  assert.equal(f.updates.some(event => event.stage === 'attached'), false);
  assert.deepEqual(f.phase(), phaseSeed());
});

test('exact native wrapper remains owned when the SDK fixture retains only a WeakRef', async t => {
  const directory = fs.mkdtempSync(path.join(ROOT, '.tmp', 'practical-chat-weak-owner-'));
  const phaseFile = path.join(directory, 'phase.json');
  fs.writeFileSync(phaseFile, JSON.stringify(phaseSeed()));
  let weak;
  const snapshots = [];
  const msg = { addKernelMsgListener(listener) { weak = new WeakRef(listener); return 15; },
    removeKernelMsgListener(handle) { assert.equal(handle, 15); } };
  const session = { getSessionId: () => 'synthetic-weak-owner', getMsgService: () => msg };
  const bridge = createPracticalChatBridge({ session,
    identity: { user_id: BOT, uid: 'u_synthetic_bot', sessionId: 'synthetic-weak-owner' },
    authObservedAt: Date.now(), isCurrent: () => true, phaseFile, onDiagnostics: value => snapshots.push(value) });
  t.after(() => { bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await bridge.attach();
  for (let i = 0; i < 3; i++) { await tick(); global.gc?.(); }
  assert.equal(typeof weak.deref()?.onRecvMsg, 'function');
  assert.equal(snapshots.at(-1).listenerOwners, 1);
  bridge.close();
  assert.equal(snapshots.at(-1).listenerOwners, 0);
});

test('final native proxy rechecks shouldSubmit/current without charging a cancelled send', async t => {
  const f = fixture(t);
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message: 'cancel before submission' },
    { shouldSubmit: () => false }), { outcome: 'not_started' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
  f.msg.generateMsgUniqueId = () => {
    f.setCurrent(false); // after raw.call's proof, immediately before final sendMsg proxy.
    return '90071992547499999';
  };
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message: 'changed at final point' }),
    { code: 'REACHABILITY_EXPIRED', outcome: 'not_started' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.phase(), phaseSeed());
  assert.equal((await f.bridge.probe()).online, false);
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: GROUP, message: 'not current' }), { code: 'REACHABILITY_EXPIRED' });
  assert.equal(f.removed, 0);
});
