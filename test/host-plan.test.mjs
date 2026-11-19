import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHostPlan } from '../src/host/plan.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const windows = () => ({ projectRoot: 'D:\\qq-onebot', platform: 'win32',
  wrapperPath: 'D:\\synthetic-artifacts\\wrapper.node', wrapperSha256: 'a'.repeat(64), version: '9.9.33-52230' });
const linux = () => ({ projectRoot: '/opt/qq-onebot', platform: 'linux',
  wrapperPath: '/opt/synthetic-artifacts/wrapper.node', wrapperSha256: 'b'.repeat(64), version: '3.2.35-54395' });

test('Windows plan unifies native paths in new runtime without inspecting a real account', () => {
  const p = createHostPlan(windows());
  assert.equal(p.configTemplates.engine.global_path_config.desktopGlobalPath, p.paths.global);
  assert.equal(p.configTemplates.login.commonPath, p.paths.global);
  assert.equal(p.configTemplates.session.desktopPathConfig.account_path, p.paths.global);
  for (const [name, target] of Object.entries(p.paths)) {
    const relative = path.win32.relative(p.paths.runtime, target);
    assert.ok(name === 'runtime' || (relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative)));
  }
  assert.equal(p.isolation.discoverExistingQqData, false);
  assert.equal(p.isolation.physicalPathsVerified, false);
  assert.equal(p.isolation.nativeWritesVerified, false);
  assert.equal(p.artifact.digestVerified, false);
});

test('Linux plans use target path semantics even when tests run on Windows', () => {
  const p = createHostPlan(linux());
  assert.equal(p.paths.global, `/opt/qq-onebot/runtime/${BOT_UIN}/nt_qq/global`);
  assert.equal(p.configTemplates.engine.platform_type, 5);
  assert.equal(p.configTemplates.session.platform, 5);
  assert.equal(p.configTemplates.engine.use_xlog, true);
  assert.ok(Object.values(p.paths).every(value => !value.includes('\\')));
});

test('plan is deeply immutable and carries no executable login or native permissions', () => {
  const p = createHostPlan(windows());
  for (const value of Object.values(p.permission)) assert.equal(value, false);
  assert.equal(p.executable, false);
  assert.equal(p.nativeHost.implemented, false);
  assert.ok(p.orderedSteps.every(step => step.executable === false));
  assert.throws(() => { p.configTemplates.login.commonPath = 'C:\\existing'; }, TypeError);
  assert.throws(() => { p.orderedSteps[0].argumentsShape.push('execute'); }, TypeError);
  assert.throws(() => { p.permission.connect = true; }, TypeError);
});

test('metadata and device/login identity stay unresolved rather than fabricated', () => {
  const p = createHostPlan(windows());
  assert.equal(p.configTemplates.engine.qua, null);
  assert.equal(p.configTemplates.login.appid, null);
  assert.equal(p.configTemplates.login.hostName, null);
  assert.equal(p.configTemplates.session.deviceInfo, null);
  assert.equal(p.configTemplates.session.selfUid, null);
  const supplied = createHostPlan({ ...windows(), appid: '123456', qua: 'V1_WIN_NQ_9.9.33-52230_GW_B' });
  assert.equal(supplied.configTemplates.login.appid, '123456');
  assert.equal(supplied.configTemplates.engine.qua, 'V1_WIN_NQ_9.9.33-52230_GW_B');
  assert.throws(() => createHostPlan({ ...windows(), qua: 'V1_LNX_NQ_3.2.35_54395_GW_B' }));
});

test('declared ordering puts session creation before engine init and identity before session activation', () => {
  const steps = createHostPlan(windows()).orderedSteps.map(step => step.id);
  const before = (a, b) => assert.ok(steps.indexOf(a) < steps.indexOf(b));
  before('create_startup_session', 'initialize_engine');
  before('obtain_session', 'initialize_engine');
  before('manual_login_boundary', 'verify_login_identity');
  before('verify_login_identity', 'initialize_session');
  before('initialize_session', 'start_session');
  before('start_session', 'verify_session_ready');
});

test('rejects wrong identity, unsupported platform and path aliases that could escape isolation', () => {
  for (const change of [
    { account: OWNER_UIN }, { account: Number(BOT_UIN) }, { platform: 'darwin' },
    { projectRoot: 'D:' }, { projectRoot: 'D:\\' }, { projectRoot: 'D:\\qq-onebot\\..\\QQ-Agent' },
    { projectRoot: 'D:\\QQ-Agent\\sandbox' }, { projectRoot: '\\\\server\\share\\test' },
    { projectRoot: 'D:\\qq-onebot:alternate' }, { projectRoot: 'D:\\qq-onebot.\\child' },
    { projectRoot: 'D:\\NUL\\child' }, { wrapperPath: 'D:\\qq-onebot\\runtime\\wrapper.node' },
    { wrapperPath: 'D:\\synthetic-artifacts\\wrapper.node:alternate' }, { wrapperSha256: 'not-a-digest' },
    { version: 'latest' }, { runtime: 'D:\\existing' }, { machineGuid: 'override' }, { token: 'never-print-this' },
  ]) assert.throws(() => createHostPlan({ ...windows(), ...change }), TypeError);
  for (const projectRoot of ['/', '/opt/../existing', '//host/share', '/opt/a\\b']) {
    assert.throws(() => createHostPlan({ ...linux(), projectRoot }), TypeError);
  }
});

test('rejects accessors without evaluating them and does not echo supplied secrets in errors', () => {
  let touched = false;
  const options = windows();
  Object.defineProperty(options, 'appid', { get() { touched = true; throw new Error('secret'); } });
  assert.throws(() => createHostPlan(options), { message: 'Invalid host plan options' });
  assert.equal(touched, false);
  assert.throws(() => createHostPlan({ ...windows(), appid: 'synthetic-secret' }), error => {
    assert.equal(error.message.includes('synthetic-secret'), false); return true;
  });
});
