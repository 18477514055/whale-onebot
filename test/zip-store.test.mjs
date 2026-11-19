import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZipWriter, crc32, normalizeEntryName } from '../scripts/lib/zip-store.mjs';

test('条目名一律转成正斜杠，并拒绝越界路径', () => {
  assert.equal(normalizeEntryName('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(normalizeEntryName('./a/b'), 'a/b');
  assert.equal(normalizeEntryName('C:\\x\\y'), 'x/y');
  assert.throws(() => normalizeEntryName('../evil'), /escapes archive/);
  assert.throws(() => normalizeEntryName(''), /entry name required/);
});

test('crc32 与已知值一致', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('生成的 zip 能被系统 tar 列出，且条目名是正斜杠', t => {
  const dir = fs.mkdtempSync(path.resolve('.tmp/zip-store-test-'));
  t.after(() => { assert.equal(fs.realpathSync(dir), dir); fs.rmSync(dir, { recursive: true }); });
  const zip = new ZipWriter();
  zip.add('input/agent-app/package.json', Buffer.from('{"name":"x"}'));
  zip.add('qq-onebot/src/cli.mjs', Buffer.from('// hi\n'), { deflate: true });
  const file = path.join(dir, 'out.zip');
  fs.writeFileSync(file, zip.finish());

  // Windows 的 bsdtar 会在个别条目后带 \r，比较前统一去掉
  const listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8' })
    .split('\n').map(x => x.replace(/\r$/, '')).filter(Boolean).sort();
  assert.deepEqual(listing, ['input/agent-app/package.json', 'qq-onebot/src/cli.mjs']);
});

test('同样输入产生同样字节（便于比对 sha256）', () => {
  const build = () => {
    const z = new ZipWriter();
    z.add('a.txt', Buffer.from('same'));
    return z.finish();
  };
  assert.deepEqual(build(), build());
});

test('重复条目直接拒绝，避免解包时互相覆盖', () => {
  const z = new ZipWriter();
  z.add('a.txt', Buffer.from('1'));
  assert.throws(() => z.add('./a.txt', Buffer.from('2')), /duplicate entry/);
});
