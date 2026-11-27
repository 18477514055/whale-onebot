// [layer: shell-android] 容器内单进程统一入口：登录状态机（快登 / 按需扫码 / 账密+滑块）→ 建桥 → OneBot → Agent。
//
// ★ 2026-11-27 架构彻底合一（问答报告 Q3/Q5/Q6/Q8/Q9/Q10）：
//   1. 废弃并发 container-login.mjs 抢占 qq-state/global/nt_db/login.db；本进程统一接管登录与运行；
//   2. 严格按需出码：掉线或快登失败后立刻进入 waiting-manual-login / token-expired / kicked-offline 并告警，
//      绝不后台自动循环刷 50 张码；仅在收到人工 cmd.json (request_qr) 时请求 1 张码；
//   3. 零误杀看门狗：先核验快登可用性，绝不盲目杀进程把在线会话踢进扫码态；
//   4. 接入原生 passwordLogin + verifyUrl/verifyCaptchaTicket + MSF/断连/被踢全监听 + login.db WAL checkpoint。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createNativeWatchdogState,
  createAgentConsoleWatchdogState,
  isMsfTicketInvalidError,
  classifyLoginError,
  sanitizeVerifyUrl,
  sanitizeQrUrl,
  readStableMachineId,
  readRestartHistory,
  recordRestartTimestamp,
  resolveContainerAccount,
  applyResolvedAccountToEnv,
  pickQuickLoginEntry,
  isAcceptableLoginIdentity,
  cleanUin
} from './container-watchdog.mjs';

// 支持多 QQ 机器人按槽位隔离状态目录（--slot=<botId>）；默认空槽位兼容老路径 /opt/whale/qq-state
const SLOT_ARG = (process.argv.find((a) => a.startsWith('--slot=')) || '').slice('--slot='.length).replace(/[^A-Za-z0-9_-]/g, '');
const STATE = SLOT_ARG ? path.join('/opt/whale/qq-state-slots', SLOT_ARG) : '/opt/whale/qq-state';
const GLOBAL = path.join(STATE, 'global');
const CMD_FILE = path.join(STATE, 'cmd.json');
const BLACKBOX_FILE = path.join(STATE, 'blackbox.log');
const PROJECT = '/qq-onebot';
const RUNTIME = SLOT_ARG ? path.join(STATE, 'runtime') : path.join(PROJECT, 'runtime');
const LOADER = '/opt/whale/native/loader.node';
const WRAPPER = '/opt/QQ/resources/app/wrapper.node';

function detectClientVersion() {
  try {
    const raw = JSON.parse(fs.readFileSync('/opt/QQ/resources/app/package.json', 'utf8'));
    const v = String(raw?.version || '').trim();
    if (/^\d+\.\d+\.\d+-\d+$/.test(v)) return v;
  } catch { /* fallback */ }
  return '3.2.35-54395';
}
const CLIENT_VER = detectClientVersion();
const CLIENT_APP_VER = CLIENT_VER.split('-')[0];
const CLIENT_BUILD = CLIENT_VER.split('-')[1] || '';
const CLIENT_QUA = 'V1_LNX_NQ_' + CLIENT_APP_VER + '_' + CLIENT_BUILD + '_GW_B';
const MACHINE_ID = readStableMachineId('/opt/whale/device');

const resolvedAccount = resolveContainerAccount({
  env: process.env,
  stateDir: STATE,
  agentConfigFile: '/agent/data/config.json',
  accountFile: '/qq-onebot/src/config/account.mjs',
});
let BOT_UIN = resolvedAccount.botUin;
const OWNER_UIN = resolvedAccount.ownerUin;
applyResolvedAccountToEnv(resolvedAccount, process.env);
const WITH_AGENT = process.argv.includes('--with-agent');

const dirs = [STATE, GLOBAL, RUNTIME, path.join(RUNTIME, 'global'), path.join(RUNTIME, 'downloads'),
  path.join(RUNTIME, 'outcomes'), path.join(PROJECT, 'runtime')];
for (const d of dirs) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {} }

// 防掉线黑匣子环形日志：保留最近 120 条关键事件，触发 -10004/-10003/140022015/1006501 时落盘前后上下文
const blackboxRing = [];
let lastBlackboxDumpAt = 0;
function recordBlackbox(tag, detail = '') {
  const entry = `${new Date().toISOString()} [${tag}] ${String(detail || '')}`;
  blackboxRing.push(entry);
  if (blackboxRing.length > 120) blackboxRing.shift();
}
function dumpBlackbox(trigger) {
  const now = Date.now();
  if (now - lastBlackboxDumpAt < 30_000) return;
  lastBlackboxDumpAt = now;
  try {
    const header = `\n===== BLACKBOX DUMP ${new Date(now).toISOString()} trigger=${trigger} ver=${CLIENT_VER} host=${os.hostname()} =====\n`;
    fs.appendFileSync(BLACKBOX_FILE, header + blackboxRing.join('\n') + '\n', { mode: 0o600 });
  } catch {}
}

function log(...a) {
  const msg = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(STATE, 'bot.log'), line); } catch {}
  if (/MSF|KICK|140022|10065|WATCHDOG|LOGIN|OFFLINE|AGENT|BILI|bridge/.test(msg)) {
    recordBlackbox('LOG', msg);
  }
  if (/-10004|140022015|1006501|NATIVE_KICKED_OFFLINE/.test(msg)) {
    dumpBlackbox(msg.slice(0, 80));
  }
}

const state = {
  phase: 'starting',
  uin: null,
  uid: null,
  sessionId: null,
  onebot: null,
  startedAt: new Date().toISOString(),
  error: null,
  agent: null,
  // 2026-11-27 统一上下线诊断字段（供 App 状态页与远端同步渲染）
  canQuickLogin: false,
  needsManualLogin: false,
  offlineReason: '',
  offlineMessage: '',
  verifyUrl: '',
  verifyAt: 0,
  qrAt: 0,
  msfStatus: 'init',
  lastMsfError: '',
  lastHealthyAt: 0,
  lastWakeAt: 0,
  clientVer: CLIENT_VER,
  hostname: os.hostname(),
  kernelRelease: os.release(),
};
let finished = false;
let switchAccountPending = false;

/**
 * NTQQ 的 global/nt_db/login.db 采用 SQLCipher 加密格式，标准 node:sqlite 无法直接打开；
 * 改为在登录成功或优雅退出前留出短暂宽限窗口，交由 NTQQ 原生引擎自身完成 WAL 落盘。
 */
async function checkpointLoginDb(reason = 'periodic') {
  if (reason === 'shutdown' || reason === 'safe_logout' || reason === 'switch_account' || reason === 'watchdog-restart') {
    await new Promise(r => setTimeout(r, 1200));
    log('LOGIN_DB_FLUSH_GRACE done reason=' + reason);
  }
  return true;
}

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

function pickOneBotPorts() {
  const reserved = new Set();
  try {
    const cfg = JSON.parse(fs.readFileSync('/agent/data/config.json', 'utf8'));
    const p = Number(cfg?.server?.port);
    if (Number.isInteger(p) && p > 0) reserved.add(p);
  } catch {}
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
    const httpPort = 13800 + i * 2, wsPort = httpPort + 1;
    for (const p of [httpPort, wsPort]) {
      if (reserved.has(p)) skipped.push(p + ':agent-console');
      else if (inUse.has(p)) skipped.push(p + ':in-use');
    }
    if (reserved.has(httpPort) || reserved.has(wsPort) || inUse.has(httpPort) || inUse.has(wsPort)) continue;
    return { port: httpPort, wsPort, skipped };
  }
  return { port: 0, wsPort: 0, skipped: skipped.concat('fallback-random') };
}

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
    if (cmd.includes('--whale-binding-worker')
      || (!cmd.includes('container-bot.mjs') && !cmd.includes('container-login.mjs') && !cmd.includes('agent-app/src/server.js'))) continue;
    try { process.kill(pid, 'SIGKILL'); victims.push(pid); } catch {}
  }
  if (victims.length) {
    log('单实例清理：killed ' + victims.join(','));
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); } catch {}
  }
  return victims;
}
ensureSingleInstance();

{
  const starttime = pid => {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    } catch { return Number.MAX_SAFE_INTEGER; }
  };
  const selfStart = starttime(process.pid);
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
      if (cmd.includes('--whale-binding-worker')
        || (!cmd.includes('container-bot.mjs') && !cmd.includes('container-login.mjs') && !cmd.includes('agent-app/src/server.js'))) continue;
      if (starttime(pid) < selfStart) {
        try { process.kill(pid, 'SIGKILL'); log('运行期清扫：killed ' + pid); } catch {}
      }
    }
  };
  setInterval(sweep, 60000).unref();
  log('单实例：运行期清扫已启动（每 60s，只清更早启动的实例）');
}

function save(phase, extra = {}) {
  state.phase = phase;
  Object.assign(state, extra);
  try {
    const tmp = path.join(STATE, 'bot.json.next');
    fs.writeFileSync(tmp, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path.join(STATE, 'bot.json'));
  } catch {}
}

function clearQrArtifacts() {
  try { fs.unlinkSync(path.join(STATE, 'qr.url')); } catch {}
  try { fs.unlinkSync(path.join(STATE, 'qr.png')); } catch {}
  state.qrAt = 0;
}

function die(phase, error) {
  if (finished) return;
  finished = true;
  log('FATAL phase=' + phase + ' ' + (error?.stack || error?.message || error || ''));
  save(phase, { error: String(error?.code ?? error?.message ?? error ?? phase) });
  void checkpointLoginDb('die').finally(() => setTimeout(() => process.exit(1), 200));
}

process.on('uncaughtException', e => {
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
  await checkpointLoginDb('shutdown');
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
  app_version: CLIENT_VER, os_version: os.version(), use_xlog: true,
  qua: CLIENT_QUA,
  global_path_config: { desktopGlobalPath: GLOBAL },
  thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
}, callbacks);
log('engine init ok ver=' + CLIENT_VER + ' host=' + os.hostname() + ' rel=' + os.release());

const startup = w.NodeIQQNTStartupSessionWrapper.create();
const session = w.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
log('startup/session ok');

const login = w.NodeIKernelLoginService.get();
login.initConfig({
  machineId: MACHINE_ID, appid: '537403759', platVer: 'Linux ' + os.release(),
  commonPath: GLOBAL, clientVer: CLIENT_VER, hostName: os.hostname(),
});
log('login service init ok mid=' + (MACHINE_ID ? MACHINE_ID.slice(0, 8) + '…' : 'empty'));

// ------------------------------------------------------------------ 单进程登录状态机
let authenticated = false;
let loginConnected = false;
let qrInFlight = false;
let quickTriedOnBoot = false;
let pendingPwdLogin = null; // { uin, passwordMd5 } 仅驻留内存供本次滑块后提交，绝不写盘/打日志

/** 实时核验本地是否仍有可用的免扫码快登条目（用于看门狗防误杀决策）。 */
async function probeQuickLoginAvailable() {
  if (typeof login.getLoginList !== 'function') return { available: false, hit: null, count: 0 };
  try {
    const list = await login.getLoginList();
    const arr = Array.isArray(list) ? list : (list?.LocalLoginInfoList || list?.localLoginInfoList || list?.list || []);
    const hit = pickQuickLoginEntry(arr, BOT_UIN, OWNER_UIN);
    const available = Boolean(hit);
    state.canQuickLogin = available;
    return { available, hit, count: arr.length };
  } catch (e) {
    log('getLoginList threw ' + e.message);
    return { available: false, hit: null, count: 0 };
  }
}

/** 按需请求 1 张二维码（严格遵守 Q5：绝不后台自动循环刷码）。 */
function requestQrOnce(source = 'manual') {
  if (authenticated) {
    log('requestQrOnce ignored: already authenticated');
    return;
  }
  clearQrArtifacts();
  qrInFlight = true;
  state.verifyUrl = '';
  state.verifyAt = 0;
  save('requesting-qr', { needsManualLogin: true, offlineReason: state.offlineReason || 'manual_qr_requested' });
  log('requesting-qr source=' + source);
  try {
    if (!loginConnected) {
      try { login.connect(); } catch {}
    }
    login.getQRCodePicture();
  } catch (e) {
    qrInFlight = false;
    log('getQRCodePicture threw ' + e.message);
    save('waiting-manual-login', {
      needsManualLogin: true,
      offlineReason: 'qr_request_failed',
      offlineMessage: '请求二维码失败：' + (e?.message || '未知错误')
    });
  }
}

/** 进入需要人工介入的离线待机态（绝不自动刷码，通知宿主推送告警）。 */
function enterManualOffline(classified) {
  qrInFlight = false;
  clearQrArtifacts();
  const phase = classified?.phase || 'waiting-manual-login';
  save(phase, {
    uin: null,
    uid: null,
    canQuickLogin: false,
    needsManualLogin: true,
    offlineReason: classified?.code || 'needs_manual_login',
    offlineMessage: classified?.message || 'QQ 当前未在线，请选择上线方式重新登录',
    verifyUrl: classified?.verifyUrl || '',
    verifyAt: classified?.verifyUrl ? Date.now() : 0
  });
  log('MANUAL_LOGIN_REQUIRED phase=' + phase + ' reason=' + (classified?.code || '') + ' msg=' + (classified?.message || ''));
}

async function tryQuickLogin() {
  if (authenticated) return true;
  if (typeof login.getLoginList !== 'function' || typeof login.quickLoginWithUin !== 'function') {
    enterManualOffline({ code: 'quick_login_unavailable', phase: 'waiting-manual-login', message: '本地快登不可用，请手动登录 QQ' });
    return false;
  }
  let probe = await probeQuickLoginAvailable();
  if (!probe.available && fs.existsSync(path.join(STATE, 'identity.json'))) {
    await new Promise(r => setTimeout(r, 1500));
    probe = await probeQuickLoginAvailable();
  }
  log('login list size=' + probe.count + ' expected=' + (BOT_UIN || '(auto)') + ' canQuick=' + probe.available);
  if (!probe.hit) {
    enterManualOffline({
      code: 'no_quick_login_entry',
      phase: 'waiting-manual-login',
      message: '本机没有可用的免扫码快登记录，请选择一键拉起 QQ、扫码或账密登录'
    });
    return false;
  }
  const attemptUin = String(probe.hit.uin).trim();
  if (!BOT_UIN) {
    BOT_UIN = attemptUin;
    applyResolvedAccountToEnv({ botUin: BOT_UIN, ownerUin: OWNER_UIN }, process.env);
  }
  save('quick-login', { needsManualLogin: false, offlineReason: '', offlineMessage: '' });
  log('quick-login-attempting uin=' + attemptUin);
  try {
    const r = await login.quickLoginWithUin(attemptUin);
    const resCode = String(r?.result ?? '');
    const errMsg = String(r?.loginErrorInfo?.errMsg ?? r?.errMsg ?? '');
    const vUrl = sanitizeVerifyUrl(r?.loginErrorInfo?.verifyUrl || r?.verifyUrl || '');
    if (resCode === '0' && !errMsg && !vUrl) {
      log('quick-login accepted');
      return true;
    }
    log('quick-login rejected result=' + JSON.stringify(r?.result ?? null) + ' hasVerify=' + Boolean(vUrl));
    enterManualOffline(classifyLoginError(resCode, errMsg, vUrl));
    return false;
  } catch (e) {
    log('quickLoginWithUin threw ' + e.message);
    enterManualOffline(classifyLoginError('', e?.message || 'quickLoginWithUin 异常'));
    return false;
  }
}

/** 原生账密登录（wrapper.node passwordLogin；密码绝不写盘/打日志，仅单次内存提交）。 */
async function performPasswordLogin(rawUin, rawPassword, captchaExtra = null) {
  if (authenticated) {
    log('passwordLogin skipped: already authenticated');
    return;
  }
  const uin = cleanUin(rawUin);
  if (!uin) {
    enterManualOffline({ code: 'invalid_uin', phase: 'waiting-manual-login', message: '请输入有效的机器人 QQ 号' });
    return;
  }
  if (OWNER_UIN && uin === OWNER_UIN) {
    log('BLOCKED passwordLogin attempt on OWNER_UIN');
    enterManualOffline({ code: 'unexpected_owner_identity', phase: 'waiting-manual-login', message: '安全防线拦截：禁止使用主号登录机器人' });
    return;
  }
  if (typeof login.passwordLogin !== 'function') {
    enterManualOffline({ code: 'password_login_unsupported', phase: 'waiting-manual-login', message: '当前 QQ 客户端原生库未暴露 passwordLogin 接口，请改用一键拉起 QQ 或扫码' });
    return;
  }
  const md5 = rawPassword
    ? createHash('md5').update(String(rawPassword), 'utf8').digest('hex')
    : (pendingPwdLogin && pendingPwdLogin.uin === uin ? pendingPwdLogin.passwordMd5 : '');
  if (!md5) {
    enterManualOffline({ code: 'empty_password', phase: 'waiting-manual-login', message: '密码不能为空' });
    return;
  }
  pendingPwdLogin = { uin, passwordMd5: md5 };
  clearQrArtifacts();
  save('pwd-logging-in', {
    needsManualLogin: true,
    offlineReason: '',
    offlineMessage: '正在向 QQ 提交账密登录…',
    verifyUrl: '',
    verifyAt: 0
  });
  log('passwordLogin attempting uin=' + uin + (captchaExtra ? ' (with captcha ticket)' : ''));
  try {
    if (!loginConnected) {
      try { login.connect(); } catch {}
    }
    // ★ 2026-11-27 真机 wrapper.node 符号表核对后的精确 LoginInfo 字段：
    //   uin / passwordMd5 / step / proofWaterSig / proofWaterRand / proofWaterSid /
    //   newDeviceLoginSig / unusualDeviceCheckSig / registerSucceedSig
    const req = {
      uin,
      passwordMd5: md5,
      step: captchaExtra ? 1 : 0,
      proofWaterSig: captchaExtra?.ticket ? String(captchaExtra.ticket) : '',
      proofWaterRand: captchaExtra?.randStr ? String(captchaExtra.randStr) : '',
      proofWaterSid: captchaExtra?.sid ? String(captchaExtra.sid) : '',
      newDeviceLoginSig: '',
      unusualDeviceCheckSig: '',
      registerSucceedSig: ''
    };
    const r = await login.passwordLogin(req);
    const resCode = String(r?.result ?? '');
    const errInfo = r?.loginErrorInfo || {};
    const errMsg = String(errInfo?.errMsg ?? r?.errMsg ?? '');
    const vUrl = sanitizeVerifyUrl(
      errInfo?.proofWaterUrl || errInfo?.verifyUrl || errInfo?.jumpUrl
      || r?.proofWaterUrl || r?.verifyUrl || ''
    );
    if (resCode === '0' && !errMsg && !vUrl) {
      log('passwordLogin accepted uin=' + uin);
      return;
    }
    log('passwordLogin result=' + JSON.stringify(r?.result ?? null)
      + ' errMsg=' + JSON.stringify(errMsg.slice(0, 120))
      + ' hasVerify=' + Boolean(vUrl)
      + ' errKeys=' + JSON.stringify(Object.keys(errInfo)));
    enterManualOffline(classifyLoginError(resCode, errMsg, vUrl));
  } catch (e) {
    log('passwordLogin threw ' + e.message);
    enterManualOffline(classifyLoginError('', e?.message || '账密登录调用异常'));
  }
}

async function handleSubmitCaptcha(cmd) {
  const ticket = String(cmd?.ticket ?? '').trim();
  const randStr = String(cmd?.randStr ?? '').trim();
  const sid = String(cmd?.sid ?? '').trim();
  log('submit_captcha received hasTicket=' + Boolean(ticket) + ' hasRand=' + Boolean(randStr));
  if (typeof login.verifyCaptchaTicket === 'function' && ticket) {
    try {
      await login.verifyCaptchaTicket({ ticket, randstr: randStr, randStr, sid });
      log('verifyCaptchaTicket invoked');
    } catch (e) {
      log('verifyCaptchaTicket threw ' + e.message);
    }
  }
  if (pendingPwdLogin && ticket) {
    await performPasswordLogin(pendingPwdLogin.uin, '', { ticket, randStr, sid });
  } else {
    save('waiting-manual-login', {
      verifyUrl: '',
      verifyAt: 0,
      needsManualLogin: true,
      offlineMessage: '验证已提交，如尚未上线请再次点击登录'
    });
  }
}

function onAuthenticatedCommon(value, source) {
  if (authenticated) return;
  const expected = switchAccountPending ? '' : BOT_UIN;
  const ver = isAcceptableLoginIdentity(value, { expectedBotUin: expected, ownerUin: OWNER_UIN });
  if (!ver.ok) {
    log('LOGIN_REJECTED reason=' + ver.reason);
    enterManualOffline({
      code: ver.reason,
      phase: 'waiting-manual-login',
      message: ver.reason === 'unexpected-owner-identity'
        ? '安全防线拦截：禁止登录主号，请换机器人小号重新登录'
        : '登录身份与绑定机器人不一致，已拦截'
    });
    return;
  }
  switchAccountPending = false;
  pendingPwdLogin = null;
  BOT_UIN = ver.uin;
  applyResolvedAccountToEnv({ botUin: ver.uin, ownerUin: OWNER_UIN, botUid: ver.uid }, process.env);
  authenticated = true;
  qrInFlight = false;
  state.uin = ver.uin;
  state.uid = ver.uid;
  state.canQuickLogin = true;
  state.needsManualLogin = false;
  state.offlineReason = '';
  state.offlineMessage = '';
  state.verifyUrl = '';
  state.verifyAt = 0;
  clearQrArtifacts();
  try {
    fs.writeFileSync(path.join(STATE, 'identity.json'),
      JSON.stringify({ uin: state.uin, uid: state.uid, at: new Date().toISOString() }), { mode: 0o600 });
  } catch {}
  save('authenticated');
  log('LOGIN_OK source=' + source + ' uin=' + state.uin + ' uid=' + String(state.uid).slice(0, 12) + '…');
  setTimeout(() => { void checkpointLoginDb('post-login'); }, 3000).unref();
  setImmediate(initializeSession);
}

const listener = {
  onQRCodeGetPicture(value) {
    if (authenticated) return;
    try {
      const b64 = String(value?.pngBase64QrcodeData ?? '').replace(/^data:image\/png;base64,/, '');
      if (!b64) { log('qr picture without data'); return; }
      const bytes = Buffer.from(b64, 'base64');
      const next = path.join(STATE, 'qr.next');
      fs.writeFileSync(next, bytes, { mode: 0o600 });
      fs.renameSync(next, path.join(STATE, 'qr.png'));
      const cleanUrl = sanitizeQrUrl(value?.qrcodeUrl || '');
      if (cleanUrl) {
        const u = path.join(STATE, 'qr.url.next');
        fs.writeFileSync(u, cleanUrl, { mode: 0o600 });
        fs.renameSync(u, path.join(STATE, 'qr.url'));
      }
      save('qr-ready', {
        qrAt: Date.now(),
        needsManualLogin: true,
        offlineMessage: '二维码已就绪（约 2 分钟有效），请使用一键拉起 QQ 或相机扫码'
      });
      log('qr-ready bytes=' + bytes.length + ' hasUrl=' + Boolean(cleanUrl));
    } catch (e) { log('qr write fail ' + e.message); }
  },
  onQRCodeLoginPollingStarted() { log('qr-polling'); },
  onQRCodeSessionUserScaned() {
    save('scanned', { offlineMessage: '已扫码，请在手机 QQ 上点击确认登录' });
    log('scanned');
    try { fs.unlinkSync(path.join(STATE, 'qr.url')); } catch {}
  },
  onQRCodeSessionFailed(t, c) {
    log('qr-session-failed type=' + t + ' code=' + c + ' (按需出码策略：不自动循环刷码)');
    if (authenticated) return;
    qrInFlight = false;
    clearQrArtifacts();
    save('waiting-manual-login', {
      needsManualLogin: true,
      offlineReason: 'qr_expired',
      offlineMessage: '二维码已过期，需要时请手动点击「获取二维码 / 一键拉起 QQ」'
    });
  },
  onQRCodeLoginSucceed(value) { onAuthenticatedCommon(value, 'qr-or-quick'); },
  onLoginSuccess(value) { onAuthenticatedCommon(value, 'password-or-native'); },
  onUserLoggedIn(value) {
    log('onUserLoggedIn uin=' + (value?.uin ?? '?'));
    if (value?.uin && value?.uid) onAuthenticatedCommon(value, 'user-logged-in');
  },
  onQRCodeSessionQuickLoginFailed(err) {
    log('quick-login-failed ' + JSON.stringify(err ?? null));
    if (!authenticated) {
      enterManualOffline(classifyLoginError(err?.result ?? '', err?.errMsg ?? '快速登录失败'));
    }
  },
  onPasswordLoginFailed(err) {
    log('password-login-failed ' + JSON.stringify(err ?? null));
    if (!authenticated) {
      const vUrl = sanitizeVerifyUrl(err?.verifyUrl || err?.loginErrorInfo?.verifyUrl || '');
      enterManualOffline(classifyLoginError(err?.result ?? err?.errCode ?? '', err?.errMsg ?? err?.loginErrorInfo?.errMsg ?? '', vUrl));
    }
  },
  onLoginConnected() {
    loginConnected = true;
    log('login-connected');
    if (authenticated || quickTriedOnBoot) return;
    quickTriedOnBoot = true;
    void tryQuickLogin();
  },
  onLoginDisconnected() {
    loginConnected = false;
    log('login-disconnected');
    state.msfStatus = 'login-disconnected';
  },
  onLoginFailed(e) {
    log('login-failed ' + JSON.stringify(e ?? null));
    if (!authenticated) {
      const vUrl = sanitizeVerifyUrl(e?.verifyUrl || e?.loginErrorInfo?.verifyUrl || '');
      enterManualOffline(classifyLoginError(e?.result ?? e?.errCode ?? '', e?.errMsg ?? e?.loginErrorInfo?.errMsg ?? '', vUrl));
    }
  },
  onLogoutSucceed() {
    log('logged-out');
  },
};
login.addKernelLoginListener(listener);
log('listener registered');
try { login.connect(); log('connect called'); } catch (e) { die('connect-failed', e); }

// 50s 兜底：若始终未收到 onLoginConnected，尝试一次快登；失败即停在待人工登录态（绝不自动刷码）
setTimeout(() => {
  if (authenticated || quickTriedOnBoot) return;
  quickTriedOnBoot = true;
  log('WARN: 50s 未收到 login-connected，执行一次快登检查');
  void tryQuickLogin();
}, 50000).unref();

// ★ QQ 与 Agent 本体 / B 站彻底解耦：容器进程启动 5s 后若 QQ 仍未登录（如 token-expired / waiting-manual-login），
//   自动独立拉起 Agent 本体（41907）与 B 站行为层；若 5s 内快登成功则直接一步到位带新 token 启动（零 401 重连）。
setTimeout(() => {
  if (finished) return;
  try { startBiliWorker(); } catch (e) { log('early bili worker start failed: ' + (e?.message ?? e)); }
  if (WITH_AGENT && !agentProc && !agentInFlight && !agentSpawning) {
    void startAgent(null).catch(e => log('early decoupled agent start failed: ' + (e?.message ?? e)));
  }
}, 5000).unref();
setInterval(() => {
  if (!finished) { try { startBiliWorker(); } catch {} }
}, 15000).unref();

// ------------------------------------------------------------------ 受控命令消费循环（500ms）
async function executeCommand(cmd) {
  const action = String(cmd?.action || '').trim();
  if (!action) return;
  log('CMD_RECV action=' + action);
  if (action === 'request_qr') {
    requestQrOnce('cmd');
    return;
  }
  if (action === 'password_login') {
    await performPasswordLogin(cmd.uin, cmd.password);
    return;
  }
  if (action === 'submit_captcha') {
    await handleSubmitCaptcha(cmd);
    return;
  }
  if (action === 'wake_session') {
    if (authenticated && originalChat) {
      try {
        const info = await originalChat.wakeSession?.();
        state.lastWakeAt = Date.now();
        log('CMD_WAKE_SESSION ' + JSON.stringify(info ?? {}));
      } catch (e) {
        log('CMD_WAKE_SESSION_ERR ' + (e?.message ?? e));
      }
    }
    return;
  }
  if (action === 'safe_logout' || action === 'switch_account' || action === 'force_relogin') {
    const prevUin = state.uin || BOT_UIN;
    // 解耦：仅释放 QQ 协议与 OneBot 通道，绝不杀 Agent 本体与 B 站 worker
    try { originalChat?.close?.(); } catch {}
    try { await onebot?.close?.(); } catch {}
    onebot = null;
    originalChat = null;
    authenticated = false;
    initStarted = false;
    initAccepted = false;
    botStarting = false;
    clearQrArtifacts();
    if (action === 'switch_account' || action === 'safe_logout') {
      try { fs.unlinkSync(path.join(STATE, 'identity.json')); } catch {}
    }
    if (action === 'switch_account') {
      switchAccountPending = true;
      BOT_UIN = '';
      try { if (prevUin && typeof login.resetLoginInfo === 'function') await login.resetLoginInfo(String(prevUin)); } catch {}
    }
    await checkpointLoginDb(action);
    enterManualOffline({
      code: action === 'switch_account' ? 'switch_account' : 'manual_logout',
      phase: 'waiting-manual-login',
      message: action === 'switch_account'
        ? '已安全退出旧账号（聊天与记忆数据已完整保留），请选择新账号重新登录'
        : (action === 'force_relogin'
          ? '已释放旧连接，请选择一键拉起 QQ、扫码或账密重新上线'
          : '已安全下线（聊天与记忆数据已完整保留），需要时随时可重新上线')
    });
    if (action === 'force_relogin' && cmd.mode === 'qr') {
      requestQrOnce('force_relogin');
    }
  }
}

let cmdBusy = false;
setInterval(() => {
  if (finished || cmdBusy) return;
  if (!fs.existsSync(CMD_FILE)) return;
  cmdBusy = true;
  let cmd = null;
  try {
    const raw = fs.readFileSync(CMD_FILE, 'utf8');
    // 立即删除命令文件（避免任何密码残留在磁盘上）
    try { fs.unlinkSync(CMD_FILE); } catch {}
    cmd = JSON.parse(raw);
  } catch (e) {
    try { fs.unlinkSync(CMD_FILE); } catch {}
    log('CMD_PARSE_ERR ' + (e?.message ?? e));
  }
  Promise.resolve(cmd ? executeCommand(cmd) : null)
    .catch(e => log('CMD_EXEC_ERR ' + (e?.message ?? e)))
    .finally(() => { cmdBusy = false; });
}, 500).unref();

// 定期 WAL checkpoint（每 30 分钟），确保长期在线时 login.db 票据持久落盘
setInterval(() => {
  if (!finished && authenticated) void checkpointLoginDb('30m-timer');
}, 30 * 60_000).unref();

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
    clientVer: CLIENT_VER, a2: '', d2: '', d2Key: '', machineId: MACHINE_ID, platform: 5,
    platVer: 'Linux ' + os.release(), appid: '537403759',
    defaultFileDownloadPath: path.join(RUNTIME, 'downloads'),
    deviceInfo: { guid, buildVer: CLIENT_VER, localId: 2052, devName: os.hostname(),
      devType: 'Linux', vendorName: '', osVer: os.version() || os.type(), vendorOsName: 'Linux',
      setMute: false, vendorType: 0 },
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
    rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform: 5,
      language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '',
      serverUrl: '', fixedAfterHitKeys: [''] },
  };
  const depends = {
    onRegisterProxyOnlineResp: (info) => {
      log('MSF onRegisterProxyOnlineResp ' + JSON.stringify(info ?? null));
      state.msfStatus = 'proxy-online';
    },
    onMSFStatusChange: (status) => {
      log('MSF onMSFStatusChange ' + JSON.stringify(status ?? null));
      state.msfStatus = typeof status === 'object' ? JSON.stringify(status) : String(status ?? '');
    },
    onMSFSsoError: (err) => {
      const msg = typeof err === 'object' ? JSON.stringify(err) : String(err ?? '');
      log('MSF onMSFSsoError ' + msg);
      state.lastMsfError = msg.slice(0, 200);
      if (/1006501|kicked/i.test(msg)) {
        authenticated = false;
        enterManualOffline(classifyLoginError('1006501', msg));
      }
    },
    getGroupCode: () => { log('depends.getGroupCode called'); return ''; },
  };
  const dispatcher = { dispatchRequest: () => {}, dispatchCall: () => {}, dispatchCallWithJson: () => {} };
  const sessionListener = {
    onNTSessionCreate: () => {}, onGProSessionCreate: () => {}, onGetSelfTinyId: () => {},
    onUserOnlineResult: (res) => { log('onUserOnlineResult ' + JSON.stringify(res ?? null)); },
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
  if (finished || !initAccepted || botStarting || state.phase === 'session-ready') return;
  let msgService;
  try { msgService = session.getMsgService(); } catch (e) { die('getMsgService-threw', e); return; }
  if (msgService === null || msgService === undefined) { readyTimer = setTimeout(completeReady, 200); return; }
  const sessionId = typeof session.getSessionId === 'function' ? session.getSessionId() : null;
  if (typeof sessionId !== 'string' || !sessionId) { die('invalid-session-id'); return; }
  // 严格单次闩锁，彻底消除 onOpentelemetryInit 与 onSessionInitComplete 并发导致的双重 bridge attached
  botStarting = true;
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  state.sessionId = sessionId;
  save('session-ready');
  log('session ready id=' + sessionId.slice(0, 8) + '…');
  setImmediate(() => { void startBot().catch(e => die('bot-start-failed', e)); });
}

// ------------------------------------------------------------------ 机器人与零误杀看门狗
let heartbeatTimer = null;
let nativeWatchdogTimer = null;
let consoleWatchdogTimer = null;

async function startBot() {
  const { createOriginalChatBridge } = await import(path.join(PROJECT, 'src/host/original-chat-bridge.mjs'));

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
  // 监听被踢下线原生事件：立刻切换为 kicked-offline 并禁止自动重启/刷码
  if (typeof originalChat.on === 'function') {
    originalChat.on('notice', (ev) => {
      if (ev?.meta_event_type === 'lifecycle' && ev?.reason === 'kicked_offline') {
        log('NATIVE_KICKED_OFFLINE event received');
        authenticated = false;
        enterManualOffline(classifyLoginError('1006501', '账号已被腾讯安全中心或其他终端踢下线'));
      }
    });
  }
  await originalChat.attach();

  onebotToken = randomBytes(24).toString('hex');
  const { port: obPort, wsPort: obWsPort, skipped } = pickOneBotPorts();
  if (skipped.length) log('ONEBOT_PORTS skip=' + JSON.stringify(skipped));
  const { createOneBotService } = await import(path.join(PROJECT, 'src/service.mjs'));
  try { fs.rmSync(path.join(PROJECT, 'runtime/outcomes/owner.lock'), { force: true }); } catch {}
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
    port: obPort, wsPort: obWsPort,
    authorizationPolicy: 'native-session', conversationPolicy: 'original',
    minimumWriteIntervalMs: 0, agentPlusCompatibility: true,
  });
  const child = { port: onebot.address.port, wsPort: onebot.wsAddress.port };
  save('onebot-ready', {
    onebot: { port: child.port, wsPort: child.wsPort, token: onebotToken },
    lastHealthyAt: Date.now(),
    msfStatus: 'online'
  });
  log('ONEBOT_READY http=' + child.port + ' ws=' + child.wsPort);

  if (WITH_AGENT) {
    try { await startAgent(child); } catch (e) { log('agent start failed: ' + (e?.stack || e)); save('agent-failed', { agent: String(e?.message ?? e) }); }
  }
  startBiliWorker();

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!finished) { try { startBiliWorker(); } catch (e) { log('bili worker check failed: ' + e.message); } }
    const d = state.diag ?? {};
    let phase = state.phase;
    if (authenticated && phase !== 'degraded') {
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

  // ① 原生通道零误杀+票据自愈看门狗（每 90s 探活；无可用快登绝不重启，有可用快登且遇 MSF -10004/-10003 或持续失联时限频免扫码快登重建会话）
  const processBootAt = Date.now();
  const restartStampFile = path.join(STATE, 'watchdog-restarts.json');
  const nativeWatchdog = createNativeWatchdogState({ allowRestart: false, allowQuickLoginRestart: true });
  let nativeCheckInFlight = false;
  if (nativeWatchdogTimer) clearInterval(nativeWatchdogTimer);
  nativeWatchdogTimer = setInterval(async () => {
    if (finished || !authenticated || !onebot || nativeCheckInFlight) return;
    nativeCheckInFlight = true;
    try {
      const targetUid = /^\d{5,15}$/.test(String(BOT_UIN || state.uin || '')) ? Number(BOT_UIN || state.uin) : 0;
      const payload = targetUid > 0
        ? { action: 'get_stranger_info', params: { user_id: targetUid } }
        : { action: 'get_robot_uin_range', params: {} };
      const probe = await probeOneBotAction(child.port, onebotToken, payload, 12000);
      if (probe && probe.status === 'ok') {
        nativeWatchdog.recordSuccess(Date.now());
        state.lastHealthyAt = Date.now();
        state.lastMsfError = '';
        if (state.phase === 'degraded') {
          save(agentProc && agentProc.exitCode === null ? 'agent-running' : 'onebot-ready', {
            offlineReason: '', offlineMessage: '', needsManualLogin: false, msfStatus: 'online'
          });
        }
      } else {
        const now = Date.now();
        const ql = await probeQuickLoginAvailable();
        const recent = readRestartHistory(restartStampFile, now);
        const msfTicketInvalid = isMsfTicketInvalidError(state.lastMsfError);
        const decision = nativeWatchdog.recordFailure({
          phase: state.phase,
          uptimeMs: now - processBootAt,
          now,
          recentRestarts: recent,
          canQuickLogin: ql.available,
          offlineReason: state.offlineReason,
          msfTicketInvalid
        });
        log('NATIVE_WATCHDOG_FAIL count=' + nativeWatchdog.snapshot().consecutiveFails
          + ' decision=' + decision + ' canQuick=' + ql.available
          + ' msfInvalid=' + msfTicketInvalid
          + ' detail=' + String(probe?.error || probe?.retcode || 'unknown'));
        if (decision === 'wake') {
          try {
            const wakeInfo = await originalChat?.wakeSession?.();
            state.lastWakeAt = Date.now();
            log('NATIVE_WATCHDOG_WAKE ' + JSON.stringify(wakeInfo ?? { invoked: true }));
          } catch (e) {
            log('NATIVE_WATCHDOG_WAKE_ERR ' + (e?.message ?? e));
          }
        } else if (decision === 'quick_restart' || decision === 'restart') {
          try { recordRestartTimestamp(restartStampFile, now); } catch {}
          save('recovering', {
            needsManualLogin: false,
            offlineReason: msfTicketInvalid ? ('msf_ticket_invalid_' + state.lastMsfError) : 'native_probe_failed',
            offlineMessage: msfTicketInvalid
              ? '检测到 QQ 会话票据失效（' + state.lastMsfError + '），正在自动免扫码快登重建连接…'
              : 'QQ 原生通道持续无响应，正在自动免扫码快登重建连接…'
          });
          await checkpointLoginDb('watchdog-quick-restart');
          log('NATIVE_WATCHDOG_QUICK_RESTART triggering guarded quick-login recovery msfErr=' + String(state.lastMsfError || ''));
          dumpBlackbox('watchdog-' + decision + '-msf-' + String(state.lastMsfError || 'none'));
          process.exit(1);
        } else if (decision === 'notify_offline') {
          dumpBlackbox('watchdog-notify-offline-' + String(probe?.error || probe?.retcode || 'unknown'));
          // 不能快登、非票据失效网络半开或限频预算用尽：立即发高优告警（绝不盲目杀进程推进 140022015！）
          save('degraded', {
            needsManualLogin: true,
            offlineReason: msfTicketInvalid
              ? ('msf_ticket_invalid_' + state.lastMsfError)
              : (ql.available ? 'native_probe_failed' : 'session_expired_no_quick_login'),
            offlineMessage: msfTicketInvalid
              ? 'QQ 会话票据已失效（' + state.lastMsfError + '）且自动快登恢复受限，请点此重新上线'
              : (ql.available
                ? 'QQ 原生通道持续异常且本小时自动恢复已达上限，请检查网络或点此重连'
                : 'QQ 原生连接已断开且本机无可用快登票据，已暂停自动重启，请手动重新上线')
          });
        }
      }
    } catch (e) {
      log('NATIVE_WATCHDOG_ERR ' + (e?.message ?? e));
    } finally {
      nativeCheckInFlight = false;
    }
  }, 90_000);
  nativeWatchdogTimer.unref?.();

  // ② agent 控制台独立看门狗（每 60s 测 /api/chats）：只精准杀并重拉 agentProc，绝不断 QQ 原生会话。
  let consoleCheckInFlight = false;
  if (consoleWatchdogTimer) clearInterval(consoleWatchdogTimer);
  consoleWatchdogTimer = setInterval(async () => {
    if (!WITH_AGENT || finished || consoleCheckInFlight) return;
    if (!agentProc || agentProc.exitCode !== null || agentProc.signalCode !== null) return;
    consoleCheckInFlight = true;
    try {
      const cPort = agentConsolePort();
      const code = await probeHttpGet('127.0.0.1', cPort, '/api/chats', 5000);
      const now = Date.now();
      if (code === 200) {
        const res = consoleWatchdog.recordHealthy({ now, startedAt: lastAgentStartedAt });
        if (res.shouldResetAttempts && agentAttempts > 0) {
          log('AGENT_CONSOLE_HEALTHY reset agentAttempts ' + agentAttempts + ' -> 0');
          agentAttempts = 0;
        }
      } else {
        const res = consoleWatchdog.recordFailure({ now, startedAt: lastAgentStartedAt });
        if (!res.ignoredInGrace) {
          log('AGENT_CONSOLE_WATCHDOG_FAIL code=' + code + ' count=' + consoleWatchdog.snapshot().consecutiveFails);
        }
        if (res.restartAgentOnly && agentProc && agentProc.exitCode === null) {
          const deadPid = agentProc.pid;
          log('AGENT_CONSOLE_WATCHDOG_KILL pid=' + deadPid + ' (保留 QQ 原生会话不掉线)');
          try { process.kill(deadPid, 'SIGKILL'); } catch {}
        }
      }
    } catch (e) {
      log('AGENT_CONSOLE_WATCHDOG_ERR ' + (e?.message ?? e));
    } finally {
      consoleCheckInFlight = false;
    }
  }, 60_000);
  consoleWatchdogTimer.unref?.();
}

function probeHttpGet(host, port, reqPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({
      host, port, path: reqPath, method: 'GET', timeout: timeoutMs,
      headers: { Host: `${host}:${port}` }
    }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function probeOneBotAction(port, token, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request({
      host: '127.0.0.1', port, path: '/', method: 'POST', timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: 'Bearer ' + token
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ error: 'invalid-json', httpStatus: res.statusCode }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end(body);
  });
}

let agentAttempts = 0;
let lastAgentStartedAt = 0;
const consoleWatchdog = createAgentConsoleWatchdogState();
let agentInFlight = false;
let agentSpawning = false;
let agentAttachedToken = '';

function agentConsolePort() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/agent/data/config.json', 'utf8'));
    const p = Number(cfg?.server?.port);
    if (Number.isFinite(p) && p > 0) return p;
  } catch { /* default */ }
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
    } catch {}
    setTimeout(() => { void tick(); }, 2000).unref?.();
  };
  setTimeout(() => { void tick(); }, 2000).unref?.();
}

let biliWorkerProc = null;
let biliWorkerTries = 0;
function startBiliWorker() {
  if (biliWorkerProc || biliWorkerTries >= 5) return;
  const entry = '/input/agent-app/src/features/bili-behavior/worker.mjs';
  const dataDir = '/agent/data';
  if (!fs.existsSync(entry)) return;
  let endpoint = false;
  try { endpoint = fs.existsSync(path.join(dataDir, 'bili-protocol.json')); } catch { endpoint = false; }
  if (!endpoint) return;
  biliWorkerTries++;
  const out = fs.openSync(path.join(RUNTIME, 'bili-worker.log'), 'a', 0o600);
  biliWorkerProc = spawn(process.execPath, [entry, dataDir], {
    cwd: '/input/agent-app',
    stdio: ['ignore', out, out],
    env: { PATH: '/bin', HOME: '/agent/home', TMPDIR: '/agent/home/tmp', TZ: 'Asia/Shanghai',
      QQ_AGENT_DATA_DIR: dataDir },
  });
  log('BILI_WORKER_STARTED pid=' + biliWorkerProc.pid);
  biliWorkerProc.on('exit', (code, sig) => {
    log('BILI_WORKER_EXIT code=' + code + ' signal=' + sig);
    biliWorkerProc = null;
    if (!finished) setTimeout(() => { try { startBiliWorker(); } catch (e) { log('bili worker retry failed: ' + e.message); } }, 15000).unref?.();
  });
  biliWorkerProc.on('error', (e) => log('BILI_WORKER_ERROR ' + e.message));
}

async function startAgent(child) {
  const wantToken = (child && child.port && child.wsPort && onebotToken) ? String(onebotToken) : '';
  const procAlive = Boolean(agentProc && agentProc.exitCode === null && agentProc.signalCode === null);
  if (agentSpawning) {
    log('agent spawn already in progress, skip');
    return;
  }
  if (procAlive) {
    // 关键修复：若 Agent 之前在 qq-detached 态启动（或持旧 OneBot token），
    // 当 QQ 晚于 Agent 登录并生成新 OneBot token 时，必须平滑重启 Agent 注入新 token，避免永久 401 失联！
    if (wantToken && wantToken !== agentAttachedToken) {
      log('AGENT_REATTACH_ON_QQ_LOGIN switching token (prev=' + (agentAttachedToken ? 'stale' : 'detached') + ' -> attached)');
      const oldProc = agentProc;
      agentProc = null;
      agentInFlight = false;
      agentAttempts = 0;
      try { oldProc.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      try { if (oldProc.exitCode === null && oldProc.signalCode === null) oldProc.kill('SIGKILL'); } catch {}
    } else {
      log('agent already running with matching token, skip');
      return;
    }
  } else if (agentInFlight) {
    log('agent start already in flight, skip');
    return;
  }
  if (agentAttempts >= 6) { log('agent attempts exhausted'); return; }
  agentSpawning = true;
  agentInFlight = true;
  agentAttempts++;
  const appDir = '/input/agent-app';
  const entry = path.join(appDir, 'src/server.js');
  if (!fs.existsSync(entry)) { log('agent entry missing: ' + entry); save('agent-missing'); agentSpawning = false; agentInFlight = false; return; }

  const cfgFile = '/agent/data/config.json';
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const before = { mode: cfg.runtime?.mode, paused: cfg.runtime?.paused };
  const UPDATE_REPO = 'https://github.com/18477514055/whale-onebot.git';
  const prevRepo = cfg.autoUpdate?.repository;
  cfg.autoUpdate = { ...(cfg.autoUpdate ?? {}), repository: UPDATE_REPO,
    snowluma: { ...(cfg.autoUpdate?.snowluma ?? {}), enabled: false } };
  if (prevRepo && prevRepo !== UPDATE_REPO) log('autoUpdate 仓库已改回本项目（原值 ' + prevRepo + '，原则 P6：不跟随上游）');
  const existingCatchup = Number(cfg.onebot?.catchupReplyWindowMs);
  if (child && child.port && child.wsPort) {
    cfg.onebot = { ...(cfg.onebot ?? {}), wsUrl: 'ws://127.0.0.1:' + child.wsPort,
      httpUrl: 'http://127.0.0.1:' + child.port, accessToken: '', httpAccessToken: '',
      catchupReplyWindowMs: Number.isFinite(existingCatchup) && existingCatchup >= 0 ? existingCatchup : 1800000 };
  }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  log('agent config patched onebot=' + (child ? (child.port + '/' + child.wsPort) : 'detached') + ' runtime=' + JSON.stringify(before));
  try {
    const victims = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (pid === process.pid || pid === process.ppid) continue;
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch { continue; }
      if (!cmd.includes('--whale-binding-worker') && cmd.includes('agent-app/src/server.js')) { try { process.kill(pid, 'SIGKILL'); victims.push(pid); } catch {} }
    }
    if (victims.length) log('killed residual agents: ' + victims.join(','));
    await new Promise(r => setTimeout(r, 1200));
    fs.rmSync('/agent/data/.server.lock', { force: true });
  } catch (e) { log('agent cleanup failed: ' + e.message); }

  fs.mkdirSync('/agent/home/tmp', { recursive: true });
  const out = fs.openSync(path.join(RUNTIME, 'agent-stdout.log'), 'a', 0o600);
  const err = fs.openSync(path.join(RUNTIME, 'agent-stderr.log'), 'a', 0o600);
  const cfgTextTimeout = Number(cfg.onebot?.textTimeoutMs);
  const textTimeoutMs = Number.isSafeInteger(cfgTextTimeout) && cfgTextTimeout >= 1000 && cfgTextTimeout <= 600000
    ? cfgTextTimeout : 120000;
  const agentEnv = {
    PATH: '/bin', HOME: '/agent/home', TMPDIR: '/agent/home/tmp', TZ: 'Asia/Shanghai',
    QQ_AGENT_DATA_DIR: '/agent/data',
    WHALE_ONEBOT_TEXT_TIMEOUT_MS: String(textTimeoutMs),
  };
  if (child && child.port && child.wsPort && onebotToken) {
    agentEnv.WHALE_ONEBOT_TOKEN = onebotToken;
    agentEnv.WHALE_ONEBOT_WS_URL = 'ws://127.0.0.1:' + child.wsPort;
    agentEnv.WHALE_ONEBOT_HTTP_URL = 'http://127.0.0.1:' + child.port;
  }
  agentAttachedToken = wantToken;
  const proc = spawn(process.execPath, [entry], {
    cwd: appDir,
    stdio: ['ignore', out, err],
    env: agentEnv,
  });
  log('agent textTimeoutMs=' + textTimeoutMs + ' mode=' + (child ? 'qq-attached' : 'qq-detached'));
  agentProc = proc;
  agentSpawning = false;
  proc.on('exit', (code, sig) => {
    log('AGENT_EXIT code=' + code + ' signal=' + sig);
    // 只有当前仍是该进程句柄时才触发自动重拉（避免被 reattach 替换掉的旧进程重复触发）
    if (agentProc !== proc) return;
    agentProc = null;
    agentInFlight = false;
    agentAttachedToken = '';
    // 无论 QQ 是否在线，Agent 本体都保持独立常驻（解耦）
    if (!finished) {
      const liveChild = (authenticated && onebot) ? { port: onebot.address.port, wsPort: onebot.wsAddress.port } : null;
      setTimeout(() => { void startAgent(liveChild).catch(e => log('agent retry failed: ' + e.message)); }, 5000).unref();
    }
  });
  proc.on('error', e => log('AGENT_ERROR ' + e.message));
  if (child) save('agent-started', { agent: { pid: proc.pid } });
  else state.agent = { pid: proc.pid };
  const agentStartedAt = Date.now();
  lastAgentStartedAt = agentStartedAt;
  consoleWatchdog.resetForNewProcess();
  log('AGENT_STARTED pid=' + proc.pid);
  consoleReadyProbe(agentConsolePort(), agentStartedAt);
}
