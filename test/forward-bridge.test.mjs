import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN;
const FRIEND = '10001';
const INNER = '900719925474099399';
function outer(overrides = {}) {
  return { msgId: '90071992547409931', msgSeq: '51', msgTime: '1700000000', chatType: 2, peerUid: '20001', senderUid: 'u_synthetic', senderUin: FRIEND,
    sendNickName: 'Synthetic sender', elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'synthetic-resource-id' } }], ...overrides };
}
function node(overrides = {}) {
  return { msgId: INNER, senderUin: FRIEND, sendNickName: 'Forwarded sender', elements: [{ elementType: 1, textElement: { content: 'original forwarded text' } }], ...overrides };
}
async function fixture(t, { maxMessages = 10000, timeoutMs = 1000, missing } = {}) {
  let listener;
  const calls = [], events = [], originals = new Map();
  const state = { identity: { user_id: BOT, online: true, sessionId: 'synthetic-forward-A' }, response: { result: 0, msgList: [node()] }, outerRead: null, multiRead: null, proofRead: null };
  const key = (peer, msgId) => JSON.stringify([peer.chatType, peer.peerUid, msgId]);
  const msg = {
    async buildMultiForwardMsg(input) {
      calls.push(['build', structuredClone(input)]);
      return state.buildResponse ?? { result: 0, rspInfo: { elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'built-resource' } }] } };
    },
    generateMsgUniqueId() { return '90071992547409955'; },
    async sendMsg(id, peer, elements) {
      calls.push(['send', id, structuredClone(peer), structuredClone(elements)]);
      listener.onMsgInfoListUpdate([outer({ ...peer, senderUin: BOT, msgId: '90071992547409956', elements, sendStatus: 2 })]);
      return { result: 0 };
    },
    addKernelMsgListener(value) { listener = value; return 1; },
    removeKernelMsgListener() {},
    async getMsgsByMsgId(peer, ids) {
      calls.push(['outer', structuredClone(peer), [...ids]]);
      if (state.outerRead) return state.outerRead(peer, ids);
      return { result: 0, msgList: ids.map(id => originals.get(key(peer, id))).filter(Boolean) };
    },
    async getMultiMsg(peer, msgId, resId) {
      calls.push(['multi', structuredClone(peer), msgId, resId]);
      return state.multiRead ? state.multiRead(peer, msgId, resId) : state.response;
    },
    async recallMsg(...args) { calls.push(['recall', ...args]); return { result: 0 }; },
  };
  if (missing) delete msg[missing];
  const bridge = new NativeBridge({ session: { getMsgService: () => msg }, identityProbe: async () => state.proofRead ? state.proofRead() : state.identity, maxMessages, timeoutMs });
  bridge.on('event', value => events.push(value));
  await bridge.attach();
  t.after(() => bridge.detach());
  const receive = async (value = outer()) => {
    originals.set(key(value, value.msgId), structuredClone(value));
    const before = events.length;
    listener.onRecvMsg([value]);
    await turn();
    return events[before]?.message.find(segment => segment.type === 'forward')?.data.id;
  };
  return { bridge, msg, calls, events, state, receive, originals, key };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

const reference = id => ({ type: 'node', data: { id } });

test('reference forwarding builds once and confirms the final message ID through the shared send path', async t => {
  const f = await fixture(t);
  await f.receive();
  const result = await f.bridge.call('send_forward_msg', { group_id: 20002, messages: [reference(1)] });
  assert.deepEqual(f.calls[0], ['build', { srcMsgIds: ['90071992547409931'], srcContact: { chatType: 2, peerUid: '20001', guildId: '' } }]);
  assert.deepEqual(f.calls[1].slice(0, 3), ['send', '0', { chatType: 2, peerUid: '20002', guildId: '90071992547409955' }]);
  assert.equal(f.bridge.messages.get(result.message_id).msgId, '90071992547409956');
});

test('invalid source batches stay unsubmitted and an incomplete build locks later writes', async t => {
  const f = await fixture(t);
  await f.receive();
  await f.receive(outer({ msgId: '90071992547409932', peerUid: '20003' }));
  await assert.rejects(f.bridge.call('send_group_forward_msg', { group_id: 20002, messages: [reference(1), reference(2)] }));
  await assert.rejects(f.bridge.call('send_forward_msg', { group_id: 20002, user_id: 10001, messages: [reference(1)] }));
  assert.deepEqual(f.calls, []);
  f.state.buildResponse = { result: 0, rspInfo: { elements: [] } };
  const core = new OneBotCore({ freezeOnUnknown: true, bridge: f.bridge, minimumWriteIntervalMs: 0 });
  t.after(() => core.close());
  const request = { action: 'send_group_forward_msg', params: { group_id: 20002, messages: [reference(1)] } };
  // P4：发送类动作拿不到确定结果 ⇒ 按已接受回成功（不再回 1504，也不再有 1503 闩锁）；
  // 但**绝不会重试**：原生 build 只被调用一次。
  const first = await core.dispatch(request);
  assert.equal(first.retcode, 0);
  assert.equal(first.data.message_id, null);
  const secondForward = await core.dispatch(request);
  assert.doesNotMatch(JSON.stringify(secondForward), /operator reconciliation required/,
    'P4：不存在「上一次结果未知就拒掉后续发送」的闩锁');
  assert(f.calls.filter(call => call[0] === 'build').length <= 2, '每条转发只提交一次，不重试');
});
async function until(check) { for (let n = 0; n < 1000; n++) { if (check()) return; await turn(); } throw new Error('Synthetic observation did not arrive'); }

test('forward ID resolves exact outer triple and returns standard singular message node array', async t => {
  const f = await fixture(t), token = await f.receive();
  assert.match(token, /^fwd_[a-f0-9]{32}_1$/);
  assert.notEqual(token, 'synthetic-resource-id');
  assert(f.bridge.capabilities().includes('get_forward_msg'));
  const result = await f.bridge.call('get_forward_msg', { id: token });
  assert.deepEqual(f.calls, [
    ['outer', { chatType: 2, peerUid: '20001', guildId: '' }, ['90071992547409931']],
    ['multi', { chatType: 2, peerUid: '20001', guildId: '' }, '90071992547409931', 'synthetic-resource-id'],
  ]);
  assert.deepEqual(result, { message: [{ type: 'node', data: { user_id: FRIEND, nickname: 'Forwarded sender', content: [{ type: 'text', data: { text: 'original forwarded text' } }] } }] });
  assert.equal('messages' in result, false);
  assert.equal(f.bridge.messages.byId.size, 1);
  assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, INNER), undefined);
  await assert.rejects(f.bridge.call('delete_msg', { message_id: 2 }), { code: 'MESSAGE_NOT_FOUND' });
  assert.equal(f.calls.some(call => call[0] === 'recall'), false);
});

test('legacy outer message reference uses the same checked read path and rejects ambiguity', async t => {
  const f = await fixture(t);
  const token = await f.receive();
  const result = await f.bridge.call('get_forward_msg', { message_id: 1 });
  assert.equal(result.message.length, 1);
  assert.deepEqual(f.calls.map(call => call[0]), ['outer', 'multi']);
  await assert.rejects(f.bridge.call('get_forward_msg', { message_id: 1, id: token }), { code: 'INVALID_PARAMS' });
  await assert.rejects(f.bridge.call('get_forward_msg', { message_id: 2 }), { code: 'MESSAGE_NOT_FOUND' });
  const card = outer({ msgId: '90071992547409932' });
  card.elements.push({ ...card.elements[0], multiForwardMsgElement: { resId: 'another-id' } });
  await f.receive(card);
  await assert.rejects(f.bridge.call('get_forward_msg', { message_id: 2 }), { code: 'FORWARD_NOT_FOUND' });
  assert.deepEqual(f.calls.map(call => call[0]), ['outer', 'multi']);
});

test('forward capability needs both native reads and unknown resource strings never guess context', async t => {
  for (const missing of ['getMsgsByMsgId', 'getMultiMsg']) {
    const f = await fixture(t, { missing });
    assert.equal(f.bridge.capabilities().includes('get_forward_msg'), false);
  }
  const f = await fixture(t); await f.receive();
  for (const id of ['synthetic-resource-id', '1', 'fwd_' + '0'.repeat(32) + '_1']) {
    await assert.rejects(f.bridge.call('get_forward_msg', { id }), error => ['INVALID_PARAMS', 'FORWARD_NOT_FOUND'].includes(error.code));
  }
  assert.deepEqual(f.calls, []);
});

test('same resource in different peers has distinct IDs and private native UID is preserved', async t => {
  const f = await fixture(t), group = await f.receive();
  const privateId = await f.receive(outer({ chatType: 1, peerUid: 'u_private_synthetic', msgId: '90071992547409932' }));
  assert.notEqual(group, privateId);
  await f.bridge.call('get_forward_msg', { id: privateId });
  assert.deepEqual(f.calls[1].slice(1), [{ chatType: 1, peerUid: 'u_private_synthetic', guildId: '' }, '90071992547409932', 'synthetic-resource-id']);
  await f.bridge.call('get_forward_msg', { id: group });
  assert.equal(f.calls[3][1].peerUid, '20001');
});

test('forward IDs expire on bounded eviction, full detach or a different bridge instance', async t => {
  const f = await fixture(t, { maxMessages: 1 }), old = await f.receive();
  const current = await f.receive(outer({ msgId: '90071992547409932' }));
  assert.equal(f.bridge.forwards.size, 1); assert.equal(f.bridge.forwardSources.size, 1);
  await assert.rejects(f.bridge.call('get_forward_msg', { id: old }), { code: 'FORWARD_NOT_FOUND' });
  f.bridge.detach(); await f.bridge.attach();
  await assert.rejects(f.bridge.call('get_forward_msg', { id: current }), { code: 'FORWARD_NOT_FOUND' });
  const fresh = await f.receive(); assert.notEqual(fresh, old);
  const other = await fixture(t), otherToken = await other.receive();
  assert.notEqual(fresh, otherToken);
  await assert.rejects(other.bridge.call('get_forward_msg', { id: fresh }), { code: 'FORWARD_NOT_FOUND' });
  assert.deepEqual(f.calls, []);
});

test('a forward reference survives same-session reattachment and revalidates its outer message', async t => {
  const f = await fixture(t);
  const token = await f.receive();
  const outerId = f.events[0].message_id;
  const first = await f.bridge.call('get_forward_msg', { id: token });
  await f.bridge.reattach();
  assert.equal((await f.bridge.call('get_msg', { message_id: outerId })).message[0].data.id, token);
  assert.deepEqual(await f.bridge.call('get_forward_msg', { id: token }), first);
  f.state.outerRead = () => ({ result: 0, msgList: [outer({ elements: [] })] });
  await assert.rejects(f.bridge.call('get_forward_msg', { id: token }), { code: 'FORWARD_NOT_FOUND' });
  assert.equal(f.calls.filter(([kind]) => kind === 'multi').length, 2);
  f.state.identity = { ...f.state.identity, sessionId: 'different-session' };
  await assert.rejects(f.bridge.reattach(), { code: 'STALE_SESSION' });
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('get_forward_msg', { id: token }), { code: 'FORWARD_NOT_FOUND' });
});

test('outer readback mismatch, missing result or duplicate outer messages prevents getMultiMsg', async t => {
  const f = await fixture(t), token = await f.receive();
  const variants = [
    { result: 0, msgList: [] }, { result: 0, msgList: [outer(), outer()] },
    { result: 0, msgList: [outer({ peerUid: '20002' })] },
    { result: 0, msgList: [outer({ msgId: '90071992547409932' })] },
    { result: 0, msgList: [outer({ elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'other' } }] })] },
    { result: 0, msgList: [outer({ senderUin: '10002' })] },
    { result: 0, msgList: [outer({ senderUin: OWNER_UIN })] },
    { msgList: [outer()] }, { result: 5, msgList: [outer()] },
  ];
  for (const response of variants) {
    f.state.outerRead = async () => response;
    await assert.rejects(f.bridge.call('get_forward_msg', { id: token }));
  }
  assert.equal(f.calls.filter(call => call[0] === 'outer').length, variants.length);
  assert.equal(f.calls.some(call => call[0] === 'multi'), false);
});

test('supported forwarded content retains text mentions and metadata without new native message IDs', async t => {
  const f = await fixture(t), token = await f.receive();
  f.state.response = { result: 0, msgList: [node({ elements: [
    { elementType: 1, textElement: { content: '@Synthetic', atType: 2, atUid: 'u_unverified' } },
    { elementType: 1, textElement: { content: '@all', atType: 1 } },
    { elementType: 6, faceElement: { faceIndex: 123 } },
    { elementType: 2, picElement: { fileName: 'synthetic.png', originImageUrl: 'https://gchat.qpic.cn/synthetic' } },
    { elementType: 4, pttElement: { fileName: 'synthetic.silk' } },
    { elementType: 5, videoElement: { fileName: 'synthetic.mp4' } },
    { elementType: 3, fileElement: { fileName: 'synthetic.txt', fileSize: '12', fileUuid: 'synthetic-id' } },
    { elementType: 10, arkElement: { bytesData: '{"synthetic":true}' } },
  ] })] };
  const result = await f.bridge.call('get_forward_msg', { id: token });
  assert.deepEqual(result.message[0].data.content.map(x => x.type), ['text', 'at', 'face', 'image', 'record', 'video', 'file', 'json']);
  assert.deepEqual(result.message[0].data.content[6], { type: 'file', data: {
    name: 'synthetic.txt', file: 'synthetic.txt', file_size: '12', file_id: 'synthetic-id',
  } });
  assert.deepEqual(result.message[0].data.content[0], { type: 'text', data: { text: '@Synthetic' } });
  assert.deepEqual(result.message[0].data.content[1], { type: 'at', data: { qq: 'all' } });
  assert.deepEqual(result.message[0].data.content[3], { type: 'image', data: {
    file: 'synthetic.png', url: 'https://gchat.qpic.cn/synthetic',
  } });
  assert.equal(f.bridge.messages.byId.size, 1);
  f.state.response = { result: 0, msgList: [] };
  assert.deepEqual(await f.bridge.call('get_forward_msg', { id: token }), { message: [] });
});

test('nested forwards, reply-only authority and unknown content reject the entire forward response', async t => {
  const f = await fixture(t), token = await f.receive();
  for (const element of [{ elementType: 16, multiForwardMsgElement: { resId: 'nested' } }, { elementType: 7, replyElement: { replayMsgId: INNER } }, { elementType: 999 }]) {
    f.state.response = { result: 0, msgList: [node(), node({ elements: [element] })] };
    await assert.rejects(f.bridge.call('get_forward_msg', { id: token }), error => ['UNSUPPORTED_NESTED_FORWARD', 'UNSUPPORTED_FORWARD_CONTENT'].includes(error.code));
  }
  assert.equal(f.bridge.forwards.size, 1); assert.equal(f.bridge.messages.byId.size, 1);
});

test('malformed native results and response budgets fail before returning any partial nodes', async t => {
  const f = await fixture(t), token = await f.receive();
  const cycle = { result: 0, msgList: [] }; cycle.loop = cycle;
  let deep = {}; for (let i = 0; i < 14; i++) deep = { nested: deep };
  const variants = [
    {}, { result: '0', msgList: [] }, { result: 0 }, { result: 5, msgList: [] },
    { result: 0, msgList: Array.from({ length: 201 }, () => node()) },
    { result: 0, msgList: [node({ elements: Array.from({ length: 1001 }, () => ({ elementType: 6, faceElement: { faceIndex: 1 } })) })] },
    { result: 0, msgList: [node({ senderUin: OWNER_UIN })] },
    { result: 0, msgList: [node({ sendNickName: 'x'.repeat(257) })] },
    { result: 0, msgList: [node({ elements: [{ elementType: 1, textElement: { content: 'x'.repeat(65537) } }] })] },
    { result: 0, msgList: [], oversized: Array.from({ length: 20 }, () => 'x'.repeat(60000)) },
    { result: 0, msgList: [], deep }, cycle,
  ];
  for (const response of variants) {
    f.state.response = response;
    await assert.rejects(f.bridge.call('get_forward_msg', { id: token }));
  }
  assert.equal(f.bridge.messages.byId.size, 1);
});

test('native response accessors including non-enumerable and Map properties are never evaluated', async t => {
  const f = await fixture(t), token = await f.receive(); let getters = 0;
  for (const response of [{ result: 0 }, new Map()]) {
    Object.defineProperty(response, 'msgList', { enumerable: false, get() { getters++; return [node()]; } });
    f.state.response = response;
    await assert.rejects(f.bridge.call('get_forward_msg', { id: token }), { code: 'INVALID_NATIVE_RESPONSE' });
  }
  const sparse = new Array(1); f.state.response = { result: 0, msgList: sparse };
  await assert.rejects(f.bridge.call('get_forward_msg', { id: token }), { code: 'INVALID_NATIVE_RESPONSE' });
  assert.equal(getters, 0);
});

test('identity loss after outer read prevents content query and identity loss after content prevents response', async t => {
  for (const phase of ['outer', 'multi']) {
    const f = await fixture(t), token = await f.receive();
    const wrong = () => { f.state.identity = { user_id: OWNER_UIN, online: true, sessionId: 'wrong' }; };
    if (phase === 'outer') f.state.outerRead = async () => { wrong(); return { result: 0, msgList: [outer()] }; };
    else f.state.multiRead = async () => { wrong(); return { result: 0, msgList: [node()] }; };
    await assert.rejects(f.bridge.call('get_forward_msg', { id: token }), { code: 'IDENTITY_REJECTED' });
    assert.equal(f.calls.filter(call => call[0] === 'multi').length, phase === 'outer' ? 0 : 1);
    assert.equal(f.bridge.forwards.size, 0);
  }
});

test('cancellation, timeout and bridge changes discard late forward reads without retries', async t => {
  for (const phase of ['outer', 'multi']) for (const stop of ['abort', 'detach', 'reattach', 'timeout']) {
    const f = await fixture(t, { timeoutMs: stop === 'timeout' ? 25 : 1000 }), token = await f.receive();
    const pending = deferred(); f.state[phase === 'outer' ? 'outerRead' : 'multiRead'] = () => pending.promise;
    const abort = new AbortController();
    const operation = f.bridge.call('get_forward_msg', { id: token }, { signal: abort.signal });
    const rejected = assert.rejects(operation, error => ['CANCELLED', 'TIMEOUT'].includes(error.code) && error.outcome === 'not_started');
    await until(() => f.calls.some(call => call[0] === phase));
    if (stop === 'abort') abort.abort();
    if (stop === 'detach') f.bridge.detach();
    if (stop === 'reattach') await f.bridge.reattach();
    await rejected;
    pending.resolve({ result: 0, msgList: phase === 'outer' ? [outer()] : [node()] });
    await turn();
    assert.equal(f.calls.filter(call => call[0] === phase).length, 1);
    if (phase === 'outer') assert.equal(f.calls.some(call => call[0] === 'multi'), false);
  }
});

test('eviction during a native read cancels its authority without minting replacement IDs', async t => {
  const f = await fixture(t, { maxMessages: 1 }), token = await f.receive();
  const pending = deferred(); f.state.multiRead = () => pending.promise;
  const query = f.bridge.call('get_forward_msg', { id: token });
  const rejected = assert.rejects(query, { code: 'FORWARD_NOT_FOUND' });
  await until(() => f.calls.some(call => call[0] === 'multi'));
  await f.receive(outer({ msgId: '90071992547409932' }));
  pending.resolve({ result: 0, msgList: [node()] }); await rejected;
  assert.equal(f.bridge.forwards.size, 1);
});

test('ordinary get_msg rechecks identity before it can mint a new forward context', async t => {
  const f = await fixture(t); await f.receive(outer({ elements: [{ elementType: 1, textElement: { content: 'plain outer' } }] }));
  f.state.outerRead = async () => { f.state.identity = { user_id: BOT, online: true, sessionId: 'changed' }; return { result: 0, msgList: [outer()] }; };
  await assert.rejects(f.bridge.call('get_msg', { message_id: 1 }), { code: 'STALE_SESSION' });
  assert.equal(f.bridge.forwards.size, 0);
});

test('OneBot core returns the standard forward payload and preserves caller echo', async t => {
  const f = await fixture(t), token = await f.receive();
  const core = new OneBotCore({ freezeOnUnknown: true, bridge: f.bridge }); t.after(() => core.close());
  const response = await core.dispatch({ action: 'get_forward_msg', params: { id: token }, echo: { synthetic: [1, false] } });
  assert.equal(response.retcode, 0); assert.equal(response.status, 'ok');
  assert.deepEqual(response.echo, { synthetic: [1, false] });
  assert.equal(response.data.message[0].type, 'node'); assert.equal('messages' in response.data, false);
});
