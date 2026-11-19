import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { validateParams } from '../src/actions.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN;
function raw(seq = '51', overrides = {}) {
  return { msgId: String(90071992547409900n + BigInt(seq)), msgSeq: seq, msgTime: '1700000000', chatType: 2, peerUid: '20001', senderUin: '10001',
    senderUid: 'u_synthetic', sendNickName: 'Synthetic sender', sendMemberName: '', elements: [{ elementType: 1, textElement: { content: 'synthetic ' + seq } }], ...overrides };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(check) { for (let i = 0; i < 1000; i++) { if (check()) return; await turn(); } throw new Error('Synthetic call did not arrive'); }
async function fixture(t, { maxMessages = 10000, timeoutMs = 1000, missingGetMsgs = false, missingLatest = false } = {}) {
  let listener;
  const calls = [], originals = new Map(), events = [];
  const identity = { user_id: BOT, online: true, sessionId: 'synthetic-history-A' };
  const state = { identity, response: { result: 0, msgList: [raw('52'), raw('51')], needContinueGetMsg: false }, history: null, proof: null };
  const msg = {
    addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
    async getMsgs(...args) { assert.notEqual(args[1], '', 'Current sample stoll rejects empty msgId'); calls.push(['history', ...args]); return state.history ? state.history(...args) : state.response; },
    async getAioFirstViewLatestMsgs(...args) { calls.push(['history', ...args]); const result = state.history ? await state.history(...args) : state.response; return result; },
    getMsgsBySeqAndCount() { calls.push(['UNEXPECTED-FIVE-ARGUMENT-CALL']); throw new Error('Uncalibrated method must not be used'); },
    async getMsgsByMsgId(peer, ids) { calls.push(['by-id', peer, ids]); return { result: 0, msgList: ids.map(id => originals.get(peer.peerUid + ':' + id)).filter(Boolean) }; },
    async getMultiMsg(...args) { calls.push(['forward', ...args]); return { result: 0, msgList: [{ msgId: '999999', senderUin: '10002', sendNickName: 'Inner sender', elements: [{ elementType: 1, textElement: { content: 'Inner' } }] }] }; },
    async recallMsg(...args) { calls.push(['recall', ...args]); return { result: 0 }; },
  };
  if (missingGetMsgs) delete msg.getMsgs;
  if (missingLatest) delete msg.getAioFirstViewLatestMsgs;
  const group = { async getUidByUins(uins) {
    calls.push(['uid', uins]);
    return { errCode: 0, uids: new Map(uins.map(uin => [uin, 'u_friend'])) };
  } };
  const bridge = new NativeBridge({ session: { getMsgService: () => msg, getGroupService: () => group }, identityProbe: async () => state.proof ? state.proof() : state.identity, timeoutMs, maxMessages });
  bridge.on('event', event => events.push(event)); await bridge.attach(); t.after(() => bridge.detach());
  const receive = async value => { originals.set(value.peerUid + ':' + value.msgId, structuredClone(value)); listener.onRecvMsg([value]); await turn(); };
  return { bridge, calls, state, msg, originals, receive, events };
}

test('latest group history uses the exact two-argument latest-view contract and orders by lossless sequence', async t => {
  const f = await fixture(t);
  f.state.response = { result: 0, msgList: [raw('9007199254740993', { msgTime: '1' }), raw('9007199254740992', { msgTime: '100' })], needContinueGetMsg: false };
  const result = await f.bridge.call('get_group_msg_history', { group_id: '20001' });
  assert.deepEqual(f.calls, [['history', { chatType: 2, peerUid: '20001', guildId: '' }, 20]]);
  assert.deepEqual(result.messages.map(m => m.message_seq), ['9007199254740992', '9007199254740993']);
  assert.deepEqual(result.messages.map(m => m.time), [100, 1]);
  assert.equal(result.messages.every(m => m.group_id === 20001 && Number.isInteger(m.message_id)), true);
  assert.equal(f.events.length, 0, 'history is a query, not a stream of new events');
});

test('group history retains file metadata and refuses malformed native file sizes', async t => {
  const f = await fixture(t);
  const fileElement = { fileName: 'Synthetic.txt', fileSize: '12', fileUuid: 'synthetic-uuid', filePath: 'private/file' };
  f.state.response.msgList = [raw('52', { elements: [{ elementType: 3, fileElement }] })];
  const query = () => f.bridge.call('get_group_msg_history', { group_id: 20001 });
  const result = await query();
  assert.deepEqual(result.messages[0].message, [{ type: 'file', data: {
    name: 'Synthetic.txt', file: 'Synthetic.txt', file_id: 'synthetic-uuid', file_size: '12',
  } }]);
  fileElement.fileSize = '1e3';
  await assert.rejects(query(), { code: 'INVALID_NATIVE_RESPONSE' });
});

test('friend history resolves the private peer and rejects foreign or protected identities', async t => {
  const f = await fixture(t);
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => core.close());
  const direct = raw('52', { chatType: 1, peerUid: 'u_friend' });
  f.state.response.msgList = [direct];
  const request = { action: 'get_friend_msg_history', params: { user_id: '10001', count: 20 } };
  const result = await core.dispatch(request);
  assert.equal(result.retcode, 0);
  assert.equal(result.data.messages[0].message_type, 'private');
  assert.deepEqual(f.calls, [['uid', ['10001']], ['history', { chatType: 1, peerUid: 'u_friend', guildId: '' }, 20]]);
  const cursor = await core.dispatch({ ...request, params: { ...request.params, message_seq: '52' } });
  assert.equal(cursor.retcode, 0);
  assert.deepEqual(f.calls.at(-1), ['history', { chatType: 1, peerUid: 'u_friend', guildId: '' }, direct.msgId, 20, false]);
  f.state.response.msgList = [{ ...direct, senderUin: '10002' }];
  assert.notEqual((await core.dispatch(request)).retcode, 0);
  const calls = f.calls.length;
  assert.notEqual((await core.dispatch({ ...request, params: { user_id: OWNER_UIN } })).retcode, 0);
  assert.equal(f.calls.length, calls);
});

test('history capability needs both known entry points, not merely a similarly named five-argument method', async t => {
  for (const options of [{ missingGetMsgs: true }, { missingLatest: true }]) {
    const f = await fixture(t, options);
    assert.equal(f.bridge.capabilities().includes('get_group_msg_history'), false);
    await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }), { code: 'UNSUPPORTED' });
    assert.deepEqual(f.calls, []);
  }
});

test('HTTP-style decimal count and group parameters normalize while uncalibrated flags reject before native', async t => {
  const f = await fixture(t), core = new OneBotCore({ bridge: f.bridge }); t.after(() => core.close());
  const response = await core.dispatch({ action: 'get_group_msg_history', params: { group_id: '20001', count: '2' }, echo: ['synthetic'] });
  assert.equal(response.retcode, 0); assert.deepEqual(response.echo, ['synthetic']); assert.equal(response.data.messages.length, 2);
  assert.equal(f.calls[0][2], 2);
  for (const count of [null, false, true, 0, -1, 101, 1.5, '01', '1.5', '1e2', 'false', '', NaN]) {
    assert.throws(() => validateParams('get_group_msg_history', { group_id: 20001, count }));
    await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001, count }), { code: 'INVALID_PARAMS' });
  }
  for (const extra of [{ reverse_order: true }, { reverseOrder: false }, { no_cache: true }, { message_id: 1 }]) {
    assert.throws(() => validateParams('get_group_msg_history', { group_id: 20001, ...extra }));
    await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001, ...extra }), { code: 'INVALID_PARAMS' });
  }
  for (const seq of [0, '0', '01', -1, 1.5, false, 9007199254740992, '9223372036854775808']) assert.throws(() => validateParams('get_group_msg_history', { group_id: 20001, message_seq: seq }));
  assert.equal(f.calls.length, 1);
});

test('message_seq resolves only an exact current same-group sequence and sends its distinct native msgId', async t => {
  const f = await fixture(t), anchor = raw('9007199254740993', { msgId: '90071992547409931' });
  await f.receive(anchor);
  const ownId = f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, anchor.msgId);
  const queried = await f.bridge.call('get_msg', { message_id: ownId });
  assert.equal(queried.message_seq, '9007199254740993');
  f.calls.length = 0; f.state.response = { result: 0, msgList: [anchor, raw('9007199254740992', { msgId: '90071992547409930' })] };
  const result = await f.bridge.call('get_group_msg_history', { group_id: 20001, message_seq: '9007199254740993', count: 2 });
  assert.equal(f.calls[0][2], '90071992547409931'); assert.notEqual(f.calls[0][2], anchor.msgSeq);
  assert.deepEqual(result.messages.map(m => m.message_seq), ['9007199254740992', '9007199254740993']);
  assert.equal(result.messages[1].message_id, ownId);
});

test('unknown, foreign-group, ambiguous and old-session cursors never fall back to a raw native ID', async t => {
  const f = await fixture(t); await f.receive(raw('51')); await f.receive(raw('70', { peerUid: '20002' }));
  for (const message_seq of ['1', '999', '70']) await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001, message_seq }), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
  await f.receive(raw('51', { msgId: '90071992547409999' }));
  await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001, message_seq: '51' }), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
  f.bridge.detach(); await f.bridge.attach();
  await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20002, message_seq: '70' }), { code: 'HISTORY_CURSOR_UNAVAILABLE' });
  assert.deepEqual(f.calls, []);
});

test('cursor responses outside the requested past range are rejected instead of silently reversed', async t => {
  const f = await fixture(t); await f.receive(raw('51'));
  await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001, message_seq: '51' }), { code: 'HISTORY_RANGE_UNCONFIRMED' });
  assert.equal(f.bridge.messages.byId.size, 1);
  assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, raw('52').msgId), undefined);
});

test('empty page is successful but missing result, missing list and oversized pages are not', async t => {
  const f = await fixture(t); f.state.response = { result: 0, needContinueGetMsg: false, msgList: [] };
  assert.deepEqual(await f.bridge.call('get_group_msg_history', { group_id: 20001 }), { messages: [] });
  for (const response of [{}, { result: 0, needContinueGetMsg: false }, { result: '0', msgList: [] }, { result: 2, msgList: [] }, { result: 0, needContinueGetMsg: false, msgList: [raw('1'), raw('2'), raw('3')] }]) {
    f.state.response = response; await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001, count: 2 }));
  }
  assert.equal(f.bridge.messages.byId.size, 0);
});

test('latest-view continuation flag must be a real boolean and never triggers a guessed continuation request', async t => {
  const f = await fixture(t);
  for (const flag of [undefined, null, 0, 'false']) {
    f.state.response = { result: 0, msgList: [raw('51')], ...(flag === undefined ? {} : { needContinueGetMsg: flag }) };
    await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }), { code: 'HISTORY_INCOMPLETE' });
  }
  assert.equal(f.calls.length, 4); assert.equal(f.bridge.messages.byId.size, 0);
  // true is the ordinary answer on any conversation with older messages above the
  // page: it is the AIO viewer's "scroll up for more" hint, not a claim that this
  // page is untrustworthy. Rejecting it made every real catchup fail with 1502.
  f.state.response = { result: 0, msgList: [raw('51')], needContinueGetMsg: true };
  const page = await f.bridge.call('get_group_msg_history', { group_id: 20001 });
  assert.equal(page.messages.length, 1);
  assert.equal(f.calls.length, 5, 'a true continuation flag must not trigger a second native fetch');
  assert.equal(f.bridge.historyContinuationPages, 1);
  assert.equal(f.bridge.messages.byId.size, 1);
});

test('whole-page validation rejects peer, IDs, sequences, identity, time and element failures without minting IDs', async t => {
  const f = await fixture(t);
  const invalidRows = [
    raw('52', { peerUid: '20002' }), raw('52', { chatType: 1 }), raw('52', { msgId: '9223372036854775808' }),
    raw('52', { msgSeq: '0' }), raw('52', { msgSeq: 52 }), raw('52', { senderUin: 'broken-uin' }),
    raw('52', { msgTime: '-1' }), raw('52', { sendNickName: 'x'.repeat(257) }),
    raw('52', { elements: [{ elementType: 1, textElement: { content: 7 } }] }),
    raw('52', { elements: [{ elementType: 6, faceElement: { faceIndex: -1 } }] }),
    raw('52', { elements: [{ elementType: 2, picElement: {} }] }), raw('52', { elements: [{ elementType: '999' }] }),
    raw('52', { elements: [{ elementType: 16, multiForwardMsgElement: { resId: '' } }] }),
  ];
  for (const invalid of invalidRows) {
    f.state.response = { result: 0, needContinueGetMsg: false, msgList: [raw('51'), invalid] };
    await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }));
    assert.equal(f.bridge.messages.byId.size, 0); assert.equal(f.bridge.messages.next, 1); assert.equal(f.bridge.forwards.size, 0);
  }
  for (const duplicate of [raw('51'), raw('52', { msgId: raw('51').msgId })]) {
    f.state.response = { result: 0, needContinueGetMsg: false, msgList: [raw('51'), duplicate] }; await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }));
  }
});

test('history keeps unknown numeric elements as payload-free placeholders without losing adjacent messages', async t => {
  const f = await fixture(t);
  const unknown = { elementType: 999, unsupported: { content: 'opaque private payload' } };
  const mixed = raw('52', { elements: [unknown, ...raw('52').elements] });
  f.state.response = { result: 0, needContinueGetMsg: false, msgList: [mixed, raw('51')] };
  const result = await f.bridge.call('get_group_msg_history', { group_id: 20001 });
  assert.deepEqual(result.messages.map(message => message.message_seq), ['51', '52']);
  assert.deepEqual(result.messages[1].message, [{ type: 'qq_unknown', data: { element_type: '999' } },
    { type: 'text', data: { text: 'synthetic 52' } }]);
  assert.deepEqual(f.bridge.messages.get(result.messages[1].message_id).elements[0], { elementType: 999 });
  assert(!JSON.stringify(result).includes('opaque private payload'));
  assert.equal(f.events.length, 0);
});

test('group history skips protected records without exposing their IDs or rejecting other messages', async t => {
  const f = await fixture(t);
  const protectedRecord = raw('52', { senderUin: OWNER_UIN, elements: [{ elementType: 999 }] });
  const visible = raw('53');
  const read = () => f.bridge.call('get_group_msg_history', { group_id: 20001 });
  f.state.response = { result: 0, needContinueGetMsg: false, msgList: [protectedRecord, visible, raw('51')] };
  const result = await read();
  assert.deepEqual(result.messages.map(message => message.message_seq), ['51', '53']);
  assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, protectedRecord.msgId), undefined);
  assert.equal(f.bridge.messages.byId.size, 2);
  f.state.response.msgList = [protectedRecord];
  assert.deepEqual(await read(), { messages: [] });
  f.state.response.msgList = [{ ...protectedRecord, peerUid: '20002' }];
  await assert.rejects(read(), { code: 'INVALID_NATIVE_RESPONSE' });
  f.state.response.msgList = [{ ...protectedRecord, msgSeq: visible.msgSeq }, visible];
  await assert.rejects(read(), { code: 'INVALID_NATIVE_RESPONSE' });
  assert.equal(f.bridge.messages.byId.size, 2);
  assert.equal(f.events.length, 0);
});

test('response graph accessors, cycles, aggregate bytes and cache capacity are bounded', async t => {
  const f = await fixture(t, { maxMessages: 1 }); let getters = 0;
  const access = { result: 0 }; Object.defineProperty(access, 'msgList', { get() { getters++; return [raw()]; } });
  const cycle = { result: 0, msgList: [] }; cycle.cycle = cycle;
  for (const response of [access, cycle, { result: 0, needContinueGetMsg: false, msgList: [raw('51'), raw('52')] }, { result: 0, needContinueGetMsg: false, msgList: [], other: Array.from({ length: 20 }, () => 'x'.repeat(60000)) }]) {
    f.state.response = response; await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }));
  }
  assert.equal(getters, 0); assert.equal(f.bridge.messages.byId.size, 0);
});

test('output expansion failure rolls back existing-entry updates and all new message/forward IDs', async t => {
  const f = await fixture(t); const original = raw('1'); await f.receive(original);
  const originalId = f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, original.msgId);
  const beforeNext = f.bridge.messages.next, beforeForward = f.bridge.nextForward;
  const huge = n => raw(String(n), { elements: [{ elementType: 1, textElement: { content: '&'.repeat(50000) } }] });
  f.state.response = { result: 0, needContinueGetMsg: false, msgList: [huge(1), huge(2), huge(3), huge(4), raw('5', { elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'not-published' } }] })] };
  await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }), { code: 'INVALID_NATIVE_RESPONSE' });
  assert.deepEqual(f.bridge.messages.get(originalId), original);
  assert.equal(f.bridge.messages.next, beforeNext); assert.equal(f.bridge.messages.byId.size, 1);
  assert.equal(f.bridge.nextForward, beforeForward); assert.equal(f.bridge.forwards.size, 0);
});

test('incoming messages while the post-query proof waits survive the later atomic history publication', async t => {
  const f = await fixture(t), proof = deferred(); let proofWaiting = false;
  f.state.history = () => { f.state.proof = () => { proofWaiting = true; return proof.promise; }; return { result: 0, needContinueGetMsg: false, msgList: [raw('51')] }; };
  const query = f.bridge.call('get_group_msg_history', { group_id: 20001 });
  await until(() => proofWaiting);
  const incoming = raw('99'); await f.receive(incoming);
  const peer = { chatType: 2, peerUid: '20001' };
  assert.equal(f.bridge.messages.find(peer, incoming.msgId), undefined);
  proof.resolve(f.state.identity); const result = await query;
  await until(() => f.events.length === 1);
  const incomingId = f.events[0].message_id;
  assert.notEqual(result.messages[0].message_id, incomingId);
  assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, incoming.msgId), incomingId);
  assert.deepEqual(f.bridge.messages.get(incomingId), incoming);
});

test('successful page keeps all page IDs at the cache bound and only resolves same-group replies', async t => {
  const f = await fixture(t, { maxMessages: 2 }); await f.receive(raw('52')); await f.receive(raw('70', { peerUid: '20002' }));
  const oldId = f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, raw('52').msgId);
  const original = raw('51');
  f.state.response = { result: 0, needContinueGetMsg: false, msgList: [raw('52', {
    records: [original],
    elements: [{ elementType: 7, replyElement: { replayMsgId: '0', sourceMsgIdInRecords: original.msgId } }],
  }), original] };
  const result = await f.bridge.call('get_group_msg_history', { group_id: 20001, count: 2 });
  assert.equal(result.messages[1].message_id, oldId);
  assert.deepEqual(result.messages[1].message, [{ type: 'reply', data: { id: String(result.messages[0].message_id) } }]);
  for (const message of result.messages) assert.equal(f.bridge.messages.get(message.message_id).msgSeq, message.message_seq);
  assert.equal(f.bridge.messages.byId.size, 2);
});

test('history outer forwards use the normal current-session map without granting inner IDs authority', async t => {
  const f = await fixture(t), forwarded = raw('51', { elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'synthetic-forward' } }] });
  f.state.response = { result: 0, needContinueGetMsg: false, msgList: [forwarded] }; f.originals.set('20001:' + forwarded.msgId, forwarded);
  const page = await f.bridge.call('get_group_msg_history', { group_id: 20001 }); const token = page.messages[0].message[0].data.id;
  assert.match(token, /^fwd_/);
  const result = await f.bridge.call('get_forward_msg', { id: token }); assert.equal(result.message[0].type, 'node');
  assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, '999999'), undefined);
  assert.equal(f.bridge.messages.byId.size, 1);
});

test('native identity loss or session changes before publication never index returned history', async t => {
  for (const change of [{ user_id: OWNER_UIN, online: true, sessionId: 'wrong' }, { user_id: BOT, online: true, sessionId: 'new-session' }]) {
    const f = await fixture(t); f.state.history = () => { f.state.identity = change; return { result: 0, needContinueGetMsg: false, msgList: [raw('51')] }; };
    await assert.rejects(f.bridge.call('get_group_msg_history', { group_id: 20001 }));
    assert.equal(f.bridge.messages.byId.size, 0); assert.equal(f.bridge.forwards.size, 0);
  }
});

test('timeout, abort, detach and cursor eviction discard late history responses without retry', async t => {
  for (const stop of ['timeout', 'abort', 'detach', 'cursor-eviction']) {
    const f = await fixture(t, { timeoutMs: stop === 'timeout' ? 20 : 1000, maxMessages: stop === 'cursor-eviction' ? 1 : 100 });
    if (stop === 'cursor-eviction') await f.receive(raw('51'));
    const pending = deferred(); f.state.history = () => pending.promise;
    const controller = new AbortController();
    const query = f.bridge.call('get_group_msg_history', { group_id: 20001, ...(stop === 'cursor-eviction' ? { message_seq: '51' } : {}) }, { signal: controller.signal });
    const rejected = assert.rejects(query, error => ['TIMEOUT', 'CANCELLED', 'HISTORY_CURSOR_UNAVAILABLE'].includes(error.code));
    await until(() => f.calls.some(c => c[0] === 'history'));
    if (stop === 'abort') controller.abort(); if (stop === 'detach') f.bridge.detach();
    if (stop === 'cursor-eviction') { await f.receive(raw('99')); pending.resolve({ result: 0, msgList: [raw('50')] }); }
    await rejected; pending.resolve({ result: 0, needContinueGetMsg: false, msgList: [raw('50')] }); await turn();
    assert.equal(f.calls.filter(c => c[0] === 'history').length, 1);
    assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, raw('50').msgId), undefined);
  }
});
