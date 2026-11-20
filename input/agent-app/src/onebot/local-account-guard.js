// [LOCAL-ONLY] PC account safety boundary. No config/env/argument can change this ID.
// The upstream OneBot class is injected by account-guard.patch.js; do not import
// onebot.js here (that would introduce a loader cycle).
export const EXPECTED_ACCOUNT_ID = null;
const HTTP_BODY_SAFE_MAX = 1536 * 1024;
const PROBE_TIMEOUT_MS = 10000;
const RECOVERY_INTERVAL_MS = 5000;
const RECOVERY_MAX_FRAMES = 256;
const RECOVERY_MAX_BYTES = 2 * 1024 * 1024;
const OPEN = 1;

export function withLocalAccountGuard(UpstreamClient, ActionError) {
  return guardedClient(UpstreamClient, ActionError, EXPECTED_ACCOUNT_ID, 'qq');
}

export function withExplicitQqGuard(UpstreamClient, ActionError, selfId) {
  if (typeof selfId !== 'string' || !/^[1-9]\d*$/.test(selfId) || !Number.isSafeInteger(Number(selfId))) throw Error('Invalid explicit QQ account');
  return guardedClient(UpstreamClient, ActionError, selfId, 'qq');
}

export function withBiliAccountGuard(UpstreamClient, ActionError, selfId) {
  if (!['number', 'string'].includes(typeof selfId) || !/^[1-9]\d*$/.test(String(selfId)) || !Number.isSafeInteger(Number(selfId))) {
    throw new TypeError('A canonical Bilibili self UID is required');
  }
  return guardedClient(UpstreamClient, ActionError, String(selfId), 'bilibili');
}

function guardedClient(UpstreamClient, ActionError, expected, platform) {
  const verifyOnly = platform === 'bilibili' && process.env.QQ_AGENT_LEGACY_COMPANION === '1' && !process.env.WHALE_BINDING_PEER_ID;
  // Old QQ implementations do not expose a platform. A different *explicit*
  // platform, even with the identical decimal account ID, is never QQ.
  const matches = (obj, field) => expected !== null && obj && (obj[field] === expected || obj[field] === Number(expected)) &&
    (obj.platform === platform || (platform === 'qq' && obj.platform === undefined));
  // Capture the actual low-level implementations, never this.call (recursive)
  // and never a caller-supplied probe function. Both use this controlled instance.
  const rawHttp = UpstreamClient.prototype.call;
  const rawWs = UpstreamClient.prototype.callViaWs;
  const states = new WeakMap();
  function state(client) {
    let s = states.get(client);
    if (!s) {
      s = { epoch: 0, socket: null, info: null, wsProof: null, callback: () => {}, tail: Promise.resolve(), config: {}, cancelledProbeEchoes: new Map() };
      states.set(client, s);
    }
    return s;
  }
  function revoke(client, preserveRecoveryCooldown = false) {
    const s = state(client);
    s.epoch += 1;
    s.info = null;
    s.wsProof = null;
    const wasVerified = !!s.dualProof;
    s.dualProof = null;
    if (wasVerified) client.onBindingProofRevoked?.();
    // Recovery belongs to one connection/configuration generation. Invalidate
    // before aborting: an old completion must never settle a newer recovery.
    const recovery = s.recovery;
    s.recovery = null;
    if (!preserveRecoveryCooldown) s.localRecoverAt = 0;
    if (recovery) {
      clearTimeout(recovery.timer);
      recovery.frames.length = 0;
      recovery.bytes = 0;
      // Upstream removes aborted RPCs from wsPending. Their late replies would
      // otherwise fall through into onEvent and masquerade as missing-ID events.
      // Remember only this exact cancelled identity RPC, never arbitrary echoes.
      if (recovery.echo) {
        s.cancelledProbeEchoes.set(recovery.echo, recovery.snap.socket);
        while (s.cancelledProbeEchoes.size > RECOVERY_MAX_FRAMES) {
          s.cancelledProbeEchoes.delete(s.cancelledProbeEchoes.keys().next().value);
        }
      }
      recovery.controller.abort();
    }
  }
  function denied(action, reason) {
    const error = new ActionError(`Local account guard: ${reason}`, { action, outcome: 'failed' });
    error.code = 'LOCAL_ACCOUNT_GUARD';
    return error;
  }
  function snapshot(client) {
    const s = state(client);
    return { epoch: s.epoch, socket: s.socket, httpUrl: client.httpUrl, wsUrl: client.wsUrl,
      httpToken: client.httpToken, accessToken: client.accessToken };
  }
  function current(client, snap) {
    const s = state(client);
    return s.epoch === snap.epoch && s.socket === snap.socket
      && client.connected === true && snap.socket?.readyState === OPEN
      && client.httpUrl === snap.httpUrl && client.wsUrl === snap.wsUrl
      && client.httpToken === snap.httpToken && client.accessToken === snap.accessToken;
  }
  function check(client, snap, action, signal) {
    if (signal?.aborted) throw denied(action, 'cancelled before dispatch');
    if (!current(client, snap)) throw denied(action, 'connection or configuration is not current');
  }
  function plainInfo(info) {
    return Object.freeze({ user_id: String(info.user_id), nickname: typeof info.nickname === 'string' ? info.nickname : '',
      ...(info.platform !== undefined ? { platform: info.platform } : {}) });
  }
  function isExpected(info) {
    // No coercible objects, whitespace, leading zeros or alternate representations.
    return matches(info, 'user_id');
  }

  class GuardedOneBotClient extends UpstreamClient {
    get socket() { return state(this).socket; }
    set socket(socket) {
      const s = state(this);
      if (s.socket === socket) return;
      revoke(this);
      s.cancelledProbeEchoes.clear(); // old-socket frames are already rejected upstream
      s.socket = socket;
      if (!socket) return;
      // Installed before upstream handlers. Keep echo dispatch upstream and only
      // filter onEvent, otherwise an unverified WS identity probe would deadlock.
      const invalidateCurrent = () => { if (state(this).socket === socket) revoke(this); };
      socket.on('open', invalidateCurrent);
      socket.on('close', invalidateCurrent);
      socket.on('error', invalidateCurrent);
    }

    get dualVerified() { const snap = state(this).dualProof; return !!snap && current(this,snap); }
    get selfInfo() {
      const s = state(this);
      return s.wsProof && current(this, s.wsProof) ? s.info : null;
    }
    // Upstream open/refreshSelfInfo assign *after* an await. Ignore these writes:
    // only a current low-level probe may publish identity. Stale success cannot
    // resurrect old selfInfo, and external writes never count as verification.
    set selfInfo(_value) { /* deliberately read-only */ }

    get onEvent() {
      return (frame) => {
        const s = state(this);
        // An exact cancelled RPC reply is not a OneBot event. Do not exempt
        // real events, frames carrying any self_id, or unknown/stale echoes.
        if (frame && !Object.hasOwn(frame, 'post_type') && !Object.hasOwn(frame, 'self_id')
          && typeof frame.echo === 'string' && s.cancelledProbeEchoes.get(frame.echo) === s.socket
          && s.socket) {
          s.cancelledProbeEchoes.delete(frame.echo);
          return;
        }
        // Validate BEFORE recovery as well as in the verified path. A mismatch
        // must fence probes/business already in flight in this generation.
        if (!matches(frame, 'self_id')) {
          revoke(this);
          return;
        }
        if (verifyOnly) return; // No peer authorized: no application ingress, even from correct account.
        // Keep frames arriving during recovery/drain in FIFO order. Previously
        // only the first frame's callback survived; all concurrent frames vanished.
        if (s.recovery || !s.wsProof || !current(this, s.wsProof)) {
          this.#localRecoverWsProof(frame);
          return;
        }
        return s.callback(frame);
      };
    }
    set onEvent(callback) { state(this).callback = typeof callback === 'function' ? callback : () => {}; }

    /**
     * Demand-driven, read-only identity recovery on the existing WS socket.
     * No login, QQ restart, business retry, or cross-generation event replay.
     * One bounded FIFO (256 frames / 2 MiB), one probe, and one optional cooldown
     * timer per generation. Failure revokes and discards the unverified FIFO;
     * only a newly arriving valid frame can request another recovery attempt.
     */
    #localRecoverWsProof(frame) {
      const s = state(this);
      let recovery = s.recovery;
      if (!recovery) {
        const snap = snapshot(this);
        if (!current(this, snap)) return;
        recovery = { snap, frames: [], bytes: 0, controller: new AbortController(), timer: null, overflowWarned: false };
        s.recovery = recovery;
      }
      // Snapshot JSON as well as accounting its bytes: callers cannot mutate
      // queued identities/payloads after admission. No raw event data in logs.
      let json;
      let queuedFrame;
      let bytes;
      try {
        json = JSON.stringify(frame);
        bytes = Buffer.byteLength(json);
        queuedFrame = JSON.parse(json);
      } catch { return; }
      if (recovery.frames.length >= RECOVERY_MAX_FRAMES || recovery.bytes + bytes > RECOVERY_MAX_BYTES) {
        if (!recovery.overflowWarned) {
          recovery.overflowWarned = true;
          console.warn('[onebot] 入站身份补探缓冲已满，丢弃超限事件（未发送）');
        }
        return;
      }
      recovery.frames.push({ frame: queuedFrame, bytes });
      recovery.bytes += bytes;
      if (recovery.started || recovery.timer !== null) return;
      const run = () => {
        recovery.timer = null;
        if (s.recovery !== recovery || !current(this, recovery.snap)) return;
        recovery.started = true;
        s.localRecoverAt = Number(process.hrtime.bigint()) / 1e6;
        this.#probe('ws', recovery.snap, 'get_login_info', PROBE_TIMEOUT_MS, recovery.controller.signal)
          .then(() => {
            if (s.recovery !== recovery || !current(this, recovery.snap) || !s.wsProof) return;
            console.warn('[onebot] 入站身份证明已恢复（wsProof 重建成功），入站事件重新分发');
            // Retain the recovery token throughout draining. Reentrant events
            // append to this FIFO, and each callback gets its own current check.
            while (recovery.frames.length && s.recovery === recovery && current(this, recovery.snap) && s.wsProof) {
              const entry = recovery.frames.shift();
              recovery.bytes -= entry.bytes;
              if (!matches(entry.frame, 'self_id')) {
                revoke(this);
                break;
              }
              try { s.callback(entry.frame); } catch {
                console.warn('[onebot] 入站恢复事件处理失败，继续分发后续已验身事件');
              }
            }
            // Release synchronously, not in a later finally microtask: otherwise
            // an event queued between drain and finally would be silently erased.
            if (s.recovery === recovery) s.recovery = null;
          })
          .catch(() => { /* #probe fences this generation on identity/transport failure. */ })
          .finally(() => {
            // An old probe must never clear a newer connection's recovery.
            if (s.recovery !== recovery) return;
            recovery.frames.length = 0;
            recovery.bytes = 0;
            s.recovery = null;
          });
      };
      const elapsed = Number(process.hrtime.bigint()) / 1e6 - (s.localRecoverAt || 0);
      const delay = s.localRecoverAt ? Math.max(0, RECOVERY_INTERVAL_MS - elapsed) : 0;
      if (delay > 0) {
        recovery.timer = setTimeout(run, delay);
        recovery.timer.unref?.();
      } else run();
    }

    async connect() { revoke(this); return super.connect(); }
    async reconnect() { revoke(this); return super.reconnect(); }
    close() { revoke(this); return super.close(); }

    async #probe(transport, snap, action, timeoutMs, signal) {
      check(this, snap, action, signal);
      let info;
      try {
        const beforeEchoSeq = this.wsEchoSeq;
        const request = (transport === 'ws' ? rawWs : rawHttp).call(
          this, 'get_login_info', {}, Math.min(timeoutMs, PROBE_TIMEOUT_MS), signal);
        const recovery = state(this).recovery;
        // The pinned upstream allocates exactly ws_<++seq> synchronously. Only
        // associate a newly allocated echo with this particular recovery token.
        if (transport === 'ws' && signal && recovery?.controller.signal === signal
          && Number.isSafeInteger(beforeEchoSeq) && this.wsEchoSeq === beforeEchoSeq + 1) {
          recovery.echo = `ws_${this.wsEchoSeq}`;
        }
        info = await request;
      } catch {
        // Only revoke the current generation: an old failed request must not
        // disturb a newer connection. Either way no business call is dispatched.
        if (current(this, snap)) revoke(this, true);
        throw denied(action, `${transport} identity probe failed`);
      }
      check(this, snap, action, signal);
      if (!isExpected(info)) {
        revoke(this);
        throw denied(action, `${transport} identity is missing or not the fixed expected account`);
      }
      if (transport === 'ws') {
        state(this).wsProof = snap;
        state(this).info = plainInfo(info);
      }
      return plainInfo(info);
    }

    #enqueue(action, params, timeoutMs, signal, forceWs) {
      if (verifyOnly && action !== 'get_login_info') return Promise.reject(denied(action,'no companion peer authorized'));
      if (typeof action !== 'string' || !/^[a-zA-Z0-9_]+$/.test(action)) {
        return Promise.reject(denied('', 'invalid action name'));
      }
      // Serialize exactly once BEFORE probing. The params/toJSON must not change
      // transport or execute side effects between the probe and business send.
      let frozenParams;
      let transport;
      try {
        const json = JSON.stringify(params);
        frozenParams = JSON.parse(json);
        transport = forceWs || Buffer.byteLength(json) > HTTP_BODY_SAFE_MAX ? 'ws' : 'http';
      } catch { return Promise.reject(denied(action, 'params are not JSON serializable')); }
      const snap = snapshot(this);
      const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
      const s = state(this);
      const operation = s.tail.then(async () => {
        check(this, snap, action, signal);
        if (action === 'get_login_info') {
          // Upstream open uses call(get_login_info). Bind event identity to this
          // WS socket as well as checking the separately configured HTTP endpoint.
          const wsInfo = await this.#probe('ws', snap, action, timeout, signal);
          if (!forceWs) await this.#probe('http', snap, action, timeout, signal);
          check(this, snap, action, signal);
          if (!forceWs) s.dualProof = snap;
          return wsInfo;
        }
        // No outbound identity cache / TTL. EVERY business call has its own
        // probe on the SAME transport immediately before low-level dispatch.
        if (process.env.QQ_AGENT_BINDING_ID && !this.dualVerified) {
          await this.#probe('ws', snap, action, timeout, signal);
          await this.#probe('http', snap, action, timeout, signal);
          check(this, snap, action, signal);
          s.dualProof = snap;
        }
        await this.#probe(transport, snap, action, timeout, signal);
        check(this, snap, action, signal);
        // Deliberately no await/callback between final check and low-level call.
        // Select rawWs ourselves for oversize bodies to avoid the upstream
        // this.callViaWs branch causing recursive queue deadlock / double probes.
        return (transport === 'ws' ? rawWs : rawHttp).call(this, action, frozenParams, timeout, signal);
      });
      // Failure is returned to the caller, not retried. Later calls start their
      // own fresh probes. Serializing also prevents late parallel probe success
      // from superseding a newer mismatch in the same generation.
      s.tail = operation.then(() => {}, () => {});
      return operation;
    }

    call(action, params = {}, timeoutMs = 15000, signal) {
      return this.#enqueue(action, params, timeoutMs, signal, false);
    }
    callViaWs(action, params = {}, timeoutMs = 15000, signal) {
      return this.#enqueue(action, params, timeoutMs, signal, true);
    }
  }

  // Changing a destination/token away and back still invalidates outstanding
  // probes. Snapshot equality alone would miss that ABA configuration race.
  for (const name of ['httpUrl', 'wsUrl', 'httpToken', 'accessToken']) {
    Object.defineProperty(GuardedOneBotClient.prototype, name, {
      get() { return state(this).config[name]; },
      set(value) {
        const s = state(this);
        if (s.config[name] !== value) revoke(this);
        s.config[name] = value;
      }
    });
  }
  return GuardedOneBotClient;
}
