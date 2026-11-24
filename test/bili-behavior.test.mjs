import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createBehavior,
  createLibrary,
  isInWindows,
  computeNextGapMs,
} from '../input/agent-app/src/features/bili-behavior/index.mjs';

function makeClock(initialDate) {
  let current = typeof initialDate === 'number' ? initialDate : new Date(initialDate).getTime();
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (next) => {
      current = typeof next === 'number' ? next : new Date(next).getTime();
    },
  };
}

async function makeTempDir(prefix = 'bili-behavior-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeVideos(bvids) {
  return bvids.map((bvid, idx) => ({
    bvid,
    title: `测试视频 ${bvid}`,
    author: `UP主${idx + 1}`,
    authorId: String(10000 + idx),
    durationSec: 120,
    desc: `简介 ${bvid}`,
  }));
}

function makeComments(bvid, count) {
  return Array.from({ length: count }, (_, idx) => ({
    rpid: `${bvid}_r${idx + 1}`,
    text: `这是一条评论内容编号 ${idx + 1}`,
    author: `路人${idx + 1}`,
    authorId: String(20000 + idx),
    likes: (count - idx) * 10,
    isHot: idx === 0,
    ctime: 1700000000 + idx * 60,
    parentRpid: '',
  }));
}

describe('B 站行为层（离线单测）', () => {
  // ★ 真机踩过的坑（2026-11-22 16:4x）：容器跑 UTC，而作息窗是用户在自己手机上填的钟点。
  //   不给偏移就按本机时间算 ⇒ 东八区用户填「09:00-12:00」，实际生效是当地 17:00-20:00。
  it('1b. 作息窗按用户时区换算（容器 UTC + 手机偏移）', () => {
    const utc = Date.UTC(2026, 10, 22, 8, 40, 0, 0);
    const windows = ['09:00-12:00', '14:00-23:00'];
    // 东八区 +480 ⇒ 当地 16:40，落在 14:00-23:00
    assert.equal(isInWindows(utc, windows, 480), true);
    // 西五区 -300 ⇒ 当地 03:40，两条窗都不在
    assert.equal(isInWindows(utc, windows, -300), false);
    // 跨午夜窗在东八区：UTC 17:30 ⇒ 当地 01:30，属于 22:00-02:00
    assert.equal(isInWindows(Date.UTC(2026, 10, 22, 17, 30), ['22:00-02:00'], 480), true);
    // 负偏移取模不许出负数：UTC 02:00 − 300 = 前一天 21:00
    assert.equal(isInWindows(Date.UTC(2026, 10, 22, 2, 0), ['20:00-23:00'], -300), true);
    // 空窗仍全天允许
    assert.equal(isInWindows(utc, [], 480), true);
  });

  // ★ 真机踩出来的（2026-11-23 凌晨）：`bili_dm_inbox` 一次 1500（服务端抖动）就把整个行为层
  //   冻结 15 分钟（全局限流），于是私信一整晚没被轮询到 —— 用户发「现在能回我吗？」也没人理。
  //   读是幂等且便宜的：读失败只把**该动作**的冷却按连续失败次数拉长，永不设全局退避。
  it('2b. 读失败只冷却该动作，永不把整个行为层冻结', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    let inboxCalls = 0;
    let sessionsCalls = 0;
    const behavior = createBehavior({
      config: {
        'browse.enabled': false, 'browse.windows': ['00:00-23:59'],
        'dm.enabled': true, 'dm.pollSeconds': 5, 'risk.backoffMinutes': 15, 'risk.maxPerHour': 100,
      },
      call: async (action) => {
        const e = new Error(action + ' failed (1500)');
        e.code = '1500';
        if (action === 'bili_dm_inbox') { inboxCalls += 1; throw e; }
        if (action === 'bili_dm_sessions') { sessionsCalls += 1; throw e; }
        return {};
      },
      clock,
      paths: { dir },
      accountId: '3747573426818991',
    });
    try {
      // 连跑 6 轮（两轮一拍：inbox 失败后还会退到 dm_sessions），全程不许出现 backoff
      for (let i = 0; i < 6; i += 1) {
        const r = await behavior.runOnce();
        assert.notEqual(r.status, 'backoff', '读失败不该把整个行为层冻结（第 ' + (i + 1) + ' 轮）');
        clock.advance(61_000);
      }
      assert.ok(inboxCalls >= 2, '短冷却过后要重新尝试，而不是一直不动');
      assert.ok(inboxCalls <= 6, '也不能每轮都硬撞');
      assert.ok(sessionsCalls >= 1);
    } finally {
      behavior.stop();
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('1. 作息窗判断：窗内 / 窗外 / 跨午夜 / 多条窗', async () => {
    const t = (h, m) => new Date(2026, 10, 22, h, m, 0, 0).getTime();

    // 常规单窗
    assert.equal(isInWindows(t(9, 0), ['09:00-12:00']), true);
    assert.equal(isInWindows(t(11, 59), ['09:00-12:00']), true);
    assert.equal(isInWindows(t(12, 0), ['09:00-12:00']), false);
    assert.equal(isInWindows(t(8, 59), ['09:00-12:00']), false);

    // 跨午夜窗 22:00-02:00
    assert.equal(isInWindows(t(22, 0), ['22:00-02:00']), true);
    assert.equal(isInWindows(t(23, 30), ['22:00-02:00']), true);
    assert.equal(isInWindows(t(0, 0), ['22:00-02:00']), true);
    assert.equal(isInWindows(t(1, 59), ['22:00-02:00']), true);
    assert.equal(isInWindows(t(2, 0), ['22:00-02:00']), false);
    assert.equal(isInWindows(t(15, 0), ['22:00-02:00']), false);

    // 多条窗混合（普通 + 跨午夜）
    const multi = ['09:00-12:00', '22:30-01:30'];
    assert.equal(isInWindows(t(10, 30), multi), true);
    assert.equal(isInWindows(t(13, 0), multi), false);
    assert.equal(isInWindows(t(0, 45), multi), true);

    // 引擎在窗外不发起任何**巡看**调用（但私信照看 —— 作息窗只管主动浏览，见 2026-11-23 的决定）
    const dir = await makeTempDir();
    let called = 0;
    let dmCalled = 0;
    const clock = makeClock(t(13, 0));
    const behavior = createBehavior({
      config: { 'browse.windows': ['09:00-12:00', '14:00-23:00'] },
      call: async (action) => {
        if (String(action).startsWith('bili_dm_')) { dmCalled += 1; return { session_list: [] }; }
        called += 1;
        return { videos: [] };
      },
      clock,
      paths: dir,
    });
    const res = await behavior.runOnce();
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'outside-window');
    assert.equal(called, 0, '窗外不该去取流');
    assert.ok(dmCalled >= 1, '窗外也要看私信（有人主动找你）');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('2. 到点判断：含 jitter 上下边界（固定随机源）', async () => {
    // 45 分钟 ± 40% => [27, 63] 分钟
    assert.equal(computeNextGapMs(45, 40, () => 0), 27 * 60_000);
    assert.equal(computeNextGapMs(45, 40, () => 0.5), 45 * 60_000);
    assert.equal(computeNextGapMs(45, 40, () => 1), 63 * 60_000);

    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    let calls = 0;
    let dmCalls = 0;
    // 固定 random = 0 => 下次间隔 = 45 * (1 - 0.4) = 27 分钟
    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 1,
        'browse.maxMinutesPerVideo': 1,
        'browse.gapMinutes': 45,
        'browse.jitterPercent': 40,
        'read.enabled': false,
        'write.enabled': false,
      },
      call: async (action) => {
        // 私信与取流走同一个 call：分开计数，否则「未到点也该查私信」这条变更会被读数掩盖。
        if (String(action).startsWith('bili_dm_')) {
          dmCalls += 1;
          return { session_list: [] };
        }
        calls += 1;
        return { videos: makeVideos([`BV1due00000${calls}`]) };
      },
      clock,
      paths: dir,
      random: () => 0,
    });

    const r1 = await behavior.runOnce();
    assert.equal(r1.status, 'ok');
    assert.equal(r1.watchedCount, 1);
    const expectedDue = clock.now() + 27 * 60_000;
    assert.equal(r1.nextRunAt, expectedDue);
    const callsAfterFirstRun = calls;
    const dmAfterFirstRun = dmCalls;

    // 推进 26 分钟 59 秒：仍未到点
    clock.advance(27 * 60_000 - 1000);
    const r2 = await behavior.runOnce();
    assert.equal(r2.status, 'skipped');
    assert.equal(r2.reason, 'not-due');
    // 没到点 ⇒ 不该再取流
    assert.equal(calls, callsAfterFirstRun);
    // ★ 但私信照样要看：巡看有 45 分钟节奏，私信的节奏是 dm.pollSeconds（默认 15 秒）。
    //   拿巡看节奏管私信 = 别人发一句要等 45 分钟，所以这里必须多一次私信轮询。
    assert.equal(dmCalls, dmAfterFirstRun + 1);

    // 再推进 1 秒：刚好到点
    clock.advance(1000);
    const r3 = await behavior.runOnce();
    assert.equal(r3.status, 'ok');
    assert.equal(r3.watchedCount, 1);
    // 到点：又取一次流
    assert.equal(calls, callsAfterFirstRun + 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('3. 去重：同一 bvid 第二轮不再观看', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['recommend'],
        'browse.partitions': ['tech'],
        'browse.maxPerRun': 5,
        'browse.gapMinutes': 1,
        'browse.jitterPercent': 0,
        'read.enabled': false,
        'write.enabled': false,
      },
      call: async () => ({ videos: makeVideos(['BV1same000001', 'BV1same000002']) }),
      clock,
      paths: dir,
      random: () => 0.5,
    });

    const r1 = await behavior.runOnce();
    assert.deepEqual(r1.watchedVideos, ['BV1same000001', 'BV1same000002']);

    clock.advance(2 * 60_000);
    const r2 = await behavior.runOnce();
    assert.equal(r2.watchedCount, 0);
    assert.deepEqual(r2.watchedVideos, []);

    const stored = await behavior.library.readVideos();
    assert.equal(stored.length, 2);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('4. maxPerRun 与 maxPerDay 上限共同约束', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const pool = makeVideos(['BV1lim000001', 'BV1lim000002', 'BV1lim000003', 'BV1lim000004', 'BV1lim000005']);

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 2,
        'browse.maxPerDay': 3,
        'browse.gapMinutes': 1,
        'browse.jitterPercent': 0,
        'read.enabled': false,
        'write.enabled': false,
      },
      call: async () => ({ videos: pool }),
      clock,
      paths: dir,
      random: () => 0.5,
    });

    const r1 = await behavior.runOnce();
    assert.equal(r1.watchedCount, 2);

    clock.advance(2 * 60_000);
    const r2 = await behavior.runOnce();
    // 受 maxPerDay=3 限制，第二轮只能再看 1 个
    assert.equal(r2.watchedCount, 1);

    clock.advance(2 * 60_000);
    const r3 = await behavior.runOnce();
    assert.equal(r3.status, 'skipped');
    assert.equal(r3.reason, 'daily_browse_limit');
    assert.equal(r3.watchedCount, 0);
    assert.equal(r3.blocked.length, 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('5. 读评论条数严格受 read.maxPerVideo 限制并落库', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    let requestedCount = null;

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 1,
        'read.enabled': true,
        'read.maxPerVideo': 3,
        'read.order': 'hot',
        'read.storeToLibrary': true,
        'write.enabled': false,
      },
      call: async (action, params) => {
        if (action === 'bili_follow_feed') return { videos: makeVideos(['BV1cmt000001']) };
        if (action === 'bili_comments') {
          requestedCount = params.count;
          // 故意返回超过 maxPerVideo 的 10 条，验证行为层硬截断
          return { comments: makeComments(params.bvid, 10) };
        }
        return {};
      },
      clock,
      paths: dir,
    });

    const res = await behavior.runOnce();
    assert.equal(requestedCount, 3);
    assert.equal(res.readCommentsCount, 3);
    const saved = await behavior.library.readComments();
    assert.equal(saved.length, 3);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('6. 配额挡写：每日评论超限时不发且记 blocked 流水', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const sent = [];

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 3,
        'browse.skipPercent': 0,
        'read.enabled': true,
        'read.maxPerVideo': 2,
        'write.enabled': true,
        'write.commentPerDay': 1,
        'write.replyOnly': false,
        'write.minChars': 5,
        'write.maxChars': 80,
      },
      call: async (action, params) => {
        if (action === 'bili_follow_feed') return { videos: makeVideos(['BV1q00000001', 'BV1q00000002']) };
        if (action === 'bili_comments') return { comments: makeComments(params.bvid, 2) };
        if (action === 'bili_comment_send') {
          sent.push(params);
          return { ok: true, rpid: `my_${sent.length}` };
        }
        return {};
      },
      clock,
      paths: dir,
      random: () => 0.5,
      generateComment: (video) => `很棒的视频内容，关于 ${video.bvid} 的讲解非常清晰！`,
    });

    const res = await behavior.runOnce();
    assert.equal(res.watchedCount, 2);
    assert.equal(res.sentComments.length, 1);
    assert.equal(sent.length, 1);
    assert.ok(res.blocked.some((b) => b.reason === 'daily_comment_limit'));

    const blockedLog = await behavior.quota.getBlockedLog();
    assert.ok(blockedLog.some((b) => b.reason === 'daily_comment_limit'));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('7. risk.maxPerHour 挡住所有动作并记 blocked', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const calledActions = [];

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 3,
        'browse.skipPercent': 0,
        'read.enabled': true,
        'read.maxPerVideo': 2,
        'write.enabled': true,
        'write.replyOnly': false,
        'write.minChars': 5,
        'risk.maxPerHour': 2,
      },
      call: async (action, params) => {
        calledActions.push(action);
        if (action === 'bili_follow_feed') return { videos: makeVideos(['BV1hr0000001', 'BV1hr0000002']) };
        if (action === 'bili_comments') return { comments: makeComments(params.bvid, 2) };
        if (action === 'bili_comment_send') return { ok: true, rpid: 'my_hr_1' };
        return {};
      },
      clock,
      paths: dir,
      random: () => 0.5,
      generateComment: () => '这是一条测试每小时动作上限的评论',
    });

    const res = await behavior.runOnce();
    // 第 1 次 bili_follow_feed，第 2 次 bili_comments(视频1)，之后达到 risk.maxPerHour=2，写评论与视频2读评论均被挡
    assert.equal(calledActions.length, 2);
    assert.equal(res.sentComments.length, 0);
    assert.ok(res.blocked.length >= 1);
    assert.ok(res.blocked.every((b) => b.reason === 'risk_max_per_hour'));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('8. 失败后按 backoffMinutes 退避，退避期间不再发，过期后恢复', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    let sendAttempts = 0;

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 2,
        'browse.gapMinutes': 1,
        'browse.jitterPercent': 0,
        'browse.skipPercent': 0,
        'browse.maxMinutesPerVideo': 1,
        'read.enabled': false,
        'write.enabled': true,
        'write.replyOnly': false,
        'write.minChars': 5,
        'risk.backoffMinutes': 15,
      },
      call: async (action) => {
        if (action === 'bili_follow_feed') {
          return { videos: makeVideos(['BV1bk0000001', 'BV1bk0000002', 'BV1bk0000003']) };
        }
        if (action === 'bili_comment_send') {
          sendAttempts += 1;
          if (sendAttempts === 1) throw new Error('network timeout');
          return { ok: true, rpid: `r_${sendAttempts}` };
        }
        return {};
      },
      clock,
      paths: dir,
      random: () => 0.5,
      generateComment: (v) => `对视频 ${v.bvid} 的正常评论内容`,
    });

    const r1 = await behavior.runOnce();
    // 视频1发评失败触发 15 分钟退避，视频2（仅推进 1 分钟）在退避期内不得再发
    assert.equal(sendAttempts, 1);
    assert.equal(r1.errors.length, 1);
    assert.ok(r1.blocked.some((b) => b.reason === 'backoff'));

    // 推进 10 分钟仍在退避期内
    clock.advance(10 * 60_000);
    const r2 = await behavior.runOnce();
    assert.equal(r2.status, 'backoff');
    assert.equal(sendAttempts, 1);

    // 再推进 10 分钟超过退避期，恢复正常发送
    clock.advance(10 * 60_000);
    const r3 = await behavior.runOnce();
    assert.equal(r3.status, 'ok');
    assert.equal(sendAttempts, 2);
    assert.equal(r3.sentComments.length, 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('9. stopOnVerify 命中后整轮立刻停止，后续视频与动作不再执行', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const actions = [];

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 3,
        'browse.skipPercent': 0,
        'read.enabled': true,
        'write.enabled': true,
        'write.replyOnly': false,
        'write.minChars': 5,
        'risk.stopOnVerify': true,
      },
      call: async (action, params) => {
        actions.push(`${action}:${params.bvid || ''}`);
        if (action === 'bili_follow_feed') {
          return { videos: makeVideos(['BV1vf0000001', 'BV1vf0000002', 'BV1vf0000003']) };
        }
        if (action === 'bili_comments') {
          const err = new Error('触发风控：请完成安全验证');
          err.code = 'BILI_BROWSER_CHALLENGE';
          throw err;
        }
        return {};
      },
      clock,
      paths: dir,
      random: () => 0.5,
      generateComment: () => '这条评论不应该被发出',
    });

    const r1 = await behavior.runOnce();
    assert.equal(r1.status, 'stopped_verify');
    assert.equal(r1.stoppedByVerify, true);
    assert.equal(r1.watchedCount, 1);
    // 每轮开头的私信轮询（收件箱 + 可能一次正文读取）也在里面，所以不断言整串，
    // 只断言「真的巡看到了、并且停住之后不再有新动作」。
    assert.ok(actions.some((a) => a === 'bili_follow_feed:'));
    assert.ok(actions.some((a) => a.startsWith('bili_comments:')));

    // 未重置前，后续 tick 仍保持停止状态
    clock.advance(60 * 60_000);
    const r2 = await behavior.runOnce();
    assert.equal(r2.status, 'stopped_verify');
    // 停住之后不该再有新动作（第一轮那 3 条保持原样）
    assert.equal(actions.length, 3);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('10. 资料库 append / 去重 / purgeBefore / condenseBefore（归纳失败时原文保留）', async () => {
    const dir = await makeTempDir();
    const t0 = new Date(2026, 10, 1, 10, 0, 0, 0).getTime();
    const t1 = new Date(2026, 10, 10, 10, 0, 0, 0).getTime();
    const t2 = new Date(2026, 10, 22, 10, 0, 0, 0).getTime();
    const clock = makeClock(t2);
    const lib = createLibrary({ dir, clock });

    await lib.appendVideo({ bvid: 'BV1lib000001', title: '旧视频', firstSeenAt: t0, lastSeenAt: t0, watchedSec: 60 });
    await lib.appendVideo({ bvid: 'BV1lib000002', title: '新视频', firstSeenAt: t2, lastSeenAt: t2, watchedSec: 90 });
    assert.equal(await lib.hasSeenVideo('BV1lib000001'), true);
    assert.equal(await lib.hasSeenVideo('BV1notexist1'), false);

    await lib.appendComment({ bvid: 'BV1lib000001', rpid: 'c1', text: '老评论1', likes: 12, isHot: true, storedAt: t0 });
    await lib.appendComment({ bvid: 'BV1lib000001', rpid: 'c2', text: '老评论2', likes: 8, isHot: false, storedAt: t0 + 1000 });
    await lib.appendComment({ bvid: 'BV1lib000002', rpid: 'c3', text: '新评论', likes: 5, isHot: false, storedAt: t2 });

    const counts = await lib.todayCounts(t2);
    assert.equal(counts.videos, 1);
    assert.equal(counts.comments, 1);

    // 归纳失败场景：summarizer 抛错 -> 原文必须完整保留，digest.jsonl 不写入
    await assert.rejects(
      () =>
        lib.condenseBefore(t1, async () => {
          throw new Error('LLM unavailable');
        }),
      /LLM unavailable/
    );
    assert.equal((await lib.readComments()).length, 3);
    assert.equal((await lib.readDigests()).length, 0);

    // 归纳成功场景：按 bvid 聚合条数与点赞，写入 digest.jsonl 并删除早于 t1 的原文
    const cRes = await lib.condenseBefore(t1, async (rows, meta) => {
      assert.equal(rows.length, 2);
      assert.equal(meta.bvid, 'BV1lib000001');
      assert.equal(meta.totalLikes, 20);
      return `共 ${rows.length} 条评论，累计点赞 ${meta.totalLikes}`;
    });
    assert.equal(cRes.condensedGroups, 1);
    assert.equal(cRes.condensedRows, 2);

    const digests = await lib.readDigests();
    assert.equal(digests.length, 1);
    assert.equal(digests[0].totalLikes, 20);
    assert.equal(digests[0].count, 2);

    const remainingComments = await lib.readComments();
    assert.equal(remainingComments.length, 1);
    assert.equal(remainingComments[0].rpid, 'c3');

    // purgeBefore 清理早于 t1 的旧视频
    const pRes = await lib.purgeBefore(t1);
    assert.equal(pRes.videos, 1);
    assert.equal(pRes.total, 1);
    assert.equal(await lib.hasSeenVideo('BV1lib000001'), false);
    assert.equal(await lib.hasSeenVideo('BV1lib000002'), true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('11. reviewBeforeSend 走 pending 队列，approve 后才发，reject 不发', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const sent = [];

    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 2,
        'browse.skipPercent': 0,
        'read.enabled': false,
        'write.enabled': true,
        'write.replyOnly': false,
        'write.minChars': 5,
        'write.maxChars': 80,
        'write.reviewBeforeSend': true,
      },
      call: async (action, params) => {
        if (action === 'bili_follow_feed') return { videos: makeVideos(['BV1rv0000001', 'BV1rv0000002']) };
        if (action === 'bili_comment_send') {
          sent.push(params);
          return { ok: true, rpid: `approved_${sent.length}` };
        }
        return {};
      },
      clock,
      paths: dir,
      random: () => 0.5,
      generateComment: (v) => `待人工确认的评论内容：${v.bvid}`,
    });

    const r1 = await behavior.runOnce();
    assert.equal(r1.sentComments.length, 0);
    assert.equal(r1.queuedComments.length, 2);
    assert.equal(sent.length, 0);

    const pending = await behavior.listPending();
    assert.equal(pending.length, 2);

    // 批准第一条 -> 真正发送
    const appRes = await behavior.approve(pending[0].id);
    assert.equal(appRes.ok, true);
    assert.equal(appRes.rpid, 'approved_1');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bvid, 'BV1rv0000001');

    // 拒绝第二条 -> 不发送
    const rejRes = await behavior.reject(pending[1].id, '语气不合适');
    assert.equal(rejRes.ok, true);
    assert.equal(sent.length, 1);

    // 队列清空
    assert.equal((await behavior.listPending()).length, 0);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('12. 半行保护：模拟 rename 前崩溃不产生坏行，原文件完整可读', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));

    let crashOnRename = false;
    const flakyFs = {
      ...fs,
      async rename(src, dst) {
        if (crashOnRename) {
          throw new Error('simulated crash before rename');
        }
        return fs.rename(src, dst);
      },
    };

    const lib = createLibrary({ dir, clock, fsOps: flakyFs });
    await lib.appendVideo({ bvid: 'BV1ok0000001', title: '完整记录1' });

    // 开启崩溃模拟：写入临时文件成功，但在 rename 替换目标文件前崩溃
    crashOnRename = true;
    await assert.rejects(
      () => lib.appendVideo({ bvid: 'BV1bad000002', title: '崩溃记录2' }),
      /simulated crash before rename/
    );

    // 校验原文件无坏行、无半行、且临时文件已清理
    const raw = await fs.readFile(lib.files.videos, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).bvid, 'BV1ok0000001');

    const dirEntries = await fs.readdir(dir);
    assert.equal(dirEntries.filter((f) => f.includes('.tmp.')).length, 0);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('13. 未注入 generateComment 记 comment_skipped；超长/过短评论被拦截', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));

    // 未注入生成器
    const b1 = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 1,
        'browse.skipPercent': 0,
        'read.enabled': false,
        'write.enabled': true,
      },
      call: async () => ({ videos: makeVideos(['BV1ng0000001']) }),
      clock,
      paths: dir,
      random: () => 0.5,
    });
    const r1 = await b1.runOnce();
    assert.equal(r1.sentComments.length, 0);
    assert.deepEqual(r1.skippedComments, [{ bvid: 'BV1ng0000001', reason: 'no-generator' }]);
    assert.ok(b1.getEvents().some((e) => e.type === 'comment_skipped' && e.reason === 'no-generator'));

    // 长度校验（minChars=15, maxChars=20）
    const dir2 = await makeTempDir();
    let sentCount = 0;
    const b2 = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['follow'],
        'browse.maxPerRun': 1,
        'browse.skipPercent': 0,
        'read.enabled': false,
        'write.enabled': true,
        'write.replyOnly': false,
        'write.minChars': 15,
        'write.maxChars': 20,
      },
      call: async (action) => {
        if (action === 'bili_comment_send') {
          sentCount += 1;
          return { ok: true, rpid: 'x' };
        }
        return { videos: makeVideos(['BV1len000001']) };
      },
      clock,
      paths: dir2,
      random: () => 0.5,
      generateComment: () => '太短了',
    });
    const r2 = await b2.runOnce();
    assert.equal(sentCount, 0);
    assert.equal(r2.skippedComments[0].reason, 'length-out-of-range');

    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dir2, { recursive: true, force: true });
  });

  it('14. start()/stop() 可注入定时器调度 + replyOnly 触发 bili_reply_list', async () => {
    const dir = await makeTempDir();
    const clock = makeClock(new Date(2026, 10, 22, 10, 0, 0, 0));
    const scheduled = [];
    let cleared = 0;
    const fakeTimer = {
      setTimeout(fn, delay) {
        const handle = { fn, delay, active: true };
        scheduled.push(handle);
        return handle;
      },
      clearTimeout(handle) {
        if (handle) handle.active = false;
        cleared += 1;
      },
    };

    const actions = [];
    const behavior = createBehavior({
      config: {
        'browse.windows': ['09:00-23:00'],
        'browse.sources': ['search'],
        'browse.keywords': ['Node.js'],
        'browse.maxPerRun': 1,
        'browse.skipPercent': 0,
        'browse.gapMinutes': 10,
        'browse.jitterPercent': 0,
        'read.enabled': true,
        'read.maxPerVideo': 2,
        'write.enabled': true,
        'write.replyOnly': true,
        'write.minChars': 5,
        'write.maxChars': 80,
      },
      call: async (action, params) => {
        actions.push({ action, params });
        if (action === 'bili_search') return { videos: makeVideos(['BV1rp0000001']) };
        if (action === 'bili_comments') return { comments: makeComments(params.bvid, 1) };
        if (action === 'bili_reply_list') {
          return {
            replies: [
              {
                rpid: 'sub_reply_1',
                rootRpid: params.rootRpid,
                parentRpid: params.rootRpid,
                text: '别人的子回复',
                author: '网友A',
                authorId: '30001',
                likes: 3,
                isHot: false,
                ctime: 1700000100,
              },
            ],
          };
        }
        if (action === 'bili_comment_send') return { ok: true, rpid: 'my_reply_1' };
        return {};
      },
      clock,
      paths: dir,
      random: () => 0.5,
      timer: fakeTimer,
      generateComment: () => '非常赞同楼上的看法，补充一点细节！',
    });

    behavior.start(0);
    assert.equal(scheduled.length, 1);
    assert.equal(behavior.getState().running, true);

    // 手动触发第一次定时回调
    await scheduled[0].fn();
    assert.ok(actions.some((a) => a.action === 'bili_search' && a.params.keyword === 'Node.js'));
    assert.ok(actions.some((a) => a.action === 'bili_reply_list' && a.params.rootRpid === 'BV1rp0000001_r1'));
    const sendCall = actions.find((a) => a.action === 'bili_comment_send');
    assert.ok(sendCall);
    assert.equal(sendCall.params.parentRpid, 'sub_reply_1');

    // 自动排了第二次定时器（10 分钟后）
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].delay, 10 * 60_000);

    behavior.stop();
    assert.equal(behavior.getState().running, false);
    assert.equal(cleared, 1);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
