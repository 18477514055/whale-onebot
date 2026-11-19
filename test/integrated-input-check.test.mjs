import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyIntegratedInputs } from '../src/host/integrated-input-check.mjs';
import { fingerprintIntegratedContents } from '../src/host/integrated-plan.mjs';

test('integrated input validation rejects changes to the manifest, files and mount flags', t => {
  const temporary = path.resolve(import.meta.dirname, '../.tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const parent = fs.realpathSync(temporary);
  const root = fs.mkdtempSync(path.join(parent, 'integrated-inventory-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    fs.rmSync(resolved, { recursive: true });
  });
  const contents = 'test input';
  const digest = value => createHash('sha256').update(value).digest('hex');
  const dirs = ['src', 'node_modules'].map(name => path.join(root, name));
  const entries = dirs.map(dir => {
    fs.mkdirSync(dir);
    const guest = path.join(dir, 'fixture.mjs');
    fs.writeFileSync(guest, contents);
    return { kind: 'source', guest, bytes: Buffer.byteLength(contents), sha256: digest(contents) };
  });
  const manifest = { entries, manifestSha256: digest(JSON.stringify(entries)), inputContentSha256: fingerprintIntegratedContents(entries) };
  const mounts = new Map(dirs.map(dir => [dir, ['ro']]));
  const verify = () => verifyIntegratedInputs(manifest, mounts, root);
  assert.doesNotThrow(verify);
  assert.throws(() => verifyIntegratedInputs({ ...manifest, manifestSha256: '0'.repeat(64) }, mounts, root),
    { code: 'ERR_ASSERTION' });
  assert.throws(() => verifyIntegratedInputs({ ...manifest, inputContentSha256: '0'.repeat(64) }, mounts, root),
    { code: 'ERR_ASSERTION' });

  const extra = path.join(dirs[0], 'unlisted');
  fs.writeFileSync(extra, contents);
  assert.throws(verify, { code: 'ERR_ASSERTION' });
  fs.unlinkSync(extra);
  fs.mkdirSync(extra);
  assert.throws(verify, /Unexpected empty input directory/);
  fs.rmdirSync(extra);
  fs.unlinkSync(entries[0].guest);
  assert.throws(verify, { code: 'ENOENT' });
  fs.writeFileSync(entries[0].guest, 'test inpuT');
  assert.throws(verify, { code: 'ERR_ASSERTION' });
  fs.writeFileSync(entries[0].guest, contents);
  mounts.set(dirs[1], ['rw']);
  assert.throws(verify, /Input must be read only/);
  mounts.set(dirs[1], ['ro']);
  assert.doesNotThrow(verify);
});
