// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 事件记忆（episodic memory）：把"确实发生过的事"按天存下来，供以后回查。
//
// ── 为什么必须单独一层，而不是扩充人物印象 ──────────────────────────────
// 现有的人物印象（data/memory/people/<QQ>.json）**在设计上就是要删掉一次性事件的**：
//   orchestrator.js:2120  "一次性事件（不会再次影响相处）的印象删除"
//   tools-core.js:713     "太临时的事情不要记"
//   prompt.js:150         "不要记临时话题、临时想法"
// 那是刻意的：印象要的是"这个人的稳定特征"，不是流水账。
//
// 但用户要的是"**至少记住一个月里发生过什么**"——"上周三他跟我说过什么"这种问题，
// 靠"稳定特征"永远答不出来。两件事目标相反，所以这里与印象**并列**存在，互不干扰：
//   印象层 = 他是谁（稳定特征，条数极少，人工/模型都可改）
//   事件层 = 发生过什么（事实流水，按时间检索，默认保留 45 天）
//
// ── 两条设计约束（都是用户明确要求过的）────────────────────────────────
// 1. **按会话隔离**：每条事件都带 chat_key，检索时只查当前会话。
//    A 群发生过的事**绝不**注入 B 群的提示词（与人物印象的 promptScope='chat' 同一原则）。
// 2. **只存事实，不做评价**：summary 是可核对的一句话（谁、什么时候、做了什么），
//    由整理模型从原文抽取；本文件不做任何推断或补全。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, getConfig } from '../core/config.js';
import { isQqNumber } from '../identity/qq-resolver.js';
import { localSourceVisible } from './local-query-policy.js';

const DAY_MS = 86400000;

/** 本地时区的 YYYY-MM-DD（"按天"检索用的键；用 UTC 会让晚上的事落到第二天）。 */
export function localDay(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 给模型看的时间：MM-DD HH:MM（省 token，且跨年概率极低）。 */
export function shortStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export class EpisodeStore {
  constructor({ dataDir = DATA_DIR, filename = null } = {}) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename || path.join(dataDir, 'episodes.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        who TEXT NOT NULL DEFAULT '',
        day TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        summary TEXT NOT NULL,
        topics TEXT NOT NULL DEFAULT '',
        source_message_ids TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE (chat_key, occurred_at, summary)
      );
      CREATE INDEX IF NOT EXISTS episodes_chat_time ON episodes(chat_key, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS episodes_time ON episodes(occurred_at);
      CREATE INDEX IF NOT EXISTS episodes_user ON episodes(chat_key, user_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS episode_state (
        chat_key TEXT PRIMARY KEY,
        last_consolidated_at INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    // ★ 2026-10-29 加列（老库升级）：`user_source` 记录这条身份是怎么解析出来的
    //   —— 没有它，以后怀疑"记错人"时无法区分是模型自己写的 QQ 号还是我们反查的。
    //   `who` 保留**当时那个群里的昵称快照**（人会改名），身份只看 `user_id`。
    try {
      const cols = this.db.prepare('PRAGMA table_info(episodes)').all().map((c) => String(c.name));
      if (!cols.includes('user_source')) {
        this.db.exec("ALTER TABLE episodes ADD COLUMN user_source TEXT NOT NULL DEFAULT ''");
      }
    } catch { /* 加不上就算了：解析本身不依赖这一列 */ }
  }

  /**
   * 批量写入事件（幂等：同一会话 + 同一时间 + 同一句话只会存在一条）。
   *
   * ★★★ 2026-10-29 改（用户定的规矩）：
   *   「我们保存的所有资料都严格按照QQ号去绑定，而不是昵称；
   *     昵称只有在真正聊天的时候才需要替换……只有QQ号是唯一识别身份。」
   *   ⇒ `user_id` 是这条事件的**身份主键**，`who` 只保留"当时那个群里的昵称快照"
   *     （人会改名、不同群不同名，所以它绝不能当键）。
   *   ⇒ 解析分两层：
   *     ① 调用方（local-episodes 的 parseEpisodeEvents）已经用**消息编号**反查好了 —— 最可靠；
   *     ② 没解析出来的，交给 `opts.resolveUser` 兜底（本模块不认识消息库，不自己查）。
   *   两样都没有就**留空**，绝不猜人（错人比空白严重得多）。
   *
   * @param {string} chatKey
   * @param {object[]} events
   * @param {{resolveUser?: (e:object)=>string}} [opts] 兜底解析器：返回 QQ 号或空串
   * @returns {number} 真正新写入的条数（被 UNIQUE 挡掉的不计）
   */
  addMany(chatKey, events = [], { resolveUser = null } = {}) {
    const key = String(chatKey || '').trim();
    if (!key) return 0;
    const list = (Array.isArray(events) ? events : []).slice(0, 200);
    if (!list.length) return 0;
    const now = Date.now();
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO episodes
      (chat_key, user_id, who, day, occurred_at, summary, topics, source_message_ids, created_at, user_source)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of list) {
        // 模型偶尔把条目写成列表项（"what" 以 "- " 开头）或把 who 写成纯标点，
        // 这些噪声会原样进提示词。入口处统一清掉，别让它们一路漏到模型眼前。
        const strip = (v) => String(v ?? '').replace(/\s+/g, ' ')
          .replace(/^[-–—•*·:：,，、\s]+/, '').replace(/[-–—•*·:：,，、\s]+$/, '').trim();
        const summary = strip(e?.summary).slice(0, 200);
        if (!summary) continue;
        const occurredAt = toInt(e?.occurredAt, 0) || now;
        // ① 调用方已经解析好的（消息编号反查）—— 直接采信
        let userId = isQqNumber(e?.userId) ? String(e.userId).trim() : '';
        let userSource = userId ? String(e?.userSource || 'caller').slice(0, 20) : '';
        // ★ 机器人自己的事（who='我'）永远不绑人 —— 与 local-episodes 的 parse 同一口径，
        //   放在这里再挡一次（addMany 也可能被别处直接调用）。
        if (userId && String(e?.who || '').trim() === '我') { userId = ''; userSource = ''; }
        // ② 兜底解析器（本模块不碰消息库）
        if (!userId && typeof resolveUser === 'function') {
          try {
            const got = String(resolveUser(e) || '').trim();
            if (isQqNumber(got)) { userId = got; userSource = 'fallback'; }
          } catch { /* 解析失败就留空，不影响写入 */ }
        }
        const res = stmt.run(
          key,
          userId,
          strip(e?.who).slice(0, 40),
          localDay(occurredAt),
          occurredAt,
          summary,
          String(e?.topics ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
          Array.isArray(e?.sourceMessageIds) ? e.sourceMessageIds.slice(0, 20).map((x) => String(x)).join(',') : '',
          now,
          userSource
        );
        inserted += Number(res?.changes ?? 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
    return inserted;
  }

  /**
   * 修一条事件的身份（回填与纠错用）。
   * @returns {boolean} 是否真的改了
   */
  setUserId(id, userId, source = 'backfill') {
    const n = Number(id);
    const uid = String(userId ?? '').trim();
    if (!Number.isInteger(n) || n <= 0) return false;
    // ★ 空串 = **明确清空**（机器人自身的事件就该留空，回填脚本用它纠错）。
    //   非空则必须是合法 QQ 号 —— 绝不把 "abc" / "0" 写进去再当身份用。
    if (uid && !isQqNumber(uid)) return false;
    const res = this.db.prepare('UPDATE episodes SET user_id = ?, user_source = ? WHERE id = ?')
      .run(uid, String(source || '').slice(0, 20), n);
    return Number(res?.changes ?? 0) > 0;
  }

  /** 身份覆盖率统计（给控制台 / 回填脚本看"还差多少"）。 */
  identityStats(chatKey = '') {
    const key = String(chatKey || '').trim();
    const where = key ? 'WHERE chat_key = ?' : '';
    const args = key ? [key] : [];
    const row = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN user_id != '' THEN 1 ELSE 0 END) AS withId,
      SUM(CASE WHEN user_id = '' THEN 1 ELSE 0 END) AS withoutId
      FROM episodes ${where}`).get(...args);
    const bySource = {};
    try {
      for (const r of this.db.prepare(
        `SELECT user_source AS src, COUNT(*) AS n FROM episodes ${where} GROUP BY user_source`
      ).all(...args)) bySource[String(r.src || '')] = Number(r.n) || 0;
    } catch { /* 老库没有这一列 */ }
    const total = Number(row?.total) || 0;
    const withId = Number(row?.withId) || 0;
    return {
      total,
      withId,
      withoutId: Number(row?.withoutId) || 0,
      rate: total ? Math.round((withId / total) * 1000) / 1000 : 0,
      bySource
    };
  }

  /**
   * 按时间/人/关键词检索。
   * @param {object} o
   * @param {string} o.chatKey   必填 —— 事件记忆按会话隔离
   * @param {number} o.since     起始时间戳（含）
   * @param {number} o.until     结束时间戳（含）
   * @param {string} o.userId    只查这个人（可选）
   * @param {string} o.keyword   关键词，命中 summary 或 topics（可选，不区分大小写）
   * @param {number} o.limit
   */
  list({ chatKey, since = 0, until = 0, userId = '', keyword = '', limit = 20 } = {}) {
    const key = String(chatKey || '').trim();
    if (!key) return [];
    const where = ['chat_key = ?', 'occurred_at >= ?'];
    const args = [key, toInt(since, 0)];
    if (toInt(until, 0) > 0) { where.push('occurred_at <= ?'); args.push(toInt(until, 0)); }
    if (/^\d{1,15}$/.test(String(userId || '').trim())) { where.push('user_id = ?'); args.push(String(userId).trim()); }
    const kw = String(keyword || '').trim();
    if (kw) {
      where.push('(summary LIKE ? COLLATE NOCASE OR topics LIKE ? COLLATE NOCASE OR who LIKE ? COLLATE NOCASE)');
      const like = `%${kw}%`;
      args.push(like, like, like);
    }
    args.push(Math.min(200, Math.max(1, toInt(limit, 20))));
    return this.db.prepare(`SELECT * FROM episodes WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC LIMIT ?`).all(...args)
      .filter(row => localSourceVisible(String(row.chat_key || ''), key, String(row.user_id || '')))
      .map((row) => ({
      id: Number(row.id),
      chatKey: row.chat_key,
      userId: String(row.user_id || ''),
      who: String(row.who || ''),
      day: String(row.day || ''),
      occurredAt: Number(row.occurred_at) || 0,
      summary: String(row.summary || ''),
      topics: String(row.topics || ''),
      sourceMessageIds: String(row.source_message_ids || '')
    }));
  }

  /**
   * 生成注入提示词的【最近的事】。
   *
   * 挑法：先把"和本次相关群友有关"以及"机器人自己/全群的事"排在前面（user_id 为空视同全群），
   * 再用更早的事补满条数 —— 既不漏掉当下正在聊的人，也不至于把这个会话最近发生的事整段丢掉。
   */
  formatForPrompt(chatKey, { userIds = [], days = 30, maxItems = 12, maxChars = 2500 } = {}) {
    const key = String(chatKey || '').trim();
    if (!key) return '';
    const limit = Math.min(40, Math.max(1, toInt(maxItems, 12)));
    const since = Date.now() - Math.max(1, toInt(days, 30)) * DAY_MS;
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
      .map((x) => String(x ?? '').trim()).filter((x) => /^\d{1,15}$/.test(x)))].slice(0, 40);
    const placeholders = ids.map(() => '?').join(',');
    const rankSql = ids.length
      ? `CASE WHEN user_id = '' OR user_id IN (${placeholders}) THEN 0 ELSE 1 END`
      : "CASE WHEN user_id = '' THEN 0 ELSE 1 END";
    const rows = this.db.prepare(`SELECT * FROM episodes
      WHERE chat_key = ? AND occurred_at >= ?
      ORDER BY ${rankSql}, occurred_at DESC LIMIT ?`)
      .all(key, since, ...ids, limit)
      .filter(row => localSourceVisible(String(row.chat_key || ''), key, String(row.user_id || '')));
    if (!rows.length) return '';
    const lines = ['【最近的事】这些是你在这个会话里真实经历过的事（新的在上）：'];
    for (const row of rows) {
      const who = String(row.who || '').trim();
      const body = String(row.summary || '').trim();
      const text = who && !body.startsWith(who) ? `${who}：${body}` : body;
      lines.push(`- ${shortStamp(row.occurred_at)} ${text}`);
    }
    lines.push('用法：这些是过去真实发生过的事，可以顺着话头自然提起；但不要一次全倒出来，也不要说"根据我的记忆/记录"。');
    return lines.join('\n').slice(0, Math.max(200, toInt(maxChars, 2500)));
  }

  /** 整理游标：下次要处理哪些消息、上次整理到哪。 */
  state(chatKey) {
    const row = this.db.prepare('SELECT * FROM episode_state WHERE chat_key = ?').get(String(chatKey || '').trim());
    return {
      lastConsolidatedAt: Number(row?.last_consolidated_at) || 0,
      lastMessageId: Number(row?.last_message_id) || 0
    };
  }

  markConsolidated(chatKey, { at = Date.now(), lastMessageId = 0 } = {}) {
    const key = String(chatKey || '').trim();
    if (!key) return;
    const prev = this.state(key);
    this.db.prepare(`INSERT INTO episode_state (chat_key, last_consolidated_at, last_message_id, updated_at)
      VALUES (?,?,?,?)
      ON CONFLICT(chat_key) DO UPDATE SET
        last_consolidated_at = excluded.last_consolidated_at,
        last_message_id = MAX(episode_state.last_message_id, excluded.last_message_id),
        updated_at = excluded.updated_at`)
      .run(key, toInt(at, Date.now()), Math.max(prev.lastMessageId, toInt(lastMessageId, 0)), Date.now());
  }

  /**
   * 清理过期事件。返回删除条数。
   *
   * ★ 2026-10-27（用户决定）：**默认不再删除任何事件记忆**。
   *   理由：既然已经有向量检索层，"记忆保留多久"就不该再由作者写死的 45 天决定 ——
   *   一个像活人的 AI 应该记得很久，旧事自然靠检索相关性沉底，而不是被删掉。
   *   `retentionDays = 0`（或负数）⇒ 直接返回 0，**一条都不删**。
   *   仍然保留天数参数，是为了以后想临时收紧时不用改代码。
   */
  prune(retentionDays = 0) {
    const days = toInt(retentionDays, 0);
    if (!(days > 0)) return 0;                    // 0 / 负数 / 非法 ⇒ 永久保留
    const cutoff = Date.now() - days * DAY_MS;
    const res = this.db.prepare('DELETE FROM episodes WHERE occurred_at < ?').run(cutoff);
    return Number(res?.changes ?? 0);
  }

  /** 每个会话的事件聚合（给控制台的「事件记忆」页用）。 */
  chats() {
    return this.db.prepare(`SELECT chat_key AS chatKey, COUNT(*) AS count,
      MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest, MAX(created_at) AS updatedAt
      FROM episodes GROUP BY chat_key ORDER BY newest DESC`).all().map((row) => ({
      chatKey: String(row.chatKey || ''),
      count: Number(row.count) || 0,
      oldest: Number(row.oldest) || 0,
      newest: Number(row.newest) || 0,
      updatedAt: Number(row.updatedAt) || 0
    }));
  }

  stats(chatKey = '') {
    const key = String(chatKey || '').trim();
    if (key) {
      const row = this.db.prepare(`SELECT COUNT(*) AS n, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest
        FROM episodes WHERE chat_key = ?`).get(key);
      return { count: Number(row?.n) || 0, oldest: Number(row?.oldest) || 0, newest: Number(row?.newest) || 0 };
    }
    const row = this.db.prepare('SELECT COUNT(*) AS n, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest FROM episodes').get();
    return { count: Number(row?.n) || 0, oldest: Number(row?.oldest) || 0, newest: Number(row?.newest) || 0 };
  }

  /** 配置读取（集中在 config.js，避免各处各写一份默认值）。 */
  static options() {
    const o = getConfig()?.memory?.episodic || {};
    return {
      enabled: o.enabled !== false,
      consolidateMinIntervalMs: Math.max(60 * 1000, toInt(o.consolidateMinIntervalMs, 1800000)),
      minNewMessages: Math.max(1, toInt(o.minNewMessages, 20)),
      windowMaxMessages: Math.min(1000, Math.max(10, toInt(o.windowMaxMessages, 300))),
      windowMaxChars: Math.min(200000, Math.max(2000, toInt(o.windowMaxChars, 40000))),
      maxEventsPerRun: Math.min(60, Math.max(1, toInt(o.maxEventsPerRun, 20))),
      retentionDays: Math.max(0, toInt(o.retentionDays, 0)),
      backfillDays: Math.max(1, toInt(o.backfillDays, 30)),
      injectDays: Math.max(1, toInt(o.injectDays, 30)),
      injectMaxItems: Math.min(40, Math.max(1, toInt(o.injectMaxItems, 12))),
      injectMaxChars: Math.max(200, toInt(o.injectMaxChars, 2500))
    };
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
