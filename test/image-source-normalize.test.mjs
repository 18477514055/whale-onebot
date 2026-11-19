// normalizeImageSource：把运行端给的图片来源统一成 placement 能吃的 base64://
// 背景与动机见 src/bridge/native-bridge.mjs 里该函数上方的长注释（修「发图/贴纸一律 HTTP 400」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImageSource } from '../src/bridge/native-bridge.mjs';

const okFetch = (bytes) => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => String(bytes.length) },
  arrayBuffer: async () => bytes,
});

test('base64:// 原样放过', async () => {
  assert.equal(await normalizeImageSource('base64://QUJD'), 'base64://QUJD');
});

test('data: URI 剥壳成 base64://', async () => {
  assert.equal(await normalizeImageSource('data:image/png;base64,QUJD'), 'base64://QUJD');
});

test('非 base64 的 data: URI 不猜，原样返回（交给下游报错）', async () => {
  const src = 'data:text/plain,hello';
  assert.equal(await normalizeImageSource(src), src);
});

test('QQ CDN 白名单 host 原样放过（仍由 placement 自己下载）', async () => {
  for (const url of [
    'https://gchat.qpic.cn/a.png',
    'https://multimedia.nt.qq.com.cn/b.png',
    'https://c2cpicdw.qpic.cn/c.png',
    'https://gchatpic_new.qpic.cn/d.png',
  ]) {
    assert.equal(await normalizeImageSource(url), url);
  }
});

test('第三方 https URL 由我们自己下载并转 base64://', async () => {
  const out = await normalizeImageSource('https://example.com/sticker.gif', {
    fetchImpl: okFetch(Buffer.from([1, 2, 3])),
  });
  assert.equal(out, 'base64://' + Buffer.from([1, 2, 3]).toString('base64'));
});

test('超过字节上限直接抛错（→ 1400，带着原因）', async () => {
  await assert.rejects(
    () => normalizeImageSource('https://example.com/big.png', {
      maxBytes: 5,
      fetchImpl: okFetch(Buffer.alloc(10)),
    }),
    /too large|size/i,
  );
});

test('content-length 超限时先拒，不下载', async () => {
  let called = false;
  await assert.rejects(
    () => normalizeImageSource('https://example.com/huge.png', {
      maxBytes: 5,
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, headers: { get: () => '999' }, arrayBuffer: async () => Buffer.alloc(1) };
      },
    }),
    /too large/i,
  );
  assert.equal(called, true);
});

test('HTTP 非 2xx 抛错', async () => {
  await assert.rejects(
    () => normalizeImageSource('https://example.com/x.png', {
      fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => '0' } }),
    }),
    /HTTP 404/,
  );
});

test('空响应体抛错', async () => {
  await assert.rejects(
    () => normalizeImageSource('https://example.com/empty.png', { fetchImpl: okFetch(Buffer.alloc(0)) }),
    /empty/i,
  );
});

test('无法识别的来源原样返回（下游会给出 UNSUPPORTED_SOURCE）', async () => {
  assert.equal(await normalizeImageSource('relative/path.png'), 'relative/path.png');
  assert.equal(await normalizeImageSource(''), '');
});
