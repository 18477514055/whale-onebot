import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Real CLI processes; every input and response is synthetic and lives under .tmp.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = path.join(project, '.tmp');
const activeChildren = new Set();
const activeDirectories = new Set();
const profile = 'login-0123456789abcdef0123';
const binding = 'synthetic-admin-cli-binding';
const secret = 'synthetic-response-top-level-secret-never-print';
const readonly = 'verify_read_only_onebot';
const adminFlag = '--allow-admin-challenge';
const supportedCommands = ['arm_inbound_challenge', 'read_inbound_challenge', readonly,
  'verify_onebot_inbound_readback', 'verify_onebot_roundtrip', 'register_online', 'read_self_status'];
const challengeText = 'whale-check-' + 'e'.repeat(32);
const matched = (admin = true, extra = {}) => ({ state: 'matched', readbackOnly: true,
  ...(admin !== undefined && { allowAdminChallenge: admin }), attempt: 1, ageMs: 10, consumed: false, ...extra });

async function fixture(t, initialControl = {}) {
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryDirectory, 'admin-challenge-cli-'));
  activeDirectories.add(root);
  const output = path.join(root, 'runtime', 'integrated', profile);
  const controlDir = path.join(root, 'runtime', 'integrated-control', profile);
  const script = path.join(root, 'scripts', 'calibration-command.mjs');
  const clients = [];
  t.after(async () => {
    for (const client of clients) {
      if (!client.closed) client.child.kill();
      await client.exited;
      assert.equal(client.closed, true, 'child close and stdio cleanup must be observed');
      assert(client.child.exitCode !== null || client.child.signalCode !== null);
      activeChildren.delete(client.child);
    }
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(temporaryDirectory));
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
    fs.rmSync(resolved, { recursive: true, force: true });
    assert.equal(fs.existsSync(resolved), false, 'the fixture directory must be removed');
    activeDirectories.delete(root);
  });
  const dependency = path.join(root, 'src', 'host', 'online-observation.mjs');
  for (const directory of [output, controlDir, path.dirname(script), path.dirname(dependency)])
    fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(project, 'scripts', 'calibration-command.mjs'), script);
  fs.copyFileSync(path.join(project, 'src', 'host', 'online-observation.mjs'), dependency);
  let control = { runId: profile, lastSeq: 0, generation: 1, authenticationObserved: true,
    authBinding: binding, deliveryIdentitySupported: true, busy: false, supportedCommands, ...initialControl };
  const writeAtomic = async (name, value) => {
    const destination = path.join(output, name);
    fs.writeFileSync(destination + '.next', JSON.stringify(value));
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(destination + '.next', destination); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt === 19) throw error;
        await delay(10);
      }
    }
  };
  const publish = async (lastSeq, extra = {}) => {
    control = { ...control, lastSeq, ...extra };
    await writeAtomic('status.json', { control });
  };
  await publish(0);
  const readCommand = () => {
    try { return JSON.parse(fs.readFileSync(path.join(controlDir, 'command.json'), 'utf8')); }
    catch (error) { if (['ENOENT', 'ENODATA'].includes(error.code)) return null; throw error; }
  };
  const start = (args) => {
    const child = spawn(process.execPath, [script, output, ...args], {
      cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    const client = { child, stdout: '', stderr: '', closed: false, seen: [], timedOut: false };
    child.stdout.on('data', chunk => { client.stdout += chunk; });
    child.stderr.on('data', chunk => { client.stderr += chunk; });
    const watchdog = setTimeout(() => { client.timedOut = true; child.kill(); }, 7000);
    client.exited = once(child, 'close').then(result => {
      client.closed = true;
      clearTimeout(watchdog);
      return result;
    });
    clients.push(client);
    return client;
  };
  const expectCommand = async (client, seq, command) => {
    const deadline = performance.now() + 5000;
    let request;
    while ((request = readCommand())?.seq !== seq) {
      assert.equal(client.closed, false, client.stderr || client.stdout || `Client exited before ${command}`);
      assert(!request || request.seq < seq, 'an unexpected delivery skipped the expected sequence');
      assert(performance.now() < deadline, `Missing command ${command} at seq ${seq}`);
      await delay(10);
    }
    assert.equal(request.command, command);
    assert.equal(request.runId, profile);
    assert.equal(request.generation, 1);
    assert.equal(request.authBinding, binding);
    assert.match(request.deliveryId, /^[a-f0-9]{32}$/);
    assert(!client.seen.some(previous => previous.deliveryId === request.deliveryId));
    assert.equal(['verify_onebot_roundtrip', 'register_online'].includes(command), false);
    client.seen.push(request);
    return request;
  };
  const respond = async (request, data, extra = {}, publishControl = true) => {
    await writeAtomic('control-result.json', { accepted: true, status: 'completed', runId: profile,
      seq: request.seq, command: request.command, deliveryId: request.deliveryId,
      secret, authBinding: secret, token: secret, password: secret, data, ...extra });
    if (publishControl) await publish(request.seq);
  };
  const finish = async (client, expectedExit, { error } = {}) => {
    assert.deepEqual(await client.exited, [expectedExit, null], client.stderr || client.stdout);
    assert.equal(client.timedOut, false, 'the real child must exit without watchdog termination');
    assert.equal(client.stdout.includes(secret), false, 'top-level response secrets must not be printed');
    assert.equal(client.stderr.includes(secret), false);
    assert.equal(client.stdout.includes(binding), false);
    assert.equal(client.stderr.includes(binding), false);
    for (const request of client.seen) assert.equal(client.stdout.includes(request.deliveryId), false);
    assert.equal(fs.existsSync(path.join(controlDir, 'delivery.lock')), false);
    assert.equal(fs.existsSync(path.join(controlDir, 'command.next')), false);
    const last = readCommand();
    assert.deepEqual(last, client.seen.at(-1) ?? null, 'no additional unobserved control command may be published');
    assert(client.seen.every(request => !['verify_onebot_roundtrip', 'register_online'].includes(request.command)));
    if (error) {
      assert.match(client.stderr, error);
      assert.equal(client.stdout, '');
      return;
    }
    assert.equal(client.stderr, '');
    return client.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  };
  return { start, publish, writeAtomic, readCommand, expectCommand, respond, finish };
}

for (const mode of ['arm', 'await']) for (const admin of [true, false]) {
  test(`read-only ${mode}: ${admin ? 'explicit admin' : 'default non-admin'} challenge verifies without any send command`, async t => {
    const f = await fixture(t);
    const args = [readonly, ...(mode === 'arm' ? ['--arm-group', '20001'] : ['--await-challenge']),
      ...(admin ? [adminFlag] : [])];
    const client = f.start(args);
    let seq = 1;
    if (mode === 'arm') {
      const arm = await f.expectCommand(client, seq++, 'arm_inbound_challenge');
      assert.deepEqual(arm.params, { groupId: '20001', readbackOnly: true,
        ...(admin && { allowAdminChallenge: true }) });
      await f.respond(arm, { text: challengeText, expiresInMs: 180000, attempt: 1 });
    }
    const read = await f.expectCommand(client, seq++, 'read_inbound_challenge');
    assert.deepEqual(read.params, {});
    const observation = matched(admin);
    if (!admin) delete observation.allowAdminChallenge; // Legacy/default readonly reply omits this field.
    await f.respond(read, observation);
    const verify = await f.expectCommand(client, seq, readonly);
    assert.deepEqual(verify.params, {});
    await f.respond(verify, { readOnlyVerified: true, nativeSubmissionAttempted: false });
    const lines = await f.finish(client, 0);
    assert.equal(lines.length, mode === 'arm' ? 2 : 1);
    if (mode === 'arm') {
      assert.equal(lines[0].phase, 'challenge-ready');
      assert.equal(lines[0].text, challengeText);
      assert.equal(lines[0].attempt, 1);
      assert(lines[0].expiresInMs > 0 && lines[0].expiresInMs <= 180000);
    }
    assert.deepEqual(lines.at(-1), { accepted: true, status: 'completed', command: readonly, seq,
      data: { readOnlyVerified: true, nativeSubmissionAttempted: false } });
    assert.deepEqual(client.seen.map(request => request.command),
      [...(mode === 'arm' ? ['arm_inbound_challenge'] : []), 'read_inbound_challenge', readonly]);
  });
}

for (const state of ['matched', 'waiting']) {
  for (const returned of [undefined, false, 'true', 1]) {
    test(`explicit admin rejects ${state} challenge with admin value ${String(returned)}`, async t => {
      const f = await fixture(t);
      const client = f.start([readonly, '--await-challenge', adminFlag]);
      const read = await f.expectCommand(client, 1, 'read_inbound_challenge');
      const observation = matched(true, { state });
      if (returned === undefined) delete observation.allowAdminChallenge;
      else observation.allowAdminChallenge = returned;
      await f.respond(read, observation);
      const [outcome] = await f.finish(client, 3);
      assert.equal(outcome.result, 'challenge-admin-mode-mismatch');
      assert.equal(outcome.retry, false);
      assert.equal(client.seen.length, 1, 'mismatched admin mode must not deliver verify');
    });
  }
  test(`default readonly rejects ${state} admin challenge instead of silently opting in`, async t => {
    const f = await fixture(t);
    const client = f.start([readonly, '--await-challenge']);
    const read = await f.expectCommand(client, 1, 'read_inbound_challenge');
    await f.respond(read, matched(true, { state }));
    const [outcome] = await f.finish(client, 3);
    assert.equal(outcome.result, 'challenge-admin-mode-mismatch');
    assert.equal(outcome.retry, false);
    assert.equal(client.seen.length, 1);
  });
}

const invalidOptions = [
  ['readonly without challenge mode', [readonly, adminFlag]],
  ['inbound-readback arm', ['verify_onebot_inbound_readback', '--arm-group', '20001', adminFlag]],
  ['inbound-readback await', ['verify_onebot_inbound_readback', '--await-challenge', adminFlag]],
  ['roundtrip arm', ['verify_onebot_roundtrip', '--arm-group', '20001', adminFlag]],
  ['roundtrip await', ['verify_onebot_roundtrip', '--await-challenge', adminFlag]],
  ['ordinary command', ['read_self_status', adminFlag]],
  ['direct arm', ['arm_inbound_challenge', '20001', adminFlag]],
  ['direct read', ['read_inbound_challenge', adminFlag]],
  ['duplicate admin arm', [readonly, '--arm-group', '20001', adminFlag, adminFlag]],
  ['duplicate admin await', [readonly, '--await-challenge', adminFlag, adminFlag]],
  ['unknown flag', [readonly, '--await-challenge', adminFlag, '--unknown-flag']],
  ['misspelled flag', [readonly, '--await-challenge', '--allow-admin-challenges']],
  ['assigned flag value', [readonly, '--await-challenge', '--allow-admin-challenge=true']],
  ['separate flag value', [readonly, '--await-challenge', adminFlag, 'true']],
  ['repeated await', [readonly, '--await-challenge', '--await-challenge', adminFlag]],
  ['misplaced admin flag', [readonly, adminFlag, '--await-challenge']],
  ['missing arm group', [readonly, '--arm-group', adminFlag]],
  ['invalid arm group', [readonly, '--arm-group', 'invalid-group', adminFlag]],
];
for (const [name, args] of invalidOptions) test(`invalid options reject before delivery: ${name}`, async t => {
  const f = await fixture(t);
  const client = f.start(args);
  await f.finish(client, 1, { error: /Usage:|Invalid test group/ });
  assert.equal(client.seen.length, 0);
});

for (const [name, extra, expected] of [
  ['age at cutoff', { ageMs: 28000 }, 'matched-challenge-too-old'],
  ['age over cutoff', { ageMs: 28001 }, 'matched-challenge-too-old'],
  ['negative age', { ageMs: -1 }, 'matched-challenge-too-old'],
  ['fractional age', { ageMs: 0.5 }, 'matched-challenge-too-old'],
  ['missing age', { ageMs: undefined }, 'matched-challenge-too-old'],
  ['null age', { ageMs: null }, 'matched-challenge-too-old'],
  ['string age', { ageMs: '10' }, 'matched-challenge-too-old'],
  ['unsafe integer age', { ageMs: Number.MAX_SAFE_INTEGER + 1 }, 'matched-challenge-too-old'],
  ['consumed challenge', { consumed: true }, 'matched-challenge-already-consumed'],
  ['wrong readonly mode', { readbackOnly: false }, 'challenge-mode-mismatch'],
]) test(`admin readonly rejects ${name} without verify`, async t => {
  const f = await fixture(t);
  const client = f.start([readonly, '--await-challenge', adminFlag]);
  const read = await f.expectCommand(client, 1, 'read_inbound_challenge');
  await f.respond(read, matched(true, extra));
  const [outcome] = await f.finish(client, 3);
  assert.equal(outcome.result, expected);
  assert.equal(outcome.retry, false);
  assert.equal(client.seen.length, 1);
});

for (const ageMs of [0, 27999]) test(`admin readonly accepts fresh age boundary ${ageMs}`, async t => {
  const f = await fixture(t);
  const client = f.start([readonly, '--await-challenge', adminFlag]);
  await f.respond(await f.expectCommand(client, 1, 'read_inbound_challenge'), matched(true, { ageMs }));
  await f.respond(await f.expectCommand(client, 2, readonly), { readOnlyVerified: true });
  const [outcome] = await f.finish(client, 0);
  assert.equal(outcome.command, readonly);
});

test('arm locks its attempt and rejects a replaced admin challenge', async t => {
  const f = await fixture(t);
  const client = f.start([readonly, '--arm-group', '20001', adminFlag]);
  const arm = await f.expectCommand(client, 1, 'arm_inbound_challenge');
  await f.respond(arm, { text: challengeText, expiresInMs: 180000, attempt: 1 });
  await f.respond(await f.expectCommand(client, 2, 'read_inbound_challenge'), matched(true, { attempt: 2 }));
  const lines = await f.finish(client, 3);
  assert.equal(lines.at(-1).result, 'challenge-changed');
  assert.equal(client.seen.length, 2);
});

for (const [stage, change] of [
  ['after arm', { generation: 2 }],
  ['before verify', { generation: 2 }],
  ['binding before verify', { authBinding: 'synthetic-replaced-binding' }],
]) test(`session change rejects ${stage} without a dependent delivery`, async t => {
  const f = await fixture(t);
  const armMode = stage === 'after arm';
  const client = f.start([readonly, ...(armMode ? ['--arm-group', '20001'] : ['--await-challenge']), adminFlag]);
  const request = await f.expectCommand(client, 1, armMode ? 'arm_inbound_challenge' : 'read_inbound_challenge');
  await f.respond(request, armMode ? { text: challengeText, expiresInMs: 180000, attempt: 1 } : matched(), {}, false);
  await f.publish(1, change);
  const lines = await f.finish(client, 2);
  assert.equal(lines.at(-1).code, 'SESSION_CHANGED');
  assert.equal(lines.at(-1).status, 'rejected');
  assert.equal(client.seen.length, 1);
});

for (const missing of [readonly, 'arm_inbound_challenge', 'read_inbound_challenge']) {
  test(`missing host capability ${missing} rejects before delivery`, async t => {
    const f = await fixture(t, { supportedCommands: supportedCommands.filter(command => command !== missing) });
    const client = f.start([readonly, ...(missing === 'arm_inbound_challenge' ? ['--arm-group', '20001'] : ['--await-challenge']), adminFlag]);
    await f.finish(client, 1, { error: /Command is unavailable in this running host/ });
  });
}

test('verify capability removed after challenge read rejects without verify', async t => {
  const f = await fixture(t);
  const client = f.start([readonly, '--await-challenge', adminFlag]);
  const read = await f.expectCommand(client, 1, 'read_inbound_challenge');
  await f.respond(read, matched(), {}, false);
  await f.publish(1, { supportedCommands: supportedCommands.filter(command => command !== readonly) });
  await f.finish(client, 1, { error: /Command is unavailable in this running host/ });
  assert.equal(client.seen.length, 1);
});

for (const [name, control] of [
  ['authentication unobserved', { authenticationObserved: false }],
  ['binding missing', { authBinding: undefined }],
]) for (const mode of ['arm', 'await']) test(`${name} rejects admin ${mode} before delivery`, async t => {
  const f = await fixture(t, control);
  const client = f.start([readonly, ...(mode === 'arm' ? ['--arm-group', '20001'] : ['--await-challenge']), adminFlag]);
  await f.finish(client, 1, { error: /AssertionError/ });
});

for (const rejectionStage of ['arm', 'read', 'verify']) test(`host authentication refusal at ${rejectionStage} is terminal without resend`, async t => {
  const f = await fixture(t);
  const client = f.start([readonly, ...(rejectionStage === 'arm' ? ['--arm-group', '20001'] : ['--await-challenge']), adminFlag]);
  let request = await f.expectCommand(client, 1, rejectionStage === 'arm' ? 'arm_inbound_challenge' : 'read_inbound_challenge');
  if (rejectionStage === 'verify') {
    await f.respond(request, matched());
    request = await f.expectCommand(client, 2, readonly);
  }
  await f.respond(request, undefined, { accepted: false, status: 'rejected', code: 'AUTHENTICATION_REQUIRED' });
  const [outcome] = await f.finish(client, 2);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(client.seen.length, rejectionStage === 'verify' ? 2 : 1);
});

test('real client ignores stale identity responses and waits for status lastSeq before dependent verify', async t => {
  const f = await fixture(t);
  const client = f.start([readonly, '--await-challenge', adminFlag]);
  const read = await f.expectCommand(client, 1, 'read_inbound_challenge');
  for (const identity of [{ seq: 0 }, { deliveryId: 'f'.repeat(32) }, { runId: 'synthetic-other-run' }, { command: readonly }]) {
    await f.respond(read, matched(), { ...identity, accepted: false, status: 'rejected', code: 'STALE_SYNTHETIC_RESPONSE' }, false);
    await delay(90);
    assert.equal(client.closed, false);
    assert.equal(client.stdout, '');
    assert.deepEqual(f.readCommand(), read);
  }
  await f.respond(read, matched(), {}, false);
  await delay(120);
  assert.equal(client.stdout, '');
  assert.deepEqual(f.readCommand(), read, 'a result alone must not advance the command sequence');
  await f.publish(1);
  const verify = await f.expectCommand(client, 2, readonly);
  await f.respond(verify, { readOnlyVerified: true }, {}, false);
  await delay(100);
  assert.equal(client.closed, false);
  assert.equal(client.stdout, '');
  await f.publish(2);
  const [outcome] = await f.finish(client, 0);
  assert.equal(outcome.data.readOnlyVerified, true);
});

after(() => {
  assert.equal(activeChildren.size, 0, 'every spawned child was closed and reclaimed');
  assert.equal(activeDirectories.size, 0, 'every isolated .tmp project was removed');
});
