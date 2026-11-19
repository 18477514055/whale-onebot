import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { OneBotCore } from '../src/protocol/core.mjs';
import { createTransport } from '../src/transport/index.mjs';

test('OneBot HTTP dispatch accepts an independent adapter profile with string identities', async t => {
  const bridge = new EventEmitter();
  let account = 'channel-bot';
  bridge.probe = async () => ({ user_id: account, online: true, sessionId: 'session-1' });
  bridge.capabilities = () => ['read_channel'];
  bridge.call = async (action, params) => {
    assert.equal(action, 'read_channel');
    return { channel: params.channel };
  };
  const profile = Object.freeze({
    actions: Object.freeze({
      get_login_info: Object.freeze({ mutates: false }),
      get_status: Object.freeze({ mutates: false }),
      get_supported_actions: Object.freeze({ mutates: false }),
      read_channel: Object.freeze({ mutates: false }),
    }),
    validateParams(action, params) {
      if (action !== 'read_channel') return {};
      assert.equal(typeof params.channel, 'string');
      return { channel: params.channel };
    },
    acceptIdentity(proof) {
      return proof.user_id.startsWith('channel-') ? { user_id: proof.user_id } : null;
    },
  });
  const core = new OneBotCore({ profile, bridge });
  t.after(() => core.close());
  const token = 'synthetic-test-token';
  const transport = await createTransport({ dispatch: core.dispatch, events: core, token, port: 0 });
  t.after(() => transport.close());
  const address = 'http://127.0.0.1:' + transport.address.port;
  const call = async (action, params) => {
    const response = await fetch(address + '/', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
    return response.json();
  };
  assert.deepEqual((await call('get_login_info')).data, { user_id: 'channel-bot' });
  assert.deepEqual((await call('read_channel', { channel: 'room-a' })).data, { channel: 'room-a' });
  assert.equal((await call('send_group_msg')).retcode, 1404);
  const events = [];
  core.on('event', event => events.push(event));
  bridge.emit('event', { self_id: 'another-bot', post_type: 'notice' });
  bridge.emit('event', { self_id: 'channel-bot', post_type: 'notice' });
  assert.equal(events.length, 1);
  account = 'channel-replacement';
  assert.equal((await call('read_channel', { channel: 'room-a' })).retcode, 1503);
  assert.deepEqual(core.status(), { online: false, good: false });
});
