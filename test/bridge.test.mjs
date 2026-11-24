import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { NativeBridge, MessageIndex } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN;
const FRIEND = '10001';
function raw(overrides = {}) {
  return { msgId: '90071992547409931', msgSeq: '51', msgTime: '1700000000', chatType: 2, peerUid: '20001', peerUin: '20001', senderUid: 'u_fixture', senderUin: FRIEND, sendNickName: 'Synthetic', elements: [{ elementType: 1, textElement: { content: 'hello' } }], ...overrides };
}
function fixture(options = {}) {
  const calls = [];
  let listener, groupListener;
  let nextId = 90071992547409939n;
  let nextFinalId = 91071992547409939n;
  let left = false;
  let identity = { user_id: BOT, nickname: 'Synthetic bot', online: true, sessionId: 'synthetic-session-A' };
  const members = new Map([['u_fixture', { uin: FRIEND, uid: 'u_fixture', nick: 'Synthetic', cardName: 'card', role: 2 }]]);
  const msg = {
    addKernelMsgListener(value) { listener = value; return 7; },
    removeKernelMsgListener(value) { calls.push(['remove-msg', value]); },
    generateMsgUniqueId() { return String(nextId++); },
    async sendMsg(...args) {
      calls.push(['send', ...args]);
      if (options.noReceipt) return { result: 0 };
      assert.equal(args[0], '0');
      queueMicrotask(() => listener.onMsgInfoListUpdate([raw({ msgId: String(nextFinalId++), guildId: args[1].guildId, peerUid: args[1].peerUid, chatType: args[1].chatType, senderUin: BOT, sendStatus: options.failReceipt ? 0 : 2, elements: args[2] })]));
      return { result: 0 };
    },
    async getMsgsByMsgId(peer, ids) { calls.push(['get', peer, ids]); return { result: 0, msgList: [raw()] }; },
    async recallMsg(...args) { calls.push(['recall', ...args]); return { result: 0 }; },
    async setMsgRead(...args) { calls.push(['read', ...args]); return { result: 0 }; },
    async setMsgEmojiLikes(...args) { calls.push(['emoji', ...args]); return { result: 0 }; },
  };
  const group = {
    addKernelGroupListener(value) { groupListener = value; return 8; },
    removeKernelGroupListener(value) { calls.push(['remove-group', value]); },
    async getUidByUins(uins) { calls.push(['resolve', uins]); return { errCode: 0, uids: new Map(uins.map((x) => [x, 'u_fixture'])) }; },
    async getGroupList(force) { calls.push(['groups', force]); queueMicrotask(() => groupListener.onGroupListUpdate(0, left ? [] : [{ groupCode: '20001', groupName: 'Synthetic Group', memberCount: 1, maxMember: 100 }])); return { result: 0 }; },
    async getGroupDetailInfo(code) { queueMicrotask(() => groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Synthetic Group', memberNum: 1, maxMemberNum: 100 })); return { result: 0 }; },
    async getAllMemberList() { return { errCode: 0, result: { infos: members, finish: true } }; },
    async setMemberShutUp(...args) { calls.push(['ban', ...args]); return { result: 0 }; },
    async setGroupShutUp(...args) { calls.push(['whole-ban', ...args]); return { result: 0 }; },
    async modifyGroupName(...args) { calls.push(['group-name', ...args]); return { result: 0 }; },
    modifyMemberCardName(code, uid, card) { calls.push(['card', code, uid, card]); if (!options.noReadback) members.get(uid).cardName = card; },
    modifyMemberRole(code, uid, role) { calls.push(['admin', code, uid, role]); if (!options.noReadback) members.get(uid).role = role; },
    async quitGroupV2(params) { calls.push(['leave', params]); if (!options.noReadback) left = true; return { result: 0 }; },
  };
  const buddy = { async getBuddyListV2() { return { result: 0, data: [{ buddyList: [{ uin: FRIEND, coreInfo: { nick: 'Synthetic', remark: 'fixture' } }] }] }; } };
  const profile = { async getUserDetailInfoByUin(uin) { return { result: 0, detail: { uin, simpleInfo: { coreInfo: { nick: 'Synthetic' }, baseInfo: { sex: 1, age: 20 } } } }; } };
  const bridge = new NativeBridge({ session: { getMsgService: () => msg, getGroupService: () => group, getBuddyService: () => buddy, getProfileService: () => profile, getRichMediaService: () => options.richMedia }, identityProbe: async () => identity, timeoutMs: 50, ...options.bridgeOptions });
  return { bridge, calls, msg, group, buddy, profile, members, setIdentity(value) { identity = value; }, receive(value) { listener.onRecvMsg(value); }, update(value) { listener.onMsgInfoListUpdate(value); }, get listener() { return listener; }, get groupListener() { return groupListener; } };
}

test('same-session reattachment rejects a new native session and clears old message IDs', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  const previous = f.bridge.messages.put(raw());
  f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
  await assert.rejects(f.bridge.reattach(), { code: 'STALE_SESSION' });
  assert.equal(f.bridge.attached, false);
  assert.throws(() => f.bridge.messages.get(previous), { code: 'MESSAGE_NOT_FOUND' });
  await f.bridge.attach();
  assert(f.bridge.messages.put(raw()) > previous);
});

test('native bridge is offline until explicit attachment and independent identity proof', async () => {
  const f = fixture();
  assert.deepEqual(f.bridge.capabilities(), []);
  await assert.rejects(f.bridge.call('get_login_info'), { code: 'OFFLINE' });
  await f.bridge.attach();
  assert.equal((await f.bridge.call('get_login_info')).user_id, Number(BOT));
  f.bridge.detach();
  assert.deepEqual(f.calls.slice(-2), [['remove-msg', 7], ['remove-group', 8]]);
});

test('input status maps the Agent Plus event values and checks explicit native completion', async t => {
  const f = fixture();
  f.msg.sendShowInputStatusReq = async (...args) => {
    f.calls.push(['input', ...args]);
    return { result: 0 };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  await f.bridge.call('set_input_status', { user_id: FRIEND, event_type: 1 });
  await f.bridge.call('set_input_status', { user_id: FRIEND, event_type: '0' });
  await assert.rejects(f.bridge.call('set_input_status', { user_id: FRIEND, event_type: false }), { code: 'INVALID_PARAMS' });
  await assert.rejects(f.bridge.call('set_input_status', { user_id: OWNER_UIN, event_type: 1 }), { code: 'PROTECTED_ACCOUNT' });
  assert.deepEqual(f.calls, [
    ['resolve', [FRIEND]], ['input', 1, 1, 'u_fixture'],
    ['resolve', [FRIEND]], ['input', 1, 0, 'u_fixture'],
  ]);
  f.msg.sendShowInputStatusReq = async () => undefined;
  await assert.rejects(f.bridge.call('set_input_status', { user_id: FRIEND, event_type: 1 }), { outcome: 'unknown' });
});

test('wrong account, offline identity and session replacement fail closed', async () => {
  for (const value of [{ user_id: OWNER_UIN, online: true, sessionId: 's' }, { user_id: BOT, online: false, sessionId: 's' }]) {
    const f = fixture(); f.setIdentity(value);
    await assert.rejects(f.bridge.attach(), { code: 'IDENTITY_REJECTED' });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await f.bridge.attach();
  f.setIdentity({ user_id: BOT, online: true, sessionId: 'different-session' });
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: 'no' }), { code: 'STALE_SESSION' });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 0);
});

test('positive control sends once and only returns after native confirmation', async () => {
  const f = fixture(); await f.bridge.attach();
  const result = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
  assert.ok(Number.isInteger(result.message_id));
  const send = f.calls.find(x => x[0] === 'send');
  assert.equal(send[1], '0');
  assert.deepEqual(send[2], { chatType: 2, peerUid: '20001', guildId: '90071992547409939' });
  assert.equal(f.bridge.messages.get(result.message_id).msgId, '91071992547409939');
  assert.deepEqual(send[3], [{ elementType: 1, textElement: { content: 'hello' } }]);
  assert.ok(send[4] instanceof Map);
  f.bridge.detach();
});

test('ack missing: accepted provisionally with no message_id and no retry', async () => {
  const f = fixture({ noReceipt: true }); await f.bridge.attach();
  const result = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
  // 等不到回执时按「已接受」放行：不编造 message_id，也不重发（否则会话会被运行端闸门挡住）
  assert.equal(result.message_id, null);
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  f.bridge.detach();
});

test('negative send receipt is not success', async () => {
  const f = fixture({ failReceipt: true }); await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' }), { code: 'SEND_FAILED', outcome: 'rejected' });
  f.bridge.detach();
});

test('unsupported element rejects entire compound message without partial send', async () => {
  const f = fixture(); await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: [{ type: 'text', data: { text: 'before' } }, { type: 'image', data: { file: 'synthetic.png' } }] }), { code: 'UNSUPPORTED_SEGMENT' });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 0);
  f.bridge.detach();
});

test('private peer resolves exact UIN to UID and protected account never resolves', async () => {
  const f = fixture(); await f.bridge.attach();
  await f.bridge.call('send_private_msg', { user_id: FRIEND, message: 'hello' });
  assert.equal(f.calls.find(x => x[0] === 'send')[2].peerUid, 'u_fixture');
  await assert.rejects(f.bridge.call('send_private_msg', { user_id: OWNER_UIN, message: 'no' }), { code: 'PROTECTED_ACCOUNT' });
  assert.equal(f.calls.filter(x => x[0] === 'resolve').length, 1);
  f.bridge.detach();
});

test('member mute preserves zero duration and stops before submission after a session change', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const request = { group_id: 20001, user_id: FRIEND, duration: 0 };
  assert.equal(await f.bridge.call('set_group_ban', request), null);
  assert.deepEqual(f.calls.find(entry => entry[0] === 'ban'), ['ban', '20001', [{ uid: 'u_fixture', timeStamp: 0 }]]);
  f.group.getUidByUins = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { errCode: 0, uids: new Map([[FRIEND, 'u_fixture']]) };
  };
  await assert.rejects(f.bridge.call('set_group_ban', request), { code: 'STALE_SESSION', outcome: 'not_started' });
  assert.equal(f.calls.filter(entry => entry[0] === 'ban').length, 1);
});

test('mute acknowledgments distinguish native rejection, missing result and changed session', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const request = { group_id: 20001, enable: false };
  let calls = 0;
  f.group.setGroupShutUp = (code, enable) => {
    assert.equal(code, '20001');
    assert.equal(enable, false);
    calls++;
    if (calls === 1) return { result: 1 };
    if (calls === 2) return { result: NaN };
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { result: 0 };
  };
  const call = () => f.bridge.call('set_group_whole_ban', request);
  await assert.rejects(call(), { code: 'NATIVE_REJECTED', outcome: 'rejected' });
  await assert.rejects(call(), { code: 'UNCONFIRMED', outcome: 'unknown' });
  await assert.rejects(call(), { code: 'UNCONFIRMED', outcome: 'unknown' });
  assert.equal(calls, 3);
});

test('private text checks the original session again after resolving its destination', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let resolutions = 0;
  f.group.getUidByUins = ids => {
    resolutions++;
    assert.deepEqual(ids, [FRIEND]);
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { errCode: 0, uids: new Map([[FRIEND, 'u_fixture']]) };
  };
  await assert.rejects(f.bridge.call('send_private_msg', { user_id: FRIEND, message: 'hello' }),
    { code: 'STALE_SESSION', outcome: 'not_started' });
  assert.equal(resolutions, 1);
  assert.equal(f.bridge.attached, false);
  assert(!f.calls.some(entry => entry[0] === 'send'));
});

test('native message ids remain exact and never collide or alias after eviction', () => {
  const index = new MessageIndex(2);
  const a = index.put(raw({ msgId: '9007199254740992' }));
  const b = index.put(raw({ msgId: '9007199254740993' }));
  assert.notEqual(a, b);
  assert.equal(index.get(a).msgId, '9007199254740992');
  const c = index.put(raw({ msgId: '9007199254740994' }));
  assert.notEqual(a, c);
  assert.throws(() => index.get(a), { code: 'MESSAGE_NOT_FOUND' });
  index.clear();
  assert.ok(index.put(raw()) > c);
});

test('batch event translation, self events and dedup are isolated from failing subscribers', async () => {
  const f = fixture(); await f.bridge.attach();
  const got = [];
  f.bridge.on('event', () => { throw new Error('subscriber'); });
  f.bridge.on('event', event => got.push(event));
  f.receive([raw(), raw(), raw({ msgId: '90071992547409932', senderUin: BOT })]);
  await tick();
  assert.equal(got.length, 2);
  assert.equal(got[0].post_type, 'message');
  assert.equal(got[1].post_type, 'message_sent');
  assert.equal(got[0].raw_message, 'hello');
  assert.equal(f.bridge.stats.subscriberErrors, 2);
  f.bridge.detach();
});

test('wrong-identity incoming event is discarded before any subscriber', async () => {
  const f = fixture(); await f.bridge.attach();
  const events = []; f.bridge.on('event', e => events.push(e));
  f.setIdentity({ user_id: OWNER_UIN, online: true, sessionId: 'synthetic-session-A' });
  f.receive([raw()]); await tick();
  assert.equal(events.length, 0);
  assert.equal(f.bridge.attached, false);
});

test('incoming events cannot mint message IDs until identity verification completes', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let resume;
  f.bridge.identityProbe = () => new Promise(resolve => { resume = resolve; });
  const message = raw();
  const events = [];
  f.bridge.on('event', event => events.push(event));
  f.receive([message, raw({ msgId: '90071992547409945', peerUid: 'invalid-group' })]);
  assert.equal(f.bridge.messages.byId.size, 0);
  await tick();
  message.elements[0].textElement.content = 'changed after callback';
  resume({ user_id: BOT, online: true, sessionId: 'synthetic-session-A' });
  await tick();
  assert.equal(f.bridge.eventPending, 0);
  assert.equal(f.bridge.messages.byId.size, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].raw_message, 'hello');
  assert.equal(f.bridge.messages.get(events[0].message_id).elements[0].textElement.content, 'hello');
  assert.equal(f.bridge.stats.malformedEvents, 1);
});

test('old callbacks cannot enter a detached session', async () => {
  const f = fixture(); await f.bridge.attach();
  const callback = f.listener;
  const events = []; f.bridge.on('event', e => events.push(e));
  f.bridge.detach(); await f.bridge.attach();
  callback.onRecvMsg([raw()]); await tick();
  assert.equal(events.length, 0);
  f.bridge.detach();
});

test('get/recall/read/emoji preserve native message context', async () => {
  const f = fixture(); await f.bridge.attach();
  f.receive([raw()]); await tick();
  const result = await f.bridge.call('get_msg', { message_id: 1 });
  assert.equal(result.message_id, 1);
  await f.bridge.call('delete_msg', { message_id: 1 });
  await f.bridge.call('mark_msg_as_read', { message_id: 1 });
  await f.bridge.call('set_msg_emoji_like', { message_id: 1, emoji_id: '66' });
  assert.deepEqual(f.calls.find(x => x[0] === 'recall')[2], ['90071992547409931']);
  assert.deepEqual(f.calls.find(x => x[0] === 'emoji').slice(2), ['51', '66', '1', true]);
  f.bridge.detach();
});

test('reaction writes re-read the group message and use the current exact sequence', async t => {
  const f = fixture();
  const currentSequence = '9007199254740993';
  let message = raw({ msgSeq: currentSequence });
  f.msg.getMsgsByMsgId = () => ({ result: 0, msgList: [message] });
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const message_id = f.bridge.messages.put(raw({ msgSeq: undefined }));
  const params = { message_id, emoji_id: '128077', set: 'false' };
  assert.equal(await f.bridge.call('set_msg_emoji_like', params), null);
  const privateId = f.bridge.messages.put(raw({ chatType: 1, peerUid: 'u_fixture' }));
  await assert.rejects(f.bridge.call('set_msg_emoji_like', { ...params, message_id: privateId }), { code: 'INVALID_PARAMS' });
  await assert.rejects(f.bridge.call('set_msg_emoji_like', { ...params, set: 'maybe' }), { code: 'INVALID_PARAMS' });
  message = { ...message, senderUid: 'u_other' };
  await assert.rejects(f.bridge.call('set_msg_emoji_like', params), { code: 'INVALID_NATIVE_RESPONSE' });
  message = { ...message, peerUid: '20002' };
  await assert.rejects(f.bridge.call('set_msg_emoji_like', params), { code: 'MESSAGE_NOT_FOUND' });
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'emoji'),
    [['emoji', { chatType: 2, peerUid: '20001', guildId: '' }, currentSequence, '128077', '2', false]]);
});

test('a reaction acknowledgment after a session change is an unknown write outcome', async t => {
  const f = fixture();
  let writes = 0;
  f.msg.setMsgEmojiLikes = () => {
    writes++;
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { result: 0 };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const message_id = f.bridge.messages.put(raw());
  await assert.rejects(f.bridge.call('set_msg_emoji_like', { message_id, emoji_id: 66 }),
    { code: 'UNCONFIRMED', outcome: 'unknown' });
  assert.equal(writes, 1);
});

test('read actions resolve one typed target and require a native acknowledgment', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  f.buddy.isBuddy = async uid => uid === 'u_fixture';
  const call = (action, params) => f.bridge.call(action, params);
  assert.equal(await call('mark_group_msg_as_read', { group_id: 20001 }), null);
  assert.equal(await call('mark_private_msg_as_read', { user_id: FRIEND }), null);
  const groupMessage = f.bridge.messages.put(raw());
  await assert.rejects(call('mark_private_msg_as_read', { message_id: groupMessage }), { code: 'INVALID_PARAMS' });
  await assert.rejects(call('mark_msg_as_read', { user_id: FRIEND, group_id: 20001 }), TypeError);
  await assert.rejects(call('mark_private_msg_as_read', { user_id: OWNER_UIN }), { code: 'PROTECTED_ACCOUNT' });
  f.buddy.isBuddy = async () => false;
  await assert.rejects(call('mark_private_msg_as_read', { user_id: FRIEND }), { code: 'FRIEND_UNVERIFIED' });
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'read'), [
    ['read', { chatType: 2, peerUid: '20001', guildId: '' }],
    ['read', { chatType: 1, peerUid: 'u_fixture', guildId: '' }],
  ]);
  f.msg.setMsgRead = async () => ({});
  await assert.rejects(call('mark_group_msg_as_read', { group_id: 20001 }), { code: 'UNCONFIRMED', outcome: 'unknown' });
});

test('translation checks native completion, preserves order, and exposes only translated words', async t => {
  const f = fixture();
  let result = { result: 0, words: ['鲸鱼', '海洋'], ignored: 'extra field' };
  let calls = 0;
  f.bridge.session.getRichMediaService = () => ({
    translateEnWordToZn(words) {
      calls++;
      assert.deepEqual(words, ['whale', 'ocean']);
      return result;
    },
  });
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const call = words => f.bridge.call('translate_en2zh', { words });
  assert.deepEqual(await call(['whale', 'ocean']), { words: ['鲸鱼', '海洋'] });
  await assert.rejects(call(['']), TypeError);
  assert.equal(calls, 1);
  result = { result: 1, words: [] };
  await assert.rejects(call(['whale', 'ocean']), { code: 'NATIVE_REJECTED' });
  result = { result: 0, words: ['鲸鱼'] };
  await assert.rejects(call(['whale', 'ocean']), { code: 'INVALID_NATIVE_RESPONSE' });
});

test('extended group query binds the requested group and only publishes requested numeric fields', async t => {
  const f = fixture();
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => { core.close(); f.bridge.detach(); });
  const params = { group_id: '20001' };
  const read = () => core.dispatch({ action: 'get_group_info_ex', params });
  assert.equal((await read()).retcode, 1404);
  const info = { groupCode: '20001', resultCode: 0,
    extInfo: { essentialMsgSwitch: 0, inviteRobotSwitch: 1, groupOwnerId: { memberUid: 'synthetic-private' } } };
  const response = value => ({ errCode: 0, result: { groupExtInfos: new Map([['20001', value]]) } });
  let result = response(info);
  f.group.getGroupExt0xEF0Info = (requested, excluded, filter, forced) => {
    assert.deepEqual(requested, ['20001']);
    assert.deepEqual(excluded, []);
    assert.equal(filter.essentialMsgSwitch, 1);
    assert.equal(filter.groupOwnerId, undefined);
    assert.equal(forced, true);
    return result;
  };
  assert.deepEqual((await read()).data, { groupCode: '20001', resultCode: 0,
    extInfo: { essentialMsgSwitch: 0, inviteRobotSwitch: 1 } });
  result = response({ ...info, groupCode: '20002' });
  assert.equal((await read()).retcode, 1502);
  result = response({ ...info, resultCode: 1 });
  assert.equal((await read()).retcode, 1500);
  result = response({ ...info, extInfo: { essentialMsgSwitch: '1' } });
  assert.equal((await read()).retcode, 1502);
  f.group.getGroupExt0xEF0Info = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'other-session' });
    return response(info);
  };
  await assert.rejects(f.bridge.call('get_group_info_ex', params), { code: 'STALE_SESSION' });
});

test('group share links preserve native request options and reject unexpected URLs', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const read = params => f.bridge.call('get_group_share_link', { group_id: '20001', ...params });
  await assert.rejects(read(), { code: 'UNSUPPORTED' });
  const calls = [];
  let response = { result: 0, url: 'https://qm.qq.com/q/Fixture' };
  f.group.getJoinGroupLink = request => { calls.push(request); return response; };
  assert.deepEqual(await read(), { url: response.url });
  response = { result: 0, url: 'https://qun.qq.com/universal-share/share?fixture=1' };
  assert.deepEqual(await read({ need_short_url: 'false', src_id: '74', additional_param: 'fixture=1' }), { url: response.url });
  assert.deepEqual(calls, [
    { groupCode: '20001', needShortUrl: true, srcId: 73, additionalParam: '' },
    { groupCode: '20001', needShortUrl: false, srcId: 74, additionalParam: 'fixture=1' },
  ]);
  await assert.rejects(read({ need_short_url: 'yes' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(read({ src_id: '2147483648' }), { code: 'INVALID_PARAMS' });
  assert.equal(calls.length, 2);
  for (const url of ['http://qm.qq.com/q/Fixture', 'https://qm.qq.com.example.invalid/q/Fixture',
    'https://user@qm.qq.com/q/Fixture', 'https://qun.qq.com/unknown']) {
    response = { result: 0, url };
    await assert.rejects(read(), { code: 'INVALID_NATIVE_RESPONSE' });
  }
  response = { result: 1, url: 'https://qm.qq.com/q/Fixture' };
  await assert.rejects(read(), { code: 'NATIVE_REJECTED' });
  f.group.getJoinGroupLink = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'other-session' });
    return { result: 0, url: 'https://qm.qq.com/q/Fixture' };
  };
  await assert.rejects(read(), { code: 'STALE_SESSION' });
});

test('group mention quota accepts zero and rejects malformed or stale native responses', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const atInfo = { canAtAll: false, RemainAtAllCountForGroup: 3, RemainAtAllCountForUin: 0 };
  let result = { errCode: 0, atInfo };
  f.group.getGroupRemainAtTimes = code => {
    assert.equal(code, '20001');
    return result;
  };
  const quota = () => f.bridge.call('get_group_at_all_remain', { group_id: 20001 });
  assert.deepEqual(await quota(), {
    can_at_all: false, remain_at_all_count_for_group: 3, remain_at_all_count_for_uin: 0,
  });
  result = { errCode: 1, atInfo };
  await assert.rejects(quota(), { code: 'NATIVE_REJECTED' });
  result = { errCode: 0, atInfo: { ...atInfo, RemainAtAllCountForUin: '0' } };
  await assert.rejects(quota(), { code: 'INVALID_NATIVE_RESPONSE' });
  f.group.getGroupRemainAtTimes = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'other-session' });
    return { errCode: 0, atInfo };
  };
  await assert.rejects(quota(), { code: 'STALE_SESSION' });
});

test('group mute list binds its callback and requires an explicit acknowledgment', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const member = { uin: FRIEND, nick: 'Fixture', shutUpTime: 1700000000, avatarPath: 'private/path' };
  let list = [member], acknowledgment = 0;
  f.group.getGroupShutUpMemberList = code => {
    assert.equal(code, '20001');
    f.groupListener.onShutUpMemberListChanged('20002', []);
    f.groupListener.onShutUpMemberListChanged(code, list);
    return { result: acknowledgment };
  };
  const read = () => f.bridge.call('get_group_shut_list', { group_id: 20001 });
  assert.deepEqual(await read(), [{ uin: FRIEND, nick: member.nick, shutUpTime: member.shutUpTime,
    user_id: Number(FRIEND), nickname: member.nick, shut_up_time: member.shutUpTime }]);
  list = [];
  assert.deepEqual(await read(), []);
  acknowledgment = 1;
  await assert.rejects(read(), { code: 'NATIVE_REJECTED' });
  acknowledgment = 0;
  list = [member, member];
  await assert.rejects(read(), { code: 'INVALID_NATIVE_RESPONSE' });
});

test('mute-list tracking capacity does not block group details', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let muteQueries = 0;
  f.group.getGroupShutUpMemberList = () => {
    muteQueries++;
    return { result: 0 };
  };
  for (let i = 0; i < 128; i++)
    f.bridge.unconfirmedGroupMuteReads.add('group-muted:' + (30000 + i));
  await assert.rejects(f.bridge.call('get_group_shut_list', { group_id: 20001 }), { code: 'UNCONFIRMED' });
  assert.equal(muteQueries, 0);
  const detail = await f.bridge.call('get_group_info', { group_id: 20001 });
  assert.equal(detail.group_id, 20001);
});

test('group folder deletion requires an explicit folder and both native result codes', async t => {
  const good = { result: 0, groupFileCommonResult: { retCode: 0, clientWording: 'synthetic native metadata' } };
  let reply = good;
  const calls = [];
  const richMedia = { async deleteGroupFolder(...args) { calls.push(args); return reply; } };
  const f = fixture({ richMedia });
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const request = { group_id: 20001, folder: '/test_folder' };
  assert(f.bridge.capabilities().includes('delete_group_folder'));
  const remove = params => f.bridge.call('delete_group_folder', params);
  for (const params of [
    { group_id: 20001 }, { ...request, folder: '/' }, { ...request, folder: '/../unsafe' },
    { ...request, folder_id: 'other' }, { ...request, start_index: 0 }, { ...request, group_id: [20001] },
  ]) await assert.rejects(remove(params), TypeError);
  assert.deepEqual(calls, []);
  assert.deepEqual(await remove(request), { retCode: 0, retMsg: '', clientWording: '' });
  assert.deepEqual(calls, [['20001', '/test_folder']]);
  reply = { result: 0 };
  await assert.rejects(remove(request), { code: 'UNCONFIRMED', outcome: 'unknown' });
  reply = { result: 0, groupFileCommonResult: { retCode: 1 } };
  await assert.rejects(remove(request), { code: 'NATIVE_REJECTED', outcome: 'rejected' });
  richMedia.deleteGroupFolder = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'different-session' });
    return good;
  };
  await assert.rejects(remove(request), { code: 'STALE_SESSION', outcome: 'unknown' });
});

test('friend request decisions bind the emitted flag to one account and an exact native callback', async t => {
  const f = fixture();
  let listener;
  const submissions = [];
  const row = { friendUid: 'u_request', reqTime: '1700000000', reqType: 1, isDecide: false, extWords: 'fixture' };
  f.buddy.addKernelBuddyListener = value => { listener = value; return 9; };
  f.buddy.removeKernelBuddyListener = handle => assert.equal(handle, 9);
  f.profile.getCoreAndBaseInfo = (_source, [uid]) => new Map([[uid, { coreInfo: {
    uid, uin: uid === 'u_protected' ? OWNER_UIN : '10001',
  } }]]);
  f.buddy.approvalFriendRequest = args => {
    submissions.push(args);
    const reqTime = args.reqTime === '1700000002' ? row.reqTime : args.reqTime;
    listener.onBuddyReqChange({ buddyReqs: [{ ...row, reqTime, reqType: args.accept ? 3 : 7, isDecide: true }] });
    if (args.reqTime === '1700000003') return Promise.reject(new Error('Synthetic native call failed after callback'));
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  assert(f.bridge.capabilities().includes('set_friend_add_request'));
  const events = [];
  f.bridge.on('event', event => events.push(event));
  listener.onBuddyReqChange({ buddyReqs: [row, row, { ...row, friendUid: 'u_protected' }] });
  await tick();
  assert.equal(events.length, 1);
  const { flag, user_id, request_type } = events[0];
  assert.deepEqual([user_id, request_type], [10001, 'friend']);
  assert.match(flag, /^friend-[a-f0-9]{32}$/);
  await assert.rejects(f.bridge.call('set_friend_add_request', { flag: row.reqTime }), { code: 'INVALID_PARAMS' });
  assert.equal(await f.bridge.call('set_friend_add_request', { flag, approve: false }), null);
  await assert.rejects(f.bridge.call('set_friend_add_request', { flag }), { code: 'INVALID_PARAMS' });
  assert.deepEqual(submissions, [{ friendUid: 'u_request', reqTime: row.reqTime, accept: false }]);

  const second = { ...row, reqTime: '1700000001' };
  listener.onBuddyReqChange({ buddyReqs: [second, { ...row, reqTime: '1700000002' }] });
  await tick();
  assert.equal(events.length, 3);
  assert.equal(await f.bridge.call('set_friend_add_request', { flag: events[1].flag }), null);
  await assert.rejects(f.bridge.call('set_friend_add_request', { flag: events[2].flag }), { code: 'TIMEOUT', outcome: 'unknown' });
  await assert.rejects(f.bridge.call('set_friend_add_request', { flag: events[2].flag }), { code: 'INVALID_PARAMS' });
  assert.equal(submissions.length, 3);
  listener.onBuddyReqChange({ buddyReqs: [{ ...row, reqTime: '1700000003' }] });
  await tick();
  assert.equal(events.length, 4);
  await assert.rejects(f.bridge.call('set_friend_add_request', { flag: events[3].flag }),
    { code: 'NATIVE_CALL_FAILED', outcome: 'unknown' });
  await assert.rejects(f.bridge.call('set_friend_add_request', { flag: events[3].flag }), { code: 'INVALID_PARAMS' });
  assert.equal(submissions.length, 4);
});

test('a repeated friend request can recover from a transient profile lookup without issuing a second flag', async t => {
  const f = fixture();
  let listener;
  let lookups = 0;
  const row = { friendUid: 'u_request', reqTime: '1700000000', reqType: 1, isDecide: false, extWords: 'fixture' };
  f.buddy.addKernelBuddyListener = value => { listener = value; return 9; };
  f.buddy.removeKernelBuddyListener = () => {};
  f.buddy.approvalFriendRequest = () => assert.fail('Read-only retry must not submit a decision');
  f.profile.getCoreAndBaseInfo = async (_source, [uid]) => {
    if (++lookups === 1) throw new Error('Synthetic profile cache unavailable');
    return new Map([[uid, { coreInfo: { uid, uin: '10001' } }]]);
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const events = [];
  f.bridge.on('event', event => events.push(event));
  const notify = () => listener.onBuddyReqChange({ buddyReqs: [row, row] });
  notify();
  notify();
  await tick();
  assert.equal(lookups, 1);
  assert.deepEqual(events, []);
  notify();
  await tick();
  notify();
  await tick();
  assert.equal(lookups, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, 10001);
  assert.match(events[0].flag, /^friend-[a-f0-9]{32}$/);
});

test('new friend requests reclaim decided entries without reviving retired requests', async t => {
  const f = fixture();
  let listener;
  const submissions = [];
  const row = (time, uid = 'u_request') => ({ friendUid: uid, reqTime: String(time), reqType: 1, isDecide: false, extWords: 'fixture' });
  const notify = (...rows) => listener.onBuddyReqChange({ buddyReqs: rows });
  f.buddy.addKernelBuddyListener = value => { listener = value; return 9; };
  f.buddy.removeKernelBuddyListener = () => {};
  f.profile.getCoreAndBaseInfo = (_source, [uid]) => new Map([[uid, { coreInfo: { uid, uin: uid === 'u_request' ? '10001' : '10002' } }]]);
  f.buddy.approvalFriendRequest = decision => {
    submissions.push([decision.reqTime, decision.friendUid]);
    notify({ ...row(decision.reqTime, decision.friendUid), isDecide: true, reqType: 7 });
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const events = new Map();
  f.bridge.on('event', event => {
    const key = `${event.time}:${event.user_id}`;
    assert(!events.has(key));
    events.set(key, event.flag);
  });
  const first = 1700000000;
  const newest = first + 256;
  for (const start of [first, first + 128]) {
    notify(...Array.from({ length: 128 }, (_, index) => row(start + index)));
    await tick();
  }
  assert.equal(events.size, 256);
  notify(row(newest));
  await tick();
  assert.equal(events.size, 256);
  const decide = (time, account = 10001) => f.bridge.call('set_friend_add_request', { flag: events.get(`${time}:${account}`), approve: false });
  await decide(first);
  notify(row(first, 'u_same_second'), row(first));
  await tick();
  assert(events.has(`${first}:10002`));
  await decide(first, 10002);
  notify(row(newest));
  await tick();
  await decide(first + 1);
  notify(row(first), row(newest + 1));
  await tick();
  assert.equal(events.size, 259);
  assert(f.bridge.friendRequests.size <= 256);
  assert.equal(f.bridge.stats.subscriberErrors, 0);
  await assert.rejects(decide(first), { code: 'INVALID_PARAMS' });
  await decide(newest);
  assert.deepEqual(submissions, [[first, 'u_request'], [first, 'u_same_second'], [first + 1, 'u_request'], [newest, 'u_request']]
    .map(([time, uid]) => [String(time), uid]));
});

test('favorite face lookup returns HTTPS addresses without local paths and rejects malformed pages', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  assert(!f.bridge.capabilities().includes('fetch_custom_face'));
  const url = 'https://example.invalid/face.png';
  let reply = { result: 0, emojiInfoList: [{ url, emoPath: 'private/cache/face.png' }] };
  let calls = 0;
  f.msg.fetchFavEmojiList = (...args) => {
    calls++;
    assert.deepEqual(args, ['', 1, true, true]);
    return reply;
  };
  const fetchFaces = count => f.bridge.call('fetch_custom_face', { count });
  assert.deepEqual(await fetchFaces('1'), [url]);
  await assert.rejects(fetchFaces(501), TypeError);
  assert.equal(calls, 1);
  for (const emojiInfoList of [[{ url: 'file:///private/cache/face.png' }], [{ url: 'https://user:secret@example.invalid/a' }],
    [{ url }, { url }], [{}]]) {
    reply = { result: 0, emojiInfoList };
    await assert.rejects(fetchFaces(1), { code: 'INVALID_NATIVE_RESPONSE' });
  }
  reply = { result: 1, emojiInfoList: [] };
  await assert.rejects(fetchFaces(1), { code: 'NATIVE_REJECTED' });
});

test('ordinary faces use the native classic and extended types and reject ambiguous IDs before submission', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const send = message => f.bridge.call('send_group_msg', { group_id: 20001, message });
  await send('[CQ:face,id=0][CQ:face,id=221][CQ:face,id=222]');
  for (const id of ['', ' 14', true, '0xE', '1e2', '01', 100001]) {
    await assert.rejects(send([{ type: 'at', data: { qq: FRIEND } }, { type: 'face', data: { id } }]),
      { code: 'INVALID_PARAMS' });
  }
  const sends = f.calls.filter(([action]) => action === 'send');
  assert.equal(sends.length, 1);
  assert.equal(f.calls.filter(([action]) => action === 'resolve').length, 0);
  assert.deepEqual(sends[0][3], [
    { elementType: 6, faceElement: { faceIndex: 0, faceType: 1 } },
    { elementType: 6, faceElement: { faceIndex: 221, faceType: 1 } },
    { elementType: 6, faceElement: { faceIndex: 222, faceType: 2 } },
  ]);
});

test('indexed message readback rejects sender substitution and ambiguous matches', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const original = raw();
  const id = f.bridge.messages.put(original);
  for (const msgList of [
    [raw({ senderUin: '10002' })], [raw({ senderUid: 'u_other' })], [raw(), raw()],
  ]) {
    f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList });
    for (const action of ['get_msg', 'get_msg_emoji_likes'])
      await assert.rejects(f.bridge.call(action, { message_id: id }), { code: 'INVALID_NATIVE_RESPONSE' });
    assert.deepEqual(f.bridge.messages.get(id), original);
  }
});

test('get_msg projects the matched message without reading unsupported native metadata', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const original = raw();
  const id = f.bridge.messages.put(original);
  const native = raw({ extraCounter: 1n });
  const [element] = native.elements;
  element.extraCounter = 1n;
  Object.defineProperty(element.textElement, 'extraGetter', { enumerable: true, get() { assert.fail('Read extra text metadata'); } });
  native.elements.push({ elementType: 1, textElement: { content: '@fixture', atType: 2, atUid: FRIEND, extraCounter: 1n } });
  Object.defineProperty(native, 'extraGetter', { enumerable: true, get() { assert.fail('Read extra message metadata'); } });
  const response = { result: 0, msgList: [raw({ peerUid: '20002', extraCounter: 1n }), native] };
  Object.defineProperty(response, 'extra', { enumerable: true, get() { assert.fail('Read extra response metadata'); } });
  f.msg.getMsgsByMsgId = async () => response;
  const message = await f.bridge.call('get_msg', { message_id: id });
  assert.equal(message.message_id, id);
  assert.equal(message.group_id, 20001);
  assert.equal(message.user_id, Number(FRIEND));
  assert.equal(message.raw_message, `hello[CQ:at,qq=${FRIEND}]`);
  assert.deepEqual(message.message, [{ type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: FRIEND } }]);
  assert(!Object.hasOwn(f.bridge.messages.get(id), 'extraCounter'));
  assert.deepEqual(f.bridge.messages.get(id).elements[0], { elementType: 1, textElement: { content: 'hello' } });
  Object.defineProperty(element.textElement, 'content', { configurable: true, get() { assert.fail('Evaluated content getter'); } });
  await assert.rejects(f.bridge.call('get_msg', { message_id: id }), { code: 'INVALID_NATIVE_RESPONSE' });
  Object.defineProperty(element.textElement, 'content', { value: 'hello' });
  Object.defineProperty(native, 'senderUin', { get() { assert.fail('Evaluated sender getter'); } });
  await assert.rejects(f.bridge.call('get_msg', { message_id: id }), { code: 'INVALID_NATIVE_RESPONSE' });
  assert.equal(f.bridge.messages.get(id).senderUin, FRIEND);
});

test('indexed message readback does not overwrite a newer update while identity is being checked', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const id = f.bridge.messages.put(raw());
  const fresh = raw({ sendNickName: 'New update' });
  const probe = f.bridge.probe.bind(f.bridge);
  let verify, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let probes = 0;
  f.bridge.probe = async () => {
    if (++probes === 2) await new Promise(resolve => { verify = resolve; entered(); });
    return probe();
  };
  const read = f.bridge.call('get_msg', { message_id: id });
  await Promise.race([started, read]);
  assert.equal(typeof verify, 'function');
  f.bridge.messages.put(fresh);
  verify();
  await assert.rejects(read, { code: 'MESSAGE_NOT_FOUND' });
  assert.deepEqual(f.bridge.messages.get(id), fresh);
});

test('reply accepts cached same-chat message and rejects cross-chat references', async () => {
  const f = fixture(); await f.bridge.attach();
  f.receive([raw({ msgSeq: '90071992547409933', clientSeq: '90071992547409935' })]); await tick();
  await f.bridge.call('send_group_msg', { group_id: 20001, message: '[CQ:reply,id=1]hello' });
  const [reply, body] = f.calls.find(x => x[0] === 'send')[3];
  assert.deepEqual(reply, { elementType: 7, elementId: '', replyElement: {
    replayMsgId: '90071992547409931', replayMsgSeq: '90071992547409933', replyMsgClientSeq: '90071992547409935',
    senderUin: FRIEND, senderUinStr: FRIEND, senderUidStr: 'u_fixture', replyMsgTime: '1700000000',
  } });
  assert.equal(body.textElement.content, 'hello');
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20002, message: '[CQ:reply,id=1]hello' }), { code: 'INVALID_PARAMS' });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  f.bridge.detach();
});

test('reply refuses invalid sequences and a protected sender before native submission', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  for (const [overrides, code] of [
    [{ msgSeq: '0' }, 'INVALID_PARAMS'],
    [{ msgSeq: '9223372036854775808' }, 'INVALID_PARAMS'],
    [{ clientSeq: 9007199254740992 }, 'INVALID_PARAMS'],
    [{ senderUin: OWNER_UIN }, 'PROTECTED_ACCOUNT'],
  ]) {
    const id = f.bridge.messages.put(raw(overrides));
    await assert.rejects(f.bridge.call('send_group_msg', {
      group_id: 20001, message: '[CQ:reply,id=' + id + ']hello',
    }), { code });
  }
  assert(!f.calls.some(entry => entry[0] === 'send'));
});

test('incoming embedded reply references resolve only to an existing matching conversation record', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const original = raw();
  const id = f.bridge.messages.put(original);
  const replyElement = { sourceMsgIdInRecords: original.msgId, replayMsgId: '0',
    senderUinStr: FRIEND, replayMsgSeq: original.msgSeq };
  const translate = (records, fields = {}) => f.bridge.translate(raw({
    msgId: '90071992547409940', records,
    elements: [{ elementType: 7, replyElement: { ...replyElement, ...fields } }],
  }));
  assert.deepEqual(translate([original]).message, [{ type: 'reply', data: { id: String(id) } }]);
  for (const [records, fields] of [
    [[{ ...original, peerUid: '20002' }], {}],
    [[original, original], {}],
    [[{ ...original, senderUin: '10003' }], {}],
    [[original], { replayMsgId: '90071992547409941' }],
    [[original], { replayMsgSeq: '99' }],
  ]) assert.equal(translate(records, fields).message[0].type, 'qq_unknown');

  const unseen = { ...original, msgId: '90071992547409999' };
  assert.equal(translate([unseen], { sourceMsgIdInRecords: unseen.msgId }).message[0].type, 'qq_unknown');
  assert.equal(f.bridge.messages.find({ chatType: 2, peerUid: '20001' }, unseen.msgId), undefined);
});

test('incoming file segments expose display metadata without local paths and retain exact sizes', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const fileElement = {
    fileName: 'Synthetic audio.m4a', fileSize: '9007199254740993',
    fileUuid: 'synthetic-file-uuid', filePath: 'private/file', url: 'https://example.invalid/',
  };
  const make = fields => raw({ elements: [{ elementType: 3, fileElement: { ...fileElement, ...fields } }] });
  const event = f.bridge.translate(make());
  assert.deepEqual(event.message, [{ type: 'file', data: {
    name: fileElement.fileName, file: fileElement.fileName, file_size: fileElement.fileSize, file_id: fileElement.fileUuid,
  } }]);
  assert.doesNotMatch(JSON.stringify(event), /private\/file|example\.invalid/);
  assert.equal(f.bridge.translate(make({ fileName: '../synthetic' })).message[0].type, 'qq_unknown');
  assert.equal(f.bridge.translate(make({ fileSize: '18446744073709551616' })).message[0].type, 'qq_unknown');
  assert.equal(f.bridge.translate(make({ fileUuid: undefined })).message[0].data.file_id, undefined);
});

test('incoming media keeps explicit QQ HTTPS URLs and treats local or unknown locations as metadata only', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const origin = 'https://multimedia.nt.qq.com.cn/download?fileid=synthetic';
  const image = (fields) => ({ elementType: 2, picElement: { fileName: 'synthetic.png', ...fields } });
  const event = f.bridge.translate(raw({ elements: [
    image({ originImageUrl: origin, summary: '[synthetic]' }),
    image({ picUrl: 'https://gchat.qpic.cn/synthetic.png', originImageUrl: origin }),
    image({ originImageUrl: '/download?fileid=synthetic', filePath: 'private/cache' }),
    image({ picUrl: 'https://gchat.qpic.cn.example.invalid/download' }),
    image({ picUrl: 'https://gchat.qpic.cn@127.0.0.1/download' }),
    image({ picUrl: 'https://gchat.qpic.cn/a b' }),
    image({ fileName: 'file:synthetic.png' }),
    { elementType: 4, pttElement: { fileName: 'synthetic.silk', filePath: 'private/cache' } },
  ] }));
  assert.deepEqual(event.message[0].data, { file: 'synthetic.png', url: origin, summary: '[synthetic]' });
  assert.equal(event.message[1].data.url, 'https://gchat.qpic.cn/synthetic.png');
  for (const item of event.message.slice(2, 6)) assert.deepEqual(item.data, { file: 'synthetic.png' });
  assert.equal(event.message[6].type, 'qq_unknown');
  assert.deepEqual(event.message[7], { type: 'record', data: { file: 'synthetic.silk' } });
  assert.doesNotMatch(JSON.stringify(event), /private\/cache|127\.0\.0\.1|example\.invalid/);
  const relative = '/download?appid=1407&fileid=fixture-id&rkey=fixture-key';
  const relativeMedia = f.bridge.translate(raw({ elements: [image({ originImageUrl: relative }),
    image({ originImageUrl: relative + '&appid=1406' }), image({ originImageUrl: '//example.invalid' + relative }),
    image({ originImageUrl: relative.replace('1407', '9999') }), image({ originImageUrl: relative.replace('fixture-key', '') }),
  ] })).message;
  assert.equal(relativeMedia[0].data.url, 'https://multimedia.nt.qq.com.cn' + relative);
  assert(relativeMedia.slice(1).every(segment => segment.data.url === undefined));
});

test('a picture with only a 32-hex md5 builds a stable gchatpic_new CDN URL', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const md5 = 'AA8635BF87D7DE2BE0AA570508C7706F'; // 32 hex chars
  const event = f.bridge.translate(raw({ elements: [
    { elementType: 2, picElement: { fileName: `${md5}.jpg`, md5HexStr: md5.toLowerCase() } },
    { elementType: 2, picElement: { fileName: 'synthetic.png', md5HexStr: 'not-a-md5' } },
  ] }));
  assert.deepEqual(event.message[0].data, { file: `${md5}.jpg`, url: `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5}/0` });
  assert.equal(event.message[1].data.url, undefined);
});

test('group and friend queries consume native callback and result contracts', async () => {
  const f = fixture(); await f.bridge.attach();
  assert.equal((await f.bridge.call('get_group_list'))[0].group_id, 20001);
  assert.equal((await f.bridge.call('get_group_info', { group_id: 20001 })).group_name, 'Synthetic Group');
  assert.equal((await f.bridge.call('get_group_member_list', { group_id: 20001 }))[0].role, 'member');
  assert.equal((await f.bridge.call('get_group_member_info', { group_id: 20001, user_id: FRIEND })).card, 'card');
  assert.equal((await f.bridge.call('get_friend_list'))[0].remark, 'fixture');
  assert.equal((await f.bridge.call('get_stranger_info', { user_id: FRIEND })).sex, 'male');
  f.bridge.detach();
});

test('group list requires a successful native acknowledgment and preserves the callback snapshot', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const list = () => f.bridge.call('get_group_list', { no_cache: true });
  let result = 1;
  f.group.getGroupList = fresh => {
    assert.equal(fresh, true);
    const group = { groupCode: '20001', groupName: 'Original', memberCount: 1, maxMember: 100 };
    f.groupListener.onGroupListUpdate(0, [group]);
    group.groupName = 'Changed after callback';
    return { result };
  };
  await assert.rejects(list(), { code: 'NATIVE_REJECTED' });
  result = 0;
  assert.equal((await list())[0].group_name, 'Original');
  f.group.getGroupList = () => {
    const groups = [{ groupCode: '20001' }, { groupCode: '20001' }];
    f.groupListener.onGroupListUpdate(0, groups);
    return { result: 0 };
  };
  await assert.rejects(list(), { code: 'INVALID_NATIVE_RESPONSE' });
});

test('standard group info requires a matching callback and the original session after acknowledgment', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  f.group.getGroupDetailInfo = (code, source) => {
    assert.equal(source, 1);
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    f.groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Synthetic Group' });
    return { result: 0 };
  };
  await assert.rejects(f.bridge.call('get_group_info', { group_id: 20001 }), { code: 'STALE_SESSION' });
});

test('a timed-out group callback cannot satisfy a subsequent request, including after reattachment', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let calls = 0;
  f.group.getGroupDetailInfo = code => {
    calls++;
    if (code === '20002')
      f.groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Other group' });
    return { result: 0 };
  };
  const read = code => f.bridge.call('get_group_info', { group_id: code });
  await assert.rejects(read(20001), { code: 'TIMEOUT' });
  const late = { groupCode: '20001', groupName: 'Late result' };
  f.groupListener.onGroupDetailInfoChange(late);
  await assert.rejects(read(20001), { code: 'UNCONFIRMED' });
  f.bridge.detach();
  await f.bridge.attach();
  f.groupListener.onGroupDetailInfoChange(late);
  await assert.rejects(read(20001), { code: 'UNCONFIRMED' });
  assert.equal((await read(20002)).group_name, 'Other group');
  assert.equal(calls, 2);
});

test('an in-flight group read cancelled by reattachment cannot be completed by either listener', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const submitted = Promise.withResolvers();
  const nativeReply = Promise.withResolvers();
  const calls = [];
  f.group.getGroupDetailInfo = code => {
    calls.push(code);
    if (code === '20001') { submitted.resolve(); return nativeReply.promise; }
    f.groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Other group' });
    return { result: 0 };
  };
  const read = code => f.bridge.call('get_group_info', { group_id: code });
  const interrupted = assert.rejects(read(20001), { code: 'CANCELLED' });
  await submitted.promise;
  const oldListener = f.groupListener;
  await f.bridge.reattach();
  await interrupted;
  const late = { groupCode: '20001', groupName: 'Late result' };
  oldListener.onGroupDetailInfoChange(late);
  f.groupListener.onGroupDetailInfoChange(late);
  nativeReply.resolve({ result: 0 });
  await assert.rejects(read(20001), { code: 'UNCONFIRMED' });
  assert.equal((await read(20002)).group_name, 'Other group');
  assert.deepEqual(calls, ['20001', '20002']);
});

test('incoming group mentions carry exact QQ numbers and resolve the verified bot UID', async t => {
  const f = fixture();
  f.setIdentity({ user_id: BOT, uid: 'u_verified_bot', online: true, sessionId: 'synthetic-session-A' });
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => { core.close(); f.bridge.detach(); });
  assert.equal((await core.dispatch({ action: 'get_login_info' })).data.uid, undefined);
  const at = (atType, atUid, atNtUid) => ({ elementType: 1,
    textElement: { content: '@Synthetic', atType, atUid, atNtUid } });
  const message = new Promise(resolve => core.once('event', resolve));
  f.receive([raw({ elements: [
    at(2, '10001'), at(2, '0', 'u_verified_bot'), at(4, '', 'u_verified_bot'), at(1),
    at(0, BOT, 'u_verified_bot'), at(2, '0', 'u_unknown'), at(2, BOT, 'u_other'),
    at(2, '10001', 'u_verified_bot'), at(4, '', 'u_unknown'),
  ] })]);
  const event = await Promise.race([message, tick().then(() => null)]);
  assert(event);
  assert.deepEqual(event.message.slice(0, 4).map(segment => segment.data.qq), ['10001', BOT, BOT, 'all']);
  assert(event.message.slice(4).every(segment => segment.type === 'text'));
  assert.match(event.raw_message, new RegExp(`\\[CQ:at,qq=${BOT_UIN}\\]`));
  assert.doesNotMatch(JSON.stringify(event), /u_verified_bot/);
});

test('outbound group mentions preserve separate QQ and NT UID fields', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const response = await f.bridge.call('send_group_msg', { group_id: 20001,
    message: '[CQ:at,qq=10001][CQ:at,qq=all][CQ:at,qq=10001]' });
  assert.equal(response.message_id, 1);
  assert.deepEqual(f.calls.filter(entry => entry[0] === 'resolve'), [['resolve', [FRIEND]]]);
  const [first, all, repeated] = f.calls.find(entry => entry[0] === 'send')[3];
  assert.equal(first.elementId, '');
  assert.deepEqual(first.textElement, { content: '@10001', atType: 2, atUid: FRIEND,
    atTinyId: '', atNtUid: 'u_fixture' });
  assert.deepEqual(repeated, first);
  assert.deepEqual(all.textElement, { content: '@全体成员', atType: 1, atUid: 'all',
    atTinyId: '', atNtUid: 'all' });
});

test('protected mentions and a session replacement during UID resolution prevent submission', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const send = message => f.bridge.call('send_group_msg', { group_id: 20001, message });
  await assert.rejects(send(`[CQ:at,qq=10001][CQ:at,qq=${OWNER_UIN}]`), { code: 'PROTECTED_ACCOUNT' });
  assert(!f.calls.some(entry => entry[0] === 'resolve'));
  f.group.getUidByUins = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { errCode: 0, uids: new Map([[FRIEND, 'u_fixture']]) };
  };
  await assert.rejects(send('[CQ:at,qq=10001]'), { code: 'STALE_SESSION' });
  assert(!f.calls.some(entry => entry[0] === 'send'));
});

test('a changed bot UID with the same native session ID revokes incoming events', async t => {
  const f = fixture();
  const identity = { user_id: BOT, uid: 'u_verified_bot', online: true, sessionId: 'synthetic-session-A' };
  f.setIdentity(identity);
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let delivered = 0;
  f.bridge.on('event', () => { delivered++; });
  f.setIdentity({ ...identity, uid: 'u_other' });
  f.receive([raw()]);
  await tick();
  assert.equal(delivered, 0);
  assert.equal(f.bridge.attached, false);
});

test('profile query checks native status, publishes only selected fields and refuses an unproven forced refresh', async t => {
  const f = fixture();
  let calls = 0, code = 0;
  f.profile.getUserDetailInfoByUin = uin => {
    assert.equal(uin, FRIEND);
    calls++;
    return { result: code, detail: { uin, uid: 'u_fixture', simpleInfo: {
      coreInfo: { uin, uid: 'u_fixture', nick: 'Synthetic', remark: 'Fixture' },
      baseInfo: { sex: 255, age: 20, longNick: 'Synthetic signature', restrictedExtra: 'drop' },
    } } };
  };
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => { core.close(); f.bridge.detach(); });
  const params = { user_id: FRIEND };
  const request = { action: 'get_stranger_info', params };
  assert.equal((await core.dispatch({ ...request, params: { ...params, no_cache: true } })).retcode, 1404);
  assert.equal(calls, 0);
  code = 1;
  assert.equal((await core.dispatch(request)).retcode, 1500);
  code = 0;
  assert.deepEqual((await core.dispatch(request)).data, { user_id: Number(FRIEND), nickname: 'Synthetic',
    sex: 'unknown', age: 20, long_nick: 'Synthetic signature', remark: 'Fixture' });
});

test('profile query exposes official intimacy as bounded scalars only', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  // 内核 SimpleInfo 里本来就带 intimate（类型定义 user.ts:218，形状未实测）⇒
  // 只透出标量，Map/嵌套对象/超长字符串一个都不带出去。
  f.profile.getUserDetailInfoByUin = uin => ({ result: 0, detail: { uin, uid: 'u_fixture', simpleInfo: {
    coreInfo: { uin, uid: 'u_fixture', nick: 'Synthetic' },
    baseInfo: { sex: 1, age: 20 },
    intimate: { score: 128, level: 3, lastActiveDays: 0, alive: true, nested: { a: 1 }, huge: 'x'.repeat(300) },
  } } });
  const info = await f.bridge.call('get_stranger_info', { user_id: FRIEND });
  assert.deepEqual(info.intimate, { score: 128, level: 3, lastActiveDays: 0, alive: true });
  // 没有任何标量可取时干脆不给这个字段（不给空壳）。
  f.profile.getUserDetailInfoByUin = uin => ({ result: 0, detail: { uin, uid: 'u_fixture', simpleInfo: {
    coreInfo: { uin, uid: 'u_fixture', nick: 'Synthetic' }, baseInfo: { sex: 1, age: 20 }, intimate: { nested: {} },
  } } });
  assert.equal('intimate' in (await f.bridge.call('get_stranger_info', { user_id: FRIEND })), false);
});

test('profile query rejects inconsistent identity and discards a successful response after session replacement', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const query = () => f.bridge.call('get_stranger_info', { user_id: FRIEND });
  f.profile.getUserDetailInfoByUin = uin => ({ result: 0,
    detail: { uin, uid: 'u_fixture', simpleInfo: { coreInfo: { uin: '10002' } } } });
  await assert.rejects(query(), { code: 'INVALID_PARAMS' });
  f.profile.getUserDetailInfoByUin = uin => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { result: 0, detail: { uin, simpleInfo: { coreInfo: { nick: 'Old response' } } } };
  };
  await assert.rejects(query(), { code: 'STALE_SESSION' });
  assert.equal(f.bridge.attached, false);
});

test('UID-only friend categories resolve in bounded batches and retain first-seen order', async t => {
  const f = fixture();
  const uids = Array.from({ length: 257 }, (_, index) => 'u_friend_' + index);
  const batches = [];
  f.buddy.getBuddyListV2 = (...args) => {
    assert.deepEqual(args, ['0', true, 0]);
    return { result: 0, data: [{ buddyUids: uids }, { buddyUids: [uids[0]] }] };
  };
  f.profile.getCoreAndBaseInfo = (source, batch) => {
    assert.equal(source, 'nodeStore');
    batches.push(batch);
    return new Map(batch.slice().reverse().map(uid => [uid, { coreInfo: {
      uid, uin: String(10000 + uids.indexOf(uid)), nick: 'Synthetic', remark: 'Fixture',
    } }]));
  };
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => { core.close(); f.bridge.detach(); });
  const response = await core.dispatch({ action: 'get_friend_list', params: { no_cache: true } });
  assert.equal(response.retcode, 0);
  assert.deepEqual(batches.map(batch => batch.length), [256, 1]);
  assert.deepEqual(response.data.map(friend => friend.user_id), uids.map((_, index) => 10000 + index));
  assert.deepEqual(response.data[0], { user_id: 10000, nickname: 'Synthetic', remark: 'Fixture' });
});

test('UID-only friend categories reject partial or mismatched profiles and a changed session', async t => {
  const f = fixture();
  f.buddy.getBuddyListV2 = () => ({ result: 0, data: [{ buddyUids: ['u_fixture'] }] });
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  f.profile.getCoreAndBaseInfo = () => new Map();
  await assert.rejects(f.bridge.call('get_friend_list'), { code: 'INCOMPLETE_FRIENDS' });
  f.profile.getCoreAndBaseInfo = () => new Map([['u_fixture', { coreInfo: { uid: 'u_wrong', uin: FRIEND } }]]);
  await assert.rejects(f.bridge.call('get_friend_list'), { code: 'INVALID_PARAMS' });
  f.profile.getCoreAndBaseInfo = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return new Map([['u_fixture', { coreInfo: { uid: 'u_fixture', uin: FRIEND } }]]);
  };
  await assert.rejects(f.bridge.call('get_friend_list'), { code: 'STALE_SESSION' });
});

test('grouped friend action retains category order and resolves shared UIDs once', async t => {
  const f = fixture();
  const member = { uin: '10002', coreInfo: { nick: 'Second friend' } };
  let categories = [
    { categoryId: 2, categroyName: 'First category', categroyMbCount: 1, buddyUids: ['u_fixture'] },
    { categoryId: 0, categoryName: 'Empty category', categoryMbCount: 0, buddyList: [] },
    { categoryId: 1, categoryName: 'Last category', categoryMbCount: 1, buddyList: [member] },
  ];
  f.buddy.getBuddyListV2 = (_start, refresh) => {
    assert.equal(refresh, true);
    return { result: 0, data: categories };
  };
  let queries = 0;
  f.profile.getCoreAndBaseInfo = (_source, batch) => {
    assert.deepEqual(batch, ['u_fixture']);
    queries++;
    member.uin = '10003';
    member.coreInfo.nick = 'Changed after list was read';
    categories[2].categoryName = 'Changed after list was read';
    return new Map([['u_fixture', { coreInfo: { uid: 'u_fixture', uin: FRIEND, nick: 'First friend' } }]]);
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const getGroups = () => f.bridge.call('get_friends_with_category');
  assert.deepEqual(await getGroups(), [
    { categoryId: 2, categoryName: 'First category', categoryMbCount: 1,
      buddyList: [{ user_id: Number(FRIEND), nickname: 'First friend', remark: '', category_id: 2 }] },
    { categoryId: 0, categoryName: 'Empty category', categoryMbCount: 0, buddyList: [] },
    { categoryId: 1, categoryName: 'Last category', categoryMbCount: 1,
      buddyList: [{ user_id: 10002, nickname: 'Second friend', remark: '', category_id: 1 }] },
  ]);
  assert.equal(queries, 1);
  categories = [{ ...categories[0], categroyMbCount: 2 }];
  await assert.rejects(getGroups(), { code: 'INVALID_PARAMS' });
  assert.equal(queries, 1);
});

test('group detail dispatch matches the requested group and projects only supported fields', async t => {
  const f = fixture();
  f.group.getGroupDetailInfo = async (code, source) => {
    assert.equal(code, '20001');
    assert([1, 2].includes(source));
    const detail = { groupName: 'Synthetic Group', memberNum: 2, maxMemberNum: 100,
      groupMemo: 'Synthetic introduction', remarkName: 'Synthetic remark', shutUpAllTimestamp: 1 };
    f.groupListener.onGroupDetailInfoChange({ ...detail, groupCode: '20002', groupName: 'Other group' });
    f.groupListener.onGroupDetailInfoChange({ ...detail, groupCode: code, internalField: 'ignored' });
    return { result: 0 };
  };
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => { core.close(); f.bridge.detach(); });
  const reply = await core.dispatch({ action: 'get_group_detail_info', params: { group_id: '20001' }, echo: 'detail' });
  assert.equal(reply.status, 'ok');
  assert.equal(reply.echo, 'detail');
  assert.deepEqual(reply.data, { group_id: 20001, group_name: 'Synthetic Group',
    member_count: 2, max_member_count: 100, group_memo: 'Synthetic introduction',
    group_remark: 'Synthetic remark', group_all_shut: -1 });
  const standard = await core.dispatch({ action: 'get_group_info', params: { group_id: '20001' } });
  assert.deepEqual(standard.data, { group_id: 20001, group_name: 'Synthetic Group',
    member_count: 2, max_member_count: 100, group_all_shut: -1 });
});

test('message reaction query uses the indexed group and returns typed totals without guessed user IDs', async t => {
  const f = fixture();
  await f.bridge.attach();
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => { core.close(); f.bridge.detach(); });
  f.bridge.messages.put(raw());
  f.msg.getMsgsByMsgId = async (peer, ids) => {
    assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
    assert.deepEqual(ids, ['90071992547409931']);
    return { result: 0, msgList: [
      raw({ peerUid: '20002', emojiLikesList: [] }),
      raw({ emojiLikesList: [
        { emojiId: '14', emojiType: '1', likesCnt: '3', isClicked: '1' },
        { emojiId: '128077', emojiType: '2', likesCnt: '1' },
      ] }),
    ] };
  };
  const result = await core.dispatch({ action: 'get_msg_emoji_likes', params: { message_id: 1 } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data, [
    { emoji_id: '14', emoji_type: 1, count: 3, users: [], users_complete: false },
    { emoji_id: '128077', emoji_type: 2, count: 1, users: [], users_complete: false },
  ]);
});

test('message reaction query rejects private messages, wrong-peer results and malformed counts', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  f.bridge.messages.put(raw({ chatType: 1, peerUid: 'u_fixture' }));
  f.bridge.messages.put(raw());
  await assert.rejects(f.bridge.call('get_msg_emoji_likes', { message_id: 1 }), { code: 'INVALID_PARAMS' });
  assert.equal(f.calls.filter(entry => entry[0] === 'get').length, 0);
  f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList: [raw({ peerUid: '20002' })] });
  await assert.rejects(f.bridge.call('get_msg_emoji_likes', { message_id: 2 }), { code: 'MESSAGE_NOT_FOUND' });
  f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList: [raw({
    emojiLikesList: [{ emojiId: '14', emojiType: '1', likesCnt: '9007199254740993' }],
  })] });
  await assert.rejects(f.bridge.call('get_msg_emoji_likes', { message_id: 2 }), { code: 'INVALID_PARAMS' });
  f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList: [raw()] });
  assert.deepEqual(await f.bridge.call('get_msg_emoji_likes', { message_id: 2 }), []);
});

test('message reaction summary includes responders only after the native total and final page agree', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const message_id = f.bridge.messages.put(raw());
  const summary = [{ emojiId: '14', emojiType: '1', likesCnt: '2' },
    { emojiId: '128077', emojiType: '2', likesCnt: '3' }, { emojiId: '13', emojiType: '1', likesCnt: '151' }];
  f.msg.getMsgsByMsgId = () => ({ result: 0, msgList: [raw({ emojiLikesList: summary })] });
  f.members.set('u_second', { uid: 'u_second', uin: '10002' });
  let secondAccount = '10002';
  const calls = [];
  f.msg.getMsgEmojiLikesList = (peer, seq, emoji, type, cookie) => {
    calls.push([peer, seq, emoji, type, cookie]);
    const last = emoji === '128077' || Boolean(cookie);
    return { result: 0, isFirstPage: !cookie, isLastPage: last, cookie: last ? '' : 'continuation',
      emojiLikesList: [{ tinyId: cookie ? secondAccount : '10001', nickName: 'Synthetic' }] };
  };
  assert.deepEqual(await f.bridge.call('get_msg_emoji_likes', { message_id }), [
    { emoji_id: '14', emoji_type: 1, count: 2, users: [{ user_id: '10001' }, { user_id: '10002' }], users_complete: true },
    { emoji_id: '128077', emoji_type: 2, count: 3, users: [], users_complete: false },
    { emoji_id: '13', emoji_type: 1, count: 151, users: [], users_complete: false },
  ]);
  const peer = { chatType: 2, peerUid: '20001', guildId: '' };
  assert.deepEqual(calls, [[peer, '51', '14', '1', ''], [peer, '51', '14', '1', 'continuation'], [peer, '51', '128077', '2', '']]);
  secondAccount = '9007199254740993';
  const [unmatched] = await f.bridge.call('get_msg_emoji_likes', { message_id });
  assert.deepEqual(unmatched, { emoji_id: '14', emoji_type: 1, count: 2, users: [{ user_id: '10001' }], users_complete: false });
});

test('reaction pagination binds its opaque cursor to the verified message and emoji', async t => {
  const f = fixture();
  const pages = [];
  f.msg.getMsgEmojiLikesList = (...args) => {
    pages.push(args);
    const continuation = Boolean(args[4]);
    return { result: 0, isFirstPage: !continuation, isLastPage: continuation,
      cookie: continuation ? '' : 'synthetic-native-cursor',
      emojiLikesList: [{ tinyId: '9007199254740993', nickName: 'Synthetic',
        headUrl: 'https://example.invalid/picture' }] };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const message_id = f.bridge.messages.put(raw());
  const params = { message_id, emojiId: 14, emojiType: 1, count: 1 };
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => core.close());
  const reply = await core.dispatch({ action: 'fetch_emoji_like', params });
  assert.equal(reply.retcode, 0);
  const first = reply.data;
  assert.match(first.cookie, /^reaction_[a-f0-9]{32}$/);
  assert.equal(first.isFirstPage, true);
  assert.deepEqual(first.emojiLikesList, [{ tinyId: '9007199254740993', nickName: 'Synthetic', headUrl: '' }]);
  assert.deepEqual(pages[0], [{ chatType: 2, peerUid: '20001', guildId: '' }, '51', '14', '1', '', false, 1]);
  await assert.rejects(f.bridge.call('fetch_emoji_like', { ...params, emojiId: 15, cookie: first.cookie }),
    { code: 'INVALID_PARAMS' });
  assert.equal(pages.length, 1);
  await f.bridge.reattach();
  f.msg.getMsgsByMsgId = () => ({ result: 0, msgList: [raw({ msgSeq: '52' })] });
  await assert.rejects(f.bridge.call('fetch_emoji_like', { ...params, cookie: first.cookie }), { code: 'INVALID_PARAMS' });
  assert.equal(pages.length, 1);
  f.msg.getMsgsByMsgId = () => ({ result: 0, msgList: [raw()] });
  const last = await f.bridge.call('fetch_emoji_like', { ...params, cookie: first.cookie });
  assert.equal(last.isLastPage, true);
  assert.equal(last.cookie, '');
  assert.equal(pages[1][4], 'synthetic-native-cursor');
  f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
  await assert.rejects(f.bridge.reattach(), { code: 'STALE_SESSION' });
  assert.equal(f.bridge.reactionPages.size, 0);
  await f.bridge.attach();
  const nextId = f.bridge.messages.put(raw());
  await assert.rejects(f.bridge.call('fetch_emoji_like', { ...params, message_id: nextId, cookie: first.cookie }),
    { code: 'INVALID_PARAMS' });
});

test('reaction pagination rejects missing continuation and duplicate responder IDs', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const entry = { tinyId: '101', nickName: 'Synthetic' };
  const response = { result: 0, isFirstPage: true, isLastPage: false, cookie: '', emojiLikesList: [entry] };
  f.msg.getMsgEmojiLikesList = () => response;
  const params = { message_id: f.bridge.messages.put(raw()), emojiId: '14', emojiType: '1' };
  await assert.rejects(f.bridge.call('fetch_emoji_like', params), { code: 'INVALID_NATIVE_RESPONSE' });
  response.cookie = 'synthetic-cursor';
  response.emojiLikesList.push(entry);
  await assert.rejects(f.bridge.call('fetch_emoji_like', params), { code: 'INVALID_NATIVE_RESPONSE' });
  assert.equal(f.bridge.reactionPages.size, 0);
});

test('get_emoji_likes aggregates native pages with exact IDs and enforces the group binding', async t => {
  const f = fixture();
  const pages = [];
  f.msg.getMsgEmojiLikesList = (...args) => {
    pages.push(args);
    const next = Boolean(args[4]);
    return { result: 0, isFirstPage: !next, isLastPage: next, cookie: next ? '' : 'next',
      emojiLikesList: next ? [{ tinyId: '9007199254740993', nickName: 'Second' }] : [
        { tinyId: OWNER_UIN, nickName: 'Filtered' }, { tinyId: '10001', nickName: 'First' },
      ] };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const core = new OneBotCore({ bridge: f.bridge });
  t.after(() => core.close());
  const call = params => core.dispatch({ action: 'get_emoji_likes', params });
  const longId = raw().msgId;
  const params = { message_id: longId, group_id: '20001', emoji_id: '1000' };
  const all = { emoji_like_list: [{ user_id: '10001', nick_name: 'First' }, { user_id: '9007199254740993', nick_name: 'Second' }] };
  assert.equal((await call({ ...params, group_id: undefined })).retcode, 1400);
  assert.equal((await call({ ...params, message_id: Number(longId) })).retcode, 1400);
  assert.equal(f.calls.length, 0);
  assert.equal((await call({ ...params, group_id: '20002' })).retcode, 1404);
  assert.equal(pages.length, 0);
  assert.deepEqual((await call(params)).data, all);
  assert.equal(f.bridge.messages.byId.size, 0);
  const shortId = f.bridge.messages.put(raw());
  assert.equal((await call({ ...params, message_id: shortId, group_id: '20002' })).retcode, 1400);
  assert.equal(pages.length, 2);
  assert.deepEqual((await call({ message_id: shortId, emoji_id: 14, count: '1' })).data,
    { emoji_like_list: all.emoji_like_list.slice(0, 1) });
  const peer = { chatType: 2, peerUid: '20001', guildId: '' };
  assert.deepEqual(pages, [[peer, '51', '1000', '2', '', false, 15],
    [peer, '51', '1000', '2', 'next', false, 15], [peer, '51', '14', '1', '', false, 15]]);
  assert.equal(f.bridge.reactionPages.size, 0);
});

test('get_emoji_likes rejects duplicate responders and discards results across session changes', async t => {
  const f = fixture();
  let changeSession = false;
  f.msg.getMsgEmojiLikesList = (...args) => {
    const next = Boolean(args[4]);
    if (next && changeSession) f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { result: 0, isFirstPage: !next, isLastPage: next, cookie: next ? '' : 'next',
      emojiLikesList: [{ tinyId: next && changeSession ? '10002' : '10001', nickName: 'Synthetic' }] };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const params = { message_id: f.bridge.messages.put(raw()), emoji_id: '14' };
  await assert.rejects(f.bridge.call('get_emoji_likes', params), { code: 'INVALID_NATIVE_RESPONSE' });
  changeSession = true;
  await assert.rejects(f.bridge.call('get_emoji_likes', params), { code: 'STALE_SESSION' });
  assert.equal(f.bridge.reactionPages.size, 0);
});

test('group detail requires a successful acknowledgment even when callback arrives first', async t => {
  const f = fixture();
  f.group.getGroupDetailInfo = async (code) => {
    f.groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Synthetic Group', memberNum: 1, maxMemberNum: 100 });
    return { result: 1 };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  await assert.rejects(f.bridge.call('get_group_detail_info', { group_id: 20001 }), { code: 'NATIVE_REJECTED' });
});

test('group detail can receive its callback after acknowledgment and leaves absent extensions absent', async t => {
  const f = fixture();
  f.group.getGroupDetailInfo = (code) => {
    setImmediate(() => f.groupListener.onGroupDetailInfoChange({
      groupCode: code, groupName: 'Synthetic Group', memberNum: 0, maxMemberNum: 100,
    }));
    return { result: 0 };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  assert.deepEqual(await f.bridge.call('get_group_detail_info', { group_id: 20001 }), {
    group_id: 20001, group_name: 'Synthetic Group', member_count: 0, max_member_count: 100,
  });
});

test('void mutations require independent readback and do not optimistically succeed', async () => {
  const good = fixture(); await good.bridge.attach();
  assert.equal(await good.bridge.call('set_group_card', { group_id: 20001, user_id: FRIEND, card: 'updated' }), null);
  assert.equal(await good.bridge.call('set_group_admin', { group_id: 20001, user_id: FRIEND }), null);
  good.bridge.detach();
  const bad = fixture({ noReadback: true }); await bad.bridge.attach();
  await assert.rejects(bad.bridge.call('set_group_card', { group_id: 20001, user_id: FRIEND, card: 'updated' }), { code: 'UNCONFIRMED', outcome: 'unknown' });
  assert.equal(bad.calls.filter(x => x[0] === 'card').length, 1);
  bad.bridge.detach();
});

test('partial native member list is never presented as complete', async () => {
  const f = fixture(); f.group.getAllMemberList = async () => ({ errCode: 0, result: { infos: f.members, finish: false } });
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('get_group_member_list', { group_id: 20001 }), { code: 'INCOMPLETE_MEMBERS' });
  f.bridge.detach();
});

test('single-member cache misses trigger one fresh read of the same group', async t => {
  const f = fixture();
  const requests = [];
  const member = f.members.get('u_fixture');
  let freshInfos = f.members;
  let cachedInfos = new Map();
  f.group.getAllMemberList = async (code, fresh) => {
    requests.push([code, fresh]);
    return { errCode: 0, result: { infos: fresh ? freshInfos : cachedInfos, finish: true } };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const query = (params = {}) => f.bridge.call('get_group_member_info', {
    group_id: 20001, user_id: FRIEND, ...params,
  });
  assert.equal((await query()).card, member.cardName);
  assert.deepEqual(requests.splice(0), [['20001', false], ['20001', true]]);
  cachedInfos = f.members;
  assert.equal((await query()).card, member.cardName);
  assert.deepEqual(requests.splice(0), [['20001', false]]);
  freshInfos = new Map();
  await assert.rejects(query({ no_cache: true }), { code: 'MEMBER_NOT_FOUND' });
  assert.deepEqual(requests.splice(0), [['20001', true]]);
  cachedInfos = new Map();
  await assert.rejects(query(), { code: 'MEMBER_NOT_FOUND' });
  assert.deepEqual(requests.splice(0), [['20001', false], ['20001', true]]);
});

test('concurrent member cache misses share a refresh and one cancelled caller does not cancel another', async t => {
  const f = fixture();
  const started = Promise.withResolvers(), response = Promise.withResolvers();
  let cached = 0, refreshed = 0;
  f.group.getAllMemberList = async (code, fresh) => {
    assert.equal(code, '20001');
    if (fresh) { refreshed++; started.resolve(); return response.promise; }
    cached++;
    return { errCode: 0, result: { infos: new Map(), finish: true } };
  };
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const controller = new AbortController();
  const query = options => f.bridge.call('get_group_member_info', { group_id: 20001, user_id: FRIEND }, options);
  const first = assert.rejects(query({ signal: controller.signal }), { code: 'CANCELLED' });
  const second = query({});
  await started.promise;
  await tick();
  assert.equal(cached, 2);
  assert.equal(refreshed, 1);
  controller.abort();
  await first;
  response.resolve({ errCode: 0, result: { infos: f.members, finish: true } });
  assert.equal((await second).card, 'card');
  assert.equal(f.bridge.memberRefreshes.size, 0);
});

test('member reads reject duplicate identity records and stale session results', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const member = f.members.get('u_fixture');
  const query = () => f.bridge.call('get_group_member_list', { group_id: 20001 });
  f.group.getAllMemberList = async () => ({ errCode: 0, result: {
    finish: true, infos: new Map([['one', member], ['two', { ...member, uid: 'u_duplicate_uin' }]]),
  } });
  await assert.rejects(query(), { code: 'INVALID_NATIVE_RESPONSE' });
  f.group.getAllMemberList = async () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'synthetic-session-B' });
    return { errCode: 0, result: { finish: true, infos: f.members } };
  };
  await assert.rejects(query(), { code: 'STALE_SESSION' });
});

test('member mutation rejects readback from a different UID with the same QQ number', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  f.group.getAllMemberList = async () => ({ errCode: 0, result: {
    finish: true, infos: new Map([['u_other', { uin: FRIEND, uid: 'u_other', cardName: 'updated' }]]),
  } });
  await assert.rejects(f.bridge.call('set_group_card', { group_id: 20001, user_id: FRIEND, card: 'updated' }),
    { code: 'UNCONFIRMED', outcome: 'unknown' });
  assert.equal(f.calls.filter(entry => entry[0] === 'card').length, 1);
});

test('abort and detach do not retry a send whose receipt never arrived', async () => {
  const f = fixture({ noReceipt: true }); await f.bridge.attach();
  const controller = new AbortController();
  const operation = f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' }, { signal: controller.signal });
  await tick(); controller.abort();
  // 断念取消不再变成「未知失败」：按已接受放行，且 pending 清空
  const first = await operation;
  assert.equal(first.message_id, null);
  assert.equal(f.bridge.pending.size, 0);
  const second = f.bridge.call('send_group_msg', { group_id: 20001, message: 'second' });
  await tick(); f.bridge.detach();
  const secondResult = await second.catch((e) => e);
  assert(secondResult && (secondResult.message_id === null || secondResult.code === 'CANCELLED'));
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 2);
});

test('unsupported destructive APIs are absent instead of guessed', async () => {
  const f = fixture(); await f.bridge.attach();
  assert.ok(!f.bridge.capabilities().includes('set_group_kick'));
  await assert.rejects(f.bridge.call('set_group_kick', { group_id: 20001, user_id: FRIEND }), { code: 'UNSUPPORTED' });
  f.bridge.detach();
});

test('identity proof is single-flight and event backlog stays bounded when native probe hangs', async () => {
  const f = fixture(); await f.bridge.attach();
  let probes = 0;
  f.bridge.identityProbe = () => { probes++; return new Promise(() => {}); };
  for (let batch = 0; batch < 20; batch++) f.receive(Array.from({ length: 100 }, (_, i) => raw({ msgId: String(100000 + batch * 100 + i) })));
  await tick();
  assert.equal(probes, 1);
  assert.equal(f.bridge.eventPending, 128);
  assert.ok(f.bridge.stats.droppedEvents >= 1872);
  await assert.rejects(f.bridge.probe(), { code: 'IDENTITY_UNAVAILABLE' });
  await tick();
  assert.equal(f.bridge.eventPending, 0);
  assert.equal(f.bridge.attached, false);
});

test('identity that resolves after timeout cannot reopen bridge', async () => {
  const f = fixture();
  let resolve;
  f.bridge.identityProbe = () => new Promise(r => { resolve = r; });
  await assert.rejects(f.bridge.attach(), { code: 'IDENTITY_UNAVAILABLE' });
  resolve({ user_id: BOT, online: true, sessionId: 'late' });
  await tick();
  assert.equal(f.bridge.attached, false);
  assert.equal(f.bridge.identity, null);
});

test('generic group send works even when private UID resolution is unavailable', async () => {
  const f = fixture(); delete f.group.getUidByUins;
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('send_msg'));
  assert.ok(!f.bridge.capabilities().includes('send_private_msg'));
  assert.ok((await f.bridge.call('send_msg', { group_id: 20001, message: 'hello' })).message_id);
  await assert.rejects(f.bridge.call('send_msg', { user_id: FRIEND, message: 'no' }), { code: 'UNSUPPORTED' });
  f.bridge.detach();
});

test('duplicate native IDs cannot correlate two side effects to the same receipt', async () => {
  const f = fixture(); f.msg.generateMsgUniqueId = () => '90071992547409939';
  await f.bridge.attach();
  await f.bridge.call('send_group_msg', { group_id: 20001, message: 'first' });
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: 'second' }), { code: 'DUPLICATE_NATIVE_ID' });
  await f.bridge.reattach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: 'after reattachment' }), { code: 'DUPLICATE_NATIVE_ID' });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  f.bridge.detach();
});

test('send history lasts beyond message cache eviction and its own limit blocks before native ID generation', async t => {
  const f = fixture({ bridgeOptions: { maxMessages: 1, maxSendCorrelations: 3 } });
  t.after(() => f.bridge.detach());
  const ids = ['90071992547409939', '90071992547409940', '90071992547409939', '90071992547409941'];
  let generated = 0;
  f.msg.generateMsgUniqueId = () => ids[generated++];
  await f.bridge.attach();
  const send = () => f.bridge.call('send_group_msg', { group_id: 20001, message: 'Synthetic message' });
  const first = await send();
  await send();
  assert.throws(() => f.bridge.messages.get(first.message_id), { code: 'MESSAGE_NOT_FOUND' });
  await f.bridge.reattach();
  await assert.rejects(send(), { code: 'DUPLICATE_NATIVE_ID' });
  await send();
  await f.bridge.reattach();
  await assert.rejects(send(), { code: 'SEND_ID_LIMIT', outcome: 'not_started' });
  assert.equal(generated, 4);
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 3);
});

test('send confirmation binds generated guildId, peer and sender; final msgId is independently preserved', async () => {
  const f = fixture({ noReceipt: true }); await f.bridge.attach();
  let settled = false;
  const pending = f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' }).then(value => { settled = true; return value; });
  await tick();
  const send = f.calls.find(x => x[0] === 'send');
  const correlation = send[2].guildId;
  const receipt = raw({ msgId: '99999999999999999', guildId: correlation, senderUin: BOT, sendStatus: 2 });
  for (const wrong of [
    { guildId: undefined, msgId: correlation }, { msgId: correlation }, { guildId: '123456' }, { guildId: Number(correlation) },
    { peerUid: '20002' }, { chatType: 1 }, { senderUin: FRIEND }, { sendStatus: 1 },
  ]) f.update([{ ...receipt, ...wrong }]);
  await tick(); assert.equal(settled, false);
  f.update([receipt]);
  const result = await pending;
  assert.equal(f.bridge.messages.get(result.message_id).msgId, receipt.msgId);
  await f.bridge.call('delete_msg', { message_id: result.message_id });
  assert.deepEqual(f.calls.find(x => x[0] === 'recall')[2], [receipt.msgId]);
  assert.notEqual(receipt.msgId, correlation);
  f.bridge.detach();
});

test('send ignores a premature terminal callback and returns the first submitted receipt snapshot', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  const correlation = '90071992547409950';
  const finalId = '90071992547409951';
  const premature = raw({ msgId: '90071992547409952', guildId: correlation, senderUin: BOT, sendStatus: 2 });
  f.msg.generateMsgUniqueId = () => {
    queueMicrotask(() => f.update([premature]));
    return correlation;
  };
  f.msg.sendMsg = (_first, peer, elements) => {
    const receipt = raw({ ...peer, msgId: finalId, senderUin: BOT, sendStatus: 2, elements });
    f.update([receipt]);
    receipt.msgId = '90071992547409953';
    receipt.sendStatus = 0;
    f.update([receipt]);
    return { result: 0 };
  };
  const result = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
  const confirmed = f.bridge.messages.get(result.message_id);
  assert.equal(confirmed.msgId, finalId);
  assert.equal(confirmed.sendStatus, 2);
});

test('receipt confirms a valid message ID even when unrelated native fields cannot be cloned', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let calls = 0;
  f.msg.sendMsg = (_first, peer) => {
    calls++;
    f.update([raw({ ...peer, senderUin: BOT, sendStatus: 2, unsupportedNativeField: 1n })]);
    return { result: 0 };
  };
  const result = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
  assert.equal(calls, 1);
  const receipt = f.bridge.messages.get(result.message_id);
  assert.equal(receipt.msgId, raw().msgId);
  assert.notEqual(receipt.msgId, receipt.guildId);
  assert.deepEqual(receipt.elements, []);
  assert(!Object.hasOwn(receipt, 'unsupportedNativeField'));
  assert.equal(f.bridge.stats.sendReceiptsReduced, 1);
  assert.equal(f.bridge.stats.sendReceiptsIndexed, 1);
});

test('a UID-only self receipt and reread bind to the verified account and reject conflicting senders', async t => {
  const f = fixture();
  f.setIdentity({ user_id: BOT, uid: 'u_bot', online: true, sessionId: 'synthetic-session-A' });
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let sent;
  f.msg.sendMsg = (_first, peer, elements) => {
    sent = raw({ ...peer, senderUin: undefined, senderUid: 'u_bot', sendStatus: 2, elements });
    f.update([{ ...sent, msgId: '90071992547409990', senderUin: FRIEND },
      { ...sent, msgId: '90071992547409991', senderUin: BOT, senderUid: 'u_other' },
      { ...sent, unsupportedNativeField: 1n }]);
    return { result: 0 };
  };
  const { message_id } = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
  const receipt = f.bridge.messages.get(message_id);
  assert.equal(receipt.msgId, raw().msgId);
  assert.equal(receipt.senderUid, 'u_bot');
  f.msg.getMsgsByMsgId = async () => ({ result: 0, msgList: [sent] });
  const read = () => f.bridge.call('get_msg', { message_id });
  assert.equal((await read()).user_id, Number(BOT));
  sent.senderUin = FRIEND;
  await assert.rejects(read());
  sent.senderUin = BOT;
  sent.senderUid = 'u_other';
  await assert.rejects(read());
});

test('reduced receipt keeps complete indexed content and rejects a conflicting sender', async t => {
  const f = fixture();
  await f.bridge.attach();
  t.after(() => f.bridge.detach());
  let finalId = '90071992547409983';
  f.msg.sendMsg = (_first, peer) => {
    f.update([raw({ ...peer, msgId: finalId, senderUin: BOT, sendStatus: 2, unsupportedNativeField: 1n })]);
    return { result: 0 };
  };
  const full = raw({ msgId: finalId, senderUin: BOT });
  const existing = f.bridge.messages.put(full);
  assert.equal((await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' })).message_id, existing);
  assert.deepEqual(f.bridge.messages.get(existing), full);

  finalId = '90071992547409984';
  const conflict = raw({ msgId: finalId, senderUin: FRIEND });
  const conflictId = f.bridge.messages.put(conflict);
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' }),
    { code: 'RESPONSE_UNAVAILABLE', outcome: 'unknown' });
  assert.deepEqual(f.bridge.messages.get(conflictId), conflict);
});

test('sendStatus 3 confirms a distinct final ID even before a nonzero send acknowledgment', async () => {
  const f = fixture();
  f.msg.sendMsg = (first, peer, elements) => {
    f.calls.push(['send', first, peer, elements]);
    assert.equal(first, '0');
    f.update([raw({ msgId: '88888888888888888', guildId: peer.guildId, chatType: peer.chatType, peerUid: peer.peerUid, senderUin: BOT, sendStatus: 3, msgSeq: '' })]);
    return Promise.resolve({ result: 5 });
  };
  await f.bridge.attach();
  const result = await f.bridge.call('send_private_msg', { user_id: FRIEND, message: 'hello' });
  assert.equal(f.bridge.messages.get(result.message_id).msgId, '88888888888888888');
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  f.bridge.detach();
});

test('confirmation without a valid final native msgId never returns the generated correlation ID', async () => {
  for (const finalId of [undefined, '', '0', '0000', 123, 'not-a-message-id']) {
    const f = fixture();
    f.msg.sendMsg = (first, peer) => {
      f.calls.push(['send', first, peer]);
      f.update([raw({ msgId: finalId, guildId: peer.guildId, senderUin: BOT, sendStatus: 2 })]);
      return { result: 0 };
    };
    await f.bridge.attach();
    let outcome = null;
    try {
      outcome = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
    } catch (error) {
      assert.equal(error.code, 'RESPONSE_UNAVAILABLE');
      assert.equal(error.outcome, 'unknown');
    }
    if (outcome) {
      // 没有可用回执时不编造 ID：只能给 null（上层按「已发出、结果待确认」记账）
      assert.equal(outcome.message_id, null);
    }
    assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
    f.bridge.detach();
  }
  const f = fixture();
  await f.bridge.attach();
  try {
    f.msg.sendMsg = (_first, peer) => {
      f.update([raw({ ...peer, msgId: '0', senderUin: BOT, sendStatus: 2, unsupportedNativeField: 1n })]);
      return { result: 0 };
    };
    let second = null;
    try {
      second = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'hello' });
    } catch (error) {
      assert.equal(error.code, 'RESPONSE_UNAVAILABLE');
    }
    if (second) assert.equal(second.message_id, null);
    assert.equal(f.bridge.messages.byId.size, 0);
    assert.equal(f.bridge.stats.sendReceiptsIndexed, 0);
  } finally { f.bridge.detach(); }
});

test('same-millisecond sends use increasing native timestamps and distinct request correlations', async () => {
  const f = fixture();
  const times = [];
  f.msg.generateMsgUniqueId = (chatType, time) => { times.push(time); return time; };
  await f.bridge.attach();
  const now = Date.now;
  try {
    Date.now = () => 1700000000000;
    await Promise.all([1, 2, 3].map(i => f.bridge.call('send_group_msg', { group_id: 20001, message: String(i) })));
  } finally { Date.now = now; f.bridge.detach(); }
  assert.deepEqual(times, ['1700000000000', '1700000000001', '1700000000002']);
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 3);
});

test('ordinary group leave requests no local deletion and requires confirmed fresh absence', async () => {
  const f = fixture(); await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('set_group_leave'));
  assert.equal(await f.bridge.call('set_group_leave', { group_id: 20001 }), null);
  assert.deepEqual(f.calls.filter(x => ['leave', 'groups'].includes(x[0])), [
    ['leave', { groupCode: '20001', needDeleteLocalMsg: false }], ['groups', true],
  ]);
  f.bridge.detach();
});

test('dismiss and uncalibrated kick/title methods are rejected before any native operation', async () => {
  const f = fixture();
  f.group.kickMemberV2 = () => { throw new Error('must not call'); };
  f.group.setIdentityTitleInfo = () => { throw new Error('must not call'); };
  await f.bridge.attach();
  const before = f.calls.length;
  for (const action of ['set_group_kick', 'set_group_special_title']) {
    assert.ok(!f.bridge.capabilities().includes(action));
    await assert.rejects(f.bridge.call(action, { group_id: 20001, user_id: FRIEND }), { code: 'UNSUPPORTED', outcome: 'not_started' });
  }
  await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001, is_dismiss: true }), { code: 'UNSUPPORTED', outcome: 'not_started' });
  await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001, is_dismiss: 'false' }), { code: 'INVALID_PARAMS', outcome: 'not_started' });
  assert.equal(f.calls.length, before);
  f.bridge.detach();
});

test('group leave capability requires both mutation and complete-list listener contracts', async () => {
  for (const name of ['quitGroupV2', 'getGroupList', 'addKernelGroupListener', 'removeKernelGroupListener']) {
    const f = fixture(); delete f.group[name]; await f.bridge.attach();
    assert.ok(!f.bridge.capabilities().includes('set_group_leave'));
    await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001 }), { code: 'UNSUPPORTED' });
    f.bridge.detach();
  }
});

test('group leave rejection or missing acknowledgment never becomes optimistic success', async () => {
  for (const [response, expected] of [[{ result: 5 }, { code: 'NATIVE_REJECTED', outcome: 'rejected' }], [undefined, { code: 'UNCONFIRMED', outcome: 'unknown' }]]) {
    const f = fixture();
    f.group.quitGroupV2 = params => { f.calls.push(['leave', params]); return response; };
    await f.bridge.attach();
    await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001 }), expected);
    assert.equal(f.calls.filter(x => x[0] === 'leave').length, 1);
    assert.equal(f.calls.filter(x => x[0] === 'groups').length, 0);
    f.bridge.detach();
  }
});

test('leave with stale, malformed, partial or rejected readback remains unknown without retry', async () => {
  for (const behavior of ['still-member', 'malformed', 'partial', 'rejected-refresh', 'hanging-refresh']) {
    const f = fixture({ noReadback: true });
    if (behavior !== 'still-member') f.group.getGroupList = force => {
      f.calls.push(['groups', force]);
      f.groupListener.onGroupListUpdate(behavior === 'partial' ? 1 : 0, behavior === 'malformed' ? [{}] : []);
      if (behavior === 'hanging-refresh') return new Promise(() => {});
      return { result: behavior === 'rejected-refresh' ? 5 : 0 };
    };
    await f.bridge.attach();
    await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001 }), { code: 'UNCONFIRMED', outcome: 'unknown' });
    assert.equal(f.calls.filter(x => x[0] === 'leave').length, 1);
    f.bridge.detach();
  }
});

test('leave success cannot cross an identity/session change during readback', async () => {
  const f = fixture();
  f.group.getGroupList = () => {
    f.setIdentity({ user_id: BOT, online: true, sessionId: 'replacement-session' });
    f.groupListener.onGroupListUpdate(0, []);
    return { result: 0 };
  };
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001 }), { code: 'UNCONFIRMED', outcome: 'unknown' });
  assert.equal(f.bridge.attached, false);
  assert.equal(f.calls.filter(x => x[0] === 'leave').length, 1);
});

test('abort before leave is not started; abort after native invocation is unknown', async () => {
  const f = fixture();
  f.group.quitGroupV2 = params => { f.calls.push(['leave', params]); return new Promise(() => {}); };
  await f.bridge.attach();
  const before = new AbortController(); before.abort();
  await assert.rejects(f.bridge.call('set_group_leave', { group_id: 20001 }, { signal: before.signal }), { outcome: 'not_started' });
  assert.equal(f.calls.filter(x => x[0] === 'leave').length, 0);
  const after = new AbortController();
  const operation = f.bridge.call('set_group_leave', { group_id: 20001 }, { signal: after.signal });
  await tick(); after.abort();
  await assert.rejects(operation, { code: 'CANCELLED', outcome: 'unknown' });
  assert.equal(f.calls.filter(x => x[0] === 'leave').length, 1);
  f.bridge.detach();
});

test('poke maps to sendNudge with receiver/caller UID and group confId', async () => {
  const f = fixture();
  f.msg.sendNudge = param => { f.calls.push(['nudge', param]); return { result: 0 }; };
  f.setIdentity({ user_id: BOT, uid: 'u_bot', online: true, sessionId: 'synthetic-session-A' });
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('friend_poke'));
  assert.ok(f.bridge.capabilities().includes('group_poke'));
  await f.bridge.call('group_poke', { group_id: 20001, user_id: FRIEND });
  assert.deepEqual(f.calls.find(x => x[0] === 'nudge')[1], { receiverUid: 'u_fixture', callerUid: 'u_bot', confId: '20001' });
  await f.bridge.call('friend_poke', { user_id: FRIEND });
  assert.deepEqual(f.calls.filter(x => x[0] === 'nudge')[1][1], { receiverUid: 'u_fixture', callerUid: 'u_bot' });
  f.bridge.detach();
});

test('set_online_status maps to msg.setStatus with NapCat status table', async () => {
  const f = fixture();
  f.msg.setStatus = param => { f.calls.push(['status', param]); return { result: 0 }; };
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('set_online_status'));
  await f.bridge.call('set_online_status', { status: 30, ext_status: 1, battery_status: 80 });
  assert.deepEqual(f.calls.find(x => x[0] === 'status')[1], { status: 30, extStatus: 1, batteryStatus: 80 });
  await assert.rejects(f.bridge.call('set_online_status', { status: 999 }), { code: 'INVALID_PARAMS' });
  f.bridge.detach();
});

test('get_group_honor_info maps to getGroupHonorList and projects bounded fields', async () => {
  const f = fixture();
  f.group.getGroupHonorList = code => { f.calls.push(['honor', code]); return { result: 0, groupHonorList: [
    { userId: FRIEND, nick: 'Synthetic', honorLevel: 3, honorType: 1, honorName: '龙王' },
  ] }; };
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('get_group_honor_info'));
  const result = await f.bridge.call('get_group_honor_info', { group_id: 20001 });
  assert.deepEqual(result, { group_id: 20001, honors: [{ user_id: Number(FRIEND), nickname: 'Synthetic', honor_level: 3, honor_type: 1, honor_name: '龙王' }] });
  assert.deepEqual(f.calls.find(x => x[0] === 'honor')[1], '20001');
  f.bridge.detach();
});

test('set_qq_avatar maps to profile.setHeader with an absolute local path', async () => {
  const f = fixture();
  f.profile.setHeader = path => { f.calls.push(['avatar', path]); return { result: 0 }; };
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('set_qq_avatar'));
  await f.bridge.call('set_qq_avatar', { file: '/qq-onebot/runtime/media/avatar.png' });
  assert.deepEqual(f.calls.find(x => x[0] === 'avatar')[1], '/qq-onebot/runtime/media/avatar.png');
  await assert.rejects(f.bridge.call('set_qq_avatar', { file: 'relative.png' }), { code: 'INVALID_PARAMS' });
  f.bridge.detach();
});

test('add_custom_face maps to msg.addFavEmoji with a bounded source', async () => {
  const f = fixture();
  f.msg.addFavEmoji = file => { f.calls.push(['face', file]); return { result: 0 }; };
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('add_custom_face'));
  await f.bridge.call('add_custom_face', { file: 'https://example.invalid/emoji.png' });
  assert.deepEqual(f.calls.find(x => x[0] === 'face')[1], 'https://example.invalid/emoji.png');
  f.bridge.detach();
});

// 2026-11-23 真机：add_custom_face 连失败 43 次（全 1500，agent 侧日志写「可能收藏已满，改存本地库」）。
// 怀疑是路径问题（贴纸在容器目录、addFavEmoji 在 QQ 进程内读不到），但**没能在真机上证实**：
// 加了一版「先经 imagePlacement 落位再收藏」的改动，生产上仍是 1502「Action was not submitted」，
// 而 imagePlacement 在生产宿主里到底注没注入也没确认 ⇒ 按「不留未验证的行为改动」回退。
// 这条留作指针：要再攻先确认宿主是否注入 imagePlacement，以及 addFavEmoji 吃不吃 base64/路径。
