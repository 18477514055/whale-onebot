import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ImageStore } from '../src/media/image-store.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Independent synthetic PNG fixture builder; no downloaded/user image data.
function crc(bytes) {
  let state = -1;
  for (const byte of bytes) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = state & 1 ? (state >>> 1) ^ 0xedb88320 : state >>> 1;
  }
  return (state ^ -1) >>> 0;
}
function chunk(name, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(name, 4, 'latin1');
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE(crc(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, trailer]);
}
function png({ width = 1, height = 1, filter = 0, interlace = 0, imageData, before = [], after = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[12] = interlace;
  const scanline = imageData ?? Buffer.from([filter, 11, 22, 33, 255]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...before, chunk('IDAT', deflateSync(scanline)), ...after, chunk('IEND')]);
}
function temporary(t, options = {}) {
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const parent = fs.mkdtempSync(path.join(project, '.tmp/image-store-test-'));
  const root = path.join(parent, 'qq-onebot'); fs.mkdirSync(root);
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert(resolved.startsWith(fs.realpathSync(path.join(project, '.tmp')) + path.sep));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { root, parent, store: new ImageStore({ projectRoot: root, ...options }) };
}
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

test('OneBot inline file stages canonical base64 at the exact decoded size limit', async t => {
  const bytes = png();
  const { store } = temporary(t, { maxBytes: bytes.length });
  const asset = await store.stageOneBotFile('base64://' + bytes.toString('base64'));
  assert.equal(asset.sha256, hash('sha256', bytes));
  assert.equal(asset.decoded, true);
  assert.deepEqual(store.read(asset.token), bytes);
});

test('OneBot inline file rejects malformed and oversized encodings before preparing storage', async t => {
  const { store } = temporary(t, { maxBytes: 64 });
  for (const file of [null, '/tmp/example.png', 'https://example.invalid/photo.png', 'data:image/png;base64,Zg==']) {
    await assert.rejects(store.stageOneBotFile(file), { code: 'UNSUPPORTED_SOURCE' });
  }
  for (const encoded of ['', 'Zg', 'Zg= ', 'Zg==\n', 'Zg=!', 'Zh==', '_w==', '====']) {
    await assert.rejects(store.stageOneBotFile('base64://' + encoded), { code: 'INVALID_BASE64' });
  }
  for (const length of [65, 1000]) {
    await assert.rejects(store.stageOneBotFile('base64://' + Buffer.alloc(length).toString('base64')), {
      code: 'LIMIT_EXCEEDED',
    });
  }
  assert.equal(fs.existsSync(store.root), false);
});

test('PNG staging writes real isolated bytes and inspect/resolve survive a fresh store instance', async t => {
  const { root, store } = temporary(t);
  const bytes = png();
  const asset = await store.stage(bytes, { filename: 'misleading.jpg' });
  assert.match(asset.token, /^img_[a-f0-9]{32}_[a-f0-9]{64}$/);
  assert.equal(asset.format, 'png'); assert.equal(asset.width, 1); assert.equal(asset.height, 1);
  assert.equal(asset.bytes, bytes.length); assert.equal(asset.md5, hash('md5', bytes)); assert.equal(asset.sha256, hash('sha256', bytes));
  assert.equal(asset.validation, 'full-decode'); assert.equal(asset.decoded, true);assert.equal(asset.frames,1);
  assert.match(asset.fileName, /^image-[a-f0-9]{16}\.png$/);
  assert.equal('path' in asset, false);
  const physical = await store.resolve(asset.token);
  assert.equal(path.dirname(physical), path.join(root, 'runtime', 'media'));
  assert.equal(fs.realpathSync(physical), physical); assert.deepEqual(fs.readFileSync(physical), bytes);
  assert.deepEqual(await new ImageStore({ projectRoot: root }).inspect(asset.token), asset);
  assert.equal(fs.existsSync(physical), true, 'inspection does not delete retained assets');
});

test('input Uint8Array subview is copied before caller can mutate its backing bytes', async t => {
  const { store } = temporary(t);
  const source = png(), padded = Buffer.concat([Buffer.from([1, 2]), source, Buffer.from([3])]);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 2, source.length);
  const operation = store.stage(view, { filename: 'snapshot.png' });
  view.fill(0);
  const asset = await operation;
  assert.deepEqual(fs.readFileSync(await store.resolve(asset.token)), source);
});

test('paths, URLs, shared memory, unsafe names and unsupported formats are rejected without staging', async t => {
  const { store, root } = temporary(t);
  for (const input of ['/some/file.png', 'https://example.invalid/picture', new ArrayBuffer(10), new Uint8Array(new SharedArrayBuffer(100))]) {
    await assert.rejects(store.stage(input), { code: 'INVALID_INPUT' });
  }
  for (const filename of ['../file.png', 'a/b.png', 'a\\b.png', 'C:photo.png', '.', 'bad\0.png', 'name.', 'name ']) {
    await assert.rejects(store.stage(png(), { filename }), { code: 'INVALID_FILENAME' });
  }
  for (const bytes of [Buffer.from('<svg/>'), Buffer.from('not an image')]) {
    await assert.rejects(store.stage(bytes, { filename: 'fake.png' }), { code: 'UNSUPPORTED_FORMAT' });
  }
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
});

test('truncation, CRC errors, trailing bytes, illegal filters and inflated-size mismatch are rejected', async t => {
  const { store } = temporary(t);
  const corrupted = png(); corrupted[45] ^= 1;
  const variants = [png().subarray(0, -1), corrupted, Buffer.concat([png(), Buffer.from('tail')]), png({ filter: 5 }), png({ imageData: Buffer.alloc(8 * 1024 * 1024) }), png({ imageData: Buffer.from([0, 1]) })];
  for (const bytes of variants) await assert.rejects(store.stage(bytes), { code: 'INVALID_IMAGE' });
});

test('duplicate header, split data sequence, critical chunks and animation are rejected', async t => {
  const { store } = temporary(t);
  const duplicateHeader = png().subarray(8, 33);
  for (const bytes of [
    png({ before: [duplicateHeader] }), png({ before: [chunk('ABCD')] }),
    png({ after: [chunk('tEXt', Buffer.from('key\0value')), chunk('IDAT', Buffer.alloc(0))] }),
    png({ before: [chunk('\xc9HDR', Buffer.alloc(13))] }),
  ]) await assert.rejects(store.stage(bytes), { code: 'INVALID_IMAGE' });
  await assert.rejects(store.stage(png({ before: [chunk('acTL', Buffer.alloc(8))] })), { code: 'UNSUPPORTED_FORMAT' });
});

test('Adam7 one-pixel PNG passes, excessive dimensions and palette omissions fail', async t => {
  const { store } = temporary(t);
  assert.equal((await store.stage(png({ interlace: 1 }))).width, 1);
  await assert.rejects(store.stage(png({ width: 16385 })), { code: 'INVALID_IMAGE' });
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 3;
  const missingPalette = Buffer.concat([png().subarray(0, 8), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 0]))), chunk('IEND')]);
  await assert.rejects(store.stage(missingPalette), { code: 'INVALID_IMAGE' });
});

test('individual size and aggregate capacity account for retained files across store instances', async t => {
  const { store, root } = temporary(t, { maxBytes: 80 });
  await assert.rejects(store.stage(Buffer.alloc(81)), { code: 'LIMIT_EXCEEDED' });
  const bytes = png(); const count = Math.floor(store.maxTotalBytes / bytes.length);
  const tokens = [];
  for (let i = 0; i < count; i++) tokens.push((await store.stage(bytes)).token);
  assert.equal(new Set(tokens).size, count);
  const restarted = new ImageStore({ projectRoot: root, maxBytes: 80 });
  await assert.rejects(restarted.stage(bytes), { code: 'LIMIT_EXCEEDED' });
  assert.equal(fs.readdirSync(store.root).length, count);
  assert.deepEqual(await restarted.inspect(tokens[0]), await store.inspect(tokens[0]));
});

test('token validation refuses filesystem paths and unknown store-issued-looking names', async t => {
  const { store } = temporary(t);
  const asset = await store.stage(png());
  for (const token of ['../' + asset.token, await store.resolve(asset.token), 'https://invalid/', asset.token + '.asset']) {
    await assert.rejects(store.inspect(token), { code: 'INVALID_TOKEN' });
    await assert.rejects(store.resolve(token), { code: 'INVALID_TOKEN' });
  }
  await assert.rejects(store.inspect('img_' + 'a'.repeat(32) + '_' + 'b'.repeat(64)), { code: 'ASSET_NOT_FOUND' });
});

test('inspect rechecks real file contents and rejects replacement, truncation and hard links', async t => {
  const { store, parent, root } = temporary(t);
  const asset = await store.stage(png()), filename = await store.resolve(asset.token);
  fs.writeFileSync(filename, png({ imageData: Buffer.from([0, 90, 91, 92, 255]) }));
  await assert.rejects(store.inspect(asset.token), { code: 'ASSET_CHANGED' });
  await assert.rejects(new ImageStore({ projectRoot: root }).inspect(asset.token), { code: 'ASSET_CHANGED' });
  await assert.rejects(store.resolve(asset.token), { code: 'ASSET_CHANGED' });
  fs.writeFileSync(filename, png().subarray(0, 20));
  await assert.rejects(store.inspect(asset.token), { code: 'ASSET_CHANGED' });
  fs.writeFileSync(filename, png());
  fs.linkSync(filename, path.join(parent, 'synthetic-linked.asset'));
  await assert.rejects(store.inspect(asset.token), { code: 'UNSAFE_PATH' });
  await assert.rejects(store.stage(png()), { code: 'UNSAFE_PATH' });
});

test('linked runtime/media directory is refused before an asset is written', async t => {
  const { store, root, parent } = temporary(t);
  const other = path.join(parent, 'synthetic-other'); fs.mkdirSync(other);
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.symlinkSync(other, path.join(root, 'runtime', 'media'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.stage(png()), { code: 'UNSAFE_PATH' });
  assert.deepEqual(fs.readdirSync(other), []);
});

test('linked project root, invalid limits and mutable configuration are refused', t => {
  const { root, store, parent } = temporary(t);
  const linkParent = path.join(parent, 'alias'); fs.mkdirSync(linkParent);
  const link = path.join(linkParent, 'qq-onebot'); fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new ImageStore({ projectRoot: link }), { code: 'UNSAFE_PATH' });
  assert.throws(() => new ImageStore({ projectRoot: parent }), { code: 'INVALID_ROOT' });
  for (const maxBytes of [0, 63, NaN, Infinity, 64 * 1024 * 1024 + 1]) assert.throws(() => new ImageStore({ projectRoot: root, maxBytes }), { code: 'INVALID_LIMIT' });
  assert.throws(() => { store.root = parent; }, TypeError);
});

test('existing lock and unexpected files fail closed without cleanup of retained assets', async t => {
  const { store } = temporary(t);
  const asset = await store.stage(png()); const physical = await store.resolve(asset.token);
  const lock = path.join(store.root, '.stage.lock'); fs.writeFileSync(lock, 'synthetic-stale-lock');
  await assert.rejects(store.stage(png()), { code: 'STORE_BUSY' });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'synthetic-stale-lock');
  fs.unlinkSync(lock);
  fs.writeFileSync(path.join(store.root, 'unmanaged.txt'), 'synthetic');
  await assert.rejects(store.stage(png()), { code: 'UNSAFE_PATH' });
  assert.equal(fs.existsSync(physical), true); assert.equal(fs.existsSync(lock), false);
});

test('intrinsic byte lengths and shared buffers cannot be disguised by view properties', async t => {
  const { store } = temporary(t, { maxBytes: 80 });
  const oversized = new Uint8Array(1000);
  Object.defineProperty(oversized, 'byteLength', { value: 1 });
  await assert.rejects(store.stage(oversized), { code: 'LIMIT_EXCEEDED' });
  const shared = new Uint8Array(new SharedArrayBuffer(70));
  Object.defineProperty(shared, 'buffer', { value: new ArrayBuffer(70) });
  await assert.rejects(store.stage(shared), { code: 'INVALID_INPUT' });
  const fake = Object.create(Uint8Array.prototype);
  await assert.rejects(store.stage(fake), { code: 'INVALID_INPUT' });
});

test('SharedArrayBuffer with an ordinary ArrayBuffer prototype still fails the intrinsic brand check', async t => {
  const { store } = temporary(t);
  const bytes = png(), backing = new SharedArrayBuffer(bytes.length), input = new Uint8Array(backing);
  input.set(bytes);
  Object.setPrototypeOf(backing, ArrayBuffer.prototype);
  assert.equal(backing instanceof ArrayBuffer, true, 'negative control actually bypasses instanceof');
  await assert.rejects(store.stage(input), { code: 'INVALID_INPUT' });
  assert.equal(fs.existsSync(store.root), false);
});

test('symbolic-link asset leaves are refused without following their bytes', async t => {
  const { store, parent } = temporary(t);
  const asset = await store.stage(png()); const filename = await store.resolve(asset.token);
  const target = path.join(parent, 'synthetic-external.png'); fs.writeFileSync(target, png());
  fs.unlinkSync(filename);
  try { fs.symlinkSync(target, filename, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows token lacks file-symlink privilege; run this case on Linux; Windows junction and hardlink tests remain active'); return; }
    throw error;
  }
  await assert.rejects(store.inspect(asset.token), { code: 'UNSAFE_PATH' });
  await assert.rejects(store.stage(png()), { code: 'UNSAFE_PATH' });
  assert.deepEqual(fs.readFileSync(target), png());
});

test('asset-count capacity is independent of byte capacity and never overwrites files', async t => {
  const { store } = temporary(t);
  const bytes = png(), sha = hash('sha256', bytes);
  await store.stage(bytes);
  for (let i = 0; i < 255; i++) fs.writeFileSync(path.join(store.root, `img_${i.toString(16).padStart(32, '0')}_${sha}.asset`), bytes, { flag: 'wx' });
  await assert.rejects(store.stage(bytes), { code: 'LIMIT_EXCEEDED' });
  assert.equal(fs.readdirSync(store.root).length, 256);
  for (const filename of fs.readdirSync(store.root)) assert.deepEqual(fs.readFileSync(path.join(store.root, filename)), bytes);
});

test('resolve validates its own bytes without yielding through an asynchronous inspect override', async t => {
  const { store, root } = temporary(t);
  const original = png(), asset = await store.stage(original);
  let overrideCalls = 0;
  class DelayedInspector extends ImageStore {
    async inspect(token) {
      overrideCalls++;
      await Promise.resolve();
      fs.writeFileSync(this.assetPath(token), png({ imageData: Buffer.from([0, 99, 98, 97, 255]) }));
      return asset; // Stale report: old resolve awaited this and only checked the path.
    }
  }
  const resolved = await new DelayedInspector({ projectRoot: root }).resolve(asset.token);
  assert.equal(hash('sha256', fs.readFileSync(resolved)), asset.sha256);
  assert.equal(overrideCalls, 0);
  // No claim that an external writer cannot change the file after resolve ends.
});
