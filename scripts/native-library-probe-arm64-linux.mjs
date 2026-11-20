// Dynamic verification of fixed Debian libraries with the original probe only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.argv.length, 2);
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const local = (...parts) => path.join(root, ...parts);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function pinned(file, digest) {
  assert.equal(hash(file), digest, file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const libraries = pinned(local('evidence/linux-arm64-runtime-libraries.json'),
  '16ff959c0d7377fa19b775da26e033f3322c7b151e5b23595ecd2f26e1569a24');
const audit = pinned(local('evidence/native-dependencies-linux-arm64-supplemental.json'),
  '2ef8830bdf197ab2a673eec0e6f709de1eb69c86be719366ca7fdbe8bc6c425e');
const node = local('.tools/node-v24.20.0-linux-arm64/bin/node');
const bwrap = local('.tools/bubblewrap/extracted/usr/bin/bwrap');
assert.equal(hash(node), '23a5637c2470fde09fcc1acc77c1b92e04e3d7e3e6e80ff7df6f5831958d1477');
assert.equal(hash(bwrap), '573236e5328ac2ebb08f59ae3a9805b4f8d12bdef14be8af4450d5463294985f');
const qemu = '/usr/bin/qemu-aarch64';
const work = fs.mkdtempSync(local('.tmp/native-library-arm64-'));
const tools = local('.tools/gcc-linux-arm64/extracted/usr');
function run(program, args, compiler = false) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: work };
  if (compiler) env.LD_LIBRARY_PATH = [path.join(tools, 'lib/x86_64-linux-gnu'),
    local('.tools/gcc-linux/extracted/usr/lib/x86_64-linux-gnu')].join(':');
  const result = spawnSync(program, args, { cwd: work, env, encoding: 'utf8', timeout: 60000, maxBuffer: 2 ** 20 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
assert.doesNotMatch(run('readelf', ['-l', qemu]), /Requesting program interpreter/);
const overlay = local(libraries.overlay);
const extras = Object.fromEntries(libraries.acquisitions.flatMap(({ staged }) => staged.map(item => [item.name, item])));
assert.deepEqual(fs.readdirSync(overlay).sort(), Object.keys(extras).sort());
for (const file of Object.values(extras)) {
  const source = path.join(overlay, file.name);
  assert.equal(fs.realpathSync(source), source);
  assert.equal(fs.statSync(source).size, file.bytes);
  assert.equal(hash(source), file.sha256);
}
const targets = [];
for (const symbol of audit.supplementalSymbolCandidates.symbols) {
  if (!symbol.providers.length) continue;
  const provider = symbol.providers.find(({ file }) => /\.so\.\d+$/.test(file));
  assert(provider && Object.hasOwn(extras, provider.file));
  const [name, version = ''] = symbol.name.split('@');
  assert.match(name, /^[A-Za-z0-9_]+$/);
  assert.match(version, /^[A-Za-z0-9_.]*$/);
  targets.push({ name, version, file: provider.file });
}
assert.equal(targets.length, 126);
const names = [...new Set([...targets.map(target => target.file), 'libX11.so.6', 'libX11-xcb.so.1',
  'libXext.so.6', 'libgssapi_krb5.so.2', 'libgcrypt.so.20'])].sort();
assert(names.every(name => Object.hasOwn(extras, name)));
const guestPath = name => `/lib/aarch64-linux-gnu/${name}`;
const table = `#define LIBRARY_COUNT ${names.length}\n#define TARGET_COUNT ${targets.length}\n` +
  `static const char *library_paths[] = {${names.map(name => JSON.stringify(guestPath(name))).join(',')}};\n` +
  'struct target { const char *name; const char *version; unsigned library; };\n' +
  `static const struct target targets[] = {${targets.map(({ name, version, file }) =>
    `{${JSON.stringify(name)},${JSON.stringify(version)},${names.indexOf(file)}}`).join(',')}};\n`;
fs.writeFileSync(path.join(work, 'target-table.h'), table, { flag: 'wx' });
const fixture = path.join(work, 'probe.node');
run(path.join(tools, 'bin/aarch64-linux-gnu-g++-14'), ['-B', path.join(tools, 'aarch64-linux-gnu/bin') + '/',
  '-x', 'c', '-fPIC', '-shared', '-nostdlib', '-Wl,-z,noexecstack', '-I', work,
  '-I', local('.tools/node-v24.20.0-linux-arm64/include/node'),
  local('experiments/native-provider-libraries-linux/probe.c'), '-o', fixture], true);
assert.match(run('readelf', ['-h', fixture]), /Machine:\s+AArch64/);
assert.doesNotMatch(run('readelf', ['-d', fixture]), /\(NEEDED\)/);
const sysroot = local('.tools/arm64-linux-sysroot/usr/aarch64-linux-gnu/lib');
const base = fs.readdirSync(sysroot).filter(name => /^(?:ld-|lib)[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)*$/.test(name));
const baseMounts = base.map(name => {
  const file = fs.realpathSync(path.join(sysroot, name));
  assert.equal(path.dirname(file), sysroot);
  assert(!Object.hasOwn(extras, name));
  return [file, guestPath(name)];
});
const positiveMounts = Object.keys(extras).map(name => [path.join(overlay, name), guestPath(name)]);
const cases = {};
for (const [mode, added] of [['baseline', []], ['supplemental', positiveMounts]]) {
  const mounts = [[qemu, '/bin/qemu'], [node, '/bin/node'], [fixture, '/input/probe.node'], ...baseMounts, ...added];
  const result = JSON.parse(run(bwrap, ['--unshare-all', '--unshare-user', '--disable-userns', '--cap-drop', 'ALL',
    '--die-with-parent', '--clearenv', '--setenv', 'LANG', 'C', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ...mounts.flatMap(([source, destination]) => ['--ro-bind', source, destination]),
    '--symlink', guestPath('ld-linux-aarch64.so.1'), '/lib/ld-linux-aarch64.so.1',
    '--remount-ro', '/', '--chdir', '/tmp', '/bin/qemu', '/bin/node', '-e',
    'require("node:assert/strict").equal(process.arch,"arm64");console.log(JSON.stringify(require("/input/probe.node").run()))']));
  const enabled = mode === 'supplemental';
  assert.equal(result.targetCalls, 0);
  assert.deepEqual(result.controls, { missingNameRejected: true, wrongVersionRejected: true });
  assert.deepEqual(result.libraries.map(item => item.path), names.map(guestPath));
  for (const item of result.libraries) assert.equal(item.loaded, enabled, item.error);
  assert.equal(result.symbols.length, targets.length);
  for (const [index, item] of result.symbols.entries()) {
    const target = targets[index];
    assert.equal(item.name, target.name);
    assert.equal(item.version, target.version);
    assert.equal(item.resolved, enabled, item.error);
    if (enabled) {
      assert.equal(item.sameAsProviderHandle, true);
      assert.equal(item.owner, guestPath(target.file));
    }
  }
  cases[mode] = { librariesLoaded: result.libraries.filter(item => item.loaded).length,
    symbolsResolved: result.symbols.filter(item => item.resolved).length, targetCalls: result.targetCalls,
    controls: result.controls };
  if (enabled) cases[mode].resolvedSymbols = result.symbols.map(({ name, version, owner, runtimeElfType }) =>
    ({ name, version, owner, runtimeElfType }));
}
const report = { at: new Date().toISOString(), architecture: 'arm64', execution: 'QEMU under network-isolated Bubblewrap',
  providerFileCount: names.length, checks: targets.length, fixtureSha256: hash(fixture),
  inputs: { librariesSha256: hash(local('evidence/linux-arm64-runtime-libraries.json')),
    symbolAuditSha256: hash(local('evidence/native-dependencies-linux-arm64-supplemental.json')),
    nodeSha256: hash(node), qemuSha256: hash(qemu), bwrapSha256: hash(bwrap) }, cases,
  phoneAccessed: false, qqExecuted: false };
fs.writeFileSync(local('evidence/native-library-probe-linux-arm64.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
