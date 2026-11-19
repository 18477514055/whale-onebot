import { crc32 } from 'node:zlib';

const magic = Buffer.from('377abcaf271c', 'hex');

export function findEmbedded7z(image, start, length) {
  if (!Buffer.isBuffer(image) || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
      start < 0 || length < 0 || start + length > image.length) {
    throw new TypeError('Invalid archive search bounds');
  }
  const end = start + length;
  const archives = [];
  for (let offset = image.indexOf(magic, start);
       offset >= start && offset + 32 <= end;
       offset = image.indexOf(magic, offset + 1)) {
    if (crc32(image.subarray(offset + 12, offset + 32)) !== image.readUInt32LE(offset + 8)) continue;
    const next = image.readBigUInt64LE(offset + 12);
    const size = image.readBigUInt64LE(offset + 20);
    if (size === 0n || next + size > BigInt(end - offset - 32)) continue;
    const nextStart = offset + 32 + Number(next);
    const archiveEnd = nextStart + Number(size);
    if (crc32(image.subarray(nextStart, archiveEnd)) !== image.readUInt32LE(offset + 28)) continue;
    archives.push({ offset, end: archiveEnd });
    offset = archiveEnd - 1;
  }
  return archives;
}
