// 容器内双看门狗策略纯状态机与 HTTP 探测辅助（零外部依赖，随 APK 同步到 /opt/whale/）：
// 1. 协议端原生通道真实联网探活状态机（Level 1 进程内唤醒 / Level 2 限频安全退出）
// 2. agent 控制台独立看门狗状态机（只重启假死的 agentProc，保住 QQ 登录态与 OneBot 进程）
import fs from 'node:fs';
import path from 'node:path';

export function createNativeWatchdogState({
  wakeAfterFails = 2,
  restartAfterFails = 4,
  restartCooldownMs = 10 * 60_000,
  minUptimeBeforeRestartMs = 3 * 60_000,
  maxRestartsPerHour = 3
} = {}) {
  let consecutiveFails = 0;
  let wakeAttempted = false;
  let lastHealthyAt = 0;

  return {
    snapshot() {
      return { consecutiveFails, wakeAttempted, lastHealthyAt };
    },
    recordSuccess(now = Date.now()) {
      consecutiveFails = 0;
      wakeAttempted = false;
      lastHealthyAt = now;
    },
    recordFailure({ phase = '', uptimeMs = 0, now = Date.now(), recentRestarts = [] } = {}) {
      consecutiveFails += 1;
      if (consecutiveFails >= wakeAfterFails && !wakeAttempted) {
        wakeAttempted = true;
        return 'wake';
      }
      if (consecutiveFails >= restartAfterFails && wakeAttempted) {
        // qr-ready 等需要人工扫码的状态严禁自杀重启，防止 140022015 循环刷码。
        if (phase === 'qr-ready' || phase === 'qr-polling' || phase === 'scanned') return 'none';
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

function cleanUin(value, placeholders) {
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
  let botUin =
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

