// 容器内机器人入口：原生登录 → 建桥 → 起 OneBot（HTTP/WS）→（可选）起原 agent 业务。
//
// 与 container-login.mjs 的分工：那个只管「拿到登录态 / 出二维码」，这个负责「登录后真正跑机器人」。
// 放在 /opt/whale/container-bot.mjs，由 APK 的 assets 覆盖写入（改这里只要重装 APK）。
//
// 用法：node container-bot.mjs [--with-agent]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const STATE = '/opt/whale/qq-state';
const GLOBAL = path.join(STATE, 'global');
const PROJECT = '/qq-onebot';
const RUNTIME = path.join(PROJECT, 'runtime');
const LOADER = '/opt/whale/native/loader.node';
const WRAPPER = '/opt/QQ/resources/app/wrapper.node';
// 账号标识不在本文件里写死：①环境变量 → ②容器的 src/config/account.mjs（唯一来源）→ ③上次登录留下的 identity.json。
// ★ 三级回退是必要的：容器里的 src 可能还没同步到最新（少 config/account.mjs），那时不能因为拿不到号就退化成扫码。
const BOT_UIN = await (async () => {
  const fromEnv = (process.env.QQ_BOT_UIN || '').trim();
  if (fromEnv) return fromEnv;
  const fromConfig = await import('/qq-onebot/src/config/account.mjs').then(m => String(m.BOT_UIN || '')).catch(() => '');
  if (fromConfig) return fromConfig;
  try { return String(JSON.parse(fs.readFileSync('/opt/whale/qq-state/identity.json', 'utf8')).uin || ''); } catch { return ''; }
})();
const WITH_AGENT = process.argv.includes('--with-agent');

const dirs = [STATE, GLOBAL, RUNTIME, path.join(RUNTIME, 'global'), path.join(RUNTIME, 'downloads'),
  path.join(RUNTIME, 'outcomes'), path.join(PROJECT, 'runtime')];
for (const d of dirs) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {} }

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
  // 只写文件。stdout 已被 shell 重定向到同一个 bot.log，再写一次会每行重复两遍。
  try { fs.appendFileSync(path.join(STATE, 'bot.log'), line); } catch {}
}

const state = { phase: 'starting', uin: null, uid: null, sessionId: null, onebot: null,
  startedAt: new Date().toISOString(), error: null, agent: null };
let finished = false;

/**
 * 把「每个资料库有多少段 / 记忆库里有多少条印象」写进 `<data>/knowledge-lib/stats.json`，只给手机面板看。
 *
 * 为什么由这里写：面板拿不到 sqlite（没有 sqlite 驱动），而 `node:sqlite` 只有容器里这个 Node 有。
 * 统计只在启动时做一次 —— 面板新增资料库 / 重建索引 / 新写入印象之后重启一次机器人，数字才会更新。
 * 任何一步失败都只记一行日志，绝不影响机器人主流程。
 */
async function writeKbStats() {
  const libDir = '/agent/data/knowledge-lib';
  const libFile = path.join(libDir, 'libraries.json');
  const idx = path.join(libDir, 'index.sqlite');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const chunks = {};
    if (fs.existsSync(libFile) && fs.existsSync(idx)) {
      const libs = JSON.parse(fs.readFileSync(libFile, 'utf8').replace(/^\uFEFF/, ''));
      const ids = Object.keys(libs?.libraries ?? {});
      const db = new DatabaseSync(idx, { readOnly: true });
      try {
        const stmt = db.prepare('SELECT COUNT(*) AS n FROM docs WHERE lib = ?');
        for (const id of ids) {
          try { chunks[id] = Number(stmt.get(id)?.n ?? 0); } catch { chunks[id] = 0; }
        }
      } finally { db.close(); }
    }
    const memory = readMemoryCount(DatabaseSync);
    if (!Object.keys(chunks).length && !memory) return;
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'stats.json'),
      JSON.stringify({ at: new Date().toISOString(), chunks, memory }, null, 2) + '\n');
    log('kb stats ' + JSON.stringify({ chunks, memory }));
  } catch (e) { log('kb stats failed: ' + (e?.message ?? e)); }
}

/** 记忆库（`memory-vec.sqlite`）里存了多少条印象 —— 只给面板显示用，读不到就返回 null。 */
function readMemoryCount(DatabaseSync) {
  const file = '/agent/data/memory-vec.sqlite';
  try {
    if (!fs.existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const n = db.prepare('SELECT COUNT(*) AS n FROM impressions_meta').get()?.n ?? 0;
      return { impressions: Number(n) };
    } finally { db.close(); }
  } catch { return null; }
}
setTimeout(() => { void writeKbStats(); }, 6000).unref();

/**
 * ★ 2026-11-19 · P3/P4：这里原本有个「held 自愈看门狗」（每 30s 扫 /api/chats，对 held>0 的会话
 *   POST resolve-held）。它是**补偿层**：掩盖的是「协议端会回 1504（未知）→ 运行端写
 *   outbox.state=unknown → 该会话被 held 永久禁跑」这个根因；而它自己也因为「5s 够读 /api/chats」
 *   这个错误假设变成新 bug（bot.log 累计 41 次读不到）。
 *   根因已按 P4 修掉（发送类动作拿不到回执时直接回「成功 + message_id:null」，held 不再产生）⇒ 删除。
 *   人工对账入口仍在面板「看板 → 待对账」（给人用的，不是自动补药）。
 */

/**
 * 挑一对 OneBot 端口：固定段（13800/13801 起）+ 占用回退 + 排除 agent 控制台端口。
 *
 * 为什么不用 port:0（随机）：随机端口会**和固定端口撞车**。2026-11-17 16:38 实测事故：
 * OneBot 随机到 41907，而 agent 控制台写死 server.port=41907 且 strictPort:true，
 * agent 启动即 EADDRINUSE 退出 → QQ 在线但**所有群都不回话**、私聊时好时坏。
 * 固定端口同时还消掉「agent 连旧端口」那一类代差问题（日志里端口可读可对比）。
 */
function pickOneBotPorts() {
  const reserved = new Set();
  // agent 控制台端口：撞上就必然把 agent 打死，必须排除
  try {
    const cfg = JSON.parse(fs.readFileSync('/agent/data/config.json', 'utf8'));
    const p = Number(cfg?.server?.port);
    if (Number.isInteger(p) && p > 0) reserved.add(p);
  } catch {}
  // /proc/net/tcp{,6} 里 state=0A 的是 LISTEN
  const inUse = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4 || cols[3] !== '0A') continue;
      const hex = (cols[1] || '').split(':')[1];
      if (hex) inUse.add(parseInt(hex, 16));
    }
  }
  const skipped = [];
  for (let i = 0; i < 40; i++) {
    const http = 13800 + i * 2, ws = http + 1;
    for (const p of [http, ws]) {
      if (reserved.has(p)) skipped.push(p + ':agent-console');
      else if (inUse.has(p)) skipped.push(p + ':in-use');
    }
    if (reserved.has(http) || reserved.has(ws) || inUse.has(http) || inUse.has(ws)) continue;
    return { port: http, wsPort: ws, skipped };
  }
  // 兜底：交给内核随机（至少不会卡死在启动）
  return { port: 0, wsPort: 0, skipped: skipped.concat('fallback-random') };
}

/**
 * 容器内单实例：把**别的** container-bot / agent 全部杀掉再干活。
 *
 * 为什么必须这么做（实机事故）：App 每次重启都会拉起一个新的 container-bot，而旧的 proot 子进程
 * 不会随 App 死掉 → 容器里同时存在多个 bot，各自登录同一个 QQ 号、各自监听随机端口。
 * 后登录的会把前一个的会话顶掉，于是「QQ 里显示在线，但根本收不到消息」（agent 连的还是旧端口）。
 * 症状：bot.json 的 receiveCallbacks 不再增长、agent 日志一直刷「30 秒后重连」。
 */
/**
 * 自己这条进程链上的所有祖先 pid（含 bash 包装、proot、Java 侧的 sh）。
 *
 * ★ 为什么必须排除祖先（实机事故 2026-11-17 16:07）：容器里的命令是
 * `proot … /bin/bash -lc 'node /opt/whale/container-bot.mjs'`，**bash 与 proot 的 cmdline 里
 * 同样含有 "container-bot.mjs" 字样**，而且它们比自己启动得更早。
 * 不排除的话，清扫会把**自己所在的包装 bash / proot 杀掉** → 整个进程组没了 →
 * Java 侧看到的是 `BOT: exit rc=137`（SIGKILL），表现为「机器人每 60 秒准时死一次」。
 */
function ancestorPids() {
  const set = new Set();
  for (let p = process.ppid, i = 0; p > 1 && i < 12; i++) {
    if (set.has(p)) break;
    set.add(p);
    try { p = Number(fs.readFileSync('/proc/' + p + '/stat', 'utf8').split(') ')[1].split(' ')[1]); }
    catch { break; }
  }
  return set;
}

function ensureSingleInstance() {
  const self = process.pid;
  const ancestors = ancestorPids();
  const victims = [];
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return []; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if (pid === self || ancestors.has(pid)) continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch { continue; }
    if (!cmd.includes('container-bot.mjs') && !cmd.includes('agent-app/src/server.js')) continue;
    try { process.kill(pid, 'SIGKILL'); victims.push(pid); } catch {}
  }
  if (victims.length) {
    log('单实例清理：killed ' + victims.join(','));
    // 同步等 2 秒给内核回收（用 Atomics.wait 而不是忙等，别把事件循环堵死）
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); } catch {}
  }
  return victims;
}
ensureSingleInstance();
// 运行期再扫一遍：万一又冒出第二个实例（比如用户连点、或旧 App 进程没死干净），
// 只保留**启动最晚**的那一个（starttime 更大），其余 bot/agent 全部清掉。
{
  const starttime = pid => {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    } catch { return Number.MAX_SAFE_INTEGER; }
  };
  const selfStart = starttime(process.pid);
  // ★ 祖先集合必须在**清扫时**重算一次并缓存：bash 包装 / proot 的 cmdline 也含脚本名，
  //   且启动更早；不排除就会把自己杀掉（详见 ancestorPids 的注释）。
  const ancestors = ancestorPids();
  const sweep = () => {
    let entries = [];
    try { entries = fs.readdirSync('/proc'); } catch { return; }
    for (const d of entries) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (pid === process.pid || ancestors.has(pid)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch { continue; }
      if (!cmd.includes('container-bot.mjs') && !cmd.includes('agent-app/src/server.js')) continue;
      // 只清**比自己早启动**的（自己拉起的 agent 更晚，不会被误杀）
      if (starttime(pid) < selfStart) {
        try { process.kill(pid, 'SIGKILL'); log('运行期清扫：killed ' + pid); } catch {}
      }
    }
  };
  setInterval(sweep, 60000).unref();
  log('单实例：运行期清扫已启动（每 60s，只清更早启动的实例）');
}

// 单实例由 Java 侧保证（起机器人前先 pkill 掉孤儿 node），这里不再用 pid 锁文件：
// pid 会被系统复用，一个陈旧锁里记的旧 pid 只要恰好被别的进程占用，就会永远挡住启动（实测 rc=0 空退）。


function save(phase, extra = {}) {
  state.phase = phase;
  Object.assign(state, extra);
  try {
    const tmp = path.join(STATE, 'bot.json.next');
    fs.writeFileSync(tmp, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path.join(STATE, 'bot.json'));
  } catch {}
}

function die(phase, error) {
  if (finished) return;
  finished = true;
  log('FATAL phase=' + phase + ' ' + (error?.stack || error?.message || error || ''));
  save(phase, { error: String(error?.code ?? error?.message ?? error ?? phase) });
  setTimeout(() => process.exit(1), 200);
}

process.on('uncaughtException', e => {
  // EPIPE / 管道关闭只是"没人读 stdout"，不是机器人故障。
  if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED')) { log('WARN ignore ' + e.code); return; }
  die('uncaught', e);
});
process.on('unhandledRejection', e => {
  if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED')) return;
  die('unhandled-rejection', e);
});

let originalChat, onebot, onebotToken, agentProc;
async function shutdown() {
  if (finished) return;
  finished = true;
  save('stopping');
  try { agentProc?.kill('SIGTERM'); } catch {}
  try { originalChat?.close(); } catch {}
  try { await onebot?.close?.(); } catch {}
  save('stopped');
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ------------------------------------------------------------------ 原生加载
const loader = { exports: {} };
process.dlopen(loader, LOADER, os.constants.dlopen.RTLD_NOW | os.constants.dlopen.RTLD_LOCAL);
log('loader ok ' + JSON.stringify(loader.exports));

const mod = { exports: {} };
process.dlopen(mod, WRAPPER, os.constants.dlopen.RTLD_LAZY | os.constants.dlopen.RTLD_LOCAL);
const w = mod.exports;
log('wrapper ok exports=' + Object.getOwnPropertyNames(w).length);

w.NodeIO3MiscService.get().addO3MiscListener({ getOnAmgomDataPiece() {} });
const engine = w.NodeIQQNTWrapperEngine.get();
const callbacks = {};
for (const n of ['onLog', 'onGetSrvCalTime', 'onShowErrUITips', 'onInstallFinished',
  'onUpdateGeneralFlag', 'onGetOfflineMsg', 'fixPicImgType', 'getAppSetting']) callbacks[n] = () => {};
engine.initWithDeskTopConfig({
  base_path_prefix: '', platform_type: 5, app_type: 4,
  app_version: '3.2.35-54395', os_version: os.version(), use_xlog: true,
  qua: 'V1_LNX_NQ_3.2.35_54395_GW_B',
  global_path_config: { desktopGlobalPath: GLOBAL },
  thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
}, callbacks);
log('engine init ok');

const startup = w.NodeIQQNTStartupSessionWrapper.create();
const session = w.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
log('startup/session ok');

const login = w.NodeIKernelLoginService.get();
login.initConfig({
  machineId: '', appid: '537403759', platVer: 'Linux ' + os.release(),
  commonPath: GLOBAL, clientVer: '3.2.35-54395', hostName: os.hostname(),
});
log('login service init ok');

// ------------------------------------------------------------------ 登录
let authenticated = false, qrRequested = false, qrTimes = 0, qr = false;

const requestQr = () => {
  if (authenticated || qr) return;
  qr = true; qrRequested = true;
  save('requesting-qr');
  log('requesting-qr');
  try { login.getQRCodePicture(); } catch (e) { log('getQRCodePicture threw ' + e.message); }
};

async function tryQuickLogin() {
  if (authenticated) return false;
  if (typeof login.getLoginList !== 'function' || typeof login.quickLoginWithUin !== 'function') return false;
  let list;
  try { list = await login.getLoginList(); } catch (e) { log('getLoginList threw ' + e.message); return false; }
  const arr = Array.isArray(list) ? list : (list?.LocalLoginInfoList || list?.localLoginInfoList || list?.list || []);
  log('login list size=' + arr.length);
  const hit = arr.find(x => x && x.isQuickLogin === true && String(x.uin ?? '') === BOT_UIN);
  if (!hit) { log('no saved quick-login entry -> qr'); return false; }
  log('quick-login-attempting uin=' + hit.uin);
  try {
    const r = await login.quickLoginWithUin(BOT_UIN);
    if (r?.result === '0' && !r?.loginErrorInfo?.errMsg) { log('quick-login accepted'); return true; }
    log('quick-login rejected result=' + JSON.stringify(r?.result ?? null));
    return false;
  } catch (e) { log('quickLoginWithUin threw ' + e.message); return false; }
}

const listener = {
  onQRCodeGetPicture(value) {
    try {
      const b64 = String(value?.pngBase64QrcodeData ?? '').replace(/^data:image\/png;base64,/, '');
      if (!b64) { log('qr picture without data'); return; }
      const bytes = Buffer.from(b64, 'base64');
      const next = path.join(STATE, 'qr.next');
      fs.writeFileSync(next, bytes, { mode: 0o600 });
      fs.renameSync(next, path.join(STATE, 'qr.png'));
      if (typeof value?.qrcodeUrl === 'string') {
        const u = path.join(STATE, 'qr.url.next');
        fs.writeFileSync(u, value.qrcodeUrl.trim(), { mode: 0o600 });
        fs.renameSync(u, path.join(STATE, 'qr.url'));
      }
      save('qr-ready');
      log('qr-ready bytes=' + bytes.length);
    } catch (e) { log('qr write fail ' + e.message); }
  },
  onQRCodeLoginPollingStarted() { log('qr-polling'); },
  onQRCodeSessionUserScaned() {
    save('scanned');
    log('scanned');
    try { fs.unlinkSync(path.join(STATE, 'qr.url')); } catch {}
  },
  onQRCodeSessionFailed(t, c) {
    log('qr-session-failed type=' + t + ' code=' + c);
    if (authenticated) return;
    qrTimes++;
    if (qrTimes <= 50) { setTimeout(() => { qr = false; requestQr(); }, 1000); }
    else die('qr-failed');
  },
  onQRCodeLoginSucceed(value) {
    if (authenticated) return;
    if (String(value?.uin) !== BOT_UIN || typeof value?.uid !== 'string' || !value.uid) {
      die('unexpected-login-identity'); return;
    }
    authenticated = true;
    state.uin = String(value.uin); state.uid = value.uid;
    try { fs.writeFileSync(path.join(STATE, 'identity.json'),
      JSON.stringify({ uin: state.uin, uid: state.uid, at: new Date().toISOString() })); } catch {}
    save('authenticated');
    log('LOGIN_OK uin=' + state.uin + ' uid=' + String(state.uid).slice(0, 12) + '…');
    setImmediate(initializeSession);
  },
  onQRCodeSessionQuickLoginFailed() { log('quick-login-failed -> qr'); if (!authenticated && !qr) requestQr(); },
  onLoginConnected() {
    log('login-connected');
    if (authenticated) return;
    void tryQuickLogin().then(ok => { if (!ok && !authenticated) requestQr(); });
  },
  onLoginDisconnected() { log('login-disconnected'); },
  onLoginFailed(e) { log('login-failed ' + JSON.stringify(e ?? null)); },
  onLogoutSucceed() { log('logged-out'); },
};
login.addKernelLoginListener(listener);
log('listener registered');
try { login.connect(); log('connect called'); } catch (e) { die('connect-failed', e); }

// 看门狗：50 秒还没连上就强行推一次（否则会一直等）
setTimeout(() => {
  if (authenticated || qr) return;
  log('WARN: 50s 未 login-connected，强制尝试快速登录/出码');
  void tryQuickLogin().then(ok => { if (!ok && !authenticated) requestQr(); });
}, 50000);

// ------------------------------------------------------------------ 会话初始化
let initStarted = false, initAccepted = false, readyTimer = null;

function initializeSession() {
  if (finished || !authenticated || initStarted) return;
  if (typeof login.getMachineGuid !== 'function') { die('machine-guid-unavailable'); return; }
  const guid = login.getMachineGuid();
  if (typeof guid !== 'string' || !guid) { die('machine-guid-invalid'); return; }
  save('initializing-session');
  log('initializing session guid=' + guid.slice(0, 8) + '…');
  const nativeConfig = {
    selfUin: BOT_UIN, selfUid: state.uid,
    desktopPathConfig: { account_path: GLOBAL },
    clientVer: '3.2.35-54395', a2: '', d2: '', d2Key: '', machineId: '', platform: 5,
    platVer: 'Linux ' + os.release(), appid: '537403759',
    defaultFileDownloadPath: path.join(RUNTIME, 'downloads'),
    deviceInfo: { guid, buildVer: '3.2.35-54395', localId: 2052, devName: os.hostname(),
      devType: 'Linux', vendorName: '', osVer: os.version() || os.type(), vendorOsName: 'Linux',
      setMute: false, vendorType: 0 },
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
    rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform: 5,
      language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '',
      serverUrl: '', fixedAfterHitKeys: [''] },
  };
  const depends = {
    onRegisterProxyOnlineResp: () => {}, onMSFStatusChange: () => {}, onMSFSsoError: () => {},
    getGroupCode: () => { log('depends.getGroupCode called'); return ''; },
  };
  const dispatcher = { dispatchRequest: () => {}, dispatchCall: () => {}, dispatchCallWithJson: () => {} };
  const sessionListener = {
    onNTSessionCreate: () => {}, onGProSessionCreate: () => {}, onGetSelfTinyId: () => {},
    onUserOnlineResult: () => {},
    onOpentelemetryInit(info) {
      log('onOpentelemetryInit is_init=' + (info?.is_init === true));
      if (info?.is_init === true) { initAccepted = true; setImmediate(completeReady); }
    },
    onSessionInitComplete(result) {
      log('onSessionInitComplete result=' + JSON.stringify(result ?? null));
      if (result === 0 || result === '0') { initAccepted = true; setImmediate(completeReady); }
      else save('session-init-unclassified');
    },
  };
  try {
    session.init(nativeConfig, depends, dispatcher, sessionListener);
    initStarted = true;
    save('starting-session');
    startup.start();
    save('waiting-session-ready');
    completeReady();
  } catch (e) { die('session-init-threw', e); }
}

let botStarting = false;
function completeReady() {
  if (finished || !initAccepted || state.phase === 'session-ready') return;
  // ★ 关键：onOpentelemetryInit 与 onSessionInitComplete 会**各自**触发一次 completeReady，
  //   若不加闸门就会**起两个 OneBot 服务**（两套随机端口）：agent 拿到第一套、bot.json 写的是第二套，
  //   于是 agent 永远连一个死端口 → 刷「X 秒后重连」→ 「QQ 在线但一句话不回」。
  if (botStarting) return;
  let msgService;
  try { msgService = session.getMsgService(); } catch (e) { die('getMsgService-threw', e); return; }
  if (msgService === null || msgService === undefined) { readyTimer = setTimeout(completeReady, 200); return; }
  const sessionId = typeof session.getSessionId === 'function' ? session.getSessionId() : null;
  if (typeof sessionId !== 'string' || !sessionId) { die('invalid-session-id'); return; }
  state.sessionId = sessionId;
  save('session-ready');
  log('session ready id=' + sessionId.slice(0, 8) + '…');
  botStarting = true;
  setImmediate(() => { void startBot().catch(e => die('bot-start-failed', e)); });
}

// ------------------------------------------------------------------ 机器人
async function startBot() {
  const { createOriginalChatBridge } = await import(path.join(PROJECT, 'src/host/original-chat-bridge.mjs'));

  // 图片发送：ImageStore 暂存 + wrapper 的 copyFile 落到 SDK 给的富媒体路径。
  let imagePlacement;
  try {
    const { ImageStore } = await import(path.join(PROJECT, 'src/media/image-store.mjs'));
    const { createNativeImagePlacement } = await import(path.join(PROJECT, 'src/media/native-image-placement.mjs'));
    const binding = w.NodeQQNTWrapperUtil;
    const util = typeof binding?.get === 'function' ? binding.get() : binding;
    if (typeof util?.copyFile === 'function') {
      imagePlacement = createNativeImagePlacement({
        store: new ImageStore({ projectRoot: PROJECT }),
        root: path.join(RUNTIME, 'global'),
        copy: (source, destination) => util.copyFile(source, destination),
      });
      log('image placement ready');
    } else log('image placement unavailable (no copyFile)');
  } catch (e) { log('image placement setup failed: ' + e.message); }

  const expectedSession = state.sessionId;
  originalChat = createOriginalChatBridge({
    session,
    identity: { user_id: BOT_UIN, uid: state.uid, sessionId: expectedSession },
    isCurrent: () => !finished && authenticated && state.sessionId === expectedSession &&
      session.getSessionId() === expectedSession,
    onUpdate: v => { if (v?.stage !== 'opened') log('bridge ' + v.stage + (v.code ? ' code=' + v.code : '')); },
    onDiagnostics: d => { state.diag = d; },
    onUnknown: v => { log('bridge unknown ' + JSON.stringify(v)); save('action-unknown'); },
    imagePlacement,
  });
  await originalChat.attach();
  log('bridge attached');

  onebotToken = randomBytes(24).toString('hex');
  // ★ 端口：固定基址 + 占用回退，且**永不与 agent 控制台端口相同**。
  //   事故（2026-11-17 16:38）：OneBot 原本用 port:0 随机端口，这一轮随机到 41907，
  //   而 agent 自己的控制台是 config.json 里写死的 server.port=41907（strictPort:true，
  //   绑不上就直接退出）⇒ agent 启动即 EADDRINUSE，整机表现为「所有群都说不了话」。
  //   随机端口撞固定端口是概率问题，迟早复发，所以这里改成固定段 + 显式排除。
  const { port: obPort, wsPort: obWsPort, skipped } = pickOneBotPorts();
  if (skipped.length) log('ONEBOT_PORTS skip=' + JSON.stringify(skipped));
  // ★ 在**同一个进程里**起 OneBot，不用 fork/IPC。
  //   原因：QQ 原生层（libbugly）把 SIGPIPE 注册成了致命信号，
  //   而 fork 出来的子进程一旦死掉，父进程往 IPC socket 写就会触发 SIGPIPE → 整个机器人当场被打死（实测 signo 13）。
  const { createOneBotService } = await import(path.join(PROJECT, 'src/service.mjs'));
  // 上一次崩溃/被强杀会留下 owner.lock，新实例启动会直接 EEXIST 失败。
  // 我们已经持有单实例锁，所以这里可以安全地清掉陈旧锁。
  try { fs.rmSync(path.join(PROJECT, 'runtime/outcomes/owner.lock'), { force: true }); } catch {}
  // ★ 「更新完一会儿机器人就静默」的真因根治（2026-11-18）：
  //   重启/重装会打断在途发送，留下 runtime/outcomes/pending.json；
  //   新进程一旦把它当成"本次未知"，写闸就永久关闭 ⇒ 之后所有发送 1503，群里怎么 @ 都不回。
  //   这里在**建服务之前**把上一个进程留下的记录隔离成 pending.orphaned-*.json（留证），
  //   于是新进程的闸是开的。注意：**不重发**、不改任何发送语义，只是不再用历史记录锁死未来。
  try {
    const outcomes = path.join(PROJECT, 'runtime/outcomes');
    const pendingFile = path.join(outcomes, 'pending.json');
    if (fs.existsSync(pendingFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(outcomes, 'pending.orphaned-' + stamp + '.json');
      let detail = '';
      try { const rec = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); detail = ' action=' + (rec.action ?? '?') + ' time=' + (rec.time ?? '?'); } catch { detail = ' unreadable'; }
      fs.renameSync(pendingFile, target);
      log('OUTCOME_ORPHAN_QUARANTINED' + detail + ' -> ' + path.basename(target));
    }
  } catch (e) { log('outcome orphan quarantine failed: ' + (e?.message ?? e)); }
  onebot = await createOneBotService({
    bridge: originalChat,
    projectRoot: PROJECT, token: onebotToken,
    // 端口由 pickOneBotPorts() 选定：固定段 + 占用回退 + 排除 agent 控制台端口（见该函数注释）。
    port: obPort, wsPort: obWsPort,
    authorizationPolicy: 'native-session', conversationPolicy: 'original',
    minimumWriteIntervalMs: 0, agentPlusCompatibility: true,
  });
  const child = { port: onebot.address.port, wsPort: onebot.wsAddress.port };
  save('onebot-ready', { onebot: { port: child.port, wsPort: child.wsPort, token: onebotToken } });
  log('ONEBOT_READY http=' + child.port + ' ws=' + child.wsPort);

  if (WITH_AGENT) {
    try { await startAgent(child); } catch (e) { log('agent start failed: ' + (e?.stack || e)); save('agent-failed', { agent: String(e?.message ?? e) }); }
  }

  // 心跳：阶段由**进程实际状态**算，不由"尝试次数"推断
  // （之前 agent 明明活着，bot.json 却写 agent-exhausted —— 这种字段比没有更坏）。
  setInterval(() => {
    const d = state.diag ?? {};
    let phase = state.phase;
    if (authenticated) {
      if (agentProc && agentProc.exitCode === null && agentProc.signalCode === null) phase = 'agent-running';
      else if (onebot) phase = 'onebot-ready';
    }
    save(phase, { counters: {
      receiveCallbacks: d.receiveCallbacks ?? 0, updateCallbacks: d.updateCallbacks ?? 0,
      publishedEvents: d.publishedEvents ?? 0, projectionFailures: d.projectionFailures ?? 0,
      unknownActions: d.unknownActions ?? 0, attached: d.attached === true,
      agentAlive: !!(agentProc && agentProc.exitCode === null && agentProc.signalCode === null),
      agentAttempts,
    } });
  }, 3000);
}

// agent 的 preload 源码（内嵌，保证与本公司版本一致；每次起 agent 前重新写一份）。
// 只做三件事：①把 OneBot 地址与 token 强制注入 onebot.js 的构造器；②把它的动作超时从写死的
// 15 秒放大（见下）；③不碰 fetch / 模型凭据。
//
// ★ 为什么要改那 15 秒（2026-11-19 实测）：用户要求「运行端 15 秒太短，强制改长」。
//   运行端 `onebot.js: const TEXT_TIMEOUT_MS = 15000` 是**写死的常量**，不在配置里，
//   所以只能在这里改源码。不改的后果有据可查：一条 outbox 记着
//   `unknown` + `The operation was aborted due to timeout` —— 我们的发送响应被限流队列
//   拖过 15 秒，运行端先放弃 → 记 unknown → 该会话 held → 后续消息全被挡住。
//   协议端这边的链条是严格递增的：桥接回执窗口(5s) < 核心 timeoutMs(10s) < 本值(默认 120s)。
//   本值由面板项 `onebot.textTimeoutMs` 控制（container-bot 读配置后放进环境变量）。
const AGENT_PRELOAD = `import { registerHooks } from 'node:module';
if (process.env.WHALE_ORIGINAL_AGENT !== '1') throw Error('ORIGINAL_PRELOAD_NOT_ARMED');
const target = 'file:///input/agent-app/src/onebot/onebot.js';
const constructor = "  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent, heartbeat = 'auto', heartbeatMs = HEARTBEAT_MS }) {";
const timeoutDecl = 'const TEXT_TIMEOUT_MS = 15000;';
const DEFAULT_TEXT_TIMEOUT_MS = 120000;
function textTimeoutMs() {
  const raw = process.env.WHALE_ONEBOT_TEXT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TEXT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 600000) throw Error('ONEBOT_TIMEOUT_INVALID');
  return ms;
}
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    let text = Buffer.from(loaded.source).toString('utf8');
    if (text.split(constructor).length !== 2) throw Error('ONEBOT_SOURCE_CHANGED');
    // 上游把这个常量删了/改值时**明确报错**，而不是悄悄跑回 15 秒。
    if (text.split(timeoutDecl).length !== 2) throw Error('ONEBOT_TIMEOUT_SOURCE_CHANGED');
    const ms = textTimeoutMs();
    text = text.replace(constructor, constructor +
      '\\n    if (process.env.WHALE_ONEBOT_WS_URL) wsUrl = process.env.WHALE_ONEBOT_WS_URL;' +
      '\\n    if (process.env.WHALE_ONEBOT_HTTP_URL) httpUrl = process.env.WHALE_ONEBOT_HTTP_URL;' +
      '\\n    accessToken = process.env.WHALE_ONEBOT_TOKEN; httpToken = process.env.WHALE_ONEBOT_TOKEN;');
    text = text.replace(timeoutDecl, 'const TEXT_TIMEOUT_MS = ' + ms + ';');
    return { ...loaded, source: text };
  },
});
`;

let agentAttempts = 0;
/** 同一时刻只允许一次 startAgent 在飞：之前两次并发起 agent 会互相把对方的进程当残留杀掉（互杀循环）。 */
let agentInFlight = false;

/**
 * 量「agent 起来 → 控制台可用」到底多久：每 2 秒打一次 `/api/chats`，第一次 200 就打
 * `CONSOLE_READY after=+Xs`；10 分钟还没起来打一行 timeout 就停。
 *
 * 为什么留着：用户体感「启动慢」时，只靠「等一会儿」永远说不清是几秒。有这一行就能分清
 * 是 agent 初始化慢、还是控制台自身慢。探测失败不影响任何主流程，纯日志。
 */
/**
 * agent 自己的控制台端口：读 /agent/data/config.json 的 server.port，读不到退回 41907。
 *
 * ★ 别拿 OneBot 的端口（13800）来试：那条口对 /api/chats 只会回 401/404，永远等不到 200。
 */
function agentConsolePort() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/agent/data/config.json', 'utf8'));
    const p = Number(cfg?.server?.port);
    if (Number.isFinite(p) && p > 0) return p;
  } catch { /* 读不到就用默认 */ }
  return 41907;
}

function consoleReadyProbe(port, startedAt) {
  if (!port) return;
  const deadline = startedAt + 10 * 60 * 1000;
  let done = false;
  const tick = async () => {
    if (done) return;
    if (Date.now() > deadline) {
      done = true;
      log('CONSOLE_READY timeout(10min) — 控制台一直没起来');
      return;
    }
    try {
      const code = await new Promise((resolve) => {
        const req = http.get({
          host: '127.0.0.1',
          port,
          path: '/api/chats',
          timeout: 3000,
          headers: { Host: '127.0.0.1:' + port },
        }, (res) => { res.resume(); resolve(res.statusCode || 0); });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
      });
      if (code === 200) {
        done = true;
        log('CONSOLE_READY after=+' + Math.round((Date.now() - startedAt) / 1000) + 's');
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    setTimeout(() => { void tick(); }, 2000).unref?.();
  };
  setTimeout(() => { void tick(); }, 2000).unref?.();
}
async function startAgent(child) {
  if (agentInFlight) { log('agent start already in flight, skip'); return; }
  if (agentAttempts >= 6) { log('agent attempts exhausted'); return; }
  agentInFlight = true;
  agentAttempts++;
  const appDir = '/input/agent-app';
  try { fs.writeFileSync('/agent/preload.mjs', AGENT_PRELOAD); } catch (e) { log('write preload failed: ' + e.message); }
  const entry = path.join(appDir, 'src/server.js');
  if (!fs.existsSync(entry)) { log('agent entry missing: ' + entry); save('agent-missing'); return; }

  // 1) 只把「部署相关」的 OneBot 端点写进业务配置；apiKey / 业务设置 / 概率 / 开关一律不动。
  const cfgFile = '/agent/data/config.json';
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const before = { mode: cfg.runtime?.mode, paused: cfg.runtime?.paused };
  // ★ 原则 P6（2026-11-19 用户定）：内置机器人是**我们自己的产品**，被深度改造过就不再跟随上游版本。
  //   更新入口保留（用户要求面板上留着），但**强制指向我们自己的仓库**，永远不去作者的上游仓库；
  //   镜像更新（snowluma）是上游专用通道，一律关掉。上游更新改走人工评审。
  const UPDATE_REPO = 'https://github.com/18477514055/whale-onebot.git';
  const prevRepo = cfg.autoUpdate?.repository;
  cfg.autoUpdate = { ...(cfg.autoUpdate ?? {}), repository: UPDATE_REPO,
    snowluma: { ...(cfg.autoUpdate?.snowluma ?? {}), enabled: false } };
  if (prevRepo && prevRepo !== UPDATE_REPO) log('autoUpdate 仓库已改回本项目（原值 ' + prevRepo + '，原则 P6：不跟随上游）');
  cfg.onebot = { ...(cfg.onebot ?? {}), wsUrl: 'ws://127.0.0.1:' + child.wsPort,
    httpUrl: 'http://127.0.0.1:' + child.port, accessToken: '', httpAccessToken: '',
    // ★ 重启/更新后补回 30 分钟内的消息（作者默认值）。原来是 0＝不补，
    //   结果「启动那 20–80 秒里被 @ 的消息」永远得不到回应 —— 用户 2026-11-19 反复踩到。
    catchupReplyWindowMs: 1800000 };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  log('agent config patched onebot=' + child.port + '/' + child.wsPort + ' runtime=' + JSON.stringify(before));
  // agent 自己的单实例锁：上一次崩溃会留下 .server.lock，而且它把「不同主机名」也当冲突，
  // 容器每次 hostname 都可能不同 → 不删就永远 E_INSTANCE_LOCKED。
  // ★ 更要命的是「上一代 agent 还活着」：它拿着旧端口跑，新一代起不来 / 起来了也被它顶掉。
  //   所以这里按 /proc/*/cmdline **精确找 pid** 再 kill（pkill -f 跨 proot 会话不可靠）。
  try {
    const victims = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (pid === process.pid || pid === process.ppid) continue;
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch { continue; }
      if (cmd.includes('agent-app/src/server.js')) { try { process.kill(pid, 'SIGKILL'); victims.push(pid); } catch {} }
    }
    if (victims.length) log('killed residual agents: ' + victims.join(','));
    await new Promise(r => setTimeout(r, 1200));
    fs.rmSync('/agent/data/.server.lock', { force: true });
  } catch (e) { log('agent cleanup failed: ' + e.message); }

  // 2) 起 agent：只注入 OneBot token（preload），模型直接用业务配置里原有的凭据，不经过任何 relay。
  fs.mkdirSync('/agent/home/tmp', { recursive: true });
  const out = fs.openSync(path.join(RUNTIME, 'agent-stdout.log'), 'a', 0o600);
  const err = fs.openSync(path.join(RUNTIME, 'agent-stderr.log'), 'a', 0o600);
  // 运行端的动作超时（面板项 onebot.textTimeoutMs，默认 120000）：
  // 不传就让 preload 用自己的默认值；传了就必须是合法毫秒数（非法值 preload 会拒绝启动，宁可报错不静默）。
  const cfgTextTimeout = Number(cfg.onebot?.textTimeoutMs);
  const textTimeoutMs = Number.isSafeInteger(cfgTextTimeout) && cfgTextTimeout >= 1000 && cfgTextTimeout <= 600000
    ? cfgTextTimeout : 120000;
  const proc = spawn(process.execPath, ['--import', 'file:///agent/preload.mjs', entry], {
    cwd: appDir,
    stdio: ['ignore', out, err],
    env: { PATH: '/bin', HOME: '/agent/home', TMPDIR: '/agent/home/tmp', TZ: 'Asia/Shanghai',
      QQ_AGENT_DATA_DIR: '/agent/data', WHALE_ORIGINAL_AGENT: '1', WHALE_ONEBOT_TOKEN: onebotToken,
      // ★ 地址走环境变量、由 preload 强制注入：不依赖 config.json（它可能被业务程序重写）。
      WHALE_ONEBOT_WS_URL: 'ws://127.0.0.1:' + child.wsPort,
      WHALE_ONEBOT_HTTP_URL: 'http://127.0.0.1:' + child.port,
      // ★ 15 秒是上游写死的常量，太短会把我们的慢响应判成未知 → held。见 AGENT_PRELOAD 注释。
      WHALE_ONEBOT_TEXT_TIMEOUT_MS: String(textTimeoutMs) },
  });
  log('agent textTimeoutMs=' + textTimeoutMs);
  agentProc = proc;
  proc.on('exit', (code, sig) => {
    log('AGENT_EXIT code=' + code + ' signal=' + sig);
    agentInFlight = false;
    // 自己退了就再来一次（下一次会先清掉占着 .server.lock 的残留 agent）。
    if (!finished) setTimeout(() => { void startAgent(child).catch(e => log('agent retry failed: ' + e.message)); }, 5000).unref();
  });
  proc.on('error', e => log('AGENT_ERROR ' + e.message));
  save('agent-started', { agent: { pid: proc.pid } });
  const agentStartedAt = Date.now();
  log('AGENT_STARTED pid=' + proc.pid);
  consoleReadyProbe(agentConsolePort(), agentStartedAt);

  // 保洁：不做「按 env 判断端口」的清理 —— 实测 proot 里的进程 /proc/<pid>/environ 读出来是空的，
  // 那样会把**自己的** agent 当成残留杀掉（log 里就是 AGENT_STARTED 两秒后被 killed stale agent）。
  // 残留清理只放在「起之前」做一次（见上面的 /proc 扫描 + kill），起之后不再动。
}
