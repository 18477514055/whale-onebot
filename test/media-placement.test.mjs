import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { placeImage } from '../src/media/placement.mjs';

test('placement verifies byte identity and refuses escaped or occupied destinations', async () => {
  const temporary = path.join(fs.realpathSync(path.resolve(import.meta.dirname, '..')), '.tmp');
  fs.mkdirSync(temporary, { recursive: true });
  assert.equal(fs.realpathSync(temporary), temporary);
  const work = fs.mkdtempSync(path.join(temporary, 'media-placement-'));
  const destination = path.join(work, 'destination');
  fs.mkdirSync(destination);
  const source = path.join(work, 'staged');
  const bytes = Buffer.from('synthetic media');
  fs.writeFileSync(source, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const md5 = createHash('md5').update(bytes).digest('hex');
  const store = { inspect: async () => ({ bytes: bytes.length, sha256, md5, fileName: 'fixture.png' }), assetPath: () => source };
  let copies = 0;
  const copy = (from, to) => {
    copies++;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  };
  const options = { store, token: 'fixture', root: destination, copy };
  try {
    await assert.rejects(placeImage({ ...options, resolveDestination: () => '../escape.png' }));
    assert.equal(copies, 0);
    const placed = await placeImage({ ...options, resolveDestination: () => 'image.png' });
    assert.equal(placed.sha256, sha256);
    await assert.rejects(placeImage({ ...options, resolveDestination: () => 'image.png' }));
    assert.equal(copies, 1);
    await assert.rejects(placeImage({ ...options, resolveDestination: () => 'wrong.png',
      copy: (_, to) => fs.writeFileSync(to, Buffer.alloc(bytes.length)) }), /differ/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(work)), temporary);
    fs.rmSync(work, { recursive: true });
  }
});
