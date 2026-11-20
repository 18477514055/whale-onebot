import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectPE, compareModuleImports } from './inspect-pe.mjs';

assert.equal(process.platform, 'linux');
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const cache = path.join(root, '.tools', 'qq-windows-official');
const sevenZip = path.join(root, '.tools', '7zip-linux', 'unpacked', 'usr', 'lib', '7zip', '7z');
const archive = path.join(cache, 'archives-QrLakq', 'resource-160568.7z');
const wrapper = path.join(cache, 'modules-TAfbOW', 'wrapper.node');
const output = fs.mkdtempSync(path.join(cache, 'dependencies-'));
const prefix = 'Files/versions/9.9.33-52230/resources/app/';
function run(args) {
  const result = spawnSync(sevenZip, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
const members = new Map();
for (const block of run(['l', '-ba', '-slt', '--', archive]).split(/\r?\n\r?\n/)) {
  const member = /^Path = (.+)$/m.exec(block)?.[1];
  if (!member?.startsWith(prefix)) continue;
  const filename = member.slice(prefix.length);
  if (!/^[a-z0-9_.-]+\.dll$/i.test(filename)) continue;
  assert(!/^Symbolic Link =|^Hard Link =/m.test(block));
  const size = Number(/^Size = (\d+)$/m.exec(block)?.[1]);
  assert(Number.isSafeInteger(size) && size > 0 && size < 512 * 1024 * 1024);
  const key = filename.toLowerCase();
  assert(!members.has(key));
  members.set(key, { member, filename, size });
}
const images = new Map([['wrapper.node', inspectPE(fs.readFileSync(wrapper))]]);
const unresolved = [];
const links = [];
let batch = ['wrapper.node'];
while (batch.length) {
  const wanted = new Set();
  for (const name of batch) {
    const pe = images.get(name);
    for (const descriptor of [...pe.imports, ...pe.delayImports]) {
      const dll = descriptor.module.toLowerCase();
      if (dll === 'qqnt.dll') continue;
      if (members.has(dll) && !images.has(dll)) wanted.add(dll);
      if (!members.has(dll)) unresolved.push({ from: name, module: descriptor.module });
    }
  }
  if (!wanted.size) break;
  const files = [...wanted].map(name => members.get(name));
  run(['e', '-y', '-spd', '-o' + output, '--', archive, ...files.map(item => item.member)]);
  for (const item of files) {
    const file = path.join(output, item.filename);
    assert.equal(fs.realpathSync(file), file);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.nlink === 1 && stat.size === item.size);
    const pe = inspectPE(fs.readFileSync(file));
    assert.equal(pe.machine, '0x8664');
    images.set(item.filename.toLowerCase(), pe);
  }
  batch = [...wanted];
}
for (const [consumer, image] of images) {
  const dependencies = new Set([...image.imports, ...image.delayImports].map(item => item.module.toLowerCase()));
  for (const module of dependencies) {
    if (!images.has(module)) continue;
    const compared = compareModuleImports(image, images.get(module), module);
    links.push({ consumer, module, requirements: compared.requirementCount, namesPresent: compared.exactNamePresent,
      unresolved: compared.requirements.filter(item => item.status !== 'exact-export-name-present').map(item => item.name ?? item.ordinal) });
  }
}
const report = {
  at: new Date().toISOString(), scope: 'Static closure within the packaged resources/app directory',
  output: path.relative(root, output), qqExecuted: false,
  files: [...images].map(([name, pe]) => ({ name, bytes: pe.fileSize, sha256: pe.sha256 })),
  links, unresolved,
  limitations: ['QQNT.dll recorded in the separate host comparison', 'System imports and imports outside resources/app remain external', 'Runtime loads and ABI semantics require later validation'],
};
const file = path.join(root, 'evidence', 'windows-official-dependencies.json');
assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file));
const existing = fs.lstatSync(file, { throwIfNoEntry: false });
if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1);
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ files: report.files.length, links: links.length,
  unresolvedLocalSymbols: links.reduce((n, link) => n + link.unresolved.length, 0),
  externalModules: [...new Set(unresolved.map(item => item.module.toLowerCase()))].sort() }));
