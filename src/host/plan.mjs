import path from 'node:path';
import { BOT_UIN } from '../config/account.mjs';

// Review-only contract. This module imports no filesystem, native, process or
// network API and never invokes a supplied object. It is not a native launcher.
const ACCOUNT = BOT_UIN;
const REFERENCE = 'NapukettoDev/NapukettoQQ@f20ed97c136e055cbe13c77545b976bfbd14e6d3';
const ALLOWED = new Set(['projectRoot', 'platform', 'account', 'wrapperPath', 'wrapperSha256', 'version', 'appid', 'qua']);

function fail(field) { throw new TypeError(`Invalid host plan ${field}`); }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function absolute(value, api, platform, field) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) fail(field);
  if (!api.isAbsolute(value)) fail(field);
  if (platform === 'win32') {
    // Reject drive-relative, UNC/device paths, ADS, reserved device names and
    // trailing-dot aliases. A plan does not need network/device namespace paths.
    if (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':')) fail(field);
    const parts = value.slice(3).split(/[\\/]/);
    if (parts.some(s => /[<>"|?*]/.test(s) || /[ .]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) fail(field);
  } else if (value.includes('\\') || value.startsWith('//')) fail(field);
  if (value.split(/[\\/]/).some(s => s === '.' || s === '..')) fail(field);
  return api.normalize(value);
}
function inside(api, root, value) {
  const rel = api.relative(root, value);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

/**
 * Create immutable, non-executable metadata for a future QQ native host.
 * sha256 is a supplied expectation, NOT a verified file digest. All paths are
 * lexical: physical symlink/reparse-point checks remain a mandatory future gate.
 * Missing build metadata is left unresolved instead of inventing QQ constants,
 * account uid, machine GUID, device identity, login tickets or a live session.
 */
export function createHostPlan(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options');
  // Reject accessors without evaluating them; this API takes inert JSON-like input.
  const fields = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string' || !ALLOWED.has(key) || !Object.hasOwn(fields[key], 'value')) fail('options');
  }
  const input = Object.fromEntries(Object.entries(fields).map(([k, descriptor]) => [k, descriptor.value]));
  const { platform, account = ACCOUNT, wrapperSha256, version, appid, qua } = input;
  if (platform !== 'win32' && platform !== 'linux') fail('platform');
  if (account !== ACCOUNT) fail('account');
  const api = platform === 'win32' ? path.win32 : path.posix;
  const projectRoot = absolute(input.projectRoot, api, platform, 'projectRoot');
  if (projectRoot === api.parse(projectRoot).root) fail('projectRoot');
  if (projectRoot.split(/[\\/]/).some(s => /^(qq-agent|tencent files|qqnt_\d+)$/i.test(s))) fail('projectRoot');
  const wrapperPath = absolute(input.wrapperPath, api, platform, 'wrapperPath');
  if (api.basename(wrapperPath).toLowerCase() !== 'wrapper.node') fail('wrapperPath');
  if (typeof wrapperSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(wrapperSha256)) fail('wrapperSha256');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+-\d+$/.test(version)) fail('version');
  if (appid !== undefined && (typeof appid !== 'string' || !/^[1-9]\d{0,15}$/.test(appid))) fail('appid');
  const prefix = platform === 'win32' ? 'WIN' : 'LNX';
  if (qua !== undefined && (typeof qua !== 'string' || !new RegExp(`^V1_${prefix}_NQ_${version.replace(/\./g, '\\.').replace('-', '[-_]')}_GW_B$`).test(qua))) fail('qua');

  const runtime = api.join(projectRoot, 'runtime');
  const accountRoot = api.join(runtime, account);
  const global = api.join(accountRoot, 'nt_qq', 'global');
  const paths = {
    runtime, accountRoot, global, cwd: accountRoot,
    downloads: api.join(accountRoot, 'downloads'), logs: api.join(accountRoot, 'logs'),
    home: api.join(accountRoot, 'home'), temp: api.join(accountRoot, 'temp'),
  };
  for (const [name, value] of Object.entries(paths)) {
    if (name !== 'runtime' && !inside(api, runtime, value)) fail('path containment');
  }
  if (wrapperPath === runtime || inside(api, runtime, wrapperPath)) fail('wrapperPath');
  const platformType = platform === 'win32' ? 3 : 5;
  const requiredObservations = {
    'engine.os_version': 'actual target OS version; never synthesized to impersonate a device',
    'login.platVer': 'actual target platform and kernel version',
    'login.hostName': 'actual target host name',
    'session.selfUid': 'verified login result for expected account',
    'session.deviceInfo': 'actual target device information and native machine GUID; no overrides',
    'session.platVer': 'same actual platform value as login',
  };
  if (appid === undefined) requiredObservations['login.appid'] = 'version-bound major.node metadata';
  if (qua === undefined) requiredObservations['engine.qua'] = 'version-bound major.node metadata';
  const configTemplates = {
    // null denotes unresolved input. These templates MUST NOT be passed to native.
    engine: {
      base_path_prefix: '', platform_type: platformType, app_type: 4,
      app_version: version, os_version: null, use_xlog: platform === 'linux', qua: qua ?? null,
      global_path_config: { desktopGlobalPath: global },
      thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
    },
    login: { machineId: '', appid: appid ?? null, platVer: null, commonPath: global,
      clientVer: version, hostName: null, externalVersion: false },
    session: {
      selfUin: account, selfUid: null, desktopPathConfig: { account_path: global },
      clientVer: version, a2: '', d2: '', d2Key: '', machineId: '', platform: platformType,
      platVer: null, appid: appid ?? null, defaultFileDownloadPath: paths.downloads,
      deviceInfo: null, deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
      rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform: platformType,
        language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '',
        serverUrl: '', fixedAfterHitKeys: [''] },
    },
  };
  const steps = [
    ['verify_artifact_and_paths', 'Verify actual digest, platform ABI, all physical paths and native write boundaries'],
    ['provide_reviewed_host_symbols', 'Supply original reviewed ABI host; unresolved native symbols remain blocking'],
    ['load_wrapper', 'process.dlopen', ['carrier', 'wrapperPath']],
    ['register_misc_listener', 'NodeIO3MiscService.get().addO3MiscListener', ['getOnAmgomDataPiece listener']],
    ['obtain_engine', 'NodeIQQNTWrapperEngine.get', []],
    ['create_startup_session', 'NodeIQQNTStartupSessionWrapper.create', []],
    ['obtain_session', 'NodeIQQNTWrapperSession.getNTWrapperSession', ['nt_1']],
    ['initialize_engine', 'engine.initWithDeskTopConfig', ['engine config', 'globalAdapter']],
    ['obtain_login_service', 'NodeIKernelLoginService.get', []],
    ['initialize_login_service', 'loginService.initConfig', ['login config']],
    ['manual_login_boundary', 'STOP: separate explicit human-controlled login; no connect/QR/quicklogin in this module'],
    ['verify_login_identity', 'Require independently observed uin, uid and online state for expected account'],
    ['initialize_session', 'session.init', ['session config', 'dependsAdapter', 'dispatcherAdapter', 'sessionListener']],
    ['start_session', 'startupSession.start', []],
    ['verify_session_ready', 'Require init success callback and getMsgService availability; method presence alone is insufficient'],
  ].map(([id, contract, argumentsShape = []]) => ({ id, contract, argumentsShape, executable: false }));
  return freeze({
    kind: 'offline-qq-host-plan', schemaVersion: 1, executable: false, status: 'review-only',
    reference: REFERENCE, projectRoot, platform, account,
    artifact: { wrapperPath, expectedSha256: wrapperSha256.toLowerCase(), digestVerified: false, version },
    paths, configTemplates, requiredObservations, orderedSteps: steps,
    permission: { nativeLoad: false, nativeInvocation: false, connect: false, requestQr: false,
      quickLogin: false, automaticLogin: false, restartClient: false, sendMessage: false, filesystemWrite: false },
    isolation: { kind: 'lexical-only', physicalPathsVerified: false, nativeWritesVerified: false,
      discoverExistingQqData: false, credentials: 'not accepted',
      requiredBeforeExecution: ['reject symlinks/reparse points and physical escapes',
        'audit native crash/cache/config writes outside explicit paths',
        'use isolated target profile without reusing any existing account data'] },
    nativeHost: { implemented: false, platformSupportVerified: false,
      publicObservation: platform === 'win32'
        ? 'QQNT.dll host imports: napi/uv plus version-dependent C++ and qq_magic symbols; exact ABI unresolved'
        : 'ELF Node host symbols plus private-stub symbols and libgnutls dependency; exact ABI unresolved',
      integrityBypass: false, antiDetection: false, identitySpoofing: false },
  });
}
