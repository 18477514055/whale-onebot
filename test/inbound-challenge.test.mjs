import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { InboundChallenge, isVerifiedProtectedChallenge } from '../src/host/inbound-challenge.mjs';
import { CalibrationControl, CalibrationOperationError } from '../src/host/calibration-control.mjs';
import { manageOneBotProcess } from '../src/host/onebot-process.mjs';
import { OfflineBridge } from '../src/core.mjs';
import { checkOfflineOneBot, checkOfflineRoundtripReverse, checkRoundtripReverseReady, createSendReceiptObservation, findSubmittedReply,
  observeOneBotReverseEndpoint, observeOneBotReverseStatus, openRoundtripReverseReceiver, probeRoundtripReverseReceiver,
  verifyConfirmedReplyReadback, verifyOneBotReceive } from '../src/host/onebot-receive-check.mjs';

import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';
const makeMessage = (text, overrides = {}) => ({
  chatType: 2, senderUin: '10001', peerUid: '20001', msgId: '90071992547409931', msgTime: '1700000000',
  elements: [{ elementType: 1, textElement: { content: text } }], ...overrides,
});

for (const scenario of ['through follow-up', 'after a local readback error', 'when the evidence sample is replaced']) test(`command client preserves the roundtrip result ${scenario}`, async t => {
  const failReadback = scenario === 'after a local readback error';
  const sampleReplaced = scenario === 'when the evidence sample is replaced';
  const tmp = path.resolve(import.meta.dirname, '../.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmp, 'calibration-client-'));
  const profile = 'login-0123456789abcdef0123';
  const output = path.join(root, 'runtime', 'integrated', profile);
  const controlDir = path.join(root, 'runtime', 'integrated-control', profile);
  const script = path.join(root, 'scripts', 'calibration-command.mjs');
  for (const dir of [output, controlDir, path.dirname(script)]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '../scripts/calibration-command.mjs'), script);
  const observations = path.join(root, 'src', 'host', 'online-observation.mjs');
  fs.mkdirSync(path.dirname(observations), { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '../src/host/online-observation.mjs'), observations);
  const runId = profile;
  const writeAtomic = async (name, data) => {
    const destination = path.join(output, name);
    fs.writeFileSync(destination + '.next', JSON.stringify(data));
    // Windows can deny a replacement while the child temporarily reads it.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(destination + '.next', destination); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt === 19) throw error;
        await delay(10);
      }
    }
  };
  let roundtripReadbackMode;
  const publish = (lastSeq, roundtripResult, roundtripMessageRead, busy = false, extra = {}) => writeAtomic('status.json', { control: {
    runId, lastSeq, generation: 1, authenticationObserved: true, authBinding: 'fixture',
    deliveryIdentitySupported: true, busy,
    supportedCommands: ['arm_inbound_challenge', 'read_inbound_challenge', 'verify_onebot_roundtrip',
      'inspect_unconfirmed_onebot_reply', 'read_confirmed_onebot_reply', 'read_onebot_status'],
  }, roundtripResult, roundtripMessageRead, roundtripReadbackMode, ...extra });
  await publish(0);
  const strictOption = '--require-three-path-readback';
  const locked = spawnSync(process.execPath, [script, output, 'verify_onebot_roundtrip', '--arm-group', '20001', strictOption],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(locked.status, 2, locked.stderr);
  assert.deepEqual(JSON.parse(locked.stdout), { command: 'verify_onebot_roundtrip', status: 'rejected', code: 'THREE_PATH_READBACK_UNAVAILABLE' });
  assert.deepEqual(fs.readdirSync(controlDir), []);
  roundtripReadbackMode = 'http-forward-reverse';
  await publish(0);
  const shim = path.join(root, 'sharing-conflict.mjs');
  const simulateSharingConflict = process.platform === 'win32' && !failReadback;
  if (simulateSharingConflict) fs.writeFileSync(shim, `
    import fs from 'node:fs';
    const rename = fs.renameSync;
    let conflicted = false;
    fs.renameSync = (source, destination) => {
      if (!conflicted && source.endsWith('command.next')) {
        conflicted = true;
        process.stderr.write('synthetic sharing conflict observed\\n');
        throw Object.assign(new Error('Simulated file sharing conflict'), { code: 'EPERM' });
      }
      return rename(source, destination);
    };
  `);
  const child = spawn(process.execPath, [...(simulateSharingConflict ? ['--import', pathToFileURL(shim).href] : []),
    script, output, 'verify_onebot_roundtrip', '--arm-group', '20001', strictOption,
    ...(!failReadback ? ['--collect-evidence'] : [])]);
  const exited = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(tmp));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let stdout = '', stderr = '';
  let followUpOutput = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const readCommand = () => {
    try { return JSON.parse(fs.readFileSync(path.join(controlDir, 'command.json'), 'utf8')); }
    catch (error) { if (['ENOENT', 'ENODATA'].includes(error.code)) return null; throw error; }
  };
  const expectCommand = async (seq, command, client = child) => {
    const signal = AbortSignal.timeout(10000);
    let request;
    while ((request = readCommand())?.seq !== seq) {
      assert.equal(client.exitCode, null, stderr || followUpOutput || 'Command client exited before publishing ' + command);
      await delay(15, undefined, { signal });
    }
    assert.equal(request.command, command);
    assert.equal(request.authBinding, command === 'read_onebot_status' ? undefined : 'fixture');
    return request;
  };
  const respond = ({ seq, command, deliveryId }, data) => writeAtomic('control-result.json',
    { accepted: true, status: 'completed', runId, seq, command, deliveryId, data });
  const arm = await expectCommand(1, 'arm_inbound_challenge');
  assert.deepEqual(arm.params, { groupId: '20001', requireRoundtripMethods: true });
  const text = 'whale-check-' + 'f'.repeat(32);
  await respond(arm, { text, expiresInMs: 180000, attempt: 1 });
  await delay(80);
  assert.equal(stdout, '');
  await publish(1);
  const observation = await expectCommand(2, 'read_inbound_challenge');
  const competing = spawnSync(process.execPath, [script, output, 'read_onebot_status'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(competing.status, 2, competing.stderr);
  assert.equal(JSON.parse(competing.stdout).code, 'DELIVERY_BUSY');
  assert.equal(readCommand().seq, 2);
  await respond(observation, { state: 'matched', ageMs: 10, attempt: 1 });
  await delay(200);
  assert.equal(readCommand().seq, 2);
  await publish(2);
  const roundtrip = await expectCommand(3, 'verify_onebot_roundtrip');
  assert.match(roundtrip.deliveryId, /^[a-f0-9]{32}$/);
  await writeAtomic('control-result.json', { accepted: false, status: 'rejected', runId,
    seq: 3, command: 'verify_onebot_roundtrip', deliveryId: 'a'.repeat(32) });
  await delay(150);
  assert.equal(child.exitCode, null);
  await respond(roundtrip, { oneBotSendConfirmed: true });
  const initialResult = { seq: 3, commandCompleted: true, offlineEndpointRestored: true,
    groupInfoVerified: false, verifiedSameSessionRoundtrip: true, messageReadbackVerified: true,
    reverseConnected: true, reverseEventVerified: true, reverseOfflineVerified: true, terminalMessageIdVerified: true,
    ...(!failReadback && { forwardMessageReadbackVerified: true, reverseMessageReadbackVerified: true,
      inboundVerified: true, outboundVerified: true, oneBotRestartVerified: true, bridgeReattachmentVerified: true,
      writeOutcomeUnknown: false, pendingOutcomePresent: false, cleanupPending: false, postSendChecksIncomplete: false,
      messageReadbackAttempted: true, httpOfflineVerified: true, webSocketOfflineVerified: true }),
    ...(failReadback && { postSendChecksIncomplete: false, outboundVerified: true, forwardMessageReadbackVerified: true }) };
  await publish(3, { ...initialResult, seq: 2 });
  await delay(175);
  assert.equal(child.exitCode, null, stderr || stdout);
  assert.equal(readCommand().deliveryId, roundtrip.deliveryId);
  await publish(3, { ...initialResult,
    authBinding: 'fixture-hidden-binding', token: 'fixture-hidden-token' });
  if (!failReadback) {
    const sample = await expectCommand(4, 'read_onebot_status');
    const offline = { endpointResponded: true, status: { online: false, good: false } };
    const data = { ...offline, webSocket: offline, reverseWebSocket: { ...offline, connected: true, pongVerified: true },
      sessionHold: { state: 'active' }, nativeSession: { checked: true, matchesAuthenticatedSession: true } };
    await respond(sample, data);
    const recordedSample = sampleReplaced ? 5 : 4;
    await publish(recordedSample, initialResult, { attempted: true, verified: true }, false, {
      at: new Date().toISOString(), inputManifestSha256: 'a'.repeat(64), exactInputInventory: true,
      identityMatches: true, sessionGeneration: 1, qrRequests: 1, sessionInitAttempts: 1, automaticRetry: false,
      roundtripSendResponse: { httpStatus: 200, retcode: 0 }, roundtripReceiptObservation: { terminalSuccessWithValidId: 1 },
      postRoundtripStatus: { seq: recordedSample, roundtripSeq: 3, sessionGeneration: 1, data },
    });
  }
  assert.deepEqual(await exited, [failReadback || sampleReplaced ? 2 : 0, null], stderr);
  if (simulateSharingConflict) assert.match(stderr, /synthetic sharing conflict observed/);
  assert(!fs.existsSync(path.join(controlDir, 'command.next')));
  const [readyLine, resultLine] = stdout.trim().split(/\r?\n/);
  const ready = JSON.parse(readyLine);
  assert.equal(ready.phase, 'challenge-ready');
  assert.equal(ready.text, text);
  assert.equal(ready.attempt, 1);
  assert(ready.expiresInMs > 0 && ready.expiresInMs < 180000);
  const outcome = JSON.parse(resultLine);
  assert.equal(outcome.data.oneBotSendConfirmed, true);
  assert.deepEqual(outcome.roundtripResult, failReadback
    ? { ...initialResult, verifiedSameSessionRoundtrip: false, postSendChecksIncomplete: true } : initialResult);
  assert(!stdout.includes('fixture-hidden'));
  assert(!stdout.includes(roundtrip.deliveryId));
  let lastCommand = failReadback ? 3 : 4;
  if (!failReadback) {
    if (sampleReplaced) {
      assert.equal(outcome.liveEvidence.code, 'LIVE_ROUNDTRIP_EVIDENCE_UNAVAILABLE');
      const recovery = spawn(process.execPath, [script, output, 'collect_live_roundtrip_evidence']);
      const recoveryExit = once(recovery, 'close');
      t.after(async () => { if (recovery.exitCode === null) recovery.kill(); await recoveryExit; });
      let recoveredOutput = '';
      recovery.stdout.on('data', value => { recoveredOutput += value; });
      const sample = await expectCommand(6, 'read_onebot_status', recovery);
      const saved = JSON.parse(fs.readFileSync(path.join(output, 'status.json'), 'utf8'));
      await respond(sample, saved.postRoundtripStatus.data);
      await writeAtomic('status.json', { ...saved, control: { ...saved.control, lastSeq: 6 },
        postRoundtripStatus: { ...saved.postRoundtripStatus, seq: 6 } });
      assert.deepEqual(await recoveryExit, [0, null]);
      const result = JSON.parse(recoveredOutput);
      assert.equal(result.command, 'read_live_roundtrip_evidence');
      assert.equal(result.threePathRoundtripVerified, true);
      assert.equal(result.evidence.roundtripResult.seq, 3);
      assert.equal(result.evidence.postRoundtripStatus.seq, 6);
      await publish(6, { ...initialResult, cleanupPending: true });
      const incomplete = spawnSync(process.execPath, [script, output, 'collect_live_roundtrip_evidence'],
        { encoding: 'utf8', timeout: 5000 });
      assert.equal(incomplete.status, 2);
      assert.equal(JSON.parse(incomplete.stdout).code, 'ROUNDTRIP_NOT_READY_FOR_EVIDENCE');
      lastCommand = 6;
    }
    else {
      assert.equal(outcome.liveEvidence.threePathRoundtripVerified, true);
      assert.equal(outcome.liveEvidence.evidence.postRoundtripStatus.seq, 4);
    }
    await publish(3, initialResult);
  }
  assert.equal(readCommand().seq, lastCommand);
  assert.equal(fs.existsSync(path.join(controlDir, 'delivery.lock')), false);
  if (sampleReplaced) return;
  await writeAtomic('control-result.json', { accepted: true, runId, seq: 3, command: 'verify_onebot_roundtrip' });
  fs.writeFileSync(path.join(controlDir, 'command.json'), JSON.stringify({ runId, seq: 4, command: 'read_inbound_challenge' }));
  const pending = spawnSync(process.execPath, [script, output, 'read_inbound_challenge'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(pending.status, 2, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).code, 'DELIVERY_PENDING');
  assert.equal(readCommand().seq, 4);

  const commandFile = path.join(controlDir, 'command.json');
  const lockFile = path.join(controlDir, 'delivery.lock');
  const publishedCommand = fs.readFileSync(commandFile, 'utf8');
  fs.writeFileSync(lockFile, 'another delivery');
  const readReport = (status = 0) => {
    const result = spawnSync(process.execPath, [script, output, 'read_roundtrip_result'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, status, result.stderr);
    assert(!result.stdout.includes('fixture-hidden'));
    return JSON.parse(result.stdout);
  };
  await publish(3, { seq: 3, cleanupPending: true, outboundVerified: true, token: 'fixture-hidden-token' });
  assert.deepEqual(readReport().roundtripResult, { seq: 3, cleanupPending: true, outboundVerified: true, postSendChecksIncomplete: true });
  await publish(3, { seq: 3, cleanupPending: false, outboundVerified: true, offlineEndpointRestored: true });
  assert.deepEqual(readReport().roundtripResult,
    { seq: 3, cleanupPending: false, outboundVerified: true, offlineEndpointRestored: true, postSendChecksIncomplete: true });
  await publish(3, { seq: 3, outboundVerified: true, verifiedSameSessionRoundtrip: true,
    postSendChecksIncomplete: false, messageReadbackAttempted: true, messageReadbackVerified: false });
  const legacy = readReport().roundtripResult;
  assert.equal(legacy.outboundVerified, true);
  assert.equal(legacy.postSendChecksIncomplete, true);
  assert.equal(legacy.verifiedSameSessionRoundtrip, false);
  const beforeRecheck = JSON.parse(fs.readFileSync(path.join(output, 'status.json'), 'utf8'));
  const rechecked = { ...beforeRecheck, sessionGeneration: 1, control: { ...beforeRecheck.control, lastSeq: 4 },
    confirmedReplyReadback: { roundtripSeq: 3, seq: 4, generation: 1, attempted: true, verified: true,
      outcome: 'verified', text: 'fixture-hidden' } };
  await writeAtomic('status.json', rechecked);
  const withRecheck = readReport();
  assert.deepEqual(withRecheck.replyRecheck, { seq: 4, attempted: true, verified: true, outcome: 'verified' });
  assert.deepEqual(withRecheck.roundtripResult, legacy);
  await writeAtomic('status.json', { ...rechecked, confirmedReplyReadback: { ...rechecked.confirmedReplyReadback,
    attempted: false, verified: false, outcome: 'service-start-failed' } });
  assert.deepEqual(readReport().replyRecheck, { seq: 4, attempted: false, verified: false, outcome: 'service-start-failed' });
  for (const patch of [{ roundtripSeq: 2 }, { generation: 2 }, { seq: 5 }]) {
    await writeAtomic('status.json', { ...rechecked, confirmedReplyReadback: { ...rechecked.confirmedReplyReadback, ...patch } });
    assert.equal(readReport().replyRecheck, undefined);
  }
  await publish(3, { seq: 3, reverseConnected: false, reverseEventVerified: false, nativeSubmissionAttempted: false,
    receiverToken: 'fixture-hidden-token' });
  assert.deepEqual(readReport().roundtripResult,
    { seq: 3, reverseConnected: false, reverseEventVerified: false, nativeSubmissionAttempted: false });
  await publish(3, { seq: 3, messageReadbackAttempted: true, messageReadbackVerified: false },
    { attempted: true, verified: false, outcome: 'onebot-rejected', nativeOutcome: 'empty', raw: 'fixture-hidden' });
  assert.deepEqual(readReport().messageReadback, { outcome: 'onebot-rejected', nativeOutcome: 'empty' });
  await publish(3, { seq: 4, outboundVerified: true });
  assert.equal(readReport(2).code, 'ROUNDTRIP_REPORT_UNAVAILABLE');
  const savedStatus = JSON.parse(fs.readFileSync(path.join(output, 'status.json'), 'utf8'));
  const observedAt = '2026-11-13T23:13:53.251Z';
  await writeAtomic('status.json', { ...savedStatus, phase: 'session-ready-observed', at: observedAt,
    calibrationHoldLimitMs: 86400000, sessionGeneration: 1, businessOnlineVerified: false,
    roundtripReadbackMode: undefined,
    control: { ...savedStatus.control, supportedCommands: [...savedStatus.control.supportedCommands, 'fixture-hidden-command'] },
    accessToken: 'fixture-hidden-token' });
  const host = spawnSync(process.execPath, [script, output, 'read_host_snapshot'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(host.status, 0, host.stderr);
  assert.deepEqual(JSON.parse(host.stdout), { command: 'read_host_snapshot', status: 'completed', data: {
    phase: 'session-ready-observed', observedAt, holdLimitMs: 86400000, sessionGeneration: 1,
    businessOnlineVerifiedAtSnapshot: false,
    supportedCommands: ['read_onebot_status', 'read_confirmed_onebot_reply', 'inspect_unconfirmed_onebot_reply', 'arm_inbound_challenge',
      'read_inbound_challenge', 'verify_onebot_roundtrip'],
    controlBusy: false, authenticationObserved: true, roundtripReadbackMode: 'unreported',
  } });
  assert(!host.stdout.includes('fixture-hidden'));
  const getLiveEvidence = () => spawnSync(process.execPath, [script, output, 'read_live_roundtrip_evidence'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(JSON.parse(getLiveEvidence().stdout).code, 'LIVE_ROUNDTRIP_EVIDENCE_UNAVAILABLE');
  const endpoint = { endpointResponded: true, status: { online: false, good: false, token: 'fixture-hidden-token' },
    sessionHold: { state: 'active' },
    nativeSession: { checked: true, matchesAuthenticatedSession: true, raw: 'fixture-hidden-session' } };
  const live = { ...savedStatus, at: observedAt, inputManifestSha256: 'a'.repeat(64), sessionGeneration: 1,
    exactInputInventory: true, identityMatches: true, qrRequests: 1, sessionInitAttempts: 1, automaticRetry: false,
    control: { ...savedStatus.control, lastSeq: 4, busy: false }, roundtripReadbackMode: undefined,
    roundtripResult: { ...initialResult, oneBotRestartVerified: true, bridgeReattachmentVerified: true,
      outboundVerified: true, writeOutcomeUnknown: false, pendingOutcomePresent: false, cleanupPending: false,
      httpOfflineVerified: true, messageReadbackAttempted: true },
    roundtripSendResponse: { httpStatus: 200, retcode: 0 }, roundtripReceiptObservation: { terminalSuccessWithValidId: 1 },
    roundtripMessageRead: { attempted: true, verified: true },
    postRoundtripStatus: { seq: 4, roundtripSeq: 3, sessionGeneration: 1, data: endpoint } };
  await writeAtomic('status.json', live);
  const exported = getLiveEvidence();
  assert.equal(exported.status, 0, exported.stderr);
  const publicEvidence = JSON.parse(exported.stdout);
  assert.equal(publicEvidence.evidence.roundtripResult.seq, 3);
  assert.deepEqual(publicEvidence.transportCoverage.http.businessActions, ['get_msg', 'send_group_msg']);
  assert.equal(publicEvidence.threePathRoundtripVerified, false);
  assert.equal(publicEvidence.postRoundtripSessionVerified, true);
  assert.deepEqual(publicEvidence.evidence.postRoundtripStatus.data.nativeSession, { checked: true, matchesAuthenticatedSession: true });
  assert(!exported.stdout.includes('fixture-hidden'));
  await writeAtomic('status.json', { ...live, postRoundtripStatus: undefined, roundtripResult: { ...live.roundtripResult,
    commandCompleted: false, terminalMessageIdVerified: true, postSendChecksIncomplete: true, verifiedSameSessionRoundtrip: false } });
  const partial = getLiveEvidence();
  assert.equal(partial.status, 0, partial.stderr);
  const partialEvidence = JSON.parse(partial.stdout);
  assert.equal(partialEvidence.evidence.postRoundtripStatus, null);
  assert.equal(partialEvidence.threePathRoundtripVerified, false);
  assert.deepEqual(partialEvidence.transportCoverage.http, { businessActions: ['get_msg', 'send_group_msg'], offlineStatusVerified: false });
  assert(!partial.stdout.includes('fixture-hidden'));
  await writeAtomic('status.json', { ...live, postRoundtripStatus: { ...live.postRoundtripStatus, roundtripSeq: 2 } });
  assert.equal(JSON.parse(getLiveEvidence().stdout).code, 'LIVE_ROUNDTRIP_EVIDENCE_UNAVAILABLE');
  await writeAtomic('status.json', { ...savedStatus, phase: 'session-ready-observed', at: observedAt,
    roundtripReadbackMode: 'http-forward-reverse', sessionGeneration: 1,
    calibrationHoldLimitMs: 86400000, sessionHold: { state: 'active', remainingMs: 7200000, secret: 'fixture-hidden' },
    roundtripResult: { seq: 3 },
    control: { ...savedStatus.control, roundtripInvoked: true } });
  const updated = spawnSync(process.execPath, [script, output, 'read_host_snapshot'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(updated.status, 0, updated.stderr);
  const snapshotFields = JSON.parse(updated.stdout).data;
  assert.deepEqual(snapshotFields.sessionHoldAtSnapshot, { state: 'active', remainingMs: 7200000 });
  assert(!updated.stdout.includes('fixture-hidden'));
  const updatedFile = JSON.parse(fs.readFileSync(path.join(output, 'status.json'), 'utf8'));
  await writeAtomic('status.json', { ...updatedFile, sessionHold: { state: 'active', remainingMs: 86400001 } });
  const invalidHold = spawnSync(process.execPath, [script, output, 'read_host_snapshot'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(invalidHold.status, 0, invalidHold.stderr);
  assert.equal(JSON.parse(invalidHold.stdout).data.sessionHoldAtSnapshot, undefined);
  assert.equal(snapshotFields.roundtripReadbackMode, 'http-forward-reverse');
  assert.equal(snapshotFields.recordedRoundtripSeq, 3);
  assert.equal(snapshotFields.roundtripInvoked, true);
  const attempted = spawnSync(process.execPath, [script, output, 'verify_onebot_roundtrip', '--arm-group', '20001', strictOption],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(attempted.status, 2, attempted.stderr);
  assert.equal(JSON.parse(attempted.stdout).code, 'ROUNDTRIP_ALREADY_ATTEMPTED');
  const retryArgs = [script, output, 'verify_onebot_roundtrip', '--arm-group', '20001', strictOption];
  const provenNotStarted = { seq: 3, noNativeSubmission: true, nativeSubmissionAttempted: false,
    writeOutcomeUnknown: false, pendingOutcomePresent: false, cleanupPending: false, outboundVerified: false };
  const retryStatus = { ...updatedFile, at: new Date().toISOString(), control: { ...updatedFile.control, roundtripInvoked: false, busy: false } };
  const readiness = (...args) => spawnSync(process.execPath, [script, output, 'check_roundtrip_readiness', ...args],
    { encoding: 'utf8', timeout: 5000 });
  const blockedReadiness = readiness();
  assert.equal(blockedReadiness.status, 2, blockedReadiness.stderr);
  assert.deepEqual(JSON.parse(blockedReadiness.stdout).blockers, ['ROUNDTRIP_ALREADY_ATTEMPTED', 'SESSION_HOLD_UNCONFIRMED']);
  await writeAtomic('status.json', { ...retryStatus, roundtripResult: provenNotStarted });
  const readyForReview = readiness();
  assert.equal(readyForReview.status, 0, readyForReview.stderr);
  assert.equal(JSON.parse(readyForReview.stdout).snapshotChecksPassed, true);
  assert(!readyForReview.stdout.includes('fixture-hidden'));
  await writeAtomic('status.json', { ...retryStatus, roundtripResult: provenNotStarted,
    control: { ...retryStatus.control, writeState: 'unknown' } });
  const unknownRegistration = readiness();
  assert.equal(unknownRegistration.status, 2, unknownRegistration.stderr);
  assert.deepEqual(JSON.parse(unknownRegistration.stdout).blockers, ['PENDING_WRITE_OUTCOME']);
  const preflightRejectsUnknown = spawnSync(process.execPath, [...retryArgs, '--require-preparation'],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(preflightRejectsUnknown.status, 2, preflightRejectsUnknown.stderr);
  assert(JSON.parse(preflightRejectsUnknown.stdout).blockers.includes('PENDING_WRITE_OUTCOME'));
  fs.unlinkSync(lockFile);
  for (const args of [['verify_onebot_roundtrip'], ['verify_onebot_roundtrip', '--arm-group', '20001'],
    ['verify_onebot_roundtrip', '--await-challenge'], ['register_online']]) {
    const rejected = spawnSync(process.execPath, [script, output, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).code, 'PENDING_WRITE_OUTCOME');
  }
  fs.writeFileSync(lockFile, 'another delivery', { flag: 'wx' });
  assert.equal(fs.readFileSync(commandFile, 'utf8'), publishedCommand);
  await writeAtomic('status.json', { ...retryStatus, roundtripResult: provenNotStarted });
  const comparison = readiness('--compare-preparation');
  assert.equal(comparison.status, 2, comparison.stderr);
  assert.deepEqual(JSON.parse(comparison.stdout).blockers, ['PREPARATION_EVIDENCE_UNAVAILABLE']);
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir);
  const build = 'a'.repeat(64);
  fs.writeFileSync(path.join(evidenceDir, 'integrated-login-preparation-linux.json'), JSON.stringify({ networkShared: false,
    qqExecuted: true, mountedInputsVerifiedAtExit: true, inputContentSha256: build, splitOneBotPorts: true,
    observed: { status: 0, phase: 'login-service-initialized-offline', loginConnectAttempts: 0, qrRequests: 0, initAttempts: 0 } }));
  const readinessStatus = { ...retryStatus, roundtripResult: provenNotStarted, inputContentSha256: build, splitOneBotPorts: true };
  await writeAtomic('status.json', readinessStatus);
  const sameBuild = readiness('--compare-preparation');
  assert.equal(sameBuild.status, 0, sameBuild.stderr);
  assert.deepEqual(JSON.parse(sameBuild.stdout).data.preparationComparison, { contentMatches: true, portModeMatches: true });
  await writeAtomic('status.json', { ...readinessStatus, inputContentSha256: 'b'.repeat(64), splitOneBotPorts: false });
  const differentBuild = readiness('--compare-preparation');
  assert.equal(differentBuild.status, 2, differentBuild.stderr);
  assert.deepEqual(JSON.parse(differentBuild.stdout).blockers, ['PREPARATION_CONTENT_MISMATCH', 'PREPARATION_PORT_MODE_MISMATCH']);
  const guardedRoundtrip = () => spawnSync(process.execPath, [...retryArgs, '--require-preparation'],
    { encoding: 'utf8', timeout: 5000 });
  const rejectedBuild = guardedRoundtrip();
  assert.equal(rejectedBuild.status, 2, rejectedBuild.stderr);
  assert.deepEqual(JSON.parse(rejectedBuild.stdout).blockers, ['PREPARATION_CONTENT_MISMATCH', 'PREPARATION_PORT_MODE_MISMATCH']);
  await writeAtomic('status.json', readinessStatus);
  const matchedBuild = guardedRoundtrip();
  assert.equal(matchedBuild.status, 2, matchedBuild.stderr);
  assert.equal(JSON.parse(matchedBuild.stdout).code, 'DELIVERY_BUSY');
  assert.equal(fs.readFileSync(commandFile, 'utf8'), publishedCommand);
  const expired = { ...retryStatus, at: new Date(Date.now() - 7200001).toISOString(), roundtripResult: provenNotStarted };
  await writeAtomic('status.json', expired);
  const expiredReadiness = readiness();
  assert.equal(expiredReadiness.status, 2, expiredReadiness.stderr);
  assert.deepEqual(JSON.parse(expiredReadiness.stdout).blockers, ['SESSION_HOLD_EXPIRED']);
  await writeAtomic('status.json', { ...expired, at: new Date(Date.now() + 60000).toISOString() });
  const ahead = readiness();
  assert.equal(ahead.status, 2, ahead.stderr);
  assert.deepEqual(JSON.parse(ahead.stdout).blockers, ['SESSION_HOLD_UNCONFIRMED']);
  await writeAtomic('status.json', { ...retryStatus, roundtripResult: provenNotStarted });
  const retry = spawnSync(process.execPath, retryArgs, { encoding: 'utf8', timeout: 5000 });
  assert.equal(JSON.parse(retry.stdout).code, 'DELIVERY_BUSY');
  await writeAtomic('status.json', { ...retryStatus, roundtripResult: { ...provenNotStarted, pendingOutcomePresent: true } });
  const pendingReadiness = readiness();
  assert.equal(pendingReadiness.status, 2, pendingReadiness.stderr);
  assert.deepEqual(JSON.parse(pendingReadiness.stdout).blockers, ['ROUNDTRIP_ALREADY_ATTEMPTED', 'PENDING_WRITE_OUTCOME']);
  const unsafeRetry = spawnSync(process.execPath, retryArgs, { encoding: 'utf8', timeout: 5000 });
  assert.equal(JSON.parse(unsafeRetry.stdout).code, 'ROUNDTRIP_ALREADY_ATTEMPTED');
  assert.equal(fs.readFileSync(commandFile, 'utf8'), publishedCommand);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'another delivery');

  fs.unlinkSync(lockFile);
  await publish(4);
  const followUpClient = spawn(process.execPath, [script, output, 'verify_onebot_roundtrip', '--await-challenge', '--inspect-unknown']);
  const followUpExited = once(followUpClient, 'close');
  t.after(() => { if (followUpClient.exitCode === null) followUpClient.kill(); });
  followUpClient.stdout.on('data', chunk => { followUpOutput += chunk; });
  const matched = await expectCommand(5, 'read_inbound_challenge', followUpClient);
  await respond(matched, { state: 'matched', ageMs: 10, attempt: 1 });
  await publish(5);
  const submitted = await expectCommand(6, 'verify_onebot_roundtrip', followUpClient);
  await writeAtomic('control-result.json', { accepted: true, status: 'unknown', code: 'WRITE_OUTCOME_UNKNOWN',
    runId, seq: submitted.seq, command: submitted.command, deliveryId: submitted.deliveryId });
  const unknownReport = { seq: 6, writeOutcomeUnknown: true, pendingOutcomePresent: true, cleanupPending: false };
  const waitingReport = { ...unknownReport, cleanupPending: true };
  await publish(6, waitingReport, undefined, true);
  await delay(250);
  assert.equal(readCommand().seq, 6);
  assert.equal(followUpClient.exitCode, null);
  assert.equal(fs.existsSync(lockFile), false);
  await publish(6, unknownReport);
  const inspection = await expectCommand(7, 'inspect_unconfirmed_onebot_reply', followUpClient);
  assert.deepEqual(inspection.params, {});
  await respond(inspection, { attempted: true, storedTerminalReplyFound: true, pendingOutcomeRetained: true });
  await publish(7, unknownReport);
  const readback = await expectCommand(8, 'read_confirmed_onebot_reply', followUpClient);
  assert.deepEqual(readback.params, {});
  if (failReadback) {
    // A malformed local response must not erase the known send outcome.
    fs.writeFileSync(path.join(output, 'control-result.json'), 'fixture-hidden-invalid');
  } else {
    await respond(readback, { attempted: true, verified: true });
    await publish(8, unknownReport);
  }
  assert.deepEqual(await followUpExited, [2, null]);
  const unknown = JSON.parse(followUpOutput);
  assert.equal(unknown.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.deepEqual(unknown.roundtripResult, waitingReport);
  assert.equal(unknown.followUp.inspection.data.pendingOutcomeRetained, true);
  if (failReadback) {
    assert.deepEqual(unknown.followUp.error, { stage: 'readback', code: 'LOCAL_FOLLOW_UP_FAILED' });
    assert.equal(unknown.followUp.readback, undefined);
    assert(!followUpOutput.includes('fixture-hidden-invalid'));
  } else assert.equal(unknown.followUp.readback.data.verified, true);
  assert.equal(readCommand().seq, 8);
  const snapshot = JSON.parse(fs.readFileSync(path.join(output, 'status.json'), 'utf8'));
  const savedInspection = { attempted: true, storedTerminalReplyFound: true, pendingOutcomeRetained: true };
  const savedReadback = { attempted: true, verified: !failReadback, pendingOutcomeRetained: true };
  for (const seq of [5, 6]) {
    await writeAtomic('status.json', { ...snapshot, roundtripFollowUp: {
      seq, inspection: { ...savedInspection, token: 'fixture-hidden-secret' },
      readback: { ...savedReadback, raw: 'fixture-hidden-reply' },
    } });
    const saved = readReport();
    assert.equal(saved.roundtripResult.writeOutcomeUnknown, true);
    assert.equal(saved.roundtripResult.pendingOutcomePresent, true);
    assert.deepEqual(saved.followUp, seq === 6 ? { inspection: savedInspection, readback: savedReadback } : undefined);
    assert.equal(readCommand().seq, 8);
  }
  if (!failReadback) {
    await publish(8);
    const nextClient = spawn(process.execPath, [script, output, 'verify_onebot_roundtrip', '--arm-group', '20001', strictOption]);
    t.after(() => { if (nextClient.exitCode === null) nextClient.kill(); });
    const exited = once(nextClient, 'close');
    let nextOutput = '';
    nextClient.stdout.on('data', chunk => { nextOutput += chunk; });
    const arm = await expectCommand(9, 'arm_inbound_challenge', nextClient);
    await writeAtomic('control-result.json', { accepted: true, status: 'failed', code: 'ADAPTER_NOT_STARTED',
      runId, seq: arm.seq, command: arm.command, deliveryId: arm.deliveryId });
    const status = JSON.parse(fs.readFileSync(path.join(output, 'status.json'), 'utf8'));
    await writeAtomic('status.json', { ...status, control: { ...status.control, lastSeq: 9 },
      roundtripReadbackMode: 'http-forward-reverse', lastInboundArmFailure: { seq: arm.seq, stage: 'check-message-methods',
      missingMethods: ['getMsgsByMsgId', 'fixture-hidden-field'] } });
    assert.deepEqual(await exited, [2, null]);
    const result = JSON.parse(nextOutput);
    assert.equal(result.code, 'ADAPTER_NOT_STARTED');
    assert.deepEqual(result.armFailure, { stage: 'check-message-methods', missingMethods: ['getMsgsByMsgId'] });
    assert.equal(readCommand().seq, 9);
    assert(!nextOutput.includes('fixture-hidden-field'));
  }
});

test('one-shot listener matches exact plain text only in the assigned group and session', () => {
  let now = 10;
  const inbound = new InboundChallenge(() => now);
  const { text } = inbound.arm(1, '20001');
  assert.match(text, /^whale-check-[a-f0-9]{32}$/);
  assert.throws(() => inbound.arm(1, '20001'));
  const valid = makeMessage(text);
  inbound.observe([valid], 2);
  inbound.observe([
    makeMessage(text + ' '),
    makeMessage(text, { chatType: 1 }),
    makeMessage(text, { peerUid: '20002' }),
    makeMessage(text, { senderUin: OWNER_UIN }),
    makeMessage(text, { senderUin: BOT_UIN }),
    makeMessage(text, { elements: [{ elementType: 1, textElement: { content: text, atType: 2 } }] }),
  ], 1);
  inbound.observe(Array(129).fill(valid), 1);
  assert.deepEqual(inbound.status(1), { state: 'waiting', attempt: 1, callbacks: 2,
    testGroupCandidates: 4, eligibleTestGroupMessages: 2 });
  inbound.observe([makeMessage(text, { senderUin: 10001, peerUid: 20001,
    elements: [text.slice(0, 10), text.slice(10)].map(content => ({
      elementType: 1, textElement: { content },
    })) })], 1);
  now += 100;
  assert.deepEqual(inbound.status(1), { state: 'matched', groupMessageObserved: true, ageMs: 100,
    consumed: false, attempt: 1, callbacks: 3, testGroupCandidates: 5, eligibleTestGroupMessages: 3 });
  assert.throws(() => inbound.arm(1, '20001'));
  assert.deepEqual(inbound.status(2), { state: 'unarmed' });
  assert.equal(inbound.takeRecent(2), null);
  assert.equal(inbound.takeRecent(1).elements[0].textElement.content, text);
  assert.equal(inbound.takeRecent(1), null);
  assert.equal(inbound.status(1).consumed, true);
});

test('fresh inbound record traverses authenticated loopback WebSocket with no send capability', async () => {
  const tmp = path.resolve(import.meta.dirname, '../.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const parent = fs.mkdtempSync(path.join(tmp, 'onebot-receive-'));
  const projectRoot = path.join(parent, 'qq-onebot');
  fs.mkdirSync(projectRoot);
  const inbound = new InboundChallenge();
  const { text } = inbound.arm(1, '20001');
  inbound.observe([makeMessage(text)], 1);
  try {
    assert.deepEqual(await verifyOneBotReceive({
      projectRoot, takeMessage: () => inbound.takeRecent(1),
      identityProbe: async () => ({ user_id: BOT_UIN, online: true, sessionId: 'synthetic-receive' }),
      signal: AbortSignal.timeout(5000),
    }), { oneBotEventVerified: true, authenticatedLoopback: true, outboundAvailable: false });
    assert.equal(inbound.takeRecent(1), null);
    assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/owner.lock')));
    const readback = new InboundChallenge();
    const challenge = readback.arm(1, '20001');
    const raw = makeMessage(challenge.text);
    readback.observe([raw], 1);
    let reads = 0;
    assert.deepEqual(await verifyOneBotReceive({
      projectRoot, takeMessage: () => readback.takeRecent(1),
      identityProbe: async () => ({ user_id: BOT_UIN, online: true, sessionId: 'synthetic-receive' }),
      signal: AbortSignal.timeout(5000),
      readInboundMessage(peer, ids) {
        reads++;
        assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
        assert.deepEqual(ids, [raw.msgId]);
        return { result: 0, msgList: [raw] };
      },
    }), { oneBotEventVerified: true, authenticatedLoopback: true, outboundAvailable: false,
      messageReadback: { attempted: true, verified: true, outcome: 'verified', nativeOutcome: 'nonempty' } });
    assert.equal(reads, 1);
    assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/pending.json')));
  } finally {
    const real = fs.realpathSync(parent);
    assert.equal(path.dirname(real), fs.realpathSync(tmp));
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test('admin opt-in recognizes only the exact current group challenge and brands the immutable result', () => {
  const inbound = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = inbound.arm(1, '20001');
  const message = makeMessage(text, { senderUin: OWNER_UIN });
  inbound.observe([message], 2);
  inbound.observe([
    { ...message, chatType: 1 },
    { ...message, peerUid: '20002' },
    makeMessage(text + '!', { senderUin: message.senderUin }),
  ], 1);
  assert.equal(inbound.status(1).state, 'waiting');
  assert.equal(inbound.status(1).eligibleTestGroupMessages, 0);
  inbound.observe([message], 1);
  const verified = inbound.takeRecent(1);
  assert.equal(verified.senderUin, message.senderUin);
  assert.equal(isVerifiedProtectedChallenge(verified), true);
  assert.equal(isVerifiedProtectedChallenge(structuredClone(verified)), false);
  assert.throws(() => { verified.elements[0].textElement.content = 'changed'; }, TypeError);
  assert.equal(inbound.takeRecent(1), null);
});

test('a readback challenge ignores the protected account and cannot be consumed by the sending mode', () => {
  const inbound = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = inbound.arm(1, '20001', { readbackOnly: true });
  inbound.observe([makeMessage(text, { senderUin: OWNER_UIN })], 1);
  assert.equal(inbound.status(1).state, 'waiting');
  assert.equal(inbound.status(1).readbackOnly, true);
  inbound.observe([makeMessage(text)], 1);
  assert.equal(inbound.status(1).state, 'matched');
  assert.equal(inbound.takeRecent(1), null);
  assert.equal(inbound.canTakeRecent(1, true), true);
  assert.equal(inbound.takeRecent(1, true).senderUin, '10001');
  assert.equal(inbound.canTakeRecent(1, true), false);
});

test('stored reply inspection reads one bounded page and requires a unique terminal self-message', async () => {
  const reply = { group: '20001', correlation: '90071992547409930', inboundNativeId: '90071992547409932',
    text: `whale-reply-${'a'.repeat(32)}`, submittedAt: 1700000000 };
  const message = makeMessage(reply.text, { senderUin: BOT_UIN, senderUid: 'u_bot', sendStatus: 2 });
  let reads = 0;
  const lookup = (msgList, continuation = false, signal = new AbortController().signal) => findSubmittedReply({
    reply, senderUin: BOT_UIN, senderUid: 'u_bot', signal,
    async readRecent(peer, count) {
      reads++;
      assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
      assert.equal(count, 20);
      return { result: 0, needContinueGetMsg: continuation, msgList };
    },
  });
  assert.deepEqual(await lookup([message]), { group: reply.group, nativeId: message.msgId, text: reply.text });
  const { senderUin: _senderUin, ...uidOnly } = message;
  assert.deepEqual(await lookup([uidOnly]), { group: reply.group, nativeId: message.msgId, text: reply.text });
  for (const page of [[message, { ...message, sendStatus: 1 }], [{ ...message, msgId: reply.correlation }],
    [{ ...message, msgId: reply.inboundNativeId }],
    [{ ...message, guildId: '90071992547409935' }], [{ ...message, senderUid: 'u_other' }],
    [{ ...message, peerUid: '20002' }], [{ ...message, msgTime: '1699999994' }],
    [message, uidOnly], [{ ...uidOnly, senderUid: 'u_other' }], [{ ...uidOnly, senderUid: undefined }],
    [{ ...uidOnly, senderUin: '10001' }]])
    assert.equal(await lookup(page), null);
  assert.equal(await lookup([message], true), null);
  assert.equal(await lookup(Array(21).fill(message)), null);
  await assert.rejects(lookup([message], false, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(reads, 15);
});

test('receipt observer accepts a bound UID only when the UIN is absent and correlation matches', () => {
  const peer = { chatType: 2, peerUid: '20001', guildId: '90071992547409941' };
  const forwarded = [];
  const observer = createSendReceiptObservation(peer, BOT_UIN, batch => forwarded.push(...batch), 'u_bot');
  const reply = { ...peer, senderUid: 'u_bot', msgId: '90071992547409942', sendStatus: 2 };
  observer.observe([{ ...reply, senderUin: '10001' }, { ...reply, senderUin: BOT_UIN, senderUid: 'u_other' },
    { ...reply, guildId: '90071992547409943' }, { ...reply, peerUid: '20002' }], 'update');
  observer.observe([{ ...reply, sendStatus: 0 }, { ...reply, sendStatus: 1 }], 'receive');
  assert.deepEqual(forwarded, []);
  observer.observe([reply], 'receive');
  assert.deepEqual(forwarded, [{ ...reply, senderUin: BOT_UIN }]);
  const result = observer.snapshot();
  assert.equal(result.senderIdentityConflicts, 2);
  assert.equal(result.senderUinRecovered, 1);
  assert.equal(result.receiveBatches, 2);
  assert.equal(result.updateBatches, 1);
});

test('roundtrip uses the challenge group and requires a distinct final native receipt', { timeout: 20000 }, async t => {
  const tmp = fs.realpathSync(path.resolve(import.meta.dirname, '../.tmp'));
  const parent = fs.mkdtempSync(path.join(tmp, 'onebot-roundtrip-'));
  const projectRoot = path.join(parent, 'qq-onebot');
  fs.mkdirSync(projectRoot);
  t.after(() => {
    const real = fs.realpathSync(parent);
    assert.equal(path.dirname(real), tmp);
    fs.rmSync(real, { recursive: true, force: true });
  });
  const inbound = new InboundChallenge();
  const { text } = inbound.arm(1, '20001');
  inbound.observe([makeMessage(text)], 1);
  let sent = 0;
  const progress = [];
  const responses = [];
  let receiptObservation;
  const report = await verifyOneBotReceive({
    projectRoot, takeMessage: () => inbound.takeRecent(1),
    identityProbe: async () => ({ user_id: BOT_UIN, online: true, sessionId: 'synthetic-receive' }),
    signal: AbortSignal.timeout(10000), timeoutMs: 6000,
    onProgress: value => progress.push(value),
    onSendResponse: value => responses.push(value),
    nativeSend: {
      generateId: () => '90071992547409939',
      async submit(first, peer, elements, extension, receive, recordSubmission) {
        sent++;
        assert.equal(first, '0');
        assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '90071992547409939' });
        assert.equal(elements[0].textElement.content, text.replace('whale-check-', 'whale-reply-'));
        assert(extension instanceof Map);
        recordSubmission();
        const observation = createSendReceiptObservation(peer, BOT_UIN, receive);
        const receipt = { ...peer, senderUin: BOT_UIN, msgId: '90071992547409940',
          msgTime: '1700000001', sendStatus: 2, elements };
        observation.observe(null);
        observation.observe(Array(129).fill(receipt));
        observation.observe([
          { ...receipt, senderUin: '10001' },
          { ...receipt, peerUid: '20002' },
          { ...receipt, guildId: undefined },
          { ...receipt, msgId: peer.guildId },
          { ...receipt, sendStatus: 1 },
        ]);
        // An update after the old two-second deadline still confirms the same submission.
        await delay(2200);
        observation.observe([receipt]);
        receiptObservation = observation.snapshot();
        return { result: 0 };
      },
    },
  });
  assert.deepEqual(report, { oneBotEventVerified: true, authenticatedLoopback: true, oneBotSendConfirmed: true });
  assert.equal(sent, 1);
  assert.deepEqual(receiptObservation, { batches: 4, unusableBatches: 2, samePeerAndSender: 4,
    samePeer: 5, sameRequest: 4, senderUidMatches: 0, senderIdentityConflicts: 0, senderUinRecovered: 0,
    receiveBatches: 0, updateBatches: 0,
    unrelatedRequest: 1, requestIdAsMessageId: 1, nonterminalStatus: 1,
    terminalFailure: 0, terminalSuccess: 1, terminalSuccessWithValidId: 1, forwarded: 2 });
  assert.deepEqual(progress, [
    { oneBotEventVerified: true, nativeSubmissionAttempted: false, oneBotSendConfirmed: false },
    { oneBotEventVerified: true, nativeSubmissionAttempted: true, oneBotSendConfirmed: false },
    { oneBotEventVerified: true, nativeSubmissionAttempted: true, oneBotSendConfirmed: true, terminalMessageIdVerified: true },
  ]);
  assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/pending.json')));
  const missing = new InboundChallenge();
  const next = missing.arm(1, '20001');
  missing.observe([makeMessage(next.text)], 1);
  const withoutReceipt = [];
  const endpointChecks = [];
  const token = 'synthetic-retained-endpoint-token';
  const controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0, wsPort: 0, startOffline: true,
    timeoutMs: 1000 });
  const original = await controller.start();
  const endpoint = { controller, token, child: original };
  try {
    // P4：拿不到终态确认时不再抛「terminal confirmation」，也不再回 504/1504、不留未决记录；
    // 验证流程如实报告「已提交但未确认」。
    const noReceipt = await verifyOneBotReceive({
      projectRoot, takeMessage: () => missing.takeRecent(1),
      identityProbe: async () => ({ user_id: BOT_UIN, online: true, sessionId: 'synthetic-receive' }),
      signal: AbortSignal.timeout(5000),
      restartOneBot: true,
      preLoginOneBot: endpoint,
      onEndpointCheck: value => endpointChecks.push(value),
      onProgress: value => withoutReceipt.push(value),
      onSendResponse: value => responses.push(value),
      nativeSend: {
        generateId: () => '90071992547409941',
        submit(_first, peer, elements, _extension, receive, recordSubmission) {
          recordSubmission();
          sent++;
          const inboundId = makeMessage(next.text).msgId;
          receive([{ ...peer, senderUin: BOT_UIN, msgId: inboundId, msgTime: '1700000001', sendStatus: 2, elements }]);
          return { result: 0 };
        },
      },
    }).catch(error => ({ error }));
    assert(noReceipt.error || noReceipt.oneBotSendConfirmed === false,
      'P4：未确认就是未确认（如实报告），而不是靠异常把它们混成「未知」');
    assert.equal(sent, 2);
    assert.deepEqual(responses.at(-1), { httpStatus: 200, retcode: 0 });
    assert.deepEqual(withoutReceipt.at(-1),
      { oneBotEventVerified: true, nativeSubmissionAttempted: true, oneBotSendConfirmed: false });
    assert.equal(fs.existsSync(path.join(projectRoot, 'runtime/outcomes/pending.json')), false);
    assert.deepEqual(endpointChecks, [{ reusesPreLoginPort: true, offlineRestored: true,
      httpPortReused: true, webSocketPortReused: true, httpOfflineVerified: true, webSocketOfflineVerified: true }]);
    assert.notEqual(endpoint.child.instance, original.instance);
    assert.equal(endpoint.child.port, original.port);
    assert.notEqual(original.wsPort, original.port);
    assert.equal(endpoint.child.wsPort, original.wsPort);
  } finally { await controller.close(); }
});

test('reverse status ignores unrelated Pong frames and distinguishes timeout from disconnect', async t => {
  const receiver = await openRoundtripReverseReceiver();
  const client = new WebSocket(receiver.options.url, { autoPong: false, headers: {
    Authorization: `Bearer ${receiver.options.token}`, 'X-Client-Role': 'Universal', 'X-Self-ID': BOT_UIN,
  } });
  t.after(async () => { client.terminate(); await receiver.close(); });
  const signal = AbortSignal.timeout(5000);
  await once(client, 'open', { signal });
  const socket = receiver.current();
  assert(socket);
  client.once('ping', () => client.pong('unrelated'));
  assert.deepEqual(await probeRoundtripReverseReceiver(receiver), { connected: true, pongVerified: false });
  assert.equal(socket.listenerCount('pong'), 0);
  client.once('ping', () => client.pong('unrelated'));
  await assert.rejects(checkRoundtripReverseReady(receiver, signal), /did not respond/);
  client.once('ping', bytes => client.pong(bytes));
  assert.deepEqual(await checkRoundtripReverseReady(receiver, signal), { connected: true, pongVerified: true });
  client.once('ping', () => client.terminate());
  assert.deepEqual(await probeRoundtripReverseReceiver(receiver, signal), { connected: false, pongVerified: false });
  assert.equal(socket.listenerCount('pong'), 0);
});

test('reverse offline readiness requires status and Pong from the same connection', async () => {
  const socket = new EventEmitter();
  const other = new EventEmitter();
  let current = socket;
  let pings = 0;
  const receiver = { current: () => current };
  socket.send = value => socket.emit('message', JSON.stringify({ echo: JSON.parse(value).echo,
    retcode: 0, data: { online: false, good: false } }));
  socket.ping = nonce => { pings++; socket.emit('pong', nonce); };
  const verify = () => checkOfflineRoundtripReverse(receiver, AbortSignal.timeout(500), undefined, { requirePong: true });
  assert.deepEqual(await verify(), { connected: true, authenticatedOfflineStatus: true, pongVerified: true });
  socket.ping = nonce => { pings++; current = other; socket.emit('pong', nonce); socket.emit('close'); };
  await assert.rejects(verify(), /same connection/);
  assert.equal(pings, 2);
});

test('reverse protocol status distinguishes a responsive action from a bare socket and a replaced connection', async () => {
  const socket = new EventEmitter();
  let current = socket;
  const receiver = { current: () => current };
  let observed;
  socket.send = value => {
    observed = JSON.parse(value);
    socket.emit('message', JSON.stringify({ echo: 'unrelated', retcode: 0, data: { online: true, good: true } }));
    socket.emit('message', JSON.stringify({ echo: observed.echo, retcode: 0, data: { online: false, good: false } }));
  };
  assert.deepEqual(await observeOneBotReverseStatus(receiver), { connected: true, endpointResponded: true,
    status: { online: false, good: false } });
  assert.equal(observed.action, 'get_status');
  socket.send = () => {};
  assert.deepEqual(await observeOneBotReverseStatus(receiver, AbortSignal.timeout(30)),
    { connected: true, endpointResponded: false, status: null });
  socket.send = value => {
    current = new EventEmitter();
    socket.emit('message', JSON.stringify({ echo: JSON.parse(value).echo, retcode: 0, data: { online: true, good: true } }));
  };
  assert.deepEqual(await observeOneBotReverseStatus(receiver), { connected: true, endpointResponded: false, status: null });
  current = undefined;
  assert.deepEqual(await observeOneBotReverseStatus(receiver), { connected: false, endpointResponded: false, status: null });
});

test('reverse endpoint sampling drops both results when the socket changes between Pong and status', async () => {
  const socket = new EventEmitter();
  let active = socket;
  const receiver = { current: () => active };
  socket.ping = nonce => socket.emit('pong', nonce);
  socket.send = value => socket.emit('message', JSON.stringify({ echo: JSON.parse(value).echo,
    retcode: 0, data: { online: false, good: false } }));
  assert.deepEqual(await observeOneBotReverseEndpoint(receiver), { connected: true, pongVerified: true,
    endpointResponded: true, status: { online: false, good: false } });
  const send = socket.send;
  socket.send = value => {
    queueMicrotask(() => { active = new EventEmitter(); send(value); });
  };
  assert.deepEqual(await observeOneBotReverseEndpoint(receiver), { connected: true, pongVerified: false,
    endpointResponded: false, status: null });
});

for (const scenario of ['invalid token', 'missing reverse readback action', 'unavailable forward API', 'different message ID', 'different event metadata']) test(
  `three-path verification with ${scenario} restores both ports without sending`, async t => {
  const connectionExpected = scenario !== 'invalid token';
  const tmp = path.resolve(import.meta.dirname, '../.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const parent = fs.mkdtempSync(path.join(tmp, 'reverse-auth-'));
  const projectRoot = path.join(parent, 'qq-onebot');
  fs.mkdirSync(projectRoot);
  let reverse, controller;
  t.after(async () => {
    try { await controller?.close(); }
    finally {
      try { await reverse?.close(); }
      finally {
        const resolved = fs.realpathSync(parent);
        assert.equal(path.dirname(resolved), fs.realpathSync(tmp));
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  });
  reverse = await openRoundtripReverseReceiver();
  const token = 'synthetic-retained-endpoint-token';
  controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0, wsPort: 0, startOffline: true,
    reverseWebSocket: { ...reverse.options, maxAttempts: 1,
      ...(!connectionExpected && { token: 'synthetic-incorrect-reverse-token' }) } });
  const original = await controller.start();
  const views = new WeakMap();
  const endpoint = { controller, token, child: original, reverse: {
    current() {
      const socket = reverse.current();
      if (!socket) return;
      if (views.has(socket)) return views.get(socket);
      const events = Object.assign(new EventEmitter(), { send: (...args) => socket.send(...args) });
      views.set(socket, events);
      Object.defineProperty(events, 'readyState', { get: () => socket.readyState });
      socket.on('message', bytes => {
        const event = JSON.parse(bytes.toString());
        if (scenario === 'missing reverse readback action' && event.echo && Array.isArray(event.data)) {
          event.data = event.data.filter(action => action !== 'get_msg');
        } else if (event.post_type === 'message') {
          if (scenario === 'different message ID') event.message_id++;
          else event.raw_message = 'Inconsistent raw message';
        }
        events.emit('message', Buffer.from(JSON.stringify(event)));
      });
      socket.once('close', () => events.emit('close'));
      return events;
    },
  } };
  if (scenario === 'unavailable forward API') {
    const proxy = new WebSocketServer({ host: '127.0.0.1', port: 0,
      verifyClient: ({ req }) => req.url === '/event' });
    await once(proxy, 'listening');
    t.after(async () => {
      for (const socket of proxy.clients) socket.terminate();
      await new Promise(resolve => proxy.close(resolve));
    });
    let restoring = false;
    const routeForward = child => ({ ...child, get wsPort() {
      return restoring ? child.wsPort : proxy.address().port;
    } });
    endpoint.child = routeForward(original);
    endpoint.controller = { ...controller,
      async start() { return routeForward(await controller.start()); },
      async restart() { return routeForward(await controller.restart()); },
      async replaceBridge(bridge) {
        await controller.replaceBridge(bridge);
        if (bridge instanceof OfflineBridge) restoring = true;
      },
    };
  }
  const challenge = new InboundChallenge();
  challenge.observe([makeMessage(challenge.arm(1, '20001').text)], 1);
  let endpointCheck, progress, generated = 0, submissions = 0;
  await assert.rejects(verifyOneBotReceive({
    projectRoot, takeMessage: () => challenge.takeRecent(1), signal: AbortSignal.timeout(6000),
    identityProbe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-reverse' }),
    restartOneBot: true, preLoginOneBot: endpoint, onEndpointCheck: value => { endpointCheck = value; },
    onProgress: value => { progress = value; },
    nativeSend: {
      generateId() { generated++; return '90071992547409943'; },
      submit() { submissions++; throw new Error('Unexpected native submission'); },
      readMessage() { throw new Error('Unexpected native read'); },
    },
  }), !connectionExpected ? { name: 'AbortError' } : scenario === 'missing reverse readback action' ?
    /did not advertise message readback/ : scenario === 'unavailable forward API' ?
      /Unexpected server response: 401/ : /Reverse event did not match the forward event/);
  assert.equal(generated, 0);
  assert.equal(submissions, 0);
  assert.deepEqual(progress, { oneBotEventVerified: false, nativeSubmissionAttempted: false,
    oneBotSendConfirmed: false, reverseConnected: connectionExpected, reverseEventVerified: false });
  assert.equal(challenge.canTakeRecent(1), !connectionExpected ||
    ['missing reverse readback action', 'unavailable forward API'].includes(scenario));
  assert.equal(Boolean(reverse.current()), connectionExpected);
  assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/pending.json')));
  assert.equal(endpoint.child.instance === original.instance, !connectionExpected);
  assert.equal(endpoint.child.port, original.port);
  assert.equal(endpoint.child.wsPort, original.wsPort);
  assert.deepEqual(endpointCheck, { reusesPreLoginPort: true, offlineRestored: connectionExpected,
    httpPortReused: true, webSocketPortReused: true, httpOfflineVerified: true, webSocketOfflineVerified: true,
    reverseOfflineVerified: connectionExpected });
});

for (const scenario of ['wrong-group callback', 'listener registration failure', 'missing message readback',
  'dual-port readback', 'shared-port reverse readback', 'WebSocket restoration failure', 'reverse readback mismatch', 'reverse restoration reports online']) {
  test(`${scenario} preserves terminal send and verifies endpoint cleanup`, async t => {
    const tmp = fs.realpathSync(path.resolve(import.meta.dirname, '../.tmp'));
    const parent = fs.mkdtempSync(path.join(tmp, 'onebot-group-read-'));
    const projectRoot = path.join(parent, 'qq-onebot');
    fs.mkdirSync(projectRoot);
    const token = 'synthetic-group-read-token';
    const failedRestoration = scenario === 'WebSocket restoration failure';
    const failedReverseReadback = scenario === 'reverse readback mismatch';
    const failedReverseRestoration = scenario === 'reverse restoration reports online';
    const dualPort = scenario === 'dual-port readback' || failedRestoration || failedReverseReadback || failedReverseRestoration;
    const sharedReverse = scenario === 'shared-port reverse readback';
    const hasReadback = dualPort || sharedReverse;
    const readsMessage = hasReadback || scenario === 'missing message readback';
    const reverse = sharedReverse || failedReverseReadback || failedReverseRestoration ? await openRoundtripReverseReceiver() : undefined;
    const controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0,
      wsPort: dualPort ? 0 : undefined, startOffline: true, timeoutMs: 1500,
      ...(reverse && { reverseWebSocket: reverse.options }) });
    t.after(async () => {
      try { await controller.close(); } finally {
        await reverse?.close();
        const real = fs.realpathSync(parent);
        assert.equal(path.dirname(real), tmp);
        fs.rmSync(real, { recursive: true, force: true });
      }
    });
    const child = await controller.start();
    const endpoint = { controller, token, child };
    if (reverse) {
      const views = new WeakMap();
      endpoint.reverse = { current() {
        const socket = reverse.current();
        if (!socket) return;
        if (views.has(socket)) return views.get(socket);
        const view = Object.assign(new EventEmitter(), { send: (...args) => socket.send(...args) });
        Object.defineProperty(view, 'readyState', { get: () => socket.readyState });
        socket.on('message', bytes => {
          const frame = JSON.parse(bytes.toString());
          if (failedReverseReadback && frame.echo && frame.retcode === 0 && frame.data?.message_id)
            frame.data.raw_message = 'Mismatched synthetic readback';
          if (failedReverseRestoration && frame.echo && frame.retcode === 0 && frame.data?.online === false)
            frame.data.online = true;
          view.emit('message', Buffer.from(JSON.stringify(frame)));
        });
        socket.once('close', () => view.emit('close'));
        views.set(socket, view);
        return view;
      } };
    }
    let replacement, rejectedUpgrades = 0;
    if (failedRestoration) {
      const unavailableWs = createServer();
      unavailableWs.on('upgrade', (_request, socket) => {
        rejectedUpgrades++;
        socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
      unavailableWs.listen(0, '127.0.0.1');
      await once(unavailableWs, 'listening');
      t.after(() => new Promise(resolve => unavailableWs.close(resolve)));
      let restoring = false;
      endpoint.controller = { ...controller,
        async restart() {
          replacement = await controller.restart();
          return { ...replacement, get wsPort() {
            return restoring ? unavailableWs.address().port : replacement.wsPort;
          } };
        },
        async replaceBridge(bridge) {
          await controller.replaceBridge(bridge);
          restoring = bridge instanceof OfflineBridge;
        },
      };
    }
    const inbound = new InboundChallenge();
    const { text } = inbound.arm(1, '20001');
    inbound.observe([makeMessage(text)], 1);
    let submissions = 0, groupReads = 0, messageReads = 0, registrations = 0, nativeListener;
    let sentMessage;
    let confirmedReply;
    const checks = {};
    const result = await verifyOneBotReceive({
      projectRoot, preLoginOneBot: endpoint, restartOneBot: true, signal: AbortSignal.timeout(10000),
      identityProbe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-group-read' }),
      takeMessage: () => inbound.takeRecent(1),
      onGroupRead: value => { checks.group = value; },
      onMessageRead: value => { checks.message = value; },
      onEndpointCheck: value => { checks.endpoint = value; },
      onConfirmedReply: value => { confirmedReply = value; },
      nativeGroup: {
        addKernelGroupListener(value) {
          assert.equal(submissions, 1);
          registrations++;
          if (scenario === 'listener registration failure') throw new Error('Synthetic registration failure');
          nativeListener = value;
          return 1;
        },
        removeKernelGroupListener() { nativeListener = undefined; },
        getGroupDetailInfo(code, source) {
          assert.equal(code, '20001');
          assert.equal(source, 1);
          assert.equal(submissions, 1);
          groupReads++;
          if (readsMessage) {
            assert.equal(messageReads, 1);
            nativeListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Fixture',
              memberNum: 3, maxMemberNum: 10 });
          } else nativeListener.onGroupDetailInfoChange({ groupCode: '20002', groupName: 'Wrong group' });
          return { result: 0 };
        },
      },
      nativeSend: {
        ...(readsMessage && {
          readMessage(peer, ids) {
            assert.equal(submissions, 1);
            assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
            assert.deepEqual(ids, ['90071992547409943']);
            messageReads++;
            return { result: 0, msgList: hasReadback ? [sentMessage] : [] };
          },
        }),
        generateId: () => '90071992547409942',
        submit(_first, peer, elements, _extension, receive, recordSubmission) {
          submissions++;
          recordSubmission();
          sentMessage = { ...peer, senderUin: BOT_UIN, msgId: '90071992547409943',
            msgTime: '1700000000', sendStatus: 2, elements };
          const { elements: _elements, ...reduced } = sentMessage;
          receive([hasReadback ? reduced : sentMessage]);
          return { result: 0 };
        },
      },
    });
    assert.equal(result.oneBotSendConfirmed, true);
    const attempted = scenario !== 'listener registration failure';
    assert.deepEqual(checks, { group: { attempted, verified: readsMessage },
      endpoint: { reusesPreLoginPort: true, offlineRestored: !failedRestoration && !failedReverseRestoration,
        ...(reverse && { reverseOfflineVerified: !failedReverseRestoration }),
        ...(hasReadback && { httpPortReused: true, webSocketPortReused: true,
          httpOfflineVerified: true, webSocketOfflineVerified: !failedRestoration }) },
      ...(readsMessage && { message: { attempted: true, verified: hasReadback,
        outcome: hasReadback ? 'verified' : 'onebot-rejected', nativeOutcome: hasReadback ? 'nonempty' : 'empty',
        ...(reverse && { forwardVerified: true, reverseVerified: !failedReverseReadback }) } }) });
    assert.equal(submissions, 1);
    assert.equal(registrations, 1);
    assert.equal(groupReads, Number(attempted));
    assert.equal(messageReads, Number(readsMessage));
    assert.equal(nativeListener, undefined);
    assert.equal(fs.existsSync(path.join(projectRoot, 'runtime/outcomes/pending.json')), false);
    assert.equal(endpoint.child.port, child.port);
    if (dualPort) assert.notEqual(child.wsPort, child.port);
    else assert.equal(child.wsPort, child.port);
    assert.equal(endpoint.child.wsPort, child.wsPort);
    if (failedReverseRestoration) {
      assert.equal(await fetch(`http://127.0.0.1:${child.port}/get_status`, { signal: AbortSignal.timeout(1000) })
        .then(() => false, error => error.cause?.code === 'ECONNREFUSED'), true);
      assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/owner.lock')));
    }
    if (failedRestoration) {
      assert.equal(rejectedUpgrades, 1);
      assert.deepEqual(await replacement.exited, { code: 0, signal: null });
      assert.equal(endpoint.child, child);
      assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/owner.lock')));
      for (const port of [replacement.port, replacement.wsPort]) {
        await assert.rejects(fetch(`http://127.0.0.1:${port}/get_status`, {
          signal: AbortSignal.timeout(1000),
        }), error => error.cause?.code === 'ECONNREFUSED');
      }
      const recovered = await controller.restart();
      assert.notEqual(recovered.instance, replacement.instance);
      assert.equal(recovered.port, child.port);
      assert.equal(recovered.wsPort, child.wsPort);
      const recoveredStatus = await checkOfflineOneBot(recovered.port, token, AbortSignal.timeout(2500), recovered.wsPort);
      assert.equal(recoveredStatus.authenticatedOfflineStatus, true);
      assert.equal(recoveredStatus.authenticatedOfflineWebSocket, true);
      assert.equal(submissions, 1);
    }
    if (scenario === 'dual-port readback') {
      const readbackRoot = path.join(parent, 'readback', 'qq-onebot');
      fs.mkdirSync(readbackRoot, { recursive: true });
      let reads = 0;
      let readbackUid = 'u_bot';
      let readbackUin = BOT_UIN;
      let failNativeRead = false;
      const readbackOptions = { projectRoot: readbackRoot, reply: confirmedReply,
        identityProbe: async () => ({ user_id: Number(BOT_UIN), uid: 'u_bot', online: true, sessionId: 'synthetic-group-read' }),
        signal: AbortSignal.timeout(5000),
        readMessage(peer, ids) {
          reads++;
          assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
          assert.deepEqual(ids, [sentMessage.msgId]);
          if (failNativeRead) throw new Error('Synthetic read failure');
          return { result: 0, msgList: [{ ...sentMessage, senderUin: readbackUin, senderUid: readbackUid }] };
        },
      };
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), { attempted: true, verified: true, outcome: 'verified' });
      readbackUin = undefined;
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), { attempted: true, verified: true, outcome: 'verified' });
      readbackUin = '10001';
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), { attempted: true, verified: false, outcome: 'response-mismatch' });
      readbackUin = BOT_UIN;
      readbackUid = 'u_other';
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), { attempted: true, verified: false, outcome: 'response-mismatch' });
      failNativeRead = true;
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), { attempted: true, verified: false, outcome: 'native-read-failed' });
      const startupFailure = { attempted: false, verified: false, outcome: 'service-start-failed' };
      assert.deepEqual(await verifyConfirmedReplyReadback({ ...readbackOptions,
        identityProbe: async () => ({ user_id: Number(BOT_UIN), online: false, sessionId: 'synthetic-group-read' }),
      }), startupFailure);
      const occupied = path.join(readbackRoot, 'runtime/outcomes/owner.lock');
      fs.writeFileSync(occupied, 'synthetic lock held', { flag: 'wx' });
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), startupFailure);
      assert.equal(fs.readFileSync(occupied, 'utf8'), 'synthetic lock held');
      fs.unlinkSync(occupied);
      failNativeRead = false;
      readbackUid = 'u_bot';
      assert.deepEqual(await verifyConfirmedReplyReadback(readbackOptions), { attempted: true, verified: true, outcome: 'verified' });
      assert.equal(reads, 6);
      assert.equal(submissions, 1);
      assert(!fs.existsSync(path.join(readbackRoot, 'runtime/outcomes/pending.json')));
    }
  });
}

test('roundtrip does not invoke native send without a fresh challenge or current identity', async t => {
  const tmp = fs.realpathSync(path.resolve(import.meta.dirname, '../.tmp'));
  const parent = fs.mkdtempSync(path.join(tmp, 'onebot-roundtrip-negative-'));
  const projectRoot = path.join(parent, 'qq-onebot');
  fs.mkdirSync(projectRoot);
  t.after(() => {
    const real = fs.realpathSync(parent);
    assert.equal(path.dirname(real), tmp);
    fs.rmSync(real, { recursive: true, force: true });
  });
  let now = 0;
  const inbound = new InboundChallenge(() => now);
  const { text } = inbound.arm(1, '20001');
  inbound.observe([makeMessage(text)], 1);
  let submissions = 0, generated = 0;
  const verify = identityProbe => verifyOneBotReceive({
    projectRoot, identityProbe, takeMessage: () => inbound.takeRecent(1),
    signal: AbortSignal.timeout(5000),
    nativeSend: {
      generateId() { generated++; return '90071992547409939'; },
      submit() { submissions++; throw new Error('Unexpected submission'); },
    },
  });
  const identity = { user_id: BOT_UIN, online: true, sessionId: 'synthetic-receive' };
  now = 30000;
  await assert.rejects(verify(async () => identity), /Recent inbound challenge unavailable/);
  now = 100;
  let probes = 0;
  await assert.rejects(verify(async () => (++probes < 3 ? identity : { ...identity, online: false })),
    /OneBot receive check timed out/);
  assert.equal(generated, 0);
  assert.equal(submissions, 0);
  assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/pending.json')));
  assert(!fs.existsSync(path.join(projectRoot, 'runtime/outcomes/owner.lock')));
});

test('online proof freshness is explicit and survives consumption only within the same challenge window', () => {
  let now = 100;
  const inbound = new InboundChallenge(() => now);
  assert.equal(inbound.hasFreshMatch(1), false);
  const { text } = inbound.arm(1, '20001', { readbackOnly: true });
  assert.equal(inbound.hasFreshMatch(1, true), false);
  inbound.observe([makeMessage(text)], 1);
  assert.equal(inbound.hasFreshMatch(2, true), false);
  assert.equal(inbound.hasFreshMatch(1), false);
  assert.equal(inbound.hasFreshMatch(1, true), true);
  assert.equal(inbound.takeRecent(1, true).elements[0].textElement.content, text);
  assert.equal(inbound.canTakeRecent(1, true), false);
  assert.equal(inbound.hasFreshMatch(1, true), true);
  now = 99;
  assert.equal(inbound.hasFreshMatch(1, true), false);
  now = 30099;
  assert.equal(inbound.hasFreshMatch(1, true), true);
  now = 30100;
  assert.equal(inbound.hasFreshMatch(1, true), false);
});

test('expired challenges cannot be revived by a late message', () => {
  let now = 0;
  const inbound = new InboundChallenge(() => now);
  const { text, expiresInMs } = inbound.arm(1, '20001');
  now = expiresInMs;
  inbound.observe([makeMessage(text)], 1);
  assert.deepEqual(inbound.status(1), { state: 'expired', attempt: 1, callbacks: 0,
    testGroupCandidates: 0, eligibleTestGroupMessages: 0 });
  assert.throws(() => inbound.arm(1, '20002'));
  assert.throws(() => inbound.arm(2, '20001'));
  const second = inbound.arm(1, '20001');
  assert.notEqual(second.text, text);
  inbound.observe([makeMessage(text)], 1);
  assert.deepEqual(inbound.status(1), { state: 'waiting', attempt: 2, callbacks: 1,
    testGroupCandidates: 1, eligibleTestGroupMessages: 1 });
  now += expiresInMs;
  assert.equal(inbound.arm(1, '20001').attempt, 3);
  now += expiresInMs;
  assert.throws(() => inbound.arm(1, '20001'));
});

test('expired unconsumed matches can be replaced only in the same session and group', () => {
  let now = 0;
  const inbound = new InboundChallenge(() => now);
  const initial = inbound.arm(1, '20001');
  inbound.observe([makeMessage(initial.text)], 1);
  now = 29999;
  assert.throws(() => inbound.arm(1, '20001'));
  now = 30000;
  assert.equal(inbound.canTakeRecent(1), false);
  assert.equal(inbound.status(1).consumed, false);
  assert.throws(() => inbound.arm(1, '20002'));
  assert.throws(() => inbound.arm(2, '20001'));
  const next = inbound.arm(1, '20001');
  assert.equal(next.attempt, 2);
  inbound.observe([makeMessage(initial.text)], 1);
  assert.equal(inbound.status(1).state, 'waiting');
  inbound.observe([makeMessage(next.text)], 1);
  assert.equal(inbound.takeRecent(1).elements[0].textElement.content, next.text);
  now += 180000;
  assert.equal(inbound.status(1).consumed, true);
  assert.throws(() => inbound.arm(1, '20001'));
});

test('arming requires current authentication and exactly one valid group parameter', async () => {
  const runId = 'synthetic-login-run-1';
  const inbound = new InboundChallenge();
  const control = new CalibrationControl({ runId, operations: {
    arm_inbound_challenge: context => inbound.arm(context.generation, context.params.groupId),
  } });
  const request = { runId, seq: 1, command: 'arm_inbound_challenge', params: { groupId: '20001' } };
  assert.equal((await control.execute(request)).code, 'AUTHENTICATION_REQUIRED');
  const binding = control.bindAuthentication({ user_id: BOT_UIN, sessionId: 'synthetic', eventId: 'verified' });
  for (const params of [{}, { groupId: 20001 }, { groupId: '20001', extra: true },
    { groupId: '20001', readbackOnly: 'true' }, { groupId: '20001', readbackOnly: false },
    { groupId: '20001', requireRoundtripMethods: false },
    { groupId: '20001', readbackOnly: true, requireRoundtripMethods: true }])
    assert.equal((await control.execute({ ...request, ...binding, params })).code, 'INVALID_PARAMS');
  const armed = await control.execute({ ...request, ...binding });
  assert.equal(armed.status, 'completed');
  assert.equal(armed.onlineProof, false);
  assert.match(armed.data.text, /^whale-check-/);
  control.close();
});

test('the roundtrip command can be invoked only once after successful authentication', async () => {
  const runId = 'synthetic-login-run-2';
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: {
    verify_onebot_roundtrip() { calls++; return { oneBotSendConfirmed: true }; },
  } });
  const request = { runId, seq: 1, command: 'verify_onebot_roundtrip' };
  assert.equal((await control.execute(request)).code, 'AUTHENTICATION_REQUIRED');
  const binding = control.bindAuthentication({ user_id: BOT_UIN, sessionId: 'synthetic', eventId: 'verified' });
  assert.equal(control.snapshot().roundtripInvoked, false);
  assert.equal((await control.execute({ ...request, ...binding })).status, 'completed');
  assert.equal(control.snapshot().roundtripInvoked, true);
  assert.equal((await control.execute({ ...request, ...binding, seq: 2 })).code, 'ROUNDTRIP_ALREADY_ATTEMPTED');
  assert.equal(calls, 1);
  control.close();
});

test('a failed roundtrip that never entered native send does not register an unknown write', async () => {
  const runId = 'synthetic-before-send';
  const control = new CalibrationControl({ runId, operations: {
    verify_onebot_roundtrip() { throw new CalibrationOperationError('not_started'); },
    read_onebot_status() { return { endpointResponded: true }; },
  } });
  const binding = control.bindAuthentication({ user_id: BOT_UIN, sessionId: 'synthetic', eventId: 'verified' });
  const response = await control.execute({ runId, seq: 1, command: 'verify_onebot_roundtrip', ...binding });
  assert.equal(response.code, 'ADAPTER_NOT_STARTED');
  assert.equal(control.snapshot().writeState, 'not_started');
  assert.equal((await control.execute({ runId, seq: 2, command: 'verify_onebot_roundtrip', ...binding })).code, 'ADAPTER_NOT_STARTED');
  assert.equal((await control.execute({ runId, seq: 3, command: 'read_onebot_status' })).status, 'completed');
  control.close();
});
