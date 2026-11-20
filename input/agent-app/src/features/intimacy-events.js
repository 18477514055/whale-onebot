// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 亲密度事件层（2026-10-29）
//
// ★ 为什么加这一层：
//   原来的亲密度（features/intimacy.js）是**纯统计**的 —— 发言量、活跃天数、@次数、
//   会话数、互动回合，五个维度全是"你做了多少事"。它算得准，但**没有"发生了什么"**：
//   · 一个天天在群里吵架的人，发言量和活跃天数都很高 ⇒ 分数很高；
//   · 一个只在关键时刻帮过一次忙的人，分数很低。
//   ⇒ 用户要的是"让模型主动去给每个人打分、设置负面/正面/中性事件"。
//
// ★ 设计要点（改之前先读）：
//
//   ① **事件是模型写的，评分是代码算的。**
//      模型负责"发生了什么"（判定 + 描述），**不负责**最终分数。
//      ⇒ 模型不能用"我觉得他很好"直接给 +50，只能落一条事件；
//        同一条事件按**类型表**折算成固定的分，模型改不了折算规则。
//      这是为了防"模型心情好就全员满分"。
//
//   ② **衰减**：事件有半衰期。三个月前的一次争吵不应该和昨天的一样重。
//      同一类型的事件权重按 `exp(-天数/半衰期)` 衰减，最后求和再压到 [-1,1]。
//
//   ③ **按人，不按群**（与作者口径一致）：同一个人的事件在任何群都算数，
//      但**事件本身记在发生它的群里**（保留"在哪发生的"）。
//
//   ④ **不主动进上下文**：本模块不导出任何"生成提示词片段"的函数。
//      模型只在主动调用工具时读到事件摘要。
//
//   ⑤ **分群隔离（读侧）**：`personSummary()` 支持按 chatKey 过滤 —— 只数"在这个群里发生的事件"，
//      用于群内榜；但 `overallScore()` 是全库口径（跨群一致的亲密度）。
//      两者分开，避免"换个群分数就变"。

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB_NAME = 'intimacy-events.sqlite';

// ── 事件类型表（唯一的折算真源）─────────────────────────────────────────────
// weight 是「一次这种事件值多少分」（最终会累加后压到 -1..1）。
// ★ 加新类型只能往这里加，不要在别处写死数字 —— 否则"模型怎么算"就不唯一了。
export const EVENT_KINDS = {
  // ── 正面 ────────────────────────────────────────────────────────────
  help:        { weight: 3.0,  label: '帮忙/解决问题', tone: 'good' },
  care:        { weight: 2.5,  label: '关心机器人或群友', tone: 'good' },
  humor:       { weight: 1.5,  label: '一起玩梗/玩笑', tone: 'good' },
  share:       { weight: 1.2,  label: '分享有价值的东西', tone: 'good' },
  praise:      { weight: 1.5,  label: '夸奖或感谢', tone: 'good' },
  deep_talk:   { weight: 2.8,  label: '深入聊天/谈心', tone: 'good' },
  defend:      { weight: 4.0,  label: '维护机器人或群友', tone: 'good' },
  // ── 负面 ────────────────────────────────────────────────────────────
  insult:      { weight: -4.0, label: '辱骂/人身攻击', tone: 'bad' },
  harass:      { weight: -5.0, label: '骚扰/纠缠', tone: 'bad' },
  spam:        { weight: -1.5, label: '刷屏/灌水', tone: 'bad' },
  troll:       { weight: -2.5, label: '恶意挑事', tone: 'bad' },
  annoy:       { weight: -1.2, label: '反复拍打/打扰', tone: 'bad' },
  ignore:      { weight: -0.8, label: '问它却不理会', tone: 'bad' },
  politics:    { weight: -2.0, label: '引战/敏感话题', tone: 'bad' },
  // ── 中性（记下来但不计分，用于画像与去重）─────────────────────────────
  chat:        { weight: 0,    label: '普通聊天', tone: 'neutral' },
  greet:       { weight: 0,    label: '打招呼', tone: 'neutral' },
  question:    { weight: 0,    label: '问了个问题', tone: 'neutral' },
  met:         { weight: 0,    label: '第一次见', tone: 'neutral' }
};

/** 半衰期（天）：一次事件的分量按指数衰减，这个值越大衰减越慢。 */
export const HALF_LIFE_DAYS = 60;

/** 事件分归一化后的上限（压到 [-1, 1]，避免刷分）。 */
const RAW_CAP = 30;
const DAY_MS = 86400000;

export function intimacyEventDbPath(dataDir) {
  return path.join(String(dataDir || ''), DB_NAME);
}

function openDb(dataDir) {
  const file = intimacyEventDbPath(dataDir);
  if (!file || !String(dataDir || '').trim()) throw new Error('亲密度事件库路径未配置（缺少 dataDir）');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        uin       TEXT NOT NULL,            -- 涉及的人（QQ 号）
        chat_key  TEXT NOT NULL,            -- 在哪发生的
        kind      TEXT NOT NULL,            -- EVENT_KINDS 的键
        weight    REAL NOT NULL,            -- 落库时的折算分（快照，便于以后改表不影响历史）
        note      TEXT NOT NULL DEFAULT '', -- 模型写的一句话描述
        ts        INTEGER NOT NULL,
        day       TEXT NOT NULL,
        dedupe    TEXT NOT NULL DEFAULT ''  -- 去重键（同人同群同类同天只算一次时用）
      );
      CREATE INDEX IF NOT EXISTS idx_ev_uin  ON events(uin);
      CREATE INDEX IF NOT EXISTS idx_ev_chat ON events(chat_key);
      CREATE INDEX IF NOT EXISTS idx_ev_ts   ON events(ts);
      -- ★ 必须是**普通**唯一索引，不能带 WHERE 条件：
      --   实测（本机 node:sqlite）带 WHERE 的「部分索引」不能当 ON CONFLICT 的目标，
      --   会报 "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"。
      --   去重键为空时本来就该允许重复（调用方传 dedupeKey:'' 表示"这条不用去重"），
      --   所以空串统一存成一个唯一值（用 id 兜底），见 recordEvent()。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ev_dedupe ON events(dedupe);
    `);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* ignore */ }
    throw error;
  }
}

/** 本地日期（东八区口径与 intimacy.js 的 dayOf 一致，别用 UTC）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * 记一条事件。
 * @param {string} dataDir
 * @param {{uin:string, chatKey:string, kind:string, note?:string, ts?:number, dedupeKey?:string}} e
 * @returns {{ok:boolean, id?:number, weight?:number, duplicate?:boolean, error?:string}}
 */
export function recordEvent(dataDir, e = {}) {
  const uin = String(e.uin ?? '').trim();
  const chatKey = String(e.chatKey ?? '').trim();
  const kind = String(e.kind ?? '').trim();
  const meta = EVENT_KINDS[kind];
  if (!uin || !/^\d{5,15}$/.test(uin)) return { ok: false, error: '不是有效的 QQ 号' };
  if (!chatKey) return { ok: false, error: '缺少会话标识（必须由宿主提供，不能手填）' };
  if (!meta) return { ok: false, error: `未知事件类型「${kind}」；可用：${Object.keys(EVENT_KINDS).join(' / ')}` };

  const ts = Number(e.ts) || Date.now();
  const day = localDay(ts);
  const note = String(e.note ?? '').trim().slice(0, 200);
  // 去重键：默认「同人+同群+同类+同一天」只算一次。
  // ★ 中性事件也去重，避免"普通聊天"一天几百条把表撑爆。
  // ★ 空 dedupeKey（= 调用方明确要求"这条不去重"）必须仍能插入 ——
  //   但 idx_ev_dedupe 是普通唯一索引，两条空串会撞。
  //   所以空的时候补一个随机段，保证唯一。见 _schema 里的注释。
  const rawDedupe = String(e.dedupeKey ?? '').trim();
  const dedupe = rawDedupe
    ? rawDedupe
    : (e.noDedupe === true
      ? `~${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : `${uin}|${chatKey}|${kind}|${day}`);

  const db = openDb(dataDir);
  try {
    const stmt = db.prepare(`
      INSERT INTO events (uin, chat_key, kind, weight, note, ts, day, dedupe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe) DO NOTHING
    `);
    const r = stmt.run(uin, chatKey, kind, meta.weight, note, ts, day, dedupe);
    const changed = Number(r?.changes) || 0;
    if (!changed) return { ok: true, duplicate: true, weight: meta.weight };
    return { ok: true, id: Number(r?.lastInsertRowid) || 0, weight: meta.weight };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 衰减系数：越久远越小。 */
function decay(ts, now = Date.now()) {
  const days = Math.max(0, (now - Number(ts)) / DAY_MS);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/**
 * 算出某个人的「事件分」（-1..1）。
 * @param {string} dataDir
 * @param {string} uin
 * @param {{chatKey?:string, now?:number}} opts chatKey 给了就只数该群内的事件
 */
export function eventScore(dataDir, uin, { chatKey = '', now = Date.now() } = {}) {
  const key = String(uin ?? '').trim();
  if (!key) return { score: 0, raw: 0, count: 0, byKind: {} };
  const db = openDb(dataDir);
  try {
    const wantChat = String(chatKey || '').trim();
    const rows = wantChat
      ? db.prepare('SELECT kind, weight, ts FROM events WHERE uin = ? AND chat_key = ?').all(key, wantChat)
      : db.prepare('SELECT kind, weight, ts FROM events WHERE uin = ?').all(key);

    let raw = 0;
    const byKind = {};
    for (const r of rows) {
      const w = Number(r.weight) || 0;
      const d = decay(r.ts, now);
      raw += w * d;
      const k = String(r.kind);
      byKind[k] = (byKind[k] || 0) + w * d;
    }
    // 压到 [-1,1]：RAW_CAP 之内线性，超出饱和（防刷分）
    const score = Math.max(-1, Math.min(1, raw / RAW_CAP));
    // byKind 也四舍五入，便于展示
    for (const k of Object.keys(byKind)) byKind[k] = Math.round(byKind[k] * 100) / 100;
    return { score: Math.round(score * 1000) / 1000, raw: Math.round(raw * 100) / 100, count: rows.length, byKind };
  } catch {
    return { score: 0, raw: 0, count: 0, byKind: {} };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 某人的事件清单（最近 N 条，新到旧）。
 * @param {{chatKey?:string, limit?:number}} opts
 */
export function listEvents(dataDir, uin, { chatKey = '', limit = 20 } = {}) {
  const key = String(uin ?? '').trim();
  if (!key) return [];
  const db = openDb(dataDir);
  try {
    const n = Math.max(1, Math.min(200, Number(limit) || 20));
    const wantChat = String(chatKey || '').trim();
    const rows = wantChat
      ? db.prepare('SELECT id, uin, chat_key AS chatKey, kind, weight, note, ts, day FROM events WHERE uin = ? AND chat_key = ? ORDER BY ts DESC LIMIT ?').all(key, wantChat, n)
      : db.prepare('SELECT id, uin, chat_key AS chatKey, kind, weight, note, ts, day FROM events WHERE uin = ? ORDER BY ts DESC LIMIT ?').all(key, n);
    return rows.map((r) => ({
      id: Number(r.id),
      uin: String(r.uin),
      chatKey: String(r.chatKey),
      kind: String(r.kind),
      label: EVENT_KINDS[r.kind]?.label || String(r.kind),
      tone: EVENT_KINDS[r.kind]?.tone || 'neutral',
      weight: Number(r.weight) || 0,
      note: String(r.note || ''),
      ts: Number(r.ts),
      day: String(r.day)
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 全局统计：一共记了多少条、按类型分布（给管理界面用）。 */
export function eventStats(dataDir, { chatKey = '' } = {}) {
  const db = openDb(dataDir);
  try {
    const wantChat = String(chatKey || '').trim();
    const rows = wantChat
      ? db.prepare('SELECT kind, COUNT(*) AS n FROM events WHERE chat_key = ? GROUP BY kind').all(wantChat)
      : db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all();
    const byKind = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n) || 0;
      byKind[String(r.kind)] = n;
      total += n;
    }
    const people = wantChat
      ? Number(db.prepare('SELECT COUNT(DISTINCT uin) AS n FROM events WHERE chat_key = ?').get(wantChat)?.n) || 0
      : Number(db.prepare('SELECT COUNT(DISTINCT uin) AS n FROM events').get()?.n) || 0;
    return { total, people, byKind };
  } catch {
    return { total: 0, people: 0, byKind: {} };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
