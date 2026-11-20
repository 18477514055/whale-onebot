// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// ═══════════════════════════════════════════════════════════════════════
// qq-resolver.js —— **统一身份解析层**（2026-10-29）
//
// ★★★ 为什么必须单独一层，以及它的唯一职责：
//
//   用户定下的规矩（原话）：
//     「我们保存的所有资料都严格按照QQ号去绑定，而不是昵称，
//       昵称只有在真正聊天的时候才需要替换，并且有些人在不同的群名称不一样，
//       有些人会改昵称，只有QQ号是唯一识别身份。」
//
//   这句话定义了两件事，必须分清：
//     ① **存储侧** 一律用 QQ 号做键 —— 昵称只是"某一刻某个群里的显示名"，不是身份；
//     ② **展示侧** 才把 QQ 号换成昵称 —— 而且要用**当前这个会话里**的昵称。
//
//   本模块只做①②之间的**单向翻译**：
//     昵称 ──(本模块)──> QQ 号        ← 落库前解析
//     QQ 号 ──(本模块)──> 昵称        ← 渲染时反查
//
// ★★★ 铁律：**宁缺勿错**
// Distribution source.
//   有 3 个不同 QQ），**绝不能猜**。命中多个不同 QQ 一律返回 null，
//   让调用方保持空 user_id —— 空白比如错人好得多：
//   错人会把"张三的坏事"记到"李四"头上，而且再也分不开。
//
// ★ 三条解析路径（按可靠性从高到低，实测覆盖率见括号）：
//   ① **消息编号反查**（最可靠，100%）：episodes.source_message_ids 存的就是 messages.id，
//      回查 messages 直接拿到 sender_id —— 昵称怎么改都不影响。
//   ② **本群别名表**（identity_aliases，上游已有 577 条）：uin + chat_key + alias，
//      这正是"同一个人在不同群不同昵称"的正解。
//   ③ **本群消息里的 sender_name**：兜底，仍是本群口径。
//   ★ 绝不做**全局**昵称匹配 —— 那是跨群张冠李戴的唯一来源。
//
// ★ 零 LLM、零网络：全部是本地 SQLite 只读查询 + 内存缓存。
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 合法 QQ 号：5~15 位纯数字，且不能是 0（实测库里混着 uid=0 / uid=563 / uid=123456）。 */
export function isQqNumber(value) {
  const s = String(value ?? '').trim();
  return /^\d{5,15}$/.test(s) && !/^0+$/.test(s);
}

/** 本进程内的解析缓存：解析是幂等的，而提示词/整理一秒钟能问几十次。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 4000;
const nameCache = new Map();      // `${chatKey}\u0000${name}` → { uin, via, at }
const displayCache = new Map();   // `${chatKey}\u0000${uin}` → { name, at }

function cacheGet(map, key, now) {
  const hit = map.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) { map.delete(key); return null; }
  return hit;
}
function cacheSet(map, key, value, now) {
  if (map.size >= CACHE_MAX) {
    // 最简单的淘汰：清掉最早的一批（这里不是热点缓存，清空也不影响正确性）
    let i = 0;
    for (const k of map.keys()) { map.delete(k); if (++i >= Math.floor(CACHE_MAX / 4)) break; }
  }
  map.set(key, { ...value, at: now });
}
/** 清空缓存（验收脚本与"人名刚变"时需要）。 */
export function clearResolveCache() {
  nameCache.clear();
  displayCache.clear();
}

// ── 只读连接（惰性、复用）──────────────────────────────────────────────
const conns = new Map();
function openReadOnly(file, tag) {
  if (!file || !fs.existsSync(file)) return null;
  const key = `${tag}\u0000${file}`;
  if (conns.has(key)) return conns.get(key);
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    // busy_timeout：机器人正在写这个库时，读一侧不要立刻报 SQLITE_BUSY
    try { db.exec('PRAGMA busy_timeout=2000'); } catch { /* 只读连接可能不允许，忽略 */ }
  } catch {
    db = null;
  }
  conns.set(key, db);
  return db;
}

/** 关掉所有只读连接（验收脚本收尾用；正常运行不需要）。 */
export function closeResolver() {
  for (const db of conns.values()) {
    try { db?.close(); } catch { /* ignore */ }
  }
  conns.clear();
  clearResolveCache();
}

/**
 * 一次性解析出「这个会话里，某个昵称对应哪个 QQ」。
 *
 * @param {object} o
 * @param {string} o.chatKey       会话键（group:xxx / private:xxx）—— 必填，按群解析
 * @param {string} o.name          昵称/群名片（模型写的、或消息里的 sender_name）
 * @param {string} o.messagesDbPath
 * @param {string} [o.identityDbPath]  identity-pilot.sqlite（别名表，可缺）
 * @returns {{uin:string, via:string}|null} null = 找不到或**有歧义**（宁缺勿错）
 */
export function resolveByName({ chatKey, name, messagesDbPath, identityDbPath = '' } = {}) {
  const key = String(chatKey || '').trim();
  const raw = String(name || '').replace(/\s+/g, ' ').trim();
  if (!key || !raw) return null;
  // 已经就是 QQ 号：直接用
  if (isQqNumber(raw)) return { uin: raw, via: 'literal' };

  const now = Date.now();
  const ck = `${key}\u0000${raw}`;
  const cached = cacheGet(nameCache, ck, now);
  if (cached) return cached.uin ? { uin: cached.uin, via: cached.via } : null;

  const only = (rows, field) => {
    const ids = [...new Set((rows || []).map((r) => String(r[field] ?? '').trim()).filter(isQqNumber))];
    return ids.length === 1 ? ids[0] : '';
  };

  let uin = '';
  let via = '';

  // ① 本群别名表（最贴"同一个人的不同昵称"）
  if (!uin && identityDbPath) {
    const idb = openReadOnly(identityDbPath, 'identity');
    if (idb) {
      try {
        const rows = idb.prepare(
          'SELECT DISTINCT uin FROM identity_aliases WHERE chat_key = ? AND alias = ?'
        ).all(key, raw);
        uin = only(rows, 'uin');
        if (uin) via = 'alias';
      } catch { /* 老库没这张表就算了，继续走下面 */ }
    }
  }

  // ② 本群消息的 sender_name（兜底，仍是本群口径）
  if (!uin && messagesDbPath) {
    const mdb = openReadOnly(messagesDbPath, 'messages');
    if (mdb) {
      try {
        const rows = mdb.prepare(
          "SELECT DISTINCT sender_id AS uin FROM messages WHERE chat_key = ? AND self = 0 AND sender_name = ?"
        ).all(key, raw);
        uin = only(rows, 'uin');
        if (uin) via = 'messages';
      } catch { /* ignore */ }
    }
  }

  // ③ **弱匹配**：本群昵称前缀（"陈黛华" → "陈黛华师姐"）。
  //    ★ 只在精确命中失败时用，且必须**全群唯一**才接受。
  //    这条与 store.memberByName 同口径（那边也是精确优先、前缀兜底、多命中返回 null）。
  if (!uin && messagesDbPath && raw.length >= 2) {
    const mdb = openReadOnly(messagesDbPath, 'messages');
    if (mdb) {
      try {
        const rows = mdb.prepare(
          "SELECT DISTINCT sender_id AS uin FROM messages WHERE chat_key = ? AND self = 0 AND sender_name LIKE ?"
        ).all(key, `${raw}%`);
        uin = only(rows, 'uin');
        if (uin) via = 'prefix';
      } catch { /* ignore */ }
    }
  }

  cacheSet(nameCache, ck, { uin: uin || '', via: via || '' }, now);
  return uin ? { uin, via } : null;
}

/**
 * 从一组消息编号反查"这条事件涉及的 QQ 号"。
 *
 * ★ 这是**最可靠**的一条路（100%），因为 source_message_ids 存的就是 messages.id。
 * ★ 但一条事件常常跨多人（实测 1009 条里 297 条如此）：
 *   这时如果给了 `who`，就在这几个说话人里按名字挑；挑不出唯一的人就返回空。
 *
 * @param {object} o
 * @param {string} o.chatKey
 * @param {(string|number)[]} o.ids
 * @param {string} o.messagesDbPath
 * @param {string} [o.who]         事件里写的名字（用来在多说话人里消歧）
 * @param {Map<string,object>} [o.byId]  调用方已经查到的 id→消息缓存（可选，避免重复查）
 * @returns {{uin:string, via:string, self:boolean}|null}
 */
export function resolveByMessageIds({ chatKey, ids = [], messagesDbPath, who = '', byId = null } = {}) {
  const key = String(chatKey || '').trim();
  if (!key || !Array.isArray(ids) || !ids.length) return null;
  const mdb = byId ? null : openReadOnly(messagesDbPath, 'messages');
  if (!byId && !mdb) return null;

  const senders = new Map();   // uin → 该 uin 在这批消息里的名字集合
  let sawSelf = false;
  for (const raw of ids) {
    const id = Number(String(raw ?? '').replace(/^#+/, '').trim());
    if (!Number.isInteger(id) || id <= 0) continue;
    let m = byId ? byId.get(String(id)) : null;
    if (!m) {
      try {
        m = mdb.prepare('SELECT sender_id, sender_name, self FROM messages WHERE chat_key = ? AND id = ?')
          .get(key, id);
      } catch { m = null; }
    }
    if (!m) continue;
    if (Number(m.self)) { sawSelf = true; continue; }
    const uin = String(m.sender_id ?? '').trim();
    if (!isQqNumber(uin)) continue;
    if (!senders.has(uin)) senders.set(uin, new Set());
    const nm = String(m.sender_name ?? '').replace(/\s+/g, ' ').trim();
    if (nm) senders.get(uin).add(nm);
  }

  if (!senders.size) return sawSelf ? { uin: '', via: 'self', self: true } : null;
  if (senders.size === 1) return { uin: [...senders.keys()][0], via: 'message-id', self: false };

  // 多个说话人：只接受"who 唯一命中其中一个人的名字"这一确定性判据
  const want = String(who || '').replace(/\s+/g, ' ').trim();
  if (want) {
    const hits = [...senders.entries()].filter(([, names]) => names.has(want)).map(([uin]) => uin);
    if (hits.length === 1) return { uin: hits[0], via: 'message-id+who', self: false };
  }
  // 多人都对得上（或都对不上）⇒ 不猜
  return null;
}

/**
 * QQ 号 → **当前这个会话里的昵称**（展示侧唯一入口）。
 *
 * ★ 为什么必须按会话：同一个人在不同群名字不一样（实测「陈黛华」在
 *
 *   拿别群的昵称在当前群喊人，等于叫错名字。
 * ★ 顺序：本群最近一条消息的 sender_name → 身份库 primary_name → QQ 号本身。
 *
 * @returns {string} 永远返回非空串（最差就是 QQ 号本身）
 */
export function displayNameFor({ uin, chatKey, messagesDbPath, identityDbPath = '', notes = null }) {
  const uid = String(uin || '').trim();
  if (!uid) return '';
  // ★ 人工备注优先级最高（作者 core/display-name.js 同一口径）：用户明确写的称呼不该被群名片盖掉
  const note = notes ? String(notes[uid] || '').trim() : '';
  if (note) return note;

  const key = String(chatKey || '').trim();
  const now = Date.now();
  const ck = `${key}\u0000${uid}`;
  const cached = cacheGet(displayCache, ck, now);
  if (cached) return cached.name || uid;

  let name = '';
  if (key && messagesDbPath) {
    const mdb = openReadOnly(messagesDbPath, 'messages');
    if (mdb) {
      try {
        const row = mdb.prepare(
          `SELECT sender_name FROM messages WHERE chat_key = ? AND sender_id = ? AND self = 0
           ORDER BY ts DESC, id DESC LIMIT 1`
        ).get(key, uid);
        name = String(row?.sender_name ?? '').replace(/\s+/g, ' ').trim();
      } catch { /* ignore */ }
    }
  }
  if (!name && identityDbPath) {
    const idb = openReadOnly(identityDbPath, 'identity');
    if (idb) {
      try {
        const row = idb.prepare('SELECT primary_name FROM people WHERE uin = ?').get(uid);
        name = String(row?.primary_name ?? '').replace(/\s+/g, ' ').trim();
      } catch { /* ignore */ }
    }
  }
  if (!name) name = uid;
  cacheSet(displayCache, ck, { name }, now);
  return name;
}

/**
 * 这个 QQ 号在**当前会话里**用过的所有昵称（改过名的人会多于一个）。
 * 用途：判断"这条事件里的 who 是不是换了名字的同一个人"、以及给模型看别名。
 *
 * @returns {string[]} 最近使用优先
 */
export function aliasNamesFor({ uin, chatKey, messagesDbPath, identityDbPath = '', limit = 5 } = {}) {
  const uid = String(uin || '').trim();
  const key = String(chatKey || '').trim();
  if (!isQqNumber(uid)) return [];
  const out = [];
  const push = (v) => {
    const s = String(v || '').replace(/\s+/g, ' ').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (identityDbPath) {
    const idb = openReadOnly(identityDbPath, 'identity');
    if (idb) {
      try {
        for (const r of idb.prepare(
          `SELECT alias FROM identity_aliases WHERE uin = ? AND chat_key = ?
           ORDER BY last_seen_at DESC LIMIT ?`
        ).all(uid, key, Math.max(1, Math.min(20, Number(limit) || 5)))) push(r.alias);
      } catch { /* ignore */ }
    }
  }
  if (messagesDbPath && out.length < limit) {
    const mdb = openReadOnly(messagesDbPath, 'messages');
    if (mdb) {
      try {
        for (const r of mdb.prepare(
          `SELECT sender_name AS name, MAX(ts) AS last FROM messages
           WHERE chat_key = ? AND sender_id = ? AND self = 0 AND sender_name != ''
           GROUP BY sender_name ORDER BY last DESC LIMIT ?`
        ).all(key, uid, Math.max(1, Math.min(20, Number(limit) || 5)))) push(r.name);
      } catch { /* ignore */ }
    }
  }
  return out.slice(0, Math.max(1, Number(limit) || 5));
}
