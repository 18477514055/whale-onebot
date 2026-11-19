import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { LiveAgentTrigger, D6_SCOPE, isLiveAgentTriggerRecord, claimLiveAgentTrigger } from '../src/host/live-agent-trigger.mjs';
import { InboundChallenge, isVerifiedProtectedChallenge } from '../src/host/inbound-challenge.mjs';
import { BOT_UIN, OWNER_UIN, TEST_GROUP } from '../src/config/account.mjs';

// Entirely in-memory synthetic native callbacks. No files, sockets, QQ or models.
const WALL = 1800000000000;
const binding = () => ({ generation: 1, sessionDigest: 'a'.repeat(64) });
const makeMessage = (text, patch = {}) => ({ chatType: 2, peerUid: D6_SCOPE.group,
  senderUin: D6_SCOPE.tester, msgId: '90071992547409931', msgTime: WALL / 1000,
  elements: [{ elementType: 1, textElement: { content: text } }], ...patch });
function fixture(duration = 180000) {
  let mono = 100, wall = WALL;
  const trigger = new LiveAgentTrigger({ clock: () => mono, wallClock: () => wall });
  const arm = trigger.arm({ ...binding(), expiresAt: wall + duration });
  return { trigger, arm, message: () => makeMessage(arm.challengeText),
    advance(ms) { wall += ms; mono += ms; }, wall(value) { wall = value; }, mono(value) { mono = value; },
    match() { assert.equal(trigger.observe([this.message()], binding()), true); return trigger.take(binding()); } };
}
function fixedError(fn, code) {
  assert.throws(fn, error => error.code === code && error.message === code && !Object.hasOwn(error, 'cause'));
}

test('fixed immutable D6 scope and real default clocks construct without external I/O', () => {
  assert.deepEqual(D6_SCOPE, { schema: 1, phaseId: 'd6-live-agent-2026-11-15',
    bot: BOT_UIN, group: TEST_GROUP, tester: OWNER_UIN, hardLimit: 3 });
  assert(Object.isFrozen(D6_SCOPE));
  const trigger = new LiveAgentTrigger();
  assert.deepEqual(trigger.status(), { state: 'disarmed' });
  assert.match(trigger.arm({ ...binding(), expiresAt: Date.now() + 10000 }).challengeText, /^whale-d6-[0-9a-f]{32}$/);
  trigger.cancel();
});

test('one exact match, deep frozen 14-field record, documented tuple digest, one take/claim', () => {
  const f = fixture();
  assert(Object.isFrozen(f.arm));
  assert.deepEqual(Object.keys(f.arm).sort(), ['challengeText', 'expiresAt', 'nonce']);
  assert.match(f.arm.nonce, /^[a-f0-9]{32}$/);
  assert.equal(f.arm.challengeText, `whale-d6-${f.arm.nonce}`);
  assert.equal(f.trigger.take(binding()), null);
  const record = f.match();
  assert.deepEqual(Object.keys(record).sort(), ['phaseId', 'bot', 'group', 'tester', 'nonce', 'challengeText',
    'messageId', 'msgTime', 'generation', 'sessionDigest', 'expiresAt', 'matchedAt', 'triggerDigest', 'raw'].sort());
  // Contract enumerates 14 fields (including raw), no hidden JSON verified flag.
  assert.equal(Object.keys(record).length, 14);
  assert.equal(record.expiresAt, WALL + 30000);
  assert.equal(record.matchedAt, WALL);
  const tuple = ['qq-onebot/live-agent-trigger', 1, D6_SCOPE.phaseId, D6_SCOPE.bot, D6_SCOPE.group, D6_SCOPE.tester,
    record.nonce, record.challengeText, record.messageId, record.msgTime, 1, binding().sessionDigest, record.expiresAt, record.matchedAt];
  assert.equal(record.triggerDigest, createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex'));
  for (const object of [record, record.raw, record.raw.elements, record.raw.elements[0], record.raw.elements[0].textElement])
    assert(Object.isFrozen(object));
  assert.throws(() => { record.raw.elements[0].textElement.content = 'tampered'; }, TypeError);
  assert.equal(f.trigger.take(binding()), null);
  assert.equal(f.trigger.observe([f.message()], binding()), false);
  assert.equal(isLiveAgentTriggerRecord(record), true);
  assert.equal(claimLiveAgentTrigger(record), true);
  assert.equal(claimLiveAgentTrigger(record), false);
  assert.equal(isLiveAgentTriggerRecord(record), true);
  assert.deepEqual(f.trigger.status(), { state: 'taken', claimed: true });
});

for (const [name, value] of [
  ['null', null], ['array', []], ['class', new Date()], ['unknown option', { extra: true }],
  ['nonfunction clock', { clock: 1 }], ['nonfunction wallClock', { wallClock: null }],
  ['inherited', Object.create({ clock: () => 1 })],
  ['getter', { get clock() { throw Error('synthetic-private-native-message'); } }],
  ['proxy', new Proxy({}, { getPrototypeOf() { throw Error('synthetic-private-native-message'); } })],
]) test(`constructor rejects ${name} with fixed code`, () => {
  fixedError(() => new LiveAgentTrigger(value), 'LIVE_TRIGGER_INVALID_OPTIONS');
});

for (const [name, change] of [
  ['missing binding', () => undefined], ['null', () => null], ['array', () => []],
  ['zero generation', x => ({ ...x, generation: 0 })], ['negative generation', x => ({ ...x, generation: -1 })],
  ['fraction generation', x => ({ ...x, generation: 1.1 })], ['unsafe generation', x => ({ ...x, generation: 2 ** 53 })],
  ['string generation', x => ({ ...x, generation: '1' })], ['short session', x => ({ ...x, sessionDigest: 'a'.repeat(63) })],
  ['nonhex session', x => ({ ...x, sessionDigest: 'z'.repeat(64) })], ['object session', x => ({ ...x, sessionDigest: new String('a'.repeat(64)) })],
  ['past deadline', x => ({ ...x, expiresAt: WALL - 1 })], ['equal deadline', x => ({ ...x, expiresAt: WALL })],
  ['over180s', x => ({ ...x, expiresAt: WALL + 180001 })], ['infinite deadline', x => ({ ...x, expiresAt: Infinity })],
  ['NaN deadline', x => ({ ...x, expiresAt: NaN })], ['string deadline', x => ({ ...x, expiresAt: String(x.expiresAt) })],
  ['extra JSON verified', x => ({ ...x, verified: true })], ['symbol', x => ({ ...x, [Symbol('x')]: 1 })],
  ['inherited', x => Object.create(x)], ['getter', x => Object.defineProperty(x, 'generation', { get() { throw Error('native secret'); } })],
  ['proxy', x => new Proxy(x, { ownKeys() { throw Error('native secret'); } })],
]) test(`arm rejects ${name} without copying input errors`, () => {
  const trigger = new LiveAgentTrigger({ clock: () => 100, wallClock: () => WALL });
  fixedError(() => trigger.arm(change({ ...binding(), expiresAt: WALL + 180000 })), 'LIVE_TRIGGER_INVALID_ARM');
  assert.deepEqual(trigger.status(), { state: 'disarmed' });
});

test('own null-prototype binding and exact 180s deadline are accepted', () => {
  const trigger = new LiveAgentTrigger({ clock: () => 100, wallClock: () => WALL });
  const options = Object.assign(Object.create(null), binding(), { expiresAt: WALL + 180000 });
  assert.equal(trigger.arm(options).expiresAt, WALL + 180000);
});

test('active armed, matched, taken and claimed states cannot be rearmed', () => {
  const f = fixture();
  const arm = () => f.trigger.arm({ ...binding(), expiresAt: WALL + 180000 });
  fixedError(arm, 'LIVE_TRIGGER_ACTIVE');
  assert.equal(f.trigger.observe([f.message()], binding()), true);
  fixedError(arm, 'LIVE_TRIGGER_ACTIVE');
  const record = f.trigger.take(binding());
  fixedError(arm, 'LIVE_TRIGGER_ACTIVE');
  assert.equal(claimLiveAgentTrigger(record), true);
  fixedError(arm, 'LIVE_TRIGGER_ACTIVE');
});

const nativeInvalid = [
  ['null', () => null], ['array', () => []], ['class', () => new Date()],
  ['wrong sender', x => ({ ...x, senderUin: '10001' })], ['self sender', x => ({ ...x, senderUin: D6_SCOPE.bot })],
  ['wrong group', x => ({ ...x, peerUid: '10001' })], ['private', x => ({ ...x, chatType: 1 })],
  ['pending self send', x => ({ ...x, sendStatus: 1 })], ['self flag', x => ({ ...x, isSelf: true })],
  ['update flag', x => ({ ...x, isUpdate: true })], ['update marker', x => ({ ...x, update: 1 })],
  ['missing sender', x => { delete x.senderUin; return x; }],
  ['prefix', x => ({ ...x, elements: [{ elementType: 1, textElement: { content: x.elements[0].textElement.content.slice(0, -1) } }] })],
  ['suffix', x => ({ ...x, elements: [{ elementType: 1, textElement: { content: x.elements[0].textElement.content + ' ' } }] })],
  ['at', x => ({ ...x, elements: [{ elementType: 1, textElement: { content: x.elements[0].textElement.content, atType: 1 } }] })],
  ['hidden atUid', x => ({ ...x, elements: [{ elementType: 1, textElement: { content: x.elements[0].textElement.content, atUid: D6_SCOPE.tester } }] })],
  ['hidden atNtUid', x => ({ ...x, elements: [{ elementType: 1, textElement: { content: x.elements[0].textElement.content, atNtUid: 'synthetic' } }] })],
  ['text quote payload', x => ({ ...x, elements: [{ elementType: 1, textElement: { content: x.elements[0].textElement.content, quote: {} } }] })],
  ['element quote payload', x => ({ ...x, elements: [{ ...x.elements[0], replyElement: {} }] })],
  ['root quote', x => ({ ...x, quote: {} })], ['root source', x => ({ ...x, sourceMsgId: '123' })],
  ['root quoteElement', x => ({ ...x, quoteElement: {} })], ['root at', x => ({ ...x, atAll: true })],
  ['media', x => ({ ...x, elements: [{ elementType: 2, textElement: x.elements[0].textElement }] })],
  ['multi segment', x => ({ ...x, elements: [x.elements[0], x.elements[0]] })], ['empty elements', x => ({ ...x, elements: [] })],
  ['number msgId', x => ({ ...x, msgId: 123 })], ['zero msgId', x => ({ ...x, msgId: '0' })],
  ['leading zero msgId', x => ({ ...x, msgId: '0123' })], ['long msgId', x => ({ ...x, msgId: '1'.repeat(129) })],
  ['nondigit msgId', x => ({ ...x, msgId: 'secret-id' })], ['fraction msgTime', x => ({ ...x, msgTime: x.msgTime + 0.1 })],
  ['coercible msgTime', x => ({ ...x, msgTime: { valueOf() { throw Error('native secret'); } } })],
  ['scientific msgTime', x => ({ ...x, msgTime: '1.8e9' })], ['unsafe msgTime', x => ({ ...x, msgTime: 2 ** 53 })],
  ['pre-arm msgTime', x => ({ ...x, msgTime: x.msgTime - 1 })], ['too-future msgTime', x => ({ ...x, msgTime: x.msgTime + 2 })],
  ['inherited message', x => Object.create(x)],
  ['getter message', x => Object.defineProperty(x, 'msgId', { get() { throw Error('native secret'); } })],
  ['getter text', x => { Object.defineProperty(x.elements[0].textElement, 'content', { get() { throw Error('native secret'); } }); return x; }],
  ['proxy message', x => new Proxy(x, { getPrototypeOf() { throw Error('native secret'); } })],
  ['proxy elements', x => ({ ...x, elements: new Proxy(x.elements, { get() { throw Error('native secret'); } }) })],
];
for (const [name, mutate] of nativeInvalid) test(`native synthetic rejection: ${name}`, () => {
  const f = fixture();
  assert.equal(f.trigger.observe([mutate(f.message())], binding()), false);
  assert.equal(f.trigger.take(binding()), null);
  assert.equal(f.trigger.status().state, 'armed');
});

for (const [name, mutate] of [
  ['null', () => null], ['oversized', x => Array(129).fill(x)], ['sparse', () => Array(1)],
  ['getter slot', x => Object.defineProperty([x], '0', { get() { throw Error('native secret'); } })],
  ['extra field', x => Object.assign([x], { extra: true })],
  ['proxy', x => new Proxy([x], { get() { throw Error('native secret'); } })],
]) test(`native batch rejects ${name}`, () => {
  const f = fixture();
  assert.equal(f.trigger.observe(mutate(f.message()), binding()), false);
});

for (const [name, value] of [
  ['wrong generation', { ...binding(), generation: 2 }], ['wrong session', { ...binding(), sessionDigest: 'b'.repeat(64) }],
  ['extra verified', { ...binding(), verified: true }], ['missing', undefined], ['inherited', Object.create(binding())],
  ['getter', { ...binding(), get generation() { throw Error('native secret'); } }],
]) test(`observe and take require own fresh binding: ${name}`, () => {
  const f = fixture();
  assert.equal(f.trigger.observe([f.message()], value), false);
  assert.equal(f.trigger.observe([f.message()], binding()), true);
  assert.equal(f.trigger.take(value), null);
  assert.equal(isLiveAgentTriggerRecord(f.trigger.take(binding())), true);
});

test('native numeric UIN/group, seconds string and empty at metadata sanitize to minimal raw', () => {
  const f = fixture();
  const source = makeMessage(f.arm.challengeText, { senderUin: Number(D6_SCOPE.tester), peerUid: Number(D6_SCOPE.group),
    msgTime: String(WALL / 1000), unrelatedNativeMetadata: 'synthetic-private-do-not-export',
    elements: [{ elementType: 1, textElement: { content: f.arm.challengeText, atType: 0, atUid: '', atNtUid: '', atTinyId: '0' } }] });
  assert.equal(f.trigger.observe([source], binding()), true);
  source.elements[0].textElement.content = 'mutated after callback';
  const record = f.trigger.take(binding());
  assert.equal(record.raw.elements[0].textElement.content, f.arm.challengeText);
  assert.equal(record.raw.msgTime, WALL / 1000);
  assert(!JSON.stringify(record).includes('synthetic-private'));
  assert.deepEqual(Object.keys(record.raw), ['chatType', 'peerUid', 'senderUin', 'msgId', 'msgTime', 'elements']);
});

test('arrival freshness accepts exactly old 2s and future 1s, rejects outside boundaries', () => {
  const old = fixture(); old.advance(2000);
  assert.equal(old.trigger.observe([old.message()], binding()), true);
  const stale = fixture(); stale.advance(2001);
  assert.equal(stale.trigger.observe([stale.message()], binding()), false);
  const future = fixture();
  assert.equal(future.trigger.observe([makeMessage(future.arm.challengeText, { msgTime: WALL / 1000 + 1 })], binding()), true);
  const tooFuture = fixture();
  assert.equal(tooFuture.trigger.observe([makeMessage(tooFuture.arm.challengeText, { msgTime: WALL / 1000 + 2 })], binding()), false);
});

test('arm second floor permits same-second callback but not preceding second', () => {
  let wall = WALL + 900;
  const trigger = new LiveAgentTrigger({ clock: () => 100, wallClock: () => wall });
  const { challengeText } = trigger.arm({ ...binding(), expiresAt: wall + 10000 });
  assert.equal(trigger.observe([makeMessage(challengeText, { msgTime: WALL / 1000 - 1 })], binding()), false);
  assert.equal(trigger.observe([makeMessage(challengeText)], binding()), true);
});

test('matching at original deadline is impossible and expiry cannot revive', () => {
  const f = fixture(1000); f.advance(1000);
  assert.equal(f.trigger.observe([f.message()], binding()), false);
  assert.equal(f.trigger.status().state, 'expired');
  f.wall(WALL); f.mono(100);
  assert.equal(f.trigger.observe([f.message()], binding()), false);
});

test('match preserves shorter original deadline and duplicate cannot renew it', () => {
  const f = fixture(10000); f.advance(1000);
  assert.equal(f.trigger.observe([makeMessage(f.arm.challengeText, { msgTime: WALL / 1000 + 1 })], binding()), true);
  f.advance(1000);
  assert.equal(f.trigger.observe([makeMessage(f.arm.challengeText, { msgTime: WALL / 1000 + 2 })], binding()), false);
  const record = f.trigger.take(binding());
  assert.equal(record.expiresAt, WALL + 10000);
  assert.equal(record.matchedAt, WALL + 1000);
  f.advance(8000);
  assert.equal(isLiveAgentTriggerRecord(record), false);
  assert.equal(claimLiveAgentTrigger(record), false);
});

for (const [name, mutate] of [
  ['wall deadline', f => f.wall(WALL + 30000)], ['monotonic deadline', f => f.mono(30100)],
  ['wall backwards', f => f.wall(WALL - 1)], ['monotonic backwards', f => f.mono(99)],
  ['NaN wall', f => f.wall(NaN)], ['infinite wall', f => f.wall(Infinity)],
  ['NaN monotonic', f => f.mono(NaN)], ['infinite monotonic', f => f.mono(Infinity)],
]) test(`record validity and claim permanently fail closed after ${name}`, () => {
  const f = fixture(); const record = f.match();
  mutate(f);
  assert.equal(isLiveAgentTriggerRecord(record), false);
  assert.equal(claimLiveAgentTrigger(record), false);
  f.wall(WALL); f.mono(100);
  assert.equal(isLiveAgentTriggerRecord(record), false);
});

test('clock regression relative to latest sample, not merely arm, invalidates', () => {
  const f = fixture(); const record = f.match();
  f.advance(1000); assert.equal(isLiveAgentTriggerRecord(record), true);
  f.wall(WALL + 999);
  assert.equal(isLiveAgentTriggerRecord(record), false);
});

test('clock callbacks throwing expose no original message in errors or status', () => {
  const trigger = new LiveAgentTrigger({ clock() { throw Error('synthetic-private-native-message'); }, wallClock: () => WALL });
  fixedError(() => trigger.arm({ ...binding(), expiresAt: WALL + 10000 }), 'LIVE_TRIGGER_CLOCK_INVALID');
  let throws = false;
  const active = new LiveAgentTrigger({ clock() { if (throws) throw Error('synthetic-private-native-message'); return 100; }, wallClock: () => WALL });
  const arm = active.arm({ ...binding(), expiresAt: WALL + 10000 });
  active.observe([makeMessage(arm.challengeText)], binding());
  const record = active.take(binding());
  throws = true;
  assert.equal(isLiveAgentTriggerRecord(record), false);
  assert.deepEqual(active.status(), { state: 'invalid', claimed: false });
});

test('take must still be fresh before brand creation', () => {
  const f = fixture();
  assert.equal(f.trigger.observe([f.message()], binding()), true);
  f.advance(30000);
  assert.equal(f.trigger.take(binding()), null);
});

test('clones, JSON verified, raw, proxy and inherited brand cannot mint/claim', () => {
  const f = fixture(); const record = f.match();
  for (const copy of [null, 1, {}, { verified: true }, record.raw, structuredClone(record), JSON.parse(JSON.stringify(record)),
    Object.create(record), { ...record, verified: true }, new Proxy(record, {})]) {
    assert.equal(isLiveAgentTriggerRecord(copy), false);
    assert.equal(claimLiveAgentTrigger(copy), false);
  }
  assert.equal(claimLiveAgentTrigger(record), true);
  assert.equal(isLiveAgentTriggerRecord(record), true);
});

test('read-only challenge brand is distinct and grants no live authority', () => {
  const readonly = new InboundChallenge(() => 0, { allowProtectedSender: true });
  const { text } = readonly.arm(1, D6_SCOPE.group, { readbackOnly: true, allowAdminChallenge: true });
  readonly.observe([makeMessage(text)], 1);
  const record = readonly.takeRecent(1, true, true);
  assert.equal(isVerifiedProtectedChallenge(record), true);
  assert.equal(isLiveAgentTriggerRecord(record), false);
  assert.equal(claimLiveAgentTrigger(record), false);
  const f = fixture();
  assert.equal(f.trigger.observe([record], binding()), false);
  assert.equal(isVerifiedProtectedChallenge(f.match()), false);
});

test('cancel revokes claimed record permanently; rearm creates independent nonce, no old replay', () => {
  const f = fixture(); const old = f.match();
  assert.equal(claimLiveAgentTrigger(old), true);
  f.trigger.cancel();
  assert.equal(isLiveAgentTriggerRecord(old), false);
  assert.equal(claimLiveAgentTrigger(old), false);
  assert.equal(f.trigger.take(binding()), null);
  const next = f.trigger.arm({ ...binding(), expiresAt: WALL + 10000 });
  assert.notEqual(next.nonce, old.nonce);
  assert.equal(f.trigger.observe([f.message()], binding()), false);
  assert.equal(f.trigger.observe([makeMessage(next.challengeText)], binding()), true);
  const fresh = f.trigger.take(binding());
  assert.equal(isLiveAgentTriggerRecord(old), false);
  assert.equal(isLiveAgentTriggerRecord(fresh), true);
  assert.equal(claimLiveAgentTrigger(fresh), true);
});

test('expired and cancelled armed/matched states allow new arm without renewing old brand', () => {
  for (const state of ['armed', 'matched', 'taken']) {
    const f = fixture(1000);
    let record;
    if (state !== 'armed') f.trigger.observe([f.message()], binding());
    if (state === 'taken') record = f.trigger.take(binding());
    f.advance(1000);
    f.trigger.arm({ ...binding(), expiresAt: WALL + 11000 });
    assert.equal(isLiveAgentTriggerRecord(record), false);
    f.trigger.cancel();
    f.trigger.arm({ ...binding(), expiresAt: WALL + 11000 });
    assert.equal(f.trigger.status().state, 'armed');
  }
});

test('getters and proxy traps are never executed during rejection', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('synthetic-private-native-message'); };
  const f = fixture();
  const raw = Object.defineProperty(f.message(), 'msgId', { get: getter });
  assert.equal(f.trigger.observe([raw], binding()), false);
  const proxy = new Proxy(f.message(), { get: getter, ownKeys: getter, getPrototypeOf: getter });
  assert.equal(f.trigger.observe([proxy], binding()), false);
  const badBinding = Object.defineProperty(binding(), 'generation', { get: getter });
  assert.equal(f.trigger.observe([f.message()], badBinding), false);
  fixedError(() => new LiveAgentTrigger({ get clock() { return getter(); } }), 'LIVE_TRIGGER_INVALID_OPTIONS');
  assert.equal(calls, 0);
});

test('invalid initial clock samples reject arm with fixed clock code', () => {
  for (const mono of [NaN, Infinity, -1, '100']) {
    const trigger = new LiveAgentTrigger({ clock: () => mono, wallClock: () => WALL });
    fixedError(() => trigger.arm({ ...binding(), expiresAt: WALL + 10000 }), 'LIVE_TRIGGER_CLOCK_INVALID');
  }
  for (const wall of [NaN, Infinity, 0, -1, '1800000000000', 2 ** 53]) {
    const trigger = new LiveAgentTrigger({ clock: () => 100, wallClock: () => wall });
    fixedError(() => trigger.arm({ ...binding(), expiresAt: WALL + 10000 }), 'LIVE_TRIGGER_CLOCK_INVALID');
  }
});

test('each host instance controls only its own brand and cancellation', () => {
  const first = fixture(), second = fixture();
  const a = first.match(), b = second.match();
  first.trigger.cancel();
  assert.equal(isLiveAgentTriggerRecord(a), false);
  assert.equal(isLiveAgentTriggerRecord(b), true);
  assert.equal(claimLiveAgentTrigger(b), true);
});

test('claimed brand remains live only until expiry and cannot be revived', () => {
  const f = fixture(); const record = f.match();
  assert.equal(claimLiveAgentTrigger(record), true);
  f.advance(29999);
  assert.equal(isLiveAgentTriggerRecord(record), true);
  assert.equal(claimLiveAgentTrigger(record), false);
  f.advance(1);
  assert.equal(isLiveAgentTriggerRecord(record), false);
  assert.equal(claimLiveAgentTrigger(record), false);
  f.wall(WALL); f.mono(100);
  assert.equal(isLiveAgentTriggerRecord(record), false);
});

test('status exports only small frozen non-sensitive state before and after match', () => {
  const f = fixture();
  const record = f.match();
  for (const status of [f.trigger.status(), (f.trigger.cancel(), f.trigger.status())]) {
    assert(Object.isFrozen(status));
    assert.deepEqual(Object.keys(status), ['state', 'claimed']);
    const text = JSON.stringify(status);
    for (const secret of [record.nonce, record.challengeText, record.messageId, record.sessionDigest, record.triggerDigest])
      assert(!text.includes(secret));
  }
});
