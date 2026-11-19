import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { OneBotCore } from '../src/core.mjs';
import { createTransport } from '../src/transport/index.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-generation-1', nickname: 'fixture' };
const event = id => ({ self_id: Number(BOT_UIN), post_type: 'message', message_type: 'group', group_id: 10,
  user_id: 20, message_id: id, message: [{ type: 'text', data: { text: 'synthetic' } }] });

test('custom forward WebSocket path preserves API, event and Universal roles', async t => {
  const events = new EventEmitter();
  const token = 'synthetic-role-token';
  let calls = 0;
  const server = await createTransport({ events, token, heartbeatMs: 0, wsPath: '/onebot/v11',
    dispatch: () => ({ retcode: 0, data: ++calls }) });
  t.after(() => server.close());
  const url = 'ws://127.0.0.1:' + server.address.port;
  const headers = { Authorization: 'Bearer ' + token };
  const signal = AbortSignal.timeout(3000);
  const rejected = new WebSocket(url + '/', { headers });
  assert.equal((await once(rejected, 'unexpected-response', { signal }))[1].statusCode, 404);
  rejected.on('error', () => {});
  rejected.terminate();
  const connect = async path => {
    const socket = new WebSocket(url + '/onebot/v11' + path, { headers });
    const frames = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open', { signal });
    return { socket, frames };
  };
  const [universal, api, eventOnly] = await Promise.all(['', '/api', '/event'].map(connect));
  for (const { socket } of [universal, api, eventOnly]) socket.send(JSON.stringify({ action: 'fixture', echo: 'role' }));
  events.emit('event', event(42));
  for (let i = 0; i < 100 && (api.frames.length < 1 || universal.frames.length < 3 || eventOnly.frames.length < 2); i++)
    await delay(10);
  assert.equal(calls, 2);
  assert.deepEqual(api.frames.map(frame => frame.echo), ['role']);
  assert.equal(universal.frames.find(frame => frame.echo === 'role').retcode, 0);
  assert.equal(universal.frames.find(frame => frame.post_type === 'message').message_id, 42);
  assert.deepEqual(eventOnly.frames.map(frame => frame.post_type), ['meta_event', 'message']);
});
class Bridge extends EventEmitter {
  calls = [];
  capabilities() { return ['send_group_msg', 'send_private_msg', 'send_msg', 'get_group_list']; }
  async probe() { return { ...identity }; }
  async call(action, params) { this.calls.push({ action, params }); return { message_id: 1 }; }
}
async function setup(t, options = {}) {
  const bridge = new Bridge(), core = new OneBotCore({ freezeOnUnknown: true, bridge, minimumWriteIntervalMs: 0, ...options });
  const token = 'synthetic-integration-token';
  const transport = await createTransport({ dispatch: core.dispatch, events: core, status: core.status, token, heartbeatMs: 0 });
  t.after(async () => { await transport.close(); core.close(); });
  const base = `http://127.0.0.1:${transport.address.port}`;
  const call = async (action, params = {}) => {
    const response = await fetch(base + '/' + action, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    return response.json();
  };
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/event', { headers: { Authorization: `Bearer ${token}` } });
  const frames = []; ws.on('message', data => frames.push(JSON.parse(data))); t.after(() => ws.terminate()); await once(ws, 'open');
  return { bridge, core, call, frames };
}

test('Integration: pre-proof events drop; verified event passes; TTL and offline events close gate', async t => {
  let now = 1000;
  const s = await setup(t, { clock: () => now, proofMaxAgeMs: 100 });
  s.bridge.emit('event', event(1)); await delay(10);
  assert.equal(s.frames.some(v => v.message_id === 1), false);
  assert.equal((await s.call('get_login_info')).data.user_id, Number(BOT_UIN));
  s.bridge.emit('event', event(2)); await delay(10);
  assert.equal(s.frames.some(v => v.message_id === 2), true);
  now += 100; s.bridge.emit('event', event(3)); await delay(10);
  assert.equal(s.frames.some(v => v.message_id === 3), false);
  await s.call('get_login_info'); s.bridge.emit('offline'); s.bridge.emit('event', event(4)); await delay(10);
  assert.equal(s.frames.some(v => v.message_id === 4), false);
});

test('Integration: timed-out late identity proof must not reopen event gate', async t => {
  const s = await setup(t, { timeoutMs: 25 }); let resolve;
  s.bridge.probe = () => new Promise(done => { resolve = done; });
  assert.equal((await s.call('get_login_info')).retcode, 1504);
  resolve({ ...identity }); await delay(10); s.bridge.emit('event', event(10)); await delay(10);
  assert.equal(s.core.status().online, false);
  assert.equal(s.frames.some(v => v.message_id === 10), false);
});

test('Integration: failed refresh must revoke previously accepted identity proof', async t => {
  const s = await setup(t); await s.call('get_login_info');
  s.bridge.probe = async () => { throw new Error('synthetic transport unavailable'); };
  assert.equal((await s.call('get_status')).data.online, false);
  s.bridge.emit('event', event(11)); await delay(10);
  assert.equal(s.core.status().online, false);
  assert.equal(s.frames.some(v => v.message_id === 11), false);
});

test('Integration: concurrent disconnect before proof resolution cannot submit mutation', async t => {
  const s = await setup(t); let release, began;
  const pending = new Promise(resolve => { began = resolve; });
  s.bridge.probe = () => new Promise(resolve => { release = resolve; began(); });
  const action = s.call('send_group_msg', { group_id: 10, message: 'synthetic' });
  await pending; s.bridge.emit('offline'); release({ ...identity });
  assert.notEqual((await action).retcode, 0); assert.equal(s.bridge.calls.length, 0);
});

test('Integration: unknown mutation outcome blocks later writes and never retries', async t => {
  const s = await setup(t, { timeoutMs: 25 });
  let count = 0; s.bridge.call = async () => { count++; return new Promise(() => {}); };
  // P4：发送失败/未知不再锁死后续发送，但也不会自动重试同一条。
  assert.equal((await s.call('send_group_msg', { group_id: 10, message: 'synthetic' })).retcode, 0);
  assert.equal((await s.call('send_group_msg', { group_id: 10, message: 'synthetic' })).retcode, 0);
  assert.equal(count, 2);
});

test('Integration: alias and string HTTP parameters preserve target/protected account checks', async t => {
  const s = await setup(t);
  assert.equal((await s.call('send_message', { message_type: 'group', group_id: '10', message: 'synthetic' })).retcode, 0);
  assert.equal(s.bridge.calls[0].action, 'send_msg'); assert.equal(s.bridge.calls[0].params.group_id, 10);
  assert.equal((await s.call('send_message', { message_type: 'private', user_id: OWNER_UIN, message: 'synthetic' })).retcode, 1403);
  assert.equal(s.bridge.calls.length, 1);
});
