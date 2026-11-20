import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const sourceRoot = path.join(root, 'experiments/native-host');
const output = path.join(root, '.tmp/native-host');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = JSON.parse(await readFile(path.join(sourceRoot, 'pins.json')));
const expectedSymbols = ['_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE', 'qq_magic_napi_register'];
const identities = {
  platform: process.platform, arch: process.arch, version: process.version,
  executableSha256: hash(await readFile(process.execPath)), configSha256: hash(JSON.stringify(process.config)),
};
function assertIdentity(observed) { assert.deepEqual(observed, pins.node, 'host identity/configuration differs from exact pinned Node'); }
assertIdentity(identities);
// These immutable expected hashes were prepared before this experiment. Never
// refresh them automatically to turn a changed build into a passing build.
for (const [relative, digest] of Object.entries(pins.files)) {
  assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
  assert.equal(hash(await readFile(path.join(root, relative))), digest, `source/header pin mismatch: ${relative}`);
}
async function confined(filename) {
  const relative = path.relative(await realpath(root), await realpath(filename));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'path escaped project');
}
const artifactNames = { provider: 'libonebot-node-host.so', bootstrap: 'bootstrap.node', local: 'bootstrap-local.node', consumer: 'consumer.node' };
const cases = ['without-provider', 'local-provider', 'global-baseline', 'global-stop'];
if (process.argv[2] === '--child') {
  assert.equal(process.argv.length, 4); const mode = process.argv[3]; assert(cases.includes(mode));
  const manifest = JSON.parse(await readFile(path.join(output, 'artifacts.json')));
  const artifacts = {};
  for (const [name, file] of Object.entries(artifactNames)) {
    artifacts[name] = path.join(output, file); await confined(artifacts[name]);
    assert.equal(hash(await readFile(artifacts[name])), manifest[name].sha256, 'native artifact changed before load');
  }
  if (mode !== 'without-provider') {
    const loader = createRequire(import.meta.url)(mode === 'local-provider' ? artifacts.local : artifacts.bootstrap);
    assert.deepEqual(loader, { providerLoaded: true });
  }
  const module = { exports: {} };
  try { process.dlopen(module, artifacts.consumer, constants.dlopen.RTLD_NOW); }
  catch (error) {
    if (mode.startsWith('global-')) throw error;
    process.stdout.write(JSON.stringify({ loaded: false, code: error.code, message: error.message }) + '\n');
    process.exit(0);
  }
  assert(mode.startsWith('global-'), 'negative control unexpectedly resolved provider imports');
  assert.deepEqual(Object.keys(module.exports).sort(), ['baseline', 'stop']);
  module.exports[mode === 'global-stop' ? 'stop' : 'baseline']();
} else {
  assert.equal(process.argv.length, 2);
  await mkdir(output, { recursive: true }); await confined(output);
  const prior = JSON.parse(await readFile(path.join(root, 'evidence/native-stopping-linux.json')));
  assert.equal(hash(JSON.stringify(prior.build.args)), pins.stoppingBuildRecipeSha256);
  assert.equal(prior.passed, true); assert.equal(prior.cases.length, 7);
  const gcc = path.join(root, '.tools/gcc-linux/extracted/usr');
  const compiler = path.join(gcc, 'bin/x86_64-linux-gnu-g++-14');
  const env = { ...process.env, TMPDIR: output, TMP: output, TEMP: output };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT', 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'LIBRARY_PATH', 'CPATH', 'CPLUS_INCLUDE_PATH', 'C_INCLUDE_PATH']) delete env[key];
  const run = (exe, args, compile = false) => {
    const r = spawnSync(exe, args, { cwd: output, env: compile ? { ...env, LD_LIBRARY_PATH: path.join(gcc, 'lib/x86_64-linux-gnu') } : env,
      encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
  };
  // Same version/configuration flags as the independently verified seven-case
  // stopping probe. Only source files, output names and export controls differ.
  const crtBegin = path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14/crtbeginS.o');
  const crtEnd = path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14/crtendS.o');
  const index = prior.build.args.indexOf(crtBegin); assert(index > 0);
  const baseArgs = prior.build.args.slice(0, index);
  const providerPath = path.join(output, artifactNames.provider);
  const builds = [
    ['provider', path.join(root, 'src/native/node-host.cc'), [`-Wl,--version-script=${path.join(sourceRoot, 'exports.map')}`]],
    ['bootstrap', path.join(sourceRoot, 'bootstrap.cc'), [`-DPROVIDER_PATH="${providerPath}"`]],
    ['local', path.join(sourceRoot, 'bootstrap.cc'), [`-DPROVIDER_PATH="${providerPath}"`, '-DLOCAL_PROVIDER=1']],
    ['consumer', path.join(sourceRoot, 'consumer.cc'), []],
  ];
  const artifacts = {}; const compilation = [];
  for (const [name, source, extra] of builds) {
    const filename = path.join(output, artifactNames[name]);
    const args = [...baseArgs, ...extra, crtBegin, source, crtEnd, '-o', filename];
    const result = run(compiler, args, true); assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const bytes = await readFile(filename);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
    assert.equal(bytes[4], 2); assert.equal(bytes[5], 1); assert.equal(bytes.readUInt16LE(18), 62);
    const inspection = run('/usr/bin/objdump', ['-f', '-p', '-T', filename]); assert.equal(inspection.status, 0);
    assert.match(inspection.stdout, /\bSTACK[^\n]*\n[^\n]*flags rw-\s*(?:\n|$)/);
    const definitions = run('/usr/bin/nm', ['-D', '--defined-only', '--format=posix', filename]); assert.equal(definitions.status, 0);
    const undefinedSymbols = run('/usr/bin/nm', ['-D', '--undefined-only', '--format=posix', filename]); assert.equal(undefinedSymbols.status, 0);
    const exported = definitions.stdout.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]).sort();
    const imported = undefinedSymbols.stdout.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]).sort();
    if (name === 'provider') assert.deepEqual(exported, expectedSymbols);
    if (name === 'consumer') {
      for (const symbol of expectedSymbols) assert(imported.includes(symbol), `consumer does not import ${symbol}`);
      assert(!exported.includes('napi_register_module_v1'), 'consumer must depend on constructor registration');
      assert(!inspection.stdout.includes('libonebot-node-host'), 'consumer must not contain a direct provider DT_NEEDED link');
      assert.match(inspection.stdout, /INIT_ARRAY/);
    }
    artifacts[name] = { path: filename, bytes: bytes.length, sha256: hash(bytes), exported, imported, inspection };
    compilation.push({ name, args, ...result });
  }
  await writeFile(path.join(output, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
  const guards = ['executableSha256', 'configSha256'].map(field => {
    assert.throws(() => assertIdentity({ ...identities, [field]: '0'.repeat(64) }));
    return { alteredField: field, rejected: true, beforeNativeLoading: true };
  });
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: 'original separated provider/bootstrap/consumer only; never loads QQ', pins,
    pinManifestSha256: hash(await readFile(path.join(sourceRoot, 'pins.json'))), scriptSha256: hash(await readFile(script)),
    runtime: identities, compiler: prior.compiler, buildRecipeSha256: pins.stoppingBuildRecipeSha256,
    sharedHelperSevenCaseEvidenceSha256: hash(await readFile(path.join(root, 'evidence/native-stopping-linux.json'))),
    staticQQEvidenceSha256: hash(await readFile(path.join(root, 'evidence/native-abi-linux.json'))),
    exportedObservedMissingSymbols: expectedSymbols, compilation, artifacts, guards, cases: [],
    limitations: ['only two missing host symbols implemented', 'other 95 exact-name matches do not verify semantics',
      'QQ dependencies and full ABI not loaded or validated', 'raw provider requires guarded loader; shared object alone does not enforce runtime pins',
      'conservative owner-thread restriction is original behavior, not a full Tencent equivalence claim'] };
  for (const mode of cases) {
    const result = run(process.execPath, [script, '--child', mode]);
    assert.equal(result.signal, null); assert.equal(result.status, mode === 'global-stop' ? 1 : 0, JSON.stringify(result));
    assert.equal(result.stderr, '');
    const observed = JSON.parse(result.stdout);
    if (mode.startsWith('global-')) assert.deepEqual(observed, { mode: mode === 'global-stop' ? 'stop' : 'baseline', constructorCalls: 1, before: false, after: mode === 'global-stop', stopResult: mode === 'global-stop' ? 0 : -1 });
    else {
      assert.equal(observed.loaded, false); assert.equal(observed.code, 'ERR_DLOPEN_FAILED');
      assert.match(observed.message, /undefined symbol: (qq_magic_napi_register|_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE)/);
    }
    evidence.cases.push({ mode, passed: true, process: result, observed });
  }
  evidence.passed = true;
  await writeFile(path.join(root, 'evidence/native-host-linux.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, guards, cases: evidence.cases.map(({ mode, observed }) => ({ mode, observed })) }, null, 2));
}
