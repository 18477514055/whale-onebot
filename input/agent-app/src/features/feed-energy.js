// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，作者原仓库从来没有过。
//   · 升级作者版本时它会被覆盖/删除（**必须从备份或私有仓库重新拷贝**）。
// Distribution source.
// [LOCAL-ONLY] ============================================================
// feed-energy.js —— 「投喂白饭」：群友 @机器人 喂一口饭，给它回一点精力。
//
// ═══════════════════════════════════════════════════════════════════
// ★★★ 参数为什么是这两个数（**改之前先读，用户原话定的**）
//
//   用户原话：
//     「让每个群友每天有两次或者三次投喂白饭的机会，可以让机器人加精力的。
//       他现在每天聊五六个小时就累了，这可不行。可以提供每天三次喂白饭的机会，
//       通过艾特他加一点白饭，不过要注意这个参数不要配太高，也不要配太低，
//       能够让他适当恢复精力就可以了。」
//     「一个群 2000 人活跃的也有 200 多，每个人投喂一次就直接爆掉了。加那么 0 点几左右。」
//     「通过我们已有的办法将受到单个群受到的精力偏移，通过整体成算到机器人的全局状态中。」
//
//   ⇒ 每次 **FEED_ENERGY = 0.3**（用户说的"0 点几"）
//   ⇒ 每人每天每群 **3 次**（用户说的"三次"）
//
// ★★★ 为什么"200 人各喂一次"不会把它爆掉 —— **靠的是结构，不是靠调参**
//
//   本模块**绝不直接改全局精力**，只加**本群局部偏移**（mood 表 `group:xxx` 行），
//   再交给 mood-engine 现成的双层模型折算：
//
//       最终精力 = 全局基础 + 本群偏移 × LOCAL_WEIGHT(0.6)
//
//   而本群偏移本身被 `mood-engine.nudgeMood` 硬夹在 **±LOCAL_CAP(25)** 内。
//   ⇒ **一个群最多只能给整体贡献 25 × 0.6 = +15 精力**，
//     不管这个群是 200 人还是 20000 人、喂 1 次还是 10000 次。
//   ⇒ 200 人各喂一次 = 60 偏移，**照样被夹到 25** ⇒ 最终精力 +15 封顶。
//     这正好是"适当恢复"的量级（基线 65 → 最高 80，不到满格 100）。
//
//   ★ 我最初还加过一个「整群每日总额」常量，**已删除** —— 它是多余的：
//     ① 结构上 LOCAL_CAP 已经封顶，再叠一层没有新增保护；
//     ② 实测那个值只允许每天 10 次，大群里绝大多数人根本轮不到喂，
//        直接违背"每个群友每天三次"的要求。**多余的常量会自己变成 bug。**
//
// ★ 三条硬约束（与 checkin.js 同款，别改坏）：
//   ① **按群隔离是结构性的**：主键 (chat_key, user_id, day)，每条 SQL 都带 chat_key。
//   ② **不主动进上下文**：本模块不导出任何提示词片段，也不被 prompt.js 引用。
//   ③ **同一人同群每天有配额**：超了就拒绝，且**不扣任何东西**（不惩罚、不转移）。

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB_NAME = 'feed-energy.sqlite';

/** ★ 每次投喂给「本群局部偏移」加多少（用户定：0.3）。 */
export const FEED_ENERGY = 0.3;

/** ★ 每人每天每群最多喂几次（用户定：3）。 */
export const FEED_PER_USER_PER_DAY = 3;

export function feedDbPath(dataDir) {
  return path.join(String(dataDir || ''), DB_NAME);
}

/** 本地日期 YYYY-MM-DD（用本机时区；别用 UTC，否则晚上 8 点后会算成第二天）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openDb(dataDir) {
  const file = feedDbPath(dataDir);
  if (!String(dataDir || '').trim()) throw new Error('投喂库路径未配置（缺少 dataDir）');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS feeds (
        chat_key  TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        user_name TEXT    NOT NULL DEFAULT '',
        day       TEXT    NOT NULL,
        n         INTEGER NOT NULL DEFAULT 0,
        at        INTEGER NOT NULL,
        PRIMARY KEY (chat_key, user_id, day)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_chat_day ON feeds (chat_key, day)');
    db.exec(`CREATE TABLE IF NOT EXISTS feed_receipts (
      chat_key TEXT NOT NULL, user_id TEXT NOT NULL, source_id TEXT NOT NULL,
      day TEXT NOT NULL, PRIMARY KEY (chat_key, user_id, source_id)
    )`);
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    throw error;
  }
  return db;
}

function requireChatKey(chatKey) {
  const k = String(chatKey || '').trim();
  if (!k) throw new Error('缺少 chatKey（必须由 orchestrator 注入，不能由模型提供）');
  return k;
}

function requireUserId(userId) {
  const u = String(userId || '').trim();
  if (!/^\d{4,15}$/.test(u)) throw new Error(`userId 不合法：${u}`);
  return u;
}

/**
 * 查某人今天在这个群还能喂几次（不写库）。
 * @returns {{day:string, used:number, left:number, cap:number}}
 */
export function feedQuota(dataDir, { chatKey, userId, at = Date.now() } = {}) {
  const key = requireChatKey(chatKey);
  const uid = requireUserId(userId);
  const day = localDay(at);
  const db = openDb(dataDir);
  try {
    const mine = db.prepare('SELECT n FROM feeds WHERE chat_key = ? AND user_id = ? AND day = ?').get(key, uid, day);
    const used = Number(mine?.n) || 0;
    return { day, used, left: Math.max(0, FEED_PER_USER_PER_DAY - used), cap: FEED_PER_USER_PER_DAY };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 投喂一次（只记账 + 配额，**不碰精力**；精力由调用方交给 mood-engine）。
 * ★ 返回里**不含精力数值** —— 免得模型拿数字做文章，
 *   也免得群里变成"我的投喂转化率是多少"。
 *
 * @returns {{ok:boolean, reason?:string, day:string, used:number, left:number, energyGain:number}}
 *   energyGain = 这次应加给「本群局部偏移」的量（不是最终精力）
 */
export function feedEnergy(dataDir, { chatKey, userId, userName = '', sourceId = '', at = Date.now() } = {}) {
  const key = requireChatKey(chatKey);
  const uid = requireUserId(userId);
  const day = localDay(at);
  const ts = Number(at) || Date.now();
  const name = String(userName || '').trim().slice(0, 40);

  const db = openDb(dataDir);
  try {
    // ★ 名额在**同一个事务**里现算现写，避免两人同时喂拿到同一个名额。
    db.exec('BEGIN IMMEDIATE');
    try {
      const mine = db.prepare('SELECT n, user_name FROM feeds WHERE chat_key = ? AND user_id = ? AND day = ?').get(key, uid, day);
      const used = Number(mine?.n) || 0;
      const source = String(sourceId || '').slice(0, 120);
      if (source && db.prepare('SELECT 1 FROM feed_receipts WHERE chat_key=? AND user_id=? AND source_id=?').get(key, uid, source)) {
        db.exec('ROLLBACK');
        return { ok: true, duplicate: true, day, used, left: Math.max(0, FEED_PER_USER_PER_DAY - used), energyGain: 0 };
      }

      if (used >= FEED_PER_USER_PER_DAY) {
        db.exec('ROLLBACK');
        return {
          ok: false,
          reason: `今天在这个群已经喂过 ${used} 次了（每人每天最多 ${FEED_PER_USER_PER_DAY} 次）。`,
          day, used, left: 0, energyGain: 0
        };
      }

      if (mine) {
        db.prepare('UPDATE feeds SET n = n + 1, at = ?, user_name = ? WHERE chat_key = ? AND user_id = ? AND day = ?')
          .run(ts, name || String(mine.user_name || ''), key, uid, day);
      } else {
        db.prepare('INSERT INTO feeds (chat_key, user_id, user_name, day, n, at) VALUES (?,?,?,?,1,?)')
          .run(key, uid, name, day, ts);
      }
      if (source) db.prepare('INSERT INTO feed_receipts (chat_key,user_id,source_id,day) VALUES (?,?,?,?)').run(key, uid, source, day);
      db.exec('COMMIT');
      return { ok: true, day, used: used + 1, left: Math.max(0, FEED_PER_USER_PER_DAY - (used + 1)), energyGain: FEED_ENERGY };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Read-only console snapshot. A never-used feed feature must not create a DB. */
export function feedStatus(dataDir, { chatKey = '', userId = '', at = Date.now(), limit = 20 } = {}) {
  const day = localDay(at);
  const key = String(chatKey || '').trim();
  const uid = String(userId || '').trim();
  if (key && !/^(group|private):\d+$/.test(key)) throw new Error('chatKey 形态不合法');
  if (uid) requireUserId(uid);
  const quota = key && uid ? { day, used: 0, left: FEED_PER_USER_PER_DAY, cap: FEED_PER_USER_PER_DAY } : null;
  const result = { day, cap: FEED_PER_USER_PER_DAY, energyGain: FEED_ENERGY,
    board: { day, totalFeeds: 0, people: [] }, quota, mood: null };
  const file = feedDbPath(dataDir);
  if (!String(dataDir || '').trim() || !fs.existsSync(file)) return result;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const where = key ? 'day = ? AND chat_key = ?' : 'day = ?';
    const values = key ? [day, key] : [day];
    result.board.totalFeeds = Number(db.prepare(`SELECT SUM(n) AS n FROM feeds WHERE ${where}`).get(...values)?.n) || 0;
    const rows = db.prepare(`SELECT user_id, MAX(user_name) AS user_name, SUM(n) AS n
      FROM feeds WHERE ${where} GROUP BY user_id ORDER BY n DESC, user_id ASC LIMIT ?`)
      .all(...values, Math.max(1, Math.min(200, Number(limit) || 20)));
    result.board.people = rows.map(r => ({ userId: String(r.user_id), name: String(r.user_name || ''), times: Number(r.n) || 0 }));
    if (quota) {
      quota.used = Number(db.prepare('SELECT n FROM feeds WHERE chat_key = ? AND user_id = ? AND day = ?').get(key, uid, day)?.n) || 0;
      quota.left = Math.max(0, FEED_PER_USER_PER_DAY - quota.used);
    }
    return result;
  } finally { db.close(); }
}

/** 本群今天的投喂概况（给"谁喂了"这类问题用；不主动进上下文）。 */
export function feedBoard(dataDir, { chatKey, day = null, limit = 20 } = {}) {
  const key = requireChatKey(chatKey);
  const d = day || localDay();
  const db = openDb(dataDir);
  try {
    const rows = db.prepare(
      'SELECT user_id, user_name, n, at FROM feeds WHERE chat_key = ? AND day = ? ORDER BY n DESC, at ASC LIMIT ?'
    ).all(key, d, Math.max(1, Math.min(200, Number(limit) || 20)));
    const total = Number(db.prepare('SELECT SUM(n) AS n FROM feeds WHERE chat_key = ? AND day = ?').get(key, d)?.n) || 0;
    return {
      day: d,
      totalFeeds: total,
      people: rows.map((r) => ({ userId: String(r.user_id), name: String(r.user_name || ''), times: Number(r.n) || 0 }))
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
