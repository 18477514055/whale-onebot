// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 群打卡（签到）—— 每群独立、按天记名次、可查当天与近七天。
//
// ★★★ 三条硬约束（改之前先读，别改坏）：
//
//   ① **按群隔离是结构性的，不是靠提示词叮嘱**
//      每一条 SQL 都带 `chat_key = ?`。所有对外函数都**必须**传 chatKey，
//      且 chatKey 只能来自 ctx.chatKey（由 orchestrator 注入），参数里绝不出现群号。
//      ⇒ 模型物理上无法给 A 群记到 B 群头上。
//
//   ② **不主动进上下文**
//      本模块**不导出任何"生成提示词片段"的函数**，也**不被 prompt.js 引用**。
//      打卡清单只在模型主动调用工具时才会被读出来。
//      ⇒ "平时不占上下文"是结构性保证，不靠提示词自律。
//
//   ③ **同一人同一天只算一次**
//      主键 (chat_key, user_id, day)。重复打卡返回**原来那个名次**，
//      不会把名次往后推，也不会重复计数（否则名次会虚高、统计会翻倍）。
//
// ★ 名次 seq 的语义：**这一天在这个群里第几个打卡**（1 起）。
//   并发安全靠 `INSERT` 时现算 count —— 见 checkIn() 里的事务。

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB_NAME = 'checkin.sqlite';
const MAX_DAYS = 400;          // 单次查询最多回看多少天（防手滑传个 99999）
const DAY_MS = 86400000;

export function checkinDbPath(dataDir) {
  return path.join(String(dataDir || ''), DB_NAME);
}

/** 本地日期 YYYY-MM-DD（用系统本地时区，不用 UTC —— 否则晚上 8 点后会算成第二天）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 YYYY-MM-DD 往前推 n 天（跨月/跨年由 Date 自己处理，不做手工加减）。 */
function shiftDay(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(n || 0));
  return localDay(d.getTime());
}

/** 两个 YYYY-MM-DD 相差多少天（b - a）。 */
function dayDiff(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a || ''));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b || ''));
  if (!pa || !pb) return NaN;
  const ta = new Date(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3])).getTime();
  const tb = new Date(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3])).getTime();
  return Math.round((tb - ta) / DAY_MS);
}

// ── 打开 / 建表 ───────────────────────────────────────────────────────────
// ★ 每次调用都开、用完就关：工具调用是低频事件（一天几十次），
//   长期持有连接反而会跟"备份/清理"抢锁。WAL 让读写不互相阻塞。
function openDb(dataDir) {
  const file = checkinDbPath(dataDir);
  if (!file || !String(dataDir || '').trim()) throw new Error('打卡库路径未配置（缺少 dataDir）');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkins (
        chat_key  TEXT    NOT NULL,
        user_id   TEXT    NOT NULL,
        user_name TEXT    NOT NULL DEFAULT '',
        day       TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        at        INTEGER NOT NULL,
        PRIMARY KEY (chat_key, user_id, day)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkins_chat_day ON checkins (chat_key, day, seq)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_checkins_chat_user ON checkins (chat_key, user_id, day)');
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    throw error;
  }
  return db;
}

function requireChatKey(chatKey) {
  const key = String(chatKey || '').trim();
  // ★ 空 chatKey 绝不能放行：那会把所有群的打卡混成一份（正是用户要求避免的）。
  if (!key) throw new Error('缺少会话标识（chatKey），拒绝写入 —— 否则会把不同群的数据混在一起');
  return key;
}

function requireUserId(userId) {
  const id = String(userId ?? '').trim();
  if (!/^\d{4,15}$/.test(id)) throw new Error(`打卡需要明确的 QQ 号（收到：${id || '空'}）`);
  return id;
}

// ── 打卡 ──────────────────────────────────────────────────────────────────
/**
 * 记一次打卡。同一人同一天重复调用**不会**产生第二条，也不会改他的名次。
 *
 * @returns {{
 *   ok: true, day: string, seq: number, total: number,
 *   isRepeat: boolean, firstAt: number, userName: string,
 *   personTotalDays: number, personStreak: number
 * }}
 */
export function checkIn(dataDir, { chatKey, userId, userName = '', at = Date.now() } = {}) {
  const key = requireChatKey(chatKey);
  const uid = requireUserId(userId);
  const day = localDay(at);
  const ts = Number(at) || Date.now();
  const name = String(userName || '').trim().slice(0, 40);

  const db = openDb(dataDir);
  try {
    const existing = db.prepare(
      'SELECT seq, at, user_name FROM checkins WHERE chat_key = ? AND user_id = ? AND day = ?'
    ).get(key, uid, day);

    if (existing) {
      // ★ 重复打卡：返回原名次。user_name 只在原来为空时才补（不覆盖已有记录）。
      if (name && !String(existing.user_name || '').trim()) {
        db.prepare('UPDATE checkins SET user_name = ? WHERE chat_key = ? AND user_id = ? AND day = ?')
          .run(name, key, uid, day);
      }
      const total = Number(db.prepare(
        'SELECT COUNT(*) AS n FROM checkins WHERE chat_key = ? AND day = ?'
      ).get(key, day)?.n) || 0;
      const person = personTotals(db, key, uid, day);
      return {
        ok: true, day, seq: Number(existing.seq) || 0, total,
        isRepeat: true, firstAt: Number(existing.at) || ts, userName: name || String(existing.user_name || ''),
        ...person
      };
    }

    // ★ 名次在事务里现算，避免两个人同时打卡拿到同一个 seq。
    db.exec('BEGIN IMMEDIATE');
    let seq = 0;
    try {
      const n = Number(db.prepare(
        'SELECT COUNT(*) AS n FROM checkins WHERE chat_key = ? AND day = ?'
      ).get(key, day)?.n) || 0;
      seq = n + 1;
      db.prepare(
        'INSERT INTO checkins (chat_key, user_id, user_name, day, seq, at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(key, uid, name, day, seq, ts);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }

    const total = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM checkins WHERE chat_key = ? AND day = ?'
    ).get(key, day)?.n) || 0;
    const person = personTotals(db, key, uid, day);
    return { ok: true, day, seq, total, isRepeat: false, firstAt: ts, userName: name, ...person };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 这个人在本群一共打过几天卡、连续多少天（含今天）。 */
function personTotals(db, chatKey, userId, today) {
  const rows = db.prepare(
    'SELECT day FROM checkins WHERE chat_key = ? AND user_id = ? ORDER BY day DESC LIMIT ?'
  ).all(chatKey, userId, MAX_DAYS);
  const days = rows.map((r) => String(r.day));
  const personTotalDays = days.length;
  // 连续天数：从今天（或昨天，允许今天还没打）往前数
  let personStreak = 0;
  if (days.length) {
    const set = new Set(days);
    let cursor = set.has(today) ? today : shiftDay(today, -1);
    while (set.has(cursor)) {
      personStreak += 1;
      cursor = shiftDay(cursor, -1);
    }
  }
  return { personTotalDays, personStreak };
}

// ── 查询：某一天 ──────────────────────────────────────────────────────────
/** 某一天本群的打卡名单（按名次）。 */
export function dayBoard(dataDir, { chatKey, day = null, limit = 100 } = {}) {
  const key = requireChatKey(chatKey);
  const d = String(day || '').trim() || localDay();
  const cap = Math.min(500, Math.max(1, Number(limit) || 100));
  const db = openDb(dataDir);
  try {
    const rows = db.prepare(
      'SELECT user_id, user_name, seq, at FROM checkins WHERE chat_key = ? AND day = ? ORDER BY seq ASC LIMIT ?'
    ).all(key, d, cap);
    const total = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM checkins WHERE chat_key = ? AND day = ?'
    ).get(key, d)?.n) || 0;
    return {
      day: d,
      total,
      people: rows.map((r) => ({
        seq: Number(r.seq) || 0,
        userId: String(r.user_id),
        name: String(r.user_name || ''),
        at: Number(r.at) || 0
      }))
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ── 查询：近 N 天统计 ─────────────────────────────────────────────────────
/**
 * 近 N 天（含今天）的打卡统计。
 * @returns {{ from, to, days: Array<{day,count,people:[{userId,name,seq}]}>, summary: {...} }}
 */
export function recentStats(dataDir, { chatKey, days = 7, now = Date.now(), topN = 10 } = {}) {
  const key = requireChatKey(chatKey);
  const n = Math.min(MAX_DAYS, Math.max(1, Number(days) || 7));
  const today = localDay(now);
  const from = shiftDay(today, -(n - 1));

  const db = openDb(dataDir);
  try {
    const rows = db.prepare(
      'SELECT day, user_id, user_name, seq FROM checkins WHERE chat_key = ? AND day >= ? AND day <= ? ORDER BY day DESC, seq ASC'
    ).all(key, from, today);

    // 按天归组（缺的那天要补 0，否则"近七天"会看起来少几天）
    const byDay = new Map();
    for (let i = 0; i < n; i += 1) {
      const d = shiftDay(today, -i);
      byDay.set(d, []);
    }
    const perPerson = new Map();
    for (const r of rows) {
      const d = String(r.day);
      if (!byDay.has(d)) byDay.set(d, []);
      const person = {
        seq: Number(r.seq) || 0,
        userId: String(r.user_id),
        name: String(r.user_name || '')
      };
      byDay.get(d).push(person);
      const cur = perPerson.get(person.userId) || { userId: person.userId, name: person.name, days: 0, firstSeqs: [] };
      cur.days += 1;
      if (!cur.name && person.name) cur.name = person.name;
      perPerson.set(person.userId, cur);
    }

    const dayList = [...byDay.entries()].map(([day, people]) => ({
      day,
      count: people.length,
      people
    }));

    const totalCheckins = rows.length;
    const activeDays = dayList.filter((d) => d.count > 0).length;
    const ranked = [...perPerson.values()].sort((a, b) => b.days - a.days || a.userId.localeCompare(b.userId));

    // 今天还没人打卡时，"最佳"没意义 —— 如实给 0
    const best = dayList.reduce((acc, d) => (d.count > acc.count ? d : acc), { day: '', count: 0 });

    return {
      from,
      to: today,
      days: dayList,
      summary: {
        totalCheckins,
        activeDays,
        windowDays: n,
        distinctPeople: perPerson.size,
        averagePerActiveDay: activeDays ? Math.round((totalCheckins / activeDays) * 10) / 10 : 0,
        bestDay: best.count > 0 ? { day: best.day, count: best.count } : null,
        topPeople: ranked.slice(0, Math.min(50, Math.max(1, Number(topN) || 10))).map((p) => ({
          userId: p.userId, name: p.name, days: p.days
        }))
      }
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 某人近 N 天的打卡明细（他哪天打了、名次多少、断没断）。 */
export function personHistory(dataDir, { chatKey, userId, days = 7, now = Date.now() } = {}) {
  const key = requireChatKey(chatKey);
  const uid = requireUserId(userId);
  const n = Math.min(MAX_DAYS, Math.max(1, Number(days) || 7));
  const today = localDay(now);
  const from = shiftDay(today, -(n - 1));

  const db = openDb(dataDir);
  try {
    const rows = db.prepare(
      'SELECT day, seq, at FROM checkins WHERE chat_key = ? AND user_id = ? AND day >= ? AND day <= ? ORDER BY day DESC'
    ).all(key, uid, from, today);
    const map = new Map(rows.map((r) => [String(r.day), r]));
    const list = [];
    for (let i = 0; i < n; i += 1) {
      const d = shiftDay(today, -i);
      const hit = map.get(d);
      list.push({ day: d, checked: Boolean(hit), seq: hit ? Number(hit.seq) : 0, at: hit ? Number(hit.at) : 0 });
    }
    return { userId: uid, from, to: today, days: list, checkedDays: rows.length, ...personTotals(db, key, uid, today) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 概览：本群打卡库有没有数据、一共多少人多少天（给工具做"冷启动"判断）。 */
export function stats(dataDir, { chatKey } = {}) {
  const key = requireChatKey(chatKey);
  const db = openDb(dataDir);
  try {
    const row = db.prepare(
      'SELECT COUNT(*) AS total, COUNT(DISTINCT day) AS days, COUNT(DISTINCT user_id) AS people, MIN(day) AS firstDay, MAX(day) AS lastDay FROM checkins WHERE chat_key = ?'
    ).get(key) || {};
    return {
      total: Number(row.total) || 0,
      days: Number(row.days) || 0,
      people: Number(row.people) || 0,
      firstDay: row.firstDay ? String(row.firstDay) : '',
      lastDay: row.lastDay ? String(row.lastDay) : ''
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export { shiftDay, dayDiff, MAX_DAYS };
