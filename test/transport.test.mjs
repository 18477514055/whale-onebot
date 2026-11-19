import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createTransport, createReverseWebSocket, createWebhook } from '../src/transport/index.mjs';

const token = 'synthetic-local-test-token-only';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, options = {}) {
  const events = new EventEmitter(), calls = [];
  const transport = await createTransport({ token, events, heartbeatMs: 0,
    dispatch: async request => { calls.push(request); return { status: 'ok', retcode: 0, data: request.params }; }, ...options });
  t.after(() => transport.close());
  const base = `http://127.0.0.1:${transport.address.port}`;
  return { ...transport, events, calls, base, ws: `ws://127.0.0.1:${transport.wsAddress.port}` };
}
function inbox(ws) {
  const messages = [], waiting = [];
  ws.on('message', data => { const frame = JSON.parse(data); if (waiting.length) waiting.shift()(frame); else messages.push(frame); });
  return { messages, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiting.push(resolve)) };
}
async function connect(t, url) {
  const ws = new WebSocket(url, { headers }); const box = inbox(ws);
  t.after(() => ws.terminate()); await once(ws, 'open'); return { ws, ...box };
}

test('dedicated WebSocket listener keeps HTTP dispatch on the HTTP port', async t => {
  const s = await setup(t, { wsPort: 0 });
  assert.notEqual(s.address.port, s.wsAddress.port);
  assert.equal((await fetch(s.base + '/get_status', { headers })).status, 200);
  assert.equal((await fetch(s.ws.replace('ws:', 'http:') + '/get_status', { headers })).status, 426);
  const wrong = new WebSocket(s.base.replace('http:', 'ws:'), { headers });
  await assert.rejects(once(wrong, 'open'), /404/);
  const right = await connect(t, s.ws + '/api');
  right.ws.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'split' }));
  assert.equal((await right.next()).echo, 'split');
  assert.equal(s.calls.length, 2);
});

test('HTTP auth, JSON/form/query requests, envelopes, status mapping and no secret forwarding', async t => {
  const s = await setup(t);
  assert.equal((await fetch(s.base + '/get_status')).status, 401);
  assert.equal((await fetch(s.base + '/get_status', { headers: { Authorization: 'Bearer wrong' } })).status, 403);
  const r = await fetch(s.base + '/send_group_msg', { method: 'POST', headers, body: JSON.stringify({ group_id: 123, message: '合成' }) });
  assert.deepEqual((await r.json()).data, { group_id: 123, message: '合成' });
  const query = await fetch(s.base + '/get_msg/?message_id=12&access_token=' + token);
  assert.deepEqual((await query.json()).data, { message_id: '12' });
  const form = await fetch(s.base + '/send_private_msg', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'user_id=12&message=a%26b' });
  assert.deepEqual((await form.json()).data, { user_id: '12', message: 'a&b' });
  const envelope = await fetch(s.base, { method: 'POST', headers, body: JSON.stringify({ action: 'get_status', echo: null }) });
  assert.equal((await envelope.json()).echo, null);
  assert.equal(s.calls.length, 4);
});

test('HTTP malformed/oversized/unsupported inputs cannot dispatch', async t => {
  const s = await setup(t, { maxBodyBytes: 64 });
  for (const [body, status] of [['{', 400], ['[]', 400], ['x'.repeat(65), 413]]) {
    const response = await fetch(s.base + '/send_group_msg', { method: 'POST', headers, body });
    assert.equal(response.status, status);
  }
  assert.equal((await fetch(s.base + '/get_status', { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status, 406);
  assert.equal((await fetch(s.base + '/get_status', { method: 'DELETE', headers })).status, 405);
  assert.equal(s.calls.length, 0);
});

test('WebSocket universal preserves arbitrary echo and responds to PING without disconnect', { timeout: 3000 }, async t => {
  const s = await setup(t), c = await connect(t, s.ws + '/');
  assert.equal((await c.next()).sub_type, 'connect');
  c.ws.send(JSON.stringify({ action: 'get_status', echo: { nested: [false, null, 0] } }));
  assert.deepEqual((await c.next()).echo, { nested: [false, null, 0] });
  const pong = once(c.ws, 'pong'); c.ws.ping('probe'); assert.equal((await pong)[0].toString(), 'probe');
  s.events.emit('event', { post_type: 'message', echo: 'must-strip', message_id: 3 });
  const event = await c.next(); assert.equal(event.message_id, 3); assert.equal('echo' in event, false);
  c.ws.send('{'); assert.equal((await c.next()).retcode, 1400);
  c.ws.send(JSON.stringify({ action: 'get_status', echo: 0 })); assert.equal((await c.next()).echo, 0);
});

test('API/event role separation and heartbeat status', { timeout: 3000 }, async t => {
  const s = await setup(t, { heartbeatMs: 30, status: () => ({ online: false, good: false }) });
  const api = await connect(t, s.ws + '/api/'), event = await connect(t, s.ws + '/event/');
  assert.equal((await event.next()).meta_event_type, 'lifecycle');
  event.ws.send(JSON.stringify({ action: 'send_group_msg' }));
  const heartbeat = await event.next(); assert.equal(heartbeat.meta_event_type, 'heartbeat'); assert.equal(heartbeat.status.online, false);
  assert.equal(s.calls.length, 0); assert.equal(api.messages.length, 0);
  api.ws.send(JSON.stringify({ action: 'get_status', echo: false })); assert.equal((await api.next()).echo, false);
});

test('WebSocket denies unauthorized upgrades and rejects invalid requests', { timeout: 3000 }, async t => {
  const s = await setup(t);
  const denied = new WebSocket(s.ws); denied.on('error', () => {}); t.after(() => denied.terminate());
  const [code] = await once(denied, 'unexpected-response').then(([, response]) => { response.resume(); denied.terminate(); return [response.statusCode]; });
  assert.equal(code, 401);
  const c = await connect(t, s.ws + '/api');
  c.ws.send(JSON.stringify({ action: 'x', params: [], echo: 'bad' }));
  assert.equal((await c.next()).retcode, 1400); assert.equal(s.calls.length, 0);
});

test('WebSocket limits pending calls and closes oversized payloads', { timeout: 3000 }, async t => {
  let release;
  const s = await setup(t, { maxBodyBytes: 128, maxInflight: 1, dispatch: () => new Promise(resolve => { release = resolve; }) });
  const c = await connect(t, s.ws + '/api');
  c.ws.send(JSON.stringify({ action: 'x', echo: 1 })); c.ws.send(JSON.stringify({ action: 'x', echo: 2 }));
  const busy = await c.next(); assert.equal(busy.retcode, 1429); assert.equal(busy.echo, 2);
  release({ status: 'ok', retcode: 0, data: null }); assert.equal((await c.next()).echo, 1);
  const closed = once(c.ws, 'close'); c.ws.send('x'.repeat(129)); assert.equal((await closed)[0], 1009);
});

test('Unsafe bind and absent authentication are rejected before listening', async () => {
  const options = { dispatch: () => {}, events: new EventEmitter(), token };
  await assert.rejects(createTransport({ ...options, token: '' }), /token/);
  await assert.rejects(createTransport({ ...options, host: '0.0.0.0' }), /loopback/);
});

test('Dispatcher failures are redacted and shutdown detaches events idempotently', async t => {
  const s = await setup(t, { dispatch: async () => { throw new Error('secret-value-do-not-expose'); } });
  const response = await fetch(s.base + '/get_status', { headers });
  const body = await response.text(); assert.equal(body.includes('secret-value'), false);
  assert.equal(JSON.parse(body).retcode, 1500);
  assert.equal(s.events.listenerCount('event'), 1);
  await s.close(); await s.close(); assert.equal(s.events.listenerCount('event'), 0);
});

test('Slow client byte budget disconnects instead of accumulating unbounded event data', { timeout: 3000 }, async t => {
  const s = await setup(t, { maxBufferedBytes: 256 }); const c = await connect(t, s.ws);
  await c.next(); const closed = once(c.ws, 'close');
  s.events.emit('event', { post_type: 'message', message: 'x'.repeat(300) });
  await closed; assert.notEqual(c.ws.readyState, WebSocket.OPEN);
});

test('Outbound endpoints cannot redirect authentication to non-loopback destinations', () => {
  const options = { events: new EventEmitter(), token, dispatch: async () => ({}) };
  for (const url of ['ws://example.com', 'ws://localhost', 'ws://127.0.0.1/?token=embedded', 'ws://user:pass@127.0.0.1'])
    assert.throws(() => createReverseWebSocket({ ...options, url }), /loopback/);
  assert.throws(() => createWebhook({ ...options, url: 'https://example.com' }), /loopback/);
});

test('Reverse WebSocket headers, invocation and bounded reconnection without event replay', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const events = new EventEmitter(), received = [], states = [];
  server.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`); assert.equal(req.headers['x-client-role'], 'Universal');
    ws.on('message', data => received.push(JSON.parse(data)));
    ws.send(JSON.stringify({ action: 'get_status', echo: 'reverse' }));
  });
  const reverse = createReverseWebSocket({ url: `ws://127.0.0.1:${server.address().port}`, token, events,
    dispatch: async () => ({ status: 'ok', retcode: 0, data: null }), maxAttempts: 2, baseDelayMs: 10,
    heartbeatMs: 10, status: () => ({ online: false, good: false }),
    onState: state => {
      states.push(state.state);
      if (state.state === 'disconnected') events.emit('event', { post_type: 'message', message_id: 991, marker: 'offline-not-replayed' });
    } });
  t.after(() => reverse.close());
  for (let i = 0; i < 100 && !received.some(v => v.echo === 'reverse'); i++) await delay(10);
  assert.ok(received.some(v => v.echo === 'reverse'));
  for (let i = 0; i < 100 && !received.some(v => v.meta_event_type === 'heartbeat'); i++) await delay(10);
  assert.equal(received.find(v => v.meta_event_type === 'heartbeat').status.online, false);
  for (const socket of server.clients) socket.terminate();
  for (let i = 0; i < 100 && reverse.attempts < 2; i++) await delay(10);
  await delay(30); for (const socket of server.clients) socket.terminate();
  for (let i = 0; i < 100 && !states.includes('exhausted'); i++) await delay(10);
  assert.ok(states.includes('exhausted')); assert.equal(reverse.attempts, 2);
  assert.equal(received.some(v => v.marker === 'offline-not-replayed'), false);
});

test('stable reverse WebSocket connections replenish the next reconnect budget', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const states = new EventEmitter();
  const reverse = createReverseWebSocket({ url: 'ws://127.0.0.1:' + server.address().port,
    token, events: new EventEmitter(), maxAttempts: 1, baseDelayMs: 10, stableConnectionMs: 20,
    heartbeatMs: 0, dispatch: async () => ({ retcode: 0 }),
    onState: ({ state }) => states.emit(state),
  });
  t.after(async () => {
    await reverse.close();
    await new Promise(resolve => server.close(resolve));
  });
  const signal = AbortSignal.timeout(4000);
  await once(states, 'connected', { signal });
  for (let cycle = 0; cycle < 2; cycle++) {
    await delay(40);
    const reconnected = once(states, 'connected', { signal });
    assert.equal(server.clients.size, 1);
    for (const socket of server.clients) socket.terminate();
    await reconnected;
  }
  assert.equal(reverse.attempts, 3);
});

test('reverse API connection replaces a peer that ignores ping and retains a peer that responds', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  await once(server, 'listening');
  const signal = AbortSignal.timeout(4000);
  let connections = 0;
  const responsive = new EventEmitter();
  server.on('connection', socket => {
    const number = ++connections;
    socket.on('ping', payload => {
      if (number === 1) socket.pong(Buffer.alloc(8));
      else {
        socket.pong(payload);
        responsive.emit('ping', number);
      }
    });
  });
  const reverse = createReverseWebSocket({ url: 'ws://127.0.0.1:' + server.address().port,
    token, events: new EventEmitter(), role: 'API', baseDelayMs: 10, pingIntervalMs: 20, pongTimeoutMs: 50,
    dispatch: async () => ({ retcode: 0 }),
  });
  t.after(async () => {
    await reverse.close();
    await new Promise(resolve => server.close(resolve));
  });
  assert.equal((await once(responsive, 'ping', { signal }))[0], 2);
  assert.equal((await once(responsive, 'ping', { signal }))[0], 2);
  assert.equal(connections, 2);
  assert.equal(reverse.attempts, 2);
});

test('Webhook signs exact bytes, reports HTTP failure once and ignores quick operation responses', { timeout: 3000 }, async t => {
  const events = new EventEmitter(), received = [], deliveries = [], secret = 'synthetic-hmac';
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ body, signature: req.headers['x-signature'] });
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"reply":"must-not-execute"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const webhook = createWebhook({ url: `http://127.0.0.1:${server.address().port}`, token, secret, events,
    onDelivery: value => deliveries.push(value) }); t.after(() => webhook.close());
  events.emit('event', { post_type: 'message', message_id: 1 });
  for (let i = 0; i < 100 && !deliveries.length; i++) await delay(10);
  assert.equal(deliveries[0].status, 503); assert.equal(received.length, 1);
  assert.equal(received[0].signature, 'sha1=' + createHmac('sha1', secret).update(received[0].body).digest('hex'));
});
