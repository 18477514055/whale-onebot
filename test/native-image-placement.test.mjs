import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ImageStore } from '../src/media/image-store.mjs';
import { createNativeImagePlacement } from '../src/media/native-image-placement.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6; header[12] = 0;
  const scanline = Buffer.from([0, 11, 22, 33, 255]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanline)), chunk('IEND')]);
}
function temporary(t) {
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const parent = fs.mkdtempSync(path.join(project, '.tmp/native-image-placement-'));
  const root = path.join(parent, 'qq-onebot'); fs.mkdirSync(root);
  const media = path.join(root, 'runtime', 'global'); fs.mkdirSync(media, { recursive: true });
  t.after(() => {
    const resolved = fs.realpathSync(parent);
    assert(resolved.startsWith(fs.realpathSync(path.join(project, '.tmp')) + path.sep));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { root, media };
}

function makeFactory({ root, media, msg, copy, download }) {
  return createNativeImagePlacement({
    store: new ImageStore({ projectRoot: root }),
    root: media,
    copy: copy ?? ((source, destination) => fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)),
    ...(download ? { download } : {}),
  });
}

test('buildImageElement stages, places and returns a full elementType=2 envelope', async t => {
  const { root, media } = temporary(t);
  // SDK getRichMediaFilePathForGuild(needCreate:true) creates the target's parent.
  fs.mkdirSync(path.join(media, 'cache'));
  const bytes = png();
  const file = 'base64://' + bytes.toString('base64');
  let pathCalls = 0, copies = 0;
  const msg = { getRichMediaFilePathForGuild: spec => {
    pathCalls++;
    assert.equal(spec.elementType, 2);
    assert.equal(spec.md5HexStr, createHash('md5').update(bytes).digest('hex'));
    assert.equal(spec.fileName, `image-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`);
    assert.equal(spec.needCreate, true);
    return 'cache/image.png';
  } };
  const factory = makeFactory({ root, media, msg, copy: (from, to) => { copies++; fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); } });
  const element = await factory.buildImageElement(file, { msg });
  assert.equal(element.elementType, 2);
  assert.equal(element.elementId, '');
  assert.equal(element.picElement.original, true);
  // NapCat's send contract derives picType from the image format and sends the real
  // decoded dimensions; this fixture is a 1x1 PNG, so NEWPIC_PNG (1001) and 1x1.
  assert.equal(element.picElement.picType, 1001);
  assert.equal(element.picElement.picSubType, 0);
  assert.equal(element.picElement.picWidth, 1);
  assert.equal(element.picElement.picHeight, 1);
  assert.equal(element.picElement.fileSize, String(bytes.length));
  assert.equal(element.picElement.md5HexStr, createHash('md5').update(bytes).digest('hex'));
  assert.equal(pathCalls, 1);
  assert.equal(copies, 1);
});

test('a GIF sticker is announced as NEWPIC_GIF with its real dimensions', async t => {
  const { root, media } = temporary(t);
  fs.mkdirSync(path.join(media, 'cache'));
  // Canonical 1x1 GIF89a. QQ 表情 are overwhelmingly animated GIFs, and NapCat
  // sends them as picType NEWPIC_GIF (2000) rather than NEWPIC_JPEG (1000).
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  // NapCat asks the SDK for the rich-media path with elementSubType equal to the
  // picture sub type (createValidSendPicElement -> uploadFile(file, PIC, subType)),
  // so a sticker must request a subType-1 path, not a subType-0 one.
  let pathSpec;
  const msg = { getRichMediaFilePathForGuild: spec => { pathSpec = spec; return 'cache/image.gif'; } };
  const factory = makeFactory({ root, media, msg });
  const element = await factory.buildImageElement('base64://' + bytes.toString('base64'), {
    msg, subType: 1, summary: '[动画表情]',
  });
  assert.equal(pathSpec.elementSubType, 1);
  assert.equal(element.picElement.picType, 2000);
  assert.equal(element.picElement.picSubType, 1);
  assert.equal(element.picElement.summary, '[动画表情]');
  assert.equal(element.picElement.picWidth, 1);
  assert.equal(element.picElement.picHeight, 1);
  assert.equal(element.picElement.fileSize, String(bytes.length));
});

test('buildImageElement rejects a non-base64, non-https or non-whitelisted source before touching placement', async t => {
  const { root, media } = temporary(t);
  const factory = makeFactory({ root, media, msg: { getRichMediaFilePathForGuild: () => 'cache/x.png' } });
  const msg = { getRichMediaFilePathForGuild: () => 'cache/x.png' };
  for (const file of ['https://example.invalid/x.png', 'http://gchat.qpic.cn/x.png', 'ftp://x/y.png', 'not-a-url']) {
    await assert.rejects(factory.buildImageElement(file, { msg }), { code: 'UNSUPPORTED_SOURCE' });
  }
});

test('buildImageElement downloads a whitelisted https CDN image into the store', async t => {
  const { root, media } = temporary(t);
  fs.mkdirSync(path.join(media, 'cache'));
  const bytes = png();
  const file = 'https://gchat.qpic.cn/gchatpic_new/0/0-0-ABC/0';
  let downloaded = 0;
  const factory = makeFactory({
    root, media, msg: { getRichMediaFilePathForGuild: () => 'cache/image.png' },
    copy: (from, to) => fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL),
    download: async () => { downloaded++; return bytes; },
  });
  const element = await factory.buildImageElement(file, { msg: { getRichMediaFilePathForGuild: () => 'cache/image.png' } });
  assert.equal(downloaded, 1);
  assert.equal(element.elementType, 2);
  assert.equal(element.picElement.fileSize, String(bytes.length));
  assert.equal(element.picElement.md5HexStr, createHash('md5').update(bytes).digest('hex'));
});

test('buildImageElement fails closed without a rich-media path method or copy binding', async t => {
  const { root, media } = temporary(t);
  const file = 'base64://' + png().toString('base64');
  const noMsg = makeFactory({ root, media, msg: undefined });
  await assert.rejects(noMsg.buildImageElement(file, { msg: {} }), { code: 'MEDIA_PATH_UNAVAILABLE' });
  assert.throws(() => createNativeImagePlacement({ store: new ImageStore({ projectRoot: root }), root: media }), { code: 'COPY_REQUIRED' });
});

test('buildImageElement rejects a destination escaping the placement root', async t => {
  const { root, media } = temporary(t);
  const file = 'base64://' + png().toString('base64');
  const factory = makeFactory({ root, media, msg: { getRichMediaFilePathForGuild: () => '../escape.png' } });
  await assert.rejects(factory.buildImageElement(file, { msg: factory && { getRichMediaFilePathForGuild: () => '../escape.png' } }));
});

test('an inline image is bounded by decoded bytes, not by string length', async t => {
  // Measured 2026-11-16: a sticker is sent as base64:// (hundreds of KB of
  // characters), and the old 8192-character cap meant for URLs rejected every one
  // of them as UNSUPPORTED_SOURCE -> HTTP 404 on the App side.
  const { root, media } = temporary(t);
  const factory = makeFactory({ root, media, msg: null });
  const longButValid = 'base64://' + Buffer.alloc(200 * 1024, 7).toString('base64');
  assert.ok(longButValid.length > 8192);
  await assert.rejects(factory.buildImageElement(longButValid, {}), (error) => {
    // It must get past the size guard and fail later (bad image bytes / missing path).
    assert.notEqual(error?.code, 'UNSUPPORTED_SOURCE', 'a large inline payload must not be rejected as a source error');
    return true;
  });
});

test('an inline image larger than the byte bound is still refused', async t => {
  const { root, media } = temporary(t);
  const factory = makeFactory({ root, media, msg: null, download: async () => Buffer.alloc(1) });
  const tiny = createNativeImagePlacementWithBound(root, media, 1024);
  const overBound = 'base64://' + Buffer.alloc(4096, 1).toString('base64');
  await assert.rejects(tiny.buildImageElement(overBound, {}), (error) => {
    assert.equal(error?.code, 'UNSUPPORTED_SOURCE');
    assert.match(String(error?.message), /size bound/i);
    return true;
  });
});

function createNativeImagePlacementWithBound(root, media, maxDownloadBytes) {
  return createNativeImagePlacement({
    store: new ImageStore({ projectRoot: root }),
    root: media,
    maxDownloadBytes,
    copy: (source, destination) => fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL),
  });
}

