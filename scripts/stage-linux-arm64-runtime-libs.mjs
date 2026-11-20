// Downloads authenticated Debian library packages into this workspace only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const cache = path.join(root, '.tools', 'debian-arm64-runtime');
fs.mkdirSync(cache, { recursive: true });
assert.equal(fs.realpathSync(cache), cache);
const work = fs.mkdtempSync(path.join(cache, 'libraries-'));
const config = path.join(work, 'apt.conf');
const overlay = path.join(work, 'lib');
fs.mkdirSync(overlay);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = [
  'libx11-6', 'libx11-xcb1', 'libxext6', 'libxcb1', 'libxau6', 'libxdmcp6',
  'libgssapi-krb5-2', 'libkrb5-3', 'libk5crypto3', 'libkrb5support0', 'libcom-err2', 'libkeyutils1',
  'libgcrypt20', 'libgpg-error0', 'libgnutls30t64', 'libldap2', 'libnettle8t64', 'libhogweed6t64',
  'libpsl5t64', 'libnghttp2-14', 'libidn2-0', 'librtmp1', 'libp11-kit0', 'libtasn1-6', 'libsasl2-2',
  'libunistring5', 'libffi8', 'libsasl2-modules-db', 'libuuid1', 'libgmp10', 'libssl3t64', 'zlib1g', 'libzstd1',
];

function run(command, args, cwd = work) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const sources = path.join(work, 'sources.list');
for (const dir of ['lists', 'cache']) {
  const directory = path.join(cache, dir);
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(fs.realpathSync(directory), directory);
}
const signedBy = '/usr/share/keyrings/debian-archive-keyring.gpg';
fs.writeFileSync(sources, ['debian trixie', 'debian-security trixie-security'].map(line => {
  const [repository, suite] = line.split(' ');
  return `deb [arch=arm64 signed-by=${signedBy}] https://deb.debian.org/${repository} ${suite} main`;
}).join('\n') + '\n', { flag: 'wx' });
const aptPaths = { 'Dir::Etc::sourcelist': sources, 'Dir::State::lists': path.join(cache, 'lists'),
  'Dir::Cache': path.join(cache, 'cache') };
assert(!/["\r\n\\]/.test(cache));
fs.writeFileSync(config, ['APT::Architecture "arm64";', 'APT::Architectures { "arm64"; };',
  'Dir::Etc::sourceparts "-";', 'Acquire::Languages "none";', 'Acquire::IndexTargets::deb::DEP-11::DefaultEnabled "false";',
  ...Object.entries(aptPaths).map(([key, value]) => `${key} "${value}";`)].join('\n') + '\n', { flag: 'wx' });
run('apt-get', ['-c', config, 'update']);

const acquisitions = [];
const priorRuns = fs.readdirSync(cache).filter(name => /^libraries-[A-Za-z0-9]+$/.test(name) && name !== path.basename(work));
for (const name of packages) {
  const target = `${name}:arm64`;
  const policy = run('apt-cache', ['-c', config, 'policy', target]);
  const version = policy.match(/^\s*Candidate:\s+(\S+)/m)?.[1];
  assert(version && version !== '(none)', `No ARM64 candidate for ${name}`);
  const specification = `${target}=${version}`;
  const metadata = run('apt-cache', ['-c', config, 'show', specification]);
  const fields = Object.fromEntries([...metadata.split('\n\n')[0].matchAll(/^([\w-]+): (.*)$/gm)]
    .map(match => [match[1], match[2]]));
  assert.equal(fields.Architecture, 'arm64');
  assert.match(fields.SHA256, /^[a-f0-9]{64}$/);
  const uri = run('apt-get', ['-c', config, '--print-uris', 'download', specification]);
  const source = uri.match(/^'(https:\/\/deb\.debian\.org\/(?:debian|debian-security)\/[^']+)'/m)?.[1];
  assert(source, `Unexpected download source for ${name}`);
  const destination = path.join(work, name);
  fs.mkdirSync(destination);
  let cached = false;
  for (const previous of priorRuns) {
    const directory = path.join(cache, previous, name);
    if (!fs.existsSync(directory) || fs.realpathSync(directory) !== directory) continue;
    const candidate = fs.readdirSync(directory, { withFileTypes: true }).find(entry => entry.isFile() && entry.name.endsWith('.deb'));
    if (!candidate) continue;
    const bytes = fs.readFileSync(path.join(directory, candidate.name));
    if (bytes.length !== Number(fields.Size) || hash(bytes) !== fields.SHA256) continue;
    fs.writeFileSync(path.join(destination, candidate.name), bytes, { flag: 'wx' });
    cached = true;
    break;
  }
  if (!cached) run('apt-get', ['-c', config, 'download', specification], destination);
  const [archive, ...extra] = fs.readdirSync(destination);
  assert(archive?.endsWith('.deb') && extra.length === 0);
  const file = path.join(destination, archive);
  assert.equal(fs.statSync(file).size, Number(fields.Size));
  assert.equal(hash(fs.readFileSync(file)), fields.SHA256);
  const extracted = path.join(destination, 'extracted');
  run('dpkg-deb', ['-x', file, extracted]);
  const staged = [];
  const libraryDirectory = path.join(extracted, 'usr', 'lib', 'aarch64-linux-gnu');
  for (const library of fs.readdirSync(libraryDirectory).sort()) {
    if (!/^lib[A-Za-z0-9_.+-]+\.so(?:\.[0-9]+)+$/.test(library)) continue;
    const input = fs.realpathSync(path.join(libraryDirectory, library));
    assert.equal(path.dirname(input), libraryDirectory);
    const header = run('readelf', ['-h', input]);
    assert.match(header, /Machine:\s+AArch64/);
    const bytes = fs.readFileSync(input);
    fs.writeFileSync(path.join(overlay, library), bytes, { flag: 'wx' });
    staged.push({ name: library, sha256: hash(bytes), bytes: bytes.length });
  }
  acquisitions.push({ package: name, version, source, sha256: fields.SHA256, bytes: Number(fields.Size), staged });
  console.log(`${name} ${version}: ${staged.length} files`);
}
const report = { at: new Date().toISOString(), architecture: 'arm64', overlay: path.relative(root, overlay), acquisitions,
  sourceIndex: 'Debian trixie and trixie-security signed ARM64 indexes', packagesInstalled: false, qqExecuted: false };
fs.writeFileSync(path.join(root, 'evidence', 'linux-arm64-runtime-libraries.json'), JSON.stringify(report, null, 2) + '\n');
