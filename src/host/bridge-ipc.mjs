import { EventEmitter } from 'node:events';
import { ACTIONS, EXPECTED_ACCOUNT } from '../actions.mjs';
import { BridgeError } from '../bridge/error.mjs';

const protocol = 'whale-qq-bridge-v1';
const limit = 16;
const knownAction = action => typeof action === 'string' && Object.hasOwn(ACTIONS, action);
const unavailable = outcome => new BridgeError('BRIDGE_IPC_UNAVAILABLE', 'Local QQ bridge unavailable',
  { retcode: 1503, outcome });
const frame = (type, data = {}) => ({ protocol, type, ...data });

// channel is the private IPC endpoint inherited from child_process.fork().
export function serveBridgeIPC(channel, bridge) {
  const jobs = new Map();
  const bridgeLoads = new WeakMap();
  let closed = false;
  let lastId = 0;
  let queued = 0;
  let generation = 0;
  let subscription;
  let replacing = false;
  let deferEventPublication = false, eventsReady = false, drainingEvents = false;
  const eventQueue = [];
  const flushEvents = () => {
    if (drainingEvents || !eventsReady || closed) return;
    drainingEvents = true;
    try { while (eventsReady && !closed && eventQueue.length && queued < 16) send(eventQueue.shift()); }
    finally { drainingEvents = false; }
  };
  const removeBinding = binding => {
    binding.target.off('event', binding.event);
    binding.target.off('offline', binding.offline);
    binding.target.off('bridge-ready', binding.ready);
  };
  const unsubscribe = () => {
    const retired = subscription;
    subscription = undefined;
    if (retired) removeBinding(retired);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    eventsReady = false;
    eventQueue.length = 0;
    channel.off('message', receive);
    channel.off('disconnect', close);
    unsubscribe();
    for (const { controller } of jobs.values()) controller.abort();
  };
  const send = message => {
    if (closed || !channel.connected) return;
    if (queued >= 32) {
      close();
      channel.disconnect();
      return;
    }
    queued++;
    const sent = error => {
      queued--;
      if (error && !closed) {
        close();
        if (channel.connected) channel.disconnect();
      }
      flushEvents();
    };
    try { channel.send(message, sent); }
    catch (error) { sent(error); }
  };
  const onOffline = () => {
    generation++;
    eventsReady = false;
    eventQueue.length = 0;
    for (const [id, { target, controller, outcome }] of jobs) {
      if (target !== bridge || controller.signal.aborted) continue;
      controller.abort();
      send(frame('error', { id, retcode: 1503, outcome }));
    }
    send(frame('offline', { generation }));
  };
  const subscribe = target => {
    // EventEmitter can still invoke a removed listener during an emit that
    // already started. A new subscription to the same object has a new identity.
    const binding = {
      target,
      event: event => {
        if (subscription !== binding) return;
        if (!deferEventPublication) { send(frame('event', { event, generation })); return; }
        if (eventQueue.length >= 128) return;
        try { eventQueue.push(frame('event', { event: structuredClone(event), generation })); }
        catch { return; }
        flushEvents();
      },
      offline: () => {
        if (subscription === binding) onOffline();
      },
      ready: () => {
        if (subscription === binding) send(frame('bridge-ready', { generation }));
      },
    };
    try {
      target.on('event', binding.event);
      target.on('offline', binding.offline);
      target.on('bridge-ready', binding.ready);
      return binding;
    } catch (error) {
      removeBinding(binding);
      throw error;
    }
  };
  const receive = async message => {
    if (message?.protocol !== protocol) return;
    const { type, id, action, params } = message;
    // Only the private core-owned child can commit an already verified generation.
    // This acknowledges identity acceptance; it cannot create online proof.
    if (type === 'events-ready') {
      if (!closed && deferEventPublication && Number.isSafeInteger(message.generation) && message.generation === generation) {
        eventsReady = true;
        flushEvents();
      }
      return;
    }
    if (type === 'cancel') { jobs.get(id)?.controller.abort(); return; }
    if (!Number.isSafeInteger(id) || id <= lastId || !['probe', 'call'].includes(type)) return;
    lastId = id;
    const target = bridge;
    const requestedGeneration = generation;
    if (type === 'probe' && message.deferEventPublication === true) deferEventPublication = true;
    const load = bridgeLoads.get(target) ?? 0;
    // Retired work remains charged until settlement, but a single stalled
    // bridge cannot consume the replacement's own request budget.
    if (load >= limit || jobs.size >= 2 * limit || (type === 'call' && (message.generation !== requestedGeneration ||
        !knownAction(action)))) {
      send(frame('error', { id, retcode: 1503, outcome: 'not_started' }));
      return;
    }
    if (type === 'call') {
      let advertised;
      try { advertised = target.capabilities(); }
      catch { /* Capability inspection is a pre-submission step. */ }
      if (closed || generation !== requestedGeneration || !Array.isArray(advertised) || !advertised.includes(action)) {
        send(frame('error', { id, retcode: 1503, outcome: 'not_started' }));
        return;
      }
    }
    const controller = new AbortController();
    const outcome = type === 'call' && ACTIONS[action].mutates ? 'unknown' : 'not_started';
    jobs.set(id, { target, controller, outcome });
    bridgeLoads.set(target, load + 1);
    try {
      let value;
      if (type === 'probe') {
        if (target.attached === false) throw unavailable('not_started');
        const proof = await target.probe({ signal: controller.signal });
        if (target.attached === false || controller.signal.aborted) throw unavailable('not_started');
        value = { proof, actions: target.capabilities().filter(knownAction), generation };
      } else {
        value = await target.call(action, params, { signal: controller.signal });
      }
      if (!controller.signal.aborted) send(frame('result', { id, value }));
    } catch (error) {
      if (!controller.signal.aborted) {
        const trusted = error instanceof BridgeError;
        send(frame('error', { id, retcode: trusted ? error.retcode : 1503,
          outcome: trusted ? error.outcome : outcome }));
      }
    } finally {
      jobs.delete(id);
      const remaining = bridgeLoads.get(target) - 1;
      if (remaining) bridgeLoads.set(target, remaining);
      else bridgeLoads.delete(target);
    }
  };
  channel.on('message', receive);
  channel.once('disconnect', close);
  try { subscription = subscribe(bridge); }
  catch (error) {
    close();
    throw error;
  }
  const replaceBridge = next => {
    if (closed) throw new Error('OneBot IPC channel is closed');
    if (replacing) throw new Error('OneBot bridge replacement is already in progress');
    if (next === bridge) return;
    if (typeof next?.probe !== 'function' || typeof next?.capabilities !== 'function' ||
        typeof next?.call !== 'function' || typeof next?.on !== 'function' || typeof next?.off !== 'function')
      throw new TypeError('OneBot bridge required');
    replacing = true;
    let candidate;
    try {
      // Until committed, candidate callbacks cannot publish anything.
      candidate = subscribe(next);
      if (closed) throw new Error('OneBot IPC channel is closed');
      unsubscribe();
      onOffline();
      if (closed) throw new Error('OneBot IPC channel is closed');
      bridge = next;
      subscription = candidate;
      candidate = undefined;
      send(frame('bridge-replaced', { generation }));
    } finally {
      replacing = false;
      if (candidate) removeBinding(candidate);
    }
  };
  return { close, replaceBridge };
}

export class IPCBridge extends EventEmitter {
  #channel;
  #requests = new Map();
  #actions = [];
  #lastId = 0;
  #closed = false;
  #generation;
  #sessionId;
  #uid;
  #authorizationPolicy;
  #proofAvailable = false;
  #minimumGeneration = 0;
  #probeSequence = 0;
  #acceptedProbe = 0;
  #awaitingReattachmentProof = false;
  #requireIdentityCommit = false;

  constructor(channel, { requireIdentityCommit = false, authorizationPolicy = 'online-proof', conversationPolicy = 'protected' } = {}) {
    super();
    if (!['online-proof', 'native-session'].includes(authorizationPolicy)) throw new TypeError('Invalid authorization policy');
    this.#authorizationPolicy = authorizationPolicy;
    if (!['protected', 'original'].includes(conversationPolicy) ||
        (conversationPolicy === 'original' && authorizationPolicy !== 'native-session')) throw new TypeError('Invalid conversation policy');
    this.#channel = channel;
    this.#requireIdentityCommit = requireIdentityCommit === true;
    channel.on('message', this.#receive);
    channel.once('disconnect', this.close);
  }

  capabilities() { return [...this.#actions]; }
  isReattaching() { return this.#awaitingReattachmentProof; }
  async probe({ signal } = {}) {
    const sequence = ++this.#probeSequence;
    const { proof, actions, generation } = await this.#request('probe',
      this.#requireIdentityCommit ? { deferEventPublication: true } : {}, signal);
    if (signal?.aborted || this.#closed || !Number.isSafeInteger(generation) || generation < this.#minimumGeneration ||
        (this.#generation !== undefined && generation < this.#generation) || sequence < this.#acceptedProbe)
      throw unavailable('not_started');
    this.#acceptedProbe = sequence;
    const nativeSession = this.#authorizationPolicy === 'native-session';
    const authorized = nativeSession
      ? proof?.authenticated === true && proof?.sessionAuthorized === true &&
        typeof proof.uid === 'string' && /^u_[A-Za-z0-9_-]{1,125}$/.test(proof.uid) &&
        (proof.online_known !== true || typeof proof.online === 'boolean')
      : proof?.online === true;
    if (!authorized || String(proof?.user_id) !== EXPECTED_ACCOUNT ||
        typeof proof.sessionId !== 'string' || !proof.sessionId || !Array.isArray(actions) ||
        (generation === this.#generation && (proof.sessionId !== this.#sessionId ||
          (nativeSession && proof.uid !== this.#uid)))) {
      this.#actions = [];
      if (this.#proofAvailable) {
        this.#proofAvailable = false;
        this.#awaitingReattachmentProof = true;
        this.emit('offline');
      }
      throw unavailable('not_started');
    }
    this.#actions = actions.filter(knownAction);
    this.#generation = generation;
    this.#sessionId = proof.sessionId;
    this.#uid = nativeSession ? proof.uid : undefined;
    this.#proofAvailable = true;
    this.#awaitingReattachmentProof = false;
    return proof;
  }
  identityAccepted(proof) {
    if (!this.#requireIdentityCommit || this.#closed || !this.#proofAvailable ||
        proof?.sessionId !== this.#sessionId || String(proof?.user_id) !== EXPECTED_ACCOUNT ||
        (this.#authorizationPolicy === 'native-session' && (proof?.uid !== this.#uid ||
          proof?.authenticated !== true || proof?.sessionAuthorized !== true))) return;
    try { this.#channel.send(frame('events-ready', { generation: this.#generation }), error => { if (error) this.close(); }); }
    catch { this.close(); }
  }
  call(action, params, { signal, shouldSubmit } = {}) {
    if (!this.#actions.includes(action) || (shouldSubmit && !shouldSubmit()))
      return Promise.reject(unavailable('not_started'));
    return this.#request('call', { action, params, generation: this.#generation }, signal);
  }

  close = () => {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.off('message', this.#receive);
    this.#channel.off('disconnect', this.close);
    this.#actions = [];
    this.#awaitingReattachmentProof = false;
    for (const request of this.#requests.values()) request.finish(unavailable(request.outcome));
    this.emit('offline');
  };

  #receive = message => {
    if (message?.protocol !== protocol) return;
    if (message.type === 'event') {
      if (this.#proofAvailable && this.#generation === message.generation) this.emit('event', message.event);
      return;
    }
    if (message.type === 'offline') {
      if (!Number.isSafeInteger(message.generation) || message.generation <= this.#minimumGeneration) return;
      this.#minimumGeneration = message.generation;
      this.#actions = [];
      this.#generation = undefined;
      this.#sessionId = undefined;
      this.#uid = undefined;
      this.#proofAvailable = false;
      this.#awaitingReattachmentProof = false;
      this.emit('offline');
      return;
    }
    if (message.type === 'bridge-replaced') {
      if (message.generation === this.#minimumGeneration && message.generation > 0)
        this.emit('bridge-replaced');
      return;
    }
    if (message.type === 'bridge-ready') {
      if (Number.isSafeInteger(message.generation) && message.generation === this.#minimumGeneration && this.#generation === undefined) {
        this.#awaitingReattachmentProof = true;
        this.emit('bridge-ready');
      }
      return;
    }
    const request = this.#requests.get(message.id);
    if (!request) return;
    if (message.type === 'result') request.finish(null, message.value);
    if (message.type === 'error') request.finish(new BridgeError('BRIDGE_IPC_ERROR', 'Local QQ bridge rejected the action',
      { retcode: message.retcode, outcome: message.outcome }));
  };

  #request(type, data = {}, signal) {
    if (this.#closed || !this.#channel.connected || signal?.aborted || this.#requests.size >= limit)
      return Promise.reject(unavailable('not_started'));
    const id = ++this.#lastId;
    const outcome = type === 'call' && ACTIONS[data.action].mutates ? 'unknown' : 'not_started';
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!this.#requests.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => {
        finish(unavailable(outcome));
        if (this.#channel.connected) {
          try { this.#channel.send(frame('cancel', { id }), () => {}); }
          catch { /* The local request has already settled. */ }
        }
      };
      const timer = setTimeout(cancel, 12000);
      this.#requests.set(id, { finish, outcome });
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.#channel.send(frame(type, { id, ...data }), error => { if (error) finish(unavailable(outcome)); });
      } catch { finish(unavailable(outcome)); }
    });
  }
}
