import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {withExplicitQqGuard} from '../input/agent-app/src/onebot/local-account-guard.js';

class ActionError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ActionError';
    Object.assign(this, info);
  }
}

class FakeSocket extends EventEmitter {
  readyState = 1;
}

/** Minimal upstream: only the two low-level entry points the guard wraps. */
function makeUpstream(httpImpl, wsImpl) {
  return class Upstream {
    constructor() {
      this.connected = false;
      this.httpUrl = 'http://127.0.0.1:13800';
      this.wsUrl = 'ws://127.0.0.1:13800';
      this.httpToken = 't';
      this.accessToken = 't';
      this.wsEchoSeq = 0;
      this.httpCalls = 0;
      this.wsCalls = 0;
    }
    async call(action) {
      this.httpCalls += 1;
      return httpImpl(action, this.httpCalls);
    }
    async callViaWs(action) {
      this.wsCalls += 1;
      return wsImpl(action, this.wsCalls);
    }
  };
}

const ACCOUNT = '991007';

function connect(Upstream) {
  const Guarded = withExplicitQqGuard(Upstream, ActionError, ACCOUNT);
  const client = new Guarded();
  client.socket = new FakeSocket();
  client.connected = true;
  return client;
}

const refuse = () => {
  throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:13800'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port: 13800
  });
};

const timeout = () => {
  throw Object.assign(new Error('probe timed out'), {name: 'TimeoutError', code: 'ETIMEDOUT'});
};

const ok = () => ({user_id: ACCOUNT, nickname: 'fixture'});
const otherAccount = () => ({user_id: '991008', nickname: 'other'});

test('a refused HTTP identity probe reports the real cause, not one generic sentence', async () => {
  const client = connect(makeUpstream(refuse, refuse));
  await assert.rejects(client.call('send_group_msg', {group_id: 1, message: 'x'}), error => {
    assert.equal(error.code, 'LOCAL_ACCOUNT_GUARD');
    assert.match(error.message, /identity probe failed/);
    // The field message must carry the transport cause; a bare "identity probe
    // failed" is undiagnosable (this is exactly what hid the 6h send outage).
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /127\.0\.0\.1:13800/);
    // Both channels down: the abandoned HTTP cause must survive in the message.
    assert.match(error.message, /http channel also failed/);
    return true;
  });
});

test('a fast transport rejection is re-probed exactly once before giving up', async () => {
  const client = connect(makeUpstream(refuse, refuse));
  await assert.rejects(client.call('send_group_msg', {group_id: 1, message: 'x'}));
  assert.equal(client.httpCalls, 2);
  assert.equal(client.wsCalls, 2);
});

test('a timed-out probe is never re-probed (it already spent its budget)', async () => {
  const client = connect(makeUpstream(timeout, timeout));
  await assert.rejects(client.call('send_group_msg', {group_id: 1, message: 'x'}), /ETIMEDOUT/);
  assert.equal(client.httpCalls, 1);
  assert.equal(client.wsCalls, 1);
});

test('a wrong identity is never retried and is reported as an identity problem', async () => {
  const client = connect(makeUpstream(otherAccount, ok));
  await assert.rejects(client.call('send_group_msg', {group_id: 1, message: 'x'}), /identity is missing or not the fixed expected account/);
  assert.equal(client.httpCalls, 1);
});

test('a transient rejection followed by a healthy probe still dispatches', async () => {
  const client = connect(makeUpstream((action, n) => {
    if (n === 1) refuse();
    return ok();
  }, ok));
  await client.call('send_group_msg', {group_id: 1, message: 'x'});
  // first probe rejects, the re-probe answers, then the business call dispatches
  assert.equal(client.httpCalls, 3);
});

test('a wedged HTTP channel does not silence a WS-verified bot', async () => {
  const client = connect(makeUpstream(refuse, ok));
  await client.call('send_group_msg', {group_id: 1, message: 'x'});
  // http: two probes, no business call. ws: one identity probe + the dispatch.
  assert.equal(client.httpCalls, 2);
  assert.equal(client.wsCalls, 2);
  assert.equal(client.dualVerified, false);
});

test('a wrong identity on the fallback channel is still refused, never dispatched', async () => {
  const client = connect(makeUpstream(refuse, otherAccount));
  await assert.rejects(client.call('send_group_msg', {group_id: 1, message: 'x'}), /ws identity is missing or not the fixed expected account/);
  // ws probe answered with a foreign account: one probe, zero dispatches
  assert.equal(client.wsCalls, 1);
});

test('strict binding mode keeps the dual requirement and never falls back', async () => {
  const previous = process.env.QQ_AGENT_BINDING_ID;
  process.env.QQ_AGENT_BINDING_ID = 'binding-fixture';
  try {
    const client = connect(makeUpstream(refuse, ok));
    await assert.rejects(client.call('send_group_msg', {group_id: 1, message: 'x'}));
    assert.equal(client.wsCalls, 1);
    assert.equal(client.httpCalls, 2);
  } finally {
    if (previous === undefined) delete process.env.QQ_AGENT_BINDING_ID;
    else process.env.QQ_AGENT_BINDING_ID = previous;
  }
});
