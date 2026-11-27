import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeMessage, toCQ } from '../segments.mjs';
import { isGroupFileId, isGroupFolderId, normalizeHistoryParams, validateParams } from '../actions.mjs';
import { BridgeError } from './error.mjs';
import { RkeyProvider, relativeDownloadParts, rkeyForAppid, rkeyImageUrl, rkeyDiagnostics } from './rkey.mjs';
import { WebCgiClient } from './web-cgi.mjs';
import { BOT_UIN, OWNER_UIN } from '../config/account.mjs';
// P1：语音/视频/文件的元素构建（纯函数模块，字段依据见该文件注释）
import { buildPttElement, buildVideoElement, buildFileElement, validateLocalMedia } from '../media/element-builders.mjs';
export { BridgeError };

// External interface observations, not copied implementation:
// https://github.com/NapukettoDev/NapukettoQQ/tree/f20ed97c136e055cbe13c77545b976bfbd14e6d3/packages/kernel/src/types
// services/{msg,group,buddy,profile}-service.ts, entities.ts, listeners/{msg,group}.ts.
// These signatures are a version-specific community contract; synthetic tests do NOT
// establish compatibility with an installed QQ runtime. No binary is loaded here.
const BOT = BOT_UIN;
const MAIN = OWNER_UIN;
const MAX_ID = 2147483647;
// 消息 id 的跨重启种子：用开机秒数取模，保证每次启动都落在历史 id 之上一大截。
const MESSAGE_ID_SEED = (() => {
  // 测试可以固定成 1（test/preload.mjs 里设 WHALE_MESSAGE_ID_SEED=1），生产不设则用开机秒数。
  const forced = Number(process.env.WHALE_MESSAGE_ID_SEED);
  if (Number.isSafeInteger(forced) && forced > 0 && forced <= 1_000_000_000) return forced;
  const seed = Math.floor(Date.now() / 1000) % 1_000_000_000;
  return seed > 100000 ? seed : 100000;
})();
// 对外报的版本号（OneBot get_version_info 用）。改版本只改这里。
const VERSION = '1.0.0';
// 语音/视频/文件发送上限（字节）。超限在提交前拒绝，不做截断。
const MEDIA_SEND_LIMITS = Object.freeze({ ptt: 30 * 1024 * 1024, video: 100 * 1024 * 1024, file: 200 * 1024 * 1024 });
const isOneBotMessageId = value => ['string', 'number'].includes(typeof value) &&
  /^[1-9]\d{0,9}$/.test(String(value)) && Number(value) <= MAX_ID;
const MAX_FACE_INDEX = 100000;
// ★ 发送回执的等待窗口单独放宽（默认 10s 对"发出去了但回执慢"是不够的）。
//   实测（2026-11-17 16:45）：一条 send_group_msg 从提交到出现在群历史里约 30 秒，
//   而回执等待只有 10 秒 ⇒ 判成"结果未知" ⇒ 写闸锁死 ⇒ 表现为"所有群都不回话"。
//   注意：放宽只是减少误判，真正兜底是超时后的**只读对账**（见 reconcileSentMessage）。
//   ★ 曾经这里是 45 秒（`SEND_RECEIPT_TIMEOUT_MS`，现已删除）。45 秒等不到回执是常态，
//   而等待越久只会让请求槽位被占着。
//   ★ 2026-11-19 21:0x：运行端那个 15 秒常量**我们已经在 preload 里改长了**（默认 120 秒，
//   面板项 `onebot.textTimeoutMs` 控），所以现在的链条是
//   **回执窗口(5s) < 核心 timeoutMs(10s) < 运行端动作超时(默认 120s)**。
//   改长的原因有据：outbox 里出现过 `unknown` + `The operation was aborted due to timeout`，
//   即我们的响应被限流队列拖过 15 秒，运行端先放弃 → 记未知 → 该会话 held。
/**
 * 消息发送 / 戳一戳这类**side effect** 允许阻塞多久等回执。
 *
 * ★ 现在这个窗口只影响「能不能拿到真实 message_id」，**成败已不由它决定**（P4：拿不到回执就回
 *   「成功 + message_id:null」）。它必须明显小于核心的 10 秒，否则核心先超时。
 *   2026-11-19 15:2x 实测踩到的就是这个顺序：窗口曾设 12000，而核心 timeoutMs 是 10000 ⇒ 核心先
 *   在 10s 放弃并回 1504（HTTP 504）→ 运行端记 `outbox.state='unknown'` → 批次 held → 该群不再回话。
 *   2026-11-19 实测：多个群与私聊共 24 条 held，全部挂着 `OneBot send_group_msg HTTP 504`
 *   或 `friend_poke HTTP 504`（我们回 1504 → 504）。QQ 侧回执实测约 29s 才落，
 *   等不到是常态 ⇒ 到点按「原生已接受」回成功（见 sendElements 的兜底）。
 */
const SEND_ACCEPT_WAIT_MS = 5000;

/**
 * 元素级诊断开关（默认关）。
 *
 * <p>开着时每条群消息会打印元素形状（`1(atType=2,atUid=…,atNtUid=u_…)`），
 * 没认出来的 at 还会带 24 字符正文前缀 —— 排查「@ 没反应 / 引用丢了 / 未知元素」很有用，
 * 但会把会话标识与正文片段写进日志，所以**不挂在默认路径上**。
 * <p>要用：启动前设 `WHALE_DEBUG_ELEMENTS=1`。这样排查不必改代码、也不必为它发版。
 */
const ELEMENT_DEBUG = process.env.WHALE_DEBUG_ELEMENTS === '1';

/**
 * 图片发送来源归一化（2026-11-19，修「群里发图/贴纸一律 HTTP 400」）。
 *
 * <p><b>为什么要它</b>：运行端把贴纸/生成图交给 OneBot 时，`image` 段里的 `file` 是它自己的
 * **远端 URL**（贴纸库 / 图像生成结果，host 不是 QQ CDN）。而我们的
 * `media/native-image-placement.mjs:buildImageElement` 只接受两种来源：
 * `base64://` 内联字节，或**白名单内的 https CDN**（gchat.qpic.cn 等）。
 * 第三方 host 一律 `UNSUPPORTED_SOURCE` → 我们回 1400 → HTTP 层映射成 **400**，
 * 运行端记一条 `OneBot send_group_msg HTTP 400`，图就永远发不出去
 * （incidents 里 25 条 `details.type=image|sticker` 就是它）。
 *
 * <p><b>做法</b>：在这里把来源统一成 `base64://`——
 * `data:` URI 剥壳、白名单 host 原样放过、其它 http(s) 由我们**自己**有界下载
 * （≤{@link IMAGE_INLINE_MAX_BYTES}、超时 {@link IMAGE_FETCH_TIMEOUT_MS}）、
 * 本地绝对路径直接读文件。这样既不改 placement 的 SSRF 白名单，也不放松任何界限。
 */
const IMAGE_INLINE_MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_CDN_HOSTS = ['gchat.qpic.cn', 'multimedia.nt.qq.com.cn', 'c2cpicdw.qpic.cn', 'gchatpic_new.qpic.cn'];

export async function normalizeImageSource(file, { signal, timeoutMs = IMAGE_FETCH_TIMEOUT_MS,
  maxBytes = IMAGE_INLINE_MAX_BYTES, fetchImpl } = {}) {
  if (typeof file !== 'string' || file.length === 0) return file;
  if (file.startsWith('base64://')) return file;

  const dataUri = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(file);
  if (dataUri) {
    if (!dataUri[2]) return file;                       // 非 base64 的 data URI 不猜
    return 'base64://' + dataUri[3].replace(/\s+/g, '');
  }

  if (/^https?:\/\//i.test(file)) {
    let host = '';
    try { host = new URL(file).hostname.toLowerCase(); } catch { return file; }
    if (IMAGE_CDN_HOSTS.includes(host)) return file;    // 交回 placement 的既有 CDN 下载
    const bytes = await fetchImageBytes(file, { signal, timeoutMs, maxBytes,
      fetchImpl: fetchImpl || globalThis.fetch });
    return 'base64://' + bytes.toString('base64');
  }

  if (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) {
    try {
      const stat = await statFile(file);
      if (!stat.isFile() || stat.size > maxBytes) return file;
      return 'base64://' + (await readFile(file)).toString('base64');
    } catch { return file; }
  }
  return file;
}

async function statFile(file) {
  const { stat } = await import('node:fs/promises');
  return stat(file);
}

/** 有界下载：先看 content-length，再按字节上限截断校验。任何异常都抛给调用方（→1400）。 */
async function fetchImageBytes(url, { signal, timeoutMs, maxBytes, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('Image source fetch unavailable');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res?.ok) throw new Error('Image source HTTP ' + (res?.status ?? '?'));
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Image source too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('Image source is empty');
    if (buf.length > maxBytes) throw new Error('Image source too large');
    return buf;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
const MAX_FRIEND_REQUESTS = 256;
// 群名补充（get_chat_names）的时间预算：单个群 3s，整批 ≤ 15s。超预算的群直接进 failed，
// 不去排队等 —— 白名单弹窗只是「锦上添花」，绝不能把面板拖住。
const CHAT_NAME_TIMEOUT_MS = 3000;
const CHAT_NAMES_BUDGET_MS = 15000;
// 群名长度上限（QQ 群名远小于此；超过说明回包不对，按失败处理而不是截断）。
const CHAT_NAME_MAX_LENGTH = 128;
const groupExtensionFields = ['essentialMsgPrivilege', 'essentialMsgSwitch', 'groupInfoExtSeq',
  'groupSquareSwitch', 'hasGroupCustomPortrait', 'inviteRobotMemberExamine', 'inviteRobotMemberSwitch', 'inviteRobotSwitch'];

const invalid = (text) => new BridgeError('INVALID_PARAMS', text, { retcode: 1400 });
const unsupported = () => new BridgeError('UNSUPPORTED', 'Native capability is not available', { retcode: 1404 });
function id(value, field = 'id') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid(`${field} must be an exact integer`);
  const str = String(value ?? '');
  if (!/^[1-9]\d{0,15}$/.test(str) || !Number.isSafeInteger(Number(str))) throw invalid(`${field} is invalid`);
  return str;
}
function user(value) {
  const str = id(value, 'user_id');
  if (str === MAIN) throw new BridgeError('PROTECTED_ACCOUNT', 'Protected account is not an operation target', { retcode: 1403 });
  return str;
}
function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  throw invalid('Expected a boolean');
}
function integer(value, min, max, fallback) {
  if (value === undefined) value = fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw invalid('Integer is outside the allowed range');
  return value;
}
function text(value, name, max = 4096) {
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be a bounded string`);
  return value;
}
function groupFileMetadata(entry, fields) {
  const metadata = {};
  for (const [publicName, nativeName, type] of fields) {
    const value = entry[nativeName];
    if (type === 'account' && typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) &&
        Number.isSafeInteger(Number(value))) metadata[publicName] = Number(value);
    if (type === 'number' && Number.isSafeInteger(value) && value >= 0) metadata[publicName] = value;
    if (type === 'name' && typeof value === 'string' && value.length <= 4096) metadata[publicName] = value;
  }
  return metadata;
}
const groupFileFields = [
  ['upload_time', 'uploadTime', 'number'],
  ['dead_time', 'deadTime', 'number'],
  ['modify_time', 'modifyTime', 'number'],
  ['download_times', 'downloadTimes', 'number'],
  ['uploader', 'uploaderUin', 'account'],
];
const groupFolderFields = [
  ['create_time', 'createTime', 'number'],
  ['modify_time', 'modifyTime', 'number'],
  ['creator', 'createUin', 'account'],
  ['modifier', 'modifyUin', 'account'],
  ['creator_name', 'creatorName', 'name'],
  ['modifier_name', 'modifyName', 'name'],
];
function checkResult(raw, sideEffect = false, key = 'result', step = '') {
  if (!raw || typeof raw[key] !== 'number') throw new BridgeError('UNCONFIRMED', 'Native result has no confirmation', { retcode: 1502, outcome: sideEffect ? 'unknown' : 'not_started' });
  if (raw[key] !== 0) {
    // ★ 诊断（2026-11-20 转发读取排障）：真机上 get_forward_msg 恒 1500 却查不出
    //   是哪一步、原生给了什么码 —— 原生拒绝时把错误载荷带出来写进 bot.log（只走拒绝分支，不影响热路径）。
    try {
      const detail = { };
      for (const k of ['errMsg', 'errmsg', 'errMsg2', 'err_msg', 'subCode', 'subcode', 'errCode', 'code']) {
        if (raw[k] !== undefined) detail[k] = String(raw[k]).slice(0, 200);
      }
      if (Array.isArray(raw.msgList)) {
        detail.msgListLen = String(raw.msgList.length);
        const first = raw.msgList[0];
        detail.firstKeys = first && typeof first === 'object' ? Object.keys(first).slice(0, 16).join('/') : String(first).slice(0, 60);
      }
      console.log('[native-rejected] step=' + (step || 'unknown') + ' result=' + raw[key]
        + ' detail=' + JSON.stringify(detail) + ' keys=' + Object.keys(raw).slice(0, 24).join(','));
    } catch { /* 诊断失败绝不影响报错本体 */ }
    throw new BridgeError('NATIVE_REJECTED', 'Native operation was rejected', { retcode: 1500, outcome: 'rejected' });
  }
  return raw;
}
function groupMention(element, selfUid) {
  if (element.atType === 1) return 'all';
  if (![2, 4].includes(element.atType)) return null;
  const raw = element.atUid;
  const unspecified = raw === undefined || raw === '' || raw === '0' || raw === 0;
  const explicit = (typeof raw === 'string' || typeof raw === 'number') &&
    /^[1-9]\d{0,15}$/.test(String(raw)) && Number.isSafeInteger(Number(raw)) ? String(raw) : null;
  const matchesSelf = selfUid !== undefined && element.atNtUid === selfUid;
  if (element.atType === 4 && !matchesSelf) return null;
  // ★ 2026-11-19：@ 的标识方式在不同群/不同 build 上不统一 —— 有的给 QQ 号（atUid=uin），
  //   有的只给 nt uid（atUid=u_xxx / atNtUid=u_xxx）。任一能对上「自己」就认，否则
  //   某些群的 @ 永远识别不出来（表现为「那几个群怎么 @ 都不回」）。
  const uidMatch = selfUid !== undefined && element.atUid !== undefined && String(element.atUid) === String(selfUid);
  // ntUid 指向自己时：uin 为空或是自己 ⇒ 认；uin 明确是别人 ⇒ 不认（防止把 @别人 当成 @自己）。
  if (matchesSelf) return unspecified || explicit === BOT ? BOT : null;
  // 只给 nt uid 的形态（atUid 直接就是 u_xxx）⇒ 认自己。
  if (uidMatch) return BOT;
  if (explicit === BOT && selfUid !== undefined && element.atNtUid && element.atNtUid !== selfUid) return null;
  return explicit;
}
function reactionSummary(entries) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.length > 256)
    throw invalid('Native reaction list is malformed');
  const seen = new Set();
  return entries.map(entry => {
    const emoji = entry?.emojiId;
    const type = entry?.emojiType;
    const count = entry?.likesCnt;
    if (typeof emoji !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(emoji) ||
        !['1', '2'].includes(type) || typeof count !== 'string' ||
        !/^(0|[1-9]\d{0,9})$/.test(count) || Number(count) > MAX_ID)
      throw invalid('Native reaction entry is malformed');
    const key = type + ':' + emoji;
    if (seen.has(key)) throw invalid('Native reaction list contains duplicate entries');
    seen.add(key);
    return { emoji_id: emoji, emoji_type: Number(type), count: Number(count), users: [], users_complete: Number(count) === 0 };
  });
}
function peerKey(peer) { return `${peer.chatType}:${peer.peerUid}`; }
function rawPeer(raw) { return { chatType: raw.chatType, peerUid: String(raw.peerUid), guildId: '' }; }
function peerEqual(a, b) { return a.chatType === b.chatType && a.peerUid === b.peerUid; }
const isNativeMessageId = value => typeof value === 'string' && /^[1-9]\d{0,127}$/.test(value);
const isReactionSequence = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const absentReplyId = value => value === undefined || value === '' || value === '0';
function fileSegment(file) {
  const name = file?.fileName;
  const size = file?.fileSize;
  const validName = typeof name === 'string' && name.length > 0 && name.length <= 4096 &&
    name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name);
  if (!validName || typeof size !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(size) ||
      BigInt(size) > 18446744073709551615n) return null;
  const data = { name, file: name, file_size: size };
  const uuid = file.fileUuid;
  if (typeof uuid === 'string' && uuid.length > 0 && uuid.length <= 1024 && !/[\x00-\x20\x7f]/.test(uuid))
    data.file_id = uuid;
  return { type: 'file', data };
}

function qqMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 ||
      !/^https:\/\/(?:gchat\.qpic\.cn|multimedia\.nt\.qq\.com\.cn)(?=\/)/i.test(value) ||
      /[\\\x00-\x20\x7f#]/.test(value)) return undefined;
  return value;
}

function qqImageOrigin(value) {
  const absolute = qqMediaUrl(value);
  if (absolute !== undefined) return absolute;
  if (typeof value !== 'string' || !value.startsWith('/download?') || /[\\\x00-\x20\x7f#]/.test(value)) return undefined;
  const address = 'https://multimedia.nt.qq.com.cn' + value;
  if (qqMediaUrl(address) === undefined) return undefined;
  const { searchParams } = new URL(address);
  const appIds = searchParams.getAll('appid');
  const fileIds = searchParams.getAll('fileid');
  const keys = searchParams.getAll('rkey');
  if (appIds.length !== 1 || !['1406', '1407'].includes(appIds[0]) || fileIds.length !== 1 || keys.length !== 1 ||
      !/^[A-Za-z0-9_+/=-]+$/.test(fileIds[0]) || !/^[A-Za-z0-9_+/=-]+$/.test(keys[0])) return undefined;
  return address;
}

function qqImageByMd5(value) {
  // NapCat fixed contract (napcat.mjs getImageUrlFromMd5): when a picture has
  // no usable picUrl/originImageUrl, the md5HexStr still builds a stable CDN
  // address gchat.qpic.cn/gchatpic_new/0/0-0-<MD5 uppercase>/0. No rkey needed.
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{32}$/.test(value)) return undefined;
  return `https://gchat.qpic.cn/gchatpic_new/0/0-0-${value.toUpperCase()}/0`;
}

// downloadRichMedia contract — corrected against NapCat's authoritative
// `downloadMedia` (napcat.mjs:9444-9474) on 2026-11-16. The earlier reading
// (downloadType=2 / elemId / poll-by-re-read) was WRONG and is why every prior
// inline attempt ended with `inlineNoPath`:
//   · the param key is `elementId`, not `elemId`;
//   · `peerUid` is REQUIRED (native must know which peer's cache to fetch into);
//   · `downloadType` must be 1 (original), not 2 (thumbnail);
//   · `fileModelId`/`downSourceType`/`downloadSourceType`/`triggerType`/`filePath`
//     are part of the NapCat shape;
//   · completion arrives via the `onRichMediaDownloadComplete` LISTENER (fields
//     msgElementId + msgId + filePath), NOT by re-reading the element — a re-read
//     never exposes filePath, which is exactly the `inlineNoPath=18/18` dead end.
const PICTURE_DOWNLOAD_TYPE = 1;
const PICTURE_DOWNLOAD_POLLS = 6;
const PICTURE_DOWNLOAD_INTERVAL_MS = 300;
// A thumbnail is what the reader needs; keep the inlined payload small enough
// that a multi-picture message stays inside the 8 MiB message budget.
// The App's own downloadImageAsDataUrl caps an image at 12 MiB; matching that here
// avoids rejecting ordinary photos/stickers (measured 2026-11-16: a 512 KiB cap made
// every real photo `inlineTooLarge` and fell back to a 404 md5 address).
const PICTURE_INLINE_MAX_BYTES = 12 * 1024 * 1024;
const PICTURE_INLINE_SUPPORTED = true;
// A multi-picture message stays under the 8 MiB OneBot message budget where possible;
// a single image may still reach 12 MiB, so allow one full image plus headroom.
const PICTURE_INLINE_TOTAL_BYTES = 16 * 1024 * 1024;
// get_record：语音落地。
// 回溯窗口按索引条数算（索引默认上限 10000 条，扫全表会拖住事件循环）。
const RECORD_FILE_SCAN_LIMIT = 400;
// pskey 内存缓存的滑动 TTL（NapCat 用 60 秒；核验失败时下一次调用会重新取）。
const PSKEY_TTL_MS = 60 * 1000;
const PSKEY_TIMEOUT_MS = 8000;
// 可选会话服务探测白名单（只调 getter，不调方法）。名字写死而不是动态猜：
// 猜出来的 getter 名一旦拼错会被 getter 的副作用掩盖，读出来的"不存在"就是假的。
const SESSION_SERVICE_PROBES = Object.freeze([
  'getTipOffService', 'getTicketService', 'getSearchService', 'getAppService',
  'getUserService', 'getFileService', 'getAvatarService', 'getEmojiService',
  'getRobotService', 'getRecentContactService', 'getProfileLikeService', 'getUixConvertService',
  'getRichMediaService', 'getMsgService', 'getGroupService', 'getBuddyService', 'getProfileService',
]);
const RECORD_DOWNLOAD_POLL_MS = 200;
// 一条消息最多落几个视频（多视频消息极罕见，给 4 个足够，也避免一次拖太久）。
const VIDEO_PAGE_LIMIT = 4;

// Bounded, non-sensitive counters for picture-address resolution. They answer
// "why can't the App see an image" without recording any rkey, message id or
// account identifier: only presence booleans and hostnames are counted.
const mediaDiagnostics = { withPicUrl: 0, withOrigin: 0, originRelative: 0, originWithFileid: 0,
  originHostMultimedia: 0, originHostGchat: 0, usedMd5Fallback: 0, usedInlineData: 0, inlineAttempts: 0,
  inlineSucceeded: 0, inlineFailed: 0, inlineNoMethod: 0, inlineTransferError: 0, inlineNoPath: 0,
  inlineReadError: 0, inlineTooLarge: 0, noAddress: 0,
  // rkey resolution: how often a received picture got a real rkey download URL vs
  // fell back to md5, and why. Names/counts only, never the rkey or fileid values.
  usedRkeyUrl: 0, rkeyAttempts: 0, rkeyResolved: 0, rkeyFailed: 0, rkeyNoMethod: 0,
  // Which field names a downloaded picture element actually exposes. Recorded once
  // (names only, never values) so the "no filePath after download" dead end can be
  // resolved without guessing again.
  inlineElementKeys: null,
  // Why the LAST image/sticker build failed. The App records a send failure as a
  // bare "HTTP 400" and keeps no wording, so without this the only clue is gone.
  // Holds the error name, its code and a bounded message (paths only, no secrets).
  lastPrepareFailure: null };
export function readMediaDiagnostics() {
  // rkeyDiagnostics carries the real shape of sendSsoCmdReqByContend's return
  // (kind, own key names, byte length, header bytes only) so a failed rkey call
  // is diagnosable from status.json without another guessing round.
  return { ...mediaDiagnostics, rkey: { ...rkeyDiagnostics } };
}
function hostOf(value) {
  if (typeof value !== 'string') return '';
  try { return new URL(value.startsWith('http') ? value : 'https://gchat.qpic.cn' + value).hostname; } catch { return ''; }
}

/**
 * 把一个形状未知的内核对象裁成「只含标量」的有界对象。
 * 用途：本机没实测过形状的字段（例如 SimpleInfo.intimate）不该原样透出 ——
 * 里面可能有 Map、深层嵌套或 getter。只保留数字/布尔/短字符串，最多 24 个键。
 * 一个标量都取不到就返回 undefined（宁可不给，也不给一个空壳）。
 */
function boundedPrimitives(value) {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  let keys = 0;
  for (const key of Object.keys(value)) {
    if (++keys > 24) break;
    if (typeof key !== 'string' || key.length > 64 || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    let entry;
    try { entry = value[key]; } catch { continue; }
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
    else if (typeof entry === 'boolean') out[key] = entry;
    else if (typeof entry === 'string' && entry.length <= 256) out[key] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

function mediaSegment(element) {
  const type = element.elementType;
  const source = type === 2 ? element.picElement : type === 4 ? element.pttElement : element.videoElement;
  const file = source?.fileName ?? (type === 2 ? source?.md5HexStr : undefined);
  if (typeof file !== 'string' || file.length === 0 || file.length > 4096 ||
      file === '.' || file === '..' || /[\\/:\x00-\x1f\x7f]/.test(file)) return null;
  const data = { file };
  let url;
  if (type === 2) {
    const viaPic = qqMediaUrl(source.picUrl);
    const viaOrigin = qqImageOrigin(source.originImageUrl);
    // A received picture usually carries originImageUrl as a bare "/download?…"
    // with no rkey. When an rkey has already been resolved for this element, the
    // full multimedia download URL wins over the md5 fallback.
    const viaRkey = element.__rkeyUrl;
    const viaMd5 = qqImageByMd5(source.md5HexStr);
    // inlineUrl is set by inlinePictureData() after the native transfer actually
    // delivered the bytes; it needs no network and cannot expire, so it wins.
    const inline = typeof element.inlineUrl === 'string' && element.inlineUrl.startsWith('base64://') ? element.inlineUrl : undefined;
    url = inline ?? viaRkey ?? viaPic ?? viaOrigin ?? viaMd5;
    // Diagnostics: record what the native element actually carried.
    if (typeof source.picUrl === 'string' && source.picUrl) mediaDiagnostics.withPicUrl++;
    if (typeof source.originImageUrl === 'string' && source.originImageUrl) {
      mediaDiagnostics.withOrigin++;
      if (source.originImageUrl.startsWith('/')) mediaDiagnostics.originRelative++;
      if (source.originImageUrl.includes('fileid=')) mediaDiagnostics.originWithFileid++;
      const host = hostOf(source.originImageUrl);
      if (host === 'multimedia.nt.qq.com.cn') mediaDiagnostics.originHostMultimedia++;
      else if (host === 'gchat.qpic.cn') mediaDiagnostics.originHostGchat++;
    }
    if (inline !== undefined) mediaDiagnostics.usedInlineData++;
    else if (viaRkey !== undefined) mediaDiagnostics.usedRkeyUrl++;
    else if (viaPic === undefined && viaOrigin === undefined && viaMd5 !== undefined) mediaDiagnostics.usedMd5Fallback++;
    if (url === undefined) mediaDiagnostics.noAddress++;
  } else if (type === 5) {
    url = qqMediaUrl(source.videoUrl);
  }
  if (url !== undefined) data.url = url;
  if (type === 2 && typeof source.summary === 'string' && source.summary.length <= 256)
    data.summary = source.summary;
  return { type: type === 2 ? 'image' : type === 4 ? 'record' : 'video', data };
}

const forwardInvalid = () => new BridgeError('INVALID_NATIVE_RESPONSE', 'Native message response is malformed or exceeds bounds', { retcode: 1502 });
// Inspect the entire native response before translating it. No JSON.stringify of
// an unbounded graph, no getters, cycles, arbitrary prototypes or coercion.
function boundForwardResponse(value) {
  const active = new Set();
  let items = 0, bytes = 0;
  const charge = amount => { bytes += amount; if (bytes > 1024 * 1024) throw forwardInvalid(); };
  function visit(value, depth) {
    if (++items > 10000 || depth > 12) throw forwardInvalid();
    charge(8);
    if (typeof value === 'string') { if (value.length > 65536) throw forwardInvalid(); charge(Buffer.byteLength(value, 'utf8')); return; }
    if (value == null || typeof value === 'boolean' || value === undefined) return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw forwardInvalid(); return; }
    if (typeof value !== 'object' || active.has(value)) throw forwardInvalid();
    active.add(value);
    if (value instanceof Map) {
      if (Object.getPrototypeOf(value) !== Map.prototype) throw forwardInvalid();
      const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value);
      if (size > 4096) throw forwardInvalid();
      for (const [key, member] of Map.prototype.entries.call(value)) { visit(key, depth + 1); visit(member, depth + 1); }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || value.length > 4096) throw forwardInvalid();
        for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, String(i))) throw forwardInvalid();
      } else if (prototype !== null && prototype !== Object.prototype) throw forwardInvalid();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 4097) throw forwardInvalid();
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 256) throw forwardInvalid();
      if (Array.isArray(value) && key === 'length') continue;
      charge(Buffer.byteLength(key, 'utf8'));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw forwardInvalid();
      visit(descriptor.value, depth + 1);
    }
    active.delete(value);
  }
  visit(value, 0);
}

// A single-message result may carry native metadata unrelated to OneBot.
// Select the envelope fields without evaluating getters or cloning extras.
function readOwnMessageField(object, key) {
  if (!object || typeof object !== 'object') throw forwardInvalid();
  const field = Object.getOwnPropertyDescriptor(object, key);
  if (!field) return undefined;
  if (!Object.hasOwn(field, 'value')) throw forwardInvalid();
  return field.value;
}

function bindSelfSender(message, identity) {
  const senderUin = readOwnMessageField(message, 'senderUin');
  const senderUid = readOwnMessageField(message, 'senderUid');
  if ((senderUin === BOT || senderUin === Number(BOT)) &&
      (!identity?.uid || !senderUid || senderUid === identity.uid)) return message;
  if (identity?.uid && senderUid === identity.uid && [undefined, null, ''].includes(senderUin)) {
    const fields = Object.getOwnPropertyDescriptors(message);
    fields.senderUin = { value: BOT, enumerable: true };
    return Object.create(null, fields);
  }
  return null;
}

function projectTextReadback(element) {
  const elementType = readOwnMessageField(element, 'elementType');
  if (elementType !== 1) return element;
  const textElement = readOwnMessageField(element, 'textElement');
  if (textElement == null) return { elementType, textElement };
  const result = {};
  for (const field of ['content', 'atType', 'atUid', 'atNtUid']) {
    const value = readOwnMessageField(textElement, field);
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw forwardInvalid();
    result[field] = value;
  }
  return { elementType, textElement: result };
}

function findMessageReadback(response, peer, msgId) {
  checkResult({ result: readOwnMessageField(response, 'result') });
  const list = readOwnMessageField(response, 'msgList');
  if (!Array.isArray(list) || list.length > 4096) throw forwardInvalid();
  let match;
  for (let index = 0; index < list.length; index++) {
    const entry = readOwnMessageField(list, String(index));
    if (readOwnMessageField(entry, 'msgId') !== msgId || readOwnMessageField(entry, 'chatType') !== peer.chatType ||
        readOwnMessageField(entry, 'peerUid') !== peer.peerUid) continue;
    if (match) throw forwardInvalid();
    match = entry;
  }
  return match ?? null;
}

const mediaReadbackFields = {
  2: ['picElement', ['fileName', 'md5HexStr', 'picUrl', 'originImageUrl', 'summary', 'sourcePath']],
  3: ['fileElement', ['fileName', 'fileSize', 'fileUuid']],
  4: ['pttElement', ['fileName']],
  // 视频（elementType 5）：投影文件名与已落盘本地路径（不采信过期 url）。
  5: ['videoElement', ['fileName', 'filePath']],
};

function projectMediaReadback(message, requestedType) {
  const elements = readOwnMessageField(message, 'elements');
  if (!Array.isArray(elements) || elements.length > 1000) throw forwardInvalid();
  const projected = [];
  for (let index = 0; index < elements.length; index++) {
    const element = readOwnMessageField(elements, String(index));
    const elementType = readOwnMessageField(element, 'elementType');
    if (elementType !== requestedType) continue;
    const [name, fields] = mediaReadbackFields[elementType];
    const source = readOwnMessageField(element, name);
    if (source == null) continue;
    const values = {};
    for (const key of fields) {
      const value = readOwnMessageField(source, key);
      if (typeof value === 'string' && value.length <= 8192) values[key] = value;
    }
    const elementId = readOwnMessageField(element, 'elementId');
    if (elementId !== undefined && elementId !== null && !Number.isSafeInteger(elementId) &&
        (typeof elementId !== 'string' || elementId.length > 4096)) throw forwardInvalid();
    projected.push({ elementType, elementId, [name]: values });
  }
  boundForwardResponse(projected);
  return projected;
}

export function selectMessageReadback(response, peer, msgId) {
  const match = findMessageReadback(response, peer, msgId);
  if (!match) return null;
  const fields = ['msgId', 'chatType', 'peerUid', 'senderUin', 'senderUid', 'msgTime', 'msgSeq', 'clientSeq',
    'sendNickName', 'sendMemberName', 'elements', 'records'];
  const selected = Object.fromEntries(fields.map(key => [key, readOwnMessageField(match, key)])
    .filter(([, value]) => value !== undefined));
  if (!Array.isArray(selected.elements) || selected.elements.length > 1000) throw forwardInvalid();
  selected.elements = Array.from({ length: selected.elements.length }, (_, index) =>
    projectTextReadback(readOwnMessageField(selected.elements, String(index))));
  boundForwardResponse(selected);
  return selected;
}

/** Collision-free process-local IDs. Eviction never aliases an old ID to a new message. */
export class MessageIndex {
  constructor(limit = 10000) {
    this.limit = integer(limit, 1, 100000, 10000);
    // ★ 2026-11-19：message_id 不再从 1 开始。
    //   运行端按 (会话, message_id) 去重；我们每次重启都把计数器归 1 ⇒ 重启后这个会话的
    //   前 N 条消息全部撞上历史 id，被运行端当重复丢掉 ⇒ 「某些群重启后再也不回话」。
    //   改成用「开机秒数」做种子（≤ 1e9，仍在 OneBot 的 message_id 范围内），跨重启不会撞。
    this.next = MESSAGE_ID_SEED;
    this.byId = new Map();
    this.byNative = new Map();
  }
  put(raw, refreshOrder = false) {
    if (!isNativeMessageId(raw.msgId)) throw invalid('Native message id is invalid');
    const key = `${peerKey(rawPeer(raw))}:${raw.msgId}`;
    let entry = this.byNative.get(key);
    if (entry) {
      entry = { ...entry, raw: structuredClone(raw) };
      if (refreshOrder) { this.byId.delete(entry.id); this.byNative.delete(key); }
      this.byId.set(entry.id, entry); this.byNative.set(key, entry); return entry.id;
    }
    if (this.next > MAX_ID) throw new BridgeError('ID_EXHAUSTED', 'Message ID space exhausted', { retcode: 1503 });
    entry = { id: this.next++, key, raw: structuredClone(raw) };
    this.byId.set(entry.id, entry);
    this.byNative.set(key, entry);
    while (this.byId.size > this.limit) {
      const first = this.byId.values().next().value;
      this.byId.delete(first.id);
      this.byNative.delete(first.key);
    }
    return entry.id;
  }
  get(value) {
    const entry = this.byId.get(Number(id(value, 'message_id')));
    if (!entry) throw new BridgeError('MESSAGE_NOT_FOUND', 'Message ID expired or belongs to another session', { retcode: 1404 });
    return structuredClone(entry.raw);
  }
  find(peer, nativeId) { return this.byNative.get(`${peerKey(peer)}:${nativeId}`)?.id; }
  clear() { this.byId.clear(); this.byNative.clear(); }
}

/**
 * Adapter for a caller-owned, already-initialized native session. identityProbe must
 * read actual runtime identity and online status; returning configured UIN is invalid.
 * Explicit native-session mode instead accepts a trusted host's accepted native
 * authentication binding and current session authorization. This is permission to
 * call the SDK, NOT platform-online proof. The host must revoke that binding on
 * actual invalidation; retained authentication UID is not a fresh UID getter.
 * This module has no login, filesystem, network, process launch, or retry facility.
 */
export class NativeBridge extends EventEmitter {
  #acceptProtectedChallenge;
  #authorizationPolicy;
  #conversationPolicy;
  #reattachIdentity;
  // qun.qq.com 域的 pskey 内存缓存（只在群公告写/删里用；不落盘、不打日志）。
  #pskey;
  #maxSendCorrelations;
  #voiceTranscriptions = new Map();
  #pendingNativeTranscriptions = new Map();

  constructor({ session, identityProbe, timeoutMs = 10000, maxMessages = 10000,
    maxSendCorrelations = 100000, acceptProtectedChallenge, authorizationPolicy = 'online-proof', conversationPolicy = 'protected',
    imagePlacement, noticeExtras = false } = {}) {
    super();
    if (!['online-proof', 'native-session'].includes(authorizationPolicy)) throw invalid('Invalid authorization policy');
    // 高频、低信息的扩展 notice（正在输入 / 对方在线状态）。默认关：
    // 实测开着时 3 分钟就刷了 97 条，把真正的 notice 淹没（2026-11-17 真机观测）。
    this.noticeExtras = noticeExtras === true;
    this.#authorizationPolicy = authorizationPolicy;
    if (!['protected', 'original'].includes(conversationPolicy) ||
        (conversationPolicy === 'original' && authorizationPolicy !== 'native-session')) throw invalid('Invalid conversation policy');
    this.#conversationPolicy = conversationPolicy;
    if (!session || typeof identityProbe !== 'function') throw invalid('session and identityProbe are required');
    if (authorizationPolicy === 'native-session' && typeof session.getSessionId !== 'function')
      throw invalid('Native session getter is required');
    if (imagePlacement !== undefined &&
        (!imagePlacement || typeof imagePlacement.buildImageElement !== 'function'))
      throw invalid('imagePlacement must expose buildImageElement');
    this.imagePlacement = imagePlacement;
    this.session = session;
    this.identityProbe = identityProbe;
    this.#acceptProtectedChallenge = acceptProtectedChallenge;
    this.timeoutMs = integer(timeoutMs, 1, 120000, 10000);
    this.rkey = new RkeyProvider({ timeoutMs: this.timeoutMs });
    // How many latest-view history pages reported older messages above them.
    // Non-sensitive, used to tell "flag was true" apart from "flag was absent".
    this.historyContinuationPages = 0;
    this.messages = new MessageIndex(maxMessages);
    this.#maxSendCorrelations = integer(maxSendCorrelations, 1, 1000000);
    this.pending = new Set();
    this.groupReads = new Set();
    this.memberRefreshes = new Map();
    this.unconfirmedGroupReads = new Set();
    this.unconfirmedGroupMuteReads = new Set();
    this.groupFileRead = null;
    this.unconfirmedGroupFileDirectories = new Set();
    this.recentGroupFileReceipts = new Set();
    this.unboundRootFileGroups = new Set();
    this.cleanups = [];
    this.generation = 0;
    this.identity = null;
    this.attached = false;
    this.receipts = new EventEmitter();
    this.receipts.setMaxListeners(256);
    this.seen = new Set();
    // notice 幂等去重（免 hook 事件面）：按 类型+会话+消息 去重，容量跟消息索引一致。
    this.noticeSeen = new Set();
    this.uix = undefined;
    /**
     * 「机器人见过的会话」登记表（group:123 / private:456 → {last, count}）。
     *
     * <p>为什么要有它：本机 QQ build 上 `getGroupList()` 的原生回调（onGroupListUpdate）
     * 实测**永不触发**，`get_group_list` 只能回 1502；而手机面板要给白名单做「勾选」，
     * 就需要一份真实的群/私聊清单。这里用最稳的口径：**只统计真正收到过消息的会话**，
     * 它天然只含机器人能看到的会话，也顺便带了「最近活跃时间」。
     * 名字不在这里取（消息里没有群名），由调用方拿 id 再去问 `get_group_info`。
     */
    this.knownChats = new Map();
    this.stats = { malformedEvents: 0, droppedEvents: 0, subscriberErrors: 0,
      sendReceiptsSnapshotted: 0, sendReceiptsReduced: 0, sendReceiptsInvalid: 0,
      sendReceiptIdentityFailures: 0, sendReceiptIndexFailures: 0, sendReceiptsIndexed: 0,
      // 回执超时 / 超时后靠只读对账认出「其实已送达」的次数。这两个数长期看能判断
      // 「是该继续放宽窗口，还是该查回执通道」——而不是靠猜。
      sendReceiptTimeouts: 0, sendReceiptsReconciled: 0,
      // ★ 2026-11-19：回执没在窗口内回来、但原生调用**已被接受**时给的「临时成功」次数。
      //   为什么要有：运行端 OneBot 客户端对文本动作的超时是 15s（onebot.js TEXT_TIMEOUT_MS），
      //   而 QQ 回执实测要 ~29s 才落。等满 45s 必然让运行端先超时 → 它把这次发送记成
      //   unknown → 该会话进 held 闸门 → **从此不再回话**（本机 5 个会话就这么静默的）。
      sendProvisionalAcks: 0, nudgeProvisionalAcks: 0,
      // 免 hook 事件面（通知类事件全部来自既有原生回调，不装 hook）：
      //   noticeEmitted 是总量；三个 dropped_* 用来区分「解析不出」和「换算不出 uin」；
      //   grayTipsSeen 是投影分支真的在工作过的证据（为 0 = 一条灰条都没见过）。
      noticeEmitted: 0, noticeDroppedNoUid: 0, noticeDroppedMalformed: 0,
      noticeDuplicatesSuppressed: 0, grayTipsSeen: 0, noticeBulkSkipped: 0,
      // 见过的灰条按 busiId 计数（最多记 32 种）：用来回答「这些群里到底出现哪些灰条」，
      // 而不是靠猜哪种 busiId 值得实现。
      grayTipKinds: {} };
    this.proof = null;
    this.proofWork = 0;
    this.eventPending = 0;
    this.sendIds = new Set();
    this.lastSendTime = 0;
    this.forwards = new Map();
    this.forwardSources = new Map();
    this.reactionPages = new Map();
    this.friendRequests = new Map();
    this.groupRequests = new Map();
    this.retiredFriendRequestTime = 0;
    this.retiredFriendRequestUids = new Set();
    this.webCgi = new WebCgiClient({
      getUin: () => this.identity?.user_id ?? BOT,
      getTipOff: () => this.tipOff,
      getTicketService: () => this.ticket,
    });
    this.forwardPrefix = randomBytes(16).toString('hex');
    this.nextForward = 1;
    this.forwardLimit = Math.min(this.messages.limit, 1024);
    // Rich-media download completion is delivered by the onRichMediaDownloadComplete
    // listener (NapCat's downloadMedia contract), keyed by `${msgId}:${elementId}`.
    this.richMediaCompletions = new Map();
  }

  probe() {
    if (this.proof) return this.proof;
    if (this.proofWork >= 4) return Promise.reject(new BridgeError('BUSY', 'Runtime identity probe limit reached', { retcode: 1503 }));
    const generation = this.generation;
    let timer;
    this.proofWork++;
    const work = Promise.resolve().then(() => this.identityProbe()).finally(() => { this.proofWork--; });
    const proof = Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); })]).then((value) => {
      if (generation !== this.generation) throw new BridgeError('STALE_SESSION', 'Session changed during identity check', { retcode: 1503 });
      const nativeSession = this.#authorizationPolicy === 'native-session';
      const uid = typeof value?.uid === 'string' && /^u_[A-Za-z0-9_-]{1,125}$/.test(value.uid) ? value.uid : undefined;
      const authorized = nativeSession
        ? value?.authenticated === true && value?.sessionAuthorized === true && uid !== undefined &&
          (value.online_known !== true || typeof value.online === 'boolean') &&
          this.session.getSessionId() === value.sessionId
        : value?.online === true;
      if (String(value?.user_id) !== BOT || !authorized || typeof value?.sessionId !== 'string' || !value.sessionId) {
        this.detach();
        throw new BridgeError('IDENTITY_REJECTED', 'Runtime identity or authorization rejected', { retcode: 1403 });
      }
      if (generation !== this.generation) throw new BridgeError('STALE_SESSION', 'Session changed during authorization check', { retcode: 1503 });
      if (this.identity && (value.sessionId !== this.identity.sessionId ||
          (this.identity.uid !== undefined && uid !== this.identity.uid))) {
        this.detach();
        throw new BridgeError('STALE_SESSION', 'Runtime session changed; explicit attachment required', { retcode: 1503 });
      }
      this.identity = { user_id: Number(BOT), nickname: typeof value.nickname === 'string' ? value.nickname : '',
        ...(nativeSession ? {
          authenticated: true, sessionAuthorized: true,
          online: value.online_known === true && value.online === true,
          online_known: value.online_known === true,
          platform_state: value.online_known !== true ? 'unknown' : value.online === true ? 'online' : 'offline',
        } : { online: true }),
        sessionId: value.sessionId, ...(uid === undefined ? {} : { uid }) };
      return { ...this.identity };
    }).catch((error) => {
      if (error instanceof BridgeError) throw error;
      if (generation === this.generation) this.detach();
      throw new BridgeError('IDENTITY_UNAVAILABLE', 'Runtime identity unavailable', { retcode: 1503 });
    }).finally(() => { clearTimeout(timer); if (this.proof === proof) this.proof = null; });
    this.proof = proof;
    return proof;
  }

  async attach() {
    if (this.attached) return this.probe();
    const generation = this.generation;
    const identity = await this.probe();
    if (generation !== this.generation)
      throw new BridgeError('STALE_SESSION', 'Session changed before listener attachment', { retcode: 1503 });
    if (this.attached) return identity;
    const previous = this.#reattachIdentity;
    this.#reattachIdentity = undefined;
    if (previous && (identity.sessionId !== previous.sessionId || identity.uid !== previous.uid ||
        identity.user_id !== previous.user_id)) {
      this.detach();
      throw new BridgeError('STALE_SESSION', 'Cannot reattach across a native session change', { retcode: 1503 });
    }
    const safe = (callback) => (...args) => {
      if (!this.attached || generation !== this.generation) { this.stats.droppedEvents++; return; }
      try { callback(...args); } catch { this.stats.malformedEvents++; }
    };
    try {
      this.msg = this.session.getMsgService?.();
      this.group = this.session.getGroupService?.();
      this.buddy = this.session.getBuddyService?.();
      this.profile = this.session.getProfileService?.();
      // rkey 探测包在当前 Linux QQ build 上实测持续返 result:145（请求包解析失败），默认关闭以防触发腾讯风控审计；
      // 仅当显式设置 WHALE_ENABLE_RKEY_PROBE=1 时启用，默认走内联下载 + md5 兜底。
      this.rkey = new RkeyProvider({
        msg: process.env.WHALE_ENABLE_RKEY_PROBE === '1' ? this.msg : undefined,
        timeoutMs: this.timeoutMs
      });
      // Rich media is optional. Some runtimes do not expose it at message-service readiness.
      try { this.richMedia = this.session.getRichMediaService?.(); } catch { this.richMedia = undefined; }
      try { this.robot = this.session.getRobotService?.(); } catch { this.robot = undefined; }
      try { this.recentContact = this.session.getRecentContactService?.(); } catch { this.recentContact = undefined; }
      try { this.profileLike = this.session.getProfileLikeService?.(); } catch { this.profileLike = undefined; }
      // 群公告写/删要 qun.qq.com 域的 pskey；内核里它在 tipOff 服务（getPskey）。
      // ★ 实测（2026-11-23）：这台机的 QQ build 上 getTipOffService 存在且带 getPskey。
      //   pskey 只放内存、60 秒滑动 TTL，绝不打印、绝不落盘、绝不进台账。
      try { this.tipOff = this.session.getTipOffService?.(); } catch { this.tipOff = undefined; }
      try { this.ticket = this.session.getTicketService?.(); } catch { this.ticket = undefined; }
      try { this.search = this.session.getSearchService?.(); } catch { this.search = undefined; }
      try { this.avatar = this.session.getAvatarService?.(); } catch { this.avatar = undefined; }
      try { this.app = this.session.getAppService?.(); } catch { this.app = undefined; }
      this.#pskey = null;
      this.webCgi.clear();
      // 免 hook 事件面：notice 回调（撤回/掉线/灰条/入群/群公告…）。失败不影响消息流。
      let notices = { msg: {}, group: {} };
      try { notices = this.noticeCallbacks(); } catch { this.stats.subscriberErrors++; }
      if (typeof this.msg?.addKernelMsgListener !== 'function' || typeof this.msg?.removeKernelMsgListener !== 'function') throw unsupported();
      this.attached = true;
      this.register(this.msg, 'addKernelMsgListener', 'removeKernelMsgListener', {
        onRecvMsg: safe((list) => this.receive(list, false)),
        onMsgInfoListUpdate: safe((list) => this.receive(list, true)),
        onRecvOfflineFileMsg: safe((list) => this.receive(list, false)),
        onFileMsgCome: safe((list) => this.receive(list, false)),
        ...notices.msg,
        // NapCat's downloadMedia contract: downloadRichMedia resolves void and the
        // completed filePath arrives here (msgElementId + msgId + filePath).
        onRichMediaDownloadComplete: safe((done) => this.rememberRichMediaDownload(done)),
        onGroupFileInfoUpdate: safe((page) => {
          const request = this.groupFileRead;
          const items = page?.item;
          if (!request || !Array.isArray(items) || items.length < 1 || items.length > 200 ||
              items.includes(undefined) || !items.every(item => item?.peerId === request.code))
            return;
          // The callback lacks a proven request correlation. A folder page
          // must identify its parent on every entry before it can be used.
          if (!items.every(item => {
            const parent = (item.fileInfo ?? item.folderInfo)?.parentFolderId;
            return request.folderId === undefined ? [undefined, '', '/'].includes(parent) : parent === request.folderId;
          })) return;
          if (Number.isSafeInteger(page.reqId) && page.reqId > 0 &&
              this.recentGroupFileReceipts.has(`${request.code}:${request.folderId ?? '/'}:${page.reqId}`)) return;
          this.receipts.emit('group-files', page);
        }),
      });
      if (this.group?.addKernelGroupListener && this.group?.removeKernelGroupListener) {
        this.register(this.group, 'addKernelGroupListener', 'removeKernelGroupListener', {
          onGroupListUpdate: safe((kind, groups) => { if (kind === 0 && Array.isArray(groups)) this.receipts.emit('groups', groups); }),
          onGroupDetailInfoChange: safe((detail) => this.receipts.emit(`group:${detail?.groupCode}`, detail)),
          onShutUpMemberListChanged: safe((code, members) => {
            if (typeof code === 'string') this.receipts.emit(`group-muted:${code}`, members);
          }),
          ...notices.group,
        });
      }
      if (['addKernelBuddyListener', 'removeKernelBuddyListener', 'approvalFriendRequest'].every(name => typeof this.buddy?.[name] === 'function') &&
          typeof this.profile?.getCoreAndBaseInfo === 'function') {
        this.register(this.buddy, 'addKernelBuddyListener', 'removeKernelBuddyListener', {
          onBuddyReqChange: safe(page => this.receiveFriendRequests(page, generation)),
        });
        this.friendRequestListener = true;
      }
      this.safeEmit('bridge-ready');
      if (!this.attached || generation !== this.generation)
        throw new BridgeError('STALE_SESSION', 'Session changed after listener attachment', { retcode: 1503 });
      return identity;
    } catch (error) {
      if (generation === this.generation) this.detach();
      throw error instanceof BridgeError ? error : unsupported();
    }
  }

  register(service, add, remove, listener) {
    const handle = service[add](listener);
    this.cleanups.push(() => service[remove](handle));
  }
  async reattach() {
    if (!this.attached || !this.identity) throw new BridgeError('OFFLINE', 'Native bridge is detached', { retcode: 1503 });
    const identity = this.identity;
    this.#detach(identity);
    try { return await this.attach(); }
    catch (error) {
      if (this.#reattachIdentity === identity) this.detach();
      throw error;
    }
  }

  detach() {
    this.#detach();
  }

  #detach(reattachIdentity) {
    const wasAttached = this.attached;
    this.attached = false;
    this.identity = null;
    this.proof = null;
    this.#reattachIdentity = reattachIdentity;
    this.generation++;
    this.robot = undefined;
    this.recentContact = undefined;
    this.profileLike = undefined;
    this.tipOff = undefined;
    this.ticket = undefined;
    this.search = undefined;
    this.avatar = undefined;
    this.app = undefined;
    this.#pskey = null;
    this.webCgi.clear();
    this.groupRequests.clear();
    this.memberRefreshes.clear();
    for (const { controller } of this.#voiceTranscriptions.values()) controller.abort();
    this.#voiceTranscriptions.clear();
    for (const cancel of [...this.pending]) cancel();
    for (const cleanup of this.cleanups.splice(0)) { try { cleanup(); } catch {} }
    if (!reattachIdentity) {
      this.messages.clear();
      this.seen.clear();
      this.sendIds.clear();
      this.#pendingNativeTranscriptions.clear();
      this.forwards.clear();
      this.forwardSources.clear();
      this.reactionPages.clear();
    }
    this.friendRequests.clear();
    this.retiredFriendRequestTime = 0;
    this.retiredFriendRequestUids.clear();
    this.friendRequestListener = false;
    if (wasAttached) this.safeEmit('offline', { reason: 'session_detached' });
  }
  safeEmit(name, event) {
    for (const callback of this.rawListeners(name)) {
      try { callback.call(this, structuredClone(event)); } catch { this.stats.subscriberErrors++; }
    }
  }
  capabilities() {
    if (!this.attached) return [];
    const available = ['get_login_info'];
    if (this.friendRequestListener) available.push('set_friend_add_request');
    const has = (service, ...names) => names.every((name) => typeof service?.[name] === 'function');
    if (has(this.msg, 'sendMsg', 'generateMsgUniqueId')) available.push('send_group_msg', 'send_msg', 'send_message');
    if (has(this.msg, 'sendMsg', 'generateMsgUniqueId') && has(this.group, 'getUidByUins')) available.push('send_private_msg');
    if (has(this.msg, 'sendShowInputStatusReq') && has(this.group, 'getUidByUins')) available.push('set_input_status');
    if (has(this.profileLike, 'setBuddyProfileLike') && has(this.group, 'getUidByUins') && has(this.buddy, 'isBuddy'))
      available.push('send_like');
    if (has(this.profileLike, 'getBuddyProfileLike') && has(this.group, 'getUidByUins', 'getUinByUids'))
      available.push('get_profile_like');
    if (has(this.msg, 'sendMsg', 'generateMsgUniqueId', 'buildMultiForwardMsg')) {
      available.push('send_group_forward_msg', 'send_forward_msg');
      if (has(this.group, 'getUidByUins')) available.push('send_private_forward_msg');
    }
    if (has(this.msg, 'getMsgsByMsgId')) available.push('get_msg');
    if (has(this.msg, 'getMsgsByMsgId', 'translatePtt2Text')) available.push('fetch_ptt_text');
    if (has(this.richMedia, 'getGroupFileList')) available.push('get_group_root_files', 'get_group_files_by_folder');
    if (has(this.richMedia, 'createGroupFolder')) available.push('create_group_file_folder');
    if (has(this.richMedia, 'deleteGroupFolder')) available.push('delete_group_folder');
    if (has(this.richMedia, 'getGroupFileInfo', 'deleteGroupFile')) available.push('delete_group_file');
    if (has(this.richMedia, 'getGroupFileInfo', 'moveGroupFile')) available.push('move_group_file');
    if (has(this.richMedia, 'getGroupFileList', 'batchGetGroupFileCount')) available.push('get_group_file_system_info');
    if (has(this.richMedia, 'translateEnWordToZn')) available.push('translate_en2zh');
    if (has(this.robot, 'getRobotUinRange')) available.push('get_robot_uin_range');
    if (has(this.recentContact, 'getRecentContactListSnapShot') && has(this.msg, 'getMsgsByMsgId') && has(this.group, 'getUidByUins'))
      available.push('get_recent_contact');
    if (has(this.msg, 'fetchFavEmojiList')) available.push('fetch_custom_face');
    if (has(this.msg, 'sendNudge')) available.push('friend_poke', 'group_poke');
    if (has(this.msg, 'setStatus')) available.push('set_online_status');
    if (has(this.group, 'getGroupHonorList')) available.push('get_group_honor_info');
    if (has(this.profile, 'setHeader')) available.push('set_qq_avatar');
    if (has(this.msg, 'getMsgsByMsgId', 'addFavEmoji')) available.push('add_custom_face');
    if (has(this.group, 'getGroupRemainAtTimes')) available.push('get_group_at_all_remain');
    if (has(this.group, 'setTop')) available.push('set_group_top');
    if (has(this.msg, 'setContactLocalTop') || has(this.buddy, 'setTop')) available.push('set_friend_top');
    if (has(this.group, 'getGroupExt0xEF0Info')) available.push('get_group_info_ex');
    if (has(this.group, 'getJoinGroupLink')) available.push('get_group_share_link');
    if (has(this.group, 'getGroupShutUpMemberList', 'addKernelGroupListener', 'removeKernelGroupListener'))
      available.push('get_group_shut_list');
    if (has(this.msg, 'getAioFirstViewLatestMsgs', 'getMsgs')) {
      available.push('get_group_msg_history');
      if (has(this.group, 'getUidByUins')) available.push('get_friend_msg_history');
    }
    if (has(this.msg, 'getMsgsByMsgId', 'getMultiMsg')) available.push('get_forward_msg');
    if (has(this.msg, 'recallMsg')) available.push('delete_msg');
    if (has(this.msg, 'setMsgRead')) available.push('mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read');
    if (has(this.msg, 'getMsgsByMsgId', 'setMsgEmojiLikes')) available.push('set_msg_emoji_like');
    if (has(this.msg, 'getMsgsByMsgId')) available.push('get_msg_emoji_likes', 'get_image', 'get_file', 'get_message_images', 'get_message_audio');
    // 语音落地需要「读得回那条消息」+「原生能传字节」两件事同时成立，
    // 少一样就不要把它列进能力表（宁可不报，也不报一个必失败的动作）。
    if (has(this.msg, 'getMsgsByMsgId', 'downloadRichMedia')) available.push('get_record');
    // 视频落地（运行端抽帧用）：同一条原生传输，只是元素类型是 5。
    if (has(this.msg, 'getMsgsByMsgId', 'downloadRichMedia')) available.push('get_message_videos');
    if (has(this.msg, 'getMsgsByMsgId', 'getMsgEmojiLikesList')) available.push('fetch_emoji_like', 'get_emoji_likes');
    // P0 免 hook：会话元信息（纯本地即可回答，NapCat 同名动作对应）
    // get_login_info 在上面已无条件加过，这里只补其余三个（重复项会让能力表出现同一动作两次）
    available.push('get_version_info', 'can_send_image', 'can_send_record');
    // 内部诊断：列出本机 QQ build 真实暴露的内核方法名（只读，用来决定哪些动作能实现）。
    available.push('debug_native_surface');
    // 内部诊断：历史读取卡在哪一步（绕开 wait() 的归一化错误）。
    // ★ 注意：core 的 dispatch 先查能力表再查注册表 —— 只加 actions.mjs 而忘了这里，
    //   调用会是 1404「动作不存在」，看起来像没生效（本轮踩过）。
    if (has(this.msg, 'getAioFirstViewLatestMsgs')) available.push('debug_history_probe');
    if (has(this.msg, 'getMsgsByMsgId')) available.push('debug_forward_probe');
    // 我们自己的扩展：机器人「见过」的会话清单（白名单勾选要用）。
    // 不依赖任何原生方法（纯本地登记表），所以无条件声明。
    // 背景：本机 getGroupList() 的 onGroupListUpdate 回调永不触发 ⇒ get_group_list 只回 1502。
    available.push('get_known_chats');
    // 群名补充（只读扩展）：候选清单只有群号、没有群名，面板拿群号再问一次。
    // 读法与 get_group_info 完全同一条（readGroupDetail → group.getGroupDetailInfo +
    // 群监听器 onGroupDetailInfoChange），所以能力闸也跟它同一道：原生没这套方法时
    // 明确不声明（面板拿到 1404 就照旧显示号码），而不是声明了再抛 TypeError。
    if (has(this.group, 'getGroupDetailInfo', 'addKernelGroupListener', 'removeKernelGroupListener'))
      available.push('get_chat_names');
    // 第二批：群公告（读/删，本机 group service 有 getGroupBulletin/deleteGroupBulletin）、
    // 群系统消息（getSingleScreenNotifies）、陌生人申请（buddy.getDoubtBuddyReq）。
    if (has(this.group, 'getGroupBulletin', 'getGroupBulletinList')) available.push('get_group_notice');
    if (has(this.group, 'deleteGroupBulletin')) available.push('del_group_notice');
    // 群公告写要多一条 pskey 通道：内核 publishGroupBulletin 的第二个参数就是它。
    // 取不到 pskey 就不要把动作列出来（列出来必失败，比不报更难查）。
    if (has(this.group, 'publishGroupBulletin') && (has(this.tipOff, 'getPskey') || has(this.ticket, 'forceFetchClientKey')))
      available.push('send_group_notice');
    if (has(this.group, 'getSingleScreenNotifies')) available.push('get_group_system_msg');
    if (has(this.group, 'operateSysNotify') || has(this.group, 'operateSysNotifyV2')) available.push('set_group_add_request');
    // get_doubt_friends_add_request：本机 build 的 buddy.getDoubtBuddyReq() 永不 resolve（实测 2026-11-18），
    // 故**不对外声明**。实现保留在 doubtFriendRequests()，等某个 build 真能回答时再打开这一行。
    // P0 免 hook：精华消息（内核 addGroupEssence / removeGroupEssence，参数用本会话索引里的 msgRandom/msgSeq）
    if (has(this.group, 'addGroupEssence', 'removeGroupEssence')) available.push('set_essence_msg', 'del_essence_msg');
    if (has(this.group, 'fetchGroupEssenceListV2') || has(this.group, 'fetchGroupEssenceList') || this.webCgi.hasAuthProvider())
      available.push('get_essence_msg_list');
    // P0 免 hook：单条转发（内核 forwardMsg(msgIds, srcPeer, dstPeers, []))
    if (has(this.msg, 'forwardMsg')) available.push('forward_friend_single_msg', 'forward_group_single_msg');
    if (this.webCgi.hasAuthProvider() || has(this.group, 'getGroupList', 'addKernelGroupListener', 'removeKernelGroupListener'))
      available.push('get_group_list');
    if (has(this.group, 'getGroupDetailInfo', 'addKernelGroupListener', 'removeKernelGroupListener')) available.push('get_group_info', 'get_group_detail_info');
    if (available.includes('get_group_detail_info') && has(this.group, 'modifyGroupRemark')) available.push('set_group_remark');
    if (has(this.group, 'getAllMemberList')) available.push('get_group_member_list', 'get_group_member_info');
    if (has(this.group, 'setGroupShutUp')) available.push('set_group_whole_ban');
    if (has(this.group, 'setMemberShutUp', 'getUidByUins')) available.push('set_group_ban');
    if (has(this.group, 'kickMember', 'getUidByUins', 'getAllMemberList')) available.push('set_group_kick', 'set_group_kick_members');
    if (available.includes('get_group_detail_info') && has(this.group, 'modifyGroupName')) available.push('set_group_name');
    if (has(this.group, 'modifyMemberCardName', 'getUidByUins', 'getAllMemberList')) available.push('set_group_card');
    if (has(this.group, 'modifyMemberRole', 'getUidByUins', 'getAllMemberList')) available.push('set_group_admin');
    if (has(this.group, 'quitGroupV2', 'getGroupList', 'addKernelGroupListener', 'removeKernelGroupListener')) available.push('set_group_leave');
    if (has(this.msg, 'sendMsg', 'generateMsgUniqueId')) {
      available.push('upload_group_file', 'send_group_file');
      if (has(this.group, 'getUidByUins')) available.push('upload_private_file', 'send_private_file');
    }
    if (has(this.richMedia, 'getGroupFileInfo') || this.webCgi.hasAuthProvider()) available.push('get_group_file_url');
    if (has(this.richMedia, 'getScreenOCR')) available.push('ocr_image');
    if (has(this.search, 'searchMsgWithKeywords') || has(this.msg, 'queryMsgsWithFilterEx')) available.push('search_local_msgs');
    if (has(this.group, 'listAllAIVoice')) available.push('get_ai_characters');
    available.push('get_qq_avatar', 'get_group_avatar', 'get_protocol_readiness');
    if (this.webCgi.hasAuthProvider()) {
      available.push(
        'get_cookies', 'get_credentials', 'get_csrf_token',
        'get_qzone_msg_list', 'get_qzone_feeds', 'send_qzone_msg', 'comment_qzone', 'like_qzone',
        'get_group_album_list', 'get_group_album_media_list', 'set_group_album_media_like',
        'do_group_album_comment', 'upload_image_to_qun_album',
      );
    }
    // Current official legacy kick contract is independently described in
    // V2 flags and personal-title methods are
    // not guessed from their presence or the older MIT facade.
    if (has(this.buddy, 'getBuddyListV2')) available.push('get_friend_list', 'get_friends_with_category');
    if (has(this.buddy, 'isBuddy', 'setBuddyRemark') && has(this.group, 'getUidByUins') &&
        has(this.profile, 'getCoreAndBaseInfo')) available.push('set_friend_remark');
    if (has(this.profile, 'getUserDetailInfoByUin')) available.push('get_stranger_info');
    if (has(this.profile, 'getUserDetailInfoByUin', 'setLongNick')) available.push('set_self_longnick');
    if (has(this.profile, 'getUserDetailInfoByUin', 'modifyDesktopMiniProfile')) available.push('set_qq_profile');
    return [...new Set(available)];
  }

  // A single waiter has an absolute timeout, abort, and lifecycle cancellation.
  wait(event, invoke, { signal, sideEffect = false, shouldSubmit, requireAck = false, snapshotReceipt, timeoutMs = this.timeoutMs } = {}) {
    if (this.pending.size >= 128) return Promise.reject(new BridgeError('BUSY', 'Native operation limit reached', { retcode: 1503 }));
    return new Promise((resolve, reject) => {
      const generation = this.generation;
      let settled = false;
      let started = false;
      let acknowledged = false;
      let receipt;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        if (event) this.receipts.off(event, receive);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const fail = (code) => new BridgeError(code, sideEffect && started ? 'Native side effect outcome is unknown; do not retry automatically' : 'Native operation did not complete', { retcode: 1502, outcome: sideEffect && started ? 'unknown' : 'not_started' });
      const cancel = () => finish(fail('CANCELLED'));
      const receive = (value) => {
        if (!started || receipt) return;
        try { receipt = { value: snapshotReceipt ? snapshotReceipt(value) : value }; }
        catch (error) { finish(sideEffect ? fail('INVALID_RECEIPT') : error); return; }
        if (!requireAck || acknowledged) finish(null, receipt.value);
      };
      const timer = setTimeout(() => finish(fail('TIMEOUT')), timeoutMs);
      this.pending.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      if (event) this.receipts.on(event, receive);
      Promise.resolve().then(async () => {
        if (settled) return;
        if (this.#authorizationPolicy === 'native-session') {
          await this.probe();
          if (settled) return;
          let current = false;
          try { current = this.identity != null && this.session.getSessionId() === this.identity.sessionId; } catch {}
          if (!current) { this.detach(); cancel(); return; }
        }
        if (settled || !this.attached || generation !== this.generation || signal?.aborted || (shouldSubmit && !shouldSubmit())) { cancel(); return; }
        started = true;
        return invoke();
      }).then((value) => {
        if (!event) finish(null, value);
        else if (requireAck) {
          try { checkResult(value); } catch (error) { finish(error); return; }
          acknowledged = true;
          if (receipt) finish(null, receipt.value);
        }
        // For callbacks, acknowledgment does not replace completion evidence.
      }, () => finish(fail('NATIVE_CALL_FAILED')));
    });
  }

  // Ordinary conversation context is not authority to operate the protected
  // account. Administrative targets continue to use user(), including uid()'s
  // default path; only explicitly selected chat/read paths use this exception.
  #conversationUser(value) { return this.#conversationPolicy === 'original' ? id(value, 'user_id') : user(value); }

  async uid(uin, options, conversation = false) {
    const value = conversation ? this.#conversationUser(uin) : user(uin);
    if (typeof this.group?.getUidByUins !== 'function') throw unsupported();
    const raw = checkResult(await this.wait(null, () => this.group.getUidByUins([value]), options), false, 'errCode');
    const uid = raw.uids instanceof Map ? raw.uids.get(value) : undefined;
    if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(uid)) throw new BridgeError('UID_UNRESOLVED', 'User identity could not be resolved', { retcode: 1404 });
    return uid;
  }
  async peer(params, type, options) {
    if (type === 'group') return { chatType: 2, peerUid: id(params.group_id, 'group_id'), guildId: '' };
    if (type === 'private') return { chatType: 1, peerUid: await this.uid(params.user_id, options, true), guildId: '' };
    throw invalid('message_type must be group or private');
  }

  async markRead(action, params, options) {
    params = validateParams(action, params);
    const generation = this.generation;
    let peer;
    if (params.message_id !== undefined) {
      const known = this.messages.get(params.message_id);
      this.#conversationUser(known.senderUin);
      peer = rawPeer(known);
      if ((action === 'mark_group_msg_as_read' && peer.chatType !== 2) ||
          (action === 'mark_private_msg_as_read' && peer.chatType !== 1)) throw invalid('Message conversation type mismatch');
    } else if (params.group_id !== undefined) {
      peer = await this.peer(params, 'group', options);
    } else {
      if (typeof this.buddy?.isBuddy !== 'function') throw unsupported();
      peer = await this.peer(params, 'private', options);
      if (!this.attached || generation !== this.generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Read target crossed a session change', { retcode: 1503 });
      if (await this.wait(null, () => this.buddy.isBuddy(peer.peerUid), options) !== true)
        throw new BridgeError('FRIEND_UNVERIFIED', 'Friend relationship could not be confirmed', { retcode: 1404 });
    }
    const assertCurrent = () => this.attached && generation === this.generation && !options.signal?.aborted;
    if (!assertCurrent()) throw new BridgeError('STALE_SESSION', 'Read target crossed a session change', { retcode: 1503 });
    const result = await this.wait(null, () => this.msg.setMsgRead(peer),
      { ...options, sideEffect: true, shouldSubmit: () => assertCurrent() && (options.shouldSubmit?.() ?? true) });
    if (!assertCurrent()) throw new BridgeError('STALE_SESSION', 'Read result crossed a session change',
      { retcode: 1502, outcome: 'unknown' });
    checkResult(result, true);
    return null;
  }

  async elements(message, peer, autoEscape, options) {
    const segments = normalizeMessage(message, autoEscape);
    if (!segments.length) throw invalid('message is empty');
    const faceElements = new Map();
    // Reject unsupported segments and protected mention targets before resolving any mentions.
    const imagePlacement = this.imagePlacement;
    for (const segment of segments) {
      if (segment.type === 'image') {
        if (!imagePlacement)
          throw new BridgeError('UNSUPPORTED_SEGMENT', 'This native profile supports text, at, face and reply sends only', { retcode: 1404 });
        const file = segment.data.file;
        if (typeof file !== 'string' || !file || file.length > 32768)
          throw invalid('Image segment requires a bounded file source');
        continue;
      }
      if (['record', 'video', 'file'].includes(segment.type)) {
        // P1：语音/视频/文件只接受**本地绝对路径**（不接 URL/base64：那两种要先落盘再走原生
        // 上传，未验证前不做）。校验放在提交之前，失败不发任何请求。
        const file = segment.data?.file;
        if (typeof file !== 'string' || !file || file.length > 4096)
          throw invalid(segment.type + ' segment requires a local absolute file path');
        const checked = validateLocalMedia(file, { kind: segment.type === 'record' ? 'ptt' : segment.type, maxBytes: MEDIA_SEND_LIMITS[segment.type === 'record' ? 'ptt' : segment.type] });
        if (!checked.ok) throw new BridgeError('MEDIA_UNAVAILABLE', checked.reason || 'Media file is not usable', { retcode: 1400 });
        continue;
      }
      if (!['text', 'at', 'face', 'reply'].includes(segment.type))
        throw new BridgeError('UNSUPPORTED_SEGMENT', 'This native profile supports text, at, face, reply, image, record, video and file sends', { retcode: 1404 });
      if (segment.type === 'at') {
        if (peer.chatType !== 2) throw invalid('Mentions require a group');
        if (segment.data.qq !== 'all') this.#conversationUser(segment.data.qq);
      }
      if (segment.type === 'face') {
        const faceId = segment.data.id;
        if (!['string', 'number'].includes(typeof faceId) || !/^(0|[1-9]\d{0,5})$/.test(String(faceId)))
          throw invalid('Face ID must be a decimal integer');
        const faceIndex = integer(Number(faceId), 0, MAX_FACE_INDEX);
        faceElements.set(segment, { elementType: 6, faceElement: { faceIndex, faceType: faceIndex < 222 ? 1 : 2 } });
      }
    }
    const mentionUids = new Map();
    const result = [];
    for (const segment of segments) {
      const d = segment.data;
      if (segment.type === 'text') result.push({ elementType: 1, textElement: { content: text(d.text, 'text', 65536) } });
      if (segment.type === 'face') result.push(faceElements.get(segment));
      if (['record', 'video', 'file'].includes(segment.type)) {
        const checked = validateLocalMedia(d.file, { kind: segment.type === 'record' ? 'ptt' : segment.type, maxBytes: MEDIA_SEND_LIMITS[segment.type === 'record' ? 'ptt' : segment.type] });
        if (!checked.ok) throw new BridgeError('MEDIA_UNAVAILABLE', checked.reason || 'Media file is not usable', { retcode: 1400 });
        if (segment.type === 'record') {
          result.push(buildPttElement({ filePath: d.file, size: checked.size,
            ...(d.duration ? { durationSec: Number(d.duration) } : {}) }));
        } else if (segment.type === 'video') {
          // ★ 2026-11-23 真机：只给 filePath + size 的 videoElement 会被内核直接拒
          //   （`1500 Native operation rejected`）。这里补上本机能算的元数据：md5、宽高、时长。
          //   封面（thumbPath）必须放在 QQ 自己能读的目录，本模块不猜那个路径，所以不给 ——
          //   万一封面对内核是必需的，这里会在真机上明确失败，而不是假装成功。
          let meta = null;
          try { meta = await this.videoProbe(d.file, options); } catch { meta = null; }
          result.push(buildVideoElement({
            filePath: d.file, size: checked.size,
            ...(meta?.md5 ? { md5: meta.md5 } : {}),
            ...(meta?.width ? { width: meta.width } : {}),
            ...(meta?.height ? { height: meta.height } : {}),
            ...(meta?.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
          }));
        } else {
          result.push(buildFileElement({ filePath: d.file, size: checked.size, groupFile: peer.chatType === 2 }));
        }
        continue;
      }
      if (segment.type === 'image') {
        if (!imagePlacement) throw invalid('Image placement unavailable');
        // Image preparation may decode/place local bytes; it does not submit.
        // Pass through the OneBot sub_type (1 = sticker/animated face) and summary so
        // the native element is built with the correct picSubType rather than always 0.
        try {
          const subType = segment.data.sub_type;
          const summary = segment.data.summary;
          // ★ 2026-11-19：运行端给的 file 常是它自己的远端 URL（贴纸库/生成图），
          //   placement 只认 base64:// 或 QQ CDN ⇒ 这里先统一成 base64://（见 normalizeImageSource）。
          const source = await normalizeImageSource(d.file, { signal: options?.signal });
          const element = await imagePlacement.buildImageElement(source, {
            msg: this.msg,
            ...(subType !== undefined && subType !== null ? { subType: Number(subType) } : {}),
            ...(summary !== undefined && summary !== null ? { summary: String(summary) } : {}),
          });
          result.push(element);
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          // The App records an image/sticker send failure as a bare "HTTP 400" and
          // keeps no wording, so the reason used to vanish. Record it here for both
          // the mapped and the unmapped cases (names/codes plus a bounded message).
          mediaDiagnostics.lastPrepareFailure = {
            at: new Date().toISOString(),
            name: String(error?.name ?? 'Error'),
            code: String(error?.code ?? ''),
            message: String(error?.message ?? '').slice(0, 240),
            mapped: error?.name === 'ImageStoreError' || error?.name === 'NativeImagePlacementError' ||
              error?.name === 'ImageDecoderError',
            subType: d.sub_type ?? null,
            chars: typeof d.file === 'string' ? d.file.length : null,
          };
          if (mediaDiagnostics.lastPrepareFailure.mapped)
            // 1400 (invalid parameters), not 1404 (capability unavailable): nothing was
            // submitted to native code, the request itself was refused. 1404 made the
            // HTTP layer answer 404, which reads as "this endpoint does not exist".
            throw new BridgeError('IMAGE_PREPARE_FAILED', error?.message ?? 'Image preparation failed', { retcode: 1400 });
          throw error;
        }
      }
      if (segment.type === 'at') {
        const all = d.qq === 'all';
        const target = all ? 'all' : this.#conversationUser(d.qq);
        if (!all && !mentionUids.has(target)) mentionUids.set(target, await this.uid(target, options, true));
        result.push({ elementType: 1, elementId: '', textElement: {
          content: all ? '@全体成员' : `@${target}`, atType: all ? 1 : 2,
          atUid: target, atTinyId: '', atNtUid: all ? 'all' : mentionUids.get(target),
        } });
      }
      if (segment.type === 'reply') {
        const source = this.messages.get(d.id);
        if (!peerEqual(peer, rawPeer(source))) throw invalid('Reply belongs to a different conversation');
        if (typeof source.msgSeq !== 'string' || !/^[1-9]\d{0,18}$/.test(source.msgSeq) ||
            BigInt(source.msgSeq) > 9223372036854775807n) throw invalid('Reply lacks a confirmed message sequence');
        const senderUin = this.#conversationUser(source.senderUin);
        const replyElement = {
          replayMsgId: source.msgId, replayMsgSeq: source.msgSeq, senderUin, senderUinStr: senderUin,
        };
        if (typeof source.senderUid === 'string' && /^u_[A-Za-z0-9_-]{1,125}$/.test(source.senderUid))
          replyElement.senderUidStr = source.senderUid;
        if (typeof source.msgTime === 'string' && /^[1-9]\d{0,15}$/.test(source.msgTime) &&
            Number.isSafeInteger(Number(source.msgTime))) replyElement.replyMsgTime = source.msgTime;
        if (source.clientSeq !== undefined) {
          if (typeof source.clientSeq !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(source.clientSeq) ||
              BigInt(source.clientSeq) > 9223372036854775807n) throw invalid('Invalid reply client sequence');
          replyElement.replyMsgClientSeq = source.clientSeq;
        }
        result.push({ elementType: 7, elementId: '', replyElement });
      }
    }
    return result;
  }

  /**
   * 发送回执超时后的**只读对账**：在本次会话的消息索引里找出"自己刚发的那一条"。
   *
   * 为什么需要（2026-11-17 实机事故）：一条 send_group_msg 提交后约 30 秒才在群历史里出现，
   * 而当时回执窗口只有 10 秒 ⇒ 判"结果未知" ⇒ 写闸锁死 ⇒ 所有群都不回话。
   * 对账**只读**、**绝不重发**：认不出来就维持"结果未知"（fail closed），符合 D 规则。
   *
   * 识别条件（缺一不可）：
   *   ① 发送者是自己（senderUin === BOT）；② 同一会话；③ guildId 命中本次请求，或
   *   ④ 纯文本发送且时间在提交时刻之后、文本与元素数完全一致（非纯文本不做模糊匹配）。
   */
  async reconcileSentMessage(peer, requestId, elements, submittedAt) {
    const textOnly = Array.isArray(elements) && elements.length > 0 &&
      elements.every(element => element?.elementType === 1);
    const wantText = textOnly ? elements.map(element => element.textElement?.content ?? '').join('') : null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.attached) return undefined;
      for (const entry of this.messages.byId.values()) {
        const raw = entry?.raw;
        if (!raw || String(raw.senderUin) !== BOT) continue;
        if (!peerEqual(rawPeer(raw), peer)) continue;
        if (isNativeMessageId(raw.msgId) && raw.msgId === requestId) return raw.msgId;
        if (wantText === null) continue;
        const at = Number(raw.msgTime) * 1000;
        if (!Number.isFinite(at) || at < submittedAt - 5000) continue;
        const got = (raw.elements ?? []).filter(element => element?.elementType === 1)
          .map(element => element.textElement?.content ?? '').join('');
        if (got !== wantText || (raw.elements ?? []).length !== elements.length) continue;
        if (isNativeMessageId(raw.msgId)) return raw.msgId;
      }
      await delay(1000);
    }
    return undefined;
  }

  /**
   * 精华消息 设/取消（P0，免 hook）。
   *
   * 内核签名：addGroupEssence({ groupCode, msgRandom, msgSeq }) / removeGroupEssence(同名参数)。
   * msgRandom / msgSeq 从**本会话消息索引**取（不额外发一次 getMsgsIncludeSelf）：
   * 索引里没有这条就报 MESSAGE_NOT_FOUND —— 不猜、不拿别人的消息去设精。
   */
  async groupEssence(params, options, add) {
    const generation = this.generation;
    const group = String(id(params.group_id, 'group_id'));
    const messageId = Number(id(params.message_id, 'message_id'));
    const entry = this.messages.byId.get(messageId);
    const raw = entry?.raw;
    if (!raw) throw new BridgeError('MESSAGE_NOT_FOUND', 'Message ID expired or belongs to another session', { retcode: 1404 });
    if (raw.chatType !== 2 || String(raw.peerUid) !== group)
      throw new BridgeError('MESSAGE_NOT_IN_GROUP', 'Message does not belong to the requested group', { retcode: 1404 });
    const msgSeq = Number(raw.msgSeq), msgRandom = Number(raw.msgRandom);
    if (!Number.isSafeInteger(msgSeq) || !Number.isSafeInteger(msgRandom) || msgSeq <= 0 || msgRandom <= 0)
      throw new BridgeError('UNSUPPORTED', 'Native message carries no msgSeq/msgRandom for essence', { retcode: 1404 });
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Essence request crossed a session change', { retcode: 1503 });
    const call = add ? this.group.addGroupEssence : this.group.removeGroupEssence;
    const receipt = await this.wait(null, () => call.call(this.group, { groupCode: group, msgRandom, msgSeq }),
      { ...options, sideEffect: true });
    checkResult(receipt, true);
    return null;
  }

  /**
   * 单条转发（P0，免 hook）。内核：forwardMsg(msgIds, srcPeer, dstPeers, commentElements)。
   * srcPeer 取自消息索引（必须与 message_id 同会话），dstPeer 由 group_id / user_id 决定。
   */
  async forwardSingle(params, destType, options) {
    const generation = this.generation;
    const messageId = Number(id(params.message_id, 'message_id'));
    const entry = this.messages.byId.get(messageId);
    if (!entry) throw new BridgeError('MESSAGE_NOT_FOUND', 'Message ID expired or belongs to another session', { retcode: 1404 });
    const srcPeer = rawPeer(entry.raw);
    const dest = await this.peer(destType === 'group' ? { group_id: id(params.group_id, 'group_id') } : { user_id: id(params.user_id, 'user_id') }, destType, options);
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Forward request crossed a session change', { retcode: 1503 });
    const receipt = await this.wait(null, () => this.msg.forwardMsg([entry.raw.msgId], srcPeer, [dest], []),
      { ...options, sideEffect: true });
    checkResult(receipt, true);
    return null;
  }

  /**
   * 群公告列表（P0，免 hook）。内核：getGroupBulletinList / getGroupBulletin(groupCode)。
   * 只读；返回 OneBot 惯用的 { notices: [...] }。字段名按本机实测方法名取，未在真机校验过的
   * 字段一律原样透传（不猜语义、不编造）。
   */
  async groupNotices(params, options) {
    const code = String(id(params.group_id, 'group_id'));
    const generation = this.generation;
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Bulletin read crossed a session change', { retcode: 1503 });
    const read = async (fn) => this.wait(null, fn, { ...options });
    let page;
    try { page = await read(() => this.group.getGroupBulletinList({ groupCode: code, page: 0, pageSize: 20 })); } catch { page = undefined; }
    if (page === undefined) {
      try { page = await read(() => this.group.getGroupBulletinList(code)); } catch { page = undefined; }
    }
    const list = Array.isArray(page?.feet) ? page.feet
      : Array.isArray(page?.notices) ? page.notices
      : Array.isArray(page?.result?.feet) ? page.result.feet
      : Array.isArray(page) ? page : [];
    return { notices: list.slice(0, 50).map(item => ({
      notice_id: String(item?.noticeId ?? item?.feedId ?? ''),
      sender_id: Number(item?.senderId ?? item?.uin ?? 0),
      publish_time: Number(item?.publishTime ?? item?.time ?? 0),
      content: typeof item?.content === 'string' ? item.content.slice(0, 4000)
        : typeof item?.msg?.content === 'string' ? item.msg.content.slice(0, 4000) : '',
      // 其余字段原样保留：我们自己没验证过的语义不做裁剪，交给调用方判断
      raw: item,
    })) };
  }

  /**
   * 取 qun.qq.com 域的 pskey（内核：tipOff.getPskey([domain], forceRefresh)）。
   *
   * 为什么要它：群公告的**写**（publishGroupBulletin）与**删**（deleteGroupBulletin）
   * 内核签名都带 pskey，deleteGroupBulletin 以前一直传空串 —— 空 pskey 会被服务端拒，
   * 表现成「动作存在但永远失败」，看不出真因。
   *
   * 安全：返回值只在本进程内存里用（60 秒滑动 TTL），不打印、不落盘、不返回给调用方。
   */
  async groupPskey(options = {}) {
    const domain = 'qun.qq.com';
    const now = Date.now();
    if (this.#pskey && this.#pskey.domain === domain && this.#pskey.expireAt > now) {
      this.#pskey.expireAt = now + PSKEY_TTL_MS;
      return this.#pskey.value;
    }
    if (typeof this.tipOff?.getPskey === 'function') {
      try {
        const response = await this.wait(null, () => this.tipOff.getPskey([domain], true), { ...options, timeoutMs: PSKEY_TIMEOUT_MS });
        const map = response?.domainPskeyMap;
        const value = map instanceof Map ? map.get(domain)
          : (map && typeof map === 'object' ? map[domain] : undefined);
        if (typeof value === 'string' && value.length >= 8 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value)) {
          this.#pskey = { domain, value, expireAt: Date.now() + PSKEY_TTL_MS };
          return value;
        }
      } catch { /* fall back to WebCgiClient clientKey jump flow cleanly */ }
    }
    if (this.webCgi.hasAuthProvider()) {
      const info = await this.webCgi.getCookies(domain);
      if (info?.p_skey) {
        this.#pskey = { domain, value: info.p_skey, expireAt: Date.now() + PSKEY_TTL_MS };
        return info.p_skey;
      }
    }
    throw new BridgeError('UNSUPPORTED', 'This native profile cannot obtain a qun.qq.com pskey', { retcode: 1404 });
  }

  /**
   * 发群公告（写）。内核：publishGroupBulletin(groupCode, pskey, data)。
   * data 形状照 NapCat 的实现（text 是 URI 编码后的正文；pinned/confirmRequired 用 0/1）：
   * 参数顺序不是猜的，是照它那一份可跑的实现。
   */
  async sendGroupNotice(params, options) {
    const generation = this.generation;
    const code = String(id(params.group_id, 'group_id'));
    const content = typeof params.content === 'string' ? params.content.trim() : '';
    if (!content || content.length > 2000) throw invalid('Group notice content must be 1 to 2000 characters');
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Bulletin publish crossed a session change', { retcode: 1503 });
    const pskey = await this.groupPskey(options);
    let picInfo;
    if (params.image !== undefined) {
      // 只收本地绝对路径（不接 URL/base64：那要先落盘，未验证前不做）。
      const checked = validateLocalMedia(params.image, { kind: 'image', maxBytes: MEDIA_SEND_LIMITS.image });
      if (!checked.ok) throw new BridgeError('MEDIA_UNAVAILABLE', checked.reason || 'Bulletin image is not usable', { retcode: 1400 });
      const uploaded = await this.wait(null,
        () => this.group.uploadGroupBulletinPic(code, pskey, params.image),
        { ...options, sideEffect: true });
      if (uploaded?.errCode !== undefined && uploaded.errCode !== 0)
        throw new BridgeError('UNCONFIRMED', 'Bulletin image upload was rejected', { retcode: 1502, outcome: 'unknown' });
      const info = uploaded?.picInfo;
      if (!info || typeof info.id !== 'string' || !info.id)
        throw new BridgeError('UNCONFIRMED', 'Bulletin image upload returned no picture reference', { retcode: 1502, outcome: 'unknown' });
      picInfo = { id: info.id, width: Number(info.width) || 0, height: Number(info.height) || 0 };
    }
    const data = { text: encodeURI(content), picInfo, oldFeedsId: '',
      pinned: params.pinned === true ? 1 : 0, confirmRequired: 0 };
    const receipt = await this.wait(null, () => this.group.publishGroupBulletin(code, pskey, data),
      { ...options, sideEffect: true });
    checkResult(receipt, true);
    return { notice_id: String(receipt?.noticeId ?? receipt?.feedId ?? '') };
  }

  /** 删除群公告（P0，写）。内核：deleteGroupBulletin(groupCode, seq, noticeId)。 */
  async deleteGroupNotice(params, options) {
    const generation = this.generation;
    const code = String(id(params.group_id, 'group_id'));
    const noticeId = String(id(params.notice_id, 'notice_id'));
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Bulletin delete crossed a session change', { retcode: 1503 });
    // ★ 以前这里传的是空串 pskey —— 服务端直接拒，却被记成「动作存在但失败」。
    const pskey = await this.groupPskey(options);
    const receipt = await this.wait(null, () => this.group.deleteGroupBulletin(code, pskey, noticeId), { ...options, sideEffect: true });
    checkResult(receipt, true);
    return null;
  }

  /**
   * 群系统消息 / 入群申请（P0，只读）。内核：getSingleScreenNotifies(doubt, startSeq, count)。
   * ★ 本机实测签名存在但参数个数在不同的 QQ build 上不一致，所以先按三参调用，失败再退回两参。
   */
  async groupSystemMessages(params, options) {
    const generation = this.generation;
    const count = integer(params.count ?? 20, 1, 200, 20);
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Notify read crossed a session change', { retcode: 1503 });
    let page;
    try { page = await this.wait(null, () => this.group.getSingleScreenNotifies(false, '', count), { ...options }); }
    catch { page = await this.wait(null, () => this.group.getSingleScreenNotifies(false, String(count)), { ...options }); }
    const list = Array.isArray(page?.notifies) ? page.notifies
      : Array.isArray(page?.result?.notifies) ? page.result.notifies
      : Array.isArray(page) ? page : [];
    const notifies = list.slice(0, 200).map((item) => {
      const req = this.rememberGroupRequest(item);
      return req ? { ...item, flag: req.flag } : item;
    });
    return { notifies, total: notifies.length, raw: page };
  }

  rememberGroupRequest(item) {
    if (!item || typeof item !== 'object') return null;
    const seq = item.seq !== undefined && item.seq !== null ? String(item.seq) : '';
    const groupCode = item.group?.groupCode ?? item.groupCode ?? item.groupUin;
    if (!seq || groupCode === undefined || groupCode === null) return null;
    const notifyType = Number(item.type ?? 1);
    const subType = notifyType === 2 || notifyType === 12 ? 'invite' : 'add';
    const flag = `${seq}|${String(groupCode)}|${notifyType}`;
    const entry = {
      flag,
      seq,
      groupCode: String(groupCode),
      notifyType,
      subType,
      userUid: String(item.user1?.uid || item.actionUser?.uid || ''),
      comment: typeof item.postscript === 'string' ? item.postscript.slice(0, 500) : '',
      status: Number(item.status ?? 0),
    };
    this.groupRequests.set(flag, entry);
    this.groupRequests.set(seq, entry);
    while (this.groupRequests.size > 1000) {
      this.groupRequests.delete(this.groupRequests.keys().next().value);
    }
    return entry;
  }

  async wakeSession() {
    if (!this.attached) return { awake: false, reason: 'detached' };
    const calls = [];
    const tryCall = async (label, fn) => {
      if (typeof fn !== 'function') return;
      try {
        await Promise.race([Promise.resolve(fn()), delay(2500)]);
        calls.push(label);
      } catch { /* 唤醒调用尽力而为，不抛出 */ }
    };
    await tryCall('switchBackGround', () => this.app?.switchBackGround?.());
    await tryCall('switchForeGround', () => this.app?.switchForeGround?.());
    await tryCall('onLine', () => this.app?.onLine?.());
    await tryCall('startMsgSync', () => this.msg?.startMsgSync?.());
    return { awake: true, invoked: calls };
  }

  async protocolReadiness() {
    const actions = this.capabilities();
    const web = await this.webCgi.readiness();
    return {
      supportedCount: actions.length,
      webAuthReady: web.tipOffPskey || web.ticketClientKey,
      tipOffPskey: web.tipOffPskey,
      ticketClientKey: web.ticketClientKey,
      cachedDomainsCount: web.cachedDomainsCount,
      groupListViaCgi: this.webCgi.hasAuthProvider(),
      groupRequestActionReady: actions.includes('set_group_add_request'),
      ocrReady: actions.includes('ocr_image'),
      qzoneReady: actions.includes('get_qzone_feeds'),
      groupAlbumReady: actions.includes('get_group_album_list'),
      fileUploadReady: actions.includes('upload_group_file'),
    };
  }

  async uploadFileAction(params, isGroup, options) {
    const generation = this.generation;
    const rawFile = params.file.startsWith('file://')
      ? new URL(params.file).pathname
      : params.file;
    let info;
    try { info = await stat(rawFile); } catch {
      throw new BridgeError('FILE_NOT_FOUND', 'Upload source file does not exist', { retcode: 1404 });
    }
    if (!info.isFile() || info.size <= 0 || info.size > MEDIA_SEND_LIMITS.file) {
      throw invalid('Upload file must be a non-empty regular file within size limit');
    }
    const peer = await this.peer(params, isGroup ? 'group' : 'private', options);
    const element = buildFileElement({
      filePath: rawFile,
      fileName: params.name,
      size: String(info.size),
      folderId: isGroup ? (params.folder ?? '') : '',
      groupFile: isGroup,
    });
    return this.sendElements(peer, [element], options, generation);
  }

  async getGroupFileUrlAction(params, options) {
    const code = String(id(params.group_id, 'group_id'));
    const fileId = String(params.file_id || '');
    if (!isGroupFileId(fileId)) throw invalid('Invalid file_id');
    if (typeof this.richMedia?.getGroupFileInfo === 'function') {
      try {
        const info = await this.wait(null, () => this.richMedia.getGroupFileInfo(code, fileId), options);
        const directUrl = info?.fileInfo?.downloadUrl || info?.downloadUrl || info?.url;
        if (typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
          return { url: directUrl };
        }
      } catch { /* fall back to Web CGI cleanly */ }
    }
    if (this.webCgi.hasAuthProvider()) {
      return this.webCgi.getGroupFileUrl(code, fileId, params.busid ?? 102);
    }
    throw new BridgeError('FILE_URL_UNAVAILABLE', 'Unable to resolve group file URL', { retcode: 1404 });
  }

  async decideGroupRequest(params, options) {
    const generation = this.generation;
    const stored = this.groupRequests.get(params.flag);
    const parts = params.flag.split('|');
    const seq = stored?.seq ?? (parts[0] || params.flag);
    const groupCode = stored?.groupCode ?? (parts[1] || '');
    const notifyType = stored?.notifyType ?? (Number(parts[2]) || (params.sub_type === 'invite' ? 2 : 1));
    if (!seq || !/^\d+$/.test(String(groupCode))) {
      throw invalid('Expected a valid group request flag (run get_group_system_msg or supply seq|group_id|type)');
    }
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Group request decision crossed a session change', { retcode: 1503 });
    const operateType = params.approve ? 1 : 2;
    const targetMsg = {
      seq: String(seq),
      type: notifyType,
      groupCode: String(groupCode),
      postscript: params.reason ?? '',
    };
    const fn = typeof this.group?.operateSysNotifyV2 === 'function'
      ? () => this.group.operateSysNotifyV2(false, { operateType, targetMsg })
      : () => this.group.operateSysNotify(false, { operateType, targetMsg });
    const res = await this.wait(null, fn, { ...options, sideEffect: true });
    checkResult(res, true);
    return null;
  }

  async getEssenceMsgList(code, options) {
    const generation = this.generation;
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Essence query crossed a session change', { retcode: 1503 });
    const nativeFn = typeof this.group?.fetchGroupEssenceListV2 === 'function'
      ? () => this.group.fetchGroupEssenceListV2({ groupCode: code, pageStart: 0, pageLimit: 50 })
      : typeof this.group?.fetchGroupEssenceList === 'function'
        ? () => this.group.fetchGroupEssenceList({ groupCode: code, pageStart: 0, pageLimit: 50 })
        : null;
    if (nativeFn) {
      try {
        const res = await this.wait(null, nativeFn, options);
        const list = Array.isArray(res?.msgList) ? res.msgList : Array.isArray(res?.result?.msgList) ? res.result.msgList : null;
        if (list) {
          return list.map((m) => ({
            sender_id: Number(m?.senderUin || 0),
            sender_nick: String(m?.senderNick || ''),
            sender_time: Number(m?.senderTime || 0),
            operator_id: Number(m?.addDigestUin || m?.operatorUin || 0),
            operator_nick: String(m?.addDigestNick || ''),
            operator_time: Number(m?.addDigestTime || 0),
            message_seq: Number(m?.msgSeq || 0),
            message_id: Number(m?.msgRandom || m?.msgSeq || 0),
            content: Array.isArray(m?.elements) ? m.elements : [],
          }));
        }
      } catch { /* fall back to Web CGI cleanly */ }
    }
    if (this.webCgi.hasAuthProvider()) {
      return this.webCgi.getEssenceMsgList(code);
    }
    throw unsupported();
  }

  async setGroupSpecialTitle(params, options) {
    const generation = this.generation;
    const code = String(id(params.group_id, 'group_id'));
    const uid = await this.uid(user(params.user_id), options);
    const title = typeof params.special_title === 'string' ? params.special_title.trim().slice(0, 32) : '';
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Special title crossed a session change', { retcode: 1503 });
    const res = await this.wait(null, () => this.group.setIdentityTitleInfo({
      groupCode: code,
      uid,
      title,
      expireTime: Number.isSafeInteger(Number(params.duration)) ? Number(params.duration) : -1,
    }), { ...options, sideEffect: true });
    checkResult(res, true);
    return null;
  }

  async ocrImageAction(imageRef, options) {
    let tempFile = '';
    let targetPath = imageRef;
    try {
      const isB64 = /^base64:\/\//i.test(imageRef);
      const dataMatch = !isB64 ? /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(imageRef) : null;
      if (isB64 || dataMatch) {
        const b64 = isB64 ? imageRef.slice('base64://'.length) : dataMatch[1];
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length || buf.length > 15 * 1024 * 1024) throw invalid('OCR image exceeds size limit');
        tempFile = path.join(os.tmpdir(), `whale-ocr-${randomBytes(8).toString('hex')}.png`);
        await writeFile(tempFile, buf, { mode: 0o600 });
        targetPath = tempFile;
      } else {
        const st = await stat(imageRef).catch(() => null);
        if (!st || !st.isFile()) throw invalid('OCR image path must be an existing local file or base64:// image');
      }
      const res = await this.wait(null, () => this.richMedia.getScreenOCR(targetPath), { ...options, timeoutMs: 15000 });
      checkResult(res);
      const rawLines = Array.isArray(res?.ocrResult?.textInfos)
        ? res.ocrResult.textInfos
        : Array.isArray(res?.textInfos) ? res.textInfos : [];
      return {
        texts: rawLines.map((line) => ({
          text: String(line?.text ?? ''),
          confidence: Number(line?.confidence ?? 0),
          coordinates: Array.isArray(line?.pt) ? line.pt : [],
        })),
        language: String(res?.ocrResult?.language ?? res?.language ?? ''),
      };
    } finally {
      if (tempFile) await rm(tempFile, { force: true }).catch(() => {});
    }
  }

  async searchLocalMsgs(params, options) {
    const keyword = typeof params.keyword === 'string' ? params.keyword.trim() : '';
    if (!keyword || keyword.length > 200) throw invalid('keyword must be 1 to 200 characters');
    const count = integer(params.count ?? 20, 1, 100, 20);
    const generation = this.generation;
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Local search crossed a session change', { retcode: 1503 });
    if (typeof this.msg?.queryMsgsWithFilterEx === 'function' && (params.group_id !== undefined || params.user_id !== undefined)) {
      const peer = await this.peer(params, params.group_id !== undefined ? 'group' : 'private', options);
      const res = await this.wait(null, () => this.msg.queryMsgsWithFilterEx('0', '0', '0', {
        chatInfo: peer,
        filterMsgType: [],
        filterSendersUid: [],
        filterMsgFromTime: '0',
        filterMsgToTime: '0',
        pageLimit: count,
        isReverseOrder: true,
        isIncludeCurrent: true,
      }), options);
      checkResult(res);
      const msgs = Array.isArray(res?.msgList) ? res.msgList : [];
      const lower = keyword.toLowerCase();
      const matched = [];
      for (const m of msgs) {
        try {
          const translated = this.translate(m);
          if (String(translated.raw_message || '').toLowerCase().includes(lower)) {
            matched.push(translated);
          }
        } catch { /* skip malformed historical item */ }
      }
      return { messages: matched.slice(0, count), total: matched.length };
    }
    if (typeof this.search?.searchMsgWithKeywords === 'function') {
      const res = await this.wait(null, () => this.search.searchMsgWithKeywords(keyword, count), options);
      return { results: res ?? null };
    }
    throw unsupported();
  }

  async getQqAvatar(params) {
    const uin = String(id(params.user_id, 'user_id'));
    const size = [40, 100, 140, 640].includes(Number(params.size)) ? Number(params.size) : 640;
    let localPath = '';
    try {
      const p = await Promise.resolve(this.avatar?.getAvatarPathByUin?.(uin));
      if (typeof p === 'string') localPath = p;
    } catch { /* ignore */ }
    return {
      user_id: Number(uin),
      url: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=${size}`,
      ...(localPath ? { local_path: localPath } : {}),
    };
  }

  async getGroupAvatar(params) {
    const code = String(id(params.group_id, 'group_id'));
    const size = [40, 100, 140, 640].includes(Number(params.size)) ? Number(params.size) : 640;
    let localPath = '';
    try {
      const p = await Promise.resolve(this.avatar?.getGroupAvatarPath?.(code));
      if (typeof p === 'string') localPath = p;
    } catch { /* ignore */ }
    return {
      group_id: Number(code),
      url: `https://p.qlogo.cn/gh/${code}/${code}/${size}`,
      ...(localPath ? { local_path: localPath } : {}),
    };
  }

  async getAiCharacters(code, params, options) {
    const res = await this.wait(null, () => this.group.listAllAIVoice(BigInt(code)), options);
    checkResult(res);
    return { characters: Array.isArray(res?.aiVoiceList) ? res.aiVoiceList : (res?.characters ?? []) };
  }

  /** 陌生人/可疑好友申请（P1，只读）。内核：buddy.getDoubtBuddyReq()。 */
  async doubtFriendRequests(params, options) {
    const generation = this.generation;
    await this.probe();
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Doubt request read crossed a session change', { retcode: 1503 });
    // ★ 实测（2026-11-18）：本机 build 里 buddy.getDoubtBuddyReq() 存在但**永不 resolve**，
    //   若按普通等待会拖成 1502「结果未知」——那会把"能力不存在"说成"结果不确定"，误导对账。
    //   读操作用短超时，超时即明确报 1404（本机不支持），不当未知、也不冻结写闸。
    let page;
    try {
      page = await this.wait(null, () => this.buddy.getDoubtBuddyReq(), { ...options, timeoutMs: 3000 });
    } catch (error) {
      if (error instanceof BridgeError && (error.code === 'TIMEOUT' || error.outcome === 'unknown' || error.code === 'CANCELLED'))
        throw new BridgeError('UNSUPPORTED', 'This native build does not answer getDoubtBuddyReq', { retcode: 1404 });
      throw error;
    }
    const list = Array.isArray(page?.reqs) ? page.reqs
      : Array.isArray(page?.requests) ? page.requests
      : Array.isArray(page?.result?.reqs) ? page.result.reqs : [];
    return { requests: list.slice(0, 200), raw: page };
  }

  async send(params, type, options) {
    const generation = this.generation;
    const peer = await this.peer(params, type, options);
    const elements = await this.elements(params.message, peer, bool(params.auto_escape), options);
    if (peer.chatType === 1 || elements.some(element => element.elementType === 7 || element.textElement?.atType === 2))
      await this.probe();
    return this.sendElements(peer, elements, options, generation);
  }

  async sendForward(action, params, options) {
    const group = Object.hasOwn(params, 'group_id');
    const direct = Object.hasOwn(params, 'user_id');
    const type = group ? 'group' : 'private';
    if (group === direct || (params.message_type !== undefined && params.message_type !== type) ||
        (action !== 'send_forward_msg' && action !== 'send_' + type + '_forward_msg')) {
      throw invalid('Forwarding requires exactly one matching destination');
    }
    if (direct) this.#conversationUser(params.user_id);
    else id(params.group_id, 'group_id');
    const nodes = normalizeMessage(params.messages);
    if (!nodes.length || nodes.length > 100) throw invalid('Forwarding requires 1 to 100 source messages');
    const sources = nodes.map(node => {
      if (node.type !== 'node' || Object.keys(node.data).length !== 1 || !Object.hasOwn(node.data, 'id'))
        throw invalid('Forwarding requires existing message references');
      const raw = this.messages.get(node.data.id);
      this.#conversationUser(raw.senderUin);
      return raw;
    });
    const origin = rawPeer(sources[0]);
    if (sources.some(raw => !peerEqual(origin, rawPeer(raw)))) throw invalid('Forwarded messages must share a source conversation');
    if (type === 'private' && typeof this.group?.getUidByUins !== 'function') throw unsupported();
    const generation = this.generation;
    const peer = await this.peer(params, type, options);
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('CANCELLED', 'Forwarding was cancelled before preparation');
    let started = false;
    try {
      const built = await this.wait(null, () => {
        if (!this.attached || this.generation !== generation) throw new Error('stale');
        started = true;
        return this.msg.buildMultiForwardMsg({ srcMsgIds: sources.map(raw => raw.msgId), srcContact: origin });
      }, { ...options, sideEffect: true });
      boundForwardResponse(built);
      const elements = built?.rspInfo?.elements;
      if (built?.result !== 0 || !Array.isArray(elements) || elements.length !== 1 ||
          elements[0]?.elementType !== 16 || typeof elements[0]?.multiForwardMsgElement?.resId !== 'string' ||
          !elements[0].multiForwardMsgElement.resId) throw new Error('Invalid forward preparation result');
      const snapshot = structuredClone(elements);
      await this.probe();
      if (this.generation !== generation || options.signal?.aborted) throw new Error('stale');
      return await this.sendElements(peer, snapshot, options, generation);
    } catch (error) {
      if (!started) throw error;
      throw new BridgeError('FORWARD_OUTCOME_UNKNOWN', 'Forward preparation or send outcome is uncertain', { retcode: 1502, outcome: 'unknown' });
    }
  }

  async sendElements(peer, elements, options, generation) {
    if (!this.attached || generation !== this.generation || options?.signal?.aborted)
      throw new BridgeError('CANCELLED', 'Send was cancelled before submission');
    if (this.sendIds.size >= this.#maxSendCorrelations)
      throw new BridgeError('SEND_ID_LIMIT', 'Native send identity capacity reached for this session', { retcode: 1503 });
    // Fixed MIT reference apis/msg.ts, sendMessage / confirmSend: first argument
    // is '0'; generated correlation ID travels in peer.guildId, while the final
    // msgId comes from the callback. These IDs must never be interchanged.
    this.lastSendTime = Math.max(Date.now(), this.lastSendTime + 1);
    if (!Number.isSafeInteger(this.lastSendTime)) throw invalid('Send timestamp exhausted');
    const requestId = this.msg.generateMsgUniqueId(peer.chatType, String(this.lastSendTime));
    if (typeof requestId !== 'string' || !/^[1-9]\d{0,127}$/.test(requestId)) throw invalid('Native correlation ID generation failed');
    const sendKey = `${peerKey(peer)}:${requestId}`;
    if (this.sendIds.has(sendKey)) throw new BridgeError('DUPLICATE_NATIVE_ID', 'Native message ID was already used in this session', { retcode: 1503 });
    this.sendIds.add(sendKey);
    let reducedReceipt = false;
    const submittedAt = Date.now();
    let raw;
    try {
      raw = await this.wait(`sent:${sendKey}`, () => {
        if (!this.attached || generation !== this.generation) throw new Error('stale');
        return this.msg.sendMsg('0', { ...peer, guildId: requestId }, elements, new Map());
      }, { ...options, sideEffect: true, timeoutMs: SEND_ACCEPT_WAIT_MS, snapshotReceipt: receipt => {
      try {
        boundForwardResponse(receipt);
        const snapshot = structuredClone(receipt);
        this.stats.sendReceiptsSnapshotted++;
        return snapshot;
      } catch {
        // The native callback may carry data outside the supported message
        // shape. Preserve only the own scalar fields needed to confirm it.
        const field = key => Object.getOwnPropertyDescriptor(receipt, key)?.value;
        const sendStatus = field('sendStatus');
        const msgId = field('msgId');
        const senderUin = field('senderUin');
        const senderUid = field('senderUid');
        if (![0, 2, 3].includes(sendStatus) || (senderUin !== BOT && senderUin !== Number(BOT)) ||
            field('chatType') !== peer.chatType || field('peerUid') !== peer.peerUid ||
            field('guildId') !== requestId ||
            (sendStatus !== 0 && (!isNativeMessageId(msgId) || msgId === requestId))) {
          this.stats.sendReceiptsInvalid++;
          throw forwardInvalid();
        }
        this.stats.sendReceiptsReduced++;
        reducedReceipt = true;
        return { ...peer, guildId: requestId, msgId: isNativeMessageId(msgId) ? msgId : undefined,
          senderUin, ...(typeof senderUid === 'string' && { senderUid }), sendStatus, elements: [] };
      }
      } });
    } catch (error) {
      // 回执超时 ≠ 没发出去。实测消息常常已经落库，只是回执回得比等待窗口晚（约 29s）。
      // ① 先做**只读对账**（绝不重发）：能在本会话消息索引里认出自己那一条，就把 message_id 交回去。
      // ② 认不出来时**不再 fail closed**：等满窗口意味着运行端多半已经先超时把它记成 unknown，
      //    那会让整个会话被 held 闸门永久挡住（这就是"活跃几个小时后突然不回话"的真因）。
      //    这里按「原生 sendMsg 已被接受」回一个临时成功（message_id=null）：
      //    运行端 store.finishSend 会落成 state='sent'（core/store.js:935-939），会话不被挡住。
      if (error instanceof BridgeError && error.outcome === 'unknown') {
        this.stats.sendReceiptTimeouts++;
        const reconciled = await this.reconcileSentMessage(peer, requestId, elements, submittedAt);
        if (reconciled !== undefined) {
          this.stats.sendReceiptsReconciled++;
          return { message_id: reconciled };
        }
        this.stats.sendProvisionalAcks++;
        console.warn('[send] 回执未在 ' + SEND_ACCEPT_WAIT_MS + 'ms 内返回，按已接受处理'
          + '（对账没认出 message_id；不重发，交由上层记账）: ' + peerKey(peer));
        return { message_id: null };
      }
      throw error;
    }
    try {
      await this.probe();
      if (!this.attached || generation !== this.generation || options?.signal?.aborted) throw new Error('stale');
    } catch {
      this.stats.sendReceiptIdentityFailures++;
      throw new BridgeError('STALE_SESSION', 'Send confirmation crossed a session change; do not retry automatically', { retcode: 1502, outcome: 'unknown' });
    }
    if (raw.sendStatus === 0) throw new BridgeError('SEND_FAILED', 'Native send failed', { retcode: 1500, outcome: 'rejected' });
    try {
      if (typeof raw.msgId !== 'string' || !/^[1-9]\d{0,127}$/.test(raw.msgId)) throw new Error('missing final message ID');
      const existing = reducedReceipt ? this.messages.find(peer, raw.msgId) : undefined;
      if (existing !== undefined && String(this.messages.get(existing).senderUin) !== BOT)
        throw forwardInvalid();
      const message_id = existing ?? this.messages.put(raw);
      this.stats.sendReceiptsIndexed++;
      return { message_id };
    }
    catch {
      this.stats.sendReceiptIndexFailures++;
      throw new BridgeError('RESPONSE_UNAVAILABLE', 'Native send completed but its response could not be represented; do not retry automatically', { retcode: 1502, outcome: 'unknown' });
    }
  }

  async call(action, params = {}, options = {}) {
    if (!this.attached) throw new BridgeError('OFFLINE', 'Native bridge is detached', { retcode: 1503 });
    const generation = this.generation;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
    if (options.signal?.aborted) throw new BridgeError('CANCELLED', 'Request cancelled');
    await this.probe();
    if (!this.attached || generation !== this.generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Action crossed a session change before submission', { retcode: 1503 });
    if (!this.capabilities().includes(action)) throw unsupported();
    const invoke = (fn, sideEffect = false) => this.wait(null, fn, { ...options, sideEffect });
    const groupCode = () => id(params.group_id, 'group_id');
    switch (action) {
      case 'get_login_info': return { user_id: Number(BOT), nickname: this.identity.nickname };
      case 'send_group_msg': return this.send(params, 'group', options);
      case 'send_private_msg': return this.send(params, 'private', options);
      case 'send_msg': case 'send_message': return this.send(params, params.message_type ?? (params.group_id !== undefined ? 'group' : 'private'), options);
      case 'send_forward_msg': case 'send_group_forward_msg': case 'send_private_forward_msg': return this.sendForward(action, params, options);
      case 'set_input_status': return this.setInputStatus(params, options);
      case 'set_online_status': return this.setOnlineStatus(params, options);
      case 'friend_poke': case 'group_poke': return this.sendNudge(action, params, options);
      case 'get_group_honor_info': return this.getGroupHonor(groupCode(), options);
      case 'set_qq_avatar': return this.setAvatar(params, options);
      case 'add_custom_face': return this.addCustomFace(params, options);
      case 'get_profile_like': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.getProfileLikes(request, options, generation);
      }
      case 'send_like': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        const friendUid = await this.uid(request.user_id, options);
        if (await invoke(() => this.buddy.isBuddy(friendUid)) !== true)
          throw new BridgeError('FRIEND_REQUIRED', 'Profile likes require a verified friend', { retcode: 1404 });
        await this.probe();
        if (!this.attached || this.generation !== generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Like request crossed a session change before submission', { retcode: 1503 });
        const receipt = await invoke(() => this.profileLike.setBuddyProfileLike({
          friendUid, sourceId: 71, doLikeCount: request.times, doLikeTollCount: 0,
        }), true);
        const unknown = () => new BridgeError('UNCONFIRMED', 'Native profile like count was not confirmed',
          { retcode: 1502, outcome: 'unknown' });
        if (!Number.isSafeInteger(receipt?.result) || !Number.isSafeInteger(receipt?.succCounts)) throw unknown();
        if (receipt.result !== 0 && receipt.succCounts === 0) checkResult(receipt, true);
        if (receipt.result !== 0 || receipt.succCounts !== request.times) throw unknown();
        try {
          await this.probe();
          if (!this.attached || this.generation !== generation || options.signal?.aborted) throw unknown();
        } catch { throw unknown(); }
        return null;
      }
      case 'get_forward_msg': {
        let request;
        try { request = validateParams(action, params); } catch { throw invalid('Expected a valid forward reference'); }
        if (request.id !== undefined) return this.getForward(request.id, options);
        const outer = this.messages.get(request.message_id);
        const elements = outer.elements.filter(element => element.elementType === 16 &&
          typeof element.multiForwardMsgElement?.resId === 'string' && element.multiForwardMsgElement.resId);
        if (elements.length !== 1) throw new BridgeError('FORWARD_NOT_FOUND', 'Expected one forward on the indexed outer message', { retcode: 1404 });
        return this.getForward(this.rememberForward(outer, elements[0].multiForwardMsgElement.resId), options);
      }
      case 'get_group_msg_history': return this.getHistory(params, 'group', options);
      case 'get_friend_msg_history': return this.getHistory(params, 'private', options);
      case 'fetch_ptt_text': return this.fetchPttText(params.message_id, options, generation);
      case 'get_recent_contact': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.getRecentContacts(request.count, options, generation);
      }
      case 'get_image': return this.readIndexedImage(params, options);
      case 'get_record': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.readIndexedRecord(request, options);
      }
      case 'get_message_videos': return this.getMessageVideos(params, options);
      case 'get_file': return this.readIndexedFile(params, options);
      case 'get_message_images':
      case 'get_message_audio': {
        const messageId = params.message_id;
        if (!isOneBotMessageId(messageId))
          throw invalid('Expected a current-session OneBot message ID');
        const indexed = this.messages.byId.get(Number(messageId));
        if (!indexed) throw new BridgeError('MESSAGE_NOT_FOUND', 'Message ID expired or belongs to another session', { retcode: 1404 });
        const type = action === 'get_message_images' ? 2 : 4;
        const elements = await this.readIndexedMediaElements(indexed, type, options);
        return elements.map(mediaSegment).filter(Boolean);
      }
      case 'get_msg':
      case 'fetch_emoji_like':
      case 'get_emoji_likes':
      case 'get_msg_emoji_likes': {
        let aggregate;
        if (action === 'get_emoji_likes') {
          try { aggregate = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        }
        const nativeReference = aggregate && BigInt(aggregate.message_id) > BigInt(MAX_ID);
        if (nativeReference && !aggregate.group_id) throw invalid('A native message ID requires group_id');
        const indexId = nativeReference
          ? this.messages.find({ chatType: 2, peerUid: aggregate.group_id, guildId: '' }, aggregate.message_id)
          : Number(params.message_id);
        const known = indexId === undefined
          ? { chatType: 2, peerUid: aggregate.group_id, msgId: aggregate.message_id }
          : this.messages.get(nativeReference ? indexId : params.message_id);
        const indexed = this.messages.byId.get(indexId);
        const sender = indexed ? this.#conversationUser(known.senderUin) : undefined;
        const peer = rawPeer(known);
        if (action !== 'get_msg' && known.chatType !== 2)
          throw invalid('Reactions are only available for group messages');
        if (aggregate?.group_id !== undefined && aggregate.group_id !== peer.peerUid)
          throw invalid('group_id does not match the indexed message');
        const reaction = action === 'fetch_emoji_like'
          ? this.reactionRequest(params, indexId, known.msgId) : null;
        const raw = await invoke(() => this.msg.getMsgsByMsgId({ ...peer }, [known.msgId]));
        let match;
        if (action === 'get_msg') {
          match = selectMessageReadback(raw, peer, known.msgId);
        } else {
          boundForwardResponse(raw);
          checkResult(raw);
          if (!Array.isArray(raw.msgList)) throw forwardInvalid();
          const matches = raw.msgList.filter(entry => entry?.msgId === known.msgId &&
            entry.chatType === peer.chatType && entry.peerUid === peer.peerUid);
          if (matches.length > 1) throw forwardInvalid();
          [match] = matches;
        }
        if (!match)
          throw new BridgeError('MESSAGE_NOT_FOUND', 'Native message was not found', { retcode: 1404 });
        if (action === 'get_msg' && sender === BOT) match = bindSelfSender(match, this.identity);
        if (!match) throw forwardInvalid();
        if ((indexed && String(match.senderUin) !== sender) ||
            (known.senderUid && match.senderUid !== known.senderUid))
          throw forwardInvalid();
        if (aggregate) this.#conversationUser(match.senderUin);
        const message = structuredClone(match);
        await this.probe();
        if (options.signal?.aborted || !this.attached || generation !== this.generation) throw new BridgeError('STALE_SESSION', 'Message query crossed a session change', { retcode: 1503 });
        if (this.messages.byId.get(indexId) !== indexed)
          throw new BridgeError('MESSAGE_NOT_FOUND', 'Indexed message changed during query', { retcode: 1404 });
        if (aggregate) return this.collectEmojiLikes({ ...aggregate, indexId }, peer, message, indexed, generation, options);
        if (reaction) return this.fetchReactionPage(reaction, peer, message, indexed, generation, options);
        if (action === 'get_msg_emoji_likes') {
          const totals = reactionSummary(message.emojiLikesList);
          if (typeof this.msg.getMsgEmojiLikesList !== 'function' || typeof this.group?.getAllMemberList !== 'function' ||
              !isReactionSequence(message.msgSeq) || !totals.slice(0, 10).some(entry => entry.count > 0 && entry.count <= 150)) return totals;
          return this.readReactionResponders(totals, indexId, peer, message, indexed, generation, options);
        }
        // Reading one message is the App's "let me actually look at this picture"
        // path, so paying a bounded native download here is affordable; the inbound
        // event path stays untouched and fast.
        const inline = await this.inlinePictureData(message, peer, options);
        if (inline.size) message.elements.forEach((element, index) => {
          const data = inline.get(index);
          if (data !== undefined && element) element.inlineUrl = data;
        });
        if (!inline.size) await this.resolveRkeyUrls(message.elements, options);
        const translated = this.translate(message);
        if (typeof message.msgSeq === 'string' && /^[1-9]\d{0,18}$/.test(message.msgSeq) && BigInt(message.msgSeq) <= 9223372036854775807n) translated.message_seq = message.msgSeq;
        return translated;
      }
      case 'delete_msg': {
        const known = this.messages.get(params.message_id);
        checkResult(await invoke(() => this.msg.recallMsg(rawPeer(known), [known.msgId]), true), true);
        return null;
      }
      case 'mark_msg_as_read':
      case 'mark_group_msg_as_read':
      case 'mark_private_msg_as_read': return this.markRead(action, params, options);
      case 'set_msg_emoji_like': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        const known = this.messages.get(request.message_id);
        if (known.chatType !== 2) throw invalid('Reactions are only available for group messages');
        const sender = this.#conversationUser(known.senderUin);
        const indexed = this.messages.byId.get(request.message_id);
        const peer = rawPeer(known);
        const raw = await invoke(() => this.msg.getMsgsByMsgId({ ...peer }, [known.msgId]));
        const matched = findMessageReadback(raw, peer, known.msgId);
        if (!matched) throw new BridgeError('MESSAGE_NOT_FOUND', 'Native message was not found', { retcode: 1404 });
        const sequence = readOwnMessageField(matched, 'msgSeq');
        if (readOwnMessageField(matched, 'senderUin') !== sender ||
            (known.senderUid && readOwnMessageField(matched, 'senderUid') !== known.senderUid) ||
            !isReactionSequence(sequence)) throw forwardInvalid();
        const current = () => this.attached && generation === this.generation && !options.signal?.aborted;
        await this.probe();
        if (!current()) throw new BridgeError('STALE_SESSION', 'Reaction target crossed a session change', { retcode: 1503 });
        const unchanged = () => this.messages.byId.get(request.message_id) === indexed;
        if (!unchanged()) throw new BridgeError('MESSAGE_NOT_FOUND', 'Indexed message changed during query', { retcode: 1404 });
        const { emoji_id: emoji, set } = request;
        const result = await this.wait(null, () => this.msg.setMsgEmojiLikes(peer, sequence, emoji, emoji.length > 3 ? '2' : '1', set),
          { ...options, sideEffect: true, shouldSubmit: () => current() && unchanged() });
        checkResult({ result: Object.getOwnPropertyDescriptor(result ?? {}, 'result')?.value }, true);
        try {
          await this.probe();
          if (!current()) throw forwardInvalid();
        } catch {
          throw new BridgeError('UNCONFIRMED', 'Reaction confirmation crossed a session change', { retcode: 1502, outcome: 'unknown' });
        }
        return null;
      }
      case 'get_group_list': {
        return this.readGroupList(bool(params.no_cache), options);
      }
      case 'get_group_root_files':
      case 'get_group_files_by_folder': {
        return this.getGroupFiles(validateParams(action, params), options);
      }
      case 'get_group_file_system_info': return this.getGroupFileSystemInfo(groupCode(), options);
      case 'delete_group_file':
      case 'move_group_file': return this.changeGroupFile(validateParams(action, params), options);
      case 'create_group_file_folder': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.createGroupFolder(String(request.group_id), request.folder_name, options);
      }
      case 'delete_group_folder': {
        const { group_id, folder_id } = validateParams(action, params);
        const response = await this.wait(null, () => this.richMedia.deleteGroupFolder(String(group_id), folder_id),
          { ...options, sideEffect: true });
        checkResult(response, true);
        checkResult(response.groupFileCommonResult, true, 'retCode');
        try {
          await this.probe();
          if (generation !== this.generation || options.signal?.aborted) throw new Error('stale');
        } catch {
          throw new BridgeError('STALE_SESSION', 'Folder deletion crossed a session change', { retcode: 1502, outcome: 'unknown' });
        }
        return { retCode: 0, retMsg: '', clientWording: '' };
      }
      case 'get_group_shut_list': return this.readGroupMutedMembers(groupCode(), options);
      case 'get_group_info_ex': {
        const code = groupCode();
        const generation = this.generation;
        const filter = Object.fromEntries(groupExtensionFields.map(field => [field, 1]));
        const response = await invoke(() => this.group.getGroupExt0xEF0Info([code], [], filter, true));
        boundForwardResponse(response);
        if (Object.hasOwn(response ?? {}, 'errCode')) checkResult(response, false, 'errCode');
        const groups = response?.result?.groupExtInfos;
        if (!(groups instanceof Map)) throw forwardInvalid();
        const group = Map.prototype.get.call(groups, code);
        if (group?.groupCode !== code) throw forwardInvalid();
        checkResult(group, false, 'resultCode');
        const info = {};
        for (const field of groupExtensionFields) {
          if (!Object.hasOwn(group.extInfo ?? {}, field)) continue;
          const value = group.extInfo[field];
          if (!Number.isSafeInteger(value)) throw forwardInvalid();
          info[field] = value;
        }
        if (!Object.keys(info).length) throw forwardInvalid();
        await this.probe();
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Extended group query crossed a session change', { retcode: 1503 });
        return { groupCode: code, resultCode: 0, extInfo: info };
      }
      case 'get_group_share_link': {
        let request;
        try { request = validateParams(action, params); }
        catch { throw invalid('Invalid group share link parameters'); }
        const generation = this.generation;
        const response = await invoke(() => this.group.getJoinGroupLink({ groupCode: String(request.group_id),
          needShortUrl: request.need_short_url, srcId: request.src_id, additionalParam: request.additional_param }));
        boundForwardResponse(response);
        checkResult(response);
        const url = response.url;
        if (typeof url !== 'string' || url.length > 4096 || /[\\\x00-\x20\x7f]/.test(url)) throw forwardInvalid();
        const parsed = URL.parse(url);
        const isGroupShare = parsed && (
          (parsed.hostname === 'qm.qq.com' && /^\/q\/[^/]+$/.test(parsed.pathname)) ||
          (parsed.hostname === 'qun.qq.com' && parsed.pathname === '/universal-share/share'));
        if (!isGroupShare || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash)
          throw forwardInvalid();
        await this.probe();
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Group share link crossed a session change', { retcode: 1503 });
        return { url };
      }
      case 'get_group_at_all_remain': {
        const code = groupCode();
        const generation = this.generation;
        const result = await invoke(() => this.group.getGroupRemainAtTimes(code));
        boundForwardResponse(result);
        checkResult(result, false, 'errCode');
        const info = result.atInfo;
        if (typeof info?.canAtAll !== 'boolean' ||
            ![info.RemainAtAllCountForGroup, info.RemainAtAllCountForUin]
              .every(count => Number.isSafeInteger(count) && count >= 0)) throw forwardInvalid();
        const remaining = {
          can_at_all: info.canAtAll,
          remain_at_all_count_for_group: info.RemainAtAllCountForGroup,
          remain_at_all_count_for_uin: info.RemainAtAllCountForUin,
        };
        await this.probe();
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Group mention quota crossed a session change', { retcode: 1503 });
        return remaining;
      }
      case 'fetch_custom_face': {
        const { count } = validateParams(action, params);
        const generation = this.generation;
        const result = await invoke(() => this.msg.fetchFavEmojiList('', count, true, true));
        boundForwardResponse(result);
        checkResult(result);
        if (!Array.isArray(result.emojiInfoList) || result.emojiInfoList.length > count) throw forwardInvalid();
        const urls = result.emojiInfoList.map(entry => {
          const url = entry?.url;
          if (typeof url !== 'string' || url.length > 4096 || /[\\\x00-\x20\x7f]/.test(url))
            throw forwardInvalid();
          const parsed = URL.parse(url);
          if (parsed?.protocol !== 'https:' || parsed.username || parsed.password) throw forwardInvalid();
          return url;
        });
        await this.probe();
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Face query crossed a session change', { retcode: 1503 });
        return urls;
      }
      case 'translate_en2zh': {
        const { words } = validateParams(action, params);
        const generation = this.generation;
        const result = await invoke(() => this.richMedia.translateEnWordToZn(words));
        boundForwardResponse(result);
        checkResult(result);
        if (!Array.isArray(result.words) || result.words.length !== words.length ||
            result.words.some(word => typeof word !== 'string' || Buffer.byteLength(word) > 8192))
          throw forwardInvalid();
        const translated = [...result.words];
        await this.probe();
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Translation crossed a session change', { retcode: 1503 });
        return { words: translated };
      }
      case 'get_robot_uin_range': {
        if (Object.keys(params).length !== 0) throw invalid('Robot UIN range query takes no parameters');
        const result = await invoke(() => this.robot.getRobotUinRange({
          justFetchMsgConfig: '1', type: 1, version: 0, aioKeywordVersion: 0,
        }));
        boundForwardResponse(result);
        if (Object.hasOwn(result ?? {}, 'result')) checkResult(result);
        const ranges = result?.response?.robotUinRanges;
        if (!Array.isArray(ranges) || ranges.length > 256) throw forwardInvalid();
        const validEndpoint = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) &&
          BigInt(value) <= 18446744073709551615n;
        const projected = Array.from(ranges, range => {
          const { minUin, maxUin } = range ?? {};
          if (!validEndpoint(minUin) || !validEndpoint(maxUin) || BigInt(minUin) > BigInt(maxUin)) throw forwardInvalid();
          return { minUin, maxUin };
        });
        await this.probe();
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Robot UIN range query crossed a session change', { retcode: 1503 });
        return projected;
      }
      case 'get_group_info': {
        const code = groupCode();
        const g = await this.readGroupDetail(code, options, 1);
        const members = integer(g.memberNum, 0, MAX_ID, 0);
        const mute = g.shutUpAllTimestamp;
        return { group_id: Number(code), group_name: text(g.groupName ?? '', 'group_name'),
          member_count: members, max_member_count: integer(g.maxMemberNum, members, MAX_ID, members),
          ...(Number.isSafeInteger(mute) && mute >= 0 && { group_all_shut: mute > 0 ? -1 : 0 }) };
      }
      case 'get_group_detail_info': {
        const code = groupCode();
        const group = await this.readGroupDetail(code, options);
        const memberCount = integer(group.memberNum, 0, MAX_ID);
        const capacity = integer(group.maxMemberNum, memberCount, MAX_ID);
        const result = { group_id: Number(code), group_name: text(group.groupName, 'group_name'),
          member_count: memberCount, max_member_count: capacity };
        if (group.groupMemo !== undefined) result.group_memo = text(group.groupMemo, 'group_memo', 16384);
        if (group.remarkName !== undefined) result.group_remark = text(group.remarkName, 'group_remark');
        if (group.shutUpAllTimestamp !== undefined) {
          const timestamp = group.shutUpAllTimestamp;
          if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw invalid('Invalid group mute timestamp');
          result.group_all_shut = timestamp > 0 ? -1 : 0;
        }
        return result;
      }
      case 'set_group_remark': {
        const code = groupCode();
        const desired = text(params.remark, 'remark', 256);
        const generation = this.generation;
        const acknowledgment = await invoke(() => this.group.modifyGroupRemark(code, desired), true);
        checkResult(acknowledgment, true);
        try {
          const group = await this.readGroupDetail(code, options);
          if (group.remarkName !== desired) throw new Error('Remark mismatch');
          await this.probe();
          if (!this.attached || this.generation !== generation || options.signal?.aborted)
            throw new Error('Session changed');
        } catch {
          throw new BridgeError('UNCONFIRMED', 'Group remark readback did not confirm the submitted change',
            { retcode: 1502, outcome: 'unknown' });
        }
        return null;
      }
      case 'get_group_member_list': return this.members(groupCode(), options, bool(params.no_cache));
      case 'get_group_member_info': {
        const wanted = this.#conversationUser(params.user_id);
        const code = groupCode();
        const fresh = bool(params.no_cache);
        let member = (await this.members(code, options, fresh)).find(m => String(m.user_id) === wanted);
        if (!member && !fresh)
          member = (await this.refreshMembersAfterCacheMiss(code, options.signal)).find(m => String(m.user_id) === wanted);
        if (!member) throw new BridgeError('MEMBER_NOT_FOUND', 'Group member was not found', { retcode: 1404 });
        return member;
      }
      case 'get_friend_list': return this.getFriendList(params, options);
      case 'get_friends_with_category': return this.getFriendList(params, options, true);
      case 'set_friend_remark': return this.setFriendRemark(params, options);
      case 'set_friend_add_request': return this.decideFriendRequest(validateParams(action, params), options);
      case 'set_self_longnick': return this.setSelfLongNick(params, options);
      case 'set_qq_profile': return this.setSelfProfile(validateParams(action, params), options);
      case 'get_stranger_info': {
        const wanted = this.#conversationUser(params.user_id);
        if (bool(params.no_cache)) throw unsupported();
        const generation = this.generation;
        const detail = await this.readUserDetail(wanted, options);
        const core = detail.simpleInfo?.coreInfo;
        const base = detail.simpleInfo?.baseInfo;
        const result = {
          user_id: Number(wanted),
          nickname: text(core?.nick ?? '', 'nickname'),
          sex: base?.sex === 1 ? 'male' : base?.sex === 2 ? 'female' : 'unknown',
          age: integer(base?.age, 0, 255, 0),
        };
        if (base?.longNick !== undefined) result.long_nick = text(base.longNick, 'signature');
        if (core?.remark !== undefined) result.remark = text(core.remark, 'remark');
        // 官方亲密度：内核的 SimpleInfo 里本来就带 `intimate`（类型定义 user.ts:218），
        // 这份数据随 get_stranger_info 一起回来了 —— 不用另开一次内核调用。
        // 形状未在本机实测过，所以只放标量、限键数与长度，别把未知结构原样透出去。
        const intimate = boundedPrimitives(detail.simpleInfo?.intimate);
        if (intimate) result.intimate = intimate;
        await this.probe();
        if (!this.attached || this.generation !== generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Profile query crossed a session change', { retcode: 1503 });
        return result;
      }
      case 'set_group_whole_ban': {
        const code = groupCode(), enable = bool(params.enable, true);
        return this.confirmMute(() => this.group.setGroupShutUp(code, enable), options, this.generation);
      }
      case 'set_group_ban': {
        const generation = this.generation;
        const code = groupCode(), uid = await this.uid(params.user_id, options);
        const duration = integer(params.duration, 0, 2592000, 1800);
        await this.probe();
        if (!this.attached || this.generation !== generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Mute request crossed a session change before submission', { retcode: 1503 });
        return this.confirmMute(() => this.group.setMemberShutUp(code, [{ uid, timeStamp: duration }]), options, generation);
      }
      case 'get_group_notice': return this.groupNotices(params, options);
      case 'send_group_notice': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.sendGroupNotice(request, options);
      }
      case 'del_group_notice': return this.deleteGroupNotice(params, options);
      case 'get_group_system_msg': return this.groupSystemMessages(params, options);
      case 'get_doubt_friends_add_request': return this.doubtFriendRequests(params, options);
      case 'debug_native_surface': {
        // 只返回**方法名**，不返回实现、不返回值、不含任何账号数据。
        const surface = {};
        for (const [label, service] of [['msg', this.msg], ['group', this.group], ['buddy', this.buddy],
          ['profile', this.profile], ['richMedia', this.richMedia], ['uix', this.uix]]) {
          if (!service) { surface[label] = null; continue; }
          const names = [];
          for (const key in service) { try { if (typeof service[key] === 'function') names.push(key); } catch {} }
          let proto = [];
          try { proto = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(n => n !== 'constructor'); } catch {}
          surface[label] = [...new Set([...names, ...proto])].sort();
        }
        // 哪些可选服务在这台机的 QQ build 上真的挂得出来（只报存在性 + 方法名）。
        // 用途：决定「群公告写 / pskey / 群文件上传」这类还差一条内核通道的动作能不能做 ——
        // 没有证据就上，等于把 1404 换成一个更难查的失败。
        const services = {};
        for (const getter of SESSION_SERVICE_PROBES) {
          let value;
          try { value = this.session?.[getter]?.(); } catch { value = undefined; }
          if (!value) { services[getter] = false; continue; }
          const names = new Set();
          try { for (const key in value) { if (typeof value[key] === 'function') names.add(key); } } catch {}
          try { for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(value))) if (name !== 'constructor') names.add(name); } catch {}
          services[getter] = [...names].sort();
        }
        return { ...surface, services };
      }
      /**
       * 历史读取的诊断探针（只读、无副作用、不发任何消息）。
       *
       * 存在的理由：`wait()` 把「超时 / 原生调用抛错 / 取消」都归成同一句
       * 「Native query did not complete」，于是 `get_group_msg_history` 在真机上恒 1502
       * 却查不出到底卡在哪一步（真机日志里这一条 886 次，是最高频的失败）。
       * 这里**绕开 wait()**，直接 await 内核 Promise，把耗时、错误名、返回外形原样报出来。
       */
      case 'debug_history_probe': {
        const code = String(id(params.group_id, 'group_id'));
        const count = integer(params.count ?? 20, 1, 50, 20);
        const peer = { chatType: 2, peerUid: code, guildId: '' };
        const out = { peer: { chatType: peer.chatType, peerUid: peer.peerUid }, count };
        const startedAt = Date.now();
        try {
          const value = await Promise.race([
            this.msg.getAioFirstViewLatestMsgs({ ...peer }, count),
            new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 25000)),
          ]);
          out.elapsedMs = Date.now() - startedAt;
          if (value === '__timeout__') { out.stage = 'timeout'; return out; }
          out.stage = 'resolved';
          out.result = typeof value?.result === 'number' ? value.result : null;
          out.needContinueGetMsg = typeof value?.needContinueGetMsg;
          out.msgListLength = Array.isArray(value?.msgList) ? value.msgList.length : null;
          out.keys = Object.keys(value ?? {}).slice(0, 16);
          // 把每条消息的**校验相关字段**原样报出来（id/seq/会话/元素类型），
          // 这样「哪一条过不了哪一条校验」不用猜。
          out.rows = (Array.isArray(value?.msgList) ? value.msgList : []).slice(0, 10).map((raw) => ({
            msgId: String(raw?.msgId), msgSeq: String(raw?.msgSeq), chatType: raw?.chatType,
            peerUid: String(raw?.peerUid), msgTime: String(raw?.msgTime),
            senderUin: String(raw?.senderUin ?? ''),
            elementTypes: Array.isArray(raw?.elements) ? raw.elements.map((e) => e?.elementType) : null,
          }));
          // ★ 关键一步：直接跑我们自己的 getHistory，把**原始错误**报出来。
          //   core 在 reading 分支会用 READ_FAILURES 表把措辞统一成
          //   「Native query did not complete」，真因（哪一步抛的、什么码）会被盖掉。
          try {
            const mapped = await this.getHistory({ group_id: code, count }, 'group', {});
            out.getHistory = { ok: true, messages: mapped?.messages?.length ?? null };
          } catch (error) {
            out.getHistory = { ok: false, name: String(error?.name ?? ''), code: String(error?.code ?? ''),
              retcode: error?.retcode ?? null, outcome: error?.outcome ?? null,
              message: String(error?.message ?? error).slice(0, 300),
              stack: String(error?.stack ?? '').split('\n').slice(1, 5).join(' | ').slice(0, 400) };
          }
        } catch (error) {
          out.elapsedMs = Date.now() - startedAt;
          out.stage = 'threw';
          out.errorName = String(error?.name ?? '');
          out.errorMessage = String(error?.message ?? error).slice(0, 300);
        }
        return out;
      }
      /**
       * 合并转发诊断（只读）：真机上 `get_forward_msg` 对真实转发恒 1500，
       * 日志里 `read_forward 1500 ×15` + 「展开合并转发失败」176 次就是它。
       * 这里对同一条转发逐个试内核方法（getMultiMsg / fetchLongMsg / fetchLongMsgWithCb），
       * 把每个的耗时、错误、返回外形原样报出来 —— 决定该用哪条。
       */
      case 'debug_forward_probe': {
        const code = String(id(params.group_id, 'group_id'));
        const messageId = Number(params.message_id);
        const indexed = this.messages.byId.get(messageId);
        const out = { group_id: code, message_id: messageId, indexed: Boolean(indexed) };
        if (!indexed) return out;
        const peer = rawPeer(indexed.raw);
        const known = indexed.raw;
        out.peer = { chatType: peer.chatType, peerUid: peer.peerUid };
        const outerElements = Array.isArray(known.elements) ? known.elements : [];
        const forwardElement = outerElements.find((element) => element?.elementType === 16 && element.multiForwardMsgElement?.resId);
        out.resId = forwardElement?.multiForwardMsgElement?.resId ?? null;
        const attempt = async (label, factory) => {
          const startedAt = Date.now();
          try {
            const value = await Promise.race([factory(),
              new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 25000))]);
            if (value === '__timeout__') return { label, stage: 'timeout', ms: Date.now() - startedAt };
            return { label, stage: 'resolved', ms: Date.now() - startedAt,
              result: typeof value?.result === 'number' ? value.result : null,
              errCode: typeof value?.errCode === 'number' ? value.errCode : null,
              msgListLength: Array.isArray(value?.msgList) ? value.msgList.length : null,
              keys: Object.keys(value ?? {}).slice(0, 16) };
          } catch (error) {
            return { label, stage: 'threw', ms: Date.now() - startedAt,
              name: String(error?.name ?? ''), message: String(error?.message ?? error).slice(0, 240) };
          }
        };
        // ★ NapCat 的签名是 getMultiMsg(peer, rootMsgId, parentMsgId)（apis/msg.ts:45-48）。
        //   我们此前传的第三参是 multiForwardMsgElement.resId —— 语义对不上，所以先按置换逐个试。
        const permutations = [];
        const resId = out.resId ?? '';
        const msgIdText = typeof known.msgId === 'string' ? known.msgId : String(known.msgId ?? '');
        for (const [label, root, parent] of [
          ['root=msgId parent=""', msgIdText, ''],
          ['root=msgId parent=resId', msgIdText, resId],
          ['root=resId parent=""', resId, ''],
          ['root=resId parent=msgId', resId, msgIdText],
        ]) {
          if (!root) continue;
          const startedAt = Date.now();
          try {
            const page = await Promise.race([
              this.msg.getMultiMsg({ ...peer }, root, parent),
              new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 12000)),
            ]);
            permutations.push(page === '__timeout__'
              ? { label, stage: 'timeout', ms: Date.now() - startedAt }
              : { label, stage: 'resolved', ms: Date.now() - startedAt,
                  result: typeof page?.result === 'number' ? page.result : null,
                  errMsg: typeof page?.errMsg === 'string' ? page.errMsg.slice(0, 100) : null,
                  msgListLength: Array.isArray(page?.msgList) ? page.msgList.length : null });
          } catch (error) {
            permutations.push({ label, stage: 'threw', ms: Date.now() - startedAt,
              message: String(error?.message ?? error).slice(0, 160) });
          }
        }
        out.permutations = permutations;
        const tries = [];
        if (this.msg?.getMultiMsg) {
          tries.push(await attempt('getMultiMsg(peer, msgId, resId)', () => this.msg.getMultiMsg({ ...peer }, known.msgId, out.resId ?? '')));
        }
        if (this.msg?.fetchLongMsg && typeof known.msgId === 'string') {
          tries.push(await attempt('fetchLongMsg(peer, msgId)', () => this.msg.fetchLongMsg({ ...peer }, known.msgId)));
        }
        if (this.msg?.fetchLongMsgWithCb) {
          tries.push(await attempt('fetchLongMsgWithCb(peer, Number(msgId))', () => this.msg.fetchLongMsgWithCb({ ...peer }, Number(known.msgId))));
        }
        out.tries = tries;
        // ★ 第 151 轮实测过「fetchLongMsg 后等 1.5s 再读一次 getMultiMsg」仍是 result:5。
        //   这里补两条**没试过**的路：
        //   ① 内核有 setIsStopKernelFetchLongMsg 这个开关 —— 如果它默认停在 true，
        //      fetchLongMsg 就只是空操作（上轮实测 1ms resolve 且零键，很像这种情形）；
        //   ② 长消息可能是**异步**拉取，读窗口比 1.5s 长得多，所以要连续轮询而不是读一次。
        const stopSwitch = {};
        if (this.msg?.setIsStopKernelFetchLongMsg) {
          for (const value of [false, true]) {
            try {
              const housekeeping = await Promise.race([
                Promise.resolve(this.msg.setIsStopKernelFetchLongMsg(value)),
                new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 5000)),
              ]);
              stopSwitch['arg=' + String(value)] = housekeeping === '__timeout__' ? 'timeout'
                : { keys: Object.keys(housekeeping ?? {}).slice(0, 8),
                    result: typeof housekeeping?.result === 'number' ? housekeeping.result : null };
            } catch (error) {
              stopSwitch['arg=' + String(value)] = { threw: String(error?.message ?? error).slice(0, 160) };
            }
          }
        }
        out.stopSwitch = stopSwitch;
        if (this.msg?.fetchLongMsg && this.msg?.getMultiMsg && this.msg?.setIsStopKernelFetchLongMsg) {
          const polls = [];
          try { await this.msg.setIsStopKernelFetchLongMsg(false); } catch { /* 不可用就算了 */ }
          const startedAt = Date.now();
          try { await this.msg.fetchLongMsg({ ...peer }, known.msgId); } catch { /* void */ }
          for (let index = 0; index < 15; index++) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            try {
              const page = await Promise.race([
                this.msg.getMultiMsg({ ...peer }, known.msgId, out.resId ?? ''),
                new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 8000)),
              ]);
              polls.push(page === '__timeout__'
                ? { at: Date.now() - startedAt, stage: 'timeout' }
                : { at: Date.now() - startedAt,
                    result: typeof page?.result === 'number' ? page.result : null,
                    msgListLength: Array.isArray(page?.msgList) ? page.msgList.length : null });
            } catch (error) {
              polls.push({ at: Date.now() - startedAt, threw: String(error?.message ?? error).slice(0, 120) });
            }
            if (polls[polls.length - 1]?.msgListLength > 0) break;
          }
          out.stopFlagThenPoll = polls;
          // 探针结束把开关恢复成「停止」——不把内核留在一个半开的状态里。
          try { await this.msg.setIsStopKernelFetchLongMsg(true); } catch { /* ignore */ }
        }
        // ★ 关键假设：内核里的 fetchLongMsg 是 void（本次实测 keys=[]），像是「先把长消息拉下来、
        //   之后 getMultiMsg 从缓存读」的模式。验证：拉一次、等一会儿、再读一次 getMultiMsg。
        if (this.msg?.fetchLongMsg && this.msg?.getMultiMsg) {
          const startedAt = Date.now();
          try { await this.msg.fetchLongMsg({ ...peer }, known.msgId); } catch {}
          await new Promise((resolve) => setTimeout(resolve, 1500));
          try {
            const again = await Promise.race([
              this.msg.getMultiMsg({ ...peer }, known.msgId, out.resId ?? ''),
              new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 20000)),
            ]);
            out.fetchThenGetMultiMsg = {
              ms: Date.now() - startedAt,
              stage: again === '__timeout__' ? 'timeout' : 'resolved',
              result: typeof again?.result === 'number' ? again.result : null,
              errMsg: typeof again?.errMsg === 'string' ? again.errMsg.slice(0, 120) : null,
              msgListLength: Array.isArray(again?.msgList) ? again.msgList.length : null,
              sample: Array.isArray(again?.msgList) && again.msgList.length
                ? { elements: Array.isArray(again.msgList[0]?.elements) ? again.msgList[0].elements.length : null,
                    senderUin: String(again.msgList[0]?.senderUin ?? '') }
                : null,
            };
          } catch (error) {
            out.fetchThenGetMultiMsg = { ms: Date.now() - startedAt, stage: 'threw',
              message: String(error?.message ?? error).slice(0, 200) };
          }
        }
        return out;
      }
      case 'get_version_info': return { app_name: 'whale-onebot', app_version: VERSION,
        protocol_version: 'v11', version: VERSION };
      /**
       * 机器人「见过」的会话清单（我们自己的扩展，不是 OneBot 标准动作）。
       *
       * <p>存在的理由：本机 QQ build 的 `getGroupList()` 原生回调`
       * onGroupListUpdate` 永不触发 ⇒ 标准 `get_group_list` 只能回 1502。
       * 手机面板要给白名单做勾选，就用这份「真的收到过消息」的清单当候选。
       * 只读、无副作用；群名不在这里（消息里没有），由调用方拿 id 再问
       * `get_group_info`。
       */
      case 'get_known_chats': {
        const chats = [...this.knownChats.values()]
          .sort((a, b) => b.last - a.last)
          .map(c => ({ type: c.type, id: c.id, last: c.last, count: c.count }));
        return { chats, total: chats.length };
      }
      /**
       * 群名补充（我们自己的只读扩展，不是 OneBot 标准动作）。
       *
       * <p>入参 `{ groups: ["871721981", ...] }`（≤ 50 个，actions.mjs 已校验）。
       * 出参 `{ names: { "871721981": "群名" }, failed: ["..."] }`：
       * **拿不到名字的群只进 failed，不让整批失败**。
       */
      case 'get_chat_names': {
        let request;
        try { request = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        if (typeof this.group?.getGroupDetailInfo !== 'function') throw unsupported();
        const generation = this.generation;
        const result = await this.chatNames(request.groups, options);
        if (!this.attached || generation !== this.generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Group name query crossed a session change', { retcode: 1503 });
        return result;
      }
      case 'can_send_image': return { yes: true };
      case 'can_send_record': return { yes: typeof this.richMedia?.downloadRichMedia === 'function' || !!this.richMedia };
      case 'set_essence_msg': return this.groupEssence(params, options, true);
      case 'del_essence_msg': return this.groupEssence(params, options, false);
      case 'forward_friend_single_msg': case 'forward_group_single_msg':
        return this.forwardSingle(params, action === 'forward_group_single_msg' ? 'group' : 'private', options);
      case 'set_group_kick': return this.kickGroupMember(params, options);
      case 'set_group_kick_members': return this.kickGroupMember(params, options, true);
      case 'set_group_name': {
        const code = groupCode(), name = text(params.group_name, 'group_name', 256);
        const generation = this.generation;
        const channel = `group:${code}`;
        if (!name.trim()) throw invalid('Group name must not be blank');
        if (this.unconfirmedGroupReads.has(channel) || this.unconfirmedGroupReads.size >= 128)
          throw new BridgeError('UNCONFIRMED', 'Group detail readback is unavailable', { retcode: 1502 });
        checkResult(await this.wait(null, () => this.group.modifyGroupName(code, name, false), {
          ...options, sideEffect: true,
          shouldSubmit: () => !this.groupReads.has(channel) && (options.shouldSubmit?.() ?? true),
        }), true);
        try {
          if (!this.attached || this.generation !== generation || options.signal?.aborted)
            throw new Error('Session changed');
          const group = await this.readGroupDetail(code, options);
          if (group.groupName !== name) throw new Error('Name mismatch');
        } catch {
          throw new BridgeError('UNCONFIRMED', 'Group name readback did not confirm the submitted change',
            { retcode: 1502, outcome: 'unknown' });
        }
        return null;
      }
      case 'set_group_top': {
        // 会话置顶（不是群消息置顶）：内核 NodeIKernelGroupService.setTop(groupCode, isTop) 返回 void。
        // 这是**本机可见的会话列表排序**，不改群设置、也不通知他人 —— 失败不会造成"看起来成功"的错觉：
        // 原生拒绝会以 BridgeError 抛出，checkResult 会把非零 result 归一成 1500。
        const code = groupCode();
        const enable = params.enable !== false;
        checkResult(await invoke(() => this.group.setTop(code, enable), true), true);
        return { group_id: Number(code), enable };
      }
      case 'set_friend_top': {
        // 私聊会话置顶。内核有两个候选，参数形状不同：
        //   msg.setContactLocalTop({ chatType: 1, peerUid }, isTop)  —— chatType 1 = C2C（好友私聊）
        //   buddy.setTop(uid: number, isTop)
        // 这里按顺序都试一次，返回**实际生效的那条**（via），免得把"没验证的形状"说成已验证。
        const uin = String(id(params.user_id, 'user_id'));
        const enable = params.enable !== false;
        const attempts = [];
        if (typeof this.msg?.setContactLocalTop === 'function') {
          try {
            checkResult(await invoke(() => this.msg.setContactLocalTop({ chatType: 1, peerUid: uin }, enable), true), true);
            return { user_id: Number(uin), enable, via: 'msg.setContactLocalTop' };
          } catch (error) {
            attempts.push({ via: 'msg.setContactLocalTop', retcode: error?.retcode ?? null,
              message: String(error?.message ?? error).slice(0, 120) });
          }
        }
        if (typeof this.buddy?.setTop === 'function') {
          try {
            checkResult(await invoke(() => this.buddy.setTop(Number(uin), enable), true), true);
            return { user_id: Number(uin), enable, via: 'buddy.setTop', attempts };
          } catch (error) {
            attempts.push({ via: 'buddy.setTop', retcode: error?.retcode ?? null,
              message: String(error?.message ?? error).slice(0, 120) });
          }
        }
        throw new BridgeError('UNAVAILABLE', 'Native friend pin was rejected on every candidate', { retcode: 1500, attempts });
      }
      case 'set_group_leave': {
        const code = groupCode();
        // group-service.ts:225-228 describes needDeleteLocalMsg, not a proven
        // dissolve-group flag. Never map is_dismiss to local message deletion.
        if (bool(params.is_dismiss)) throw unsupported();
        const generation = this.generation;
        checkResult(await invoke(() => this.group.quitGroupV2({ groupCode: code, needDeleteLocalMsg: false }), true), true);
        try {
          if (generation !== this.generation) throw new Error('session changed');
          const groups = await this.readGroupList(true, options);
          if (groups.some(group => String(group.group_id) === code)) throw new Error('group still present');
        } catch {
          throw new BridgeError('UNCONFIRMED', 'Leave submitted but current-session readback did not confirm it; do not retry automatically', { retcode: 1502, outcome: 'unknown' });
        }
        return null;
      }
      case 'set_group_card': case 'set_group_admin': {
        const generation = this.generation;
        const code = groupCode(), wanted = user(params.user_id), uid = await this.uid(wanted, options);
        const desired = action === 'set_group_card' ? text(params.card ?? '', 'card', 256) : bool(params.enable, true) ? 'admin' : 'member';
        await this.probe();
        if (!this.attached || this.generation !== generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Member update crossed a session change before submission', { retcode: 1503 });
        await invoke(() => action === 'set_group_card' ? this.group.modifyMemberCardName(code, uid, desired) : this.group.modifyMemberRole(code, uid, desired === 'admin' ? 3 : 2), true);
        try {
          if (this.generation !== generation) throw new Error('stale');
          const member = (await this.members(code, options, true, { uin: wanted, uid }))[0];
          if (!member || (action === 'set_group_card' ? member.card : member.role) !== desired) throw new Error('unconfirmed');
        } catch { throw new BridgeError('UNCONFIRMED', 'Mutation submitted but readback did not confirm it', { retcode: 1502, outcome: 'unknown' }); }
        return null;
      }
      case 'get_cookies': {
        const domain = typeof params.domain === 'string' && params.domain.trim() ? params.domain.trim() : 'qun.qq.com';
        const info = await this.webCgi.getCookies(domain, { noCache: bool(params.no_cache) });
        return { cookies: info.cookies, bkn: String(info.bkn) };
      }
      case 'get_credentials': {
        const domain = typeof params.domain === 'string' && params.domain.trim() ? params.domain.trim() : 'qun.qq.com';
        const info = await this.webCgi.getCookies(domain, { noCache: bool(params.no_cache) });
        return { cookies: info.cookies, csrf_token: info.bkn };
      }
      case 'get_csrf_token': {
        const domain = typeof params.domain === 'string' && params.domain.trim() ? params.domain.trim() : 'qun.qq.com';
        const info = await this.webCgi.getCookies(domain, { noCache: bool(params.no_cache) });
        return { token: info.bkn };
      }
      case 'get_protocol_readiness': return this.protocolReadiness();
      case 'upload_group_file': case 'send_group_file':
      case 'upload_private_file': case 'send_private_file': {
        let req;
        try { req = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.uploadFileAction(req, action.endsWith('group_file'), options);
      }
      case 'get_group_file_url': {
        let req;
        try { req = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.getGroupFileUrlAction(req, options);
      }
      case 'set_group_add_request': {
        let req;
        try { req = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.decideGroupRequest(req, options);
      }
      case 'get_essence_msg_list': return this.getEssenceMsgList(groupCode(), options);
      case 'ocr_image': {
        let req;
        try { req = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.ocrImageAction(req.image, options);
      }
      case 'search_local_msgs': {
        let req;
        try { req = validateParams(action, params); } catch (error) { throw invalid(error.message); }
        return this.searchLocalMsgs(req, options);
      }
      case 'get_qq_avatar': return this.getQqAvatar(params);
      case 'get_group_avatar': return this.getGroupAvatar(params);
      case 'get_ai_characters': return this.getAiCharacters(groupCode(), params, options);
      case 'get_qzone_msg_list': return this.webCgi.getQzoneMsgList(params);
      case 'get_qzone_feeds': return this.webCgi.getQzoneFeeds(params);
      case 'send_qzone_msg': return this.webCgi.sendQzoneMsg(validateParams(action, params));
      case 'comment_qzone': return this.webCgi.commentQzone(validateParams(action, params));
      case 'like_qzone': return this.webCgi.likeQzone(validateParams(action, params));
      case 'get_group_album_list': return this.webCgi.getGroupAlbumList(validateParams(action, params));
      case 'get_group_album_media_list': return this.webCgi.getGroupAlbumMediaList(validateParams(action, params));
      case 'set_group_album_media_like': return this.webCgi.setGroupAlbumMediaLike(validateParams(action, params));
      case 'do_group_album_comment': return this.webCgi.doGroupAlbumComment(validateParams(action, params));
      case 'upload_image_to_qun_album': return this.webCgi.uploadImageToQunAlbum(validateParams(action, params));
      default: throw unsupported();
    }
  }

  async readIndexedImage({ file, message_id: messageId }, options) {
    if (typeof file !== 'string' || !file || file.length > 4096 || file === '.' || file === '..' || /[\\/:\x00-\x1f\x7f]/.test(file))
      throw invalid('Expected an image filename from a current-session message');
    if (messageId !== undefined && !isOneBotMessageId(messageId))
      throw invalid('Expected a current-session OneBot message ID');
    const locate = elements => Array.isArray(elements) ? elements.filter(element => element?.elementType === 2 &&
      mediaSegment(element)?.data.file === file) : [];
    let indexed, original;
    const notFound = () => new BridgeError('IMAGE_NOT_FOUND', 'Expected one indexed image with a verified QQ address', { retcode: 1404 });
    const candidates = messageId === undefined ? this.messages.byId.values() : [this.messages.byId.get(Number(messageId))];
    for (const entry of candidates) {
      if (!entry) continue;
      const matches = locate(entry.raw.elements);
      if (!matches.length) continue;
      if (indexed || matches.length !== 1) throw notFound();
      indexed = entry;
      [original] = matches;
    }
    if (!indexed) throw notFound();
    const matches = locate(await this.readIndexedMediaElements(indexed, 2, options));
    const image = matches[0];
    if (matches.length !== 1 || (original.elementId !== undefined && image.elementId !== original.elementId)) throw notFound();
    const { url } = mediaSegment(image).data;
    if (!url) throw notFound();
    return { file, file_name: file, url };
  }

  async readIndexedFile({ message_id: messageId, file_id: fileId }, options) {
    if (!isOneBotMessageId(messageId) || typeof fileId !== 'string' || !fileId ||
        fileId.length > 1024 || /[\x00-\x20\x7f]/.test(fileId))
      throw invalid('Expected a current-session message ID and a file ID from its file segment');
    const indexed = this.messages.byId.get(Number(messageId));
    const unavailable = () => new BridgeError('FILE_NOT_FOUND', 'Indexed file could not be verified', { retcode: 1404 });
    const find = elements => elements.filter(element => element?.elementType === 3 && fileSegment(element.fileElement)?.data.file_id === fileId);
    if (!indexed || !Array.isArray(indexed.raw.elements)) throw unavailable();
    const originals = find(indexed.raw.elements);
    if (originals.length !== 1) throw unavailable();
    const elements = await this.readIndexedMediaElements(indexed, 3, options);
    const current = find(elements);
    if (current.length !== 1 || (originals[0].elementId !== undefined && current[0].elementId !== originals[0].elementId))
      throw unavailable();
    const { name: file_name, file_size } = fileSegment(current[0].fileElement).data;
    return { file_name, file_size };
  }

  // A received picture carries originImageUrl = "/download?appid=1406&fileid=…"
  // with NO rkey — the packet protocol fetches its own rkey (that is exactly what
  // NapCat's getRkeyData does), and we have no such client. With no rkey the only
  // public address left is the md5 CDN form, and that form 404s for anything the
  // public store does not keep. Measured on live traffic 2026-11-16: originRelative
  // 7 of 7, all with fileid, zero usable rkey — and one private-chat picture plus
  // every market sticker answered 404 while a plain group picture answered 200.
  // QQ itself can always fetch the bytes, so ask the native transfer to download
  // the picture and hand the reader a data URL. That needs no network at the far
  // end and cannot expire. Returns Map(elementId → 'base64://…'); an empty map
  // means "fall back to the md5 address", never a fabricated success.
  // A received picture carries originImageUrl = "/download?appid=1406&fileid=…"
  // with NO rkey — the packet protocol fetches its own rkey (that is exactly what
  // NapCat's getRkeyData does) and we have no such client. With no rkey the only
  // public address left is the md5 CDN form, and that form 404s for anything the
  // public store does not keep. Measured on live traffic 2026-11-16: originRelative
  // 12 of 12, all with fileid, zero usable rkey; md5 addresses answered 200 on some
  // pictures and 404 on others (a private-chat photo, every market sticker).
  // QQ itself can always fetch the bytes, so ask the native transfer to download
  // the picture and hand the reader a data URL. That needs no network at the far
  // end and cannot expire.
  //
  // Returns Map(message element index → 'base64://…'). Keyed by index, not by
  // elementId: a received element may carry an empty elementId, and matching on it
  // silently dropped every picture before. An empty map means "fall back to the
  // md5 address", never a fabricated success.
  async inlinePictureData(message, peer, options) {
    const result = new Map();
    const elements = Array.isArray(message?.elements) ? message.elements : [];
    const targets = [];
    let total = 0;
    const isAbsPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && /^([/\\]|[A-Za-z]:[\\/])/.test(p);

    for (let index = 0; index < elements.length && targets.length + result.size < 4; index++) {
      const element = elements[index];
      if (!element || element.elementType !== 2 || !element.picElement) continue;
      const { picUrl, originImageUrl, sourcePath, thumbPath } = element.picElement;
      if (qqMediaUrl(picUrl) !== undefined) continue;
      if (qqImageOrigin(originImageUrl) !== undefined) continue;
      // 优先读取本地已落盘的缓存文件（sourcePath / thumbPath），0ms 命中避免走下载竞态
      const localCandidates = [];
      if (isAbsPath(sourcePath)) localCandidates.push(sourcePath);
      if (thumbPath && typeof thumbPath === 'object') {
        const vals = thumbPath instanceof Map ? [...thumbPath.values()] : Object.values(thumbPath);
        for (const p of vals) if (isAbsPath(p) && !localCandidates.includes(p)) localCandidates.push(p);
      }
      let hitLocal = false;
      for (const p of localCandidates) {
        const bytes = await readFile(p).catch(() => null);
        if (bytes?.length && bytes.length <= PICTURE_INLINE_MAX_BYTES && total + bytes.length <= PICTURE_INLINE_TOTAL_BYTES) {
          total += bytes.length;
          result.set(index, 'base64://' + bytes.toString('base64'));
          hitLocal = true;
          break;
        }
      }
      if (!hitLocal) targets.push({ index, element });
    }
    if (!targets.length) {
      if (result.size) { mediaDiagnostics.inlineAttempts++; mediaDiagnostics.inlineSucceeded++; }
      return result;
    }
    if (!PICTURE_INLINE_SUPPORTED) return result;
    if (typeof this.msg?.downloadRichMedia !== 'function') {
      mediaDiagnostics.inlineNoMethod++;
      return result;
    }
    mediaDiagnostics.inlineAttempts++;
    const interval = Math.max(5, Math.min(PICTURE_DOWNLOAD_INTERVAL_MS,
      Math.floor(this.timeoutMs / (PICTURE_DOWNLOAD_POLLS + 2))));
    // ★ 2026-11-26 真机实测根治（31/32 失败真因）：
    //   旧版把 completions.delete(key) 写在 await downloadRichMedia(...) 之后！
    //   当缓存命中或快速下完时，onRichMediaDownloadComplete 会在 await 期间写入 completions，
    //   随后立刻被 delete 抹掉 ⇒ 轮询白等 10s 超时！必须先清旧键再调用 downloadRichMedia。
    const completions = this.richMediaCompletions;
    for (const { element } of targets) {
      const elementId = element.elementId ?? '';
      const key = `${message.msgId}:${String(elementId)}`;
      completions.delete(key);
      try {
        await this.msg.downloadRichMedia({
          fileModelId: '0',
          downSourceType: 0,
          downloadSourceType: 0,
          triggerType: 1,
          msgId: message.msgId,
          chatType: peer.chatType,
          peerUid: peer.peerUid,
          elementId,
          thumbSize: 0,
          downloadType: PICTURE_DOWNLOAD_TYPE,
          filePath: '',
        });
      } catch { mediaDiagnostics.inlineTransferError++; }
    }
    const deadline = Date.now() + Math.max(this.timeoutMs, 15000);
    while (targets.some(t => !result.has(t.index)) && Date.now() < deadline) {
      if (options?.signal?.aborted) break;
      for (const { index, element } of targets) {
        if (result.has(index)) continue;
        const elementId = element.elementId ?? '';
        const key = `${message.msgId}:${String(elementId)}`;
        let matchKey = key;
        let done = completions.get(key);
        // 兜底匹配：部分内核版本回调里的 msgElementId 与读取时不一致（如空串 vs 数字串）
        if (!done && targets.length === 1) {
          const prefix = `${message.msgId}:`;
          for (const [k, v] of completions.entries()) {
            if (k.startsWith(prefix)) { matchKey = k; done = v; break; }
          }
        }
        if (!done || typeof done.filePath !== 'string') continue;
        const path = done.filePath;
        if (!isAbsPath(path)) continue;
        const bytes = await readFile(path).catch(() => { mediaDiagnostics.inlineReadError++; return null; });
        if (!bytes?.length) continue;
        if (bytes.length > PICTURE_INLINE_MAX_BYTES || total + bytes.length > PICTURE_INLINE_TOTAL_BYTES) {
          mediaDiagnostics.inlineTooLarge++;
          completions.delete(matchKey);
          continue; // do not retry this element; other targets keep polling
        }
        total += bytes.length;
        result.set(index, 'base64://' + bytes.toString('base64'));
        completions.delete(matchKey);
      }
      if (targets.some(t => !result.has(t.index))) await delay(interval, undefined, { signal: options?.signal }).catch(() => {});
    }
    let succeeded = result.size;
    if (succeeded) mediaDiagnostics.inlineSucceeded++; else mediaDiagnostics.inlineFailed++;
    return result;
  }

  // OneBot get_record：把一条语音消息落成本地文件。
  //
  // 本运行端拿语音字节的唯一被验证过的途径是原生传输：downloadRichMedia
  // （downloadType: 1，与 inlinePictureData 同一契约，NapCat 的 downloadMedia 也用同一个
  // 调用）→ onRichMediaDownloadComplete 回调给出 filePath。没有第二条路：pttElement
  // 不带可直接下载的地址，服务端 url 会过期。
  //
  // 只返回原生 silk 文件。out_format 不是 silk 的在 validateParams 里就被拒了 ——
  // 本运行端没有转码器，把 silk 说成 mp3 比明确拒绝更糟。
  async readIndexedRecord(params, options) {
    const generation = this.generation;
    const notFound = () => new BridgeError('MEDIA_MESSAGE_NOT_FOUND',
      'Record message could not be verified', { retcode: 1404 });
    let indexed;
    if (params.message_id !== undefined) {
      indexed = this.messages.byId.get(params.message_id);
      if (!indexed) throw notFound();
    } else {
      // 按文件名回溯：索引按插入顺序保存，从新到旧扫一个有界窗口。
      const entries = [...this.messages.byId.values()];
      const floor = Math.max(0, entries.length - RECORD_FILE_SCAN_LIMIT);
      for (let index = entries.length - 1; index >= floor; index--) {
        const candidate = entries[index];
        const elements = Array.isArray(candidate?.raw?.elements) ? candidate.raw.elements : [];
        if (elements.some(element => element?.elementType === 4 && element.pttElement?.fileName === params.file)) {
          indexed = candidate;
          break;
        }
      }
      if (!indexed) throw notFound();
    }
    const known = indexed.raw;
    const sender = this.#conversationUser(known.senderUin);
    if (known.chatType === 1 && (!known.peerUin ||
        (String(known.peerUin) === MAIN && this.#conversationPolicy !== 'original'))) throw notFound();
    const peer = rawPeer(known);
    const raw = await this.wait(null, () => this.msg.getMsgsByMsgId({ ...peer }, [known.msgId]), options);
    const message = findMessageReadback(raw, peer, known.msgId);
    if (!message || String(readOwnMessageField(message, 'senderUin')) !== sender ||
        (known.senderUid && known.senderUid !== readOwnMessageField(message, 'senderUid'))) throw notFound();
    let elements = projectMediaReadback(message, 4);
    if (params.file !== undefined) {
      elements = elements.filter(element => element.pttElement?.fileName === params.file);
    }
    if (elements.length === 0) throw notFound();
    // 一条消息里有多段语音而调用方没指定文件时，不猜哪一段，明确要求指明。
    if (elements.length > 1) throw new BridgeError('MEDIA_NOT_UNIQUE',
      'Message carries more than one record; pass file to pick one', { retcode: 1400 });
    if (typeof this.msg?.downloadRichMedia !== 'function')
      throw new BridgeError('UNSUPPORTED', 'This native profile cannot transfer records', { retcode: 1404 });
    const elementId = elements[0].elementId ?? '';
    const key = `${message.msgId}:${String(elementId)}`;
    const completions = this.richMediaCompletions;
    completions.delete(key);
    try {
      await this.msg.downloadRichMedia({
        fileModelId: '0', downSourceType: 0, downloadSourceType: 0, triggerType: 1,
        msgId: message.msgId, chatType: peer.chatType, peerUid: peer.peerUid,
        elementId, thumbSize: 0, downloadType: PICTURE_DOWNLOAD_TYPE, filePath: '',
      });
    } catch {
      throw new BridgeError('MEDIA_UNAVAILABLE', 'Native record transfer failed', { retcode: 1502 });
    }
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) break;
      const done = completions.get(key);
      if (done) {
        completions.delete(key);
        const path = done.filePath;
        // 只接受绝对路径：回调里的相对路径无法被上层安全读取。
        if (typeof path === 'string' && path && path.length <= 4096 &&
            /^([/\\]|[A-Za-z]:[\\/])/.test(path)) {
          await this.probe();
          if (!this.attached || this.generation !== generation)
            throw new BridgeError('STALE_SESSION', 'Record query crossed a session change', { retcode: 1503 });
          return { file: path, out_format: 'silk',
            ...(elements[0].pttElement?.fileName ? { name: elements[0].pttElement.fileName } : {}) };
        }
      }
      await delay(RECORD_DOWNLOAD_POLL_MS, undefined, { signal: options?.signal }).catch(() => {});
    }
    throw new BridgeError('MEDIA_UNAVAILABLE', 'Native record transfer did not complete', { retcode: 1502 });
  }

  /**
   * 把一条消息里的视频落到**本地文件**并返回绝对路径（OneBot 扩展动作 get_message_videos）。
   *
   * 为什么需要它：运行端要看视频只能「下载 → ffmpeg 抽帧」，而 QQ 的视频地址带 rkey、会过期
   * （真机 `图片获取失败：HTTP 404` 就是这么来的）。`get_message_images` 只处理图片元素，
   * 视频没有对等通道 ⇒ 收到视频消息时运行端无处可取。这里用与 get_record 完全同一条
   * 原生传输（downloadRichMedia + 完成回调）把视频落到磁盘，运行端与本协议端在**同一个容器
   * 文件系统**里，直接读路径即可，不需要把几十 MB 塞进 OneBot 消息体。
   */
  async getMessageVideos(params, options) {
    const messageId = params.message_id;
    if (!isOneBotMessageId(messageId)) throw invalid('Expected a current-session OneBot message ID');
    const indexed = this.messages.byId.get(Number(messageId));
    if (!indexed) throw new BridgeError('MESSAGE_NOT_FOUND', 'Message ID expired or belongs to another session', { retcode: 1404 });
    const elements = await this.readIndexedMediaElements(indexed, 5, options);
    if (!elements.length) throw new BridgeError('MEDIA_MESSAGE_NOT_FOUND', 'Message carries no video', { retcode: 1404 });
    if (typeof this.msg?.downloadRichMedia !== 'function')
      throw new BridgeError('UNSUPPORTED', 'This native profile cannot transfer videos', { retcode: 1404 });
    const known = indexed.raw;
    const peer = rawPeer(known);
    const msgId = known.msgId;
    const completions = this.richMediaCompletions;
    const videos = [];
    const isAbsPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && /^([/\\]|[A-Za-z]:[\\/])/.test(p);
    // 视频体积远大于图片，放宽下载等待窗口到 40s（与运行端 60s RPC 超时匹配）
    const videoTimeoutMs = Math.max(this.timeoutMs, 40_000);
    for (const element of elements.slice(0, VIDEO_PAGE_LIMIT)) {
      const name = element.videoElement?.fileName;
      const existingPath = element.videoElement?.filePath;
      if (isAbsPath(existingPath)) {
        const st = await stat(existingPath).catch(() => null);
        if (st?.isFile() && st.size > 0) {
          videos.push({ file: typeof name === 'string' && name ? name : '', path: existingPath });
          continue;
        }
      }
      const elementId = element.elementId ?? '';
      const key = `${msgId}:${String(elementId)}`;
      let resolvedPath = null;
      // NTQQ 原生视频优先 downloadType=2（原文件），若无响应再退 downloadType=1
      for (const dlType of [2, PICTURE_DOWNLOAD_TYPE]) {
        if (resolvedPath || options?.signal?.aborted) break;
        completions.delete(key);
        try {
          await this.msg.downloadRichMedia({
            fileModelId: '0', downSourceType: 0, downloadSourceType: 0, triggerType: 1,
            msgId, chatType: peer.chatType, peerUid: peer.peerUid,
            elementId, thumbSize: 0, downloadType: dlType, filePath: '',
          });
        } catch { continue; }
        const stepDeadline = Date.now() + (dlType === 2 ? Math.floor(videoTimeoutMs * 0.65) : Math.floor(videoTimeoutMs * 0.35));
        while (Date.now() < stepDeadline) {
          if (options?.signal?.aborted) break;
          let matchKey = key;
          let done = completions.get(key);
          if (!done && elements.length === 1) {
            const prefix = `${msgId}:`;
            for (const [k, v] of completions.entries()) {
              if (k.startsWith(prefix)) { matchKey = k; done = v; break; }
            }
          }
          if (!done) { await delay(RECORD_DOWNLOAD_POLL_MS, undefined, { signal: options?.signal }).catch(() => {}); continue; }
          completions.delete(matchKey);
          const p = done.filePath;
          if (isAbsPath(p)) {
            const st = await stat(p).catch(() => null);
            if (st?.isFile() && st.size > 0) {
              resolvedPath = p;
              break;
            }
          }
          break;
        }
      }
      if (resolvedPath) {
        videos.push({ file: typeof name === 'string' && name ? name : '', path: resolvedPath });
      }
    }
    return { videos, total: videos.length };
  }

  rememberRichMediaDownload(done) {
    if (!done || typeof done !== 'object') return;
    const msgId = done.msgId;
    const rawElementId = done.msgElementId ?? done.elementId ?? '';
    const filePath = done.filePath;
    if (typeof msgId !== 'string' || typeof filePath !== 'string' || !filePath) return;
    // Native may report msgElementId as a number or string; normalise to string so
    // the key matches inlinePictureData's `${msgId}:${String(elementId ?? '')}`.
    const elementId = String(rawElementId);
    this.richMediaCompletions.set(`${msgId}:${elementId}`, { filePath });
  }


  // Resolve a real download URL for received pictures whose originImageUrl is a
  // bare "/download?appid=…&fileid=…" with no rkey. Fetches an rkey once (cached)
  // via the native sendSsoCmdReqByContend OIDB channel and stamps element.__rkeyUrl.
  // Never throws and never fabricates: on any failure the element is left without
  // __rkeyUrl and mediaSegment falls back to the md5 address. Only the on-demand
  // read paths (get_msg / get_message_images) call this; the inbound event path
  // stays zero-extra-cost.
  async resolveRkeyUrls(elements, options) {
    const needed = [];
    for (const element of Array.isArray(elements) ? elements : []) {
      if (!element || element.elementType !== 2) continue;
      const parts = relativeDownloadParts(element.picElement?.originImageUrl);
      if (!parts) continue;
      needed.push({ element, appid: parts.appid, fileid: parts.fileid });
    }
    if (!needed.length) return;
    mediaDiagnostics.rkeyAttempts++;
    if (!this.rkey.available) { mediaDiagnostics.rkeyNoMethod++; return; }
    const rkeyData = await this.rkey.get({ signal: options?.signal });
    if (!rkeyData) { mediaDiagnostics.rkeyFailed++; return; }
    mediaDiagnostics.rkeyResolved++;
    for (const { element, appid, fileid } of needed) {
      const rkey = rkeyForAppid(rkeyData, appid);
      if (!rkey) continue;
      element.__rkeyUrl = rkeyImageUrl(appid, fileid, rkey);
    }
  }

  async readIndexedMediaElements(indexed, elementType, options) {    const generation = this.generation;
    const notFound = () => new BridgeError('MEDIA_MESSAGE_NOT_FOUND', 'Indexed media message could not be verified', { retcode: 1404 });
    const known = indexed.raw;
    const sender = this.#conversationUser(known.senderUin);
    if (known.chatType === 1 && (!known.peerUin ||
        (String(known.peerUin) === MAIN && this.#conversationPolicy !== 'original'))) throw notFound();
    const peer = rawPeer(known);
    const raw = await this.wait(null, () => this.msg.getMsgsByMsgId({ ...peer }, [known.msgId]), options);
    const message = findMessageReadback(raw, peer, known.msgId);
    if (!message || String(readOwnMessageField(message, 'senderUin')) !== sender ||
        (known.senderUid && known.senderUid !== readOwnMessageField(message, 'senderUid'))) throw notFound();
    const inline = elementType === 2 ? await this.inlinePictureData(message, peer, options) : null;
    const elements = projectMediaReadback(message, elementType);
    // Resolve rkey download URLs on the projected elements when the inline path
    // delivered nothing (the normal case on this wrapper — see inlinePictureData).
    if (elementType === 2 && !inline?.size) {
      await this.resolveRkeyUrls(elements, options);
    }
    if (inline?.size) {
      const positions = [];
      for (let index = 0; index < message.elements.length; index++) {
        const candidate = message.elements[index];
        if (candidate?.elementType === 2 && candidate.picElement) positions.push(index);
      }
      elements.forEach((element, position) => {
        const data = inline.get(positions[position]);
        if (data !== undefined) element.inlineUrl = data;
      });
    }
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Media query crossed a session change', { retcode: 1503 });
    if (this.messages.byId.get(indexed.id) !== indexed) throw notFound();
    return elements;
  }

  reactionRequest(params, indexId, nativeId) {
    const { emojiId, emojiType, count = 20, cookie = '' } = params;
    if (!['string', 'number'].includes(typeof emojiId) || !/^(0|[1-9]\d{0,15})$/.test(String(emojiId)) ||
        !Number.isSafeInteger(Number(emojiId)) || ![1, 2, '1', '2'].includes(emojiType) ||
        !['string', 'number'].includes(typeof count) || !/^[1-9]\d{0,2}$/.test(String(count)) ||
        Number(count) > 100 || typeof cookie !== 'string' || cookie.length > 64)
      throw invalid('Invalid reaction page parameters');
    const key = JSON.stringify([indexId, nativeId, String(emojiId), String(emojiType), Number(count)]);
    const cursor = cookie ? this.reactionPages.get(cookie) : undefined;
    if (cookie && (cursor?.key !== key || cursor.sessionId !== this.identity?.sessionId))
      throw invalid('Reaction page cursor does not match this request');
    return { key, indexId, emojiId: String(emojiId), emojiType: String(emojiType), count: Number(count),
      nativeCookie: cursor?.nativeCookie ?? '', cursorSequence: cursor?.sequence };
  }

  async readReactionPage(request, peer, message, indexed, generation, options) {
    if (!this.attached || generation !== this.generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Reaction page crossed a session change', { retcode: 1503 });
    if (!isReactionSequence(message.msgSeq))
      throw invalid('Message lacks a confirmed reaction sequence');
    if (request.nativeCookie && request.cursorSequence !== message.msgSeq)
      throw invalid('Reaction page cursor refers to a different message sequence');
    const raw = await this.wait(null, () => this.msg.getMsgEmojiLikesList({ ...peer }, message.msgSeq,
      request.emojiId, request.emojiType, request.nativeCookie, false, request.count), options);
    boundForwardResponse(raw);
    checkResult(raw);
    if (!Array.isArray(raw.emojiLikesList) || raw.emojiLikesList.length > request.count ||
        typeof raw.isLastPage !== 'boolean' || raw.isFirstPage !== !request.nativeCookie ||
        typeof raw.cookie !== 'string' || raw.cookie.length > 4096 ||
        (!raw.isLastPage && (!raw.cookie || raw.cookie === request.nativeCookie))) throw forwardInvalid();
    const ids = new Set();
    const emojiLikesList = raw.emojiLikesList.map(entry => {
      if (typeof entry?.tinyId !== 'string' || !/^[1-9]\d{0,19}$/.test(entry.tinyId) ||
          ids.has(entry.tinyId)) throw forwardInvalid();
      ids.add(entry.tinyId);
      return { tinyId: entry.tinyId, nickName: text(entry.nickName, 'reaction nickname', 256), headUrl: '' };
    });
    const { isLastPage, isFirstPage, cookie: nativeCookie } = raw;
    await this.probe();
    if (!this.attached || generation !== this.generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Reaction page crossed a session change', { retcode: 1503 });
    if (this.messages.byId.get(request.indexId) !== indexed)
      throw new BridgeError('MESSAGE_NOT_FOUND', 'Indexed message changed during query', { retcode: 1404 });
    return { emojiLikesList, isLastPage, isFirstPage, nativeCookie };
  }

  async fetchReactionPage(request, peer, message, indexed, generation, options) {
    const { emojiLikesList, isLastPage, isFirstPage, nativeCookie } = await this.readReactionPage(
      request, peer, message, indexed, generation, options);
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Reaction page crossed a session change', { retcode: 1503 });
    const cookie = isLastPage ? '' : 'reaction_' + randomBytes(16).toString('hex');
    if (cookie) {
      if (this.reactionPages.size >= 256) this.reactionPages.delete(this.reactionPages.keys().next().value);
      this.reactionPages.set(cookie, { key: request.key, nativeCookie, sequence: message.msgSeq, sessionId: this.identity.sessionId });
    }
    return { emojiLikesList, cookie, isLastPage, isFirstPage, result: 0, errMsg: '' };
  }

  async readReactionResponders(totals, indexId, peer, message, indexed, generation, options) {
    let members;
    try { members = await this.members(peer.peerUid, options); }
    catch (error) {
      if (!this.attached || this.generation !== generation || options.signal?.aborted) throw error;
      return totals;
    }
    const memberAccounts = new Set(members.map(member => String(member.user_id)));
    let remainingPages = 10;
    for (const entry of totals.slice(0, 10)) {
      if (remainingPages === 0) break;
      if (entry.count === 0 || entry.count > 150) continue;
      const request = { indexId, emojiId: entry.emoji_id, emojiType: String(entry.emoji_type),
        count: 15, nativeCookie: '', cursorSequence: message.msgSeq };
      const seen = new Set();
      const cursors = new Set();
      while (remainingPages > 0) {
        remainingPages--;
        const page = await this.readReactionPage(request, peer, message, indexed, generation, options);
        for (const { tinyId } of page.emojiLikesList) {
          if (seen.has(tinyId)) throw forwardInvalid();
          seen.add(tinyId);
        }
        if (page.isLastPage) {
          if (seen.size === entry.count) {
            entry.users = [...seen].filter(account => account !== MAIN && memberAccounts.has(account)).map(user_id => ({ user_id }));
            entry.users_complete = entry.users.length === entry.count;
          }
          break;
        }
        if (seen.size >= entry.count) break;
        if (cursors.has(page.nativeCookie)) throw forwardInvalid();
        cursors.add(page.nativeCookie);
        request.nativeCookie = page.nativeCookie;
      }
    }
    return totals;
  }

  async collectEmojiLikes(query, peer, message, indexed, generation, options) {
    const request = { indexId: query.indexId, emojiId: query.emoji_id, emojiType: query.emoji_type,
      count: 15, nativeCookie: '', cursorSequence: message.msgSeq };
    const cursors = new Set();
    const responders = new Set();
    const emoji_like_list = [];
    for (let page = 0; page < 200; page++) {
      const result = await this.readReactionPage(request, peer, message, indexed, generation, options);
      for (const entry of result.emojiLikesList) {
        if (responders.has(entry.tinyId)) throw forwardInvalid();
        responders.add(entry.tinyId);
        if (entry.tinyId !== MAIN) emoji_like_list.push({ user_id: entry.tinyId, nick_name: entry.nickName });
      }
      if (result.isLastPage || (query.count && emoji_like_list.length >= query.count)) {
        if (query.count) emoji_like_list.length = Math.min(query.count, emoji_like_list.length);
        const response = { emoji_like_list };
        boundForwardResponse(response);
        return response;
      }
      if (cursors.has(result.nativeCookie)) throw forwardInvalid();
      cursors.add(result.nativeCookie);
      request.nativeCookie = result.nativeCookie;
    }
    throw forwardInvalid();
  }

  async confirmMute(invoke, options, generation) {
    const response = await this.wait(null, invoke, { ...options, sideEffect: true });
    const result = response && Object.getOwnPropertyDescriptor(response, 'result')?.value;
    try {
      await this.probe();
      if (!this.attached || this.generation !== generation || options.signal?.aborted)
        throw new Error('Session changed');
    } catch {
      throw new BridgeError('UNCONFIRMED', 'Mute acknowledgment crossed a session change',
        { retcode: 1502, outcome: 'unknown' });
    }
    checkResult({ result: Number.isSafeInteger(result) ? result : undefined }, true);
    return null;
  }

  async readGroupCallback(event, invoke, options, project) {
    const unconfirmed = event.startsWith('group-muted:') ? this.unconfirmedGroupMuteReads : this.unconfirmedGroupReads;
    if (unconfirmed.has(event) || unconfirmed.size >= 128)
      throw new BridgeError('UNCONFIRMED', 'An earlier group query has no confirmed response', { retcode: 1502 });
    if (this.groupReads.has(event))
      throw new BridgeError('BUSY', 'A query for this group callback is already active', { retcode: 1502 });
    if (this.groupReads.size + unconfirmed.size >= 128)
      throw new BridgeError('BUSY', 'Group query tracking capacity reached', { retcode: 1502 });
    const generation = this.generation;
    this.groupReads.add(event);
    try {
      let submitted = false;
      let result;
      try {
        result = await this.wait(event, () => {
          submitted = true;
          return invoke();
        }, { ...options, requireAck: true, snapshotReceipt: project });
      } catch (error) {
        // These notifications lack a request ID. The same native session may
        // survive detach/attach, so retain ambiguous channels for this bridge.
        if (submitted && error.code !== 'NATIVE_REJECTED')
          unconfirmed.add(event);
        throw error;
      }
      await this.probe();
      if (!this.attached || generation !== this.generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Group query crossed a session change', { retcode: 1503 });
      return result;
    } finally {
      this.groupReads.delete(event);
    }
  }

  async readGroupList(fresh, options) {
    if (this.webCgi.hasAuthProvider()) {
      try {
        return await this.webCgi.getGroupList({ noCache: fresh === true });
      } catch (error) {
        if (typeof this.group?.getGroupList !== 'function'
            || typeof this.group?.addKernelGroupListener !== 'function') {
          throw error;
        }
      }
    }
    return this.readGroupCallback('groups', () => this.group.getGroupList(fresh), options, groups => {
      if (groups.length > 10000) throw forwardInvalid();
      const seen = new Set();
      return groups.map(group => {
        const code = id(group?.groupCode, 'groupCode');
        if (seen.has(code)) throw forwardInvalid();
        seen.add(code);
        const members = integer(group.memberCount, 0, MAX_ID, 0);
        return { group_id: Number(code), group_name: text(group.groupName ?? '', 'group_name'),
          member_count: members, max_member_count: integer(group.maxMember, members, MAX_ID, members) };
      });
    });
  }

  readGroupMutedMembers(code, options) {
    return this.readGroupCallback(`group-muted:${code}`, () => this.group.getGroupShutUpMemberList(code), options, members => {
      if (!Array.isArray(members) || members.length > 2048) throw forwardInvalid();
      boundForwardResponse(members);
      const seen = new Set();
      return members.map(member => {
        if (!member || typeof member.uin !== 'string' || !/^[1-9]\d{0,15}$/.test(member.uin) ||
            !Number.isSafeInteger(Number(member.uin)) || seen.has(member.uin) ||
            typeof member.nick !== 'string' || member.nick.length > 4096 ||
            !Number.isSafeInteger(member.shutUpTime) || member.shutUpTime < 0)
          throw forwardInvalid();
        seen.add(member.uin);
        return { uin: member.uin, nick: member.nick, shutUpTime: member.shutUpTime,
          user_id: Number(member.uin), nickname: member.nick, shut_up_time: member.shutUpTime };
      });
    });
  }

  readGroupDetail(code, options, source = 2) {
    return this.readGroupCallback(`group:${code}`, () => this.group.getGroupDetailInfo(code, source), options, detail => {
      if (String(detail?.groupCode) !== code) throw invalid('Native group identity mismatch');
      boundForwardResponse(detail);
      return structuredClone(detail);
    });
  }

  /**
   * 批量读群名（get_chat_names 的实现）。
   *
   * <p><b>为什么用 readGroupDetail（source=1）</b>：它跟已经对外发布的
   * `get_group_info` 是**同一行代码**（本文件 `case 'get_group_info'` → `readGroupDetail(code, options, 1)`，
   * 群名取 `detail.groupName`）。这条读法在 2026-11-14 的 Linux 三路真机实测里被核对过
   * （用 `get_group_info` 核对同群的群名和成员数量）。
   * 另一条候选 `get_group_info_ex`（`group.getGroupExt0xEF0Info`）**不能用**：它只回
   * `groupExtensionFields` 里的整数开关（精华消息/机器人邀请…），结构里根本没有群名。
   *
   * <p><b>为什么串行</b>：群详情回调通道按群分片（`group:${code}`），且 readGroupCallback
   * 对同一通道的并发请求会直接 BUSY；逐个来既能拿到稳定结果，也不会把 50 个群同时压到内核上。
   *
   * <p><b>失败口径</b>：单个群超时 / 回调不触发 / 群名空或异常 ⇒ 只进 `failed`，
   * 其余群照常返回。整个循环有 15s 总预算，单群 3s，所以最坏也在 15s 左右收口。
   *
   * <p><b>为什么连续两次超时就整批收手</b>：群详情回调是按群分片的（`group:&lt;code&gt;`），
   * 读超时会在 readGroupCallback 里把该通道记成「未确认」并保留到下次重启（与 get_group_info
   * 同一个机制）。真机上若 `onGroupDetailInfoChange` 根本不触发（就像本机
   * `onGroupListUpdate` 那样），一路试下去会白白毒化 50 条通道、还会拖满 15s。
   * 所以「第一次超时照常继续（可能只是这个群慢），第二次连续超时」就判定回调不可用，
   * 剩下的群直接进 failed、不再发读请求 —— 宁可少拿名字，也不扩大副作用。
   */
  async chatNames(groups, options) {
    const names = {};
    const failed = [];
    const missing = [];
    // ★ 非 Hook 优先查 Web CGI 群列表缓存（1 次 HTTP 即可拿到全量群名，避免逐群调原生 1502 超时）
    if (this.webCgi?.hasAuthProvider?.()) {
      try {
        const list = await this.webCgi.getGroupList(options?.signal);
        if (Array.isArray(list) && list.length > 0) {
          const map = new Map();
          for (const g of list) {
            const gid = String(g?.group_id ?? '').trim();
            const gname = typeof g?.group_name === 'string' ? g.group_name.trim() : '';
            if (gid && gname && gname.length <= CHAT_NAME_MAX_LENGTH && !/[\x00-\x1f\x7f]/.test(gname)) {
              map.set(gid, gname);
            }
          }
          for (const code of groups) {
            const hit = map.get(String(code));
            if (hit) names[code] = hit;
            else missing.push(code);
          }
        } else {
          missing.push(...groups);
        }
      } catch {
        missing.push(...groups);
      }
    } else {
      missing.push(...groups);
    }
    if (missing.length === 0) return { names, failed };

    const deadline = Date.now() + CHAT_NAMES_BUDGET_MS;
    let consecutiveTimeouts = 0;
    for (let index = 0; index < missing.length; index++) {
      const code = missing[index];
      if (options.signal?.aborted) throw new BridgeError('CANCELLED', 'Request cancelled');
      if (!this.attached) throw new BridgeError('OFFLINE', 'Native bridge is detached', { retcode: 1503 });
      const remaining = deadline - Date.now();
      if (remaining <= 0) { failed.push(code); continue; }
      try {
        // 单群 3s 与整批 15s 都要守住；同时**不越过**桥接本身配置的 timeoutMs
        // （运维把全局读超时调小的时候，这里不能反过来把它撑大）。
        const timeoutMs = Math.min(CHAT_NAME_TIMEOUT_MS, remaining, this.timeoutMs);
        if (timeoutMs < 1) { failed.push(code); continue; }
        const detail = await this.readGroupDetail(code, { ...options, timeoutMs }, 1);
        const name = typeof detail?.groupName === 'string' ? detail.groupName.trim() : '';
        if (!name || name.length > CHAT_NAME_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(name)) {
          failed.push(code);
          continue;
        }
        names[code] = name;
        consecutiveTimeouts = 0;
      } catch (error) {
        // 只在外部整体取消时上抛；单个群的任何失败都降级成 failed。
        if (error?.code === 'CANCELLED' || options.signal?.aborted) throw error;
        failed.push(code);
        consecutiveTimeouts = error?.code === 'TIMEOUT' ? consecutiveTimeouts + 1 : 0;
        if (consecutiveTimeouts >= 2) {
          for (const rest of missing.slice(index + 1)) failed.push(rest);
          break;
        }
      }
    }
    return { names, failed };
  }

  async readGroupFilePage(code, { fileCount, startIndex, folderId, includeSpace = false, expectPage = true }, options) {
    if (this.groupFileRead) throw new BridgeError('BUSY', 'A native group file query is already active', { retcode: 1503 });
    const root = folderId === undefined || folderId === '/';
    const directoryKey = JSON.stringify([code, folderId ?? '/']);
    if (expectPage && (this.unconfirmedGroupFileDirectories.has(directoryKey) || this.unconfirmedGroupFileDirectories.size >= 128))
      throw new BridgeError('UNCONFIRMED', 'An earlier group file query can still emit a page for this directory', { retcode: 1502 });
    if (expectPage && root && this.unboundRootFileGroups.has(code))
      throw new BridgeError('UNCONFIRMED', 'An earlier quota request can still emit an unbound root page', { retcode: 1502 });
    if (!expectPage && !this.unboundRootFileGroups.has(code) && this.unboundRootFileGroups.size >= 128)
      throw new BridgeError('BUSY', 'Unbound group file tracking capacity reached', { retcode: 1502 });
    const request = { code, folderId };
    this.groupFileRead = request;
    try {
      let submitted = false;
      let page, space;
      try {
        const result = await this.wait(expectPage ? 'group-files' : null, async () => {
          submitted = true;
          // A quota-only call still uses getGroupFileList. Its Promise does
          // not consume or identify a possible later directory callback.
          if (!expectPage) this.unboundRootFileGroups.add(code);
          const acknowledgment = await this.richMedia.getGroupFileList(code, {
            fileCount, startIndex, sortType: 1, sortOrder: 2, showOnlinedocFolder: 0,
            ...(folderId === undefined ? {} : { folderId }),
          });
          if (includeSpace && acknowledgment?.groupSpaceResult !== undefined) {
            boundForwardResponse(acknowledgment.groupSpaceResult);
            space = structuredClone(acknowledgment.groupSpaceResult);
          }
          return acknowledgment;
        }, { ...options, requireAck: expectPage, snapshotReceipt: receipt => {
          boundForwardResponse(receipt);
          const snapshot = structuredClone(receipt);
          if (Number.isSafeInteger(snapshot.reqId) && snapshot.reqId > 0) {
            const seen = this.recentGroupFileReceipts;
            seen.add(`${code}:${folderId ?? '/'}:${snapshot.reqId}`);
            if (seen.size > 1024) seen.delete(seen.values().next().value);
          }
          return snapshot;
        } });
        if (expectPage) page = result;
        else checkResult(result);
      } catch (error) {
        // The native acknowledgment does not provide a proven request ID.
        // A late page could satisfy another query of the same group and directory.
        if (expectPage && submitted && error.code !== 'NATIVE_REJECTED')
          this.unconfirmedGroupFileDirectories.add(directoryKey);
        throw error;
      }
      return { page, space };
    } finally {
      if (this.groupFileRead === request) this.groupFileRead = null;
    }
  }

  async getGroupFileSystemInfo(code, options) {
    const generation = this.generation;
    const count = await this.wait(null, () => this.richMedia.batchGetGroupFileCount([code]), options);
    boundForwardResponse(count);
    checkResult(count);
    if (!Array.isArray(count.groupCodes) || count.groupCodes.length !== 1 || count.groupCodes[0] !== code ||
        !Array.isArray(count.groupFileCounts) || count.groupFileCounts.length !== 1 ||
        !Number.isSafeInteger(count.groupFileCounts[0]) || count.groupFileCounts[0] < 0)
      throw forwardInvalid();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Group file count crossed a session change', { retcode: 1503 });
    const fileCount = count.groupFileCounts[0];
    // The group-bound count and this invocation's Promise can establish
    // zero-file quota. An empty asynchronous page carries no group identity.
    const { page, space } = await this.readGroupFilePage(code, {
      fileCount: 1, startIndex: 0, includeSpace: true, expectPage: fileCount > 0,
    }, options);
    if (page) checkResult(page, false, 'retCode');
    checkResult(space, false, 'retCode');
    const { usedSpace, totalSpace } = space;
    if (![usedSpace, totalSpace].every(value => Number.isSafeInteger(value) && value >= 0) ||
        usedSpace > totalSpace || (page && page.item.length !== 1)) throw forwardInvalid();
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Group file space crossed a session change', { retcode: 1503 });
    // The fixed OneBot extension uses a compatibility limit, separate from the native byte quota.
    return { file_count: fileCount, limit_count: 10000, used_space: usedSpace, total_space: totalSpace };
  }

  async getGroupFiles({ group_id, file_count: count, folder_id: folderId, start_index: startIndex = 0 }, options) {
    const code = id(group_id, 'group_id');
    const normalized = typeof count === 'string' && /^[1-9]\d{0,2}$/.test(count) ? Number(count) : count;
    const fileCount = integer(normalized, 1, 200, 50);
    const generation = this.generation;
    const { page } = await this.readGroupFilePage(code, { fileCount, startIndex, folderId }, options);
    checkResult(page, false, 'retCode');
    if (page.item.length > fileCount || typeof page.isEnd !== 'boolean')
      throw invalid('Malformed native group file page');
    const nextIndex = page.nextIndex;
    if (!page.isEnd && nextIndex !== undefined &&
        (!Number.isSafeInteger(nextIndex) || nextIndex <= startIndex || nextIndex > MAX_ID))
      throw invalid('Invalid native group file continuation');
    const files = [], folders = [];
    const fileIds = new Set(), folderIds = new Set();
    for (const item of page.item) {
      const file = item.fileInfo, folder = item.folderInfo;
      if (Boolean(file) === Boolean(folder)) throw invalid('Unrecognized native group file entry');
      if (file) {
        const size = file.fileSize;
        const fileId = file.fileId;
        if (!isGroupFileId(fileId) || fileIds.has(fileId))
          throw invalid('Invalid or duplicate native group file ID');
        fileIds.add(fileId);
        if (typeof size !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(size) || !Number.isSafeInteger(Number(size)))
          throw invalid('Invalid native group file size');
        files.push({ group_id: Number(code), file_id: fileId,
          file_name: text(file.fileName, 'file_name'), file_size: Number(size), size: Number(size),
          busid: integer(file.busId, 0, 0xffffffff), uploader_name: text(file.uploaderName, 'uploader_name'),
          ...groupFileMetadata(file, groupFileFields) });
      } else {
        const folderId = folder.folderId;
        if (!isGroupFolderId(folderId) || folderIds.has(folderId))
          throw invalid('Invalid or duplicate native group folder ID');
        folderIds.add(folderId);
        folders.push({ group_id: Number(code), folder_id: folderId, folder: folderId,
          folder_name: text(folder.folderName, 'folder_name'), total_file_count: integer(folder.totalFileCount, 0, MAX_ID),
          ...groupFileMetadata(folder, groupFolderFields) });
      }
    }
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Group file query crossed a session change', { retcode: 1503 });
    return { files, folders, is_end: page.isEnd,
      ...(!page.isEnd && nextIndex !== undefined ? { next_index: nextIndex } : {}) };
  }

  async createGroupFolder(code, name, options) {
    const generation = this.generation;
    const unconfirmed = () => new BridgeError('UNCONFIRMED', 'Folder creation has no matching native confirmation',
      { retcode: 1502, outcome: 'unknown' });
    const response = await this.wait(null, () => this.richMedia.createGroupFolder(code, name),
      { ...options, sideEffect: true });
    if (!Number.isSafeInteger(response?.result)) throw unconfirmed();
    checkResult(response, true);
    const receipt = response.resultWithGroupItem;
    if (!Number.isSafeInteger(receipt?.result?.retCode) || !Array.isArray(receipt.groupItem) ||
        (receipt.result.retCode !== 0 && receipt.groupItem.length !== 0)) throw unconfirmed();
    checkResult(receipt.result, true, 'retCode');
    if (receipt.groupItem.length !== 1) throw unconfirmed();
    const [entry] = receipt.groupItem;
    const folder = entry?.folderInfo;
    const folderId = folder?.folderId;
    if (entry?.peerId !== code || entry.fileInfo != null || folder?.parentFolderId !== '/' ||
        folder.folderName !== name || !isGroupFolderId(folderId)) throw unconfirmed();
    try {
      await this.probe();
      if (generation !== this.generation || options.signal?.aborted) throw new Error('stale');
    } catch {
      throw unconfirmed();
    }
    return { result: { retCode: 0 }, groupItem: [{ peerId: code,
      folderInfo: { folderId, parentFolderId: '/', folderName: name } }] };
  }

  async changeGroupFile({ group_id, file_id, bus_id, current_parent_directory: source, target_parent_directory: destination }, options) {
    const code = String(group_id);
    const generation = this.generation;
    const moving = destination !== undefined;
    const readFileInfo = async () => {
      const details = checkResult(await this.wait(null, () => this.richMedia.getGroupFileInfo(code, file_id), options));
      return checkResult(details.groupFileInfoResult, false, 'retCode').fileInfo;
    };
    const info = await readFileInfo();
    if (info?.fileId !== file_id || info.isFolder === true || !Number.isInteger(info.busId) || info.busId < 1 || info.busId > 0xffffffff ||
        (bus_id !== undefined && bus_id !== info.busId) || (moving && info.parentFolderId !== source))
      throw invalid('Group file metadata does not match the requested file or directory');
    const businessId = info.busId;
    await this.probe();
    if (generation !== this.generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Group file request crossed a session change before submission', { retcode: 1503 });
    const response = await this.wait(null, () => moving
      ? this.richMedia.moveGroupFile(code, [businessId], [file_id], source, destination)
      : this.richMedia.deleteGroupFile(code, [businessId], [file_id]),
      { ...options, sideEffect: true });
    checkResult(response, true);
    const receipt = moving ? response.moveGroupFileResult : response.transGroupFileResult;
    checkResult(receipt?.result, true, 'retCode');
    const { successFileIdList, failFileIdList } = receipt;
    if (Array.isArray(successFileIdList) && successFileIdList.length === 0 &&
        Array.isArray(failFileIdList) && failFileIdList.length === 1 && failFileIdList[0] === file_id)
      throw new BridgeError('NATIVE_REJECTED', 'Native file operation was rejected', { retcode: 1500, outcome: 'rejected' });
    if (!Array.isArray(successFileIdList) || successFileIdList.length !== 1 || successFileIdList[0] !== file_id ||
        !Array.isArray(failFileIdList) || failFileIdList.length !== 0)
      throw new BridgeError('UNCONFIRMED', 'Native group file receipt does not match the request', { retcode: 1502, outcome: 'unknown' });
    try {
      await this.probe();
      if (generation !== this.generation || options.signal?.aborted) throw new Error('stale');
    } catch {
      throw new BridgeError('STALE_SESSION', 'Group file operation crossed a session change', { retcode: 1502, outcome: 'unknown' });
    }
    if (moving) {
      try {
        const moved = await readFileInfo();
        const matches = moved?.fileId === file_id && moved.isFolder !== true &&
          moved.busId === businessId && moved.parentFolderId === destination;
        await this.probe();
        if (!matches || generation !== this.generation || options.signal?.aborted) throw new Error('unconfirmed');
      } catch {
        throw new BridgeError('UNCONFIRMED', 'Move could not be confirmed in the destination directory', { retcode: 1502, outcome: 'unknown' });
      }
      return { ok: true };
    }
    return { result: 0, transGroupFileResult: { result: { retCode: 0 }, successFileIdList: [file_id], failFileIdList: [] } };
  }

  async getProfileLikes({ user_id = BOT, start, count }, options, generation) {
    const self = user_id === BOT;
    const uid = self ? this.identity.uid : await this.uid(user_id, options);
    if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(uid))
      throw new BridgeError('UID_UNRESOLVED', 'Profile identity could not be resolved', { retcode: 1404 });
    const current = () => {
      if (!this.attached || this.generation !== generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Profile like query crossed a session change', { retcode: 1503 });
    };
    current();
    const response = await this.wait(null, () => this.profileLike.getBuddyProfileLike({ friendUids: [uid],
      basic: 1, vote: 1, favorite: 0, userProfile: 1, type: self ? 2 : 1, start, limit: count }), options);
    boundForwardResponse(response);
    const entries = checkResult(response).info?.userLikeInfos;
    if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.uid !== uid) throw forwardInvalid();
    const { time, favoriteInfo, voteInfo } = entries[0];
    if (typeof time !== 'string' || !/^\d{1,20}$/.test(time)) throw forwardInvalid();
    const accounts = new Set();
    for (const info of [favoriteInfo, voteInfo]) {
      if (!Array.isArray(info?.userInfos) || info.userInfos.length > count) throw forwardInvalid();
      for (const entry of info.userInfos) {
        if (typeof entry?.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(entry.uid)) throw forwardInvalid();
        accounts.add(entry.uid);
      }
    }
    let uins = new Map();
    if (accounts.size) {
      current();
      const reply = await this.wait(null, () => this.group.getUinByUids([...accounts]), options);
      boundForwardResponse(reply);
      uins = checkResult(reply, false, 'errCode').uins;
      if (!(uins instanceof Map)) throw forwardInvalid();
    }
    const project = (info, counters) => ({ ...Object.fromEntries(counters.map(key => [key, integer(info[key], 0, Number.MAX_SAFE_INTEGER)])),
      userInfos: info.userInfos.flatMap(entry => {
        const uin = uins.get(entry.uid);
        if (typeof uin !== 'string' || uin === MAIN || !/^[1-9]\d{0,15}$/.test(uin) || !Number.isSafeInteger(Number(uin))) return [];
        return [{ uid: entry.uid, uin: Number(uin), nick: text(entry.nick ?? '', 'nickname'),
          ...(Number.isSafeInteger(entry.count) && entry.count >= 0 && { count: entry.count }),
          ...(Number.isSafeInteger(entry.latestTime) && entry.latestTime >= 0 && { latestTime: entry.latestTime }) }];
      }) });
    await this.probe();
    current();
    return { uid, time, favoriteInfo: project(favoriteInfo, ['total_count', 'last_time', 'today_count']),
      voteInfo: project(voteInfo, ['total_count', 'new_count', 'new_nearby_count', 'last_visit_time']) };
  }

  async fetchPttText(messageId, { signal }, generation) {
    const cancelled = () => new BridgeError('CANCELLED', 'Voice transcription wait was cancelled', { retcode: 1502 });
    if (signal?.aborted) throw cancelled();
    const key = Number(id(messageId, 'message_id'));
    let job = this.#voiceTranscriptions.get(key);
    if (!job) {
      if (this.#voiceTranscriptions.size >= 16)
        throw new BridgeError('BUSY', 'Voice transcription capacity reached', { retcode: 1503 });
      const controller = new AbortController();
      job = { controller, result: this.readPttText(messageId, { signal: controller.signal }, generation).finally(() => {
        if (this.#voiceTranscriptions.get(key)?.controller === controller) this.#voiceTranscriptions.delete(key);
      }) };
      this.#voiceTranscriptions.set(key, job);
    }
    let abort;
    try {
      const interrupted = signal && new Promise((_, reject) => {
        abort = () => reject(cancelled());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await (interrupted ? Promise.race([job.result, interrupted]) : job.result);
      if (signal?.aborted) throw cancelled();
      if (!this.attached || generation !== this.generation)
        throw new BridgeError('STALE_SESSION', 'Voice transcription crossed a session change', { retcode: 1503 });
      return { text: result.text };
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }

  async readPttText(messageId, options, generation) {
    const known = this.messages.get(messageId);
    const indexed = this.messages.byId.get(Number(messageId));
    const sender = this.#conversationUser(known.senderUin);
    const peer = rawPeer(known);
    const current = () => {
      if (!this.attached || generation !== this.generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Voice transcription crossed a session change', { retcode: 1503 });
      if (this.messages.byId.get(Number(messageId)) !== indexed)
        throw new BridgeError('MESSAGE_NOT_FOUND', 'Indexed message changed during transcription', { retcode: 1404 });
    };
    const read = async () => {
      current();
      const reply = await this.wait(null, () => this.msg.getMsgsByMsgId({ ...peer }, [known.msgId]), options);
      const message = selectMessageReadback(reply, peer, known.msgId);
      if (!message) throw new BridgeError('MESSAGE_NOT_FOUND', 'Native voice message was not found', { retcode: 1404 });
      if (String(message.senderUin) !== sender || (known.senderUid && message.senderUid !== known.senderUid)) throw forwardInvalid();
      const voice = message.elements.filter(element => element.elementType === 4);
      if (voice.length !== 1 || !voice[0].pttElement || typeof voice[0].elementId !== 'string' ||
          !voice[0].elementId || voice[0].elementId.length > 128)
        throw new BridgeError('VOICE_NOT_FOUND', 'Expected one identifiable voice segment', { retcode: 1404 });
      await this.probe();
      current();
      return voice[0];
    };
    let segment = await read();
    const cached = segment.pttElement.text;
    if (cached != null && typeof cached !== 'string') throw forwardInvalid();
    if (!cached?.trim()) {
      const elementId = segment.elementId;
      let busy = false;
      const receipt = await this.wait(null, async () => {
        const key = `${peerKey(peer)}:${known.msgId}:${elementId}`;
        const pending = this.#pendingNativeTranscriptions;
        if (pending.has(key) || pending.size >= 16) { busy = true; return; }
        const ticket = {};
        pending.set(key, ticket);
        try { return await this.msg.translatePtt2Text(known.msgId, { ...peer }, segment); }
        finally { if (pending.get(key) === ticket) pending.delete(key); }
      }, options);
      if (busy) throw new BridgeError('BUSY', 'Native voice transcription is still pending', { retcode: 1503 });
      checkResult(receipt);
      for (const waitMs of [0, 100, 250, 500]) {
        if (waitMs) await delay(waitMs, undefined, { signal: options.signal });
        segment = await read();
        if (segment.elementId !== elementId) throw forwardInvalid();
        const candidate = segment.pttElement.text;
        if (candidate != null && typeof candidate !== 'string') throw forwardInvalid();
        if (candidate?.trim()) break;
      }
    }
    const transcript = segment.pttElement.text;
    if (typeof transcript !== 'string' || !transcript.trim() || Buffer.byteLength(transcript, 'utf8') > 16384)
      throw new BridgeError('TRANSCRIPT_UNAVAILABLE', 'Voice transcription is unavailable', { retcode: 1404 });
    return { text: transcript };
  }

  async getRecentContacts(count, options, generation) {
    const raw = await this.wait(null, () => this.recentContact.getRecentContactListSnapShot(count), options);
    boundForwardResponse(raw);
    const snapshot = checkResult(checkResult(raw).info, false, 'errCode').changedList;
    if (!Array.isArray(snapshot) || snapshot.length > count) throw forwardInvalid();
    const seen = new Set();
    const rows = [];
    for (const entry of snapshot) {
      if (!entry || !Number.isInteger(entry.chatType)) throw forwardInvalid();
      const { chatType, peerUid, peerUin, msgId, msgTime } = entry;
      if (chatType !== 1 && chatType !== 2) continue;
      if (chatType === 1 && peerUin === MAIN && this.#conversationPolicy !== 'original') continue;
      if (typeof peerUin !== 'string' || id(peerUin) !== peerUin ||
          (chatType === 2 ? peerUin !== peerUid : typeof peerUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(peerUid)) ||
          !isNativeMessageId(msgId) || typeof msgTime !== 'string' || !/^\d{1,16}$/.test(msgTime) ||
          !Number.isSafeInteger(Number(msgTime))) throw forwardInvalid();
      const peer = { chatType, peerUid, guildId: '' };
      const key = peerKey(peer);
      if (seen.has(key)) throw forwardInvalid();
      seen.add(key);
      rows.push({ peer, data: { chatType, peerUin, msgId, msgTime, remark: text(entry.remark ?? '', 'remark'),
        peerName: text(entry.peerName ?? '', 'peerName'), sendNickName: text(entry.sendNickName ?? '', 'nickname'),
        sendMemberName: text(entry.sendMemberName ?? '', 'card') } });
    }
    const current = () => {
      if (!this.attached || this.generation !== generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Recent contacts crossed a session change', { retcode: 1503 });
    };
    const projected = [];
    for (const { peer, data } of rows) {
      current();
      if (peer.chatType === 1) {
        if (await this.uid(data.peerUin, options, true) !== peer.peerUid) throw forwardInvalid();
        current();
      }
      const reply = await this.wait(null, () => this.msg.getMsgsByMsgId(peer, [data.msgId]), options);
      const message = selectMessageReadback(reply, peer, data.msgId);
      if (String(message?.senderUin) === MAIN && this.#conversationPolicy !== 'original') continue;
      if (message && peer.chatType === 1 && ![data.peerUin, BOT].includes(String(message.senderUin)))
        throw forwardInvalid();
      projected.push({ data, message });
    }
    await this.probe();
    current();
    return this.publishMessageBatch(staged => {
      const result = projected.map(({ data, message }) => message ? { ...data, lastestMsg: this.translate(message, staged) } : data);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) throw forwardInvalid();
      return result;
    });
  }

  async getFriendList(params, options, grouped = false) {
    const generation = this.generation;
    const refresh = bool(params.no_cache, grouped);
    const raw = checkResult(await this.wait(null, () => this.buddy.getBuddyListV2('0', refresh, 0), options));
    if (!Array.isArray(raw.data) || raw.data.length > 1024) throw invalid('Native friend list shape mismatch');
    const entries = [];
    const categories = [];
    const categoryIds = new Set();
    const uids = new Set();
    const projectFriend = friend => {
      const core = friend?.coreInfo;
      const uin = id(friend?.uin ?? core?.uin, 'friend QQ number');
      if (core?.uin !== undefined && String(core.uin) !== uin)
        throw invalid('Native friend profile QQ number mismatch');
      return { user_id: Number(uin), nickname: text(core?.nick ?? '', 'nickname'),
        remark: text(core?.remark ?? '', 'remark') };
    };
    let total = 0;
    for (const category of raw.data) {
      const uidOnly = category?.buddyUids !== undefined;
      const list = uidOnly ? category.buddyUids : category?.buddyList;
      if (!Array.isArray(list) || (total += list.length) > 10000)
        throw invalid('Native friend category shape mismatch');
      const categoryEntries = [];
      if (grouped) {
        const categoryId = integer(category.categoryId, 0, MAX_ID);
        const categoryName = text(category.categroyName ?? category.categoryName, 'category name');
        const categoryMbCount = integer(category.categroyMbCount ?? category.categoryMbCount, 0, MAX_ID);
        if (categoryIds.has(categoryId) || categoryMbCount !== list.length)
          throw invalid('Native friend category membership mismatch');
        categoryIds.add(categoryId);
        categories.push({ categoryId, categoryName, categoryMbCount, entries: categoryEntries });
      }
      for (const entry of list) {
        if (uidOnly) {
          if (typeof entry !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(entry))
            throw invalid('Native friend UID is invalid');
          if (uids.has(entry) && !grouped) continue;
          uids.add(entry);
        } else if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw invalid('Native friend profile is invalid');
        const snapshot = uidOnly ? entry : projectFriend(entry);
        entries.push(snapshot);
        if (grouped) categoryEntries.push(snapshot);
      }
    }
    const profiles = new Map();
    if (uids.size) {
      if (typeof this.profile?.getCoreAndBaseInfo !== 'function') throw unsupported();
      const ordered = [...uids];
      for (let offset = 0; offset < ordered.length; offset += 256) {
        const batch = ordered.slice(offset, offset + 256);
        if (!this.attached || this.generation !== generation || options.signal?.aborted)
          throw new BridgeError('STALE_SESSION', 'Friend query crossed a session change', { retcode: 1503 });
        const result = await this.wait(null, () => this.profile.getCoreAndBaseInfo('nodeStore', [...batch]), options);
        if (!(result instanceof Map) || result.size !== batch.length)
          throw new BridgeError('INCOMPLETE_FRIENDS', 'Friend profile batch is incomplete', { retcode: 1502 });
        for (const uid of batch) {
          const profile = result.get(uid);
          if (profile?.coreInfo?.uid !== uid || (profile.uid !== undefined && profile.uid !== uid))
            throw invalid('Native friend profile UID mismatch');
          profiles.set(uid, projectFriend(profile));
        }
      }
    }
    const friends = new Map();
    const friendsByEntry = new Map();
    for (const entry of entries) {
      const result = typeof entry === 'string' ? profiles.get(entry) : entry;
      const previous = friends.get(result.user_id);
      if (previous && (previous.nickname !== result.nickname || previous.remark !== result.remark))
        throw invalid('Conflicting native friend profiles');
      if (!previous) friends.set(result.user_id, result);
      if (grouped) friendsByEntry.set(entry, result);
    }
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Friend query crossed a session change', { retcode: 1503 });
    if (!grouped) return [...friends.values()];
    return categories.map(({ entries, ...category }) => {
      const buddyList = entries.map(entry => ({ ...friendsByEntry.get(entry), category_id: category.categoryId }));
      if (new Set(buddyList.map(friend => friend.user_id)).size !== buddyList.length)
        throw invalid('Duplicate friend in native category');
      return { ...category, buddyList };
    });
  }

  async readUserDetail(uin, options) {
    const raw = checkResult(await this.wait(null, () => this.profile.getUserDetailInfoByUin(uin), options));
    const detail = raw.detail;
    const core = detail?.simpleInfo?.coreInfo;
    if (detail?.uin !== uin || (core?.uin !== undefined && core.uin !== uin) ||
        (core?.uid !== undefined && core.uid !== detail.uid))
      throw invalid('Native profile identity mismatch');
    return detail;
  }

  async setSelfProfile(params, options) {
    const generation = this.generation;
    const current = () => this.attached && this.generation === generation && !options.signal?.aborted;
    const birthdayKeys = ['birthday_year', 'birthday_month', 'birthday_day'];
    const read = async () => {
      const detail = await this.readUserDetail(BOT, options);
      const base = detail.simpleInfo?.baseInfo;
      const birthday = {};
      for (const [i, field] of birthdayKeys.entries()) {
        const value = base?.[field];
        if (!Number.isInteger(value) || value < 0 || value > [9999, 12, 31][i]) throw forwardInvalid();
        birthday[field] = String(value);
      }
      if (typeof detail.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(detail.uid) ||
          (this.identity?.uid !== undefined && detail.uid !== this.identity.uid) || ![0, 1, 2, 255].includes(base.sex))
        throw forwardInvalid();
      return { uid: detail.uid, nick: text(detail.simpleInfo?.coreInfo?.nick, 'native nickname'),
        longNick: text(base.longNick, 'native signature'), sex: base.sex, birthday };
    };
    const previous = await read();
    const { uid, nick, longNick, sex, birthday } = previous;
    // 生日写入补全（2026-11-23）：内核 modifyDesktopMiniProfile 本来就收 birthday，
    // 以前只读不写（改了也只能改昵称/签名/性别）。三个字段必须一起给：
    // 只给年或只给月，原生会写进一个半截生日，读回来就成了"我改坏了"。
    const supplied = birthdayKeys.filter(key => params[key] !== undefined);
    let desiredBirthday = birthday;
    if (supplied.length) {
      if (supplied.length !== birthdayKeys.length)
        throw invalid('Provide birthday_year, birthday_month and birthday_day together');
      const next = {};
      for (const [i, field] of birthdayKeys.entries()) {
        const value = Number(params[field]);
        if (!Number.isInteger(value) || value < 0 || value > [9999, 12, 31][i])
          throw invalid(`Invalid ${field}`);
        next[field] = String(value);
      }
      desiredBirthday = next;
    }
    const desired = { nick: params.nickname ?? nick, longNick: params.personal_note ?? longNick,
      sex: params.sex ?? sex, birthday: desiredBirthday };
    await this.probe();
    if (!current()) throw new BridgeError('STALE_SESSION', 'Profile request crossed a session change', { retcode: 1503 });
    if (desired.nick === nick && desired.longNick === longNick && desired.sex === sex &&
        birthdayKeys.every(field => desiredBirthday[field] === birthday[field])) return null;
    const response = await this.wait(null, () => this.profile.modifyDesktopMiniProfile({ ...desired, location: undefined }),
      { ...options, sideEffect: true });
    checkResult(response, true);
    try {
      const observed = await read();
      await this.probe();
      if (!current() || observed.uid !== uid || observed.nick !== desired.nick || observed.longNick !== desired.longNick ||
          observed.sex !== desired.sex ||
          birthdayKeys.some(field => observed.birthday[field] !== desiredBirthday[field]))
        throw new Error('Profile mismatch');
    } catch {
      throw new BridgeError('UNCONFIRMED', 'Self profile readback did not match the requested update', { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  async setSelfLongNick(params, options) {
    let desired;
    try { ({ long_nick: desired } = validateParams('set_self_longnick', params)); }
    catch { throw invalid('Expected one bounded signature field'); }
    const generation = this.generation;
    const assertCurrent = () => {
      if (!this.attached || this.generation !== generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Signature request crossed a session change', { retcode: 1503 });
    };
    const readProfile = async () => {
      assertCurrent();
      const detail = await this.readUserDetail(BOT, options);
      if (typeof detail.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(detail.uid))
        throw new BridgeError('PROFILE_MISMATCH', 'Native self profile identity did not match', { retcode: 1404 });
      return { uid: detail.uid, signature: text(detail.simpleInfo?.baseInfo?.longNick, 'native signature') };
    };
    const previous = await readProfile();
    await this.probe();
    assertCurrent();
    if (previous.signature === desired) return null;
    const response = await this.wait(null, () => this.profile.setLongNick(desired), { ...options, sideEffect: true });
    if (typeof response?.result === 'number') checkResult(response, true);
    try {
      const current = await readProfile();
      if (current.uid !== previous.uid || current.signature !== desired) throw new Error('Profile mismatch');
      await this.probe();
      assertCurrent();
    } catch {
      throw new BridgeError('UNCONFIRMED', 'Self profile readback did not confirm the submitted signature',
        { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  receiveFriendRequests(page, generation) {
    if (!Array.isArray(page?.buddyReqs) || page.buddyReqs.length > MAX_FRIEND_REQUESTS) return;
    for (const row of page.buddyReqs) {
      const { friendUid: uid, reqTime, reqType, isDecide, isInitiator, isDoubt, extWords } = row ?? {};
      if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(uid) ||
          typeof reqTime !== 'string' || !/^[1-9]\d{0,15}$/.test(reqTime) || !Number.isSafeInteger(Number(reqTime))) continue;
      const key = `${uid}:${reqTime}`;
      const existing = this.friendRequests.get(key);
      if (existing) {
        if (isDecide === true) {
          existing.decided = true;
          this.receipts.emit(`friend:${key}`, reqType);
        }
        continue;
      }
      if (reqType !== 1 || isDecide !== false || isInitiator === true || isDoubt === true ||
          typeof extWords !== 'string' || extWords.length > 1024) continue;
      const time = Number(reqTime);
      if (time < this.retiredFriendRequestTime ||
          (time === this.retiredFriendRequestTime && this.retiredFriendRequestUids.has(uid))) continue;
      if (this.friendRequests.size >= MAX_FRIEND_REQUESTS) {
        let oldest;
        for (const candidate of this.friendRequests.values()) {
          if (candidate.time === this.retiredFriendRequestTime && this.retiredFriendRequestUids.size >= MAX_FRIEND_REQUESTS) continue;
          if (candidate.decided && !candidate.processing && (!oldest || candidate.time < oldest.time)) oldest = candidate;
        }
        if (!oldest || time < oldest.time) continue;
        // Keep the exact retired identities at the boundary second. Once the
        // boundary advances, the timestamp alone covers the older identities.
        this.friendRequests.delete(`${oldest.uid}:${oldest.reqTime}`);
        if (oldest.time > this.retiredFriendRequestTime) {
          this.retiredFriendRequestTime = oldest.time;
          this.retiredFriendRequestUids.clear();
        }
        if (oldest.time === this.retiredFriendRequestTime) this.retiredFriendRequestUids.add(oldest.uid);
      }
      const entry = { uid, reqTime, time, flag: 'friend-' + randomBytes(16).toString('hex') };
      this.friendRequests.set(key, entry);
      void this.wait(null, () => this.profile.getCoreAndBaseInfo('nodeStore', [uid])).then(async profiles => {
        const profile = profiles instanceof Map && profiles.size === 1 ? profiles.get(uid)?.coreInfo : undefined;
        if (profile?.uid !== uid) return;
        if (!['string', 'number'].includes(typeof profile.uin)) return;
        const account = user(profile.uin);
        if (account === BOT) return;
        await this.probe();
        if (!this.attached || this.generation !== generation || entry.decided) return;
        entry.account = account;
        this.safeEmit('event', { self_id: Number(BOT), post_type: 'request', request_type: 'friend',
          user_id: Number(account), time, comment: extWords, flag: entry.flag });
      }).catch(() => {}).finally(() => {
        // A later native notification can retry this read-only lookup. Keep
        // published or decided requests bound to their original identity.
        if (!entry.account && !entry.decided && this.friendRequests.get(key) === entry)
          this.friendRequests.delete(key);
      });
    }
  }

  async decideFriendRequest({ flag, approve, remark }, options) {
    const entry = [...this.friendRequests.values()].find(value => value.flag === flag);
    if (!entry?.account || entry.decided || entry.submitted || entry.processing) throw invalid('Friend request is no longer actionable');
    if (remark && !this.capabilities().includes('set_friend_remark')) throw unsupported();
    const generation = this.generation;
    const { uid, reqTime, account } = entry;
    entry.processing = true;
    try {
      const result = await this.wait(`friend:${uid}:${reqTime}`, async () => {
        entry.submitted = true;
        const completion = await this.buddy.approvalFriendRequest({ friendUid: uid, reqTime, accept: approve });
        // The documented Promise<void> confirms only that the call completed.
        // Keep waiting for the request-specific decision notification.
        if (completion !== undefined) checkResult(completion, true);
        return { result: 0 };
      }, { ...options, sideEffect: true, requireAck: true,
        shouldSubmit: () => !entry.decided && !entry.submitted && (options.shouldSubmit?.() ?? true) });
      try {
        if (result !== (approve ? 3 : 7)) throw new Error('Different decision');
        await this.probe();
        if (generation !== this.generation || options.signal?.aborted) throw new Error('Stale decision');
        if (remark) await this.setFriendRemark({ user_id: account, remark }, options, uid);
      } catch {
        throw new BridgeError('UNCONFIRMED', 'Friend request decision or remark could not be confirmed', { retcode: 1502, outcome: 'unknown' });
      }
      return null;
    } finally {
      entry.processing = false;
    }
  }

  async setFriendRemark(params, options, expectedUid) {
    const wanted = user(params.user_id);
    const desired = text(params.remark, 'remark', 256);
    const generation = this.generation;
    const uid = await this.uid(wanted, options);
    if (expectedUid !== undefined && uid !== expectedUid)
      throw new BridgeError('PROFILE_MISMATCH', 'Friend remark did not resolve to the approved account', { retcode: 1404 });
    const assertCurrent = () => {
      if (!this.attached || this.generation !== generation || options.signal?.aborted)
        throw new BridgeError('STALE_SESSION', 'Friend remark crossed a session change', { retcode: 1503 });
    };
    const readRemark = async () => {
      assertCurrent();
      const profiles = await this.wait(null, () => this.profile.getCoreAndBaseInfo('nodeStore', [uid]), options);
      const core = profiles instanceof Map && profiles.size === 1 ? profiles.get(uid)?.coreInfo : null;
      if (core?.uid !== uid || core?.uin !== wanted)
        throw new BridgeError('PROFILE_MISMATCH', 'Native friend profile identity did not match', { retcode: 1404 });
      return text(core.remark, 'native remark');
    };
    assertCurrent();
    const isBuddy = await this.wait(null, () => this.buddy.isBuddy(uid), options);
    if (isBuddy !== true) throw new BridgeError('FRIEND_UNVERIFIED', 'Friend relationship could not be confirmed', { retcode: 1404 });
    const previous = await readRemark();
    await this.probe();
    assertCurrent();
    if (previous === desired) return null;
    const result = await this.wait(null, () => this.buddy.setBuddyRemark({ uid, remark: desired }),
      { ...options, sideEffect: true });
    if (result !== undefined) checkResult(result, true);
    try {
      if (await readRemark() !== desired) throw new Error('Remark mismatch');
      await this.probe();
      assertCurrent();
    } catch {
      throw new BridgeError('UNCONFIRMED', 'Friend remark readback did not confirm the submitted change',
        { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  async refreshMembersAfterCacheMiss(groupCode, signal) {
    const cancelled = () => new BridgeError('CANCELLED', 'Member refresh was cancelled', { retcode: 1502 });
    if (signal?.aborted) throw cancelled();
    let refresh = this.memberRefreshes.get(groupCode);
    if (!refresh) {
      refresh = this.members(groupCode, {}, true).finally(() => {
        if (this.memberRefreshes.get(groupCode) === refresh) this.memberRefreshes.delete(groupCode);
      });
      this.memberRefreshes.set(groupCode, refresh);
    }
    if (!signal) return refresh;
    let abort;
    try {
      const interrupted = new Promise((_, reject) => {
        abort = () => reject(cancelled());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const members = await Promise.race([refresh, interrupted]);
      if (signal.aborted) throw cancelled();
      return members;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async members(groupCode, options, fresh = false, target) {
    const generation = this.generation;
    const raw = checkResult(await this.wait(null, () => this.group.getAllMemberList(groupCode, fresh), options), false, 'errCode');
    const infos = raw.result?.infos;
    if (!(infos instanceof Map) || Object.getPrototypeOf(infos) !== Map.prototype || raw.result.finish !== true)
      throw new BridgeError('INCOMPLETE_MEMBERS', 'Native member list is incomplete', { retcode: 1502 });
    if (infos.size > 10000) throw forwardInvalid();
    const seenUins = new Set(), seenUids = new Set(), members = [];
    for (const member of Map.prototype.values.call(infos)) {
      if (typeof member?.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,125}$/.test(member.uid) ||
          !['string', 'number'].includes(typeof member.uin)) throw forwardInvalid();
      const uin = id(member.uin, 'member.uin');
      if (seenUins.has(uin) || seenUids.has(member.uid)) throw forwardInvalid();
      seenUins.add(uin);
      seenUids.add(member.uid);
      if (target && (target.uin !== uin || target.uid !== member.uid)) continue;
      const { memberRealLevel, shutUpTime, isRobot } = member;
      members.push({ group_id: Number(groupCode), user_id: Number(uin),
        nickname: text(member.nick ?? '', 'nickname'), card: text(member.cardName ?? '', 'card'),
        sex: member.sex === 1 ? 'male' : member.sex === 2 ? 'female' : 'unknown',
        age: integer(member.age, 0, 255, 0), area: '', join_time: integer(Number(member.joinTime ?? 0), 0, Number.MAX_SAFE_INTEGER),
        last_sent_time: integer(Number(member.lastSpeakTime ?? 0), 0, Number.MAX_SAFE_INTEGER),
        level: Number.isSafeInteger(memberRealLevel) && memberRealLevel >= 0 ? String(memberRealLevel) : '',
        ...(Number.isSafeInteger(shutUpTime) && shutUpTime >= 0 && { shut_up_timestamp: shutUpTime }),
        ...(typeof isRobot === 'boolean' && { is_robot: isRobot }),
        role: member.role === 4 ? 'owner' : member.role === 3 ? 'admin' : 'member',
        unfriendly: false, title: text(member.memberSpecialTitle ?? '', 'title'), title_expire_time: 0, card_changeable: true });
    }
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Member query crossed a session change', { retcode: 1503 });
    return members;
  }

  async setInputStatus(params, options) {
    const type = params.event_type;
    if (type !== 0 && type !== 1 && type !== '0' && type !== '1')
      throw invalid('event_type must be 0 or 1');
    const generation = this.generation;
    const uid = await this.uid(params.user_id, options, true);
    await this.probe();
    if (!this.attached || this.generation !== generation)
      throw new BridgeError('STALE_SESSION', 'Input status crossed a session change before submission');
    const result = await this.wait(null, () => this.msg.sendShowInputStatusReq(1, Number(type), uid),
      { ...options, sideEffect: true });
    checkResult(result, true);
    try {
      await this.probe();
      if (this.generation !== generation || options?.signal?.aborted) throw new Error('stale');
    } catch {
      throw new BridgeError('STALE_SESSION', 'Input status confirmation crossed a session change',
        { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  // OneBot set_online_status. The fixed kernel contract is msg.setStatus with
  // the NapCat status table (10 online / 30 away / 40 hidden / 50 busy / 60
  // call-me / 70 dnd). ext_status/battery_status are forward-compatible fields;
  // customStatus is not persisted here because the fixed sample only proves
  // status/extStatus/batteryStatus. A non-acknowledged setStatus is unknown.
  async setOnlineStatus(params, options) {
    const allowed = ['status', 'ext_status', 'battery_status'];
    if (Object.keys(params).some(key => !allowed.includes(key))) throw invalid('Invalid set_online_status parameters');
    const status = integer(params.status ?? 10, 10, 70);
    const extStatus = integer(params.ext_status ?? 0, 0, 2147483647);
    const batteryStatus = integer(params.battery_status ?? 0, 0, 100);
    const generation = this.generation;
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Status update crossed a session change before submission', { retcode: 1503 });
    const result = await this.wait(null, () => this.msg.setStatus({ status, extStatus, batteryStatus }),
      { ...options, sideEffect: true });
    checkResult(result, true);
    try {
      await this.probe();
      if (this.generation !== generation || options.signal?.aborted) throw new Error('stale');
    } catch {
      throw new BridgeError('STALE_SESSION', 'Status update confirmation crossed a session change',
        { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  // OneBot friend_poke / group_poke. sendNudge({receiverUid, callerUid, confId})
  // where confId is the group peerUid for groups and absent for private. The
  // caller is the bot itself; the receiver is the resolved UID of the target.
  async sendNudge(action, params, options) {
    const group = action === 'group_poke';
    const generation = this.generation;
    const receiverUin = group ? params.user_id : params.user_id;
    const callerUid = this.identity?.uid;
    if (!callerUid || !/^u_[A-Za-z0-9_-]{1,125}$/.test(callerUid))
      throw new BridgeError('IDENTITY_UNAVAILABLE', 'Nudge requires the verified bot UID', { retcode: 1503 });
    const receiverUid = await this.uid(receiverUin, options, true);
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Nudge crossed a session change before submission', { retcode: 1503 });
    const nudgeParam = { receiverUid, callerUid };
    if (group) nudgeParam.confId = id(params.group_id, 'group_id');
    let result;
    try {
      result = await this.wait(null, () => this.msg.sendNudge(nudgeParam),
        { ...options, sideEffect: true, timeoutMs: SEND_ACCEPT_WAIT_MS });
    } catch (error) {
      // 戳一戳同样是 side effect：等满窗口 → 运行端把它记成 unknown → 该会话进 held 闸门。
      // 实测私聊 <OWNER_UIN> 就挂着 5 条 `friend_poke HTTP 504` 把整个私聊挡住了。
      // 原生 `sendNudge` 已提交、只是没有回执时，按「已接受」返回（OneBot 侧该动作本就没有回执语义）。
      if (error instanceof BridgeError && (error.code === 'TIMEOUT' || error.outcome === 'unknown')) {
        this.stats.nudgeProvisionalAcks++;
        console.warn('[poke] 回执未在 ' + SEND_ACCEPT_WAIT_MS + 'ms 内返回，按已接受处理（不重试）');
        return null;
      }
      throw error;
    }
    if (result !== undefined) checkResult(result, true);
    try {
      await this.probe();
      if (this.generation !== generation || options.signal?.aborted) throw new Error('stale');
    } catch {
      throw new BridgeError('STALE_SESSION', 'Nudge confirmation crossed a session change', { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  // OneBot get_group_honor_info. group.getGroupHonorList(code) returns
  // { result, groupHonorList? } where entries carry { userId, nick, honorLevel,
  // honorType, honorName, time }. Project only bounded scalar fields.
  async getGroupHonor(code, options) {
    const generation = this.generation;
    const result = await this.wait(null, () => this.group.getGroupHonorList(code), options);
    boundForwardResponse(result);
    checkResult(result);
    const list = result.groupHonorList;
    if (!Array.isArray(list) || list.length > 4096) throw forwardInvalid();
    const seen = new Set();
    const honors = list.map(entry => {
      const uin = entry?.userId;
      if (!['string', 'number'].includes(typeof uin) || !/^[1-9]\d{0,15}$/.test(String(uin)) ||
          !Number.isSafeInteger(Number(uin))) throw forwardInvalid();
      const key = String(uin);
      if (seen.has(key)) throw forwardInvalid();
      seen.add(key);
      return {
        user_id: Number(uin),
        nickname: text(entry?.nick ?? entry?.nickName ?? '', 'nickname'),
        honor_level: integer(entry?.honorLevel, 0, 2147483647, 0),
        honor_type: integer(entry?.honorType, 0, 2147483647, 0),
        honor_name: text(entry?.honorName ?? '', 'honor_name'),
      };
    });
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Honor query crossed a session change', { retcode: 1503 });
    return { group_id: Number(code), honors };
  }

  async setAvatar(params, options) {
    const file = params.file;
    if (typeof file !== 'string' || !file || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file))
      throw invalid('Expected a bounded local avatar file path');
    if (!file.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(file)) throw invalid('Expected an absolute local avatar file path');
    const generation = this.generation;
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Avatar update crossed a session change before submission', { retcode: 1503 });
    const result = await this.wait(null, () => this.profile.setHeader(file), { ...options, sideEffect: true });
    checkResult(result, true);
    try {
      await this.probe();
      if (this.generation !== generation || options.signal?.aborted) throw new Error('stale');
    } catch {
      throw new BridgeError('STALE_SESSION', 'Avatar update confirmation crossed a session change', { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  async addCustomFace(params, options) {
    const file = params.file;
    if (typeof file !== 'string' || !file || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file))
      throw invalid('Expected a bounded custom face source');
    const generation = this.generation;
    await this.probe();
    if (!this.attached || this.generation !== generation || options.signal?.aborted)
      throw new BridgeError('STALE_SESSION', 'Custom face crossed a session change before submission', { retcode: 1503 });
    const result = await this.wait(null, () => this.msg.addFavEmoji(file), { ...options, sideEffect: true });
    checkResult(result, true);
    try {
      await this.probe();
      if (this.generation !== generation || options.signal?.aborted) throw new Error('stale');
    } catch {
      throw new BridgeError('STALE_SESSION', 'Custom face confirmation crossed a session change', { retcode: 1502, outcome: 'unknown' });
    }
    return null;
  }

  async kickGroupMember(params, options = {}, batch = false) {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(params)) || Object.keys(params).some(key => !['group_id', 'user_id', 'reject_add_request'].includes(key)) ||
        !['number', 'string'].includes(typeof params.group_id)) throw invalid('Expected one exact group');
    const targets = batch ? params.user_id : [params.user_id];
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 50)
      throw invalid('Expected 1 through 50 kick targets');
    const accounts = Array.from(targets, value => {
      if (!['number', 'string'].includes(typeof value)) throw invalid('Expected an exact kick target');
      const account = user(value);
      if (batch && account === BOT) throw invalid('The robot cannot be a batch kick target');
      return account;
    });
    if (new Set(accounts).size !== accounts.length) throw invalid('Duplicate kick target');
    const flag = params.reject_add_request;
    const rejectSubsequent = bool(batch && (flag === 'true' || flag === 'false') ? flag === 'true' : flag);
    const code = id(params.group_id, 'group_id');
    const generation = this.generation, sessionId = this.identity?.sessionId;
    const unknown = () => new BridgeError('UNCONFIRMED', 'Kick outcome or complete readback is unknown; do not retry automatically', { retcode: 1502, outcome: 'unknown' });
    const beforeFailure = () => new BridgeError('MEMBER_IDENTITY_UNCONFIRMED', 'Complete same-group member identity was not established', { retcode: 1502 });
    const own = (object, name) => {
      if (!object || typeof object !== 'object' || Array.isArray(object)) throw beforeFailure();
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw beforeFailure();
      return descriptor.value;
    };
    const validUid = value => typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,125}$/.test(value);
    const ensureCurrent = () => {
      if (options.signal?.aborted || !this.attached || this.generation !== generation || this.identity?.sessionId !== sessionId)
        throw new BridgeError('STALE_SESSION', 'Kick request lost its original session before confirmation', { retcode: 1503 });
    };
    const membership = async () => {
      const raw = await this.wait(null, () => { ensureCurrent(); return this.group.getAllMemberList(code, true); }, options);
      ensureCurrent();
      const errCode = own(raw, 'errCode');
      if (!Number.isInteger(errCode) || errCode !== 0) throw beforeFailure();
      const result = own(raw, 'result'), infos = own(result, 'infos');
      if (own(result, 'finish') !== true || !(infos instanceof Map) || Object.getPrototypeOf(infos) !== Map.prototype) throw beforeFailure();
      const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(infos);
      if (size > 10000) throw beforeFailure();
      const byUin = new Map(), uids = new Set();
      // The map key is deliberately ignored: only documented member value
      // fields establish UIN<->UID identity and absence of the exact target.
      for (const member of Map.prototype.values.call(infos)) {
        const memberUin = own(member, 'uin'), memberUid = own(member, 'uid');
        if (!['number', 'string'].includes(typeof memberUin) || !validUid(memberUid)) throw beforeFailure();
        const uin = id(memberUin, 'member.uin');
        if (byUin.has(uin) || uids.has(memberUid)) throw beforeFailure();
        byUin.set(uin, memberUid); uids.add(memberUid);
      }
      return { byUin, uids };
    };
    ensureCurrent();
    let uids;
    if (batch) {
      const resolution = await this.wait(null, () => this.group.getUidByUins([...accounts]), options);
      const errCode = own(resolution, 'errCode');
      if (!Number.isInteger(errCode) || errCode !== 0) throw beforeFailure();
      const resolved = own(resolution, 'uids');
      if (!(resolved instanceof Map) || Object.getPrototypeOf(resolved) !== Map.prototype) throw beforeFailure();
      uids = accounts.map(account => Map.prototype.get.call(resolved, account));
    } else {
      uids = [await this.uid(accounts[0], options)];
    }
    ensureCurrent();
    const expected = new Set(uids);
    if (!uids.every(validUid) || expected.size !== accounts.length) throw beforeFailure();
    const before = await membership();
    if (!accounts.every((account, index) => before.byUin.get(account) === uids[index])) throw beforeFailure();
    await this.probe(); ensureCurrent();
    let submitted = false;
    try {
      // Fixed official legacy path: (groupCode, [uid], reject-join flag, reason).
      // No clear-history operation or undocumented V2 option is invoked.
      const ack = await this.wait(null, () => {
        ensureCurrent(); submitted = true;
        return this.group.kickMember(code, [...uids], rejectSubsequent, '');
      }, { ...options, sideEffect: true });
      ensureCurrent();
      const outerCode = own(ack, 'errCode');
      if (!Number.isInteger(outerCode) || outerCode < -2147483648 || outerCode > 2147483647) throw unknown();
      const entries = own(ack, 'resultList');
      if (!Array.isArray(entries) || entries.length !== expected.size) throw unknown();
      const seen = new Set();
      let successes = 0;
      for (let index = 0; index < entries.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw unknown();
        const entry = descriptor.value, replyUid = own(entry, 'uid'), memberCode = own(entry, 'result');
        if (!expected.has(replyUid) || seen.has(replyUid) || !Number.isInteger(memberCode) || memberCode < 0 ||
            memberCode > 4294967295) throw unknown();
        seen.add(replyUid);
        if (memberCode === 0) successes++;
      }
      if (successes === 0) throw new BridgeError('NATIVE_REJECTED', 'Native target removal was rejected', { retcode: 1500, outcome: 'rejected' });
      if (outerCode !== 0 || successes !== expected.size) throw unknown();
      await this.probe(); ensureCurrent();
      const after = await membership();
      if (accounts.some(account => after.byUin.has(account)) || uids.some(uid => after.uids.has(uid))) throw unknown();
      await this.probe(); ensureCurrent();
      // This confirms only same-session absence after an acknowledged request.
      // It does not prove future join-request rejection or causal exclusivity.
      return null;
    } catch (error) {
      if (!submitted) throw error instanceof BridgeError ? new BridgeError(error.code, 'Kick was not submitted', { retcode: error.retcode, outcome: 'not_started' }) : beforeFailure();
      if (error instanceof BridgeError && error.outcome === 'rejected') throw error;
      throw unknown();
    }
  }

  async getHistory(input, type, options = {}) {
    let params;
    try { params = normalizeHistoryParams(input, type === 'group' ? 'group_id' : 'user_id'); }
    catch { throw invalid('Invalid history parameters or unsupported direction flag'); }
    const generation = this.generation, sessionId = this.identity?.sessionId;
    const peer = await this.peer(params, type, options);
    const rejectResponse = () => { throw forwardInvalid(); };
    const nativeInteger = value => {
      if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) rejectResponse();
      return BigInt(value);
    };
    let anchor;
    if (params.message_seq !== undefined) {
      const matches = [...this.messages.byId.values()].filter(entry => peerEqual(rawPeer(entry.raw), peer) && entry.raw.msgSeq === params.message_seq);
      if (matches.length !== 1) throw new BridgeError('HISTORY_CURSOR_UNAVAILABLE', 'History sequence has no unique current-session message in this conversation', { retcode: 1404 });
      anchor = matches[0]; nativeInteger(anchor.raw.msgId); this.#conversationUser(anchor.raw.senderUin);
    }
    const ensureCurrent = () => {
      if (options.signal?.aborted) throw new BridgeError('CANCELLED', 'History query cancelled', { retcode: 1502 });
      if (!this.attached || this.generation !== generation || this.identity?.sessionId !== sessionId) throw new BridgeError('STALE_SESSION', 'History query crossed a session change', { retcode: 1503 });
      if (anchor) {
        const current = this.messages.byId.get(anchor.id);
        if (!current || current.key !== anchor.key || current.raw.msgSeq !== params.message_seq) throw new BridgeError('HISTORY_CURSOR_UNAVAILABLE', 'History cursor expired during query', { retcode: 1404 });
      }
    };
    ensureCurrent();
    // Official sample: latest uses Contact+count and returns an explicit
    // needContinueGetMsg flag. getMsgs parses its second argument with stoll;
    // never pass the empty-string fallback from the older MIT reference.
    // The five-argument getMsgsBySeqAndCount booleans are NOT guessed here.
    const response = await this.wait(null, () => {
      ensureCurrent();
      return anchor ? this.msg.getMsgs({ ...peer }, anchor.raw.msgId, params.count, false) : this.msg.getAioFirstViewLatestMsgs({ ...peer }, params.count);
    }, options);
    ensureCurrent(); boundForwardResponse(response); checkResult(response);
    // needContinueGetMsg is the AIO viewer's "there are older messages above this
    // page" flag, not a claim that THIS page is incomplete: NapCat's
    // GoCQHTTP_GetGroupMsgHistory / GetFriendMsgHistory consume .msgList and never
    // look at it. Requiring ===false made every conversation with more than `count`
    // messages fail with 1502, which is why every catchup at startup failed.
    // Accept a real boolean; still reject a missing or non-boolean field, because
    // then the response shape is not the contract we verified.
    if (!anchor && typeof response.needContinueGetMsg !== 'boolean')
      throw new BridgeError('HISTORY_INCOMPLETE', 'Latest-view history response lacks the continuation flag', { retcode: 1502 });
    if (!anchor && response.needContinueGetMsg) this.historyContinuationPages++;
    if (!Array.isArray(response.msgList) || response.msgList.length > params.count || response.msgList.length > this.messages.limit) rejectResponse();
    // Native may retain and later mutate its objects. Translate our checked copy.
    const raws = [];
    const messageIds = new Set(), sequences = new Set(); let totalSegments = 0, forwardCount = 0;
    const bounded = (value, limit = 65536, optional = false) => {
      if (optional && value === undefined) return;
      if (typeof value !== 'string' || value.length > limit) rejectResponse();
    };
    const record = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) rejectResponse();
      return value;
    };
    for (const raw of structuredClone(response.msgList)) {
      record(raw);
      if (raw.chatType !== peer.chatType || raw.peerUid !== peer.peerUid) rejectResponse();
      if (type === 'private' && ![BOT, String(params.user_id)].includes(String(raw.senderUin))) rejectResponse();
      nativeInteger(raw.msgId); const seq = nativeInteger(raw.msgSeq);
      // ★ 2026-11-23 真机实据：**msgSeq 在群里不唯一**。灰条（elementType 8，senderUin "0"）
      //   是本地插入的，不占新序号 —— 实测同一页里 `msgId 7785292425117701431`（真实文本）
      //   与 `msgId 7785292453650608706`（灰条）**都是 msgSeq 831719**。
      //   原先用 (msgId, msgSeq) 双重去重，于是每个含灰条的群历史都被判成「响应畸形」→ 1502，
      //   结果「历史补齐」在真机上 886 次全失败（最大的单一报错源）。
      //   唯一性只认 msgId；msgSeq 只是翻页游标，不参与唯一性判断。
      if (messageIds.has(raw.msgId)) rejectResponse();
      messageIds.add(raw.msgId); sequences.add(raw.msgSeq);
      if (params.message_seq !== undefined && seq > BigInt(params.message_seq)) throw new BridgeError('HISTORY_RANGE_UNCONFIRMED', 'Native history returned messages newer than the requested cursor', { retcode: 1502 });
      // 系统/灰条消息的 senderUin 是 "0"（没有真实发送者），不能按账号格式校验。
      const isSystem = String(raw.senderUin) === '0';
      // 这类条目（群公告/入群/撤回等灰条）既没有真实发送者，也没有 OneBot 消息表示，
      // 塞进历史只会让 translate() 在 sender 校验上抛错 —— 跳过它，别让它毁掉整页。
      if (isSystem) { this.stats.historySystemSkipped = (this.stats.historySystemSkipped ?? 0) + 1; continue; }
      const sender = id(raw.senderUin, 'senderUin');
      if (type === 'group' && sender === MAIN && this.#conversationPolicy !== 'original') continue;
      if (!['string', 'number'].includes(typeof raw.msgTime) || !/^(0|[1-9]\d{0,15})$/.test(String(raw.msgTime)) || !Number.isSafeInteger(Number(raw.msgTime))) rejectResponse();
      bounded(raw.sendNickName, 256, true); bounded(raw.sendMemberName, 256, true);
      if (!Array.isArray(raw.elements) || raw.elements.length > 1000) rejectResponse();
      totalSegments += raw.elements.length; if (totalSegments > 4096) rejectResponse();
      raw.elements = raw.elements.map(element => {
        record(element);
        if (!Number.isSafeInteger(element.elementType) || element.elementType < 0) rejectResponse();
        if (element.elementType === 1) {
          const text = record(element.textElement); bounded(text.content);
          if (text.atType !== undefined && ![0, 1, 2, 4].includes(text.atType)) rejectResponse();
        } else if (element.elementType === 6) {
          const face = record(element.faceElement);
          if (!Number.isInteger(face.faceIndex) || face.faceIndex < 0 || face.faceIndex > 100000) rejectResponse();
        } else if (element.elementType === 7) {
          const reply = record(element.replyElement);
          if (absentReplyId(reply.replayMsgId)) nativeInteger(reply.sourceMsgIdInRecords);
          else nativeInteger(reply.replayMsgId);
        } else if (element.elementType === 3) {
          if (!fileSegment(element.fileElement)) rejectResponse();
        } else if ([2, 4, 5].includes(element.elementType)) {
          if (!mediaSegment(element)) rejectResponse();
        } else if (element.elementType === 10) {
          bounded(record(element.arkElement).bytesData);
        } else if (element.elementType === 16) {
          const resId = record(element.multiForwardMsgElement).resId;
          bounded(resId, 4096); if (!resId) rejectResponse(); forwardCount++;
        } else return { elementType: element.elementType };
        return element;
      });
      raws.push(raw);
    }
    if (forwardCount > this.forwardLimit) rejectResponse();
    raws.sort((a, b) => BigInt(a.msgSeq) < BigInt(b.msgSeq) ? -1 : BigInt(a.msgSeq) > BigInt(b.msgSeq) ? 1 : 0);
    await this.probe(); ensureCurrent();
    return this.publishMessageBatch(staged => {
      // Index the entire validated page first so same-page replies resolve only to
      // real outer messages in this exact group, regardless of delivery order.
      for (const raw of raws) if (staged.messages.find(peer, raw.msgId) !== undefined) staged.messages.put(raw, true);
      for (const raw of raws) staged.messages.put(raw, true);
      const result = { messages: raws.map(raw => ({ ...this.translate(raw, staged), message_seq: raw.msgSeq })) };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) rejectResponse();
      ensureCurrent();
      return result;
    });
  }

  publishMessageBatch(project) {
    // No awaited work after this point: stage all ID/forward changes, validate the
    // complete envelope, then publish. Malformed pages cannot mint partial IDs.
    const stagedIndex = new MessageIndex(this.messages.limit);
    stagedIndex.next = this.messages.next; stagedIndex.byId = new Map(this.messages.byId); stagedIndex.byNative = new Map(this.messages.byNative);
    const staged = { messages: stagedIndex, forwards: new Map(this.forwards), forwardSources: new Map(this.forwardSources),
      forwardPrefix: this.forwardPrefix, nextForward: this.nextForward, forwardLimit: this.forwardLimit,
      attached: this.attached, identity: this.identity };
    const result = project(staged);
    this.messages.next = stagedIndex.next; this.messages.byId = stagedIndex.byId; this.messages.byNative = stagedIndex.byNative;
    this.forwards = staged.forwards; this.forwardSources = staged.forwardSources; this.nextForward = staged.nextForward;
    return result;
  }

  rememberForward(raw, resId, state = this) {
    if (!state.attached || !state.identity) throw invalid('Forward context requires an attached session');
    text(resId, 'resId', 4096);
    if (!resId || typeof raw.msgId !== 'string' || !/^[1-9]\d{0,127}$/.test(raw.msgId)) throw invalid('Forward context is invalid');
    const peer = rawPeer(raw);
    if (peer.chatType === 2) id(peer.peerUid, 'group_id');
    else if (peer.chatType !== 1 || !/^u_[A-Za-z0-9_-]{1,125}$/.test(peer.peerUid)) throw invalid('Forward peer is invalid');
    const key = JSON.stringify([peer.chatType, peer.peerUid, raw.msgId, resId]);
    const known = state.forwardSources.get(key);
    if (known) return known;
    if (state.nextForward > Number.MAX_SAFE_INTEGER) throw new BridgeError('ID_EXHAUSTED', 'Forward ID space exhausted', { retcode: 1503 });
    const token = `fwd_${state.forwardPrefix}_${(state.nextForward++).toString(36)}`;
    state.forwards.set(token, { key, peer, msgId: raw.msgId, resId, senderUin: this.#conversationUser(raw.senderUin), sessionId: state.identity.sessionId });
    state.forwardSources.set(key, token);
    while (state.forwards.size > state.forwardLimit) {
      const first = state.forwards.keys().next().value;
      state.forwardSources.delete(state.forwards.get(first).key); state.forwards.delete(first);
    }
    return token;
  }

  async getForward(token, options = {}) {
    // Fixed MIT contract: kernel/types/services/msg-service.ts:147-151 and
    // kernel/apis/msg.ts:733-742. Use received outer context, never resId as msgId.
    if (typeof token !== 'string' || !/^fwd_[a-f0-9]{32}_[1-9a-z][0-9a-z]{0,10}$/.test(token)) throw invalid('Expected a current-session forward ID');
    const context = this.forwards.get(token);
    if (!context) throw new BridgeError('FORWARD_NOT_FOUND', 'Forward ID expired or belongs to another session', { retcode: 1404 });
    const generation = this.generation;
    const ensureCurrent = () => {
      if (options.signal?.aborted) throw new BridgeError('CANCELLED', 'Forward query cancelled', { retcode: 1502 });
      if (!this.attached || generation !== this.generation || context.sessionId !== this.identity?.sessionId) throw new BridgeError('STALE_SESSION', 'Forward query crossed a session change', { retcode: 1503 });
      if (this.forwards.get(token) !== context) throw new BridgeError('FORWARD_NOT_FOUND', 'Forward ID expired during query', { retcode: 1404 });
    };
    ensureCurrent();
    const outerResult = await this.wait(null, () => { ensureCurrent(); return this.msg.getMsgsByMsgId({ ...context.peer }, [context.msgId]); }, options);
    ensureCurrent();
    boundForwardResponse(outerResult);
    checkResult(outerResult, false, 'result', 'getForward.outer.getMsgsByMsgId');
    if (!Array.isArray(outerResult.msgList) || outerResult.msgList.length !== 1) throw new BridgeError('FORWARD_NOT_FOUND', 'Outer forward message was not found uniquely', { retcode: 1404 });
    const outer = outerResult.msgList[0];
    if (!outer || outer.msgId !== context.msgId || outer.chatType !== context.peer.chatType || outer.peerUid !== context.peer.peerUid || this.#conversationUser(outer.senderUin) !== context.senderUin ||
        !Array.isArray(outer.elements) || outer.elements.length > 1000 || !outer.elements.some(element => element?.elementType === 16 && element.multiForwardMsgElement?.resId === context.resId))
      throw new BridgeError('FORWARD_NOT_FOUND', 'Outer forward context no longer matches', { retcode: 1404 });
    await this.probe();
    ensureCurrent();
    const raw = await this.wait(null, () => { ensureCurrent(); return this.msg.getMultiMsg({ ...context.peer }, context.msgId, context.resId); }, options);
    ensureCurrent();
    boundForwardResponse(raw);
    checkResult(raw, false, 'result', 'getForward.inner.getMultiMsg');
    if (!Array.isArray(raw.msgList) || raw.msgList.length > 200) throw forwardInvalid();
    let segments = 0;
    const message = raw.msgList.map(node => {
      if (!node || typeof node !== 'object' || !Array.isArray(node.elements) || node.elements.length > 1000) throw forwardInvalid();
      const sender = this.#conversationUser(node.senderUin);
      if (typeof node.sendNickName !== 'string' || node.sendNickName.length > 256) throw forwardInvalid();
      const content = node.elements.map(element => {
        if (++segments > 4096 || !element || typeof element !== 'object') throw forwardInvalid();
        const bounded = (value, max = 65536) => { if (typeof value !== 'string' || value.length > max) throw forwardInvalid(); return value; };
        if (element.elementType === 1) {
          const value = bounded(element.textElement?.content);
          if (element.textElement.atType === 1) return { type: 'at', data: { qq: 'all' } };
          return { type: 'text', data: { text: value } }; // No unverified UID→UIN conversion.
        }
        if (element.elementType === 6 && Number.isInteger(element.faceElement?.faceIndex) && element.faceElement.faceIndex >= 0 && element.faceElement.faceIndex <= 100000) return { type: 'face', data: { id: String(element.faceElement.faceIndex) } };
        if (element.elementType === 3) {
          const file = fileSegment(element.fileElement);
          if (!file) throw forwardInvalid();
          return file;
        }
        if ([2, 4, 5].includes(element.elementType)) {
          const media = mediaSegment(element);
          if (!media) throw forwardInvalid();
          return media;
        }
        if (element.elementType === 10) return { type: 'json', data: { data: bounded(element.arkElement?.bytesData) } };
        if (element.elementType === 16) throw new BridgeError('UNSUPPORTED_NESTED_FORWARD', 'Nested forward lacks a verified outer-message context', { retcode: 1404 });
        throw new BridgeError('UNSUPPORTED_FORWARD_CONTENT', 'A forward node contains unsupported content; no partial response returned', { retcode: 1404 });
      });
      // Forwarded inner msgId/peer never enters MessageIndex or gains recall authority.
      return { type: 'node', data: { user_id: sender, nickname: node.sendNickName, content } };
    });
    const result = { message };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) throw forwardInvalid();
    await this.probe();
    ensureCurrent();
    return result;
  }

  /**
   * 登记「收到过消息的会话」（见 this.knownChats 的说明）。
   *
   * <p>群聊的 peerUid 就是群号；私聊的 peerUid 是 uid，所以私聊取 senderUin
   * （私聊里发送者就是对方）。任何异常都吞掉 —— 登记失败绝不能影响消息投递。
   */
  noteChat(raw) {
    try {
      if (!raw || typeof raw !== 'object') return;
      const isGroup = raw.chatType === 2;
      const id = String(isGroup ? raw.peerUid : raw.senderUin);
      if (!/^\d{1,20}$/.test(id) || id === '0') return;
      const key = `${isGroup ? 'group' : 'private'}:${id}`;
      const stamp = typeof raw.msgTime === 'number' && raw.msgTime > 0
        ? (raw.msgTime > 1e12 ? raw.msgTime : raw.msgTime * 1000)
        : Date.now();
      const prev = this.knownChats.get(key);
      if (prev) {
        prev.count++;
        if (stamp > prev.last) prev.last = stamp;
        return;
      }
      if (this.knownChats.size >= 512) {
        // 只保留最近活跃的 384 个，避免无限增长。
        const all = [...this.knownChats.entries()].sort((a, b) => b[1].last - a[1].last);
        this.knownChats = new Map(all.slice(0, 384));
      }
      this.knownChats.set(key, { id, type: isGroup ? 'group' : 'private', last: stamp, count: 1 });
    } catch { /* 登记失败不影响任何东西 */ }
  }

  receive(list, update) {
    if (!Array.isArray(list)) { this.stats.malformedEvents++; return; }
    if (list.length > 512) { this.stats.droppedEvents += list.length; return; }
    for (let raw of list) {
      try {
        if (![1, 2].includes(raw.chatType) || typeof raw.peerUid !== 'string' ||
            (this.#conversationPolicy !== 'original' && String(raw.senderUin) === MAIN &&
              (update || raw.chatType !== 2 || !this.#acceptProtectedChallenge?.(raw)))) {
          this.stats.droppedEvents++;
          continue;
        }
        if (update) {
          raw = bindSelfSender(raw, this.identity);
          if (!raw || ![0, 2, 3].includes(raw.sendStatus)) continue;
          // A generated request ID may differ from the stored message ID. Only
          // same-peer, same-sender callbacks bearing that exact guildId qualify.
          if (typeof raw.guildId === 'string' && /^[1-9]\d{0,127}$/.test(raw.guildId) &&
              (raw.sendStatus === 0 || raw.msgId !== raw.guildId))
            this.receipts.emit(`sent:${peerKey(rawPeer(raw))}:${raw.guildId}`, raw);
          if (raw.sendStatus === 0) continue;
        }
        if (this.eventPending >= 128) { this.stats.droppedEvents++; continue; }
        const key = `${peerKey(rawPeer(raw))}:${raw.msgId}`;
        if (this.seen.has(key)) continue;
        boundForwardResponse(raw);
        const snapshot = structuredClone(raw);
        // Fresh independent identity proof gates every incoming event. Generation
        // prevents a delayed proof from reviving a detached/replaced session.
        const generation = this.generation;
        this.eventPending++;
        this.probe().then(() => {
          if (!this.attached || generation !== this.generation) { this.stats.droppedEvents++; return; }
          if (this.seen.has(key)) return;
          try {
            // ★ 免 hook：先把这条消息里的灰条分派成 notice。纯灰条消息（拍一拍/禁言/入群…）
            //   不是聊天内容，不产出 message 事件，否则会话里会冒出无数条空消息。
            const onlyGray = this.scanGrayTips(snapshot);
            if (onlyGray) { this.seen.add(key); return; }
            const event = this.translate(snapshot);
            this.seen.add(key);
            this.noteChat(snapshot);
            while (this.seen.size > this.messages.limit) this.seen.delete(this.seen.values().next().value);
            this.safeEmit('event', event);
          } catch { this.stats.malformedEvents++; }
        }, () => { this.stats.droppedEvents++; }).finally(() => { this.eventPending--; });
      } catch { this.stats.malformedEvents++; }
    }
  }
  findReply(raw, reply, index) {
    if (!reply || typeof reply !== 'object') return undefined;
    const peer = rawPeer(raw);
    let candidate = reply.replayMsgId;
    let embedded;
    if (!absentReplyId(reply.sourceMsgIdInRecords)) {
      if (!isNativeMessageId(reply.sourceMsgIdInRecords) ||
          !Array.isArray(raw.records) || raw.records.length > 32) return undefined;
      const matches = raw.records.filter(record => record?.msgId === reply.sourceMsgIdInRecords);
      if (matches.length !== 1 || !peerEqual(peer, rawPeer(matches[0]))) return undefined;
      [embedded] = matches;
      if (!absentReplyId(candidate) && candidate !== embedded.msgId) return undefined;
      candidate = embedded.msgId;
    }
    if (!isNativeMessageId(candidate) || candidate === raw.msgId) return undefined;
    const id = index.find(peer, candidate);
    if (id === undefined) return undefined;
    const source = index.byId.get(id)?.raw;
    if (!source || (String(source.senderUin) === MAIN && this.#conversationPolicy !== 'original') ||
        (embedded && (String(embedded.senderUin) !== String(source.senderUin) ||
          (embedded.msgSeq !== undefined && embedded.msgSeq !== source.msgSeq)))) return undefined;
    const checks = [
      [reply.senderUin, source.senderUin], [reply.senderUinStr, source.senderUin],
      [reply.senderUidStr, source.senderUid], [reply.replayMsgSeq, source.msgSeq],
    ];
    if (checks.some(([supplied, expected]) => !absentReplyId(supplied) && supplied !== String(expected ?? '')))
      return undefined;
    return id;
  }

  // ------------------------------------------------------------------ 免 hook 事件面（notice）
  //
  // 依据实测的，
  // notice 全来自
  // ①内核监听回调（onMsgRecall / onKickedOffLine / onMemberListChange …）
  // ②正常消息流里的灰条（elementType 8 的 jsonGrayTipElement）。
  // 两条都不需要 initHook 注入，所以不违反 D16。

  /**
   * 给 notice 回调用的 safe 包装（attach() 里那个 safe 是局部闭包，方法里用不到它）。
   * 只做两件事：不在会话内就丢弃、回调抛错只计数不冒泡。notice 绝不允许打断消息流。
   */
  safeNotice(callback) {
    return (...args) => {
      if (!this.attached) { this.stats.droppedEvents++; return; }
      try { return callback(...args); } catch { this.stats.subscriberErrors++; }
    };
  }

  /** 计数集合：notice 幂等去重（按会话+消息+类型），容量跟消息索引一致就够。 */
  noticeKey(kind, peerUid, id) {
    return `${kind}:${peerUid}:${id}`;
  }

  noticeOnce(key) {
    if (this.noticeSeen.has(key)) { this.stats.noticeDuplicatesSuppressed++; return false; }
    this.noticeSeen.add(key);
    while (this.noticeSeen.size > this.messages.limit) this.noticeSeen.delete(this.noticeSeen.values().next().value);
    return true;
  }

  /** 统一出口：补齐 time/self_id，并计数。调用方只给 post_type 之后的字段。 */
  emitNotice(fields) {
    this.stats.noticeEmitted++;
    this.safeEmit('event', { time: Math.floor(Date.now() / 1000), self_id: Number(BOT), ...fields });
  }

  /**
   * uid（u_xxx）→ uin。顺序：本条消息自带的发送者 → 自己 → 消息索引里见过的人 → 内核 uix 服务。
   * 全失败返回 undefined（调用方据此**丢弃**这条 notice，不猜）。
   */
  async noticeUin(uid, raw) {
    if (typeof uid !== 'string' || uid.length === 0) return undefined;
    if (raw && uid === raw.senderUid && raw.senderUin !== undefined) return Number(raw.senderUin);
    if (uid === this.identity?.uid) return Number(BOT);
    for (const entry of this.messages.byId.values()) {
      const r = entry?.raw;
      if (r && r.senderUid === uid && r.senderUin !== undefined) return Number(r.senderUin);
    }
    try {
      const result = await this.uix?.getUin?.([uid]);
      // ★ 内核声明是 getUin(uid[]) => Promise<{ uinInfo: Map }>（NodeIKernelUixConvertService.ts:2）。
      //   早期这里按「返回值就是 Map」写，真机上每次换算都会失败 ⇒ 拍一拍/禁言/入群全被丢弃。
      //   两种形状都认，避免把实现绑死在某一个版本的返回结构上。
      const map = result?.uinInfo ?? result;
      const value = map?.get?.(uid) ?? map?.[uid];
      if (value !== undefined && value !== null && String(value).length > 0) return Number(value);
    } catch {}
    return undefined;
  }

  /** 按 (peerUid, msgSeq) 找回我们索引里的那条消息（撤回需要它给出 message_id 与发送者）。 */
  noticeFindBySeq(peerUid, msgSeq) {
    const want = String(msgSeq);
    for (const entry of this.messages.byId.values()) {
      const r = entry?.raw;
      if (r && r.peerUid === peerUid && r.msgSeq !== undefined && String(r.msgSeq) === want) return entry;
    }
    return undefined;
  }

  /**
   * 消息撤回（内核 onMsgRecall）。chatType 1=私聊 2=群。
   * 找不到原消息就**不发**：宁可少一条 notice，也不要报一个错的 message_id。
   */
  noticeRecall(chatType, peerUid, msgSeq) {
    try {
      if (typeof peerUid !== 'string' || msgSeq === undefined) { this.stats.noticeDroppedMalformed++; return; }
      const key = this.noticeKey('recall', peerUid, msgSeq);
      if (this.noticeSeen.has(key)) { this.stats.noticeDuplicatesSuppressed++; return; }
      const entry = this.noticeFindBySeq(peerUid, msgSeq);
      if (!entry) { this.stats.noticeDroppedMalformed++; return; }
      this.noticeOnce(key);
      const sender = Number(entry.raw.senderUin);
      if (Number(chatType) === 1)
        this.emitNotice({ post_type: 'notice', notice_type: 'friend_recall', user_id: sender, message_id: entry.id });
      else
        this.emitNotice({ post_type: 'notice', notice_type: 'group_recall', group_id: Number(peerUid),
          user_id: sender, operator_id: sender, message_id: entry.id });
    } catch { this.stats.noticeDroppedMalformed++; }
  }

  /** 自己被踢下线：这是「是不是被踢」的**直接证据**，不必再去 grep 日志猜。 */
  noticeKickedOffline() {
    try {
      if (!this.noticeOnce(this.noticeKey('kicked', 'self', Date.now() >> 12))) return;
      this.emitNotice({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable',
        reason: 'kicked_offline' });
    } catch {}
  }

  /** 灰条分派：busiId 表来自 NapCat types/graytip.ts 的 JsonGrayBusiId（见能力矩阵 §4.3）。 */
  async noticeGrayTip(raw, busiId, jsonStr, element) {
    try {
      let json = null;
      if (typeof jsonStr === 'string' && jsonStr.length <= 8192) {
        try { json = JSON.parse(jsonStr); } catch { this.stats.noticeDroppedMalformed++; }
      }
      const items = Array.isArray(json?.items) ? json.items : [];
      const uids = items.filter(item => item && typeof item.uid === 'string').map(item => item.uid);
      const summary = items.map(item => (typeof item?.txt === 'string' ? item.txt : '')).join('').slice(0, 120);
      const isGroup = raw.chatType === 2;
      const groupId = isGroup ? Number(raw.peerUid) : undefined;
      // ★ 去重键**只在真正要发之前**才占用：先换算 uid，换算不出来就丢弃，
      //   不能因为一次换算失败把这条消息永久标记成"已处理"（否则同一条永远发不出来）。
      // 1061 / 1068 / 2401 = 拍一拍（群拍 / 好友拍）：
      // 兼容 uid、uin、jp 三种字段形态，不再因 items 里出现 3 个元素或带 uin 而静默丢弃。
      if (busiId === '1061' || busiId === '1068' || busiId === '2401') {
        const actors = [];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          if (typeof item.uid === 'string' && item.uid) actors.push({ uid: item.uid });
          else if ((typeof item.uin === 'string' || typeof item.uin === 'number') && /^\d{4,15}$/.test(String(item.uin))) actors.push({ uin: Number(item.uin) });
          else if (typeof item.jp === 'string' && /^\d{4,15}$/.test(item.jp)) actors.push({ uin: Number(item.jp) });
        }
        if (actors.length < 2) { this.stats.noticeDroppedMalformed++; return; }
        const from = actors[0].uin ?? await this.noticeUin(actors[0].uid, raw);
        const to = actors[1].uin ?? await this.noticeUin(actors[1].uid, raw);
        if (from === undefined || to === undefined) { this.stats.noticeDroppedNoUid++; return; }
        if (!this.noticeOnce(this.noticeKey('tip:' + busiId, raw.peerUid, raw.msgId))) return;
        const fields = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
          user_id: from, target_id: to, raw_info: items };
        if (groupId !== undefined) fields.group_id = groupId;
        this.emitNotice(fields);
        return;
      }

      // 1014 禁言 / 2402 解除禁言
      if (busiId === '1014' || busiId === '2402') {
        if (!this.noticeOnce(this.noticeKey('tip:' + busiId, raw.peerUid, raw.msgId))) return;
        const target = uids.length ? await this.noticeUin(uids[0], raw) : undefined;
        const fields = { post_type: 'notice', notice_type: 'group_ban',
          sub_type: busiId === '1014' ? 'ban' : 'lift_ban',
          group_id: groupId, operator_id: Number(raw.senderUin ?? 0), user_id: target ?? 0,
          ...(target === undefined ? { uid_unresolved: true } : {}) };
        // 禁言秒数在原生的 grayTipElement.groupElement.shutUp.duration（字符串 "600"/"0"）；
        // 解除禁言不带正数时长——不猜，读不到就不放这个字段。
        const shutUp = element?.grayTipElement?.groupElement?.shutUp;
        const duration = Number(shutUp?.duration);
        if (busiId === '1014' && Number.isFinite(duration) && duration > 0) fields.duration = duration;
        if (summary) fields.comment = summary;
        this.emitNotice(fields);
        return;
      }

      // 1022 / 1015 / 1016 = 入群（含改名片、带欢迎语）
      if (busiId === '1022' || busiId === '1015' || busiId === '1016') {
        if (!this.noticeOnce(this.noticeKey('tip:' + busiId, raw.peerUid, raw.msgId))) return;
        const who = uids.length ? await this.noticeUin(uids[0], raw) : undefined;
        const fields = { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve',
          group_id: groupId, operator_id: Number(raw.senderUin ?? 0), user_id: who ?? 0,
          ...(who === undefined ? { uid_unresolved: true } : {}) };
        if (summary) fields.comment = summary;
        this.emitNotice(fields);
        return;
      }

      // 其它 busiId 本阶段不产出事件，但已经在 grayTipsSeen 里留过痕（证明分支在工作）
    } catch { this.stats.noticeDroppedMalformed++; }
  }

  /** 解析 XML 形态的灰条拍一拍（NTQQ 3.2.x 大量戳一戳落在 xmlElement.content 而非 jsonGrayTipElement）。 */
  async noticeXmlGrayTip(raw, xmlEl) {
    try {
      const busiId = xmlEl?.busiId !== undefined && xmlEl?.busiId !== null ? String(xmlEl.busiId) : '';
      const content = typeof xmlEl?.content === 'string' ? xmlEl.content : '';
      const isPoke = busiId === '1061' || busiId === '1068' || busiId === '2401'
        || /拍了拍|戳了戳|poke|nudge/i.test(content);
      if (!isPoke || !content) return;
      const actors = [];
      // 匹配 <qq uin="..." col="..." jp="..."/> 或 uid="u_..."
      const tagRe = /<(?:qq|nor)\b[^>]*>/gi;
      let m;
      while ((m = tagRe.exec(content)) !== null) {
        const tag = m[0];
        const uinM = /\b(?:uin|jp)=["'](\d{4,15})["']/i.exec(tag);
        const uidM = /\b(?:uid|jp)=["'](u_[A-Za-z0-9_-]{4,125})["']/i.exec(tag);
        if (uinM) actors.push({ uin: Number(uinM[1]) });
        else if (uidM) actors.push({ uid: uidM[1] });
      }
      if (actors.length < 2) {
        // 兜底：从整段 XML 中直接抓所有 uin / uid
        for (const mm of content.matchAll(/\b(?:uin|jp)=["'](\d{4,15})["']/gi)) {
          actors.push({ uin: Number(mm[1]) });
        }
        if (actors.length < 2) {
          for (const mm of content.matchAll(/\b(?:uid|jp)=["'](u_[A-Za-z0-9_-]{4,125})["']/gi)) {
            actors.push({ uid: mm[1] });
          }
        }
      }
      // 私聊单方提及兜底：只给了一个对象时结合发送者与机器人自身补全
      let from = actors[0] ? (actors[0].uin ?? await this.noticeUin(actors[0].uid, raw)) : undefined;
      let to = actors[1] ? (actors[1].uin ?? await this.noticeUin(actors[1].uid, raw)) : undefined;
      if (from === undefined && raw?.senderUin !== undefined) from = Number(raw.senderUin);
      if (to === undefined && raw?.chatType === 1 && from !== undefined) {
        to = String(from) === String(BOT) ? Number(raw.peerUin ?? 0) : Number(BOT);
      }
      if (!from || !to) { this.stats.noticeDroppedNoUid++; return; }
      const dedupKind = 'xml:' + (busiId || 'poke');
      if (!this.noticeOnce(this.noticeKey(dedupKind, raw.peerUid, raw.msgId))) return;
      const fields = {
        post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
        user_id: from, target_id: to,
      };
      if (raw.chatType === 2) fields.group_id = Number(raw.peerUid);
      this.emitNotice(fields);
    } catch { this.stats.noticeDroppedMalformed++; }
  }

  /** 扫描一条原生消息里的灰条元素并分派。只读，不改消息。 */
  scanGrayTips(raw) {
    const elements = raw?.elements;
    if (!Array.isArray(elements)) return false;
    let onlyGray = elements.length > 0;
    const recordKind = (key) => {
      const kinds = this.stats.grayTipKinds;
      if (kinds[key] !== undefined || Object.keys(kinds).length < 32) kinds[key] = (kinds[key] ?? 0) + 1;
    };
    for (const element of elements) {
      if (element?.elementType !== 8) { onlyGray = false; continue; }
      this.stats.grayTipsSeen++;
      const tip = element.grayTipElement;
      const json = tip?.jsonGrayTipElement;
      const xml = tip?.xmlElement;
      if (json && json.busiId !== undefined && json.busiId !== null) {
        const kindKey = String(json.busiId);
        recordKind(kindKey);
        void this.noticeGrayTip(raw, kindKey, json.jsonStr, element);
      } else if (xml) {
        const xmlKey = 'xml:' + String(xml.busiId ?? tip?.subElementType ?? 'unknown');
        recordKind(xmlKey);
        void this.noticeXmlGrayTip(raw, xml);
      } else if (tip) {
        recordKind('sub:' + String(tip.subElementType ?? 'unknown'));
      }
    }
    return onlyGray;
  }

  /**
   * attach 时挂上全部 notice 监听。全部包在 safe() 里：
   * 某个回调不存在/签名不同，只影响那一条 notice，绝不影响消息流。
   */
  noticeCallbacks() {
    try { this.uix = this.session.getUixConvertService?.(); } catch { this.uix = undefined; }
    this.noticeSeen = this.noticeSeen ?? new Set();
    const msgCallbacks = {
      onMsgRecall: this.safeNotice((chatType, uid, msgSeq) => this.noticeRecall(chatType, uid, msgSeq)),
      onKickedOffLine: this.safeNotice(() => this.noticeKickedOffline()),
      onInputStatusPush: this.safeNotice((value) => {
        if (!this.noticeExtras) return;
        try {
          const peer = value?.peerUid ?? value?.peerId;
          if (typeof peer !== 'string') return;
          const event = { post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
            user_id: Number(value?.userUin ?? 0), status_text: String(value?.statusText ?? '') };
          if (value?.chatType === 2) event.group_id = Number(peer);
          this.emitNotice(event);
        } catch {}
      }),
      onUserOnlineStatusChanged: this.safeNotice((value) => {
        if (!this.noticeExtras) return;
        try {
          const uid = value?.uid ?? value?.userUid;
          if (typeof uid !== 'string') return;
          void this.noticeUin(uid, null).then((uin) => {
            if (uin === undefined) { this.stats.noticeDroppedNoUid++; return; }
            this.emitNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'online_status',
              user_id: uin, online: value?.online === true || value?.status === 1 });
          }).catch(() => {});
        } catch {}
      }),
      onGroupFileInfoAdd: this.safeNotice((info) => {
        try {
          const groupCode = info?.peerId ?? info?.groupCode;
          const name = info?.fileInfo?.fileName ?? info?.folderInfo?.folderName;
          if (groupCode === undefined) return;
          this.emitNotice({ post_type: 'notice', notice_type: 'group_upload',
            group_id: Number(groupCode), user_id: Number(info?.fileInfo?.uploaderUin ?? 0),
            file: { id: String(info?.fileInfo?.fileUuid ?? ''), name: String(name ?? ''), size: Number(info?.fileInfo?.fileSize ?? 0) } });
        } catch {}
      }),
      onRecvSysMsg: this.safeNotice((list) => {
        try {
          // ★ 原生会在启动与轮询时**重复投递同一批**系统消息（实测一条内容能连着来好几次，
          //   3 分钟内把 emitted 顶到 96 而 grayTipsSeen 仍是 0）。按「类型+内容」做 1 分钟窗口去重。
          const seen = new Set();
          for (const msg of Array.isArray(list) ? list.slice(0, 32) : []) {
            const text = typeof msg?.contentStr === 'string' ? msg.contentStr.slice(0, 200) : '';
            const kind = String(msg?.msgType ?? msg?.type ?? '');
            const key = this.noticeKey('sysmsg', kind + ':' + text, Math.floor(Date.now() / 60000));
            if (seen.has(key) || !this.noticeOnce(key)) continue;
            seen.add(key);
            this.emitNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'sys_msg',
              text, kind, undecoded: msg });
          }
        } catch {}
      }),
    };
    const groupCallbacks = {
        // 入群申请/审批结果：onJoinGroupNotify 与 onGroupNotifiesUpdated 都可能给
        onJoinGroupNotify: this.safeNotice((value) => {
          try {
            const groupCode = value?.groupCode ?? value?.group?.groupCode ?? value?.groupUin;
            const uid = value?.memberUid ?? value?.member?.uid;
            if (groupCode === undefined) return;
            void this.noticeUin(uid, null).then((uin) => {
              const key = this.noticeKey('join-notify', String(groupCode) + ':' + String(uid), Math.floor(Date.now() / 60000));
              if (!this.noticeOnce(key)) return;
              this.emitNotice({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve',
                group_id: Number(groupCode), operator_id: 0, user_id: uin ?? 0,
                ...(uin === undefined ? { uid_unresolved: true } : {}) });
            }).catch(() => {});
          } catch {}
        }),
        onGroupNotifiesUpdated: this.safeNotice((...args) => {
          try {
            const payload = args.length >= 2 && Array.isArray(args[1])
              ? args[1]
              : (Array.isArray(args[0]) ? args[0] : [args[0]]);
            for (const value of payload) {
              if (!value || typeof value !== 'object') continue;
              const req = this.rememberGroupRequest(value);
              const groupCode = req?.groupCode ?? value?.groupCode ?? value?.group?.groupCode;
              if (groupCode === undefined) continue;
              const text = typeof value?.contentStr === 'string' ? value.contentStr.slice(0, 200) : '';
              this.emitNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'group_notify',
                group_id: Number(groupCode), text });
              if (req && (req.status === 0 || req.status === 1) && req.seq) {
                const dedupKey = this.noticeKey('group-req', req.flag, Math.floor(Date.now() / 60000));
                if (!this.noticeOnce(dedupKey)) continue;
                void this.noticeUin(req.userUid, null).then((uin) => {
                  this.emitNotice({
                    post_type: 'request',
                    request_type: 'group',
                    sub_type: req.subType,
                    group_id: Number(req.groupCode),
                    user_id: uin ?? 0,
                    comment: req.comment,
                    flag: req.flag,
                  });
                }).catch(() => {});
              }
            }
          } catch {}
        }),
        onGroupBulletinChange: this.safeNotice((value) => {
          try {
            const groupCode = value?.groupCode ?? value?.peerId;
            if (groupCode === undefined) return;
            this.emitNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'group_bulletin',
              group_id: Number(groupCode),
              bulletin: { content: String(value?.content ?? value?.msg?.content ?? '').slice(0, 500) } });
          } catch {}
        }),
        onMemberListChange: this.safeNotice((value) => {
          try {
            // ★ 内核声明的载荷是 { sceneId, ids: string[], infos: Map<uid, GroupMember>,
            //   hasPrev, hasNext, hasRobot }（NodeIKernelGroupListener.ts:70-77）。
            //   早期按 groupCode/uid 读，真机上这两个字段都不存在 ⇒ group_decrease 永不触发且完全静默。
            const groupCode = value?.sceneId ?? value?.groupCode ?? value?.peerId;
            if (groupCode === undefined) { this.stats.noticeDroppedMalformed++; return; }
            const ids = Array.isArray(value?.ids) ? value.ids.filter(uid => typeof uid === 'string')
              : (typeof value?.uid === 'string' ? [value.uid] : []);
            if (ids.length === 0) { this.stats.noticeDroppedMalformed++; return; }
            // ★ 别把「成员列表变化」当成「每个成员都退群了」：
            //   ① hasPrev=false 是**初次全量同步**，不是变化（实测启动瞬间一次能带几百个 id，
            //      按 id 逐条发 notice 会把真事件淹没——2026-11-17 真机观测到 emitted 3 分钟 97→256 条）；
            //   ② 单批 id 过多同样按全量处理，只记计数不发事件。
            const infos = value?.infos instanceof Map ? value.infos : null;
            if (value?.hasPrev !== true || ids.length > 16) { this.stats.noticeBulkSkipped++; return; }
            for (const uid of ids) {
              if (infos && infos.has(uid)) continue;   // 还在群成员表里 ⇒ 不是退群
              void this.noticeUin(uid, null).then((uin) => {
                // 成员列表变化会连续多次回调：按 (群, 人) 做 60 秒窗口去重，否则一次退群发十条。
                const key = this.noticeKey('member-leave', String(groupCode) + ':' + uid, Math.floor(Date.now() / 60000));
                if (!this.noticeOnce(key)) return;
                this.emitNotice({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'leave',
                  group_id: Number(groupCode), operator_id: 0, user_id: uin ?? 0,
                  ...(uin === undefined ? { uid_unresolved: true } : {}) });
              }).catch(() => {});
            }
          } catch { this.stats.noticeDroppedMalformed++; }
        }),
    };
    return { msg: msgCallbacks, group: groupCallbacks };
  }

  translate(raw, state = this) {
    if (![1, 2].includes(raw.chatType) || typeof raw.peerUid !== 'string' || !Array.isArray(raw.elements) || raw.elements.length > 1000) throw invalid('Native message shape mismatch');
    const sender = Number(id(raw.senderUin, 'senderUin'));
    const senderInfo = { user_id: sender, nickname: text(raw.sendNickName ?? '', 'nickname'),
      card: text(raw.sendMemberName ?? '', 'card') };
    if (!isNativeMessageId(raw.msgId)) throw invalid('Native message id is invalid');
    const time = integer(Number(raw.msgTime), 0, Number.MAX_SAFE_INTEGER);
    const groupId = raw.chatType === 2 ? Number(id(raw.peerUid, 'group_id')) : undefined;
    // 元素级诊断：**默认关**。要排查「@ 没认出来 / 引用没映射 / 未知元素形状」时，
    //   启动前设 `WHALE_DEBUG_ELEMENTS=1`，它会为每次启动的前 40 条群消息打印元素形状、
    //   为前 20 个没认出来的 at 打印字段与文本前缀。
    //   ★ 它会把会话标识与消息正文前缀写进日志，所以不进默认路径、也不需要为排查改代码发版。
    if (ELEMENT_DEBUG && raw.chatType === 2) {
      if (this.stats.elemDebug === undefined) this.stats.elemDebug = 0;
      if (this.stats.elemDebug < 40) {
        this.stats.elemDebug++;
        const brief = raw.elements.map((el) => {
          const t = el.textElement;
          const at = t && (t.atType !== undefined || t.atUid !== undefined || t.atNtUid !== undefined)
            ? '(atType=' + String(t.atType) + ',atUid=' + String(t.atUid) + ',atNtUid=' + String(t.atNtUid) + ')'
            : '';
          return String(el.elementType) + at;
        }).join(' | ');
        console.warn('[elems] chat=' + String(raw.peerUid) + ' ' + brief);
      }
    }
    const message = raw.elements.map((el) => {
      if (el.elementType === 1 && typeof el.textElement?.content === 'string') {
        const t = el.textElement;
        const target = raw.chatType === 2 ? groupMention(t, this.identity?.uid) : null;
        if (target !== null) return { type: 'at', data: { qq: target } };
        // 诊断（默认关，见 WHALE_DEBUG_ELEMENTS）：文本元素带了 at 字段却没认出来
        // （atType 不认识 / atUid 不是 uin / ntUid 不匹配）。
        if (ELEMENT_DEBUG && raw.chatType === 2 && (t.atType !== undefined || t.atUid !== undefined || t.atNtUid !== undefined)) {
          if (this.stats.atDebug === undefined) this.stats.atDebug = 0;
          if (this.stats.atDebug < 20) {
            this.stats.atDebug++;
            console.warn('[at-debug] missed atType=' + String(t.atType) + ' atUid=' + String(t.atUid) +
              ' atNtUid=' + String(t.atNtUid) + ' selfUid=' + String(this.identity?.uid) + ' bot=' + String(BOT) +
              ' text=' + JSON.stringify(String(t.content).slice(0, 24)));
          }
        }
        return { type: 'text', data: { text: t.content } };
      }
      if (el.elementType === 6 && Number.isInteger(el.faceElement?.faceIndex)) return { type: 'face', data: { id: String(el.faceElement.faceIndex) } };
      if (el.elementType === 7) {
        const replyId = this.findReply(raw, el.replyElement, state.messages);
        if (replyId) return { type: 'reply', data: { id: String(replyId) } };
      }
      if (el.elementType === 3) {
        const file = fileSegment(el.fileElement);
        if (file) return file;
      }
      if ([2, 4, 5].includes(el.elementType)) {
        const media = mediaSegment(el);
        if (media) return media;
      }
      if (el.elementType === 10 && typeof el.arkElement?.bytesData === 'string') return { type: 'json', data: { data: el.arkElement.bytesData } };
      // 灰条：只透出 busi_id，**不带正文**（正文可能是群公告/系统提示，噪声大且不该混进 raw_message）。
      // 真正的语义已经由 scanGrayTips() 变成 notice 了。
      if (el.elementType === 8) {
        const busiId = el.grayTipElement?.jsonGrayTipElement?.busiId;
        return { type: 'qq_graytip', data: { busi_id: busiId === undefined || busiId === null ? '' : String(busiId) } };
      }
      if (el.elementType === 16 && typeof el.multiForwardMsgElement?.resId === 'string') return { type: 'forward', data: { id: this.rememberForward(raw, el.multiForwardMsgElement.resId, state) } };
      // 诊断（默认关，见 WHALE_DEBUG_ELEMENTS）：解析不了的元素打原始字段名。
      if (ELEMENT_DEBUG) {
        if (this.stats.atDebug === undefined) this.stats.atDebug = 0;
        if (this.stats.atDebug < 20) {
          this.stats.atDebug++;
          console.warn('[at-debug] elementType=' + String(el.elementType) + ' keys=' + Object.keys(el).join(','));
        }
      }
      return { type: 'qq_unknown', data: { element_type: String(el.elementType) } };
    });
    const rawMessage = toCQ(message);
    const messageId = state.messages.put(raw);
    const result = { time, self_id: Number(BOT), post_type: sender === Number(BOT) ? 'message_sent' : 'message', message_type: raw.chatType === 2 ? 'group' : 'private', sub_type: raw.chatType === 2 ? 'normal' : 'friend', message_id: messageId, user_id: sender, message, raw_message: rawMessage, font: 0, sender: senderInfo };
    if (groupId !== undefined) result.group_id = groupId;
    return result;
  }
}
