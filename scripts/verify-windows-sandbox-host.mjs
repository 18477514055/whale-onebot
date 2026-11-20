import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

assert.equal(process.platform, 'win32');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
function read(file, max = 150 * 1024 * 1024) {
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && stat.nlink === 1 && stat.size <= max);
  return fs.readFileSync(file);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const kit = JSON.parse(read(path.join(root, 'evidence', 'windows-sandbox-host-kit.json'), 32768));
const relocated = process.argv.length === 4 && ['--relocate', '--verify-relocated'].includes(process.argv[2]);
assert(relocated || process.argv.length === 2, 'Use --relocate <copied kit> or --verify-relocated <copied kit>');
assert(/^windows-sandbox-host-[a-z0-9]+$/i.test(path.basename(kit.work)));
assert.equal(kit.config, path.join(kit.work, 'native-host-check.wsb'));
const work = relocated ? path.resolve(process.argv[3]) : kit.work;
assert.equal(fs.realpathSync(work), work);
const originalConfig = read(path.join(work, 'native-host-check.wsb'), 32768);
assert.equal(hash(originalConfig), kit.configSha256);
const input = path.join(work, 'input');
const output = path.join(work, 'output');
const originalManifest = path.join(input, 'manifest.json');
const manifestBytes = read(originalManifest, 32768);
const manifest = JSON.parse(manifestBytes);
const oldCanary = path.join(kit.work, 'unmapped-canary.txt');
const canary = path.join(work, 'unmapped-canary.txt');
const expectedManifest = Buffer.from(JSON.stringify({ ...manifest, unmappedCanary: oldCanary }, null, 2) + '\n');
assert.equal(hash(expectedManifest), kit.manifestSha256);
const manifestSha256 = hash(manifestBytes);
const updatedManifest = Buffer.from(JSON.stringify({ ...manifest, unmappedCanary: canary }, null, 2) + '\n');
const alreadyRelocated = manifestBytes.equals(updatedManifest);
if (!relocated) assert.equal(manifestSha256, kit.manifestSha256);
else if (process.argv[2] === '--relocate') assert(manifestSha256 === kit.manifestSha256 || alreadyRelocated);
else assert(alreadyRelocated);
assert.equal(Object.keys(manifest.files).length + 1, kit.inputFiles);
for (const [name, expected] of Object.entries(manifest.files)) {
  assert(/^(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/i.test(name) && !['.', '..'].includes(path.posix.basename(name)));
  assert.equal(hash(read(path.join(input, name))), expected);
}
function inventory(dir, prefix = '') {
  assert.equal(fs.realpathSync(dir), dir);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      const children = inventory(path.join(dir, entry.name), name + '/');
      assert(children.length > 0, 'Unlisted empty input directory');
      return children;
    }
    assert(entry.isFile());
    return [name];
  });
}
assert.deepEqual(inventory(input).sort(), ['manifest.json', ...Object.keys(manifest.files)].sort());
assert.equal(fs.realpathSync(output), output);
if (relocated) {
  assert.notEqual(work.toLowerCase(), kit.work.toLowerCase());
  assert(!/[%\x00-\x1f]/.test(work), 'Use a literal Windows Sandbox host path without environment expansion');
  assert.equal(read(canary, 1024).toString(), 'original synthetic canary');
  const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const folders = ['input', 'output'];
  const mappings = [...originalConfig.toString().matchAll(/<HostFolder>([^<]+)<\/HostFolder>/g)];
  assert.deepEqual(mappings.map(match => match[1]), folders.map(folder => escapeXml(path.join(kit.work, folder))));
  let config = originalConfig.toString();
  for (const [index, folder] of folders.entries())
    config = config.replace(mappings[index][0], () => '<HostFolder>' + escapeXml(path.join(work, folder)) + '</HostFolder>');
  const relocatedConfig = path.join(work, 'relocated-host-check.wsb');
  if (process.argv[2] === '--relocate') {
    const hasRelocatedConfig = fs.lstatSync(relocatedConfig, { throwIfNoEntry: false }) !== undefined;
    if (hasRelocatedConfig) assert.equal(read(relocatedConfig, 32768).toString(), config);
    if (!hasRelocatedConfig || !alreadyRelocated) {
      assert.deepEqual(fs.readdirSync(output), []);
      const publish = (target, bytes) => {
        const temporary = path.join(work, `.relocate-${randomUUID()}.next`);
        fs.writeFileSync(temporary, bytes, { flag: 'wx', flush: true });
        try { fs.renameSync(temporary, target); }
        finally { fs.rmSync(temporary, { force: true }); }
      };
      if (!hasRelocatedConfig) publish(relocatedConfig, config);
      if (!alreadyRelocated) publish(originalManifest, updatedManifest);
    }
    console.log(JSON.stringify({ config: relocatedConfig, inputsVerified: kit.inputFiles, manifestSha256: hash(updatedManifest) }));
    process.exit(0);
  }
  assert.equal(read(relocatedConfig, 32768).toString(), config);
}
const result = path.join(output, 'report.json');
if (!fs.existsSync(result)) {
  console.log(JSON.stringify({ inputsVerified: kit.inputFiles, guestReportPresent: false }));
  process.exit(0);
}
const report = JSON.parse(read(result, 32768));
assert.equal(report.mode, 'sandbox');
assert.equal(report.manifestSha256, manifestSha256);
assert.equal(report.nodeSha256, manifest.files['node.exe']);
assert.equal(report.qqExecuted, false);
assert.equal(report.outputWritable, true);
assert.deepEqual(report.isolation, { readOnlyInput: true, unmappedCanaryAbsent: true, noNonLoopbackInterfaces: true });
assert.deepEqual(report.cases, kit.rehearsal.cases);
assert.equal(read(path.join(output, 'write-test.txt'), 1024).toString(), 'synthetic output');
console.log(JSON.stringify({ inputsVerified: kit.inputFiles, guestReportPresent: true, guestObservation: report }));
