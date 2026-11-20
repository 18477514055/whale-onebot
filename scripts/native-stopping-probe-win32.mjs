import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { inspectPE } from './inspect-pe.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const output = path.join(root, '.tmp/native-stopping-win32');
const native = path.join(output, 'stopping.node');
const source = path.join(root, 'experiments/native-stopping/probe.cc');
const tools = path.join(root, '.tools');
const internal = path.join(tools, 'node-internals-v24.20.0');
const publicHeaders = path.join(tools, 'node-v24.20.0-linux-x64/include/node');
const vc = path.join(tools, 'msvc-windows/toolchain/VC/Tools/MSVC/14.44.35207');
const binaryDir = path.join(vc, 'bin/Hostx64/x64');
const compiler = path.join(binaryDir, 'cl.exe');
const linker = path.join(binaryDir, 'link.exe');
const sdkHeaders = path.join(tools, 'msvc-windows/extracted/microsoft.windows.sdk.cpp/c/Include/10.0.26100.0');
const sdkLibraries = path.join(tools, 'msvc-windows/extracted/microsoft.windows.sdk.cpp.x64/c');
const nodeLibrary = path.join(tools, 'node-v24.20.0-win-x64/node.lib');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const modes = ['baseline', 'stop', 'unavailable', 'nonNodeContext', 'foreignThread'];
const expected = {
  executableSha256: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
  configSha256: 'cef8c4e3f5021ff106d9d0a910912e6336d56faaec280e8000ee84227fa86a96',
  sourceSha256: 'c3576b95a4a42c50991070e2195732fc26f6f8e1d3453562f360c7259d6e2f65',
  helperSha256: 'a4d25fcecbbfa63769a36ef90ccf94d28116330e708088558c6f64724f0df2b1',
  nodeLibrarySha256: '63ec831bbf164d1b23197d6fac1944dfb146534e332889ca0755d250e8dedff9',
};
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v24.20.0');
assert.equal(hash(await readFile(process.execPath)), expected.executableSha256);
assert.equal(hash(JSON.stringify(process.config)), expected.configSha256);
assert.equal(hash(await readFile(source)), expected.sourceSha256);
assert.equal(hash(await readFile(path.join(root, 'src/native/node-host.h'))), expected.helperSha256);
const linuxPins = JSON.parse(await readFile(path.join(root, 'experiments/native-host/pins.json')));
const headerHashes = {};
for (const [relative, digest] of Object.entries(linuxPins.files)) {
  if (!relative.startsWith('.tools/node-internals-v24.20.0/') && !relative.startsWith('.tools/node-v24.20.0-linux-x64/include/node/')) continue;
  assert.equal(hash(await readFile(path.join(root, relative))), digest, `source/header mismatch: ${relative}`);
  headerHashes[relative] = digest;
}
async function confined(filename) {
  const relative = path.relative(await realpath(root), await realpath(filename));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'path escaped project');
}
if (!isMainThread) {
  assert(workerData && modes.includes(workerData.mode)); await confined(native);
  assert.equal(hash(await readFile(native)), workerData.sha256);
  createRequire(import.meta.url)(native)[workerData.mode]();
} else if (process.argv[2] === '--worker-child') {
  assert.equal(process.argv.length, 5); assert(['baseline', 'stop'].includes(process.argv[3]));
  const worker = new Worker(script, { workerData: { mode: process.argv[3], sha256: process.argv[4] } });
  worker.on('error', error => { console.error(error.message); process.exitCode = 2; });
  worker.on('exit', code => { console.error(JSON.stringify({ workerExit: code })); });
} else if (process.argv[2] === '--child') {
  assert.equal(process.argv.length, 5); assert(modes.includes(process.argv[3])); await confined(native);
  assert.equal(hash(await readFile(native)), process.argv[4]);
  createRequire(import.meta.url)(native)[process.argv[3]]();
} else {
  assert.equal(process.argv.length, 2); await mkdir(output, { recursive: true }); await confined(output);
  assert.equal(hash(await readFile(nodeLibrary)), expected.nodeLibrarySha256);
  const includes = [publicHeaders, path.join(internal, 'src'), path.join(internal, 'deps/v8/include'),
    path.join(internal, 'deps/simdjson'), path.join(vc, 'include'),
    ...['ucrt', 'shared', 'um'].map(name => path.join(sdkHeaders, name))];
  const libraryPaths = [path.join(vc, 'lib/x64'), path.join(sdkLibraries, 'ucrt/x64'), path.join(sdkLibraries, 'um/x64')];
  const config = process.config.variables;
  assert.equal(config.node_shared, false); assert.equal(config.force_dynamic_crt, 0);
  assert.equal(config.clang, 1); assert.equal(config.llvm_version, '19.1.5');
  const definitions = ['NODE_WANT_INTERNALS=1', 'BUILDING_NODE_EXTENSION=1', 'NDEBUG',
    `HAVE_INSPECTOR=${config.v8_enable_inspector}`, `HAVE_OPENSSL=${Number(config.node_use_openssl)}`,
    `HAVE_SQLITE=${Number(config.node_use_sqlite)}`, `HAVE_AMARO=${Number(config.node_use_amaro)}`,
    'NODE_USE_V8_PLATFORM=1', '_HAS_EXCEPTIONS=0', '_ITERATOR_DEBUG_LEVEL=0',
    '_CRT_SECURE_NO_DEPRECATE', '_CRT_NONSTDC_NO_DEPRECATE', 'NOMINMAX', 'WIN32_LEAN_AND_MEAN'];
  if (config.v8_enable_i18n_support) definitions.push('V8_INTL_SUPPORT');
  const commonCompileArgs = ['/nologo', '/c', '/std:c++20', '/O2', '/Gy', '/Gw', '/GR-', '/MT', '/utf-8',
    '/Zc:__cplusplus', '/Zc:preprocessor', '/Zc:inline', ...definitions.map(value => `/D${value}`), ...includes.map(value => `/I${value}`)];
  const commonLinkArgs = ['/NOLOGO', '/DLL', '/MACHINE:X64', '/OPT:REF', '/OPT:ICF', '/INCREMENTAL:NO',
    ...libraryPaths.map(value => `/LIBPATH:${value}`), nodeLibrary];
  const env = { ...process.env, TEMP: output, TMP: output, INCLUDE: includes.join(';'), LIB: libraryPaths.join(';') };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'CL', '_CL_', 'LINK', '_LINK_']) delete env[key];
  // Child-scoped only. cl support DLLs and linker remain inside the new project.
  env.PATH = `${binaryDir};${path.join(process.env.SystemRoot, 'System32')}`;
  const run = (exe, args) => {
    const r = spawnSync(exe, args, { cwd: output, env, encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null };
  };
  const object = path.join(output, 'probe.obj');
  // Windows Node does not export ContextEmbedderTag::kNodeContextTagPtr used
  // only by the Linux probe's extra internal-vs-public pointer diagnostic.
  // Keep the shared helper/Stop/thread cases unchanged; do not fake that tag.
  const sourceText = await readFile(source, 'utf8');
  const diagnostic = 'const bool same_environment = environment == node::Environment::GetCurrent(isolate);';
  assert.equal(sourceText.split(diagnostic).length, 2);
  const adaptedSource = sourceText.replace(diagnostic, 'const bool public_environment_available = environment != nullptr;')
    .replaceAll('sameEnvironment', 'publicEnvironmentAvailable').replaceAll('same_environment', 'public_environment_available');
  const adaptedPath = path.join(output, 'probe-win32.cc');
  await writeFile(adaptedPath, adaptedSource);
  const compileArgs = [...commonCompileArgs, `/Fo${object}`, adaptedPath];
  const compilation = run(compiler, compileArgs); assert.equal(compilation.status, 0, JSON.stringify(compilation));
  const simdjsonSource = path.join(tools, 'node-simdjson-win32/simdjson.cpp');
  const simdjsonSha256 = '73443d00a1ce1ebf4dbb5f1bce435d964f814facee646a81aa57626ad303155c';
  assert.equal(hash(await readFile(simdjsonSource)), simdjsonSha256);
  const simdjsonObject = path.join(output, 'simdjson.obj');
  const simdjsonCompileArgs = [...commonCompileArgs, `/Fo${simdjsonObject}`, simdjsonSource];
  const simdjsonCompilation = run(compiler, simdjsonCompileArgs);
  assert.equal(simdjsonCompilation.status, 0, JSON.stringify(simdjsonCompilation));
  const linkArgs = [...commonLinkArgs, `/OUT:${native}`, `/IMPLIB:${path.join(output, 'probe.lib')}`, object, simdjsonObject];
  const linking = run(linker, linkArgs); assert.equal(linking.status, 0, JSON.stringify(linking));
  const bytes = await readFile(native); const pe = inspectPE(bytes);
  assert.equal(pe.machine, '0x8664'); assert.equal(pe.format, 'PE32+');
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: 'original Windows plugin and disposable Node child processes only; no QQ', expected, headerHashes,
    node: { path: process.execPath, version: process.version, sha256: expected.executableSha256, config: process.config,
      originalCompiler: 'clang 19.1.5 per process.config; local MSVC is an ABI compatibility experiment, not the same compiler' },
    build: { compiler, linker, compilerSha256: hash(await readFile(compiler)), linkerSha256: hash(await readFile(linker)),
      commonCompileArgs, commonLinkArgs, includePaths: includes, libraryPaths, environment: { INCLUDE: env.INCLUDE, LIB: env.LIB, PATH: env.PATH, TEMP: output, TMP: output },
      compileArgs, linkArgs, compilation, linking, compilerVersion: run(compiler, ['/Bv']),
      additionalObjects: [simdjsonObject], simdjson: { source: simdjsonSource, sha256: simdjsonSha256,
        url: 'https://raw.githubusercontent.com/nodejs/node/71b8b174857e25106d39b61a9e6f30d927da8b01/deps/simdjson/simdjson.cpp',
        license: 'Apache-2.0; retained at .tools/node-simdjson-win32/LICENSE',
        object: simdjsonObject, objectSha256: hash(await readFile(simdjsonObject)),
        compileArgs: simdjsonCompileArgs, compilation: simdjsonCompilation } },
    sourceAdaptation: { original: source, originalSha256: expected.sourceSha256, generated: adaptedPath,
      generatedSha256: hash(adaptedSource), reason: 'replace unavailable internal pointer-equivalence diagnostic with explicit publicEnvironmentAvailable; shared helper and seven behavioral cases unchanged' },
    importLibrary: { path: nodeLibrary, bytes: (await readFile(nodeLibrary)).length, sha256: expected.nodeLibrarySha256,
      source: 'https://nodejs.org/dist/v24.20.0/win-x64/node.lib', checksumSource: 'https://nodejs.org/dist/v24.20.0/SHASUMS256.txt' },
    fixture: { path: native, sha256: hash(bytes), bytes: bytes.length, pe }, scriptSha256: hash(await readFile(script)), cases: [],
    limitations: ['only the exact pinned Node Windows binary/config tested', 'no QQ loading or Tencent-equivalence claim', 'shared current-thread conservative helper unchanged', 'MSVC-built plugin against Clang-built Node is validated by these observations only'] };
  for (const { mode, worker } of [...modes.map(mode => ({ mode, worker: false })), ...['baseline', 'stop'].map(mode => ({ mode, worker: true }))]) {
    const result = run(process.execPath, [script, worker ? '--worker-child' : '--child', mode, hash(bytes)]);
    // Preserve raw Windows observations even if an assertion fails; never
    // assume a nonzero code or a signal is a successful native experiment.
    evidence.cases.push({ mode, worker, process: result });
    await writeFile(path.join(root, 'evidence/native-stopping-win32.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    assert.equal(result.signal, null, JSON.stringify(result));
    const observed = JSON.parse(result.stdout);
    if (mode === 'unavailable') assert.deepEqual(observed, { mode, state: 'unavailable', conservativeStopping: true });
    else if (mode === 'nonNodeContext') assert.deepEqual(observed, { mode, state: 'unavailable', noNodeEnvironment: true, conservativeStopping: true });
    else if (mode === 'foreignThread') assert.deepEqual(observed, { mode, created: 0, joined: 0, ran: true, hasCurrentIsolate: false, capturedMatchesCurrent: false, state: 'unavailable', conservativeStopping: true, ownerBefore: 'running', ownerAfter: 'running' });
    else assert.deepEqual(observed, { mode, before: 'running', after: mode === 'stop' ? 'stopping' : 'running', beforeBoolean: false, afterBoolean: mode === 'stop', publicEnvironmentAvailable: true, stopResult: mode === 'stop' ? 0 : -1 });
    const expectedExit = mode === 'stop' && !worker ? 1 : 0;
    assert.equal(result.status, expectedExit, JSON.stringify(result));
    if (worker) assert.deepEqual(JSON.parse(result.stderr), { workerExit: 0 });
    else assert.equal(result.stderr, '');
    Object.assign(evidence.cases.at(-1), { observed, expectedExit, passed: true });
  }
  evidence.passed = true;
  await writeFile(path.join(root, 'evidence/native-stopping-win32.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, cases: evidence.cases.map(({ mode, worker, observed, process }) => ({ mode, worker, observed, exit: process.status })) }, null, 2));
}
