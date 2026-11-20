// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 【我们之间】+【想起来了】—— 提示词里两个「活人感」段的**计算层**。
// **独立文件，不改作者 orchestrator 的任何一段逻辑**。
//
// ★ 为什么这两段必须在这里算、而不是在 prompt.js 里算：
//   它们都是**异步**的（向量检索、事件库、裸 SQL），而 `buildUserPrompt` 是**同步**函数。
//   ⇒ 只能在唤醒流程里 await 算好，再把字符串传进去。这是架构限制，不是洁癖。
//
// ★ 为什么是回调而不是算好的字符串（【我们之间】特有）：
//   prompt.js 里才知道**最终会进提示词的是哪些人**（触发批 + 档位选中的已读）。
//   在这里先算会重复一遍筛选、而且可能算错人（把模型根本看不到的人的关系史注进去）。
//   ⇒ 传回调，让 prompt.js 在它算完 relevantUserIds 之后回调我们。
//
// ★ 刹车（三道，全部来自实测，别拆）：
//   ① 关键词闸门 —— 只有**碰到记忆**的发言才触发（"你上次说…""还记得…"），
//      普通闲聊一个字都不查（否则每轮都烧向量检索）。
//   ② 每人 10 分钟冷却 —— 同一句"你上次说过啥"连发三次不能查三次。
//   ③ 人数与字数上限 —— 最多 2 人 / 每人 2 条 / 整段 900 字符。
//   三者任一缺失都会让这段话变成"每轮都塞一大堆旧事"，比不触发更糟。
//
// ★ 失败一律降级为空串：这两段都是**增强项**，绝不允许它们影响正常回复。

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../core/config.js';
import { buildProactiveRecall } from './proactive-recall.js';
import { getRelationalFacts, formatRelationalFacts } from './relational-memory.js';
import { personMilestones, formatMilestones, getPersonStatuses, formatPersonStatuses } from './local-impressions.js';
import { displayNameFor } from '../identity/qq-resolver.js';

/** 上游 DATA_DIR 下的两个库（与作者的存储同源，绝不写死绝对路径）。 */
export function localPaths() {
  return {
    dataDir: DATA_DIR,
    messagesDbPath: path.join(DATA_DIR, 'messages.sqlite'),
    relationshipDbPath: path.join(DATA_DIR, 'relationship-pilot.sqlite'),
    peopleDir: path.join(DATA_DIR, 'memory', 'people')
  };
}

/**
 * 算【想起来了】主动召回。
 *
 * @param {object} opts
 * @param {string} opts.chatKey
 * @param {object[]} opts.triggerEntries  本轮触发批
 * @param {object|null} opts.episodes     EpisodeStore 实例
 * @param {object} opts.recallCfg         config.memory.proactiveRecall
 * @param {Map} opts.cooldown             跨轮共享的冷却表（必须由调用方持有，不能每次 new）
 * @returns {Promise<string>} 空串 = 本轮没触发
 */
export async function buildRecallText({
  chatKey,
  triggerEntries = [],
  episodes = null,
  recallCfg = {},
  cooldown = null,
  now = Date.now()
} = {}) {
  if (recallCfg?.enabled === false) return '';
  try {
    const { messagesDbPath } = localPaths();
    const r = await buildProactiveRecall({
      chatKey,
      entries: triggerEntries,
      episodes,
      messagesDbPath,
      maxPeople: Math.min(4, Math.max(1, Number(recallCfg.maxPeople) || 2)),
      maxItemsPerPerson: Math.min(4, Math.max(1, Number(recallCfg.maxItemsPerPerson) || 2)),
      maxChars: Math.min(2000, Math.max(300, Number(recallCfg.maxChars) || 900)),
      cooldownMs: Math.max(0, Number(recallCfg.cooldownMs ?? 600000)),
      lastQueryAt: cooldown,
      now,
      // ★ 2026-11-01 新增：实体命中触发（缺陷②）
      //   给一个"关键词 → 命中条数"的计数器，让「我今天又去吃了」这类
      //   **不说明说**的话也能碰到记忆。
      //   ★ 用 FTS5 + 中文二元组（tokenizeText 同一套规则），实测 26k 条建索引 463ms、
      //     检索 0~2ms，比 LIKE 准得多。建不出来就返回 null，自动退回"只认明说型"。
      entityFts: makeEntityFts(messagesDbPath)
    });
    return String(r?.text || '');
  } catch {
    // 主动召回是增强项，失败就当没有 —— 绝不影响本轮回复
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-01 新增：实体命中的 FTS5 计数器
//
// 为什么需要（缺陷②的实测证据）：
//   `detectRecallTrigger` 那三条正则只能抓"明说要回忆"的话。
//   实测反例：「那个彩票后来中了吗」「我今天又去吃了」「你还玩那个游戏吗」
//   —— **全都不触发**。而真人之间的记忆使用，绝大多数不需要说"你还记得吗"。
//
// ★★ 重要设计决定（第一版踩过，别改回去）：
//   第一版在**主链路上**同步建 FTS 表，结果：
//     · `buildRecallText` 耗时 **4,964 ms**（聊天主链路直接卡死）
//     · 而且只建了 13,553 / 36,498 行就中断了
//   ⇒ 改成：**建表交给独立脚本**（`scripts/build-entity-fts.mjs`），
//     主链路**只读**，且要求表已存在且行数够。这样主链路零成本。
//   ★ 表不存在就返回 null，自动退回"只认明说型"——不影响任何现有功能。
// ═══════════════════════════════════════════════════════════════════════
let _entityFtsReady = null;   // null=未尝试 / false=失败 / object=可用
let _entityFtsDb = null;

/** 中文按单字 + 二元组切（与 memory-search.js 的 tokenizeText 同一套规则）。 */
export function entityTokens(text) {
  const source = String(text ?? '').toLowerCase();
  const tokens = [];
  tokens.push(...(source.match(/[a-z0-9_]{2,}/g) || []));
  for (const run of (source.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || [])) {
    const chars = [...run];
    tokens.push(...chars);
    for (let i = 0; i < chars.length - 1; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(tokens)];
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-01 新增：FTS 自动增量维护（治「新消息不索引」）
//
// 【为什么需要】实测发现：`build-entity-fts.mjs` 是一次性脚本，跑完之后
//   新进来的消息**不会自动进 FTS**。手机实测缺口 16 行（rowid 37266+），
//   而「鲑鱼大帝」「蓝色鲸鱼」恰好就在那些新消息里 ⇒ 实体触发查不到。
//   缺口会随时间**持续变大** ⇒ 覆盖率跌破 80% 后 makeEntityFts 会自己关掉（fail-safe），
//   但那等于实体触发又失效了。
//
// 【设计约束】（别违反，违反会重演第一版的 4,964ms 卡死）
//   ① **绝不在主链路同步建整表** —— 这里只补「已索引 rowid 之后」的那一小段，通常 0~几十行；
//   ② **必须节流** —— 默认 10 分钟最多补一次，避免每条消息都开表；
//   ③ **失败绝不影响主链路** —— 全程 try/catch，任何异常只记 debug，不抛。
//
// 【怎么判断要补谁】FTS 的 rowid 与 messages.rowid **一一对应**（建表脚本用的就是它），
//   所以只需取两边 MAX(rowid)，把 messages 里大于它的那几条补进去即可。
const FTS_SYNC_INTERVAL_MS = 10 * 60 * 1000;   // 10 分钟最多补一次
let _ftsLastSyncAt = 0;
let _ftsSyncing = false;

// ★ 2026-11-20 折叠后真机事故修复（P6 深度改造）：178MB 库 + proot 下，任何对 messages
//   的「无索引条件扫全表」都会把事件循环冻住几十分钟（表现为控制台/入站全无响应，
//   /proc 侧只见 pread64 一页页啃库、CPU 只涨不干活）。原实现有两处全表扫：
//   ① MAX(rowid) 带 WHERE text 过滤 ⇒ 全表扫 137k 行；
//   ② 覆盖率检查的两次 COUNT(*) ⇒ 全表扫两遍。
//   修复：①改为 rowid 倒序 + LIMIT 1（从表尾回找第一条有文本的行，实测 4ms）；
//        ②改为「FTS 尾部缺口」检查：两边各一次 rowid seek（FTS5 按 rowid 有序，1ms），
//          缺口 > 20000 行才判不达标——半建库（13k/36k）的场景缺口 23k 仍会被拦下，
//          日常增量缺口 ≤ 5000 不影响启用。80% 比率检查的保护语义保留在缺口判定里。
/** messages 里「有文本」的最大 rowid（倒序回扫，近期消息几乎都有文本 ⇒ 实测毫秒级）。 */
function maxTextRowid(db) {
  const row = db.prepare(
    "SELECT rowid AS r FROM messages WHERE text IS NOT NULL AND text != '' ORDER BY rowid DESC LIMIT 1"
  ).get();
  return Number(row?.r) || 0;
}

function syncEntityFtsIncremental(messagesDbPath, writeDb) {
  if (!writeDb || _ftsSyncing) return 0;
  const now = Date.now();
  if (now - _ftsLastSyncAt < FTS_SYNC_INTERVAL_MS) return 0;
  _ftsSyncing = true;
  try {
    const lastFts = Number(writeDb.prepare('SELECT MAX(rowid) AS r FROM messages_fts').get()?.r) || 0;
    const lastMsg = maxTextRowid(writeDb);
    if (lastMsg <= lastFts) { _ftsLastSyncAt = now; return 0; }
    const rows = writeDb.prepare(
      'SELECT rowid AS id, text FROM messages WHERE rowid > ? AND text IS NOT NULL AND text != \'\' ORDER BY rowid LIMIT 5000'
    ).all(lastFts);
    if (!rows.length) { _ftsLastSyncAt = now; return 0; }
    const ins = writeDb.prepare('INSERT INTO messages_fts(rowid, tokens) VALUES(?,?)');
    let n = 0;
    for (const row of rows) {
      const tokens = entityTokens(row.text).join(' ');
      if (!tokens) continue;
      try { ins.run(Number(row.id), tokens); n += 1; } catch { /* 主键冲突等，跳过 */ }
    }
    _ftsLastSyncAt = now;
    return n;
  } catch {
    _ftsLastSyncAt = Date.now();   // 失败也节流，别每条消息都重试
    return 0;
  } finally {
    _ftsSyncing = false;
  }
}
function makeEntityFts(messagesDbPath) {
  if (_entityFtsReady === false) return null;
  if (_entityFtsReady) return _entityFtsReady;
  try {
    const db = new DatabaseSync(messagesDbPath, { readOnly: true });
    const has = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
    ).get();
    if (!has) { db.close(); _entityFtsReady = false; return null; }
    // ★ 覆盖率检查（2026-11-20 改为「尾部缺口」判定，见上方 maxTextRowid 注释）：
    //   原来的两次 COUNT(*) 全表扫在 178MB 库 + proot 下会冻住事件循环几十分钟。
    //   新判据：FTS 最大 rowid 距 messages 最大文本 rowid 的缺口 > 20000 行才判不达标
    //   （半建库 13k/36k 的场景缺口 23k 仍然被拦；日常增量缺口 ≤ 5000 不影响启用）。
    let ok = true;
    try {
      const ftsMax = Number(db.prepare('SELECT MAX(rowid) AS r FROM messages_fts').get()?.r) || 0;
      const msgMax = maxTextRowid(db);
      if (msgMax > 0 && ftsMax + 20000 < msgMax) ok = false;
    } catch { ok = false; }
    if (!ok) { db.close(); _entityFtsReady = false; return null; }
    _entityFtsDb = db;
    _entityFtsReady = {
      count(term) {
        try {
          // ★★★ 2026-11-01：每次查询前先按节流补一次增量。
          //   为什么不放在开库处：那里有 _entityFtsReady 缓存，只会执行一次；
          //   而 count() 是每次实体判定都会调用的，放这里才真正持续维护。
          //   节流 10 分钟 ⇒ 稳态几乎不做事；只在有新消息时补那几十行。
          if (messagesDbPath && Date.now() - _ftsLastSyncAt >= FTS_SYNC_INTERVAL_MS) {
            try {
              const wdb = new DatabaseSync(messagesDbPath);
              const added = syncEntityFtsIncremental(messagesDbPath, wdb);
              wdb.close();
              // 只读句柄看不到新写入 ⇒ 补了就丢缓存，下次查询重建
              if (added > 0) { _entityFtsReady = null; _entityFtsDb = null; }
            } catch { _ftsLastSyncAt = Date.now(); }
          }
          const q = entityTokens(term).map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
          if (!q) return 0;
          const row = _entityFtsDb.prepare('SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH ?').get(q);
          return Number(row?.c) || 0;
        } catch { return 0; }
      }
    };
    return _entityFtsReady;
  } catch {
    _entityFtsReady = false;
    return null;
  }
}

/**
 * 造一个【我们之间】回调，交给 prompt.js 在算完 relevantUserIds 之后调用。
 *
 * ★ 2026-10-29 扩展（方案 F + C）：这段现在不只是"累计量"，而是三层：
 *   ① 关系史（原有）：认识多久 / 说过多少句 / 最近一句原话 / 常怎么提起我
 *   ② **里程碑**（新）：第一次说话、第一次私聊、第一次聊到半夜、单日最多
 *   ③ **近况**（新）：每人一句"最近怎么了"（来自事件整理顺带产出）
 *   ⇒ 真人的回忆是"我们第一次聊到半夜那次" + "他这周好像挺累的"，
 *     不是"一共聊了 237 次"。②③ 才是"像人"的部分。
 *
 * ★ 成本：①②③ 全是本地只读查询（里程碑是 SQL，近况是本地 sqlite），
 *   唯一增加的 token 是渲染出来的那几十个字（每人约 40 字符，最多 3 人）。
 *
 * @param {object} opts
 * @param {string} opts.chatKey
 * @param {string} opts.selfId        机器人的 QQ（"我对他说了什么"要用；空串会降级）
 * @param {object} [opts.memory]      MemoryStore（取备注名，只为让措辞更像人）
 * @param {number} [opts.maxPeople]   上限，默认 3（实测每人约 150~200 字，再多就撑爆提示词）
 * @param {boolean} [opts.milestones] 是否追加里程碑（默认 true）
 * @param {boolean} [opts.statuses]   是否追加近况（默认 true）
 * @returns {(userIds: string[]) => string}
 */
export function makeRelationalFor({
  chatKey, selfId = '', memory = null, maxPeople = 3, milestones = true, statuses = true
} = {}) {
  const { messagesDbPath, dataDir } = localPaths();
  const identityDbPath = path.join(dataDir, 'identity-pilot.sqlite');

  /**
   * 该用什么称呼。
   * ★ 2026-10-29（用户定的规矩）：**存储按 QQ 号，聊天时才换成昵称**。
   *   原来的写法是 `memory.getMember(chatKey, uin).name` —— 那是**人物记忆文件里的名字**，
   *   可能是很久以前记的、也可能是别的群的名字（人会改名、群名片各群不同）。
   *   现在优先用**当前这个会话里他最近用的昵称**（displayNameFor），
   *   取不到才退回记忆里的名字，最后才是 QQ 号。
   */
  const nameOf = (uin) => {
    try {
      const n = displayNameFor({ uin, chatKey, messagesDbPath, identityDbPath });
      if (n && n !== uin) return n;
    } catch { /* 取不到就用下面那个 */ }
    try {
      return memory?.getMember?.(chatKey, uin)?.name || '';
    } catch { return ''; }
  };

  return function relationalFor(userIds) {
    try {
      const ids = (Array.isArray(userIds) ? userIds : [])
        .map((x) => String(x ?? '').trim())
        .filter((x) => /^\d{5,15}$/.test(x))
        .slice(0, Math.max(1, Number(maxPeople) || 3));
      if (!ids.length) return '';

      // ① 关系史（原有逻辑，一个字节没改）
      const blocks = ids
        .map((uin) => {
          const facts = getRelationalFacts(uin, {
            messagesDbPath,
            chatKey,
            selfUin: String(selfId || '')
          });
          if (!facts) return '';
          return formatRelationalFacts(facts, { name: nameOf(uin) });
        })
        .filter(Boolean);

      // ② 里程碑（方案 F）：只在有具体转折时才有内容，算不出来就整段不出
      if (milestones) {
        const extra = [];
        for (const uin of ids) {
          try {
            const m = personMilestones(uin, { messagesDbPath, chatKey });
            if (!m) continue;
            const line = formatMilestones(m, { name: nameOf(uin) });
            if (line) extra.push(line);
          } catch { /* 单人失败不影响别人 */ }
        }
        if (extra.length) blocks.push(`【我们之间的几个转折】\n${extra.join('\n')}`);
      }

      // ③ 近况（方案 C）：只查给进来的这几个人，不多查
      if (statuses) {
        try {
          const map = getPersonStatuses(dataDir, ids);
          if (map.size) {
            const names = {};
            for (const uin of map.keys()) names[uin] = nameOf(uin);
            const text = formatPersonStatuses(map, { maxPeople: ids.length, names });
            if (text) blocks.push(`【最近怎么了】\n${text}`);
          }
        } catch { /* 近况是增强项，失败就当没有 */ }
      }

      // ★ 上限必须在**拼之前**截，不是在拼完之后截字符串 —— 后者会把某人的半句话切断
      return blocks.slice(0, Math.max(1, Number(maxPeople) || 3) + 2).join('\n\n');
    } catch {
      return '';
    }
  };
}
