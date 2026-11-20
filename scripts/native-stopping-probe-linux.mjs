import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const output = path.join(root, '.tmp/native-stopping');
const native = path.join(output, 'stopping.node');
const source = path.join(root, 'experiments/native-stopping/probe.cc');
const tools = path.join(root, '.tools');
const gcc = path.join(tools, 'gcc-linux/extracted/usr');
const internal = path.join(tools, 'node-internals-v24.20.0');
const publicHeaders = path.join(tools, 'node-v24.20.0-linux-x64/include/node');
const compiler = path.join(gcc, 'bin/x86_64-linux-gnu-g++-14');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modes = ['baseline', 'stop', 'unavailable', 'nonNodeContext', 'foreignThread'];
async function confined(p) {
  const relative = path.relative(await realpath(root), await realpath(p));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'path escaped project');
}
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.20.0', 'internal layout pinned to exact release');
if (!isMainThread) {
  assert(workerData && modes.includes(workerData.mode));
  await confined(native);
  assert.equal(hash(await readFile(native)), workerData.sha256);
  createRequire(import.meta.url)(native)[workerData.mode]();
} else if (process.argv[2] === '--worker-child') {
  assert.equal(process.argv.length, 5); assert(['baseline', 'stop'].includes(process.argv[3]));
  const worker = new Worker(script, { workerData: { mode: process.argv[3], sha256: process.argv[4] } });
  worker.on('error', error => { console.error(error.message); process.exitCode = 2; });
  worker.on('exit', code => { console.error(JSON.stringify({ workerExit: code })); });
} else if (process.argv[2] === '--child') {
  assert.equal(process.argv.length, 5); assert(modes.includes(process.argv[3]));
  await confined(native);
  assert.equal(hash(await readFile(native)), process.argv[4]);
  createRequire(import.meta.url)(native)[process.argv[3]]();
} else {
  assert.equal(process.argv.length, 2);
  await mkdir(output, { recursive: true }); await confined(output);
  const env = { ...process.env, TMPDIR: output, TMP: output, TEMP: output };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT', 'GCC_EXEC_PREFIX', 'COMPILER_PATH', 'LIBRARY_PATH', 'CPATH', 'CPLUS_INCLUDE_PATH', 'C_INCLUDE_PATH']) delete env[key];
  const run = (exe, args, compilerProcess = false) => {
    const childEnv = compilerProcess ? { ...env, LD_LIBRARY_PATH: path.join(gcc, 'lib/x86_64-linux-gnu') } : env;
    const r = spawnSync(exe, args, { cwd: output, env: childEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
  };
  const config = process.config.variables;
  assert.equal(config.v8_enable_pointer_compression, 0);
  assert.equal(config.v8_enable_sandbox, 0);
  assert.equal(config.v8_enable_inspector, 1);
  assert.equal(config.node_use_openssl, true);
  assert.equal(config.debug_node, false);
  const enabled = value => value === true || value === 1 || value === 'true';
  assert(enabled(config.node_use_v8_platform));
  const definitions = ['NODE_WANT_INTERNALS=1', 'BUILDING_NODE_EXTENSION=1',
    `HAVE_INSPECTOR=${config.v8_enable_inspector}`, `HAVE_OPENSSL=${Number(config.node_use_openssl)}`,
    `HAVE_SQLITE=${Number(enabled(config.node_use_sqlite))}`, `HAVE_AMARO=${Number(enabled(config.node_use_amaro))}`,
    'NODE_USE_V8_PLATFORM=1', '_GLIBCXX_USE_CXX11_ABI=1', '_FILE_OFFSET_BITS=64', '__STDC_FORMAT_MACROS', 'NDEBUG'];
  if (config.v8_enable_i18n_support) definitions.push('V8_INTL_SUPPORT');
  if (config.v8_enable_v8_checks) definitions.push('V8_ENABLE_CHECKS');
  const includes = [publicHeaders, path.join(internal, 'src'), path.join(internal, 'deps/v8/include'),
    path.join(internal, 'deps/simdjson'), path.join(gcc, 'include/c++/14'),
    path.join(gcc, 'include/x86_64-linux-gnu/c++/14'), path.join(gcc, 'include/c++/14/backward'),
    path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14/include'),
    path.join(tools, 'tinycc-linux/libc-headers/usr/include'),
    path.join(tools, 'tinycc-linux/libc-headers/usr/include/x86_64-linux-gnu'),
    path.join(tools, 'tinycc-linux/kernel-headers/usr/include'),
    path.join(tools, 'tinycc-linux/kernel-headers/usr/include/x86_64-linux-gnu')];
  const args = ['-B', path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14/'), '-std=gnu++20', '-O2', '-fPIC',
    '-fno-rtti', '-fno-exceptions', '-fno-strict-aliasing', '-fno-use-linker-plugin', '-shared', '-nostdlib', '-Wl,-z,noexecstack',
    ...definitions.map(x => `-D${x}`), ...includes.flatMap(x => ['-isystem', x]),
    path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14/crtbeginS.o'), source,
    path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14/crtendS.o'), '-o', native];
  const compilation = run(compiler, args, true);
  assert.equal(compilation.status, 0, compilation.stderr);
  const bytes = await readFile(native);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(bytes[4], 2); assert.equal(bytes[5], 1); assert.equal(bytes.readUInt16LE(18), 62);
  const inspection = run('/usr/bin/objdump', ['-f', '-p', '-T', native]);
  assert.equal(inspection.status, 0);
  assert.match(inspection.stdout, /\bSTACK[^\n]*\n[^\n]*flags rw-\s*(?:\n|$)/);
  const manifest = JSON.parse(await readFile(path.join(internal, 'download-manifest.json')));
  const headerHashes = {};
  for (const item of manifest.files) headerHashes[item.path] = hash(await readFile(path.join(internal, item.path)));
  for (const file of ['node.gyp', 'common.gypi', 'node.gypi', 'src/node.h', 'src/node.cc', 'src/env.cc', 'LICENSE']) headerHashes[file] = hash(await readFile(path.join(internal, file)));
  headerHashes['project/src/native/node-host.h'] = hash(await readFile(path.join(root, 'src/native/node-host.h')));
  assert.equal(hash(await readFile(path.join(publicHeaders, 'node.h'))), headerHashes['src/node.h'], 'public and internal source versions differ');
  const kernelPackageFilename = 'linux-libc-dev_6.12.113-1_all.deb';
  const kernelPackage = await readFile(path.join(tools, 'tinycc-linux', kernelPackageFilename));
  assert.equal(kernelPackage.length, 3021244);
  assert.equal(hash(kernelPackage), 'b2d475e01aaf0030c72bd3a0300d311f8be64aa9e82d82eae5da1a04f4010071');
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: 'original plugin and disposable Node child processes only; no QQ', sourceCommit: manifest.commit,
    node: { version: process.version, path: process.execPath, sha256: hash(await readFile(process.execPath)), config: process.config },
    compiler: { path: compiler, sha256: hash(await readFile(compiler)), version: run(compiler, ['--version'], true) },
    build: { args, definitions, compilation }, fixture: { path: native, sha256: hash(bytes), bytes: bytes.length, inspection },
    sourceSha256: hash(await readFile(source)), scriptSha256: hash(await readFile(script)), headerHashes,
    toolchainEvidenceSha256: hash(await readFile(path.join(root, 'evidence/cpp-toolchain-linux.json'))),
    additionalKernelHeadersPackage: { filename: kernelPackageFilename, bytes: kernelPackage.length, sha256: hash(kernelPackage),
      source: 'https://security.debian.org/debian-security/pool/updates/main/l/linux/linux-libc-dev_6.12.113-1_all.deb',
      expectedDigestSource: 'existing apt-cache show linux-libc-dev=6.12.113-1 metadata; matched size and SHA256 before dpkg-deb extraction',
      installed: false, extractedPath: path.join(tools, 'tinycc-linux/kernel-headers') },
    crtHashes: Object.fromEntries(await Promise.all(['crtbeginS.o', 'crtendS.o'].map(async file => [file, hash(await readFile(path.join(gcc, 'lib/gcc/x86_64-linux-gnu/14', file)))]))),
    caveats: ['Node internal API pinned to exact release and config', 'no Tencent IsEnvironmentStopping equivalence claim', 'foreign unentered thread rejected before isolate instance calls; not an arbitrary-thread/lifetime guarantee', 'no offset reconstruction or cleanup-hook substitute'], cases: [] };
  for (const { mode, worker } of [...modes.map(mode => ({ mode, worker: false })), ...['baseline', 'stop'].map(mode => ({ mode, worker: true }))]) {
    const result = run(process.execPath, [script, worker ? '--worker-child' : '--child', mode, hash(bytes)]);
    assert.equal(result.signal, null, JSON.stringify({ mode, worker, ...result }));
    const expectedExit = mode === 'stop' && !worker ? 1 : 0;
    assert.equal(result.status, expectedExit, JSON.stringify({ mode, worker, ...result }));
    const observed = JSON.parse(result.stdout);
    if (mode === 'unavailable') assert.deepEqual(observed, { mode, state: 'unavailable', conservativeStopping: true });
    else if (mode === 'nonNodeContext') assert.deepEqual(observed, { mode, state: 'unavailable', noNodeEnvironment: true, conservativeStopping: true });
    else if (mode === 'foreignThread') assert.deepEqual(observed, { mode, created: 0, joined: 0, ran: true, hasCurrentIsolate: false, capturedMatchesCurrent: false, state: 'unavailable', conservativeStopping: true, ownerBefore: 'running', ownerAfter: 'running' });
    else assert.deepEqual(observed, { mode, before: 'running', after: mode === 'stop' ? 'stopping' : 'running', beforeBoolean: false, afterBoolean: mode === 'stop', sameEnvironment: true, stopResult: mode === 'stop' ? 0 : -1 });
    if (worker) assert.deepEqual(JSON.parse(result.stderr), { workerExit: 0 });
    else assert.equal(result.stderr, '', 'main-thread native probe must have empty stderr');
    evidence.cases.push({ mode, worker, expectedExit, passed: true, process: result, observed });
  }
  evidence.passed = true;
  await writeFile(path.join(root, 'evidence/native-stopping-linux.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, cases: evidence.cases.map(({ mode, observed }) => ({ mode, observed })) }, null, 2));
}
