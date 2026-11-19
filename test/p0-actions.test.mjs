// P0 免 hook 动作的单元测试（会话元信息 / 精华消息 / 单条转发）。
// 夹具全部合成：不出现任何真实 QQ 号或群号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN;
const GROUP = '20001';
const FRIEND_UIN = '10002';

function raw(overrides = {}) {
  return {
    msgId: '90071992547409931', msgSeq: '51', msgRandom: '77', msgTime: '1700000000',
    chatType: 2, peerUid: GROUP, peerUin: GROUP, senderUid: 'u_fixture', senderUin: FRIEND_UIN,
    sendNickName: 'Synthetic',
    elements: [{ elementType: 1, textElement: { content: 'hello' } }],
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  let listener;
  let identity = { user_id: BOT, nickname: 'Synthetic bot', online: true, sessionId: 'p0-session' };
  const msg = {
    addKernelMsgListener(value) { listener = value; return 7; },
    removeKernelMsgListener() {},
    async forwardMsg(...args) { calls.push(['forward', ...args]); return { result: 0 }; },
  };
  const group = {
    addKernelGroupListener() { return 8; },
    removeKernelGroupListener() {},
    async addGroupEssence(param) { calls.push(['essence-add', param]); return { result: 0 }; },
    async removeGroupEssence(param) { calls.push(['essence-del', param]); return { result: 0 }; },
    async getUidByUins(uins) { return { errCode: 0, uids: new Map(uins.map(x => [x, 'u_fixture'])) }; },
  };
  const bridge = new NativeBridge({
    session: {
      getMsgService: () => msg,
      getGroupService: () => group,
      getBuddyService: () => ({}),
      getProfileService: () => ({}),
      getRichMediaService: () => options.richMedia,
      getSessionId: () => identity.sessionId,
    },
    identityProbe: async () => identity,
    timeoutMs: 50,
    ...options.bridgeOptions,
  });
  return {
    bridge, calls,
    setIdentity(value) { identity = value; },
    receive(value) { listener.onRecvMsg(value); },
  };
}

// 让消息进索引（消息动作都要求 message_id 在会话索引里）
async function primeMessage(f) {
  f.receive([raw()]);
  await new Promise(resolve => setTimeout(resolve, 20));
}

test('P0 会话元信息：get_login_info / get_version_info / can_send_image / can_send_record 可调用且形状正确', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  const caps = f.bridge.capabilities();
  for (const name of ['get_login_info', 'get_version_info', 'can_send_image', 'can_send_record'])
    assert.ok(caps.includes(name), `capabilities 里应有 ${name}`);

  const login = await f.bridge.call('get_login_info', {});
  assert.equal(login.user_id, Number(BOT));
  assert.equal(typeof login.nickname, 'string');

  const version = await f.bridge.call('get_version_info', {});
  assert.equal(version.protocol_version, 'v11');
  assert.equal(typeof version.app_version, 'string');
  assert.ok(version.app_version.length > 0);

  assert.deepEqual(await f.bridge.call('can_send_image', {}), { yes: true });
  const record = await f.bridge.call('can_send_record', {});
  assert.equal(typeof record.yes, 'boolean');
});

test('P0 精华：set_essence_msg 用索引里的 msgRandom/msgSeq 调内核 addGroupEssence', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  await primeMessage(f);

  const list = await f.bridge.call('get_group_msg_history', { group_id: Number(GROUP) }, {}).catch(() => null);
  // 索引里的 message_id 从 1 开始递增；直接取第一条
  const messageId = 1;
  await f.bridge.call('set_essence_msg', { group_id: Number(GROUP), message_id: messageId });
  const hit = f.calls.find(c => c[0] === 'essence-add');
  assert.ok(hit, '应调用 addGroupEssence');
  assert.deepEqual(hit[1], { groupCode: GROUP, msgRandom: 77, msgSeq: 51 });
  assert.equal(list, null, '历史查询在这里只是确保索引可用（本夹具不实现历史动作）');
});

test('P0 精华：del_essence_msg 调 removeGroupEssence', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  await primeMessage(f);

  await f.bridge.call('del_essence_msg', { group_id: Number(GROUP), message_id: 1 });
  const hit = f.calls.find(c => c[0] === 'essence-del');
  assert.ok(hit, '应调用 removeGroupEssence');
  assert.deepEqual(hit[1], { groupCode: GROUP, msgRandom: 77, msgSeq: 51 });
});

test('P0 精华：消息不在索引 → 1404，绝不用别人的消息设精', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  await assert.rejects(() => f.bridge.call('set_essence_msg', { group_id: Number(GROUP), message_id: 999 }),
    (error) => { assert.equal(error.retcode, 1404); return true; });
  assert.equal(f.calls.some(c => c[0] === 'essence-add'), false);
});

test('P0 精华：消息不属于该群 → 1404，且不发内核调用', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  await primeMessage(f);

  await assert.rejects(() => f.bridge.call('set_essence_msg', { group_id: 39999, message_id: 1 }),
    (error) => { assert.equal(error.retcode, 1404); return true; });
  assert.equal(f.calls.some(c => c[0] === 'essence-add'), false);
});

test('P0 精华：原生消息缺 msgSeq/msgRandom → 1404（不猜、不拿 0 充数）', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  f.receive([raw({ msgId: '90071992547409932', msgSeq: undefined, msgRandom: undefined })]);
  await new Promise(resolve => setTimeout(resolve, 20));

  await assert.rejects(() => f.bridge.call('set_essence_msg', { group_id: Number(GROUP), message_id: 1 }),
    (error) => { assert.equal(error.retcode, 1404); return true; });
  assert.equal(f.calls.some(c => c[0] === 'essence-add'), false);
});

test('P0 单条转发：forward_group_single_msg 传 (msgIds, srcPeer, [dstPeer], [])', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  await primeMessage(f);

  await f.bridge.call('forward_group_single_msg', { group_id: 39999, message_id: 1 });
  const hit = f.calls.find(c => c[0] === 'forward');
  assert.ok(hit, '应调用 forwardMsg');
  assert.deepEqual(hit[1], ['90071992547409931']);            // 原生 msgId 数组
  // peer 结构由 this.peer() 统一产出（含 guildId: ''），这里只断语义字段
  assert.equal(hit[2].chatType, 2);
  assert.equal(hit[2].peerUid, GROUP);   // 源会话取自索引
  assert.equal(Array.isArray(hit[3]) && hit[3].length, 1);
  assert.equal(hit[3][0].chatType, 2);
  assert.equal(hit[3][0].peerUid, '39999');
  assert.deepEqual(hit[4], []);                               // commentElements 为空
});

test('P0 单条转发：forward_friend_single_msg 目标是私聊 peer', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  await primeMessage(f);

  await f.bridge.call('forward_friend_single_msg', { user_id: Number(FRIEND_UIN), message_id: 1 });
  const hit = f.calls.find(c => c[0] === 'forward');
  assert.ok(hit, '应调用 forwardMsg');
  assert.equal(hit[3][0].chatType, 1, '私聊 chatType 必须是 1');
});

// ---------------------------------------------------------------- 群名补充（get_chat_names）
// 夹具全部合成：群 20001 有名字，20002 回包缺群名，20003 原生调用抛错，
// 20004/20005 认得请求但回调永不触发（模拟本机 onGroupDetailInfoChange 不触发）。
function nameFixture() {
  const calls = [];
  let groupListener;
  const identity = { user_id: BOT, nickname: 'Synthetic bot', online: true, sessionId: 'p0-names' };
  const names = { 20001: '合成群甲', 20002: '' };
  const silent = new Set(['20004', '20005']);
  const msg = { addKernelMsgListener() { return 7; }, removeKernelMsgListener() {} };
  const group = {
    addKernelGroupListener(value) { groupListener = value; return 8; },
    removeKernelGroupListener() {},
    getGroupDetailInfo(code, source) {
      calls.push([code, source]);
      if (code === '20003') throw new Error('synthetic native failure');
      if (silent.has(code)) return { result: 0 };   // 订阅了但不发回调 → 走超时
      const detail = { groupCode: code, groupName: names[code], memberNum: 3, maxMemberNum: 200 };
      queueMicrotask(() => groupListener.onGroupDetailInfoChange(detail));
      return { result: 0 };
    },
  };
  const bridge = new NativeBridge({
    session: {
      getMsgService: () => msg,
      getGroupService: () => group,
      getBuddyService: () => ({}),
      getProfileService: () => ({}),
      getRichMediaService: () => undefined,
      getSessionId: () => identity.sessionId,
    },
    identityProbe: async () => identity,
    timeoutMs: 200,
  });
  return { bridge, calls };
}

test('P0 群名：get_chat_names 逐个读群详情（source=1），单个失败只进 failed', async t => {
  const f = nameFixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  assert.ok(f.bridge.capabilities().includes('get_chat_names'), '群详情可用时应声明 get_chat_names');

  const result = await f.bridge.call('get_chat_names', { groups: ['20001', '20002', '20003'] });
  assert.deepEqual(result.names, { 20001: '合成群甲' });
  assert.deepEqual(result.failed, ['20002', '20003'],
    '缺群名 / 原生抛错的群只进 failed，不能让整批失败');
  assert.deepEqual(f.calls, [['20001', 1], ['20002', 1], ['20003', 1]],
    '串行读取，且 source=1（与 get_group_info 同一读法）');

  assert.deepEqual(await f.bridge.call('get_chat_names', { groups: [] }), { names: {}, failed: [] });
});

test('P0 群名：参数越界一律 1400，能力缺失时明确 1404', async t => {
  const f = nameFixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  for (const groups of [
    Array.from({ length: 51 }, (_, i) => String(20001 + i)), // 超过 50 个
    [20001],                                                  // 数字不是字符串
    ['abc'],                                                  // 不是 5-15 位数字
    ['2000'],                                                 // 太短
    ['2000112345678901'],                                     // 太长
    ['20001', '20001'],                                       // 重复
    undefined,                                                // 缺参数
  ]) {
    await assert.rejects(() => f.bridge.call('get_chat_names', { groups }),
      error => { assert.equal(error.retcode, 1400, JSON.stringify(groups)); return true; });
  }
  assert.deepEqual(f.calls, [], '参数不合法时一次原生调用都不许发');

  // 原生没有 getGroupDetailInfo 的 build：不声明能力，调用即 1404（面板照旧显示号码）。
  const bare = fixture();
  t.after(() => bare.bridge.detach());
  await bare.bridge.attach();
  assert.equal(bare.bridge.capabilities().includes('get_chat_names'), false);
  await assert.rejects(() => bare.bridge.call('get_chat_names', { groups: ['20001'] }),
    error => { assert.equal(error.retcode, 1404); return true; });
});

test('P0 群名：连续两次超时就收手，不再毒化更多通道、不拖满预算', async t => {
  const f = nameFixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  const result = await f.bridge.call('get_chat_names', { groups: ['20004', '20005', '20001', '20002'] });
  assert.deepEqual(result.names, {}, '回调不触发时一个名字都拿不到');
  assert.deepEqual(result.failed, ['20004', '20005', '20001', '20002'],
    '连续两次超时后剩下的群直接 failed，但仍在 failed 里逐个交代');
  assert.deepEqual(f.calls, [['20004', 1], ['20005', 1]],
    '回调判定不可用后不再发第三次读请求（避免毒化更多群详情通道）');
});
