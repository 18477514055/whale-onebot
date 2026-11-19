import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED, EVIDENCE, BUNDLE_FILES } from '../scripts/phone-adaptation/constants.mjs';
import { digest, readPhysical, physicalPath, publicError } from '../scripts/phone-adaptation/safe-files.mjs';
import { inspectElf } from '../scripts/phone-adaptation/elf.mjs';
import { loadBaseline, buildReport, validateFacts, validateSnapshot, inspectFixedArtifacts } from '../scripts/phone-adaptation/core.mjs';
import { main } from '../scripts/phone-adaptation/preflight.mjs';
import { prepare } from '../scripts/phone-adaptation/prepare.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { fs.mkdirSync(path.join(project, '.tmp')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const tmpRoot = physicalPath(project, '.tmp', { directory: true });
const tools = path.join(project, 'scripts', 'phone-adaptation');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'phone-adaptation-test-'));
  t.after(() => {
    // Verify the exact resolved synthetic target before deletion. Nothing outside
    // this freshly allocated project .tmp child can be removed by this fixture.
    assert.equal(path.dirname(path.resolve(root)), tmpRoot);
    assert.match(path.basename(root), /^phone-adaptation-test-/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
function save(root, relative, data) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
function baselineFixture(root) {
  const smoke = { node: FIXED.nodeVersion, nodeArchiveSha256: FIXED.nodeArchiveSha256,
    architecture: 'arm64', qqExecuted: false, phoneExecution: false };
  const deps = { archiveSha256: FIXED.qqArchiveSha256,
    coverage: { neededClosureComplete: false, allStrongUndefinedMatched: false, missingNeeded: [], allVersionNeedsMatched: true },
    modules: [
      { id: 'module-00', kind: 'node', path: `/mnt/d/qq-onebot/${FIXED.nodePath}`, sha256: FIXED.nodeElfSha256, needed: ['libc.so.6'] },
      { id: 'module-01', kind: 'wrapper', path: `/mnt/d/qq-onebot/${FIXED.wrapperPath}`, sha256: FIXED.wrapperSha256, needed: ['libc.so.6'] },
    ] };
  save(root, `evidence/${EVIDENCE[0]}`, smoke);
  save(root, `evidence/${EVIDENCE[1]}`, deps);
  const depsHash = digest(readPhysical(root, `evidence/${EVIDENCE[1]}`, 100000));
  save(root, `evidence/${EVIDENCE[2]}`, { architecture: 'arm64', wrapperSha256: FIXED.wrapperSha256,
    inputEvidenceSha256: { [EVIDENCE[1]]: depsHash }, targets: Array.from({ length: 12 }, () => ({})),
    initializerReachability: 'unknown', allOnlyJumpSlots: true });
  save(root, `evidence/${EVIDENCE[3]}`, { architecture: 'arm64', nodeSha256: FIXED.nodeElfSha256,
    qqExecuted: false, phoneAccessed: false, artifacts: [
      { file: FIXED.providerPath, sha256: FIXED.providerSha256 }, { file: FIXED.loaderPath, sha256: FIXED.loaderSha256 },
    ] });
  return loadBaseline(root);
}
function facts(overrides = {}) {
  return { schema: 1, androidApi: null, androidAbis: [], runtimePlatform: null,
    runtimeArch: null, nodeVersion: null, libc: null, executionRoute: 'unselected', ...overrides };
}
function elf({ machine = 183, libc = 'libc.so.6', interpreter = '/lib/ld-linux-aarch64.so.1' } = {}) {
  const b = Buffer.alloc(1024);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(b);
  b.writeUInt16LE(3, 16); b.writeUInt16LE(machine, 18); b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(64n, 32); b.writeUInt16LE(64, 52); b.writeUInt16LE(56, 54); b.writeUInt16LE(3, 56);
  function segment(i, type, offset, va, size) {
    const p = 64 + i * 56; b.writeUInt32LE(type, p); b.writeBigUInt64LE(BigInt(offset), p + 8);
    b.writeBigUInt64LE(BigInt(va), p + 16); b.writeBigUInt64LE(BigInt(size), p + 32); b.writeBigUInt64LE(BigInt(size), p + 40);
  }
  segment(0, 1, 0, 0x10000, 1024);
  segment(1, 3, 256, 0, Buffer.byteLength(interpreter) + 1);
  segment(2, 2, 320, 0, 64);
  b.write(interpreter, 256);
  const strings = Buffer.from(`\0${libc}\0`); strings.copy(b, 480);
  [[1, 1], [5, 0x10000 + 480], [10, strings.length], [0, 0]].forEach(([tag, value], i) => {
    b.writeBigUInt64LE(BigInt(tag), 320 + i * 16); b.writeBigUInt64LE(BigInt(value), 328 + i * 16);
  });
  return b;
}

test('synthetic ELF64 identifies AArch64/glibc without executing target', () => {
  const result = inspectElf(elf());
  assert.equal(result.machine, 'aarch64'); assert.equal(result.libc, 'glibc');
  assert.deepEqual(result.needed, ['libc.so.6']); assert.equal(result.symbolResolutionProven, false);
});
test('synthetic Bionic and x64 are not confused with Linux ARM64', () => {
  assert.equal(inspectElf(elf({ libc: 'libc.so', interpreter: '/system/bin/linker64' })).libc, 'bionic');
  assert.equal(inspectElf(elf({ machine: 62 })).machine, 'x86_64');
  assert.equal(inspectElf(elf({ libc: 'libc.so', interpreter: '/lib/ld-linux-aarch64.so.1' })).libc, 'conflicting');
});
test('ELF rejects truncated file, endian/class mismatch and overflowing offset', () => {
  assert.throws(() => inspectElf(Buffer.alloc(12)), /MALFORMED_ELF/);
  const endian = elf(); endian[5] = 2; assert.throws(() => inspectElf(endian), /UNSUPPORTED_ELF/);
  const overflow = elf(); overflow.writeBigUInt64LE(0xffffffffffffffffn, 32);
  assert.throws(() => inspectElf(overflow), /MALFORMED_ELF/);
});
test('ELF rejects unterminated dynamic table, unsafe name and unmapped string table', () => {
  const unterminated = elf(); unterminated.writeBigUInt64LE(1n, 368);
  assert.throws(() => inspectElf(unterminated), /MALFORMED_ELF/);
  assert.throws(() => inspectElf(elf({ libc: '../synthetic-secret' })), /UNSAFE_ELF_STRING/);
  const unmapped = elf(); unmapped.writeBigUInt64LE(0x999999n, 344);
  assert.throws(() => inspectElf(unmapped), /MALFORMED_ELF/);
});
test('bounded readers reject traversal, oversized input, directories and hardlinks', t => {
  const root = fixture(t); save(root, 'a.txt', 'synthetic');
  assert.throws(() => readPhysical(root, '../a.txt', 100), /UNSAFE_PATH/);
  assert.throws(() => readPhysical(root, 'a.txt', 2), /INPUT_TOO_LARGE/);
  fs.mkdirSync(path.join(root, 'dir'));
  assert.throws(() => readPhysical(root, 'dir', 100), /NOT_REGULAR/);
  fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'hard.txt'));
  assert.throws(() => readPhysical(root, 'hard.txt', 100), /HARDLINK_REJECTED/);
});
test('ancestor junction/symlink is rejected before reading synthetic canary', t => {
  const root = fixture(t); save(root, 'physical/canary.txt', 'synthetic-only');
  const link = path.join(root, 'linked');
  fs.symlinkSync(path.join(root, 'physical'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readPhysical(root, 'linked/canary.txt', 100), /LINK_REJECTED/);
});
test('fixed baseline binds evidence digests and projects no arbitrary strings', t => {
  const root = fixture(t), baseline = baselineFixture(root);
  assert.equal(baseline.unresolvedWirelessPhotoCount, 12);
  const projected = validateSnapshot({ ...baseline, token: 'SYNTHETIC_SECRET_DO_NOT_ECHO' });
  assert.equal(JSON.stringify(projected).includes('SYNTHETIC_SECRET'), false);
  save(root, `evidence/${EVIDENCE[1]}`, '{}');
  assert.throws(() => loadBaseline(root), /BASELINE_BINDING_MISMATCH/);
});
test('zero missing DT_NEEDED never promotes dependency closure/providers', t => {
  const report = buildReport({ baseline: baselineFixture(fixture(t)) });
  assert.equal(report.status, 'BLOCKED'); assert.equal(report.deploymentAllowed, false);
  for (const id of ['qq-dependency-closure', 'qq-provider-symbols']) assert.equal(report.gates.find(g => g.id === id).status, 'BLOCKED');
  assert.equal(report.deviceConnected, false); assert.equal(report.targetExecuted, false);
  assert.throws(() => validateSnapshot({ ...report.baseline, neededClosureComplete: true }), /INVALID_SNAPSHOT/);
});
test('Bionic direct QQ route blocks even with ARM64 and Node24 declarations', t => {
  const report = buildReport({ baseline: baselineFixture(fixture(t)), facts: facts({ androidAbis: ['arm64-v8a'],
    runtimePlatform: 'android', runtimeArch: 'arm64', nodeVersion: 'v24.20.0', libc: 'bionic', executionRoute: 'android-bionic' }) });
  assert.equal(report.gates.find(g => g.id === 'libc-route').status, 'BLOCKED');
  assert.equal(report.gates.find(g => g.id === 'node24-runtime').status, 'NOT_PROVEN');
  assert.equal(report.gates.find(g => g.id === 'android-abi').status, 'NOT_PROVEN');
});
test('wrong ABI/Node blocks; matching glibc declaration cannot prove isolation', t => {
  const baseline = baselineFixture(fixture(t));
  const wrong = buildReport({ baseline, facts: facts({ androidAbis: ['armeabi-v7a'], runtimeArch: 'arm', nodeVersion: 'v22.1.0' }) });
  for (const id of ['android-abi', 'native-architecture', 'node24-runtime']) assert.equal(wrong.gates.find(g => g.id === id).status, 'BLOCKED');
  const matching = buildReport({ baseline, facts: facts({ libc: 'glibc', executionRoute: 'linux-glibc-in-new-uid', nodeVersion: 'v24.20.0' }) });
  for (const id of ['libc-route', 'new-uid-filesystem-boundary', 'network-and-lifecycle']) assert.equal(matching.gates.find(g => g.id === id).status, 'NOT_PROVEN');
});
test('facts schema rejects secrets, raw output, unknown fields and duplicates', () => {
  for (const input of [facts({ token: 'synthetic' }), facts({ nodeVersion: 'secret-value' }),
    facts({ androidAbis: ['arm64-v8a', 'arm64-v8a'] }), facts({ androidApi: '34' }), facts({ libc: 'unknown' })]) {
    assert.throws(() => validateFacts(input), /INVALID_DEVICE_FACTS/);
  }
});
test('CLI valid baseline returns 2 and does not create output files', t => {
  const root = fixture(t); baselineFixture(root); fs.mkdirSync(path.join(root, 'scripts/phone-adaptation'), { recursive: true });
  const before = fs.readdirSync(path.join(root, 'scripts/phone-adaptation'));
  let text; const status = main([], { toolRoot: path.join(root, 'scripts/phone-adaptation'), output: s => { text = s; } });
  assert.equal(status, 2); assert.equal(JSON.parse(text).status, 'BLOCKED');
  assert.deepEqual(fs.readdirSync(path.join(root, 'scripts/phone-adaptation')), before);
});
test('CLI errors never reflect sensitive argv, malformed JSON or fs messages', t => {
  const root = fixture(t), toolRoot = path.join(root, 'scripts/phone-adaptation'); baselineFixture(root);
  save(root, 'scripts/phone-adaptation/inputs/device-facts.json', '{"token":"SYNTHETIC_SECRET_DO_NOT_ECHO"}');
  const errors = [];
  for (const args of [['--SYNTHETIC_SECRET_DO_NOT_ECHO'], ['--with-facts'], ['--snapshot', '--inspect-fixed-artifacts'], ['--snapshot']]) {
    assert.equal(main(args, { toolRoot, output: s => errors.push(s) }), 1);
  }
  assert.equal(errors.join('').includes('SYNTHETIC_SECRET'), false);
  assert.equal(errors.join('').includes(root), false);
  assert.equal(JSON.stringify(publicError(new Error('SYNTHETIC_SECRET'))).includes('SYNTHETIC_SECRET'), false);
});
test('binary inspection rejects unknown bytes by hash before ELF parsing', t => {
  const root = fixture(t), baseline = baselineFixture(root);
  save(root, FIXED.nodePath, 'SYNTHETIC_NOT_A_REAL_NODE_BINARY');
  assert.throws(() => inspectFixedArtifacts(root, baseline), /ARTIFACT_HASH_MISMATCH/);
});
test('prepared bundle has exact allowlist, local hashes, no runtime and usable snapshot CLI', t => {
  const root = fixture(t), toolRoot = path.join(root, 'scripts/phone-adaptation'); baselineFixture(root);
  for (const name of BUNDLE_FILES) save(toolRoot, name, readPhysical(tools, name, 1000000));
  save(toolRoot, 'DO_NOT_COPY.credentials', 'SYNTHETIC_SECRET_DO_NOT_COPY');
  const result = prepare({ toolRoot }); assert.equal(result.status, 'PREPARED_TOOL_ONLY');
  const bundleRoot = path.join(root, result.directory);
  const names = fs.readdirSync(bundleRoot).sort();
  assert.deepEqual(names, [...BUNDLE_FILES, 'baseline.snapshot.json', 'bundle.manifest.json'].sort());
  const manifest = JSON.parse(readPhysical(bundleRoot, 'bundle.manifest.json', 100000));
  for (const record of manifest.files) assert.equal(digest(readPhysical(bundleRoot, record.name, 1000000)), record.sha256);
  let output; assert.equal(main(['--snapshot'], { toolRoot: bundleRoot, output: s => { output = s; } }), 2);
  assert.equal(JSON.parse(output).deviceConnected, false); assert.equal(output.includes('SYNTHETIC_SECRET'), false);
  const second = prepare({ toolRoot }); assert.notEqual(second.directory, result.directory);
});
test('packager rejects linked source and linked output parent instead of copying trees', t => {
  const root = fixture(t), toolRoot = path.join(root, 'scripts/phone-adaptation'); baselineFixture(root);
  for (const name of BUNDLE_FILES) save(toolRoot, name, readPhysical(tools, name, 1000000));
  fs.mkdirSync(path.join(root, 'synthetic-output'));
  fs.symlinkSync(path.join(root, 'synthetic-output'), path.join(toolRoot, 'prepared'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepare({ toolRoot }), /LINK_REJECTED/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'synthetic-output')), []);
});
