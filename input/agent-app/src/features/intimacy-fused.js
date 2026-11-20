// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 亲密度融合层（2026-10-29）
//
// ★ 这一层只做一件事：**把「事件分」并入原来的「统计分」**，得到最终亲密度。
//   它不改 intimacy.js 的任何逻辑（那是我们自己的文件，但已经被 5 个地方引用，
//   原地改造风险高）—— 而是在外面再包一层，原有调用点继续工作，
//   想要"事件增强版"的调用点改成调这里。
//
// ★ 融合公式（改之前先想清楚，这是整个系统的"尺子"）：
//
//     最终分 = 统计分 × (1 + EVENT_INFLUENCE × 事件分)
//
//   · 统计分：原 intimacy.js 的 0–100（发言量/活跃天数/@/会话数/回合）
//   · 事件分：intimacy-events.js 给的 -1..1（正负事件按半衰期加权，压到 ±1）
//   · EVENT_INFLUENCE = 0.35
//
//   **为什么用乘法而不是加法**：
//     加法会让"一个陌生人被夸了几句"直接跳到 40 分，这不合理 —— 亲密度首先要有
//     "一起待过多久"的底子。乘法保证"底子薄的人，事件只能微调；底子厚的人，
//     好事件/坏事件都更显著"，符合直觉。
//
//   **为什么系数是 0.35 而不是 1.0**：
//     事件分是 ±1，乘 0.35 意味着一侧最多 ±35% 的修正。
//     实测校准：一个天天吵架但发言极多的人（统计 90 分），一条 insult 事件
//     （-4 分 raw，约 -0.13 事件分）只会把 90 压到 86 —— **不会因为一次争吵就清零**。
//     而一个只在关键时刻帮过忙的人（统计 20 分），累计 help+defend 到 0.5 事件分，
//     能把 20 拉到 23.5 —— 有感但不夸张。
//     ⇒ 事件是"修正项"，不是"主项"。这和用户要的"复杂化"一致：
//        维度变多了，但不会让分数乱跳。

import {
  getPersonIntimacy, getChatRanking, computeAll
} from './intimacy.js';
import {
  eventScore, listEvents, recordEvent, eventStats, EVENT_KINDS,
  localDay, intimacyEventDbPath, HALF_LIFE_DAYS
} from './intimacy-events.js';

/** 事件分对最终分的最大影响比例（见文件头注释的校准依据）。 */
export const EVENT_INFLUENCE = 0.35;

const clamp0to100 = (v) => Math.min(100, Math.max(0, Number(v) || 0));

/**
 * 把统计分与事件分合成最终分。
 * 纯函数，方便单测和"只算分不入库"的场景。
 *
 * @param {number} baseScore 原统计分 0–100
 * @param {number} evScore   事件分 -1..1
 * @returns {{score:number, base:number, event:number, delta:number}}
 */
export function fuse(baseScore, evScore) {
  const base = clamp0to100(baseScore);
  const ev = Math.max(-1, Math.min(1, Number(evScore) || 0));
  const score = clamp0to100(Math.round(base * (1 + EVENT_INFLUENCE * ev) * 10) / 10);
  return {
    score,
    base: Math.round(base * 10) / 10,
    event: Math.round(ev * 1000) / 1000,
    // 事件带来的增减（正=加分，负=扣分）
    delta: Math.round((score - base) * 10) / 10
  };
}

/** 分档（与 intimacy.js 的 TIERS 同一口径，避免两处不一致）。 */
function tierLabel(score) {
  if (score >= 70) return '很熟';
  if (score >= 45) return '熟';
  if (score >= 25) return '认识';
  if (score >= 10) return '见过';
  return '陌生';
}

/**
 * 取一个人的**最终**亲密度（统计 + 事件）。
 *
 * @param {string} uin
 * @param {{messagesDbPath:string, relationshipDbPath?:string, chatKey?:string,
 *          dataDir:string, withEvents?:boolean}} opts
 */
export function getPersonIntimacyFused(uin, opts = {}) {
  const base = getPersonIntimacy(uin, opts);
  if (!base) return null;
  const ev = opts.dataDir
    ? eventScore(opts.dataDir, uin, { chatKey: '' })   // ★ 事件分用全库口径：亲密度绑人，不绑群
    : { score: 0, raw: 0, count: 0, byKind: {} };
  const merged = fuse(base.score, ev.score);
  return {
    ...base,
    score: merged.score,          // ← 覆盖成最终分
    baseScore: merged.base,       // 原统计分（给界面展示"事件改了多少"）
    eventScore: merged.event,
    eventDelta: merged.delta,
    eventCount: ev.count,
    eventByKind: ev.byKind,
    tier: tierLabel(merged.score),
    ...(opts.withEvents === false ? {} : {
      events: opts.dataDir ? listEvents(opts.dataDir, uin, { limit: 8 }) : []
    })
  };
}

/**
 * 本群榜单（统计分 + 事件分融合后重新排序）。
 * ★ 注意：**排序依据变成了最终分** —— 所以"事件"会改变名次，这正是用户要的。
 */
export function getChatRankingFused(chatKey, opts = {}) {
  const board = getChatRanking(chatKey, opts);
  if (!board?.ok) return board;
  const oldByUin = new Map((board.rows || []).map((r) => [String(r.uin), r]));

  const rows = (board.rows || []).map((r) => {
    const ev = opts.dataDir
      ? eventScore(opts.dataDir, r.uin, { chatKey: '' })
      : { score: 0, count: 0, raw: 0, byKind: {} };
    const merged = fuse(r.score, ev.score);
    return {
      ...r,
      score: merged.score,
      baseScore: merged.base,
      eventScore: merged.event,
      eventDelta: merged.delta,
      eventCount: ev.count,
      tier: tierLabel(merged.score),
      // 名次要重排，这里先留空，下面统一填
      rank: 0
    };
  });

  rows.sort((a, b) => b.score - a.score || b.chatMessageCount - a.chatMessageCount);
  rows.forEach((r, i) => { r.rank = i + 1; });

  return { ...board, rows };
}

/**
 * 全站榜单（管理界面用）：所有人，按最终分降序。
 * @param {{messagesDbPath:string, relationshipDbPath?:string, dataDir:string, limit?:number}} opts
 */
export function listAllFused(opts = {}) {
  const all = computeAll({ messagesDbPath: opts.messagesDbPath, relationshipDbPath: opts.relationshipDbPath });
  const rows = all.map((p) => {
    const ev = opts.dataDir ? eventScore(opts.dataDir, p.uin, { chatKey: '' }) : { score: 0, count: 0, raw: 0, byKind: {} };
    const merged = fuse(p.score, ev.score);
    return {
      uin: String(p.uin),
      score: merged.score,
      baseScore: merged.base,
      eventScore: merged.event,
      eventDelta: merged.delta,
      eventCount: ev.count,
      eventByKind: ev.byKind,
      tier: tierLabel(merged.score),
      messageCount: Number(p.metrics?.messageCount) || 0,
      activeDays: Number(p.metrics?.activeDays) || 0,
      mentions: Number(p.metrics?.mentions) || 0,
      chatCount: Number(p.metrics?.chatCount) || 0,
      rounds: Number(p.metrics?.rounds) || 0,
      lastTs: Number(p.metrics?.lastTs) || 0
    };
  });
  rows.sort((a, b) => b.score - a.score || b.messageCount - a.messageCount);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

export {
  recordEvent, listEvents, eventScore, eventStats, EVENT_KINDS,
  localDay, intimacyEventDbPath, HALF_LIFE_DAYS
};
