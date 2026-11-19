import { performance } from 'node:perf_hooks';
import { BOT_UIN } from '../config/account.mjs';

const BOT = BOT_UIN;
export class SelfStatusObservationError extends Error {
  constructor(code) { super('Native self-status observation was not established'); this.name = 'SelfStatusObservationError'; this.code = code; }
}
const fail = code => { throw new SelfStatusObservationError(code); };
function field(object, name, optional = false) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) fail('INVALID_NATIVE_FRAME');
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor && optional) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_NATIVE_FRAME');
  return descriptor.value;
}
function statusInteger(value) { if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail('INVALID_NATIVE_FRAME'); return value; }

/**
 * Original observer for the tested zero-argument getSelfStatus ACK and a later
 * onSelfStatusChanged callback. It does not return readRuntimeProof/online:true.
 * Temporal pairing is not proof that the callback was caused by this query, or
 * that the server is currently authenticated/online. There is no request ID in
 * the observed callback contract. No offline freshness calibration is implied.
 *
 * expectedUid must come from the actual accepted authentication event. Session
 * and UID remain private. readContext, if supplied, must read real current
 * getters and return only {registered?:boolean, transportState?:int32}.
 * Timeout/cancellation/failure after a query starts permanently revokes this
 * observer, so a late callback cannot satisfy a later query on this instance.
 */
export class SelfStatusObserver {
  #profile; #session; #uid; #clock; #timeout; #readContext;
  #state = 'idle'; #epoch = 0; #sessionId; #handle; #hasHandle = false;
  #cleanupPromise = null; #cleanupIncomplete = false;
  #pending = null; #eventSequence = 0;
  #stats = { callbacks: 0, ignoredCallbacks: 0, malformedCallbacks: 0, queries: 0, completed: 0 };
  constructor({ profileService, session, expectedUid, timeoutMs = 5000, clock = () => performance.now(), readContext } = {}) {
    if (!profileService || !session || typeof expectedUid !== 'string' || expectedUid.length < 1 || expectedUid.length > 256 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || typeof clock !== 'function' ||
        (readContext !== undefined && typeof readContext !== 'function')) throw new TypeError('Explicit self-status observation dependencies required');
    for (const name of ['getSelfStatus', 'addKernelProfileListener', 'removeKernelProfileListener']) if (typeof profileService[name] !== 'function') throw new TypeError('Exact profile adapter methods required');
    if (typeof session.getSessionId !== 'function') throw new TypeError('Current native session getter required');
    this.#profile = profileService; this.#session = session; this.#uid = expectedUid;
    this.#clock = clock; this.#timeout = timeoutMs; this.#readContext = readContext;
  }
  #now() { const value = this.#clock(); if (!Number.isFinite(value) || value < 0) fail('CLOCK_INVALID'); return value; }
  #currentSession() {
    let id;
    try { id = this.#session.getSessionId(); } catch { fail('SESSION_UNAVAILABLE'); }
    if (typeof id !== 'string' || !id || id.length > 256) fail('SESSION_UNAVAILABLE');
    return id;
  }
  #ensureCurrent(job) {
    if (this.#state !== 'attached' || (job && (job.epoch !== this.#epoch || job.controller.signal.aborted || this.#pending !== job))) fail('OBSERVER_REVOKED');
    if (this.#currentSession() !== this.#sessionId) fail('SESSION_CHANGED');
  }
  snapshot() {
    return { state: this.#state, epoch: this.#epoch, busy: this.#pending !== null, onlineProof: false,
      cleanupIncomplete: this.#cleanupIncomplete, stats: { ...this.#stats } };
  }
  attach() {
    if (this.#state === 'attached') {
      try { this.#ensureCurrent(); } catch (error) { this.#revoke(error.code); throw error; }
      return this.snapshot();
    }
    if (this.#state !== 'idle') fail('OBSERVER_REVOKED');
    this.#sessionId = this.#currentSession();
    this.#state = 'attaching'; const epoch = ++this.#epoch;
    try {
      const handle = this.#profile.addKernelProfileListener({ onSelfStatusChanged: value => this.#receive(value, epoch) });
      if (!Number.isSafeInteger(handle) || handle < 0) { this.#cleanupIncomplete = true; fail('INVALID_LISTENER_HANDLE'); }
      this.#handle = handle; this.#hasHandle = true;
      if (this.#state !== 'attaching' || this.#currentSession() !== this.#sessionId) fail('SESSION_CHANGED');
      this.#state = 'attached'; return this.snapshot();
    } catch (error) {
      this.#revoke(error instanceof SelfStatusObservationError ? error.code : 'LISTENER_REGISTRATION_FAILED');
      throw error instanceof SelfStatusObservationError ? error : new SelfStatusObservationError('LISTENER_REGISTRATION_FAILED');
    }
  }
  #cleanup() {
    if (this.#cleanupPromise || !this.#hasHandle) return this.#cleanupPromise ?? Promise.resolve(this.snapshot());
    const handle = this.#handle; this.#hasHandle = false;
    // Save ownership before invoking a potentially reentrant native remove.
    this.#cleanupPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.#profile.removeKernelProfileListener(handle)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup timeout')), this.#timeout); }),
        ]);
      } catch { this.#cleanupIncomplete = true; }
      finally { clearTimeout(timer); }
      return this.snapshot();
    })();
    return this.#cleanupPromise;
  }
  #revoke(code = 'OBSERVER_REVOKED', closed = false) {
    if (this.#state !== 'closed' && this.#state !== 'invalidated') { this.#state = closed ? 'closed' : 'invalidated'; this.#epoch++; }
    else if (closed) this.#state = 'closed';
    const job = this.#pending;
    if (job && !job.done) { job.controller.abort(); job.finish(new SelfStatusObservationError(code)); }
    void this.#cleanup();
  }
  invalidate() { this.#revoke('DISCONNECTED'); return this.snapshot(); }
  async close() { this.#revoke('CLOSED', true); return this.#cleanup(); }
  #receive(value, epoch) {
    this.#stats.callbacks++; this.#eventSequence++;
    if (this.#state !== 'attached' || epoch !== this.#epoch) { this.#stats.ignoredCallbacks++; return; }
    try {
      this.#ensureCurrent();
      const uin = field(value, 'uin'), uid = field(value, 'uid');
      if (uin !== BOT || uid !== this.#uid) fail('IDENTITY_MISMATCH');
      const frame = { uin, uidMatchesExpected: true };
      for (const key of ['status', 'extStatus', 'batteryStatus', 'offlineType', 'activeState']) frame[key] = statusInteger(field(value, key));
      const observedAtMonotonicMs = this.#now();
      const job = this.#pending;
      if (!job || !job.started || this.#eventSequence <= job.startSequence) { this.#stats.ignoredCallbacks++; return; }
      if (observedAtMonotonicMs < job.startedAt) fail('CLOCK_REGRESSED');
      job.frame = { ...frame, observedAtMonotonicMs };
      this.#maybeComplete(job);
    } catch (error) {
      this.#stats.malformedCallbacks++;
      this.#revoke(error instanceof SelfStatusObservationError ? error.code : 'INVALID_NATIVE_FRAME');
    }
  }
  #maybeComplete(job) {
    if (job.done || job.finishing || !job.acknowledged || !job.frame) return;
    job.finishing = true;
    Promise.resolve().then(async () => {
      this.#ensureCurrent(job);
      let context;
      if (this.#readContext) {
        const raw = await this.#readContext(Object.freeze({ signal: job.controller.signal }));
        this.#ensureCurrent(job);
        context = { source: 'injected-native-context-getter' };
        const registered = field(raw, 'registered', true), transportState = field(raw, 'transportState', true);
        if (registered !== undefined) { if (typeof registered !== 'boolean') fail('INVALID_NATIVE_CONTEXT'); context.registered = registered; }
        if (transportState !== undefined) context.transportState = statusInteger(transportState);
      }
      this.#ensureCurrent(job);
      const now = this.#now(), frame = job.frame;
      if (now < frame.observedAtMonotonicMs) fail('CLOCK_REGRESSED');
      const observation = { kind: 'native-client-observation', source: 'ProfileService.onSelfStatusChanged',
        epoch: job.epoch, ...frame, queryStartedAtMonotonicMs: job.startedAt, ageMs: now - frame.observedAtMonotonicMs,
        onlineProof: false, serverFreshnessVerified: false, queryCausalityVerified: false,
        ...(context ? { context } : {}) };
      this.#stats.completed++; job.finish(null, observation);
    }).catch(error => {
      if (!job.done && this.#pending === job) this.#revoke(error instanceof SelfStatusObservationError ? error.code : 'CONTEXT_UNAVAILABLE');
    });
  }
  observe({ signal } = {}) {
    if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'))
      return Promise.reject(new SelfStatusObservationError('INVALID_SIGNAL'));
    if (signal?.aborted) return Promise.reject(new SelfStatusObservationError('CANCELLED'));
    try { this.#ensureCurrent(); } catch (error) { this.#revoke(error.code); return Promise.reject(error); }
    if (this.#pending) return Promise.reject(new SelfStatusObservationError('BUSY'));
    return new Promise((resolve, reject) => {
      const job = { epoch: this.#epoch, controller: new AbortController(), started: false, startedAt: null,
        startSequence: null, acknowledged: false, frame: null, finishing: false, done: false };
      this.#pending = job;
      const abort = () => this.#revoke('CANCELLED');
      const timer = setTimeout(() => this.#revoke('TIMEOUT'), this.#timeout);
      job.finish = (error, value) => {
        if (job.done) return; job.done = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (this.#pending === job) this.#pending = null;
        if (error) reject(error); else resolve(value);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        this.#ensureCurrent(job);
        // Start is immediately before the actual zero-argument native call, not
        // when observe() was queued. Synchronous callbacks may share its clock tick.
        job.startedAt = this.#now(); job.startSequence = this.#eventSequence; job.started = true;
        this.#stats.queries++;
        return this.#profile.getSelfStatus();
      }).then(ack => {
        if (job.done) return;
        this.#ensureCurrent(job);
        if (field(ack, 'result') !== 0) fail('ACK_REJECTED');
        job.acknowledged = true; this.#maybeComplete(job);
      }).catch(error => {
        if (!job.done && this.#pending === job) this.#revoke(error instanceof SelfStatusObservationError ? error.code : 'QUERY_FAILED');
      });
    });
  }
}
