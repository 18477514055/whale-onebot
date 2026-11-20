// Original PE export plan; input is static evidence, never a native module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STOPPING_EXPORT = '?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z';
export const REGISTER_EXPORT = 'qq_magic_napi_register';
const expected = {
  wrapper: '63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0',
  node: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function createExportPlan(evidence) {
  assert.equal(evidence?.wrapper?.sha256, expected.wrapper, 'Unrecognized consumer');
  assert.equal(evidence?.node?.sha256, expected.node, 'Unrecognized Node');
  for (const image of [evidence.wrapper, evidence.node]) {
    assert.equal(image.machine, '0x8664'); assert.equal(image.format, 'PE32+');
  }
  // Recompute the observed requirements and providers instead of trusting the
  // report's aggregate counters or comparison conclusions.
  const requirements = [...evidence.wrapper.imports, ...evidence.wrapper.delayImports]
    .filter(item => item.module.toLowerCase() === 'qqnt.dll').flatMap(item => item.symbols);
  assert.equal(requirements.length, 99, 'Unexpected consumer contract');
  const seen = new Set(), forwards = [], implementations = [];
  const exports = new Map();
  for (const entry of evidence.node.exports.entries) {
    if (entry.kind === 'unused') continue;
    for (const alias of entry.names) {
      assert(!exports.has(alias.name), 'Ambiguous Node export');
      exports.set(alias.name, entry);
    }
  }
  for (const item of requirements) {
    assert.equal(item.kind, 'name', 'Ordinal imports cannot be remapped');
    assert(/^[A-Za-z_?][A-Za-z0-9_?@$]*$/.test(item.name), 'Unsupported export spelling');
    assert(!seen.has(item.name), 'Duplicate consumer import'); seen.add(item.name);
    if ([STOPPING_EXPORT, REGISTER_EXPORT].includes(item.name)) {
      assert(!exports.has(item.name), 'Host contract changed');
      implementations.push(item.name);
    } else {
      assert(exports.has(item.name), 'Node export missing');
      // Chained forwarders would require another provider identity check.
      assert.equal(exports.get(item.name).kind, 'address', 'Node export is not direct');
      forwards.push(item.name);
    }
  }
  assert.equal(forwards.length, 97); assert.equal(implementations.length, 2);
  return { schemaVersion: 1, architecture: 'win32-x64', consumerSha256: expected.wrapper,
    nodeSha256: expected.node, forwards: forwards.sort(), implementations: implementations.sort(),
    caveat: 'Export names only. Forwarder resolution and native C++ semantics require separate compiled runtime controls.' };
}

export function renderForwarderDef(plan, targetModule, { includeImplementations = true } = {}) {
  // Only two exact experiment variants. Do not allow arbitrary module/search paths.
  assert(['node', 'node.exe'].includes(targetModule), 'Unrecognized forwarder target');
  const lines = ['LIBRARY onebot-node-host', 'EXPORTS'];
  for (const name of plan.forwards) {
    assert(/^[A-Za-z_?][A-Za-z0-9_?@$]*$/.test(name), 'Unsupported export spelling');
    lines.push(`  ${name}=${targetModule}.${name}`);
  }
  if (includeImplementations) for (const name of plan.implementations) {
    assert([STOPPING_EXPORT, REGISTER_EXPORT].includes(name), 'Unrecognized implementation');
    lines.push(`  ${name}`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'No alternate evidence accepted');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bytes = fs.readFileSync(path.join(root, 'evidence/native-abi.json'));
  assert.equal(sha256(bytes), '6a2a059e3cce149f81e09424a52601eb9d791cc18c983211ec461dd5a9f281a0', 'Static evidence changed');
  const plan = createExportPlan(JSON.parse(bytes));
  const destination = path.join(root, 'evidence/windows-host-export-plan.json');
  if (fs.existsSync(destination)) assert(fs.lstatSync(destination).isFile() && !fs.lstatSync(destination).isSymbolicLink());
  fs.writeFileSync(destination, JSON.stringify({ ...plan, staticEvidenceSha256: sha256(bytes) }, null, 2) + '\n');
  console.log(JSON.stringify({ forwards: plan.forwards.length, implementations: plan.implementations, nativeExecuted: false }));
}
