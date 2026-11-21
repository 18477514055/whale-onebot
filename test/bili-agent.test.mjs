import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OneBotClient, createAgentOneBotClient } from '../input/agent-app/src/onebot/onebot.js';
import { agentInstance } from '../input/agent-app/src/core/bili-instance.js';
import { EXPECTED_ACCOUNT_ID } from '../input/agent-app/src/onebot/local-account-guard.js';
import { createTransport } from '../src/transport/index.mjs';

const selfId = 701001, peerId = 701002;
const token = randomUUID(); // Local bearer; no real credentials or account files.
function route(t, { address, wsAddress }) {
  const env = { WHALE_ONEBOT_HTTP_URL: `http://127.0.0.1:${address.port}`,
    WHALE_ONEBOT_WS_URL: `ws://127.0.0.1:${wsAddress.port}/`, WHALE_ONEBOT_TOKEN: token };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  } });
}
async function connect(t, client) {
  const up = new Promise(resolve => client.onStatus(s => { if (s.connected) resolve(); }));
  await client.connect();
  await up;
}

test('dedicated Bilibili service: actual agent receives WS private text and confirms its HTTP reply', { timeout: 10000 }, async t => {
  const { startBiliService } = await import('../src/platforms/bilibili/service.mjs');
  const { BiliBridge } = await import('../src/platforms/bilibili/bridge.mjs');
  const history = [], sent = [];
  const client = {
    identity: async () => ({ user_id: selfId, nickname: 'fixture' }),
    messages: async end => history.filter(row => end == null || BigInt(row.msg_seqno) < BigInt(end)),
    sendText: async text => { sent.push(text); return { msg_key: '9007199254740993003' }; },
  };
  const service = await startBiliService({ client, selfId, peerId, token, port: 0, allowSend: true, pollMs: 60000 });
  let agent;
  t.after(async () => { agent?.close(); await service.close(); });
  assert.ok(service.bridge instanceof BiliBridge);
  route(t, service);
  const events = new EventEmitter();
  agent = createAgentOneBotClient({ selfId }, { heartbeat: 'off', onEvent: f => events.emit(f.post_type, f) });
  await connect(t, agent);
  const login = await agent.call('get_login_info', {}, 2000); // Verifies WS AND HTTP endpoint identities.
  assert.equal(login.platform, 'bilibili'); assert.equal(agent.selfId, String(selfId));
  const incoming = once(events, 'message', { signal: AbortSignal.timeout(3000) });
  history.push({ msg_seqno: 1, msg_key: '9007199254740993002', sender_uid: peerId, receiver_id: selfId,
    receiver_type: 1, msg_type: 1, msg_source: 0, timestamp: Math.floor(Date.now() / 1000), content: JSON.stringify({ content: '你好，夹具' }) });
  await service.bridge.pollOnce();
  const [event] = await incoming;
  assert.equal(event.platform, 'bilibili'); assert.equal(event.message_type, 'private');
  assert.equal(event.self_id, selfId); assert.equal(event.user_id, peerId);
  assert.deepEqual(event.message, [{ type: 'text', data: { text: '你好，夹具' } }]);
  const ack = await agent.sendText('private', event.user_id, '收到，谢谢');
  assert.ok(Number.isSafeInteger(ack?.message_id) && ack.message_id !== 0, 'confirmed OneBot message_id, not accepted/unknown');
  assert.deepEqual(sent, ['收到，谢谢']);
});

test('numeric UID alone is not a Bilibili credential: untagged QQ endpoint cannot receive a write', { timeout: 5000 }, async t => {
  const calls = [];
  const transport = await createTransport({ token, events: new EventEmitter(), heartbeatMs: 0,
    dispatch: async req => { calls.push(req.action); return { status: 'ok', retcode: 0, data: { user_id: selfId } }; } });
  let agent;
  t.after(async () => { agent?.close(); await transport.close(); });
  route(t, transport);
  agent = createAgentOneBotClient({ selfId }, { heartbeat: 'off' });
  await connect(t, agent);
  await assert.rejects(agent.sendText('private', peerId, 'do not dispatch'), { code: 'LOCAL_ACCOUNT_GUARD' });
  assert.equal(agent.selfId, ''); assert.ok(calls.length > 0); assert.ok(calls.every(a => a === 'get_login_info'));
  assert.ok(createAgentOneBotClient(null, {}) instanceof OneBotClient);
});

test('default QQ client rejects an explicitly Bilibili response even for the identical decimal UID', { timeout: 5000 }, async t => {
  const events = new EventEmitter(), received = [], writes = [];
  let platform;
  const server = await createTransport({ token, events, selfId: Number(EXPECTED_ACCOUNT_ID), heartbeatMs: 0,
    dispatch: async req => {
      if (req.action === 'send_private_msg') writes.push(req);
      return { status: 'ok', retcode: 0, data: { user_id: EXPECTED_ACCOUNT_ID, platform } };
    } });
  let agent;
  t.after(async () => { agent?.close(); await server.close(); });
  route(t, server);
  agent = createAgentOneBotClient(null, { heartbeat: 'off', onEvent: f => received.push(f) });
  await connect(t, agent);
  assert.equal((await agent.call('get_login_info')).user_id, EXPECTED_ACCOUNT_ID); // Original untagged QQ is allowed.
  platform = 'bilibili';
  events.emit('event', { self_id: EXPECTED_ACCOUNT_ID, platform, post_type: 'message' });
  await assert.rejects(agent.callViaWs('get_login_info'), { code: 'LOCAL_ACCOUNT_GUARD' });
  await assert.rejects(agent.sendText('private', peerId, 'do not dispatch'), { code: 'LOCAL_ACCOUNT_GUARD' });
  assert.equal(agent.selfId, ''); assert.ok(received.every(f => f.post_type !== 'message')); assert.deepEqual(writes, []);
});

test('isolated Bilibili agent data directory cannot adopt QQ history or be reopened as QQ', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whale-bili-agent-'));
  try {
    const dir = path.join(root, `bilibili-${selfId}`);
    const env = { WHALE_AGENT_PLATFORM: 'bilibili', WHALE_BILI_SELF_ID: String(selfId), WHALE_BILI_CONSOLE_PORT: '25403',
      WHALE_ONEBOT_HTTP_URL: 'http://127.0.0.1:25401', WHALE_ONEBOT_WS_URL: 'ws://127.0.0.1:25402', WHALE_ONEBOT_TOKEN: token, QQ_AGENT_DATA_DIR: dir };
    assert.throws(() => agentInstance({ ...env, QQ_AGENT_DATA_DIR: root }), /directory/);
    assert.throws(() => agentInstance({ ...env, WHALE_BILI_CONSOLE_PORT: '3210' }), /console port/);
    mkdirSync(dir); writeFileSync(path.join(dir, 'messages.sqlite'), 'synthetic sentinel');
    assert.throws(() => agentInstance(env), /unmarked/);
    const clean = { ...env, QQ_AGENT_DATA_DIR: path.join(root, 'fresh', `bilibili-${selfId}`) };
    assert.deepEqual(agentInstance(clean), { selfId: String(selfId), port: 25403 });
    assert.deepEqual(agentInstance(clean), agentInstance(clean));
    assert.throws(() => agentInstance({ ...clean, WHALE_AGENT_PLATFORM: 'qq' }), /cannot be opened as QQ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
