import assert from 'node:assert/strict';
import test from 'node:test';
import { findEmbedded7z } from '../src/host/embedded-7z.mjs';

// 7z encoded by the local tool from a file containing "synthetic".
const fixture = Buffer.from('N3q8ryccAATtY1iVDQAAAAAAAABeAAAAAAAAAFUALbIBAAhzeW50aGV0aWMAAQQGAAEJDQAHCwEAASEhAQAMCQAICgFXAsRBAAAFARkMAAAAAAAAAAAAAAAAESUAcQBxAC0ANwB6AC0AZgBpAHgAdAB1AHIAZQAuAHQAeAB0AAAAFQYBACCA/4EAAA==', 'base64');

test('embedded candidates with a truncated start header are ignored', () => {
  assert.deepEqual(findEmbedded7z(fixture.subarray(0, 8), 0, 8), []);
});

test('embedded archives have exact offsets and reject corrupted or overflowing headers', () => {
  const framed = Buffer.concat([Buffer.alloc(7), fixture, Buffer.alloc(9)]);
  assert.deepEqual(findEmbedded7z(framed, 7, fixture.length), [{ offset: 7, end: 7 + fixture.length }]);
  assert.deepEqual(findEmbedded7z(framed, 7, fixture.length - 1), []);
  const corrupt = Buffer.from(fixture);
  corrupt[corrupt.length - 1] ^= 1;
  assert.deepEqual(findEmbedded7z(corrupt, 0, corrupt.length), []);
  assert.throws(() => findEmbedded7z(framed, 7, framed.length), TypeError);
});
