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

function harness({ reply = '在的，刚看到', dailyLimit = 5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
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
    },
    call,
    paths: { dir },
    accountId: SELF,
    generateDmReply: async ({ text }) => ({ text: `${reply}（收到：${text}）` }),
  });
  return { behavior, calls, dir };
}

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
    assert.equal(dmRows.length, 1);
    assert.equal(dmRows[0].talker, TALKER);
    assert.equal(dmRows[0].isAdmin, true, 'admin.uid 命中要标成管理员');
  } finally {
    behavior.stop();
  }
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
