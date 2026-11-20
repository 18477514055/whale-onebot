// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// ═══════════════════════════════════════════════════════════════════════
// local-overlay-bridge.js —— **注入点唯一会调用的那一层**
//
// ★ 为什么要有这一层（而不是把逻辑直接写进注入的代码里）：
//   Loader 注入的代码活在**作者的类体内部**，那里只能写「调用」——
//   写多了就变成"又改了一遍他的文件"，升级照样要重放。
//   所有能写成普通函数的逻辑，全部住在这里（普通模块，随便改、随便测）。
//
// ★ 注入进去的代码一共只有 5 处、约 10 行，全部长这样：
//     this.__local.toolCtx(this)
//     this.__local.promptExtras(this, { chatKey, triggerEntries })
//     this.__local.maybeConsolidateEpisodes(this, chatKey, (m) => this.#memoryChat(m))
//     createLocalBridge(this)
//     import ...
//   ⇒ 作者改他方法体的任何其他部分，这些调用**一个字都不用改**。
//
// ★ 私有方法的处理（本文件最需要看懂的一段）：
//   `#maybeConsolidateEpisodes` 这类**不能**在类外部定义。所以这里不定义它，
//   接受调用方把「写 #memoryChat 的那个箭头函数」作为参数传进来 ——
//   箭头函数在类体内创建 ⇒ 能访问私有方法；我们这里只管用。
// ═══════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { normalizeCannedReplies } from '../features/canned-replies.js';
import { EpisodeStore } from '../memory/episodes.js';
import { consolidateEpisodesOnce, episodeOptions, ensureEpisodeStore } from '../memory/local-episodes.js';
import { buildRecallText, makeRelationalFor } from '../memory/local-recall.js';
// ★ 2026-10-29：亲密度打分的「时机闸门」。
//   用户明确要求「一定要让模型主动打分，但不要经常打；定时不可靠，因为电脑不常开」。
//   ⇒ 不用定时器，用「攒够量 + 拉开间隔」双闸门（与 episodes 整理同一套思路）。
import {
  scoringOptions, shouldPrompt, gateState, markPrompted
} from '../features/intimacy-gate.js';
// ★ 2026-10-30：我们自己的心情引擎（上游那套已用配置关掉，见 mood-engine.js 顶部说明）。
import { moodPrompt } from '../features/mood-engine.js';

/** 每个 Orchestrator 实例的私有状态（挂在 orch.__local 上）。 */
const STATE = new WeakMap();

/**
 * 构造时调用一次：把事件库、冷却表挂上去。
 * ★ 任何异常都必须被吞掉 —— 我们绝不能让作者的对象构造失败。
 */
export function createLocalBridge(orch) {
  const state = {
    episodes: null,
    episodesFailed: false,
    consolidatingEpisodes: new Set(),
    recallCooldown: new Map()
  };
  try {
    state.episodes = ensureEpisodeStore(null, { failedRef: { value: false } });
    // 传进去的 failedRef 是值拷贝，把真实结果同步回来
    if (!state.episodes) state.episodesFailed = true;
  } catch (error) {
    state.episodesFailed = true;
    console.warn('[local-overlay] 事件记忆库打不开，本进程不再重试:', error?.message ?? error);
  }
  STATE.set(orch, state);

  return {
    /** 工具 ctx 要用的那几个字段（见下）。 */
    toolCtx: (o) => toolCtxOf(o),
    /** userPrompt 里要带的两段。 */
    promptExtras: (o, args) => promptExtrasOf(o, args),
    /** 事件记忆整理。memoryChat 由调用方从类体内传进来。 */
    maybeConsolidateEpisodes: (o, chatKey, memoryChat) => maybeConsolidate(o, chatKey, memoryChat),
    /** 供调试/验收用。 */
    state: () => STATE.get(orch)
  };
}

function stateOf(orch) {
  let s = STATE.get(orch);
  if (!s) {
    // 极端情况：构造时注入没生效（比如作者挪了构造锚点），这里补建一份
    s = { episodes: null, episodesFailed: false, consolidatingEpisodes: new Set(), recallCooldown: new Map() };
    try { s.episodes = ensureEpisodeStore(null, { failedRef: { value: false } }); } catch { s.episodesFailed = true; }
    STATE.set(orch, s);
  }
  return s;
}

// ── ⑤ 工具 ctx ───────────────────────────────────────────────────────────
// ★ 为什么不写死绝对路径：换部署目录 / 换 QQ_AGENT_DATA_DIR 就废了。
//   一律从 DATA_DIR 推导，与作者自己的存储同源。
export function toolCtxOf(orch) {
  const st = stateOf(orch);
  return {
    memoryPaths: {
      dataDir: DATA_DIR,
      messagesDbPath: path.join(DATA_DIR, 'messages.sqlite'),
      relationshipDbPath: path.join(DATA_DIR, 'relationship-pilot.sqlite'),
      peopleDir: path.join(DATA_DIR, 'memory', 'people')
    },
    // ★ 作者 v0.9.10 配置里**没有 cannedReplies 这个键**（那是我们自建的），
    //   所以绝不能假设它存在 —— 一律归一化，缺了就当空数组。
    cannedRules: () => {
      try {
        const raw = getConfig()?.cannedReplies?.rules;
        if (!Array.isArray(raw) || !raw.length) return [];
        return normalizeCannedReplies(raw);
      } catch { return []; }
    },
    // ★ 必须与提示词里【最近的事】**同一个实例**，否则模型会看到两套互不一致的旧事
    episodes: st.episodes
  };
}

// ── ④ userPrompt 的两段 ──────────────────────────────────────────────────
export async function promptExtrasOf(orch, { chatKey, triggerEntries } = {}) {
  const st = stateOf(orch);
  const cfg = getConfig();

  // 【想起来了】：只在这一轮**真的聊到记忆**时才捞（关键词闸门在 buildRecallText 里）。
  const proactiveRecallText = await buildRecallText({
    chatKey,
    triggerEntries,
    episodes: st.episodes,
    recallCfg: cfg.memory?.proactiveRecall || {},
    cooldown: st.recallCooldown
  });

  // 【我们之间】：交给 prompt.js 在它算完 relevantUserIds 之后再回调 ——
  //   这里先算会重复一遍筛选，还可能把模型根本看不到的人注进去。
  // ★ 2026-10-29：这段现在含三层（关系史 + 里程碑 + 近况），见 local-recall.js 顶部。
  //   全部本地只读查询，不额外发起 LLM 调用。
  const relationalFor = makeRelationalFor({
    chatKey,
    selfId: cfg.onebot?.selfId || orch.onebot?.selfId || '',
    memory: orch.memory,
    milestones: cfg.memory?.milestones !== false,
    statuses: cfg.memory?.personStatus !== false
  });

  // ★ 2026-10-29：亲密度打分提示（只在闸门真的到点时才产生文字，其余轮次返回空串）。
  //   见 features/intimacy-gate.js 顶部：为什么不用定时、三档阈值怎么定。
  const scoringPromptText = buildScoringPrompt(orch, chatKey, triggerEntries);

  // ★ 2026-10-30：我们自己的心情状态（关掉了上游那套，见 features/mood-engine.js 顶部）。
  //   ★ 为什么放**最后**：前面几段相对稳定，这段每小时才变一次，
  //     但它仍然是"动态内容"，排在最后可以把前缀缓存的损失压到最小。
  //   ★ 关闭时返回空串 ⇒ 提示词与未启用时逐字一致。
  let moodPromptText = '';
  try {
    moodPromptText = moodPrompt(DATA_DIR, chatKey);
  } catch { /* 心情是增强项，取不到就当没有 */ }

  return { proactiveRecallText, relationalFor, scoringPromptText, moodPromptText };
}

/**
 * 组装「该给这几个人打分了」的提示段。
 *
 * ★ 只在闸门到点时返回非空 —— 这一点非常重要：
 *   promptExtras 会注入到**用户提示词**里（动态内容），每轮都变会让前缀缓存失效。
 *   所以它必须稀有。绝大多数轮次这里返回 ''，提示词保持稳定。
 *
 * ★ 不在提示里给模型看"现在几分" —— 那会诱导它为了让分数好看而记事件。
 *   只说"最近谁做了什么值得记一下"，让它就事论事。
 */
function buildScoringPrompt(orch, chatKey, triggerEntries = []) {
  try {
    const st = stateOf(orch);
    if (st.scoringDisabled) return '';
    const cfg = getConfig();
    const opts = scoringOptions(cfg);

    // ★ 本轮有多少条新消息
    const batchSize = Array.isArray(triggerEntries) ? triggerEntries.filter((m) => !m?.self).length : 0;
    if (!batchSize) return '';

    const state = gateState(DATA_DIR, chatKey);

    // ★★★ 关键：用**累计口径**判断，不是本轮批大小。
    //   第一版直接用 batchSize ⇒ "一天 10 轮、每轮 50 条"会 10 轮全触发（实测抓到）。
    //   现在累计「自上次提示以来攒了多少条」，提示后清零。
    //   ★ 跨重启安全：lastMessageId 存在 sqlite 里，重启后靠它算出"上次提示之后又来了多少条"。
    const sinceId = Number(state.lastMessageId) || 0;
    let pendingAccum = batchSize;
    try {
      // 用消息库现成的方法数一下（只 count，不拉内容）
      const rows = orch.store.recent(chatKey, { afterId: sinceId, limit: 2000 }) || [];
      const fresh = rows.filter((m) => !m?.self).length;
      // 取两者较大值：消息库更权威；取不到就退回"本轮批大小"
      pendingAccum = Math.max(batchSize, fresh);
    } catch { /* 查库失败就退回 batchSize，最坏是少提示一次 */ }

    const verdict = shouldPrompt(chatKey, {
      pendingCount: pendingAccum,
      lastPromptAt: state.lastPromptAt,
      opts
    });
    if (!verdict.due) return '';

    // 到点了：取最近说话的人（最多 N 个），让模型"就这些人"判断
    const n = opts.maxPeopleInPrompt;
    const seen = new Map();
    for (const m of [...(triggerEntries || [])].reverse()) {
      const id = String(m?.senderId || '').trim();
      if (!id || /^\d{5,15}$/.test(id) === false) continue;
      if (m?.self) continue;
      if (!seen.has(id)) seen.set(id, String(m?.senderName || id).slice(0, 20));
      if (seen.size >= n) break;
    }
    if (!seen.size) return '';

    const who = [...seen.entries()].map(([id, name]) => `${name}(${id})`).join('、');

    // 记一次"提示过了" —— 必须在返回非空之后立刻落盘，
    // 否则同一个群在下一轮又会满足闸门（消息数没变、间隔也没变）。
    markPrompted(DATA_DIR, chatKey, {
      lastMessageId: Number(triggerEntries?.[triggerEntries.length - 1]?.id) || 0,
      profile: verdict.profile
    });

    return [
      '',
      '【顺手记一笔印象】',
      `- 刚才这一批聊得比较多，如果**确实**看出了谁做了什么值得记的事，可以用 mark_event 记下来：${who}`,
      '- 只记你**真的有依据**的（谁帮了忙、谁说了难听的话、谁聊得特别投机），**没看出什么就别硬记**。',
      '- 同一天同类型只算一次，所以你不用怕记重；但也别为了凑数把小事说成大事件。',
      '- 这件事不用告诉群友，也不要提"打分""亲密度"这类词。'
    ].join('\n');
  } catch {
    // 任何异常都吞掉：打分提示是"锦上添花"，绝不能因为它让正常回复失败
    return '';
  }
}

// ── ③ 事件记忆整理 ───────────────────────────────────────────────────────
export function maybeConsolidate(orch, chatKey, memoryChat) {
  try {
    const st = stateOf(orch);
    if (!st.episodes) return;
    const cfg = getConfig();
    const opt = episodeOptions();
    if (!opt.enabled) return;
    // 设置里关掉"记忆自动整理"时，事件整理也一起停 —— 同一个开关的语义
    if (cfg.memory?.consolidateEnabled === false) return;
    if (orch.paused || orch.aborted) return;
    if (!cfg.api?.model || !cfg.api?.baseUrl) return;
    if (st.consolidatingEpisodes.has(chatKey)) return;

    const s = st.episodes.state(chatKey);
    if (Date.now() - (Number(s.lastConsolidatedAt) || 0) < opt.consolidateMinIntervalMs) return;
    // 只读「刚好够触发」的几行，判断值不值得跑 —— 不把整段历史拉进内存
    const pending = orch.store.recent(chatKey, {
      afterId: Number(s.lastMessageId) || 0,
      limit: opt.minNewMessages
    });
    if ((pending?.length || 0) < opt.minNewMessages) return;

    st.consolidatingEpisodes.add(chatKey);
    console.log(`[episodes] 开始整理 ${chatKey}：待处理 ${pending.length} 条`);
    // ★ 不自己写整理逻辑，调 local-episodes.js 的唯一入口
    Promise.resolve()
      .then(() => consolidateEpisodesOnce({
        store: orch.store,
        episodes: st.episodes,
        chatKey,
        memoryChat,
        getChatName: (groupId) => orch.getChatName?.(groupId) || '',
        assertAllowed: () => {},
        // ★ 2026-10-29：身份解析要用消息库与别名库（昵称→QQ、事件绑人）。
        //   路径从 DATA_DIR 推，与作者存储同源 —— 绝不在这里写死绝对路径。
        messagesDbPath: path.join(DATA_DIR, 'messages.sqlite'),
        identityDbPath: path.join(DATA_DIR, 'identity-pilot.sqlite')
      }))
      .then((r) => console.log(`[episodes] 整理完成 ${chatKey}：${r?.note || ''}`))
      .catch((error) => console.error(`[episodes] 整理 ${chatKey} 失败:`, error?.message ?? error))
      .finally(() => st.consolidatingEpisodes.delete(chatKey));
  } catch (error) {
    console.error('[episodes] 整理检查出错:', error?.message ?? error);
  }
}

/** 供验收脚本直接用。 */
export function localStateOf(orch) { return stateOf(orch); }
