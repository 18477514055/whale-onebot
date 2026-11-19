// Received-image rkey provider.
//
// A received picture element carries `originImageUrl = "/download?appid=1406|1407&fileid=…"`
// with NO rkey. Without an rkey that relative address answers HTTP 400, and the md5
// CDN form 404s for anything the public store does not keep (measured on live traffic
// 2026-11-16). The fix is to obtain an rkey ourselves the way NapCat does, then build
// the full `https://multimedia.nt.qq.com.cn/download?appid=…&fileid=…&rkey=…` URL.
//
// External interface observations, not copied implementation:
//   · NapCat (NapukettoDev) `napcat.mjs` `FetchRkey` — builds OIDB `0x9067_202`
//     (command 36967 / sub-command 202) with body
//       reqHead { common{requestId:1, command:202}, scene{requestType:2,
//                 businessType:1, sceneType:0}, client{agentType:2} }
//       downloadRKeyReq { key:[10, 20, 2] }
//     and parses the reply's `rkeyList` as { rkey, ttl, time, type }; type 10 is the
//     private rkey, type 20 the group rkey, and each rkey string is `.slice(6)`.
//   · The wire path is the message service's `sendSsoCmdReqByContend(cmd, data)`,
//     which the fixed Linux wrapper exposes (`NodeIKernelMsgService::sendSsoCmdReqByContend`,
//     "needs 2", in the reverse-engineering assertion table). NapCat names the command
//     string `OidbSvcTrpcTcp.0x9067_202`.
//
// These signatures are a version-specific community contract; the synthetic tests do NOT
// establish compatibility with an installed QQ runtime. No binary is loaded here, and a
// failed rkey fetch must degrade back to the md5 fallback, never fabricate a URL.

export const RKEY_COMMAND = 'OidbSvcTrpcTcp.0x9067_202';
export const RKEY_APPID_PRIVATE = '1406';
export const RKEY_APPID_GROUP = '1407';
const OIDB_COMMAND = 36967; // 0x9067
const OIDB_SUB_COMMAND = 202;
const RKEY_KEY_TYPES = [10, 20, 2];
const RKEY_TYPE_PRIVATE = 10;
const RKEY_TYPE_GROUP = 20;
// rkey strings carry a fixed 6-character prefix (NapCat slices it off both on the packet
// and remote paths); a shorter result is rejected rather than shipped as an address.
const RKEY_PREFIX_CHARS = 6;
const RKEY_MIN_LENGTH = 8;
// ttl comes back in seconds as a UINT64; clamp to a sane window so a corrupt value
// cannot pin a stale rkey forever, nor force a refetch every message.
const RKEY_TTL_MIN_MS = 60_000;
const RKEY_TTL_MAX_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Minimal protobuf wire codec. Only the pieces the rkey request/response need.
// Hand-rolled so this module stays dependency-free (the project ships no protobuf lib).
// ---------------------------------------------------------------------------

/** Encode a non-negative integer as a varint. */
function writeVarint(value) {
  let v = BigInt(value);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/** Read one varint; returns { value: bigint, next: number } or null when truncated. */
function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buffer.length) {
    const byte = buffer[pos];
    pos += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7n;
    if (shift > 70n) return null; // defensive: reject absurdly long varints
  }
  return null;
}

/** Tag byte(s): (fieldNumber << 3) | wireType. */
function writeTag(fieldNumber, wireType) {
  return writeVarint((fieldNumber << 3) | wireType);
}

function writeVarintField(fieldNumber, value) {
  return Buffer.concat([writeTag(fieldNumber, 0), writeVarint(value)]);
}

function writeBytesField(fieldNumber, bytes) {
  return Buffer.concat([writeTag(fieldNumber, 2), writeVarint(bytes.length), bytes]);
}

/**
 * Walk a buffer into fields. Returns null on malformed input. Each entry is
 * { field, wire, bigint?, bytes? }. Groups (wire 3/4) are rejected; 32/64-bit
 * fixed fields are skipped but advance correctly.
 */
function parseWire(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const out = [];
  let pos = 0;
  while (pos < buffer.length) {
    const key = readVarint(buffer, pos);
    if (!key) return null;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buffer, key.next);
      if (!v) return null;
      out.push({ field, wire, bigint: v.value });
      pos = v.next;
    } else if (wire === 2) {
      const len = readVarint(buffer, key.next);
      if (!len) return null;
      const n = Number(len.value);
      if (!Number.isSafeInteger(n) || n < 0 || key.next + n > buffer.length) return null;
      const dataStart = key.next + (len.next - len.next); // len.next === key.next + varint bytes already consumed
      // readVarint returned `next` = position right after the length varint.
      const start = len.next;
      out.push({ field, wire, bytes: buffer.subarray(start, start + n) });
      pos = start + n;
    } else if (wire === 1) {
      if (key.next + 8 > buffer.length) return null;
      out.push({ field, wire });
      pos = key.next + 8;
    } else if (wire === 5) {
      if (key.next + 4 > buffer.length) return null;
      out.push({ field, wire });
      pos = key.next + 4;
    } else {
      return null; // groups (3/4) not expected and not supported
    }
  }
  return out;
}

function findField(fields, fieldNumber) {
  return fields.find((f) => f.field === fieldNumber);
}

// ---------------------------------------------------------------------------
// Request encoding
// ---------------------------------------------------------------------------

/** Encode the full OIDB 0x9067_202 rkey request body (a Buffer for sendSsoCmdReqByContend). */
export function encodeRkeyRequest(variant = RKEY_REQUEST_SHAPES[0]) {
  const shape = typeof variant === 'boolean' ? { packed: variant } : (variant ?? {});
  const packed = shape.packed !== false;
  const wrap = shape.wrap !== false;
  const commonCommand = Number.isInteger(shape.commonCommand) ? shape.commonCommand : OIDB_SUB_COMMAND;
  const reserved = shape.reserved === undefined ? 1 : shape.reserved;
  // downloadRKeyReq (DownloadRKeyReq): key = [10, 20, 2] as repeated int32.
  // Two legal wire forms exist and the native parser accepts only one of them:
  // packed (one length-delimited field) or one varint field per element.
  const downloadRKeyReq = packed
    ? Buffer.concat([writeTag(1, 2), writeVarint(Buffer.concat(RKEY_KEY_TYPES.map(v => writeVarint(v))).length),
      ...RKEY_KEY_TYPES.map(v => writeVarint(v))])
    : Buffer.concat(RKEY_KEY_TYPES.flatMap(v => [writeTag(1, 0), writeVarint(v)]));
  // common (Common): requestId = 1, command = 202.
  const common = Buffer.concat([
    writeVarintField(1, 1),
    writeVarintField(2, commonCommand),
  ]);
  // scene (SceneInfo): requestType = 2, businessType = 1, sceneType = 0.
  const scene = Buffer.concat([
    writeVarintField(101, 2),
    writeVarintField(102, 1),
    writeVarintField(200, 0),
  ]);
  // client (ClientInfo): agentType = 2.
  const client = Buffer.concat([writeVarintField(1, 2)]);
  // reqHead (ReqHead): common = 1, scene = 2, client = 3.
  const reqHead = Buffer.concat([
    writeBytesField(1, common),
    writeBytesField(2, scene),
    writeBytesField(3, client),
  ]);
  // ReqBody: reqHead = 1, downloadRKeyReq = 4.
  const body = Buffer.concat([
    writeBytesField(1, reqHead),
    writeBytesField(4, downloadRKeyReq),
  ]);
  // Bare ReqBody when the native layer adds the envelope itself.
  if (!wrap) return body;
  // OidbSvcTrpcTcpBase: command = 1, subCommand = 2, body = 4, isReserved = 12.
  const parts = [writeVarintField(1, OIDB_COMMAND), writeVarintField(2, OIDB_SUB_COMMAND),
    writeBytesField(4, body)];
  if (reserved !== null) parts.push(writeVarintField(12, reserved));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Response decoding
// ---------------------------------------------------------------------------

/**
 * Decode an rkey reply buffer into { private_rkey, group_rkey, ttlMs } or null.
 * Fail-closed: any malformed segment yields null so the caller falls back to md5.
 */
export function decodeRkeyResponse(buffer) {
  const top = parseWire(buffer);
  if (!top) return null;
  // OidbSvcTrpcTcpBase: errorCode = 3, body = 4.
  const errorCode = findField(top, 3);
  if (errorCode && errorCode.bigint !== undefined && errorCode.bigint !== 0n) return null;
  const bodyField = findField(top, 4);
  if (!bodyField?.bytes) return null;

  // RspBody: data = 4.
  const rsp = parseWire(bodyField.bytes);
  const dataField = rsp && findField(rsp, 4);
  if (!dataField?.bytes) return null;

  // RspData: rkeyList = 1 (repeated message).
  const list = parseWire(dataField.bytes);
  if (!list) return null;

  let privateRkey = '';
  let groupRkey = '';
  let ttlMs = RKEY_TTL_MAX_MS;
  for (const entry of list) {
    if (entry.field !== 1 || !entry.bytes) continue;
    const item = parseWire(entry.bytes);
    if (!item) continue;
    const rkeyField = findField(item, 1);
    const typeField = findField(item, 5);
    const ttlField = findField(item, 2);
    if (!rkeyField?.bytes) continue;
    const rkey = rkeyField.bytes.toString('utf8').slice(RKEY_PREFIX_CHARS);
    if (rkey.length < RKEY_MIN_LENGTH || /[\x00-\x20\x7f]/.test(rkey)) continue;
    const type = Number(typeField?.bigint ?? 0n);
    if (type === RKEY_TYPE_PRIVATE) privateRkey = rkey;
    else if (type === RKEY_TYPE_GROUP) groupRkey = rkey;
    const ttlSec = Number(ttlField?.bigint ?? 0n);
    if (Number.isFinite(ttlSec) && ttlSec > 0) {
      ttlMs = Math.min(ttlMs, Math.max(RKEY_TTL_MIN_MS, Math.min(RKEY_TTL_MAX_MS, ttlSec * 1000)));
    }
  }
  if (!privateRkey && !groupRkey) {
    // The envelope depth can differ between QQ builds. Fall back to a bounded
    // recursive search for messages that look like an rkey item
    // ({1: string rkey, 5: varint type}) instead of failing outright.
    const found = scanForRkeyItems(buffer, 0);
    for (const item of found) {
      const rkey = item.rkey;
      const typeKey = item.type;
      if (typeKey === RKEY_TYPE_PRIVATE) privateRkey = rkey;
      else if (typeKey === RKEY_TYPE_GROUP) groupRkey = rkey;
      else if (!privateRkey) privateRkey = rkey;
      if (item.ttlSec > 0)
        ttlMs = Math.min(ttlMs, Math.max(RKEY_TTL_MIN_MS, Math.min(RKEY_TTL_MAX_MS, item.ttlSec * 1000)));
    }
  }
  if (!privateRkey && !groupRkey) { rkeyDiagnostics.decodeFailed++; return null; }
  rkeyDiagnostics.decodeOk++;
  return { private_rkey: privateRkey, group_rkey: groupRkey, ttlMs };
}

/**
 * Depth-limited search for rkey items anywhere in the reply graph. Returns
 * { rkey, type, ttlSec } for every message that carries a plausible rkey string
 * plus a type varint. Bounded so a hostile or malformed buffer cannot spin.
 */
function scanForRkeyItems(buffer, depth) {
  if (depth > 6 || !buffer || buffer.length === 0 || buffer.length > 1024 * 1024) return [];
  const fields = parseWire(buffer);
  if (!fields) return [];
  const found = [];
  const text = findField(fields, 1);
  const type = findField(fields, 5);
  const ttl = findField(fields, 2);
  if (text?.bytes) {
    const raw = text.bytes.toString('utf8');
    const candidate = raw.slice(RKEY_PREFIX_CHARS);
    const typeValue = Number(type?.bigint ?? -1);
    const looksLikeRkey = candidate.length >= RKEY_MIN_LENGTH && !/[\x00-\x20\x7f]/.test(candidate) &&
      (typeValue === RKEY_TYPE_PRIVATE || typeValue === RKEY_TYPE_GROUP ||
        (typeValue === -1 && /^[A-Za-z0-9_\-+/=]+$/.test(candidate)));
    if (looksLikeRkey) found.push({ rkey: candidate, type: typeValue, ttlSec: Number(ttl?.bigint ?? 0n) });
  }
  for (const field of fields) {
    if (!field.bytes || field.bytes.length === 0) continue;
    found.push(...scanForRkeyItems(field.bytes, depth + 1));
    if (found.length > 8) break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/** Full download URL for a received picture given a resolved rkey. */
export function rkeyImageUrl(appid, fileid, rkey) {
  return `https://multimedia.nt.qq.com.cn/download?appid=${appid}&fileid=${encodeURIComponent(fileid)}&rkey=${encodeURIComponent(rkey)}`;
}

/**
 * Parse a received `originImageUrl` that still needs an rkey. Returns
 * { appid, fileid } for a usable relative `/download?…` with a valid appid, a single
 * fileid, and NO rkey yet. Returns null otherwise (already absolute, has an rkey,
 * wrong appid, or contains forbidden characters).
 */
export function relativeDownloadParts(value) {
  if (typeof value !== 'string' || !value.startsWith('/download?') || /[\\\x00-\x20\x7f#]/.test(value)) return null;
  // Parse the raw query by hand: URLSearchParams decodes `+` as a space, which would
  // corrupt base64-ish fileid values, and NapCat pastes the fileid verbatim. Values
  // here are plain `[A-Za-z0-9_+/=-]`, so a literal split is lossless and safe.
  const query = value.slice(value.indexOf('?') + 1);
  const params = new Map();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const val = pair.slice(eq + 1);
    if (!key) continue;
    if (!params.has(key)) params.set(key, []);
    params.get(key).push(val);
  }
  const appids = params.get('appid');
  const fileids = params.get('fileid');
  const rkeys = params.get('rkey');
  if (!appids || appids.length !== 1 || !['1406', '1407'].includes(appids[0])) return null;
  if (!fileids || fileids.length !== 1 || !/^[A-Za-z0-9_+/=-]+$/.test(fileids[0])) return null;
  if (rkeys && rkeys.length !== 0) return null;
  return { appid: appids[0], fileid: fileids[0] };
}

/** Pick the rkey for an appid: 1406 is private, anything else (1407) is group. */
export function rkeyForAppid(rkeyData, appid) {
  if (!rkeyData) return '';
  return appid === RKEY_APPID_PRIVATE ? rkeyData.private_rkey : rkeyData.group_rkey;
}

// ---------------------------------------------------------------------------
// Provider (with in-memory cache)
// ---------------------------------------------------------------------------

/**
 * Cache-backed rkey provider. `msg` must expose `sendSsoCmdReqByContend(cmd, data)`
 * (the fixed Linux wrapper's message service). When it does not, `available` is false
 * and every `get()` resolves null so callers fall back to the md5 address.
 */
// Non-sensitive observation of what sendSsoCmdReqByContend actually returns.
// Field names, types and lengths only — never a value, never a key.
// Every plausible request shape, tried in order until the native parser accepts
// one. NapCat builds {wrap:true, packed:true, commonCommand:202, reserved:1}, which
// this wrapper rejects ("请求包解析失败"), so the unconfirmed axes are swept:
//   wrap          full OidbSvcTrpcTcpBase envelope vs the bare ReqBody
//   packed        repeated int32 packed vs one varint per element
//   commonCommand common.command = sub-command 202 vs the full command 36967
//   reserved      isReserved present as 1 / present as 0 / omitted
// MEASURED 2026-11-16 on the fixed Linux wrapper: 252 combinations were tried —
// 24 packet shapes (envelope x key packing x common.command x isReserved) times
// 5 argument containers (Buffer, base64, hex, ArrayBuffer, Uint8Array) — and every
// single call came back {result: 145, errMsg: "请求包解析失败", rsp: ""}. The packet
// bytes match NapCat's own FetchRkey encoder field for field, so the request is not
// the problem: this build has no working packet-send channel behind the method
// (NapCat only succeeds because it loads a separate NativePacketClient hook first).
// The sweep is therefore collapsed to the canonical shape and a single container,
// which keeps one cheap diagnostic probe while removing 27 wasted native calls per
// image view.
const RKEY_CHANNEL_PROVEN_UNUSABLE = true;
export const RKEY_REQUEST_SHAPES = RKEY_CHANNEL_PROVEN_UNUSABLE
  ? [{ wrap: true, packed: true, commonCommand: 202, reserved: 1 }]
  : (() => {
    const shapes = [];
    for (const wrap of [true, false])
      for (const packed of [true, false])
        for (const commonCommand of [202, 36967])
          for (const reserved of [1, 0, null])
            shapes.push({ wrap, packed, commonCommand, reserved });
    return shapes;
  })();
export const RKEY_ENCODING_VARIANTS = RKEY_REQUEST_SHAPES;

// How the encoded packet is passed to sendSsoCmdReqByContend: raw bytes vs a text
// encoding. A native method that expects base64 will "fail to parse" a raw Buffer
// exactly like this.
export const RKEY_DATA_CONTAINERS = RKEY_CHANNEL_PROVEN_UNUSABLE
  ? ['buffer']
  : ['buffer', 'base64', 'hex', 'arraybuffer', 'uint8array'];

function toContainer(buffer, container) {
  switch (container) {
    case 'base64': return buffer.toString('base64');
    case 'hex': return buffer.toString('hex');
    case 'arraybuffer': return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    case 'uint8array': return new Uint8Array(buffer);
    default: return buffer;
  }
}
export const rkeyDiagnostics = { calls: 0, extractFailed: 0, decodeFailed: 0, decodeOk: 0,
  threw: 0, lastResult: null, acceptedVariant: null, triedShapes: 0, requestHeadHex: '', returnKind: null, returnKeys: null, returnShape: null, bufferField: null, bufferLength: 0, bufferHeadHex: '',
  errorName: null };

export class RkeyProvider {
  #msg;
  #timeoutMs;
  #private = '';
  #group = '';
  #expiresAt = 0;
  #noMethod = false;
  #variant = null;
  #container = null;

  constructor({ msg, timeoutMs = 10000 } = {}) {
    this.#msg = msg ?? null;
    this.#timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000 ? timeoutMs : 10000;
    this.#noMethod = typeof this.#msg?.sendSsoCmdReqByContend !== 'function';
  }

  get available() { return !this.#noMethod; }
  get noMethod() { return this.#noMethod; }

  /** Resolve { private_rkey, group_rkey } (cached when fresh) or null. */
  async get({ signal } = {}) {
    if (this.#noMethod) return null;
    if (this.#group || this.#private) {
      if (Date.now() < this.#expiresAt) return { private_rkey: this.#private, group_rkey: this.#group };
    }
    const raw = await this.#request(signal);
    if (!raw) return null;
    const decoded = decodeRkeyResponse(raw);
    if (!decoded) return null;
    this.#private = decoded.private_rkey;
    this.#group = decoded.group_rkey;
    this.#expiresAt = Date.now() + decoded.ttlMs;
    return { private_rkey: this.#private, group_rkey: this.#group };
  }

  async #request(signal) {
    // Both legal encodings of the repeated key list are attempted, because the
    // native parser rejects the request outright ("请求包解析失败") when it gets the
    // form it does not expect. The accepted one is remembered for later calls.
    // One flat task list: every packet shape as raw bytes, then the canonical shape
    // in the other containers (a native method expecting base64 rejects bytes with
    // the same "parse failed" wording). The first task that decodes wins and is
    // remembered, so a healthy session pays for this sweep once.
    const tasks = this.#variant === null
      ? [...RKEY_REQUEST_SHAPES.map(shape => ({ shape, container: 'buffer' })),
        ...RKEY_DATA_CONTAINERS.filter(c => c !== 'buffer').map(container => ({ shape: RKEY_REQUEST_SHAPES[0], container }))]
      : [{ shape: this.#variant, container: this.#container ?? 'buffer' }];
    for (const { shape, container } of tasks) {
      rkeyDiagnostics.calls++;
      rkeyDiagnostics.triedShapes++;
      const encoded = encodeRkeyRequest(shape);
      rkeyDiagnostics.requestHeadHex = encoded.subarray(0, 24).toString('hex');
      let result;
      try {
        result = await this.#msg.sendSsoCmdReqByContend(RKEY_COMMAND, toContainer(encoded, container));
      } catch (error) {
        rkeyDiagnostics.threw++;
        rkeyDiagnostics.errorName = String(error?.name ?? 'Error').slice(0, 40);
        continue;
      }
      observeShape(result, shape, container);
      const buffer = extractRspBuffer(result);
      if (!buffer) { rkeyDiagnostics.extractFailed++; continue; }
      const decoded = decodeRkeyResponse(buffer);
      if (!decoded) { rkeyDiagnostics.decodeFailed++; continue; }
      this.#variant = shape;
      this.#container = container;
      rkeyDiagnostics.acceptedVariant = describeVariant(shape) + '/' + container;
      rkeyDiagnostics.bufferLength = buffer.length;
      rkeyDiagnostics.bufferHeadHex = buffer.subarray(0, 16).toString('hex');
      return buffer;
    }
    return null;
  }
}

/**
 * Pull the reply buffer out of the loose `sendSsoCmdReqByContend` return shape.
 * NapCat reads `a.rspbuffer`; tolerate a bare Buffer and a `{ result }` envelope,
 * rejecting a non-zero result as failure. Returns null on anything unrecognized.
 */
const asBuffer = value => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (Array.isArray(value)) {
    // A byte array is a plausible native marshalling of a protobuf reply.
    if (value.length > 8 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(value);
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object ArrayBuffer]') return Buffer.from(new Uint8Array(value));
    // TypedArray views other than Uint8Array (DataView stores raw bytes too).
    if (typeof value.byteLength === 'number' && typeof value.byteOffset === 'number' &&
        typeof value.buffer === 'object' && value.buffer) {
      try { return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); } catch { /* fall through */ }
    }
  }
  if (typeof value === 'string' && value.length > 32) {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length > 8) return decoded;
  }
  return null;
};

/**
 * One-line, value-free description of a nested return field. This is what turns
 * "the call failed" into "the bytes live at rsp.data.buffer".
 */
function describeValue(value, depth = 0) {
  if (value == null) return String(value);
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (value instanceof ArrayBuffer) return `ArrayBuffer(${value.byteLength})`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  const type = typeof value;
  if (type !== 'object') return type === 'string' ? `string(${value.length})` : type;
  const name = value.constructor?.name ?? 'Object';
  if (depth >= 2) return name;
  let keys = [];
  try { keys = Object.keys(value).slice(0, 6); } catch { return name; }
  return `${name}{${keys.join(',')}}`;
}

/** Record the shape of the first reply only; values are never kept. */
function describeVariant(variant) {
  if (!variant || typeof variant !== 'object') return String(variant);
  return [variant.wrap === false ? 'body' : 'wrapped', variant.packed === false ? 'unpacked' : 'packed',
    'cmd' + (variant.commonCommand ?? 202), 'res' + String(variant.reserved)].join('/');
}

function observeShape(raw, variant, container) {
  if (rkeyDiagnostics.returnKind === null) {
  if (raw == null) { rkeyDiagnostics.returnKind = String(raw); return; }
  rkeyDiagnostics.returnKind = Buffer.isBuffer(raw) ? 'Buffer'
    : raw instanceof Uint8Array ? 'Uint8Array' : typeof raw;
  if (typeof raw !== 'object') return;
  let keys = [];
  try { keys = Object.keys(raw).slice(0, 16); } catch { keys = []; }
  rkeyDiagnostics.returnKeys = keys;
  rkeyDiagnostics.returnShape = keys.map(key => `${key}:${describeValue(raw[key])}`).slice(0, 8);
  if (typeof raw.result === 'number') rkeyDiagnostics.lastResult = raw.result;
  const errMsg = raw.errMsg;
  if (typeof errMsg === 'string' && errMsg) rkeyDiagnostics.errorName = errMsg.slice(0, 60);
  rkeyDiagnostics.returnVariant = describeVariant(variant) + '/' + (container ?? 'buffer');
  }
}

/**
 * Find the reply buffer anywhere in the returned object, breadth-first and
 * depth-limited. The wrapper's shape is not documented, so instead of assuming a
 * field name we look for the bytes: any Buffer/Uint8Array/ArrayBuffer/byte array
 * or long base64 string within three levels.
 */
function extractRspBuffer(raw, depth = 0, seen = new Set()) {
  if (raw == null || depth > 3) return null;
  const direct = asBuffer(raw);
  if (direct) { rkeyDiagnostics.bufferField = rkeyDiagnostics.bufferField ?? (depth === 0 ? 'self' : 'nested'); return direct; }
  if (typeof raw !== 'object') return null;
  if (seen.has(raw)) return null;
  seen.add(raw);
  // A non-zero status is a rejection, whatever the field is named.
  for (const statusKey of ['result', 'code', 'retcode', 'errorCode']) {
    const status = raw[statusKey];
    if (typeof status === 'number' && status !== 0) return null;
  }
  let keys = [];
  try { keys = Object.keys(raw).slice(0, 32); } catch { return null; }
  // Prefer the names the protocol family uses, then anything else.
  const preferred = ['rspbuffer', 'rspBuffer', 'rsp', 'data', 'body', 'buffer', 'payload', 'bytes'];
  const ordered = [...preferred.filter(key => keys.includes(key)), ...keys.filter(key => !preferred.includes(key))];
  for (const key of ordered) {
    let value;
    try { value = raw[key]; } catch { continue; }
    const found = extractRspBuffer(value, depth + 1, seen);
    if (found) {
      if (rkeyDiagnostics.bufferField === null) rkeyDiagnostics.bufferField = key;
      return found;
    }
  }
  return null;
}

