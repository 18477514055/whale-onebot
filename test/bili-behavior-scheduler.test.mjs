import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BEHAVIOR_FILE,
  PROTOCOL_FILE,
  ACTIONS_FILE,
  readBehaviorConfig,
  readProtocolEndpoint,
  createFetchCaller,
  createActionBridge,
  createActionSink,
  startBiliBehavior,
} from '../input/agent-app/src/features/bili-behavior/scheduler.mjs';

const made = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-sched-'));
  made.push(dir);
  return dir;
}
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function writeConfig(dir, value) {
  fs.writeFileSync(path.join(dir, BEHAVIOR_FILE), JSON.stringify(value), 'utf8');
}

// 全天窗口 + 只走推荐流：不受「现在几点」影响，也不依赖关注/收藏。
const NOW_CONFIG = {
  enabled: true,
  'browse.enabled': true,
  'browse.windows': ['00:00-23:59'],
  'browse.sources': ['recommend'],
  'browse.maxPerRun': 1,
  'browse.gapMinutes': 1,
};

function fakeApp(calls = []) {
  return {
    onebot: {
      async call(action, params) {
        calls.push({ action, params });
        if (action === 'bili_recommend') {
          return { videos: [{ bvid: 'BV1sched0001', title: '调度测试', authorId: '9', author: 'UP', durationSec: 30 }] };
        }
        if (action === 'bili_video_info') return { aid: 42, bvid: 'BV1sched0001' };
        if (action === 'bili_comments') return { comments: [] };
        return {};
      },
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('B 站行为层运行端宿主（离线单测）', () => {
  it('1. 配置文件缺失 / 非法 / 未启用时一律不启动', () => {
    const dir = tempDir();
    assert.equal(readBehaviorConfig(dir), null, '缺文件');
    assert.equal(startBiliBehavior({ app: fakeApp(), dataDir: dir, platform: 'bilibili' }), null);

    fs.writeFileSync(path.join(dir, BEHAVIOR_FILE), 'not json', 'utf8');
    assert.equal(readBehaviorConfig(dir), null, '坏 JSON');
    assert.equal(startBiliBehavior({ app: fakeApp(), dataDir: dir, platform: 'bilibili' }), null);

    writeConfig(dir, { ...NOW_CONFIG, enabled: false });
    // 读得到（这样热更新才知道「被人关掉了」），但启动一律拒绝。
    assert.equal(readBehaviorConfig(dir).enabled, false, '显式关闭仍然读得出来');
    assert.equal(startBiliBehavior({ app: fakeApp(), dataDir: dir, platform: 'bilibili' }), null);

    writeConfig(dir, { ...NOW_CONFIG, enabled: 'true' });
    assert.equal(startBiliBehavior({ app: fakeApp(), dataDir: dir, platform: 'bilibili' }), null, 'enabled 必须是布尔 true');
  });

  it('2. 非 B 站平台直接跳过（QQ 机器人不会被这套逻辑碰到）', () => {
    const dir = tempDir();
    writeConfig(dir, NOW_CONFIG);
    assert.equal(startBiliBehavior({ app: fakeApp(), dataDir: dir, platform: 'qq' }), null);
    assert.equal(startBiliBehavior({ app: fakeApp(), dataDir: dir, platform: undefined }), null);
  });

  it('3. 动作通道没就绪时跳过，并把原因说出来（不静默）', () => {
    const dir = tempDir();
    writeConfig(dir, NOW_CONFIG);
    const warned = [];
    const host = startBiliBehavior({
      app: {}, dataDir: dir, platform: 'bilibili',
      log: { warn: (m) => warned.push(String(m)), log: () => {} },
    });
    assert.equal(host, null);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /动作通道/);
  });

  // ★ 2026-11-23 真机踩到的：worker 按配置建好了生成器，但宿主只解构了 summarize，
  //   把 generateComment / generateDmReply 静默丢掉 ⇒ 生产里「生成评论」「回私信」从来没生效
  //   （流水只有一句 dm_reply_skipped: no-generator）。这条守住「宿主必须把生成器转交引擎」。
  it('3b. 宿主把私信生成器转交引擎：真跑一轮会回一句', async () => {
    const dir = tempDir();
    writeConfig(dir, { ...NOW_CONFIG, 'dm.enabled': true, 'dm.pollSeconds': 5, 'browse.enabled': false });
    const calls = [];
    const app = {
      onebot: {
        call: async (action, params) => {
          calls.push(action);
          if (action === 'bili_dm_inbox') return { session_list: [{ talker_id: '1680813704', unread_count: 1, session_ts: 1795326711991671 }] };
          if (action === 'bili_dm_peer_history') return { messages: [{ sender_uid: '1680813704', timestamp: 1795326711, msg_key: 'k1', content: JSON.stringify({ content: '在吗' }) }] };
          if (action === 'bili_dm_send_text') return { msg_key: 'mk1' };
          return {};
        },
      },
    };
    const host = startBiliBehavior({
      app,
      dataDir: dir,
      platform: 'bilibili',
      initialDelayMs: 0,
      generateDmReply: async () => ({ text: '在的' }),
    });
    assert.ok(host, '该起得来');
    try {
      await host.behavior.runOnce();
      assert.ok(calls.includes('bili_dm_send_text'), '生成器被丢掉时不可能会发消息（no-generator）');
    } finally {
      host.stop();
    }
  });

  it('4. 抽象动作名逐个映射到适配层，未登记的抛错（不返回空数组冒充成功）', async () => {
    const calls = [];
    const bridge = createActionBridge({
      call: async (action, params) => { calls.push({ action, params }); return { videos: [], items: [], replies: [] }; },
    });
    const params = {
      bili_recommend: { partition: 'tech', count: 1 },
      bili_search: { keyword: '测试', page: 1 },
      bili_follow_feed: { offset: '', host_mid: 0 },
      bili_favorites: {},
      bili_comments: { bvid: 'BV1xx411c7mD', count: 5 },
      bili_reply_list: { bvid: 'BV1xx411c7mD', rootRpid: '12345', count: 3 },
    };
    for (const [action, value] of Object.entries(params)) await bridge(action, value);
    // ★ 契约（第 140 轮定下的，这条测试原先按旧契约写）：`bili_*` 名字一律**直通协议端**，
    //   由协议端自己校验（拼错的动作会回 1404，失败照样可见）；只有不像 `bili_*` 的才本地抛错。
    await bridge('bili_not_a_thing', {});
    assert.ok(calls.some((c) => c.action === 'bili_not_a_thing'), 'bili_* 要直通给协议端');
    await assert.rejects(() => bridge('not_an_action', {}), /unknown action/);
    assert.ok(calls.some((c) => c.action === 'bili_recommend'));
    assert.ok(calls.some((c) => c.action === 'bili_video_info'), 'bili_comments 要先取 aid');
  });

  it('5. 动作流水按行追加，写不进去只哑一次、不反复抛', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', ACTIONS_FILE);
    const sink = createActionSink(file);
    sink({ at: 1, kind: 'browse' });
    sink({ at: 2, kind: 'comment_skipped' });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).kind, 'comment_skipped');

    // 路径被一个文件占住 ⇒ 写不进去：第一次失败后不再尝试，也不抛。
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'x');
    const broken = createActionSink(path.join(blocker, ACTIONS_FILE));
    assert.doesNotThrow(() => broken({ at: 3, kind: 'x' }));
    assert.doesNotThrow(() => broken({ at: 4, kind: 'x' }));
  });

  it('6. 端到端：读配置 → 真实动作名 → 资料库落盘 → 动作流水落盘 → 可停', async () => {    const dir = tempDir();
    writeConfig(dir, NOW_CONFIG);
    const calls = [];
    const host = startBiliBehavior({
      app: fakeApp(calls), dataDir: dir, platform: 'bilibili',
      log: { warn: () => {}, log: () => {} }, initialDelayMs: 0,
    });
    assert.ok(host, '应该起来了');
    for (let i = 0; i < 60 && calls.length === 0; i += 1) await wait(25);
    assert.ok(calls.length > 0, '至少发生一次动作');
    const names = calls.map((c) => c.action);
    assert.ok(names.includes('bili_recommend'), '真实动作名必须出现在调用里');
    assert.ok(!names.some((n) => /^(recommend|search|favorites)$/.test(n)), '抽象名不应泄漏到协议端');

    await wait(60);
    // 流水是按 2 秒一次冲盘的：等它真落盘再停，否则「tick 还没写完就 stop」会读到不存在的文件。
    const actionsPath = path.join(dir, ACTIONS_FILE);
    for (let i = 0; i < 120 && !fs.existsSync(actionsPath); i += 1) await wait(25);
    host.stop();
    host.stop(); // 幂等：重复停不抛

    const actions = fs.readFileSync(actionsPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(actions.length >= 1, '流水至少一行');
    assert.ok(actions.every((line) => { JSON.parse(line); return true; }), '每行都是完整 JSON');
    assert.ok(fs.existsSync(path.join(dir, 'bili-library', 'quota.json')), '配额落盘');
  });

  it('7. 协议端端点文件：只认回环 HTTP + 合规令牌，其余一律 null', () => {
    const dir = tempDir();
    const write = (value) => {
      fs.writeFileSync(path.join(dir, PROTOCOL_FILE), JSON.stringify(value), 'utf8');
      return readProtocolEndpoint(dir);
    };
    assert.equal(readProtocolEndpoint(dir), null, '缺文件');
    assert.equal(write({ httpUrl: 'http://127.0.0.1:38999', token: 'a'.repeat(48), selfId: '42' }).httpUrl, 'http://127.0.0.1:38999');
    assert.equal(write({ httpUrl: 'http://10.0.0.2:38999', token: 'a'.repeat(48) }), null, '非回环');
    assert.equal(write({ httpUrl: 'https://127.0.0.1:38999', token: 'a'.repeat(48) }), null, '非 http');
    assert.equal(write({ httpUrl: 'http://127.0.0.1:38999', token: 'short' }), null, '令牌太短');
    assert.equal(write({ httpUrl: 'http://127.0.0.1:38999', token: 'a'.repeat(48) + '\nX' }), null, '令牌带换行');
  });

  it('8. 直连协议端的调用器：POST / + Bearer + 解析 data；失败抛可判别的错', async () => {
    const http = await import('node:http');
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
        const { action } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        if (action === 'boom') { res.end(JSON.stringify({ status: 'failed', retcode: 1500, data: null })); return; }
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { echo: action } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const call = createFetchCaller({ httpUrl: 'http://127.0.0.1:' + port, token: 'a'.repeat(48) });
      assert.deepEqual(await call('bili_recommend', { count: 1 }), { echo: 'bili_recommend' });
      assert.equal(seen[0].method, 'POST');
      assert.equal(seen[0].url, '/');
      assert.equal(seen[0].auth, 'Bearer ' + 'a'.repeat(48));
      assert.deepEqual(seen[0].body, { action: 'bili_recommend', params: { count: 1 } });

      await assert.rejects(() => call('boom', {}), (error) => error.action === 'boom' && error.retcode === 1500);
      // 构造期的校验是同步抛（不是 Promise 拒绝）
      assert.throws(() => createFetchCaller({ httpUrl: 'http://10.1.2.3:1', token: 'a'.repeat(48) }), /invalid protocol url/);
      assert.throws(() => createFetchCaller({ httpUrl: 'http://127.0.0.1:' + port, token: '' }), /invalid protocol token/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('9. 注入 call 时不需要 app.onebot（独立 worker 那条路）', async () => {
    const dir = tempDir();
    writeConfig(dir, NOW_CONFIG);
    const calls = [];
    const host = startBiliBehavior({
      dataDir: dir,
      platform: 'bilibili',
      selfUid: '42',
      config: NOW_CONFIG,
      initialDelayMs: 0,
      log: { warn: () => {}, log: () => {} },
      // 直接注入：没有 app，也没有 onebot 客户端
      call: async (action) => {
        calls.push(action);
        if (action === 'bili_recommend') return { videos: [{ bvid: 'BV1worker001', title: 'w', authorId: '1', author: 'a', durationSec: 10 }] };
        if (action === 'bili_video_info') return { aid: 7 };
        if (action === 'bili_comments') return { comments: [] };
        return {};
      },
    });
    assert.ok(host, '注入了 call 就该起得来');
    for (let i = 0; i < 60 && calls.length === 0; i += 1) await wait(25);
    host.stop();
    assert.ok(calls.includes('bili_recommend'), '真的调了协议端动作');
  });

  it('10. 资料库维护：有保留期就清理；没归纳器时只清理、不删未归纳原文', async () => {
    const dir = tempDir();
    const config = {
      ...NOW_CONFIG,
      'lib.retentionDays': 7,
      'lib.condenseEnabled': true,
      'lib.condenseAfterDays': 3,
      'browse.enabled': false,      // 只测维护，不让 tick 抢戏
    };
    writeConfig(dir, config);
    const host = startBiliBehavior({
      dataDir: dir, platform: 'bilibili', config, initialDelayMs: 0,
      log: { warn: () => {}, log: () => {} },
      call: async () => ({}),
    });
    assert.ok(host);
    try {
      // 造一条 20 天前的评论 + 一条今天的
      const libDir = path.join(dir, 'bili-library');
      fs.mkdirSync(libDir, { recursive: true });
      const rows = [
        { bvid: 'BV1old0000001', rpid: '1', text: '旧评论', author: 'a', authorId: '1', ctime: Math.floor(Date.now() / 1000) - 20 * 86400, storedAt: Date.now() - 20 * 86400000, isMine: false, repliedByMe: false, likes: 0 },
        { bvid: 'BV1new0000001', rpid: '2', text: '新评论', author: 'b', authorId: '2', ctime: Math.floor(Date.now() / 1000), storedAt: Date.now(), isMine: false, repliedByMe: false, likes: 0 },
      ];
      fs.writeFileSync(path.join(libDir, 'comments.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      const result = await host.runMaintenance(Date.now());
      assert.ok(result, '维护要能跑');
      // purgeBefore 返回的是分类计数对象，不是一个数字
      assert.equal(result.purged.total, 1, '超过保留期的那条应被清掉，今天这条留下');
      assert.equal(result.purged.comments, 1);
      assert.equal(result.skippedCondense, true, '没有归纳器就不能假装归纳过');
      assert.ok(fs.existsSync(path.join(libDir, 'comments.jsonl')), '未归纳的原文必须还在');
      const left = fs.readFileSync(path.join(libDir, 'comments.jsonl'), 'utf8').split('\n').filter(Boolean);
      assert.equal(left.length, 1);
      assert.match(left[0], /BV1new0000001/);
    } finally {
      // ★ 必须放在 finally：断言失败时若不停，engine 的调度定时器会一直把进程吊着（测试就挂死）。
      host.stop();
    }
  });
});
