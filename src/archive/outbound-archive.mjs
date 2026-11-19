// 机器人「原话」归档：把**每一次被接受的发送**落成一行 JSON，供之后用大模型整理、再删原话。
//
// 为什么要放在协议端（而不是运行端）：
//   发送的权威在协议端（PRINCIPLES.md P4）。运行端的 messages 表把同一条消息记两遍
//   （我们的发送记录 + QQ 回显），拿它当真相会把流水写成双份；而且它记的是「它认为发了」，
//   协议端记的是「我们确实回给运行端的是成功」。
//
// 文件形态：JSONL，一行一条，**只追加**。字段见 record()。
// 整理与删除由 scripts/compact-outbound-archive.mjs 做（先写摘要、校验落盘，再删原话）。
import fs from 'node:fs';
import path from 'node:path';

/** 会产生 outbox 行的发送类动作（与 protocol/core.mjs 的 ACCEPT_WITHOUT_RECEIPT 保持一致）。 */
export const ARCHIVED_ACTIONS = Object.freeze(['send_msg', 'send_private_msg', 'send_group_msg',
  'send_group_forward_msg', 'send_private_forward_msg']);

/** 单行里保留的 segments 原始 JSON 上限：超了就只留可读文本。 */
const MAX_RAW_SEGMENTS = 4096;

/**
 * 把 OneBot 消息段摊成一句人话（归档给人看，也方便之后让模型摘要）。
 * 不追求可逆：`[图片]`、`[表情:212]`、`[@12345]`、`[回复:678]` 这类占位比原始结构更好读。
 */
export function flattenSegments(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text': parts.push(String(data.text ?? '')); break;
      case 'at': parts.push('[@' + String(data.qq ?? '') + ']'); break;
      case 'reply': parts.push('[回复:' + String(data.id ?? '') + ']'); break;
      case 'face': parts.push('[表情' + String(data.id ?? '') + ']'); break;
      case 'image': parts.push('[图片]'); break;
      case 'record': parts.push('[语音]'); break;
      case 'video': parts.push('[视频]'); break;
      case 'file': parts.push('[文件' + (data.file ? ':' + String(data.file) : '') + ']'); break;
      case 'json': parts.push('[卡片]'); break;
      case 'forward': parts.push('[合并转发]'); break;
      case 'node': parts.push('[转发节点]'); break;
      case 'shake': parts.push('[窗口抖动]'); break;
      case 'poke': parts.push('[戳一戳]'); break;
      default: parts.push('[' + String(seg.type || '未知段') + ']');
    }
  }
  return parts.join('');
}

/** 从动作参数里取「这条发给谁」。群聊记群号，私聊记对方号，都没有就记动作本身。 */
export function chatOf(action, params = {}) {
  if (params.group_id !== undefined && params.group_id !== null) return 'group:' + String(params.group_id);
  if (params.user_id !== undefined && params.user_id !== null) return 'private:' + String(params.user_id);
  if (action === 'send_group_forward_msg' && params.messages !== undefined) return 'unknown:group-forward';
  return 'unknown';
}

/**
 * 发送归档。
 *
 * <p>只记**被接受的发送**（retcode 0）。失败/未提交的不进这个文件 —— 那些属于 outbox 与日志，
 * 归档是「机器人说过什么」，不是「哪些没发出去」。
 */
export class OutboundArchive {
  #file; #maxBytes; #now;

  constructor(file, { maxBytes = 8 * 1024 * 1024, now = () => Date.now() } = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('Archive file required');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new TypeError('Invalid archive size limit');
    this.#file = file;
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  get file() { return this.#file; }

  /**
   * 尝试把一次动作结果记进归档。**绝不抛错**：归档失败不能影响发送（P4 的同一条道理）。
   * @returns {boolean} 是否真的写了一行
   */
  maybeRecord(request, response) {
    try {
      return this.#record(request, response);
    } catch {
      return false;
    }
  }

  #record(request, response) {
    const action = request?.action;
    if (!ARCHIVED_ACTIONS.includes(action)) return false;
    if (!response || response.retcode !== 0) return false;
    const params = request.params ?? {};
    const at = this.#now();
    const message = params.message ?? params.messages ?? [];
    const text = flattenSegments(message);
    // 只有文本段、且本来就是字符串时 text 可能为空；退回原始结构供人看。
    const rawSegments = JSON.stringify(message);
    const line = {
      at: new Date(at).toISOString(),
      at_ms: at,
      action,
      chat: chatOf(action, params),
      message_id: response.data?.message_id ?? null,
      // 拿不到回执时为 true：消息确实提交给原生且被接受，但没有 QQ 侧确认。
      accepted_without_receipt: response.data?.accepted_without_receipt === true,
      text,
      ...(rawSegments.length <= MAX_RAW_SEGMENTS ? { segments: message } : { segments_truncated: true }),
    };
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    this.#rotateIfNeeded();
    fs.appendFileSync(this.#file, JSON.stringify(line) + '\n', 'utf8');
    return true;
  }

  /** 单文件上限：到了一就滚成 `.1`（只留一代），避免无限涨。 */
  #rotateIfNeeded() {
    try {
      if (fs.statSync(this.#file).size < this.#maxBytes) return;
    } catch {
      return;
    }
    try { fs.renameSync(this.#file, this.#file + '.1'); } catch { /* 滚不动就继续追加，不阻塞发送 */ }
  }
}

/** 读回归档（给整理脚本与面板用）。坏行跳过，不因为一行坏 JSON 读不出全部。 */
export function readArchive(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 半行/坏行：跳过 */ }
  }
  return out;
}
