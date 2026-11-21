import { inflateSync, brotliDecompressSync } from 'node:zlib';

export const MAX_FRAME = 1024 * 1024;
const MAX_EXPANDED = 4 * MAX_FRAME;
const malformed = () => new Error('Invalid live protocol frame');

export function packet(op, value) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + body.length); header.writeUInt16BE(16, 4); header.writeUInt16BE(1, 6);
  header.writeUInt32BE(op, 8); header.writeUInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

// Compression wraps a sequence of full packets, not a single JSON document.
export function unpack(input) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_FRAME) throw malformed();
  const out = []; let budget = MAX_EXPANDED, packets = 0;
  function scan(buf, nested) {
    for (let i = 0; i < buf.length;) {
      if (++packets > 1024 || i + 16 > buf.length) throw malformed();
      const len = buf.readUInt32BE(i), header = buf.readUInt16BE(i + 4);
      const v = buf.readUInt16BE(i + 6), op = buf.readUInt32BE(i + 8);
      if (header < 16 || len < header || len > buf.length - i) throw malformed();
      const body = buf.subarray(i + header, i + len); i += len;
      if (v === 2 || v === 3) {
        if (nested || op !== 5 || budget < 1) throw malformed();
        const sub = (v === 2 ? inflateSync : brotliDecompressSync)(body, {maxOutputLength:budget});
        budget -= sub.length; scan(sub, true);
      } else if (v <= 1 && (op === 5 || op === 8)) {
        out.push({op, data:JSON.parse(body.toString('utf8'))});
      } else if (v <= 1 && op === 3 && body.length === 4) out.push({op, data:body.readUInt32BE()});
    }
  }
  scan(input, false); return out;
}

const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const id = n => (typeof n === 'string' || count(n) !== null) && /^\d{1,20}$/.test(n) ? String(n) : null;
const text = (s, cap) => typeof s === 'string' ? s.slice(0, cap) : '';

// Only materialize top-level fields with a known meaning. Do not expose raw pb,
// opaque nested user info, medals, images, URLs or the original JSON command.
function fields(b64) {
  if (typeof b64 !== 'string' || b64.length > 100000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw malformed();
  const b = Buffer.from(b64, 'base64'), out = []; let pos = 0;
  function vint() {
    let val = 0n;
    for (let i = 0; i < 10 && pos < b.length; i++) {
      const x = b[pos++]; val |= BigInt(x & 127) << BigInt(i * 7);
      if (!(x & 128)) return val;
    }
    throw malformed();
  }
  while (pos < b.length) {
    const tag = Number(vint()), wire = tag % 8, key = Math.floor(tag / 8);
    if (!key || !Number.isSafeInteger(tag) || out.length >= 1024) throw malformed();
    if (wire === 0) out.push([key, vint()]);
    else {
      const size = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(vint()) : -1;
      if (size < 0 || size > b.length - pos) throw malformed();
      out.push([key, b.subarray(pos, pos + size)]); pos += size;
    }
  }
  return out;
}

export function liveEvent(command) {
  const cmd = command?.cmd?.split?.(':')[0], d = command?.data ?? {};
  if (cmd === 'DANMU_MSG') {
    const info = command.info;
    if (typeof info?.[1] === 'string') return {sub_type:'danmu', text:text(info[1], 2048), user_id:id(info[2]?.[0]), nickname:text(info[2]?.[1], 128)};
  } else if (cmd === 'SEND_GIFT') {
    return {sub_type:'gift', user_id:id(d.uid), nickname:text(d.uname, 128), gift_id:id(d.giftId), gift_name:text(d.giftName, 128), quantity:count(d.num)};
  } else if (cmd === 'INTERACT_WORD') {
    return {sub_type:'presence', user_id:id(d.uid), nickname:text(d.uname, 128), interaction:count(d.msg_type)};
  } else if (cmd === 'INTERACT_WORD_V2' || cmd === 'ONLINE_RANK_V3') {
    try {
      const f = fields(d.pb ?? command.pb);
      if (cmd === 'ONLINE_RANK_V3') return {sub_type:'rank_update'}; // No verified member schema.
      const uid = f.find(([k,v]) => k === 1 && typeof v === 'bigint')?.[1];
      const name = f.find(([k,v]) => k === 2 && Buffer.isBuffer(v))?.[1];
      const type = f.find(([k,v]) => k === 5 && typeof v === 'bigint')?.[1];
      return {sub_type:'presence', user_id:uid?.toString() ?? null, nickname:text(name?.toString('utf8'), 128), interaction:count(Number(type))};
    } catch { return null; } // One unknown protobuf event need not kill the channel.
  } else if (cmd === 'ONLINE_RANK_COUNT') return {sub_type:'rank_count', count:count(d.count)};
  else if (cmd === 'WATCHED_CHANGE') return {sub_type:'watched', count:count(d.num)};
  return null;
}
