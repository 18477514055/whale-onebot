// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
/**
 * 亲密度引擎（我们自己的，外附在作者的关系评估之上）
 *
 * ★ 设计原则（2026-10-26 定）：
 *   1. **不碰作者的 relationship-*.js** —— 作者的关系评估照常跑，我们只**读**它的 affinity/friction。
 *   2. **零 LLM** —— 纯确定性计算，永不报错、可重复、秒级重算。
 *   3. **scale 用本机实测分位标定**，不照抄作者的绝对值（作者的 sat(activeDays,12) 在本机
 *      active_days 最大只有 4 的情况下，那一项 25% 权重最高只能拿 0.071，整项报废）。
 *
 * 六个维度：
 *   D1 说话量    count(messages, self=0)
 *   D2 活跃跨度  count(distinct date)
 *   D3 直接搭话  count(mentions_self=1)
 *   D4 会话广度  count(distinct chat_key)
 *   D5 互动回合  他 @ 机器人后，机器人 5 分钟内有回复的次数
 *   D6 亲近倾向  作者的 affinity（仅少数人有；缺失按中性 0 处理，不扣分）
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * 本机实测标定（2026-10-26）
 *
 * ★ 为什么不用「分位直接当 scale」：分位只告诉你"这个值在这个人群里算高"，不告诉你
 *   "达到这个值该不该给满分"。第一版直接取 P95/P90（63/2/18/2/10），实测 Top1 发 734 条
 *   就让 D1 的 sat 顶到 1.0、base01 冲到 0.967，再乘 affinity 1.2 倍直接溢出 100 分被 clamp ——
 *   **两个人并列 100，看不出谁更亲，而且到顶后无法反映后续增长**。
 *
 * ⇒ 改为「留有余量的 scale」：让最活跃的人拿到 ~85-95 分而不是 100，保留上涨空间。
 *   实测 D 组（300/10/40/4/20）：Top1=93.7、Top2=77.4，无人顶格；中位 4.5；
 *   只来一天发几条的人落在 5-8 分（"陌生"档），符合真实人群结构。
 */
export const SCALES = {
  D1: 300,  // 发言量   （最活跃 735 条 → sat=0.914）
  D2: 10,   // 活跃天数 （本机 max 仅 4 天 → sat=0.330，承认数据跨度短，不虚高）
  D3: 40,   // @机器人  （最高 118 次 → sat=0.948）
  D4: 4,    // 会话数   （最高 8 个 → sat=0.865）
  D5: 20,   // 互动回合 （最高 68 回合 → sat=0.967）
};

/** 权重：直接互动（D3/D5）合计 40%，比作者更看重「他主动找你」 */
export const WEIGHTS = { D1: 0.30, D2: 0.20, D3: 0.25, D4: 0.10, D5: 0.15 };

/** 亲密度分档（给人和给模型看的） */
export const TIERS = [
  { min: 70, key: 'close',  label: '很熟' },
  { min: 45, key: 'warm',   label: '熟' },
  { min: 25, key: 'known',  label: '认识' },
  { min: 10, key: 'met',    label: '见过' },
  { min: 0,  key: 'stranger', label: '陌生' },
];

const sat = (value, scale) => 1 - Math.exp(-Math.max(0, Number(value) || 0) / Math.max(0.001, Number(scale) || 1));
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

export function tierOf(score) {
  for (const t of TIERS) if (score >= t.min) return t;
  return TIERS[TIERS.length - 1];
}

/**
 * 把六维原始值合成 0–100。
 * 纯函数，方便单测与复算。
 */
export function compose(metrics) {
  const d1 = Number(metrics.messageCount) || 0;
  const d2 = Number(metrics.activeDays) || 0;
  const d3 = Number(metrics.mentions || 0);
  const d4 = Number(metrics.chatCount) || 0;
  const d5 = Number(metrics.rounds) || 0;
  const affinity = Number(metrics.affinity) || 0;
  const friction = Number(metrics.friction) || 0;

  const base01 =
    WEIGHTS.D1 * sat(d1, SCALES.D1) +
    WEIGHTS.D2 * sat(d2, SCALES.D2) +
    WEIGHTS.D3 * sat(d3, SCALES.D3) +
    WEIGHTS.D4 * sat(d4, SCALES.D4) +
    WEIGHTS.D5 * sat(d5, SCALES.D5);

  let base = 100 * clamp01(base01);

  // D6 亲近倾向：乘性修正（affinity 是"温度"，对熟人影响大、对陌生人影响小）
  // 本机 affinity 实测范围 [-0.014, 0.201] ⇒ 归一到 [-1, 1] 需要除 0.2
  const affinityNorm = clamp(affinity / 0.2, -1, 1);
  base = base * (1 + 0.2 * affinityNorm);

  // friction 是减分项，单独扣（作者定义它就是"摩擦压力"）
  base = base - 25 * clamp01(friction);

  const score = Math.round(clamp(base, 0, 100) * 10) / 10;
  return {
    score,
    tier: tierOf(score).label,
    breakdown: {
      D1: Math.round(1000 * WEIGHTS.D1 * sat(d1, SCALES.D1)) / 10,
      D2: Math.round(1000 * WEIGHTS.D2 * sat(d2, SCALES.D2)) / 10,
      D3: Math.round(1000 * WEIGHTS.D3 * sat(d3, SCALES.D3)) / 10,
      D4: Math.round(1000 * WEIGHTS.D4 * sat(d4, SCALES.D4)) / 10,
      D5: Math.round(1000 * WEIGHTS.D5 * sat(d5, SCALES.D5)) / 10,
    },
    affinityNorm: Math.round(affinityNorm * 1000) / 1000,
  };
}

/** 从消息库算 D1–D5（一次扫完，别每人查一遍） */
export function measureFromMessages(messagesDbPath, { roundWindowMs = 5 * 60 * 1000 } = {}) {
  const db = new DatabaseSync(messagesDbPath, { readOnly: true });
  try {
    const stats = new Map();
    const touch = (uin) => {
      if (!stats.has(uin)) {
        stats.set(uin, { messageCount: 0, activeDays: 0, mentions: 0, chatCount: 0, rounds: 0, lastTs: 0, _days: new Set(), _chats: new Set(), _perChat: new Map() });
      }
      return stats.get(uin);
    };
    // ★ 2026-10-26 加：按「哪个群」分别统计。
    //   总分（六维聚合全库）不变，但排名要按**所在群**算 —— 425 人的总榜名次
    //   在小群里毫无意义（大群里排第 200 和小群里排第 200 完全不是一回事）。
    const touchChat = (s, chatKey) => {
      const k = String(chatKey || '');
      if (!s._perChat.has(k)) s._perChat.set(k, { messageCount: 0, mentions: 0, rounds: 0, _days: new Set() });
      return s._perChat.get(k);
    };

    // D1 / D2 / D3 / D4
    const rows = db.prepare(`
      SELECT sender_id AS uin, ts, chat_key AS chatKey, mentions_self AS m, self
      FROM messages
      WHERE sender_id IS NOT NULL AND sender_id != ''
      ORDER BY chat_key, ts ASC
    `).all();

    const dayOf = (ts) => {
      // 用东八区算"哪一天"，否则跨零点会把同一天拆成两天
      const d = new Date(Number(ts) + 8 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    };

    let pending = null; // { uin, ts, chatKey }
    for (const r of rows) {
      const uin = String(r.uin);
      const isSelf = Number(r.self) === 1;
      const ts = Number(r.ts);

      // ---- D5：他 @ 机器人后 5 分钟内机器人有回复 ----
      if (pending) {
        if (r.chatKey === pending.chatKey && ts <= pending.ts + roundWindowMs) {
          if (isSelf) {
            const ps = touch(pending.uin);
            ps.rounds += 1;
            touchChat(ps, pending.chatKey).rounds += 1;   // 按群也记一笔记
            pending = null;
          } else if (uin !== pending.uin) {
            pending = null; // 换人说话 = 这一轮没被回应
          }
        } else {
          pending = null;
        }
      }

      if (isSelf) continue; // 机器人自己的发言不计入任何人的 D1–D4

      const s = touch(uin);
      s.messageCount += 1;
      s._days.add(dayOf(ts));
      s._chats.add(String(r.chatKey || ''));
      if (Number(r.m) === 1) {
        s.mentions += 1;
        if (!pending) pending = { uin, ts, chatKey: r.chatKey };
      }
      if (ts > s.lastTs) s.lastTs = ts;

      // 按群统计（分数本身仍是全库口径，这里只用于「群内排名」）
      {
        const c = touchChat(s, r.chatKey);
        c.messageCount += 1;
        c._days.add(dayOf(ts));
        if (Number(r.m) === 1) c.mentions += 1;
      }
    }

    const out = new Map();
    for (const [uin, s] of stats) {
      out.set(uin, {
        messageCount: s.messageCount,
        activeDays: s._days.size,
        mentions: s.mentions,
        chatCount: s._chats.size,
        rounds: s.rounds,
        lastInteractionAt: s.lastTs,
        chats: [...s._chats].filter(Boolean),
        perChat: s._perChat,   // Map<chatKey, {messageCount, activeDays, mentions, rounds, _days:Set}>
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** 从作者的关系库读 affinity / friction（只读，缺失按 0） */
export function readAffinity(relationshipDbPath) {
  const out = new Map();
  let db = null;
  try {
    db = new DatabaseSync(relationshipDbPath, { readOnly: true });
    for (const r of db.prepare('SELECT uin, affinity, friction FROM relationship_states').all()) {
      out.set(String(r.uin), { affinity: Number(r.affinity) || 0, friction: Number(r.friction) || 0 });
    }
  } catch {
    // 作者的表不存在或读不了 ⇒ 全部按中性处理，不影响主流程
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 一次算全部人。
 * @returns {Array<{uin,score,tier,metrics,breakdown}>}
 */
export function computeAll({ messagesDbPath, relationshipDbPath }) {
  const measured = measureFromMessages(messagesDbPath);
  const affinityMap = relationshipDbPath ? readAffinity(relationshipDbPath) : new Map();

  const list = [];
  for (const [uin, m] of measured) {
    const rel = affinityMap.get(uin) || { affinity: 0, friction: 0 };
    const composed = compose({ ...m, ...rel });
    list.push({
      uin,
      score: composed.score,
      tier: composed.tier,
      breakdown: composed.breakdown,
      affinityNorm: composed.affinityNorm,
      metrics: m,
      affinity: rel.affinity,
      friction: rel.friction,
    });
  }
  list.sort((a, b) => b.score - a.score || b.metrics.messageCount - a.metrics.messageCount);
  return list;
}

// ---------------------------------------------------------------------------
// 带缓存的「查一个人」入口 —— 给固定回复（canned-replies）用。
//
// 为什么要缓存：computeAll 要扫全表 messages.sqlite（8000+ 条），约 40 ms。
// 每条 @ 都跑一次没必要，而且固定回复是热路径（要立刻回话）。
// 缓存 5 分钟；过了就后台重算，不阻塞当次回答（先给旧的，下次给新的）。
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null;          // { at, byUin: Map<uin, entry>, list }
let refreshing = null;     // Promise | null

/**
 * ★★★ 2026-10-27 修（真实事故）：这里原来有一个会让**所有人**都显示"交流太少"的坑。
 *
 *   旧代码的 catch 分支：`if (!cache) cache = { at: Date.now(), byUin: new Map(), list: [] }`
 *   ⇒ `computeAll()` 只要**抛一次**（850KB / 15k 行、WAL 并发读完全可能抛），
 *     就会写入一张**空表**并把 `at` 设成"现在" ⇒ **接下来 5 分钟内所有人的查询都查不到人**
 *     ⇒ `getPersonIntimacy` 返回 null ⇒ 固定回复走 `notInRoster` ⇒ 群里连回"咱们互动还太少"。
 *   而且 `catch {}` 把错误吞掉了 —— 现场完全看不出发生过什么。
 *
 *   实测现场（华东师范群）：管理员在该群 35 条消息、门槛只要 2，却连 3 次都报"交流太少"；
 *   而在干净进程里用完全一样的数据跑，结果是「100/100（很熟，本群第 1/33 名）」。
 *   ⇒ 就是这个"失败被缓存成空表"导致的。
 *
 *   修法三条：
 *     ① **失败绝不写空表**：算不出来就沿用旧缓存；没有旧缓存就返回 null，
 *        让调用方按"这次查不到"处理（而不是把"所有人都不存在"缓存 5 分钟）；
 *     ② **失败也留痕**：`console.warn` 打出来（原来静默吞掉）；
 *     ③ **失败不设 TTL**：下一次查询会立刻重试，不会卡 5 分钟。
 */
function ensureCache({ messagesDbPath, relationshipDbPath }, { force = false } = {}) {
  const now = Date.now();
  const fresh = cache && now - cache.at < CACHE_TTL_MS;
  if (fresh && !force) return cache;

  if (!refreshing) {
    refreshing = (() => {
      try {
        const list = computeAll({ messagesDbPath, relationshipDbPath });
        const byUin = new Map();
        for (const item of list) byUin.set(String(item.uin), item);
        cache = { at: Date.now(), byUin, list };
      } catch (error) {
        // ★ 只记日志，**不写空表**（写空表 = 把"这次失败"升级成"所有人都不存在"）
        try {
          console.warn('[intimacy] 亲密度计算失败，本次按"查不到"处理（不缓存空结果）:', error?.message ?? error);
        } catch { /* 日志失败不影响主流程 */ }
      } finally {
        refreshing = null;
      }
      return cache;
    })();
  }
  // 有旧缓存就先给旧的（不阻塞），没有就返回 null（调用方按"这次没数据"处理）
  return cache ?? null;
}

/**
 * 查单个人的亲密度（带缓存）。
 *
 * @param {string} uin
 * @param {{messagesDbPath:string, relationshipDbPath?:string, chatKey?:string}} opts
 *        chatKey 决定排名口径 —— 传了就按**这个群**排，不传才退回全库。
 * @returns {{
 *   score:number, tier:string, metrics:object, affinity:number, friction:number,
 *   rank:number|null, total:number, ranked:boolean, inRoster:boolean,
 *   chatKey:string|null, chatMessageCount:number
 * }|null} null = 这个人从未在消息库出现过（连互动记录都没有）
 */
export function getPersonIntimacy(uin, { messagesDbPath, relationshipDbPath, chatKey } = {}) {
  const key = String(uin ?? '').trim();
  if (!key) return null;
  const c = ensureCache({ messagesDbPath, relationshipDbPath });
  if (!c) {
    // 首次调用且算得慢：同步再等一次（computeAll 是同步函数，所以这里其实已经算完了）
    const c2 = ensureCache({ messagesDbPath, relationshipDbPath }, { force: true });
    if (!c2) return null;
    return pick(c2, key, chatKey);
  }
  return pick(c, key, chatKey);
}

// ---------------------------------------------------------------------------
// 排名口径（2026-10-26 改）：
//   ★ 排名必须**按群**算。原来的「全群第 N/439 名」是拿全库所有人排的，
//     在小群里毫无意义 —— 大群排第 200 和小群排第 200 完全不是一回事，
//     而且一个人在大群里活跃、在小群里几乎没说过话，却显示同一个名次。
//   ⇒ 分数仍用全库口径（他跟你整体的熟悉程度），但 rank/total **只在
//     「这个群里有互动的人」中排**，total 也是那个群的活跃人数。
// ---------------------------------------------------------------------------

/** 在某个群里，低于这个互动量就不进榜（也不给排名） */
export const MIN_CHAT_MESSAGES_FOR_RANK = 2;

function pick(c, key, chatKey) {
  const hit = c.byUin.get(key);
  if (!hit) return null;

  const wantChat = String(chatKey || '').trim();
  const perChat = hit.metrics?.perChat;
  const mine = wantChat && perChat ? perChat.get(wantChat) : null;

  // 这个人**在这个群里**的互动量
  const inThisChatMsgs = mine ? mine.messageCount : 0;
  // ★ 这个人**在全部会话里**的互动量（亲密度真正的口径 —— 绑人，不绑群）
  const totalMsgs = Number(hit.metrics?.messageCount) || 0;

  let rank = null;
  let total = 0;
  let ranked = false;      // 是否进入**群内榜单**
  const chatMessageCount = inThisChatMsgs;

  if (wantChat && perChat) {
    // 群内榜单：只数这个群里 messageCount ≥ 门槛的人
    const peers = [];
    for (const [uin, item] of c.byUin) {
      const pc = item.metrics?.perChat?.get(wantChat);
      const n = pc ? pc.messageCount : 0;
      if (n >= MIN_CHAT_MESSAGES_FOR_RANK) peers.push({ uin, score: item.score, n });
    }
    peers.sort((a, b) => b.score - a.score || b.n - a.n);
    total = peers.length;
    const idx = peers.findIndex((p) => String(p.uin) === key);
    if (idx >= 0) { rank = idx + 1; ranked = true; }
  } else {
    // 没带 chatKey 时退回全库口径（兼容旧调用）
    rank = c.list.findIndex((x) => String(x.uin) === key) + 1 || null;
    total = c.list.length;
    ranked = true;
  }

  return {
    score: hit.score,
    tier: hit.tier,
    metrics: hit.metrics,
    affinity: hit.affinity,
    friction: hit.friction,
    rank,
    total,
    ranked,
    chatKey: wantChat || null,
    chatMessageCount,
    totalMessageCount: totalMsgs,
    // ★★★ 2026-10-27 修：**亲密度绑人，不绑群**。
    //   旧代码是 `inRoster: ranked` —— 而 ranked 取决于"**这个群里**说了 ≥2 句"，
    //   于是同一个人跟机器人总分 100（很熟），换个刚加进来、还没怎么说话的群，
    //   就被判「交流太少」而**连分数都不给**。用户原话：
    //     「亲密度应该是绑定在个人账号上面的，而不是绑定在某个群上面。
    //       如果机器人在两个群碰到同样一个人的话，亲密度应该是一样的。」
    //   ⇒ 现在：只要这个人在**任何会话**里跟机器人有过互动，分数就照给（跨群一致）；
    //     `inRoster / rank` 只表示"在本群榜上有名"，供文案决定要不要报名次。
    inRoster: totalMsgs > 0,
    // 群内是否入榜（只影响"要不要报名次"，不影响"给不给分"）
    inChatRanking: ranked
  };
}

/**
 * 取某个群的**亲密度榜单**（按分降序）。给模型回答「榜上都有谁 / 我在这个群排第几」用。
 *
 *
 * @param {{messagesDbPath:string, relationshipDbPath?:string, limit?:number}} opts
 * @returns {{
 *   ok:boolean, chatKey:string, total:number,
 *   rows:Array<{rank:number, uin:string, score:number, tier:string, chatMessageCount:number}>,
 *   minMessages:number
 * }}
 */
export function getChatRanking(chatKey, { messagesDbPath, relationshipDbPath, limit = 10 } = {}) {
  const wantChat = String(chatKey || '').trim();
  const empty = { ok: false, chatKey: wantChat, total: 0, rows: [], minMessages: MIN_CHAT_MESSAGES_FOR_RANK };
  if (!wantChat) return empty;

  const c = ensureCache({ messagesDbPath, relationshipDbPath }) ?? ensureCache({ messagesDbPath, relationshipDbPath }, { force: true });
  if (!c) return empty;

  const peers = [];
  for (const [uin, item] of c.byUin) {
    const pc = item.metrics?.perChat?.get(wantChat);
    const n = pc ? pc.messageCount : 0;
    if (n >= MIN_CHAT_MESSAGES_FOR_RANK) {
      peers.push({ uin, score: item.score, tier: item.tier, chatMessageCount: n });
    }
  }
  peers.sort((a, b) => b.score - a.score || b.chatMessageCount - a.chatMessageCount);

  const max = Math.min(50, Math.max(1, Number(limit) || 10));
  return {
    ok: true,
    chatKey: wantChat,
    total: peers.length,
    minMessages: MIN_CHAT_MESSAGES_FOR_RANK,
    rows: peers.slice(0, max).map((p, i) => ({ rank: i + 1, ...p })),
  };
}

/** 清缓存（测试用；或数据刚变更多想让下一次立刻重算时） */
export function clearIntimacyCache() {
  cache = null;
  refreshing = null;
}
