// 深度改造折叠验收（2026-11-20，P6）：运行端 23 个 overlay 补丁 + preload 三职责
// 已全部直改进 input/agent-app 源码，钩子层（--import preload / local-overlay boot.mjs）退役。
// 这里锁死折叠产物里最容易「悄悄丢掉」的硬标记；真机行为验收另见台账。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'input/agent-app');
const read = (rel) => fs.readFileSync(path.join(AGENT, rel), 'utf8');
const containerBot = fs.readFileSync(path.join(ROOT, 'android/container-bot.mjs'), 'utf8');

// ── 1. 钩子层退役：container-bot 不再写/挂 preload ──────────────────────────
test('container-bot 已退役 preload：不再有 AGENT_PRELOAD / --import / preload.mjs', () => {
  assert.ok(!containerBot.includes('AGENT_PRELOAD'), '不应再有 AGENT_PRELOAD 模板');
  assert.ok(!containerBot.includes('--import'), '不应再向 agent 传 --import');
  assert.ok(!containerBot.includes('/agent/preload.mjs'), '不应再写 /agent/preload.mjs');
  // 环境变量注入保留（读取方换成了源内折叠逻辑）。
  for (const key of ['WHALE_ONEBOT_TOKEN', 'WHALE_ONEBOT_WS_URL', 'WHALE_ONEBOT_HTTP_URL', 'WHALE_ONEBOT_TEXT_TIMEOUT_MS']) {
    assert.ok(containerBot.includes(key), 'container-bot 仍应传 ' + key);
  }
});

// ── 2. onebot.js：超时环境变量化 + 地址/token 环境变量注入 + 账号闸 ──────────
test('onebot.js：动作超时已源内环境变量化（默认 120 秒，非法值报错不静默）', () => {
  const s = read('src/onebot/onebot.js');
  assert.ok(!s.includes('const TEXT_TIMEOUT_MS = 15000;'), '上游写死的 15 秒不应残留');
  assert.ok(s.includes('WHALE_ONEBOT_TEXT_TIMEOUT_MS'), '应读 WHALE_ONEBOT_TEXT_TIMEOUT_MS');
  assert.ok(s.includes('return 120000;'), '默认 120000');
  assert.ok(s.includes('ONEBOT_TIMEOUT_INVALID'), '非法值抛 ONEBOT_TIMEOUT_INVALID');
});

test('onebot.js：超时 IIFE 语义与原 preload 等价（默认/合法/非法三态）', () => {
  const s = read('src/onebot/onebot.js');
  const start = s.indexOf('const TEXT_TIMEOUT_MS = (() => {');
  const end = s.indexOf('})();', start);
  assert.ok(start >= 0 && end > start, '找不到超时 IIFE');
  const iife = s.slice(start + 'const TEXT_TIMEOUT_MS = '.length, end + 4); // 含 "})();"
  const evalWith = (env) => {
    const saved = process.env.WHALE_ONEBOT_TEXT_TIMEOUT_MS;
    try {
      if (env === undefined) delete process.env.WHALE_ONEBOT_TEXT_TIMEOUT_MS;
      else process.env.WHALE_ONEBOT_TEXT_TIMEOUT_MS = env;
      // eslint-disable-next-line no-new-func
      return new Function('process', 'return ' + iife + ';')(process);
    } finally {
      if (saved === undefined) delete process.env.WHALE_ONEBOT_TEXT_TIMEOUT_MS;
      else process.env.WHALE_ONEBOT_TEXT_TIMEOUT_MS = saved;
    }
  };
  assert.equal(evalWith(undefined), 120000, '不传 ⇒ 默认 120000');
  assert.equal(evalWith(''), 120000, '空串 ⇒ 默认 120000');
  assert.equal(evalWith('45000'), 45000, '合法毫秒 ⇒ 原样生效');
  assert.throws(() => evalWith('999'), /ONEBOT_TIMEOUT_INVALID/, '过小值必须报错');
  assert.throws(() => evalWith('abc'), /ONEBOT_TIMEOUT_INVALID/, '非数字必须报错');
  assert.throws(() => evalWith('700000'), /ONEBOT_TIMEOUT_INVALID/, '超上限必须报错');
});

test('onebot.js：地址/token 环境变量强制注入折叠进构造器（原 preload 注入逐字保留）', () => {
  const s = read('src/onebot/onebot.js');
  assert.ok(s.includes('if (process.env.WHALE_ONEBOT_WS_URL) wsUrl = process.env.WHALE_ONEBOT_WS_URL;'));
  assert.ok(s.includes('if (process.env.WHALE_ONEBOT_HTTP_URL) httpUrl = process.env.WHALE_ONEBOT_HTTP_URL;'));
  assert.ok(s.includes('accessToken = process.env.WHALE_ONEBOT_TOKEN; httpToken = process.env.WHALE_ONEBOT_TOKEN;'));
});

test('onebot.js：账号闸包装在（withLocalAccountGuard + HTTP 禁重定向）', () => {
  const s = read('src/onebot/onebot.js');
  assert.ok(s.includes('withLocalAccountGuard(LocalUpstreamOneBotClient, OneBotActionError)'),
    'OneBotClient 必须经账号闸包装导出');
  assert.ok(s.includes("redirect: 'error'"), 'HTTP 动作请求必须禁重定向');
  assert.ok(!/^export class OneBotClient \{/m.test(s), '上游裸导出不应再直接暴露');
});

// ── 3. orchestrator.js：run 硬顶 600s + __local 桥接线 ──────────────────────
test('orchestrator.js：run 超时硬顶 600s（Run deadline exceeded 静默根因修复已入源）', () => {
  const s = read('src/core/orchestrator.js');
  assert.ok(s.includes('Math.min(600000, Math.max(1000, Number(cfgNow.api.runTimeoutMs) || 180000))'));
  assert.ok(!s.includes('Math.min(240000,'), '240s 硬顶不应残留');
});

test('orchestrator.js：__local 桥全量接线（人味层的入口）', () => {
  const s = read('src/core/orchestrator.js');
  assert.ok(s.includes("import { createLocalBridge } from './local-overlay-bridge.js';"), '桥模块 import');
  assert.ok(s.includes('this.__local = createLocalBridge(this);'), '构造器挂桥');
  assert.ok(s.includes('...this.__local.toolCtx(this)'), '工具 ctx 注入（kb_search/get_intimacy/search_old_messages 的载体）');
  assert.ok(s.includes('...(await this.__local.promptExtras(this, { chatKey, triggerEntries })),'),
    '【我们之间】/【想起来了】提示段注入');
  assert.ok(s.includes('this.__local.maybeConsolidateEpisodes(this, chatKey, (m) => this.#memoryChat(m));'),
    '事件记忆自动整理');
});

// ── 4. store.js：情绪自动采集挂入站唯一入口 ────────────────────────────────
test('store.js：情绪自动采集（心情引擎数据源）已折叠', () => {
  const s = read('src/core/store.js');
  assert.ok(s.includes("from '../features/mood-capture.js'"), 'mood-capture import');
  assert.ok(s.includes('__localCaptureEmotion(chatKey, message, recorded)'), '入站采集调用');
});

// ── 5. 全部 18 个折叠目标 ESM 语法可解析 ──────────────────────────────────
test('18 个折叠目标全部通过 ESM 语法检查', () => {
  const targets = [
    'src/core/orchestrator.js', 'src/llm/prompt.js', 'src/tools/tools-core.js',
    'src/llm/tts-presets.js', 'src/llm/tts-mimo.js', 'src/llm/safe-fetch.js',
    'src/console/app.js', 'src/core/config-legacy.js', 'src/memory/memory-global.js',
    'src/core/store.js', 'src/onebot/sender.js', 'src/onebot/sticker-manager.js',
    'src/plugins/capabilities.js', 'src/plugins/registry.js',
    'src/pilots/incident-pilot.js', 'src/onebot/onebot.js',
    'ui/app.js', 'ui/pages/overview.js',
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foldt-'));
  try {
    for (const rel of targets) {
      assert.ok(fs.existsSync(path.join(AGENT, rel)), '目标文件应存在: ' + rel);
      const dst = path.join(tmp, rel.replaceAll('/', '_') + '.mjs');
      fs.copyFileSync(path.join(AGENT, rel), dst);
      const r = spawnSync(process.execPath, ['--check', dst], { encoding: 'utf8' });
      assert.equal(r.status, 0, '语法失败 ' + rel + '\n' + r.stderr);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── 6. 折叠引擎退役标记：仓库树里不应再带 overlay 机制死代码 ────────────────
test('仓库运行端树不再携带 overlay 补丁机制（深度改造后为纯源码）', () => {
  assert.ok(!fs.existsSync(path.join(AGENT, 'local-overlay')), 'local-overlay 机制目录应已退役');
});
