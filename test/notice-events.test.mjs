// 免 hook 事件面 · 阶段 1：6 类 notice 的单元测试。
//
// 规格来源（断言只依赖这两份文档里的**对外形状**，不断言任何私有方法名）：
//   docs/notice-event-contract-2026-11-17.md        §1 六类 notice / §2 精确字段 / §3 uid→uin / §4 灰条解析 / §5 计数
//   docs/non-hook-capability-matrix-2026-11-17.md   §4 灰条 busiId 表
//
// 夹具全部合成：群号 20001，QQ 号 10001..10006，uid 形如 u_fake_*，绝不使用真实号码。
// 运行：node --test test\notice-events.test.mjs
//
// 用例 → 合同条款
//   1  group_recall      §1 / §2      onMsgRecall(2, peerUid, msgSeq)
//   2  friend_recall     §1 / §2      onMsgRecall(1, peerUid, msgSeq)，无 group_id
//   3  notify.poke       §1 / §4      灰条 busiId 1061，items[].uid = [发起者, 被拍者]
//   4  group_ban         §1 / §4      灰条 busiId 1014 ⇒ ban，2402 ⇒ lift_ban，带 duration
//   5  group_increase    §1 / §4      灰条 busiId 1022 ⇒ sub_type approve
//   6  group_decrease    §1 / §4      onMemberListChange（合同「成员消失」路径）
//   7  幂等              §0.2        同一 (会话, msgId, 类型) 只发一次，且不误伤后续同类事件
//   8  灰条不当普通消息   §0 / §4      灰条正文不得透传到 message 事件
//   9  换算失败不发       §3 / §5      getUin 空/抛错 ⇒ 丢弃并计入 stats.noticeDroppedNoUid
//  10  写闸不受影响       §0.3        notice 不改变 status().write_ready

import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

const SELF = Number(BOT_UIN);
const GROUP = 20001;          // 合成群号
const FRIEND_UIN = 10001;     // 合成 QQ 号（私聊对方）
const MEMBER_UIN = 10002;     // 合成 QQ 号（被撤回 / 被禁言者）
const ADMIN_UIN = 10003;      // 合成 QQ 号（群管理 = 灰条发送者 = 操作者）
const NEWCOMER_UIN = 10004;   // 合成 QQ 号（入群者）
const GONE_UIN = 10005;       // 合成 QQ 号（退群者）
const POKER_UIN = 10006;      // 合成 QQ 号（戳人者）

const UID = {
  self: 'u_fake_self',
  friend: 'u_fake_friend',
  member: 'u_fake_member',
  admin: 'u_fake_admin',
  newcomer: 'u_fake_newcomer',
  gone: 'u_fake_gone',
  poker: 'u_fake_poker',
};
// uid → uin 的唯一真源；夹具里出现的任何 uid 都必须在这里有对应合成号码。
const UIN_OF = {
  [UID.self]: SELF,
  [UID.friend]: FRIEND_UIN,
  [UID.member]: MEMBER_UIN,
  [UID.admin]: ADMIN_UIN,
  [UID.newcomer]: NEWCOMER_UIN,
  [UID.gone]: GONE_UIN,
  [UID.poker]: POKER_UIN,
};

const TIME = '1731812400';

// ---------------------------------------------------------------- 等待工具
async function until(check, label) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await turn();
  }
  assert.fail(`合成等待超时：「${label}」没有出现`);
}
// 负向断言用：给实现足够多的机会去发，然后确认它确实没发。
async function settle() {
  for (let index = 0; index < 8; index++) await turn();
}

// ---------------------------------------------------------------- 合成原生消息
function text(overrides = {}) {
  return {
    msgId: '90071992547409931', msgSeq: '51', msgTime: TIME, chatType: 2,
    peerUid: String(GROUP), senderUid: UID.member, senderUin: MEMBER_UIN, sendNickName: 'Synthetic',
    elements: [{ elementType: 1, textElement: { content: 'synthetic notice target' } }],
    ...overrides,
  };
}

// 灰条消息（elementType 8）。jsonGrayTipElement 与 groupElement 是真实内核会带上的两种子形状：
//   - busiId 分派：jsonGrayTipElement.busiId + jsonStr 里的 items
//   - 群系统灰条：groupElement.type（TipGroupElementType）
function grayTip({ msgId, msgSeq, subElementType = 17, busiId, items, groupElement, ...overrides }) {
  const grayTipElement = { subElementType };
  if (groupElement) grayTipElement.groupElement = groupElement;
  if (busiId !== undefined) {
    grayTipElement.jsonGrayTipElement = { busiId, jsonStr: JSON.stringify({ items }) };
  }
  return {
    msgId, msgSeq, msgTime: TIME, chatType: 2, peerUid: String(GROUP),
    senderUid: UID.member, senderUin: MEMBER_UIN, sendNickName: 'Synthetic',
    elements: [{ elementType: 8, grayTipElement }],
    ...overrides,
  };
}

// 戳一戳灰条：busiId 1061，items 里两个带 uid 的元素 = [发起者, 被拍者]（合同 §4）。
const pokeTip = (msgId = '90071992547409941', msgSeq = '61') => grayTip({
  msgId, msgSeq, busiId: '1061',
  items: [{ uid: UID.poker }, { uid: UID.self }],
});

// ---------------------------------------------------------------- 夹具
function fixture(t, options = {}) {
  const events = [];
  const calls = [];
  // 桥会往同一个 msg 服务上注册**两个** listener 对象（主消息流 + notice），
  // 所以夹具必须按数组保存、按方法名广播，不能只留最后一个。
  const msgListeners = [];
  const groupListeners = [];
  let nextId = 90071992547409960n;
  const identity = {
    user_id: SELF, uid: UID.self, nickname: 'Synthetic bot',
    sessionId: 'synthetic-notice-A',
    authenticated: true, sessionAuthorized: true, online: true, online_known: true,
  };
  // 内核 NodeIKernelUixConvertService.getUin 的声明形状是 { uinInfo: Map }
  // （.tmp/napcat-src/packages/napcat-core/services/NodeIKernelUixConvertService.ts:2）。
  // 这里返回的 Map 自带 uinInfo 自引用，使 result.get(uid) 与 result.uinInfo.get(uid)
  // 两种读法都成立 —— 夹具不偏向任何一种实现写法。
  const uinResult = uinInfo => Object.assign(uinInfo, { uinInfo });
  const uinInfoOf = uids => uinResult(new Map(uids.map(uid => [uid, String(UIN_OF[uid] ?? '')])));
  const uix = {
    async getUin(uids) {
      calls.push(['getUin', [...uids]]);
      if (options.getUin) return options.getUin(uids);
      return uinInfoOf(uids);
    },
    async getUid(uins) {
      calls.push(['getUid', [...uins]]);
      return uinResult(new Map(uins.map(uin => [String(uin), UID.friend])));
    },
  };
  const msg = {
    addKernelMsgListener(value) { msgListeners.push(value); return msgListeners.length; },
    removeKernelMsgListener() {},
    generateMsgUniqueId() { return String(nextId++); },
    async sendMsg() { return { result: 0 }; },
    async getMsgsByMsgId() { return { result: 0, msgList: [] }; },
  };
  const group = {
    addKernelGroupListener(value) { groupListeners.push(value); return groupListeners.length; },
    removeKernelGroupListener() {},
    getUidByUins(uins) { return { errCode: 0, uids: new Map(uins.map(uin => [uin, UID.friend])) }; },
    getUinByUids(uids) { return { errCode: 0, uins: new Map(uids.map(uid => [uid, String(UIN_OF[uid] ?? '')])) }; },
    async getAllMemberList() { return { errCode: 0, result: { infos: new Map(), finish: true } }; },
  };
  const session = {
    getSessionId: () => identity.sessionId,
    getMsgService: () => msg,
    getGroupService: () => group,
    getUixConvertService: () => uix,
  };
  const bridge = new NativeBridge({
    session, identityProbe: async () => identity, authorizationPolicy: 'native-session', timeoutMs: 200,
  });
  bridge.on('event', event => events.push(event));
  t.after(() => bridge.detach());

  // 向所有已注册 listener 广播一个回调；返回是否真的有 listener 实现了它。
  const broadcast = (listeners, method, args) => {
    let handled = false;
    for (const listener of listeners) {
      if (typeof listener?.[method] !== 'function') continue;
      handled = true;
      listener[method](...args);
    }
    return handled;
  };
  return {
    bridge, events, calls, uix, identity,
    async attach() { await bridge.attach(); },
    receive(value) {
      assert.ok(broadcast(msgListeners, 'onRecvMsg', [Array.isArray(value) ? value : [value]]),
        '桥没有订阅 NodeIKernelMsgListener.onRecvMsg，灰条消息根本进不来');
    },
    recall(chatType, peerUid, msgSeq) {
      assert.ok(broadcast(msgListeners, 'onMsgRecall', [chatType, peerUid, msgSeq]),
        '桥没有订阅 NodeIKernelMsgListener.onMsgRecall（合同 §1 的撤回来源）');
    },
    memberListChange(payload) {
      assert.ok(broadcast(groupListeners, 'onMemberListChange', [payload]),
        '桥没有订阅 NodeIKernelGroupListener.onMemberListChange（合同 §1 的 group_decrease 来源）');
    },
  };
}

const notices = f => f.events.filter(event => event.post_type === 'notice');
const messageEvents = f => f.events.filter(event => event.post_type === 'message' || event.post_type === 'message_sent');
const only = f => {
  const list = notices(f);
  assert.equal(list.length, 1, `应当恰好 1 条 notice，实际 ${list.length} 条：${JSON.stringify(list)}`);
  return list[0];
};

// ---------------------------------------------------------------- 1. group_recall
test('group recall notice carries group_id, sender user_id and the OneBot message_id', async t => {
  const f = fixture(t);
  await f.attach();
  f.receive([text()]);
  await until(() => messageEvents(f).length === 1, '原始群消息');
  const original = messageEvents(f)[0];
  assert.ok(Number.isInteger(original.message_id), '夹具前置：原始消息必须先拿到 OneBot message_id');

  f.recall(2, String(GROUP), '51');
  const notice = only(f);
  assert.equal(notice.post_type, 'notice');
  assert.equal(notice.notice_type, 'group_recall');
  assert.equal(notice.self_id, SELF);
  assert.equal(notice.group_id, GROUP, 'group_recall 必须带群号');
  assert.equal(notice.user_id, MEMBER_UIN, 'user_id 是被撤回消息的发送者');
  assert.equal(notice.message_id, original.message_id,
    'message_id 必须是本条消息此前发出的那个 OneBot message_id（否则 delete_msg 引用不上）');
  assert.ok(Number.isInteger(notice.time), 'time 必须是整数秒');
  // onMsgRecall 只给 (chatType, peerUid, msgSeq)，拿不到真实操作者；可以省略 operator_id，
  // 但**不许编造**：若给了，只能等于已知的发送者。
  assert.ok(notice.operator_id === undefined || notice.operator_id === MEMBER_UIN,
    `operator_id 不可臆造，实际 ${JSON.stringify(notice.operator_id)}`);
});

// ---------------------------------------------------------------- 2. friend_recall
test('friend recall notice has no group_id and keeps the private sender', async t => {
  const f = fixture(t);
  await f.attach();
  f.receive([text({ msgId: '90071992547409932', msgSeq: '71', chatType: 1,
    peerUid: UID.friend, senderUid: UID.friend, senderUin: FRIEND_UIN })]);
  await until(() => messageEvents(f).length === 1, '原始私聊消息');
  const original = messageEvents(f)[0];
  assert.equal(original.message_type, 'private', '夹具前置：私聊消息');

  f.recall(1, UID.friend, '71');
  const notice = only(f);
  assert.equal(notice.post_type, 'notice');
  assert.equal(notice.notice_type, 'friend_recall');
  assert.equal(notice.self_id, SELF);
  assert.equal(notice.user_id, FRIEND_UIN);
  assert.equal(notice.message_id, original.message_id);
  assert.equal(Object.hasOwn(notice, 'group_id'), false,
    `friend_recall 不许带 group_id（合同 §2 私聊示例没有该字段），实际 ${JSON.stringify(notice.group_id)}`);
  assert.ok(Number.isInteger(notice.time));
});

// ---------------------------------------------------------------- 3. notify.poke
test('poke gray tip projects notify/poke with target_id and both uids in raw_info', async t => {
  const f = fixture(t);
  await f.attach();
  f.receive([pokeTip()]);
  await until(() => notices(f).length === 1, 'notify.poke notice');
  const notice = only(f);
  assert.equal(notice.post_type, 'notice');
  assert.equal(notice.notice_type, 'notify');
  assert.equal(notice.sub_type, 'poke');
  assert.equal(notice.self_id, SELF);
  assert.equal(notice.group_id, GROUP, '群里的戳一戳要带群号');
  assert.equal(notice.user_id, POKER_UIN, 'user_id 是发起戳的人 = items[0].uid 换算结果');
  assert.equal(notice.target_id, SELF, 'target_id 是被戳的人 = items[1].uid 换算结果（本机）');
  assert.ok(Array.isArray(notice.raw_info), 'raw_info 必须保留原始 uid 列表');
  assert.deepEqual(notice.raw_info.map(item => item?.uid), [UID.poker, UID.self],
    'raw_info 必须原样保留两个 uid，顺序为 [发起者, 被拍者]');
  assert.equal(JSON.stringify(notice).includes('jsonStr'), false,
    '合同 §4：不要把整段 jsonStr 透传给上层');
});

// ---------------------------------------------------------------- 4. group_ban
test('ban gray tips map busiId 1014 to ban and 2402 to lift_ban with duration', async t => {
  const f = fixture(t);
  await f.attach();

  // 灰条发送者 = 执行禁言的群管理（原生里这条灰条由操作者的动作产生）。
  // 同时把同一份事实写进 items（uid 顺序 = 被禁言者, 操作者）与 groupElement.shutUp，
  // 这样按 items 解析、按 groupElement.shutUp 解析、按 raw.senderUin 取操作者的实现都能对上。
  f.receive([grayTip({
    msgId: '90071992547409933', msgSeq: '81', busiId: '1014',
    senderUid: UID.admin, senderUin: ADMIN_UIN,
    items: [{ uid: UID.member }, { uid: UID.admin }, { txt: '合成：禁言 10 分钟' }],
    groupElement: { type: 8, shutUp: { duration: '600', admin: { uid: UID.admin }, member: { uid: UID.member } } },
  })]);
  await until(() => notices(f).length === 1, 'group_ban(ban) notice');
  f.receive([grayTip({
    msgId: '90071992547409934', msgSeq: '82', busiId: '2402',
    senderUid: UID.admin, senderUin: ADMIN_UIN,
    items: [{ uid: UID.member }, { uid: UID.admin }, { txt: '合成：解除禁言' }],
    groupElement: { type: 8, shutUp: { duration: '0', admin: { uid: UID.admin }, member: { uid: UID.member } } },
  })]);
  await until(() => notices(f).length === 2, 'group_ban(lift_ban) notice');

  const [ban, lift] = notices(f);
  assert.equal(ban.post_type, 'notice');
  assert.equal(ban.notice_type, 'group_ban');
  assert.equal(ban.sub_type, 'ban', 'busiId 1014 ⇒ 禁言');
  assert.equal(ban.self_id, SELF);
  assert.equal(ban.group_id, GROUP);
  assert.equal(ban.user_id, MEMBER_UIN, 'user_id 是被禁言的人');
  assert.equal(ban.operator_id, ADMIN_UIN, 'operator_id 是执行禁言的人');

  assert.equal(lift.notice_type, 'group_ban');
  assert.equal(lift.sub_type, 'lift_ban', 'busiId 2402 ⇒ 解除禁言');
  assert.equal(lift.group_id, GROUP);
  assert.equal(lift.user_id, MEMBER_UIN);
  assert.equal(lift.operator_id, ADMIN_UIN);

  // 合同 §2 的 group_ban 示例带 duration（禁言秒数）。原生把它放在
  // grayTipElement.groupElement.shutUp.duration（字符串 "600" / "0"）。
  // 放在最后断言：上面所有形状项都跑完了，再暴露这一处缺口。
  assert.equal(ban.duration, 600, '禁言 notice 必须带 duration 秒数（合同 §2）');
  assert.equal(lift.duration ?? 0, 0, '解除禁言不许带正数 duration');
});

// ---------------------------------------------------------------- 5. group_increase
test('member-join gray tip projects group_increase/approve for the joining member', async t => {
  const f = fixture(t);
  await f.attach();
  // 灰条发送者 = 拉人进群的操作者；items 里唯一的 uid 是入群者。
  f.receive([grayTip({
    msgId: '90071992547409935', msgSeq: '91', busiId: '1022',
    senderUid: UID.admin, senderUin: ADMIN_UIN,
    items: [{ uid: UID.newcomer }, { txt: '合成：加入本群' }],
  })]);
  await until(() => notices(f).length === 1, 'group_increase notice');
  const notice = only(f);
  assert.equal(notice.post_type, 'notice');
  assert.equal(notice.notice_type, 'group_increase', 'busiId 1022 ⇒ 入群');
  assert.equal(notice.sub_type, 'approve', '合同 §2 入群固定 sub_type=approve');
  assert.equal(notice.self_id, SELF);
  assert.equal(notice.group_id, GROUP);
  assert.equal(notice.user_id, NEWCOMER_UIN, 'user_id 是入群的人（items 里唯一的 uid）');
  // 合同 §2 的示例写 operator_id: 0（不知道操作者）。灰条发送者确实可能就是操作者，
  // 所以这里只断言「不臆造」：要么 0/缺省，要么就是夹具里那个真实的操作者。
  assert.ok([0, ADMIN_UIN].includes(notice.operator_id ?? 0),
    `operator_id 只能是 0（未知）或真实操作者 ${ADMIN_UIN}，实际 ${JSON.stringify(notice.operator_id)}`);
});

// ---------------------------------------------------------------- 6. group_decrease
test('member-list change projects group_decrease/leave for the leaving member', async t => {
  const f = fixture(t);
  await f.attach();
  // 合同 §1 把 group_decrease 的来源写成「灰条 / onMemberListChange（成员消失）」。
  // 退群灰条没有文档化的 json busiId，所以这里覆盖内核监听回调这条路。
  // 真机载荷是 { sceneId, ids, infos, hasPrev, hasNext, hasRobot }（内核声明）；
  // hasPrev=false 是**初次全量同步**，不是变化——实现会跳过它（避免启动时刷出几百条假退群）。
  f.memberListChange({ sceneId: String(GROUP), ids: [UID.gone], infos: new Map(), hasPrev: true, hasNext: true });
  await until(() => notices(f).length === 1, 'group_decrease notice');
  const notice = only(f);
  assert.equal(notice.post_type, 'notice');
  assert.equal(notice.notice_type, 'group_decrease');
  assert.equal(notice.sub_type, 'leave', '成员消失默认 leave（kick/kick_me 需要操作者或被踢证据）');
  assert.equal(notice.self_id, SELF);
  assert.equal(notice.group_id, GROUP);
  assert.equal(notice.user_id, GONE_UIN, 'user_id 是退群的人');
  assert.equal(notice.operator_id ?? 0, 0, '没有操作者证据时只能省略或 0，不许臆造');
});

// ---------------------------------------------------------------- 7. 幂等
test('the same gray tip delivered twice emits exactly one notice', async t => {
  const f = fixture(t);
  await f.attach();
  const tip = pokeTip();
  f.receive([tip]);
  await until(() => notices(f).length === 1, '第一条 poke notice');
  f.receive([tip]);                 // 同一条消息（同 msgId）再喂一次
  await settle();
  assert.equal(notices(f).length, 1,
    `同一 (会话, msgId, 类型) 只应发一次，实际 ${notices(f).length} 次`);
  assert.equal(notices(f)[0].notice_type, 'notify');
  assert.equal(notices(f)[0].sub_type, 'poke');

  // 反向确认去重没有「过度抑制」：之后另一次真实的拍一拍（不同 msgId）必须照常发。
  f.receive([pokeTip('90071992547409942', '62')]);
  await until(() => notices(f).length === 2, '第二次独立 poke notice');
  assert.equal(notices(f)[1].sub_type, 'poke');
});

// ---------------------------------------------------------------- 8. 灰条不当普通消息
test('a gray tip never leaks its body into a message event', async t => {
  const f = fixture(t);
  await f.attach();

  // (a) 能识别的灰条（1061）已经变成 notice，就不该再产出一条空的普通消息。
  f.receive([pokeTip()]);
  await until(() => notices(f).length === 1, 'poke notice');
  await settle();
  assert.equal(messageEvents(f).length, 0,
    `灰条不应再产出普通消息事件（否则会话里会冒出空消息），实际 ${JSON.stringify(messageEvents(f))}`);

  // (b) 识别不了的灰条（busiId 9999）：无论实现选择丢弃还是保留占位，
  //     灰条正文（uid / txt / jsonStr）都**不许**透传到 message 事件里。
  f.receive([grayTip({
    msgId: '90071992547409937', msgSeq: '97', busiId: '9999',
    items: [{ uid: UID.gone }, { txt: '合成：未知业务灰条正文' }],
  })]);
  await settle();
  for (const event of messageEvents(f)) {
    const dump = JSON.stringify(event);
    assert.equal(dump.includes(UID.gone), false, `message 事件泄漏了灰条 uid：${dump}`);
    assert.equal(dump.includes('合成：未知业务灰条正文'), false, `message 事件泄漏了灰条正文：${dump}`);
    assert.equal(dump.includes('jsonStr'), false, `message 事件泄漏了 jsonStr 字段：${dump}`);
  }
});

// ---------------------------------------------------------------- 9. uid 换算失败不发
test('a gray tip whose uid cannot be converted is dropped and counted', async t => {
  // 空表：内核没有返回任何 uin。
  const empty = fixture(t, { getUin: () => uinResultEmpty() });
  await empty.attach();
  empty.receive([pokeTip()]);
  await settle();
  assert.equal(notices(empty).length, 0, '换算不出 uin 时宁可不发（合同 §3）');
  assert.ok((empty.bridge.stats?.noticeDroppedNoUid ?? 0) >= 1,
    `合同 §5 要求 stats.noticeDroppedNoUid 增加，实际 stats=${JSON.stringify(empty.bridge.stats)}`);

  // 抛错：换算服务本身失败，同样不许抛出去打断消息流。
  const broken = fixture(t, { getUin: () => { throw new Error('synthetic uid conversion failure'); } });
  await broken.attach();
  broken.receive([pokeTip()]);
  await settle();
  assert.equal(notices(broken).length, 0, '换算抛错时宁可不发');
  assert.ok((broken.bridge.stats?.noticeDroppedNoUid ?? 0) >= 1,
    `换算抛错也要计入 noticeDroppedNoUid，实际 stats=${JSON.stringify(broken.bridge.stats)}`);

  // 消息流不能被打断：随后一条普通文本消息仍然要正常产出。
  broken.receive([text({ msgId: '90071992547409938', msgSeq: '99' })]);
  await until(() => messageEvents(broken).length === 1, '换算失败后的普通消息');
  assert.equal(messageEvents(broken)[0].raw_message, 'synthetic notice target');
});

// 空 uin 结果：Map 里没有这个 uid，两种读法都取不到值。
function uinResultEmpty() {
  const info = new Map();
  return Object.assign(info, { uinInfo: info });
}

// ---------------------------------------------------------------- 10. 写闸不受影响
test('notices never change the write gate', async t => {
  const f = fixture(t);
  await f.attach();
  const core = new OneBotCore({ bridge: f.bridge, authorizationPolicy: 'native-session', minimumWriteIntervalMs: 0 });
  t.after(() => core.close());
  const identity = await core.refreshIdentity(new AbortController().signal);
  assert.ok(identity, '夹具前置：native-session 身份核验必须成功');
  assert.equal(core.status().write_ready, true, '夹具前置：notice 之前写闸是开的');

  f.receive([pokeTip()]);
  await until(() => notices(f).length === 1, 'poke notice');
  assert.equal(core.status().write_ready, true, 'notice 只是读侧事件，不得影响 write_ready');
  assert.equal(core.status().session_authorized, true, 'notice 不得撤销会话授权');
  assert.equal(core.metrics.failures, 0, `notice 事件不得让 core 记失败，实际 ${core.metrics.failures}`);
});
