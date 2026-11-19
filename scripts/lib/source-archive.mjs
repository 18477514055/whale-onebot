import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_TAR = 64 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_PATH = 4096;
const BLOCK = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(message) {
  throw new Error(`Invalid source archive: ${message}`);
}

function regular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    fail('input must be a regular, non-link file with nlink 1');
  }
}

function unchanged(before, after) {
  regular(after);
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) {
    if (before[key] !== after[key]) fail('input changed while reading');
  }
}

function readStable(file) {
  const initial = lstatSync(file, { bigint: true });
  regular(initial);
  if (initial.size > BigInt(MAX_COMPRESSED)) fail('compressed size exceeds 32 MiB');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(file, flags);
  try {
    unchanged(initial, fstatSync(fd, { bigint: true }));
    const data = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (!count) fail('input truncated while reading');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) fail('input grew while reading');
    unchanged(initial, fstatSync(fd, { bigint: true }));
    unchanged(initial, lstatSync(file, { bigint: true }));
    return data;
  } finally {
    closeSync(fd);
  }
}

function decode(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    fail('invalid UTF-8');
  }
}

function zero(bytes) {
  return bytes.every((value) => value === 0);
}

function field(bytes) {
  const nul = bytes.indexOf(0);
  if (nul < 0) return bytes;
  if (!zero(bytes.subarray(nul))) fail('nonzero bytes after header string terminator');
  return bytes.subarray(0, nul);
}

function octal(bytes, label) {
  if (bytes[0] & 0x80) fail(`${label}: base-256 is unsupported`);
  const text = bytes.toString('latin1').replace(/^[\x00 ]+|[\x00 ]+$/g, '');
  if (!/^[0-7]+$/.test(text)) fail(`${label}: expected octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail(`${label}: integer overflow`);
  return value;
}

function pathName(name, directory) {
  if (!name || Buffer.byteLength(name, 'utf8') > MAX_PATH) fail('path is empty or exceeds 4096 bytes');
  if (/[\\:\x00\r\n]/.test(name) || name.startsWith('/')) fail('unsafe path');
  const parts = name.split('/');
  if (parts.at(-1) === '' && directory) parts.pop();
  if (parts.some((part) => part === '' || part === '.' || part === '..')) fail('unsafe path component');
  return parts.join('/');
}

function decimal(text, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) fail(`${label}: expected unsigned decimal`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) fail(`${label}: integer overflow`);
  return value;
}

function pax(payload) {
  const values = new Map();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0 || space - offset > 10) fail('PAX record length');
    const digits = payload.subarray(offset, space).toString('latin1');
    if (!/^[1-9][0-9]*$/.test(digits)) fail('PAX record length');
    const length = Number(digits);
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > payload.length || end <= space + 1 || payload[end - 1] !== 10) {
      fail('PAX record length or terminator');
    }
    const record = decode(payload.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    if (equals <= 0) fail('PAX record missing key/value');
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (values.has(key)) fail('duplicate PAX key');
    if (!['path', 'mtime', 'atime', 'ctime', 'size'].includes(key)) fail('unsupported PAX key');
    if (key === 'path') {
      // Directory trailing slash is checked against the following real header.
      pathName(value, true);
    } else if (key === 'size') {
      decimal(value, 'PAX size');
    } else if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
      fail('invalid PAX timestamp');
    }
    values.set(key, value);
    offset = end;
  }
  if (!payload.length) fail('empty PAX metadata');
  return values;
}

/**
 * Read this project's UTF-8 .tar.gz source archive without CLI text or extraction.
 * Synchronous; returns [{ name, type: 'file' | 'directory', size }].
 * Deliberately rejects unsupported tar extensions rather than guessing encodings.
 */
export function readSourceArchive(file) {
  const compressed = readStable(file);
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR });
  } catch {
    fail('invalid gzip or decompressed output exceeds 64 MiB');
  }
  if (tar.length % BLOCK) fail('truncated tar block');
  const entries = [];
  const names = new Set();
  let pendingPax;
  let pendingLong;
  let count = 0;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (zero(header)) {
      if (pendingPax || pendingLong !== undefined) fail('dangling metadata');
      if (tar.length - offset < 2 * BLOCK || !zero(tar.subarray(offset))) fail('missing two zero blocks or nonzero trailing bytes');
      return entries;
    }
    if (++count > MAX_ENTRIES) fail('entry count exceeds 5000 (including metadata)');
    const expected = octal(header.subarray(148, 156), 'checksum');
    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) fail('header checksum mismatch');
    const headerSize = octal(header.subarray(124, 136), 'size');
    const magic = header.subarray(257, 263).toString('latin1');
    if (magic !== 'ustar\0' && magic !== 'ustar ' && !zero(header.subarray(257, 265))) fail('unsupported tar format');
    const base = decode(field(header.subarray(0, 100)));
    const prefix = magic === 'ustar\0' ? decode(field(header.subarray(345, 500))) : '';
    const rawName = prefix ? `${prefix}/${base}` : base;
    const type = header[156];
    if (![0, 48, 53, 120, 76].includes(type)) fail('unsupported entry type (links, global PAX and special files are forbidden)');
    if (!zero(header.subarray(157, 257))) fail('link target is forbidden');
    const metadata = type === 120 || type === 76;
    const size = !metadata && pendingPax?.has('size') ? decimal(pendingPax.get('size'), 'PAX size') : headerSize;
    const start = offset + BLOCK;
    const end = start + size;
    const next = start + Math.ceil(size / BLOCK) * BLOCK;
    if (!Number.isSafeInteger(next) || end > tar.length || next > tar.length) fail('truncated entry payload');
    if (!zero(tar.subarray(end, next))) fail('nonzero entry padding');
    const payload = tar.subarray(start, end);
    if (type === 120) {
      if (pendingPax) fail('duplicate pending PAX metadata');
      pendingPax = pax(payload);
      if (pendingLong !== undefined && pendingPax.has('path')) fail('conflicting path metadata');
    } else if (type === 76) {
      if (pendingLong !== undefined) fail('duplicate pending GNU long name');
      if (!payload.length || payload.at(-1) !== 0 || payload.subarray(0, -1).includes(0)) fail('invalid GNU long name terminator');
      if (payload.length - 1 > MAX_PATH) fail('path exceeds 4096 bytes');
      pendingLong = decode(payload.subarray(0, -1));
      pathName(pendingLong, true);
      if (pendingPax?.has('path')) fail('conflicting path metadata');
    } else {
      const directory = type === 53;
      const name = pendingPax?.get('path') ?? pendingLong ?? rawName;
      const key = pathName(name, directory);
      // Validate fallback header names too: an extension cannot mask unsafe bytes.
      pathName(rawName, directory);
      if (directory && size !== 0) fail('directory has nonzero size');
      if (names.has(key)) fail('duplicate archive member');
      names.add(key);
      entries.push({ name, type: directory ? 'directory' : 'file', size });
      pendingPax = undefined;
      pendingLong = undefined;
    }
    offset = next;
  }
  if (pendingPax || pendingLong !== undefined) fail('dangling metadata');
  fail('missing two zero end blocks');
}
