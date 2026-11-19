import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { serveModelChannel, createChannelModelRelay } from '../scripts/lib/clean-agent-model-channel.mjs';

const model = 'synthetic-model';
const input = (extra = {}) => ({ model, messages: [{ role: 'user', content: 'synthetic 雪' }], ...extra });
const output = text => ({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
const turn = () => new Promise(resolve => setImmediate(resolve));
function pair({ fragment = false, stalled = false } = {}) {
  let a, b;
  const endpoint = peer => new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      if (stalled) return;
      if (!peer().destroyed) {
        if (fragment) for (const byte of chunk) peer().push(Buffer.from([byte]));
        else peer().push(Buffer.from(chunk));
      }
      callback();
    },
    destroy(error, callback) { if (!peer().destroyed) peer().push(null); callback(error); },
  });
  a = endpoint(() => b); b = endpoint(() => a);
  return [a, b];
}
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4); head.writeUInt32BE(payload.length);
  return Buffer.concat([head, payload]);
}
function reader(stream) {
  let buffer = Buffer.alloc(0);
  const values = [], waiters = [];
  stream.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
      const n = buffer.readUInt32BE();
      const value = JSON.parse(buffer.subarray(4, n + 4).toString()); buffer = buffer.subarray(n + 4);
      if (waiters.length) waiters.shift()(value); else values.push(value);
    }
  });
  return () => values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiters.push(resolve));
}
async function fixture(t, dispatch = async () => ({ status: 200, body: output('synthetic result') }), options = {}) {
  const [parentStream, childStream] = pair(options);
  const parent = serveModelChannel(parentStream, { dispatch, ...options });
  const relay = createChannelModelRelay(childStream, { model, ...options });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  t.after(async () => { await relay.close(); await parent.close(); });
  return { parent, relay, parentStream, childStream, port: relay.server.address().port };
}
function send(port, body = input(), options = {}) {
  const payload = options.raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: options.path ?? '/v1/chat/completions',
      method: options.method ?? 'POST', agent: false,
      headers: { 'content-type': 'application/json', ...options.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }));
    });
    req.on('error', reject); req.end(payload);
  });
}
async function code(port, body, expected, options) {
  const response = await send(port, body, options);
  assert.equal(response.body.error?.code, expected);
  assert.notEqual(response.status, 200);
  return response;
}

test('fragmented four-byte BE UTF8 JSON roundtrip; no binding, credentials, routing or request mutation', async t => {
  let seen;
  const { parent, relay, port } = await fixture(t, async (body, { signal }) => {
    seen = body; assert(signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'n', 'stream']);
    return { status: 200, body: output('合成 reply') };
  }, { fragment: true });
  const response = await send(port);
  assert.equal(response.status, 200); assert.equal(response.body.choices[0].message.content, '合成 reply');
  assert.equal(seen.stream, false); assert.equal(seen.n, 1); assert.equal(seen.model, model);
  assert.equal(response.headers.authorization, undefined); assert.equal(response.headers.location, undefined);
  assert.equal(relay.stats().requests, 1); assert.equal(parent.stats().requests, 1);
  assert.equal(parent.stats().succeeded, 1);
});

test('exact route/method/model/nonstreaming/single result and field allowlist fail before dispatch', async t => {
  let calls = 0;
  const { port, relay } = await fixture(t, async () => { calls++; return { status: 200, body: output('ok') }; });
  for (const path of ['/v1/chat/completions?x=1', '/v1/chat/completions/', '/v1/models', 'http://host/v1/chat/completions']) {
    await code(port, input(), 'NOT_FOUND', { path });
  }
  await code(port, input(), 'METHOD_NOT_ALLOWED', { method: 'PUT' });
  for (const bad of [input({ model: 'other' }), input({ stream: true }), input({ n: 2 }),
    input({ url: 'http://synthetic.invalid' }), input({ headers: { authorization: 'synthetic' } }),
    input({ messages: [] }), input({ messages: [{ role: 'invalid', content: 'x' }] }), [], null]) {
    await code(port, bad, 'INVALID_REQUEST');
  }
  await code(port, null, 'INVALID_REQUEST', { raw: '{' });
  await code(port, null, 'INVALID_REQUEST', { raw: Buffer.from([0xff]) });
  await code(port, input(), 'INVALID_REQUEST', { headers: { 'content-type': 'text/plain' } });
  await code(port, input(), 'INVALID_REQUEST', { headers: { 'content-encoding': 'gzip' } });
  assert.equal(calls, 0); assert.equal(relay.stats().requests, 0);
});

test('lifetime submission budget remains spent after an unknown failure and never retries', async t => {
  let calls = 0;
  const { port, parent, relay } = await fixture(t, () => { calls++; throw new Error('synthetic private detail'); }, { maxRequests: 1 });
  await code(port, input(), 'UPSTREAM_FAILURE');
  await code(port, input(), 'BUDGET_EXHAUSTED');
  assert.equal(calls, 1); assert.equal(parent.stats().requests, 1); assert.equal(relay.stats().requests, 1);
  assert(!JSON.stringify(parent.stats()).includes('private'));
});

test('concurrency is bounded while dispatch pending; completion may be out of ID order', async t => {
  const releases = [];
  const { port, parent, relay } = await fixture(t, () => new Promise(resolve => releases.push(resolve)), { maxConcurrent: 2 });
  const first = send(port), second = send(port);
  while (releases.length < 2) await turn();
  await code(port, input(), 'CONCURRENCY_LIMIT');
  assert.equal(parent.stats().running, 2); assert.equal(relay.stats().requests, 2);
  releases[1]({ status: 200, body: output('second') });
  assert.equal((await second).body.choices[0].message.content, 'second');
  releases[0]({ status: 200, body: output('first') });
  assert.equal((await first).body.choices[0].message.content, 'first');
});

for (const result of [
  { status: 302, body: output('redirect') }, { status: 201, body: output('not 200') },
  { status: 200, body: {} }, { status: 200, body: { choices: [] } },
  { status: 200, body: { choices: [{ message: { role: 'user', content: 'x' } }] } },
  { status: 200, body: { ...output('x'), error: 'bad' } },
  { status: 200, body: output('x'), headers: { location: 'http://synthetic.invalid' } },
]) {
  test(`unsafe dispatch response is fixed error: ${JSON.stringify(result)}`, async t => {
    const { port } = await fixture(t, async () => result);
    const response = await code(port, input(), 'UNSAFE_RESPONSE');
    assert.deepEqual(response.body, { error: { code: 'UNSAFE_RESPONSE' } });
  });
}

test('bounded HTTP input, envelope overhead and dispatch output', async t => {
  const { port, relay } = await fixture(t, async () => ({ status: 200, body: output('x'.repeat(2000)) }), { maxBytes: 512 });
  await code(port, input({ messages: [{ role: 'user', content: 'x'.repeat(600) }] }), 'INPUT_TOO_LARGE');
  await code(port, input(), 'OUTPUT_TOO_LARGE');
  assert.equal(relay.stats().requests, 1);
  const near = input({ messages: [{ role: 'user', content: 'x'.repeat(390) }] });
  assert(Buffer.byteLength(JSON.stringify(near)) < 512);
  await code(port, near, 'INPUT_TOO_LARGE');
  assert.equal(relay.stats().requests, 1);
});

test('timeout aborts dispatch, spends budget, ignores late result without retry', async t => {
  let signal, resolve, calls = 0;
  const { port, parent, relay } = await fixture(t, (_body, options) => {
    calls++; signal = options.signal; return new Promise(done => { resolve = done; });
  }, { timeoutMs: 80, maxRequests: 2, maxConcurrent: 1 });
  await code(port, input(), 'TIMEOUT');
  await turn(); assert.equal(signal.aborted, true);
  assert.equal(parent.stats().running, 1);
  await code(port, input(), 'CONCURRENCY_LIMIT');
  assert.equal(calls, 1);
  resolve({ status: 200, body: output('late') }); await turn(); await turn();
  assert.equal(parent.stats().running, 0); assert.equal(relay.stats().succeeded, 0);
  await code(port, input(), 'BUDGET_EXHAUSTED');
});

test('client disconnect sends cancellation and aborts parent signal', async t => {
  let start, signal;
  const started = new Promise(resolve => { start = resolve; });
  const { port, relay } = await fixture(t, (_body, options) => {
    signal = options.signal; start(); return new Promise(() => {});
  });
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'content-type': 'application/json' }, agent: false });
  req.on('error', () => {}); req.end(JSON.stringify(input()));
  await started; req.destroy();
  for (let i = 0; i < 20 && !signal.aborted; i++) await turn();
  assert.equal(signal.aborted, true); assert.equal(relay.stats().cancelled, 1);
});

test('close is idempotent, aborts active work, promptly ignores uncooperative dispatch', async t => {
  let start, signal;
  const started = new Promise(resolve => { start = resolve; });
  const { port, parent, relay } = await fixture(t, (_body, options) => {
    signal = options.signal; start(); return new Promise(() => {});
  });
  const response = send(port).catch(() => null);
  await started; await parent.close(); await relay.close(); await relay.close(); await parent.close();
  await response;
  assert.equal(signal.aborted, true); assert.equal(parent.stats().closed, true); assert.equal(relay.stats().closed, true);
  assert.equal(relay.server.listening, false);
});

for (const variant of ['duplicate', 'gap', 'url', 'cancel-unknown', 'cancel-duplicate', 'invalid-body', 'over-budget']) {
  test(`parent protocol fail-closed: ${variant}`, async t => {
    const [a, b] = pair(); let calls = 0;
    const parent = serveModelChannel(a, { maxRequests: 1, dispatch: async () => { calls++; return { status: 200, body: output('ok') }; } });
    t.after(() => { parent.close(); b.destroy(); });
    const next = reader(b), request = { type: 'request', id: 1, body: input({ stream: false, n: 1 }) };
    if (['duplicate', 'cancel-duplicate', 'over-budget'].includes(variant)) { b.write(frame(request)); await next(); }
    const bad = {
      duplicate: request, gap: { ...request, id: 2 }, url: { ...request, url: '/other' },
      'cancel-unknown': { type: 'cancel', id: 1 }, 'cancel-duplicate': { type: 'cancel', id: 1 },
      'invalid-body': { ...request, body: input({ stream: true, n: 1 }) }, 'over-budget': { ...request, id: 2 },
    }[variant];
    if (variant === 'cancel-duplicate') b.write(frame(bad));
    b.write(frame(bad)); await turn();
    assert.equal(parent.stats().closed, true); assert(calls <= 1);
  });
}

for (const bytes of [Buffer.from([0, 0, 0, 0]), Buffer.from([0x7f, 0xff, 0xff, 0xff]),
  Buffer.from([0, 0, 0, 1, 0xff]), Buffer.from([0, 0, 0, 1, 0x7b])]) {
  test(`invalid length/UTF8/JSON frame closes before dispatch (${bytes.toString('hex')})`, async t => {
    const [a, b] = pair(); let calls = 0;
    const parent = serveModelChannel(a, { maxBytes: 512, dispatch: () => { calls++; } });
    t.after(() => { parent.close(); b.destroy(); });
    b.write(bytes); await turn(); assert.equal(parent.stats().closed, true); assert.equal(calls, 0);
  });
}

test('partial header/body timeout and EOF fail closed', async t => {
  for (const bytes of [Buffer.from([0]), Buffer.from([0, 0, 0, 10, 0x7b])]) {
    const [a, b] = pair();
    const parent = serveModelChannel(a, { timeoutMs: 25, dispatch: () => assert.fail('must not dispatch') });
    t.after(() => { parent.close(); b.destroy(); });
    const closed = once(a, 'close'); b.write(bytes); await closed;
    assert.equal(parent.stats().closed, true);
  }
  const [a, b] = pair(); const parent = serveModelChannel(a, { dispatch() {} });
  b.destroy(); await turn(); assert.equal(parent.stats().closed, true);
});

for (const variant of ['duplicate', 'unknown', 'redirect', 'unsafe', 'extra']) {
  test(`child protocol fail-closed: ${variant}`, async t => {
    const [a, b] = pair();
    const relay = createChannelModelRelay(b, { model });
    t.after(async () => { await relay.close(); a.destroy(); });
    relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
    const next = reader(a), pending = send(relay.server.address().port);
    const request = await next(); assert.equal(request.id, 1);
    const valid = { type: 'response', id: 1, status: 200, body: output('synthetic') };
    if (variant === 'duplicate') { a.write(frame(valid)); assert.equal((await pending).status, 200); }
    const bad = { duplicate: valid, unknown: { ...valid, id: 2 }, redirect: { ...valid, status: 302 },
      unsafe: { ...valid, body: {} }, extra: { ...valid, headers: {} } }[variant];
    a.write(frame(bad)); await turn(); assert.equal(relay.stats().closed, true);
    if (variant !== 'duplicate') assert.equal((await pending).body.error.code, 'CHANNEL_PROTOCOL');
  });
}

test('Duplex.from readable/writable anonymous-pipe composition roundtrips and closes safely', async t => {
  const childInput = new PassThrough(), childOutput = new PassThrough();
  const parentStream = Duplex.from({ readable: childOutput, writable: childInput });
  const childStream = Duplex.from({ readable: childInput, writable: childOutput });
  const parent = serveModelChannel(parentStream, { dispatch: async () => ({ status: 200, body: output('composed pipes') }) });
  const relay = createChannelModelRelay(childStream, { model });
  t.after(async () => { await relay.close(); await parent.close(); });
  assert.equal(parentStream.readableObjectMode, false); assert.equal(childStream.writableObjectMode, false);
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  assert.equal((await send(relay.server.address().port)).body.choices[0].message.content, 'composed pipes');
  await relay.close(); await parent.close(); await turn();
  assert.equal(childInput.destroyed, true); assert.equal(childOutput.destroyed, true);
});

test('channel errors abort dispatch and do not include exception text in a response', async t => {
  let start, signal;
  const started = new Promise(resolve => { start = resolve; });
  const { port, parentStream, parent } = await fixture(t, (_body, options) => {
    signal = options.signal; start(); return new Promise(() => {});
  });
  const response = send(port); await started;
  parentStream.destroy(new Error('synthetic-private-exception'));
  assert.equal((await response).body.error.code, 'CLOSED');
  assert.equal(signal.aborted, true); assert.equal(parent.stats().closed, true);
});

test('oversized response prefix closes child without accepting a success body', async t => {
  const [a, b] = pair(); const relay = createChannelModelRelay(b, { model, maxBytes: 512 });
  t.after(async () => { await relay.close(); a.destroy(); });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const next = reader(a), pending = send(relay.server.address().port);
  await next(); const prefix = Buffer.alloc(4); prefix.writeUInt32BE(513); a.write(prefix);
  assert.equal((await pending).body.error.code, 'CHANNEL_PROTOCOL'); assert.equal(relay.stats().closed, true);
});

test('coalesced requests obey parent concurrency independently of HTTP relay', async t => {
  const [a, b] = pair(); let calls = 0, release;
  const parent = serveModelChannel(a, { maxConcurrent: 1, dispatch: () => {
    calls++; return new Promise(resolve => { release = resolve; });
  } });
  t.after(() => { parent.close(); b.destroy(); });
  const next = reader(b);
  b.write(Buffer.concat([1, 2].map(id => frame({ type: 'request', id, body: input({ stream: false, n: 1 }) }))));
  const rejected = await next(); assert.equal(rejected.id, 2); assert.equal(rejected.body.error.code, 'CONCURRENCY_LIMIT');
  await turn(); assert.equal(calls, 1); assert.equal(parent.stats().running, 1);
  release({ status: 200, body: output('first') }); assert.equal((await next()).id, 1);
});

test('write backpressure waits for drain and never duplicates a frame', async t => {
  const [a, b] = pair();
  const original = a.write.bind(a);
  let writes = 0;
  a.write = (chunk, callback) => {
    writes++;
    original(chunk, () => { callback(); setImmediate(() => a.emit('drain')); });
    return false;
  };
  const parent = serveModelChannel(a, { dispatch: async () => ({ status: 200, body: output('ok') }) });
  t.after(() => { parent.close(); b.destroy(); });
  const next = reader(b);
  b.write(Buffer.concat([1, 2].map(id => frame({ type: 'request', id, body: input({ stream: false, n: 1 }) }))));
  const first = await next(), second = await next();
  assert.deepEqual([first.id, second.id], [1, 2]); assert.equal(writes, 2);
});

test('stalled transport write closes by deadline without dispatch or retry', async t => {
  const { relay, childStream, port, parent } = await fixture(t, () => assert.fail('must not dispatch'), { stalled: true, timeoutMs: 40 });
  const closed = once(childStream, 'close');
  const response = await send(port);
  await closed; await turn();
  assert.equal(response.body.error.code, 'TIMEOUT');
  assert.equal(relay.stats().closed, true); assert.equal(parent.stats().requests, 0);
});

test('slow HTTP input occupies a bounded slot and expires before submission', async t => {
  const { relay, port, parent } = await fixture(t, () => assert.fail('must not dispatch'), { maxConcurrent: 1, timeoutMs: 150 });
  let ready;
  const receiving = new Promise(resolve => { ready = resolve; });
  const result = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' }, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject); req.write('{'); ready();
  });
  await receiving;
  while (!relay.stats().active) await turn();
  await code(port, input(), 'CONCURRENCY_LIMIT');
  assert.equal((await result).error.code, 'TIMEOUT');
  assert.equal(relay.stats().requests, 0); assert.equal(parent.stats().requests, 0);
});

test('incomplete HTTP headers have an absolute deadline and bounded connection count', async t => {
  const { relay, port } = await fixture(t, undefined, { timeoutMs: 40, maxConcurrent: 1 });
  assert.equal(relay.server.maxConnections, 3);
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
  t.after(() => socket.destroy());
  const closed = once(socket, 'close');
  await once(socket, 'connect'); socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: synthetic\r\n');
  await closed; assert.equal(relay.stats().received, 0);
});

test('a cancelled request permits exactly one late terminal result, then duplicates close channel', async t => {
  const [a, b] = pair(); const relay = createChannelModelRelay(b, { model, timeoutMs: 40 });
  t.after(async () => { await relay.close(); a.destroy(); });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  const next = reader(a), response = send(relay.server.address().port);
  const request = await next(); assert.equal(request.id, 1);
  assert.equal((await response).body.error.code, 'TIMEOUT');
  assert.deepEqual(await next(), { type: 'cancel', id: 1 });
  const late = frame({ type: 'response', id: 1, status: 200, body: output('late') });
  a.write(late); await turn(); assert.equal(relay.stats().closed, false);
  a.write(late); await turn(); assert.equal(relay.stats().closed, true);
});

test('zero submission budget never calls parent dispatch', async t => {
  const { port, parent } = await fixture(t, () => assert.fail('must not dispatch'), { maxRequests: 0 });
  await code(port, input(), 'BUDGET_EXHAUSTED'); assert.equal(parent.stats().requests, 0);
});

test('dispatch getter exceptions become fixed failures rather than unhandled rejections', async t => {
  const { port } = await fixture(t, async () => ({ get status() { throw new Error('synthetic detail'); }, body: output('ok') }));
  await code(port, input(), 'UPSTREAM_FAILURE');
});

test('configuration rejects object mode, invalid bounds/model/dispatch', () => {
  const [a, b] = pair();
  try {
    for (const options of [{ maxBytes: 0 }, { maxRequests: -1 }, { maxConcurrent: 0 }, { timeoutMs: 0 }, { timeoutMs: 2 ** 31 }]) {
      assert.throws(() => serveModelChannel(a, { dispatch() {}, ...options }), /MODEL_CHANNEL_INVALID_CONFIG/);
    }
    assert.throws(() => serveModelChannel(a, {}), /MODEL_CHANNEL_INVALID_CONFIG/);
    assert.throws(() => createChannelModelRelay(a, { model: '' }), /MODEL_CHANNEL_INVALID_CONFIG/);
    assert.throws(() => serveModelChannel(new Duplex({ objectMode: true, read() {}, write(_c, _e, cb) { cb(); } }), { dispatch() {} }), /MODEL_CHANNEL_INVALID_CONFIG/);
  } finally { a.destroy(); b.destroy(); }
});
