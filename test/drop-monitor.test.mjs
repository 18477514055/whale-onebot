import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBSERVATIONS, parseProcStat, exactParentCommand, identityContinuity, classifySample,
  serializeSample, shouldEmit } from '../scripts/monitoring/drop-monitor-core.mjs';
import { LIVE_PROFILE, ACTIVE_WORK, parseOptions, getHealth, createLogger, runMonitor } from '../scripts/monitoring/drop-monitor-io.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canary = 'SYNTHETIC_AUTH_UID_SECRET_CANARY_DO_NOT_LOG';
const proc = { exists: true, running: true, commandMatches: true, starttime: '123' };
const ready = () => ({ phase: 'session-ready-observed', sessionGeneration: 1, identityMatches: true,
  businessOnlineVerified: false, control: { authBinding: canary }, uid: canary, sessionId: canary,
  liveAgent: { stage: 'ready-original-rules', consolePort: 34779, writeOutcomeUnknown: true,
    receiveDiagnostics: { receiveCallbacks: 7, publishedEvents: 5, unknownActions: 1, [canary]: 9 } },
  observations: { onMSFStatusChange: { count: 8, shape: { uid: canary } }, [canary]: { count: 99 } } });
const sample = extra => classifySample({ status: ready(), process: proc, identityContinuous: true,
  health: { reachable: true, ok: true, onebotConnected: true, secret: canary }, now: 100000, ...extra });
const fakeStat = (start = '123', state = 'S') => `215 (synthetic (parent)) ${state} ${Array(18).fill('0').join(' ')} ${start} 0 0`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(project, '.tmp', 'drop-monitor-fixture-'));
  t.after(async () => { assert(path.dirname(root) === path.join(project, '.tmp')); await fs.rm(root, { recursive: true, force: true }); });
  const status = path.join(root, 'runtime/integrated', LIVE_PROFILE, 'status.json');
  const lock = path.join(root, 'runtime/integrated-login.lock');
  await fs.mkdir(path.dirname(status), { recursive: true });
  await fs.mkdir(path.join(root, ACTIVE_WORK), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: 215, profileId: LIVE_PROFILE }));
  await fs.writeFile(status, JSON.stringify(ready()));
  const procRoot = path.join(root, 'proc'), processDir = path.join(procRoot, '215');
  await fs.mkdir(processDir, { recursive: true });
  await fs.writeFile(path.join(processDir, 'stat'), fakeStat());
  await fs.writeFile(path.join(processDir, 'cmdline'), [path.join(root, '.tools/node-v24.20.0-linux-x64/bin/node'),
    'scripts/integrated-preflight-linux.mjs', '--login', '--original-agent', '--split-onebot-ports', ''].join('\0'));
  await fs.symlink(root, path.join(processDir, 'cwd'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, procRoot, status, lock, processDir };
}

 test('PID stat parsing handles parentheses and zombies; command matching accepts exact relative script only', () => {
  assert.deepEqual(parseProcStat(fakeStat()), { starttime: '123', running: true });
  assert.equal(parseProcStat(fakeStat('124', 'Z')).running, false);
  assert.equal(parseProcStat('bad'), null);
  const root = path.resolve(project);
  const args = [path.join(root, '.tools/node-v24.20.0-linux-x64/bin/node'), 'scripts/integrated-preflight-linux.mjs', '--login', '--original-agent', '--split-onebot-ports'];
  assert.equal(exactParentCommand(args, root, root, path.resolve), true);
  args[1] = path.join(root, args[1]);
  assert.equal(exactParentCommand(args, root, root, path.resolve), true);
  assert.equal(exactParentCommand([...args, '--extra'], root, root, path.resolve), false);
  assert.equal(exactParentCommand(args, root + '-other', root, path.resolve), false);
  assert.equal(identityContinuity(proc, { ...proc, starttime: '124' }, true), false);
  assert.equal(identityContinuity(proc, proc, false), false);
});

test('ready/App/transport/native activity never manufactures platform online or Tencent-kick proof', () => {
  const value = sample();
  assert.equal(value.Appready, true);
  assert.equal(value.onebotConnected, true);
  assert.equal(value.native.receiveCallbacks, 7);
  assert.equal(value.writeOutcomeUnknown, true);
  assert.equal(value.platformOnline, 'unknown');
  assert.equal(value.tencentKick, 'unknown');
  assert.equal(JSON.stringify(value).includes(canary), false);
  assert.equal(Object.keys(value.observations).length, OBSERVATIONS.length);
});

test('stale ready snapshot, cached online false, dead/reused PID, and missing health cannot prove online', () => {
  for (const extra of [
    { process: { exists: false }, identityContinuous: false },
    { process: { ...proc, starttime: 'reused' }, identityContinuous: false },
    { health: { reachable: false, onebotConnected: true, ok: true } },
    { health: { reachable: true, ok: null } },
  ]) {
    const value = sample(extra);
    assert.equal(value.Appready, false);
    assert.equal(value.platformOnline, 'unknown');
    assert.equal(value.tencentKick, 'unknown');
  }
  const value = sample({ status: { ...ready(), businessOnlineVerified: false, online: false, good: false } });
  assert.equal(value.platformOnline, 'unknown');
  assert.equal(sample({ identityContinuous: false }).identitybool, null);
});

test('generic disconnect, process exit, parent result and WS false retain unknown kick attribution', () => {
  assert.equal(sample({ status: { ...ready(), phase: 'login-disconnected' } }).terminalCode, 'LOGIN_DISCONNECTED_REASON_UNKNOWN');
  assert.equal(sample({ process: { exists: false }, identityContinuous: false }).terminalCode, 'PARENT_EXIT_REASON_UNKNOWN');
  const value = sample({ parentResult: { observed: { phase: 'login-disconnected', status: 2, reason: canary }, secret: canary } });
  assert.equal(value.terminalCode, 'PARENT_RESULT_REASON_UNKNOWN');
  assert.equal(value.tencentKick, 'unknown');
  assert.equal(sample({ health: { reachable: true, ok: true, onebotConnected: false } }).onebotConnected, false);
});

test('native/observations progress is distinct; writes occur only for state transition or 60s heartbeat', () => {
  const previous = sample(); const status = ready(); status.liveAgent.receiveDiagnostics.receiveCallbacks++;
  const next = sample({ status, previous });
  assert.equal(next.nativeProgress, 'advanced');
  assert.equal(shouldEmit(previous, next, 0, 59000), false);
  assert.equal(shouldEmit(previous, next, 0, 60000), true);
  assert.equal(shouldEmit(previous, { ...next, onebotConnected: false }, 0, 1), true);
  assert.equal(shouldEmit(previous, { ...next, writeOutcomeUnknown: false }, 0, 1), true);
  status.liveAgent.receiveDiagnostics.receiveCallbacks = 0;
  assert.equal(sample({ status, previous }).nativeProgress, 'reset');
});

test('CLI accepts only 2–5s intervals and fresh direct monitoring run paths', () => {
  assert.equal(parseOptions(['--once', '--interval-ms', '2000', '--output', 'runtime/monitoring/test-run'], project).once, true);
  for (const args of [['--interval-ms', '1999'], ['--interval-ms', '5001'], ['--output', '../leak'],
    ['--output', 'runtime/integrated/old'], ['--output', 'runtime/monitoring/nested/run'], ['--url', 'http://remote']]) {
    assert.throws(() => parseOptions(args, project));
  }
});

test('health reader uses only GET exact loopback /healthz, no redirect; projects boolean fields only', async () => {
  const result = await getHealth(34779, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:34779/healthz');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    return new Response(JSON.stringify({ ok: true, onebotConnected: false, uid: canary, secret: canary }));
  });
  assert.deepEqual(result, { reachable: true, ok: true, onebotConnected: false });
  assert.equal((await getHealth(1, () => assert.fail('must not fetch'))).reachable, false);
  assert.equal((await getHealth(34779, async () => new Response('x'.repeat(16385)))).onebotConnected, null);
});

test('logger discards arbitrary synthetic auth/UID/secret canaries even at safe-field string positions', async t => {
  const { root } = await fixture(t);
  const logger = await createLogger(root, path.join(root, 'runtime/monitoring/synthetic'));
  await logger.write({ ...sample(), secret: canary, control: { authBinding: canary }, phase: canary,
    terminalCode: canary, native: { ...sample().native, uid: canary }, at: canary });
  await logger.write(sample());
  await logger.close();
  const events = await fs.readFile(path.join(logger.directory, 'events.jsonl'), 'utf8');
  const latest = await fs.readFile(path.join(logger.directory, 'latest.json'), 'utf8');
  assert(!events.includes(canary)); assert(!latest.includes(canary));
  assert.equal(events.trim().split('\n').length, 2);
  assert.deepEqual(JSON.parse(latest), JSON.parse(serializeSample(sample())));
  await assert.rejects(createLogger(root, logger.directory));
});

test('synthetic once binds PID/starttime/exact relative argv, and only new monitoring files change', async t => {
  const f = await fixture(t);
  const before = await Promise.all([fs.readFile(f.status), fs.readFile(f.lock), fs.readFile(path.join(f.processDir, 'cmdline'))]);
  const value = await runMonitor({ ...f, once: true,
    request: async () => new Response(JSON.stringify({ ok: true, onebotConnected: true, authBinding: canary })) });
  assert.equal(value.process.identityContinuous, true);
  assert.equal(value.Appready, true);
  assert.equal(value.platformOnline, 'unknown');
  assert(!JSON.stringify(value).includes(canary));
  const after = await Promise.all([fs.readFile(f.status), fs.readFile(f.lock), fs.readFile(path.join(f.processDir, 'cmdline'))]);
  assert.deepEqual(after, before);
});

test('PID replacement during health response invalidates current readiness rather than trusting old ready', async t => {
  const f = await fixture(t);
  const value = await runMonitor({ ...f, once: true, request: async () => {
    await fs.writeFile(path.join(f.processDir, 'stat'), fakeStat('999'));
    return new Response(JSON.stringify({ ok: true, onebotConnected: true }));
  } });
  assert.equal(value.process.exists, true);
  assert.equal(value.process.identityContinuous, false);
  assert.equal(value.Appready, false); assert.equal(value.onebotConnected, null);
  assert.equal(value.terminalCode, 'PROCESS_IDENTITY_LOST');
});

test('identity loss latches; only bounded final-result collection follows, with no App repoll or rebind', async t => {
  const f = await fixture(t); let requests = 0; const emitted = [];
  const value = await runMonitor({ ...f, intervalMs: 0, request: async () => {
    requests++; await fs.writeFile(path.join(f.processDir, 'stat'), fakeStat('999'));
    return new Response(JSON.stringify({ ok: true, onebotConnected: true }));
  }, onSample: async entry => {
    emitted.push(entry);
    if (emitted.length === 1) await fs.writeFile(path.join(f.processDir, 'stat'), fakeStat('123'));
  } });
  assert.equal(requests, 1);
  assert.equal(value.process.identityContinuous, false);
  assert.equal(value.terminalCode, 'PROCESS_IDENTITY_LOST');
  assert.equal(emitted.length, 2); // Initial loss plus final bounded sample, not every poll.
});

test('dead initial PID does not poll App, and activework parent-result is safely projected', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.processDir, 'stat'));
  await fs.writeFile(path.join(f.root, ACTIVE_WORK, 'parent-result.json'), JSON.stringify({
    observed: { phase: 'login-disconnected', status: 2, secret: canary }, uid: canary }));
  const value = await runMonitor({ ...f, once: true, request: () => assert.fail('dead PID must not fetch') });
  assert.equal(value.process.exists, false); assert.equal(value.Appready, false);
  assert.equal(value.platformOnline, 'unknown'); assert.equal(value.tencentKick, 'unknown');
  assert.equal(value.parentResult.present, true); assert.equal(value.parentResult.exitCode, 2);
  assert.equal(value.terminalCode, 'BINDING_REJECTED');
  assert(!JSON.stringify(value).includes(canary));
});
