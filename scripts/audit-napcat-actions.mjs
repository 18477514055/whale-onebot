import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const commit = '9335843246e3b7a17944861f3ac8731a259732c2';
const archiveSha256 = '846f2a0d3f0f5e8ab80b4bb6bf8de9a52c1166c3478f08e64f3b2dece1ce34a5';
const prefix = `NapCatQQ-${commit}/packages/napcat-onebot/action`;
const archive = path.resolve(process.argv[2] ?? path.join(root, '.tmp', 'napcat-93358432.tar.gz'));
assert.equal(fs.statSync(archive).size, 58951456);
assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), archiveSha256);
const readEvidence = name => JSON.parse(fs.readFileSync(path.join(root, 'evidence', name), 'utf8'));
const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
assert.equal(listed.status, 0, listed.stderr);
const files = listed.stdout.split(/\r?\n/).filter(name => name.startsWith(prefix + '/') && name.endsWith('.ts'));
assert(files.length > 150 && files.length < 300);
assert.equal(new Set(files).size, files.length);
assert(files.every(name => /^[A-Za-z0-9_./-]+$/.test(name) && !name.split('/').includes('..')));

// Stream only the TypeScript members, in archive order. No third-party code runs.
const source = spawnSync('tar', ['-xOzf', archive, ...files], { maxBuffer: 16 * 1024 * 1024 });
assert.equal(source.status, 0, source.stderr?.toString());
const annotated = spawnSync('tar', ['-tvzf', archive, ...files], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
assert.equal(annotated.status, 0, annotated.stderr);
const wanted = new Set(files);
const sources = new Map();
let offset = 0;
for (const line of annotated.stdout.trim().split(/\r?\n/)) {
  const match = line.match(new RegExp(`^-\\S*\\s+(?:\\d+\\s+\\S+\\s+\\S+|\\S+/\\S+)\\s+(\\d+)\\s+.*?(${prefix}/[A-Za-z0-9_./-]+)$`));
  assert(match && wanted.delete(match[2]), 'Unexpected tar listing format or file order');
  const size = Number(match[1]);
  sources.set(match[2].slice(prefix.length + 1), source.stdout.subarray(offset, offset + size).toString('utf8'));
  offset += size;
}
assert.equal(wanted.size, 0);
assert.equal(offset, source.stdout.length);

const router = sources.get('router.ts');
const index = sources.get('index.ts');
assert(router?.includes('export const ActionName') && index?.includes('export function getAllHandlers'));
const names = new Map([...router.matchAll(/^\s+(\w+):\s*'([A-Za-z0-9_.]+)',/gm)].map(match => match.slice(1)));
const handlers = new Set([...index.replace(/^\s*\/\/.*$/gm, '').matchAll(/\bnew (\w+)\(obContext, core\)/g)]
  .map(match => match[1]).filter(name => name !== 'ActionClass'));
const defaultImports = new Map([...index.matchAll(/^import (\w+) from '\S+\/([^/']+)';$/gm)]
  .map(match => [match[2], match[1]]));
const actions = new Map();
for (const [file, text] of sources) {
  const classes = [...text.matchAll(/\bclass\s+(\w+)\b/g)];
  for (const [i, declaration] of classes.entries()) {
    const modifiers = text.slice(Math.max(0, declaration.index - 256), declaration.index);
    const className = /\bexport\s+default\s+$/.test(modifiers) ?
      defaultImports.get(path.posix.basename(file, '.ts')) ?? declaration[1] : declaration[1];
    const block = text.slice(declaration.index, classes[i + 1]?.index);
    const decorator = /@ActionHandler\s*(?:\(\s*\))?\s*(?:export\s+)?(?:default\s+)?$/
      .test(modifiers);
    if (!handlers.has(className) && !decorator) continue;
    const name = block.match(/\bactionName\s*=\s*ActionName\.(\w+)\b/)?.[1];
    if (!names.has(name)) continue;
    const resolved = names.get(name);
    actions.set(resolved, file);
    handlers.delete(className);
  }
}
assert(actions.size > 150 && handlers.size === 0, `Unresolved explicit handlers: ${[...handlers].join(', ')}`);
const capabilities = readEvidence('capabilities.json');
const matrix = new Map(capabilities.matrix.map(item => [item.action, item]));
const agent = new Map(readEvidence('agent-plus-action-inventory.json').actions.map(item => [item.action, item]));
const rows = [...actions].sort(([a], [b]) => a.localeCompare(b)).map(([action, napcatFile]) => ({
  action, napcatFile, whaleLayer: matrix.get(action)?.layer ?? 'unregistered',
  agentPlusLiteralCall: agent.has(action), realQQVerified: matrix.get(action)?.realQQVerified === true,
  ...(matrix.get(action)?.realQQVerified === true && { liveTransport: matrix.get(action).liveTransport,
    liveTransports: matrix.get(action).liveTransports }),
}));
const counts = records => Object.fromEntries(['local-protocol', 'native-contract-adapter', 'unimplemented', 'unregistered']
  .map(layer => [layer, records.filter(item => item.whaleLayer === layer).length]));
const report = {
  at: new Date().toISOString(), commit,
  registrySource: `https://github.com/NapNeko/NapCatQQ/blob/${commit}/packages/napcat-onebot/action/index.ts`,
  archiveSha256,
  liveTransportCoverage: capabilities.liveTransportCoverage,
  postRoundtripSessionVerified: capabilities.postRoundtripSessionVerified,
  threePathRoundtripVerified: capabilities.threePathRoundtripVerified,
  scope: 'Static action names from pinned registry and recognized decorators, excluding async/rate-limited aliases. No runtime calls.',
  unresolvedExplicitHandlers: [...handlers].sort(),
  counts: { identifiedNapCatNames: rows.length, ...counts(rows), realQQVerified: rows.filter(item => item.realQQVerified).length },
  agentPlusOverlap: counts(rows.filter(item => item.agentPlusLiteralCall)),
  agentPlusOutsideIdentifiedNapCat: [...agent.keys()].filter(action => !actions.has(action)).sort(),
  actions: rows,
};
fs.writeFileSync(path.join(root, 'evidence', 'napcat-action-gap.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report.counts, agentPlusOverlap: report.agentPlusOverlap, unresolved: report.unresolvedExplicitHandlers }));
