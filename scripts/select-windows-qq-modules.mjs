import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const cache = path.join(root, '.tools', 'qq-windows-official');
const sevenZip = path.join(root, '.tools', '7zip-linux', 'unpacked', 'usr', 'lib', '7zip', '7z');
assert.equal(process.platform, 'linux');
assert(process.argv.length >= 3 && process.argv.length <= 12, 'Supply the extracted resource archives');
function run(args) {
  const result = spawnSync(sevenZip, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
const names = new Set(['wrapper.node', 'qqnt.dll']);
const selected = new Map();
for (const argument of process.argv.slice(2)) {
  const archive = path.resolve(argument);
  const relative = path.relative(cache, archive);
  assert(/^archives-[A-Za-z0-9]+\/resource-\d+\.7z$/.test(relative));
  assert.equal(fs.realpathSync(archive), archive);
  const stat = fs.lstatSync(archive);
  assert(stat.isFile() && stat.nlink === 1);
  for (const block of run(['l', '-slt', '-ba', '--', archive]).split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find(item => item.startsWith('Path = '));
    if (!line) continue;
    const member = line.slice(7);
    const filename = member.split(/[\\/]/).at(-1).toLowerCase();
    if (!names.has(filename)) continue;
    assert(/^[A-Za-z0-9 ._\\/\-]+$/.test(member) && !member.startsWith('/') &&
      !member.startsWith('\\') && !member.split(/[\\/]/).includes('..'));
    assert(!selected.has(filename), 'Module basename is ambiguous across resource archives');
    const size = Number(/^Size = (\d+)$/m.exec(block)?.[1]);
    assert(Number.isSafeInteger(size) && size > 0 && size < 512 * 1024 * 1024);
    assert(!/^Symbolic Link =|^Hard Link =/m.test(block));
    selected.set(filename, { archive, member, size });
  }
}
assert.equal(selected.size, names.size, 'Both target modules must be identified');
const output = fs.mkdtempSync(path.join(cache, 'modules-'));
const modules = {};
for (const [filename, item] of selected) {
  run(['e', '-y', '-spd', '-o' + output, '--', item.archive, item.member]);
  const file = path.join(output, item.member.split(/[\\/]/).at(-1));
  assert.equal(fs.realpathSync(file), file);
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && stat.nlink === 1 && stat.size === item.size);
  modules[filename] = { file, member: item.member, archive: path.basename(item.archive), bytes: item.size };
}
assert.equal(fs.readdirSync(output).length, names.size);
console.log(JSON.stringify({ output, modules }));
