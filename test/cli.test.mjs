import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {once, on} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket, WebSocketServer} from 'ws';
import {main} from '../src/cli.mjs';
test('standalone CLI actually serves offline and never reveals token',async t=>{
  const token=randomBytes(24).toString('hex');const lines=[];
  const app=await main({env:{WHALE_ONEBOT_TOKEN:token,WHALE_ONEBOT_PORT:'0'},log:line=>lines.push(line)});t.after(()=>app.close());
  assert(!lines.join('').includes(token));
  const url=`http://127.0.0.1:${app.server.address.port}`;
  assert.equal((await fetch(url+'/get_status')).status,401);
  const response=await fetch(url+'/get_status',{headers:{Authorization:`Bearer ${token}`}});
  assert.deepEqual((await response.json()).data,{online:false,good:false});
  const send=await fetch(url+'/send_group_msg',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({group_id:900001,message:'synthetic'})});
  assert.equal((await send.json()).retcode,1404);
});
test('CLI refuses missing token without starting an unprotected server',async()=>{
  await assert.rejects(main({env:{}}));
});

test('CLI supports separate HTTP and forward ports alongside an authenticated reverse connection', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      for (const socket of receiver.clients) socket.terminate();
      await new Promise(resolve => receiver.close(resolve));
    }
  });
  const signal = AbortSignal.timeout(5000);
  await once(receiver, 'listening', { signal });
  const token = randomBytes(24).toString('hex'), reverseToken = randomBytes(24).toString('hex');
  const connected = once(receiver, 'connection', { signal });
  const lines = [];
  app = await main({ env: { WHALE_ONEBOT_TOKEN: token, WHALE_ONEBOT_PORT: '0', WHALE_ONEBOT_WS_PORT: '0',
    WHALE_ONEBOT_WS_PATH: '/onebot/v11', WHALE_ONEBOT_REVERSE_WS_URL: `ws://127.0.0.1:${receiver.address().port}`,
    WHALE_ONEBOT_REVERSE_WS_TOKEN: reverseToken }, log: line => lines.push(line) });
  const [reverseSocket, request] = await connected;
  assert.equal(request.headers.authorization, `Bearer ${reverseToken}`);
  assert.equal(request.headers['x-client-role'], 'Universal');
  assert(!lines.some(line => line.includes(token) || line.includes(reverseToken)));
  const { address, wsAddress } = app.server;
  assert.notEqual(address.port, wsAddress.port);
  const viaHTTP = await fetch(`http://127.0.0.1:${address.port}/get_status`, { headers: { Authorization: `Bearer ${token}` }, signal });
  assert.equal(viaHTTP.status, 200);
  const httpData = (await viaHTTP.json()).data;
  assert.deepEqual(httpData, { online: false, good: false });
  const forward = new WebSocket(`ws://127.0.0.1:${wsAddress.port}/onebot/v11/api`, { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => forward.terminate());
  await once(forward, 'open', { signal });
  async function readStatus(socket) {
    const frames = on(socket, 'message', { signal });
    try {
      socket.send(JSON.stringify({ action: 'get_status', echo: 'offline' }));
      for await (const [payload] of frames) {
        const response = JSON.parse(payload.toString());
        if (response.echo === 'offline') {
          assert.equal(response.retcode, 0);
          return response.data;
        }
      }
    } finally { await frames.return(); }
  }
  assert.deepEqual(await readStatus(forward), httpData);
  assert.deepEqual(await readStatus(reverseSocket), httpData);
  const detached = once(reverseSocket, 'close', { signal });
  await app.close();
  await detached;
});

test('CLI configures reverse API and Event roles with independent tokens', async t => {
  const http = createServer();
  const receiver = new WebSocketServer({ server: http });
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      for (const socket of receiver.clients) socket.terminate();
      await new Promise(resolve => receiver.close(resolve));
      await new Promise(resolve => http.close(resolve));
    }
  });
  const signal = AbortSignal.timeout(5000);
  http.listen(0, '127.0.0.1');
  await once(receiver, 'listening', { signal });
  const peers = new Map();
  const connected = Promise.withResolvers();
  receiver.on('connection', (socket, request) => {
    const messages = on(socket, 'message', { signal });
    peers.set(request.url, { socket, request, messages });
    if (peers.size === 2) connected.resolve();
  });
  const url = `ws://127.0.0.1:${receiver.address().port}`;
  const apiToken = randomBytes(24).toString('hex'), eventToken = randomBytes(24).toString('hex');
  const env = { WHALE_ONEBOT_TOKEN: 'synthetic-local-token', WHALE_ONEBOT_PORT: '0',
    WHALE_ONEBOT_REVERSE_WS_API_URL: url + '/api', WHALE_ONEBOT_REVERSE_WS_API_TOKEN: apiToken,
    WHALE_ONEBOT_REVERSE_WS_EVENT_URL: url + '/event', WHALE_ONEBOT_REVERSE_WS_EVENT_TOKEN: eventToken };
  await assert.rejects(main({ env: { ...env, WHALE_ONEBOT_REVERSE_WS_EVENT_TOKEN: undefined } }), /EVENT_TOKEN/);
  let tcpConnections = 0;
  http.on('connection', () => { tcpConnections++; });
  await assert.rejects(main({ env: { ...env, WHALE_ONEBOT_REVERSE_WS_EVENT_TOKEN: eventToken + '\0' } }), /token header/);
  await assert.rejects(main({ env: { ...env, WHALE_ONEBOT_REVERSE_WS_EVENT_URL: url + '/event?invalid=1' } }), /loopback endpoint/);
  await delay(50);
  assert.equal(tcpConnections, 0);
  app = await main({ env, log() {} });
  await Promise.race([connected.promise, once(receiver, 'close', { signal }).then(() => assert.fail('Receiver closed'))]);
  const api = peers.get('/api'), event = peers.get('/event');
  try {
    assert.equal(api.request.headers.authorization, `Bearer ${apiToken}`);
    assert.equal(event.request.headers.authorization, `Bearer ${eventToken}`);
    assert.equal(api.request.headers['x-client-role'], 'API');
    assert.equal(event.request.headers['x-client-role'], 'Event');
    const action = JSON.stringify({ action: 'get_status', echo: 'split' });
    api.socket.send(action);
    const lifecycle = JSON.parse((await event.messages.next()).value[0].toString());
    assert.equal(lifecycle.meta_event_type, 'lifecycle');
    const response = JSON.parse((await api.messages.next()).value[0].toString());
    assert.equal(response.echo, 'split');
    assert.equal(response.retcode, 0);
    assert.deepEqual(response.data, { online: false, good: false });
    const detached = Promise.all([api.socket, event.socket].map(socket => once(socket, 'close', { signal })));
    await app.close();
    await detached;
  } finally { await Promise.all([api.messages.return(), event.messages.return()]); }
});
