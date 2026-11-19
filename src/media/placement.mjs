import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The caller owns process isolation and the native client's path convention.
// This helper checks the selected destination and its contents.
export async function placeImage({ store, token, root, resolveDestination, copy, elementSubType = 0 }) {
  function directory(target) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target)
      throw new Error('Invalid media directory');
  }
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root)
    throw new Error('Invalid media root');
  directory(root);
  const asset = await store.inspect(token);
  const source = store.assetPath(token);
  const raw = await resolveDestination({
    md5HexStr: asset.md5, fileName: asset.fileName, elementType: 2,
    // NapCat passes the picture sub type here (createValidSendPicElement ->
    // uploadFile(file, PIC, subType)), so a sticker asks the SDK for its path with
    // elementSubType=1 and a normal picture with 0. Sending a sticker while asking
    // for a subType-0 path made native refuse the message, so this is threaded
    // through instead of being pinned to 0.
    elementSubType: Number.isInteger(elementSubType) && elementSubType >= 0 && elementSubType <= 255 ? elementSubType : 0,
    thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '',
  });
  if (typeof raw !== 'string' || !raw || raw.length > 4096 ||
      /[\x00-\x1f:\\]/.test(raw) || raw.split('/').some(part => part === '..' || part === '.'))
    throw new Error('Invalid native media path');
  const destination = path.resolve(root, raw);
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
      destination === source) throw new Error('Media destination is outside its placement area');
  function checkParents() {
    directory(root);
    let dir = root;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      dir = path.join(dir, part);
      directory(dir);
    }
  }
  checkParents();
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Media destination already exists');
  await copy(source, destination);
  checkParents();
  const before = fs.lstatSync(destination, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(asset.bytes) ||
      fs.realpathSync(destination) !== destination) throw new Error('Invalid placed file');
  const fd = fs.openSync(destination, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const same = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size &&
    a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  try {
    if (!same(fs.fstatSync(fd, { bigint: true }), before)) throw new Error('Placed file changed');
    const buffer = Buffer.alloc(65536);
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    let bytes = 0;
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null));) {
      bytes += count;
      if (bytes > asset.bytes) throw new Error('Placed file grew');
      sha.update(buffer.subarray(0, count));
      md5.update(buffer.subarray(0, count));
    }
    checkParents();
    if (bytes !== asset.bytes || sha.digest('hex') !== asset.sha256 || md5.digest('hex') !== asset.md5 ||
        !same(fs.fstatSync(fd, { bigint: true }), before) || !same(fs.lstatSync(destination, { bigint: true }), before))
      throw new Error('Placed bytes differ from the staged image');
  } finally {
    fs.closeSync(fd);
  }
  return { path: destination, nativePath: raw, bytes: asset.bytes, sha256: asset.sha256, md5: asset.md5 };
}
