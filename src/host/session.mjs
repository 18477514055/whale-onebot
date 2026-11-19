import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { BOT_UIN } from '../config/account.mjs';

// Original orchestration of externally observed wrapper contracts. Reference:
// NapukettoDev/NapukettoQQ@f20ed97c136e055cbe13c77545b976bfbd14e6d3
// packages/kernel/src/{wrapper/wrapper-loader.ts,login/lifecycle.ts,types/wrapper.ts}
// No dlopen, login initiation, client launch, secret persistence or automatic recovery.
const PROJECT = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const EXPECTED = BOT_UIN;
export class SessionError extends Error {
  constructor(code, message) { super(message); this.name = 'SessionError'; this.code = code; }
}
const fail = (code, message) => { throw new SessionError(code, message); };
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function method(value, name) {
  if (typeof value?.[name] !== 'function') fail('CONTRACT_MISSING', 'Required native or version-bound adapter method is missing');
}
function required(value, names) {
  if (!object(value)) fail('CONFIG_INCOMPLETE', 'Required native configuration object is missing');
  for (const name of names.split(' ')) if (!Object.hasOwn(value, name)) fail('CONFIG_INCOMPLETE', 'Required native configuration field is missing');
}
function complete(value, seen = new Set()) {
  if (value === null || value === undefined) fail('CONFIG_INCOMPLETE', 'Native configuration has unresolved fields');
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail('CONFIG_INVALID', 'Native configuration must contain plain values');
  if (typeof value === 'object') {
    if (seen.has(value)) fail('CONFIG_INVALID', 'Native configuration must be acyclic');
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) fail('CONFIG_INVALID', 'Native configuration must not contain accessors');
      complete(descriptor.value, seen);
    }
    seen.delete(value);
  }
}
function isWithin(root, child) {
  const relative = path.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function physicalDirectory(value, boundary) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !isWithin(boundary, path.resolve(value))) fail('PATH_REJECTED', 'Native paths must stay in the new project runtime');
  const resolved = path.resolve(value);
  let segment = boundary;
  for (const name of path.relative(boundary, resolved).split(path.sep)) {
    segment = path.join(segment, name);
    let stat;
    try { stat = fs.lstatSync(segment); } catch { fail('PATH_REJECTED', 'Native runtime directories must be prepared explicitly'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(segment) !== segment) fail('PATH_REJECTED', 'Native paths must be physical directories without links');
  }
  return resolved;
}

/**
 * Two-stage controller for an isolated, caller-owned wrapper runtime.
 * The caller supplies exact version-bound configs and adapters. Nothing runs in
 * the constructor. prepare() initializes engine/login config only. A separate,
 * external human-controlled login must finish before activate(loginResult).
 *
 * readRuntimeProof(context) is deliberately REQUIRED and NOT implemented here.
 * It must independently observe {user_id,uid,authenticated,online,sessionId}; it
 * must not echo sessionConfig/loginResult, and MSF connection state alone is not
 * an online proof. Real runtime support remains blocked until that reader exists.
 */
export class SessionLifecycle extends EventEmitter {
  constructor({ wrapper, runtimeRoot, engineConfig, loginConfig, sessionConfig, adapters, readRuntimeProof, timeoutMs = 15000, pollMs = 25 } = {}) {
    super();
    if (!object(wrapper) || !object(adapters) || typeof readRuntimeProof !== 'function') fail('DEPENDENCY_REQUIRED', 'Wrapper, exact adapters and independent runtime proof reader are required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) fail('LIMIT_INVALID', 'Invalid lifecycle limits');
    for (const config of [engineConfig, loginConfig, sessionConfig]) { if (!object(config)) fail('CONFIG_INCOMPLETE', 'All native configurations are required'); complete(config); }
    for (const name of ['global', 'depends', 'dispatcher']) if (!object(adapters[name])) fail('DEPENDENCY_REQUIRED', 'Version-bound callback adapters are required');
    for (const name of ['registerMiscListener', 'closeSession', 'releaseEngine']) method(adapters, name);
    this.wrapper = wrapper;
    this.runtimeRoot = runtimeRoot;
    this.configs = structuredClone({ engine: engineConfig, login: loginConfig, session: sessionConfig });
    this.adapters = adapters;
    this.readRuntimeProof = readRuntimeProof;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.state = 'idle';
    this.epoch = 0;
    this.controller = new AbortController();
    this.proofFlight = null;
    this.loginIdentity = null;
    this.cleanupErrors = 0;
    this.cleanupIncomplete = false;
    this.cleanupFailureStage = null;
    this.cleanupPromise = null;
    this.loginListenerHandle = undefined;
  }

  validatePathsAndConfig() {
    // Validate the runtime boundary itself before trusting any descendant.
    // A project-contained source/evidence directory is not a native data root.
    const runtimeBoundary = physicalDirectory(path.join(PROJECT, 'runtime'), PROJECT);
    const root = physicalDirectory(this.runtimeRoot, runtimeBoundary);
    const c = this.configs;
    required(c.engine, 'base_path_prefix platform_type app_type app_version os_version use_xlog qua global_path_config thumb_config');
    required(c.login, 'machineId appid platVer commonPath clientVer hostName externalVersion');
    required(c.session, 'selfUin selfUid desktopPathConfig clientVer a2 d2 d2Key machineId platform platVer appid rdeliveryConfig defaultFileDownloadPath deviceInfo deviceConfig');
    required(c.session.deviceInfo, 'guid buildVer localId devName devType vendorName osVer vendorOsName setMute vendorType');
    required(c.session.rdeliveryConfig, 'appKey systemId appId logicEnvironment platform language sdkVersion userId appVersion osVersion bundleId serverUrl fixedAfterHitKeys');
    const global = physicalDirectory(c.engine.global_path_config?.desktopGlobalPath, root);
    if (c.login.commonPath !== global || c.session.desktopPathConfig?.account_path !== global) fail('PATH_REJECTED', 'Engine, login and session must share the explicit isolated global directory');
    physicalDirectory(c.session.defaultFileDownloadPath, root);
    if (c.engine.base_path_prefix !== '' || c.session.selfUin !== EXPECTED) fail('CONFIG_REJECTED', 'Unexpected native path prefix or account');
    if (![3, 5].includes(c.engine.platform_type) || c.session.platform !== c.engine.platform_type) fail('CONFIG_REJECTED', 'Target platform must be Windows or Linux and consistent');
    if (c.engine.app_type !== 4 || !/^\d+\.\d+\.\d+-\d+$/.test(c.engine.app_version) || c.login.clientVer !== c.engine.app_version || c.session.clientVer !== c.engine.app_version) fail('CONFIG_REJECTED', 'Native version metadata is inconsistent');
    if (typeof c.login.appid !== 'string' || !/^\d+$/.test(c.login.appid) || c.session.appid !== c.login.appid) fail('CONFIG_REJECTED', 'Version-bound appid is required');
    if (typeof c.engine.qua !== 'string' || !c.engine.qua || typeof c.engine.os_version !== 'string' || !c.engine.os_version) fail('CONFIG_REJECTED', 'Actual platform metadata is required');
    if (c.login.externalVersion !== false || typeof c.login.hostName !== 'string' || !c.login.hostName || typeof c.login.platVer !== 'string' || !c.login.platVer || c.session.platVer !== c.login.platVer) fail('CONFIG_REJECTED', 'Actual login platform metadata is required');
    for (const key of ['a2', 'd2', 'd2Key', 'machineId']) if (c.session[key] !== '') fail('CONFIG_REJECTED', 'Imported session tickets are not accepted');
    if (c.login.machineId !== '') fail('CONFIG_REJECTED', 'Device identity overrides are not accepted');
  }
  emitIsolated(name, value) {
    for (const listener of this.rawListeners(name)) { try { listener.call(this, value); } catch {} }
  }
  async bounded(operation, signal) {
    if (signal?.aborted || this.controller.signal.aborted) fail('CANCELLED', 'Session operation was cancelled');
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (signal?.aborted || this.controller.signal.aborted) fail('CANCELLED', 'Session operation was cancelled'); return operation(); }),
        new Promise((_, reject) => {
          abort = () => reject(new SessionError('CANCELLED', 'Session operation was cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          this.controller.signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(new SessionError('TIMEOUT', 'Session lifecycle deadline exceeded')), this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.controller.signal.removeEventListener('abort', abort);
    }
  }
  async prepare({ signal } = {}) {
    if (this.state !== 'idle') fail('INVALID_STATE', 'Lifecycle preparation is one-shot');
    this.validatePathsAndConfig();
    this.state = 'preparing';
    try {
      await this.bounded(async () => {
        for (const [name, methodName] of [['NodeIQQNTWrapperEngine', 'get'], ['NodeIQQNTStartupSessionWrapper', 'create'], ['NodeIQQNTWrapperSession', 'getNTWrapperSession'], ['NodeIKernelLoginService', 'get']]) method(this.wrapper[name], methodName);
        // self-host.ts requires O3 dispatch before engine/bootstrap. Callback and
        // unregister semantics belong to the exact version adapter, not a noop.
        const dispose = await this.adapters.registerMiscListener({ wrapper: this.wrapper, signal: this.controller.signal });
        if (typeof dispose !== 'function') fail('CONTRACT_MISSING', 'Misc listener registration must return its exact cleanup closure');
        let disposed = false;
        const once = () => { if (!disposed) { disposed = true; return dispose(); } };
        if (this.controller.signal.aborted || signal?.aborted) {
          await this.cleanupOne(once, 'misc_listener');
          fail('CANCELLED', 'Misc listener registration arrived after cancellation');
        }
        this.miscCleanup = once;
        this.engine = this.wrapper.NodeIQQNTWrapperEngine.get();
        this.startup = this.wrapper.NodeIQQNTStartupSessionWrapper.create();
        this.session = this.wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1');
        method(this.engine, 'initWithDeskTopConfig'); method(this.startup, 'start'); method(this.startup, 'stop');
        for (const name of ['init', 'getSessionId', 'getMsgService']) method(this.session, name);
        this.engine.initWithDeskTopConfig(structuredClone(this.configs.engine), this.adapters.global);
        this.loginService = this.wrapper.NodeIKernelLoginService.get();
        for (const name of ['initConfig', 'addKernelLoginListener', 'removeKernelLoginListener']) method(this.loginService, name);
        this.loginService.initConfig(structuredClone(this.configs.login));
        const epoch = this.epoch;
        const disconnect = () => { if (epoch === this.epoch) void this.close('runtime_disconnected'); };
        this.loginListenerHandle = this.loginService.addKernelLoginListener({
          onLoginDisConnected: disconnect,
          onLogoutSucceed: disconnect,
          onLoginFailed: disconnect,
          onQRCodeLoginSucceed: (result) => {
            if (epoch !== this.epoch) return;
            if (String(result?.uin) !== EXPECTED || (this.loginIdentity && result?.uid !== this.loginIdentity.uid)) disconnect();
          },
        });
      }, signal);
      if (this.controller.signal.aborted || signal?.aborted) fail('CANCELLED', 'Preparation was cancelled');
      this.state = 'prepared';
      return { state: this.state, loginRequired: true };
    } catch (error) { await this.close('prepare_failed'); throw error instanceof SessionError ? error : new SessionError('NATIVE_FAILED', 'Native preparation failed'); }
  }
  async activate(loginResult, { signal } = {}) {
    if (this.state !== 'prepared') fail('INVALID_STATE', 'Prepare must finish before explicit activation');
    this.state = 'activating';
    try {
      if (!object(loginResult) || String(loginResult.uin) !== EXPECTED || typeof loginResult.uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(loginResult.uid)) fail('IDENTITY_REJECTED', 'Observed manual login identity is not the expected account');
      this.loginIdentity = { uin: EXPECTED, uid: loginResult.uid };
      await this.readProof('before-init', signal);
      const config = structuredClone(this.configs.session);
      config.selfUin = EXPECTED;
      config.selfUid = loginResult.uid;
      const epoch = this.epoch;
      let initialized = false, initFailure = false;
      const sessionListener = {
        onNTSessionCreate: () => {},
        onGProSessionCreate: () => {},
        onGetSelfTinyId: () => {},
        // Unknown online-result shape is intentionally not interpreted as proof.
        onUserOnlineResult: () => {},
        onOpentelemetryInit: info => { if (epoch === this.epoch && info?.is_init === true) initialized = true; },
        onSessionInitComplete: result => {
          if (epoch !== this.epoch) return;
          if (result === 0 || result === '0') initialized = true; else initFailure = true;
        },
      };
      await this.bounded(async () => {
        this.session.init(config, this.adapters.depends, this.adapters.dispatcher, sessionListener);
        if (this.controller.signal.aborted || signal?.aborted) fail('CANCELLED', 'Session initialization was cancelled');
        if (initFailure) fail('INIT_REJECTED', 'Native session initialization failed');
        this.startup.start();
        while (true) {
          if (epoch !== this.epoch || this.controller.signal.aborted || signal?.aborted) fail('CANCELLED', 'Session initialization was cancelled');
          if (initFailure) fail('INIT_REJECTED', 'Native session initialization failed');
          if (initialized && this.session.getMsgService() != null) break;
          await new Promise(resolve => setTimeout(resolve, this.pollMs));
        }
      }, signal);
      const proof = await this.readProof('ready', signal);
      if (epoch !== this.epoch || this.controller.signal.aborted || signal?.aborted) fail('CANCELLED', 'Ready proof arrived after cancellation');
      this.state = 'ready';
      this.emitIsolated('ready', { ...proof });
      if (epoch !== this.epoch || this.controller.signal.aborted || signal?.aborted || this.state !== 'ready') fail('CANCELLED', 'Ready subscriber closed or cancelled the session');
      return { session: this.session, identityProbe: this.probe, proof };
    } catch (error) { await this.close('activation_failed'); throw error instanceof SessionError ? error : new SessionError('NATIVE_FAILED', 'Native session activation failed'); }
  }
  async readProof(phase, signal) {
    const epoch = this.epoch;
    // getSessionId availability before init has not been established. Do not
    // expose a pre-init session accessor as a supposed proof of its validity.
    const context = { phase, loginService: this.loginService, signal: this.controller.signal };
    if (phase !== 'before-init') context.session = this.session;
    const value = await this.bounded(() => this.readRuntimeProof(context), signal);
    if (epoch !== this.epoch || this.controller.signal.aborted || signal?.aborted) fail('CANCELLED', 'Runtime proof arrived after cancellation');
    if (!value || String(value.user_id) !== EXPECTED || value.uid !== this.loginIdentity?.uid || value.authenticated !== true || (phase !== 'before-init' && value.online !== true)) fail('IDENTITY_REJECTED', 'Independent runtime proof did not confirm the expected logged-in account');
    if (phase === 'before-init') {
      if (value.loginService !== this.loginService) fail('IDENTITY_REJECTED', 'Pre-init proof is bound to a different login service');
      return { user_id: Number(EXPECTED), authenticated: true };
    }
    const nativeSessionId = this.session.getSessionId();
    if (typeof nativeSessionId !== 'string' || !nativeSessionId || value.sessionId !== nativeSessionId) fail('IDENTITY_REJECTED', 'Runtime proof is bound to a different native session');
    return { user_id: Number(EXPECTED), nickname: typeof value.nickname === 'string' ? value.nickname : '',
      online: value.online === true, sessionId: nativeSessionId, uid: value.uid };
  }
  probe = () => {
    if (this.state !== 'ready') return Promise.reject(new SessionError('OFFLINE', 'Native session lifecycle is not ready'));
    if (this.proofFlight) return this.proofFlight;
    const flight = this.readProof('current').catch(async error => { await this.close('proof_failed'); throw error; }).finally(() => { if (this.proofFlight === flight) this.proofFlight = null; });
    this.proofFlight = flight;
    return flight;
  };
  async cleanupOne(fn, stage) {
    let timer;
    try {
      await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup timeout')), this.timeoutMs); })]);
      return true;
    }
    catch {
      this.cleanupErrors++;
      this.cleanupIncomplete = true;
      this.cleanupFailureStage ??= stage;
      return false;
    }
    finally { clearTimeout(timer); }
  }
  close(reason = 'closed') {
    if (this.cleanupPromise) return this.cleanupPromise;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closed'; this.epoch++; this.controller.abort();
    this.emitIsolated('offline', { reason });
    const cleanup = [];
    if (this.loginListenerHandle !== undefined) cleanup.push(['login_listener', () => this.loginService.removeKernelLoginListener(this.loginListenerHandle)]);
    if (this.startup) cleanup.push(['startup', () => this.startup.stop()]);
    // close(arg) and destroy() semantics are version-dependent; caller-owned
    // exact teardown callbacks are required rather than guessing their arguments.
    if (this.session) cleanup.push(['session', () => this.adapters.closeSession(this.session)]);
    if (this.engine) cleanup.push(['engine', () => this.adapters.releaseEngine(this.engine)]);
    if (this.miscCleanup) cleanup.push(['misc_listener', this.miscCleanup]);
    this.cleanupPromise = (async () => {
      // A deadline does not stop a native release. Keep its dependencies alive
      // on failure or timeout; do not resume the chain even if it settles later.
      for (const [stage, fn] of cleanup) if (!await this.cleanupOne(fn, stage)) break;
    })();
    return this.cleanupPromise;
  }
}
