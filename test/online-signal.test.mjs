import assert from 'node:assert/strict';
import test from 'node:test';
import { describeOnlineObservations, summarizeOnlineSignal } from '../src/host/online-signal.mjs';

test('three-argument QQ observations retain codes and comparisons without identifier or text values', () => {
  const response = { result: 0, status: 10, msg: 'private message', serverTime: 'private time' };
  Object.defineProperty(response, 'helloInterval', { get() { throw new Error('Accessor evaluated'); } });
  const report = summarizeOnlineSignal([0, 'private uid', response], { uin: '123', uid: 'private uid' }, 'session');
  assert.deepEqual(report, {
    argumentCount: 3, code: 0, identifierType: 'string', matchesAccount: false,
    matchesUid: true, matchesSession: false, response: { result: 0, status: 10 }, onlineProof: false,
  });
});

test('online observation output labels age, drops stale generations and never emits online proof', () => {
  const current = { generation: 2, observedAtMonotonicMs: 500, value: { status: 10 } };
  const older = { ...current, generation: 1 };
  const future = { ...current, observedAtMonotonicMs: 1701 };
  const events = { onSelfStatusChanged: current, onUserOnlineResult: older,
    onRegisterProxyOnlineResp: future, extra: current };
  const snapshot = (nowMs) => describeOnlineObservations(events, { generation: 2, nowMs, maxAgeMs: 1000 });
  assert.deepEqual(snapshot(1500), { events: {
    onSelfStatusChanged: { ...current, ageMs: 1000, withinObservationWindow: true },
  }, onlineProof: false });
  assert.deepEqual(snapshot(1700), { events: {
    onSelfStatusChanged: { ...current, ageMs: 1200, withinObservationWindow: false },
  }, onlineProof: false });
});
