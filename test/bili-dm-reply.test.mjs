// 私信：能按会话回（不依赖「私信对端」），同一句不会回两遍，受每日上限约束。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dmActions } from '../src/platforms/bilibili/actions/publish-dm.mjs';
import { createBehavior } from '../input/agent-app/src/features/bili-behavior/index.mjs';

const SELF = '3747573426818991';
const TALKER = '1680813704';

test('协议端：bili_dm_send_text 是写动作、按 talker 发、不绑 peer', async () => {
  const spec = dmActions.bili_dm_send_text;
  assert.equal(spec.write, true);
  assert.deepEqual(spec.params, ['talker_id', 'content']);
  assert.notEqual(spec.peer, true, '按会话回复不该要求先配私信对端');
  const calls = [];
  const ctx = {
    selfId: SELF,
    deviceId: '11111111-2222-4333-8444-555555555555',
    request: async (req) => { calls.push(req); return { msg_key: '9007199254740993001' }; },
  };
  const out = await spec.run(ctx, { talker_id: TALKER, content: '在的' });
  assert.equal(out.msg_key, '9007199254740993001');
  assert.equal(calls[0].form['msg[receiver_id]'], TALKER);
  assert.equal(JSON.parse(calls[0].form['msg[content]']).content, '在的');
  await assert.rejects(spec.run(ctx, { talker_id: TALKER, content: '  ' }), TypeError);
});

function harness({ reply = '在的，刚看到', dailyLimit = 5, extraConfig = {}, dir = null } = {}) {
  const workDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  const calls = [];
  const call = async (action, params) => {
    calls.push({ action, params });
    if (action === 'bili_dm_inbox') {
      return { session_list: [{ talker_id: TALKER, unread_count: 1, session_ts: 1795326711991671 }] };
    }
    if (action === 'bili_dm_peer_history') {
      return { messages: [{ sender_uid: TALKER, timestamp: 1795326711, msg_key: 'k1', content: '现在在吗' }] };
    }
    if (action === 'bili_dm_send_text') return { msg_key: 'mk1' };
    return {};
  };
  const behavior = createBehavior({
    config: {
      enabled: true, 'browse.enabled': false, 'dm.enabled': true, 'dm.maxPerDay': dailyLimit,
      'admin.uid': TALKER, 'risk.maxPerHour': 30,
      ...extraConfig,
    },
    call,
    paths: { dir: workDir },
    accountId: SELF,
    generateDmReply: async ({ text }) => ({ text: `${reply}（收到：${text}）` }),
  });
  return { behavior, calls, dir: workDir };
}

// ★ 两个都在真机上踩到过（2026-11-22 17:1x）：
//   ① 协议端 `bili_dm_peer_history` 返回是**新→旧**，取数组末尾会回到最旧那条；
//   ② 系统会话的 `msg[content]` 是通知卡片 JSON（"登录操作通知"），把它当聊天内容去回，
//      既没意义又把自己撞上 1429 限频。
test('只回最新的那条文本消息；通知卡片不当聊天内容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  const calls = [];
  const behavior = createBehavior({
    config: { enabled: true, 'browse.enabled': false, 'dm.enabled': true, 'dm.maxPerDay': 5 },
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'bili_dm_inbox') {
        return {
          session_list: [
            { talker_id: TALKER, unread_count: 2, session_ts: 1795326711991671 },
            { talker_id: '844424930131964', unread_count: 1, session_ts: 1795192715298177 },
          ],
        };
      }
      if (action === 'bili_dm_peer_history') {
        if (String(params.talker_id) === '844424930131964') {
          return { messages: [{ sender_uid: '844424930131964', timestamp: 1795170362, msg_key: 'n1', content: JSON.stringify({ title: '登录操作通知', text: '你的账号在新设备登录', jump_text: '查看详情' }) }] };
        }
        // 新 → 旧：最上面那条才是该回的
        return {
          messages: [
            { sender_uid: TALKER, timestamp: 1795326711, msg_key: 'k-new', content: JSON.stringify({ content: '现在在吗' }) },
            { sender_uid: SELF, timestamp: 1795326000, msg_key: 'k-self', content: JSON.stringify({ content: '在的' }) },
            { sender_uid: TALKER, timestamp: 1795170589, msg_key: 'k-old', content: JSON.stringify({ content: '我们已互相关注，开始聊天吧~' }) },
          ],
        };
      }
      if (action === 'bili_dm_send_text') return { msg_key: 'mk1' };
      return {};
    },
    paths: { dir },
    accountId: SELF,
    generateDmReply: async ({ text }) => ({ text: `回复：${text}` }),
  });
  try {
    const r = await behavior.runOnce();
    const sent = calls.filter((c) => c.action === 'bili_dm_send_text');
    assert.equal(sent.length, 1, '通知卡片不该发消息');
    assert.equal(sent[0].params.talker_id, TALKER);
    assert.ok(String(sent[0].params.content).includes('现在在吗'), '要回最新那条，而不是最旧那条');
    assert.equal(r.dmReplies, 1);
  } finally {
    behavior.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('私信发送被限频(1429)后进入冷却，不再每轮硬撞', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  const calls = [];
  let sendCount = 0;
  const behavior = createBehavior({
    config: { enabled: true, 'browse.enabled': false, 'browse.windows': ['00:00-23:59'], 'dm.enabled': true, 'dm.maxPerDay': 5, 'risk.backoffMinutes': 15 },
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'bili_dm_inbox') {
        return { session_list: [{ talker_id: TALKER, unread_count: 1, session_ts: 1795326711991671 }] };
      }
      if (action === 'bili_dm_peer_history') {
        return { messages: [{ sender_uid: TALKER, timestamp: 1795326711, msg_key: 'k1', content: JSON.stringify({ content: '在吗' }) }] };
      }
      if (action === 'bili_dm_send_text') {
        sendCount += 1;
        const err = new Error('bili_dm_send_text failed (1429)');
        err.code = '1429';
        throw err;
      }
      return {};
    },
    paths: { dir },
    accountId: SELF,
    generateDmReply: async () => ({ text: '在的' }),
    clock: (() => { let t = 1795326800000; return { now: () => t, advance: (ms) => { t += ms; } }; })(),
  });
  try {
    await behavior.runOnce();
    assert.equal(sendCount, 1, '第一次该真去发');
    // 冷却期内再来一条新消息，也不该再撞
    await behavior.runOnce();
    await behavior.runOnce();
    assert.equal(sendCount, 1, '限频后必须冷却，不能每轮硬撞');
  } finally {
    behavior.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('收到私信会按会话回一句，并落 dm.jsonl + 记流水', async () => {
  const { behavior, calls, dir } = harness();
  try {
    const result = await behavior.runOnce();
    const sent = calls.filter((c) => c.action === 'bili_dm_send_text');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.talker_id, TALKER);
    assert.ok(String(sent[0].params.content).includes('在的'));
    assert.equal(result.dmCount, 1);
    assert.equal(result.dmReplies, 1);
    const dmRows = fs.readFileSync(path.join(dir, 'dm.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const incoming = dmRows.filter((r) => r.kind !== 'reply');
    const replies = dmRows.filter((r) => r.kind === 'reply');
    assert.equal(incoming.length, 1, '一条来信只落一行（不该每个 tick 都重复落）');
    assert.equal(incoming[0].talker, TALKER);
    assert.equal(incoming[0].msgKey, 'k1', '去重键要用消息身份，不是会话时间');
    assert.equal(incoming[0].isAdmin, true, 'admin.uid 命中要标成管理员');
    assert.equal(replies.length, 1, '回过谁要落盘，否则 worker 重启会重放');
    assert.equal(replies[0].msgKey, 'k1');
  } finally {
    behavior.stop();
  }
});

// ★ 真机踩出来的：worker 会随 App 重启 / 配置变更 / 协议端换端口反复重建，
//   而「已经回过谁」原先只存在内存 Set 里 ⇒ 每次重启都把同一句再回一遍。
//   现在水位从 dm.jsonl 重建，这条测试就是那个重启场景。
test('worker 重启后不会把同一句私信再回一遍（水位从库里重建）', async () => {
  const first = harness();
  try {
    const r1 = await first.behavior.runOnce();
    assert.equal(r1.dmReplies, 1);
  } finally {
    first.behavior.stop();
  }
  // 全新的 behavior 实例（等价于 worker 重启），只带同一个数据目录
  const second = harness({ dir: first.dir });
  try {
    const r2 = await second.behavior.runOnce();
    assert.equal(second.calls.filter((c) => c.action === 'bili_dm_send_text').length, 0, '重启后不许重放');
    assert.equal(r2.dmReplies || 0, 0);
    assert.equal(r2.dmCount || 0, 0, '同一条消息也不该再落一行');
  } finally {
    second.behavior.stop();
  }
  fs.rmSync(first.dir, { recursive: true, force: true });
});

// ★ 巡看有每日配额，但「今天不看了」不等于「今天不回消息」。
//   第 141 轮之前 tick() 在配额/到点这些 return 之后才轮询私信，结果是：
//   巡看额度用完或还没到下一次巡看时，别人发来的私信一律没人看（表现就是"不回复我"）。
test('巡看每日上限用完时，私信照样收、照样回', async () => {
  const { behavior, calls, dir } = harness({
    extraConfig: { 'browse.enabled': true, 'browse.windows': ['00:00-23:59'], 'browse.maxPerDay': 0 },
  });
  try {
    const result = await behavior.runOnce();
    assert.equal(result.dmCount, 1, '巡看配额为 0 也要收私信');
    assert.equal(result.dmReplies, 1, '收得到就该回');
    assert.equal(calls.filter((c) => c.action === 'bili_dm_send_text').length, 1);
  } finally {
    behavior.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同一句私信不会被回两遍', async () => {
  const { behavior, calls, dir } = harness();
  try {
    await behavior.runOnce();
    await behavior.runOnce();
    assert.equal(calls.filter((c) => c.action === 'bili_dm_send_text').length, 1);
  } finally {
    behavior.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('没注入私信回复器时只记录、不发送', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  const calls = [];
  const behavior = createBehavior({
    config: { enabled: true, 'browse.enabled': false, 'dm.enabled': true, 'dm.maxPerDay': 5 },
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'bili_dm_inbox') return { session_list: [{ talker_id: TALKER, unread_count: 1, session_ts: 1 }] };
      if (action === 'bili_dm_peer_history') return { messages: [{ sender_uid: TALKER, timestamp: 1, content: 'hi' }] };
      return {};
    },
    paths: { dir },
    accountId: SELF,
  });
  try {
    const result = await behavior.runOnce();
    assert.equal(calls.filter((c) => c.action === 'bili_dm_send_text').length, 0);
    assert.equal(result.dmCount, 1);
    assert.equal(result.dmReplies || 0, 0);
  } finally {
    behavior.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
