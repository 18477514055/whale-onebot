import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const output = path.join(root, '.tmp/native-registration/linux');
const source = path.join(root, 'experiments/native-registration');
const toolRoot = path.join(root, '.tools/tinycc-linux');
const compiler = path.join(toolRoot, 'extracted/usr/bin/tcc');
const compilerLibrary = path.join(toolRoot, 'extracted/usr/lib/x86_64-linux-gnu/tcc');
const include = path.join(root, '.tools/node-v24.20.0-linux-x64/include/node');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [
  { name: 'baseline', source: 'linux-baseline.c', success: true, route: 'standard-symbol-registration', constructors: 0, delegations: 0 },
  { name: 'delegated', source: 'linux-delegated.c', success: true, route: 'synthetic-registration-delegate', constructors: 1, delegations: 1 },
  { name: 'unregistered', source: 'linux-unregistered.c', success: false },
  { name: 'delegation-disabled', source: 'linux-delegated.c', define: '-DDISABLE_REGISTRATION', success: false },
];
async function confined(directory) {
  const relative = path.relative(await realpath(root), await realpath(directory));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'path escaped project');
}
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 synthetic experiment only');
if (process.argv[2] === '--child') {
  assert.equal(process.argv.length, 5);
  const selected = cases.find(item => item.name === process.argv[3]);
  assert(selected, 'fixture is not allowlisted');
  await confined(output);
  const filename = path.join(output, `${selected.name}.node`);
  assert.equal(hash(await readFile(filename)), process.argv[4], 'fixture changed before load');
  try {
    const result = createRequire(import.meta.url)(filename);
    process.stdout.write(JSON.stringify({ loaded: true, exports: result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ loaded: false, error: { code: error.code, message: error.message } }));
  }
} else {
  assert.equal(process.argv.length, 2, 'no external native paths accepted');
  await mkdir(output, { recursive: true });
  for (const directory of [output, source, path.dirname(compiler)]) await confined(directory);
  const env = { ...process.env, TMPDIR: output, TMP: output, TEMP: output };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT']) delete env[key];
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { cwd: output, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
  };
  const version = run(compiler, ['-v']);
  assert.equal(version.status, 0);
  const evidence = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'original synthetic ELF fixtures only; no QQ loading',
    node: { path: process.execPath, version: process.version, arch: process.arch, sha256: hash(await readFile(process.execPath)) },
    compiler: { path: compiler, sha256: hash(await readFile(compiler)), version },
    linker: { path: '/usr/bin/ld', sha256: hash(await readFile('/usr/bin/ld')), version: run('/usr/bin/ld', ['--version']) },
    packages: [], scriptSha256: hash(await readFile(script)), sourceHashes: {}, headers: {}, cases: [],
    limitations: ['no QQ compatibility proof', 'no IsEnvironmentStopping implementation', 'no worker, teardown or C++ ABI validation'],
  };
  for (const [filename, expectedSha256] of [
    ['tcc_0.9.27+git20200814.62c30a4a-2_amd64.deb', '957d1607516de7f4c968193b8d89f0df535046c0f793c561aebebacf6846b2d3'],
    ['libc6-dev_2.41-12+deb13u4_amd64.deb', '1fda734dabcd80b77266a09ab62b0f1e3e16d8091db62899890b2200745632a2'],
  ]) {
    const bytes = await readFile(path.join(toolRoot, filename));
    assert.equal(hash(bytes), expectedSha256);
    evidence.packages.push({ filename, bytes: bytes.length, sha256: hash(bytes), provenance: 'downloaded from configured Debian trixie repository; digest matched existing apt metadata; dpkg-deb extraction only, not installed' });
  }
  for (const file of ['linux-fixture.h', 'linux-baseline.c', 'linux-delegated.c', 'linux-unregistered.c']) evidence.sourceHashes[file] = hash(await readFile(path.join(source, file)));
  for (const file of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) evidence.headers[file] = hash(await readFile(path.join(include, file)));
  for (const item of cases) {
    const filename = path.join(output, `${item.name}.node`);
    const objectFile = path.join(output, `${item.name}.o`);
    const args = ['-B', compilerLibrary, '-c', '-nostdlib', '-I', include,
      '-I', path.join(toolRoot, 'libc-headers/usr/include'), '-I', path.join(toolRoot, 'libc-headers/usr/include/x86_64-linux-gnu'),
      ...(item.define ? [item.define] : []), path.join(source, item.source), '-o', objectFile];
    const compilation = run(compiler, args);
    assert.equal(compilation.status, 0, compilation.stderr);
    const linkArgs = ['-shared', '-z', 'noexecstack', ...(item.source === 'linux-delegated.c' ? ['-init', 'synthetic_constructor'] : []), '-o', filename, objectFile];
    const linking = run('/usr/bin/ld', linkArgs);
    assert.equal(linking.status, 0, linking.stderr);
    const bytes = await readFile(filename);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
    assert.equal(bytes[4], 2, 'ELF64'); assert.equal(bytes[5], 1, 'little endian');
    assert.equal(bytes.readUInt16LE(16), 3, 'shared object'); assert.equal(bytes.readUInt16LE(18), 62, 'x86_64');
    const inspection = run('/usr/bin/objdump', ['-f', '-p', '-T', filename]);
    assert.equal(inspection.status, 0, inspection.stderr);
    assert.match(inspection.stdout, /file format elf64-x86-64/);
    assert.match(inspection.stdout, /\bSTACK[^\n]*\n[^\n]*flags rw-\s*(?:\n|$)/, 'explicit non-executable stack required');
    assert(!/\bNEEDED\b/.test(inspection.stdout), 'synthetic fixture must have no DT_NEEDED libraries');
    if (item.name === 'baseline') assert.match(inspection.stdout, /napi_register_module_v1/);
    else assert(!inspection.stdout.includes('napi_register_module_v1'));
    if (item.source === 'linux-delegated.c') assert.match(inspection.stdout, /\n\s+INIT\s+0x/);
    const processResult = run(process.execPath, [script, '--child', item.name, hash(bytes)]);
    assert.equal(processResult.status, 0, JSON.stringify(processResult));
    const observed = JSON.parse(processResult.stdout);
    assert.equal(observed.loaded, item.success, `${item.name}: ${JSON.stringify(observed)}`);
    if (item.success) assert.deepEqual(observed.exports, { answer: 42, constructorCalls: item.constructors, delegationCalls: item.delegations, route: item.route });
    else {
      assert.equal(observed.error.code, 'ERR_DLOPEN_FAILED');
      assert.match(observed.error.message, /did not self-register/i);
    }
    evidence.cases.push({ name: item.name, expectedSuccess: item.success, passed: true, compilation: { args, ...compilation }, linking: { args: linkArgs, ...linking },
      fixture: { path: filename, sha256: hash(bytes), bytes: bytes.length, format: 'ELF64 little-endian ET_DYN EM_X86_64', inspection },
      process: processResult, observed });
  }
  evidence.passed = evidence.cases.every(item => item.passed);
  const target = path.join(root, 'evidence/native-registration-linux.json');
  await confined(path.dirname(target));
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: evidence.passed, cases: evidence.cases.map(item => ({ name: item.name, passed: item.passed, observed: item.observed })), evidence: target }, null, 2));
}
