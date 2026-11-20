import { FIXED, EVIDENCE, LIMITS } from './constants.mjs';
import { fail, digest, readJson, readPhysical } from './safe-files.mjs';
import { inspectElf } from './elf.mjs';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sonames = value => Array.isArray(value) && value.length > 0 && value.length <= 128 &&
  value.every(n => typeof n === 'string' && /^[A-Za-z0-9_.+-]{1,128}$/.test(n));
const stringsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function loadBaseline(projectRoot) {
  const inputs = EVIDENCE.map(name => readJson(projectRoot, `evidence/${name}`, LIMITS.json));
  const [smoke, dependencies, relocations, host] = inputs.map(item => item.value);
  if (smoke.node !== FIXED.nodeVersion || smoke.nodeArchiveSha256 !== FIXED.nodeArchiveSha256 ||
      smoke.architecture !== 'arm64' || smoke.qqExecuted !== false || smoke.phoneExecution !== false ||
      dependencies.archiveSha256 !== FIXED.qqArchiveSha256 || relocations.wrapperSha256 !== FIXED.wrapperSha256 ||
      relocations.architecture !== 'arm64' ||
      relocations.inputEvidenceSha256?.[EVIDENCE[1]] !== inputs[1].sha256) fail('BASELINE_BINDING_MISMATCH');
  const node = dependencies.modules?.find(m => m.id === 'module-00' && m.kind === 'node');
  const wrapper = dependencies.modules?.find(m => m.id === 'module-01' && m.kind === 'wrapper');
  if (node?.sha256 !== FIXED.nodeElfSha256 || wrapper?.sha256 !== FIXED.wrapperSha256 ||
      node.path !== `/mnt/d/qq-onebot/${FIXED.nodePath}` || wrapper.path !== `/mnt/d/qq-onebot/${FIXED.wrapperPath}` ||
      !sonames(node.needed) || !sonames(wrapper.needed)) fail('BASELINE_ARTIFACT_MISMATCH');
  if (host.architecture !== 'arm64' || host.nodeSha256 !== FIXED.nodeElfSha256 ||
      host.qqExecuted !== false || host.phoneAccessed !== false ||
      !host.artifacts?.some(a => a.file === FIXED.providerPath && a.sha256 === FIXED.providerSha256) ||
      !host.artifacts?.some(a => a.file === FIXED.loaderPath && a.sha256 === FIXED.loaderSha256)) fail('BASELINE_HOST_MISMATCH');
  // Pin the currently known unresolved baseline. A future changed baseline needs
  // human review and a new candidate; this tool never promotes it automatically.
  if (dependencies.coverage?.neededClosureComplete !== false || dependencies.coverage?.allStrongUndefinedMatched !== false ||
      !Array.isArray(dependencies.coverage?.missingNeeded) || dependencies.coverage.missingNeeded.length !== 0 ||
      dependencies.coverage?.allVersionNeedsMatched !== true ||
      !Array.isArray(relocations.targets) || relocations.targets.length !== 12 ||
      relocations.initializerReachability !== 'unknown' || relocations.allOnlyJumpSlots !== true) fail('BASELINE_COVERAGE_CHANGED');
  const result = {
    schema: 1, kind: 'historical-static-baseline-not-phone-execution',
    qqVersion: FIXED.qqVersion, qqArchiveSha256: FIXED.qqArchiveSha256,
    nodeVersion: FIXED.nodeVersion, nodeArchiveSha256: FIXED.nodeArchiveSha256,
    nodeElfSha256: node.sha256, wrapperSha256: wrapper.sha256,
    nodeNeeded: node.needed, wrapperNeeded: wrapper.needed,
    neededClosureComplete: false, allStrongUndefinedMatched: false, missingNeededCount: 0,
    allVersionNeedsMatched: true, unresolvedWirelessPhotoCount: 12,
    initializerReachability: 'unknown', phoneExecution: false, qqExecuted: false,
    sources: EVIDENCE.map((name, i) => ({ name, sha256: inputs[i].sha256 })),
  };
  return validateSnapshot(result);
}

export function validateSnapshot(input) {
  if (!input || input.schema !== 1 || input.kind !== 'historical-static-baseline-not-phone-execution' ||
      input.qqVersion !== FIXED.qqVersion || input.qqArchiveSha256 !== FIXED.qqArchiveSha256 ||
      input.nodeVersion !== FIXED.nodeVersion || input.nodeArchiveSha256 !== FIXED.nodeArchiveSha256 ||
      input.nodeElfSha256 !== FIXED.nodeElfSha256 || input.wrapperSha256 !== FIXED.wrapperSha256 ||
      input.neededClosureComplete !== false || input.allStrongUndefinedMatched !== false ||
      input.missingNeededCount !== 0 || input.allVersionNeedsMatched !== true ||
      input.unresolvedWirelessPhotoCount !== 12 || input.initializerReachability !== 'unknown' ||
      input.phoneExecution !== false || input.qqExecuted !== false || !sonames(input.nodeNeeded) || !sonames(input.wrapperNeeded) ||
      !Array.isArray(input.sources) || input.sources.length !== EVIDENCE.length ||
      input.sources.some((s, i) => s?.name !== EVIDENCE[i] || !hex(s.sha256))) fail('INVALID_SNAPSHOT');
  // Construct explicitly, never spread possibly secret/unknown properties.
  return { schema: 1, kind: input.kind, qqVersion: FIXED.qqVersion, qqArchiveSha256: FIXED.qqArchiveSha256,
    nodeVersion: FIXED.nodeVersion, nodeArchiveSha256: FIXED.nodeArchiveSha256,
    nodeElfSha256: FIXED.nodeElfSha256, wrapperSha256: FIXED.wrapperSha256,
    nodeNeeded: [...input.nodeNeeded], wrapperNeeded: [...input.wrapperNeeded],
    neededClosureComplete: false, allStrongUndefinedMatched: false, missingNeededCount: 0, allVersionNeedsMatched: true,
    unresolvedWirelessPhotoCount: 12, initializerReachability: 'unknown', phoneExecution: false, qqExecuted: false,
    sources: input.sources.map((s, i) => ({ name: EVIDENCE[i], sha256: s.sha256 })) };
}

export function validateFacts(input) {
  const fields = ['schema', 'androidApi', 'androidAbis', 'runtimePlatform', 'runtimeArch', 'nodeVersion', 'libc', 'executionRoute'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k)) || input.schema !== 1 ||
      !(input.androidApi === null || (Number.isInteger(input.androidApi) && input.androidApi >= 21 && input.androidApi <= 100)) ||
      !Array.isArray(input.androidAbis) || input.androidAbis.length > 4 ||
      new Set(input.androidAbis).size !== input.androidAbis.length ||
      input.androidAbis.some(a => !['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].includes(a)) ||
      ![null, 'android', 'linux'].includes(input.runtimePlatform) || ![null, 'arm64', 'arm', 'x64', 'ia32'].includes(input.runtimeArch) ||
      !(input.nodeVersion === null || (typeof input.nodeVersion === 'string' && /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.nodeVersion))) ||
      ![null, 'bionic', 'glibc'].includes(input.libc) ||
      !['unselected', 'android-bionic', 'linux-glibc-in-new-uid'].includes(input.executionRoute)) fail('INVALID_DEVICE_FACTS');
  return Object.fromEntries(fields.map(k => [k, Array.isArray(input[k]) ? [...input[k]] : input[k]]));
}

export function inspectFixedArtifacts(projectRoot, baseline) {
  return [['node', FIXED.nodePath, FIXED.nodeElfSha256, baseline.nodeNeeded],
    ['wrapper', FIXED.wrapperPath, FIXED.wrapperSha256, baseline.wrapperNeeded],
    ['host-provider', FIXED.providerPath, FIXED.providerSha256, null],
    ['host-loader', FIXED.loaderPath, FIXED.loaderSha256, null]].map(([id, relative, expected, needed]) => {
    // No caller-provided path, no globs, no directory scan. Hash before parsing.
    const bytes = readPhysical(projectRoot, relative, LIMITS.binary);
    if (digest(bytes) !== expected) fail('ARTIFACT_HASH_MISMATCH');
    const elf = inspectElf(bytes);
    if (elf.machine !== 'aarch64' || ['bionic', 'conflicting'].includes(elf.libc) ||
        (needed && (elf.libc !== 'glibc' || !stringsEqual(elf.needed, needed)))) fail('ARTIFACT_ABI_MISMATCH');
    return { id, path: relative, sha256: expected, ...elf };
  });
}

export function buildReport({ baseline, facts = null, artifacts = null, snapshot = false }) {
  baseline = validateSnapshot(baseline);
  if (facts !== null) facts = validateFacts(facts);
  const gates = [];
  const gate = (id, status, reason) => gates.push({ id, status, reason });
  gate('fixed-arm64-baseline', 'PASS_STATIC', snapshot ? 'Bundled historical projection only; source evidence not re-read.' : 'Fixed local evidence bindings checked; not target execution.');
  gate('android-abi', facts?.androidAbis.length ? (facts.androidAbis.includes('arm64-v8a') ? 'NOT_PROVEN' : 'BLOCKED') : 'NOT_PROVEN',
    'Requires actual arm64-v8a device evidence in a new test instance; supplied facts are unverified declarations.');
  const major = facts?.nodeVersion ? Number(facts.nodeVersion.slice(1).split('.')[0]) : null;
  gate('node24-runtime', major !== null && major !== 24 ? 'BLOCKED' : 'NOT_PROVEN',
    'Node24 executable, child/worker/timer/network/exit behavior must run in the new UID; PC Node version is not phone evidence.');
  gate('native-architecture', facts?.runtimeArch && facts.runtimeArch !== 'arm64' ? 'BLOCKED' : 'NOT_PROVEN',
    'The fixed QQ candidate is AArch64, not x64/arm32; same CPU does not establish libc or private ABI compatibility.');
  const bionic = facts?.libc === 'bionic' || facts?.executionRoute === 'android-bionic' || facts?.runtimePlatform === 'android';
  gate('libc-route', bionic ? 'BLOCKED' : 'NOT_PROVEN', bionic
    ? 'Fixed Linux glibc QQ/Node cannot load directly in Bionic. Bionic may test original JS with synthetic bridge only.'
    : 'New-UID glibc compatibility layer, loader and search paths are not validated on Android. Copying ELF files is not a runtime.');
  gate('fixed-native-files', artifacts ? 'PASS_STATIC' : 'NOT_PROVEN',
    artifacts ? 'Pinned node/wrapper/original host-provider/host-loader bytes, ELF machine and DT_NEEDED re-read without execution.' : 'No target binary read; use --inspect-fixed-artifacts on original PC project only.');
  gate('project-native-addons', 'NOT_PROVEN', 'Original host provider/loader synthetic QEMU success is not real QQ/Android ABI proof. Sharp 0.35.5 media decoder needs its matching target addon/libvips; PC x64 node_modules cannot be copied as phone dependencies.');
  gate('qq-dependency-closure', 'BLOCKED', 'Historical static missing DT_NEEDED count is zero, but RPATH inheritance/complete dependency closure is not proven.');
  gate('qq-provider-symbols', 'BLOCKED', '12 unresolved wireless-photo targets; legitimate same-version providers, symbol scope and initializer reachability remain unresolved. No stubs or binding-policy workaround.');
  gate('new-uid-filesystem-boundary', 'NOT_PROVEN', 'Verify separate package/UID and two new synthetic canaries. A directory or PRoot rootfs is not UID isolation.');
  gate('network-and-lifecycle', 'NOT_PROVEN', 'Separate UID is not loopback/network isolation; require reviewed network policy, authenticated synthetic endpoints and verified cleanup/background behavior.');
  gate('official-acquisition', 'NOT_PROVEN', 'Historical Tencent source and local SHA256 only; previous official body fetches FAILED. No fresh fetch, signature proof or redistribution permission asserted.');
  gate('phone-qq-load-and-operation', 'NOT_PROVEN', 'No phone execution/login/session import performed. D13 normal Linux business scope does not authorize modifying existing phone production.');
  return { schema: 1, kind: 'offline-phone-adaptation-preflight', status: 'BLOCKED', deploymentAllowed: false,
    deviceConnected: false, targetExecuted: false, credentialRead: false, productionTouched: false,
    suppliedFactsTrust: facts ? 'unverified-non-sensitive-declarations' : 'none', suppliedFacts: facts,
    baseline, artifacts,
    nativePaths: { packageWrapperMember: FIXED.packageWrapperMember, inspectedWrapper: FIXED.wrapperPath,
      originalHostProvider: FIXED.providerPath, originalHostLoader: FIXED.loaderPath,
      phonePathsVerified: false, projectMediaAddon: 'sharp@0.35.5: target-specific addon/libvips not acquired or loaded' },
    gates,
    notProven: gates.filter(g => g.status === 'NOT_PROVEN').map(g => g.id),
    next: ['Choose a new package/UID and matching bootstrap/prefix before any device test.',
      'First prove Node24 + original synthetic bridge inside that new UID; no QQ or existing production resources.',
      'Resolve fixed ARM64 QQ providers/initializers and glibc route before separately authorized QQ loading.'],
    prohibition: ['No device transport, installation, global dependencies or runtime launch.',
      'No account/session/config/data import, production stop or automatic login recovery.',
      'No claim of lower Tencent kick rate from this preflight.'] };
}
