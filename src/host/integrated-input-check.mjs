import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprintIntegratedContents } from './integrated-plan.mjs';

export function verifyIntegratedInputs({ entries, manifestSha256, inputContentSha256 }, mountFlags, projectRoot = '/qq-onebot') {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(JSON.stringify(entries)), manifestSha256);
  if (inputContentSha256 !== undefined) assert.equal(fingerprintIntegratedContents(entries), inputContentSha256);
  const trees = ['src', 'node_modules'].map(name => path.join(projectRoot, name));
  for (const entry of entries) {
    const stat = fs.lstatSync(entry.guest);
    assert(stat.isFile() && stat.nlink === 1);
    assert.equal(fs.realpathSync(entry.guest), entry.guest);
    assert.equal(stat.size, entry.bytes);
    assert.equal(digest(fs.readFileSync(entry.guest)), entry.sha256);
    const mount = trees.find(dir => entry.guest.startsWith(dir + path.sep)) ?? entry.guest;
    assert(mountFlags.get(mount)?.includes('ro'), 'Input must be read only');
  }
  for (const tree of trees) {
    const actual = [];
    function walk(dir) {
      assert.equal(fs.realpathSync(dir), dir);
      const children = fs.readdirSync(dir, { withFileTypes: true });
      assert(dir === tree || children.length > 0, 'Unexpected empty input directory');
      for (const entry of children) {
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(target);
        else {
          assert(entry.isFile());
          actual.push(target);
        }
      }
    }
    walk(tree);
    const expected = entries.filter(entry => entry.guest.startsWith(tree + path.sep)).map(entry => entry.guest);
    assert.deepEqual(actual.sort(), expected.sort());
  }
}
