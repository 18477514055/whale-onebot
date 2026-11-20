import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createModelBroker } from '../src/host/full-agent-model-broker.mjs';

export const OPENCODE_MODEL = 'deepseek-v4.1-flash';
export const OPENCODE_BASE = 'https://opencode.ai/inference/go/openai/v1';

// Read from the terminal, never a shell command/history, and never echo the key.
// Caller can instead supply OPENCODE_API_KEY in this process's environment.
export function readHiddenKey({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new Error('KEY_TTY_REQUIRED'));
  return new Promise((resolve, reject) => {
    const previousRaw = Boolean(input.isRaw);
    let value = '', escape = '', pasting = false;
    const beginPaste = '\u001b[200~', endPaste = '\u001b[201~';
    const cleanup = () => {
      input.off('data', data); input.off('error', error);
      input.setRawMode(previousRaw); input.pause(); output.write('\n\u001b[?2004h');
    };
    const fail = code => { cleanup(); reject(new Error(code)); };
    const error = () => fail('KEY_INPUT_FAILED');
    const append = char => {
      if (value.length >= 4096) { fail('KEY_INPUT_INVALID_TOO_LONG'); return false; }
      value += char; return true;
    };
    const data = bytes => {
      for (const char of bytes.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { fail('KEY_INPUT_CANCELLED'); return; }
        if (escape) {
          escape += char;
          if (escape === beginPaste) {
            if (pasting) { fail('KEY_INPUT_INVALID_CONTROL'); return; }
            pasting = true; escape = ''; continue;
          }
          if (escape === endPaste) {
            if (!pasting) { fail('KEY_INPUT_INVALID_CONTROL'); return; }
            pasting = false; escape = ''; continue;
          }
          if (!beginPaste.startsWith(escape) && !endPaste.startsWith(escape)) {
            fail('KEY_INPUT_INVALID_CONTROL'); return;
          }
          continue;
        }
        if (char === '\u001b') { escape = char; continue; }
        if (pasting) { if (!append(char)) return; continue; }
        // Some terminal frontends emit the paste gesture before its text.
        if (char === '\u0016') continue;
        if (char === '\r' || char === '\n') {
          const trimmed = value.trim();
          if (!trimmed) { fail('KEY_REQUIRED'); return; }
          if (!/^[\x21-\x7e]+$/.test(trimmed)) { fail('KEY_INPUT_INVALID_TOKEN'); return; }
          cleanup(); resolve(trimmed); return;
        }
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (!/^[\x20-\x7e\t]$/.test(char)) { fail('KEY_INPUT_INVALID_CONTROL'); return; }
        if (!append(char)) return;
      }
    };
    output.write('\u001b[?2004lOpenCode API Key (hidden input; paste only the key, then Enter): ');
    input.setRawMode(true); input.on('data', data); input.once('error', error); input.resume();
  });
}

// Keep the parent-side HTTP capability authenticated too; the local header is
// never forwarded by createModelBroker to the upstream provider.
export function protectLocalBroker(broker) {
  const token = randomBytes(24).toString('hex');
  const listeners = broker.server.listeners('request');
  assert.equal(listeners.length, 1);
  broker.server.removeAllListeners('request');
  broker.server.on('request', (req, res) => {
    if (req.headers['x-whale-model-relay'] !== token) {
      res.writeHead(401, { 'content-type': 'application/json', connection: 'close' }).end('{"error":{"code":"LOCAL_AUTH_REQUIRED"}}');
      req.resume(); return;
    }
    listeners[0].call(broker.server, req, res);
  });
  broker.server.maxConnections = 4;
  return { token, headers: { 'x-whale-model-relay': token } };
}

export async function probeOpenCodeModel({ apiKey }) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('OPENCODE_KEY_REQUIRED');
  const broker = createModelBroker({ baseUrl: OPENCODE_BASE, apiKey, model: OPENCODE_MODEL,
    maxRequests: 2, maxTokens: 4096, timeoutMs: 90000 });
  const localAuth = protectLocalBroker(broker);
  const expected = `whale-model-check-${randomBytes(12).toString('hex')}`;
  const messages = [
    { role: 'system', content: 'You are testing a model integration. The supplied send_message tool is a local synthetic recorder only; it cannot connect to QQ, send a real message, or access any device. Call it exactly once as requested.' },
    { role: 'user', content: `Call send_message exactly once with messages equal to this exact plain text: ${expected}. Do not call another tool. After the synthetic tool result, briefly acknowledge it.` },
  ];
  const tools = [{ type: 'function', function: { name: 'send_message', description: 'Local synthetic recorder; NO actual message delivery or external side effect.',
    parameters: { type: 'object', properties: { messages: { type: 'string' } }, required: ['messages'], additionalProperties: false } } }];
  const usage = [];
  const rememberUsage = body => {
    const numeric = name => Number.isSafeInteger(body.usage?.[name]) && body.usage[name] >= 0 ? body.usage[name] : null;
    usage.push({ promptTokens: numeric('prompt_tokens'), completionTokens: numeric('completion_tokens'), totalTokens: numeric('total_tokens') });
  };
  try {
    broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening');
    const ask = async body => {
      const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...localAuth.headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(95000), redirect: 'error' });
      if (!response.ok) throw new Error('OPENCODE_COMPLETION_FAILED');
      const result = await response.json(); rememberUsage(result); return result;
    };
    const first = await ask({ model: OPENCODE_MODEL, messages, tools, tool_choice: 'auto', max_tokens: 4096, stream: false });
    const assistant = first.choices?.[0]?.message;
    assert.equal(assistant?.role, 'assistant'); assert.equal(assistant.tool_calls?.length, 1);
    const call = assistant.tool_calls[0]; assert.equal(call.type, 'function'); assert.equal(call.function?.name, 'send_message');
    assert(typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 256);
    const args = JSON.parse(call.function.arguments); assert.deepEqual(args, { messages: expected });
    // Never execute a QQ action. Return only this explicitly synthetic receipt.
    const second = await ask({ model: OPENCODE_MODEL, messages: [...messages, assistant,
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, synthetic: true, messageIds: [123456789] }) }],
      max_tokens: 4096, stream: false });
    assert.equal(second.choices?.[0]?.message?.role, 'assistant');
    assert(!second.choices[0].message.tool_calls?.length);
    assert(typeof second.choices[0].message.content === 'string' && second.choices[0].message.content.trim());
    assert.equal(broker.stats().requests, 2); assert.equal(broker.stats().succeeded, 2);
    const report = { at: new Date().toISOString(), passed: true, provider: 'OpenCode Go', baseUrl: OPENCODE_BASE,
      model: OPENCODE_MODEL, syntheticToolCallValidated: true, toolResultRoundtrip: true, requests: 2, usage,
      broker: broker.stats(), noAutomaticRetry: true, realQQ: false, realSends: 0,
      limitations: ['Real-model API/tool exchange only; this recorder is not a QQ send or a full App/real-QQ acceptance.',
        'Usage is provider-reported; missing fields stay null. No API credential or raw model body is retained.'] };
    assert(!JSON.stringify(report).includes(apiKey)); return report;
  } finally { await broker.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let entered = false;
  try {
    const flags = process.argv.slice(2);
    const fileIndex = flags.indexOf('--key-file');
    if (fileIndex !== -1) {
      const keyFile = flags[fileIndex + 1];
      flags.splice(fileIndex, 2);
      const authorizedFile = process.platform === 'linux' ? '/mnt/c/Users/24239/Desktop/apikey.txt' : 'C:\\Users\\24239\\Desktop\\apikey.txt';
      if (typeof keyFile !== 'string' || path.resolve(keyFile) !== authorizedFile || flags.includes('--prompt-key'))
        throw new Error('OPENCODE_CREDENTIAL_FILE_PATH');
      // Explicit user authorization: opaque credential load only. Never inspect,
      // hash, print, copy or rewrite this external file; no other files accepted.
      try {
        const stat = fs.lstatSync(keyFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
          throw new Error('CREDENTIAL_FILE_METADATA');
        const bytes = fs.readFileSync(keyFile);
        try {
          let text;
          if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
          else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
          else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          process.env.OPENCODE_API_KEY = text.trim(); entered = true;
        } finally { bytes.fill(0); }
      } catch { throw new Error('OPENCODE_CREDENTIAL_FILE_FAILED'); }
    }
    if (new Set(flags).size !== flags.length || flags.some(flag => !['--prompt-key', '--with-full-agent'].includes(flag)))
      throw new Error('MODEL_PROBE_ARGUMENTS');
    if (flags.includes('--with-full-agent') && process.platform !== 'linux') throw new Error('MODEL_PROBE_LINUX_REQUIRED');
    if (!process.env.OPENCODE_API_KEY && flags.includes('--prompt-key')) {
      for (;;) {
        try { process.env.OPENCODE_API_KEY = await readHiddenKey(); entered = true; break; }
        catch (error) {
          if (error.message !== 'KEY_REQUIRED') throw error;
          console.log('No key received yet; paste only the key at the next hidden prompt, then press Enter. Ctrl+C cancels.');
        }
      }
    }
    const report = await probeOpenCodeModel({ apiKey: process.env.OPENCODE_API_KEY });
    const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const output = path.join(root, 'evidence', `opencode-model-probe-${Date.now()}.json`);
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ passed: true, evidence: output, model: OPENCODE_MODEL, requests: report.requests, usage: report.usage, realSends: 0 }));
    if (flags.includes('--with-full-agent')) {
      const preparedRoot = path.join(root, '.tmp/clean-agent-3usdw3');
      const child = spawn(process.execPath, [path.join(root, 'scripts/verify-clean-agent-full-linux.mjs'), '--run-real-model',
        preparedRoot, '66136bb01abd99d7e4881a91cea43826343f00a4f148c0892a9e20eead9110be'], {
        cwd: root, env: process.env, stdio: 'inherit' });
      const [code, signal] = await once(child, 'exit');
      if (code !== 0 || signal) throw new Error('REAL_AGENT_MODEL_CHECK_FAILED');
    }
  } catch (error) {
    const safe = ['OPENCODE_KEY_REQUIRED', 'KEY_TTY_REQUIRED', 'KEY_INPUT_CANCELLED', 'KEY_INPUT_INVALID',
      'KEY_INPUT_INVALID_TOO_LONG', 'KEY_INPUT_INVALID_CONTROL', 'KEY_INPUT_INVALID_TOKEN', 'KEY_INPUT_FAILED',
      'KEY_REQUIRED', 'MODEL_PROBE_ARGUMENTS', 'MODEL_PROBE_LINUX_REQUIRED',
      'OPENCODE_CREDENTIAL_FILE_PATH', 'OPENCODE_CREDENTIAL_FILE_FAILED'];
    console.error(JSON.stringify({ passed: false, code: safe.includes(error.message) ? error.message : 'OPENCODE_MODEL_PROBE_FAILED', realSends: 0 }));
    process.exitCode = 1;
  } finally { if (entered) delete process.env.OPENCODE_API_KEY; }
}
