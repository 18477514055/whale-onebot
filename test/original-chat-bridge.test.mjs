import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalChatBridge } from '../src/host/original-chat-bridge.mjs';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { IPCBridge } from '../src/host/bridge-ipc.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN, MAIN = OWNER_UIN;
const identity = { user_id: BOT, uid: 'u_bot', sessionId: 'synthetic-original' };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function message(id, extra = {}) {
  return { chatType: 2, peerUid: '20001', senderUin: MAIN, senderUid: 'u_main', msgId: String(id), msgSeq: String(id),
    msgTime: '4102444800', elements: [{ elementType: 1, textElement: { content: 'synthetic' } }], ...extra };
}
function fixture(t, { handle = 1, weak = false, registrationThrows = false } = {}) {
  let listener, current = true, sid = identity.sessionId, sequence = 800;
  const raw = new Map(), sent = [], updates = [], diagnostics = [], unknown = [];
  let adds = 0, removes = 0, hints = 0, reads = 0;
  const listenerOf = () => weak ? listener?.deref() : listener;
  const msg = {
    addKernelMsgListener(value) { adds++; listener = weak ? new WeakRef(value) : value; if (registrationThrows) throw Error('synthetic'); return handle; },
    removeKernelMsgListener(value) { assert.equal(value, handle); removes++; },
    generateMsgUniqueId() { return String(++sequence); },
    sendMsg(_first, peer, elements) {
      sent.push({ peer, elements });
      listenerOf().onMsgInfoListUpdate([message(++sequence, { ...peer, elements, senderUin: BOT, senderUid: identity.uid, sendStatus: 2 })]);
      return { result: 0 };
    },
    getMsgsByMsgId(peer, ids) { return { result: 0, msgList: ids.map(id => raw.get(id)).filter(Boolean), metadata: 9n }; },
    getAioFirstViewLatestMsgs(peer) {
      return { result: 0, needContinueGetMsg: false, msgList: [message(101, { ...peer, senderUid: 'u_main', metadata: Buffer.from('synthetic') })] };
    },
    getMsgs(peer) { return this.getAioFirstViewLatestMsgs(peer); },
    setMsgRead() { reads++; return { result: 0 }; },
    sendShowInputStatusReq() { hints++; return { result: 0 }; },
  };
  const group = {
    getUidByUins(accounts) { return { errCode: 0, uids: new Map(accounts.map(account => [account, account === MAIN ? 'u_main' : 'u_other'])) }; },
    getAllMemberList() { return { errCode: 0, result: { finish: true,
      infos: new Map([['member', { uin: MAIN, uid: 'u_main', nick: 'synthetic' }]]) } }; },
  };
  const session = { getSessionId: () => sid, getMsgService: () => msg, getGroupService: () => group,
    getBuddyService: () => ({ isBuddy: () => true }) };
  const bridge = createOriginalChatBridge({ session, identity, isCurrent: () => current,
    onUpdate: value => updates.push(value), onDiagnostics: value => diagnostics.push(value), onUnknown: value => unknown.push(value) });
  const core = new OneBotCore({ bridge, authorizationPolicy: 'native-session', conversationPolicy: 'original', minimumWriteIntervalMs: 0 });
  t.after(() => { core.close(); bridge.close(); });
  return { bridge, core, msg, group, raw, sent, updates, diagnostics, unknown,
    get adds() { return adds; }, get removes() { return removes; }, get hints() { return hints; }, get reads() { return reads; },
    setCurrent(value) { current = value; }, setSession(value) { sid = value; },
    async start() { await bridge.attach(); assert(await core.refreshIdentity(new AbortController().signal)); await nextTurn(); },
    receive(value) { const id = Object.getOwnPropertyDescriptor(value, 'msgId')?.value; if (id) raw.set(id, value); listenerOf().onRecvMsg([value]); },
    update(value) { listenerOf().onMsgInfoListUpdate(value); },
  };
}
const call = (f, action, params = {}) => f.core.dispatch({ action, params });

test('original binding receives all group senders and private MAIN, preserving native future time and self semantics', async t => {
  const f = fixture(t); await f.start();
  const events = []; f.core.on('event', value => events.push(value));
  f.receive(message(1));
  f.receive(message(2, { peerUid: '20002', senderUin: '10002', senderUid: 'u_other' }));
  f.receive(message(3, { chatType: 1, peerUid: 'u_main', peerUin: MAIN }));
  f.receive(message(4, { senderUin: BOT, senderUid: identity.uid }));
  await nextTurn();
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(x => x.message_type), ['group', 'group', 'private', 'group']);
  assert.equal(events[0].time, 4102444800);
  assert.equal(events[3].post_type, 'message_sent');
  assert.equal(events[3].sender.user_id, Number(BOT));
  // ★ 语义变更（2026-11-17）：native-session 模式下 `online` 表示「机器人此刻能用」，
  //   不再是「腾讯侧显示在线」——后者我们只能观测到 unknown。旧断言（online=false）
  //   会让外部工具把可用会话判成离线（验收探针因此拒绝发送），已按新语义改写。
  assert.equal(f.core.status().online, true);
  assert.equal(f.core.status().online_known, true);
  assert.equal(f.core.status().platform_state, 'unknown');
});

test('original projection ignores SDK Buffer/BigInt metadata and unrelated getters without mutating source', async t => {
  const f = fixture(t); await f.start();
  const events = []; f.core.on('event', value => events.push(value));
  const value = message(5, { metadata: Buffer.from('synthetic'), other: 1n });
  value.elements[0].textElement.metadata = 4n;
  Object.defineProperty(value, 'unrelated', { get() { throw Error('must not evaluate'); } });
  f.receive(value); await nextTurn();
  assert.equal(events.length, 1);
  assert.equal(events[0].raw_message, 'synthetic');
  assert.equal(value.other, 1n);
  assert.equal(value.msgTime, '4102444800');
  assert.equal(f.diagnostics.at(-1).projectionFailures, 0);
  const bad = message(6);
  Object.defineProperty(bad, 'msgId', { get() { throw Error('must not evaluate'); } });
  f.receive(bad); await nextTurn();
  assert.equal(events.length, 1);
  assert.equal(f.diagnostics.at(-1).projectionFailures, 1);
  assert(!JSON.stringify(f.diagnostics).includes('synthetic-original'));
  assert(!JSON.stringify(f.diagnostics).includes(MAIN));
});

test('original get_msg, member read, @MAIN and quote work in the BOT group context', async t => {
  const f = fixture(t); await f.start();
  const events = []; f.core.on('event', value => events.push(value));
  f.receive(message(11)); await nextTurn();
  const mid = events[0].message_id;
  assert.equal((await call(f, 'get_msg', { message_id: mid })).data.user_id, Number(MAIN));
  assert.equal((await call(f, 'get_group_member_info', { group_id: 20001, user_id: MAIN })).retcode, 0);
  const response = await call(f, 'send_group_msg', { group_id: 20001, message: [
    { type: 'reply', data: { id: String(mid) } }, { type: 'at', data: { qq: MAIN } }, { type: 'text', data: { text: 'synthetic reply' } },
  ] });
  assert.equal(response.retcode, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].elements[0].replyElement.senderUin, MAIN);
  assert.equal(f.sent[0].elements[1].textElement.atUid, MAIN);
});

test('original private MAIN supports input hint, mark-read and more than three unmarked normal sends', async t => {
  const f = fixture(t); await f.start();
  const events = []; f.core.on('event', value => events.push(value));
  f.receive(message(21, { chatType: 1, peerUid: 'u_main', peerUin: MAIN })); await nextTurn();
  assert.equal((await call(f, 'set_input_status', { user_id: MAIN, event_type: 1 })).retcode, 0);
  assert.equal((await call(f, 'mark_msg_as_read', { message_id: events[0].message_id })).retcode, 0);
  for (let index = 0; index < 4; index++) {
    const result = await call(f, 'send_private_msg', { user_id: MAIN, message: `synthetic-${index}` });
    assert.equal(result.retcode, 0);
  }
  assert.equal(f.hints, 1); assert.equal(f.reads, 1); assert.equal(f.sent.length, 4);
  assert(f.sent.every(x => x.peer.chatType === 1 && x.peer.peerUid === 'u_main'));
  assert.equal(f.sent[0].elements[0].textElement.content, 'synthetic-0');
});

test('original group/private history includes MAIN and safely projects unrelated native metadata', async t => {
  const f = fixture(t); await f.start();
  for (const [action, params] of [['get_group_msg_history', { group_id: 20001 }], ['get_friend_msg_history', { user_id: MAIN }]]) {
    const response = await call(f, action, params);
    assert.equal(response.retcode, 0);
    assert.equal(response.data.messages[0].user_id, Number(MAIN));
    assert.equal(response.data.messages[0].time, 4102444800);
  }
});

test('original conversations do not allow MAIN account identity or administrative targets', async t => {
  assert.throws(() => createOriginalChatBridge({ session: {}, identity: { ...identity, user_id: MAIN }, isCurrent: () => true }));
  const f = fixture(t); await f.start();
  for (const [action, params] of [['set_group_ban', { group_id: 20001, user_id: MAIN }],
    ['set_friend_remark', { user_id: MAIN, remark: 'synthetic' }]]) {
    assert.equal((await call(f, action, params)).retcode, 1403);
  }
  assert.equal(f.sent.length, 0);
});

test('explicit original constructor is unavailable under online-proof and public fields cannot select it', async t => {
  assert.throws(() => new NativeBridge({ session: {}, identityProbe: () => ({}), conversationPolicy: 'original' }));
  assert.throws(() => new OneBotCore({ conversationPolicy: 'original' }));
  assert.throws(() => new IPCBridge({}, { conversationPolicy: 'original' }));
  const f = fixture(t); await f.start();
  const strict = new OneBotCore({ bridge: f.bridge, authorizationPolicy: 'native-session', minimumWriteIntervalMs: 0 });
  t.after(() => strict.close());
  const result = await strict.dispatch({ action: 'send_private_msg', conversationPolicy: 'original',
    params: { user_id: MAIN, message: 'synthetic', conversationPolicy: 'original' } });
  assert.equal(result.retcode, 1403);
  assert.equal(f.sent.length, 0);
});

test('original binding retains exact weak SDK listener owner and removes only its verified handle', async t => {
  const f = fixture(t, { weak: true }); await f.start();
  if (typeof globalThis.gc === 'function') { globalThis.gc(); await nextTurn(); globalThis.gc(); }
  const events = []; f.core.on('event', value => events.push(value));
  f.receive(message(31)); await nextTurn();
  assert.equal(events.length, 1); assert.equal(f.adds, 1);
  f.bridge.close(); assert.equal(f.removes, 1);
});

test('uncertain listener registration is owned and cannot be retried or removed with unverified handle', async t => {
  for (const options of [{ handle: {} }, { registrationThrows: true }]) {
    const f = fixture(t, options);
    await assert.rejects(f.bridge.attach());
    await assert.rejects(f.bridge.attach(), { code: 'ATTACH_ALREADY_ATTEMPTED' });
    assert.equal(f.removes, 0);
    assert.equal(f.unknown[0].stage, 'registration-uncertain');
    assert.equal(f.diagnostics.at(-1).uncertainRegistrations, 1);
  }
});

test('actual lifecycle invalidation permanently revokes this binding and prevents further native sends', async t => {
  const f = fixture(t); await f.start();
  f.setCurrent(false);
  await assert.rejects(f.bridge.probe(), { code: 'NATIVE_SESSION_INVALIDATED' });
  f.setCurrent(true);
  await assert.rejects(f.bridge.probe());
  assert.equal(f.bridge.attached, false);
  assert.equal(f.removes, 1);
  assert.notEqual((await call(f, 'send_private_msg', { user_id: MAIN, message: 'synthetic' })).retcode, 0);
  assert.equal(f.sent.length, 0);
});

test('changed actual native session ID revokes binding without any identity substitution', async t => {
  const f = fixture(t); await f.start();
  f.setSession('other-session');
  await assert.rejects(f.bridge.probe());
  assert.equal(f.bridge.attached, false);
  assert.equal(f.removes, 1);
});

test('reduced terminal update receipt survives whole-message projection failure in original binding', async t => {
  const f = fixture(t); await f.start();
  // A native send confirmation whose content cannot be projected (optional BigInt
  // field + no elements array) must still confirm the send instead of being dropped.
  f.msg.sendMsg = (_first, peer) => {
    const reduced = { msgId: String(8800000003), guildId: peer.guildId, chatType: peer.chatType,
      peerUid: peer.peerUid, senderUin: BOT, senderUid: identity.uid, sendStatus: 2, optionalBigInt: 1n };
    queueMicrotask(() => f.update([reduced]));
    return { result: 0 };
  };
  const result = await call(f, 'send_group_msg', { group_id: 20001, message: 'synthetic reduced' });
  assert.equal(result.retcode, 0);
  assert.ok(Number.isInteger(result.data.message_id));
  assert.equal(f.diagnostics.at(-1).reducedReceipts, 1);
  assert.equal(f.diagnostics.at(-1).projectionFailures, 0);
});

test('an oversized record list no longer swallows an inbound message', async t => {
  const f = fixture(t); await f.start();
  const huge = message(4301, { records: Array.from({ length: 40 }, (_, i) => message(6000 + i)) });
  f.receive([huge]);
  await nextTurn(); await nextTurn();
  const latest = f.diagnostics.at(-1);
  // The regression this guards is specific: a record list used to be reported as
  // records.shape and the whole message was dropped. Any other failure label is a
  // different, unrelated condition and must not be attributed to this change.
  assert.equal(latest.projectionFailureKeys['records.shape'], undefined,
    'a big record list must not be rejected; keys=' + JSON.stringify(latest.projectionFailureKeys));
});
