// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
/**
 * 跨群记忆（cross-chat memory）
 *
 * ★ 设计前提（2026-10-26 用户要求）：
 *   「让她拥有跨群记忆——平时几乎用不上，但是用的时候很有用」
 *
 * ★ 与既有约束的关系（这条最重要，别搞反了）：
 *   项目里早就定过 `memory.promptScope = 'chat'` —— **默认只注入"在当前这个会话里观察到"的印象**，
 *   注释原话是"正是用户明确不要的污染其他群的记忆"。所以本模块**绝不改默认注入**，
 *   它只提供一条**按需查询**的路径：当群友真的问起「他在别的群也这样吗」「你还在哪些地方见过我」
 *   这类问题时，模型才去查；平时一个字都不进提示词。
 *
 * ⇒ 一句话：**默认隔离不变，需要时可查。**
 *
 * ★★ 2026-10-26 实测发现的一个数据缺陷（必须绕开，否则跨群查询会变成复读）：
 *   现在 18 个 people/*.json **全部**存在「所有印象共享同一份 sourceChatKeys」的情况
 *   （实测 `不同来源组合=1`）。也就是说印象并不是"按群分别记的"，而是这个人整体的画像，
 *   只是被打上了他出现过的**所有**会话标签。
 *   ⇒ 如果按印象的 sourceChatKeys 逐群展开，同一条内容会在 6 个群里重复显示 6 次（实测踩到）。
 *   ⇒ 所以本模块改为：**印象只有一份（这个人的整体画像）**，跨群部分只回答
 *     "他在哪些会话出现过 / 有过互动"，需要细节再按会话去查（见 listChatsFor）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { visibleImpressions } from '../core/memory-visibility.js';

const clean = (v, n = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 'group:780739184' → '群 780739184'；'private:2423936413' → '私聊 2423936413' */
export function describeChat(chatKey) {
  const m = /^(group|private):(.+)$/.exec(String(chatKey || ''));
  if (!m) return clean(chatKey, 40);
  return (m[1] === 'group' ? '群 ' : '私聊 ') + m[2];
}

function readPerson(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const uin = String(d?.userId || path.basename(file, '.json'));
    const top = Array.isArray(d?.sourceChatKeys) ? d.sourceChatKeys.map(String) : [];
    const impressions = (Array.isArray(d?.impressions) ? d.impressions : [])
      .map((im) => ({
        content: clean(im?.content, 600),
        createdAt: Number(im?.createdAt) || 0,
        sourceChatKeys: Array.isArray(im?.sourceChatKeys) && im.sourceChatKeys.length ? im.sourceChatKeys.map(String) : top
      }))
      .filter((im) => im.content);
    // 这个人出现过的所有会话 = 所有印象标签的并集（去重）
    const chats = [...new Set([...top, ...impressions.flatMap((i) => i.sourceChatKeys)])];
    return { uin, impressions, chats };
  } catch {
    return null;
  }
}

function listPersonFiles(peopleDir) {
  try {
    return fs.readdirSync(peopleDir).filter((f) => f.endsWith('.json')).map((f) => path.join(peopleDir, f));
  } catch {
    return [];
  }
}

/**
 * 查某个人的跨群画像。
 *
 * @param {string} uin
 * @param {{peopleDir:string, excludeChatKey?:string, maxImpressions?:number}} opts
 * @returns {null | {
 *   uin:string, totalImpressions:number,
 *   chats:string[], chatLabels:string[],
 *   otherChats:string[], otherChatLabels:string[],
 *   isHere:boolean, seenElsewhere:boolean,
 *   impressions:string[]
 * }}
 */
export function getCrossChatProfile(uin, { peopleDir, chatKey = '', excludeChatKey = '', maxImpressions = 8 } = {}) {
  const key = String(uin || '').trim();
  if (!key || !peopleDir) return null;
  const file = path.join(peopleDir, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  const person = readPerson(file);
  if (!person) return null;

  // Preserve identity metadata across scopes, but never let the local tool
  // bypass the operator's native impression visibility policy.
  const impressions = visibleImpressions(person.impressions, chatKey);
  const here = Boolean(excludeChatKey) && person.chats.includes(excludeChatKey);
  const others = person.chats.filter((ck) => ck !== excludeChatKey);

  return {
    uin: key,
    totalImpressions: impressions.length,
    chats: person.chats,
    chatLabels: person.chats.map(describeChat),
    otherChats: others,
    otherChatLabels: others.map(describeChat),
    isHere: here,
    seenElsewhere: others.length > 0,
    // 印象只有一份（这个人的整体画像），新的在前
    impressions: impressions
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, Math.max(1, maxImpressions))
      .map((x) => x.content)
  };
}

/**
 * 当前会话里，有哪些人**在别的会话也出现过**（回答"你还在哪些地方见过我们"）。
 *
 * @returns {Array<{uin:string, here:string, otherChats:string[], otherChatLabels:string[], totalImpressions:number}>}
 */
export function listPeopleSeenElsewhere({ peopleDir, chatKey, limit = 10 } = {}) {
  if (!peopleDir || !chatKey) return [];
  const out = [];
  for (const file of listPersonFiles(peopleDir)) {
    const person = readPerson(file);
    if (!person || !person.impressions.length) continue;
    if (!person.chats.includes(chatKey)) continue;
    const others = person.chats.filter((ck) => ck !== chatKey);
    if (!others.length) continue;
    out.push({
      uin: person.uin,
      here: chatKey,
      otherChats: others,
      otherChatLabels: others.map(describeChat),
      totalImpressions: person.impressions.length
    });
  }
  out.sort((a, b) => b.otherChats.length - a.otherChats.length || b.totalImpressions - a.totalImpressions);
  return out.slice(0, Math.max(1, limit));
}

/**
 * 某个会话里关于这个人的**真实互动记录**（不是印象，是消息）。
 * 用来回答"他在那个群都说了什么"——印象只有一份，但每个群的消息是各自独立的。
 *
 * @returns {Array<{ts:number, text:string}>}  新的在前
 */
export function listChatsFor(uin, {
  messagesDbPath, chatKey, excludeChatKey = '', limit = 12, maxChars = 120
} = {}) {
  const key = String(uin || '').trim();
  if (!key || !messagesDbPath) return [];
  let db = null;
  try {
    db = new DatabaseSync(messagesDbPath, { readOnly: true });
    const sql = excludeChatKey && !chatKey
      ? `SELECT chat_key, ts, text FROM messages
         WHERE self=0 AND sender_id=? AND chat_key != ?
         ORDER BY ts DESC LIMIT ?`
      : `SELECT chat_key, ts, text FROM messages
         WHERE self=0 AND sender_id=? AND chat_key = ?
         ORDER BY ts DESC LIMIT ?`;
    const rows = chatKey
      ? db.prepare(sql).all(key, chatKey, Math.max(1, limit))
      : db.prepare(sql).all(key, excludeChatKey || '', Math.max(1, limit));
    return rows.map((r) => ({
      chatKey: String(r.chat_key),
      ts: Number(r.ts) || 0,
      text: clean(r.text, maxChars)
    }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 这个人在各个会话里的发言数（判断"他在这里活跃还是在别处活跃"） */
export function chatActivityFor(uin, { messagesDbPath, limit = 10 } = {}) {
  const key = String(uin || '').trim();
  if (!key || !messagesDbPath) return [];
  let db = null;
  try {
    db = new DatabaseSync(messagesDbPath, { readOnly: true });
    const rows = db.prepare(
      `SELECT chat_key AS chatKey, COUNT(*) AS n, MAX(ts) AS lastTs
       FROM messages WHERE self=0 AND sender_id=?
       GROUP BY chat_key ORDER BY n DESC LIMIT ?`
    ).all(key, Math.max(1, limit));
    return rows.map((r) => ({
      chatKey: String(r.chatKey),
      label: describeChat(String(r.chatKey)),
      messages: Number(r.n) || 0,
      lastAt: Number(r.lastTs) || 0
    }));
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
