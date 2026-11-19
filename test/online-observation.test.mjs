import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { defaultSessionHoldMs, observeHeldSession, parseSessionHold, sessionHoldStatus, sessionStartupLimitMs,
  sessionWatchdogDelay } from '../src/host/session-hold.mjs';

test('session hold uses the monotonic deadline independently of transport state', () => {
  assert.deepEqual(sessionHoldStatus(undefined, 100), { state: 'not-started', remainingMs: null });
  const duration = parseSessionHold('--login', ['--hold-hours', '72']);
  assert.equal(duration, 3 * defaultSessionHoldMs);
  const start = 1200;
  const deadline = start + duration;
  assert.deepEqual(sessionHoldStatus(deadline, start), { state: 'active', remainingMs: duration });
  assert.deepEqual(sessionHoldStatus(deadline, deadline - 0.5), { state: 'active', remainingMs: 0 });
  assert.deepEqual(sessionHoldStatus(deadline, deadline), { state: 'expired', remainingMs: 0 });
  assert.deepEqual(sessionHoldStatus(deadline, deadline + 5), { state: 'expired', remainingMs: 0 });
  assert.throws(() => parseSessionHold('--prepare-login', ['--hold-hours', '72']), TypeError);
});

test('held session diagnostics compare native IDs without exporting them or probing an inactive hold', () => {
  const expected = 'opaque-session';
  const active = { state: 'active', remainingMs: 100 };
  for (const state of ['not-started', 'expired', 'ended']) {
    assert.deepEqual(observeHeldSession({ state }, expected, () => assert.fail('Must not read native session')),
      { checked: false, matchesAuthenticatedSession: null });
  }
  for (const [value, matchesAuthenticatedSession] of [[expected, true], ['different-session', false], ['', null], [7, null]]) {
    assert.deepEqual(observeHeldSession(active, expected, () => value), { checked: true, matchesAuthenticatedSession });
  }
  assert.deepEqual(observeHeldSession(active, expected, () => { throw new Error('private detail'); }),
    { checked: true, matchesAuthenticatedSession: null });
});
import { OnlineObservation, classifyIntegratedHostExit, summarizeLiveRoundtripEvidence, summarizeRoundtripReachability,
  summarizeRoundtripResult } from '../src/host/online-observation.mjs';
import { compareOnlineWindows, compareOnlineWindowSeries } from '../src/host/compare-online-windows.mjs';

const hasEvidence = name => fs.existsSync(new URL('../evidence/' + name, import.meta.url));

test('live scope keeps historical HTTP evidence distinct from a complete three-path roundtrip', { skip: !hasEvidence('integrated-linux-readback-passed.json') && 'evidence/ 不在仓库里' }, () => {
  const report = JSON.parse(fs.readFileSync(new URL('../evidence/integrated-linux-readback-passed.json', import.meta.url)));
  const historical = summarizeLiveRoundtripEvidence(report);
  assert.deepEqual(historical.transportCoverage.http.businessActions, ['get_group_info', 'get_msg', 'send_group_msg']);
  assert.deepEqual(historical.transportCoverage.forwardWebSocket.businessActions, []);
  assert.deepEqual(historical.transportCoverage.reverseWebSocket.businessActions, []);
  assert.equal(historical.threePathRoundtripVerified, false);
  assert.equal(historical.postRoundtripSessionVerified, false);
  const fixture = structuredClone(report);
  Object.assign(fixture.roundtripResult, { reverseConnected: true, reverseEventVerified: true,
    forwardMessageReadbackVerified: true, reverseMessageReadbackVerified: true, reverseOfflineVerified: true,
    terminalMessageIdVerified: true });
  fixture.postRoundtripStatus.data.reverseWebSocket = { ...fixture.postRoundtripStatus.data.webSocket, connected: true, pongVerified: true };
  Object.assign(fixture.postRoundtripStatus, { roundtripSeq: fixture.roundtripResult.seq, sessionGeneration: fixture.sessionGeneration });
  fixture.postRoundtripStatus.data.sessionHold = { state: 'active' };
  fixture.postRoundtripStatus.data.nativeSession = { checked: true, matchesAuthenticatedSession: true };
  assert.equal(summarizeLiveRoundtripEvidence(fixture).threePathRoundtripVerified, true);
  fixture.postRoundtripStatus.data.reverseWebSocket.pongVerified = false;
  const missingPong = summarizeLiveRoundtripEvidence(fixture);
  assert.equal(missingPong.threePathRoundtripVerified, false);
  assert.deepEqual(missingPong.transportCoverage.reverseWebSocket.businessActions, ['get_msg']);
  fixture.postRoundtripStatus.data.reverseWebSocket.pongVerified = true;
  fixture.postRoundtripStatus.data.nativeSession.matchesAuthenticatedSession = false;
  const mismatched = summarizeLiveRoundtripEvidence(fixture);
  assert.equal(mismatched.threePathRoundtripVerified, false);
  assert.equal(mismatched.postRoundtripSessionVerified, false);
  assert.deepEqual(mismatched.transportCoverage.http.businessActions, historical.transportCoverage.http.businessActions);
  fixture.postRoundtripStatus.data.nativeSession.matchesAuthenticatedSession = true;
  fixture.postRoundtripStatus.data.sessionHold.state = 'expired';
  assert.equal(summarizeLiveRoundtripEvidence(fixture).postRoundtripSessionVerified, false);
  fixture.postRoundtripStatus.data.sessionHold.state = 'active';
  fixture.postRoundtripStatus.seq = fixture.roundtripResult.seq;
  assert.equal(summarizeLiveRoundtripEvidence(fixture).threePathRoundtripVerified, false);
  assert.deepEqual(summarizeLiveRoundtripEvidence({ ...fixture, sessionInitAttempts: 2 }).transportCoverage.http.businessActions, []);
});

test('capability preview recomputes exported coverage without modifying the published matrix', { skip: !hasEvidence('capabilities.json') && 'evidence/ 不在仓库里' }, t => {
  const root = path.resolve(import.meta.dirname, '..');
  const scratch = path.join(root, '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'capability-preview-'));
  const file = path.join(directory, 'report.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(directory); });
  const read = name => fs.readFileSync(path.join(root, 'evidence', name));
  const published = read('capabilities.json');
  const defaultPreview = spawnSync(process.execPath, ['scripts/capabilities.mjs', '--preview'],
    { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(defaultPreview.status, 0, defaultPreview.stderr);
  const defaultReport = JSON.parse(defaultPreview.stdout);
  assert.equal(defaultReport.liveEvidence, 'evidence/integrated-linux-three-path-live.json');
  assert.equal(defaultReport.threePathRoundtripVerified, true);
  const evidence = JSON.parse(read('integrated-linux-readback-passed.json'));
  Object.assign(evidence.roundtripResult, { reverseConnected: true, reverseEventVerified: true,
    forwardMessageReadbackVerified: true, reverseMessageReadbackVerified: true, reverseOfflineVerified: true,
    terminalMessageIdVerified: true });
  Object.assign(evidence.postRoundtripStatus, { roundtripSeq: evidence.roundtripResult.seq,
    sessionGeneration: evidence.sessionGeneration });
  evidence.postRoundtripStatus.data.reverseWebSocket = { ...evidence.postRoundtripStatus.data.webSocket, connected: true, pongVerified: true };
  evidence.postRoundtripStatus.data.sessionHold = { state: 'active' };
  evidence.postRoundtripStatus.data.nativeSession = { checked: true, matchesAuthenticatedSession: true };
  const fixture = { command: 'read_live_roundtrip_evidence', status: 'completed', evidence, threePathRoundtripVerified: false };
  const write = () => fs.writeFileSync(file, JSON.stringify(fixture));
  const execute = (...flags) => spawnSync(process.execPath, ['scripts/capabilities.mjs', '--live-evidence', file, ...flags],
    { cwd: root, encoding: 'utf8', timeout: 5000 });
  write();
  const preview = execute('--preview');
  assert.equal(preview.status, 0, preview.stderr);
  const report = JSON.parse(preview.stdout);
  assert.equal(report.threePathRoundtripVerified, true);
  assert.equal(report.postRoundtripSessionVerified, true);
  assert.deepEqual(report.matrix.find(row => row.action === 'get_msg').liveTransports,
    ['http', 'forwardWebSocket', 'reverseWebSocket']);
  const partial = structuredClone(fixture);
  partial.evidence.postRoundtripStatus = null;
  Object.assign(partial.evidence.roundtripResult, { commandCompleted: false, verifiedSameSessionRoundtrip: false,
    postSendChecksIncomplete: true, reverseMessageReadbackVerified: false });
  fs.writeFileSync(file, JSON.stringify(partial));
  const partialPreview = execute('--preview');
  assert.equal(partialPreview.status, 0, partialPreview.stderr);
  const partialReport = JSON.parse(partialPreview.stdout);
  assert.equal(partialReport.threePathRoundtripVerified, false);
  assert.equal(partialReport.postRoundtripSessionVerified, false);
  assert.deepEqual(partialReport.matrix.find(row => row.action === 'get_msg').liveTransports, ['http', 'forwardWebSocket']);
  assert.equal(partialReport.matrix.find(row => row.action === 'send_group_msg').realQQVerified, true);
  partial.evidence.roundtripResult.terminalMessageIdVerified = false;
  fs.writeFileSync(file, JSON.stringify(partial));
  assert.notEqual(execute('--preview').status, 0);
  const combined = { command: 'verify_onebot_roundtrip', status: 'completed',
    roundtripResult: { seq: evidence.roundtripResult.seq }, liveEvidence: fixture };
  fs.writeFileSync(file, JSON.stringify(combined));
  const combinedPreview = execute('--preview');
  assert.equal(combinedPreview.status, 0, combinedPreview.stderr);
  assert.equal(JSON.parse(combinedPreview.stdout).threePathRoundtripVerified, true);
  combined.roundtripResult.seq++;
  fs.writeFileSync(file, JSON.stringify(combined));
  assert.notEqual(execute('--preview').status, 0);
  assert.notEqual(execute().status, 0);
  evidence.postRoundtripStatus.roundtripSeq--;
  write();
  assert.notEqual(execute('--preview').status, 0);
  assert.deepEqual(read('capabilities.json'), published);
});

test('parent watchdog reserves a full hold window after initialization rather than at process spawn', () => {
  const ready = { phase: 'session-ready-observed', identityMatches: true, initCallbackAccepted: true,
    sessionGeneration: 1, calibrationHoldLimitMs: defaultSessionHoldMs, businessOnlineVerified: false };
  assert.equal(sessionStartupLimitMs, 300000);
  assert.equal(sessionWatchdogDelay({ ...ready, phase: 'qr-ready' }, defaultSessionHoldMs), null);
  assert.equal(sessionWatchdogDelay({ ...ready, sessionGeneration: 2 }, defaultSessionHoldMs), null);
  assert.equal(sessionWatchdogDelay({ ...ready, identityMatches: false }, defaultSessionHoldMs), null);
  assert.equal(sessionWatchdogDelay({ ...ready, initCallbackAccepted: false }, defaultSessionHoldMs), null);
  assert.equal(sessionWatchdogDelay({ ...ready, calibrationHoldLimitMs: 1 }, defaultSessionHoldMs), null);
  assert.equal(sessionWatchdogDelay(ready, defaultSessionHoldMs), defaultSessionHoldMs + 15000);
});

test('roundtrip summary permits manual retry evidence only for a settled, unsubmitted action', () => {
  const state = { roundtripProgress: { nativeSubmissionAttempted: false } };
  const response = { accepted: true, command: 'verify_onebot_roundtrip', seq: 1,
    status: 'failed', code: 'ADAPTER_NOT_STARTED' };
  assert.equal(summarizeRoundtripResult(state, response, false).noNativeSubmission, true);
  assert.equal(summarizeRoundtripResult(state, response, true).noNativeSubmission, undefined);
  assert.equal(summarizeRoundtripResult(state, response, false, true).noNativeSubmission, undefined);
  assert.equal(summarizeRoundtripResult(state, { ...response, code: 'WRITE_OUTCOME_UNKNOWN' }, false).noNativeSubmission, undefined);
});

test('exposure counts adjacent fresh observations of the same verified session only', () => {
  const window = new OnlineObservation({ maxGapMs: 1000 });
  for (const [atMs, kind, generation] of [
    [0, 'unverified', 1], [100, 'verified_online', 1], [1100, 'verified_online', 1],
    [2101, 'verified_online', 1], [2500, 'network_unavailable', 1],
    [2550, 'network_unavailable', 1],
    [2600, 'verified_online', 1], [2700, 'verified_online', 2], [2900, 'verified_online', 2],
    [3000, 'operator_stop', 2],
  ]) window.record({ atMs, kind, generation });
  assert.deepEqual(window.summarize(), {
    maxGapMs: 1000, observedMs: 3000, verifiedOnlineMs: 1200, verifiedIntervals: 2, unverifiedMs: 1800,
    terminalReason: 'operator_stop', confirmedPlatformKicks: 0, networkInterruptions: 1,
  });
});

test('the closing sample never extends exposure and only explicit platform kicks are counted', () => {
  for (const [kind, count] of [['platform_kick_confirmed', 1], ['session_invalidated', 0],
    ['native_crash', 0], ['operator_stop', 0], ['unknown_exit', 0]]) {
    const window = new OnlineObservation({ maxGapMs: 1000 });
    window.record({ atMs: 400, kind: 'verified_online', generation: 1 });
    window.record({ atMs: 500, kind, generation: 1 });
    const summary = window.summarize();
    assert.equal(summary.verifiedOnlineMs, 0);
    assert.equal(summary.terminalReason, kind);
    assert.equal(summary.confirmedPlatformKicks, count);
    assert.throws(() => window.record({ atMs: 600, kind: 'verified_online', generation: 1 }), /ended/);
  }
});

test('observations reject replay, generation rollback and unclassified native signal names', () => {
  const window = new OnlineObservation({ maxGapMs: 1000 });
  window.record({ atMs: 90, kind: 'unverified', generation: 2 });
  assert.throws(() => window.record({ atMs: 90, kind: 'verified_online', generation: 2 }), RangeError);
  assert.throws(() => window.record({ atMs: 91, kind: 'verified_online', generation: 1 }), RangeError);
  assert.throws(() => window.record({ atMs: 92, kind: 'getSelfStatus', generation: 2 }), TypeError);
  assert.equal(window.summarize().verifiedOnlineMs, 0);
});

test('launcher exit classification keeps vague disconnects and unexplained signals unattributed', () => {
  for (const [phase, status, signal, deadlineElapsed, expected] of [
    ['closed', 0, null, false, 'operator_stop'],
    ['closed', 2, null, false, 'unknown_exit'],
    ['signal-termination', 2, null, false, 'unknown_exit'],
    ['manual-session-hold-expired', 2, null, false, 'observation_expired'],
    ['logged-out', 2, null, false, 'session_invalidated'],
    ['changed-login-identity', 2, null, false, 'session_invalidated'],
    ['login-disconnected', 2, null, false, 'unknown_exit'],
    ['login-account-limit', 2, null, false, 'unknown_exit'],
    ['session-ready-observed', null, 'SIGABRT', false, 'unknown_exit'],
    ['session-ready-observed', null, 'SIGKILL', true, 'observation_expired'],
  ]) assert.equal(classifyIntegratedHostExit({ phase, status, signal, deadlineElapsed }), expected);
});

test('point-in-time roundtrip requires successful OneBot response independently of process exit', () => {
  const snapshot = {
    phase: 'closed',
    roundtripProgress: { oneBotEventVerified: true, nativeSubmissionAttempted: true, oneBotSendConfirmed: true },
    roundtripSendResponse: { httpStatus: 200, retcode: 0 },
    roundtripOneBotRestartVerified: true,
    roundtripBridgeRestartVerified: true,
    roundtripEndpointCheck: { reusesPreLoginPort: true, offlineRestored: true },
    roundtripGroupRead: { attempted: true, verified: true },
    roundtripMessageRead: { attempted: true, verified: true },
  };
  assert.deepEqual(summarizeRoundtripReachability(snapshot), {
    inboundVerified: true, nativeSubmissionAttempted: true, outboundVerified: true, oneBotRestartVerified: true, bridgeReattachmentVerified: true,
    preLoginPortReused: true, offlineEndpointRestored: true,
    groupInfoVerified: true, messageReadbackVerified: true,
  });
  assert.equal(summarizeRoundtripReachability({ ...snapshot, roundtripSendResponse: { httpStatus: 504, retcode: 1504 } }).outboundVerified, false);
  assert.equal(summarizeRoundtripReachability({ phase: 'session-ready-observed' }).inboundVerified, false);
  const control = { command: 'verify_onebot_roundtrip', accepted: true, seq: 3, status: 'completed', code: 'COMPLETED' };
  const completed = summarizeRoundtripResult(snapshot, control, false);
  assert.equal(completed.seq, 3);
  assert.equal(completed.verifiedSameSessionRoundtrip, true);
  const threePath = { ...snapshot, roundtripReadbackMode: 'http-forward-reverse',
    roundtripEndpointCheck: { ...snapshot.roundtripEndpointCheck, reverseOfflineVerified: true },
    roundtripProgress: { ...snapshot.roundtripProgress, reverseConnected: true, reverseEventVerified: true, terminalMessageIdVerified: true },
    roundtripMessageRead: { ...snapshot.roundtripMessageRead, forwardVerified: true, reverseVerified: true } };
  assert.equal(summarizeRoundtripResult(threePath, control, false).verifiedSameSessionRoundtrip, true);
  for (const [section, field] of [['roundtripProgress', 'reverseConnected'], ['roundtripProgress', 'reverseEventVerified'],
    ['roundtripProgress', 'terminalMessageIdVerified'],
    ['roundtripMessageRead', 'forwardVerified'], ['roundtripMessageRead', 'reverseVerified'],
    ['roundtripEndpointCheck', 'reverseOfflineVerified']]) {
    const incomplete = summarizeRoundtripResult({ ...threePath, [section]: { ...threePath[section], [field]: undefined } }, control, false);
    assert.equal(incomplete.verifiedSameSessionRoundtrip, false, field);
    assert.equal(incomplete.postSendChecksIncomplete, true, field);
    assert.equal(incomplete.outboundVerified, true, field);
  }
  assert.equal(completed.cleanupPending, false);
  assert.equal(completed.groupInfoAttempted, true);
  assert.equal(completed.messageReadbackAttempted, true);
  assert.equal(Object.hasOwn(completed, 'webSocketOfflineVerified'), false);
  for (const roundtripMessageRead of [undefined, { attempted: true, verified: false }]) {
    const incomplete = summarizeRoundtripResult({ ...snapshot, roundtripMessageRead }, control, false);
    assert.equal(incomplete.outboundVerified, true);
    assert.equal(incomplete.offlineEndpointRestored, true);
    assert.equal(incomplete.pendingOutcomePresent, false);
    assert.equal(incomplete.messageReadbackVerified, false);
    assert.equal(incomplete.postSendChecksIncomplete, true);
    assert.equal(incomplete.verifiedSameSessionRoundtrip, false);
  }
  const reverseFailure = summarizeRoundtripResult({ ...snapshot, roundtripProgress: {
    oneBotEventVerified: false, reverseConnected: true, reverseEventVerified: false, nativeSubmissionAttempted: false,
  } }, control, false);
  assert.equal(reverseFailure.reverseConnected, true);
  assert.equal(reverseFailure.reverseEventVerified, false);
  assert.equal(reverseFailure.nativeSubmissionAttempted, false);
  assert.equal(reverseFailure.verifiedSameSessionRoundtrip, false);
  const split = summarizeRoundtripResult({ ...snapshot, roundtripEndpointCheck: {
    reusesPreLoginPort: true, offlineRestored: false, httpPortReused: true, webSocketPortReused: true,
    httpOfflineVerified: true, webSocketOfflineVerified: false,
  } }, control, false);
  assert.equal(split.httpOfflineVerified, true);
  assert.equal(split.webSocketOfflineVerified, false);
  assert.equal(split.offlineEndpointRestored, false);
  assert.equal(split.outboundVerified, true);
  assert.equal(split.postSendChecksIncomplete, true);
  assert.equal(split.verifiedSameSessionRoundtrip, false);
  const splitRecovered = summarizeRoundtripResult({ ...snapshot, roundtripEndpointCheck: {
    reusesPreLoginPort: true, offlineRestored: true, httpPortReused: true, webSocketPortReused: true,
    httpOfflineVerified: true, webSocketOfflineVerified: true,
  } }, control, false);
  assert.equal(splitRecovered.postSendChecksIncomplete, false);
  assert.equal(splitRecovered.verifiedSameSessionRoundtrip, true);
  assert.equal(summarizeRoundtripResult(snapshot, control, true).verifiedSameSessionRoundtrip, false);
  const uncertain = summarizeRoundtripResult(snapshot,
    { ...control, status: 'unknown', code: 'WRITE_OUTCOME_UNKNOWN' }, true);
  assert.equal(uncertain.verifiedSameSessionRoundtrip, false);
  assert.equal(uncertain.writeOutcomeUnknown, true);
  const cancelled = { ...control, status: 'cancelled', code: 'SEND_CONFIRMED_CHECKS_INCOMPLETE' };
  const duringCleanup = summarizeRoundtripResult(snapshot, cancelled, false, true);
  const afterCleanup = summarizeRoundtripResult(snapshot, cancelled, false);
  assert.equal(duringCleanup.cleanupPending, true);
  assert.equal(duringCleanup.outboundVerified, true);
  assert.equal(afterCleanup.cleanupPending, false);
  assert.equal(afterCleanup.verifiedSameSessionRoundtrip, false);
  assert.equal(afterCleanup.postSendChecksIncomplete, true);
  assert.equal(summarizeRoundtripResult(snapshot, { ...control, accepted: false }, false), null);
  assert.equal(summarizeRoundtripResult(snapshot, { ...control, command: 'read_onebot_status' }, false), null);
});

test('sequential matched windows calculate observed kick rates using only verified exposure', () => {
  const first = window('whale-onebot', '2026-11-13T00:00:00.000Z');
  const second = window('napcat', '2026-11-13T00:00:10.000Z', 'platform_kick_confirmed');
  const report = compareOnlineWindows(first, second);
  assert.equal(report.comparable, true);
  assert.deepEqual(report.observedKicksPerHour, { 'whale-onebot': 0, napcat: 3600 });
});

test('comparison omits rates when exposure, attribution or comparability is missing', () => {
  const first = window('whale-onebot', '2026-11-13T00:00:00.000Z');
  first.observations[1].kind = 'unverified';
  const second = window('napcat', '2026-11-13T00:00:01.000Z', 'unknown_exit');
  second.platform = 'win32';
  const report = compareOnlineWindows(first, second);
  assert.deepEqual(report.blockers, [
    'mismatch:platform', 'overlapping-windows', 'whale-onebot:no-verified-exposure', 'napcat:unattributed-ending',
  ]);
  assert.equal(report.comparable, false);
  assert.equal(report.observedKicksPerHour, null);
});

test('a kick long after the last verified sample does not enter a rate comparison', () => {
  const first = window('whale-onebot', '2026-11-13T00:00:00.000Z');
  const second = window('napcat', '2026-11-13T00:00:10.000Z', 'platform_kick_confirmed');
  second.observations.at(-1).atMs = 3000;
  assert.deepEqual(compareOnlineWindows(first, second).blockers, ['napcat:kick-outside-fresh-exposure']);
});

test('series weights observed kicks by total verified exposure, independent of input order', t => {
  const first = window('whale-onebot', '2026-11-13T00:00:00.000Z');
  const baseline = window('napcat', '2026-11-13T00:00:10.000Z', 'platform_kick_confirmed');
  const second = window('whale-onebot', '2026-11-13T00:00:20.000Z', 'platform_kick_confirmed');
  second.observations.splice(2, 0, { atMs: 2000, kind: 'verified_online', generation: 1 });
  second.observations.at(-1).atMs = 2200;
  const report = compareOnlineWindowSeries([second, first, baseline]);
  assert.equal(report.comparable, true);
  assert.deepEqual(report.totals['whale-onebot'], { windowCount: 2, observedMs: 3400, verifiedOnlineMs: 3000, confirmedPlatformKicks: 1 });
  assert.deepEqual(report.observedKicksPerHour, { 'whale-onebot': 1200, napcat: 3600 });
  const root = path.resolve(import.meta.dirname, '..');
  const scratch = path.join(root, '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, 'observation-series-'));
  const inputs = [second, first, baseline].map((value, index) => {
    const file = path.join(fixture, `window-${index}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  });
  t.after(() => { for (const file of inputs) fs.unlinkSync(file); fs.rmdirSync(fixture); });
  const result = spawnSync(process.execPath, ['scripts/compare-online-observations.mjs', '--series', ...inputs],
    { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), report);
});

test('series blocks the calculation for overlapping, unmatched, and unverified windows', () => {
  const first = window('whale-onebot', '2026-11-13T00:00:00.000Z');
  const second = window('whale-onebot', '2026-11-13T00:00:00.100Z');
  const baseline = window('napcat', '2026-11-13T00:00:10.000Z', 'session_invalidated');
  baseline.qqVersion = 'different';
  baseline.observations[1].kind = 'unverified';
  const report = compareOnlineWindowSeries([first, second, baseline]);
  assert.deepEqual(report.blockers, ['napcat[3]:mismatch:qqVersion', 'napcat[3]:no-verified-exposure',
    'napcat[3]:unattributed-ending', 'overlapping-windows']);
  assert.equal(report.observedKicksPerHour, null);
  assert(compareOnlineWindowSeries([first, second]).blockers.includes('napcat:missing-windows'));
});

test('Linux snapshot observer writes comparison-format data without promoting saved online flags', t => {
  const root = path.resolve(import.meta.dirname, '..');
  const scratch = path.join(root, '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, 'linux-snapshot-observer-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(fixture)), fs.realpathSync(scratch));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const profile = 'login-0123456789abcdef0123';
  const directory = path.join(fixture, 'runtime', 'integrated', profile);
  for (const folder of [directory, path.join(fixture, 'scripts'), path.join(fixture, 'src', 'host')])
    fs.mkdirSync(folder, { recursive: true });
  for (const name of ['scripts/observe-linux-session.mjs', 'scripts/calibration-command.mjs', 'src/host/online-observation.mjs'])
    fs.copyFileSync(path.join(root, name), path.join(fixture, name));
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ phase: 'session-ready-observed',
    at: '2026-11-13T00:00:00.000Z', sessionGeneration: 1, businessOnlineVerified: true,
    control: { runId: profile, authenticationObserved: true, authBinding: 'private-fixture-binding' } }));
  const command = spawnSync(process.execPath, [path.join(fixture, 'scripts/observe-linux-session.mjs'),
    profile, 'synthetic', 'idle', '1'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(command.status, 0, command.stderr);
  assert(!command.stdout.includes('private-fixture-binding'));
  const result = JSON.parse(command.stdout);
  assert.deepEqual(result.observations.map(entry => entry.kind), ['unverified', 'observation_expired']);
  assert.equal(result.summary.verifiedOnlineMs, 0);
  assert(compareOnlineWindows(result, window('napcat', '2026-11-13T00:00:00.000Z')).blockers.includes('whale-onebot:no-verified-exposure'));
  assert.deepEqual(fs.readdirSync(directory), ['status.json']);
  assert.deepEqual(fs.readdirSync(path.join(fixture, 'runtime')), ['integrated']);
});

function window(implementation, startedAt, ending = 'operator_stop') {
  return { implementation, startedAt, platform: 'linux', qqVersion: 'synthetic', scenario: 'idle',
    maxGapMs: 1000, observations: [
      { atMs: 0, kind: 'verified_online', generation: 1 },
      { atMs: 1000, kind: 'verified_online', generation: 1 },
      { atMs: 1200, kind: ending, generation: 1 },
    ] };
}
