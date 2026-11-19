import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { probeOpenCodeModel, readHiddenKey, protectLocalBroker, OPENCODE_BASE, OPENCODE_MODEL } from '../scripts/verify-opencode-model.mjs';
import { createModelBroker } from '../src/host/full-agent-model-broker.mjs';

const KEY = 'synthetic-opencode-probe-key-not-real';
function stub(t, mode = 'success') {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://opencode.ai/')) return original(url, options);
    calls++;
    assert.equal(String(url), OPENCODE_BASE + '/chat/completions');
    assert.equal(options.headers.authorization, `Bearer ${KEY}`);
    const request = JSON.parse(options.body); assert.equal(request.model, OPENCODE_MODEL);
    const expected = JSON.stringify(request.messages).match(/whale-model-check-[a-f0-9]{24}/)?.[0]; assert(expected);
    let message;
    if (mode === 'reflect') message = { role: 'assistant', content: KEY };
    else if (mode === 'invalid') message = { role: 'assistant', content: 'No tool call' };
    else if (calls === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-call', type: 'function',
      function: { name: 'send_message', arguments: JSON.stringify({ messages: expected }) } }] };
    else {
      assert(request.messages.some(item => item.role === 'tool' && item.tool_call_id === 'synthetic-call' && item.content.includes('123456789')));
      message = { role: 'assistant', content: 'Synthetic receipt acknowledged.' };
    }
    return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; }); return () => calls;
}
test('real-model probe validates a tool call and tool-result round without QQ or retained credentials', async t => {
  const calls = stub(t); const report = await probeOpenCodeModel({ apiKey: KEY });
  assert.equal(calls(), 2); assert.equal(report.requests, 2); assert.equal(report.realSends, 0);
  assert.equal(report.syntheticToolCallValidated, true); assert.equal(report.toolResultRoundtrip, true);
  assert(!JSON.stringify(report).includes(KEY)); assert.equal(report.usage.length, 2);
});
test('invalid model output stops after first request rather than retrying', async t => {
  const calls = stub(t, 'invalid'); await assert.rejects(probeOpenCodeModel({ apiKey: KEY })); assert.equal(calls(), 1);
});
test('credential-reflecting upstream cannot enter the probe report', async t => {
  const calls = stub(t, 'reflect'); await assert.rejects(probeOpenCodeModel({ apiKey: KEY }), /OPENCODE_COMPLETION_FAILED/);
  assert.equal(calls(), 1);
});
test('parent-side HTTP capability rejects unauthenticated callers before any broker input', async t => {
  const broker = createModelBroker({ baseUrl: OPENCODE_BASE, apiKey: KEY, model: OPENCODE_MODEL, maxRequests: 0 });
  const auth = protectLocalBroker(broker); t.after(() => broker.close());
  broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening');
  const url = `http://127.0.0.1:${broker.server.address().port}/v1/chat/completions`;
  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401); assert.equal(broker.stats().received, 0);
  const allowed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...auth.headers },
    body: JSON.stringify({ model: OPENCODE_MODEL, messages: [{ role: 'user', content: 'synthetic' }] }) });
  assert.equal(allowed.status, 429); assert.equal(broker.stats().requests, 0);
});
test('missing key is rejected without accessing any source configuration or model', async () => {
  await assert.rejects(probeOpenCodeModel({ apiKey: '' }), /OPENCODE_KEY_REQUIRED/);
});
function tty() {
  const input = new EventEmitter(), writes = [];
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {}; input.pause = () => {};
  return { input, writes, output: { write: text => writes.push(text) } };
}
test('hidden terminal key input never echoes, restores raw mode and removes listeners', async () => {
  const f = tty(); const pending = readHiddenKey(f);
  assert.equal(f.input.isRaw, true); f.input.emit('data', Buffer.from(KEY + '\r'));
  assert.equal(await pending, KEY); assert.equal(f.input.isRaw, false); assert.equal(f.input.listenerCount('data'), 0);
  assert(!f.writes.join('').includes(KEY));
});
test('hidden input handles correction, cancellation and rejects non-TTY input', async () => {
  const f = tty(); const pending = readHiddenKey(f); f.input.emit('data', Buffer.from('abcX\bdef\r'));
  assert.equal(await pending, 'abcdef');
  const g = tty(); const cancelled = readHiddenKey(g); g.input.emit('data', Buffer.from('\u0003'));
  await assert.rejects(cancelled, /KEY_INPUT_CANCELLED/); assert.equal(g.input.isRaw, false);
  await assert.rejects(readHiddenKey({ input: { isTTY: false } }), /KEY_TTY_REQUIRED/);
});
test('hidden input accepts fragmented bracketed paste, paste gestures and harmless surrounding whitespace', async () => {
  for (const sequence of [
    '\u001b[200~' + KEY + '\u001b[201~\r',
    '\u001b[200~  ' + KEY + '\r\n\u001b[201~\r',
    '\u0016' + KEY + '\r',
    '  ' + KEY + '  \r',
  ]) {
    const f = tty(), pending = readHiddenKey(f);
    for (const char of sequence) f.input.emit('data', Buffer.from(char));
    assert.equal(await pending, KEY); assert.equal(f.input.isRaw, false);
    assert(!f.writes.join('').includes(KEY)); assert.equal(f.input.listenerCount('data'), 0);
  }
});
test('hidden input rejects internal newline, bearer prefixes and nested paste frames', async () => {
  for (const sequence of [
    '\u001b[200~one\r\ntwo\u001b[201~\r',
    'Bearer ' + KEY + '\r',
    '\u001b[200~\u001b[200~',
    '\u001b[201~',
  ]) {
    const f = tty(), pending = readHiddenKey(f); f.input.emit('data', Buffer.from(sequence));
    await assert.rejects(pending, /KEY_INPUT_INVALID/); assert.equal(f.input.isRaw, false);
    assert(!f.writes.join('').includes(KEY));
  }
});
test('hidden input rejects controls and oversized input without echoing partial secret', async () => {
  for (const text of ['abc\u001b[A', 'a'.repeat(4097)]) {
    const f = tty(), pending = readHiddenKey(f); f.input.emit('data', Buffer.from(text));
    await assert.rejects(pending, /KEY_INPUT_INVALID/); assert.equal(f.input.isRaw, false);
    assert(!f.writes.join('').includes('abc')); assert.equal(f.input.listenerCount('error'), 0);
  }
});
