// Original static supplemental dependency audit. Never dlopen, ldd, execute QQ,
// install packages or run maintainer scripts. Downloads normal Debian libraries.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux');
const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const work = path.join(root, '.tools/linux-runtime-deps');
const rawDir = path.join(work, 'raw');
fs.mkdirSync(rawDir, { recursive: true });
assert.equal(fs.realpathSync(work), work);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = filename => digest(fs.readFileSync(filename));
const commands = [];
function run(executable, args, cwd = work) {
  const env = { ...process.env, LC_ALL: 'C' };
  for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_DEBUG_OUTPUT']) delete env[key];
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  commands.push({ executable, args, cwd, status: result.status, signal: result.signal,
    stdoutSha256: digest(result.stdout ?? ''), stderr: result.stderr ?? '' });
  assert.equal(result.status, 0, `${executable}: ${result.stderr ?? result.error?.message}`);
  return result.stdout;
}
const originalFile = path.join(root, 'evidence/native-dependencies-linux.json');
const original = JSON.parse(fs.readFileSync(originalFile));
const originalSha256 = hashFile(originalFile);
const cacheRaw = run('/sbin/ldconfig', ['-p']);
fs.writeFileSync(path.join(rawDir, 'ldconfig.txt'), cacheRaw);
const system = new Map();
for (const line of cacheRaw.split('\n')) {
  const match = line.match(/^\s*(\S+)\s+\([^)]*x86-64[^)]*\)\s+=>\s+(\/\S+)/);
  if (match && /^\/(?:usr\/)?lib(?:64)?\//.test(match[2])) system.set(match[1], match[2]);
}
const packageBySoname = {
  'libX11.so.6': 'libx11-6', 'libX11-xcb.so.1': 'libx11-xcb1', 'libXext.so.6': 'libxext6',
  'libgcrypt.so.20': 'libgcrypt20', 'libgnutls.so.30': 'libgnutls30t64', 'libldap.so.2': 'libldap2',
  'liblber.so.2': 'libldap2', 'libpsl.so.5': 'libpsl5t64', 'libnghttp2.so.14': 'libnghttp2-14',
  'librtmp.so.1': 'librtmp1', 'libnettle.so.8': 'libnettle8t64', 'libidn2.so.0': 'libidn2-0',
  'libxcb.so.1': 'libxcb1', 'libXau.so.6': 'libxau6', 'libXdmcp.so.6': 'libxdmcp6',
  'libgpg-error.so.0': 'libgpg-error0', 'libp11-kit.so.0': 'libp11-kit0', 'libtasn1.so.6': 'libtasn1-6',
  'libsasl2.so.2': 'libsasl2-2', 'libffi.so.8': 'libffi8', 'libunistring.so.5': 'libunistring5',
  'libhogweed.so.6': 'libhogweed6t64', 'libgmp.so.10': 'libgmp10', 'libbsd.so.0': 'libbsd0', 'libmd.so.0': 'libmd0',
};
const directNames = Object.keys(packageBySoname).slice(0, 12);
const acquisitions = [];
const acquiredPackages = new Set();
const modules = new Map();
const overlay = new Map();

function compatible(required, provided) {
  if (required.split('@')[0] !== provided.split('@')[0]) return false;
  if (required.includes('@')) return required.split('@').pop() === provided.split('@').pop();
  return !provided.includes('@') || provided.includes('@@');
}
// Positive and negative controls for version matching, before inspecting data.
assert(compatible('symbol', 'symbol@@A'));
assert(compatible('symbol@A', 'symbol@@A'));
assert(!compatible('symbol', 'symbol@A'));
assert(!compatible('symbol@A', 'symbol@@B'));
assert(!compatible('symbol@A', 'other@@A'));

function inspect(filename, origin) {
  const canonical = fs.realpathSync(filename);
  if (modules.has(canonical)) return modules.get(canonical);
  const raw = run('/usr/bin/readelf', ['--file-header', '--dynamic', '--dyn-syms', '--version-info', '--wide', canonical]);
  assert.match(raw, /Class:\s+ELF64/); assert.match(raw, /Machine:\s+Advanced Micro Devices X86-64/);
  const declared = Number(raw.match(/Symbol table '\.dynsym' contains (\d+) entries:/)?.[1]);
  const symbols = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+):\s+([0-9a-fA-F]+)\s+(\S+)\s+(.+?)\s+(GLOBAL|LOCAL|WEAK|UNIQUE|<OS specific>:\s+\d+)\s+(DEFAULT|INTERNAL|HIDDEN|PROTECTED)\s+(\S+)(?:\s+(\S+))?/);
    if (m) symbols.push({ index: +m[1], type: m[4], binding: m[5], visibility: m[6], section: m[7], name: m[8] ?? '', baseName: (m[8] ?? '').split('@')[0] });
  }
  assert(declared > 0); assert.equal(symbols.length, declared, 'incomplete dynamic symbol parser');
  const versionNeeds = []; const versionDefinitions = []; let section = ''; let current;
  for (const line of raw.split('\n')) {
    if (line.startsWith('Version needs section')) section = 'needs';
    if (line.startsWith('Version definition section')) section = 'definitions';
    if (line.startsWith('Version symbols section')) section = 'symbols';
    if (section === 'needs') {
      const m = line.match(/File:\s+(\S+)\s+Cnt:/); if (m) { current = { file: m[1], versions: [] }; versionNeeds.push(current); }
      const v = line.match(/Name:\s+(\S+)\s+Flags:/); if (v && current) current.versions.push(v[1]);
    } else if (section === 'definitions') { const v = line.match(/Name:\s+(\S+)/); if (v) versionDefinitions.push(v[1]); }
  }
  const id = `provider-${String(modules.size).padStart(2, '0')}`;
  const rawPath = path.join(rawDir, `${id}.readelf.txt`); fs.writeFileSync(rawPath, raw);
  const value = { id, path: canonical, origin, sha256: hashFile(canonical), bytes: fs.statSync(canonical).size,
    soname: raw.match(/\(SONAME\).*?\[([^\]]+)\]/)?.[1] ?? null,
    needed: [...raw.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(m => m[1]),
    versionNeeds, versionDefinitions, symbols, symbolCount: symbols.length,
    rawEvidence: path.relative(root, rawPath), rawSha256: digest(raw) };
  modules.set(canonical, value); return value;
}

function acquire(packageName) {
  if (acquiredPackages.has(packageName)) return;
  const policy = run('/usr/bin/apt-cache', ['policy', packageName]);
  const version = policy.match(/^\s*Candidate:\s+(\S+)/m)?.[1]; assert(version && version !== '(none)');
  const metadata = run('/usr/bin/apt-cache', ['show', `${packageName}=${version}`]);
  const paragraph = metadata.trim().split(/\n\n/).find(s => s.startsWith(`Package: ${packageName}\n`)); assert(paragraph);
  const fields = Object.fromEntries([...paragraph.matchAll(/^([\w-]+): (.*)$/gm)].map(m => [m[1], m[2]]));
  assert.equal(fields.Version, version); assert(['amd64', 'all'].includes(fields.Architecture));
  assert.match(fields.SHA256, /^[a-f0-9]{64}$/); const expectedSize = Number(fields.Size);
  assert(expectedSize > 0 && expectedSize < 6 * 1024 * 1024, 'unexpected package size');
  assert(acquisitions.reduce((n, p) => n + p.bytes, 0) + expectedSize < 25 * 1024 * 1024, 'download budget exceeded');
  const uriRaw = run('/usr/bin/apt-get', ['--print-uris', 'download', `${packageName}=${version}`]);
  const source = uriRaw.match(/^'(https:\/\/(?:deb\.debian\.org|security\.debian\.org)\/[^']+)'/m)?.[1];
  assert(source, 'download must use an explicitly recognized official Debian HTTPS host');
  const directory = path.join(work, 'packages', `${packageName}-${fields.SHA256.slice(0, 12)}`);
  fs.mkdirSync(directory, { recursive: true }); assert.equal(fs.realpathSync(directory), directory);
  fs.writeFileSync(path.join(directory, 'apt-metadata.txt'), metadata);
  fs.writeFileSync(path.join(directory, 'apt-policy.txt'), policy);
  fs.writeFileSync(path.join(directory, 'apt-download-uri.txt'), uriRaw);
  let debs = fs.readdirSync(directory).filter(x => x.endsWith('.deb'));
  if (!debs.length) { console.log(`Downloading ${packageName} ${version} (${expectedSize} bytes)`); run('/usr/bin/apt', ['download', `${packageName}=${version}`], directory); debs = fs.readdirSync(directory).filter(x => x.endsWith('.deb')); }
  assert.equal(debs.length, 1);
  const archive = path.join(directory, debs[0]); assert.equal(fs.statSync(archive).size, expectedSize); assert.equal(hashFile(archive), fields.SHA256);
  const inventory = run('/usr/bin/dpkg-deb', ['--contents', archive]);
  fs.writeFileSync(path.join(directory, 'contents.txt'), inventory);
  for (const line of inventory.split('\n').filter(Boolean)) {
    const member = line.match(/\s(\.\/[^\n]*?)(?: -> .*| link to .*|$)/)?.[1];
    assert(member && !member.split('/').includes('..'), 'unsafe archive member');
  }
  const extracted = path.join(directory, 'extracted'); fs.mkdirSync(extracted, { recursive: true });
  assert.equal(fs.realpathSync(extracted), extracted);
  run('/usr/bin/dpkg-deb', ['-x', archive, extracted]);
  const acquisition = { package: packageName, version, architecture: fields.Architecture, source,
    bytes: expectedSize, sha256: fields.SHA256, expectedDigestSource: 'existing local apt index; no apt update',
    archive, extracted, metadataSha256: digest(metadata), inventorySha256: digest(inventory), installed: false, maintainerScriptsExecuted: false };
  acquisitions.push(acquisition); acquiredPackages.add(packageName);
  fs.writeFileSync(path.join(work, 'acquisitions.json'), JSON.stringify(acquisitions, null, 2));
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && /\.so(?:\.|$)/.test(entry.name)) {
        const fd = fs.openSync(filename, 'r'); const signature = Buffer.alloc(4); fs.readSync(fd, signature, 0, 4, 0); fs.closeSync(fd);
        if (signature.toString('hex') !== '7f454c46') continue;
        const module = inspect(filename, { kind: 'verified-Debian-package', package: packageName, version });
        if (module.soname) { assert(!overlay.has(module.soname), `duplicate overlay SONAME ${module.soname}`); overlay.set(module.soname, module); }
      }
    }
  }
  walk(extracted);
}

function resolve(soname) {
  if (overlay.has(soname)) return overlay.get(soname);
  if (system.has(soname)) return inspect(system.get(soname), { kind: 'current-system-ldconfig' });
  if (packageBySoname[soname]) { acquire(packageBySoname[soname]); return overlay.get(soname) ?? null; }
  return null;
}

const directProviders = directNames.map(soname => ({ requested: soname, module: resolve(soname)?.id ?? null }));
const edges = []; const visited = new Set(); const queue = [...modules.values()];
for (let index = 0; index < queue.length; index++) {
  const module = queue[index]; if (visited.has(module.path)) continue; visited.add(module.path);
  for (const soname of module.needed) {
    const target = resolve(soname);
    const requiredVersions = module.versionNeeds.find(x => x.file === soname)?.versions ?? [];
    edges.push({ from: module.id, soname, to: target?.id ?? null, requiredVersions,
      missingVersions: target ? requiredVersions.filter(v => !target.versionDefinitions.includes(v)) : requiredVersions,
      interpretation: 'hypothetical declared-dependency closure, not an installed or loaded search scope' });
  }
  for (const candidate of modules.values()) if (!visited.has(candidate.path) && !queue.includes(candidate)) queue.push(candidate);
}
const exports = [...modules.values()].flatMap(module => module.symbols.filter(symbol => symbol.name && symbol.section !== 'UND' && ['GLOBAL', 'WEAK', 'UNIQUE'].includes(symbol.binding) && ['DEFAULT', 'PROTECTED'].includes(symbol.visibility)).map(symbol => ({ module: module.id, ...symbol })));
function match(requirement) {
  const sameName = exports.filter(s => s.baseName === requirement.baseName);
  return { ...requirement,
    supplementalProviders: sameName.filter(s => compatible(requirement.name, s.name)).map(s => ({ module: s.module, name: s.name, type: s.type, binding: s.binding })),
    versionMismatchedCandidates: sameName.filter(s => !compatible(requirement.name, s.name)).map(s => ({ module: s.module, name: s.name })) };
}
const bugly = original.comparisons.find(c => c.unresolvedStrong.length === 125 && original.modules.find(m => m.id === c.module)?.path.endsWith('/app/libbugly.so'));
assert(bugly, 'prior Bugly requirement set changed');
const buglyMatches = bugly.unresolvedStrong.map(match);
const missingNeeded = original.coverage.missingNeeded.map(edge => {
  const consumer = original.modules.find(m => m.id === edge.consumer);
  const target = resolve(edge.name);
  const versions = consumer.versionNeeds.find(x => x.file === edge.name)?.versions ?? [];
  return { ...edge, provider: target?.id ?? null, requiredVersions: versions,
    missingVersions: target ? versions.filter(v => !target.versionDefinitions.includes(v)) : versions };
});
const otherPriorMatches = original.comparisons.filter(c => c.module !== bugly.module).map(c => ({
  module: c.module, supplementalMatches: c.unresolvedStrong.map(match).filter(s => s.supplementalProviders.length),
})).filter(c => c.supplementalMatches.length);
const providerUndefined = [...modules.values()].map(module => ({ module: module.id,
  unresolvedStrong: module.symbols.filter(s => s.name && s.section === 'UND' && s.binding !== 'WEAK').map(match).filter(s => !s.supplementalProviders.length),
  unresolvedWeak: module.symbols.filter(s => s.name && s.section === 'UND' && s.binding === 'WEAK').map(match).filter(s => !s.supplementalProviders.length) }));
const nmChecks = [];
for (const { module: id } of directProviders) {
  if (!id || nmChecks.some(x => x.module === id)) continue;
  const module = [...modules.values()].find(m => m.id === id);
  const raw = run('/usr/bin/nm', ['-D', '--defined-only', '--format=posix', module.path]);
  const names = new Set(raw.split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]));
  const requirements = [...buglyMatches, ...otherPriorMatches.flatMap(x => x.supplementalMatches)]
    .flatMap(x => x.supplementalProviders).filter(x => x.module === id);
  assert(requirements.every(x => names.has(x.name)), 'readelf provider name not corroborated by nm');
  fs.writeFileSync(path.join(rawDir, `${id}.nm.txt`), raw);
  nmChecks.push({ module: id, checkedRequiredDefinitions: requirements.length,
    allConfirmed: requirements.length ? true : null, rawSha256: digest(raw) });
}
assert.equal(hashFile(originalFile), originalSha256, 'original dependency evidence was changed');
const report = { schemaVersion: 1, observedAt: new Date().toISOString(), mode: 'static-only-normal-library-provider-audit',
  sourceEvidence: { path: originalFile, sha256: originalSha256 }, acquisitions, totalDownloadedBytes: acquisitions.reduce((n, p) => n + p.bytes, 0),
  directProviders, missingNeeded, modules: [...modules.values()].map(({ symbols, ...module }) => module), edges,
  bugly: { module: bugly.module, requiredCount: buglyMatches.length, matchedCount: buglyMatches.filter(x => x.supplementalProviders.length).length,
    symbols: buglyMatches, addedToOriginalRuntimeScope: false }, otherPriorMatches, providerUndefined, nmChecks,
  summary: { missingNeededProvidersFound: missingNeeded.filter(x => x.provider).length,
    missingNeededVersionFailures: missingNeeded.filter(x => x.missingVersions.length).length,
    newClosureMissingNeeded: edges.filter(x => !x.to), newClosureVersionFailures: edges.filter(x => x.to && x.missingVersions.length),
    newClosureUnmatchedStrong: providerUndefined.reduce((n, x) => n + x.unresolvedStrong.length, 0),
    newClosureUnmatchedWeak: providerUndefined.reduce((n, x) => n + x.unresolvedWeak.length, 0) },
  versionMatchingControls: { cases: 5, passed: true, rule: 'exact base name; versioned reference requires exact version; unversioned reference accepts unversioned or default @@ only' },
  commands, limitations: ['No target/native loading, ldd, installation, maintainer scripts, preload or QQ execution.',
    'Supplemental Bugly providers are available normal libraries, not automatically in the original Node lookup scope.',
    'Static export/version matching does not establish lookup order, interposition, IFUNC behavior or function/struct ABI.',
    'Private LDAP names and unversioned symbols retain compatibility uncertainty.',
    'No wifiphoto stubs or workaround libraries are created; those unresolved requirements remain.'] };
fs.writeFileSync(path.join(root, 'evidence/linux-runtime-providers.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ packages: acquisitions.length, bytes: report.totalDownloadedBytes, modules: modules.size,
  buglyRequired: report.bugly.requiredCount, buglyMatched: report.bugly.matchedCount, summary: report.summary }, null, 2));
