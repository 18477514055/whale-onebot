import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createModelBroker, createOriginalModelBroker } from '../src/host/full-agent-model-broker.mjs';

// Synthetic-only credentials and messages; no environment, external services,
// production fixtures, phone, QQ, WSL, or real model calls are used by this file.
const KEY = 'synthetic-broker-test-key-7c49';
const MODEL = 'synthetic-model';
const BODY = { model: MODEL, messages: [{ role: 'user', content: 'synthetic input' }] };
const completion = (extra = {}) => ({
  id: 'synthetic-result',
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic output' }, finish_reason: 'stop' }],
  usage: { completion_tokens: 3 },
  ...extra,
});
const json = (res, body = completion()) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const deferred = () => {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
};
async function listen(server, path) {
  server.listen(path ?? { port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  return server.address();
}
async function stop(server) {
  const closed = new Promise((resolveValue) => { server.close(resolveValue); });
  server.closeAllConnections();
  await closed;
}
async function fixture(t, handler = (_req, res) => json(res), options = {}, factory = createModelBroker) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => {});
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      received.push({ method: req.method, path: req.url, headers: req.headers, body });
      Promise.resolve(handler(req, res, body)).catch(() => res.destroy());
    });
  });
  const address = await listen(upstream);
  const broker = factory({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: KEY, model: MODEL,
    allowLoopbackUpstream: true, ...options,
  });
  const brokerAddress = await listen(broker.server);
  t.after(async () => { await broker.close(); await stop(upstream); });
  return { upstream, broker, received, port: brokerAddress.port, upstreamPort: address.port };
}
function client(port, { method = 'POST', path = '/v1/chat/completions', body = BODY, headers = {} } = {}) {
  return new Promise((resolveValue, reject) => {
    const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(responseText); } catch { data = null; }
        resolveValue({ status: res.statusCode, headers: res.headers, text: responseText, data });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}
async function stubbedBroker(t, baseUrl, options = {}, factory = createModelBroker) {
  // Every test using this helper installs a test-scoped fetch stub first. Only
  // the local HTTP client is real; no configured HTTPS target is contacted.
  const broker = factory({ baseUrl, apiKey: KEY, model: MODEL, ...options });
  const { port } = await listen(broker.server);
  t.after(() => broker.close());
  return { broker, port };
}
function fixed(response, code, status) {
  assert.equal(response.status, status);
  assert.deepEqual(response.data, { error: { code } });
  assert.ok(!response.text.includes(KEY));
  assert.equal(response.headers['cache-control'], 'no-store');
}

// Config validation never performs a network request and never interpolates the
// configured URL, model, or credential in thrown errors.
test('configuration fails closed with a fixed non-sensitive error', () => {
  const base = { baseUrl: 'https://synthetic.invalid', apiKey: KEY, model: MODEL };
  const bad = [
    { apiKey: undefined }, { apiKey: '' }, { apiKey: ' ' }, { apiKey: 'bad\r\nheader' },
    { model: '' }, { model: 'bad\nmodel' },
    { maxRequests: -1 }, { maxRequests: 1.5 }, { maxRequests: Infinity },
    { maxTokens: 0 }, { maxTokens: '3' }, { maxInputBytes: 0 }, { maxOutputBytes: -1 },
    { timeoutMs: 0 }, { timeoutMs: 2147483648 }, { allowLoopbackUpstream: 'yes' },
    { baseUrl: 'http://127.0.0.1' }, { baseUrl: 'ftp://synthetic.invalid' },
    { baseUrl: `https://${KEY}@synthetic.invalid` }, { baseUrl: `https://synthetic.invalid?${KEY}` },
    { baseUrl: `https://synthetic.invalid#${KEY}` }, { baseUrl: 'https://synthetic.invalid?' },
    { baseUrl: 'https://synthetic.invalid#' }, { baseUrl: 'https://@synthetic.invalid' },
    { baseUrl: 'https://synthetic.invalid/other' }, { baseUrl: ' https://synthetic.invalid' },
    { baseUrl: 'https:\\synthetic.invalid' },
    ...['localhost', '192.0.2.1', '0.0.0.0', '2130706433', '0x7f000001', '127.01.0.1', '[::ffff:127.0.0.1]'].map((host) => ({
      baseUrl: `http://${host}`, allowLoopbackUpstream: true,
    })),
  ];
  for (const override of bad) {
    assert.throws(() => createModelBroker({ ...base, ...override }), (error) =>
      error instanceof TypeError && error.message === 'MODEL_BROKER_INVALID_CONFIG');
  }
});

test('accepted URL forms produce unbound http.Server and idempotent close', async () => {
  for (const baseUrl of [
    'https://synthetic.invalid', 'https://synthetic.invalid/v1/',
    'https://synthetic.invalid/v1/chat/completions',
    'http://127.0.0.2:1234', 'http://[::1]:1234/v1', 'http://[0:0:0:0:0:0:0:1]:1234',
  ]) {
    const broker = createModelBroker({ baseUrl, apiKey: KEY, model: MODEL, allowLoopbackUpstream: true });
    assert.ok(broker.server instanceof http.Server);
    assert.equal(broker.server.listening, false);
    const first = broker.close();
    assert.ok(first instanceof Promise);
    assert.equal(broker.close(), first);
    await first;
  }
});

test('only fixed POST route; no GET pricing/models, query, absolute URL, or alias', async (t) => {
  const f = await fixture(t);
  for (const [method, path, code, status] of [
    ['GET', '/v1/models', 'NOT_FOUND', 404], ['GET', '/v1/pricing', 'NOT_FOUND', 404],
    ['GET', '/v1/chat/completions', 'METHOD_NOT_ALLOWED', 405],
    ['HEAD', '/v1/models', 'NOT_FOUND', 404],
    ['PUT', '/v1/chat/completions', 'METHOD_NOT_ALLOWED', 405],
    ['POST', '/v1/chat/completions?x=1', 'NOT_FOUND', 404],
    ['POST', '/v1/chat/completions/', 'NOT_FOUND', 404],
    ['POST', '/v1/%63hat/completions', 'NOT_FOUND', 404],
    ['POST', 'http://synthetic.invalid/v1/chat/completions', 'NOT_FOUND', 404],
  ]) {
    const response = await client(f.port, { method, path });
    if (method === 'HEAD') { assert.equal(response.status, status); continue; }
    fixed(response, code, status);
  }
  assert.equal(f.received.length, 0);
  assert.equal(f.broker.stats().requests, 0);
});

test('valid completion injects fixed model/tokens/stream/n and only upstream receives key', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('x-upstream-private', KEY);
    res.setHeader('set-cookie', `synthetic=${KEY}`);
    json(res);
  });
  const response = await client(f.port, { headers: {
    authorization: 'Bearer agent-synthetic-not-the-upstream-key',
    'x-api-key': 'synthetic-agent-header', 'x-forwarded-host': 'synthetic.invalid',
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, completion());
  assert.equal(response.headers['x-upstream-private'], undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.ok(!response.text.includes(KEY));
  const submitted = f.received[0];
  assert.equal(submitted.path, '/v1/chat/completions');
  assert.equal(submitted.method, 'POST');
  assert.ok(submitted.headers.authorization === `Bearer ${KEY}`);
  assert.equal(submitted.headers['x-api-key'], undefined);
  assert.equal(submitted.headers['x-forwarded-host'], undefined);
  assert.deepEqual(submitted.body, { ...BODY, stream: false, n: 1, max_tokens: 512 });
  const stats = f.broker.stats();
  assert.equal(stats.requests, 1);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.rejected, 0);
  assert.ok(!JSON.stringify(stats).includes(KEY));
});

test('body validation rejects model/stream/n/token ambiguity and unknown parameters before charging', async (t) => {
  const f = await fixture(t);
  const invalid = [
    null, [], {}, { ...BODY, model: 'other' }, { messages: BODY.messages },
    { ...BODY, stream: true }, { ...BODY, stream: null }, { ...BODY, stream: 0 },
    { ...BODY, n: 0 }, { ...BODY, n: 2 }, { ...BODY, n: '1' },
    { ...BODY, max_tokens: 513 }, { ...BODY, max_tokens: 0 }, { ...BODY, max_tokens: 1.5 },
    { ...BODY, max_completion_tokens: 513 }, { ...BODY, max_tokens: 3, max_completion_tokens: 3 },
    { ...BODY, messages: [] }, { ...BODY, messages: [null] },
    { ...BODY, messages: [{ role: 'invalid', content: 'synthetic' }] },
    { ...BODY, messages: [{ role: 'user', content: {} }] },
    { ...BODY, api_key: 'synthetic' }, { ...BODY, base_url: 'http://synthetic.invalid' },
    { ...BODY, stream_options: {} },
  ];
  for (const body of invalid) fixed(await client(f.port, { body }), 'INVALID_REQUEST', 400);
  for (const body of ['not json', '{', '{"model":NaN}', Buffer.from([0xff])]) {
    fixed(await client(f.port, { body }), 'INVALID_REQUEST', 400);
  }
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }]) {
    fixed(await client(f.port, { headers }), 'INVALID_REQUEST', 400);
  }
  assert.equal(f.received.length, 0);
  assert.equal(f.broker.stats().requests, 0);
});

test('explicit valid n/stream and smaller completion token limits are preserved', async (t) => {
  const f = await fixture(t);
  for (const tokenField of ['max_tokens', 'max_completion_tokens']) {
    const response = await client(f.port, { body: { ...BODY, stream: false, n: 1, [tokenField]: 8 } });
    assert.equal(response.status, 200);
    assert.equal(f.received.at(-1).body[tokenField], 8);
    assert.equal(f.received.at(-1).body[tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'], undefined);
  }
});

test('lifetime budget includes failed submissions and does not auto-retry', async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(503); res.end('synthetic failure'); }, { maxRequests: 2 });
  fixed(await client(f.port), 'UPSTREAM_FAILURE', 502);
  fixed(await client(f.port), 'UPSTREAM_FAILURE', 502);
  fixed(await client(f.port), 'BUDGET_EXHAUSTED', 429);
  assert.equal(f.received.length, 2);
  assert.equal(f.broker.stats().requests, 2);
});

test('zero request budget denies all submissions', async (t) => {
  const f = await fixture(t, undefined, { maxRequests: 0 });
  fixed(await client(f.port), 'BUDGET_EXHAUSTED', 429);
  assert.equal(f.received.length, 0);
});

test('concurrent requests cannot overdraw submission budget', async (t) => {
  const gate = deferred();
  const submitted = deferred();
  let hits = 0;
  const f = await fixture(t, async (_req, res) => {
    if (++hits === 2) submitted.resolve();
    await gate.promise;
    json(res);
  }, { maxRequests: 2 });
  t.after(() => gate.resolve());
  const calls = Array.from({ length: 12 }, () => client(f.port));
  await submitted.promise;
  assert.equal(f.broker.stats().requests, 2);
  gate.resolve();
  const responses = await Promise.all(calls);
  assert.equal(responses.filter((r) => r.status === 200).length, 2);
  assert.equal(responses.filter((r) => r.data.error?.code === 'BUDGET_EXHAUSTED').length, 10);
  assert.equal(f.received.length, 2);
});

test('upstream error status/headers/body/status text are never reflected', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(401, KEY, { 'x-synthetic-private': KEY, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: KEY } }));
  });
  const response = await client(f.port);
  fixed(response, 'UPSTREAM_FAILURE', 502);
  assert.equal(response.headers['x-synthetic-private'], undefined);
  assert.equal(f.broker.stats().outputBytes, 0);
});

test('200 error envelopes and malformed/non-JSON/invalid UTF-8 output fail closed', async (t) => {
  const bodies = [
    JSON.stringify({ error: { message: 'synthetic secret detail' } }),
    '<html>synthetic upstream error</html>', '{', 'null', '[]',
    JSON.stringify(completion({ choices: [] })), JSON.stringify(completion({ choices: [{}, {}] })),
    Buffer.from([0xff]),
  ];
  let next = 0;
  const f = await fixture(t, (_req, res) => res.end(bodies[next++]), { maxRequests: bodies.length });
  for (const _body of bodies) {
    const response = await client(f.port);
    assert.equal(response.status, 502);
    assert.ok(['UPSTREAM_FAILURE', 'UNSAFE_RESPONSE'].includes(response.data.error.code));
    assert.equal(response.text, JSON.stringify({ error: { code: response.data.error.code } }));
  }
});

test('successful responses reject credential in nested keys/values and escaped duplicate fields', async (t) => {
  const escaped = [...KEY].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const payloads = [
    JSON.stringify(completion({ private: KEY })),
    JSON.stringify(completion({ [`prefix-${KEY}-suffix`]: 'synthetic' })),
    JSON.stringify(completion({ metadata: [{ nested: `prefix ${KEY} suffix` }] })),
    JSON.stringify(completion()).replace('synthetic output', escaped),
    `{"duplicate":"${escaped}","duplicate":"safe",${JSON.stringify(completion()).slice(1)}`,
    JSON.stringify(completion({ choices: [{ message: { content: KEY } }] })),
  ];
  let next = 0;
  const f = await fixture(t, (_req, res) => res.end(payloads[next++]), { maxRequests: payloads.length });
  for (const _payload of payloads) fixed(await client(f.port), 'UNSAFE_RESPONSE', 502);
  assert.equal(f.broker.stats().succeeded, 0);
  assert.equal(f.broker.stats().codes.UNSAFE_RESPONSE, payloads.length);
});

test('numeric JSON values also cannot reflect a numeric credential', async (t) => {
  const f = await fixture(t, (_req, res) => json(res, completion({ metadata: 123456789 })), { apiKey: '123456789' });
  fixed(await client(f.port), 'UNSAFE_RESPONSE', 502);
});

test('all HTTP redirect statuses are rejected without touching target or retrying', async (t) => {
  let redirected = 0;
  const target = http.createServer((_req, res) => { redirected++; json(res); });
  const targetAddress = await listen(target);
  t.after(() => stop(target));
  const statuses = [301, 302, 303, 307, 308];
  let next = 0;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(statuses[next++], { location: `http://127.0.0.1:${targetAddress.port}/${KEY}` });
    res.end(KEY);
  });
  for (const _status of statuses) fixed(await client(f.port), 'UPSTREAM_FAILURE', 502);
  assert.equal(redirected, 0);
  assert.equal(f.received.length, statuses.length);
});

test('declared request byte limit rejects before upstream submission', async (t) => {
  const f = await fixture(t, undefined, { maxInputBytes: 32 });
  fixed(await client(f.port), 'INPUT_TOO_LARGE', 413);
  assert.equal(f.broker.stats().requests, 0);
});

test('chunked request byte limit is enforced during reading', async (t) => {
  const f = await fixture(t, undefined, { maxInputBytes: 32 });
  const response = await new Promise((resolveValue, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveValue({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)), text: Buffer.concat(chunks).toString(), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(' '.repeat(20));
    req.end(' '.repeat(20));
  });
  fixed(response, 'INPUT_TOO_LARGE', 413);
  assert.equal(f.broker.stats().requests, 0);
});

test('UTF-8 input limit counts bytes, not characters, and exact-size input passes', async (t) => {
  const body = { ...BODY, messages: [{ role: 'user', content: '合成输入' }] };
  const size = Buffer.byteLength(JSON.stringify(body));
  const f = await fixture(t, undefined, { maxInputBytes: size });
  assert.equal((await client(f.port, { body })).status, 200);
  fixed(await client(f.port, { body: { ...body, messages: [{ role: 'user', content: '合成输入字' }] } }), 'INPUT_TOO_LARGE', 413);
  assert.equal(f.received.length, 1);
});

test('declared and streaming output byte limits reject before sending any upstream bytes', async (t) => {
  let next = 0;
  const f = await fixture(t, (_req, res) => {
    if (next++ === 0) res.setHeader('content-length', '1000');
    else res.setHeader('transfer-encoding', 'chunked');
    res.write('x'.repeat(100));
    res.end('x'.repeat(100));
  }, { maxOutputBytes: 64 });
  fixed(await client(f.port), 'OUTPUT_TOO_LARGE', 502);
  fixed(await client(f.port), 'OUTPUT_TOO_LARGE', 502);
  assert.equal(f.broker.stats().succeeded, 0);
});

test('exact-size successful output is accepted', async (t) => {
  const text = JSON.stringify(completion());
  const f = await fixture(t, (_req, res) => res.end(text), { maxOutputBytes: Buffer.byteLength(text) });
  assert.equal((await client(f.port)).text, text);
});

test('returned completion usage must be an integer within the requested cap', async (t) => {
  const usages = [{ completion_tokens: 9 }, { completion_tokens: -1 }, { completion_tokens: 1.5 },
    { completion_tokens: '3' }, null];
  let next = 0;
  const f = await fixture(t, (_req, res) => json(res, completion({ usage: usages[next++] })));
  for (const _usage of usages) fixed(await client(f.port, { body: { ...BODY, max_tokens: 8 } }), 'UNSAFE_RESPONSE', 502);
});

test('timeout before upstream headers consumes one submission without retry', async (t) => {
  const f = await fixture(t, () => {}, { timeoutMs: 80 });
  fixed(await client(f.port), 'TIMEOUT', 504);
  assert.equal(f.broker.stats().requests, 1);
  assert.equal(f.broker.stats().codes.TIMEOUT, 1);
  assert.equal(f.received.length, 1);
});

test('timeout also bounds a stalled upstream response body', async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{'); }, { timeoutMs: 80 });
  fixed(await client(f.port), 'TIMEOUT', 504);
  assert.equal(f.broker.stats().succeeded, 0);
});

test('timeout bounds a stalled incoming request before budget charge', async (t) => {
  const f = await fixture(t, undefined, { timeoutMs: 80 });
  const result = await new Promise((resolveValue, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': 100 },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveValue({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)), text: Buffer.concat(chunks).toString(), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write('{');
  });
  fixed(result, 'TIMEOUT', 504);
  assert.equal(f.broker.stats().requests, 0);
});

test('client disconnect aborts the upstream operation without a refund/retry', async (t) => {
  const entered = deferred();
  const upstreamClosed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.once('close', () => upstreamClosed.resolve());
    entered.resolve();
  });
  const req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  req.on('error', () => {});
  req.end(JSON.stringify(BODY));
  await entered.promise;
  req.destroy();
  await upstreamClosed.promise;
  assert.equal(f.broker.stats().codes.CANCELLED, 1);
  assert.equal(f.broker.stats().requests, 1);
  assert.equal(f.broker.stats().active, 0);
});

test('close aborts in-flight operations, closes listener, and remains idempotent', async (t) => {
  const entered = deferred();
  const upstreamClosed = deferred();
  const f = await fixture(t, (_req, res) => {
    res.once('close', () => upstreamClosed.resolve());
    entered.resolve();
  });
  const request = client(f.port).catch(() => null);
  await entered.promise;
  const first = f.broker.close();
  assert.equal(f.broker.close(), first);
  await first;
  await upstreamClosed.promise;
  await request;
  assert.equal(f.broker.server.listening, false);
  assert.equal(f.broker.stats().active, 0);
  assert.equal(f.broker.stats().codes.CLOSED, 1);
  assert.equal(f.broker.stats().requests, 1);
});

test('closed broker cannot submit if its public server is subsequently rebound', async (t) => {
  const f = await fixture(t);
  await f.broker.close();
  const address = await listen(f.broker.server);
  t.after(() => stop(f.broker.server));
  fixed(await client(address.port), 'CLOSED', 503);
  assert.equal(f.received.length, 0);
});

test('stats are detached counters/fixed codes only, with no mutable internal references', async (t) => {
  const f = await fixture(t);
  await client(f.port);
  const snapshot = f.broker.stats();
  snapshot.requests = 10000;
  snapshot.codes.TIMEOUT = 10000;
  assert.equal(f.broker.stats().requests, 1);
  assert.equal(f.broker.stats().codes.TIMEOUT, 0);
  const scan = (value) => Object.values(value).every((item) => typeof item === 'number' || (item && typeof item === 'object' && scan(item)));
  assert.ok(scan(f.broker.stats()));
});

test('upgrade and CONNECT cannot tunnel to an upstream', async (t) => {
  const f = await fixture(t);
  for (const raw of [
    'GET /v1/chat/completions HTTP/1.1\r\nHost: synthetic\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    'CONNECT synthetic.invalid:443 HTTP/1.1\r\nHost: synthetic.invalid\r\n\r\n',
  ]) {
    const response = await new Promise((resolveValue, reject) => {
      const socket = net.connect(f.port, '127.0.0.1');
      const chunks = [];
      socket.on('connect', () => socket.write(raw));
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => resolveValue(Buffer.concat(chunks).toString('utf8')));
    });
    assert.ok(response.startsWith('HTTP/1.1 400') || response.startsWith('HTTP/1.1 404'));
    assert.ok(!response.includes(KEY));
  }
  assert.equal(f.received.length, 0);
});

test('default submission budget is exactly six, including concurrent requests', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 7 }, () => client(f.port)));
  assert.equal(responses.filter((response) => response.status === 200).length, 6);
  assert.equal(responses.filter((response) => response.data.error?.code === 'BUDGET_EXHAUSTED').length, 1);
  assert.equal(f.received.length, 6);
  assert.equal(f.broker.stats().requests, 6);
});

test('custom token cap is injected and larger requests never reach upstream', async (t) => {
  const f = await fixture(t, undefined, { maxTokens: 7 });
  assert.equal((await client(f.port)).status, 200);
  assert.equal(f.received[0].body.max_tokens, 7);
  fixed(await client(f.port, { body: { ...BODY, max_tokens: 8 } }), 'INVALID_REQUEST', 400);
  fixed(await client(f.port, { body: { ...BODY, max_completion_tokens: 8 } }), 'INVALID_REQUEST', 400);
  assert.equal(f.received.length, 1);
});

test('upstream connection failure returns only a fixed code without retries', async (t) => {
  const f = await fixture(t, (_req, res) => res.destroy());
  fixed(await client(f.port), 'UPSTREAM_FAILURE', 502);
  assert.equal(f.received.length, 1);
  assert.equal(f.broker.stats().requests, 1);
});

test('Expect negotiation is rejected without upstream calls', async (t) => {
  const f = await fixture(t);
  for (const expect of ['100-continue', 'synthetic-expectation']) {
    fixed(await client(f.port, { headers: { expect } }), 'INVALID_REQUEST', 400);
  }
  assert.equal(f.received.length, 0);
});

test('close cancels partial incoming requests before charging', async (t) => {
  const f = await fixture(t);
  const entered = once(f.broker.server, 'request');
  const req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': 100 },
  });
  req.on('error', () => {});
  req.on('response', (res) => res.resume());
  req.write('{');
  await entered;
  await f.broker.close();
  req.destroy();
  assert.equal(f.broker.stats().active, 0);
  assert.equal(f.broker.stats().requests, 0);
  assert.equal(f.broker.stats().codes.CLOSED, 1);
});

test('OpenCode allows only the two exact official HTTPS bases/endpoints with fixed local route', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push({ target, init });
    return new Response(JSON.stringify(completion()), { status: 200 });
  });
  for (const prefix of ['/inference/go/openai/v1', '/inference/openai/v1']) {
    const target = `https://opencode.ai${prefix}/chat/completions`;
    for (const suffix of ['', '/', '/chat/completions']) {
      const f = await stubbedBroker(t, `https://opencode.ai${prefix}${suffix}`);
      assert.equal((await client(f.port)).status, 200);
      assert.equal(calls.at(-1).target, target);
      assert.equal(calls.at(-1).init.method, 'POST');
      assert.equal(calls.at(-1).init.redirect, 'error');
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { ...BODY, stream: false, n: 1, max_tokens: 512 });
      fixed(await client(f.port, { path: `${prefix}/chat/completions` }), 'NOT_FOUND', 404);
      await f.broker.close();
    }
  }
  assert.equal(calls.length, 6);
});

test('OpenCode session is random per broker, stable within it, and truthful headers cannot be spoofed by App', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push({ target, init });
    return new Response(JSON.stringify(completion()), { status: 200,
      headers: { 'x-opencode-session': init.headers['x-opencode-session'], 'x-upstream-private': KEY },
    });
  });
  const sessions = [];
  for (let instance = 0; instance < 3; instance++) {
    const f = await stubbedBroker(t, 'https://opencode.ai/inference/go/openai/v1');
    for (let request = 0; request < 2; request++) {
      const response = await client(f.port, { headers: {
        'x-opencode-session': 'synthetic-app-spoof', 'user-agent': 'synthetic-coding-client-spoof',
        authorization: 'Bearer synthetic-app-credential', 'x-api-key': 'synthetic-app-key',
      } });
      assert.equal(response.status, 200);
      assert.equal(response.headers['x-opencode-session'], undefined);
      assert.equal(response.headers['x-upstream-private'], undefined);
      const { target, init } = calls.at(-1);
      assert.equal(init.headers['user-agent'], 'whale-onebot-integration-test/0.1');
      assert.match(init.headers['x-opencode-session'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      assert.ok(init.headers.authorization === `Bearer ${KEY}`);
      assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'authorization', 'content-type', 'user-agent', 'x-opencode-session']);
      assert.ok(!JSON.stringify({ target, body: init.body, session: init.headers['x-opencode-session'], stats: f.broker.stats() }).includes(KEY));
      if (request === 0) sessions.push(init.headers['x-opencode-session']);
      else assert.equal(init.headers['x-opencode-session'], sessions.at(-1));
    }
    await f.broker.close();
  }
  assert.equal(new Set(sessions).size, 3);
  assert.equal(calls.length, 6);
});

test('OpenCode extensions reject misleading hosts, ports, arbitrary prefixes, normalization tricks and URL decorations', (t) => {
  const fetchStub = t.mock.method(globalThis, 'fetch', async () => { throw new Error('SYNTHETIC_UNEXPECTED_FETCH'); });
  const paths = ['/inference/go/openai/v1', '/inference/openai/v1'];
  const invalid = paths.flatMap((path) => [
    `https://synthetic.invalid${path}`, `https://opencode.ai.synthetic.invalid${path}`,
    `https://synthetic-opencode.ai${path}`, `https://opencode.ai.${path}`,
    `https://%6fpencode.ai${path}`, `https://opencode.ai:8443${path}`,
    `http://opencode.ai${path}`, `http://127.0.0.1${path}`,
    `https://${KEY}@opencode.ai${path}`, `https://opencode.ai@synthetic.invalid${path}`,
    `https://opencode.ai/prefix${path}`, `https://opencode.ai/prefix/..${path}`,
    `https://opencode.ai/%2e${path}`, `https://opencode.ai${path}/chat/completions/`,
    `https://opencode.ai${path}/responses`, `https://opencode.ai${path}/models`,
    `https://opencode.ai${path}?`, `https://opencode.ai${path}?key=${KEY}`,
    `https://opencode.ai${path}#`, `https://opencode.ai${path}#${KEY}`,
  ]);
  for (const baseUrl of invalid) {
    assert.throws(() => createModelBroker({ baseUrl, apiKey: KEY, model: MODEL, allowLoopbackUpstream: true }),
      (error) => error.message === 'MODEL_BROKER_INVALID_CONFIG');
  }
  assert.equal(fetchStub.mock.callCount(), 0);
});

test('OpenCode redirect and service errors cannot switch host, API tier, or model and are never retried', async (t) => {
  const calls = [];
  const responses = [];
  const statuses = [301, 302, 303, 307, 308, 401, 404, 429, 500];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push({ target, init });
    const response = new Response(KEY, { status: statuses[(calls.length - 1) % statuses.length],
      headers: { location: `https://synthetic.invalid/${KEY}` },
    });
    responses.push(response);
    return response;
  });
  for (const prefix of ['/inference/go/openai/v1', '/inference/openai/v1']) {
    const target = `https://opencode.ai${prefix}/chat/completions`;
    const f = await stubbedBroker(t, target, { maxRequests: statuses.length });
    const start = calls.length;
    for (const _status of statuses) fixed(await client(f.port), 'UPSTREAM_FAILURE', 502);
    assert.equal(calls.length - start, statuses.length);
    for (const call of calls.slice(start)) {
      assert.equal(call.target, target);
      assert.equal(call.init.redirect, 'error');
      assert.equal(JSON.parse(call.init.body).model, MODEL);
    }
    assert.equal(f.broker.stats().requests, statuses.length);
    await f.broker.close();
  }
  assert.ok(responses.every((response) => response.bodyUsed === false));
  assert.equal(calls.length, statuses.length * 2);
});

test('standard upstream URL and headers remain unchanged without OpenCode identity', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push({ target, init });
    return new Response(JSON.stringify(completion()), { status: 200 });
  });
  const f = await stubbedBroker(t, 'https://synthetic.invalid/v1');
  assert.equal((await client(f.port)).status, 200);
  assert.equal(calls[0].target, 'https://synthetic.invalid/v1/chat/completions');
  assert.equal(calls[0].init.headers['x-opencode-session'], undefined);
  assert.equal(calls[0].init.headers['user-agent'], undefined);
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['accept', 'authorization', 'content-type']);
});

test('caller can bind an IPC socket; Unix files stay under project .tmp', async (t) => {
  const broker = createModelBroker({ baseUrl: 'https://synthetic.invalid', apiKey: KEY, model: MODEL, maxRequests: 0 });
  let directory;
  let socketPath;
  if (process.platform === 'win32') {
    socketPath = `\\\\.\\pipe\\qq-onebot-synthetic-broker-${process.pid}-${Date.now()}`;
  } else {
    const root = resolve('.tmp');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, 'model-broker-'));
    socketPath = join(directory, 'broker.sock');
  }
  t.after(async () => {
    await broker.close();
    if (directory) {
      assert.ok(directory.startsWith(`${resolve('.tmp')}/`));
      await rm(directory, { recursive: true, force: true });
    }
  });
  try {
    await listen(broker.server, socketPath);
  } catch (error) {
    if (process.platform === 'linux' && error.code === 'ENOTSUP' && error.syscall === 'listen') {
      t.skip('Linux project mount does not support Unix socket listen (ENOTSUP); broker Unix socket support is NOT verified.');
      return;
    }
    throw error;
  }
  const response = await new Promise((resolveValue, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveValue({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(BODY));
  });
  assert.equal(response.status, 429);
  assert.deepEqual(response.data, { error: { code: 'BUDGET_EXHAUSTED' } });
});

const originalFixture = (t, handler, options) => fixture(t, handler, options, createOriginalModelBroker);
const GO = 'https://opencode.ai/inference/go/openai/v1';

test('original mode admits only approved Go or explicitly enabled literal-loopback transport', async () => {
  for (const baseUrl of [GO, GO + '/', GO + '/chat/completions']) {
    const broker = createOriginalModelBroker({ baseUrl, apiKey: KEY });
    assert.equal(broker.server.listening, false);
    await broker.close();
  }
  const invalid = [
    ...['https://opencode.ai/v1', 'https://opencode.ai/inference/openai/v1',
      'https://synthetic.invalid/v1', 'https://opencode.ai:8443/inference/go/openai/v1',
      'https://opencode.ai/prefix/../inference/go/openai/v1',
      'https://%6fpencode.ai/inference/go/openai/v1', GO + '?', GO + '#',
      'http://localhost/v1', 'http://192.0.2.1/v1', 'http://2130706433/v1',
      'http://127.01.0.1/v1', 'http://[::ffff:127.0.0.1]/v1',
    ].map(baseUrl => ({ baseUrl, allowLoopbackUpstream: true })),
    { baseUrl: 'http://127.0.0.1/v1' }, { apiKey: '' }, { apiKey: 'bad\r\nheader' },
    { model: 'bad\nmodel' }, { maxRequests: 64 }, { maxTokens: 32768 },
    { maxInputBytes: 0 }, { maxOutputBytes: 0 }, { timeoutMs: 0 }, { timeoutMs: 2147483648 },
  ];
  for (const options of invalid) {
    assert.throws(() => createOriginalModelBroker({ baseUrl: GO, apiKey: KEY, ...options }),
      error => error instanceof TypeError && error.message === 'MODEL_BROKER_INVALID_CONFIG');
  }
});

test('original mode preserves missing token limits, n and stream instead of injecting trial defaults', async (t) => {
  const f = await originalFixture(t);
  assert.equal((await client(f.port)).status, 200);
  assert.deepEqual(f.received[0].body, BODY);
  for (const name of ['max_tokens', 'max_completion_tokens', 'stream', 'n']) {
    assert.equal(Object.hasOwn(f.received[0].body, name), false);
  }
});

test('original mode preserves model selection, multiple choices and provider body parameters', async (t) => {
  const result = completion({ choices: [completion().choices[0], completion().choices[0]],
    usage: { completion_tokens: 200000 } });
  const f = await originalFixture(t, (_req, res) => json(res, result));
  const body = { ...BODY, model: 'synthetic-other-go-model', stream: false, n: 2, max_tokens: 131072,
    max_completion_tokens: 262144, thinking: { type: 'disabled' }, enable_thinking: false,
    reasoning_effort: 'high', temperature: 0.8, tools: [], tool_choice: 'auto',
    provider_extension: { nested: ['synthetic', 0, true, null] } };
  const response = await client(f.port, { body });
  assert.equal(response.status, 200);
  assert.deepEqual(f.received[0].body, body);
  assert.deepEqual(response.data, result);
  assert.equal(f.broker.stats().requests, 1);
});

test('original mode preserves each explicit completion token field without a host cap', async (t) => {
  const f = await originalFixture(t, (_req, res) => json(res, completion({ usage: { completion_tokens: 300000 } })));
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    const body = { ...BODY, stream: false, [field]: 262144 };
    assert.equal((await client(f.port, { body })).status, 200);
    assert.deepEqual(f.received.at(-1).body, body);
  }
});

test('original mode has no six/64 lifetime request quota and does not retry failed calls', async (t) => {
  let count = 0;
  const f = await originalFixture(t, (_req, res) => {
    if (++count === 1) { res.writeHead(503); res.end('synthetic unavailable'); } else json(res);
  });
  const unavailable = await client(f.port);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.text, 'synthetic unavailable');
  for (let call = 0; call < 70; call++) assert.equal((await client(f.port)).status, 200);
  assert.equal(f.received.length, 71);
  assert.equal(f.broker.stats().requests, 71);
  assert.equal(f.broker.stats().succeeded, 70);
  assert.equal(f.broker.stats().codes.BUDGET_EXHAUSTED, 0);
});

test('original mode rejects malformed chat and unsupported SSE without silently rewriting it', async (t) => {
  const f = await originalFixture(t);
  for (const body of [null, [], {}, { ...BODY, model: '' }, { ...BODY, model: 'bad\nmodel' },
    { ...BODY, stream: true }, { ...BODY, stream: null }, { ...BODY, n: 0 }, { ...BODY, n: '2' },
    { ...BODY, max_tokens: 0 }, { ...BODY, max_completion_tokens: 1.5 },
    { ...BODY, messages: [] }, { ...BODY, messages: [null] }, '{', Buffer.from([0xff])]) {
    fixed(await client(f.port, { body }), 'INVALID_REQUEST', 400);
  }
  fixed(await client(f.port, { path: '/v1/models' }), 'NOT_FOUND', 404);
  fixed(await client(f.port, { headers: { 'content-encoding': 'gzip' } }), 'INVALID_REQUEST', 400);
  assert.equal(f.received.length, 0);
});

test('original Go routing and credential/session headers stay fixed while request models vary', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, init) => {
    calls.push({ target, init });
    return new Response(JSON.stringify(completion()), { status: 200,
      headers: { 'set-cookie': KEY, 'x-upstream-private': KEY } });
  });
  const f = await stubbedBroker(t, GO, {}, createOriginalModelBroker);
  for (const model of [MODEL, 'synthetic-purpose-model']) {
    const body = { ...BODY, model, stream: false, n: 2 };
    const response = await client(f.port, { body, headers: {
      authorization: 'Bearer synthetic-app-placeholder', 'x-api-key': 'synthetic-app-key',
      'user-agent': 'synthetic-spoof', 'x-opencode-session': 'synthetic-spoof',
    } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['x-upstream-private'], undefined);
    const call = calls.at(-1);
    assert.equal(call.target, GO + '/chat/completions');
    assert.equal(call.init.redirect, 'error');
    assert.deepEqual(JSON.parse(call.init.body), body);
    assert.ok(call.init.headers.authorization === `Bearer ${KEY}`);
    assert.equal(call.init.headers['user-agent'], 'whale-onebot-integration-test/0.1');
    assert.deepEqual(Object.keys(call.init.headers).sort(), ['accept', 'authorization', 'content-type', 'user-agent', 'x-opencode-session']);
  }
  assert.equal(calls[0].init.headers['x-opencode-session'], calls[1].init.headers['x-opencode-session']);
  assert.ok(!JSON.stringify(f.broker.stats()).includes(KEY));
});

test('original response screening retains escaped/duplicate/nested credential reflection protection', async (t) => {
  const escaped = [...KEY].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const payloads = [
    JSON.stringify(completion({ metadata: [{ nested: KEY }] })),
    JSON.stringify(completion({ [`prefix-${KEY}`]: 'synthetic' })),
    JSON.stringify(completion()).replace('synthetic output', escaped),
    `{"duplicate":"${escaped}","duplicate":"safe",${JSON.stringify(completion()).slice(1)}`,
  ];
  let count = 0;
  const f = await originalFixture(t, (_req, res) => res.end(payloads[count++]));
  for (const _payload of payloads) fixed(await client(f.port), 'UNSAFE_RESPONSE', 502);
  assert.equal(f.broker.stats().succeeded, 0);
  assert.equal(f.received.length, payloads.length);
});

test('original mode rejects empty/non-JSON/error envelopes but not multiple choices or high usage', async (t) => {
  const payloads = ['null', '[]', '{', '<html>synthetic</html>', Buffer.from([0xff]),
    JSON.stringify({ error: { message: KEY } }), JSON.stringify(completion({ choices: [] }))];
  let count = 0;
  const f = await originalFixture(t, (_req, res) => res.end(payloads[count++]));
  for (const _payload of payloads) {
    const response = await client(f.port);
    assert.equal(response.status, 502);
    assert.ok(['UPSTREAM_FAILURE', 'UNSAFE_RESPONSE'].includes(response.data.error.code));
    assert.ok(!response.text.includes(KEY));
  }
});

test('original mode never follows redirects or forwards their unsafe bodies and headers', async (t) => {
  let followed = 0;
  const target = http.createServer((_req, res) => { followed++; json(res); });
  const address = await listen(target);
  t.after(() => stop(target));
  const statuses = [301, 302, 303, 307, 308];
  let count = 0;
  const f = await originalFixture(t, (_req, res) => {
    res.writeHead(statuses[count++], KEY, { location: `http://127.0.0.1:${address.port}/${KEY}`, 'x-private': KEY });
    res.end(KEY);
  });
  for (const _status of statuses) {
    const response = await client(f.port);
    fixed(response, 'UPSTREAM_FAILURE', 502);
    assert.equal(response.headers['x-private'], undefined);
  }
  assert.equal(followed, 0);
  assert.equal(f.received.length, statuses.length);
});

test('original mode keeps configurable input/output byte and timeout transport boundaries', async (t) => {
  const input = await originalFixture(t, undefined, { maxInputBytes: 32 });
  fixed(await client(input.port), 'INPUT_TOO_LARGE', 413);
  assert.equal(input.received.length, 0);
  const output = await originalFixture(t, (_req, res) => res.end('x'.repeat(100)), { maxOutputBytes: 64 });
  fixed(await client(output.port), 'OUTPUT_TOO_LARGE', 502);
  const stalled = await originalFixture(t, (_req, res) => { res.writeHead(200); res.write('{'); }, { timeoutMs: 80 });
  fixed(await client(stalled.port), 'TIMEOUT', 504);
  assert.equal(stalled.received.length, 1);
});

test('original relay closes and cancels in-flight upstream work without automatic retry', async (t) => {
  const entered = deferred();
  const upstreamClosed = deferred();
  const f = await originalFixture(t, (_req, res) => {
    res.once('close', () => upstreamClosed.resolve());
    entered.resolve();
  });
  const request = client(f.port).catch(() => null);
  await entered.promise;
  const closing = f.broker.close();
  assert.equal(f.broker.close(), closing);
  await closing;
  await upstreamClosed.promise;
  await request;
  assert.equal(f.broker.stats().requests, 1);
  assert.equal(f.broker.stats().active, 0);
  assert.equal(f.broker.stats().codes.CLOSED, 1);
  assert.equal(f.broker.server.listening, false);
});

test('original mode preserves provider 4xx/5xx status and JSON/text error bytes without retries', async (t) => {
  const statuses = [400, 401, 402, 403, 404, 429, 500, 502, 503, 599];
  const cases = statuses.flatMap(status => [
    { status, text: ` {"error":{"code":"synthetic_${status}","message":"synthetic provider detail"}}\n` },
    { status, text: `synthetic_${status}: provider says "unrecognized\\q"; do not rewrite` },
  ]);
  let count = 0;
  const f = await originalFixture(t, (_req, res) => {
    const entry = cases[count++];
    res.writeHead(entry.status, KEY, { 'content-type': 'text/plain', 'set-cookie': KEY,
      authorization: KEY, 'x-api-key': KEY, 'retry-after': '1', 'x-private': KEY });
    res.end(entry.text);
  });
  for (const entry of cases) {
    const response = await client(f.port);
    assert.equal(response.status, entry.status);
    assert.equal(response.text, entry.text);
    if (response.data) assert.equal(response.data.error.code, `synthetic_${entry.status}`);
    for (const name of ['set-cookie', 'authorization', 'x-api-key', 'retry-after', 'x-private']) {
      assert.equal(response.headers[name], undefined);
    }
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.text.includes(KEY));
  }
  assert.equal(f.received.length, cases.length);
  assert.equal(f.broker.stats().requests, cases.length);
  assert.equal(f.broker.stats().rejected, cases.length);
  assert.equal(f.broker.stats().succeeded, 0);
});

test('original provider errors still reject raw, escaped, duplicate and nested credential reflections', async (t) => {
  const escaped = [...KEY].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const cases = [KEY, escaped, `provider: "${escaped}"`,
    JSON.stringify({ error: { code: 'synthetic_auth', message: KEY } }),
    JSON.stringify({ error: { [KEY]: 'synthetic' } }),
    `{"duplicate":"${escaped}","duplicate":"safe","error":{"code":"synthetic_auth"}}`,
  ];
  let count = 0;
  const f = await originalFixture(t, (_req, res) => {
    res.writeHead(count % 2 ? 401 : 429);
    res.end(cases[count++]);
  });
  for (const _entry of cases) fixed(await client(f.port), 'UNSAFE_RESPONSE', 502);
  assert.equal(f.received.length, cases.length);
  assert.equal(f.broker.stats().codes.UNSAFE_RESPONSE, cases.length);
  const numeric = await originalFixture(t, (_req, res) => {
    res.writeHead(403); res.end('{"error":{"value":123456789}}');
  }, { apiKey: '123456789' });
  fixed(await client(numeric.port), 'UNSAFE_RESPONSE', 502);
});

test('original error passthrough remains byte-bounded, UTF-8 screened and timeout-cancellable', async (t) => {
  const large = await originalFixture(t, (_req, res) => {
    res.writeHead(401); res.end('x'.repeat(100));
  }, { maxOutputBytes: 64 });
  fixed(await client(large.port), 'OUTPUT_TOO_LARGE', 502);
  const invalid = await originalFixture(t, (_req, res) => {
    res.writeHead(403); res.end(Buffer.from([0xff]));
  });
  fixed(await client(invalid.port), 'UPSTREAM_FAILURE', 502);
  const stalled = await originalFixture(t, (_req, res) => {
    res.writeHead(429); res.write('{');
  }, { timeoutMs: 80 });
  fixed(await client(stalled.port), 'TIMEOUT', 504);
  assert.equal(stalled.received.length, 1);
});
