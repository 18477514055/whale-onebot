// Fixed normal Debian libraries + original fixture only; never opens a QQ ELF.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.argv.length, 2);
const script = fileURLToPath(import.meta.url), root = fs.realpathSync(path.resolve(path.dirname(script), '..'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pins = {
  providers: 'e1957c119124024acdf3627f4e64f90bea264953dde4d3d53c67c52fbfc9b300',
  originalDependencies: '7d4984d60802a3a170b7d4b8dd810815a06ff08494889b7e2eee674d0764376f',
  originalAbi: '46c6ba8700c49b703a04ef07207b8ae45c1ccbba5d20179e9aaaf3aaedf7ffab',
  node: '89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7',
};
const pinnedFiles = [
  ['evidence/linux-runtime-providers.json', pins.providers],
  ['evidence/native-dependencies-linux.json', pins.originalDependencies],
  ['evidence/native-abi-linux.json', pins.originalAbi],
];
function checkPins() { for (const [file, expected] of pinnedFiles) assert.equal(hash(path.join(root, file)), expected, file); }
checkPins(); assert.equal(hash(process.execPath), pins.node);
const providers = JSON.parse(fs.readFileSync(path.join(root, pinnedFiles[0][0])));
const isolation = JSON.parse(fs.readFileSync(path.join(root, 'evidence/linux-isolation.json')));
const bwrap = path.join(root, '.tools/bubblewrap/extracted/usr/bin/bwrap');
assert.equal(hash(bwrap), isolation.tool.sha256);
const registration = JSON.parse(fs.readFileSync(path.join(root, 'evidence/native-registration-linux.json')));
const compilerRoot = path.join(root, '.tools/tinycc-linux');
const compiler = path.join(compilerRoot, 'extracted/usr/bin/tcc');
assert.equal(hash(compiler), registration.compiler.sha256);
assert.equal(hash('/usr/bin/ld'), registration.linker.sha256);
const sourceDir = path.join(root, 'experiments/native-provider-libraries-linux');
const source = path.join(sourceDir, 'probe.c'), childScript = path.join(sourceDir, 'child.mjs');
for (const p of [sourceDir, path.join(root, '.tmp'), path.join(root, 'evidence')]) assert.equal(fs.realpathSync(p), p);
const work = fs.mkdtempSync(path.join(root, '.tmp/native-library-probe-'));
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: work };
const commands = [];
function run(executable, args) {
  const r = spawnSync(executable, args, { cwd: work, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  commands.push({ executable, args, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr });
  assert.equal(r.status, 0, `${executable}: ${r.stderr || r.error?.message}`); return r.stdout;
}
const byId = new Map(providers.modules.map(m => [m.id, m]));
assert.equal(providers.modules.length, 29);
assert.deepEqual(providers.summary.newClosureMissingNeeded, []);
assert.deepEqual(providers.summary.newClosureVersionFailures, []);
const mountTarget = name => '/lib/x86_64-linux-gnu/' + name;
const supplemental = providers.modules.map(m => {
  assert.match(m.soname, /^[A-Za-z0-9_.+-]+$/);
  const canonical = fs.realpathSync(m.path);
  assert(canonical.startsWith(root + '/.tools/linux-runtime-deps/packages/') || canonical.startsWith('/usr/lib/x86_64-linux-gnu/'));
  assert.equal(hash(canonical), m.sha256, m.id); assert.equal(fs.statSync(canonical).size, m.bytes);
  return { source: canonical, target: mountTarget(m.soname), sha256: m.sha256, module: m.id };
});
assert.equal(new Set(supplemental.map(m => m.target)).size, supplemental.length);
for (const m of providers.modules) for (const soname of m.needed) assert(supplemental.some(p => p.target === mountTarget(soname)));
const roots = providers.directProviders.map(p => { const m = byId.get(p.module); assert.equal(m.soname, p.requested); return m; });
assert.equal(roots.length, 12);
const requirements = [
  ...providers.bugly.symbols.map(s => ({ ...s, group: 'bugly' })),
  ...providers.otherPriorMatches.flatMap(m => m.supplementalMatches.map(s => ({ ...s, group: m.module === 'module-01' ? 'x11' : 'gcrypt' }))),
].map(s => {
  assert.equal(s.supplementalProviders.length, 1);
  const candidate = s.supplementalProviders[0], m = byId.get(candidate.module);
  assert(['FUNC', 'OBJECT'].includes(candidate.type));
  assert.match(s.baseName, /^[A-Za-z0-9_]+$/);
  const version = s.name.includes('@') ? s.name.split('@').pop() : '';
  assert.match(version, /^[A-Za-z0-9_.]*$/);
  const library = roots.findIndex(r => r.id === m.id); assert(library >= 0);
  return { name: s.baseName, version, group: s.group, library, expectedOwner: mountTarget(m.soname), type: candidate.type, providerDefinition: candidate.name };
});
assert.equal(requirements.length, 177); assert.equal(new Set(requirements.map(s => s.name)).size, 177);
assert.deepEqual(Object.fromEntries(['bugly', 'x11', 'gcrypt'].map(g => [g, requirements.filter(s => s.group === g).length])), { bugly: 125, x11: 19, gcrypt: 33 });
assert.equal(requirements.find(s => s.name === 'gnutls_free').type, 'OBJECT');
const header = '#define LIBRARY_COUNT 12\n#define TARGET_COUNT 177\n' +
  'static const char *library_paths[] = {\n' + roots.map(m => JSON.stringify(mountTarget(m.soname))).join(',\n') + '\n};\n' +
  'struct target { const char *name; const char *version; unsigned library; };\nstatic const struct target targets[] = {\n' +
  requirements.map(s => `{${JSON.stringify(s.name)},${JSON.stringify(s.version)},${s.library}}`).join(',\n') + '\n};\n';
fs.writeFileSync(path.join(work, 'target-table.h'), header, { flag: 'wx' });
const include = path.join(root, '.tools/node-v24.20.0-linux-x64/include/node');
for (const [file, expected] of Object.entries(registration.headers)) assert.equal(hash(path.join(include, file)), expected);
const fixture = path.join(work, 'probe.node');
run(compiler, ['-B', path.join(compilerRoot, 'extracted/usr/lib/x86_64-linux-gnu/tcc'), '-c', '-nostdlib',
  '-I', include, '-I', work, '-I', path.join(compilerRoot, 'libc-headers/usr/include'),
  '-I', path.join(compilerRoot, 'libc-headers/usr/include/x86_64-linux-gnu'), source, '-o', path.join(work, 'probe.o')]);
run('/usr/bin/ld', ['-shared', '-z', 'noexecstack', '-o', fixture, path.join(work, 'probe.o')]);
const fixtureInspection = run('/usr/bin/readelf', ['--dynamic', '--wide', fixture]);
assert(!fixtureInspection.includes('(NEEDED)'));
// Build a minimal explicit base from GNU DT_NEEDED and the read-only loader cache.
// No entire host library directory is mounted and no ldd is used.
const cache = run('/sbin/ldconfig', ['-p']);
const cacheMap = new Map([...cache.matchAll(/^\s*(\S+)\s+\([^)]*x86-64[^)]*\)\s+=>\s+(\/\S+)/gm)].map(m => [m[1], m[2]]));
const base = new Map();
const queue = [process.execPath];
for (let i = 0; i < queue.length; i++) {
  const raw = run('/usr/bin/readelf', ['--dynamic', '--wide', queue[i]]);
  for (const match of raw.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)) {
    const soname = match[1]; if (base.has(soname)) continue;
    assert.match(soname, /^[A-Za-z0-9_.+-]+$/);
    const source = fs.realpathSync(cacheMap.get(soname)); assert(source.startsWith('/usr/lib/x86_64-linux-gnu/'));
    const item = { source, target: mountTarget(soname), sha256: hash(source), module: 'node-baseline' };
    base.set(soname, item); queue.push(source);
  }
}
assert(base.has('ld-linux-x86-64.so.2'));
assert(roots.every(r => !base.has(r.soname)), 'baseline accidentally includes a target library');
const baseline = [...base.values()];
const full = [...baseline];
for (const m of supplemental) {
  const duplicate = full.find(p => p.target === m.target);
  if (duplicate) assert.equal(duplicate.sha256, m.sha256); else full.push(m);
}
const namespaces = Object.fromEntries(['user', 'net', 'mnt', 'pid', 'ipc'].map(n => [n, fs.readlinkSync('/proc/self/ns/' + n)]));
const canary = path.join(work, 'unmounted-canary.txt'); fs.writeFileSync(canary, 'synthetic-host-canary', { flag: 'wx' });
let connections = 0;
const server = net.createServer(socket => { connections++; socket.end(); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve, reject) => { const s = net.createConnection({ host: '127.0.0.1', port }); s.on('connect', () => { s.end(); resolve(); }); s.on('error', reject); });
const cases = [];
try {
  for (const [mode, mounts] of [['no-supplemental-libraries', baseline], ['all-normal-providers', full]]) {
    const directory = path.join(work, mode); fs.mkdirSync(directory);
    const output = path.join(directory, 'output'); fs.mkdirSync(output);
    const manifest = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ mode, fixtureSha256: hash(fixture), mounts }, null, 2), { flag: 'wx' });
    const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv',
      ...mounts.flatMap(m => ['--ro-bind', m.source, m.target]),
      '--symlink', mountTarget('ld-linux-x86-64.so.2'), '/lib64/ld-linux-x86-64.so.2',
      '--ro-bind', process.execPath, '/bin/node', '--ro-bind', childScript, '/input/child.mjs', '--ro-bind', fixture, '/input/probe.node', '--ro-bind', manifest, '/input/manifest.json',
      '--bind', output, '/output', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--setenv', 'HOME', '/output', '--setenv', 'XDG_CONFIG_HOME', '/output/config', '--setenv', 'XDG_CACHE_HOME', '/output/cache', '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'CANARY_PATH', canary, '--setenv', 'PROBE_PORT', String(port),
      '--chdir', '/output', '--remount-ro', '/', '/bin/node', '/input/child.mjs'];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(bwrap, args, { cwd: work, env: { ...env, WHALE_SYNTHETIC_SECRET: 'synthetic-only' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.stdout.on('data', d => { stdout += d; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', d => { stderr += d; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
    });
    assert.equal(result.status, 0, JSON.stringify(result)); assert.equal(result.signal, null);
    const observed = JSON.parse(result.stdout); assert.equal(observed.mode, mode);
    for (const n of Object.keys(namespaces)) assert.notEqual(observed.namespaces[n], namespaces[n]);
    assert.equal(observed.observed.targetCalls, 0);
    assert(Object.values(observed.observed.controls).every(Boolean));
    assert.equal(observed.observed.symbols.length, requirements.length);
    assert.equal(observed.observed.libraries.length, roots.length);
    const positive = mode === 'all-normal-providers';
    for (const m of observed.observed.libraries) assert.equal(m.loaded, positive, JSON.stringify(m));
    for (let i = 0; i < requirements.length; i++) {
      const expected = requirements[i], actual = observed.observed.symbols[i];
      assert.equal(actual.name, expected.name); assert.equal(actual.version, expected.version);
      assert.equal(actual.resolved, positive, JSON.stringify(actual));
      if (positive) {
        assert.equal(actual.owner, expected.expectedOwner); assert.equal(actual.sameAsProviderHandle, true);
        assert.equal(actual.runtimeElfType, expected.type === 'OBJECT' ? 1 : 2);
      }
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'completed.json'))), { mode, targetCalls: 0 });
    cases.push({ mode, args, mounts, manifestSha256: hash(manifest), process: result, observed, passed: true });
  }
} finally { await new Promise(resolve => server.close(resolve)); }
assert.equal(connections, 1); assert.equal(fs.readFileSync(canary, 'utf8'), 'synthetic-host-canary'); checkPins();
for (const m of full) assert.equal(hash(m.source), m.sha256);
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), scope: 'Normal Debian shared libraries and original synthetic Node fixture only; no QQ binary loaded or mounted',
  pins, node: { path: process.execPath, sha256: hash(process.execPath), version: process.version },
  bwrap: { path: bwrap, sha256: hash(bwrap), referenceEvidenceSha256: hash(path.join(root, 'evidence/linux-isolation.json')) },
  sources: { runner: hash(script), probe: hash(source), child: hash(childScript), generatedHeader: hash(path.join(work, 'target-table.h')) },
  compiler: { path: compiler, sha256: hash(compiler) }, linker: { path: '/usr/bin/ld', sha256: hash('/usr/bin/ld') },
  fixture: { path: fixture, sha256: hash(fixture), bytes: fs.statSync(fixture).size }, work, commands, requirements,
  cases, parentNamespaces: namespaces, hostPositiveConnections: connections, canaryUnchanged: true,
  summary: { normalLibraryRoots: 12, supplementalClosureFiles: supplemental.length, baselineFiles: baseline.length, positiveMountedLibraryFiles: full.length,
    negativeLoaded: 0, negativeResolved: 0, positiveLoaded: 12, positiveResolved: 177, groups: { bugly: 125, x11: 19, gcrypt: 33 }, targetCalls: 0 },
  limitations: ['No QQ wrapper, libbugly, main executable or account data mounted or executed.', 'Normal library constructors and linker relocations execute; only unknown target calls are excluded.',
    'Successful lookup does not prove QQ load order, symbol interposition, function/structure ABI or login/session behavior.', 'This explicit synthetic sandbox is not a complete hostile-code containment proof.',
    'Paths and hashes are checked before and after; concurrent malicious host file replacement is outside this experiment.'] };
const destination = path.join(root, 'evidence/native-library-provider-probe-linux.json');
if (fs.existsSync(destination)) { assert.equal(fs.realpathSync(destination), destination); assert.equal(fs.statSync(destination).nlink, 1); }
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, summary: report.summary, evidence: destination }, null, 2));
