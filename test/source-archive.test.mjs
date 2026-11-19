import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { closeSync, existsSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readSourceArchive } from '../scripts/lib/source-archive.mjs';

const project = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = path.join(project, '.tmp');
let owned;
let canonicalParent;
let canonicalOwned;
let sequence = 0;

before(() => {
  if (!existsSync(temporary)) mkdirSync(temporary);
  assert.ok(lstatSync(temporary).isDirectory() && !lstatSync(temporary).isSymbolicLink());
  canonicalParent = realpathSync(temporary);
  owned = mkdtempSync(path.join(temporary, 'source-archive-test-'));
  canonicalOwned = realpathSync(owned);
  assert.equal(path.dirname(canonicalOwned), canonicalParent);
});

after(() => {
  if (!owned) return;
  // Delete only the exact directory created by this test, never shared .tmp.
  assert.equal(path.dirname(path.resolve(owned)), path.resolve(temporary));
  assert.ok(path.basename(owned).startsWith('source-archive-test-'));
  const stat = lstatSync(owned);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(realpathSync(owned), canonicalOwned);
  assert.equal(path.dirname(canonicalOwned), canonicalParent);
  rmSync(owned, { recursive: true });
});

function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

function header({ name = 'plain.txt', type = '0', size = 0, prefix = '', magic = 'ustar\0' } = {}) {
  const result = Buffer.alloc(512);
  Buffer.from(name).copy(result, 0, 0, 100);
  result.write('0000644\0', 100, 'ascii');
  result.write('0000000\0', 108, 'ascii');
  result.write('0000000\0', 116, 'ascii');
  result.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  result.write('00000000000\0', 136, 'ascii');
  result[156] = type === '\0' ? 0 : type.charCodeAt(0);
  result.write(magic, 257, 'latin1');
  result.write('00', 263, 'ascii');
  Buffer.from(prefix).copy(result, 345, 0, 155);
  return checksum(result);
}

function member(options = {}, payload = Buffer.alloc(0)) {
  return Buffer.concat([header({ ...options, size: options.size ?? payload.length }), payload, Buffer.alloc((512 - payload.length % 512) % 512)]);
}

function archive(parts, ending = Buffer.alloc(1024)) {
  return Buffer.concat([...parts, ending]);
}

function paxRecord(key, value) {
  const body = Buffer.from(` ${key}=${value}\n`);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

function paxMember(records) {
  return member({ name: 'PaxHeader/plain', type: 'x' }, Buffer.concat(records));
}

function fixture(tar, compressed = false) {
  const file = path.join(owned, `fixture-${++sequence}.tar.gz`);
  writeFileSync(file, compressed ? tar : gzipSync(tar));
  return file;
}

function read(tar) {
  return readSourceArchive(fixture(tar));
}

function reject(title, make, pattern) {
  test(title, () => assert.throws(() => read(make()), pattern));
}

test('ASCII, NUL file type, directories and USTAR prefixes retain metadata only', () => {
  assert.deepEqual(read(archive([
    member({ name: 'docs/', type: '5' }),
    member({ name: 'readme.txt', prefix: 'docs' }, Buffer.from('synthetic')),
    member({ name: 'empty', type: '\0' }),
  ])), [
    { name: 'docs/', type: 'directory', size: 0 },
    { name: 'docs/readme.txt', type: 'file', size: 9 },
    { name: 'empty', type: 'file', size: 0 },
  ]);
});

test('UTF-8 header names are read directly, with no CLI encoding', () => {
  const name = 'docs/三工作区交接报告-2026-11-14.md';
  assert.deepEqual(read(archive([member({ name }, Buffer.from('正文'))])), [{ name, type: 'file', size: 6 }]);
});

test('real-shaped Chinese PAX byte lengths and timestamps do not create pseudo-members', () => {
  const name = 'docs/三工作区交接报告-2026-11-14.md';
  const payload = Buffer.from(`52 path=${name}\n28 mtime=1794671065.8884034\n`);
  assert.equal(payload.length, 80);
  assert.deepEqual(read(archive([
    member({ name: 'PaxHeader/docs', type: 'x' }, payload),
    member({ name }, Buffer.from('ok')),
  ])), [{ name, type: 'file', size: 2 }]);
});

test('local PAX path/size/mtime/atime/ctime override only the next entry', () => {
  assert.deepEqual(read(archive([
    paxMember([paxRecord('path', '目录/文件.txt'), paxRecord('size', '3'), paxRecord('mtime', '-1.25'), paxRecord('atime', '0'), paxRecord('ctime', '2.5')]),
    member({ name: 'fallback', size: 0 }, Buffer.from('abc')),
    member({ name: 'next' }),
  ])), [{ name: '目录/文件.txt', type: 'file', size: 3 }, { name: 'next', type: 'file', size: 0 }]);
});

test('GNU L long UTF-8 names and GNU magic are supported', () => {
  const name = `docs/${'长文件名'.repeat(30)}.md`;
  const longHeader = member({ name: '././@LongLink', type: 'L', magic: 'ustar ' }, Buffer.from(`${name}\0`));
  assert.deepEqual(read(archive([longHeader, member({ name: 'fallback' })])), [{ name, type: 'file', size: 0 }]);
});

test('4096-byte PAX paths and extra all-zero terminal blocks are accepted', () => {
  const name = 'a'.repeat(4096);
  assert.deepEqual(read(archive([paxMember([paxRecord('path', name)]), member()], Buffer.alloc(2048))), [{ name, type: 'file', size: 0 }]);
});

test('5000 headers are accepted at the entry bound', () => {
  assert.equal(read(archive(Array.from({ length: 5000 }, (_, i) => member({ name: `f${i}` })))).length, 5000);
});

test('an empty tar with two zero blocks is valid', () => assert.deepEqual(read(Buffer.alloc(1024)), []));

reject('corrupt checksum is rejected', () => { const h = header(); h[0] ^= 1; return archive([h]); }, /checksum mismatch/);
reject('non-octal checksum is rejected', () => { const h = header(); h[148] = 56; return archive([h]); }, /checksum: expected octal/);
reject('non-octal size is rejected', () => { const h = header(); h[124] = 57; return archive([checksum(h)]); }, /size: expected octal/);
reject('base-256 size is explicitly rejected', () => { const h = header(); h[124] = 128; return archive([checksum(h)]); }, /size: base-256 is unsupported/);
reject('base-256 checksum is explicitly rejected', () => { const h = header(); h[148] = 128; return archive([h]); }, /checksum: base-256 is unsupported/);
reject('partial tar blocks are rejected', () => archive([member()]).subarray(0, -1), /truncated tar block/);
reject('truncated entry data is rejected', () => archive([header({ size: 4096 })]), /truncated entry payload/);
reject('missing terminal blocks are rejected', () => member(), /missing two zero/);
reject('one zero end block is insufficient', () => archive([member()], Buffer.alloc(512)), /missing two zero/);
reject('nonzero content after terminal blocks is rejected', () => archive([member()], Buffer.concat([Buffer.alloc(1024), Buffer.alloc(512, 1)])), /nonzero trailing/);
reject('nonzero content after the first zero block is rejected', () => archive([member()], Buffer.concat([Buffer.alloc(512), header()])), /nonzero trailing/);
reject('nonzero entry padding is rejected', () => { const m = member({}, Buffer.from('a')); m[513] = 1; return archive([m]); }, /nonzero entry padding/);
reject('invalid UTF-8 header name is rejected', () => { const h = header(); h[0] = 255; return archive([checksum(h)]); }, /invalid UTF-8/);
reject('invalid UTF-8 USTAR prefix is rejected', () => { const h = header(); h[345] = 255; return archive([checksum(h)]); }, /invalid UTF-8/);
reject('hidden nonzero bytes after a header NUL are rejected', () => { const h = header({ name: 'a' }); h[3] = 120; return archive([checksum(h)]); }, /after header string terminator/);

for (const name of ['/absolute', '../escape', 'a/../escape', './dot', 'a/./dot', 'a//empty', 'a\\backslash', 'C:drive', 'line\nbreak', 'line\rbreak', '']) {
  reject(`unsafe member path ${JSON.stringify(name)} is rejected`, () => archive([member({ name })]), /unsafe path|path is empty/);
}
reject('file trailing slash is rejected', () => archive([member({ name: 'file/' })]), /unsafe path component/);
reject('NUL in a PAX path is rejected', () => archive([paxMember([paxRecord('path', 'bad\0name')]), member()]), /unsafe path/);
reject('PAX traversal cannot override a safe fallback', () => archive([paxMember([paxRecord('path', '../bad')]), member()]), /unsafe path/);
reject('PAX cannot mask an unsafe fallback header', () => archive([paxMember([paxRecord('path', 'safe')]), member({ name: '../bad' })]), /unsafe path/);
reject('4097-byte paths are rejected', () => archive([paxMember([paxRecord('path', 'a'.repeat(4097))]), member()]), /4096 bytes/);

for (const type of ['1', '2', '3', '4', '6', '7', 'g', 'K', 'S']) {
  reject(`link/global/special tar type ${type} is rejected`, () => archive([member({ type })]), /unsupported entry type/);
}
reject('a link target on an ordinary file is rejected', () => { const h = header(); h.write('target', 157); return archive([checksum(h)]); }, /link target/);
reject('directories with data are rejected', () => archive([member({ name: 'dir/', type: '5' }, Buffer.from('data'))]), /directory has nonzero size/);
reject('duplicate final names are rejected', () => archive([member({ name: 'same' }), member({ name: 'same' })]), /duplicate archive member/);
reject('directory slash aliases cannot bypass duplicate checking', () => archive([member({ name: 'dir/', type: '5' }), member({ name: 'dir' })]), /duplicate archive member/);
reject('duplicate names after PAX resolution are rejected', () => archive([member({ name: 'same' }), paxMember([paxRecord('path', 'same')]), member()]), /duplicate archive member/);
reject('duplicate PAX keys are rejected', () => archive([paxMember([paxRecord('path', 'a'), paxRecord('path', 'b')]), member()]), /duplicate PAX key/);
reject('unknown PAX keys are rejected', () => archive([paxMember([paxRecord('uid', '0')]), member()]), /unsupported PAX key/);
reject('empty PAX payload is rejected', () => archive([paxMember([]), member()]), /empty PAX/);
reject('non-decimal PAX size is rejected', () => archive([paxMember([paxRecord('size', '0x10')]), member()]), /unsigned decimal/);
reject('overflowing PAX size is rejected', () => archive([paxMember([paxRecord('size', '9999999999999999999')]), member()]), /integer overflow/);
reject('PAX timestamp garbage is rejected', () => archive([paxMember([paxRecord('mtime', 'NaN')]), member()]), /timestamp/);
reject('PAX declared length is checked in bytes, not Unicode characters', () => archive([member({ type: 'x' }, Buffer.from('13 path=中文\n')), member()]), /PAX record length/);
reject('PAX missing length separator is rejected', () => archive([member({ type: 'x' }, Buffer.from('12path=file\n')), member()]), /PAX record length/);
reject('PAX leading-zero record lengths are rejected', () => archive([member({ type: 'x' }, Buffer.from('013 path=abc\n')), member()]), /PAX record length/);
reject('PAX missing newline is rejected', () => { const p = paxRecord('path', 'abc'); p[p.length - 1] = 120; return archive([member({ type: 'x' }, p), member()]); }, /PAX record length/);
reject('PAX record missing equals is rejected', () => archive([member({ type: 'x' }, Buffer.from('11 pathabc\n')), member()]), /missing key\/value/);
reject('invalid UTF-8 PAX is rejected', () => { const p = paxRecord('path', 'abc'); p[p.length - 2] = 255; return archive([member({ type: 'x' }, p), member()]); }, /invalid UTF-8/);
reject('invalid UTF-8 GNU long name is rejected', () => archive([member({ type: 'L' }, Buffer.from([255, 0])), member()]), /invalid UTF-8/);
reject('GNU long name requires a NUL terminator', () => archive([member({ type: 'L' }, Buffer.from('long')), member()]), /GNU long name terminator/);
reject('GNU long name cannot contain embedded NUL', () => archive([member({ type: 'L' }, Buffer.from('a\0b\0')), member()]), /GNU long name terminator/);
reject('GNU long name traversal is rejected', () => archive([member({ type: 'L' }, Buffer.from('../bad\0')), member()]), /unsafe path/);
reject('dangling PAX is rejected', () => archive([paxMember([paxRecord('path', 'file')])]), /dangling metadata/);
reject('dangling GNU metadata is rejected', () => archive([member({ type: 'L' }, Buffer.from('long\0'))]), /dangling metadata/);
reject('dangling metadata without end blocks is rejected', () => paxMember([paxRecord('path', 'file')]), /dangling metadata/);
reject('stacked PAX metadata is rejected', () => archive([paxMember([paxRecord('mtime', '0')]), paxMember([paxRecord('path', 'file')]), member()]), /duplicate pending PAX/);
reject('conflicting GNU and PAX paths are rejected', () => archive([member({ type: 'L' }, Buffer.from('long\0')), paxMember([paxRecord('path', 'file')]), member()]), /conflicting path/);
reject('5001 entries exceed the bound', () => archive(Array.from({ length: 5001 }, (_, i) => member({ name: `f${i}` }))), /entry count exceeds 5000/);
reject('metadata headers count toward the 5000 entry bound', () => archive([...Array.from({ length: 4999 }, (_, i) => member({ name: `f${i}` })), paxMember([paxRecord('mtime', '0')]), member()]), /entry count exceeds 5000/);

test('invalid gzip and truncated gzip are rejected', () => {
  assert.throws(() => readSourceArchive(fixture(Buffer.from('not gzip'), true)), /invalid gzip/);
  assert.throws(() => readSourceArchive(fixture(gzipSync(Buffer.alloc(1024)).subarray(0, -4), true)), /invalid gzip/);
});

test('gunzip output is capped at 64 MiB', () => {
  const file = fixture(gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1)), true);
  assert.throws(() => readSourceArchive(file), /decompressed output exceeds 64 MiB/);
});

test('compressed files above 32 MiB are rejected before reading', () => {
  const file = path.join(owned, 'oversize.tar.gz');
  const fd = openSync(file, 'wx');
  try { ftruncateSync(fd, 32 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  assert.throws(() => readSourceArchive(file), /compressed size exceeds 32 MiB/);
});

test('directory inputs and hardlinked files are rejected', () => {
  assert.throws(() => readSourceArchive(owned), /regular, non-link/);
  const file = fixture(Buffer.alloc(1024));
  const alias = path.join(owned, 'hardlink.tar.gz');
  linkSync(file, alias);
  assert.throws(() => readSourceArchive(file), /nlink 1/);
  assert.throws(() => readSourceArchive(alias), /nlink 1/);
});

test('symbolic-link inputs are rejected', (t) => {
  const file = fixture(Buffer.alloc(1024));
  const alias = path.join(owned, 'symlink.tar.gz');
  try { symlinkSync(file, alias, 'file'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('host does not permit creating a synthetic file symlink'); return; }
    throw error;
  }
  assert.throws(() => readSourceArchive(alias), /regular, non-link/);
});
