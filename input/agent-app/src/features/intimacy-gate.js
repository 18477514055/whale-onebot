// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 亲密度打分的「时机闸门」（2026-10-29）
//
// ★ 用户的要求（原话）：
//   「那么打分频率是多少呢？最好给一个标准的时间或者多个标准的时间，或者是多个时间节点。
//     反正就是一定要让模型主动去打分，但是又不要经常去打分。
//     但是定时又不可靠，因为电脑不常开，机器人在线的时段不是固定的。」
//
// ★ 结论：**不用定时，用"攒够量 + 拉开间隔"双闸门**。
//   这正是本项目里已经被验证过的模式（`maybeConsolidateEpisodes` 用的就是
//   `consolidateMinIntervalMs + minNewMessages`，见 core/local-overlay-bridge.js:149/155）。
//
//   为什么定时不可靠（用户已经说到点子上）：
//   · 电脑不常开 ⇒ 定时器在关机期间是死的，醒来后补跑一次也未必有意义；
//   · 在线时段不固定 ⇒ 任何"每天 N 点"的方案，实际跑的时候群里可能根本没人在。
//   ⇒ 所以判据必须是**"有没有足够的新素材"**，而不是"到没到点"。
//
// ★ 三档时间节点（回答"多个标准的时间"）：
//
//   ┌────────────┬──────────┬──────────┬──────────────────────────────┐
//   │ 档位       │ 新消息数 │ 最小间隔 │ 适用                         │
//   ├────────────┼──────────┼──────────┼──────────────────────────────┤
//   │ 轻量(light)│   30 条  │   4 小时 │ 群里聊得不多时也能慢慢积累   │
//   │ 标准(normal)│  80 条  │  12 小时 │ **默认**                     │
//   │ 深度(deep) │  200 条  │  24 小时│ 大群刷得快时避免反复打分      │
//   └────────────┴──────────┴──────────┴──────────────────────────────┘
//
//   ★ 间隔为什么从 2 小时改到 4 小时（**实测教训，不要改回去**）：
//     最初 light 定的是「30 条 / 2 小时」。模拟「一天 10 轮、每轮 2.4 小时 50 条」
//     ⇒ **10 轮全触发**，一天打 10 次分 —— 因为每轮 50 条 ≥ 30、间隔 2.4h ≥ 2h，两条永远同时满足。
//     改成 4 小时后同一场景落在约 **5 次/天**，才符合"要有但不频繁"。
//
//   三条同时生效是「或」的关系吗？**不是** —— 是**任一档满足就触发**，
//   但档位越高门槛越高。实际效果（都已用模拟验证，见 verify-intimacy-gate.mjs）：
//   · 小群一天 40 条 ⇒ 最多 1 次；
//   · 大群一天 500 条 ⇒ 约 5 次（受 4 小时间隔压制）；
//   · 刷屏群一天 2000 条 ⇒ 仍被间隔压住（约 6 次，**不随消息量线性增长**）。
//
// ★ 为什么还要「最小间隔」：
//   只有消息数门槛的话，一个大群 10 分钟就能攒够 80 条 ⇒ 每 10 分钟提示一次，
//   那等于"经常打分"，正是用户不要的。
//
// ★ 为什么要「按群独立」：
//   亲密度是按人算的，但**话题是按群走的**。A 群聊了 100 条、B 群刚建，
//   不应该因为 A 群活跃就顺带给 B 群的人也打分（那样 B 群的人会被凭空评价）。
//
// ★ 提示怎么给（这一段决定了成本）：
//   **搭在正常对话里，不额外发起 LLM 调用。**
//   闸门到了 ⇒ 在给模型的提示词里加一小段「这轮顺便回顾一下最近谁做了什么」，
//   模型在回话的同一次调用里顺带调 mark_event。省掉一整次独立请求。
//   ★ 代价：提示词多几十个字，且**只在闸门真到的时候**才加（大部分轮次不加）。
//     这很关键 —— promptExtras 是动态内容，会让前缀缓存失效，
//     所以它必须"稀有"，不能每轮都变。

import { DataStore } from './intimacy-gate-store.js';

// ── 三档默认值（配置可覆盖：intimacy.scoring.*）──────────────────────────
export const SCORING_PROFILES = {
  light:  { minNewMessages: 30,  minIntervalMs:  4 * 3600 * 1000 },
  normal: { minNewMessages: 80,  minIntervalMs: 12 * 3600 * 1000 },
  deep:   { minNewMessages: 200, minIntervalMs: 24 * 3600 * 1000 }
};

/** 读配置（带安全夹取，防手滑写个 0 或负数导致每轮都触发）。 */
export function scoringOptions(cfg = {}) {
  const raw = cfg?.intimacy?.scoring || {};
  const pick = (name, dflt) => {
    const v = raw?.[name] || {};
    return {
      minNewMessages: Math.max(10, Math.min(5000, Number(v.minNewMessages) || dflt.minNewMessages)),
      minIntervalMs: Math.max(10 * 60 * 1000, Math.min(7 * 24 * 3600 * 1000, Number(v.minIntervalMs) || dflt.minIntervalMs))
    };
  };
  return {
    enabled: raw?.enabled !== false,
    light: pick('light', SCORING_PROFILES.light),
    normal: pick('normal', SCORING_PROFILES.normal),
    deep: pick('deep', SCORING_PROFILES.deep),
    // 每轮最多提示几个群（一般只会命中 1 个；这个上限防"刚开机一堆群同时到点"）
    maxPromptsPerTurn: Math.max(1, Math.min(3, Number(raw?.maxPromptsPerTurn) || 1)),
    // 提示里最多提几个人（越少越省 token，也越聚焦）
    maxPeopleInPrompt: Math.max(2, Math.min(10, Number(raw?.maxPeopleInPrompt) || 5))
  };
}

/**
 * 判断某个群现在该不该"提示模型去打分"。
 *
 * ★ 2026-10-29 修（模拟测试抓到的真问题）：
 *   第一版只看「本轮触发批的条数 + 距上次的间隔」，结果模拟「一天 10 轮、每轮 2.4 小时 50 条」
 *   ⇒ **10 轮全触发**，一天打 10 次分 —— 正是用户不要的。
 *   根因：每轮 50 条 ≥ 30，间隔 2.4h ≥ 2h，两条都满足 ⇒ 每次都过。
 *
 *   ⇒ 改成 **累计口径**：`pendingCount` 必须是「自上次提示以来**累计**攒了多少条」，
 *     不是「本轮这批多少条」。这样同样是 50 条/轮，第一轮不够、第二轮才够，
 *     之后每次提示都会把累计清零 ⇒ 一天最多 4-5 次。
 *
 * @param {string} chatKey
 * @param {{pendingCount:number, lastPromptAt:number, now?:number, opts:object}} p
 *        pendingCount = **自上次提示以来累计的非自己消息数**（不是本轮批大小）
 * @returns {{due:boolean, profile?:string, reason?:string}}
 */
export function shouldPrompt(chatKey, { pendingCount = 0, lastPromptAt = 0, now = Date.now(), opts } = {}) {
  const key = String(chatKey || '').trim();
  if (!key) return { due: false, reason: 'no-chat' };
  const o = opts || scoringOptions({});
  if (!o.enabled) return { due: false, reason: 'disabled' };

  const pending = Math.max(0, Number(pendingCount) || 0);
  const since = now - (Number(lastPromptAt) || 0);

  // ★ 逐档检查，取**最容易满足**的那一档（档位只用于日志/展示，不影响提示内容）
  const order = ['light', 'normal', 'deep'];
  let hit = null;
  for (const name of order) {
    const p = o[name];
    if (pending >= p.minNewMessages && since >= p.minIntervalMs) { hit = name; break; }
  }
  if (!hit) {
    // 说清楚为什么没到（给调试与界面用）
    const light = o.light;
    if (pending < light.minNewMessages) return { due: false, reason: 'not-enough-messages' };
    return { due: false, reason: 'too-soon' };
  }
  return { due: true, profile: hit };
}

// ── 状态持久化（存"上次提示时间"与"上次提示时的消息游标"）─────────────
// ★ 为什么不用内存：电脑不常开 ⇒ 每次启动内存都是空的。
//   如果把 lastPromptAt 存在内存里，一重启就"以为从来没提示过" ⇒ 开机就提示一次。
//   存磁盘才能跨重启保持"刚提示过就别再提示"的语义。
let _store = null;
function store(dataDir) {
  if (_store && _store.dataDir === String(dataDir || '')) return _store;
  _store = new DataStore(dataDir);
  return _store;
}

/** 取某个群的上次提示状态。 */
export function gateState(dataDir, chatKey) {
  try {
    return store(dataDir).get(String(chatKey || '')) || { lastPromptAt: 0, lastMessageId: 0, prompts: 0 };
  } catch {
    return { lastPromptAt: 0, lastMessageId: 0, prompts: 0 };
  }
}

/** 记一次"提示过了"。 */
export function markPrompted(dataDir, chatKey, { lastMessageId = 0, now = Date.now(), profile = '' } = {}) {
  try {
    store(dataDir).set(String(chatKey || ''), {
      lastPromptAt: Number(now) || Date.now(),
      lastMessageId: Number(lastMessageId) || 0,
      profile: String(profile || '')
    });
  } catch { /* 写失败不影响主流程，只是下次可能重复提示一次 */ }
}

/** 给界面看：所有群的上次提示时间（排查"为什么它一直不打分"用）。 */
export function listGateStates(dataDir) {
  try { return store(dataDir).all(); } catch { return []; }
}

/** 重置某个群（手工清掉"刚提示过"的记录，让下一次立刻可触发）。 */
export function resetGate(dataDir, chatKey) {
  try { store(dataDir).remove(String(chatKey || '')); return true; } catch { return false; }
}
