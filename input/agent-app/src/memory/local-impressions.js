// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// ═══════════════════════════════════════════════════════════════════════
// local-impressions.js —— 让【记忆】从"档案标签"变成"带时间的回忆"（2026-10-29）
//
// 用户的四句话对应本文件的四个功能（B / D / F / C）：
//   · 「其他的几个选项全都可以做出来」+「不要极大的增加消耗」
//
// ── B：印象**带时间**（≈0 成本：只改渲染，不加数据）────────────────────
//   问题：原来每条印象只印一个日期（`[10-28]`），看不出「这个印象是听了一次就下的，
//   还是相处两个月反复印证的」。真人说「我记得你以前不是这样」靠的就是**跨度**。
//   做法：同时有 createdAt 与 lastObservedAt 且相差够久时，印成 `[09-20→10-28]`。
//   ★ 这两个字段**上游本来就有**（global-person-memory-store.js 的 normalizeEntry），
//     我们只是把它印出来 —— 不加字、不加查询、不加 token（字符数还少了一个）。
//
// ── D：印象**带置信度**（≈0 成本：纯推导）─────────────────────────────
//   问题：现在所有印象都斩钉截铁。真人会说「我印象里……不过可能记错了」。
//   做法：**不新增字段**（上游 normalizeEntry 会丢掉我们不认识的键，加了也白加），
//   而是从已有字段**推导**：
//     · 首末观察跨度过短（< 1 天）且这人只有这一条印象 ⇒ 只见过一面 ⇒ 标「印象不深」
//     · 跨度够长（≥ 7 天）⇒ 反复印证过 ⇒ 不标（默认就是可信的）
//   ★ 为什么不做"被否证就降权"：那需要额外一轮判断，且容易把正常的分歧
//     误判成"记错了"。先用确定性推导，等有真实误记案例再说。
//
// ── F：关系**里程碑**（0 LLM 成本：纯 SQL 复算）───────────────────────
//   问题：【我们之间】给的是累计量（说过多少句），不是**转折点**。
//   真人记得的是「我们第一次聊到半夜那次」，不是「一共聊了 237 次」。
//   做法：从 messages 表直接算 5 类可核对的事实（全部带时间戳，不编）：
//     第一次说话 / 第一次私聊 / 第一次深夜（0–4 点）/ 单日最多 / 最近一次
//   ★ 每条都是 SQL 算出来的真实时间，没有一次 LLM 调用。
//
// ── C：每人一句**近况**（唯一的增量成本，约 +0.01%/天）────────────────
//   问题：模型看到的是"一堆碎片事件"，没有"他这周好像挺累的"这种整体印象。
//   做法：搭在**已经存在**的事件整理调用上（不额外发起 LLM 调用），让模型多输出
//     一段 `people:[{user_id,status}]`。存在 person-status.sqlite，按需注入。
//
// ★ 铁律（与 qq-resolver 一致）：**只按 QQ 号存**。昵称只是渲染时的显示名。
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../core/config.js';

const DAY_MS = 86400000;
const clean = (v, n = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ═══════════════════════════════════════════════════════════════════════
// B + D：印象行的渲染
// ═══════════════════════════════════════════════════════════════════════

// ★★★ 2026-10-29 两次实测，第二次推翻了第一次的结论（必须记下来，别再走回头路）：
//
//   第一次：以为"印象带时间跨度"要渲染 `createdAt → lastObservedAt`。
//     实测生产库 **614 条印象，两者完全相等一条不差** ⇒ 箭头永远是 `x→x`，等于没做。
//     根因在上游 `global-person-memory-store.js:422-441` 的 `replace()`：
//     正文没变就**沿用旧时间戳**（刻意的 —— 否则"90 天没观察到就删"永远不成立）。
//
//   第二次：以为"既然等于，那就彻底没用"，于是自己建了一本 `impression-ledger.sqlite`
//     来记"这条印象在记忆里活了多少天"。**这个判断是错的。**
//     实测 `createdAt` 的年龄分布：今天 168 条 / 1-2 天 249 / 3-6 天 197 ——
//     它根本不是"一批写死的常量"，而是**"这条印象的当前措辞是什么时候定的"**：
//     整理一旦改写措辞就刷新，没改就保留 ⇒ **它的年龄正好就是"多久没变过"**。
//     那正是我们要的时间感，**本来就在数据里**。
//
//   ⇒ 现在的口径：`createdAt` 的年龄是**主来源**（立刻生效、有真实分布），
//     账本只做**补充**（同一条措辞连续存在超过 createdAt 年龄时才用账本值，
//     例如整理刷新了措辞但意思没变）。两个都拿不到才退回 `lastObservedAt`。
//
//   ★ 措辞纪律：只能说「存了 N 天」（字面事实），
//     **不能说「印证了 N 次」** —— 我们并没有真的重新观察过，那是过度声称。

const ledgerConns = new Map();
const pendingSeen = new Map();     // `${uin}\u0000${hash}` → { uin, hash, day }
let lastFlushAt = 0;

function openLedger(dataDir) {
  const dir = String(dataDir || '').trim();
  if (!dir) return null;
  if (ledgerConns.has(dir)) return ledgerConns.get(dir);
  let db = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(path.join(dir, 'impression-ledger.sqlite'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=3000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        uin       TEXT NOT NULL,
        hash      TEXT NOT NULL,
        day       TEXT NOT NULL,
        first_day TEXT NOT NULL,
        last_day  TEXT NOT NULL,
        days      INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (uin, hash)
      );
      CREATE INDEX IF NOT EXISTS idx_seen_uin ON seen(uin);
    `);
  } catch {
    db = null;
  }
  ledgerConns.set(dir, db);
  return db;
}

/** 内容指纹：正文改了就是另一条印象了（与上游"正文相同才算同一条"同一口径）。 */
export function impressionHash(content) {
  const s = String(content ?? '').replace(/\s+/g, ' ').trim();
  // 简单稳定哈希（djb2）：够用，且不引入加密库
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '-' + s.length.toString(36);
}

/**
 * 记一笔「这条印象今天还在记忆里」。
 * ★ 按 (人, 内容指纹, 天) 去重 ⇒ 同一天渲染多少次都只算一天。
 * ★ 失败一律吞掉：它只影响一行日期标注，绝不能让提示词渲染失败。
 * ★ 攒批写盘：渲染是高频路径（一次【记忆】最多 60 行），**绝不能每行都写库**。
 */
export function noteImpressionSeen(dataDir, { uin, content, ts = Date.now() } = {}) {
  const uid = String(uin || '').trim();
  if (!dataDir || !/^\d{5,15}$/.test(uid)) return false;
  const hash = impressionHash(content);
  const day = dayKeyOf(ts);
  pendingSeen.set(`${uid}\u0000${hash}`, { uin: uid, hash, day });
  // 攒够 60 条或距上次落盘超过 30 秒就刷一次
  if (pendingSeen.size >= 60 || ts - lastFlushAt > 30000) flushSeen(dataDir, ts);
  return true;
}

/** 把攒下的记录一次性写库。 */
export function flushSeen(dataDir, now = Date.now()) {
  const db = openLedger(dataDir);
  lastFlushAt = now;
  if (!db || !pendingSeen.size) { pendingSeen.clear(); return 0; }
  const batch = [...pendingSeen.values()];
  pendingSeen.clear();
  let n = 0;
  try {
    const stmt = db.prepare(`
      INSERT INTO seen (uin, hash, day, first_day, last_day, days) VALUES (?,?,?,?,?,1)
      ON CONFLICT(uin, hash) DO UPDATE SET
        days = CASE WHEN seen.day = excluded.day THEN seen.days ELSE seen.days + 1 END,
        first_day = MIN(seen.first_day, excluded.day),
        last_day = MAX(seen.last_day, excluded.day),
        day = excluded.day
    `);
    for (const r of batch) {
      try { stmt.run(r.uin, r.hash, r.day, r.day, r.day); n += 1; } catch { /* 单条失败不影响其它 */ }
    }
  } catch { /* 写不进去就当没记 */ }
  return n;
}

/**
 * 读「这条印象已经存了多少天」。
 * @returns {{days:number, firstDay:string, lastDay:string}|null}
 */
export function impressionLifespan(dataDir, { uin, content } = {}) {
  const uid = String(uin || '').trim();
  if (!dataDir || !/^\d{5,15}$/.test(uid)) return null;
  // 先落盘再读：否则刚记的这一笔读不到
  if (pendingSeen.size) flushSeen(dataDir);
  const db = openLedger(dataDir);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT days, first_day, last_day FROM seen WHERE uin = ? AND hash = ?')
      .get(uid, impressionHash(content));
    if (!row) return null;
    return { days: Number(row.days) || 1, firstDay: String(row.first_day || ''), lastDay: String(row.last_day || '') };
  } catch {
    return null;
  }
}

/** 关掉账本连接（验收脚本收尾用）。 */
export function closeImpressionLedger() {
  pendingSeen.clear();
  for (const db of ledgerConns.values()) { try { db?.close(); } catch { /* ignore */ } }
  ledgerConns.clear();
}

/** 坏时间戳守卫（与上游 memory-global 同口径：负数/超范围一律当 0）。 */
function tsOf(v) {
  const n = Number(v) || 0;
  return Number.isFinite(n) && n > 0 && n <= 8.64e15 ? n : 0;
}

/**
 * 账本"成熟度"：表里最早一条记录距今多少天。
 *
 * ★★★ 为什么必须有这个门槛（第一版上线当天实测发现的坑）：
 *   账本是**今天才开始记**的，所以第一天每条印象都是 `days = 1`。
 *   如果照此判定，第一天的【记忆】会变成**每一行都标「（印象不深）」** ——
 *   连"管理员管这个机器人很久了"这种最稳的印象也被否定。
 *   那不是在表达不确定，那是在**教模型怀疑一切记忆**，比不标更糟。
 *   ⇒ 只有当账本自己积累了 ≥ 3 天历史，"印象不深"才是**有意义**的判断。
 *     在那之前只显示天数（"存了 1 天"本身已经传达了"这是新判断"）。
 */
export function ledgerMaturityDays(dataDir, { now = Date.now() } = {}) {
  const db = openLedger(dataDir);
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT MIN(first_day) AS d FROM seen').get();
    const d = String(row?.d || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
    const t = Date.parse(`${d}T00:00:00+08:00`);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.floor((now - t) / DAY_MS));
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-01 新增：从**原始消息**反推这条印象"第一次出现"的时间
//
// 为什么必须做（这是"时感"缺陷的真正根因）：
//   实测手机 723 条印象，`createdAt === lastObservedAt` **723/723 全部相等**。
//   因为整理（consolidate）走 `replaceMember(...)` **整份替换**，
//   `createdAt` 被重置成"整理那一刻"。
//   ⇒ 现在印的「这个判断 N 天没变」里的 N 是假的：
//     9 月那 6,403 条消息产生的印象，N 全是从 10-25 之后算的。
//
// 做法：拿印象正文里的**实词**去 messages 表里查这个人说过的话，
//   取命中的**最早时间**。这是"这条印象大概是什么时候形成的"的最诚实估计。
//   ★ 纯 SQL，零 LLM，零新数据。查不到就返回 null（绝不编时间）。
//   ★ 有 2 秒 busy_timeout + 结果缓存，渲染是高频路径不能拖慢。
// ═══════════════════════════════════════════════════════════════════════

const originCache = new Map();   // `${uin}|${hash}` -> {ts, at}
const ORIGIN_CACHE_TTL = 10 * 60 * 1000;   // 10 分钟
const ORIGIN_CACHE_MAX = 800;

/**
 * 从印象正文里抽"可核对的名词性片段"，用于回查消息。
 *
 * ★ 2026-11-01 实测教训（第一版命中率只有 2/8）：
 *   第一版要求**连续 3~6 字**的中文片段，但印象正文是**概括性**的
 *   （"他常聊《文明6》…"），原文里几乎不会连续出现这么长的片段。
 *   ⇒ 改成抽 **2 字二元组**（命中率大幅提升），并按"信息量"排序：
 *     专有名词（书名号/引号里）> 4 字词 > 3 字词 > 2 字词。
 *   ★ 同时剔除高频虚词二元组（"他说""他会""的是"这类），它们命中率极高但没有区分度。
 */
const ORIGIN_STOP_BIGRAMS = new Set([
  '他说', '她会', '他会', '它说', '的是', '了的', '这个', '那个', '什么', '怎么',
  '因为', '所以', '但是', '而且', '就是', '可以', '已经', '还是', '或者', '然后',
  '现在', '时候', '自己', '别人', '喜欢', '习惯', '经常', '常常', '有时', '偶尔',
  '觉得', '认为', '表示', '提到', '比如', '例如', '包括', '以及', '还有', '一个',
  '一些', '这种', '那种', '这么', '那么', '非常', '比较', '有点', '很多', '没有'
]);

function originProbeTerms(content, max = 10) {
  const s = String(content || '');
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const w = String(t || '').trim();
    if (w.length < 2 || seen.has(w)) return;
    if (ORIGIN_STOP_BIGRAMS.has(w)) return;
    seen.add(w); out.push(w);
  };

  // ① 最高优先：书名号/引号里的专有名词（"文明6"、"骗子酒馆"、"鲑鱼大帝"）
  for (const m of s.matchAll(/[《【「"'']([^》】」"'']{2,12})[》】」"'']/g)) push(m[1]);
  // ② 英文/数字词（"SnowLuma"、"token"、"文明6" 的数字部分）
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) push(m[0]);
  // ③ 中文：先 4 字、再 3 字、最后 2 字（长优先，但都要过停用表）
  const cn = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of cn.split(/\s+/)) {
    if (seg.length < 2) continue;
    for (let len = 4; len >= 2; len -= 1) {
      for (let i = 0; i + len <= seg.length; i += 1) {
        push(seg.slice(i, i + len));
        if (out.length >= max * 3) break;
      }
      if (out.length >= max * 3) break;
    }
  }
  return out.slice(0, max);
}

/**
 * 估算一条印象"最早可能形成于什么时候"。
 * @returns {number|null} 毫秒时间戳；查不到返回 null
 */
export function impressionOriginAt(messagesDbPath, { uin, content, now = Date.now() } = {}) {
  const uid = String(uin || '').trim();
  if (!messagesDbPath || !/^\d{5,15}$/.test(uid) || !content) return null;
  const key = `${uid}|${impressionHash(content)}`;
  const hit = originCache.get(key);
  if (hit && now - hit.at < ORIGIN_CACHE_TTL) return hit.ts;

  const db = openReadOnly(messagesDbPath);
  if (!db) return null;
  let best = null;
  try {
    const terms = originProbeTerms(content);
    for (const t of terms) {
      // ★ 只查这个人自己说的（sender_id），避免把别人说的话算成他的
      const row = db.prepare(
        `SELECT MIN(ts) AS t FROM messages
         WHERE sender_id = ? AND text LIKE ? AND ts > 0`
      ).get(uid, `%${t}%`);
      const ts = Number(row?.t) || 0;
      if (ts > 0 && (best === null || ts < best)) best = ts;
    }
  } catch { /* 查不到就当没有 */ }
  if (originCache.size > ORIGIN_CACHE_MAX) originCache.clear();
  originCache.set(key, { ts: best, at: now });
  return best;
}

/**
 * 算一条印象的时间跨度与可信度。
 *
 * ★ 时间口径：`createdAt` 的**年龄**（= "这个判断多久没变过"，实测有真实分布：
 *   今天 168 / 1-2 天 249 / 3-6 天 197 条），账本只做补充。
 *
 * ★★ 置信度口径（2026-10-29 第三次修正，前两版都不对）：
 *   前两版拿**时间**当置信度依据 —— "今天写的就不深"。那是错的：
 *   一个聊了 1459 句的人，今天总结出的印象依然是**证据充分**的；
 *   一个只说过 2 句的人，印象存了 30 天也还是**薄**的。
 *   ⇒ 置信度的正确依据是**证据量**（他跟机器人互动过多少次），不是时间。
 *     时间只用来表达"这个判断多久没变"（那是另一件事，也已经在印了）。
 *
 * @param {object} entry
 * @param {object} [opts]
 * @param {number} [opts.siblingCount]  这个人一共几条印象
 * @param {number} [opts.interactions]  这个人跟机器人的互动次数（证据量，来自 people/*.json 的 relationship）
 * @param {number} [opts.now]
 * @param {{days:number}|null} [opts.lifespan]
 * @param {boolean} [opts.mature]
 * @returns {{ageDays:number, aliveDays:number, spanDays:number, confidence:number, low:boolean, source:string, first:number, last:number}}
 */
export function impressionFacts(entry, {
  siblingCount = 1, interactions = 0, now = Date.now(), lifespan = null, mature = false,
  originAt = null   // ★ 2026-11-01：从原始消息反推的"这条印象最早可能形成于"时间戳
} = {}) {
  const first = tsOf(entry?.createdAt);
  const last = Math.max(first, tsOf(entry?.lastObservedAt) || first);
  // ① 这个判断多久没变过
  const ageDays = first ? Math.max(0, Math.floor((now - first) / DAY_MS)) : 0;
  // ② 账本记得它存在了几天（补充：措辞被整理刷新但意思没变时，账本更诚实）
  const aliveDays = Math.max(0, Number(lifespan?.days) || 0);
  // ★★★ ③ 2026-11-01 新增：从**原始消息**反推的真实起点。
  //   实测 723/723 条印象的 createdAt === lastObservedAt（整理时被整份替换重置），
  //   所以单靠 createdAt 算出来的"多久没变"是**假的**。
  //   原始消息是唯一没被重置过的证据 —— 用它的最早命中时间当起点。
  //   ★ 只取"比 createdAt 更早"的，绝不把时间往后推（那会显得比实际更新）。
  const originTs = Number(originAt) || 0;
  const originDays = (originTs > 0 && first && originTs < first)
    ? Math.max(0, Math.floor((now - originTs) / DAY_MS))
    : 0;
  const spanDays = Math.max(ageDays, aliveDays, originDays);
  const source = originDays >= Math.max(ageDays, aliveDays)
    ? (originDays > 0 ? 'messages' : 'none')
    : (aliveDays > ageDays ? 'ledger' : (ageDays > 0 ? 'createdAt' : 'none'));

  // ③ 置信度 = 证据量（互动次数），不是时间。
  //    · ≥ 100 次互动 ⇒ 0.9（处得很久，判断有底）
  //    · ≥ 30        ⇒ 0.8
  //    · ≥ 10        ⇒ 0.7
  //    · ≥ 3         ⇒ 0.55
  //    · < 3         ⇒ 0.35（几乎没聊过，只能说个大概）
  //    · 同一人还有别的印象 ⇒ +0.05；人工写的 ⇒ 1.0
  const n = Math.max(0, Number(interactions) || 0);
  let confidence;
  if (n >= 100) confidence = 0.9;
  else if (n >= 30) confidence = 0.8;
  else if (n >= 10) confidence = 0.7;
  else if (n >= 3) confidence = 0.55;
  else confidence = 0.35;
  if (siblingCount >= 2) confidence = Math.min(0.95, confidence + 0.05);
  if (entry?.origin === 'manual') confidence = 1;

  // ★ 只有当**真的几乎没有证据**（互动 < 3 次）时才标"印象不深"。
  //   ⚠️ 绝不能用"今天写的"当理由 —— 那会把今天总结出的、证据充分的判断全部否定，
  //      等于教模型怀疑一切新记忆（第一版就这么错过）。
  //   ★ 账本未成熟不影响这一条：它依据的是互动次数，不是账本。
  const low = n < 3 && entry?.origin !== 'manual';
  return {
    ageDays, aliveDays, spanDays,
    originDays, originAt: originTs || 0,
    confidence: Math.round(confidence * 100) / 100,
    low, source, first, last, interactions: n
  };
}

/** MM-DD（今年省年份；往年的带年份，否则跨年会被读错）。 */
function stampOf(ts, thisYear) {
  if (!ts) return '日期未知';
  const d = new Date(ts + 8 * 3600 * 1000);   // 与上游 todayKey 同口径（东八区）
  const y = d.getUTCFullYear();
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return String(y) === String(thisYear) ? md : `${y}-${md}`;
}

/**
 * 去掉印象正文尾部的「（记于 2026-10-28 20:29）」。
 *
 * ★ 为什么会有这个尾注：上游整理流程在某种路径下会把日期注脚写进正文
 *   （实测管理员的三条印象末尾都带它）。上游自己也把它当噪声处理 ——
 *   `orchestrator.js:3390` 的 `impressionKey()` 就是专门剥掉它再做去重的。
 * ★ 为什么现在剥：我们已经用 `[这个判断 N 天没变]` 表达了时间，
 *   正文再挂一个「记于」就是**同一件事说两次**，白占 token、读着也啰嗦。
 * ★ 只剥**末尾**的这一种固定形状，不做任何模糊替换（改坏正文比多几个字严重）。
 */
export function stripDatedNote(content) {
  return String(content ?? '')
    .replace(/（记于[^）]{0,40}）\s*$/, '')
    .replace(/\(记于[^)]{0,40}\)\s*$/, '')
    .trim();
}

/**
 * 渲染一行印象（**替代**上游那句 `- ${who}：[${stamp}] ${content}`）。
 *
 * 输出形状（★ 措辞纪律：只说"这个判断多久没变"，不声称"印证了几次"）：
 *   `- 陈黛华：[这个判断 4 天没变] 说话幽默…`
 *   `- 陈黛华：[这个判断 1 天没变]（印象不深）…`   ← 证据太少
 *   `- 陈黛华：[10-29] 说话幽默…`                  ← 时间戳缺失（老行为）
 *
 * ★ 为什么写「这个判断 N 天没变」而不是「存了 N 天」：
 *   后者会被读成"认识多久 / 处了多久"，那是【我们之间】在讲的事。
 *   这里的语义是**这条印象本身多久没被推翻**，措辞必须点明"这个判断"。
 *
 * @param {object} o
 * @param {string} o.who
 * @param {object} o.entry
 * @param {number} o.siblingCount 这个人一共几条印象
 * @param {number} o.interactions 这个人跟机器人的互动次数（证据量）
 * @param {string} o.thisYear    '2026'
 * @param {(s:string)=>string} o.sanitize
 * @param {{days:number}|null} [o.lifespan]  账本读数（noteImpressionSeen 那一套）
 * @param {boolean} [o.mature]  账本是否已积累够历史
 */
export function renderImpressionLine({
  who, entry, siblingCount = 1, interactions = 0, thisYear = '', sanitize = (s) => s,
  lifespan = null, mature = false, originAt = null
} = {}) {
  const f = impressionFacts(entry, { siblingCount, interactions, lifespan, mature, originAt });
  let span;
  if (f.spanDays >= 1) {
    // ★ 只用"这个判断多久没变"这个字面事实 —— 不写"印证过几次"，我们并没有真的重新观察。
    // ★ 2026-11-01：优先用 messages 反推的起点（source='messages'），
    //   因为 createdAt 被整理重置过，单靠它算出来的天数不可信。
    //   措辞按"更像人"分级 —— 人对时间的感知是分档的，不是精确到天。
    span = humanSpan(f.spanDays);
  } else {
    // 时间戳缺失/坏掉：退回老行为（印日期），绝不印 "0 天没变"
    span = stampOf(f.last || f.first, thisYear) || '日期未知';
  }
  // ★ 低置信只在**自动**印象上标（人工写的没必要质疑）
  const flag = f.low && entry?.origin !== 'manual' ? '（印象不深）' : '';
  return `- ${who}：[${span}]${flag} ${sanitize(stripDatedNote(entry?.content))}`;
}

/**
 * 把"天数"翻成**人话**。
 * ★ 2026-11-01 新增：原来一律印「这个判断 N 天没变」，
 *   但"这个判断 47 天没变"这种精确到天的说法不像人 —— 人会分档说。
 *   ★ 分档依据：短跨度精确（1~2 天有意义），长跨度模糊（人对"很久以前"本来就不精确）。
 */
export function humanSpan(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  if (d <= 0) return '';
  if (d === 1) return '昨天才这么想';
  if (d <= 3) return `这几天一直这么想`;
  if (d <= 7) return `这周都这么觉得`;
  if (d <= 14) return `这个判断两周没变`;
  if (d <= 30) return `这个判断一个多月没变`;
  if (d <= 90) return `这个判断有两三个月了`;
  if (d <= 180) return `这个判断有半年了`;
  return `这个判断有一年多了`;
}

// ═══════════════════════════════════════════════════════════════════════
// F：关系里程碑（纯 SQL、零 LLM）
// ═══════════════════════════════════════════════════════════════════════

const conns = new Map();
function openReadOnly(file) {
  if (!file || !fs.existsSync(file)) return null;
  if (conns.has(file)) return conns.get(file);
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* ignore */ }
  } catch { db = null; }
  conns.set(file, db);
  return db;
}

/** 相对时间说法（"3 天前"比时间戳更像人话）。 */
export function humanAgo(then, now = Date.now()) {
  const d = now - Number(then || 0);
  if (!Number.isFinite(d) || d < 0) return '';
  const m = Math.round(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const dd = Math.round(h / 24);
  if (dd < 30) return `${dd} 天前`;
  const mo = Math.round(dd / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.round(mo / 12)} 年前`;
}

/** YYYY-MM-DD（东八区）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 算一个人与机器人之间的**转折点**（全部可核对，算不出来就不返回）。
 *
 * ★ 只取"第一次"与"最极端"这两类 —— 那才是里程碑；中间过程是统计，不是回忆。
 * ★ 深夜按**东八区 0–4 点**（`ts` 是毫秒时间戳，SQL 里换算）。
 *
 * @param {string} uin
 * @param {object} o
 * @param {string} o.messagesDbPath
 * @param {string} [o.chatKey] 给了就只在这个会话内算"第一次说话"；跨群类（私聊/深夜）始终全库
 * @param {number} [o.max] 最多几条
 * @returns {{items:Array<{kind:string,label:string,at:number,ago:string,detail:string}>, ...}|null}
 */
export function personMilestones(uin, { messagesDbPath, chatKey = '', max = 4, now = Date.now() } = {}) {
  const uid = String(uin || '').trim();
  if (!/^\d{5,15}$/.test(uid) || !messagesDbPath) return null;
  const db = openReadOnly(messagesDbPath);
  if (!db) return null;
  const items = [];
  try {
    // ① 第一次说话（本会话）—— 全库的"最早"更接近"认识多久"，两个都取
    const scope = chatKey ? 'AND chat_key = ?' : '';
    const args = chatKey ? [uid, chatKey] : [uid];
    const firstHere = db.prepare(
      `SELECT MIN(ts) AS ts FROM messages WHERE sender_id = ? ${scope}`
    ).get(...args);
    const firstAny = db.prepare('SELECT MIN(ts) AS ts FROM messages WHERE sender_id = ?').get(uid);
    const tFirstAny = Number(firstAny?.ts) || 0;
    const tFirstHere = Number(firstHere?.ts) || 0;
    if (tFirstAny) {
      items.push({
        kind: 'first_met',
        label: '第一次说话',
        at: tFirstAny,
        ago: humanAgo(tFirstAny, now),
        detail: humanAgo(tFirstAny, now)
      });
    }
    // ② 第一次私聊（跨群；只有真的在私聊里说过才算）
    const firstPrivate = db.prepare(
      `SELECT MIN(ts) AS ts FROM messages WHERE sender_id = ? AND chat_key LIKE 'private:%'`
    ).get(uid);
    const tPrivate = Number(firstPrivate?.ts) || 0;
    if (tPrivate) {
      items.push({ kind: 'first_private', label: '第一次私聊', at: tPrivate, ago: humanAgo(tPrivate, now), detail: humanAgo(tPrivate, now) });
    }
    // ③ 第一次深夜（东八区 0–4 点）
    const firstNight = db.prepare(
      `SELECT MIN(ts) AS ts FROM messages WHERE sender_id = ?
        AND CAST(strftime('%H', ts / 1000, 'unixepoch', '+8 hours') AS INTEGER) BETWEEN 0 AND 4`
    ).get(uid);
    const tNight = Number(firstNight?.ts) || 0;
    if (tNight) {
      items.push({ kind: 'first_late_night', label: '第一次聊到半夜', at: tNight, ago: humanAgo(tNight, now), detail: humanAgo(tNight, now) });
    }
    // ④ 单日最多（"哪天聊得最凶"）—— 只在确实明显多于平常时才值得一提
    const busiest = db.prepare(
      `SELECT day, n FROM (
         SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+8 hours') AS day, COUNT(*) AS n
         FROM messages WHERE sender_id = ? GROUP BY day
       ) ORDER BY n DESC LIMIT 1`
    ).get(uid);
    const busyN = Number(busiest?.n) || 0;
    if (busyN >= 30) {
      items.push({ kind: 'busiest_day', label: `单日最多（${busyN} 句）`, at: 0, ago: '', detail: String(busiest.day || '') });
    }
    // ⑤ 最近一次
    const latest = db.prepare('SELECT MAX(ts) AS ts FROM messages WHERE sender_id = ?').get(uid);
    const tLatest = Number(latest?.ts) || 0;
    if (tLatest) {
      items.push({ kind: 'last_seen', label: '最近说话', at: tLatest, ago: humanAgo(tLatest, now), detail: humanAgo(tLatest, now) });
    }
    if (!items.length) return null;
    return {
      uin: uid,
      firstMetAt: tFirstAny,
      firstHereAt: tFirstHere,
      firstPrivateAt: tPrivate,
      firstLateNightAt: tNight,
      busiestDay: String(busiest?.day || ''),
      busiestCount: busyN,
      lastSeenAt: tLatest,
      items: items.slice(0, Math.max(1, Number(max) || 4))
    };
  } catch {
    return null;
  }
}

/** 渲染里程碑成一行（给提示词用，尽量短）。 */
export function formatMilestones(m, { name = '' } = {}) {
  if (!m?.items?.length) return '';
  const who = clean(name, 40) || m.uin;
  const DAY_MS_ = 86400000;
  // ★ 里程碑的意义是"**转折**"，不是"第一次做某事的清单"。
  //   实测：管理员那三条（第一次说话 / 第一次私聊 / 第一次半夜）全落在同一天，
  //   并列写出来就是「1 个月前；1 个月前；1 个月前」—— 纯噪声。
  //   规则：私聊 / 半夜 只有在比"第一次说话"晚 ≥ 1 天时才算独立里程碑。
  const base = Number(m.firstMetAt) || 0;
  const distinct = (at) => Number(at) > 0 && (!base || Number(at) - base >= DAY_MS_);
  const bits = [];
  if (base) bits.push(`第一次说话是 ${humanAgo(base)}`);
  if (distinct(m.firstPrivateAt)) bits.push(`第一次私聊是 ${humanAgo(m.firstPrivateAt)}`);
  if (distinct(m.firstLateNightAt)) bits.push(`第一次聊到半夜是 ${humanAgo(m.firstLateNightAt)}`);
  if (m.busiestCount >= 30 && m.busiestDay) bits.push(`${m.busiestDay} 那天说了 ${m.busiestCount} 句`);
  if (!bits.length) return '';
  return `- ${who}：${bits.join('；')}。`;
}

// ═══════════════════════════════════════════════════════════════════════
// C：每人一句近况（增量成本只有整理调用多写几十个字）
// ═══════════════════════════════════════════════════════════════════════

const STATUS_DB = 'person-status.sqlite';

function openStatusDb(dataDir) {
  const dir = String(dataDir || '').trim();
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, STATUS_DB));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS status (
      uin      TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL DEFAULT '',
      line     TEXT NOT NULL,
      ts       INTEGER NOT NULL,
      day      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_status_ts ON status(ts DESC);
  `);
  return db;
}

/**
 * 写入/更新某人的一句近况（同一人只保留最新一句 —— 近况的意义就是"现在"）。
 * @returns {boolean}
 */
export function setPersonStatus(dataDir, { uin, line, chatKey = '', ts = Date.now() } = {}) {
  const uid = String(uin || '').trim();
  const text = clean(line, 80);
  if (!dataDir || !/^\d{5,15}$/.test(uid) || !text) return false;
  let db = null;
  try {
    db = openStatusDb(dataDir);
    if (!db) return false;
    db.prepare(`INSERT INTO status (uin, chat_key, line, ts, day) VALUES (?,?,?,?,?)
      ON CONFLICT(uin) DO UPDATE SET chat_key=excluded.chat_key, line=excluded.line,
        ts=excluded.ts, day=excluded.day`).run(uid, String(chatKey || ''), text, Number(ts) || Date.now(), dayKeyOf(ts));
    return true;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * 批量读近况（给提示词用）。只读**给进来的这几个人**，不多查。
 * @returns {Map<string,{line:string,ts:number,ago:string}>}
 */
export function getPersonStatuses(dataDir, uins = [], { maxAgeDays = 21, now = Date.now() } = {}) {
  const out = new Map();
  const ids = [...new Set((Array.isArray(uins) ? uins : []).map((x) => String(x ?? '').trim()).filter((x) => /^\d{5,15}$/.test(x)))];
  if (!dataDir || !ids.length) return out;
  let db = null;
  try {
    db = openStatusDb(dataDir);
    if (!db) return out;
    const cutoff = now - Math.max(1, Number(maxAgeDays) || 21) * DAY_MS;
    const marks = ids.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT uin, line, ts FROM status WHERE uin IN (${marks}) AND ts >= ?`).all(...ids, cutoff)) {
      out.set(String(r.uin), { line: String(r.line || ''), ts: Number(r.ts) || 0, ago: humanAgo(r.ts, now) });
    }
    return out;
  } catch {
    return out;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 渲染近况段（只给 1~3 个人，太多就不像"我记得你"，而像报表）。 */
export function formatPersonStatuses(map, { maxPeople = 3, names = null } = {}) {
  if (!map?.size) return '';
  const rows = [...map.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, Math.max(1, Number(maxPeople) || 3));
  const lines = rows.map(([uin, v]) => {
    const who = clean(names?.[uin], 40) || uin;
    return `- ${who}：${v.line}${v.ago ? `（${v.ago}）` : ''}`;
  });
  return lines.join('\n');
}

/** 清掉本模块的只读连接（验收脚本收尾用）。 */
export function closeImpressionStore() {
  for (const db of conns.values()) { try { db?.close(); } catch { /* ignore */ } }
  conns.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// E：记忆的钩子 —— 「你怎么知道的？」要答得出来
// ═══════════════════════════════════════════════════════════════════════
//
// ★ 问题：现在的印象是**结论**（"他喜欢猫"），没有**出处**。
//   模型说"我记得你喜欢猫"，对方问"你怎么知道"，它只能说"我记的" —— 很假。
//
// ★ 为什么**不把原文片段存进印象文件**（原方案 E 的写法）：
//   ① 上游 `normalizeEntry()` 只保留 content / createdAt / lastObservedAt /
//      origin / sourceChatKeys 五个键，**多写一个键会被静默丢掉** ——
//      存在印象里等于白存（下次读盘就没了）。
//   ② 就算能存，也要在整理时让模型额外产出引文 ⇒ 多花 token、还可能编出原文。
//   ③ **原话本来就在 `messages.sqlite` 里**，而且那才是唯一真实的版本。
//   ⇒ 改成**按需反查**：模型被问"你怎么知道"时才调 `memory_why` 工具，
//     从真实聊天记录里捞出 1~2 句他自己说过的话。
//   ★ 成本：平时**零注入**（不进提示词），只有真被追问时才查一次。
//   ★ 准确性：捞的是**逐字原话**，不是模型转述 —— 答得出、也对得上。

/**
 * 关键词切分（中文没有空格，按二元组 + 英文词切）。
 * ★ 与 memory-search.js 的 tokenizeText 同思路，但这里只用于 LIKE 检索，越简单越可靠。
 * ★ 单字中文单独处理：话题就是「猫」这种一个字时，二元组切不出来 ——
 *   直接丢掉它会让检索退化到"这个人的最近几句"（那就成了瞎引）。
 */
export function keywordTerms(text, { max = 6 } = {}) {
  const s = String(text ?? '').toLowerCase().trim();
  const out = new Set();
  // 英文/数字词
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const han = s.replace(/[^\u4e00-\u9fff]/g, '');
  if (han.length === 1) {
    out.add(han);                       // 整个话题就一个字（"猫""鱼"）
  } else {
    for (let i = 0; i + 2 <= han.length; i += 1) out.add(han.slice(i, i + 2));
    if (han.length >= 3) out.add(han);   // 整串也留一个，命中更精确
  }
  return [...out].filter((x) => x.length >= 1).slice(0, Math.max(1, Number(max) || 6));
}

/**
 * 反查「这句话他是怎么说的」—— 从**真实聊天记录**里捞出逐字原话。
 *
 * @param {object} o
 * @param {string} o.uin             谁
 * @param {string} [o.topic]         印象/话题关键词（空=只按人取最近几句）
 * @param {string} o.messagesDbPath
 * @param {string} [o.chatKey]       给了就只在这个会话里找
 * @param {number} [o.limit]         最多几条，默认 2（真人回忆也只会想起一两句）
 * @param {number} [o.scanLimit]     最多扫多少行候选，默认 400（防大群全表扫）
 * @returns {{quotes:Array<{text:string,ts:number,ago:string,chatKey:string}>, scanned:number, terms:string[], matched:boolean}|null}
 *
 * ★★★ 返回值语义（调用方必须按它措辞，别混着用）：
 *   · `matched:true`  ⇒ 这些是**关于这个话题**的原话，可以直接引用；
 *   · `matched:false` + 有 quotes ⇒ 这是**他最近说过的话**，跟话题无关，
 *     只能当"他最近这么说话"的语气参考，**绝不能当证据**；
 *   · quotes 为空 ⇒ **就是查不到**。这时必须如实说"记不清了"，
 *     不许拿别的话凑数（那正是"编造回忆"）。
 */
export function findMemoryQuotes({
  uin, topic = '', messagesDbPath, chatKey = '', limit = 2, scanLimit = 400, now = Date.now()
} = {}) {
  const uid = String(uin || '').trim();
  if (!/^\d{5,15}$/.test(uid) || !messagesDbPath) return null;
  const db = openReadOnly(messagesDbPath);
  if (!db) return null;
  const max = Math.max(1, Math.min(5, Number(limit) || 2));
  const scan = Math.max(20, Math.min(2000, Number(scanLimit) || 400));
  const terms = keywordTerms(topic);
  // ★★ 命中门槛（2026-10-29 验收抓出两次）：
  //   中文二元组会把**胡编的话题**也切出一堆看似合理的词 ——
  //   「完全不存在的话题zzz」切出 完全/全不/不存/存在/在的。
  //   ① 只数"命中了几个词"不够：一句话里「完全不会」会同时命中 `完全` 与 `全不`
  //      （两个**重叠**的二元组），于是一个词就凑满了 2 个命中。
  //   ② ⇒ 改成看**覆盖比例**：把命中的位置合并成区间，算它覆盖了**原始话题**的多少。
  //      真正相关时覆盖率高（"鲸鱼"话题命中"别戳，鲸鱼漏气" = 2/2 = 100%）；
  //      靠重叠凑数时很低（「完全不存在的话题zzz」命中「完全不会」= 3/8 = 38%）。
  //   ★ hanLen 必须取**原始话题**的中文字数，不能取"最长那个词"的长度 ——
  //     取词长时长话题会被算得跟自己一样短，门槛等于没有（第一版就是这么错的）。
  const topicHanLen = String(topic ?? '').replace(/[^\u4e00-\u9fff]/g, '').length;
  const hanLen = Math.max(1, topicHanLen);
  const MIN_COVERAGE = 0.5;
  try {
    const scope = chatKey ? 'AND chat_key = ?' : '';
    const baseArgs = chatKey ? [uid, chatKey] : [uid];

    /** 把原始行清洗成"能读的原话"。★ 与 relational-memory 同一套清洗（实测这三种噪声都会混进来）。
     *  ★★ 关键：清洗后必须**再验一次关键词** —— SQL 是在**原始文本**上 LIKE 的，
     *     而引用头 `[引用#…·猫娘：…]` 里也带关键词。清洗把引用头剥掉之后，
     *     剩下的句子可能跟话题毫无关系（实测：「为什么要保证不下」就是这么来的）。
     */
    const cleanRows = (rows) => {
      const out = [];
      const seen = new Set();
      for (const r of rows) {
        let t = clean(r.text, 120);
        t = t.replace(/^\[引用[^\]]*\]\s*/g, '').replace(/^[^\]]{0,40}\]\s*/g, '').replace(/\[at\]/g, '');
        t = t.replace(/^@\S+\s*/, '').replace(/^[@\s]+/, '').trim();
        if (t.length < 2) continue;
        if (/^[[{]/.test(t) || /"\s*,\s*"/.test(t)) continue;
        if (!/[\u4e00-\u9fffA-Za-z]/.test(t)) continue;
        // ★★ 清洗后重新验关键词，并且要够"覆盖"（见上面 MIN_COVERAGE 的说明）。
        //     SQL 的 LIKE 是在**原始文本**上做的：引用头 `[引用#…·猫娘：…]` 里也带关键词，
        //     剥掉之后剩下的句子可能跟话题毫无关系（实测：「为什么要保证不下」就是这么来的）。
        if (terms.length) {
          const low = t.toLowerCase();
          // 把每个命中词的**位置区间**找出来，合并后算覆盖了多少字
          const spans = [];
          for (const k of terms) {
            const kk = k.toLowerCase();
            let from = 0;
            for (;;) {
              const at = low.indexOf(kk, from);
              if (at < 0) break;
              spans.push([at, at + kk.length]);
              from = at + 1;
              if (spans.length > 200) break;   // 防病态输入
            }
          }
          if (!spans.length) continue;
          spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          let covered = 0;
          let cur = -1;
          for (const [a, b] of spans) {
            if (b <= cur) continue;              // 完全被前一个覆盖
            covered += b - Math.max(a, cur);     // 只补新的那一段
            cur = b;
          }
          // ★ 纯英文话题（hanLen=1 但那 1 是兜底值）只要出现过就算命中
          const need = topicHanLen > 0
            ? Math.max(1, Math.ceil(hanLen * MIN_COVERAGE))
            : 1;
          if (covered < need) continue;
        }
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({ text: t, ts: Number(r.ts) || 0, ago: humanAgo(r.ts, now), chatKey: String(r.chatKey || '') });
        if (out.length >= max * 6) break;
      }
      return out;
    };

    // ① 有关键词：先按关键词收窄（LIKE 的 OR 组合）
    let cleaned = [];
    let matched = false;
    let scanned = 0;
    if (terms.length) {
      const ors = terms.map(() => "(text LIKE ? ESCAPE '\\')").join(' OR ');
      const likeArgs = terms.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
      let rows = [];
      try {
        rows = db.prepare(`SELECT chat_key AS chatKey, ts, text FROM messages
          WHERE sender_id = ? ${scope} AND self = 0 AND TRIM(COALESCE(text,'')) <> ''
            AND (${ors})
          ORDER BY ts DESC LIMIT ?`).all(...baseArgs, ...likeArgs, scan);
      } catch { rows = []; }
      scanned = rows.length;
      cleaned = cleanRows(rows);
      // ★ matched 看的是**清洗后还剩几条**：SQL 命中了但全是引用头/JSON 残留时，
      //   等于没命中 —— 这时必须落到下面的兜底（实测踩过：matched=true 却一条都引不出来）。
      matched = cleaned.length > 0;
    }

    // ② 关键词没命中（或没给关键词）：退回"这个人最近说过的几句"，
    //   ★ 但**必须标明这是"最近说过的话"，不是"关于这个话题的原话"** ——
    //     混为一谈等于把不相干的话当成证据，比没有更糟
    //     （实测：topic='猫' 只命中 1 条，一退回就成了「不然真的养不起」，跟猫毫无关系）。
    if (!cleaned.length) {
      const rows = db.prepare(`SELECT chat_key AS chatKey, ts, text FROM messages
        WHERE sender_id = ? ${scope} AND self = 0 AND TRIM(COALESCE(text,'')) <> ''
        ORDER BY ts DESC LIMIT ?`).all(...baseArgs, Math.min(60, scan));
      cleaned = cleanRows(rows);
      scanned += rows.length;
      matched = false;
    }

    // ③ 排序：关键词命中时优先"短"（更像随口一说）；兜底时保持"最近优先"
    const picked = matched
      ? cleaned.slice().sort((a, b) => a.text.length - b.text.length).slice(0, max)
      : cleaned.slice(0, max);
    return { quotes: picked, scanned, terms, matched };
  } catch {
    return null;
  }
}
