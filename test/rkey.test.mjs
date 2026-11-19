import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RKEY_COMMAND,
  RkeyProvider,
  decodeRkeyResponse,
  encodeRkeyRequest,
  relativeDownloadParts,
  rkeyForAppid,
  rkeyImageUrl,
} from '../src/bridge/rkey.mjs';

// Hand-rolled protobuf helpers to build a synthetic rkey reply for decode tests.
function varint(v) {
  let x = BigInt(v);
  const out = [];
  while (x >= 0x80n) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; }
  out.push(Number(x));
  return Buffer.from(out);
}
function tag(field, wire) { return varint((field << 3) | wire); }
function vf(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }
function bf(field, bytes) { return Buffer.concat([tag(field, 2), varint(bytes.length), bytes]); }

// Build a well-formed rkey reply buffer mirroring NapCat's RspData{rkeyList} shape.
// rkeyList is a REPEATED message: each AW entry is its own field-1 length-delimited
// payload, concatenated (not wrapped in a single field-1 container).
function buildReply(entries) {
  const rkeyList = Buffer.concat(entries.map(({ rkey, type, ttl }) => bf(1, Buffer.concat([
    bf(1, Buffer.from(rkey)),
    vf(5, type),
    vf(2, ttl),
  ]))));
  const rspBody = Buffer.concat([bf(4, rkeyList)]); // RspBody.data = 4
  return Buffer.concat([vf(3, 0), bf(4, rspBody)]); // OidbBase.errorCode=3, body=4
}

test('encodeRkeyRequest emits the OIDB 0x9067_202 request and round-trips its fields', () => {
  const req = encodeRkeyRequest();
  assert(Buffer.isBuffer(req));
  // Top-level OidbSvcTrpcTcpBase: command=36967, subCommand=202, isReserved=1, body present.
  // Verify the command tag (field 1 wire 0) is 36967 and subCommand (field 2) is 202.
  let pos = 0;
  const readVar = (buf, off) => {
    let v = 0n, s = 0n, p = off;
    while (p < buf.length) { const b = buf[p]; p++; v |= BigInt(b & 0x7f) << s; if ((b & 0x80) === 0) return { v, p }; s += 7n; }
    throw new Error('varint overrun');
  };
  const fields = [];
  while (pos < req.length) {
    const k = readVar(req, pos); pos = k.p;
    const field = Number(k.v >> 3n), wire = Number(k.v & 7n);
    if (wire === 0) { const v = readVar(req, pos); fields.push([field, Number(v.v)]); pos = v.p; }
    else if (wire === 2) { const l = readVar(req, pos); const n = Number(l.v); fields.push([field, 'bytes']); pos = l.p + n; }
    else throw new Error('unexpected wire');
  }
  assert.ok(fields.some(([f, v]) => f === 1 && v === 36967), 'command field');
  assert.ok(fields.some(([f, v]) => f === 2 && v === 202), 'subCommand field');
  assert.ok(fields.some(([f, v]) => f === 12 && v === 1), 'isReserved field');
  assert.ok(fields.some(([f, v]) => f === 4 && v === 'bytes'), 'body field');
});

test('decodeRkeyResponse returns private/group rkey and clamps ttl', () => {
  const reply = buildReply([
    { rkey: '123456PRIVATEKEY', type: 10, ttl: 300 },
    { rkey: '123456GROUPKEY___', type: 20, ttl: 600 },
    { rkey: '123456OTHER____', type: 2, ttl: 100 },
  ]);
  const decoded = decodeRkeyResponse(reply);
  assert.equal(decoded.private_rkey, 'PRIVATEKEY');
  assert.equal(decoded.group_rkey, 'GROUPKEY___');
  // ttl is min of (300,600,100) seconds, clamped to >= 60s → 100s = 100000ms.
  assert.equal(decoded.ttlMs, 100_000);
});

test('decodeRkeyResponse rejects a non-zero error code and malformed input', () => {
  const reply = buildReply([{ rkey: '123456PRIVATEKEY', type: 10, ttl: 300 }]);
  // Flip the top-level errorCode field to 1.
  const badError = Buffer.concat([vf(3, 1), bf(4, Buffer.alloc(0))]);
  assert.equal(decodeRkeyResponse(badError), null);
  assert.equal(decodeRkeyResponse(Buffer.from('garbage-not-protobuf')), null);
  assert.equal(decodeRkeyResponse(Buffer.alloc(0)), null);
  assert.equal(decodeRkeyResponse(null), null);
});

test('decodeRkeyResponse strips the fixed 6-char prefix and rejects a too-short rkey', () => {
  // rkey shorter than prefix+min fails the whole decode (no usable key).
  const short = buildReply([{ rkey: '12345A', type: 10, ttl: 300 }]);
  assert.equal(decodeRkeyResponse(short), null);
});

test('relativeDownloadParts parses a bare relative origin and rejects wrong shapes', () => {
  assert.deepEqual(
    relativeDownloadParts('/download?appid=1406&fileid=AbC-123_/='),
    { appid: '1406', fileid: 'AbC-123_/=' },
  );
  assert.deepEqual(
    relativeDownloadParts('/download?fileid=AbC&appid=1407'),
    { appid: '1407', fileid: 'AbC' },
  );
  // already has an rkey → not our job
  assert.equal(relativeDownloadParts('/download?appid=1406&fileid=AbC&rkey=k'), null);
  // absolute URL → null
  assert.equal(relativeDownloadParts('https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=AbC'), null);
  // wrong appid
  assert.equal(relativeDownloadParts('/download?appid=9999&fileid=AbC'), null);
  // no fileid
  assert.equal(relativeDownloadParts('/download?appid=1406'), null);
  // bad chars in fileid
  assert.equal(relativeDownloadParts('/download?appid=1406&fileid=a b'), null);
  // not /download
  assert.equal(relativeDownloadParts('/other?appid=1406&fileid=AbC'), null);
});

test('rkeyImageUrl encodes fileid and rkey and picks private vs group rkey', () => {
  assert.equal(
    rkeyImageUrl('1406', 'a+b/c=', 'priv/key'),
    'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=a%2Bb%2Fc%3D&rkey=priv%2Fkey',
  );
  const data = { private_rkey: 'PRIV', group_rkey: 'GRP' };
  assert.equal(rkeyForAppid(data, '1406'), 'PRIV');
  assert.equal(rkeyForAppid(data, '1407'), 'GRP');
  assert.equal(rkeyForAppid(null, '1406'), '');
});

test('RkeyProvider is unavailable without sendSsoCmdReqByContend and fails closed on it', async () => {
  const noMethod = new RkeyProvider({ msg: {} });
  assert.equal(noMethod.available, false);
  assert.equal(noMethod.noMethod, true);
  assert.equal(await noMethod.get(), null);
});

test('RkeyProvider caches a successful fetch and only calls once per TTL window', async () => {
  let calls = 0;
  const reply = buildReply([
    { rkey: '123456PRIVATEKEY', type: 10, ttl: 300 },
    { rkey: '123456GROUPKEY___', type: 20, ttl: 300 },
  ]);
  const msg = {
    async sendSsoCmdReqByContend(cmd, data) {
      calls += 1;
      assert.equal(cmd, RKEY_COMMAND);
      assert(Buffer.isBuffer(data));
      return { result: 0, rspbuffer: reply };
    },
  };
  const provider = new RkeyProvider({ msg, timeoutMs: 5000 });
  assert.equal(provider.available, true);
  const first = await provider.get();
  assert.equal(first.private_rkey, 'PRIVATEKEY');
  assert.equal(first.group_rkey, 'GROUPKEY___');
  const second = await provider.get();
  assert.equal(second.private_rkey, 'PRIVATEKEY');
  assert.equal(calls, 1); // cached
});

test('RkeyProvider fails closed on a zero result or unrecognized reply', async () => {
  const zero = new RkeyProvider({ msg: { async sendSsoCmdReqByContend() { return { result: 1 }; } } });
  assert.equal(await zero.get(), null);
  const junk = new RkeyProvider({ msg: { async sendSsoCmdReqByContend() { return Buffer.from('nope'); } } });
  assert.equal(await junk.get(), null);
  const empty = new RkeyProvider({ msg: { async sendSsoCmdReqByContend() { return { result: 0, rspbuffer: null }; } } });
  assert.equal(await empty.get(), null);
});
