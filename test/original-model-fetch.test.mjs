import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalModelFetch } from '../src/host/original-model-fetch.mjs';
const upstream = 'https://opencode.ai/inference/go/openai/v1/chat/completions';
const options = { relayBase: 'http://127.0.0.1:45670/v1', relayToken: 'synthetic-local-only-auth' };

test('in-memory relay leaves original service/model/request parameters unchanged', async () => {
  let captured;
  const fetch = createOriginalModelFetch(async (input, init) => { captured = new Request(input, init); return new Response('{}'); }, options);
  const payload = { model: 'synthetic-original-purpose-model', messages: [{ role: 'user', content: 'synthetic hello' }],
    stream: false, temperature: 0.7, thinking: { type: 'disabled' } };
  await fetch(upstream, { method: 'POST', headers: { authorization: 'Bearer __whale_runtime_auth__', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(captured.url, options.relayBase + '/chat/completions');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(JSON.parse(await captured.text()), payload);
  assert.equal(captured.headers.has('authorization'), false);
  assert.equal(captured.headers.get('x-whale-model-relay'), options.relayToken);
});

test('all other origins, service tiers and paths remain untouched', async () => {
  const calls = [];
  const fetch = createOriginalModelFetch((...args) => { calls.push(args); return Promise.resolve(new Response('{}')); }, options);
  const init = { method: 'GET', headers: { 'x-synthetic-header': 'unchanged' } };
  for (const url of ['https://example.invalid/v1/chat/completions', 'https://opencode.ai/inference/openai/v1/chat/completions',
    'https://opencode.ai/inference/go/openai/v1/models']) {
    await fetch(url, init);
    assert.equal(calls.at(-1)[0], url);
    assert.equal(calls.at(-1)[1], init);
  }
});

test('Request inputs retain body, caller headers and cancellation signal', async () => {
  let captured;
  const fetch = createOriginalModelFetch(async (input, init) => { captured = new Request(input, init); return new Response('{}'); }, options);
  const controller = new AbortController();
  const input = new Request(upstream, { method: 'POST', body: '{"synthetic":true}', headers: { 'content-type': 'application/json', 'x-original': 'retained' }, signal: controller.signal });
  await fetch(input);
  assert.equal(await captured.text(), '{"synthetic":true}');
  assert.equal(captured.headers.get('x-original'), 'retained');
  controller.abort();
  assert.equal(captured.signal.aborted, true);
});

test('relay authentication can only be routed to the selected literal loopback target', () => {
  for (const relayBase of ['https://example.invalid/v1', 'http://127.0.0.1:1234/v1?secret=not-real', 'http://u:p@127.0.0.1:1234/v1'])
    assert.throws(() => createOriginalModelFetch(() => {}, { ...options, relayBase }), /ORIGINAL_MODEL_RELAY_INVALID/);
  assert.throws(() => createOriginalModelFetch(() => {}, { ...options, relayToken: 'bad\nheader' }), /ORIGINAL_MODEL_RELAY_INVALID/);
});
