// Original synthetic ARM64 consumers only. No QQ or device operations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const fromRoot = (...parts) => path.join(root, ...parts);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tools = fromRoot('.tools', 'gcc-linux-arm64', 'extracted', 'usr');
const nodeRoot = fromRoot('.tools', 'node-v24.20.0-linux-arm64');
const node = path.join(nodeRoot, 'bin', 'node');
const sysroot = fromRoot('.tools', 'arm64-linux-sysroot', 'usr', 'aarch64-linux-gnu');
const work = fs.mkdtempSync(fromRoot('.tmp', 'native-host-arm64-'));
const nodeDigest = '23a5637c2470fde09fcc1acc77c1b92e04e3d7e3e6e80ff7df6f5831958d1477';
assert.equal(hash(node), nodeDigest);
assert.equal(hash(fromRoot('.tools', 'node-v24.20.0-linux-arm64.tar.xz')),
  '5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7');
assert.equal(hash(path.join(nodeRoot, 'include', 'node', 'config.gypi')),
  '42ee6216f7154ad2b035857a59cb07fa1188599df46c94367e93cc5205bbd7f8');
const pins = JSON.parse(fs.readFileSync(fromRoot('experiments', 'native-host', 'pins.json'), 'utf8'));
for (const [file, digest] of Object.entries(pins.files)) {
  if (file.startsWith('.tools/node-internals-v24.20.0/')) assert.equal(hash(fromRoot(file)), digest, file);
  if (file.startsWith('.tools/node-v24.20.0-linux-x64/include/node/') && !file.endsWith('/config.gypi')) {
    const relative = file.slice('.tools/node-v24.20.0-linux-x64/'.length);
    assert.equal(hash(path.join(nodeRoot, relative)), digest, relative);
  }
}
assert.equal(hash(fromRoot('src/native/node-host.h')), '31cc9885cdf4ff0783419e821af00162c35e77a4e81fa135498f6020572e817d');
assert.equal(hash(fromRoot('experiments/native-host-scope/probe.cc')), '6089f8e43687afc430d231331fe5adce0bc701ccc6d3b59b0f9eca15eb712551');

const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: work };
function run(program, args, compiler = false) {
  const result = spawnSync(program, args, { cwd: work, encoding: 'utf8', timeout: 90000, maxBuffer: 2 ** 20,
    env: compiler ? { ...env, LD_LIBRARY_PATH: [path.join(tools, 'lib', 'x86_64-linux-gnu'),
      fromRoot('.tools/gcc-linux/extracted/usr/lib/x86_64-linux-gnu')].join(':') } : env });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
const arm = args => run('/usr/bin/qemu-aarch64', ['-L', sysroot, node, ...args]);
const version = arm(['-p', '[process.arch,process.version].join(" ")']);
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), 'arm64 v24.20.0');

const compiler = path.join(tools, 'bin', 'aarch64-linux-gnu-g++-14');
const compilerVersion = run(compiler, ['--version'], true);
assert.equal(compilerVersion.status, 0, compilerVersion.stderr);
const headers = fromRoot('.tools', 'node-internals-v24.20.0');
const common = [
  '-B', path.join(tools, 'aarch64-linux-gnu', 'bin') + '/', '-std=gnu++20', '-O2', '-fPIC',
  '-fno-rtti', '-fno-exceptions', '-fno-strict-aliasing', '-fno-use-linker-plugin', '-shared', '-nostdlib',
  '-Wl,-z,noexecstack', '-DNODE_WANT_INTERNALS=1', '-DBUILDING_NODE_EXTENSION=1', '-DHAVE_INSPECTOR=1',
  '-DHAVE_OPENSSL=1', '-DHAVE_SQLITE=1', '-DHAVE_AMARO=1', '-DNODE_USE_V8_PLATFORM=1',
  '-D_GLIBCXX_USE_CXX11_ABI=1', '-D_FILE_OFFSET_BITS=64', '-D__STDC_FORMAT_MACROS', '-DNDEBUG', '-DV8_INTL_SUPPORT',
  '-isystem', path.join(nodeRoot, 'include', 'node'), '-isystem', path.join(headers, 'src'),
  '-isystem', path.join(headers, 'deps', 'v8', 'include'), '-isystem', path.join(headers, 'deps', 'simdjson'),
];
const gccLibrary = path.join(tools, 'lib', 'gcc-cross', 'aarch64-linux-gnu', '14');
const provider = path.join(work, 'libonebot-node-host.so');
const builds = [
  [provider, 'src/native/node-host.cc', [`-Wl,--version-script=${fromRoot('experiments/native-host/exports.map')}`]],
  [path.join(work, 'loader.node'), 'experiments/native-host/bootstrap.cc', [`-DPROVIDER_PATH="${provider}"`]],
  [path.join(work, 'consumer.node'), 'experiments/native-host/consumer.cc', []],
  [path.join(work, 'probe.node'), 'experiments/native-host-scope/probe.cc', []],
];
const artifacts = builds.map(([file, source, options]) => {
  const build = run(compiler, [...common, ...options, path.join(gccLibrary, 'crtbeginS.o'), fromRoot(source),
    path.join(gccLibrary, 'crtendS.o'), '-o', file], true);
  assert.equal(build.status, 0, build.stderr);
  const header = run('/usr/bin/readelf', ['-h', file]);
  assert.equal(header.status, 0, header.stderr);
  assert.match(header.stdout, /Machine:\s+AArch64/);
  return { file: path.relative(root, file), sha256: hash(file), source, sourceSha256: hash(fromRoot(source)) };
});
const symbols = run('/usr/bin/nm', ['-D', '--defined-only', '--format=posix', provider]);
assert.equal(symbols.status, 0, symbols.stderr);
const exported = symbols.stdout.trim().split('\n').map(line => line.split(/\s+/)[0]).sort();
assert.deepEqual(exported, ['_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE', 'qq_magic_napi_register']);

const missing = arm(['-e', 'require("./consumer.node")']);
// A lazy missing symbol in a module constructor can terminate the loader
// with 127, rather than passing an ERR_DLOPEN_FAILED back to JavaScript.
assert([1, 127].includes(missing.status), missing.stderr);
assert.match(missing.stderr, /undefined symbol: (qq_magic_napi_register|_ZN4node21IsEnvironmentStoppingEPN2v87IsolateE)/);
const load = 'require("./loader.node");';
const registration = arm(['-e', load + 'require("./consumer.node").baseline()']);
assert.equal(registration.status, 0, registration.stderr);
const registered = JSON.parse(registration.stdout);
assert.deepEqual(registered, { mode: 'baseline', constructorCalls: 1, before: false, after: false, stopResult: -1 });
const callbacks = [];
for (const stop of [false, true]) {
  const result = arm(['-e', load + `require("./probe.node").start(${stop})`]);
  assert.equal(result.status, stop ? 1 : 0, result.stderr);
  assert.equal(result.stderr, '');
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed, { callback: 'uv_async', sameIsolate: true, inContext: true, before: false,
    after: stop, stopResult: stop ? 0 : -1, nullResult: true, foreignCurrent: false,
    foreignResult: true, threadCreated: 0, threadJoined: 0 });
  callbacks.push(observed);
}
const report = { at: new Date().toISOString(), architecture: 'arm64', execution: 'QEMU user-mode',
  nodeSha256: nodeDigest, compiler: compilerVersion.stdout.split('\n')[0], exported, artifacts,
  missingProviderRejected: true, registered, callbacks, qqExecuted: false, phoneAccessed: false };
fs.writeFileSync(fromRoot('evidence', 'native-host-scope-linux-arm64.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
