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
