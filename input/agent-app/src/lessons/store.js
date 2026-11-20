// 经验教训库：机器人自己答错过、被群友纠正过的结论，按 chatKey 存下来。
//
// ★ 为什么要有它（用户 2026-11-09 原话）：
//   「群友指出来之后还不一定会认。然后认了之后也不会当成记忆，长期存下去」
//   ⇒ 现有 memory_append 只收 memberImpression（对某个人的印象），绑定到人；
//     meme_remember 只收梗/黑话。**"我上次把 X 说成 Y，其实应该是 Z" 无处可放**，
//     于是下次同样的问题还会照原样答错。
//
// ★ 设计三条（与梗库同构，便于维护）：
//   ① 一行一条 JSON 条目，按 chatKey 隔离 —— 本群的错不在别的群提。
//   ② 原子写（临时文件 + rename），坏文件留档不覆盖。
//   ③ 只记「可复用的判断」，不记「我错了对不起」这种情绪表达。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import { sanitizeUserText } from '../core/util.js';

const FILE = path.join(DATA_DIR, 'lessons.json');
const MAX_ENTRIES = 800;
const MAX_PER_CHAT = 200;
const MAX_TOPIC = 60;
const MAX_WRONG = 400;
const MAX_RIGHT = 600;
const MAX_SOURCE = 120;

function clean(value, max) {
  return sanitizeUserText(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validChatKey(value) {
  return /^(?:group|private):[0-9A-Za-z_-]{1,40}$/.test(String(value || '').trim());
}

function readDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    const entries = parsed.entries.filter((e) => e && typeof e === 'object'
      && typeof e.id === 'string' && typeof e.chatKey === 'string'
      && typeof e.topic === 'string' && typeof e.wrong === 'string' && typeof e.right === 'string');
    return { version: 1, entries };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`); } catch { /* 留档失败也不阻断 */ }
    }
    return { version: 1, entries: [] };
  }
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function publicEntry(e) {
  return {
    id: e.id,
    chatKey: e.chatKey,
    topic: e.topic,
    wrong: e.wrong,
    right: e.right,
    source: e.source || '',
    hits: Number(e.hits) || 0,
    createdAt: e.createdAt || 0,
    updatedAt: e.updatedAt || 0
  };
}

/**
 * 记一条教训。
 * topic 是"以后怎么找回来"的钥匙（例如「群星 行星飞升 效果」），
 * wrong/right 是"错在哪、对的是什么"。
 * ★ 同一 chatKey 下 topic 归一化后相同 ⇒ 视为同一条，覆盖更新（不堆重复）。
 *
 * ★★★ 2026-11-09 用户追加要求（这条是硬约束，不是建议）：
 *   「群友说的也未必是对的……有人指出了他的错误，他会优先进行联网搜索和核对，
 *     核对之后再加入经验教训中」
 *   ⇒ **没核对过的纠正一律不许入库**。`verified` 必须为 true 且 `source` 非空，
 *     否则直接抛错。这一层放在 store 而不是只写在提示词里：
 *     提示词会被忽略，抛错不会 —— 结构性保证比叮嘱可靠。
 *   ★ 这也顺带挡住另一类污染：群友瞎说一句，机器人当成真理永久记下去，
 *     那比不记更糟（以后每次都会主动说错）。
 */
export function rememberLesson({ chatKey, topic, wrong, right, source = '', createdBy = '', verified = false } = {}) {
  if (!validChatKey(chatKey)) throw new Error('chatKey 不合法');
  // ★ 强制核对：没有 verified + source 就不给写
  if (verified !== true) {
    throw new Error('这条还没有核实过，不能入库。请先用 web_search / web_fetch 核对，'
      + '确认后再调用本工具并传 verified=true 和 source（写清据以核对的来源）。');
  }
  const src = clean(source, MAX_SOURCE);
  if (!src) {
    throw new Error('缺少 source：请写清你是依据什么核对通过的（例如「web_search：群星 wiki 飞升页」）。'
      + '没有来源的纠正可能是群友记错，不能当教训存下来。');
  }

  const t = clean(topic, MAX_TOPIC);
  const w = clean(wrong, MAX_WRONG);
  const r = clean(right, MAX_RIGHT);
  if (!t) throw new Error('topic 不能为空');
  if (!w) throw new Error('wrong（我错在哪）不能为空');
  if (!r) throw new Error('right（正确的说法）不能为空');

  const db = readDb();
  const now = Date.now();
  const key = t.toLowerCase().replace(/\s+/g, ' ');
  const existing = db.entries.find((e) => e.chatKey === chatKey
    && String(e.topic || '').toLowerCase().replace(/\s+/g, ' ') === key);

  if (existing) {
    existing.wrong = w;
    existing.right = r;
    existing.source = src;
    existing.updatedAt = now;
    // 只留最近 N 条/群，防无限增长
    trim(db, chatKey);
    writeDb(db);
    return { entry: publicEntry(existing), updated: true };
  }

  const entry = {
    id: `ls_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    chatKey,
    topic: t,
    wrong: w,
    right: r,
    source: src,
    createdBy: clean(createdBy, 40),
    hits: 0,
    createdAt: now,
    updatedAt: now
  };
  db.entries.push(entry);
  trim(db, chatKey);
  if (db.entries.length > MAX_ENTRIES) db.entries = db.entries.slice(-MAX_ENTRIES);
  writeDb(db);
  return { entry: publicEntry(entry), updated: false };
}

function trim(db, chatKey) {
  const mine = db.entries.filter((e) => e.chatKey === chatKey);
  if (mine.length <= MAX_PER_CHAT) return;
  const drop = new Set(mine.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .slice(0, mine.length - MAX_PER_CHAT).map((e) => e.id));
  db.entries = db.entries.filter((e) => !drop.has(e.id));
}

/** 本群全部教训（按更新时间倒序）。 */
export function listLessons(chatKey, limit = 20) {
  const db = readDb();
  return db.entries
    .filter((e) => e.chatKey === chatKey)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map(publicEntry);
}

/**
 * 查教训：按 topic/wrong/right 里出现的关键字匹配（中文二元组，与检索同一口径的简化版）。
 * ★ 不做向量检索 —— 条目量小（每群上限 200），关键词足够，且能立刻返回。
 */
export function lookupLessons(chatKey, query = '', limit = 6) {
  const all = listLessons(chatKey, MAX_PER_CHAT);
  const q = clean(query, 80).toLowerCase();
  if (!q) return all.slice(0, limit);
  const terms = new Set();
  for (const part of q.split(/[\s,，。;；]+/).filter(Boolean)) {
    terms.add(part);
    if (part.length >= 2) for (let i = 0; i + 1 < part.length; i++) terms.add(part.slice(i, i + 2));
  }
  const scored = all.map((e) => {
    const hay = `${e.topic} ${e.wrong} ${e.right} ${e.source}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (t && hay.includes(t)) score += t.length >= 2 ? 2 : 1;
    if (e.topic.toLowerCase().includes(q)) score += 5;
    return { e, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || (b.e.updatedAt || 0) - (a.e.updatedAt || 0));
  return scored.slice(0, Math.max(1, Math.min(50, limit))).map((x) => x.e);
}

/** 打一次"这条教训又被提醒了一次"（只影响排序，无副作用）。 */
export function touchLesson(id) {
  const db = readDb();
  const e = db.entries.find((x) => x.id === id);
  if (!e) return null;
  e.hits = (Number(e.hits) || 0) + 1;
  writeDb(db);
  return publicEntry(e);
}

// ── 供提示词渲染：把最近几条教训压成一小段（不进上下文，只在工具里用） ──
export function lessonsDigest(chatKey, limit = 8) {
  const list = listLessons(chatKey, limit);
  if (!list.length) return '';
  return list.map((e) => `- ${e.topic}：曾错说成「${e.wrong}」→ 正确是「${e.right}」`).join('\n');
}
