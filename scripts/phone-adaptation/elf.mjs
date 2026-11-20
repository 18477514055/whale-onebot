import { fail } from './safe-files.mjs';

// Deliberately small ELF64/LE program-header inspector. No ldd, readelf, dlopen,
// native import or process execution. Does not resolve symbols or RPATH closure.
export function inspectElf(bytes) {
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 ||
        offset > bytes.length || size > bytes.length - offset) fail('MALFORMED_ELF');
  };
  range(0, 64);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('NOT_ELF');
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1) fail('UNSUPPORTED_ELF');
  const u64 = offset => { range(offset, 8); const n = bytes.readBigUInt64LE(offset);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('MALFORMED_ELF'); return Number(n); };
  if (bytes.readUInt16LE(52) !== 64 || bytes.readUInt32LE(20) !== 1) fail('MALFORMED_ELF');
  const machineId = bytes.readUInt16LE(18), typeId = bytes.readUInt16LE(16);
  if (![2, 3].includes(typeId)) fail('UNSUPPORTED_ELF');
  const phoff = u64(32), phsize = bytes.readUInt16LE(54), phnum = bytes.readUInt16LE(56);
  if (phsize !== 56 || phnum < 1 || phnum > 4096) fail('MALFORMED_ELF');
  range(phoff, phsize * phnum);
  const segments = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + phsize * i;
    const s = { type: bytes.readUInt32LE(p), offset: u64(p + 8), va: u64(p + 16),
      size: u64(p + 32), memsize: u64(p + 40) };
    range(s.offset, s.size);
    if (s.type === 1 && s.memsize < s.size) fail('MALFORMED_ELF');
    segments.push(s);
  }
  function text(offset, max, pattern) {
    range(offset, max);
    if (max < 1 || max > 1024 * 1024) fail('MALFORMED_ELF');
    const end = bytes.indexOf(0, offset);
    if (end < offset || end >= offset + max || end - offset > 4096) fail('MALFORMED_ELF');
    const value = bytes.toString('utf8', offset, end);
    if (!pattern.test(value)) fail('UNSAFE_ELF_STRING');
    return value;
  }
  const interpreters = segments.filter(s => s.type === 3), dynamics = segments.filter(s => s.type === 2);
  if (interpreters.length > 1 || dynamics.length > 1) fail('MALFORMED_ELF');
  const interpreter = interpreters.length ? text(interpreters[0].offset, interpreters[0].size, /^\/[A-Za-z0-9_./+-]{1,255}$/) : null;
  const neededOffsets = []; let strtab, strsize, sonameOffset;
  if (dynamics.length) {
    const dynamic = dynamics[0];
    if (dynamic.size % 16 || dynamic.size > 16 * 16384) fail('MALFORMED_ELF');
    let terminated = false;
    for (let p = dynamic.offset; p < dynamic.offset + dynamic.size; p += 16) {
      const tag = u64(p), value = u64(p + 8);
      if (tag === 0) { terminated = true; break; }
      if (tag === 1) neededOffsets.push(value);
      if (tag === 5) { if (strtab !== undefined) fail('MALFORMED_ELF'); strtab = value; }
      if (tag === 10) { if (strsize !== undefined) fail('MALFORMED_ELF'); strsize = value; }
      if (tag === 14) { if (sonameOffset !== undefined) fail('MALFORMED_ELF'); sonameOffset = value; }
    }
    if (!terminated) fail('MALFORMED_ELF');
  }
  const names = [...neededOffsets, ...(sonameOffset === undefined ? [] : [sonameOffset])];
  if (names.length > 4096) fail('MALFORMED_ELF');
  let stringBase;
  if (names.length) {
    if (!strsize || strtab === undefined || strsize > 16 * 1024 * 1024) fail('MALFORMED_ELF');
    const mappings = segments.filter(s => s.type === 1 && strtab >= s.va &&
      strtab - s.va <= s.size && strsize <= s.size - (strtab - s.va));
    if (mappings.length !== 1) fail('MALFORMED_ELF');
    stringBase = mappings[0].offset + strtab - mappings[0].va;
    range(stringBase, strsize);
  }
  const nameAt = n => {
    if (n >= strsize) fail('MALFORMED_ELF');
    return text(stringBase + n, Math.min(strsize - n, 4097), /^[A-Za-z0-9_.+-]{1,128}$/);
  };
  const needed = neededOffsets.map(nameAt), soname = sonameOffset === undefined ? null : nameAt(sonameOffset);
  const glibc = needed.includes('libc.so.6') || !!interpreter?.includes('ld-linux-');
  const bionic = needed.includes('libc.so') || /^\/system\/bin\/linker(?:64)?$/.test(interpreter ?? '');
  return { elfClass: 64, byteOrder: 'little', machine: machineId === 183 ? 'aarch64' : machineId === 62 ? 'x86_64' : 'unsupported',
    type: typeId === 2 ? 'executable' : 'shared-or-pie', interpreter, needed, soname,
    libc: glibc && bionic ? 'conflicting' : glibc ? 'glibc' : bionic ? 'bionic' : 'unknown',
    symbolResolutionProven: false, initializerReachabilityProven: false };
}
