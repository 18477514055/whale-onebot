import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MediaElementError, ELEMENT_TYPES, PIC_SUB_TYPES, PIC_TYPES, VIDEO_FORMATS, IMAGE_MAX_BYTES,
  buildPttElement, buildVideoElement, buildFileElement, buildImageElement, elementSubTypeFor, validateLocalMedia,
} from '../src/media/element-builders.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporary(t) {
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(project, '.tmp/media-element-builders-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert(resolved.startsWith(fs.realpathSync(path.join(project, '.tmp')) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}
// Create a file of an exact size without writing megabytes: write one byte, then
// extend with truncate (sparse on both NTFS and ext4).
function sized(file, size) {
  fs.writeFileSync(file, Buffer.alloc(1));
  fs.truncateSync(file, size);
  return file;
}
function throwsCode(code, fn) {
  return assert.throws(fn, error => {
    assert.equal(error.name, 'MediaElementError');
    assert.equal(error.code, code);
    return true;
  });
}
// Recursively collect every path whose value is literally undefined. Native code
// must never receive an `undefined` key, so this is asserted for every builder.
function undefinedPaths(value, at = '$', seen = new Set()) {
  if (value === undefined) return [at];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (value instanceof Map) return [...value.entries()].flatMap(([key, item]) => undefinedPaths(item, `${at}<${String(key)}>`, seen));
  return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${at}.${key}`, seen));
}
const noUndefined = element => assert.deepEqual(undefinedPaths(element), []);

const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

// ---------------------------------------------------------------- voice / ptt

test('buildPttElement returns the complete pttElement send envelope', () => {
  const element = buildPttElement({ filePath: '/srv/media/Ori/aaaa.silk', size: 1234, md5: MD5, durationSec: 3 });
  assert.deepEqual(element, {
    elementType: 4,
    elementId: '',
    pttElement: {
      fileName: 'aaaa.silk',
      filePath: '/srv/media/Ori/aaaa.silk',
      fileSize: '1234',
      duration: 3,
      formatType: 1,
      voiceType: 1,
      voiceChangeType: 0,
      canConvert2Text: true,
      fileSubId: '',
      playState: 1,
      autoConvertText: 0,
      storeID: 0,
      otherBusinessInfo: { aiVoiceType: 0 },
      waveAmplitudes: [],
      md5HexStr: MD5,
    },
  });
  assert.equal(element.elementType, ELEMENT_TYPES.ptt);
  noUndefined(element);
});

test('buildPttElement derives a Windows basename, rounds duration and defaults it to 1', () => {
  const withPath = buildPttElement({ filePath: 'C:\\Users\\x\\AppData\\tmp\\voice 01.silk', size: '9', durationSec: 2.6 });
  assert.equal(withPath.pttElement.fileName, 'voice 01.silk');
  assert.equal(withPath.pttElement.fileSize, '9');
  assert.equal(withPath.pttElement.duration, 3);
  // md5 omitted → the key is absent, never undefined.
  assert.equal('md5HexStr' in withPath.pttElement, false);
  const noDuration = buildPttElement({ filePath: '/a/b.silk', size: 0 });
  assert.equal(noDuration.pttElement.duration, 1);
  assert.equal(noDuration.pttElement.fileSize, '0');
  noUndefined(noDuration);
});

test('buildPttElement accepts an explicit fileName and a real waveform', () => {
  const element = buildPttElement({ filePath: '/a/b.silk', fileName: 'voice.silk', size: 10, waveAmplitudes: [0, 18, 9] });
  assert.equal(element.pttElement.fileName, 'voice.silk');
  assert.deepEqual(element.pttElement.waveAmplitudes, [0, 18, 9]);
  throwsCode('INVALID_ARGUMENT', () => buildPttElement({ filePath: '/a/b.silk', size: 10, waveAmplitudes: [1, 999] }));
  throwsCode('INVALID_ARGUMENT', () => buildPttElement({ filePath: '/a/b.silk', size: 10, waveAmplitudes: 'loud' }));
});

test('buildPttElement never emits the unverified fileUuid field', () => {
  const element = buildPttElement({ filePath: '/a/b.silk', size: 10, fileUuid: 'u_0123456789abcdef' });
  assert.equal('fileUuid' in element.pttElement, false);
  assert.deepEqual(Object.keys(element).sort(), ['elementId', 'elementType', 'pttElement']);
});

test('buildPttElement rejects a missing or malformed required field', () => {
  throwsCode('INVALID_PATH', () => buildPttElement({ size: 10 }));
  throwsCode('INVALID_PATH', () => buildPttElement({ filePath: '', size: 10 }));
  throwsCode('INVALID_PATH', () => buildPttElement({ filePath: '/a/b\u0000.silk', size: 10 }));
  throwsCode('INVALID_SIZE', () => buildPttElement({ filePath: '/a/b.silk' }));
  throwsCode('INVALID_SIZE', () => buildPttElement({ filePath: '/a/b.silk', size: '0123' }));
  throwsCode('INVALID_SIZE', () => buildPttElement({ filePath: '/a/b.silk', size: -1 }));
  throwsCode('INVALID_SIZE', () => buildPttElement({ filePath: '/a/b.silk', size: 1.5 }));
  throwsCode('INVALID_DIGEST', () => buildPttElement({ filePath: '/a/b.silk', size: 10, md5: 'xyz' }));
  throwsCode('INVALID_DURATION', () => buildPttElement({ filePath: '/a/b.silk', size: 10, durationSec: -1 }));
  throwsCode('INVALID_FILENAME', () => buildPttElement({ filePath: '/a/b.silk', fileName: 'a/b' }));
  throwsCode('INVALID_FILENAME', () => buildPttElement({ filePath: '/a/b.silk', fileName: '..' }));
  // The error message names the offending basename only, never the full path.
  assert.throws(() => buildPttElement({ filePath: '/home/secret/account/x.silk', size: 10, fileName: 'a/b' }),
    error => !error.message.includes('/home/secret') && error.message.endsWith('(b)'));
});

// --------------------------------------------------------------- video

test('buildVideoElement returns the complete videoElement send envelope', () => {
  const element = buildVideoElement({
    filePath: '/srv/media/Ori/clip.mp4', size: 4096, md5: MD5, durationSec: 15.4,
    width: 1920, height: 1080, thumbPath: '/srv/media/Thumb/clip_0.png', thumbSize: 512,
    fileUuid: 'u_video123',
  });
  assert.deepEqual(element, {
    elementType: 5,
    elementId: '',
    videoElement: {
      fileName: 'clip.mp4',
      filePath: '/srv/media/Ori/clip.mp4',
      fileSize: '4096',
      fileTime: 15,
      fileFormat: 2,
      videoMd5: MD5,
      fileUuid: 'u_video123',
      fileWidth: 1920,
      thumbWidth: 1920,
      fileHeight: 1080,
      thumbHeight: 1080,
      thumbPath: new Map([[0, '/srv/media/Thumb/clip_0.png']]),
      thumbSize: 512,
    },
  });
  assert.equal(element.elementType, ELEMENT_TYPES.video);
  assert(element.videoElement.thumbPath instanceof Map);
  assert.equal(element.videoElement.thumbPath.get(0), '/srv/media/Thumb/clip_0.png');
  noUndefined(element);
});

test('buildVideoElement omits every optional key that was not supplied', () => {
  const element = buildVideoElement({ filePath: '/a/b.mp4', size: '7' });
  assert.deepEqual(element, {
    elementType: 5,
    elementId: '',
    videoElement: { fileName: 'b.mp4', filePath: '/a/b.mp4', fileSize: '7', fileTime: 0, fileFormat: 2 },
  });
  for (const key of ['thumbPath', 'thumbSize', 'videoMd5', 'fileUuid', 'fileWidth', 'fileHeight', 'thumbWidth', 'thumbHeight'])
    assert.equal(key in element.videoElement, false, `${key} must stay absent`);
});

test('buildVideoElement maps a format extension and rejects unknown input', () => {
  assert.equal(buildVideoElement({ filePath: '/a/b.mov', size: 1, format: 'MOV' }).videoElement.fileFormat, VIDEO_FORMATS.mov);
  assert.equal(buildVideoElement({ filePath: '/a/b.mkv', size: 1, format: 'mkv' }).videoElement.fileFormat, 4);
  assert.equal(buildVideoElement({ filePath: '/a/b.mov', size: 1, format: VIDEO_FORMATS.mov }).videoElement.fileFormat, VIDEO_FORMATS.mov);
  throwsCode('INVALID_ARGUMENT', () => buildVideoElement({ filePath: '/a/b.mp4', size: 1, format: 'flv' }));
  throwsCode('INVALID_DIMENSION', () => buildVideoElement({ filePath: '/a/b.mp4', size: 1, width: -2 }));
  throwsCode('INVALID_DIMENSION', () => buildVideoElement({ filePath: '/a/b.mp4', size: 1, height: 1.5 }));
  throwsCode('INVALID_SIZE', () => buildVideoElement({ filePath: '/a/b.mp4' }));
  throwsCode('INVALID_PATH', () => buildVideoElement({ size: 1 }));
  throwsCode('INVALID_UUID', () => buildVideoElement({ filePath: '/a/b.mp4', size: 1, fileUuid: 'has space' }));
});

// --------------------------------------------------------------- file

test('buildFileElement returns the private-chat file envelope with an empty folder', () => {
  const element = buildFileElement({ filePath: '/srv/media/Ori/report.pdf', size: 2048 });
  assert.deepEqual(element, {
    elementType: 3,
    elementId: '',
    fileElement: { fileName: 'report.pdf', filePath: '/srv/media/Ori/report.pdf', fileSize: '2048', folderId: '' },
  });
  assert.equal(element.elementType, ELEMENT_TYPES.file);
  noUndefined(element);
});

test('buildFileElement expresses the group-file difference through parameters', () => {
  const element = buildFileElement({
    filePath: '/srv/media/Ori/report.pdf', fileName: '季度报告.pdf', size: 2048,
    fileUuid: 'u_abcdef', md5: MD5, sha1: SHA1, folderId: '/folder_1', groupFile: true,
  });
  assert.deepEqual(element, {
    elementType: 3,
    elementId: '',
    fileElement: {
      fileName: '季度报告.pdf', filePath: '/srv/media/Ori/report.pdf', fileSize: '2048',
      folderId: '/folder_1', fileUuid: 'u_abcdef', fileMd5: MD5, fileSha: SHA1,
    },
  });
  // The group root directory is the empty id and is legal for a group send.
  assert.equal(buildFileElement({ filePath: '/a/b.pdf', size: 1, folderId: '', groupFile: true }).fileElement.folderId, '');
  noUndefined(element);
});

test('buildFileElement refuses a folder id on the private path', () => {
  throwsCode('INVALID_FOLDER', () => buildFileElement({ filePath: '/a/b.pdf', size: 1, folderId: '/folder_1' }));
  throwsCode('INVALID_FOLDER', () => buildFileElement({ filePath: '/a/b.pdf', size: 1, folderId: 'has space', groupFile: true }));
  throwsCode('INVALID_FOLDER', () => buildFileElement({ filePath: '/a/b.pdf', size: 1, folderId: 7, groupFile: true }));
  throwsCode('INVALID_DIGEST', () => buildFileElement({ filePath: '/a/b.pdf', size: 1, sha1: 'too-short' }));
  throwsCode('INVALID_DIGEST', () => buildFileElement({ filePath: '/a/b.pdf', size: 1, md5: SHA1 }));
  throwsCode('INVALID_UUID', () => buildFileElement({ filePath: '/a/b.pdf', size: 1, fileUuid: '' }));
  throwsCode('INVALID_SIZE', () => buildFileElement({ filePath: '/a/b.pdf' }));
});

// --------------------------------------------------------------- image

test('buildImageElement keeps the existing native-bridge picElement layout', () => {
  const element = buildImageElement({
    sourcePath: '/srv/media/global/cache/image-abc.png', size: 68, md5: MD5, width: 1, height: 1, format: 'png',
  });
  assert.deepEqual(element, {
    elementType: 2,
    elementId: '',
    picElement: {
      md5HexStr: MD5,
      fileSize: '68',
      fileName: 'image-abc.png',
      sourcePath: '/srv/media/global/cache/image-abc.png',
      picWidth: 1,
      picHeight: 1,
      original: true,
      picType: 1001,
      picSubType: 0,
      fileUuid: '',
      fileSubId: '',
      summary: '',
      thumbFileSize: 0,
    },
  });
  assert.deepEqual(Object.keys(element.picElement), [
    'md5HexStr', 'fileSize', 'fileName', 'sourcePath', 'picWidth', 'picHeight',
    'original', 'picType', 'picSubType', 'fileUuid', 'fileSubId', 'summary', 'thumbFileSize',
  ]);
  noUndefined(element);
});

test('buildImageElement maps kind/sub_type to picSubType and unknown sizes to 0', () => {
  const sticker = buildImageElement({ sourcePath: '/a/b.gif', size: 1, md5: MD5, kind: 'sticker', format: 'gif' });
  assert.equal(sticker.picElement.picSubType, 1);
  assert.equal(sticker.picElement.picType, 2000);
  assert.equal(sticker.picElement.picWidth, 0);
  assert.equal(sticker.picElement.picHeight, 0);
  assert.equal(buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5, subType: 2 }).picElement.picSubType, 2);
  assert.equal(buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5 }).picElement.picType, PIC_TYPES.jpeg);
  assert.equal(buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5, summary: '[图片]' }).picElement.summary, '[图片]');
  // `filePath` is honoured as an alias for `sourcePath`.
  assert.equal(buildImageElement({ filePath: '/a/b.png', size: 1, md5: MD5 }).picElement.sourcePath, '/a/b.png');
});

test('buildImageElement rejects the missing required fields', () => {
  throwsCode('INVALID_DIGEST', () => buildImageElement({ sourcePath: '/a/b.png', size: 1 }));
  throwsCode('INVALID_PATH', () => buildImageElement({ size: 1, md5: MD5 }));
  throwsCode('INVALID_SIZE', () => buildImageElement({ sourcePath: '/a/b.png', md5: MD5 }));
  throwsCode('UNKNOWN_KIND', () => buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5, kind: 'video' }));
  throwsCode('INVALID_ARGUMENT', () => buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5, subType: 999 }));
  throwsCode('INVALID_ARGUMENT', () => buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5, summary: 'x'.repeat(257) }));
});

// --------------------------------------------------------------- sub types

test('elementSubTypeFor maps every documented kind and returns null otherwise', () => {
  assert.deepEqual(
    ['image', 'sticker', 'ptt', 'video', 'file'].map(elementSubTypeFor),
    [PIC_SUB_TYPES.normal, PIC_SUB_TYPES.sticker, 0, 0, 0],
  );
  assert.equal(elementSubTypeFor('record'), null);
  assert.equal(elementSubTypeFor(''), null);
  assert.equal(elementSubTypeFor(undefined), null);
  assert.equal(elementSubTypeFor(2), null);
});

// --------------------------------------------------------------- no undefined

test('no builder produces an undefined key for any optional-field combination', () => {
  const built = [
    buildPttElement({ filePath: '/a/b.silk', size: 1 }),
    buildPttElement({ filePath: '/a/b.silk', size: 1, md5: MD5, durationSec: 0, fileName: 'c.silk' }),
    buildVideoElement({ filePath: '/a/b.mp4', size: 1 }),
    buildVideoElement({ filePath: '/a/b.mp4', size: 1, md5: MD5, thumbPath: '/a/t.png', thumbSize: 4, width: 1, height: 2, fileUuid: 'u_x', durationSec: 3 }),
    buildFileElement({ filePath: '/a/b.bin', size: 1 }),
    buildFileElement({ filePath: '/a/b.bin', size: 1, md5: MD5, sha1: SHA1, fileUuid: 'u_y', folderId: '/f', groupFile: true }),
    buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5 }),
    buildImageElement({ sourcePath: '/a/b.png', size: 1, md5: MD5, width: 2, height: 3, kind: 'sticker', summary: 's', format: 'webp' }),
  ];
  for (const element of built) {
    assert.equal(typeof element.elementType, 'number');
    assert.equal(element.elementId, '');
    noUndefined(element);
  }
});

test('builders do not mutate their frozen input', () => {
  const input = Object.freeze({ filePath: '/a/b.silk', size: 1, md5: MD5 });
  buildPttElement(input);
  assert.deepEqual(input, { filePath: '/a/b.silk', size: 1, md5: MD5 });
  const image = Object.freeze({ sourcePath: '/a/b.png', size: 1, md5: MD5 });
  buildImageElement(image);
  assert.deepEqual(image, { sourcePath: '/a/b.png', size: 1, md5: MD5 });
});

// --------------------------------------------------------------- local media

test('validateLocalMedia accepts an existing readable file and reports its size', t => {
  const dir = temporary(t);
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.alloc(10, 7));
  assert.deepEqual(validateLocalMedia(file), { ok: true, size: 10 });
  assert.deepEqual(validateLocalMedia(file, { kind: 'ptt', maxBytes: 10 }), { ok: true, size: 10 });
  assert.deepEqual(validateLocalMedia(file, { kind: 'sticker' }), { ok: true, size: 10 });
});

test('validateLocalMedia rejects a missing file, a directory and an empty file', t => {
  const dir = temporary(t);
  assert.deepEqual(validateLocalMedia(path.join(dir, 'nope.bin')), { ok: false, reason: 'not-found' });
  assert.deepEqual(validateLocalMedia(dir), { ok: false, reason: 'not-a-file' });
  const empty = path.join(dir, 'empty.bin');
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.deepEqual(validateLocalMedia(empty), { ok: false, reason: 'empty' });
  assert.deepEqual(validateLocalMedia(''), { ok: false, reason: 'invalid-path' });
  assert.deepEqual(validateLocalMedia(7), { ok: false, reason: 'invalid-path' });
  assert.deepEqual(validateLocalMedia(path.join(dir, 'a\u0000.bin')), { ok: false, reason: 'invalid-path' });
});

test('validateLocalMedia enforces the 12 MiB image default exactly', t => {
  const dir = temporary(t);
  const atLimit = sized(path.join(dir, 'at-limit.png'), IMAGE_MAX_BYTES);
  assert.equal(IMAGE_MAX_BYTES, 12 * 1024 * 1024);
  assert.deepEqual(validateLocalMedia(atLimit), { ok: true, size: 12 * 1024 * 1024 });
  const over = sized(path.join(dir, 'over.png'), IMAGE_MAX_BYTES + 1);
  assert.deepEqual(validateLocalMedia(over), { ok: false, reason: 'too-large' });
  // A caller-supplied cap is honoured for every kind.
  assert.deepEqual(validateLocalMedia(over, { kind: 'video', maxBytes: IMAGE_MAX_BYTES + 1 }), { ok: true, size: IMAGE_MAX_BYTES + 1 });
  assert.deepEqual(validateLocalMedia(atLimit, { kind: 'file', maxBytes: 1024 }), { ok: false, reason: 'too-large' });
});

test('validateLocalMedia fails closed without an explicit ptt/video/file cap', t => {
  const dir = temporary(t);
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.alloc(3));
  for (const kind of ['ptt', 'video', 'file'])
    assert.deepEqual(validateLocalMedia(file, { kind }), { ok: false, reason: 'limit-required' });
  assert.deepEqual(validateLocalMedia(file, { kind: 'nope' }), { ok: false, reason: 'invalid-kind' });
  assert.deepEqual(validateLocalMedia(file, { kind: 'image', maxBytes: 0 }), { ok: false, reason: 'invalid-limit' });
  assert.deepEqual(validateLocalMedia(file, { kind: 'image', maxBytes: 1.5 }), { ok: false, reason: 'invalid-limit' });
  assert.deepEqual(validateLocalMedia(file, { kind: 'image', maxBytes: 'big' }), { ok: false, reason: 'invalid-limit' });
});

test('validateLocalMedia rejects a symbolic link', t => {
  const dir = temporary(t);
  const target = path.join(dir, 'target.bin');
  fs.writeFileSync(target, Buffer.alloc(4));
  const link = path.join(dir, 'link.bin');
  try { fs.symlinkSync(target, link, 'file'); }
  catch {
    // Windows refuses a file symlink without privilege; a junction is a link too
    // and is created unprivileged, so the branch is still exercised there.
    try { fs.symlinkSync(dir, link, 'junction'); } catch { t.skip('link creation is not permitted on this host'); return; }
  }
  assert.deepEqual(validateLocalMedia(link), { ok: false, reason: 'symlink' });
});
