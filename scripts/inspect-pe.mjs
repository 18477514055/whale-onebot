import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Original, read-only PE table parser. No LoadLibrary/dlopen/child process.
// Format reference: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
const MAX_ENTRIES = 1_000_000;
const bad = reason => { throw new Error(`Invalid or unsupported PE: ${reason}`); };
const hex = value => `0x${value.toString(16)}`;

export function inspectPE(bytes) {
  if (!Buffer.isBuffer(bytes)) bad('expected Buffer');
  function range(offset, length, label = 'file range') {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) bad(label);
    return offset;
  }
  const u16 = offset => bytes.readUInt16LE(range(offset, 2));
  const u32 = offset => bytes.readUInt32LE(range(offset, 4));
  const u64 = offset => bytes.readBigUInt64LE(range(offset, 8));
  range(0, 64, 'DOS header');
  if (u16(0) !== 0x5a4d) bad('DOS signature');
  const pe = u32(0x3c);
  range(pe, 24, 'PE header');
  if (u32(pe) !== 0x4550) bad('PE signature');
  const machine = u16(pe + 4), sectionCount = u16(pe + 6), optionalSize = u16(pe + 20);
  if (!sectionCount || sectionCount > 96) bad('section count');
  const optional = pe + 24;
  range(optional, optionalSize, 'optional header');
  const magic = u16(optional), is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b) bad('optional magic');
  const dirOffset = is64 ? 112 : 96;
  if (optionalSize < dirOffset) bad('short optional header');
  const imageBase = is64 ? u64(optional + 24) : BigInt(u32(optional + 28));
  const imageSize = u32(optional + 56), headerSize = u32(optional + 60);
  const directoryCount = u32(optional + dirOffset - 4);
  if (directoryCount > Math.floor((optionalSize - dirOffset) / 8)) bad('directory count');
  const sectionTable = optional + optionalSize;
  range(sectionTable, sectionCount * 40, 'section table');
  if (headerSize < sectionTable + sectionCount * 40 || headerSize > bytes.length) bad('header size');
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const off = sectionTable + i * 40;
    const s = { name: bytes.subarray(off, off + 8).toString('latin1').replace(/\0.*$/, ''),
      virtualSize: u32(off + 8), rva: u32(off + 12), rawSize: u32(off + 16), rawOffset: u32(off + 20), characteristics: u32(off + 36) };
    const virtualExtent = Math.max(s.virtualSize, s.rawSize);
    if (s.rva < headerSize || s.rva + virtualExtent > 0x1_0000_0000 || s.rva + virtualExtent > imageSize) bad('section virtual range');
    if (s.rawSize) {
      range(s.rawOffset, s.rawSize, 'section raw range');
      if (s.rawOffset < headerSize) bad('section overlaps headers');
    }
    for (const other of sections) {
      if (s.rva < other.rva + Math.max(other.virtualSize, other.rawSize) && other.rva < s.rva + virtualExtent) bad('overlapping section RVAs');
      if (s.rawSize && other.rawSize && s.rawOffset < other.rawOffset + other.rawSize && other.rawOffset < s.rawOffset + s.rawSize) bad('overlapping raw sections');
    }
    sections.push(s);
  }
  function locate(rva, length = 1) {
    if (!Number.isInteger(rva) || rva <= 0 || !Number.isInteger(length) || length < 1 || rva + length > 0x1_0000_0000) bad('RVA bounds');
    if (rva < headerSize) {
      if (rva + length > headerSize) bad('RVA crosses header');
      return { offset: range(rva, length), available: headerSize - rva };
    }
    const s = sections.find(section => rva >= section.rva && rva < section.rva + Math.max(section.virtualSize, section.rawSize));
    if (!s || rva - s.rva + length > s.rawSize) bad('RVA not file backed');
    return { offset: range(s.rawOffset + rva - s.rva, length), available: s.rawSize - (rva - s.rva) };
  }
  const at = (rva, length = 1) => locate(rva, length).offset;
  function stringAt(rva, limit = 65536) {
    const { offset, available } = locate(rva);
    const maximum = Math.min(available, limit);
    const zero = bytes.subarray(offset, offset + maximum).indexOf(0);
    if (zero < 0) bad('unterminated string');
    const raw = bytes.subarray(offset, offset + zero);
    if (!raw.length) bad('empty symbol or module name');
    return { value: raw.toString('latin1'), bytesHex: raw.toString('hex'), fileOffset: offset };
  }
  function directory(index) {
    if (index >= directoryCount) return null;
    const off = optional + dirOffset + index * 8, rva = u32(off), size = u32(off + 4);
    if (!rva && !size) return null;
    if (!rva || !size) bad('partial directory');
    at(rva, size);
    return { rva, size, fileOffset: at(rva) };
  }
  function table(rva, count, width) {
    if (count > MAX_ENTRIES) bad('table budget');
    return count ? at(rva, count * width) : null;
  }
  const width = is64 ? 8 : 4, ordinalFlag = is64 ? 0x8000000000000000n : 0x80000000n;
  function thunks(lookupRva, iatRva, nameIsVa = false) {
    const symbols = [];
    const start = locate(lookupRva, width);
    const maximum = Math.min(Math.floor(start.available / width), MAX_ENTRIES);
    for (let index = 0; index < maximum; index++) {
      const thunkRva = lookupRva + index * width, fileOffset = at(thunkRva, width);
      const value = is64 ? u64(fileOffset) : BigInt(u32(fileOffset));
      at(iatRva + index * width, width);
      if (value === 0n) return symbols;
      const item = { index, thunkRva, fileOffset, iatRva: iatRva + index * width, lookupValueHex: hex(value) };
      if (value & ordinalFlag) {
        if ((value & ~(ordinalFlag | 0xffffn)) !== 0n) bad('ordinal reserved bits');
        symbols.push({ ...item, kind: 'ordinal', ordinal: Number(value & 0xffffn) });
      } else {
        const nameRva = nameIsVa ? value - imageBase : value;
        if (nameRva <= 0n || nameRva > 0xffffffffn) bad('import name RVA');
        const hintOffset = at(Number(nameRva), 3), name = stringAt(Number(nameRva) + 2);
        symbols.push({ ...item, kind: 'name', hint: u16(hintOffset), name: name.value, nameBytesHex: name.bytesHex, nameFileOffset: name.fileOffset });
      }
    }
    bad('unterminated thunk table or table budget');
  }
  function imports(index, delay = false) {
    const dir = directory(index);
    if (!dir) return [];
    const result = [], stride = delay ? 32 : 20;
    for (let offset = 0; offset + stride <= dir.size; offset += stride) {
      const off = at(dir.rva + offset, stride);
      const fields = Array.from({ length: stride / 4 }, (_, n) => u32(off + n * 4));
      if (fields.every(value => value === 0)) return result;
      let nameRva, lookupRva, iatRva, attributes;
      if (delay) {
        attributes = fields[0];
        if (attributes !== 0 && attributes !== 1) bad('delay attributes');
        const toRva = value => {
          const converted = attributes === 1 ? BigInt(value) : BigInt(value) - imageBase;
          if (converted <= 0n || converted > 0xffffffffn) bad('delay VA/RVA');
          return Number(converted);
        };
        nameRva = toRva(fields[1]); iatRva = toRva(fields[3]); lookupRva = fields[4] ? toRva(fields[4]) : iatRva;
      } else {
        nameRva = fields[3]; iatRva = fields[4]; lookupRva = fields[0] || iatRva;
      }
      const name = stringAt(nameRva);
      result.push({ kind: delay ? 'delay' : 'normal', module: name.value, moduleBytesHex: name.bytesHex,
        descriptorRva: dir.rva + offset, descriptorFileOffset: off, descriptorFields: fields,
        lookupRva, iatRva, symbols: thunks(lookupRva, iatRva, delay && attributes === 0) });
    }
    bad('unterminated import descriptor table');
  }
  function exports() {
    const dir = directory(0);
    if (!dir) return { module: null, ordinalBase: null, entries: [] };
    if (dir.size < 40) bad('export directory size');
    const off = at(dir.rva, 40), ordinalBase = u32(off + 16), functionCount = u32(off + 20), nameCount = u32(off + 24);
    if (ordinalBase + functionCount > 0x1_0000_0000) bad('export ordinal overflow');
    const funcs = table(u32(off + 28), functionCount, 4), names = table(u32(off + 32), nameCount, 4), ordinals = table(u32(off + 36), nameCount, 2);
    const aliases = new Map();
    for (let index = 0; index < nameCount; index++) {
      const ordinalIndex = u16(ordinals + index * 2);
      if (ordinalIndex >= functionCount) bad('export name ordinal outside EAT');
      const name = stringAt(u32(names + index * 4));
      const items = aliases.get(ordinalIndex) ?? [];
      items.push({ name: name.value, nameBytesHex: name.bytesHex, nameFileOffset: name.fileOffset, nameTableIndex: index });
      aliases.set(ordinalIndex, items);
    }
    const entries = [];
    for (let index = 0; index < functionCount; index++) {
      const addressRva = u32(funcs + index * 4), within = addressRva >= dir.rva && addressRva < dir.rva + dir.size;
      const item = { ordinal: ordinalBase + index, addressRva, addressTableFileOffset: funcs + index * 4,
        names: aliases.get(index) ?? [], kind: addressRva === 0 ? 'unused' : within ? 'forwarder' : 'address' };
      if (within) {
        const f = stringAt(addressRva, dir.rva + dir.size - addressRva);
        item.forwarder = f.value; item.forwarderBytesHex = f.bytesHex;
      }
      // An export address may name uninitialized data; do not pretend it is code.
      if (addressRva >= imageSize) bad('export address outside image');
      entries.push(item);
    }
    return { module: stringAt(u32(off + 12)).value, ordinalBase, directory: dir, entries };
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'), fileSize: bytes.length,
    format: is64 ? 'PE32+' : 'PE32', machine: hex(machine), imageBase: hex(imageBase), imageSize, headerSize,
    sections, imports: imports(1), delayImports: imports(13, true), exports: exports(),
    coverage: 'complete encoded normal/delay import and export tables; not loader execution or ABI semantic validation',
  };
}

export function compareModuleImports(consumer, provider, moduleName) {
  const named = new Map();
  for (const entry of provider.exports.entries) {
    if (entry.kind === 'unused') continue;
    for (const alias of entry.names) {
      const previous = named.get(alias.name) ?? [];
      previous.push({ ordinal: entry.ordinal, kind: entry.kind, addressRva: entry.addressRva, forwarder: entry.forwarder ?? null });
      named.set(alias.name, previous);
    }
  }
  const requirements = [];
  for (const descriptor of [...consumer.imports, ...consumer.delayImports]) {
    if (descriptor.module.toLowerCase() !== moduleName.toLowerCase()) continue;
    for (const symbol of descriptor.symbols) {
      const matches = symbol.kind === 'name' ? named.get(symbol.name) ?? [] : [];
      requirements.push({ importKind: descriptor.kind, module: descriptor.module, ...symbol,
        group: symbol.kind === 'ordinal' ? 'ordinal' : symbol.name.startsWith('napi_') ? 'napi' : symbol.name.startsWith('uv_') ? 'uv' : 'other',
        status: symbol.kind === 'ordinal' ? 'ordinal-cannot-map-between-different-modules' : matches.length ? 'exact-export-name-present' : 'absent',
        providerMatches: matches });
    }
  }
  const present = requirements.filter(x => x.status === 'exact-export-name-present').length;
  return { module: moduleName, matching: 'DLL names case-insensitive; export symbol names exact case-sensitive per PE linkage',
    requirementCount: requirements.length, exactNamePresent: present,
    absent: requirements.filter(x => x.status === 'absent').length,
    ordinalUnresolved: requirements.filter(x => x.kind === 'ordinal').length,
    architectureMatches: consumer.machine === provider.machine && consumer.format === provider.format,
    requirements, conclusion: 'Name presence is necessary metadata only; calling conventions, C++ ABI, allocator, event-loop and function semantics are not verified.' };
}

async function stableRead(filename) {
  const before = await stat(filename);
  if (!before.isFile()) bad('target is not regular file');
  const bytes = await readFile(filename);
  const after = await stat(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) bad('target changed during read');
  return { path: filename, ...inspectPE(bytes) };
}

async function audit() {
  // Explicit authorized targets only; no discovery of accounts or native loading.
  const wrapper = await stableRead('D:\\QQ-Agent\\pc-bot-shell\\versions\\9.9.33-52230\\resources\\app\\wrapper.node');
  const node = await stableRead('C:\\Program Files\\nodejs\\node.exe');
  const comparison = compareModuleImports(wrapper, node, 'QQNT.dll');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), method: 'original static PE byte parser; no native execution',
    parserSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    wrapper, node, comparison };
  await writeFile(path.join(root, 'evidence', 'native-abi.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ wrapper: { sha256: wrapper.sha256, bytes: wrapper.fileSize }, node: { sha256: node.sha256, bytes: node.fileSize },
    counts: { requirements: comparison.requirementCount, present: comparison.exactNamePresent, absent: comparison.absent, ordinalUnresolved: comparison.ordinalUnresolved },
    missing: comparison.requirements.filter(x => x.status !== 'exact-export-name-present').map(x => x.name ?? `ordinal:${x.ordinal}`) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--audit') throw new Error('Usage: node scripts/inspect-pe.mjs --audit');
  await audit();
}
