import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compareModuleImports, inspectPE } from './inspect-pe.mjs';

const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const cache = path.join(root, '.tools', 'qq-windows-official');
assert.equal(process.argv.length, 5, 'Supply installer, extracted wrapper, and extracted QQNT.dll');
function readArtifact(argument, base, filename) {
  const file = path.resolve(argument);
  const relative = path.relative(base, file);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  if (filename) assert.equal(path.basename(file).toLowerCase(), filename.toLowerCase());
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size < 1024 ** 3);
  const bytes = fs.readFileSync(file);
  const after = fs.statSync(file);
  assert.equal(after.size, stat.size);
  assert.equal(after.mtimeMs, stat.mtimeMs);
  assert.equal(after.ino, stat.ino);
  assert.equal(bytes.length, stat.size);
  return { file, bytes };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const installer = readArtifact(process.argv[2], cache);
assert.equal(installer.bytes.length, 314581680, 'Expected the complete fixed Windows installer');
const wrapper = readArtifact(process.argv[3], cache, 'wrapper.node');
const stock = readArtifact(process.argv[4], cache, 'QQNT.dll');
const native = inspectPE(wrapper.bytes);
const dll = inspectPE(stock.bytes);
const scopePath = path.join(root, 'evidence', 'native-host-scope-win32.json');
const scopeBytes = fs.readFileSync(scopePath);
assert.equal(hash(scopeBytes), '038578701c96fab90a43b226fde63c7f6cfc043510e9d81557d647e9f087d6bd');
const scope = JSON.parse(scopeBytes);
assert(scope.passed);
const providerPath = scope.provider.path;
const provider = readArtifact(providerPath, path.join(root, '.tmp'), 'onebot-node-host.dll');
assert.equal(hash(provider.bytes), scope.provider.sha256);
const shim = inspectPE(provider.bytes);
const historical = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'native-abi.json'), 'utf8'));
function compare(provider) {
  const comparison = compareModuleImports(native, provider, 'QQNT.dll');
  assert(comparison.architectureMatches);
  assert(comparison.requirementCount > 0);
  return {
    requirements: comparison.requirementCount,
    exactMatches: comparison.exactNamePresent,
    missing: comparison.requirements.filter(item => item.status !== 'exact-export-name-present')
      .map(item => item.name ?? 'ordinal:' + item.ordinal),
  };
}
const artifact = item => ({
  path: path.relative(root, item.file).split(path.sep).join('/'),
  bytes: item.bytes.length,
  sha256: hash(item.bytes),
});
const report = {
  at: new Date().toISOString(),
  scope: 'Static analysis of independently extracted installer files',
  installer: artifact(installer),
  wrapper: artifact(wrapper),
  stockProvider: artifact(stock),
  originalProvider: artifact(provider),
  matchesPriorWorkspaceWrapper: historical.wrapper.sha256 === native.sha256,
  imports: [...native.imports, ...native.delayImports].map(item => ({ module: item.module, symbols: item.symbols.length })),
  stockCoverage: compare(dll),
  originalProviderCoverage: compare(shim),
  qqExecuted: false,
};
const destination = path.join(root, 'evidence', 'windows-official-runtime.json');
assert.equal(fs.realpathSync(path.dirname(destination)), path.dirname(destination));
const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1);
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
