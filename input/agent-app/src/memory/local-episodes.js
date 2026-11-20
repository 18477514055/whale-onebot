// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 事件记忆的「整理」与「检索装配」—— **独立文件，不改作者 orchestrator 的任何一段逻辑**。
//
// ★ 为什么单独一个文件（与 local-tools.js / local-prompt.js 同一个理由）：
//   作者的 `src/core/orchestrator.js` 有 3239 行，且是他每次大改的核心文件。
//   把「整理事件 / 装配提示词」整段内联进去，他每次更新都要在那 3239 行里重新找位置。
//   ⇒ 片段全住这里，`orchestrator.js` 只加**两处**（import + 调用）。
//
// ★ 上游（v0.9.10）与本地的三处**真实差异**（不处理就会静默失效，实测确认过）：
//   ① 上游 `store` **没有 `since()`** —— 那是我们扁平版 store.js 的方法。
//      等价物是 `store.recent(chatKey, { afterId, limit })`，但它**不支持 minTs 下限**。
//      ⇒ 「首次整理只回溯 backfillDays 天」这道闸只能在这里自己按 ts 过滤。
//   ② 上游 `recent({afterId})` 按 id **升序**返回「游标之后最早的一批」，与我们要的语义一致。
//   ③ 上游 `extractJsonObject` 是 orchestrator 文件内的私有函数（第 3643 行），**没有导出**。
//      ⇒ 这里自己实现一份（与上游同款行为：先整串 JSON.parse，再找第一个 { ... } 块）。
//
// ★ 整理与印象整理**故意相反**（这是设计，不是疏漏）：
//   印象整理 = 合并、去重、**把一次性事件删掉**（只留"他是个什么样的人"）
//   事件整理 = 恰恰要把一次性事件**留下来**（"上周三他让我帮查天气"）

import { EpisodeStore } from './episodes.js';
import { resolveByName } from '../identity/qq-resolver.js';
import { setPersonStatus } from './local-impressions.js';
import { DATA_DIR } from '../core/config.js';
import path from 'node:path';

/**
 * 事件记忆的全部可调参数（作者 episodes.js 的归一化逻辑，含 0 值守卫）。
 * ★ 由本文件转发一层，好处是 orchestrator 只需要 import 我们自己的文件
 *   —— 作者挪动 `episodes.js` 的位置时只改这里一行。
 */
export function episodeOptions() {
  return EpisodeStore.options();
}

/**
 * 惰性拿一个 EpisodeStore 实例。
 *
 * ★ 为什么惰性：宿主 `src/console/app.js`（6587 行，作者每次大改）里没有 episodes，
 *   我们不想为一行 `new EpisodeStore()` 去改它。第一次真正要用时才建。
 * ★ 建失败就记住，**不在每轮重试** —— 否则库文件被占用时会每秒往日志里刷错误。
 *
 * @param {object|null} existing 已经有的实例（调用方传了就直用）
 * @param {{ failedRef: { value: boolean } }} state 失败标记（由调用方持有）
 * @returns {object|null}
 */
export function ensureEpisodeStore(existing, state) {
  if (existing) return existing;
  if (state?.failedRef?.value) return null;
  try {
    const store = new EpisodeStore();
    if (state) state.value = store;
    return store;
  } catch (error) {
    if (state?.failedRef) state.failedRef.value = true;
    console.warn('[episodes] 事件记忆库打不开，本进程不再重试:', error?.message ?? error);
    return null;
  }
}

/** 失败/重试都靠它判断：拿到不合法的 JSON 时返回 null，调用方据此**不推进游标**。 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  // ① 整串就是 JSON（模型很听话时的常见情况）
  try { return JSON.parse(text); } catch { /* 继续 */ }
  // ② 去掉 ```json 围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* 继续 */ }
  }
  // ③ 从第一个 { 到最后一个 }（模型爱在前面加一句"好的，"）
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 继续 */ }
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtTs(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    + ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 事件整理用的提示词。
 * ★ 与印象整理**故意相反**：这里要求保留一次性事件。
 */
export function buildEpisodePrompt({ chatName = '', picked = [] } = {}) {
  const first = picked[0]?.m;
  const last = picked.at(-1)?.m;
  const lines = picked.map(({ m, text }) => {
    const who = m.self ? '我' : String(m.senderName || m.senderId || '某人');
    return `#${m.id} ${fmtTs(m.ts)} ${who}：${text.slice(0, 300)}`;
  });
  return {
    system: [
      '你是聊天机器人的「事件记忆」整理模块。你的唯一任务：把一段聊天记录里**确实发生过的事**，压缩成一条条可核对的事实，供以后回查"谁在什么时候说过、做过什么"。',
      '',
      '注意：这和"人物印象"完全不是一回事。人物印象只留稳定特征、**要求删掉一次性事件**；',
      '你恰好相反 —— **一次性的事件正是你要保留的东西**。不要升华、不要总结、不要评价人。',
      '',
      '硬规则：',
      '1. 只写原文里真实出现的内容。时间、对象、数字、承诺、约定必须来自原文，一个字都不许编。',
      '2. 一条 = 一件事，≤60 字，具体到可核对（谁 + 做了什么/说了什么 + 关键细节）。',
      '3. 忽略：纯表情、纯复读、没有信息量的寒暄（"在吗""哈哈""睡了""6"）。',
      '4. 同一件事只写一条，不要把一件事拆成好几条。',
      '5. 机器人自己说的话/做的事也要记，who 写"我"、user_id 留空字符串。',
      // ★ 补这一条是因为实测发现：24 条消息里群友占一半，产出 5 条全是"我…"，
      //   模型把"事件记忆"当成了"机器人日记"。群友做过的事同等重要。
      '6. **群友做的事与机器人做的事同等重要**。这不是机器人的日记 —— 只记自己说过什么会漏掉大半事实。',
      '7. 只输出 JSON，不要 Markdown 代码块、不要任何解释文字。',
      // ★★★ 2026-10-29 加（方案 C「最近怎么了」）：
      //   用户要「让模型主动去给每个人打分/记事件」，但模型看到的是**一堆碎片事件**，
      //   没有"他这周好像挺累的"这种整体印象 —— 真人先有整体判断，再想起细节。
      //   ⇒ 在**同一次**调用里顺带多写一句近况（不额外发起 LLM 调用）。
      //   ★ 成本实测：输出多约 60~120 字/人次，输出总量只占 0.85% ⇒ 影响 < 0.01%。
      '8. 另外，如果这段记录里**明显能看出**某个人最近的状态/处境（在忙什么、心情如何、遇到什么事），',
      '   就顺手写一句近况，每人最多一句、≤40 字。**看不出来就不要写** —— 宁可没有，也不要编。',
      '   这一句要给以后回话用（像"这周在忙毕业设计，偏焦虑"），不是复述某一条事件。',
      '',
      '输出格式：',
      '{"events":[{"user_id":"发言人的QQ号（机器人自己写空字符串）","who":"名字","at":"YYYY-MM-DD HH:MM",'
      + '"what":"一句话事实","topics":"逗号分隔关键词，2~5个","ids":[这件事对应的消息编号，取自每行开头的 #数字]}],'
      + '"people":[{"user_id":"这个人的QQ号","status":"一句近况，≤40字"}]}',
      '★ people 可以没有（写成空数组 []）；events 一条都没有时输出 {"events":[],"people":[]}'
    ].join('\n'),
    user: [
      `下面是${chatName ? `「${chatName}」` : '这个会话'}在 ${fmtTs(first?.ts)} 到 ${fmtTs(last?.ts)} 之间的聊天记录`
      + '（每行开头 #数字 是消息编号，格式：编号 时间 发言人：内容）：',
      '',
      ...lines,
      '',
      '请提取其中**值得以后回想**的事件：',
      '- 3~15 条；内容确实很少时可以只给 1~2 条；一条都没有就输出 {"events":[],"people":[]}',
      '- 优先保留：约定与承诺、请求与答复、情绪事件、重要事实（考试/工作/生病/生日/行程）、机器人做过的事、关系变化、纠纷与雷点',
      '- 每条尽量带上对应的 ids（消息编号），这样时间可以精确核对',
      '- 按时间升序排列'
    ].join('\n')
  };
}

/**
 * 解析模型返回的事件。
 *
 * 时间优先取 ids 指向的真实消息时间（可核对），其次解析 at，最后退回本批最后一条的时间；
 * 并把它夹在本批时间范围内 —— 模型偶尔会写出离谱日期，那会让事件在"按天检索"里跑到错误的位置。
 *
 * ★ 两个从生产踩出来的坑，这里都照原样修好了：
 *   ① `who` 模型爱写"某人" ⇒ 从 ids 反查原文说话人（self ? '我' : senderName）
 *   ② 字段名：store 的 entry() 产出 camelCase `senderName`，而裸 SQL 是 snake_case ⇒ 两种都兼容
 *
 * ★★★ 2026-10-29 身份解析（用户定的规矩：**只按 QQ 号绑，昵称只是当时的显示名**）：
 *   模型写的 `user_id` 常常是空的（实测 1038 条里 1009 条空），所以这里补两道：
 *     ① **消息编号反查**（最可靠）：ids 就是本批消息 id，直接查它们是谁发的；
 *     ② **本群昵称反查**（兜底）：`who` → QQ，命中必须唯一，多命中一律留空（宁缺勿错）。
 *   `who` 仍然保留（当昵称快照），但它**不再承担身份**。
 *
 * @param {object} parsed   模型返回的 JSON
 * @param {object[]} picked 本批消息 [{ m, text }]
 * @param {object} [opts]
 * @param {(name:string)=>string} [opts.resolveName] 昵称→QQ 的兜底解析器（返回空串=解析不出）
 */
export function parseEpisodeEvents(parsed, picked = [], { resolveName = null } = {}) {
  const raw = Array.isArray(parsed?.events) ? parsed.events
    : (Array.isArray(parsed) ? parsed : []);
  const byId = new Map(picked.map(({ m }) => [String(m.id), m]));
  const firstTs = Number(picked[0]?.m?.ts) || Date.now();
  const lastTs = Number(picked.at(-1)?.m?.ts) || Date.now();

  /** 这批消息 id 涉及到的其他说话人（uin → 名字集合）。★ 全部来自原文，不猜。 */
  const sendersOf = (ids) => {
    const map = new Map();
    for (const id of ids) {
      const m = byId.get(id);
      if (!m || m.self) continue;
      const uin = String(m.senderId ?? m.sender_id ?? '').trim();
      if (!/^\d{5,15}$/.test(uin)) continue;
      if (!map.has(uin)) map.set(uin, new Set());
      const nm = String(m.senderName ?? m.sender_name ?? '').replace(/\s+/g, ' ').trim();
      if (nm) map.get(uin).add(nm);
    }
    return map;
  };

  const out = [];
  for (const e of raw.slice(0, 60)) {
    const summary = String(e?.what ?? e?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!summary) continue;
    const ids = (Array.isArray(e?.ids) ? e.ids : [])
      .map((x) => String(x ?? '').replace(/^#+/, '').trim())
      .filter((x) => /^\d+$/.test(x))
      .slice(0, 20);
    let occurredAt = 0;
    for (const id of ids) {
      const m = byId.get(id);
      if (m) occurredAt = occurredAt ? Math.min(occurredAt, Number(m.ts) || 0) : Number(m.ts) || 0;
    }
    if (!occurredAt && e?.at) {
      const t = Date.parse(String(e.at).replace(/\//g, '-').replace(' ', 'T'));
      if (Number.isFinite(t)) occurredAt = t;
    }
    if (!occurredAt) occurredAt = lastTs;
    occurredAt = Math.min(Math.max(occurredAt, firstTs - 3600000), Date.now() + 300000);

    // ① 说话人（昵称快照）
    // ★★★ 2026-10-29 修正（第一版写反了，验收抓出）：
    //   第一版让**消息编号里的第一个发言人**盖过模型写的 `who`。那是错的 ——
    //   `ids` 是**证据**（这件事关联了哪几条消息），`who` 才是**主体**（这件事说的是谁）。
    //   一条事件常常关联多人的消息（实测 1009 条里 297 条如此），
    //   拿第一个 id 的说话人当主体，会把「阿乙骂人」记成「阿甲骂人」。
    //   ⇒ 主体一律以模型写的 `who` 为准；模型没写才从消息里推。
    const modelWho = String(e?.who ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    let msgWho = '';
    for (const id of ids) {
      const m = byId.get(id);
      if (!m || m.self) continue;
      const nm = String(m.senderName ?? m.sender_name ?? m.senderId ?? m.sender_id ?? '').trim();
      if (nm) { msgWho = nm; break; }
    }
    const who = modelWho || msgWho;

    // ② 身份（QQ 号）：模型写的 → 消息编号反查 → 本群昵称反查，逐级降级
    // ★★★ 2026-10-29 实测抓到的坑（回填 1038 条时发现）：
    //   `who === '我'` 的事件说的是**机器人自己**，但消息编号里往往也带着对方的发言，
    //   于是"反查唯一发言人"会把**对方**的 QQ 号绑到"我做的事"上 ——
    //   实测错了 37 条（例：'我否认贴吧那个不是自己' → 绑成陈黛华）。
    //   ⇒ 机器人不是群友，**它自己的事件 user_id 必须留空**。这是设计，不是缺省。
    const isSelfEvent = who === '我';
    let userId = '';
    let userSource = '';
    if (!isSelfEvent) {
      const modelUid = String(e?.user_id ?? e?.userId ?? '').trim();
      if (/^\d{5,15}$/.test(modelUid) && !/^0+$/.test(modelUid)) {
        userId = modelUid;
        userSource = 'model';
      }
    }
    if (!userId && !isSelfEvent) {
      const senders = sendersOf(ids);
      if (senders.size === 1) {
        userId = [...senders.keys()][0];
        userSource = 'message-id';
      } else if (senders.size > 1) {
        // 一条事件跨了多个人：只有"主体名字唯一命中其中一人"这个确定性判据才认
        const hits = who
          ? [...senders.entries()].filter(([, names]) => names.has(who)).map(([uin]) => uin)
          : [];
        if (hits.length === 1) { userId = hits[0]; userSource = 'message-id+who'; }
      }
    }
    if (!userId && !isSelfEvent && typeof resolveName === 'function' && who) {
      try {
        const got = String(resolveName(who) || '').trim();
        if (/^\d{5,15}$/.test(got) && !/^0+$/.test(got)) { userId = got; userSource = 'name-lookup'; }
      } catch { /* 解析失败就留空 */ }
    }

    // ③ 正文里模型爱写"某人说…"，那是它自己的口头禅，不是事实
    const cleaned = summary.replace(/^某人(?:说|问|表示|提到)[，,：:]?\s*/, '').trim();
    out.push({
      userId,
      userSource,
      who,
      occurredAt,
      summary: cleaned || summary,
      topics: String(e?.topics ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      sourceMessageIds: ids
    });
  }
  return out;
}

/**
 * 取「游标之后、且在回溯窗口内」的一批消息。
 *
 * ★ 上游没有 `store.since({minTs})`，所以这里用 `recent({afterId})` 拿批，再自己按 ts 过滤。
 * ★ 顺序必须保持 id 升序（recent 的 afterId 分支已经是升序），否则"最后处理到哪条"会算错。
 *
 * @returns {{rows: object[], flooredOut: number}} flooredOut = 被回溯窗口挡掉的条数（诊断用）
 */
export function fetchBatch(store, chatKey, { afterId = 0, limit = 300, minTs = 0 } = {}) {
  const rows = store.recent(chatKey, {
    afterId: Math.max(0, Number(afterId) || 0),
    limit: Math.max(1, Number(limit) || 1)
  });
  const list = Array.isArray(rows) ? rows : [];
  if (!minTs) return { rows: list, flooredOut: 0 };
  const kept = list.filter((m) => (Number(m?.ts) || 0) >= minTs);
  return { rows: kept, flooredOut: list.length - kept.length };
}

/**
 * 整理一个会话的事件记忆 —— **纯函数式入口**，不依赖 Orchestrator 的私有字段。
 *
 * @param {object} opts
 * @param {object} opts.store            ChatStore（上游形状）
 * @param {object} opts.episodes         EpisodeStore 实例
 * @param {string} opts.chatKey
 * @param {(messages: object[]) => Promise<object>} opts.memoryChat  调用方注入（复用上游 #memoryChat）
 * @param {() => string} [opts.getChatName]
 * @param {boolean} [opts.force]         跳过游标（手动全量重跑用）
 * @param {() => void} [opts.assertAllowed] 时间闸门（上游 time-gate）
 * @param {string} [opts.messagesDbPath]  身份解析用（昵称→QQ 兜底）；不给就只靠消息编号反查
 * @param {string} [opts.identityDbPath]  身份别名库（identity-pilot.sqlite），可缺
 * @param {string} [opts.statusDataDir]   近况库所在目录；不给则用 messagesDbPath 的同级目录
 *                                        （验收脚本必须显式传临时目录，否则会写进生产库）
 * @returns {Promise<{ok, note, added, statusCount, scanned, failed, pruned?}>}
 */
export async function consolidateEpisodesOnce({
  store,
  episodes,
  chatKey,
  memoryChat,
  getChatName = null,
  force = false,
  assertAllowed = null,
  messagesDbPath = '',
  identityDbPath = '',
  statusDataDir = ''
} = {}) {
  if (!episodes) throw new Error('事件记忆未启用');
  if (typeof memoryChat !== 'function') throw new Error('缺少 memoryChat');
  const opt = EpisodeStore.options();
  const st = episodes.state(chatKey);
  // ★ 2026-10-29：身份解析要用消息库与别名库。默认从 DATA_DIR 推，
  //   调用方（local-overlay-bridge）也可以显式传 —— 验收脚本用隔离目录时靠这个。
  const msgDb = messagesDbPath || path.join(DATA_DIR, 'messages.sqlite');
  const idDb = identityDbPath || path.join(DATA_DIR, 'identity-pilot.sqlite');
  // 近况库与消息库同一个 DATA_DIR（不另配路径，避免又多一处可配错的开关）
  // ★ 但调用方可以显式覆盖：验收脚本用隔离目录时必须传，否则会写进生产库。
  const statusDir = statusDataDir || path.dirname(msgDb);
  const startId = force ? 0 : Number(st.lastMessageId) || 0;
  // 首次整理（游标为 0）只往前补 backfillDays 天：
  // 否则一个历史很长的群会从最早的记录开始跑，等于把整个库重烧一遍。
  const floorTs = startId > 0 ? 0 : Date.now() - opt.backfillDays * 86400000;
  const { rows } = fetchBatch(store, chatKey, {
    afterId: startId,
    limit: opt.windowMaxMessages,
    minTs: floorTs
  });
  if (!rows.length) {
    return { ok: true, note: '没有新的聊天记录需要整理', added: 0, scanned: 0, failed: false };
  }

  // 字符预算：按时间从早到晚累计，超预算就截断。
  // ★ 截断时游标只推到"真正处理过的最后一条"，剩下的下一轮接着做 —— 否则中间那段会被永久跳过。
  const picked = [];
  let chars = 0;
  for (const m of rows) {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (chars + text.length > opt.windowMaxChars && picked.length > 0) break;
    chars += text.length + 24;
    picked.push({ m, text });
  }
  const lastProcessedId = Number(picked.at(-1)?.m?.id) || Number(st.lastMessageId) || 0;
  if (!picked.length) {
    episodes.markConsolidated(chatKey, {
      at: Date.now(),
      lastMessageId: Number(rows.at(-1)?.id) || 0
    });
    return { ok: true, note: '这批消息都是空文本，跳过', added: 0, scanned: 0, failed: false };
  }

  const chatName = typeof getChatName === 'function'
    ? (getChatName(String(chatKey).split(':')[1]) || '')
    : '';
  const { system, user } = buildEpisodePrompt({ chatName, picked });
  let added = 0;
  let statusCount = 0;
  try {
    const res = await memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    if (typeof assertAllowed === 'function') assertAllowed();
    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      // ★ 不推进游标：宁可下轮重做，也不能把这段历史悄悄丢掉
      return {
        ok: false,
        note: '模型返回无法解析，本轮跳过（下次重试）',
        added: 0,
        scanned: picked.length,
        failed: true
      };
    }
    // ★ 2026-10-29：把「昵称 → QQ」的兜底解析器传进去（消息编号反查在 parse 里已经做了）。
    //   解析器只用**本会话**的昵称，绝不做跨群全局匹配 —— 那是张冠李戴的唯一来源。
    const resolveName = (name) => {
      try {
        const r = resolveByName({
          chatKey,
          name,
          messagesDbPath: msgDb,
          identityDbPath: idDb
        });
        return r?.uin || '';
      } catch { return ''; }
    };
    const events = parseEpisodeEvents(parsed, picked, { resolveName }).slice(0, opt.maxEventsPerRun);
    added = episodes.addMany(chatKey, events);

    // ★ 方案 C「最近怎么了」：模型在同一次调用里顺带写的一句近况。
    //   ★ 只收**本批真的说过话的人**（防模型写错号）；一人只留最新一句（近况就是"现在"）。
    //   ★ 写失败绝不影响事件整理 —— 它是增强项。
    try {
      const rows = Array.isArray(parsed?.people) ? parsed.people : [];
      if (rows.length) {
        const speakers = new Set();
        for (const { m } of picked) {
          if (m.self) continue;
          const uin = String(m.senderId ?? m.sender_id ?? '').trim();
          if (/^\d{5,15}$/.test(uin)) speakers.add(uin);
        }
        for (const r of rows.slice(0, 20)) {
          const uin = String(r?.user_id ?? r?.userId ?? '').trim();
          const line = String(r?.status ?? r?.line ?? '').replace(/\s+/g, ' ').trim();
          if (!line || !speakers.has(uin)) continue;   // 没在本批说过话的人不写（防错号）
          if (setPersonStatus(statusDir, { uin, line, chatKey, ts: Number(picked.at(-1)?.m?.ts) || Date.now() })) {
            statusCount += 1;
          }
        }
      }
    } catch { /* ignore */ }

    episodes.markConsolidated(chatKey, { at: Date.now(), lastMessageId: lastProcessedId });
  } catch (error) {
    // 失败时**不推进游标**
    return {
      ok: false,
      note: `整理失败：${error?.message ?? error}`,
      added: 0,
      scanned: picked.length,
      failed: true
    };
  }

  // 过期清理顺手做，不额外起定时器。
  // ★ `retentionDays = 0`（默认）= **永久保留**，prune(0) 直接返回 0 不删任何东西。
  //   这段留着是为了以后想临时收紧时只改配置即可，而不是又要来改代码。
  let pruned = 0;
  try { pruned = episodes.prune(opt.retentionDays); } catch { /* 清理失败不影响整理结果 */ }

  const note = added > 0
    ? `已从 ${picked.length} 条聊天记录里整理出 ${added} 条事件${statusCount ? `、${statusCount} 条近况` : ''}${pruned ? `（顺带清理 ${pruned} 条过期事件）` : ''}`
    : `看过 ${picked.length} 条聊天记录，没有值得记下来的事件${statusCount ? `（更新了 ${statusCount} 条近况）` : ''}${pruned ? `（顺带清理 ${pruned} 条过期事件）` : ''}`;
  return { ok: true, note, added, statusCount, scanned: picked.length, failed: false, pruned };
}
