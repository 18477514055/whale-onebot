import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPE } from './inspect-pe.mjs';
import { findEmbedded7z } from '../src/host/embedded-7z.mjs';

const cache = path.join(fs.realpathSync(path.resolve(import.meta.dirname, '..')), '.tools', 'qq-windows-official');
assert.equal(fs.realpathSync(cache), cache);
const installer = path.join(cache, 'QQ_9.9.33_260813_x64_01.exe');
const stat = fs.lstatSync(installer);
assert(stat.isFile() && stat.nlink === 1 && stat.size === 314581680, 'Complete fixed Windows installer required');
assert.equal(fs.realpathSync(installer), installer);
const image = fs.readFileSync(installer);
assert.equal(image.length, stat.size);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const resource = inspectPE(image).sections.find(section => section.name === '.rsrc');
assert(resource && resource.rawSize > 0);
const archives = findEmbedded7z(image, resource.rawOffset, resource.rawSize);
assert(archives.length > 0 && archives.length <= 10);
const output = fs.mkdtempSync(path.join(cache, 'archives-'));
for (const archive of archives) {
  const bytes = image.subarray(archive.offset, archive.end);
  archive.file = path.join(output, 'resource-' + archive.offset + '.7z');
  fs.writeFileSync(archive.file, bytes, { flag: 'wx' });
  archive.bytes = bytes.length;
  archive.sha256 = digest(bytes);
}
console.log(JSON.stringify({ installerSha256: digest(image), archives }));
