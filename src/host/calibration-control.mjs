import { randomUUID } from 'node:crypto';
import { BOT_UIN } from '../config/account.mjs';

const BOT = BOT_UIN;
const AUTHENTICATED = new Set(['register_online', 'read_self_status', 'read_online_status', 'inspect_image_path', 'prepare_image_element', 'inspect_service_readiness', 'arm_inbound_challenge', 'read_inbound_challenge', 'verify_onebot_receive', 'verify_onebot_inbound_readback', 'verify_onebot_roundtrip', 'read_confirmed_onebot_reply', 'inspect_unconfirmed_onebot_reply', 'restart_onebot', 'verify_read_only_onebot']);
const COMMANDS = Object.freeze(['stop', 'inspect_service_methods', ...AUTHENTICATED, 'read_onebot_status']);
const isWrite = command => command === 'register_online' || command === 'verify_onebot_roundtrip';
class ControlError extends Error {
  constructor(code) { super('Calibration control rejected an operation'); this.code = code; }
}
export class CalibrationOperationError extends Error {
  constructor(outcome) {
    super('Calibration adapter reported a failure');
    if (!['not_started', 'rejected'].includes(outcome)) throw new TypeError('Explicit adapter outcome required');
    this.outcome = outcome;
  }
}
const reject = code => { throw new ControlError(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validDeliveryId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// This bounds and snapshots already-redacted adapter data. It is not a redactor,
// a detector for secrets in strings, or an isolation boundary for arbitrary JS.
function jsonSnapshot(value, maxBytes) {
  let count = 0, bytes = 0;
  const active = new Set();
  const charge = n => { bytes += n; if (bytes > maxBytes) reject('INVALID_JSON'); };
  const visit = (value, depth) => {
    if (++count > 2048 || depth > 8) reject('INVALID_JSON');
    charge(8);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) reject('INVALID_JSON'); return value; }
    if (typeof value === 'string') { if (value.length > 8192) reject('INVALID_JSON'); charge(Buffer.byteLength(value)); return value; }
    if (typeof value !== 'object' || active.has(value)) reject('INVALID_JSON');
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024 : !plain(value)) reject('INVALID_JSON');
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1025) reject('INVALID_JSON');
    const result = array ? [] : {};
    if (array) for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, String(i))) reject('INVALID_JSON');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) reject('INVALID_JSON');
      if (array && !/^(0|[1-9]\d*)$/.test(key)) reject('INVALID_JSON');
      charge(Buffer.byteLength(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject('INVALID_JSON');
      result[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(value);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) reject('INVALID_JSON');
  return result;
}

/** Pure, fixed-command controller for a single calibration host.
 * bindAuthentication is fed ONLY from a trusted actual authentication event,
 * never from configured UIN or a fabricated readRuntimeProof. Observing that
 * event does not establish current online state. Each named adapter must know
 * its exact native signature and return already-redacted JSON; no eval, path,
 * arbitrary method dispatch, login initiation, network or filesystem lives here.
 */
export class CalibrationControl {
  #runId; #operations; #timeoutMs; #lastSeq = 0; #generation = 0;
  #auth = null; #authEvents = new Map(); #stopped = false; #active = null;
  #writeUnknown = false; #registration = 'not_started';
  #roundtripInvoked = false;
  constructor({ runId, operations = {}, timeoutMs = 5000 } = {}) {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(runId)) throw new TypeError('Bounded unique runId required');
    if (!plain(operations) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid calibration configuration');
    const selected = Object.create(null);
    for (const name of Reflect.ownKeys(operations)) {
      const descriptor = Object.getOwnPropertyDescriptor(operations, name);
      if (!COMMANDS.includes(name) || name === 'stop' || typeof descriptor?.value !== 'function') throw new TypeError('Only fixed calibration adapters are accepted');
      selected[name] = descriptor.value;
    }
    this.#runId = runId; this.#operations = Object.freeze(selected); this.#timeoutMs = timeoutMs;
  }
  snapshot() {
    return { runId: this.#runId, generation: this.#generation, authBinding: this.#auth?.binding ?? null,
      authenticationObserved: this.#auth !== null, onlineProof: false, busy: this.#active !== null,
      roundtripInvoked: this.#roundtripInvoked,
      stopped: this.#stopped, lastSeq: this.#lastSeq, writeState: this.#writeUnknown ? 'unknown' : this.#registration,
      deliveryIdentitySupported: true,
      supportedCommands: COMMANDS.filter(name => name === 'stop' || Object.hasOwn(this.#operations, name)) };
  }
  #cancelActive(code) {
    const job = this.#active;
    if (!job || job.reported) return;
    if (job.started && isWrite(job.command) && !job.sendConfirmed) this.#writeUnknown = true;
    job.cancelCode = code; job.controller.abort();
  }
  invalidate() {
    this.#generation++; this.#auth = null;
    this.#cancelActive('AUTHENTICATION_CHANGED');
    if (!this.#writeUnknown) this.#registration = 'not_started';
    return this.snapshot();
  }
  close() {
    if (!this.#stopped) {
      this.#stopped = true; this.#generation++; this.#auth = null;
      this.#cancelActive('STOPPED');
    }
    return this.snapshot();
  }
  bindAuthentication(event) {
    if (this.#stopped) reject('STOPPED');
    let value;
    try { value = jsonSnapshot(event, 4096); } catch { reject('INVALID_AUTHENTICATION_EVENT'); }
    if (!plain(value) || Object.keys(value).some(key => !['user_id', 'sessionId', 'eventId'].includes(key)) ||
        !['string', 'number'].includes(typeof value.user_id) || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256 ||
        typeof value.eventId !== 'string' || !value.eventId || value.eventId.length > 128) reject('INVALID_AUTHENTICATION_EVENT');
    if (String(value.user_id) !== BOT) { this.close(); reject('ACCOUNT_REJECTED'); }
    if (this.#authEvents.has(value.eventId)) {
      if (this.#auth?.eventId === value.eventId && this.#auth.sessionId === value.sessionId) return { generation: this.#generation, authBinding: this.#auth.binding };
      reject('AUTHENTICATION_EVENT_REPLAY');
    }
    if (this.#authEvents.size >= 256) reject('AUTHENTICATION_EVENT_LIMIT');
    this.invalidate();
    this.#auth = { user_id: BOT, sessionId: value.sessionId, eventId: value.eventId, binding: randomUUID() };
    this.#authEvents.set(value.eventId, true);
    return { generation: this.#generation, authBinding: this.#auth.binding };
  }
  #response(request, accepted, status, code, data) {
    const response = { accepted, status, code, runId: this.#runId,
      seq: Number.isSafeInteger(request?.seq) && request.seq > 0 ? request.seq : null,
      command: COMMANDS.includes(request?.command) ? request.command : null,
      generation: this.#generation, onlineProof: false };
    if (validDeliveryId(request?.deliveryId)) response.deliveryId = request.deliveryId;
    if (data !== undefined) response.data = data;
    return response;
  }
  async execute(input) {
    let request;
    try {
      request = jsonSnapshot(input, 16384);
      if (!plain(request) || Object.keys(request).some(key => !['runId', 'seq', 'command', 'params', 'generation', 'authBinding', 'deliveryId'].includes(key)) ||
          (Object.hasOwn(request, 'deliveryId') && !validDeliveryId(request.deliveryId))) reject('INVALID_REQUEST');
      if (request.runId !== this.#runId) reject('RUN_ID_MISMATCH');
      if (!Number.isSafeInteger(request.seq) || request.seq < 1 || request.seq !== this.#lastSeq + 1) reject('SEQUENCE_REJECTED');
      if (this.#stopped) reject('STOPPED');
      if (!COMMANDS.includes(request.command)) reject('UNSUPPORTED_COMMAND');
      if (request.command === 'arm_inbound_challenge') {
        if (!plain(request.params) || Object.keys(request.params).some(key => !['groupId', 'readbackOnly', 'requireRoundtripMethods', 'allowAdminChallenge'].includes(key)) ||
            (Object.hasOwn(request.params, 'readbackOnly') && request.params.readbackOnly !== true) ||
            (Object.hasOwn(request.params, 'allowAdminChallenge') &&
              (request.params.allowAdminChallenge !== true || request.params.readbackOnly !== true)) ||
            (Object.hasOwn(request.params, 'requireRoundtripMethods') &&
              (request.params.requireRoundtripMethods !== true || request.params.readbackOnly === true)) ||
            typeof request.params.groupId !== 'string' || !/^[1-9]\d{4,15}$/.test(request.params.groupId) ||
            !Number.isSafeInteger(Number(request.params.groupId))) reject('INVALID_PARAMS');
      } else if (request.params !== undefined && (!plain(request.params) || Object.keys(request.params).length !== 0)) reject('INVALID_PARAMS');
      if (request.command !== 'stop' && !Object.hasOwn(this.#operations, request.command)) reject('UNSUPPORTED_COMMAND');
      if (request.command !== 'stop' && this.#active) reject('BUSY');
      if (AUTHENTICATED.has(request.command)) {
        if (!this.#auth) reject('AUTHENTICATION_REQUIRED');
        if (request.generation !== this.#generation || request.authBinding !== this.#auth.binding) reject('STALE_AUTHENTICATION_BINDING');
      }
      if (isWrite(request.command) && this.#writeUnknown) reject('UNKNOWN_WRITE_LOCKED');
      if (request.command === 'verify_onebot_roundtrip' && this.#roundtripInvoked) reject('ROUNDTRIP_ALREADY_ATTEMPTED');
      if (request.command === 'register_online') {
        if (this.#registration === 'completed') reject('ALREADY_REGISTERED');
      }
    } catch (error) { return this.#response(request, false, 'rejected', error instanceof ControlError ? error.code : 'INVALID_REQUEST'); }
    this.#lastSeq = request.seq;
    if (request.command === 'stop') { this.close(); return this.#response(request, true, 'stopped', 'STOPPED'); }
    const job = { command: request.command, controller: new AbortController(), generation: this.#generation,
      auth: this.#auth, started: false, settled: false, reported: false, cancelCode: null, sendConfirmed: false };
    this.#active = job;
    let timer, abort;
    const current = () => !this.#stopped && job.generation === this.#generation && job.auth === this.#auth && !job.controller.signal.aborted;
    const operation = Promise.resolve().then(() => {
      if (!current()) reject(job.cancelCode ?? 'AUTHENTICATION_CHANGED');
      job.started = true;
      if (job.command === 'register_online') this.#registration = 'running';
      if (job.command === 'verify_onebot_roundtrip') this.#roundtripInvoked = true;
      return this.#operations[job.command](Object.freeze({ signal: job.controller.signal, params: Object.freeze(request.params ?? {}),
        runId: this.#runId, seq: request.seq, generation: job.generation,
        ...(job.command === 'verify_onebot_roundtrip' && { confirmSend() {
          if (!current() || job.settled) reject('CONFIRMATION_TOO_LATE');
          job.sendConfirmed = true;
        } }),
        authentication: job.auth ? Object.freeze({ user_id: BOT, sessionId: job.auth.sessionId, eventId: job.auth.eventId }) : null }));
    }).then(data => {
      if (!current()) reject(job.cancelCode ?? 'AUTHENTICATION_CHANGED');
      return jsonSnapshot(data === undefined ? null : data, 65536);
    }).finally(() => {
      job.settled = true;
      if (job.reported && this.#active === job) this.#active = null;
    });
    const cancelled = new Promise((_, failure) => {
      abort = () => failure(new ControlError(job.cancelCode ?? 'CANCELLED'));
      job.controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => this.#cancelActive('TIMEOUT'), this.#timeoutMs);
    });
    try {
      const data = await Promise.race([operation, cancelled]);
      if (!current()) reject(job.cancelCode ?? 'AUTHENTICATION_CHANGED');
      if (job.command === 'register_online') this.#registration = 'completed';
      return this.#response(request, true, 'completed', 'COMPLETED', data);
    } catch (error) {
      const explicit = error instanceof CalibrationOperationError && !job.controller.signal.aborted;
      const unknown = isWrite(job.command) && job.started && !job.sendConfirmed && (!explicit || this.#writeUnknown);
      if (job.command === 'verify_onebot_roundtrip' && explicit && error.outcome === 'not_started' &&
          !job.sendConfirmed && !unknown && current()) this.#roundtripInvoked = false;
      if (unknown) this.#writeUnknown = true;
      else if (job.command === 'register_online') this.#registration = 'not_started';
      const code = job.sendConfirmed ? 'SEND_CONFIRMED_CHECKS_INCOMPLETE' :
        unknown ? 'WRITE_OUTCOME_UNKNOWN' : explicit ? error.outcome === 'rejected' ? 'ADAPTER_REJECTED' : 'ADAPTER_NOT_STARTED' : error instanceof ControlError ? error.code : 'ADAPTER_FAILED';
      return this.#response(request, true, unknown ? 'unknown' : job.controller.signal.aborted ? 'cancelled' : 'failed', code);
    } finally {
      clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort);
      job.reported = true;
      if (job.settled && this.#active === job) this.#active = null;
    }
  }
}
