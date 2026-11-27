// [layer: shell-android] 容器内统一登录/重连/双看门狗纯状态机与安全辅助（零外部依赖，随 APK 同步到 /opt/whale/）：
// 1. 协议端原生通道零误杀看门狗（绝不盲目杀进程把在线会话踢进扫码态：先核验快登可用性）
// 2. agent 控制台独立看门狗（只精准重启假死的 agentProc，保住 QQ 登录态与 OneBot 进程）
// 3. 登录失败分类、安全 verifyUrl 提取、稳定 machineId 派生、脱敏占位符免疫与禁登主号防线
import fs from 'node:fs';
import path from 'node:path';

/** 不允许看门狗自动重启的交互/离线阶段（防 140022015 / 1006501 循环重启与刷码）。 */
const NON_RESTARTABLE_PHASES = new Set([
  'waiting-manual-login',
  'qr-ready',
  'qr-polling',
  'scanned',
  'pwd-logging-in',
  'verify-required',
  'kicked-offline',
  'token-expired',
  'stopping',
  'stopped'
]);

const BLOCK_RESTART_REASONS = new Set([
  'kicked_1006501',
  'token_expired_140022015',
  'manual_logout',
  'switch_account',
  'verify_required'
]);

export function isInteractiveOrOfflinePhase(phase) {
  return NON_RESTARTABLE_PHASES.has(String(phase || '').trim());
}

/**
 * 原生通道零误杀看门狗状态机（2026-11-27 问答报告 Q3）：
 * - 连续 fail 2 次 → 返回 'wake'（进程内温和唤醒，不重登）；
 * - 连续 fail 4 次：
 *   - 处于人工待机/扫码/被踢/过期态 → 返回 'none'；
 *   - 默认策略（绝不盲目重启）：若 allowRestart !== true 或 canQuickLogin !== true 或命中被踢/过期原因，
 *     严禁杀进程，返回 'notify_offline'（由宿主进入离线告警与人工介入态，绝不把会话踢进刷码态）；
 *   - 仅当 allowRestart === true && canQuickLogin === true 且通过冷静期/冷却/每小时限频时，才放行 'restart'。
 */
export function createNativeWatchdogState({
  wakeAfterFails = 2,
  restartAfterFails = 4,
  restartCooldownMs = 10 * 60_000,
  minUptimeBeforeRestartMs = 3 * 60_000,
  maxRestartsPerHour = 3,
  allowRestart = false
} = {}) {
  let consecutiveFails = 0;
  let wakeAttempted = false;
  let offlineNotified = false;
  let lastHealthyAt = 0;

  return {
    snapshot() {
      return { consecutiveFails, wakeAttempted, offlineNotified, lastHealthyAt };
    },
    recordSuccess(now = Date.now()) {
      consecutiveFails = 0;
      wakeAttempted = false;
      offlineNotified = false;
      lastHealthyAt = now;
    },
    recordFailure({
      phase = '',
      uptimeMs = 0,
      now = Date.now(),
      recentRestarts = [],
      canQuickLogin = false,
      offlineReason = ''
    } = {}) {
      consecutiveFails += 1;
      if (isInteractiveOrOfflinePhase(phase)) {
        return 'none';
      }
      if (consecutiveFails >= wakeAfterFails && !wakeAttempted) {
        wakeAttempted = true;
        return 'wake';
      }
      if (consecutiveFails >= restartAfterFails && wakeAttempted) {
        if (BLOCK_RESTART_REASONS.has(String(offlineReason || '').trim())) {
          if (!offlineNotified) {
            offlineNotified = true;
            return 'notify_offline';
          }
          return 'none';
        }
        // 核心防反噬防线：未显式允许重启或不能免扫码快登时，绝不杀进程，改发离线告警并保持温和周期唤醒
        if (!allowRestart || canQuickLogin !== true) {
          if (!offlineNotified) {
            offlineNotified = true;
            return 'notify_offline';
          }
          // 之后每隔 3 次失败温和再试一次进程内唤醒，绝不自杀
          if ((consecutiveFails - restartAfterFails) % 3 === 0) return 'wake';
          return 'none';
        }
        if (uptimeMs < minUptimeBeforeRestartMs) return 'none';
        const recentWindow = (Array.isArray(recentRestarts) ? recentRestarts : [])
          .filter((t) => Number.isFinite(t) && t > 0 && now - t < 3600_000);
        const lastRestartAt = recentWindow.length ? Math.max(...recentWindow) : 0;
        if (lastRestartAt && now - lastRestartAt < restartCooldownMs) return 'none';
        if (recentWindow.length >= maxRestartsPerHour) return 'none';
        return 'restart';
      }
      return 'none';
    }
  };
}

/**
 * 分类 QQ 原生登录/断连错误码，映射为统一可读中文原因与状态阶段。
 */
export function classifyLoginError(result, errMsg = '', verifyUrl = '') {
  const codeStr = String(result ?? '').trim();
  const msgStr = String(errMsg ?? '').trim();
  const safeVerify = sanitizeVerifyUrl(verifyUrl);
  if (safeVerify) {
    return {
      code: 'verify_required',
      phase: 'verify-required',
      message: msgStr || '腾讯安全中心要求完成滑块或新设备验证',
      verifyUrl: safeVerify,
      needsManualLogin: true,
      blockAutoRestart: true
    };
  }
  if (codeStr === '140022015' || /140022015|过期|失效|expired|invalid.*token/i.test(msgStr)) {
    return {
      code: 'token_expired_140022015',
      phase: 'token-expired',
      message: 'QQ 快登令牌已过期（140022015），请手动通过一键拉起 QQ、扫码或账密重新上线',
      verifyUrl: '',
      needsManualLogin: true,
      blockAutoRestart: true
    };
  }
  if (codeStr === '1006501' || /1006501|风控|外挂|安全中心|踢|kicked|风险|被迫下线/i.test(msgStr)) {
    return {
      code: 'kicked_1006501',
      phase: 'kicked-offline',
      message: msgStr || '账号被 QQ 安全中心或异地登录踢下线（1006501），请核查网络环境后手动重登',
      verifyUrl: '',
      needsManualLogin: true,
      blockAutoRestart: true
    };
  }
  if (codeStr === '1006514' || /1006514|网络|timeout|disconnect|连接异常/i.test(msgStr)) {
    return {
      code: 'net_err_1006514',
      phase: 'degraded',
      message: msgStr || 'QQ 原生网络连接异常（1006514），等待网络恢复后温和重连',
      verifyUrl: '',
      needsManualLogin: false,
      blockAutoRestart: false
    };
  }
  if (/密码错误|password.*invalid|incorrect/i.test(msgStr)) {
    return {
      code: codeStr ? ('qq_err_' + codeStr) : 'password_invalid',
      phase: 'waiting-manual-login',
      message: msgStr || '账号或密码不正确，请核对后重试',
      verifyUrl: '',
      needsManualLogin: true,
      blockAutoRestart: true
    };
  }
  if (codeStr === '140022008') {
    return {
      code: 'qq_err_140022008',
      phase: 'waiting-manual-login',
      message: msgStr
        ? ('账密登录被拒（140022008）：' + msgStr)
        : '账密登录被腾讯拒绝（140022008，可能是密码不符或该号/环境被腾讯限制仅允许扫码登录），建议改用一键拉起 QQ 或扫码',
      verifyUrl: '',
      needsManualLogin: true,
      blockAutoRestart: true
    };
  }
  return {
    code: codeStr ? ('qq_err_' + codeStr) : 'login_failed',
    phase: 'waiting-manual-login',
    message: msgStr || (codeStr ? ('QQ 登录未通过（错误码 ' + codeStr + '），请手动重新登录') : 'QQ 登录未通过，请手动重新登录'),
    verifyUrl: '',
    needsManualLogin: true,
    blockAutoRestart: true
  };
}

/** 仅放行腾讯官方 HTTPS 验证页域名，防止将非法链接推送给 WebView。 */
export function sanitizeVerifyUrl(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.length > 2048) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return '';
    const h = u.hostname.toLowerCase();
    const ok = h === 'qq.com' || h.endsWith('.qq.com')
      || h === 'tencent.com' || h.endsWith('.tencent.com')
      || h === 'gtimg.com' || h.endsWith('.gtimg.com')
      || h === 'gtimg.cn' || h.endsWith('.gtimg.cn');
    return ok ? s : '';
  } catch {
    return '';
  }
}

/** 仅放行腾讯官方一次性登录授权链接（如 https://txz.qq.com/p?k=...）。 */
export function sanitizeQrUrl(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.length > 512) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return '';
    const h = u.hostname.toLowerCase();
    if (h === 'txz.qq.com' || h.endsWith('.qq.com')) return s;
    return '';
  } catch {
    return '';
  }
}

/** 从设备伪造目录读取稳定 32 位十六进制 machineId，保证跨重启一致。 */
export function readStableMachineId(deviceDir = '/opt/whale/device') {
  for (const p of [path.join(deviceDir, 'machine-id'), '/etc/machine-id']) {
    try {
      const s = fs.readFileSync(p, 'utf8').trim().toLowerCase();
      if (/^[0-9a-f]{16,64}$/.test(s)) return s.slice(0, 32);
    } catch { /* try next */ }
  }
  return '';
}

export function createAgentConsoleWatchdogState({
  graceAfterStartMs = 120_000,
  failThreshold = 3,
  healthyResetAttemptsAfterMs = 10 * 60_000
} = {}) {
  let consecutiveFails = 0;
  let seenHealthy = false;
  let attemptsResetDone = false;

  return {
    resetForNewProcess() {
      consecutiveFails = 0;
      seenHealthy = false;
      attemptsResetDone = false;
    },
    snapshot() {
      return { consecutiveFails, seenHealthy, attemptsResetDone };
    },
    recordHealthy({ now = Date.now(), startedAt = 0 } = {}) {
      consecutiveFails = 0;
      seenHealthy = true;
      const elapsed = startedAt > 0 ? now - startedAt : 0;
      if (!attemptsResetDone && elapsed >= healthyResetAttemptsAfterMs) {
        attemptsResetDone = true;
        return { shouldResetAttempts: true };
      }
      return { shouldResetAttempts: false };
    },
    recordFailure({ now = Date.now(), startedAt = 0 } = {}) {
      const elapsed = startedAt > 0 ? now - startedAt : 0;
      if (!seenHealthy && elapsed < graceAfterStartMs) {
        return { restartAgentOnly: false, ignoredInGrace: true };
      }
      consecutiveFails += 1;
      if (consecutiveFails >= failThreshold) {
        consecutiveFails = 0;
        seenHealthy = false;
        return { restartAgentOnly: true, ignoredInGrace: false };
      }
      return { restartAgentOnly: false, ignoredInGrace: false };
    }
  };
}

export function readRestartHistory(stampFile, now = Date.now()) {
  try {
    const raw = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.map(Number).filter((t) => Number.isFinite(t) && t > 0 && now - t < 3600_000);
  } catch {
    return [];
  }
}

export function recordRestartTimestamp(stampFile, now = Date.now()) {
  const next = [...readRestartHistory(stampFile, now), now];
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(stampFile, JSON.stringify(next) + '\n', 'utf8');
  return next;
}

const PLACEHOLDER_BOT_UINS = new Set(['', '10000']);
const PLACEHOLDER_OWNER_UINS = new Set(['', '10001']);
const PLACEHOLDER_BOT_UIDS = new Set(['', 'u_placeholder']);
const UIN_RE = /^[1-9]\d{4,15}$/;

export function cleanUin(value, placeholders = PLACEHOLDER_BOT_UINS) {
  const s = String(value ?? '').trim();
  if (!UIN_RE.test(s) || placeholders.has(s)) return '';
  return s;
}

function cleanUid(value) {
  const s = String(value ?? '').trim();
  if (!s || PLACEHOLDER_BOT_UIDS.has(s)) return '';
  return s;
}

function readAccountFileLiterals(accountFile) {
  const out = { botUin: '', ownerUin: '', botUid: '' };
  if (!accountFile) return out;
  try {
    const src = fs.readFileSync(accountFile, 'utf8');
    const matchConst = (name) => {
      const m = new RegExp(`export\\s+const\\s+${name}\\s*=[^;\\n]*['"]([^'"]+)['"]`).exec(src);
      return m ? m[1].trim() : '';
    };
    out.botUin = cleanUin(matchConst('BOT_UIN'), PLACEHOLDER_BOT_UINS);
    out.ownerUin = cleanUin(matchConst('OWNER_UIN'), PLACEHOLDER_OWNER_UINS);
    out.botUid = cleanUid(matchConst('BOT_UID'));
  } catch { /* ignore */ }
  return out;
}

/**
 * 解析容器运行时真实机器人/主人身份，绝不把仓库脱敏占位符（10000/10001/u_placeholder）当作有效账号，
 * 也不提前 import src/config/account.mjs（避免冻结 ESM 缓存）。
 */
export function resolveContainerAccount({
  env = process.env,
  stateDir = '/opt/whale/qq-state',
  agentConfigFile = '/agent/data/config.json',
  accountFile = '/qq-onebot/src/config/account.mjs'
} = {}) {
  const fileLiterals = readAccountFileLiterals(accountFile);

  let identity = null;
  try {
    identity = JSON.parse(fs.readFileSync(path.join(stateDir, 'identity.json'), 'utf8'));
  } catch { identity = null; }

  let agentCfg = null;
  try {
    agentCfg = JSON.parse(fs.readFileSync(agentConfigFile, 'utf8'));
  } catch { agentCfg = null; }

  const ownerUin =
    cleanUin(env?.QQ_OWNER_UIN, PLACEHOLDER_OWNER_UINS)
    || fileLiterals.ownerUin
    || cleanUin(agentCfg?.admin?.ownerUin, PLACEHOLDER_OWNER_UINS);

  const identityUin = cleanUin(identity?.uin, PLACEHOLDER_BOT_UINS);
  const botUin =
    cleanUin(env?.QQ_BOT_UIN, PLACEHOLDER_BOT_UINS)
    || fileLiterals.botUin
    || (identityUin && identityUin !== ownerUin ? identityUin : '');

  const botUid =
    cleanUid(env?.QQ_BOT_UID)
    || fileLiterals.botUid
    || cleanUid(identity?.uid);

  return { botUin, ownerUin, botUid };
}

export function applyResolvedAccountToEnv({ botUin = '', ownerUin = '', botUid = '' } = {}, env = process.env) {
  if (!env) return;
  if (cleanUin(botUin, PLACEHOLDER_BOT_UINS)) env.QQ_BOT_UIN = String(botUin).trim();
  if (cleanUin(ownerUin, PLACEHOLDER_OWNER_UINS)) env.QQ_OWNER_UIN = String(ownerUin).trim();
  if (cleanUid(botUid)) env.QQ_BOT_UID = String(botUid).trim();
}

export function pickQuickLoginEntry(entries, botUin = '', ownerUin = '') {
  const arr = Array.isArray(entries) ? entries.filter((x) => x && x.isQuickLogin === true && cleanUin(x.uin, PLACEHOLDER_BOT_UINS)) : [];
  if (botUin) return arr.find((x) => String(x.uin).trim() === botUin) || null;
  const nonOwner = arr.filter((x) => !ownerUin || String(x.uin).trim() !== ownerUin);
  return nonOwner.length === 1 ? nonOwner[0] : null;
}

export function isAcceptableLoginIdentity(value, { expectedBotUin = '', ownerUin = '' } = {}) {
  const uin = cleanUin(value?.uin, PLACEHOLDER_BOT_UINS);
  const uid = typeof value?.uid === 'string' ? value.uid.trim() : '';
  if (!uin || !uid) return { ok: false, reason: 'unexpected-login-identity' };
  if (ownerUin && uin === ownerUin) return { ok: false, reason: 'unexpected-owner-identity' };
  if (expectedBotUin && uin !== expectedBotUin) return { ok: false, reason: 'unexpected-login-identity' };
  return { ok: true, uin, uid };
}
