import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const app = process.platform === 'win32' ? 'D:/QQ-Agent/app' : '/mnt/d/QQ-Agent/app';
const source = fs.realpathSync(path.join(app, 'src'));
const pattern = '\\b(?:onebot|client|this)(?:\\.|\\?\\.)call(?:ViaWs)?(?:\\?\\.)?\\(\\s*[\x27"]([a-z_][a-z_0-9]*)[\x27"]';
const search = spawnSync('rg', ['--json', '-U', '-g', '*.js', pattern, '.'], { cwd: source, encoding: 'utf8' });
assert.equal(search.status, 0, search.stderr);
const actions = new Map();
const files = new Map();
for (const line of search.stdout.trim().split(/\r?\n/)) {
  const entry = JSON.parse(line);
  if (entry.type !== 'match') continue;
  const name = entry.data.path.text.replace(/^\.[\\/]/, '').split(path.sep).join('/');
  const absolute = path.join(source, name);
  assert.equal(fs.realpathSync(absolute), absolute);
  if (!files.has(name)) files.set(name, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'));
  for (const match of entry.data.lines.text.matchAll(new RegExp(pattern, 'g'))) {
    const sites = actions.get(match[1]) ?? [];
    const extraLines = entry.data.lines.text.slice(0, match.index).split('\n').length - 1;
    sites.push({ file: name, line: entry.data.line_number + extraLines });
    actions.set(match[1], sites);
  }
}
const capabilities = JSON.parse(fs.readFileSync(path.join(root, 'evidence/capabilities.json'), 'utf8'));
const byName = new Map(capabilities.matrix.map(item => [item.action, item]));
const records = [...actions].sort(([a], [b]) => a.localeCompare(b)).map(([action, sites]) => {
  const entry = byName.get(action);
  return { action, sites, layer: entry?.layer ?? 'unregistered', notes: entry?.notes ?? '',
    realQQVerified: entry?.realQQVerified ?? false };
});
const report = { at: new Date().toISOString(), source, method: 'Literal call/callViaWs action names in JavaScript source, including optional chaining',
  limitations: ['Dynamic expressions and function references are outside this extraction', 'A literal match is source evidence, not a runtime call'],
  files: Object.fromEntries(files), counts: Object.fromEntries(
    ['local-protocol', 'native-contract-adapter', 'unimplemented', 'unregistered'].map(layer =>
      [layer, records.filter(entry => entry.layer === layer).length])), actions: records };
const output = path.join(root, 'evidence/agent-plus-action-inventory.json');
assert.equal(fs.realpathSync(path.dirname(output)), path.dirname(output));
const existing = fs.lstatSync(output, { throwIfNoEntry: false });
if (existing) assert(existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1);
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ actions: records.length, ...report.counts }));
