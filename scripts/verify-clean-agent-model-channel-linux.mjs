import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createModelBroker } from '../src/host/full-agent-model-broker.mjs';
import { serveModelChannel } from './lib/clean-agent-model-channel.mjs';
import { validNamespaces } from './lib/run-clean-agent-isolation.mjs';

assert(process.platform === 'linux' && process.arch === 'x64' && process.argv.length === 2);
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const work = fs.mkdtempSync(path.join(root, '.tmp/model-channel-probe-'));
fs.mkdirSync(path.join(work, 'input'), { mode: 0o700 });
const files = ['experiments/clean-agent-model-channel-probe.mjs', 'scripts/lib/clean-agent-model-channel.mjs'];
const inventory = [];
for (const file of files) {
  const source = path.join(root, file), stat = fs.lstatSync(source); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const bytes = fs.readFileSync(source), target = path.join(work, 'input', file);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  inventory.push({ path: file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const key = randomBytes(24).toString('hex');
let upstreamCalls = 0, dispatchCalls = 0, server, channel;
const upstream = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; assert(size < 65536); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, 'fd-probe-model'); upstreamCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: `ack:${body.messages[0].content}` }, finish_reason: 'stop' }],
      usage: { completion_tokens: 10 } }));
  } catch { res.writeHead(400).end('{}'); }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const broker = createModelBroker({ baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: key, model: 'fd-probe-model',
  maxRequests: 2, allowLoopbackUpstream: true });
broker.server.listen(0, '127.0.0.1'); await once(broker.server, 'listening');
const parentNamespaces = Object.fromEntries(['net', 'pid', 'mnt', 'user'].map(name => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]));
try {
  const bwrap = path.join(root, '.tools/bubblewrap/extracted/usr/bin/bwrap');
  const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled', '--new-session', '--die-with-parent',
    '--cap-drop', 'ALL', '--clearenv', '--ro-bind', '/usr/lib/x86_64-linux-gnu', '/lib/x86_64-linux-gnu',
    '--symlink', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', '/lib64/ld-linux-x86-64.so.2',
    '--ro-bind', process.execPath, '/bin/node', '--ro-bind', path.join(work, 'input'), '/project',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--setenv', 'HOME', '/tmp', '--chdir', '/tmp', '--remount-ro', '/',
    '/bin/node', '/project/experiments/clean-agent-model-channel-probe.mjs'];
  const child = spawn('/usr/bin/timeout', ['-k', '3', '20', bwrap, ...args], { cwd: work,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', WHALE_SYNTHETIC_PARENT_KEY: key }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 262144) child.kill('SIGTERM'); });
  channel = Duplex.from({ readable: child.stdout, writable: child.stdin }); channel.on('error', () => {});
  server = serveModelChannel(channel, { maxRequests: 2, timeoutMs: 5000, dispatch: async (body, { signal }) => {
    dispatchCalls++;
    const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal });
    return { status: response.status, body: await response.json() };
  } });
  const [code, signal] = await once(child, 'exit');
  assert(!stderr.includes(key));
  const resultLines = stderr.split('\n').filter(line => line.startsWith('CLEAN_AGENT_CHANNEL_RESULT='));
  assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(resultLines.length, 1);
  const observed = JSON.parse(resultLines[0].slice('CLEAN_AGENT_CHANNEL_RESULT='.length));
  assert.equal(observed.passed, true); assert.equal(observed.completed, 2); assert(validNamespaces(observed.namespaces, parentNamespaces));
  assert.equal(dispatchCalls, 2); assert.equal(upstreamCalls, 2); assert.equal(broker.stats().requests, 2);
  const report = { at: new Date().toISOString(), passed: true, sourceInventory: inventory,
    transport: 'inherited standard-input/output anonymous pipes; no file socket and no shared network',
    observed, parentNamespaces, dispatchCalls, upstreamCalls, broker: broker.stats(), parentChannel: server.stats(),
    stderrWithoutResult: stderr.split('\n').filter(line => !line.startsWith('CLEAN_AGENT_CHANNEL_RESULT=')).join('\n'),
    realModel: false, realQQ: false, rawCredentialPersisted: false,
    limitations: ['Synthetic upstream only; does not authorize real model spend or real QQ actions.', 'Not yet a full App run with this external channel.'] };
  const output = path.join(root, 'evidence/clean-agent-model-channel-linux-20261115.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ passed: true, output, observed }));
} finally {
  await server?.close(); channel?.destroy(); await broker.close();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
