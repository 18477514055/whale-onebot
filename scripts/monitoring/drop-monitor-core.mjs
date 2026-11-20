// Passive observation only. No QQ/App modules or control clients are imported.
export const OBSERVATIONS = Object.freeze([
  'onLoginConnecting', 'onLoginConnected', 'onLoginDisConnected', 'onQRCodeLoginSucceed',
  'onLoginFailed', 'onLogoutSucceed', 'onUserLoggedIn', 'onLoginState',
  'onRegisterProxyOnlineResp', 'onUserOnlineResult', 'onMSFStatusChange', 'onMSFSsoError',
  'onNTSessionCreate', 'onGProSessionCreate', 'onGetSelfTinyId', 'onOpentelemetryInit',
  'onSessionInitComplete', 'onSelfStatusChanged', 'dispatchRequest', 'dispatchCall', 'dispatchCallWithJson',
]);
export const NATIVE_COUNTS = Object.freeze([
  'receiveCallbacks', 'updateCallbacks', 'projectedMessages', 'projectionFailures', 'rejectedBatches',
  'translatedEvents', 'publishedEvents', 'droppedEvents', 'unknownActions', 'bufferedEvents',
  'listenerOwners', 'uncertainRegistrations', 'nativeMalformedEvents', 'nativeDroppedEvents',
]);
const PHASES = new Set([
  'loading', 'registering-misc', 'creating-engine', 'initializing-engine', 'initializing-login',
  'connecting', 'requesting-qr', 'waiting-qr', 'authenticated-initialization-authorized',
  'initializing-session', 'starting-session', 'waiting-session-ready', 'session-ready-observed',
  'login-disconnected', 'login-failed', 'logged-out', 'login-account-limit', 'signal-termination',
  'closed', 'native-or-driver-exception', 'native-or-driver-rejection', 'manual-session-hold-expired',
  'session-init-timeout', 'connection-timeout', 'qr-wait-timeout', 'unexpected-login-identity',
  'changed-login-identity', 'authentication-event-too-old-for-init', 'invalid-native-session-id',
]);
const TERMINAL = new Set([
  'login-disconnected', 'login-failed', 'logged-out', 'login-account-limit', 'signal-termination',
  'closed', 'native-or-driver-exception', 'native-or-driver-rejection', 'manual-session-hold-expired',
  'session-init-timeout', 'connection-timeout', 'qr-wait-timeout', 'unexpected-login-identity',
  'changed-login-identity', 'authentication-event-too-old-for-init', 'invalid-native-session-id',
]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
export const safePhase = phase => PHASES.has(phase) ? phase : 'unknown';

export function parseProcStat(text) {
  // comm can contain spaces/parentheses; field 22 is starttime, not PID alone.
  const close = text.lastIndexOf(')');
  if (close < 0 || !/^\d+ \(/.test(text)) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '') || !fields[0]) return null;
  return { starttime: fields[19], running: !['Z', 'X', 'x'].includes(fields[0]) };
}

export function exactParentCommand(argv, cwd, root, resolvePath) {
  if (!Array.isArray(argv) || argv.length !== 5 || cwd !== root) return false;
  return resolvePath(cwd, argv[0]) === resolvePath(root, '.tools/node-v24.20.0-linux-x64/bin/node') &&
    resolvePath(cwd, argv[1]) === resolvePath(root, 'scripts/integrated-preflight-linux.mjs') &&
    argv.slice(2).join('\0') === ['--login', '--original-agent', '--split-onebot-ports'].join('\0');
}

export function identityContinuity(binding, current, lockMatches) {
  return Boolean(binding && current?.exists && current.running && current.commandMatches &&
    lockMatches && current.starttime === binding.starttime);
}

function progress(now, previous, keys) {
  if (!previous) return 'unknown';
  let advanced = false, comparable = false;
  for (const key of keys) {
    if (now[key] === null || previous[key] === null || previous[key] === undefined) continue;
    comparable = true;
    if (now[key] < previous[key]) return 'reset';
    if (now[key] > previous[key]) advanced = true;
  }
  return advanced ? 'advanced' : comparable ? 'unchanged' : 'unknown';
}

// Pure projection: never serialize an input object, arbitrary key, exception or reason string.
export function classifySample({ status, health, process: proc, identityContinuous,
  parentResult, previous, stopped = false, bindingRejected = false, now = Date.now() }) {
  const phase = safePhase(status?.phase);
  const terminalPhase = TERMINAL.has(phase);
  const current = identityContinuous === true && proc?.exists === true && !terminalPhase;
  const healthReachable = current && health?.reachable === true;
  const native = Object.fromEntries(NATIVE_COUNTS.map(key => [key, count(status?.liveAgent?.receiveDiagnostics?.[key])]));
  const observations = Object.fromEntries(OBSERVATIONS.map(key => [key, count(status?.observations?.[key]?.count)]));
  let terminalCode = 'OBSERVING';
  if (!status) terminalCode = 'STATUS_UNAVAILABLE';
  if (terminalPhase) terminalCode = phase === 'login-disconnected'
    ? 'LOGIN_DISCONNECTED_REASON_UNKNOWN' : 'DRIVER_TERMINAL_REASON_UNKNOWN';
  if (!identityContinuous) terminalCode = proc?.exists ? 'PROCESS_IDENTITY_LOST' : 'PARENT_EXIT_REASON_UNKNOWN';
  if (parentResult) terminalCode = 'PARENT_RESULT_REASON_UNKNOWN';
  if (bindingRejected) terminalCode = 'BINDING_REJECTED';
  if (stopped) terminalCode = 'MONITOR_STOPPED';
  return {
    at: new Date(now).toISOString(), phase, generation: count(status?.sessionGeneration),
    identitybool: current ? bool(status?.identityMatches) : null,
    process: { exists: proc?.exists === true, identityContinuous: identityContinuous === true },
    Appready: healthReachable && health?.ok === true && ['ready-original-rules', 'ready-for-human-chat'].includes(status?.liveAgent?.stage),
    health: { reachable: healthReachable, ok: healthReachable ? bool(health?.ok) : null },
    onebotConnected: healthReachable ? bool(health?.onebotConnected) : null,
    native, observations, writeOutcomeUnknown: bool(status?.liveAgent?.writeOutcomeUnknown),
    nativeProgress: progress(native, previous?.native, NATIVE_COUNTS),
    observationProgress: progress(observations, previous?.observations, OBSERVATIONS),
    platformOnline: 'unknown', tencentKick: 'unknown',
    parentResult: { present: Boolean(parentResult), phase: safePhase(parentResult?.observed?.phase),
      exitCode: count(parentResult?.observed?.status) },
    terminalCode,
  };
}

// Explicit persistence projection also protects callers of the logger API.
export function serializeSample(sample) {
  const terminalCodes = ['OBSERVING', 'STATUS_UNAVAILABLE', 'LOGIN_DISCONNECTED_REASON_UNKNOWN',
    'DRIVER_TERMINAL_REASON_UNKNOWN', 'PROCESS_IDENTITY_LOST', 'PARENT_EXIT_REASON_UNKNOWN',
    'PARENT_RESULT_REASON_UNKNOWN', 'BINDING_REJECTED', 'MONITOR_STOPPED'];
  const progressValue = value => ['unknown', 'advanced', 'unchanged', 'reset'].includes(value) ? value : 'unknown';
  const at = typeof sample?.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(sample.at)
    ? sample.at : '1970-01-01T00:00:00.000Z';
  return JSON.stringify({ at, phase: safePhase(sample?.phase), generation: count(sample?.generation),
    identitybool: bool(sample?.identitybool),
    process: { exists: sample?.process?.exists === true, identityContinuous: sample?.process?.identityContinuous === true },
    Appready: sample?.Appready === true,
    health: { reachable: sample?.health?.reachable === true, ok: bool(sample?.health?.ok) },
    onebotConnected: bool(sample?.onebotConnected),
    native: Object.fromEntries(NATIVE_COUNTS.map(key => [key, count(sample?.native?.[key])])),
    observations: Object.fromEntries(OBSERVATIONS.map(key => [key, count(sample?.observations?.[key])])),
    nativeProgress: progressValue(sample?.nativeProgress), observationProgress: progressValue(sample?.observationProgress),
    platformOnline: 'unknown', tencentKick: 'unknown', writeOutcomeUnknown: bool(sample?.writeOutcomeUnknown),
    parentResult: { present: sample?.parentResult?.present === true, phase: safePhase(sample?.parentResult?.phase),
      exitCode: count(sample?.parentResult?.exitCode) },
    terminalCode: terminalCodes.includes(sample?.terminalCode) ? sample.terminalCode : 'STATUS_UNAVAILABLE',
  }) + '\n';
}

export function shouldEmit(previous, next, lastEmissionMs, nowMs) {
  if (!previous || nowMs - lastEmissionMs >= 60000) return true;
  // Counter advances stay in memory until heartbeat; no message-by-message log.
  return JSON.stringify([previous.phase, previous.generation, previous.identitybool, previous.process,
    previous.Appready, previous.health, previous.onebotConnected, previous.terminalCode, previous.parentResult, previous.writeOutcomeUnknown]) !==
    JSON.stringify([next.phase, next.generation, next.identitybool, next.process,
      next.Appready, next.health, next.onebotConnected, next.terminalCode, next.parentResult, next.writeOutcomeUnknown]);
}
