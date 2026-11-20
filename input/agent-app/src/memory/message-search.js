// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
/**
 * 老消息检索（message search）—— 让"几个月前说过的话"真的能翻出来。
 *
 * ★★ 为什么必须补这一层（2026-10-27 用户问「理论上问到的话，他有可能把几个月前的东西都翻出来，是吧」）：
 *   实测本机三个记忆层的时间覆盖面**差得很远**：
 *     · `messages.sqlite` 原始消息：**11,412 条 / 9-21 ~ 10-26 / 35 天**（全都在）
 *     · `episodes.sqlite` 事件记忆：**522 条 / 10-25 ~ 10-27 / 仅 3 天**（10-25 之前 **0 条**）
 *     · `people/*.json` 印象：5 条/人，只存"稳定特征"，没有时间轴
 *   ⇒ **事件记忆只有 3 天**，所以"翻几个月前"根本翻不到 —— 不是窗口设小了（工具允许 365 天、
 *     召回允许 90 天），是**那段时间根本没有事件条目**。
 *   ⇒ 但原始消息**一条没少**（35 天全在）。所以正确做法是：**给它一个直接搜原始消息的工具**，
 *     而不是继续在事件层上加大天数（加多大都没用）。
 *
 * ★★ 铁律（与本项目其它记忆模块一致）：
 *   1. **只读**，不改任何记忆数据；
 *   2. **严格按会话隔离** —— 只查当前 chatKey，绝不跨群（用户反复强调过"不要跨群污染"）；
 *   3. **返回原话 + 时间**，不做摘要、不做推断 —— 摘要由模型自己看原话去概括，避免我们编。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { localHistorySql } from './local-query-policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 上海时区的短时间（与项目其它地方一致，不用本地时区以免漂移） */
function stamp(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function openDb(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

/**
 * 在当前会话里按关键词/时间搜历史消息。
 *
 * @param {object} o
 * @param {string} o.messagesDbPath
 * @param {string} o.chatKey            **必填**，用于会话隔离
 * @param {string} [o.keyword]          关键词（不区分大小写，匹配正文/说话人）
 * @param {string} [o.who]              只看某个人（QQ 号或名字片段）
 * @param {number} [o.daysFrom]         从几天前开始（默认 365 = 能翻到头）
 * @param {number} [o.daysTo]           查到几天前为止（默认 0 = 今天）
 * @param {number} [o.limit]            最多几条（默认 20，上限 50）
 * @param {boolean} [o.selfOnly]        只看我自己说的
 * @param {boolean} [o.oldestFirst]     true = 从**最早**开始给（想翻"我们最早聊了什么"时用）。
 *                                      ★ 默认是倒序（最新优先），因为绝大多数提问是"上次说过什么"；
 *                                        想看开端就必须能翻头 —— 倒序 + limit 只能看到最近的 N 条，
 *                                        这就是第一版"最早一条"却返回今天的原因（实测踩到）。
 * @returns {{ok:boolean, rows:Array, total:number, earliest?:number, latest?:number, error?:string}}
 */
export function searchOldMessages({
  messagesDbPath,
  chatKey,
  keyword = '',
  who = '',
  daysFrom = 365,
  daysTo = 0,
  limit = 20,
  selfOnly = false,
  oldestFirst = false
} = {}) {
  const ck = String(chatKey || '').trim();
  // ★ 没有 chatKey 就**直接拒绝** —— 绝不退化成"搜全库"，那等于跨群泄露。
  if (!ck) return { ok: false, rows: [], total: 0, error: '缺少 chatKey（必须指定会话，不允许搜全库）' };
  const db = openDb(messagesDbPath);
  if (!db) return { ok: false, rows: [], total: 0, error: '消息库不可用' };

  try {
    const now = Date.now();
    let from = Math.min(3650, Math.max(0, Number(daysFrom) || 0));
    let to = Math.min(3650, Math.max(0, Number(daysTo) || 0));
    if (from < to) { const t = from; from = to; to = t; }
    const since = now - (from + 1) * DAY_MS;
    const until = to > 0 ? now - to * DAY_MS : now;
    const max = Math.min(50, Math.max(1, Number(limit) || 20));

    const where = ['chat_key = ?', 'ts >= ?', 'ts <= ?', "TRIM(COALESCE(text,'')) <> ''"];
    const args = [ck, since, until];

    const kw = clean(keyword, 60);
    if (kw) {
      where.push('(text LIKE ? COLLATE NOCASE OR sender_name LIKE ? COLLATE NOCASE)');
      args.push(`%${kw}%`, `%${kw}%`);
    }
    const w = clean(who, 40);
    if (w) {
      // QQ 号精确，名字走片段匹配
      if (/^\d{5,15}$/.test(w)) { where.push('sender_id = ?'); args.push(w); }
      else { where.push('(sender_name LIKE ? COLLATE NOCASE)'); args.push(`%${w}%`); }
    }
    if (selfOnly) where.push('self = 1');

    const policy = localHistorySql(ck);
    args.push(...policy.args);
    const cond = where.join(' AND ') + policy.clause;
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${cond}`).get(...args)?.n) || 0;
    // ★ 同时给出这个范围内真正的首尾时间，避免"total 说有 3792 条，但我只看到今天"这种困惑。
    const span = db.prepare(`SELECT MIN(ts) AS e, MAX(ts) AS l FROM messages WHERE ${cond}`).get(...args) || {};
    // ★ 默认倒序（最新优先）；oldestFirst=true 时正序（从开端看起）。
    const order = oldestFirst ? 'ASC' : 'DESC';
    const rows = db.prepare(`SELECT ts, sender_id, sender_name, text, self, mentions_self
      FROM messages WHERE ${cond} ORDER BY ts ${order} LIMIT ?`).all(...args, max);

    return {
      ok: true,
      total,
      earliest: Number(span.e) || 0,
      latest: Number(span.l) || 0,
      earliestText: stamp(span.e),
      latestText: stamp(span.l),
      oldestFirst,
      rows: rows.map((r) => ({
        ts: Number(r.ts) || 0,
        time: stamp(r.ts),
        senderId: String(r.sender_id || ''),
        senderName: String(r.sender_name || ''),
        self: Number(r.self) === 1,
        text: clean(r.text, 200)
      }))
    };
  } catch (error) {
    return { ok: false, rows: [], total: 0, error: `查询失败：${error?.message ?? error}` };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 渲染成给模型看的文本。★ 原话优先，不做摘要。 */
export function formatOldMessages(result, { keyword = '', who = '' } = {}) {
  if (!result.ok) return `查不了历史消息（${result.error || '未知原因'}）—— 那就别编。`;
  if (!result.rows.length) {
    const what = keyword ? `「${keyword}」` : (who ? `${who}` : '这些条件');
    return `这个会话里没找到跟 ${what} 有关的更早消息。（可能真没聊过，也可能是在别的群聊的——但别的群的内容我看不到。）`;
  }
  const L = [];
  const head = keyword ? `提到「${keyword}」的旧消息` : (who ? `${who} 以前的发言` : '旧消息');
  // ★ 把「这个范围内到底有多少条、跨多久」写清楚，模型才不会以为"只有这几条"。
  const range = result.earliestText && result.latestText
    ? `，时间跨度 ${result.earliestText} ~ ${result.latestText}`
    : '';
  L.push(`${head}（共 ${result.total} 条${range}；下面是${result.oldestFirst ? '最早' : '最新'}的 ${result.rows.length} 条）：`);
  for (const r of result.rows) {
    const who2 = r.self ? '我' : (r.senderName || r.senderId);
    L.push(`- ${r.time} ${who2}：${r.text}`);
  }
  if (result.total > result.rows.length) {
    L.push(`（还有 ${result.total - result.rows.length} 条没列。想换一批就调 daysFrom/daysTo 缩小范围，或换关键词。）`);
  }
  L.push('用法：这些是**原话**，可以自然地提起（"你几月几号不是说过…"）。但别一条条念，也别假装记得比这更细。');
  return L.join('\n');
}
