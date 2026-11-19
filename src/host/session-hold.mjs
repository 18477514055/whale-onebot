const hourMs = 60 * 60 * 1000;
export const defaultSessionHoldMs = 24 * hourMs;
export const sessionStartupLimitMs = 5 * 60 * 1000;
const sessionShutdownGraceMs = 15000;

// Called once when the parent first observes completed initialization.
export function sessionWatchdogDelay(state, holdMs) {
  if (state?.phase !== 'session-ready-observed' || state.identityMatches !== true ||
      state.initCallbackAccepted !== true || state.sessionGeneration !== 1 ||
      state.calibrationHoldLimitMs !== holdMs) return null;
  if (!Number.isSafeInteger(holdMs) || holdMs < hourMs || holdMs > 168 * hourMs)
    throw new TypeError('Invalid session hold duration');
  return holdMs + sessionShutdownGraceMs;
}

export function sessionHoldStatus(deadlineMs, nowMs) {
  if (deadlineMs === undefined) return { state: 'not-started', remainingMs: null };
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs) || nowMs < 0)
    throw new TypeError('Invalid monotonic session hold time');
  const remainingMs = Math.max(0, Math.floor(deadlineMs - nowMs));
  return { state: nowMs >= deadlineMs ? 'expired' : 'active', remainingMs };
}

// A matching native session identifies continuity only. It cannot establish
// current reachability or whether business actions can complete.
export function observeHeldSession(hold, expectedId, readSessionId) {
  if (hold.state !== 'active' || typeof expectedId !== 'string' || !expectedId)
    return { checked: false, matchesAuthenticatedSession: null };
  try {
    const observedId = readSessionId();
    return { checked: true, matchesAuthenticatedSession: typeof observedId === 'string' && observedId.length > 0
      ? observedId === expectedId : null };
  } catch {
    return { checked: true, matchesAuthenticatedSession: null };
  }
}

export function parseSessionHold(mode, options) {
  if (options.length === 0) return defaultSessionHoldMs;
  if (mode !== '--login' || options.length !== 2 || options[0] !== '--hold-hours' ||
      !/^[1-9][0-9]{0,2}$/.test(options[1]) || Number(options[1]) > 168)
    throw new TypeError('Use --login --hold-hours <1–168>');
  return Number(options[1]) * hourMs;
}
