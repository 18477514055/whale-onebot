import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionLifecycle } from '../src/host/session.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const tmp = fileURLToPath(new URL('../runtime/', import.meta.url));
const loginResult = { uin: BOT_UIN, uid: 'u_synthetic', nick: 'Synthetic only' };
function fixture(t, options = {}) {
  fs.mkdirSync(tmp, { recursive: true });
  const root = fs.mkdtempSync(path.join(tmp, 'host-session-'));
  const global = path.join(root, 'global'), downloads = path.join(root, 'downloads');
  fs.mkdirSync(global); fs.mkdirSync(downloads);
  const calls = [];
  let sessionListener, loginListener;
  const state = { ready: false, proof: { user_id: BOT_UIN, uid: 'u_synthetic', authenticated: true, online: true, nickname: 'Synthetic only', sessionId: 'nt_synthetic' }, initFailure: false };
  const session = {
    init(config, depends, dispatcher, listener) { calls.push(['session.init', config, depends, dispatcher]); sessionListener = listener; },
    getSessionId() { assert.ok(sessionListener, 'getSessionId must not be called before init'); calls.push(['session.id']); return 'nt_synthetic'; },
    getMsgService() { return state.ready ? { synthetic: true } : null; },
  };
  const startup = {
    start() {
      calls.push(['startup.start']);
      if (options.startError) throw new Error('native secret must not escape');
      if (!options.neverReady) setTimeout(() => {
        state.ready = !options.noService;
        if (state.initFailure) sessionListener.onSessionInitComplete(5);
        else if (options.numericReady) sessionListener.onSessionInitComplete(0);
        else sessionListener.onOpentelemetryInit({ is_init: true, is_report: false });
      }, 2);
    },
    stop() { calls.push(['startup.stop']); },
  };
  const engine = { initWithDeskTopConfig(config, adapter) { calls.push(['engine.init', config, adapter]); } };
  const service = {
    initConfig(config) { calls.push(['login.init', config]); },
    addKernelLoginListener(listener) { calls.push(['login.addListener']); loginListener = listener; return 71; },
    removeKernelLoginListener(handle) { calls.push(['login.removeListener', handle]); },
    connect() { throw new Error('Must never initiate login'); },
    getQRCodePicture() { throw new Error('Must never request QR'); },
    quickLoginWithUin() { throw new Error('Must never quick login'); },
    getMsfStatus() { return 3; },
  };
  const wrapper = {
    NodeIQQNTWrapperEngine: { get() { calls.push(['engine.get']); return engine; } },
    NodeIQQNTStartupSessionWrapper: { create() { calls.push(['startup.create']); return startup; } },
    NodeIQQNTWrapperSession: { getNTWrapperSession(key) { calls.push(['session.get', key]); return session; } },
    NodeIKernelLoginService: { get() { calls.push(['login.get']); return service; } },
  };
  const configs = {
    engine: { base_path_prefix: '', platform_type: 3, app_type: 4, app_version: '9.9.33-52230', os_version: 'Synthetic OS', use_xlog: false, qua: 'V1_WIN_NQ_9.9.33-52230_GW_B', global_path_config: { desktopGlobalPath: global }, thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 } },
    login: { machineId: '', appid: '123456789', platVer: 'Synthetic platform', commonPath: global, clientVer: '9.9.33-52230', hostName: 'Synthetic host', externalVersion: false },
    session: { selfUin: BOT_UIN, selfUid: '', desktopPathConfig: { account_path: global }, clientVer: '9.9.33-52230', a2: '', d2: '', d2Key: '', machineId: '', platform: 3, platVer: 'Synthetic platform', appid: '123456789', rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform: 3, language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '', serverUrl: '', fixedAfterHitKeys: [''] }, defaultFileDownloadPath: downloads, deviceInfo: { guid: 'synthetic-guid', buildVer: '9.9.33-52230', localId: 2052, devName: 'Synthetic host', devType: 'Windows', vendorName: '', osVer: 'Synthetic OS', vendorOsName: 'Windows', setMute: false, vendorType: 0 }, deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}' },
  };
  const adapters = {
    registerMiscListener({ wrapper: actual, signal }) {
      assert.equal(actual, wrapper); assert.equal(signal.aborted, false);
      calls.push(['misc.register']);
      return () => calls.push(['misc.remove']);
    },
    global: { exactSyntheticGlobalCallback() {} },
    depends: { exactSyntheticDependsCallback() {} },
    dispatcher: { exactSyntheticDispatcherCallback() {} },
    closeSession(value) { assert.equal(value, session); calls.push(['session.close.adapter']); },
    releaseEngine(value) { assert.equal(value, engine); calls.push(['engine.release.adapter']); },
  };
  const controller = new SessionLifecycle({ wrapper, runtimeRoot: root, engineConfig: configs.engine, loginConfig: configs.login, sessionConfig: configs.session, adapters, readRuntimeProof: async ({ phase, loginService, session: proofSession }) => { if (phase === 'before-init') assert.equal(proofSession, undefined); calls.push(['proof', phase]); return { ...state.proof, loginService }; }, timeoutMs: 80, pollMs: 5 });
  t.after(async () => {
    await controller.close();
    const resolved = fs.realpathSync(root), boundary = fs.realpathSync(tmp) + path.sep;
    assert.ok(resolved.startsWith(boundary));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { controller, calls, state, configs, adapters, service, session, get sessionListener() { return sessionListener; }, get loginListener() { return loginListener; } };
}

test('session constructor is inert; prepare creates session before engine initialization and never starts login', async t => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.controller.prepare(), { state: 'prepared', loginRequired: true });
  assert.deepEqual(f.calls.map(x => x[0]), ['misc.register', 'engine.get', 'startup.create', 'session.get', 'engine.init', 'login.get', 'login.init', 'login.addListener']);
  assert.equal(f.calls.find(x => x[0] === 'session.get')[1], 'nt_1');
  assert.equal(f.calls.find(x => x[0] === 'engine.init')[2], f.adapters.global);
});

test('native runtime root rejects project source, runtime boundary and lexical siblings before any native call', async t => {
  for (const rejected of [new URL('../src/', import.meta.url), new URL('../runtime/', import.meta.url), new URL('../.tmp/', import.meta.url)]) {
    const f = fixture(t);
    f.controller.runtimeRoot = fileURLToPath(rejected);
    await assert.rejects(f.controller.prepare(), { code: 'PATH_REJECTED' });
    assert.deepEqual(f.calls, []);
  }
});

test('native runtime root rejects a directory link even when its target is another prepared runtime', async t => {
  const f = fixture(t), other = fixture(t);
  const alias = path.join(f.controller.runtimeRoot, 'linked-root');
  fs.symlinkSync(other.controller.runtimeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.controller.runtimeRoot = alias;
  await assert.rejects(f.controller.prepare(), { code: 'PATH_REJECTED' });
  assert.deepEqual(f.calls, []);
  // Remove just the link, never recurse through its target during fixture cleanup.
  fs.unlinkSync(alias);
});

test('explicit activation binds independently proved identity, init then start, asynchronous ready and services', async t => {
  const f = fixture(t); await f.controller.prepare();
  const result = await f.controller.activate(loginResult);
  assert.equal(f.controller.state, 'ready');
  assert.equal(result.session, f.session);
  assert.equal((await result.identityProbe()).user_id, Number(BOT_UIN));
  const names = f.calls.map(x => x[0]);
  assert.ok(names.indexOf('session.init') < names.indexOf('startup.start'));
  const init = f.calls.find(x => x[0] === 'session.init');
  assert.equal(init[1].selfUid, 'u_synthetic');
  assert.equal(init[2], f.adapters.depends);
  assert.equal(init[3], f.adapters.dispatcher);
  assert.deepEqual(f.calls.filter(x => x[0] === 'proof').map(x => x[1]), ['before-init', 'ready', 'current']);
});

test('manual login result for another account never initializes session and cleans owned resources', async t => {
  const f = fixture(t); await f.controller.prepare();
  await assert.rejects(f.controller.activate({ uin: OWNER_UIN, uid: 'u_wrong' }), { code: 'IDENTITY_REJECTED' });
  assert.equal(f.calls.some(x => x[0] === 'session.init'), false);
  assert.deepEqual(f.calls.slice(-5).map(x => x[0]), ['login.removeListener', 'startup.stop', 'session.close.adapter', 'engine.release.adapter', 'misc.remove']);
  assert.equal(f.controller.state, 'closed');
});

test('configured account plus MSF connected cannot substitute for an independent authenticated proof', async t => {
  const f = fixture(t); await f.controller.prepare();
  f.state.proof.authenticated = false;
  assert.equal(f.service.getMsfStatus(), 3);
  await assert.rejects(f.controller.activate(loginResult), { code: 'IDENTITY_REJECTED' });
  assert.equal(f.calls.some(x => x[0] === 'session.init'), false);
});

test('ready callback alone without mounted services times out and cleans up', async t => {
  const f = fixture(t, { noService: true }); await f.controller.prepare();
  await assert.rejects(f.controller.activate(loginResult), { code: 'TIMEOUT' });
  assert.equal(f.controller.state, 'closed');
  assert.equal(f.calls.filter(x => x[0] === 'startup.stop').length, 1);
});

test('native start exception is sanitized and cannot be ignored as successful readiness', async t => {
  const f = fixture(t, { startError: true }); await f.controller.prepare();
  await assert.rejects(f.controller.activate(loginResult), e => e.code === 'NATIVE_FAILED' && !e.message.includes('secret'));
  assert.equal(f.controller.state, 'closed');
});

test('explicit session-init failure rejects, while numeric zero completion is supported', async t => {
  const f = fixture(t); await f.controller.prepare(); f.state.initFailure = true;
  await assert.rejects(f.controller.activate(loginResult), { code: 'INIT_REJECTED' });
  const good = fixture(t, { numericReady: true }); await good.controller.prepare();
  assert.equal((await good.controller.activate(loginResult)).proof.online, true);
});

test('online=false after initialization never yields ready even with valid authentication and services', async t => {
  const f = fixture(t); await f.controller.prepare();
  f.controller.readRuntimeProof = async ({ phase, loginService }) => ({ ...f.state.proof, loginService, online: phase === 'before-init' });
  await assert.rejects(f.controller.activate(loginResult), { code: 'IDENTITY_REJECTED' });
  assert.equal(f.controller.state, 'closed');
});

test('disconnect cancels in-flight activation; late native ready callback cannot revive it', async t => {
  const f = fixture(t, { neverReady: true }); await f.controller.prepare();
  const pending = f.controller.activate(loginResult);
  await new Promise(resolve => setTimeout(resolve, 10));
  f.loginListener.onLoginDisConnected('opaque status');
  await assert.rejects(pending, { code: 'CANCELLED' });
  f.state.ready = true; f.sessionListener.onOpentelemetryInit({ is_init: true });
  assert.equal(f.controller.state, 'closed');
  await assert.rejects(f.controller.probe(), { code: 'OFFLINE' });
});

test('aborted activation and late independent proof never initialize or reopen session', async t => {
  const f = fixture(t); await f.controller.prepare();
  let resolve;
  f.controller.readRuntimeProof = () => new Promise(r => { resolve = r; });
  const abort = new AbortController();
  const operation = f.controller.activate(loginResult, { signal: abort.signal });
  await new Promise(r => setImmediate(r)); abort.abort();
  await assert.rejects(operation, { code: 'CANCELLED' });
  resolve(f.state.proof); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.some(x => x[0] === 'session.init'), false);
  assert.equal(f.controller.state, 'closed');
});

test('proof from another native session rejects and current identity loss closes ready lifecycle', async t => {
  const f = fixture(t); await f.controller.prepare();
  f.state.proof.sessionId = 'other-session';
  await assert.rejects(f.controller.activate(loginResult), { code: 'IDENTITY_REJECTED' });
  const ready = fixture(t); await ready.controller.prepare(); await ready.controller.activate(loginResult);
  ready.state.proof.user_id = OWNER_UIN;
  await assert.rejects(ready.controller.probe(), { code: 'IDENTITY_REJECTED' });
  assert.equal(ready.controller.state, 'closed');
});

test('existing-data path and incomplete config are rejected before any wrapper call', async t => {
  const f = fixture(t);
  f.controller.configs.login.commonPath = 'D:\\QQ-Agent\\data';
  await assert.rejects(f.controller.prepare(), { code: 'PATH_REJECTED' });
  assert.equal(f.calls.length, 0);
  const missing = fixture(t); delete missing.controller.configs.session.rdeliveryConfig;
  await assert.rejects(missing.controller.prepare(), { code: 'CONFIG_INCOMPLETE' });
  assert.equal(missing.calls.length, 0);
});

test('cleanup is idempotent and tolerates a reentrant offline subscriber', async t => {
  const f = fixture(t); await f.controller.prepare();
  f.controller.on('offline', () => { void f.controller.close(); });
  await f.controller.close(); await f.controller.close();
  assert.equal(f.calls.filter(x => x[0] === 'startup.stop').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'login.removeListener').length, 1);
  assert.equal(f.calls.filter(x => x[0] === 'misc.remove').length, 1);
  assert.equal(f.controller.cleanupIncomplete, false);
  assert.equal(f.controller.cleanupFailureStage, null);
});

test('misc registration failure or invalid cleanup prevents all engine calls', async t => {
  const failed = fixture(t);
  failed.adapters.registerMiscListener = () => { throw new Error('native secret'); };
  await assert.rejects(failed.controller.prepare(), e => e.code === 'NATIVE_FAILED' && !e.message.includes('secret'));
  assert.equal(failed.calls.length, 0);
  const invalid = fixture(t);
  invalid.adapters.registerMiscListener = () => undefined;
  await assert.rejects(invalid.controller.prepare(), { code: 'CONTRACT_MISSING' });
  assert.equal(invalid.calls.length, 0);
});

test('late misc registration cleans exactly once after timeout without creating an engine', async t => {
  const f = fixture(t);
  let resolve;
  f.adapters.registerMiscListener = () => new Promise(r => { resolve = r; });
  await assert.rejects(f.controller.prepare(), { code: 'TIMEOUT' });
  resolve(() => f.calls.push(['misc.remove']));
  await new Promise(r => setImmediate(r));
  await f.controller.close();
  assert.deepEqual(f.calls.map(x => x[0]), ['misc.remove']);
});

test('misc registration cancellation cleans late resource; teardown failures are bounded', async t => {
  const f = fixture(t);
  let resolve;
  f.adapters.registerMiscListener = () => new Promise(r => { resolve = r; });
  const abort = new AbortController();
  const operation = f.controller.prepare({ signal: abort.signal });
  await new Promise(r => setImmediate(r)); abort.abort();
  await assert.rejects(operation, { code: 'CANCELLED' });
  resolve(() => { f.calls.push(['misc.remove']); throw new Error('private detail'); });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(f.calls.map(x => x[0]), ['misc.remove']);
  assert.equal(f.controller.cleanupErrors, 1);
});

test('pre-init proof must bind the exact login service and never reads session ID early', async t => {
  const f = fixture(t); await f.controller.prepare();
  f.controller.readRuntimeProof = async () => ({ ...f.state.proof, loginService: {} });
  await assert.rejects(f.controller.activate(loginResult), { code: 'IDENTITY_REJECTED' });
  assert.equal(f.calls.some(x => ['session.init', 'session.id'].includes(x[0])), false);
  const good = fixture(t); await good.controller.prepare(); await good.controller.activate(loginResult);
  assert.ok(good.calls.findIndex(x => x[0] === 'session.id') > good.calls.findIndex(x => x[0] === 'startup.start'));
});

test('a ready subscriber closing the lifecycle prevents successful activation return', async t => {
  const f = fixture(t); await f.controller.prepare();
  f.controller.on('ready', () => { void f.controller.close('subscriber_closed'); });
  await assert.rejects(f.controller.activate(loginResult), { code: 'CANCELLED' });
  assert.equal(f.controller.state, 'closed');
  await assert.rejects(f.controller.probe(), { code: 'OFFLINE' });
});

test('timed-out session teardown never releases dependencies even when teardown later settles', async t => {
  const f = fixture(t); await f.controller.prepare();
  let finish;
  f.adapters.closeSession = () => { f.calls.push(['session.close.pending']); return new Promise(resolve => { finish = resolve; }); };
  await f.controller.close();
  assert.equal(f.calls.some(x => ['engine.release.adapter', 'misc.remove'].includes(x[0])), false);
  assert.equal(f.controller.cleanupIncomplete, true);
  assert.equal(f.controller.cleanupFailureStage, 'session');
  assert.equal(f.calls.some(x => ['engine.release.adapter', 'misc.remove'].includes(x[0])), false);
  finish(); await new Promise(resolve => setImmediate(resolve)); await f.controller.close();
  assert.equal(f.calls.some(x => ['engine.release.adapter', 'misc.remove'].includes(x[0])), false);
  assert.equal(f.controller.cleanupIncomplete, true);
});

test('failed listener removal and failed session teardown record distinct incomplete stages', async t => {
  const listener = fixture(t); await listener.controller.prepare();
  listener.service.removeKernelLoginListener = () => { throw new Error('private native error'); };
  await listener.controller.close();
  assert.equal(listener.controller.cleanupIncomplete, true);
  assert.equal(listener.controller.cleanupFailureStage, 'login_listener');
  assert.equal(listener.calls.some(x => x[0] === 'startup.stop'), false);
  const session = fixture(t); await session.controller.prepare();
  session.adapters.closeSession = () => { throw new Error('private native error'); };
  await session.controller.close();
  assert.equal(session.controller.cleanupIncomplete, true);
  assert.equal(session.controller.cleanupFailureStage, 'session');
  assert.equal(session.calls.some(x => ['engine.release.adapter', 'misc.remove'].includes(x[0])), false);
});
