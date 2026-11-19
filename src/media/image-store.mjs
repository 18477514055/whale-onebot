// Original bounded raster staging; PNG retains independent CRC/structure checks.
// Every successful asset additionally completes isolated full-frame pixel decoding.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {ImageDecoder} from './image-decoder.mjs';

const MiB = 1024 * 1024;
const TOKEN = /^img_([a-f0-9]{32})_([a-f0-9]{64})$/;
const INLINE_IMAGE_PREFIX = 'base64://';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedValue = (name, value) => Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get.call(value);
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export class ImageStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'ImageStoreError'; this.code = code; }
}
function fail(code, message) { throw new ImageStoreError(code, message); }
function requireImage(condition, message) { if (!condition) fail('INVALID_IMAGE', message); }
function digest(algorithm, bytes) { return createHash(algorithm).update(bytes).digest('hex'); }
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngMetadata(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG)) fail('UNSUPPORTED_FORMAT', 'Only content-identified PNG is supported');
  let position = 8, chunks = 0, header, paletteEntries = 0, transparency = false, dataStarted = false, dataEnded = false, ended = false;
  const compressed = [];
  while (position < bytes.length) {
    requireImage(++chunks <= 16384 && bytes.length - position >= 12, 'Invalid PNG chunk boundary');
    const length = bytes.readUInt32BE(position);
    requireImage(length <= bytes.length - position - 12, 'Truncated PNG chunk');
    const kind = bytes.toString('latin1', position + 4, position + 8);
    requireImage(/^[A-Za-z]{4}$/.test(kind) && kind[2] === kind[2].toUpperCase(), 'Invalid PNG chunk type');
    const content = bytes.subarray(position + 8, position + 8 + length);
    requireImage(crc(bytes.subarray(position + 4, position + 8 + length)) === bytes.readUInt32BE(position + 8 + length), 'PNG CRC mismatch');
    if (!header) requireImage(kind === 'IHDR', 'PNG must begin with IHDR');
    if (dataStarted && kind !== 'IDAT') dataEnded = true;
    if (kind === 'IHDR') {
      requireImage(!header && length === 13, 'Invalid or duplicate IHDR');
      const width = content.readUInt32BE(0), height = content.readUInt32BE(4), depth = content[8], color = content[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      requireImage(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 16 * 1024 * 1024, 'PNG dimensions exceed bounds');
      requireImage(depths[color]?.includes(depth) && content[10] === 0 && content[11] === 0 && content[12] <= 1, 'Unsupported PNG header fields');
      header = { width, height, depth, color, interlace: content[12], channels: { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color] };
    } else if (kind === 'PLTE') {
      requireImage(!paletteEntries && !dataStarted && !transparency && ![0, 4].includes(header.color) && length > 0 && length <= 768 && length % 3 === 0, 'Invalid PNG palette');
      paletteEntries = length / 3;
      requireImage(header.color !== 3 || paletteEntries <= 2 ** header.depth, 'PNG palette exceeds bit depth');
    } else if (kind === 'tRNS') {
      requireImage(!transparency && !dataStarted, 'Invalid transparency chunk order');
      requireImage(header.color === 0 ? length === 2 : header.color === 2 ? length === 6 : header.color === 3 && paletteEntries > 0 && length > 0 && length <= paletteEntries, 'Invalid PNG transparency');
      transparency = true;
    } else if (kind === 'IDAT') {
      requireImage(!dataEnded && (header.color !== 3 || paletteEntries > 0), 'Invalid PNG image data order');
      dataStarted = true; compressed.push(content);
    } else if (kind === 'IEND') {
      requireImage(length === 0 && dataStarted && position + 12 === bytes.length, 'Invalid PNG end or trailing bytes');
      ended = true;
    } else {
      if (['acTL', 'fcTL', 'fdAT'].includes(kind)) fail('UNSUPPORTED_FORMAT', 'Animated PNG is not supported');
      requireImage(kind[0] === kind[0].toLowerCase(), 'Unknown critical PNG chunk');
      // Ancillary payload semantics are deliberately not claimed as decoded.
    }
    position += length + 12;
  }
  requireImage(ended && header, 'PNG is incomplete');
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const width = Math.max(0, Math.ceil((header.width - x) / dx)), height = Math.max(0, Math.ceil((header.height - y) / dy));
    if (!width || !height) continue;
    const rowBytes = 1 + Math.ceil(width * header.channels * header.depth / 8);
    expected += rowBytes * height; rows.push({ rowBytes, height });
  }
  requireImage(expected <= 64 * MiB, 'Inflated PNG exceeds bounds');
  let inflated;
  const encoded = Buffer.concat(compressed);
  try {
    inflated = inflateSync(encoded, { maxOutputLength: expected, info: true });
  } catch { fail('INVALID_IMAGE', 'PNG compressed data is invalid or oversized'); }
  requireImage(inflated.buffer.length === expected && inflated.engine.bytesWritten === encoded.length, 'PNG data length or compressed trailing bytes mismatch');
  let offset = 0;
  for (const { rowBytes, height } of rows) for (let row = 0; row < height; row++) {
    requireImage(inflated.buffer[offset] <= 4, 'Invalid PNG row filter'); offset += rowBytes;
  }
  return { format: 'png', width: header.width, height: header.height, validation: 'structure', decoded: false };
}

function physicalDirectories(directory) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail('UNSAFE_PATH', 'Image store requires physical directories');
  }
}
function regular(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || fs.realpathSync(file) !== file) fail('UNSAFE_PATH', 'Image assets must be physical files with one link');
  return stat;
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function safeName(filename) {
  if (filename === undefined) return;
  if (typeof filename !== 'string' || !filename || filename.length > 128 || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(filename) || /^\.+$/.test(filename) || /[. ]$/.test(filename)) fail('INVALID_FILENAME', 'filename must be a bounded plain filename hint');
}

/**
 * Only explicit byte snapshots enter this store; no URL/path import API exists.
 * Successful assets are retained. A stale .stage.lock fails closed (no automatic
 * deletion/recovery). Standard Node APIs cannot exclude hostile concurrent parent
 * directory replacement on every platform; this is not a hostile-host sandbox.
 */
export class ImageStore {
  #decoder;
  constructor({ projectRoot, maxBytes = 10 * MiB } = {}) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.basename(path.resolve(projectRoot)).toLowerCase() !== 'qq-onebot') fail('INVALID_ROOT', 'An absolute independent qq-onebot project root is required');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 64 * MiB) fail('INVALID_LIMIT', 'maxBytes must be between 64 bytes and 64 MiB');
    this.projectRoot = path.resolve(projectRoot);
    physicalDirectories(this.projectRoot);
    this.root = path.join(this.projectRoot, 'runtime', 'media');
    this.maxBytes = maxBytes;
    this.maxTotalBytes = Math.min(maxBytes * 16, 128 * MiB);
    this.maxAssets = 256;
    this.#decoder = new ImageDecoder({maxInputBytes:maxBytes});
    Object.freeze(this);
  }
  prepare() {
    physicalDirectories(this.projectRoot);
    for (const directory of [path.join(this.projectRoot, 'runtime'), this.root]) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      physicalDirectories(directory);
    }
  }
  assetPath(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) fail('INVALID_TOKEN', 'A store-issued image token is required');
    return path.join(this.root, token + '.asset');
  }
  async #metadata(token, bytes) {
    const sha256 = digest('sha256', bytes);
    if (TOKEN.exec(token)[2] !== sha256) fail('ASSET_CHANGED', 'Image content no longer matches its token');
    if(bytes.subarray(0,8).equals(PNG))pngMetadata(bytes);
    const metadata=await this.#decoder.decode(bytes);
    if(metadata.sha256!==sha256||metadata.bytes!==bytes.length)fail('ASSET_CHANGED','Decoded input changed');
    const extension=metadata.format==='jpeg'?'jpg':metadata.format;
    return { token, ...metadata, md5: digest('md5', bytes), sha256, bytes: bytes.length, fileName: `image-${sha256.slice(0, 16)}.${extension}` };
  }
  read(token) {
    const filename = this.assetPath(token);
    physicalDirectories(this.root);
    let before;
    try { before = regular(filename); } catch (error) { if (error.code === 'ENOENT') fail('ASSET_NOT_FOUND', 'Image token is not present in this store'); throw error; }
    if (before.size <= 0n || before.size > BigInt(this.maxBytes)) fail('LIMIT_EXCEEDED', 'Image asset exceeds file size bound');
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!sameFile(before, opened) || opened.nlink !== 1n || !opened.isFile()) fail('ASSET_CHANGED', 'Image changed while being opened');
      const bytes = Buffer.alloc(Number(before.size));
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(descriptor, bytes, count, bytes.length - count, count);
        if (read === 0) fail('ASSET_CHANGED', 'Image was truncated'); count += read;
      }
      const extra = Buffer.alloc(1);
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (fs.readSync(descriptor, extra, 0, 1, count) !== 0 || !sameFile(before, after) || after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('ASSET_CHANGED', 'Image changed during inspection');
      physicalDirectories(this.root);
      const current = regular(filename);
      if (!sameFile(before, current) || before.size !== current.size || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs) fail('ASSET_CHANGED', 'Image path changed during inspection');
      return bytes;
    } finally { fs.closeSync(descriptor); }
  }
  async stageOneBotFile(file) {
    if (typeof file !== 'string' || !file.startsWith(INLINE_IMAGE_PREFIX))
      fail('UNSUPPORTED_SOURCE', 'Image file must use base64:// inline bytes');
    const encodedLength = file.length - INLINE_IMAGE_PREFIX.length;
    if (encodedLength > Math.ceil(this.maxBytes / 3) * 4)
      fail('LIMIT_EXCEEDED', 'Image exceeds per-file size bound');
    const encoded = file.slice(INLINE_IMAGE_PREFIX.length);
    if (encodedLength === 0 || encodedLength % 4 !== 0)
      fail('INVALID_BASE64', 'Image file must contain canonical base64');
    const padding = encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='));
    if (encodedLength / 4 * 3 - padding > this.maxBytes)
      fail('LIMIT_EXCEEDED', 'Image exceeds per-file size bound');
    const bytes = Buffer.from(encoded, 'base64');
    // Buffer also accepts URL-safe variants and skips whitespace. Require the
    // exact spelling emitted by Agent Plus, including padding and zero pad bits.
    if (bytes.toString('base64') !== encoded)
      fail('INVALID_BASE64', 'Image file must contain canonical base64');
    return this.stage(bytes);
  }
  async stage(input, { filename } = {}) {
    if (!(input instanceof Uint8Array)) fail('INVALID_INPUT', 'Explicit non-shared Buffer or Uint8Array bytes are required');
    let buffer, byteLength, byteOffset;
    try {
      buffer = typedValue('buffer', input); byteLength = typedValue('byteLength', input); byteOffset = typedValue('byteOffset', input);
    } catch { fail('INVALID_INPUT', 'A real byte view is required'); }
    // instanceof is insufficient: a SharedArrayBuffer can be given the ordinary
    // ArrayBuffer prototype. The intrinsic getter checks the real backing brand.
    try { arrayBufferLength.call(buffer); } catch { fail('INVALID_INPUT', 'Shared byte inputs are not supported'); }
    if (byteLength === 0 || byteLength > this.maxBytes) fail('LIMIT_EXCEEDED', 'Image exceeds per-file size bound');
    const snapshot = Buffer.from(new Uint8Array(buffer, byteOffset, byteLength)); // Intrinsic bounds, then copy before filesystem operations.
    safeName(filename);
    const sha256 = digest('sha256', snapshot), token = `img_${randomBytes(16).toString('hex')}_${sha256}`;
    const metadata=await this.#metadata(token,snapshot);
    if(digest('sha256',snapshot)!==sha256)fail('ASSET_CHANGED','Image snapshot changed before staging');
    this.prepare();
    const lock = path.join(this.root, '.stage.lock');
    let lockFd;
    try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      regular(lock); fail('STORE_BUSY', 'Image staging is already active or requires explicit stale-lock recovery');
    }
    const lockIdentity = fs.fstatSync(lockFd, { bigint: true });
    let outputFd, created, committed = false;
    try {
      let total = 0, count = 0;
      for (const entry of fs.readdirSync(this.root)) {
        if (entry === '.stage.lock') continue;
        if (!entry.endsWith('.asset') || !TOKEN.test(entry.slice(0, -6))) fail('UNSAFE_PATH', 'Unexpected file in image storage');
        const stat = regular(path.join(this.root, entry));
        if (stat.size <= 0n || stat.size > BigInt(this.maxBytes)) fail('LIMIT_EXCEEDED', 'Existing asset exceeds file size bound');
        total += Number(stat.size); count++;
        if (total > this.maxTotalBytes || count > this.maxAssets) fail('LIMIT_EXCEEDED', 'Existing image store exceeds capacity');
      }
      if (count >= this.maxAssets || total + snapshot.length > this.maxTotalBytes) fail('LIMIT_EXCEEDED', 'Image store aggregate capacity exceeded');
      physicalDirectories(this.root);
      const target = this.assetPath(token);
      outputFd = fs.openSync(target, 'wx', 0o600);
      created = fs.fstatSync(outputFd, { bigint: true });
      if (!created.isFile() || created.nlink !== 1n) fail('UNSAFE_PATH', 'Image output is not exclusive');
      fs.writeFileSync(outputFd, snapshot); fs.fsyncSync(outputFd);
      fs.closeSync(outputFd); outputFd = undefined;
      if(digest('sha256',this.read(token))!==sha256)fail('ASSET_CHANGED','Staged content differs from decoded snapshot');
      committed = true;
      return metadata;
    } finally {
      if (outputFd !== undefined) fs.closeSync(outputFd);
      // Only an uncommitted file created by this operation can be removed.
      if (created && !committed) {
        const target = this.assetPath(token);
        try { const now = regular(target); if (sameFile(created, now)) fs.unlinkSync(target); } catch {}
      }
      fs.closeSync(lockFd);
      try { const now = regular(lock); if (sameFile(lockIdentity, now)) fs.unlinkSync(lock); } catch {}
    }
  }
  async inspect(token) {
    const metadata=await this.#metadata(token,this.read(token));
    if(digest('sha256',this.read(token))!==metadata.sha256)fail('ASSET_CHANGED','Asset changed during decoding');
    return metadata;
  }
  async resolve(token) {
    // Full decoding is asynchronous; reread the actual bytes after that gap.
    // The returned path is not a lease: external changes after return remain
    // possible and must be handled by the eventual native copy/lease boundary.
    const metadata=await this.#metadata(token,this.read(token));
    if(digest('sha256',this.read(token))!==metadata.sha256)fail('ASSET_CHANGED','Asset changed during decoding');
    physicalDirectories(this.root);
    const filename = this.assetPath(token); regular(filename);
    return filename; // Internal bridge use only; never expose this through OneBot.
  }
}
