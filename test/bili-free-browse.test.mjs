// 自由巡看 vs 按分区：引擎必须真的把「分区」传到协议端（或者干脆不传），
// 而不是像以前那样只当展示标签。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createBehavior } = await import('../input/agent-app/src/features/bili-behavior/index.mjs');

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebrowse-'));
  const calls = [];
  const call = async (action, params) => {
    calls.push({ action, params });
    if (action === 'bili_recommend') {
      return { videos: [{ bvid: 'BV1free00001', title: '南极', author: 'UP', durationSec: 60, partition: 'knowledge' }] };
    }
    if (action === 'bili_video_info') return { aid: 1, durationSec: 60, title: '南极', author: 'UP' };
    if (action === 'bili_comments') return { comments: [] };
    return {};
  };
  const config = {
    enabled: true,
    'browse.enabled': true,
    'browse.windows': ['00:00-23:59'],
    'browse.sources': ['recommend'],
    'browse.freeBrowse': true,
    'browse.partitions': [],
    'browse.maxPerRun': 1,
    'browse.maxPerDay': 10,
    'browse.maxMinutesPerVideo': 1,
    'browse.gapMinutes': 0,
    'browse.jitterPercent': 0,
    'browse.skipPercent': 0,
    'read.enabled': false,
    'read.storeToLibrary': false,
    'write.enabled': false,
    'dm.enabled': false,
    'live.enabled': false,
    'risk.maxPerHour': 30,
    ...overrides,
  };
  const behavior = createBehavior({ config, call, paths: { dir }, accountId: 'me' });
  return { behavior, calls, dir };
}

const recommendCalls = (calls) => calls.filter((c) => c.action === 'bili_recommend');

test('自由巡看：不传 rid，走综合推荐流', async () => {
  const { behavior, calls } = harness();
  try {
    await behavior.tick();
  } finally {
    behavior.stop();
  }
  const got = recommendCalls(calls);
  assert.ok(got.length > 0, '必须真的调了推荐流');
  for (const call of got) assert.equal(call.params.rid, undefined, '自由巡看不该带 rid');
});

test('按分区：把选中的分区 id 作为 rid 传给协议端', async () => {
  const { behavior, calls } = harness({ 'browse.freeBrowse': false, 'browse.partitions': ['4'] });
  try {
    await behavior.tick();
  } finally {
    behavior.stop();
  }
  const got = recommendCalls(calls);
  assert.ok(got.length > 0, '必须真的调了推荐流');
  assert.equal(String(got[0].params.rid), '4');
});

test('旧配置（只有 partitions、没有 freeBrowse）仍然按分区走', async () => {
  const { behavior, calls } = harness({ 'browse.freeBrowse': undefined, 'browse.partitions': ['188'] });
  try {
    await behavior.tick();
  } finally {
    behavior.stop();
  }
  const got = recommendCalls(calls);
  assert.ok(got.length > 0);
  // 没有 freeBrowse 键时按旧语义处理：partitions 非空就按分区取流。
  assert.equal(String(got[0].params.rid), '188');
});
