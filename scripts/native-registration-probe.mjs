import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectPE } from './inspect-pe.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const output = path.join(root, '.tmp', 'native-registration');
const source = path.join(root, 'experiments', 'native-registration');
const compiler = path.join(root, '.tools', 'tinycc-0.9.27', 'tcc', 'tcc.exe');
const include = path.join(root, '.tools', 'node-v24.20.0-linux-x64', 'include', 'node');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cases = [
  { name: 'baseline', source: 'baseline.c', success: true, route: 'standard-symbol-registration', constructors: 0, delegations: 0 },
  { name: 'delegated', source: 'delegated.c', success: true, route: 'synthetic-registration-delegate', constructors: 1, delegations: 1 },
  { name: 'unregistered', source: 'unregistered.c', success: false },
  { name: 'delegation-disabled', source: 'delegated.c', define: '-DDISABLE_REGISTRATION', success: false },
];

async function confined(directory) {
  const actualRoot = await realpath(root);
  const actual = await realpath(directory);
  const relative = path.relative(actualRoot, actual);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'path escaped project');
}

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 synthetic experiment only');

if (process.argv[2] === '--child') {
  assert.equal(process.argv.length, 5);
  const selected = cases.find(item => item.name === process.argv[3]);
  assert(selected, 'fixture is not allowlisted');
  await confined(output);
  const filename = path.join(output, `${selected.name}.node`);
  const bytes = await readFile(filename);
  assert.equal(hash(bytes), process.argv[4], 'fixture changed before load');
  try {
    const result = createRequire(import.meta.url)(filename);
    process.stdout.write(JSON.stringify({ loaded: true, exports: result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ loaded: false, error: { code: error.code, message: error.message } }));
  }
} else {
  assert.equal(process.argv.length, 2, 'no configuration or external native paths accepted');
  await mkdir(output, { recursive: true });
  await confined(output);
  await confined(source);
  await confined(path.dirname(compiler));
  const env = { ...process.env, TEMP: output, TMP: output };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { cwd: output, env, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
  };
  const version = run(compiler, ['-v']);
  assert.equal(version.status, 0, version.stderr);
  const evidence = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'original synthetic native fixtures only; no QQ loading',
    node: { path: process.execPath, version: process.version, arch: process.arch, sha256: hash(await readFile(process.execPath)) },
    compiler: { path: compiler, sha256: hash(await readFile(compiler)), version,
      archiveSha256: hash(await readFile(path.join(root, '.tools', 'tcc-0.9.27-win64-bin.zip'))),
      provenance: 'official historical Savannah archive; hash matches third-party Scoop manifest, not an upstream signature' },
    scriptSha256: hash(await readFile(script)), sourceHashes: {}, headers: {}, cases: [],
    limitations: ['no QQ compatibility proof', 'no IsEnvironmentStopping implementation', 'no C++ ABI or teardown/worker proof', 'DllMain process attach is the tested Windows initialization mechanism'],
  };
  for (const file of ['fixture.h', 'baseline.c', 'delegated.c', 'unregistered.c']) evidence.sourceHashes[file] = hash(await readFile(path.join(source, file)));
  for (const file of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) evidence.headers[file] = hash(await readFile(path.join(include, file)));
  for (const item of cases) {
    const filename = path.join(output, `${item.name}.node`);
    const args = ['-shared', '-I', include, '-I', source, ...(item.define ? [item.define] : []), path.join(source, item.source), '-o', filename];
    const compilation = run(compiler, args);
    assert.equal(compilation.status, 0, `${item.name}: ${compilation.stderr}`);
    const pe = inspectPE(await readFile(filename));
    assert.equal(pe.machine, '0x8664');
    assert.equal(pe.format, 'PE32+');
    const exports = pe.exports.entries.flatMap(entry => entry.names.map(name => name.name));
    if (item.name === 'baseline') assert(exports.includes('napi_register_module_v1'));
    else assert(!exports.includes('napi_register_module_v1'));
    for (const module of [...pe.imports, ...pe.delayImports]) assert(['kernel32.dll', 'msvcrt.dll'].includes(module.module.toLowerCase()), `unexpected import ${module.module}`);
    const processResult = run(process.execPath, [script, '--child', item.name, pe.sha256]);
    assert.equal(processResult.status, 0, JSON.stringify(processResult));
    const observed = JSON.parse(processResult.stdout);
    assert.equal(observed.loaded, item.success);
    if (item.success) assert.deepEqual(observed.exports, { answer: 42, constructorCalls: item.constructors, delegationCalls: item.delegations, route: item.route });
    else {
      assert.equal(observed.error.code, 'ERR_DLOPEN_FAILED');
      assert.match(observed.error.message, /did not self-register/i);
    }
    evidence.cases.push({ name: item.name, expectedSuccess: item.success, passed: true, compilation: { args, ...compilation },
      fixture: { path: filename, sha256: pe.sha256, bytes: pe.fileSize, machine: pe.machine, format: pe.format, exports,
        imports: pe.imports.map(module => ({ module: module.module, symbols: module.symbols })) },
      process: processResult, observed });
  }
  evidence.passed = evidence.cases.every(item => item.passed);
  const target = path.join(root, 'evidence', 'native-registration-win32.json');
  await confined(path.dirname(target));
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: evidence.passed, cases: evidence.cases.map(item => ({ name: item.name, passed: item.passed, observed: item.observed })), evidence: target }, null, 2));
}
