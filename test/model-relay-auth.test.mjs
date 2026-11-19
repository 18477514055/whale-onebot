import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { protectOriginalModelRelay } from '../src/host/model-relay-auth.mjs';

test('normal relay authentication rejects unauthenticated calls without imposing trial concurrency limits', async t => {
  let calls = 0;
  const server = http.createServer((_req, res) => { calls++; res.end('synthetic-ok'); });
  const auth = protectOriginalModelRelay({ server });
  assert.equal(server.maxConnections, undefined);
  assert.throws(() => protectOriginalModelRelay({ server }), /ALREADY_BOUND/);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(calls, 0);
  const response = await fetch(url, { method: 'POST', headers: auth.headers });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'synthetic-ok');
  assert.equal(calls, 1);
});

test('normal auth preserves an explicitly caller-owned connection setting', () => {
  const server = http.createServer(() => {});
  server.maxConnections = 17;
  protectOriginalModelRelay({ server });
  assert.equal(server.maxConnections, 17);
  assert.throws(() => protectOriginalModelRelay({}), /SERVER_REQUIRED/);
});
