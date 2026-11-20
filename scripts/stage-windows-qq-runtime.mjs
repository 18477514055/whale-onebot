import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'win32');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const cache = path.join(root, '.tools', 'qq-windows-official');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(file, expected) {
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert.equal(before.size, expected.bytes);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(digest(bytes), expected.sha256);
  return bytes;
}
const pins = {
  'windows-official-runtime.json': '19cd8e8dcfa0b7f830a6c6f38d6ed3a7578f9131afa5324b3ec958b0b0a3902a',
  'windows-official-dependencies.json': '5542b7ca37cead2a7f01ff5658a13fc7c24007e444a91791b05e2ed099dbab72',
  'windows-api-set-probe.json': '47c9cf29dff1e523926d8343aaf7fd9febbff9cf06ae99d70f465293e4c755f6',
};
const verify = process.argv.length === 4 && process.argv[2] === '--verify';
const fresh = process.argv.length === 3 && process.argv[2] === '--fresh';
assert(verify || fresh || process.argv.length === 2, 'Use no arguments to prepare, --fresh to copy, or --verify <stage>');
function evidence(name) {
  const file = path.join(root, 'evidence', name);
  return JSON.parse(regular(file, { bytes: fs.statSync(file).size, sha256: pins[name] }));
}
const runtime = evidence('windows-official-runtime.json');
const dependencies = evidence('windows-official-dependencies.json');
const apiSets = evidence('windows-api-set-probe.json');
const probeNames = apiSets.resolved.map(entry => entry.symbol).sort();
const [gap] = dependencies.links.filter(link => link.unresolved.length);
assert.equal(gap.module, 'api-ms-win-core-synch-l1-2-0.dll');
assert.equal(gap.consumer, 'msvcrt.dll');
assert.deepEqual([...gap.unresolved].sort(), probeNames);
assert.equal(runtime.originalProviderCoverage.requirements, 99);
assert.deepEqual(runtime.originalProviderCoverage.missing, []);
const node = fs.realpathSync(process.execPath);
const nodeSha256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
const systemOnly = name => /^(api-ms-|ext-ms-)/.test(name) || name === 'msvcrt.dll';
const dependencyFiles = dependencies.files.filter(file => file.name !== 'wrapper.node');
const systemContract = dependencyFiles.filter(file => systemOnly(file.name)).map(file => file.name);
const stagedDependencies = dependencyFiles.filter(file => !systemOnly(file.name));
function verifyStage(stage) {
  assert.equal(fs.realpathSync(stage), stage);
  const manifest = path.join(stage, 'manifest.json');
  const stat = fs.lstatSync(manifest);
  assert.equal(fs.realpathSync(manifest), manifest);
  assert(stat.isFile() && stat.nlink === 1 && stat.size <= 32768);
  const report = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.deepEqual(report.evidenceSha256, pins);
  assert.deepEqual(report.systemContract, systemContract);
  assert.equal(report.stockQqntSha256, runtime.stockProvider.sha256);
  const expected = new Map([
    ['node.exe', { sha256: nodeSha256 }], ['wrapper.node', runtime.wrapper], ['qqnt.dll', runtime.originalProvider],
    ...stagedDependencies.map(file => [file.name, file]),
  ]);
  assert(Array.isArray(report.files) && report.files.length === expected.size);
  for (const item of report.files) {
    assert(/^[a-z0-9_.-]+\.(dll|node|exe)$/i.test(item.name));
    const key = item.name.toLowerCase();
    const pin = expected.get(key);
    assert(pin && pin.sha256 === item.sha256 && (pin.bytes === undefined || pin.bytes === item.bytes));
    regular(path.join(stage, item.name), { bytes: item.bytes, sha256: pin.sha256 });
    expected.delete(key);
  }
  assert.equal(expected.size, 0);
  assert.deepEqual(fs.readdirSync(stage).sort(), ['manifest.json', ...report.files.map(item => item.name)].sort());
  return { stage, verified: report.files.length, exactInventory: true, verifiedAgainstPinnedEvidence: true };
}
if (verify) {
  console.log(JSON.stringify(verifyStage(path.resolve(process.argv[3]))));
  process.exit(0);
}
assert.equal(fs.realpathSync(cache), cache);
const destination = path.join(root, 'evidence', 'windows-qq-stage.json');
assert.equal(fs.realpathSync(path.dirname(destination)), path.dirname(destination));
const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1 && existing.size <= 32768);
if (!fresh && existing) {
  const report = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert(typeof report.stage === 'string' && /^\.tools\/qq-windows-official\/stage-[a-z0-9]+$/i.test(report.stage),
    'Recorded stage is outside the managed cache');
  const stage = path.join(root, report.stage);
  console.log(JSON.stringify({ ...verifyStage(stage), reused: true, qqExecuted: false }));
  process.exit(0);
}
const nodeInfo = { bytes: fs.statSync(node).size, sha256: nodeSha256 };
const inputs = [
  { name: 'node.exe', source: node, ...nodeInfo },
  { name: 'wrapper.node', source: path.join(root, runtime.wrapper.path), ...runtime.wrapper },
  { name: 'QQNT.dll', source: path.join(root, runtime.originalProvider.path), ...runtime.originalProvider },
];
for (const file of stagedDependencies) {
  assert(/^[a-z0-9_.-]+\.dll$/i.test(file.name));
  // Windows directory enumeration retains the official filename case.
  const sourceDir = path.join(root, dependencies.output);
  assert.equal(fs.realpathSync(sourceDir), sourceDir);
  const [name] = fs.readdirSync(sourceDir).filter(item => item.toLowerCase() === file.name);
  assert(name);
  inputs.push({ ...file, name, source: path.join(sourceDir, name) });
}
assert.equal(new Set(inputs.map(item => item.name.toLowerCase())).size, inputs.length);
const stage = fs.mkdtempSync(path.join(cache, 'stage-'));
const files = inputs.map(input => {
  const bytes = regular(input.source, input);
  const target = path.join(stage, input.name);
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  regular(target, input);
  return { name: input.name, bytes: input.bytes, sha256: input.sha256 };
});
assert.deepEqual(fs.readdirSync(stage).sort(), files.map(item => item.name).sort());
const report = {
  at: new Date().toISOString(), stage: path.relative(root, stage).split(path.sep).join('/'),
  evidenceSha256: pins, files, systemContract, qqExecuted: false,
  stockQqntSha256: runtime.stockProvider.sha256,
  purpose: 'Local staged inputs for a later isolated Windows loader test',
};
const reportText = JSON.stringify(report, null, 2) + '\n';
fs.writeFileSync(path.join(stage, 'manifest.json'), reportText, { flag: 'wx' });
fs.writeFileSync(destination, reportText);
console.log(JSON.stringify({ stage: report.stage, files: files.length, systemContract: systemContract.length, qqExecuted: false }));
