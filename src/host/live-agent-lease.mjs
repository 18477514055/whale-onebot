/* D6 trusted-host coordinator, deliberately NOT wired into any live driver.
 * store, identityProbe and nativeSubmit are trusted constructor dependencies,
 * never App/IPC-supplied objects. This module proves neither their authority nor
 * persistence/ACL deployment. No default store, online proof or native adapter.
 * The native adapter MUST invoke beforeNative synchronously at the actual final
 * sendMsg point and immediately submit the exact checked text once. Only a fully
 * correlated final receipt may resolve it. Not a wrapper around arbitrary call().
 * Node 24 crypto/timer APIs checked via Context7, 2026-11-15.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { BridgeError } from '../bridge/error.mjs';
import { D6_SCOPE, isLiveAgentTriggerRecord, claimLiveAgentTrigger } from './live-agent-trigger.mjs';

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[1-9]\d{0,127}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const error = (code, unknown = false) => new BridgeError(code, code,
  { retcode: unknown ? 1502 : 1403, outcome: unknown ? 'unknown' : 'not_started' });
function requireValue(ok, code) { if (!ok) throw error(code); }
function exact(value, keys) {
  requireValue(value !== null && typeof value === 'object' && !types.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype, 'D6_INVALID_INPUT');
  const props = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(props).length === keys.length && keys.every(key =>
    Object.hasOwn(props, key) && Object.hasOwn(props[key], 'value')), 'D6_INVALID_INPUT');
}
function frozenPayload(text) {
  return Object.freeze({ group_id: Number(D6_SCOPE.group), message: Object.freeze([
    Object.freeze({ type: 'text', data: Object.freeze({ text }) }),
  ]) });
}
function payload(action, params, marker) {
  requireValue(action === 'send_group_msg', 'D6_ACTION_DENIED');
  exact(params, ['group_id', 'message']);
  requireValue((params.group_id === D6_SCOPE.group || params.group_id === Number(D6_SCOPE.group)) &&
    !types.isProxy(params.message) && Array.isArray(params.message) && params.message.length === 1 &&
    Reflect.ownKeys(params.message).length === 2, 'D6_TARGET_OR_MESSAGE_DENIED');
  const element = Object.getOwnPropertyDescriptor(params.message, '0');
  requireValue(element && Object.hasOwn(element, 'value'), 'D6_INVALID_INPUT');
  exact(element.value, ['type', 'data']); exact(element.value.data, ['text']);
  const text = element.value.data.text;
  requireValue(element.value.type === 'text' && typeof text === 'string' && text.length <= 512 &&
    text.startsWith(marker + ' ') && text.slice(marker.length + 1).trim().length > 0 &&
    !/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(text) && !/\[CQ:/i.test(text) &&
    !text.slice(marker.length).includes('[whale-d6:'), 'D6_TEXT_DENIED');
  return frozenPayload(text);
}

export class LiveAgentLeaseGate {
  #store; #identityProbe; #nativeSubmit; #clock; #wallClock; #timeoutMs;
  #state = 'disarmed'; #current; #controller; #lastWall = -Infinity; #lastMono = -Infinity;
  #closed = false; #permits = new WeakSet();
  constructor({ store, identityProbe, nativeSubmit, clock = () => performance.now(),
    wallClock = Date.now, timeoutMs = 20000 } = {}) {
    requireValue(store && ['status','reserve','markSubmitted','confirm','rejectConsumed','markUnknown']
      .every(name => typeof store[name] === 'function') && typeof identityProbe === 'function' &&
      typeof nativeSubmit === 'function' && typeof clock === 'function' && typeof wallClock === 'function' &&
      positive(timeoutMs) && timeoutMs <= 30000, 'D6_DEPENDENCY_REQUIRED');
    this.#store = store; this.#identityProbe = identityProbe; this.#nativeSubmit = nativeSubmit;
    this.#clock = clock; this.#wallClock = wallClock; this.#timeoutMs = timeoutMs;
  }
  #time() {
    const wall = this.#wallClock(), mono = this.#clock();
    requireValue(positive(wall) && Number.isFinite(mono) && mono >= 0 &&
      wall >= this.#lastWall && mono >= this.#lastMono, 'D6_CLOCK_INVALID');
    this.#lastWall = wall; this.#lastMono = mono;
    return { wall, mono };
  }
  #snapshot() {
    const s = this.#store.status();
    requireValue(s && Object.entries(D6_SCOPE).every(([key, value]) => s[key] === value) &&
      s.state === 'active' && Number.isInteger(s.used) && s.used >= 0 && s.used < 3 &&
      s.remaining === 3 - s.used && positive(s.ownerEpoch), 'D6_STORE_UNAVAILABLE');
    return s;
  }
  #valid(current, { reserved = false } = {}) {
    requireValue(!this.#closed && this.#state !== 'frozen' && this.#current === current &&
      this.#controller && !this.#controller.signal.aborted && isLiveAgentTriggerRecord(current.record), 'D6_GRANT_REVOKED');
    const now = this.#time();
    requireValue(now.wall < current.record.expiresAt && now.mono < current.monoDeadline, 'D6_GRANT_EXPIRED');
    const s = this.#store.status();
    requireValue(s && Object.entries(D6_SCOPE).every(([key, value]) => s[key] === value) &&
      s.ownerEpoch === current.ownerEpoch && ['active','exhausted'].includes(s.state) &&
      s.used === current.slot - (reserved ? 0 : 1) &&
      s.remaining === 3 - s.used, 'D6_STORE_CHANGED');
    return now;
  }
  #proof(current, proof) {
    exact(proof, ['user_id','online','generation','sessionDigest','observedAt','expiresAt','authority']);
    const { wall } = this.#time();
    requireValue(proof.user_id === D6_SCOPE.bot && proof.online === true &&
      proof.generation === current.record.generation && proof.sessionDigest === current.record.sessionDigest &&
      proof.authority === 'independent-current' && positive(proof.observedAt) && positive(proof.expiresAt) &&
      proof.observedAt <= wall && wall - proof.observedAt <= 1000 && proof.expiresAt > wall &&
      proof.expiresAt <= proof.observedAt + 1000, 'D6_IDENTITY_UNAVAILABLE');
    return Object.freeze({ ...proof });
  }
  async #bounded(work, controller, ms) {
    let timer; let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(error('D6_CANCELLED'));
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      timer = setTimeout(() => { reject(error('D6_TIMEOUT')); controller.abort(); }, ms);
    });
    try { return await Promise.race([Promise.resolve().then(() => {
      requireValue(!controller.signal.aborted, 'D6_CANCELLED'); return work();
    }), stopped]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
  #freeze(current) {
    // Revoke BEFORE callbacks/abort. Pending slots are never refunded.
    if (!this.#closed) this.#state = 'frozen';
    if (current?.storePermit && !current.finished && !current.unknownMarked) {
      current.unknownMarked = true;
      try { this.#store.markUnknown(current.storePermit); } catch { /* pending/dirty remains fail-closed */ }
    }
    this.#controller?.abort();
  }
  /** Trusted supervisor only; runDigest must come from this trigger's verified new-DB run. */
  async authorize(record, { runDigest } = {}) {
    requireValue(!this.#closed && this.#state === 'disarmed', 'D6_NOT_DISARMED');
    requireValue(typeof runDigest === 'string' && HEX.test(runDigest) &&
      isLiveAgentTriggerRecord(record) && claimLiveAgentTrigger(record), 'D6_TRIGGER_DENIED');
    this.#state = 'authorizing';
    let current;
    try {
      const now = this.#time(), s = this.#snapshot();
      requireValue(positive(record.expiresAt) && record.expiresAt > now.wall &&
        record.expiresAt - now.wall <= 30000, 'D6_GRANT_EXPIRED');
      current = { record, runDigest, slot: s.used + 1, ownerEpoch: s.ownerEpoch,
        monoDeadline: now.mono + record.expiresAt - now.wall };
      this.#current = current; this.#controller = new AbortController();
      const proof = await this.#bounded(() => this.#identityProbe({ signal: this.#controller.signal }),
        this.#controller, Math.min(this.#timeoutMs, record.expiresAt - now.wall));
      this.#valid(current); this.#proof(current, proof);
      const permit = Object.freeze(Object.create(null)); this.#permits.add(permit); current.permit = permit;
      current.marker = `[whale-d6:${D6_SCOPE.phaseId}:${current.slot}:${record.nonce}]`;
      this.#state = 'ready';
      return Object.freeze({ permit, descriptor: Object.freeze({ marker: current.marker,
        expiresAt: record.expiresAt, slot: current.slot, phaseId: D6_SCOPE.phaseId }) });
    } catch {
      this.#freeze(current); throw error('D6_AUTHORIZATION_FAILED');
    }
  }
  /** Host keeps permit; never serialize it or accept an App-supplied runDigest. */
  async submit(permit, action, params, { signal } = {}) {
    requireValue(!this.#closed && this.#state === 'ready' && permit && this.#permits.has(permit) &&
      permit === this.#current?.permit, 'D6_PERMIT_DENIED');
    const current = this.#current;
    // Invalid static requests do not spend a slot. Getters/prototypes are rejected.
    const submittedPayload = payload(action, params, current.marker);
    requireValue(signal === undefined || signal instanceof AbortSignal, 'D6_INVALID_SIGNAL');
    requireValue(!signal?.aborted, 'D6_CANCELLED');
    this.#state = 'sending'; // Serialize before the first await.
    const controller = this.#controller;
    const cancelled = () => this.#freeze(current);
    signal?.addEventListener('abort', cancelled, { once: true });
    let guarded = false, correlationId, guardFault = false;
    const payloadDigest = hash(['whale-d6-payload-v1', current.runDigest, submittedPayload]);
    try {
      this.#valid(current);
      let proof = await this.#bounded(() => this.#identityProbe({ signal: controller.signal }), controller, this.#timeoutMs);
      this.#valid(current); proof = this.#proof(current, proof);
      current.storePermit = this.#store.reserve({ triggerDigest: current.record.triggerDigest,
        sessionDigest: current.record.sessionDigest, generation: current.record.generation,
        payloadDigest, expiresAt: current.record.expiresAt });
      this.#valid(current, { reserved: true });
      const beforeNative = view => {
        try {
          requireValue(!guarded && !guardFault, 'D6_DUPLICATE_NATIVE_ATTEMPT');
          exact(view, ['groupId','text','generation','sessionDigest','correlationId']);
          this.#valid(current, { reserved: true }); this.#proof(current, proof);
          requireValue(view.groupId === D6_SCOPE.group && view.text === submittedPayload.message[0].data.text &&
            view.generation === current.record.generation && view.sessionDigest === current.record.sessionDigest &&
            typeof view.correlationId === 'string' && ID.test(view.correlationId), 'D6_NATIVE_BINDING_DENIED');
          requireValue(this.#store.markSubmitted(current.storePermit) === true, 'D6_SUBMISSION_NOT_DURABLE');
          this.#valid(current, { reserved: true }); this.#proof(current, proof);
          correlationId = view.correlationId; guarded = true;
          return true;
        } catch {
          guardFault = true; this.#freeze(current); throw error('D6_NATIVE_GUARD_DENIED', true);
        }
      };
      const observedReceipt = await this.#bounded(() => this.#nativeSubmit(submittedPayload,
        Object.freeze({ signal: controller.signal, beforeNative })), controller, this.#timeoutMs);
      requireValue(guarded && !guardFault, 'D6_NATIVE_GUARD_MISSING');
      this.#valid(current, { reserved: true });
      exact(observedReceipt, ['groupId','bot','generation','sessionDigest','correlationId','finalMessageId','message_id','sendStatus']);
      // Do not retain the adapter's mutable alias across the final asynchronous probe.
      const receipt = Object.freeze({ ...observedReceipt });
      requireValue(receipt.groupId === D6_SCOPE.group && receipt.bot === D6_SCOPE.bot &&
        receipt.generation === current.record.generation && receipt.sessionDigest === current.record.sessionDigest &&
        receipt.correlationId === correlationId && typeof receipt.finalMessageId === 'string' &&
        ID.test(receipt.finalMessageId) && receipt.finalMessageId !== correlationId &&
        positive(receipt.message_id) && [2,3].includes(receipt.sendStatus), 'D6_RECEIPT_UNCONFIRMED');
      proof = await this.#bounded(() => this.#identityProbe({ signal: controller.signal }), controller, this.#timeoutMs);
      this.#valid(current, { reserved: true }); this.#proof(current, proof);
      requireValue(this.#store.confirm(current.storePermit, { receiptDigest: hash(['whale-d6-receipt-v1', receipt]) }) === true,
        'D6_CONFIRM_NOT_DURABLE');
      current.finished = true;
      this.#state = 'disarmed'; this.#current = undefined;
      return Object.freeze({ message_id: receipt.message_id });
    } catch {
      this.#freeze(current);
      throw error('D6_SEND_STOPPED', Boolean(current.storePermit));
    } finally { signal?.removeEventListener('abort', cancelled); }
  }
  /** App/child restart, loss of identity, offline, expiry or operator stop. No resume API. */
  cancel() {
    if (this.#state === 'frozen' || this.#closed) return;
    if (this.#state === 'sending' || this.#state === 'authorizing') this.#freeze(this.#current);
    else { this.#state = 'disarmed'; this.#current = undefined; this.#controller?.abort(); }
  }
  close() { this.cancel(); this.#closed = true; this.#state = 'closed'; }
  status() { return Object.freeze({ state: this.#state, deployed: false }); }
}
