import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { CalibrationControl, CalibrationOperationError } from '../src/host/calibration-control.mjs';
import { inspectServiceReadiness, summarizeRoundtripServiceReadiness } from '../src/host/service-readiness.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const runId = 'synthetic-calibration-run-0001';
const event = (eventId = 'synthetic-event-1', sessionId = 'synthetic-session-1') => ({ user_id: BOT_UIN, sessionId, eventId });

test('service readiness checks fixed accessors and never runs business methods or property getters', () => {
  let accessors = 0;
  const session = {
    getMsgService() {
      accessors++;
      return {
        sendMsg() { throw new Error('Unexpected message call'); },
        fetchFavEmojiList() { throw new Error('Unexpected face list call'); },
        get getMsgsByMsgId() { throw new Error('Unexpected getter'); },
      };
    },
    getBuddyService() { accessors++; return null; },
  };
  const report = inspectServiceReadiness(session);
  assert.equal(accessors, 2);
  assert.equal(report.getMsgService.methods.sendMsg, true);
  assert.equal(report.getMsgService.methods.getMsgsByMsgId, false);
  assert.equal(report.getMsgService.methods.fetchFavEmojiList, true);
  assert.equal(report.getMsgService.methods.setMsgRead, false);
  assert.equal(report.getGroupService.methods.getGroupRemainAtTimes, false);
  assert.equal(report.getRichMediaService.methods.translateEnWordToZn, false);
  assert.equal(report.getBuddyService.serviceAvailable, false);
  assert.equal(report.getRichMediaService.accessorAvailable, false);
  let checks = 0;
  assert.throws(() => inspectServiceReadiness(session, () => {
    if (++checks === 2) throw new Error('Session changed');
  }), /Session changed/);
  assert.equal(accessors, 3);
});

test('roundtrip readiness requires the listener pair, send methods and exact message readback', () => {
  const method = () => assert.fail('Must not call a business method');
  const message = { addKernelMsgListener: method, removeKernelMsgListener: method, sendMsg: method,
    generateMsgUniqueId: method, getMsgsByMsgId: method };
  const session = { getMsgService: () => message, getRobotService() { throw new Error('synthetic optional failure'); },
    getProfileLikeService: () => ({ setBuddyProfileLike: method }) };
  const report = inspectServiceReadiness(session);
  assert.deepEqual(report.getRobotService, { accessorAvailable: true, serviceAvailable: false, accessorFailed: true,
    methods: { getRobotUinRange: false } });
  assert.equal(report.getProfileLikeService.methods.setBuddyProfileLike, true);
  assert.deepEqual(summarizeRoundtripServiceReadiness(report), { inboundListener: true, send: true, messageReadback: true,
    groupInfo: false, historyReconciliation: false, roundtripMethodsAvailable: true });
  delete message.getMsgsByMsgId;
  assert.equal(summarizeRoundtripServiceReadiness(inspectServiceReadiness(session)).roundtripMethodsAvailable, false);
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const command = (control, name, extra = {}) => {
  const s = control.snapshot();
  return { runId: s.runId, seq: s.lastSeq + 1, command: name, params: {}, generation: s.generation, authBinding: s.authBinding, ...extra };
};
async function entered(check) { for (let i = 0; i < 1000; i++) { if (check()) return; await turn(); } throw new Error('Synthetic adapter did not start'); }

test('controller is inert and only fixed provided adapters are supported', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: { inspect_service_methods: () => { calls++; return { service: ['getSelfStatus'] }; } } });
  assert.equal(calls, 0);
  assert.deepEqual(control.snapshot().supportedCommands, ['stop', 'inspect_service_methods']);
  const result = await control.execute(command(control, 'inspect_service_methods'));
  assert.equal(result.status, 'completed'); assert.equal(result.onlineProof, false);
  assert.deepEqual(result.data, { service: ['getSelfStatus'] }); assert.equal(calls, 1);
  const absent = await control.execute(command(control, 'read_self_status'));
  assert.equal(absent.accepted, false); assert.equal(absent.code, 'UNSUPPORTED_COMMAND');
  assert.throws(() => new CalibrationControl({ runId, operations: { arbitrary_method: () => null } }), TypeError);
  assert.throws(() => new CalibrationControl({ runId, operations: { stop: () => null } }), TypeError);
  assert.throws(() => new CalibrationControl({ runId: 'short' }), TypeError);
  control.close();
});

test('control replies carry the exact delivery identity without consuming a rejected sequence', async () => {
  const control = new CalibrationControl({ runId, operations: { read_onebot_status: () => ({}) } });
  assert.equal(control.snapshot().deliveryIdentitySupported, true);
  const bad = await control.execute(command(control, 'read_onebot_status', { deliveryId: 'invalid' }));
  assert.equal(bad.code, 'INVALID_REQUEST');
  assert.equal(bad.deliveryId, undefined);
  const firstId = '1'.repeat(32);
  const rejected = await control.execute(command(control, 'read_onebot_status', { params: { extra: 1 }, deliveryId: firstId }));
  assert.equal(rejected.code, 'INVALID_PARAMS');
  assert.equal(rejected.deliveryId, firstId);
  const nextId = '2'.repeat(32);
  const accepted = await control.execute(command(control, 'read_onebot_status', { deliveryId: nextId }));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.seq, rejected.seq);
  assert.equal(accepted.deliveryId, nextId);
});

test('authentication event creates opaque binding; it is not online proof or configured-account login', async () => {
  let context;
  const control = new CalibrationControl({ runId, operations: { read_self_status: value => { context = value; return { type: 'number', value: 10 }; } } });
  assert.equal((await control.execute(command(control, 'read_self_status'))).code, 'AUTHENTICATION_REQUIRED');
  const binding = control.bindAuthentication(event());
  assert.equal(binding.generation, 1); assert.match(binding.authBinding, /^[a-f0-9-]{36}$/);
  assert.deepEqual(control.bindAuthentication(event()), binding);
  const result = await control.execute(command(control, 'read_self_status'));
  assert.equal(result.status, 'completed'); assert.equal(result.onlineProof, false);
  assert.equal(control.snapshot().authenticationObserved, true);
  assert.equal(control.snapshot().onlineProof, false);
  assert.deepEqual(context.authentication, event()); assert(Object.isFrozen(context.authentication));
  assert.equal('sessionId' in result, false); assert.equal('eventId' in result, false);
  control.invalidate();
  assert.throws(() => control.bindAuthentication(event()), { code: 'AUTHENTICATION_EVENT_REPLAY' });
  const next = control.bindAuthentication(event('synthetic-event-2', 'synthetic-session-2'));
  assert.notEqual(next.authBinding, binding.authBinding);
  assert.equal((await control.execute(command(control, 'read_self_status', binding))).code, 'STALE_AUTHENTICATION_BINDING');
  control.close();
});

test('confirmed reply readback requires current authentication and accepts no target parameters', async () => {
  let reads = 0;
  const control = new CalibrationControl({ runId, operations: {
    read_confirmed_onebot_reply() { reads++; return { attempted: true, verified: true }; },
  } });
  const name = 'read_confirmed_onebot_reply';
  assert.equal((await control.execute(command(control, name))).code, 'AUTHENTICATION_REQUIRED');
  const binding = control.bindAuthentication({ user_id: Number(BOT_UIN), sessionId: 'fixture-reply', eventId: 'confirmed' });
  assert.equal((await control.execute(command(control, name, { ...binding, params: { message_id: 1 } }))).code, 'INVALID_PARAMS');
  assert.equal(reads, 0);
  assert.deepEqual((await control.execute(command(control, name, binding))).data, { attempted: true, verified: true });
  assert.equal(reads, 1);
  control.close();
});

test('OneBot restart requires the current authentication binding and takes no parameters', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: {
    restart_onebot() { calls++; return { replacedChild: true, portReused: true, authenticatedOfflineStatus: true }; },
  } });
  assert.equal((await control.execute(command(control, 'restart_onebot'))).code, 'AUTHENTICATION_REQUIRED');
  const old = control.bindAuthentication(event());
  control.bindAuthentication(event('replacement-event', 'replacement-session'));
  assert.equal((await control.execute(command(control, 'restart_onebot', old))).code, 'STALE_AUTHENTICATION_BINDING');
  assert.equal((await control.execute(command(control, 'restart_onebot', { params: { port: 1 } }))).code, 'INVALID_PARAMS');
  assert.equal(calls, 0);
  const result = await control.execute(command(control, 'restart_onebot'));
  assert.equal(result.status, 'completed');
  assert.equal(result.data.portReused, true);
  assert.equal(result.onlineProof, false);
  assert.equal(calls, 1);
});

test('OneBot status is a fixed parameterless local observation before QQ authentication', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: {
    read_onebot_status() { calls++; return { endpointResponded: true, status: { online: false, good: false } }; },
  } });
  assert.equal((await control.execute(command(control, 'read_onebot_status', { params: { port: 1 } }))).code, 'INVALID_PARAMS');
  const result = await control.execute(command(control, 'read_onebot_status'));
  assert.equal(result.status, 'completed');
  assert.equal(result.onlineProof, false);
  assert.equal(control.snapshot().authenticationObserved, false);
  assert.deepEqual(result.data, { endpointResponded: true, status: { online: false, good: false } });
  assert.equal(calls, 1);
});

test('wrong account permanently stops calibration and revokes any prior binding', async () => {
  const control = new CalibrationControl({ runId, operations: { read_self_status: () => ({ value: 'redacted' }) } });
  control.bindAuthentication(event());
  assert.throws(() => control.bindAuthentication({ ...event('wrong'), user_id: OWNER_UIN }), { code: 'ACCOUNT_REJECTED' });
  assert.equal(control.snapshot().stopped, true); assert.equal(control.snapshot().authBinding, null);
  assert.throws(() => control.bindAuthentication(event('later')), { code: 'STOPPED' });
  assert.equal((await control.execute(command(control, 'read_self_status'))).code, 'STOPPED');
});

test('image path inspection requires the current authentication binding and accepts no paths', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: {
    inspect_image_path: () => { calls++; return { pathCalls: 1, needCreate: false, absolute: true }; },
  } });
  const inspect = extra => control.execute(command(control, 'inspect_image_path', extra));
  assert.equal((await inspect()).code, 'AUTHENTICATION_REQUIRED');
  const binding = control.bindAuthentication(event());
  assert.equal((await inspect({ params: { path: '/tmp/other', needCreate: true } })).code, 'INVALID_PARAMS');
  control.invalidate();
  control.bindAuthentication(event('new-event', 'new-session'));
  assert.equal((await inspect(binding)).code, 'STALE_AUTHENTICATION_BINDING');
  assert.equal(calls, 0);
  const result = await inspect();
  assert.equal(result.status, 'completed');
  assert.equal(result.onlineProof, false);
  assert.deepEqual(result.data, { pathCalls: 1, needCreate: false, absolute: true });
  assert.equal(calls, 1);
});

test('run identity, exact increasing sequence and fixed empty parameters prevent replay or arbitrary dispatch', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: { inspect_service_methods: () => { calls++; return []; } } });
  const first = command(control, 'inspect_service_methods');
  for (const extra of [{ runId: 'other-calibration-run-0001' }, { seq: 2 }, { command: 'eval' }, { params: { method: 'quickLogin' } }, { path: '/any/path' }]) {
    const result = await control.execute({ ...first, ...extra }); assert.equal(result.accepted, false);
  }
  assert.equal(calls, 0); assert.equal(control.snapshot().lastSeq, 0);
  assert.equal((await control.execute(first)).accepted, true);
  assert.equal((await control.execute(first)).code, 'SEQUENCE_REJECTED'); assert.equal(calls, 1);
  assert.equal((await control.execute(command(control, 'stop'))).status, 'stopped');
});

test('single in-flight command rejects busy without consuming a sequence or queuing work', async () => {
  const pending = deferred(); let calls = 0;
  const control = new CalibrationControl({ runId, operations: { inspect_service_methods: () => { calls++; return pending.promise; } } });
  const firstRequest = command(control, 'inspect_service_methods'), first = control.execute(firstRequest);
  await entered(() => calls === 1);
  assert.equal((await control.execute(firstRequest)).code, 'SEQUENCE_REJECTED');
  assert.equal((await control.execute(command(control, 'inspect_service_methods'))).code, 'BUSY');
  assert.equal(control.snapshot().lastSeq, 1); assert.equal(calls, 1);
  pending.resolve({ methods: [] }); assert.equal((await first).status, 'completed');
  assert.equal(control.snapshot().busy, false); control.close();
});

test('stop before adapter invocation never starts the operation and cannot be undone by late work', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: { register_online: () => { calls++; return {}; } } });
  control.bindAuthentication(event());
  const operation = control.execute(command(control, 'register_online'));
  const stopped = await control.execute(command(control, 'stop'));
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.accepted, true);
  const result = await operation; assert.equal(result.status, 'cancelled'); assert.equal(result.code, 'STOPPED');
  assert.equal(calls, 0); assert.equal(control.snapshot().writeState, 'not_started');
  assert.equal(control.snapshot().stopped, true);
});

test('stop interrupts an adapter, keeps serial ownership until settlement and ignores late completion', async () => {
  const pending = deferred(); let context;
  const control = new CalibrationControl({ runId, operations: { read_self_status: value => { context = value; return pending.promise; } } });
  control.bindAuthentication(event());
  const operation = control.execute(command(control, 'read_self_status')); await entered(() => context);
  await control.execute(command(control, 'stop'));
  assert.equal(context.signal.aborted, true); assert.equal((await operation).status, 'cancelled');
  assert.equal(control.snapshot().busy, true);
  pending.resolve({ online: true }); await turn();
  assert.equal(control.snapshot().busy, false); assert.equal(control.snapshot().stopped, true);
  assert.equal(control.snapshot().onlineProof, false); assert.equal(control.snapshot().authenticationObserved, false);
});

test('authentication replacement cancels old work and old responses cannot adopt the new event binding', async () => {
  const pending = deferred(); let calls = 0;
  const control = new CalibrationControl({ runId, operations: { read_online_status: () => { calls++; return pending.promise; } } });
  const oldBinding = control.bindAuthentication(event());
  const operation = control.execute(command(control, 'read_online_status')); await entered(() => calls === 1);
  const current = control.bindAuthentication(event('event-2', 'session-2'));
  assert.notEqual(current.authBinding, oldBinding.authBinding);
  assert.equal((await operation).code, 'AUTHENTICATION_CHANGED');
  assert.equal(control.snapshot().busy, true);
  pending.resolve({ observed: true }); await turn();
  assert.equal(control.snapshot().authBinding, current.authBinding); assert.equal(control.snapshot().busy, false);
  assert.equal((await control.execute(command(control, 'read_online_status', oldBinding))).code, 'STALE_AUTHENTICATION_BINDING');
  control.close();
});

test('timed-out read keeps native ownership until it actually settles and does not start a concurrent read', async () => {
  const pending = deferred(); let calls = 0;
  const control = new CalibrationControl({ runId, timeoutMs: 15, operations: { read_self_status: () => { calls++; return pending.promise; } } });
  control.bindAuthentication(event());
  const result = await control.execute(command(control, 'read_self_status'));
  assert.equal(result.code, 'TIMEOUT'); assert.equal(result.status, 'cancelled');
  assert.equal(control.snapshot().busy, true);
  assert.equal((await control.execute(command(control, 'read_self_status'))).code, 'BUSY'); assert.equal(calls, 1);
  pending.resolve({ type: 'number', value: 10 }); await turn();
  assert.equal(control.snapshot().busy, false); assert.equal(control.snapshot().writeState, 'not_started');
  control.close();
});

test('roundtrip timeout after terminal send is reported as incomplete checks without an unknown write', async () => {
  const pending = deferred();
  let context;
  const control = new CalibrationControl({ runId, timeoutMs: 25, operations: {
    verify_onebot_roundtrip(input) {
      context = input;
      input.confirmSend();
      return pending.promise;
    },
  } });
  control.bindAuthentication(event());
  const result = await control.execute(command(control, 'verify_onebot_roundtrip'));
  assert.equal(result.code, 'SEND_CONFIRMED_CHECKS_INCOMPLETE');
  assert.equal(result.status, 'cancelled');
  assert.equal(control.snapshot().writeState, 'not_started');
  assert.throws(() => context.confirmSend(), { code: 'CONFIRMATION_TOO_LATE' });
  pending.resolve(null);
  await entered(() => !control.snapshot().busy);
  assert.equal((await control.execute(command(control, 'verify_onebot_roundtrip'))).code, 'ROUNDTRIP_ALREADY_ATTEMPTED');
});

test('an explicit pre-submission failure leaves one roundtrip available on the same session', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: {
    verify_onebot_roundtrip(context) {
      if (++calls === 1) throw new CalibrationOperationError('not_started');
      context.confirmSend();
      return { oneBotSendConfirmed: true };
    },
  } });
  control.bindAuthentication(event());
  assert.equal((await control.execute(command(control, 'verify_onebot_roundtrip'))).code, 'ADAPTER_NOT_STARTED');
  assert.equal(control.snapshot().roundtripInvoked, false);
  assert.equal((await control.execute(command(control, 'verify_onebot_roundtrip'))).code, 'COMPLETED');
  assert.equal(control.snapshot().roundtripInvoked, true);
  assert.equal((await control.execute(command(control, 'verify_onebot_roundtrip'))).code, 'ROUNDTRIP_ALREADY_ATTEMPTED');
  assert.equal(calls, 2);
});

test('unknown registration outcomes never retry and remain locked across late success and authentication changes', async () => {
  const pending = deferred(); let calls = 0;
  const control = new CalibrationControl({ runId, timeoutMs: 15, operations: { register_online: () => { calls++; return pending.promise; }, read_self_status: () => ({ value: 0 }) } });
  control.bindAuthentication(event());
  const result = await control.execute(command(control, 'register_online'));
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(control.snapshot().writeState, 'unknown'); assert.equal(calls, 1);
  pending.resolve({ accepted: true }); await turn();
  assert.equal(control.snapshot().writeState, 'unknown');
  assert.equal((await control.execute(command(control, 'register_online'))).code, 'UNKNOWN_WRITE_LOCKED');
  control.bindAuthentication(event('event-2', 'session-2'));
  assert.equal((await control.execute(command(control, 'register_online'))).code, 'UNKNOWN_WRITE_LOCKED');
  assert.equal((await control.execute(command(control, 'read_self_status'))).status, 'completed');
  assert.equal(calls, 1); control.close();
});

test('registration completion is one-shot per authentication event and never establishes online proof', async () => {
  let calls = 0;
  const control = new CalibrationControl({ runId, operations: { register_online: () => { calls++; return { result: 0 }; } } });
  control.bindAuthentication(event());
  const result = await control.execute(command(control, 'register_online'));
  assert.equal(result.status, 'completed'); assert.equal(result.onlineProof, false);
  assert.equal(control.snapshot().writeState, 'completed');
  assert.equal((await control.execute(command(control, 'register_online'))).code, 'ALREADY_REGISTERED');
  assert.equal(calls, 1);
  control.bindAuthentication(event());
  assert.equal((await control.execute(command(control, 'register_online'))).code, 'ALREADY_REGISTERED');
  control.bindAuthentication(event('event-2', 'session-2'));
  assert.equal((await control.execute(command(control, 'register_online'))).status, 'completed');
  assert.equal(calls, 2); control.close();
});

test('explicit not-started or rejected adapter failures permit a later explicit sequence, generic failures do not', async () => {
  for (const outcome of ['not_started', 'rejected', 'generic']) {
    let calls = 0;
    const control = new CalibrationControl({ runId, operations: { register_online: () => { calls++; if (calls === 1) throw outcome === 'generic' ? new Error('SECRET-NATIVE-TICKET') : new CalibrationOperationError(outcome); return null; } } });
    control.bindAuthentication(event());
    const first = await control.execute(command(control, 'register_online'));
    assert.equal(JSON.stringify(first).includes('SECRET'), false);
    assert.equal(first.code, outcome === 'generic' ? 'WRITE_OUTCOME_UNKNOWN' : outcome === 'rejected' ? 'ADAPTER_REJECTED' : 'ADAPTER_NOT_STARTED');
    const second = await control.execute(command(control, 'register_online'));
    assert.equal(second.code, outcome === 'generic' ? 'UNKNOWN_WRITE_LOCKED' : 'COMPLETED');
    assert.equal(calls, outcome === 'generic' ? 1 : 2); control.close();
  }
});

test('request JSON and already-redacted response snapshots are bounded without evaluating getters', async () => {
  let calls = 0, getterCalls = 0, returned = { observation: { values: [1, false] } };
  const control = new CalibrationControl({ runId, operations: { inspect_service_methods: () => { calls++; return returned; } } });
  const getterRequest = {};
  Object.defineProperty(getterRequest, 'runId', { get() { getterCalls++; return runId; } });
  assert.equal((await control.execute(getterRequest)).accepted, false);
  assert.equal((await control.execute(command(control, 'inspect_service_methods', { params: { bytes: 'x'.repeat(20000) } }))).accepted, false);
  assert.equal(getterCalls, 0); assert.equal(calls, 0);
  const good = await control.execute(command(control, 'inspect_service_methods'));
  returned.observation.values[0] = 99;
  assert.deepEqual(good.data, { observation: { values: [1, false] } });
  const getterResponse = {};
  Object.defineProperty(getterResponse, 'secret', { get() { getterCalls++; return 'PRIVATE'; } });
  const cycle = {}; cycle.loop = cycle;
  for (returned of [getterResponse, cycle, { huge: Array.from({ length: 20 }, () => 'x'.repeat(8000)) }, { code: 1n }]) {
    const result = await control.execute(command(control, 'inspect_service_methods'));
    assert.equal(result.code, 'INVALID_JSON'); assert.equal('data' in result, false);
  }
  assert.equal(getterCalls, 0); control.close();
});

test('invalid output after registration is an unknown write and stop during registration locks it', async () => {
  const invalid = new CalibrationControl({ runId, operations: { register_online: () => ({ raw: 'x'.repeat(9000) }) } });
  invalid.bindAuthentication(event());
  assert.equal((await invalid.execute(command(invalid, 'register_online'))).code, 'WRITE_OUTCOME_UNKNOWN'); invalid.close();
  const pending = deferred(); let started = false;
  const stopped = new CalibrationControl({ runId, operations: { register_online: () => { started = true; return pending.promise; } } });
  stopped.bindAuthentication(event());
  const operation = stopped.execute(command(stopped, 'register_online')); await entered(() => started);
  stopped.close();
  assert.equal((await operation).code, 'WRITE_OUTCOME_UNKNOWN');
  pending.resolve({ result: 0 }); await turn();
  assert.equal(stopped.snapshot().writeState, 'unknown'); assert.equal(stopped.snapshot().stopped, true);
});
