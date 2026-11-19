import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createExportPlan, renderForwarderDef, REGISTER_EXPORT, STOPPING_EXPORT } from '../scripts/windows-host-exports.mjs';
const evidenceUrl = new URL('../evidence/native-abi.json', import.meta.url);
const EVIDENCE_MISSING = 'evidence/native-abi.json 不在仓库里（开发记录）';
const SKIP = !fs.existsSync(evidenceUrl) && EVIDENCE_MISSING;
const evidence = SKIP ? { wrapper: { imports: [] }, comparison: {} } : JSON.parse(fs.readFileSync(evidenceUrl));
const clone = () => structuredClone(evidence);
const imports = e => e.wrapper.imports.find(x => x.module.toLowerCase() === 'qqnt.dll').symbols;

test('Windows export contract is recomputed from all 99 actual PE requirements', { skip: SKIP }, () => {
  const value = clone(); value.comparison.requirementCount = 1; value.comparison.requirements = [];
  const plan = createExportPlan(value);
  assert.equal(plan.forwards.length, 97);
  assert.deepEqual(plan.implementations, [STOPPING_EXPORT, REGISTER_EXPORT].sort());
  assert.equal(renderForwarderDef(plan, 'node').split('\n').length, 102);
  assert(!renderForwarderDef(plan,'node').includes('"'), 'MSVC preserves quotes in DEF export names');
  assert.equal(renderForwarderDef(plan, 'node.exe', {includeImplementations:false}).split('\n').length, 100);
});
test('Windows export contract rejects changed identities, ordinal or duplicate requirements', { skip: SKIP }, () => {
  for (const mutate of [
    e => { e.node.sha256 = '0'.repeat(64); },
    e => { e.wrapper.machine = '0x14c'; },
    e => { imports(e)[0].kind = 'ordinal'; },
    e => { imports(e)[1].name = imports(e)[0].name; },
    e => { imports(e).pop(); },
  ]) { const value = clone(); mutate(value); assert.throws(() => createExportPlan(value)); }
});
test('Windows export contract requires a direct exact-case provider and bounded DEF syntax', { skip: SKIP }, () => {
  const value = clone();
  const name = createExportPlan(value).forwards[0];
  const target = value.node.exports.entries.find(x => x.names.some(n => n.name === name));
  target.kind = 'forwarder'; target.forwarder = 'other.' + name;
  assert.throws(() => createExportPlan(value));
  const missing = clone(); imports(missing)[2].name = 'NAPI_DOES_NOT_EXIST';
  assert.throws(() => createExportPlan(missing));
  assert.throws(() => renderForwarderDef(createExportPlan(evidence), '../node'));
  assert.throws(() => renderForwarderDef({forwards:['evil\nEXPORTS injected'],implementations:[]}, 'node'));
});
