import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { BOT_UIN, OWNER_UIN, TEST_GROUP } from '../config/account.mjs';

// Trusted-host only: do not expose arm/observe/take through App, IPC or HTTP.
// This brand proves a local exact challenge match, NOT online status or a send lease.
// Native callback provenance is an adapter obligation: fields (including absence
// of update/self flags) cannot prove receive-vs-update/history. Never feed an
// App-supplied/JSON message here, even if it says verified:true. No live wiring
// or real-phase authorization is provided by this standalone module.
export const D6_SCOPE = Object.freeze({ schema: 1, phaseId: 'd6-live-agent-2026-11-15',
  bot: BOT_UIN, group: TEST_GROUP, tester: OWNER_UIN, hardLimit: 3 });
const branded = new WeakSet();
const authorities = new WeakMap();
const bindingKeys = ['generation', 'sessionDigest'];
const armKeys = [...bindingKeys, 'expiresAt'];

function failure(code) {
  return Object.assign(new Error(code), { code });
}

// No inherited fields, accessors, symbols, proxies or coercion at trust boundaries.
function dataRecord(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value')) ||
      (keys && (names.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))))) return null;
  const result = Object.create(null);
  for (const key of names) result[key] = descriptors[key].value;
  return result;
}

function dataArray(value, max) {
  if (!value || types.isProxy(value) || !Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  if (length > max || Reflect.ownKeys(descriptors).length !== length + 1) return null;
  const result = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[i];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    result.push(descriptor.value);
  }
  return result;
}

function validBinding(value) {
  return value && Number.isSafeInteger(value.generation) && value.generation > 0 &&
    typeof value.sessionDigest === 'string' && /^[a-fA-F0-9]{64}$/.test(value.sessionDigest);
}

function sameBinding(value, current) {
  return validBinding(value) && value.generation === current.generation && value.sessionDigest === current.sessionDigest;
}

function qqEquals(value, expected) {
  return value === expected || (Number.isSafeInteger(value) && value === Number(expected));
}

function nativeSecond(value) {
  if (typeof value === 'string') {
    if (!/^[1-9]\d{0,12}$/.test(value)) return null;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value * 1000) ? value : null;
}

function minimalMessage(input, current, wall) {
  const raw = dataRecord(input);
  if (!raw || raw.chatType !== 2 || !qqEquals(raw.peerUid, D6_SCOPE.group) ||
      !qqEquals(raw.senderUin, D6_SCOPE.tester) || raw.sendStatus === 1 ||
      ['isSelf', 'self', 'isUpdate', 'update'].some(key => Object.hasOwn(raw, key) && raw[key] !== false && raw[key] !== 0) ||
      ['quote', 'reply', 'source', 'replyElement', 'quoteElement', 'sourceMsgId', 'sourceMsg',
        'at', 'atType', 'atUid', 'atNtUid', 'atAll'].some(key => Object.hasOwn(raw, key)) ||
      typeof raw.msgId !== 'string' || !/^[1-9]\d{0,127}$/.test(raw.msgId)) return null;
  const msgTime = nativeSecond(raw.msgTime);
  if (msgTime === null || msgTime < Math.floor(current.armedWall / 1000) ||
      wall - msgTime * 1000 > 2000 || msgTime * 1000 - wall > 1000) return null;
  const elements = dataArray(raw.elements, 1);
  if (!elements || elements.length !== 1) return null;
  const element = dataRecord(elements[0], ['elementType', 'textElement']);
  const text = element && dataRecord(element.textElement);
  if (!element || element.elementType !== 1 || !text || text.content !== current.challengeText ||
      Reflect.ownKeys(text).some(key => !['content', 'atType', 'atUid', 'atNtUid', 'atTinyId'].includes(key)) ||
      (Object.hasOwn(text, 'atType') && text.atType !== 0) ||
      ['atUid', 'atNtUid', 'atTinyId'].some(key => Object.hasOwn(text, key) && text[key] !== '' && text[key] !== '0' && text[key] !== 0)) return null;
  return Object.freeze({ chatType: 2, peerUid: D6_SCOPE.group, senderUin: D6_SCOPE.tester,
    msgId: raw.msgId, msgTime,
    elements: Object.freeze([Object.freeze({ elementType: 1,
      textElement: Object.freeze({ content: current.challengeText }) })]) });
}

export function isLiveAgentTriggerRecord(record) {
  if (!branded.has(record)) return false;
  return authorities.get(record).valid();
}

export function claimLiveAgentTrigger(record) {
  if (!isLiveAgentTriggerRecord(record)) return false;
  const authority = authorities.get(record);
  if (authority.current.claimed) return false;
  authority.current.claimed = true;
  // Claim is one-shot; validity remains true for the final native guard.
  return true;
}

export class LiveAgentTrigger {
  #clock;
  #wallClock;
  #current;

  constructor(options = {}) {
    const data = dataRecord(options);
    if (!data || Reflect.ownKeys(data).some(key => !['clock', 'wallClock'].includes(key)) ||
        (Object.hasOwn(data, 'clock') && typeof data.clock !== 'function') ||
        (Object.hasOwn(data, 'wallClock') && typeof data.wallClock !== 'function')) throw failure('LIVE_TRIGGER_INVALID_OPTIONS');
    this.#clock = data.clock ?? (() => performance.now());
    this.#wallClock = data.wallClock ?? (() => Date.now());
  }

  #sample(current) {
    try {
      const mono = this.#clock();
      const wall = this.#wallClock();
      if (!Number.isFinite(mono) || mono < 0 || !Number.isFinite(wall) || wall <= 0 || wall > Number.MAX_SAFE_INTEGER ||
          (current && (mono < current.lastMono || wall < current.lastWall))) throw failure('LIVE_TRIGGER_CLOCK_INVALID');
      if (current) { current.lastMono = mono; current.lastWall = wall; }
      return { mono, wall };
    } catch {
      if (current) current.state = 'invalid';
      return null;
    }
  }

  #fresh(current) {
    if (this.#current !== current || ['cancelled', 'expired', 'invalid'].includes(current.state)) return false;
    const now = this.#sample(current);
    if (!now) return false;
    if (now.wall >= current.deadlineWall || now.mono >= current.deadlineMono) {
      current.state = 'expired';
      return false;
    }
    return true;
  }

  arm(options) {
    const binding = dataRecord(options, armKeys);
    if (!validBinding(binding) || !Number.isFinite(binding.expiresAt)) throw failure('LIVE_TRIGGER_INVALID_ARM');
    if (this.#current && this.#fresh(this.#current)) throw failure('LIVE_TRIGGER_ACTIVE');
    const now = this.#sample();
    if (!now) throw failure('LIVE_TRIGGER_CLOCK_INVALID');
    const duration = binding.expiresAt - now.wall;
    if (!(duration > 0 && duration <= 180000) || binding.expiresAt > Number.MAX_SAFE_INTEGER) throw failure('LIVE_TRIGGER_INVALID_ARM');
    let nonce;
    try { nonce = randomBytes(16).toString('hex'); }
    catch { throw failure('LIVE_TRIGGER_RANDOM_FAILED'); }
    const challengeText = `whale-d6-${nonce}`;
    this.#current = { ...binding, nonce, challengeText, state: 'armed', claimed: false,
      armedWall: now.wall, lastWall: now.wall, lastMono: now.mono,
      deadlineWall: binding.expiresAt, deadlineMono: now.mono + duration };
    return Object.freeze({ nonce, challengeText, expiresAt: binding.expiresAt });
  }

  // Only call for the current receive callback, never history or update callbacks.
  observe(messages, binding) {
    const current = this.#current;
    if (!current || !this.#fresh(current) || current.state !== 'armed') return false;
    try {
      if (!sameBinding(dataRecord(binding, bindingKeys), current)) return false;
      const batch = dataArray(messages, 128);
      if (!batch) return false;
      for (const message of batch) {
        const raw = minimalMessage(message, current, current.lastWall);
        if (!raw) continue;
        // Inputs may not extend the original arm deadline or the 30s match window.
        current.raw = raw;
        current.matchedAt = current.lastWall;
        current.deadlineWall = Math.min(current.deadlineWall, current.lastWall + 30000);
        current.deadlineMono = Math.min(current.deadlineMono, current.lastMono + 30000);
        current.state = 'matched';
        return true;
      }
    } catch { return false; }
    return false;
  }

  take(binding) {
    const current = this.#current;
    if (!current || !this.#fresh(current) || current.state !== 'matched') return null;
    if (!sameBinding(dataRecord(binding, bindingKeys), current)) return null;
    const raw = current.raw;
    // SHA256 of UTF-8 JSON array, domain + schema + all authority-bearing fields.
    // Fixed order/types and array framing avoid ambiguous delimiter concatenation.
    const tuple = ['qq-onebot/live-agent-trigger', D6_SCOPE.schema, D6_SCOPE.phaseId,
      D6_SCOPE.bot, D6_SCOPE.group, D6_SCOPE.tester, current.nonce, current.challengeText,
      raw.msgId, raw.msgTime, current.generation, current.sessionDigest, current.deadlineWall, current.matchedAt];
    let triggerDigest;
    try { triggerDigest = createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex'); }
    catch { current.state = 'invalid'; throw failure('LIVE_TRIGGER_DIGEST_FAILED'); }
    const record = Object.freeze({ phaseId: D6_SCOPE.phaseId, bot: D6_SCOPE.bot, group: D6_SCOPE.group,
      tester: D6_SCOPE.tester, nonce: current.nonce, challengeText: current.challengeText,
      messageId: raw.msgId, msgTime: raw.msgTime, generation: current.generation,
      sessionDigest: current.sessionDigest, expiresAt: current.deadlineWall, matchedAt: current.matchedAt,
      triggerDigest, raw });
    current.state = 'taken';
    branded.add(record);
    authorities.set(record, { current, valid: () => this.#fresh(current) });
    return record;
  }

  cancel() {
    if (this.#current) this.#current.state = 'cancelled';
  }

  status() {
    const current = this.#current;
    if (!current) return Object.freeze({ state: 'disarmed' });
    this.#fresh(current);
    return Object.freeze({ state: current.state, claimed: current.claimed });
  }
}
