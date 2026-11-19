import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectPE, compareModuleImports } from '../scripts/inspect-pe.mjs';

function fixture({ is64 = true, delayVa = false, fallbackIat = false } = {}) {
  const b = Buffer.alloc(0x1000);
  const pe = 0x80, optional = pe + 24, optionalSize = is64 ? 240 : 224;
  const dir = optional + (is64 ? 112 : 96), sections = optional + optionalSize;
  const off = rva => rva - 0x1000 + 0x200;
  const word = (offset, value) => b.writeUInt16LE(value, offset);
  const dword = (offset, value) => b.writeUInt32LE(value, offset);
  const str = (rva, value) => b.write(`${value}\0`, off(rva), 'latin1');
  const ptr = (rva, value) => is64 ? b.writeBigUInt64LE(BigInt(value), off(rva)) : dword(off(rva), Number(value));
  const width = is64 ? 8 : 4;
  word(0, 0x5a4d); dword(0x3c, pe); dword(pe, 0x4550);
  word(pe + 4, is64 ? 0x8664 : 0x14c); word(pe + 6, 1); word(pe + 20, optionalSize);
  word(optional, is64 ? 0x20b : 0x10b);
  if (is64) b.writeBigUInt64LE(0x140000000n, optional + 24); else dword(optional + 28, 0x400000);
  dword(optional + 56, 0x2000); dword(optional + 60, 0x200);
  dword(dir - 4, 16); dword(dir, 0x1200); dword(dir + 4, 0x100);
  dword(dir + 8, 0x1000); dword(dir + 12, 40);
  dword(dir + 13 * 8, 0x1400); dword(dir + 13 * 8 + 4, 64);
  b.write('.rdata', sections, 'latin1'); dword(sections + 8, 0xe00); dword(sections + 12, 0x1000);
  dword(sections + 16, 0xe00); dword(sections + 20, 0x200);
  dword(off(0x1000), fallbackIat ? 0 : 0x1080); dword(off(0x100c), 0x1040); dword(off(0x1010), 0x10c0);
  str(0x1040, 'QQNT.dll'); word(off(0x1100), 17); str(0x1102, 'napi_test');
  for (const table of [0x1080, 0x10c0]) {
    ptr(table, 0x1100); ptr(table + width, (is64 ? 0x8000000000000000n : 0x80000000n) | 9n); ptr(table + width * 2, 0);
  }
  const exp = off(0x1200);
  dword(exp + 12, 0x1230); dword(exp + 16, 7); dword(exp + 20, 3); dword(exp + 24, 3);
  dword(exp + 28, 0x1240); dword(exp + 32, 0x1250); dword(exp + 36, 0x1260);
  str(0x1230, 'synthetic.dll'); dword(off(0x1240), 0x1600); dword(off(0x1244), 0x1280); dword(off(0x1248), 0);
  [0x12a0, 0x12b0, 0x12c0].forEach((rva, i) => dword(off(0x1250) + i * 4, rva));
  [0, 0, 1].forEach((value, i) => word(off(0x1260) + i * 2, value));
  str(0x1280, 'other.#9'); str(0x12a0, 'napi_test'); str(0x12b0, 'alias'); str(0x12c0, 'forwarded');
  const delayAddress = rva => delayVa ? rva + 0x400000 : rva;
  dword(off(0x1400), delayVa ? 0 : 1); dword(off(0x1404), delayAddress(0x1440));
  dword(off(0x140c), delayAddress(0x14c0)); dword(off(0x1410), delayAddress(0x1480));
  str(0x1440, 'DELAY.dll'); word(off(0x1540), 2); str(0x1542, 'uv_delay');
  ptr(0x1480, delayAddress(0x1540)); ptr(0x14c0, delayAddress(0x1540));
  return { b, pe, optional, dir, sections, off, word, dword, str, ptr, width };
}

test('positive PE32+ parses complete names, aliases, ordinals, unused slots and forwarder', () => {
  const f = fixture(), p = inspectPE(f.b);
  assert.equal(p.sha256, createHash('sha256').update(f.b).digest('hex'));
  assert.equal(p.format, 'PE32+'); assert.equal(p.machine, '0x8664');
  assert.equal(p.imports.length, 1); assert.equal(p.delayImports.length, 1);
  assert.equal(p.imports[0].module, 'QQNT.dll');
  assert.deepEqual(p.imports[0].symbols.map(s => s.name ?? s.ordinal), ['napi_test', 9]);
  assert.equal(p.imports[0].symbols[0].hint, 17);
  assert.equal(p.imports[0].symbols[0].nameFileOffset, f.off(0x1102));
  assert.equal(p.delayImports[0].symbols[0].name, 'uv_delay');
  assert.deepEqual(p.exports.entries.map(e => e.ordinal), [7, 8, 9]);
  assert.deepEqual(p.exports.entries[0].names.map(e => e.name), ['napi_test', 'alias']);
  assert.equal(p.exports.entries[1].forwarder, 'other.#9');
  assert.equal(p.exports.entries[2].kind, 'unused');
});

test('PE32 handles OriginalFirstThunk fallback and historical delay VA encoding', () => {
  const p = inspectPE(fixture({ is64: false, delayVa: true, fallbackIat: true }).b);
  assert.equal(p.format, 'PE32'); assert.equal(p.machine, '0x14c');
  assert.equal(p.imports[0].lookupRva, 0x10c0);
  assert.equal(p.delayImports[0].symbols[0].name, 'uv_delay');
  assert.equal(p.imports[0].symbols[1].ordinal, 9);
});

test('name comparison uses exact symbol case, DLL case folding, and never equates ordinals across modules', () => {
  const consumer = inspectPE(fixture().b), provider = inspectPE(fixture().b);
  let comparison = compareModuleImports(consumer, provider, 'qqnt.DLL');
  assert.equal(comparison.requirementCount, 2); assert.equal(comparison.exactNamePresent, 1);
  assert.equal(comparison.ordinalUnresolved, 1); assert.equal(comparison.absent, 0);
  provider.exports.entries[0].names[0].name = 'NAPI_TEST';
  comparison = compareModuleImports(consumer, provider, 'qqnt.dll');
  assert.equal(comparison.exactNamePresent, 0); assert.equal(comparison.absent, 1);
  assert.equal(comparison.requirements[1].status, 'ordinal-cannot-map-between-different-modules');
});

test('forwarded export stays identified as forwarded metadata, not confirmed callable', () => {
  const f = fixture(); f.str(0x1102, 'forwarded');
  const result = compareModuleImports(inspectPE(f.b), inspectPE(fixture().b), 'QQNT.dll');
  assert.equal(result.requirements[0].providerMatches[0].kind, 'forwarder');
  assert.equal(result.requirements[0].providerMatches[0].forwarder, 'other.#9');
});

test('absent import/export directories give an explicit empty inventory', () => {
  const f = fixture(); f.b.fill(0, f.dir, f.dir + 16 * 8);
  const p = inspectPE(f.b);
  assert.deepEqual(p.imports, []); assert.deepEqual(p.delayImports, []); assert.deepEqual(p.exports.entries, []);
});

test('truncation, invalid signatures, impossible counts and directory ranges fail closed', () => {
  for (const length of [0, 10, 63, 0x90, 0x1ff, 0xfff]) assert.throws(() => inspectPE(fixture().b.subarray(0, length)), /Invalid or unsupported PE/);
  const corruptions = [
    f => f.word(0, 0), f => f.dword(f.pe, 0), f => f.word(f.optional, 0x999),
    f => f.dword(0x3c, 0xfffffff0), f => f.word(f.pe + 6, 97),
    f => f.dword(f.dir - 4, 17), f => f.word(f.pe + 20, 4),
    f => f.dword(f.dir + 12, 0), f => f.dword(f.dir + 8, 0x1fff),
    f => f.dword(f.off(0x1200) + 20, 1000001), f => f.word(f.off(0x1260), 3),
  ];
  for (const corrupt of corruptions) { const f = fixture(); corrupt(f); assert.throws(() => inspectPE(f.b), /Invalid or unsupported PE/); }
});

test('rejects virtual-only names, raw/virtual overlap, reserved ordinal bits and unterminated descriptors', () => {
  const corruptions = [
    f => { f.dword(f.sections + 16, 0x800); f.dword(f.off(0x100c), 0x1d00); },
    f => { f.word(f.pe + 6, 2); f.b.copy(f.b, f.sections + 40, f.sections, f.sections + 40); },
    f => { f.word(f.pe + 6, 2); f.b.copy(f.b, f.sections + 40, f.sections, f.sections + 40); f.dword(f.sections + 52, 0x2000); f.dword(f.optional + 56, 0x4000); },
    f => f.ptr(0x1080, 0x8000000000010009n),
    f => f.dword(f.dir + 12, 20),
    f => { f.dword(f.dir + 13 * 8 + 4, 32); },
    f => f.dword(f.off(0x1400), 2),
    f => { f.dword(f.off(0x1244), 0x12ff); f.b[f.off(0x12ff)] = 65; },
    f => { f.dword(f.off(0x100c), 0x1dff); f.b[f.off(0x1dff)] = 65; },
  ];
  for (const corrupt of corruptions) { const f = fixture(); corrupt(f); assert.throws(() => inspectPE(f.b), /Invalid or unsupported PE/); }
});

test('unterminated thunk table and out-of-image exported address are rejected', () => {
  const f = fixture(); f.dword(f.off(0x1000), 0x1df8); f.ptr(0x1df8, 0x8000000000000009n);
  assert.throws(() => inspectPE(f.b), /unterminated thunk/);
  const g = fixture(); g.dword(g.off(0x1240), 0xffffffff);
  assert.throws(() => inspectPE(g.b), /export address outside image/);
});
