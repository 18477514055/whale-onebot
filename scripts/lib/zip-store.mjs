// 极简 ZIP 写入器（store，不压缩）：只做我们需要的三件事 ——
// ① **条目名用正斜杠**（Windows 的 Compress-Archive 会写反斜杠，解包后变成 `usr\bin\x` 这种怪文件，
//    rootfs 永远不就绪，这条坑我们踩过）；② 可重复（固定时间戳）；③ 不引第三方依赖。
//
// 用法：
//   const zip = new ZipWriter();
//   zip.add('input/agent-app/package.json', Buffer.from('{}'));
//   const bytes = zip.finish();
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 统一成 zip 要求的条目名：正斜杠、无前导 ./、无盘符、拒绝越界。 */
export function normalizeEntryName(name) {
  if (typeof name !== 'string' || !name) throw new TypeError('entry name required');
  let n = name.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(n)) n = n.slice(2);
  const parts = n.split('/');
  if (parts.includes('..')) throw new TypeError('entry escapes archive: ' + name);
  const kept = parts.filter(p => p && p !== '.');
  if (!kept.length) throw new TypeError('empty entry name');
  return kept.join('/');
}

export class ZipWriter {
  #entries = [];
  #names = new Set();

  /**
   * @param {string} name 条目名（会被规范化成正斜杠）
   * @param {Buffer} data 内容
   * @param {{deflate?:boolean}} options deflate=true 时压缩（文本更小），默认不压缩
   */
  add(name, data, { deflate = false } = {}) {
    const entry = normalizeEntryName(name);
    if (this.#names.has(entry)) throw new Error('duplicate entry: ' + entry);
    this.#names.add(entry);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    this.#entries.push({ name: entry, raw, body, method: deflate ? 8 : 0 });
    return this;
  }

  get size() { return this.#entries.length; }

  /** 生成 zip 字节。固定 1980-01-01，保证同样输入得到同样输出（便于比对 sha256）。 */
  finish() {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of this.#entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const crc = crc32(e.raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);          // version needed
      local.writeUInt16LE(0x0800, 6);      // UTF-8 名
      local.writeUInt16LE(e.method, 8);
      local.writeUInt16LE(0, 10);          // time
      local.writeUInt16LE(0x0021, 12);     // date = 1980-01-01
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(e.body.length, 18);
      local.writeUInt32LE(e.raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, nameBuf, e.body);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0x0021, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(e.body.length, 20);
      cd.writeUInt32LE(e.raw.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cd, nameBuf]));

      offset += local.length + nameBuf.length + e.body.length;
    }
    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.#entries.length, 8);
    end.writeUInt16LE(this.#entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, centralBuf, end]);
  }
}
