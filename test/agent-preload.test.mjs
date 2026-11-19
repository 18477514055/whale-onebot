import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 运行端 preload 是**内嵌在 android/container-bot.mjs 里的模板字符串**（故意的：保证随 APK 走，
// 不依赖容器里还放着别的文件）。这里把那段源码取出来、把 registerHooks 换成假的，然后验证它
// 真的改写了 onebot.js —— 尤其是「把写死的 15 秒超时改长」这件 2026-11-19 才加的事。
const containerBot = fs.readFileSync(path.resolve(import.meta.dirname, '../android/container-bot.mjs'), 'utf8');

function loadPreload() {
  const start = containerBot.indexOf('const AGENT_PRELOAD = `');
  assert(start >= 0, 'container-bot.mjs 里找不到 AGENT_PRELOAD');
  const bodyStart = start + 'const AGENT_PRELOAD = `'.length;
  const bodyEnd = containerBot.indexOf('\n`;', bodyStart);
  assert(bodyEnd > bodyStart, 'AGENT_PRELOAD 模板没有结束标记');
  let code = containerBot.slice(bodyStart, bodyEnd);
  // 模板里写的是 \n 转义（生成换行），取出来之后先还原成真实换行，再去掉 import 行。
  code = code.replace(/\\n/g, '\n').replace(/^import \{ registerHooks \} from 'node:module';\n/, '');
  let hook = null;
  const registerHooks = h => { hook = h; };
  const savedArmed = process.env.WHALE_ORIGINAL_AGENT;
  process.env.WHALE_ORIGINAL_AGENT = '1';
  try {
    new Function('registerHooks', code)(registerHooks);
  } finally {
    if (savedArmed === undefined) delete process.env.WHALE_ORIGINAL_AGENT;
    else process.env.WHALE_ORIGINAL_AGENT = savedArmed;
  }
  assert(hook && typeof hook.load === 'function', 'preload 没有注册 load 钩子');
  // ★ 环境变量必须在**调用 load 的时候**存在（preload 在 load 里才读它），所以这里包一层。
  return (text, env = {}) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      return hook.load('file:///input/agent-app/src/onebot/onebot.js', {}, () => ({ source: Buffer.from(text) })).source;
    } finally {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  };
}

const CONSTRUCTOR = "  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent, heartbeat = 'auto', heartbeatMs = HEARTBEAT_MS }) {";

function fixture({ timeoutDecl = 'const TEXT_TIMEOUT_MS = 15000;' } = {}) {
  return [
    'const HEARTBEAT_MS = 30000;',
    timeoutDecl,
    'export class OneBotClient {',
    CONSTRUCTOR,
    '    this.wsUrl = wsUrl;',
    '    this.httpUrl = httpUrl;',
    '  }',
    '}',
    '',
  ].join('\n');
}

test('preload 把写死的 15 秒动作超时改长（默认 120 秒）', () => {
  const transform = loadPreload();
  const out = transform(fixture());
  assert(out.includes('const TEXT_TIMEOUT_MS = 120000;'));
  assert(!out.includes('const TEXT_TIMEOUT_MS = 15000;'));
});

test('preload 用环境变量覆盖超时值，并把地址与 token 注入构造器', () => {
  const transform = loadPreload();
  const out = transform(fixture(), { WHALE_ONEBOT_TEXT_TIMEOUT_MS: '45000' });
  assert(out.includes('const TEXT_TIMEOUT_MS = 45000;'));
  assert(out.includes('if (process.env.WHALE_ONEBOT_WS_URL) wsUrl = process.env.WHALE_ONEBOT_WS_URL;'));
  assert(out.includes('accessToken = process.env.WHALE_ONEBOT_TOKEN;'));
});

test('preload 拒绝非法超时值，而不是悄悄回落到默认', () => {
  const transform = loadPreload();
  assert.throws(() => transform(fixture(), { WHALE_ONEBOT_TEXT_TIMEOUT_MS: '999' }), /ONEBOT_TIMEOUT_INVALID/);
  assert.throws(() => transform(fixture(), { WHALE_ONEBOT_TEXT_TIMEOUT_MS: 'abc' }), /ONEBOT_TIMEOUT_INVALID/);
});

test('上游把超时常量改掉时 preload 明确报错，不回落到 15 秒', () => {
  const transform = loadPreload();
  assert.throws(() => transform(fixture({ timeoutDecl: 'const TEXT_TIMEOUT_MS = 20000;' })),
    /ONEBOT_TIMEOUT_SOURCE_CHANGED/);
});

test('构造器形状变化时 preload 仍然拒绝启动（沿用原有保护）', () => {
  const transform = loadPreload();
  assert.throws(() => transform('const TEXT_TIMEOUT_MS = 15000;\nclass X {}\n'), /ONEBOT_SOURCE_CHANGED/);
});
