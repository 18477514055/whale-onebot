import http from 'node:http';

const PATH = '/v1/chat/completions';
const STATUS = Object.freeze({ INVALID_REQUEST: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  INPUT_TOO_LARGE: 413, BUDGET_EXHAUSTED: 429, CONCURRENCY_LIMIT: 429,
  UPSTREAM_FAILURE: 502, UNSAFE_RESPONSE: 502, OUTPUT_TOO_LARGE: 502,
  TIMEOUT: 504, CANCELLED: 499, CLOSED: 503, CHANNEL_PROTOCOL: 502 });
const FIELDS = new Set(['model', 'messages', 'stream', 'n', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'stop', 'tools', 'tool_choice',
  'parallel_tool_calls', 'response_format', 'reasoning_effort']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (n, min = 1) => Number.isSafeInteger(n) && n >= min;
const errorBody = code => ({ error: { code } });
const decoder = new TextDecoder('utf-8', { fatal: true });
function config(stream, options) {
  const { maxRequests = 6, maxConcurrent = 2, maxBytes = 2097152, timeoutMs = 20000 } = options;
  if (!stream || typeof stream.write !== 'function' || typeof stream.on !== 'function' ||
      typeof stream.destroy !== 'function' || stream.destroyed || stream.readableObjectMode || stream.writableObjectMode ||
      !integer(maxRequests, 0) || !integer(maxConcurrent) || !integer(maxBytes) || maxBytes > 0x7fffffff ||
      !integer(timeoutMs) || timeoutMs > 0x7fffffff) throw new TypeError('MODEL_CHANNEL_INVALID_CONFIG');
  return { maxRequests, maxConcurrent, maxBytes, timeoutMs };
}
function requestValid(body, model) {
  return object(body) && Object.keys(body).every(key => FIELDS.has(key)) &&
    typeof body.model === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,199}$/iu.test(body.model) &&
    (model === undefined || body.model === model) && body.stream === false && body.n === 1 &&
    Array.isArray(body.messages) && body.messages.length > 0 && body.messages.every(message =>
      object(message) && ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) &&
      (typeof message.content === 'string' || message.content === null || Array.isArray(message.content) ||
        (message.role === 'assistant' && Array.isArray(message.tool_calls))));
}
function successValid(body) {
  return object(body) && !Object.hasOwn(body, 'error') && Array.isArray(body.choices) && body.choices.length === 1 &&
    object(body.choices[0]) && object(body.choices[0].message) && body.choices[0].message.role === 'assistant' &&
    (typeof body.choices[0].message.content === 'string' || body.choices[0].message.content === null ||
      Array.isArray(body.choices[0].message.tool_calls));
}
function encode(value, maxBytes) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (!payload.length || payload.length > maxBytes) return null;
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length); payload.copy(frame, 4);
  return frame;
}

// Owns the supplied binary Duplex, not its construction or listener binding. One
// frame is allocated only after validating its unsigned big-endian length. Never
// concatenate arbitrary chunks, log payloads, reopen a transport, or retry writes.
function transport(stream, limits, receive, failed) {
  let closed = false, headerBytes = 0, payloadBytes = 0, payload = null, frameTimer;
  const header = Buffer.alloc(4), queue = [];
  let writing = false, writeTimer, currentDrain;
  function stop(code = 'CLOSED') {
    if (closed) return;
    closed = true; clearTimeout(frameTimer); clearTimeout(writeTimer); payload = null; queue.length = 0;
    if (currentDrain) stream.off('drain', currentDrain);
    stream.off('data', data); stream.destroy(); failed(code);
  }
  function pump() {
    if (closed || writing || !queue.length) return;
    writing = true;
    writeTimer = setTimeout(() => stop('TIMEOUT'), limits.timeoutMs); writeTimer.unref();
    const frame = queue.shift();
    let flushed = false, drained = false, returned = false;
    const next = () => {
      if (!returned || !flushed || !drained || closed) return;
      clearTimeout(writeTimer); stream.off('drain', drain); currentDrain = null; writing = false; pump();
    };
    const drain = () => { drained = true; next(); };
    currentDrain = drain; stream.once('drain', drain);
    try {
      const ready = stream.write(frame, error => {
        if (error) { stream.off('drain', drain); stop('CLOSED'); return; }
        flushed = true; next();
      });
      drained ||= ready; returned = true; next();
    } catch { stream.off('drain', drain); stop('CLOSED'); }
  }
  function data(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) { stop('CHANNEL_PROTOCOL'); return; }
    let offset = 0;
    while (!closed && offset < chunk.length) {
      if (!headerBytes && !payload) {
        frameTimer = setTimeout(() => stop('TIMEOUT'), limits.timeoutMs); frameTimer.unref();
      }
      if (!payload) {
        const size = Math.min(4 - headerBytes, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + size), headerBytes); headerBytes += size; offset += size;
        if (headerBytes < 4) continue;
        const length = header.readUInt32BE();
        if (!length || length > limits.maxBytes) { stop('CHANNEL_PROTOCOL'); return; }
        payload = Buffer.allocUnsafe(length); payloadBytes = 0;
      }
      const size = Math.min(payload.length - payloadBytes, chunk.length - offset);
      payload.set(chunk.subarray(offset, offset + size), payloadBytes); payloadBytes += size; offset += size;
      if (payloadBytes === payload.length) {
        clearTimeout(frameTimer);
        let value;
        try { value = JSON.parse(decoder.decode(payload)); }
        catch { stop('CHANNEL_PROTOCOL'); return; }
        payload = null; headerBytes = 0;
        try { receive(value); } catch { stop('CHANNEL_PROTOCOL'); }
      }
    }
  }
  stream.on('data', data);
  stream.on('error', () => stop('CLOSED'));
  stream.once('end', () => stop('CLOSED'));
  stream.once('close', () => stop('CLOSED'));
  return {
    stop,
    send(value) {
      if (closed) return false;
      let frame;
      try { frame = encode(value, limits.maxBytes); } catch { return false; }
      if (!frame) return false;
      if (queue.length >= limits.maxConcurrent * 2 + 2) { stop('CHANNEL_PROTOCOL'); return false; }
      queue.push(frame); pump(); return !closed;
    },
  };
}

/**
 * Parent capability: v1 frames are {type:'request',id,body}, {type:'cancel',id},
 * and {type:'response',id,status,body}. IDs start at 1 and requests increase by
 * exactly one; responses may finish out of order. maxBytes includes the JSON
 * envelope (but excludes its four-byte prefix). Only status 200 chat shapes or
 * locally defined error codes cross the channel. dispatch receives no URL,
 * headers, credentials or arbitrary routing authority. It MUST honor signal;
 * ignored cancellation retains its concurrency slot until dispatch settles.
 */
export function serveModelChannel(stream, { dispatch, ...options } = {}) {
  const limits = config(stream, options);
  if (typeof dispatch !== 'function') throw new TypeError('MODEL_CHANNEL_INVALID_CONFIG');
  const counts = { requests: 0, succeeded: 0, rejected: 0, cancelled: 0 };
  const active = new Map(), cancelled = new Set();
  let closed = false, lastId = 0, running = 0;
  const channel = transport(stream, limits, receive, () => {
    closed = true;
    for (const entry of active.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    active.clear();
  });
  function respond(id, status, body) {
    if (!closed && !channel.send({ type: 'response', id, status, body })) channel.stop('CHANNEL_PROTOCOL');
  }
  function finish(entry, code, body) {
    if (entry.done || closed) return;
    entry.done = true; clearTimeout(entry.timer); active.delete(entry.id);
    if (code) { counts.rejected++; entry.controller.abort(); }
    else counts.succeeded++;
    respond(entry.id, code ? STATUS[code] : 200, code ? errorBody(code) : body);
  }
  function receive(message) {
    if (exact(message, ['type', 'id']) && message.type === 'cancel') {
      if (!integer(message.id) || message.id > lastId || cancelled.has(message.id)) return channel.stop('CHANNEL_PROTOCOL');
      cancelled.add(message.id); counts.cancelled++;
      const entry = active.get(message.id);
      if (entry) finish(entry, 'CANCELLED');
      return;
    }
    if (!exact(message, ['type', 'id', 'body']) || message.type !== 'request' ||
        !integer(message.id) || message.id !== lastId + 1 || !requestValid(message.body)) return channel.stop('CHANNEL_PROTOCOL');
    lastId = message.id;
    // No unbounded history or submission stream once the lifetime budget ends.
    if (lastId > limits.maxRequests) return channel.stop('CHANNEL_PROTOCOL');
    if (running >= limits.maxConcurrent) { counts.rejected++; respond(message.id, 429, errorBody('CONCURRENCY_LIMIT')); return; }
    counts.requests++; running++;
    const entry = { id: message.id, controller: new AbortController(), done: false };
    active.set(entry.id, entry);
    entry.timer = setTimeout(() => finish(entry, 'TIMEOUT'), limits.timeoutMs); entry.timer.unref();
    // Invoke once, including synchronous throws; never await an uncooperative
    // dispatch during close and never send a second result after timeout/cancel.
    Promise.resolve().then(() => {
      if (closed || entry.done) return undefined;
      return dispatch(message.body, { signal: entry.controller.signal });
    }).then(result => {
      if (entry.done || closed) return;
      if (!exact(result, ['status', 'body']) || result.status !== 200 || !successValid(result.body)) {
        finish(entry, 'UNSAFE_RESPONSE'); return;
      }
      let bounded;
      try { bounded = encode({ type: 'response', id: entry.id, status: 200, body: result.body }, limits.maxBytes); } catch { /* fixed failure below */ }
      if (!bounded) finish(entry, 'OUTPUT_TOO_LARGE');
      else finish(entry, null, result.body);
    }).catch(() => finish(entry, 'UPSTREAM_FAILURE')).finally(() => { running--; });
  }
  return {
    stats: () => ({ ...counts, active: active.size, running, closed }),
    close() { channel.stop(); return Promise.resolve(); },
  };
}

/** Child relay. Caller alone binds server to its private namespace's loopback. */
export function createChannelModelRelay(stream, { model, ...options } = {}) {
  const limits = config(stream, options);
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,199}$/iu.test(model)) throw new TypeError('MODEL_CHANNEL_INVALID_CONFIG');
  const counts = { received: 0, requests: 0, succeeded: 0, rejected: 0, cancelled: 0 };
  const pending = new Map(), abandoned = new Set(), contexts = new Set(), sockets = new Set();
  const headerTimers = new WeakMap();
  let closed = false, nextId = 0, closing;
  const channel = transport(stream, limits, receive, code => {
    closed = true;
    for (const context of [...contexts]) context.fail(code);
    pending.clear(); abandoned.clear();
  });
  function receive(message) {
    if (!exact(message, ['type', 'id', 'status', 'body']) || message.type !== 'response' || !integer(message.id)) return channel.stop('CHANNEL_PROTOCOL');
    const context = pending.get(message.id);
    if (!context && !abandoned.has(message.id)) return channel.stop('CHANNEL_PROTOCOL');
    const success = message.status === 200 && successValid(message.body);
    const code = exact(message.body, ['error']) && exact(message.body.error, ['code']) && message.body.error.code;
    if (!success && !(typeof code === 'string' && Object.hasOwn(STATUS, code) && STATUS[code] === message.status)) return channel.stop('CHANNEL_PROTOCOL');
    if (!context) { abandoned.delete(message.id); return; }
    pending.delete(message.id); context.id = null;
    if (success) context.finish(200, message.body);
    else context.fail(code);
  }
  function handle(req, res, forceInvalid = false) {
    clearTimeout(headerTimers.get(req.socket)); headerTimers.delete(req.socket);
    counts.received++;
    let done = false, size = 0, chunks = [], timer;
    const context = { id: null, fail, finish };
    function cleanup() {
      contexts.delete(context); chunks = [];
      req.off('data', data); req.off('end', end);
    }
    function finish(status, body) {
      if (done) return;
      done = true; cleanup();
      if (status === 200) counts.succeeded++; else counts.rejected++;
      if (!res.destroyed && !res.writableEnded) {
        const payload = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
          'content-length': payload.length, 'cache-control': 'no-store', connection: 'close' });
        res.end(payload);
      }
    }
    function fail(code) {
      if (done) return;
      if (context.id !== null) {
        const id = context.id; context.id = null; pending.delete(id); abandoned.add(id);
        if (!closed) channel.send({ type: 'cancel', id });
      }
      finish(STATUS[code], errorBody(code));
      // Rejections must not retain arbitrary unread bodies or keep-alive sessions.
      if (!req.complete) res.once('finish', () => req.socket.destroy());
    }
    function disconnected() { if (!done) { counts.cancelled++; fail('CANCELLED'); } }
    timer = setTimeout(() => {
      if (!done) {
        fail('TIMEOUT');
        // Permit only a short bounded flush of the fixed timeout error.
        timer = setTimeout(() => { if (!res.writableFinished) res.destroy(); }, Math.min(100, limits.timeoutMs));
        timer.unref();
      } else if (!res.writableFinished) res.destroy();
    }, limits.timeoutMs); timer.unref();
    req.on('error', disconnected); req.once('aborted', disconnected);
    res.on('error', disconnected); res.once('finish', () => clearTimeout(timer));
    res.once('close', () => { clearTimeout(timer); if (!res.writableFinished) disconnected(); });
    if (closed) return fail('CLOSED');
    if (forceInvalid) return fail('INVALID_REQUEST');
    if (req.url !== PATH) return fail('NOT_FOUND');
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED');
    if (contexts.size >= limits.maxConcurrent) return fail('CONCURRENCY_LIMIT');
    if (counts.requests >= limits.maxRequests) return fail('BUDGET_EXHAUSTED');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '') ||
        (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) return fail('INVALID_REQUEST');
    if (Number(req.headers['content-length']) > limits.maxBytes) return fail('INPUT_TOO_LARGE');
    contexts.add(context);
    function data(chunk) {
      size += chunk.length;
      if (size > limits.maxBytes) return fail('INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    function end() {
      if (done) return;
      let body;
      try { body = JSON.parse(decoder.decode(Buffer.concat(chunks, size))); } catch { return fail('INVALID_REQUEST'); }
      chunks = [];
      if (!object(body) || (Object.hasOwn(body, 'stream') && body.stream !== false) ||
          (Object.hasOwn(body, 'n') && body.n !== 1)) return fail('INVALID_REQUEST');
      body = { ...body, stream: false, n: 1 };
      if (!requestValid(body, model)) return fail('INVALID_REQUEST');
      // Multiple bodies can finish in the same turn; charge synchronously here.
      if (counts.requests >= limits.maxRequests) return fail('BUDGET_EXHAUSTED');
      const id = nextId + 1;
      if (!encode({ type: 'request', id, body }, limits.maxBytes)) return fail('INPUT_TOO_LARGE');
      counts.requests++; nextId = id; context.id = id; pending.set(id, context);
      if (!channel.send({ type: 'request', id, body })) fail('CLOSED');
    }
    req.on('data', data); req.once('end', end);
  }
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: limits.timeoutMs,
    headersTimeout: limits.timeoutMs, keepAliveTimeout: 1 }, handle);
  // Bound even sockets still reading headers or draining a response. Excess
  // connections may be dropped by Node before an HTTP error can be returned.
  server.maxConnections = limits.maxConcurrent + 2;
  server.maxRequestsPerSocket = 1;
  server.on('checkContinue', (req, res) => handle(req, res, true));
  server.on('checkExpectation', (req, res) => handle(req, res, true));
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('connection', socket => {
    const timer = setTimeout(() => socket.destroy(), limits.timeoutMs); timer.unref();
    headerTimers.set(socket, timer); sockets.add(socket);
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
  });
  return {
    server,
    stats: () => ({ ...counts, active: contexts.size, pending: pending.size, closed }),
    close() {
      if (closing) return closing;
      channel.stop();
      closing = new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
