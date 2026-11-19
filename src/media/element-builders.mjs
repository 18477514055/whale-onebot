// P1 media element builders — voice (ptt) / video / group-private file / image.
//
// Scope (hard): native ELEMENT CONSTRUCTION only. No placement, no upload, no
// sendMsg, no network, no configuration, no message logging. The single exception
// is validateLocalMedia(), which performs metadata-only synchronous queries
// (lstatSync / accessSync — the same class as the task's fs.statSync, plus the
// ability to reject a symlink and to test readability). Everything else is pure:
// same input in, same element out, no side effects.
//
// Field provenance: every non-obvious field below carries a `见 <file>:<line>`
// citation. Values whose acceptance by the real client is NOT yet proven are
// marked 待真机确认 and listed in the hand-off report; field NAMES always come from
// a citation, and nothing is invented.
//
// Shapes we must stay compatible with inside this repo:
//   src/bridge/native-bridge.mjs:129-141         fileSegment()  — receive-side file element
//   src/bridge/native-bridge.mjs:228-269         mediaSegment() — receive-side 2/4/5 elements
//   src/bridge/native-bridge.mjs:367-369         mediaReadbackFields — field names per elementType
//   src/media/native-image-placement.mjs:103-108 send-side picElement layout
//
// NapCat references are read-only field/shape references (no restricted
// implementation is copied here; the construction logic below is our own).
import fs from 'node:fs';

const MiB = 1024 * 1024;

// The 12 MiB picture cap is the existing production budget, not a new guess.
export const IMAGE_MAX_BYTES = 12 * MiB;            // 见 src/bridge/native-bridge.mjs:190-193
// Our own sanity ceiling for the `maxBytes` argument; NOT a QQ limit.
const MEDIA_LIMIT_CEILING = 1024 * MiB;
// fileSize travels as a decimal string bounded to uint64.
// 见 src/bridge/native-bridge.mjs:134-135 (fileElement readback validation)
const UINT64_MAX = 18446744073709551615n;
const DECIMAL = /^(0|[1-9]\d{0,19})$/;
const MD5 = /^[0-9a-fA-F]{32}$/;                     // 见 src/bridge/native-bridge.mjs:165-171
const SHA1 = /^[0-9a-fA-F]{40}$/;
// Same group-folder-id rule the action layer already enforces.
const FOLDER_ID = /^\/?[A-Za-z0-9_-]+$/;             // 见 src/actions.mjs:88-90
const FORBIDDEN_NAME = /[\\/\x00-\x1f\x7f]/;         // 见 src/bridge/native-bridge.mjs:132-133
const MAX_PATH = 4096;
const MAX_DURATION_SEC = 24 * 60 * 60;

// ElementType 见 .tmp/napcat-src/packages/napcat-core/types/msg.ts:48-51
export const ELEMENT_TYPES = Object.freeze({ image: 2, file: 3, ptt: 4, video: 5 });
// PicSubType 见 .tmp/napcat-src/packages/napcat-core/types/msg.ts:124-126
export const PIC_SUB_TYPES = Object.freeze({ normal: 0, sticker: 1 });
// PicType 见 .tmp/napcat-src/packages/napcat-core/types/msg.ts:111-119
export const PIC_TYPES = Object.freeze({ jpeg: 1000, png: 1001, webp: 1002, gif: 2000 });
// NTVideoType 见 .tmp/napcat-src/packages/napcat-core/types/msg.ts:293-304
export const VIDEO_FORMATS = Object.freeze({
  afs: 7, avi: 1, mkv: 4, mod: 9, mov: 8, mp4: 2, mts: 11, rm: 6, rmvb: 5, ts: 10, wmv: 3,
});

export class MediaElementError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaElementError'; this.code = code; }
}
function fail(code, message) { throw new MediaElementError(code, message); }

// Error messages never carry a full path: only the basename, so a failure cannot
// leak a home directory or an account-specific folder into a log line.
function label(value) {
  if (typeof value !== 'string' || value.length === 0) return '<empty>';
  const parts = value.split(/[\\/]/).filter(part => part.length > 0);
  return parts.length ? parts[parts.length - 1].slice(0, 128) : '<empty>';
}
function requirePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || /[\x00-\x1f\x7f]/.test(value))
    fail('INVALID_PATH', `${field} must be a non-empty bounded path without control characters`);
  return value;
}
function requireFileName(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH ||
      value === '.' || value === '..' || FORBIDDEN_NAME.test(value))
    fail('INVALID_FILENAME', `${field} must be one bounded plain file name (${label(value)})`);
  return value;
}
// Derive the basename without touching the filesystem and without depending on
// path.sep: both separators are honoured on every platform.
function derivedName(filePath) {
  const parts = filePath.split(/[\\/]/).filter(part => part.length > 0);
  return parts.length ? parts[parts.length - 1] : '';
}
function decimalSize(value, field) {
  let text;
  if (typeof value === 'number') text = Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  else if (typeof value === 'string') text = value;
  else text = null;
  if (text === null || !DECIMAL.test(text) || BigInt(text) > UINT64_MAX)
    fail('INVALID_SIZE', `${field} must be a non-negative decimal byte count`);
  return text;
}
function digestOf(value, field, pattern) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value))
    fail('INVALID_DIGEST', `${field} must be a lower/upper-case hex digest`);
  return value;
}
function secondsOf(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_DURATION_SEC)
    fail('INVALID_DURATION', `${field} must be a duration in seconds between 0 and ${MAX_DURATION_SEC}`);
  // Every send shape carries whole seconds.
  // 见 .tmp/napcat-src/packages/napcat-core/packet/message/element.ts:485,564
  return Math.round(value);
}
function pixelsOf(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535)
    fail('INVALID_DIMENSION', `${field} must be a whole pixel count between 0 and 65535`);
  return value;
}
function boundedText(value, field, max) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    fail('INVALID_ARGUMENT', `${field} must be a bounded string without control characters`);
  return value;
}
// Identifies / bounds the native file UUID that the receive path exposes as
// fileElement.fileUuid. 见 src/bridge/native-bridge.mjs:137-139
function uuidOf(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\x00-\x20\x7f]/.test(value))
    fail('INVALID_UUID', 'fileUuid must be one bounded opaque identifier');
  return value;
}

/**
 * Numeric element sub type for a media kind.
 *
 * image   → 0  PicSubType.KNORMAL  (见 .../types/msg.ts:125)
 * sticker → 1  PicSubType.KCUSTOM  (见 .../types/msg.ts:126; OneBot image sub_type is
 *              passed straight through, 见 .tmp/napcat-src/packages/napcat-onebot/api/msg.ts:763-771,
 *              and the sticker asks the SDK for its path with elementSubType=1,
 *              见 src/media/placement.mjs:20-25)
 * ptt / video / file → 0  This is the EFFECTIVE value: the native uploadFile call
 *              defaults elementSubType to 0 and those call sites omit it
 *              (见 .tmp/napcat-src/packages/napcat-core/apis/file.ts:141 and
 *               .tmp/napcat-src/packages/napcat-onebot/api/file.ts:125,195; the file
 *               call passes the literal 0, 见 .../api/file.ts:43). There is no
 *               separate "sub type" semantic proven for these three kinds.
 *
 * Anything else returns null — unrecognised, NOT a guessed number.
 */
export function elementSubTypeFor(kind) {
  switch (kind) {
    case 'image': return PIC_SUB_TYPES.normal;
    case 'sticker': return PIC_SUB_TYPES.sticker;
    case 'ptt': return 0;
    case 'video': return 0;
    case 'file': return 0;
    default: return null;
  }
}

/**
 * buildPttElement — voice message envelope (elementType 4).
 * 见 .tmp/napcat-src/packages/napcat-core/types/element.ts:310-336 (PttElement)
 * 见 .tmp/napcat-src/packages/napcat-core/types/element.ts:372-375 (send whitelist)
 * 见 .tmp/napcat-src/packages/napcat-onebot/api/file.ts:202-226 (send-side values)
 *
 * `filePath` is the path the native upload step already produced (the SDK media
 * path), NOT an arbitrary local source path — validateLocalMedia() is the check
 * for a local source file.
 *
 * `fileUuid` is accepted for symmetry with the other builders but is NOT emitted:
 * the PTT send whitelist does not contain it (element.ts:373-374), so a value
 * passed here would at best be ignored by the client.
 */
export function buildPttElement({ filePath, fileUuid, fileName, size, md5, durationSec, waveAmplitudes } = {}) {
  const target = requirePath(filePath, 'ptt filePath');
  const name = fileName === undefined ? requireFileName(derivedName(target), 'ptt fileName') : requireFileName(fileName, 'ptt fileName');
  const fileSize = decimalSize(size, 'ptt size');
  const md5HexStr = digestOf(md5, 'ptt md5', MD5);
  // Default 1 second: the send path falls back to 1 when the probe has no duration.
  const duration = secondsOf(durationSec, 'ptt durationSec', 1);   // 见 .../api/file.ts:210
  const amplitudes = waveAmplitudes === undefined ? [] : waveAmplitudes;
  if (!Array.isArray(amplitudes) || amplitudes.length > 1024 ||
      amplitudes.some(value => !Number.isSafeInteger(value) || value < 0 || value > 255))
    fail('INVALID_ARGUMENT', 'ptt waveAmplitudes must be at most 1024 bytes 0..255');
  void fileUuid; // deliberately not emitted — see the doc comment above
  const pttElement = {
    fileName: name,
    filePath: target,
    fileSize,
    duration,
    formatType: 1,            // 见 .../api/file.ts:211
    voiceType: 1,             // 见 .../api/file.ts:212
    voiceChangeType: 0,       // 见 .../api/file.ts:213
    canConvert2Text: true,    // 见 .../api/file.ts:214
    fileSubId: '',            // 见 .../api/file.ts:218
    playState: 1,             // 见 .../api/file.ts:219
    autoConvertText: 0,       // 见 .../api/file.ts:220
    storeID: 0,               // 见 .../api/file.ts:221
    otherBusinessInfo: { aiVoiceType: 0 },   // 见 .../api/file.ts:222-224
    // 待真机确认: NapCat sends a fixed 15-entry amplitude array here; an empty list
    // (or a caller-supplied real waveform) is our own choice and is not yet proven
    // against a live client. Field name 见 .../types/element.ts:374.
    waveAmplitudes: amplitudes,
    ...(md5HexStr !== undefined ? { md5HexStr } : {}),   // 见 .../types/element.ts:373
  };
  return { elementType: ELEMENT_TYPES.ptt, elementId: '', pttElement };   // elementId '' 见 .../types/element.ts:16-20
}

/**
 * buildVideoElement — short-video message envelope (elementType 5).
 * 见 .tmp/napcat-src/packages/napcat-core/types/element.ts:112-137 (VideoElement)
 * 见 .tmp/napcat-src/packages/napcat-onebot/api/file.ts:172-187 (send-side values)
 */
export function buildVideoElement({ filePath, fileUuid, fileName, size, md5, thumbPath, thumbSize,
  durationSec, width, height, format } = {}) {
  const target = requirePath(filePath, 'video filePath');
  const name = fileName === undefined ? requireFileName(derivedName(target), 'video fileName') : requireFileName(fileName, 'video fileName');
  const fileSize = decimalSize(size, 'video size');
  const videoMd5 = digestOf(md5, 'video md5', MD5);          // 见 .../api/file.ts:178
  const thumb = thumbPath === undefined ? undefined : requirePath(thumbPath, 'video thumbPath');
  const thumbBytes = thumbSize === undefined ? undefined : Number(decimalSize(thumbSize, 'video thumbSize'));
  const id = uuidOf(fileUuid);                               // 见 .../types/element.ts:131
  // 0 when unknown: the packet converter clamps a missing time to 0.
  const fileTime = secondsOf(durationSec, 'video durationSec', 0);   // 见 .../packet/message/element.ts:485
  // fileFormat is the numeric NTVideoType; a raw number is accepted as-is because
  // the receive side already exposes it as a number.
  const videoFormat = format === undefined ? VIDEO_FORMATS.mp4
    : typeof format === 'number'
      ? (Number.isSafeInteger(format) && format >= 0 && format <= 255 ? format : undefined)
      : VIDEO_FORMATS[String(format).toLowerCase()];
  if (videoFormat === undefined)
    fail('INVALID_ARGUMENT', `video format must be one of ${Object.keys(VIDEO_FORMATS).join(', ')}`);
  const fileWidth = pixelsOf(width, 'video width');          // 见 .../api/file.ts:166
  const fileHeight = pixelsOf(height, 'video height');       // 见 .../api/file.ts:167
  const videoElement = {
    fileName: name,                                          // 见 .../api/file.ts:176
    filePath: target,                                        // 见 .../api/file.ts:177
    fileSize,                                                // 见 .../api/file.ts:185
    fileTime,                                                // 见 .../api/file.ts:164
    fileFormat: videoFormat,                                 // 见 .../api/file.ts:165
    ...(videoMd5 !== undefined ? { videoMd5 } : {}),
    ...(id !== undefined ? { fileUuid: id } : {}),
    ...(fileWidth !== undefined ? { fileWidth, thumbWidth: fileWidth } : {}),   // 见 .../api/file.ts:183
    ...(fileHeight !== undefined ? { fileHeight, thumbHeight: fileHeight } : {}), // 见 .../api/file.ts:184
    // thumbPath is a Map<frameIndex, path> in the element contract.
    // 见 .tmp/napcat-src/packages/napcat-core/types/element.ts:127 and .../api/file.ts:181
    // 待真机确认: NapCat always supplies a thumbnail (falling back to a built-in
    // placeholder image, 见 .../api/file.ts:142-149). Omitting these two keys when no
    // thumbnail exists has NOT been verified against a live client.
    ...(thumb !== undefined ? { thumbPath: new Map([[0, thumb]]) } : {}),
    ...(thumb === undefined || thumbBytes === undefined ? {} : { thumbSize: thumbBytes }),
  };
  return { elementType: ELEMENT_TYPES.video, elementId: '', videoElement };
}

/**
 * buildFileElement — file message envelope (elementType 3), shared by a group file
 * upload and a private-chat file send. The only documented differences are carried
 * by parameters:
 *   · groupFile:true   → a parent folder id is legal (folderId), 见
 *     .tmp/napcat-src/packages/napcat-onebot/action/go-cqhttp/UploadGroupFile.ts:54
 *   · groupFile:false  → folderId must stay empty; the private path passes ''
 *     explicitly, 见 .../go-cqhttp/UploadPrivateFile.ts:64 and
 *     .tmp/napcat-src/packages/napcat-onebot/api/msg.ts:774-777
 *
 * 见 .tmp/napcat-src/packages/napcat-core/types/element.ts:210-226 (FileElement)
 * 见 .tmp/napcat-src/packages/napcat-onebot/api/file.ts:50-59 (send-side values)
 */
export function buildFileElement({ filePath, fileName, size, fileUuid, md5, sha1, folderId, groupFile = false } = {}) {
  const target = requirePath(filePath, 'file filePath');
  const name = fileName === undefined ? requireFileName(derivedName(target), 'file fileName') : requireFileName(fileName, 'file fileName');
  const fileSize = decimalSize(size, 'file size');
  const id = uuidOf(fileUuid);                       // 见 src/bridge/native-bridge.mjs:137-139,368
  const fileMd5 = digestOf(md5, 'file md5', MD5);    // 见 .../types/element.ts:211
  // element field `fileSha` carries the SHA1 of the file.
  // 见 .../types/element.ts:220 and .../packet/message/element.ts:655 (fileSha: fileSha1)
  const fileSha = digestOf(sha1, 'file sha1', SHA1);
  const folder = folderId === undefined ? '' : folderId;   // default '' 见 .../api/file.ts:38,55
  if (typeof folder !== 'string' || folder.length > 256 || (folder !== '' && !FOLDER_ID.test(folder)))
    fail('INVALID_FOLDER', 'folderId must be empty or one bounded group folder id');
  if (!groupFile && folder !== '')
    fail('INVALID_FOLDER', 'folderId is only meaningful for a group file send (pass groupFile: true)');
  const fileElement = {
    fileName: name,
    filePath: target,
    fileSize,
    folderId: folder,
    ...(id !== undefined ? { fileUuid: id } : {}),
    ...(fileMd5 !== undefined ? { fileMd5 } : {}),
    ...(fileSha !== undefined ? { fileSha } : {}),
  };
  return { elementType: ELEMENT_TYPES.file, elementId: '', fileElement };
}

/**
 * buildImageElement — picture / sticker envelope (elementType 2).
 * The field layout is deliberately identical to the image builder native-bridge
 * already injects (imagePlacement.buildImageElement), so both paths produce the
 * same shape: 与 native-bridge 现有实现保持一致，字段布局见
 * src/media/native-image-placement.mjs:103-108（picType 映射见同文件:28-29）。
 *
 * Pure: the caller has already staged and placed the bytes and computed the md5;
 * this function only assembles the element.
 */
export function buildImageElement({ sourcePath, filePath, fileName, size, md5, width, height,
  picType, format, kind, subType, summary } = {}) {
  const source = requirePath(sourcePath ?? filePath, 'image sourcePath');
  const name = fileName === undefined ? requireFileName(derivedName(source), 'image fileName') : requireFileName(fileName, 'image fileName');
  const fileSize = decimalSize(size, 'image size');       // 见 .../native-image-placement.mjs:104
  const md5HexStr = digestOf(md5, 'image md5', MD5);
  if (md5HexStr === undefined) fail('INVALID_DIGEST', 'image md5 is required to build a picElement');
  let picSubType;
  if (subType === undefined) {
    // Only the two picture kinds are meaningful here; elementSubTypeFor() would
    // otherwise let 'video'/'ptt'/'file' through as 0.
    if (kind === undefined || kind === 'image') picSubType = PIC_SUB_TYPES.normal;
    else if (kind === 'sticker') picSubType = PIC_SUB_TYPES.sticker;
    else fail('UNKNOWN_KIND', `${String(kind)} is not a picture kind`);
  } else {
    if (!Number.isSafeInteger(subType) || subType < 0 || subType > 255)
      fail('INVALID_ARGUMENT', 'image subType must be an integer between 0 and 255');
    picSubType = subType;                                  // 0..255 clamp 见 .../native-image-placement.mjs:82
  }
  let type = picType;
  if (type === undefined) type = format === undefined ? PIC_TYPES.jpeg : PIC_TYPES[String(format).toLowerCase()] ?? PIC_TYPES.jpeg;
  if (!Number.isSafeInteger(type) || type < 0) fail('INVALID_ARGUMENT', 'image picType must be a non-negative integer');
  const summaryText = boundedText(summary, 'image summary', 256) ?? '';   // 见 .../native-image-placement.mjs:83
  const picWidth = pixelsOf(width, 'image width') ?? 0;    // unknown → 0 见 .../native-image-placement.mjs:101
  const picHeight = pixelsOf(height, 'image height') ?? 0; // 见 .../native-image-placement.mjs:102
  const picElement = {
    md5HexStr,
    fileSize,
    fileName: name,
    sourcePath: source,
    picWidth,
    picHeight,
    original: true,
    picType: type,
    picSubType,
    fileUuid: '',
    fileSubId: '',
    summary: summaryText,
    thumbFileSize: 0,
  };
  return { elementType: ELEMENT_TYPES.image, elementId: '', picElement };
}

/**
 * validateLocalMedia — pre-flight check for a LOCAL source file before it is
 * staged/placed. The only function in this module that touches the filesystem.
 *
 * Returns { ok: true, size } or { ok: false, reason } where reason is one of:
 *   invalid-path | invalid-kind | invalid-limit | limit-required | not-found |
 *   symlink | not-a-file | empty | too-large | unreadable
 *
 * `kind: 'image'` defaults to the existing 12 MiB cap. ptt / video / file have NO
 * verified cap, so the caller must pass maxBytes explicitly; without it the check
 * fails closed ("limit-required") instead of inventing a number.
 */
export function validateLocalMedia(filePath, { kind = 'image', maxBytes } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > MAX_PATH || /[\x00-\x1f\x7f]/.test(filePath))
    return { ok: false, reason: 'invalid-path' };
  if (!['image', 'sticker', 'ptt', 'video', 'file'].includes(kind)) return { ok: false, reason: 'invalid-kind' };
  let limit = maxBytes;
  if (limit === undefined) {
    if (kind === 'image' || kind === 'sticker') limit = IMAGE_MAX_BYTES;   // 见 src/bridge/native-bridge.mjs:190-193
    else return { ok: false, reason: 'limit-required' };
  }
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MEDIA_LIMIT_CEILING)
    return { ok: false, reason: 'invalid-limit' };
  let stat;
  try { stat = fs.lstatSync(filePath, { throwIfNoEntry: false }); } catch { return { ok: false, reason: 'unreadable' }; }
  if (stat === undefined) return { ok: false, reason: 'not-found' };
  // A link is never a media source: the same stance the image store takes.
  // 见 src/media/image-store.mjs:107-111
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  // A zero-byte file is rejected by the send path itself.
  // 见 .tmp/napcat-src/packages/napcat-onebot/api/file.ts:44-46
  if (stat.size === 0) return { ok: false, reason: 'empty' };
  if (stat.size > limit) return { ok: false, reason: 'too-large' };
  try { fs.accessSync(filePath, fs.constants.R_OK); } catch { return { ok: false, reason: 'unreadable' }; }
  return { ok: true, size: stat.size };
}
