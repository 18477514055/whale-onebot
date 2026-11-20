import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(project, 'evidence');
const wrapper = path.join(project, '.tools', 'qq-linux-arm64-inspection-NGwyZl', 'wrapper.node');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inputEvidenceSha256 = {};
function loadEvidence(name) {
  const bytes = readFileSync(path.join(evidence, name));
  inputEvidenceSha256[name] = sha256(bytes);
  return JSON.parse(bytes);
}

const abi = loadEvidence('native-abi-linux-arm64.json');
const dependencies = loadEvidence('native-dependencies-linux-arm64-supplemental.json');
const wrapperSha256 = sha256(readFileSync(wrapper));
assert.equal(wrapperSha256, abi.wrapper.sha256);
assert.equal(dependencies.archiveSha256, abi.archive.sha256);
const names = new Set(dependencies.originalHostWifiphoto.symbols.map(symbol => symbol.name));
const symbols = abi.comparison.undefinedSymbols.filter(symbol => names.has(symbol.name));
assert.equal(names.size, 12);
assert.equal(symbols.length, names.size);
assert(symbols.every(symbol => symbol.binding === 'GLOBAL'));
const byIndex = new Map(symbols.map(symbol => [symbol.index, symbol]));
assert.equal(byIndex.size, names.size);

const commands = [];
function readelf(option) {
  const windows = process.platform === 'win32';
  const input = windows ? `/mnt/${wrapper[0].toLowerCase()}/${wrapper.slice(3).replaceAll('\\', '/')}` : wrapper;
  const program = windows ? 'wsl.exe' : 'readelf';
  const args = windows ? ['-d', 'Debian', '--', 'env', 'LC_ALL=C', 'readelf', option, input] : [option, input];
  const result = spawnSync(program, args, {
    env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0, result.stderr.toString());
  commands.push({ program, args, status: result.status, stdoutSha256: sha256(result.stdout) });
  return result.stdout.toString('utf8');
}

assert.match(readelf('-hW'), /^\s*Machine:\s+AArch64\s*$/m);
const dynamic = readelf('-dW');
const tags = [...dynamic.matchAll(/^\s*0x[\da-f]+\s+\(([\w_]+)\)\s+(.*?)\s*$/gm)];
assert.equal(tags.length, Number(dynamic.match(/contains (\d+) entries:/)?.[1]));
const initializerTags = tags.filter(([, tag]) => ['INIT', 'INIT_ARRAY', 'INIT_ARRAYSZ'].includes(tag)).map(([line]) => line.trim());
const eagerBindingTags = tags.filter(([, tag, value]) => tag === 'BIND_NOW'
  || (tag === 'FLAGS' && /\bBIND_NOW\b/.test(value))
  || (tag === 'FLAGS_1' && /\bNOW\b/.test(value))).map(([line]) => line.trim());

const tables = [];
const records = new Map(symbols.map(symbol => [symbol.index, { symbol, relocations: [] }]));
let table;
for (const line of readelf('-rW').split('\n')) {
  const header = line.match(/^Relocation section '([^']+)' at offset (0x[0-9a-f]+) contains (\d+) entries:/);
  if (header) {
    const [, name, offset, count] = header;
    table = { name, offset, declared: Number(count), inspected: 0 };
    tables.push(table);
    continue;
  }
  const row = line.match(/^\s*([0-9a-f]{16})\s+([0-9a-f]{16})\s+(R_AARCH64_\S+)(?:\s+(.*?))?\s*$/);
  if (!row) continue;
  assert(table, 'Relocation outside a declared table');
  table.inspected++;
  const [, address, info, type, fields] = row;
  const index = Number.parseInt(info.slice(0, 8), 16);
  const displayName = fields?.split(/\s+/, 3)[1];
  const symbol = byIndex.get(index);
  if (!symbol && !names.has(displayName)) continue;
  assert.equal(symbol?.name, displayName, 'Symbol name disagrees with the ELF relocation index');
  records.get(index).relocations.push({ table: table.name, type, address: `0x${address}`, info, raw: line });
}

assert.deepEqual(tables.map(item => item.name), ['.rela.dyn', '.rela.plt']);
for (const item of tables) assert.equal(item.inspected, item.declared, `Incomplete ${item.name}`);
const targets = [...records.values()];
assert(targets.every(record => record.relocations.length > 0), 'Expected at least one relocation for every import');
const allOnlyJumpSlots = targets.every(({ relocations }) => relocations.length === 1
  && relocations[0].table === '.rela.plt' && relocations[0].type === 'R_AARCH64_JUMP_SLOT');

const report = {
  schema: 1,
  observedAt: new Date().toISOString(),
  mode: 'static-no-target-execution',
  architecture: 'arm64',
  wrapperSha256,
  inputEvidenceSha256,
  commands,
  tables,
  initializerTags,
  eagerBindingTags,
  allOnlyJumpSlots,
  targets,
  initializerReachability: 'unknown',
  references: [
    'https://github.com/ARM-software/abi-aa/blob/main/aaelf64/aaelf64.rst',
    'https://man7.org/linux/man-pages/man3/dlopen.3.html',
  ],
};
writeFileSync(path.join(evidence, 'native-relocations-linux-arm64.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ targets: targets.length, tables, allOnlyJumpSlots, eagerBindingTags, initializerTags }));
