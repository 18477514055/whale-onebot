#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 免 hook 事件面 · notice 真机验收探针
//
// 目的：在**真机**上证明 notice 是从机器人本体（我们自己的 OneBot 服务端）发出来的，
//       而不是离线单测里合成的 raw 造出来的。
//
//   · 唯一能自触发的一条 = 群撤回：
//       send_group_msg → 等 --delay → delete_msg → 断言 WS 上收到
//       { post_type:'notice', notice_type:'group_recall', message_id: 与刚发那条一致 }
//   · 无法自触发的（notify.poke / group_ban / group_increase / group_decrease …）只能被动观察：
//       本脚本把收到的**每一条** notice 原样打成一行 JSON，交给人工核对。
//
// 依据：
//   契约    docs/notice-event-contract-2026-11-17.md        （notice 形状 §2、可自触发动作 §6）
//   矩阵    docs/non-hook-capability-matrix-2026-11-17.md   §4/§5
//
// 传输行为**按源码读到的实现写**，不是猜的（src/transport/server.mjs 行号基于 2026-11-17 工作区）：
//   · 鉴权：server.mjs:15-21 auth() —— 优先 `Authorization: Bearer <token>`；**没有**该头时才回落
//     `?access_token=`。本脚本只用握手/请求头，绝不把 token 放进 URL（URL 会进日志）。
//   · WS 角色：server.mjs:93 `roles = { [wsPath]:'Universal', wsPath+'/api':'API', wsPath+'/event':'Event' }`，
//     默认 wsPath='/'。'/' 既能收事件也能发动作；'/event' 只收事件；'/api' 只发动作。
//   · 事件帧：server.mjs:170-175 原样广播（不重排、不包装），notice 事件体见契约 §2。
//   · HTTP 动作：POST /<action>，`Content-Type: application/json`，body 即 params（server.mjs:105-138）。
//   · 参数校验：src/actions.mjs:298-316（group_id ∈ [1, 2^53-1]；message_id 取整数）。
//   · 动作名/返回：send_group_msg → data.message_id（src/host/onebot-receive-check.mjs:659-668）。
//
// 安全（项目红线：凭据只进不出、动作必须可复现）：
//   · token 只从 bot.json 或 --token-env 指定的环境变量读：**不打印、不回显、不写入任何文件**。
//   · 群号 / QQ 号只从命令行参数与运行期事件来：脚本里不硬编码任何真实号。
//   · 日志与摘要里所有号一律掩码（保留前 3 后 2）；自由文本里的长数字串也做同样掩码。
//   · 只连回环地址（--host 限定 127.0.0.1 / ::1 / localhost），不会误发到远端。
//   · 动作**不重试**：结果未知（retcode 1504 等）直接判 FAIL —— 撤回是副作用动作，盲重试会打乱验收证据。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const NAME = 'notice-live-probe';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_STATE_DIR = '/opt/whale/qq-state';
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_WS_PATH = '/';
const MAX_DELAY_MS = 600000;
const MAX_TIMEOUT_MS = 600000;

const USAGE = `notice-live-probe — 免 hook 事件面 · notice 真机验收探针

用法：
  node scripts/notice-live-probe.mjs --group <群号> [选项]

必填：
  --group <id>        自发自撤的目标群。**没有默认值**：脚本里不硬编码任何真实群号，
                      号只能从命令行来（日志里掩码为前 3 后 2）。

选项（括号内为默认值）：
  --mode <ws|http>    连接方式（ws）。http 只发动作、收不到事件 ⇒ 结论必然 FAIL，
                      仅用于"别处观察"的触发场景。
  --delay <ms>        send 与 delete 之间的等待（${DEFAULT_DELAY_MS}）。太短可能撤回时消息尚未落地。
  --timeout <ms>      整个自测的总预算：连 WS → 查身份 → 发送 → 撤回 → 等 notice（${DEFAULT_TIMEOUT_MS}）。
                      实测一条 send_group_msg 的终态确认可能很慢(约 30s)，慢环境请加大，例如 60000。
  --state <dir>       bot.json 所在目录（${DEFAULT_STATE_DIR}）。文件形如
                      { "onebot": { "port": <http>, "wsPort": <ws>, "token": "<token>" } }。
  --bot-json <file>   直接指定 bot.json（优先于 --state）。
  --token-env <NAME>  bot.json 里取不到 token 时，从这个环境变量读（不打印、不落盘）。
  --host <addr>       仅回环：127.0.0.1 / ::1 / localhost（${DEFAULT_HOST}）。
  --port <n>          OneBot HTTP 端口（默认取 bot.json 的 onebot.port）。
  --ws-port <n>       OneBot WS 端口（默认取 bot.json 的 onebot.wsPort）。
  --ws-path <path>    WS 路径（${DEFAULT_WS_PATH}）。'/' = Universal（收事件 + 可发动作），
                      '/event' = 只收事件，'/api' = 只发动作；服务端另配了 wsPath 时用这里对齐。
  --message <text>    自发消息正文（notice-live-probe-<8hex>，每次不同，便于对照历史）。
  -h, --help          打印本帮助（不连网、不读 bot.json）。

输出：
  stdout  收到的**每一条 notice 原样一行 JSON**（不加重排、不加前缀），最后是一段 JSON 摘要
          { probe, mode, sent, noticeSeen, elapsedMs, verdict, reason, ... }。
  stderr  人读的进度与告警（token 永远显示为 Bearer ***）。

退出码：
  0  PASS：WS 上收到了 post_type=notice / notice_type=group_recall，
           且 message_id 与本脚本刚发那条一致。
  1  FAIL：没收到 / 字段不匹配 / 动作被拒 / 超时（reason 会写明卡在哪一步）。
  2  用法或配置错误（参数不合法、bot.json 读不到或字段不全）—— 不是验收结论，未执行任何动作。

示例：
  node scripts/notice-live-probe.mjs --group 123456789 --timeout 60000
  node scripts/notice-live-probe.mjs --group 123456789 --mode http --timeout 60000
`;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

class UsageError extends Error {}

const OPTIONS = new Map([
  ['--mode', 'mode'],
  ['--group', 'group'],
  ['--delay', 'delay'],
  ['--timeout', 'timeout'],
  ['--state', 'state'],
  ['--bot-json', 'botJson'],
  ['--token-env', 'tokenEnv'],
  ['--host', 'host'],
  ['--port', 'port'],
  ['--ws-port', 'wsPort'],
  ['--ws-path', 'wsPath'],
  ['--message', 'message'],
]);

function parseArgs(argv) {
  const raw = {};
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--help' || item === '-h') { help = true; continue; }
    if (!item.startsWith('--')) throw new UsageError(`unexpected argument: ${JSON.stringify(item)}`);
    const split = item.indexOf('=');
    const name = split === -1 ? item : item.slice(0, split);
    const field = OPTIONS.get(name);
    if (!field) throw new UsageError(`unknown option: ${name}`);
    let value = split === -1 ? undefined : item.slice(split + 1);
    if (value === undefined) {
      if (index + 1 >= argv.length) throw new UsageError(`option ${name} requires a value`);
      value = argv[++index];
    }
    if (raw[field] !== undefined) throw new UsageError(`option ${name} given more than once`);
    raw[field] = value;
  }
  return { help, raw };
}

function requiredInteger(name, value, min, max) {
  if (value === undefined) throw new UsageError(`${name} is required`);
  if (!/^[0-9]+$/.test(String(value))) throw new UsageError(`${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new UsageError(`${name} must be between ${min} and ${max}`);
  return number;
}

function optionalInteger(name, value, min, max, fallback) {
  if (value === undefined) return fallback;
  return requiredInteger(name, value, min, max);
}

const isPort = value => Number.isSafeInteger(value) && value >= 1 && value <= 65535;

function normalizeWsPath(value) {
  const text = String(value);
  if (!text.startsWith('/') || text.length > 128 || /\s/.test(text) || /[?#]/.test(text))
    throw new UsageError('--ws-path must be a path starting with "/" (e.g. / or /event)');
  return text;
}

function normalizeMessageText(value) {
  const text = value === undefined ? `notice-live-probe-${randomBytes(4).toString('hex')}` : String(value);
  if (!text) throw new UsageError('--message must not be empty');
  if (Buffer.byteLength(text) > 4096) throw new UsageError('--message is too long (max 4096 bytes)');
  return text;
}

// ---------------------------------------------------------------------------
// bot.json（形如 android/container-bot.mjs:475 写出的结构）
// ---------------------------------------------------------------------------

function readState({ botJson, stateDir }) {
  const file = botJson ? path.resolve(botJson) : path.resolve(stateDir, 'bot.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${file} (${error?.code ?? 'read failed'}) — 用 --state 或 --bot-json 指向手机上的 bot.json`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new UsageError(`${file} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new UsageError(`${file} must contain a JSON object`);
  const onebot = parsed.onebot && typeof parsed.onebot === 'object' && !Array.isArray(parsed.onebot)
    ? parsed.onebot : parsed;
  const token = typeof onebot.token === 'string' && onebot.token ? onebot.token : undefined;
  return {
    file,
    port: isPort(onebot.port) ? onebot.port : undefined,
    wsPort: isPort(onebot.wsPort) ? onebot.wsPort : undefined,
    token,
    phase: typeof parsed.phase === 'string' ? parsed.phase : undefined,
  };
}

function resolveConfig(raw) {
  const mode = String(raw.mode ?? 'ws').toLowerCase();
  if (mode !== 'ws' && mode !== 'http') throw new UsageError('--mode must be ws or http');

  const group = requiredInteger('--group', raw.group, 1, Number.MAX_SAFE_INTEGER);
  const delayMs = optionalInteger('--delay', raw.delay, 0, MAX_DELAY_MS, DEFAULT_DELAY_MS);
  const timeoutMs = optionalInteger('--timeout', raw.timeout, 100, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const host = String(raw.host ?? DEFAULT_HOST).toLowerCase();
  if (!LOOPBACK.has(host))
    throw new UsageError('--host must be a loopback address (127.0.0.1, ::1, localhost): this probe must never drive a remote bot');

  if (raw.tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw.tokenEnv))
    throw new UsageError('--token-env must be an environment variable name');

  const wsPath = normalizeWsPath(raw.wsPath ?? DEFAULT_WS_PATH);
  const message = normalizeMessageText(raw.message);

  const state = readState({ botJson: raw.botJson, stateDir: raw.state ?? DEFAULT_STATE_DIR });
  const port = optionalInteger('--port', raw.port, 1, 65535, state.port);
  const wsPort = optionalInteger('--ws-port', raw.wsPort, 1, 65535, state.wsPort);
  if (port === undefined)
    throw new UsageError(`${state.file} has no usable onebot.port — 传 --port，或确认机器人已到 onebot-ready 阶段`);
  if (mode === 'ws' && wsPort === undefined)
    throw new UsageError(`${state.file} has no usable onebot.wsPort — 传 --ws-port（或改用 --mode=http）`);

  let token = state.token;
  if (!token && raw.tokenEnv) token = process.env[raw.tokenEnv];
  if (typeof token !== 'string' || !token)
    throw new UsageError('OneBot token unavailable: bot.json has no onebot.token and --token-env was not given');
  if (/[\r\n]/.test(token)) throw new UsageError('OneBot token contains a line break');

  const authority = host.includes(':') ? `[${host}]` : host;
  return {
    mode,
    group,
    delayMs,
    timeoutMs,
    wsPath,
    message,
    port,
    wsPort,
    token,
    stateFile: state.file,
    phase: state.phase,
    httpBase: `http://${authority}:${port}`,
    wsUrl: mode === 'ws' ? `ws://${authority}:${wsPort}${wsPath}` : null,
  };
}

// ---------------------------------------------------------------------------
// 掩码 / 红act
// ---------------------------------------------------------------------------

/** 保留前 3 后 2，其余打码（项目要求：日志里不许出现完整号码）。 */
function maskId(value) {
  const text = String(value ?? '');
  if (!text) return '?';
  if (text.length <= 5) return '*'.repeat(text.length);
  return `${text.slice(0, 3)}${'*'.repeat(text.length - 5)}${text.slice(-2)}`;
}

/** 自由文本（wording / 异常消息）里的长数字串也按号处理。 */
const redactText = value => String(value ?? '').replace(/\d{6,}/g, digits => maskId(digits));

const log = (...parts) => process.stderr.write(`[${NAME}] ${parts.join(' ')}\n`);

function failure(reason, stage) {
  const error = new Error(reason);
  error.reason = reason;
  error.stage = stage;
  return error;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// WS 辅助
// ---------------------------------------------------------------------------

function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    const settle = error => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onOpen = () => settle();
    const onError = error => settle(failure(`ws.connect failed: ${error?.message ?? error}`, 'ws.connect'));
    const onClose = () => settle(failure('ws.connect failed: connection closed before open', 'ws.connect'));
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// 探针本体
// ---------------------------------------------------------------------------

async function probe(config) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + config.timeoutMs;
  const notices = [];
  let sentMessageId = null;
  let recallNotice = null;
  let recallResolve = null;
  let socket = null;
  let failureReason = null;

  const recallPromise = new Promise(resolve => { recallResolve = resolve; });

  const summary = {
    probe: NAME,
    mode: config.mode,
    sent: false,
    noticeSeen: {},
    elapsedMs: 0,
    verdict: 'FAIL',
    reason: 'not started',
    group: maskId(config.group),
    endpoint: { http: config.httpBase, ws: config.wsUrl },
    state: { file: config.stateFile, phase: config.phase ?? null },
    selfId: null,
    sentMessageId: null,
    recalled: false,
    recallMatched: false,
    wsConnected: false,
    wsClosed: false,
    noticesTotal: 0,
    warnings: [],
  };

  const remaining = () => deadlineAt - Date.now();
  const timeoutFailure = stage => failure(`timeout: ${stage} (总预算 ${config.timeoutMs}ms 用尽)`, stage);

  const raceDeadline = (stage, promise) => {
    const left = remaining();
    if (left <= 0) { promise.catch(() => {}); return Promise.reject(timeoutFailure(stage)); }
    let timer;
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutFailure(stage)), left); });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  };

  // 动作一律走 HTTP POST /<action>（与 server.mjs 的路径式分发一致）。
  const call = async (action, params = {}) => {
    const left = remaining();
    if (left <= 0) throw timeoutFailure(action);
    let response;
    try {
      response = await fetch(`${config.httpBase}/${action}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(left),
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw timeoutFailure(action);
      throw failure(`${action} transport error: ${redactText(error?.message ?? error)}`, action);
    }
    const text = await response.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw failure(`${action} returned an unparseable response (http ${response.status})`, action);
    if (response.status !== 200 || body.retcode !== 0) {
      const wording = redactText(body.wording ?? body.message ?? '');
      throw failure(`${action} rejected: retcode=${body.retcode ?? '?'} http=${response.status}${wording ? ` ${wording}` : ''}`, action);
    }
    return body.data;
  };

  const checkRecall = () => {
    if (recallNotice || sentMessageId === null) return;
    const hit = notices.find(item => item.notice_type === 'group_recall' && Number(item.message_id) === sentMessageId);
    if (!hit) return;
    recallNotice = hit;
    recallResolve(hit);
  };

  // 事件到达：原样透出 + 计数 + 匹配。非 notice 一律忽略（meta_event / message 不属本探针范围）。
  const onFrame = text => {
    let event;
    try { event = JSON.parse(text); } catch { log('ws: unparseable frame (ignored)'); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (event.post_type !== 'notice') return;
    notices.push(event);
    summary.noticesTotal = notices.length;
    const type = typeof event.notice_type === 'string' && event.notice_type ? event.notice_type : 'unknown';
    summary.noticeSeen[type] = (summary.noticeSeen[type] ?? 0) + 1;
    // ★ 人工核对用：原样一行 JSON，不加前缀、不重排字段。
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    checkRecall();
  };

  // 先建句柄再等握手：握手超时也能在 finally 里把 socket 收掉，绝不留下挂着的事件循环。
  const openSocket = async () => {
    const { WebSocket } = await import('ws'); // 延迟加载：--help / 用法错误不需要 ws 依赖
    const handshakeTimeout = Math.max(1, Math.min(remaining(), 10000));
    const ws = new WebSocket(config.wsUrl, {
      headers: { Authorization: `Bearer ${config.token}` },
      handshakeTimeout,
      perMessageDeflate: false,
      maxPayload: 4 * 1024 * 1024,
    });
    ws.on('error', () => {}); // 常驻兜底：握手后的 socket 错误不许逃逸成未捕获异常
    ws.on('message', (data, isBinary) => { if (!isBinary) onFrame(data.toString('utf8')); });
    ws.once('close', () => { summary.wsClosed = true; });
    return ws;
  };

  try {
    if (config.phase && !['onebot-ready', 'agent-running'].includes(config.phase))
      summary.warnings.push(`bot.json phase=${config.phase}（可能尚未 ready，端口可能已过期）`);

    if (config.mode === 'ws') {
      socket = await openSocket();
      await raceDeadline('ws.connect', waitOpen(socket));
      summary.wsConnected = true;
      log(`ws open ${config.wsUrl} (Authorization: Bearer ***)`);
    }

    // 先做两次只读动作：证明鉴权通了再动副作用动作（fail closed：读不到身份就不发）。
    const login = await call('get_login_info');
    if (login && login.user_id !== undefined) summary.selfId = maskId(login.user_id);
    else summary.warnings.push('get_login_info 未返回 user_id');
    log(`login ok self_id=${summary.selfId ?? '?'}`);

    const status = await call('get_status');
    if (status?.online !== true)
      throw failure(`not_online: get_status 返回 online=${JSON.stringify(status?.online)}，未发送任何消息`, 'get_status');
    if (status?.good !== true) summary.warnings.push('get_status good=false（服务端自评不健康，仍继续）');

    // ---- 第 1 步：发 ----
    const sent = await call('send_group_msg', { group_id: config.group, message: config.message });
    const rawMessageId = sent?.message_id;
    sentMessageId = typeof rawMessageId === 'string' && /^[1-9]\d{0,15}$/.test(rawMessageId) ? Number(rawMessageId) : rawMessageId;
    if (!Number.isSafeInteger(sentMessageId) || sentMessageId < 1)
      throw failure(`send_no_message_id: send_group_msg 没有返回可用的 message_id（${JSON.stringify(sentMessageId ?? null)}）`, 'send_group_msg');
    summary.sent = true;
    summary.sentMessageId = sentMessageId;
    log(`sent ok message_id=${sentMessageId} group=${maskId(config.group)}`);
    checkRecall(); // 防御：若撤回事件早于 HTTP 响应到达，这里补一次匹配

    // ---- 第 2 步：等（不许越过总预算） ----
    if (config.delayMs >= remaining())
      throw failure(`timeout: 发送后等待 ${config.delayMs}ms 会超出总预算 ${config.timeoutMs}ms（加大 --timeout 或减小 --delay）`, 'delay');
    await raceDeadline('delay', sleep(config.delayMs));

    // ---- 第 3 步：撤回（单次，不重试） ----
    await call('delete_msg', { message_id: sentMessageId });
    summary.recalled = true;
    log(`recall accepted message_id=${sentMessageId}`);

    if (config.mode !== 'ws') {
      summary.warnings.push('--mode=http 收不到事件：notice 断言无法进行（只验证了动作链）');
    } else {
      // ---- 第 4 步：等 group_recall ----
      const closedWhileWaiting = new Promise((_, reject) => {
        if (!socket || socket.readyState === 3)
          { reject(failure('ws.closed: 事件连接已断开', 'wait.group_recall')); return; }
        socket.once('close', () => reject(failure('ws.closed: 等待 group_recall 期间事件连接断开', 'wait.group_recall')));
      });
      closedWhileWaiting.catch(() => {}); // 竞速已结算后仍可能迟到 reject，兜住

      const notice = await raceDeadline('wait.group_recall', Promise.race([recallPromise, closedWhileWaiting]));

      // ---- 断言（唯一能量化的那条） ----
      // 1) post_type === 'notice'                 （onFrame 已过滤，这里再确认一次）
      // 2) notice_type === 'group_recall'
      // 3) notice.message_id === 刚发那条的 message_id
      summary.recallMatched = notice.post_type === 'notice' && notice.notice_type === 'group_recall' &&
        Number(notice.message_id) === sentMessageId;
      if (!summary.recallMatched)
        throw failure('notice mismatch: 收到 group_recall 但 message_id 与刚发出的那条不一致', 'assert.group_recall');

      // ---- 契约 §2 的字段体检（不判 FAIL，只记 warning，避免误伤） ----
      if (notice.group_id === undefined) summary.warnings.push('group_recall 缺 group_id（契约 §2 要求）');
      else if (Number(notice.group_id) !== config.group)
        summary.warnings.push(`group_recall.group_id 与目标群不一致（收到 ${maskId(notice.group_id)}）`);
      for (const key of ['user_id', 'operator_id'])
        if (notice[key] === undefined) summary.warnings.push(`group_recall 缺 ${key}（契约 §2 要求）`);
      if (notice.self_id !== undefined && login?.user_id !== undefined && Number(notice.self_id) !== Number(login.user_id))
        summary.warnings.push('group_recall.self_id 与 get_login_info.user_id 不一致');

      const sameIdCount = notices.filter(item =>
        item.notice_type === 'group_recall' && Number(item.message_id) === sentMessageId).length;
      if (sameIdCount > 1)
        summary.warnings.push(`同一 message_id 收到 ${sameIdCount} 条 group_recall（幂等契约要求恰好 1 条）`);

      log(`group_recall observed message_id=${sentMessageId}（${sameIdCount} 条与本次一致）`);
    }
  } catch (error) {
    failureReason = error?.reason ?? redactText(error?.message ?? String(error));
    if (error?.stage) summary.stage = error.stage;
  } finally {
    if (socket) {
      try { socket.terminate(); } catch { /* 已经关闭 */ }
    }
  }

  summary.elapsedMs = Date.now() - startedAt;

  if (failureReason) {
    summary.verdict = 'FAIL';
    summary.reason = failureReason;
    if (failureReason.startsWith('timeout:'))
      summary.hint = '本仓实测 send_group_msg 的终态确认可能慢到约 30s：请加大 --timeout（例如 60000）。';
  } else if (config.mode === 'http') {
    summary.verdict = 'FAIL';
    summary.reason = 'notice_not_observable_in_http_mode: 动作链已执行（sent/recalled 见字段），但 HTTP 模式收不到事件';
    summary.hint = '要断言 group_recall，请用 --mode=ws 重跑。';
  } else if (summary.sent && summary.recallMatched) {
    summary.verdict = 'PASS';
    summary.reason = `group_recall received on ws with message_id=${summary.sentMessageId}`;
  } else {
    summary.verdict = 'FAIL';
    summary.reason = 'notice_not_observed: 未在预算内收到与本条 message_id 匹配的 group_recall';
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${NAME}: ${redactText(error?.message ?? error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) { process.stdout.write(USAGE); return 0; }

  let config;
  try {
    config = resolveConfig(options.raw);
  } catch (error) {
    process.stderr.write(`${NAME}: ${redactText(error?.message ?? error)}\n\n${USAGE}`);
    return 2;
  }

  const summary = await probe(config);
  return summary.verdict === 'PASS' ? 0 : 1;
}

main().then(code => {
  process.exitCode = code;
  // 兜底：正常情况下事件循环自己退出；万一有遗留句柄，也绝不挂住。
  setTimeout(() => process.exit(code), 300).unref();
}, error => {
  process.stdout.write(`${JSON.stringify({
    probe: NAME, mode: null, sent: false, noticeSeen: {}, elapsedMs: 0, verdict: 'FAIL',
    reason: `unexpected: ${redactText(error?.message ?? String(error))}`,
  }, null, 2)}\n`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 300).unref();
});
