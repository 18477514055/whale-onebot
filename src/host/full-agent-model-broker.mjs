import http from 'node:http';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

const PATH = '/v1/chat/completions';
const OPENCODE_ENDPOINTS = new Map([
  ['/inference/go/openai/v1', '/inference/go/openai/v1/chat/completions'],
  ['/inference/openai/v1', '/inference/openai/v1/chat/completions'],
].flatMap(([base, endpoint]) => [[base, endpoint], [`${base}/`, endpoint], [endpoint, endpoint]]));
const CLIENT_USER_AGENT = 'whale-onebot-integration-test/0.1';
const CODES = Object.freeze({
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INVALID_REQUEST: 400,
  INPUT_TOO_LARGE: 413,
  BUDGET_EXHAUSTED: 429,
  UPSTREAM_FAILURE: 502,
  OUTPUT_TOO_LARGE: 502,
  UNSAFE_RESPONSE: 502,
  TIMEOUT: 504,
  CANCELLED: 499,
  CLOSED: 503,
  INTERNAL_ERROR: 500,
});
const FIELDS = new Set([
  'model', 'messages', 'stream', 'n', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'stop',
  'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort',
]);
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const configError = () => new TypeError('MODEL_BROKER_INVALID_CONFIG');

class Failure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function positiveInteger(value, allowZero = false) {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

function upstreamUrl(baseUrl, allowLoopbackUpstream) {
  try {
    if (typeof baseUrl !== 'string' || /[\s\\?#]/u.test(baseUrl)) throw configError();
    const authority = /^https?:\/\/([^/]+)(?:\/|$)/iu.exec(baseUrl)?.[1];
    if (!authority || authority.includes('@')) throw configError();
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw configError();
    let endpoint = PATH;
    if (!['/', '/v1', '/v1/', PATH, `${PATH}/`].includes(url.pathname)) {
      const rawPath = /^https?:\/\/[^/]+(\/.*)?$/iu.exec(baseUrl)?.[1] ?? '/';
      endpoint = OPENCODE_ENDPOINTS.get(url.pathname);
      if (!endpoint || url.origin !== 'https://opencode.ai' ||
          !['opencode.ai', 'opencode.ai:443'].includes(authority.toLowerCase()) ||
          rawPath !== url.pathname) throw configError();
    }
    if (url.protocol !== 'https:') {
      const host = authority.startsWith('[')
        ? /^\[([^\]]+)\](?::[0-9]+)?$/u.exec(authority)?.[1]
        : /^([^:]+)(?::[0-9]+)?$/u.exec(authority)?.[1];
      const literalLoopback = host && (
        (isIP(host) === 4 && host.startsWith('127.')) ||
        (isIP(host) === 6 && url.hostname === '[::1]')
      );
      if (url.protocol !== 'http:' || !allowLoopbackUpstream || !literalLoopback) throw configError();
    }
    url.pathname = endpoint;
    return url.href;
  } catch {
    throw configError();
  }
}

function requestBody(value, model, maxTokens) {
  if (!object(value) || Object.keys(value).some((key) => !FIELDS.has(key)) ||
      value.model !== model || !Array.isArray(value.messages) || !value.messages.length ||
      (own(value, 'stream') && value.stream !== false) || (own(value, 'n') && value.n !== 1)) {
    throw new Failure('INVALID_REQUEST');
  }
  for (const message of value.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
        !(typeof message.content === 'string' || message.content === null || Array.isArray(message.content) ||
          (message.role === 'assistant' && Array.isArray(message.tool_calls)))) {
      throw new Failure('INVALID_REQUEST');
    }
  }
  if (own(value, 'max_tokens') && own(value, 'max_completion_tokens')) throw new Failure('INVALID_REQUEST');
  const tokenField = own(value, 'max_completion_tokens') ? 'max_completion_tokens' : 'max_tokens';
  const tokens = own(value, tokenField) ? value[tokenField] : maxTokens;
  if (!positiveInteger(tokens) || tokens > maxTokens) throw new Failure('INVALID_REQUEST');
  return { body: JSON.stringify({ ...value, model, stream: false, n: 1, [tokenField]: tokens }), tokens };
}

// Normal operation preserves request members rather than applying the trial's
// whitelist, n=1 or token budget. Validate only the fixed capability and basic
// non-streaming chat envelope; optional provider parameters remain the App's.
function originalRequestBody(value) {
  if (!object(value) || typeof value.model !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,199}$/iu.test(value.model) ||
      !Array.isArray(value.messages) || !value.messages.length ||
      (own(value, 'stream') && value.stream !== false) ||
      (own(value, 'n') && !positiveInteger(value.n))) throw new Failure('INVALID_REQUEST');
  for (const message of value.messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
        !(typeof message.content === 'string' || message.content === null || Array.isArray(message.content) ||
          (message.role === 'assistant' && Array.isArray(message.tool_calls)))) throw new Failure('INVALID_REQUEST');
  }
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    if (own(value, field) && !positiveInteger(value[field])) throw new Failure('INVALID_REQUEST');
  }
  // Re-serialize the validated object so duplicate model members cannot make
  // upstream and local parsers select different models. No member is injected.
  return { body: JSON.stringify(value) };
}

// Inspect both wire text and the parsed tree: escaped strings and duplicate JSON
// fields must not evade screening. Iteration avoids recursion on deeply nested JSON.
function reflectsKey(value, apiKey, text, plainText = false) {
  // Scan every primitive too, including duplicate object members overwritten by
  // JSON.parse. Parsing each lexical primitive decodes escaped key/value text.
  const primitives = /"(?:[^"\\]|\\[\s\S])*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/gu;
  for (const token of text.matchAll(primitives)) {
    let decoded;
    try { decoded = JSON.parse(token[0]); }
    catch {
      // Provider text need not be valid JSON. Scan valid JSON-escaped fragments
      // without treating an unrelated quoted backslash as a transport failure.
      if (plainText) continue;
      throw new Failure('UPSTREAM_FAILURE');
    }
    if (String(decoded).includes(apiKey)) return true;
  }
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item !== null && typeof item === 'object') {
      for (const key of Object.keys(item)) {
        if (key.includes(apiKey)) return true;
        pending.push(item[key]);
      }
    } else if (String(item).includes(apiKey)) return true;
  }
  return false;
}

function readInput(req, signal, maxBytes, count) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const fail = (failure) => { cleanup(); reject(failure); };
    const data = (chunk) => {
      bytes += chunk.length;
      count(chunk.length);
      if (bytes > maxBytes) { fail(new Failure('INPUT_TOO_LARGE')); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const error = () => fail(new Failure('CANCELLED'));
    const abort = () => fail(new Failure('CANCELLED'));
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function readOutput(response, maxBytes, count) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > maxBytes)) {
    throw new Failure('OUTPUT_TOO_LARGE');
  }
  if (!response.body) throw new Failure('UPSTREAM_FAILURE');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      count(value.byteLength);
      if (bytes > maxBytes) throw new Failure('OUTPUT_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    reader.releaseLock();
  }
}

/**
 * A credential-holding, non-streaming, one-model HTTP capability. This function
 * never listens: the caller owns listener binding (prefer a permissioned IPC
 * socket), access control, and its lifetime. Standard baseUrl accepts an origin,
 * /v1, or the exact completions path. Only https://opencode.ai additionally
 * accepts the two explicit inference OpenAI v1 bases/endpoints above; Go and
 * ordinary inference are never inferred, switched, or used as fallbacks.
 * The local capability remains POST /v1/chat/completions in all modes.
 * OpenCode receives a random per-broker session and this integration's truthful
 * User-Agent, not the identity of a coding-agent product. No API eligibility is
 * implied: the caller must independently authorize the chosen service and model.
 * maxRequests is a lifetime submission budget, charged immediately before fetch.
 * maxTokens caps requested completion tokens, not independently tokenized text;
 * returned usage.completion_tokens, when present, must also respect the cap.
 * No request/response data, credentials, URLs, or exception details are logged.
 */
export function createModelBroker(options = {}) {
  return createBroker(options);
}

/**
 * Original-mode relay: the same bounded, credential-holding transport, without
 * the trial factory's lifetime request quota or completion-token cap/injection.
 * The App retains its model and every request member, including omitted n and
 * token limits. SSE is deliberately unsupported: the original App uses JSON.
 * Safe provider 4xx/5xx statuses and JSON/text error bodies pass through so the
 * original App keeps its own retry/auth classification; no upstream headers do.
 * Only the approved Go endpoint is allowed in normal operation. An explicit
 * literal-loopback HTTP target is available for synthetic tests, never a tier
 * fallback. Listener authentication still belongs to the caller (for example,
 * protectLocalBroker); this factory does not listen or acquire credentials.
 */
export function createOriginalModelBroker(options = {}) {
  if (!object(options) || own(options, 'maxRequests') || own(options, 'maxTokens')) throw configError();
  return createBroker({ maxInputBytes: 8388608, maxOutputBytes: 8388608, timeoutMs: 60000, ...options }, true);
}

function createBroker({
  baseUrl,
  apiKey,
  model,
  maxRequests = 6,
  maxTokens = 512,
  maxInputBytes = 2097152,
  maxOutputBytes = 2097152,
  timeoutMs = 20000,
  allowLoopbackUpstream = false,
} = {}, originalMode = false) {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/u.test(apiKey) ||
      (!(originalMode && model === undefined) &&
        (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,199}$/iu.test(model))) ||
      typeof allowLoopbackUpstream !== 'boolean' ||
      (!originalMode && (!positiveInteger(maxRequests, true) || !positiveInteger(maxTokens))) ||
      !positiveInteger(maxInputBytes) || !positiveInteger(maxOutputBytes) ||
      !positiveInteger(timeoutMs) || timeoutMs > 2147483647) throw configError();
  const target = upstreamUrl(baseUrl, allowLoopbackUpstream);
  if (originalMode && target !== 'https://opencode.ai/inference/go/openai/v1/chat/completions' &&
      !(allowLoopbackUpstream && new URL(target).protocol === 'http:')) throw configError();
  const openCodeHeaders = new URL(target).origin === 'https://opencode.ai'
    ? { 'x-opencode-session': randomUUID(), 'user-agent': CLIENT_USER_AGENT }
    : {};
  const counts = {
    received: 0, requests: 0, succeeded: 0, rejected: 0, inputBytes: 0, outputBytes: 0,
    codes: Object.fromEntries(Object.keys(CODES).map((code) => [code, 0])),
  };
  const active = new Set();
  const running = new Set();
  const sockets = new Set();
  let closed = false;
  let closing;

  function handle(req, res, forceInvalid = false) {
    counts.received++;
    const controller = new AbortController();
    let settled = false;
    let successPending = false;
    const finish = () => {
      if (!settled && successPending && res.writableFinished) {
        settled = true;
        counts.succeeded++;
      }
      clearTimeout(timer);
      active.delete(context);
      req.off('aborted', disconnected);
    };
    const fail = (code) => {
      if (settled) return;
      settled = true;
      counts.rejected++;
      counts.codes[code]++;
      controller.abort();
      if (res.headersSent) res.destroy();
      else if (!res.destroyed && !res.writableEnded) {
        const payload = JSON.stringify({ error: { code } });
        res.writeHead(CODES[code], {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'cache-control': 'no-store',
          connection: 'close',
        });
        res.end(payload);
      }
      // Do not retain unbounded rejected bodies. Connection: close prevents reuse.
      req.resume();
    };
    const disconnected = () => { fail('CANCELLED'); finish(); };
    const context = { fail };
    const timer = setTimeout(() => {
      if (!settled) fail('TIMEOUT');
      else if (!res.writableFinished) { res.destroy(); finish(); }
    }, timeoutMs);
    timer.unref();
    active.add(context);
    req.once('aborted', disconnected);
    // Keep a non-data-bearing error listener even after input reading finishes.
    req.on('error', () => {});
    res.on('error', disconnected);
    res.once('finish', finish);
    res.once('close', () => {
      if (!res.writableFinished) disconnected();
      else finish();
    });

    const operation = (async () => {
      try {
        if (closed) throw new Failure('CLOSED');
        if (forceInvalid) throw new Failure('INVALID_REQUEST');
        if (req.url !== PATH) throw new Failure('NOT_FOUND');
        if (req.method !== 'POST') throw new Failure('METHOD_NOT_ALLOWED');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '') ||
            (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
          throw new Failure('INVALID_REQUEST');
        }
        if (Number(req.headers['content-length']) > maxInputBytes) throw new Failure('INPUT_TOO_LARGE');
        const input = await readInput(req, controller.signal, maxInputBytes, (n) => { counts.inputBytes += n; });
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); }
        catch { throw new Failure('INVALID_REQUEST'); }
        const request = originalMode ? originalRequestBody(value) : requestBody(value, model, maxTokens);
        if (controller.signal.aborted) return;
        if (closed) throw new Failure('CLOSED');
        if (!originalMode && counts.requests >= maxRequests) throw new Failure('BUDGET_EXHAUSTED');
        // Synchronous check-and-charge before the first upstream submission.
        counts.requests++;
        let response;
        try {
          response = await fetch(target, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json',
              ...openCodeHeaders,
            },
            body: request.body,
            redirect: 'error',
            signal: controller.signal,
          });
        } catch { throw new Failure('UPSTREAM_FAILURE'); }
        // The original App classifies retry/auth failures by upstream status and
        // provider text. Retain safe 4xx/5xx results rather than turning them into
        // retryable 502s. Redirects and other non-200 statuses remain rejected.
        const providerError = originalMode && response.status >= 400 && response.status <= 599;
        if (response.status !== 200 && !providerError) throw new Failure('UPSTREAM_FAILURE');
        const output = await readOutput(response, maxOutputBytes, (n) => { counts.outputBytes += n; });
        let parsed;
        let text;
        let jsonOutput = false;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(output);
          try { parsed = JSON.parse(text); jsonOutput = true; }
          catch { if (!providerError) throw new Failure('UPSTREAM_FAILURE'); }
        } catch { throw new Failure('UPSTREAM_FAILURE'); }
        if (text.includes(apiKey) ||
            (providerError && text.replace(/\\u([a-f0-9]{4})/giu, (_match, hex) => String.fromCharCode(parseInt(hex, 16))).includes(apiKey)) ||
            reflectsKey(parsed, apiKey, text, providerError && !jsonOutput)) throw new Failure('UNSAFE_RESPONSE');
        if (!providerError && (!object(parsed) || own(parsed, 'error') || !Array.isArray(parsed.choices) ||
            (originalMode ? parsed.choices.length === 0 : parsed.choices.length !== 1) ||
            (!originalMode && own(parsed, 'usage') && (!object(parsed.usage) ||
              (own(parsed.usage, 'completion_tokens') && (!positiveInteger(parsed.usage.completion_tokens, true) ||
                parsed.usage.completion_tokens > request.tokens)))))) throw new Failure('UNSAFE_RESPONSE');
        if (controller.signal.aborted || closed || res.destroyed) return;
        // No upstream headers, status text, or cookies are propagated. Buffer the
        // entire bounded response before sending any potentially sensitive bytes.
        // The original client does not inspect Retry-After, so no header exception
        // is needed to preserve its behavior.
        res.writeHead(providerError ? response.status : 200, {
          'content-type': jsonOutput ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
          'content-length': output.length,
          'cache-control': 'no-store',
          connection: 'close',
        });
        if (providerError) {
          settled = true;
          counts.rejected++;
          counts.codes.UPSTREAM_FAILURE++;
        } else successPending = true;
        res.end(output);
      } catch (error) {
        if (!controller.signal.aborted) fail(error instanceof Failure ? error.code : 'UPSTREAM_FAILURE');
      }
    })();
    running.add(operation);
    void operation.finally(() => { running.delete(operation); });
  }

  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: timeoutMs, headersTimeout: timeoutMs }, handle);
  server.on('checkContinue', (req, res) => handle(req, res, true));
  server.on('checkExpectation', (req, res) => handle(req, res, true));
  const rawFailure = (socket, code) => {
    const payload = JSON.stringify({ error: { code } });
    if (socket.writable) socket.end(`HTTP/1.1 ${CODES[code]} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    else socket.destroy();
  };
  server.on('clientError', (_error, socket) => rawFailure(socket, 'INVALID_REQUEST'));
  server.on('upgrade', (_req, socket) => rawFailure(socket, 'INVALID_REQUEST'));
  server.on('connect', (_req, socket) => rawFailure(socket, 'NOT_FOUND'));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); });
  });

  return {
    server,
    stats() {
      return { ...counts, active: active.size, codes: { ...counts.codes } };
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const context of active) context.fail('CLOSED');
      closing = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }).then(async () => { await Promise.allSettled([...running]); });
      return closing;
    },
  };
}
