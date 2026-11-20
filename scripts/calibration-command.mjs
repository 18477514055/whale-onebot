// Parent-side fixed command delivery. Never prints the local authentication binding.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { hasThreePathReadback, summarizeLiveRoundtripEvidence } from '../src/host/online-observation.mjs';
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const directory=path.resolve(process.argv[2]),command=process.argv[3];
const inboundCommands=['arm_inbound_challenge','read_inbound_challenge','verify_onebot_receive','verify_onebot_inbound_readback','verify_onebot_roundtrip'];
const integratedCommands=['inspect_image_path','prepare_image_element','inspect_service_readiness','restart_onebot','read_confirmed_onebot_reply','verify_read_only_onebot',
  'inspect_unconfirmed_onebot_reply',...inboundCommands];
const calibrationCommands=['inspect_service_methods','register_online','read_self_status','read_online_status',
  'stop','read_onebot_status',...integratedCommands];
const readRoundtrip=command==='read_roundtrip_result';
const readHostSnapshot=command==='read_host_snapshot';
const checkRoundtripReadiness=command==='check_roundtrip_readiness';
const readLiveEvidence=command==='read_live_roundtrip_evidence';
const resampleLiveEvidence=command==='collect_live_roundtrip_evidence';
const readOnly=readRoundtrip||readHostSnapshot||readLiveEvidence||checkRoundtripReadiness;
const challengeCommand=['verify_onebot_roundtrip','verify_onebot_inbound_readback','verify_read_only_onebot'].includes(command);
const roundtripCommand=command==='verify_onebot_roundtrip';
const readbackOnly=command==='verify_onebot_inbound_readback'||command==='verify_read_only_onebot';
const awaitChallenge=challengeCommand&&process.argv[4]==='--await-challenge';
const armAndAwait=challengeCommand&&process.argv[4]==='--arm-group';
const optionStart=armAndAwait?6:command==='arm_inbound_challenge'||awaitChallenge?5:4;
const options=process.argv.slice(optionStart);
const followUp=roundtripCommand&&(awaitChallenge||armAndAwait)&&options.includes('--inspect-unknown');
const strictReadback=roundtripCommand&&options.includes('--require-three-path-readback');
const collectEvidence=strictReadback&&(awaitChallenge||armAndAwait)&&options.includes('--collect-evidence');
const comparePreparation=checkRoundtripReadiness&&options.includes('--compare-preparation');
const requirePreparation=strictReadback&&(awaitChallenge||armAndAwait)&&options.includes('--require-preparation');
const allowAdminChallenge=command==='verify_read_only_onebot'&&(awaitChallenge||armAndAwait)&&options.includes('--allow-admin-challenge');
const groupId=armAndAwait?process.argv[5]:command==='arm_inbound_challenge'?process.argv[4]:undefined;
assert.equal(process.argv.length,optionStart+Number(followUp)+Number(strictReadback)+Number(collectEvidence)+Number(comparePreparation)+Number(requirePreparation)+Number(allowAdminChallenge),
  'Usage: calibration-command.mjs <runtime directory> <fixed command> [group | --await-challenge | --arm-group <group>] [--inspect-unknown] [--require-three-path-readback] [--collect-evidence] [--compare-preparation | --require-preparation] [--allow-admin-challenge (read-only client only)]');
if (groupId !== undefined) assert(/^[1-9]\d{4,15}$/.test(groupId) && Number.isSafeInteger(Number(groupId)), 'Invalid test group');
assert(readOnly || resampleLiveEvidence || calibrationCommands.includes(command));
const runtime = path.join(root, 'runtime');
const profile = path.basename(directory);
const integrated = path.dirname(directory) === path.join(runtime, 'integrated');
assert(integrated ? /^login-[a-f0-9]{20}$/.test(profile) :
  path.dirname(directory) === runtime && /^status-calibration-[A-Za-z0-9]+$/.test(profile));
assert((!readOnly && !resampleLiveEvidence && !integratedCommands.includes(command) && command !== 'read_onebot_status') || integrated, 'Command requires the integrated host');
const output = integrated ? directory : path.join(directory, 'output');
const controlDir = integrated ? path.join(runtime, 'integrated-control', profile) : path.join(directory, 'control');
for(const p of new Set([runtime,directory,output,...(readOnly ? [] : [controlDir])])){
  assert(!fs.lstatSync(p).isSymbolicLink());assert.equal(fs.realpathSync(p),p);
}
function readJSON(file,max){
  const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=max);
  assert.equal(fs.realpathSync(file),file);return JSON.parse(fs.readFileSync(file,'utf8'));
}
// Atomic replacement across the Windows/WSL mount can briefly return ENODATA.
// Only retry the read; an already published control command is never resent.
const sharingConflict = error => process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(error.code);
const transientObservation = error => error.code === 'ENOENT' || error.code === 'ENODATA' || sharingConflict(error);
const armStages = ['verify-session', 'acquire-message-service', 'check-message-methods', 'check-onebot-endpoints', 'register-listener',
  'verify-session-after-registration', 'create-challenge'];
const armMethods = ['addKernelMsgListener', 'removeKernelMsgListener', 'getMsgsByMsgId', 'generateMsgUniqueId', 'sendMsg'];
const sameSession = (current, expected) => current?.runId === expected.runId &&
  current.generation === expected.generation && current.authBinding === expected.authBinding;
const pendingRoundtrip = (report, seq) => report?.seq === seq &&
  report.writeOutcomeUnknown === true && report.pendingOutcomePresent === true;
const incompatibleReadback = mode => strictReadback && mode !== 'http-forward-reverse';
const readbackModeRejection = () => ({ command, status: 'rejected', code: 'THREE_PATH_READBACK_UNAVAILABLE' });
const validRoundtripSequence = (control, report) => Number.isSafeInteger(report?.seq) &&
  report.seq > 0 && Number.isSafeInteger(control?.lastSeq) && report.seq <= control.lastSeq;
const roundtripAlreadyInvoked = (control, report) =>
  control?.roundtripInvoked === true || (validRoundtripSequence(control, report) &&
    !(control.roundtripInvoked === false && report.noNativeSubmission === true && report.nativeSubmissionAttempted === false &&
      report.writeOutcomeUnknown === false && report.pendingOutcomePresent === false && report.cleanupPending === false &&
      report.outboundVerified === false));
const roundtripRejection = () => ({ command, status: 'rejected', code: 'ROUNDTRIP_ALREADY_ATTEMPTED' });
const hasPendingWrite = ({ control, roundtripResult }) => roundtripResult?.pendingOutcomePresent === true ||
  control?.writeState === 'unknown' || control?.writeOutcomeUnknown === true;
const pendingWriteRejection = name => ({ command: name, status: 'rejected', code: 'PENDING_WRITE_OUTCOME' });
async function readStatus() {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return readJSON(path.join(output, 'status.json'), 32768); }
    catch (error) {
      if (!transientObservation(error) || attempt === 9) throw error;
      await delay(50);
    }
  }
}

function publicRoundtripResult(report, expectedSeq, mode) {
  if (report?.seq !== expectedSeq || !Number.isSafeInteger(expectedSeq) || expectedSeq < 1) return;
  const fields = ['commandCompleted', 'postSendChecksIncomplete', 'writeOutcomeUnknown', 'pendingOutcomePresent', 'cleanupPending', 'noNativeSubmission',
    'inboundVerified', 'reverseConnected', 'reverseEventVerified', 'nativeSubmissionAttempted', 'terminalMessageIdVerified', 'outboundVerified',
    'oneBotRestartVerified', 'bridgeReattachmentVerified',
    'preLoginPortReused', 'offlineEndpointRestored', 'httpPortReused', 'webSocketPortReused',
    'httpOfflineVerified', 'webSocketOfflineVerified', 'reverseOfflineVerified', 'groupInfoAttempted', 'groupInfoVerified',
    'messageReadbackAttempted', 'messageReadbackVerified', 'forwardMessageReadbackVerified',
    'reverseMessageReadbackVerified', 'verifiedSameSessionRoundtrip'];
  const result = { seq: expectedSeq };
  for (const field of fields) {
    if (typeof report[field] === 'boolean') result[field] = report[field];
  }
  // Older hosts could mark the roundtrip complete before get_msg was verified.
  // Apply the current acceptance rule without rewriting the saved snapshot.
  if (result.messageReadbackVerified !== true || (mode === 'http-forward-reverse' && !hasThreePathReadback(result))) {
    if (result.verifiedSameSessionRoundtrip === true) result.verifiedSameSessionRoundtrip = false;
    if (result.outboundVerified === true) result.postSendChecksIncomplete = true;
  }
  return result;
}

async function readSavedRoundtripResult() {
  const { control, roundtripResult: report, roundtripMessageRead: readback, roundtripFollowUp, roundtripReadbackMode,
    confirmedReplyReadback, sessionGeneration } = await readStatus();
  const result = control?.runId === profile && Number.isSafeInteger(control.lastSeq) && report?.seq <= control.lastSeq
    ? publicRoundtripResult(report, report.seq, roundtripReadbackMode) : undefined;
  const outcome = ['verified', 'response-mismatch', 'onebot-rejected', 'deadline-or-cancelled', 'transport-failed'];
  const nativeOutcome = ['pending', 'rejected', 'unclassified', 'empty', 'nonempty', 'failed', 'not-started'];
  const messageReadback = result && outcome.includes(readback?.outcome) && nativeOutcome.includes(readback?.nativeOutcome) &&
    readback.attempted === result.messageReadbackAttempted && readback.verified === result.messageReadbackVerified
    ? { outcome: readback.outcome, nativeOutcome: readback.nativeOutcome } : undefined;
  let followUp;
  if (result && pendingRoundtrip(result, result.seq) && roundtripFollowUp?.seq === result.seq) {
    const { inspection, readback } = roundtripFollowUp;
    if (inspection?.attempted === true && typeof inspection.storedTerminalReplyFound === 'boolean' &&
        typeof inspection.pendingOutcomeRetained === 'boolean') {
      followUp = { inspection: { attempted: true, storedTerminalReplyFound: inspection.storedTerminalReplyFound,
        pendingOutcomeRetained: inspection.pendingOutcomeRetained } };
      if (inspection.storedTerminalReplyFound && inspection.pendingOutcomeRetained &&
          readback?.attempted === true && typeof readback.verified === 'boolean' && typeof readback.pendingOutcomeRetained === 'boolean') {
        followUp.readback = { attempted: true, verified: readback.verified, pendingOutcomeRetained: readback.pendingOutcomeRetained };
      }
    }
  }
  const replyRecheck = result?.outboundVerified === true && sessionGeneration === 1 &&
    confirmedReplyReadback?.roundtripSeq === result.seq && confirmedReplyReadback.generation === sessionGeneration &&
    Number.isSafeInteger(confirmedReplyReadback.seq) && confirmedReplyReadback.seq > result.seq &&
    confirmedReplyReadback.seq <= control.lastSeq && typeof confirmedReplyReadback.verified === 'boolean'
    ? { seq: confirmedReplyReadback.seq, verified: confirmedReplyReadback.verified } : undefined;
  if (replyRecheck && typeof confirmedReplyReadback.attempted === 'boolean' &&
      ['verified', 'not-started', 'service-start-failed', 'native-read-failed', 'response-mismatch', 'onebot-rejected', 'transport-failed'].includes(confirmedReplyReadback.outcome) &&
      replyRecheck.verified === (confirmedReplyReadback.outcome === 'verified') &&
      (!['verified', 'native-read-failed', 'response-mismatch'].includes(confirmedReplyReadback.outcome) || confirmedReplyReadback.attempted) &&
      (!['not-started', 'service-start-failed'].includes(confirmedReplyReadback.outcome) || !confirmedReplyReadback.attempted)) {
    replyRecheck.attempted = confirmedReplyReadback.attempted;
    replyRecheck.outcome = confirmedReplyReadback.outcome;
  }
  return result ? { command, status: 'completed', roundtripResult: result, messageReadback, followUp, replyRecheck }
    : { command, status: 'unavailable', code: 'ROUNDTRIP_REPORT_UNAVAILABLE' };
}

async function readSavedLiveEvidence(expectedControl, expectedRoundtrip, expectedSample) {
  const saved = await readStatus();
  const { control, roundtripResult, postRoundtripStatus, inputManifestSha256, inputContentSha256 } = saved;
  const command = 'read_live_roundtrip_evidence';
  const unavailable = { command, status: 'unavailable', code: 'LIVE_ROUNDTRIP_EVIDENCE_UNAVAILABLE' };
  if (control?.runId !== profile || control.authenticationObserved !== true || control.busy !== false ||
      saved.sessionGeneration !== 1 || !validRoundtripSequence(control, roundtripResult) ||
      typeof saved.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(saved.at) ||
      !/^[a-f0-9]{64}$/.test(typeof inputManifestSha256 === 'string' ? inputManifestSha256 : '') ||
      roundtripResult.cleanupPending !== false || (expectedControl && (!sameSession(control, expectedControl) ||
        roundtripResult.seq !== expectedRoundtrip || postRoundtripStatus?.seq !== expectedSample))) return unavailable;
  if (postRoundtripStatus != null && (postRoundtripStatus.roundtripSeq !== roundtripResult.seq ||
      postRoundtripStatus.sessionGeneration !== saved.sessionGeneration || !Number.isSafeInteger(postRoundtripStatus.seq) ||
      postRoundtripStatus.seq <= roundtripResult.seq || postRoundtripStatus.seq > control.lastSeq)) return unavailable;
  const projectStatus = entry => ({ endpointResponded: entry?.endpointResponded === true,
    status: entry?.endpointResponded === true && typeof entry?.status?.online === 'boolean' && typeof entry.status.good === 'boolean'
      ? { online: entry.status.online, good: entry.status.good } : null });
  const readback = saved.roundtripMessageRead;
  const evidence = { at: saved.at, profile, inputManifestSha256, exactInputInventory: saved.exactInputInventory === true,
    ...(typeof inputContentSha256 === 'string' && /^[a-f0-9]{64}$/.test(inputContentSha256) && { inputContentSha256 }),
    identityMatches: saved.identityMatches === true, sessionGeneration: saved.sessionGeneration,
    qrRequests: saved.qrRequests === 1 ? 1 : null, sessionInitAttempts: saved.sessionInitAttempts === 1 ? 1 : null,
    automaticRetry: saved.automaticRetry === false ? false : null,
    sendResponse: { httpStatus: saved.roundtripSendResponse?.httpStatus === 200 ? 200 : null,
      retcode: saved.roundtripSendResponse?.retcode === 0 ? 0 : null },
    receiptObservation: { terminalSuccessWithValidId: saved.roundtripReceiptObservation?.terminalSuccessWithValidId === 1 ? 1 : null },
    roundtripResult: publicRoundtripResult(roundtripResult, roundtripResult.seq, saved.roundtripReadbackMode),
    messageReadback: { attempted: readback?.attempted === true, verified: readback?.verified === true },
    postRoundtripStatus: postRoundtripStatus == null ? null : { seq: postRoundtripStatus.seq, roundtripSeq: postRoundtripStatus.roundtripSeq,
      sessionGeneration: postRoundtripStatus.sessionGeneration, data: { ...projectStatus(postRoundtripStatus.data),
      webSocket: projectStatus(postRoundtripStatus.data?.webSocket),
      reverseWebSocket: { ...projectStatus(postRoundtripStatus.data?.reverseWebSocket),
        connected: postRoundtripStatus.data?.reverseWebSocket?.connected === true,
        pongVerified: postRoundtripStatus.data?.reverseWebSocket?.pongVerified === true },
      sessionHold: { state: postRoundtripStatus.data?.sessionHold?.state === 'active' ? 'active' : null },
      nativeSession: { checked: postRoundtripStatus.data?.nativeSession?.checked === true,
        matchesAuthenticatedSession: typeof postRoundtripStatus.data?.nativeSession?.matchesAuthenticatedSession === 'boolean'
          ? postRoundtripStatus.data.nativeSession.matchesAuthenticatedSession : null } } } };
  const coverage = summarizeLiveRoundtripEvidence(evidence);
  if (!coverage.transportCoverage.http.businessActions.includes('send_group_msg')) return unavailable;
  return { command, status: 'completed', evidence, ...coverage };
}

async function readSavedHostSnapshot(saved = undefined) {
  const { control, phase, at, calibrationHoldLimitMs, sessionGeneration, businessOnlineVerified, sessionHold,
    roundtripReadbackMode, roundtripResult, inputContentSha256, splitOneBotPorts } = saved ?? await readStatus();
  if (control?.runId !== profile || typeof phase !== 'string' || !/^[a-z][a-z-]{0,79}$/.test(phase) ||
      typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) || !Number.isFinite(Date.parse(at)))
    return { command, status: 'unavailable', code: 'HOST_SNAPSHOT_UNAVAILABLE' };
  const data = { phase, observedAt: at,
    holdLimitMs: Number.isSafeInteger(calibrationHoldLimitMs) && calibrationHoldLimitMs > 0 &&
      calibrationHoldLimitMs <= 168 * 3600000 ? calibrationHoldLimitMs : null };
  const remaining = sessionHold?.remainingMs;
  if ((sessionHold?.state === 'not-started' && remaining === null) ||
      (sessionHold?.state === 'ended' && remaining === null && data.holdLimitMs !== null) ||
      (sessionHold?.state === 'expired' && remaining === 0 && data.holdLimitMs !== null) ||
      (sessionHold?.state === 'active' && data.holdLimitMs !== null && Number.isSafeInteger(remaining) &&
        remaining >= 0 && remaining <= data.holdLimitMs)) {
    data.sessionHoldAtSnapshot = { state: sessionHold.state, remainingMs: remaining };
  }
  if (Number.isSafeInteger(sessionGeneration) && sessionGeneration > 0) data.sessionGeneration = sessionGeneration;
  if (typeof businessOnlineVerified === 'boolean') data.businessOnlineVerifiedAtSnapshot = businessOnlineVerified;
  if (Array.isArray(control.supportedCommands))
    data.supportedCommands = calibrationCommands.filter(name => control.supportedCommands.includes(name));
  if (typeof control.busy === 'boolean') data.controlBusy = control.busy;
  if (typeof control.authenticationObserved === 'boolean') data.authenticationObserved = control.authenticationObserved;
  data.roundtripReadbackMode = roundtripReadbackMode === 'http-forward-reverse' ? roundtripReadbackMode : 'unreported';
  if (validRoundtripSequence(control, roundtripResult))
    data.recordedRoundtripSeq = roundtripResult.seq;
  if (typeof control.roundtripInvoked === 'boolean') data.roundtripInvoked = control.roundtripInvoked;
  if (typeof inputContentSha256 === 'string' && /^[a-f0-9]{64}$/.test(inputContentSha256))
    data.inputContentSha256 = inputContentSha256;
  if (typeof splitOneBotPorts === 'boolean') data.splitOneBotPorts = splitOneBotPorts;
  return { command, status: 'completed', data };
}

async function readRoundtripReadiness(saved = undefined) {
  saved ??= await readStatus();
  const snapshot = await readSavedHostSnapshot(saved);
  if (snapshot.status !== 'completed') return snapshot;
  const data = snapshot.data;
  const blockers = [];
  if (data.phase !== 'session-ready-observed' || data.authenticationObserved !== true || data.sessionGeneration !== 1)
    blockers.push('SESSION_NOT_READY');
  if (data.roundtripReadbackMode !== 'http-forward-reverse') blockers.push('THREE_PATH_READBACK_UNAVAILABLE');
  if (!['arm_inbound_challenge', 'read_inbound_challenge', 'verify_onebot_roundtrip', 'read_onebot_status']
    .every(name => data.supportedCommands?.includes(name))) blockers.push('REQUIRED_COMMANDS_UNAVAILABLE');
  if (data.controlBusy !== false) blockers.push('CONTROL_NOT_IDLE');
  if (roundtripAlreadyInvoked(saved.control, saved.roundtripResult)) blockers.push('ROUNDTRIP_ALREADY_ATTEMPTED');
  if (hasPendingWrite(saved)) blockers.push('PENDING_WRITE_OUTCOME');
  const snapshotAgeMs = Date.now() - Date.parse(data.observedAt);
  const hold = data.sessionHoldAtSnapshot;
  const remainingMs = snapshotAgeMs < 0 ? null : hold?.state === 'expired' ? 0 : hold?.state === 'active'
    ? Math.max(0, hold.remainingMs - snapshotAgeMs) : null;
  if (remainingMs === null) blockers.push('SESSION_HOLD_UNCONFIRMED');
  else if (remainingMs === 0) blockers.push('SESSION_HOLD_EXPIRED');
  data.estimatedHoldRemainingMs = remainingMs;
  if (comparePreparation || requirePreparation) {
    let preparation;
    try { preparation = readJSON(path.join(root, 'evidence', 'integrated-login-preparation-linux.json'), 65536); }
    catch { /* Missing or unreadable evidence cannot establish equivalence. */ }
    if (preparation?.networkShared !== false || preparation.qqExecuted !== true ||
        preparation.mountedInputsVerifiedAtExit !== true || preparation.observed?.status !== 0 ||
        preparation.observed.phase !== 'login-service-initialized-offline' || preparation.observed.loginConnectAttempts !== 0 ||
        preparation.observed.qrRequests !== 0 || preparation.observed.initAttempts !== 0 ||
        typeof preparation.inputContentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preparation.inputContentSha256) ||
        typeof preparation.splitOneBotPorts !== 'boolean') {
      blockers.push('PREPARATION_EVIDENCE_UNAVAILABLE');
    } else {
      const contentMatches = data.inputContentSha256 === undefined ? null : data.inputContentSha256 === preparation.inputContentSha256;
      const portModeMatches = data.splitOneBotPorts === undefined ? null : data.splitOneBotPorts === preparation.splitOneBotPorts;
      data.preparationComparison = { contentMatches, portModeMatches };
      if (contentMatches === null || portModeMatches === null) blockers.push('HOST_BUILD_UNCONFIRMED');
      if (contentMatches === false) blockers.push('PREPARATION_CONTENT_MISMATCH');
      if (portModeMatches === false) blockers.push('PREPARATION_PORT_MODE_MISMATCH');
    }
  }
  return { command, status: blockers.length ? 'rejected' : 'completed', snapshotChecksPassed: blockers.length === 0,
    blockers, data };
}

async function deliver(name, expectedControl, expectedRoundtripSeq) {
  const lockPath = path.join(controlDir, 'delivery.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return { command: name, status: 'rejected', code: 'DELIVERY_BUSY' };
    throw error;
  }
  try { return await deliverLocked(name, expectedControl, expectedRoundtripSeq); }
  finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

async function deliverLocked(name, expectedControl, expectedRoundtripSeq) {
  const saved = await readStatus();
  const { control, roundtripResult: report, roundtripReadbackMode } = saved;
  if (requirePreparation && ['arm_inbound_challenge', 'verify_onebot_roundtrip'].includes(name)) {
    const readiness = await readRoundtripReadiness(saved);
    if (!readiness.snapshotChecksPassed) return readiness;
  }
  if (incompatibleReadback(roundtripReadbackMode)) return readbackModeRejection();
  if (roundtripCommand && ['arm_inbound_challenge', 'verify_onebot_roundtrip'].includes(name) &&
      roundtripAlreadyInvoked(control, report)) return roundtripRejection();
  if ((name === 'register_online' || name === 'verify_onebot_roundtrip' ||
      (roundtripCommand && name === 'arm_inbound_challenge')) && hasPendingWrite(saved))
    return pendingWriteRejection(command);
  assert(control && typeof control.runId === 'string', 'Session control is not ready');
  assert(control.supportedCommands?.includes(name), 'Command is unavailable in this running host');
  assert(name === 'stop' || !control.busy, 'Native calibration is still in flight; no concurrent command');
  if (expectedControl && !sameSession(control, expectedControl))
    return { command: name, status: 'rejected', code: 'SESSION_CHANGED' };
  if (expectedRoundtripSeq !== undefined) {
    const matchingReport = name === 'read_onebot_status'
      ? report?.seq === expectedRoundtripSeq && report.verifiedSameSessionRoundtrip === true && report.postSendChecksIncomplete === false
      : pendingRoundtrip(report, expectedRoundtripSeq);
    if (!matchingReport || report.cleanupPending !== false)
      return { command: name, status: 'rejected', code: 'ROUNDTRIP_STATE_CHANGED' };
  }
  const request = { runId: control.runId, seq: control.lastSeq + 1, command: name,
    params: name === 'arm_inbound_challenge' ? { groupId, ...(readbackOnly && { readbackOnly: true }),
      ...(allowAdminChallenge && { allowAdminChallenge: true }),
      ...(strictReadback && { requireRoundtripMethods: true }) } : {} };
  if (control.deliveryIdentitySupported === true) request.deliveryId = randomBytes(16).toString('hex');
  if (['register_online', 'read_self_status', 'read_online_status', ...integratedCommands].includes(name)) {
    assert(control.authenticationObserved === true && typeof control.authBinding === 'string');
    request.generation = control.generation;
    request.authBinding = control.authBinding;
  }
  const commandFile = path.join(controlDir, 'command.json');
  const existing = readIfPresent(commandFile, 4096);
  if (existing?.runId === control.runId && existing.seq > control.lastSeq) {
    const result = readIfPresent(path.join(output, 'control-result.json'), 65536);
    if (result?.runId !== existing.runId || result.seq !== existing.seq ||
        result.command !== existing.command || result.deliveryId !== existing.deliveryId || result.accepted !== false)
      return { command: name, status: 'rejected', code: 'DELIVERY_PENDING' };
    if (!request.deliveryId && existing.command === name && existing.seq === request.seq)
      return { command: name, status: 'rejected', code: 'DELIVERY_AMBIGUOUS' };
  }
  const temporary = path.join(controlDir, 'command.next');
  fs.writeFileSync(temporary, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, commandFile); break; }
      catch (error) {
        if (!sharingConflict(error) || attempt === 9) throw error;
        await delay(50);
      }
    }
  } catch (error) {
    // Only clean up the staging file created by this delivery. The published
    // command and its result remain available for inspection.
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  const deadline = performance.now() + (integrated ? 12000 : 9000);
  let roundtripResponse;
  while (performance.now() < deadline) {
    await delay(50);
    let response;
    try { response = readJSON(path.join(output, 'control-result.json'), 65536); }
    catch (error) { if (transientObservation(error)) continue; throw error; }
    if (response.runId !== request.runId || response.seq !== request.seq || response.command !== name ||
        response.deliveryId !== request.deliveryId) continue;
    const observed = { accepted: response.accepted, status: response.status, code: response.code,
      command: name, seq: response.seq, onlineProof: response.onlineProof, data: response.data };
    const needsRoundtripReport = response.accepted === true && name === 'verify_onebot_roundtrip';
    if (needsRoundtripReport) roundtripResponse = observed;
    // The driver publishes its sequence after the result. Wait for that
    // publication before issuing a dependent command.
    let roundtripResult;
    if (response.accepted && name !== 'stop') {
      let snapshot;
      try { snapshot = readJSON(path.join(output, 'status.json'), 32768); }
      catch (error) { if (transientObservation(error)) continue; throw error; }
      const { control: current, roundtripResult: report, lastInboundArmFailure } = snapshot;
      if (!current || current.runId !== request.runId || current.lastSeq < request.seq) continue;
      if (needsRoundtripReport) {
        roundtripResult = publicRoundtripResult(report, request.seq, snapshot.roundtripReadbackMode);
        if (!roundtripResult) continue;
      }
      if (name === 'arm_inbound_challenge' && response.status !== 'completed' &&
          lastInboundArmFailure?.seq === request.seq && armStages.includes(lastInboundArmFailure.stage)) {
        const reported = lastInboundArmFailure.missingMethods;
        observed.armFailure = { stage: lastInboundArmFailure.stage,
          ...(Array.isArray(reported) && { missingMethods: armMethods.filter(method => reported.includes(method)) }) };
      }
    }
    return { ...observed, roundtripResult };
  }
  if (roundtripResponse) return { ...roundtripResponse, reportObservation: 'observation-timeout', retry: false };
  return { command: name, seq: request.seq, result: 'observation-timeout', retry: false };
}

function readIfPresent(file, max) {
  try { return readJSON(file, max); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function waitForRoundtripCleanup(seq, expectedControl) {
  const deadline = performance.now() + 8000;
  do {
    const { control, roundtripResult: report } = await readStatus();
    if (!sameSession(control, expectedControl)) return 'SESSION_CHANGED';
    if (!pendingRoundtrip(report, seq)) return 'ROUNDTRIP_STATE_CHANGED';
    if (!control.busy && report.cleanupPending === false) return;
    await delay(100);
  } while (performance.now() < deadline);
  return 'CLEANUP_WAIT_TIMEOUT';
}

async function inspectUnknownRoundtrip(roundtrip, control) {
  const result = {};
  let stage = 'cleanup';
  try {
    const skipped = await waitForRoundtripCleanup(roundtrip.seq, control);
    if (skipped) return { skipped };
    stage = 'inspection';
    result.inspection = await deliver('inspect_unconfirmed_onebot_reply', control, roundtrip.seq);
    if (result.inspection.status === 'completed' && result.inspection.data?.storedTerminalReplyFound === true &&
        result.inspection.data?.pendingOutcomeRetained === true) {
      stage = 'readback';
      result.readback = await deliver('read_confirmed_onebot_reply', control, roundtrip.seq);
    }
  } catch {
    result.error = { stage, code: 'LOCAL_FOLLOW_UP_FAILED' };
  }
  return result;
}

async function collectRoundtripEvidence(roundtrip, control) {
  try {
    const sample = await deliver('read_onebot_status', control, roundtrip.seq);
    if (sample.status !== 'completed') return { status: 'unavailable', code: sample.code ?? 'STATUS_SAMPLE_UNAVAILABLE' };
    return await readSavedLiveEvidence(control, roundtrip.seq, sample.seq);
  } catch {
    return { status: 'unavailable', code: 'LOCAL_EVIDENCE_COLLECTION_FAILED' };
  }
}

async function resampleRoundtripEvidence() {
  const { control, roundtripResult, roundtripReadbackMode } = await readStatus();
  if (roundtripReadbackMode !== 'http-forward-reverse') return readbackModeRejection();
  if (!control?.supportedCommands?.includes('read_onebot_status'))
    return { command, status: 'rejected', code: 'STATUS_SAMPLE_UNAVAILABLE' };
  if (control.authenticationObserved !== true || control.busy !== false || !validRoundtripSequence(control, roundtripResult) ||
      roundtripResult.cleanupPending !== false || roundtripResult.postSendChecksIncomplete !== false ||
      roundtripResult.pendingOutcomePresent !== false || roundtripResult.writeOutcomeUnknown !== false ||
      roundtripResult.commandCompleted !== true || roundtripResult.verifiedSameSessionRoundtrip !== true || !hasThreePathReadback(roundtripResult))
    return { command, status: 'rejected', code: 'ROUNDTRIP_NOT_READY_FOR_EVIDENCE' };
  const evidence = await collectRoundtripEvidence(roundtripResult, control);
  return { ...evidence, command: evidence.status === 'completed' ? evidence.command : command };
}

async function awaitMatchingChallenge(control, deadline, attempt) {
  let observation;
  do {
    observation = await deliver('read_inbound_challenge', control);
    if (observation.status !== 'completed') return observation;
    if (['matched', 'waiting'].includes(observation.data?.state) &&
        (observation.data.readbackOnly === true) !== readbackOnly)
      return { ...observation, result: 'challenge-mode-mismatch', retry: false };
    if (['matched', 'waiting'].includes(observation.data?.state) &&
        (observation.data.allowAdminChallenge === true) !== allowAdminChallenge)
      return { ...observation, result: 'challenge-admin-mode-mismatch', retry: false };
    if (attempt !== undefined && observation.data?.attempt !== attempt)
      return { ...observation, result: 'challenge-changed', retry: false };
    if (observation.data?.state === 'matched') {
      if (observation.data.consumed === true)
        return { ...observation, result: 'matched-challenge-already-consumed', retry: false };
      const { ageMs } = observation.data;
      if (!Number.isSafeInteger(ageMs) || ageMs < 0 || ageMs >= 28000 || performance.now() >= deadline)
        return { ...observation, result: 'matched-challenge-too-old', retry: false };
      const roundtrip = await deliver(command, control);
      if (collectEvidence && roundtrip.status === 'completed' && roundtrip.roundtripResult?.verifiedSameSessionRoundtrip === true &&
          roundtrip.roundtripResult.postSendChecksIncomplete === false && hasThreePathReadback(roundtrip.roundtripResult))
        return { ...roundtrip, liveEvidence: await collectRoundtripEvidence(roundtrip, control) };
      if (!followUp || roundtrip.code !== 'WRITE_OUTCOME_UNKNOWN' ||
          !pendingRoundtrip(roundtrip.roundtripResult, roundtrip.seq))
        return roundtrip;
      return { ...roundtrip, followUp: await inspectUnknownRoundtrip(roundtrip, control) };
    }
    if (observation.data?.state !== 'waiting') break;
    await delay(500);
  } while (performance.now() < deadline);
  return { ...observation, result: 'no-fresh-challenge', retry: false };
}

async function runChallengeCommand() {
  const saved = await readStatus();
  const { control, roundtripReadbackMode, roundtripResult } = saved;
  if (requirePreparation) {
    const readiness = await readRoundtripReadiness(saved);
    if (!readiness.snapshotChecksPassed) return readiness;
  }
  if (incompatibleReadback(roundtripReadbackMode)) return readbackModeRejection();
  if (roundtripCommand && roundtripAlreadyInvoked(control, roundtripResult)) return roundtripRejection();
  if (roundtripCommand && hasPendingWrite(saved)) return pendingWriteRejection(command);
  assert(control?.supportedCommands?.includes(command), 'Command is unavailable in this running host');
  if (followUp) assert(['inspect_unconfirmed_onebot_reply', 'read_confirmed_onebot_reply']
    .every(name => control.supportedCommands.includes(name)), 'Read-only follow-up is unavailable in this running host');
  if (collectEvidence && !control.supportedCommands.includes('read_onebot_status'))
    return { command, status: 'rejected', code: 'STATUS_SAMPLE_UNAVAILABLE' };
  const startedAt = performance.now();
  if (!armAndAwait) return awaitMatchingChallenge(control, startedAt + 180000);
  const armed = await deliver('arm_inbound_challenge', control);
  if (armed.status !== 'completed') return armed;
  const { text, expiresInMs, attempt } = armed.data ?? {};
  if (typeof text !== 'string' || !/^whale-check-[a-f0-9]{32}$/.test(text) ||
      !Number.isSafeInteger(expiresInMs) || expiresInMs < 1 || expiresInMs > 180000 ||
      !Number.isSafeInteger(attempt) || attempt < 1)
    return { command, result: 'invalid-challenge', retry: false };
  const deadline = startedAt + expiresInMs;
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) return { command, result: 'no-fresh-challenge', retry: false };
  console.log(JSON.stringify({ phase: 'challenge-ready', text, expiresInMs: remainingMs, attempt }));
  return awaitMatchingChallenge(control, deadline, attempt);
}

const outcome = await (checkRoundtripReadiness ? readRoundtripReadiness() : resampleLiveEvidence ? resampleRoundtripEvidence() : readLiveEvidence ? readSavedLiveEvidence() : readHostSnapshot ? readSavedHostSnapshot() : readRoundtrip ? readSavedRoundtripResult() :
  awaitChallenge || armAndAwait ? runChallengeCommand() : deliver(command));
console.log(JSON.stringify(outcome));
const report = outcome.roundtripResult;
const roundtripIncomplete = roundtripCommand && outcome.status === 'completed' &&
  (report?.verifiedSameSessionRoundtrip !== true || report.postSendChecksIncomplete === true ||
    (strictReadback && !hasThreePathReadback(report)) || (collectEvidence && outcome.liveEvidence?.threePathRoundtripVerified !== true));
const incompleteResample = resampleLiveEvidence && outcome.threePathRoundtripVerified !== true;
process.exitCode = outcome.result ? 3 : !roundtripIncomplete && !incompleteResample && ['completed', 'stopped'].includes(outcome.status) ? 0 : 2;
