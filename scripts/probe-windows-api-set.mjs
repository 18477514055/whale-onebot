import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectPE } from './inspect-pe.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const temporary = path.join(root, '.tmp');
assert.equal(fs.realpathSync(temporary), temporary);
const work = fs.mkdtempSync(path.join(temporary, 'windows-api-set-'));
const source = path.join(root, 'experiments', 'windows-api-set', 'probe.c');
const compiler = path.join(root, '.tools', 'tinycc-0.9.27', 'tcc', 'tcc.exe');
const executable = path.join(work, 'probe.exe');
const system = path.join(process.env.SystemRoot, 'System32');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: system, TEMP: work, TMP: work };
function run(file, args) {
  const result = spawnSync(file, args, { cwd: work, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.equal(result.signal, null);
  return result.stdout.trim().split(/\r?\n/);
}
run(compiler, [source, '-o', executable]);
const pe = inspectPE(fs.readFileSync(executable));
assert.equal(pe.machine, '0x8664');
const [module, ...observed] = run(executable, []);
assert.equal(module.toLowerCase(), ('module=' + path.join(system, 'KernelBase.dll')).toLowerCase());
const old = JSON.parse(fs.readFileSync(path.join(root, 'evidence/windows-official-dependencies.json'), 'utf8'));
const gaps = old.links.filter(link => link.unresolved.length);
assert.equal(gaps.length, 1);
const resolved = observed.slice(0, 5).map(line => {
  const [symbol, owner] = line.split('|');
  assert.equal(path.dirname(owner).toLowerCase(), system.toLowerCase());
  return { symbol: symbol.replace(/^resolved=/, ''), owner };
});
assert.deepEqual(resolved.map(item => item.symbol), gaps[0].unresolved);
assert.deepEqual(observed.slice(5), [
  'negative=missing-contract-and-symbol',
  'calls=critical-section-and-event',
]);
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {
  at: new Date().toISOString(), scope: 'Original x64 probe on the current Windows host',
  windowsRelease: (await import('node:os')).release(), sourceSha256: sha256(source),
  compilerSha256: sha256(compiler), executableSha256: pe.sha256,
  module, resolved, observed, qqExecuted: false, isolatedQqLoadVerified: false,
};
const destination = path.join(root, 'evidence/windows-api-set-probe.json');
assert.equal(fs.realpathSync(path.dirname(destination)), path.dirname(destination));
const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1);
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
