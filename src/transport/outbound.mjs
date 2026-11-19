import { createHmac, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { attachActions, checkOptions, sendFrame } from './server.mjs';
import { BOT_UIN } from '../config/account.mjs';

// Outbound transports deliberately only accept numeric loopback destinations.
// Reconnection reconnects the transport; requests/events are never replayed.
function endpoint(input, protocols) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid transport endpoint'); }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
    throw new Error('Explicit loopback endpoint without credentials or query required');
  return url;
}
export function createReverseWebSocket(options) {
  return prepareReverseWebSocket(options)();
}

export function prepareReverseWebSocket({ url, token, dispatch, events, selfId = Number(BOT_UIN),
  role = 'Universal', maxAttempts = 8, baseDelayMs = 500, maxDelayMs = 30000, stableConnectionMs = 30000,
  maxBodyBytes = 8 * 1024 * 1024, maxBufferedBytes = 16 * 1024 * 1024,
  maxInflight = 16, heartbeatMs = 15000, status = () => ({ online: false, good: false }),
  pingIntervalMs = 30000, pongTimeoutMs = 10000,
  closeWsOnUnknownOutcome = false, onState = () => {} } = {}) {
  checkOptions({ dispatch, events, token });
  if (/[^\x09\x20-\x7e\x80-\xff]/.test(token)) throw new Error('Invalid reverse WebSocket token header');
  const target = endpoint(url, ['ws:', 'wss:']);
  if (!['Universal', 'API', 'Event'].includes(role)) throw new Error('Invalid reverse WebSocket role');
  for (const value of [maxAttempts, baseDelayMs, maxDelayMs, stableConnectionMs, maxBodyBytes, maxBufferedBytes, maxInflight])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid reverse transport limit');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) throw new Error('Invalid heartbeat interval');
  if (!Number.isSafeInteger(pingIntervalMs) || pingIntervalMs < 0 || pingIntervalMs > 2147483647 ||
      !Number.isSafeInteger(pongTimeoutMs) || pongTimeoutMs < 1 || pongTimeoutMs > 2147483647)
    throw new Error('Invalid WebSocket liveness interval');
  return () => startReverseWebSocket({ target, token, dispatch, events, selfId, role, maxAttempts, baseDelayMs,
    maxDelayMs, stableConnectionMs, maxBodyBytes, maxBufferedBytes, maxInflight, heartbeatMs, status,
    pingIntervalMs, pongTimeoutMs, closeWsOnUnknownOutcome, onState });
}

function startReverseWebSocket({ target, token, dispatch, events, selfId, role, maxAttempts, baseDelayMs,
  maxDelayMs, stableConnectionMs, maxBodyBytes, maxBufferedBytes, maxInflight, heartbeatMs, status,
  pingIntervalMs, pongTimeoutMs, closeWsOnUnknownOutcome, onState }) {
  let closed = false, timer, ws, closePromise, attempts = 0, consecutiveAttempts = 0;
  const report = state => { try { onState({ state, attempts }); } catch {} };
  const broadcast = event => {
    if (role === 'API' || !event || typeof event !== 'object' || Array.isArray(event) || !ws) return;
    const frame = { ...event }; delete frame.echo; sendFrame(ws, frame, maxBufferedBytes);
  };
  events.on('event', broadcast);
  const heartbeat = heartbeatMs && role !== 'API' ? setInterval(() => {
    try { broadcast({ time: Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'meta_event',
      meta_event_type: 'heartbeat', status: status(), interval: heartbeatMs }); } catch {}
  }, heartbeatMs) : null;
  heartbeat?.unref();
  const connect = () => {
    if (closed) return;
    attempts++;
    consecutiveAttempts++;
    report('connecting');
    if (closed) return;
    const socket = ws = new WebSocket(target, { headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': String(selfId),
      'X-Client-Role': role, 'User-Agent': 'Whale-OneBot/0.1' }, maxPayload: maxBodyBytes,
      followRedirects: false, handshakeTimeout: 10000, perMessageDeflate: false });
    attachActions(socket, { dispatch, maxBufferedBytes, maxInflight, enabled: role !== 'Event', closeWsOnUnknownOutcome });
    let openedAt, livenessTimer, pingPayload;
    const schedulePing = () => {
      if (!pingIntervalMs || closed || socket.readyState !== WebSocket.OPEN) return;
      livenessTimer = setTimeout(() => {
        pingPayload = randomBytes(8);
        livenessTimer = setTimeout(() => socket.terminate(), pongTimeoutMs);
        livenessTimer.unref();
        socket.ping(pingPayload, error => { if (error) socket.terminate(); });
      }, pingIntervalMs);
      livenessTimer.unref();
    };
    socket.on('pong', data => {
      if (!pingPayload?.equals(data)) return;
      pingPayload = undefined;
      clearTimeout(livenessTimer);
      schedulePing();
    });
    socket.on('open', () => {
      openedAt = performance.now();
      report('connected');
      if (closed) return;
      schedulePing();
      if (role !== 'API') sendFrame(socket, { time: Math.floor(Date.now() / 1000), self_id: selfId,
        post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }, maxBufferedBytes);
    });
    socket.on('close', () => {
      clearTimeout(livenessTimer);
      if (closed) return;
      if (openedAt !== undefined && performance.now() - openedAt >= stableConnectionMs) consecutiveAttempts = 0;
      if (consecutiveAttempts >= maxAttempts) { clearInterval(heartbeat); events.off('event', broadcast); report('exhausted'); return; }
      report('disconnected');
      if (closed) return;
      const exponent = Math.max(0, Math.min(consecutiveAttempts - 1, 20));
      timer = setTimeout(connect, Math.min(maxDelayMs, baseDelayMs * 2 ** exponent));
      timer.unref();
    });
  };
  connect();
  return { close() {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    events.off('event', broadcast);
    closePromise = new Promise(resolve => {
      if (!ws || ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      ws.once('close', resolve);
      ws.terminate();
    });
    report('closed');
    return closePromise;
  },
    get attempts() { return attempts; } };
}

export function createWebhook({ url, token, secret, events, selfId = Number(BOT_UIN),
  timeoutMs = 5000, maxPending = 128, maxBodyBytes = 8 * 1024 * 1024,
  maxPendingBytes = 16 * 1024 * 1024, maxResponseBytes = 8 * 1024 * 1024,
  prepareQuickOperation = events?.prepareQuickOperation, onDelivery = () => {} } = {}) {
  const target = endpoint(url, ['http:', 'https:']);
  checkOptions({ dispatch: () => {}, events, token });
  if (secret !== undefined && (typeof secret !== 'string' || !secret || secret.length > 4096))
    throw new Error('Invalid webhook signing secret');
  for (const value of [timeoutMs, maxPending, maxBodyBytes, maxPendingBytes, maxResponseBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid webhook limit');
  if(prepareQuickOperation!==undefined&&typeof prepareQuickOperation!=='function')throw new Error('Invalid quick-operation handler');
  let closed = false, active = false, pendingBytes = 0, drainPromise;
  const lifetime = new AbortController();
  const queue = [], controllers = new Set();
  const report = result => { try { onDelivery(result); } catch {} };
  async function drain() {
    if (active || closed) return;
    active = true;
    while (!closed && queue.length) {
      const job = queue.shift(), {body,quickOperation} = job, controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status;
      try {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Self-ID': String(selfId),
          ...(secret ? { 'X-Signature': 'sha1=' + createHmac('sha1', secret).update(body).digest('hex') } : {}) };
        const response = await fetch(target, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
        status=response.status;
        if(!response.ok||!quickOperation||response.status===204){
          await response.body?.cancel();report({delivered:response.ok,status});continue;
        }
        const chunks=[];let bytes=0;
        if(response.body)for await(const chunk of response.body){
          bytes+=chunk.byteLength;if(bytes>maxResponseBytes)throw new Error('Quick response too large');
          chunks.push(chunk);
        }
        const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)).trim();
        if(!text){report({delivered:true,status});continue;}
        if(closed||controller.signal.aborted){report({delivered:true,status,quickOperations:{accepted:false,reason:'cancelled',queued:0}});continue;}
        const result=await quickOperation(JSON.parse(text),{signal:lifetime.signal});
        report({delivered:true,status,quickOperations:result});
      } catch { report(status===undefined?{delivered:false,outcome:'unknown'}:{delivered:status>=200&&status<300,status,quickOperations:{accepted:false,reason:'invalid_response',queued:0}}); }
      finally { pendingBytes-=job.bytes;clearTimeout(timer); controllers.delete(controller); }
    }
    active = false;
  }
  const listener = event => {
    if (closed) return;
    let body;
    try { const frame = { ...event }; delete frame.echo; body = JSON.stringify(frame); } catch { report({ delivered: false, outcome: 'invalid' }); return; }
    const bytes=Buffer.byteLength(body);
    if (queue.length + (active ? 1 : 0) >= maxPending || bytes > maxBodyBytes || pendingBytes+bytes>maxPendingBytes) {
      report({ delivered: false, outcome: 'dropped' }); return;
    }
    let quickOperation;
    try{quickOperation=prepareQuickOperation?.(event);}catch{report({delivered:false,outcome:'invalid'});return;}
    if(quickOperation!==undefined&&quickOperation!==null&&typeof quickOperation!=='function'){report({delivered:false,outcome:'invalid'});return;}
    pendingBytes+=bytes;queue.push({body,bytes,quickOperation});
    if(!active)drainPromise=drain();
  };
  events.on('event', listener);
  return { close() {
    if (!closed) {
      closed = true;
      lifetime.abort();
      pendingBytes -= queue.reduce((sum, job) => sum + job.bytes, 0);
      queue.length = 0;
      events.off('event', listener);
      for (const controller of controllers) controller.abort();
    }
    return drainPromise;
  } };
}
