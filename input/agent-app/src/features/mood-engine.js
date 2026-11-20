// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// ═══════════════════════════════════════════════════════════════════════
// mood-engine.js —— 心情引擎（2026-10-30）
//
// ★★★ 为什么自己做一套，而不是改上游的 `src/core/persona-state.js`：
//
//   用户原话：「我感觉他们的心情系统挺简单的，而且基本不影响……
//              主要是我认为他可以绑定亲密度和事件——然后影响他的说话和行为。
//              而如果绑定亲密度和事件系统的话，又会牵涉到我自己做的亲密度和记忆库，
//              所以我觉得我单独做一个，把上游的心情系统给它关掉或者是不冲突的话，留着也行。」
//
//   ⇒ 决策：**关掉上游，自己做**。三条理由：
//     ① 上游那套要绑的是**我们的**亲密度与事件层（`features/intimacy-*.js`），
//        把上游文件改成依赖我们的模块，等于每次作者升级都要重放一次改造；
//     ② 上游那套本身有硬伤（实测：energy 每天净 +18.6 ⇒ 永远 100；
//        mood 每天净 −3.15 而互动 3 次就持平 ⇒ 永远 100。「心情」事实上是死的）；
//     ③ 关掉只要一个配置开关，零侵入：`humanize.personaState.enabled = false`。
//        上游所有入口（`personaStatePrompt` / `notePersonaInteraction`）第一句就是
//        `if (!enabled() ...) return`，关掉即整条链路不碰 —— 实测确认过。
//
// ★★★ 与上游的三条根本差异（这就是"不简单"的地方）：
//
//   **差异 1：心情有"来源"，而且是可归因的**
//     上游：只看钟点（醒着跌、睡着涨），被人骂和被夸一模一样。
//     我们：**三源驱动** ——
//       · 事件源（主）：亲密度事件层的 18 种事件 → 每种有自己的情绪冲击
//       · 亲密度源：熟的人说话让人舒服，陌生人的高强度互动更容易烦
//       · 钟点源：只作为**基线回归**，不再主导
//
//   **差异 2：不会锁死在边界**
//     上游：没有回归项 ⇒ 顶到 100 就永远 100。
//     我们：每小时向基线回归 3%（`v += (base - v) * 0.03`），
//           ⇒ 任何冲击都会**自然平复**，不会留下永久烙印，也不会卡死在端点。
//           ★ 这是"情绪"和"状态值"的区别：情绪会过去，状态值不会。
//
//   **差异 3：真的影响行为（不是只塞一句话）**
//     上游：往提示词里塞一句「心情挺好」，模型看不看无所谓。
//     我们：把心情翻译成**四条可执行的行为约束**（说话长度 / 主动程度 / 语气 / 是否接梗），
//           并且在**很累或很烦**时主动降低参与意愿（`participationFactor`）。
//
// ★★★ 刻度纪律（改之前先读，这是整个系统的"尺子"）：
//   两个维度都归一化到 **0–100**（不再是上游的 energy 0–100 / mood −100–100 混用）：
//     · `energy`（精力）：0 = 完全耗尽，100 = 精神饱满。基线 65。
//     · `mood`（心情）：0 = 极差，50 = 平静（**基线**），100 = 极好。基线 50。
//   ⇒ 两个都是 0–100、都有同一套回归，代码里不用再记"这个 0 到 100、那个 −100 到 100"。
//
// ★ 铁律：本模块**绝不抛异常出去**。心情是增强项，
//   读不到/写不进就退回默认值，聊天必须照常（与上游同一条纪律）。
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../core/config.js';
import { minuteOfDayInZone } from '../core/util.js';

// ═══════════════════════════════════════════════════════════════════════
// ★★★ 2026-10-30 第二次改造：从"单层按群"改成**双层**
//
// 用户原话：「心情的话，能不能同时被多个群影响，并且同时反馈到多个群，
//            但是每个群又有相对的独立性？然后如果问到他为什么心情这么好/这么差/
//            这么累/这么活跃，那么机器人可以说一句在另外一个群或者在哪里遇到了什么事，
//            但是不用牵涉到具体情况。这样子的话才更像是一个真人。」
//
// ★ 这三句话定义了**三层语义**，必须分清（第一版只做了第 2 层，所以不对）：
//
//   ① **全局基础心情（base）**：她这个人的"底子"。
//      任何一个群发生的事都会影响它 ⇒ **被多个群影响**；
//      它又出现在每个群的最终心情里 ⇒ **反馈到多个群**。
//
//   ② **每群局部偏移（local）**：在这个群刚发生的事造成的短期波动。
//      ⇒ 这提供"相对的独立性"：在本群被夸，本群会更高兴一点，
//        但别的群只是通过 base 感受到一点点余温，不会同样高兴。
//
//   ③ **最终心情 = base + local 的加权**（local 有上限，不能盖过 base）：
//
//        final.energy = clamp(base.energy + local.energy * LOCAL_WEIGHT)
//        final.mood   = clamp(base.mood   + local.mood   * LOCAL_WEIGHT)
//
//      LOCAL_WEIGHT = 0.6：局部偏移最多贡献 ±60% 的相对量，
//      且 local 自身也被限制在 ±25 分内 ⇒ 单群很难把整体心情彻底带偏。
//
// ★★★ 事件冲击的分配比例（`GLOBAL_SHARE`）：
//      每次事件 → 全局 base 拿 65%、本群 local 拿 35%。
//   · 为什么全局拿大头：用户要的是"同时被多个群影响、同时反馈到多个群"，
//     全局占大头才有"整体状态"的感觉；否则每个群各自为政，又退回第一版。
//   · 为什么本群也拿一份：这样"在这个群刚被骂"会**立刻**在这个群体现得更明显，
//     而不是要等全局慢慢变 —— 那正是"相对独立性"。
//
// ★★★ 归因（用户第二句话）：被问"你怎么心情这么好/这么差/这么累"时，
//   要能说一句"在另一个地方遇到点事"，但**不说具体内容**。
//   ⇒ 我们记录**最近影响的来源群**（`mood_log.scope` + 一张 `mood_origin` 表只存
//     "哪个 scope 影响过、什么时候、朝哪个方向、大概什么类型的事"），
//     **绝不记录人名、原话、具体事件内容**。
//   ⇒ 渲染时只给"方向 + 模糊地点"（"另一个群""别的地方"），且**当前群自己的事不说成别处**。
// ═══════════════════════════════════════════════════════════════════════

const DB_NAME = 'mood-engine.sqlite';
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/** 每次事件冲击分配给全局 base 的比例（其余给本群 local）。 */
export const GLOBAL_SHARE = 0.65;

/** 本群局部偏移在最终心情里的权重。 */
export const LOCAL_WEIGHT = 0.6;

/** 局部偏移的绝对值上限（防止单群把整体带偏）。 */
export const LOCAL_CAP = 25;

const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

/** 精力/心情的基线：任何冲击都会往这里回归。 */
export const BASELINE = { energy: 65, mood: 50 };

/** 每小时向基线回归的比例（3% ⇒ 半衰期约 23 小时）。 */
export const REGRESSION_PER_HOUR = 0.03;

/**
 * ★★★ 事件 → 情绪冲击表（唯一的折算真源）。
 *
 * 与 `features/intimacy-events.js` 的 `EVENT_KINDS` **一一对应**（那边 18 种）。
 * ★ 刻意与亲密度权重**不完全同号同比例**：
 *   亲密度衡量"关系深浅"（一次骚扰不会让关系崩），心情衡量"此刻的情绪"
 *   （被骚扰一次，当下就是会烦）。所以情绪冲击可以比亲密度权重更陡。
 * ★ 精力那一列：**深入聊天最耗精力**（deep_talk −6），而收到关心反而回一点（care +1）。
 *   这是刻意的不对称 —— 真人聊天就是这样。
 */
export const MOOD_IMPACTS = {
  // ── 正面 ────────────────────────────────────────────────────────────
  defend:    { mood: +8,  energy: -1.0, label: '维护我/维护群友' },
  deep_talk: { mood: +6,  energy: -6.0, label: '深入聊天' },
  care:      { mood: +5,  energy: +1.0, label: '关心' },
  praise:    { mood: +5,  energy: +0.5, label: '夸奖/感谢' },
  help:      { mood: +4,  energy: -1.0, label: '帮忙' },
  humor:     { mood: +3,  energy: -0.5, label: '一起玩梗' },
  share:     { mood: +3,  energy: -0.5, label: '分享好东西' },
  // ── 负面 ────────────────────────────────────────────────────────────
  harass:    { mood: -15, energy: -4.0, label: '骚扰/纠缠' },
  insult:    { mood: -12, energy: -2.0, label: '辱骂/人身攻击' },
  troll:     { mood: -8,  energy: -2.0, label: '恶意挑事' },
  politics:  { mood: -8,  energy: -2.0, label: '引战/敏感话题' },
  ignore:    { mood: -4,  energy: 0,    label: '问了却不理会' },
  spam:      { mood: -3,  energy: -1.0, label: '刷屏/灌水' },
  annoy:     { mood: -2,  energy: -1.5, label: '反复拍打/打扰' },
  // ── 中性（保持表完整，不产生冲击；留着是为了"未知类型不报错"）───────
  chat:      { mood: 0,   energy: 0,    label: '普通聊天' },
  greet:     { mood: 0,   energy: 0,    label: '打招呼' },
  question:  { mood: 0,   energy: 0,    label: '提问' },
  met:       { mood: 0,   energy: 0,    label: '初次见' }
};

/** 亲密度 → 冲击倍率（越熟，正面事件越暖、负面事件越"扎心"）。 */
export function intimacyMultiplier(intimacyScore) {
  const s = clamp(intimacyScore, 0, 100);
  // 陌生(0) ⇒ 0.7（不太往心里去）；很熟(100) ⇒ 1.4（一句话就能影响一整天）
  return Math.round((0.7 + (s / 100) * 0.7) * 100) / 100;
}

// ── 存储 ─────────────────────────────────────────────────────────────────
function openDb(dataDir) {
  const dir = String(dataDir || '').trim();
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(dir, DB_NAME));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=3000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS mood (
        scope      TEXT PRIMARY KEY,   -- 'global' = 全局基础；'group:xxx' = 该群的局部偏移
        energy     REAL NOT NULL,
        mood       REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        saved_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mood_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        scope     TEXT NOT NULL,
        kind      TEXT NOT NULL,
        uin       TEXT NOT NULL DEFAULT '',
        d_mood    REAL NOT NULL DEFAULT 0,
        d_energy  REAL NOT NULL DEFAULT 0,
        note      TEXT NOT NULL DEFAULT '',
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mood_log_ts ON mood_log(ts DESC);
      -- ★★★ 归因表：只记"哪个 scope 影响过、朝哪个方向、大概什么类型"，
      --   **绝不存人名、原话、具体事件内容**（用户明确要求"不用牵涉到具体情况"）。
      CREATE TABLE IF NOT EXISTS mood_origin (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        scope    TEXT NOT NULL,          -- 影响力来自哪个群（只到群粒度）
        affect   TEXT NOT NULL,          -- 'up' | 'down' | 'tiring'
        kind     TEXT NOT NULL,          -- 事件类型（粗粒度，不含内容）
        strength REAL NOT NULL DEFAULT 0,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mood_origin_ts ON mood_origin(ts DESC);
    `);
    return db;
  } catch {
    return null;
  }
}

/**
 * scope：给了 chatKey 就按群，否则全局。
 *
 * ★★ 2026-10-30 修（实测踩到）：第一版对不合法的 chatKey（如 `group:A`）**静默退回 global**
 *   ⇒ 两个群可能都落到 global 上，看起来"串了"，而调用方完全不知道。
 *   ⇒ 现在：非法 chatKey **保留原样作为 scope**（只做长度/字符清洗），
 *     绝不悄悄合并到 global —— 合并意味着"两个群共用一份心情"，
 *     那正是要避免的事。类型非法是调用方的 bug，应该**看得见**而不是被吞掉。
 */
export function moodScopeOf(chatKey = '') {
  const k = String(chatKey || '').trim();
  if (!k) return 'global';
  // 合法形态：group:数字 / private:数字
  if (/^(group|private):\d+$/.test(k)) return k;
  // 其他情况：清洗成可作主键的串，但**保留区分度**（不合并到 global）
  const cleaned = k.replace(/[^\w:.-]/g, '_').slice(0, 80);
  return cleaned || 'global';
}

/** 睡眠窗口判定（沿用上游的语义：00:00–07:00）。 */
function sleepingNow(now) {
  const cfg = getConfig()?.humanize?.personaState || {};
  const start = String(cfg.sleepStart || '00:00');
  const end = String(cfg.sleepEnd || '07:00');
  const parse = (v, fb) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
    return m ? Number(m[1]) * 60 + Number(m[2]) : fb;
  };
  const s = parse(start, 0);
  const e = parse(end, 7 * 60);
  const minute = minuteOfDayInZone(now);
  if (s === e) return false;
  return s < e ? (minute >= s && minute < e) : (minute >= s || minute < e);
}

/**
 * 纯计算：从旧状态推进到 `now`（含回归 + 睡眠恢复）。便于单测，不写库。
 *
 * ★★★ 2026-10-30 修（第一版实测仍会顶到 100，等于没解决上游那个问题）：
 *   第一版只加了一项"向基线回归"，但**每小时的小时效应仍然净正**：
 *     睡着 7h：+6/h × 7 = +42，回归只拉回一部分
 *     醒着 17h：−3.5/h × 17 = −59.5
 *   一天净 ≈ −17.5，看起来应该下降 —— **但实测第 1 天就到 100**。
 *   原因：`Math.min(72, hours)` 把**第一次**推进的 hours 当成了 24（首次没有 updatedAt），
 *   24 小时按**当前时刻**的 sleeping 判定**整段**都算睡眠 ⇒ +144 ⇒ 直接顶格。
 *   ⇒ 两个修法（都必须）：
 *     ① **把跨越睡眠/清醒边界的时间按比例切开**，不能拿"此刻"的 sleeping 去乘整段时间；
 *     ② 首次（没有 updatedAt）**不推进**，直接给基线 —— 否则一次 24h 的虚拟"睡眠"就把表头写满。
 *
 * @returns {{energy:number, mood:number, sleeping:boolean, hours:number}}
 */
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-01 新增：精力 = 活跃度驱动（取代原来的"按钟表扣"）
//
// 【为什么要改 —— 用户原话】
//   「不是这个问题，是我机器人刚刚才启动。是相当于根本没有聊天，他也会消耗精力。」
//   「通过日志来判断机器人真正的活跃时间和不活跃时间…这个一整天是指从早上7点到第二天7点」
//   「如果机器人在一个小时内处理的消息较少，那么这个小时也算休息时间。
//     这样的话就避免我需要手动关闭机器人来恢复精力。我现在是设置机器人一天24小时开着的。」
//
// 【旧模型的两个硬伤】
//   ① 只要不在睡眠窗口（00:00-07:00）就恒定 −3.5/h，**与有没有聊天完全无关**
//      ⇒ 实测：无人说话 9.8 小时也掉 25.5 分
//   ② 只有晚睡能回血，白天没得回
//
// 【新模型】
//   工作量的**纯回溯**窗口（★ 绝不能用中心窗口 —— 那要看未来数据，运行到 t 时拿不到）：
//       窗口 = [now - W, now)，W = 15 分钟
//       工作量 = 0.3 × 处理条数(self=0) + 0.7 × 生成条数(self=1)
//      · "看"比"说"省力 ⇒ 处理权重低
//      · 实测三种口径：处理 13,226 / 生成 2,829 / 被点名 1,037（被点名只占处理 7.8%）
//
//   工作量 < 休息门槛 ⇒ 该分钟算**休息**，精力朝 CEILING 收敛；
//   否则按工作量强度扣分。
//
//   ★ 为什么休息用"上限收敛"而不是"+N/小时"：
//     机器人真实静默窗口长达 11 小时，如果 +8/h 会直接把表打满 100。
//     收敛式能精确停在 CEILING(85) —— 这才是"休息好之后 80 多"的实现方式。
//
// 【参数来自 96 组扫描，对齐用户给的目标分布】
//   正常六七十 / 休息好 80 多 / 聊久了 30-40 / 90+ 与 十几 都罕见
// ======================================================================

/** 回溯窗口（分钟）。★ 只看过去，因果可行。 */
export const ACTIVITY_WINDOW_MIN = 15;

/** 工作量 = 处理 × PROC + 生成 × GEN */
export const WORKLOAD_PROCESS_WEIGHT = 0.3;
export const WORKLOAD_GENERATE_WEIGHT = 0.7;

/** 休息判定门槛 = ref × 本系数。★ 必须用比例，不能用分位数（p10 会退化成 0）。 */
export const REST_THRESHOLD_RATIO = 0.03;

/** 休息时精力朝这个上限收敛。 */
export const ENERGY_CEILING = 85;

/** 休息收敛速率（每小时）。 */
export const REST_CONVERGE_PER_HOUR = 0.4;

/** 醒着时的消耗率（点/小时）：空闲 → 最忙。 */
export const DRAIN_IDLE_PER_HOUR = 0.3;
export const DRAIN_PEAK_PER_HOUR = 8.0;

/** 工作量满负荷基准。0 = 尚未标定（会自动用 p90 标定并缓存）。 */
export const WORKLOAD_REF_DEFAULT = 60;

let _wlRef = WORKLOAD_REF_DEFAULT;
let _wlRefAt = 0;
const WL_REF_TTL_MS = 30 * 60 * 1000;   // 30 分钟重标定一次

/**
 * 从 messages 表算「最近 W 分钟的工作量」。**纯回溯，不看未来。**
 * 失败一律返回 null（调用方退回旧模型），绝不影响主链路。
 */
export function recentWorkload(dataDir, now = Date.now()) {
  try {
    const dir = String(dataDir || '').trim();
    if (!dir) return null;
    const file = path.join(dir, 'messages.sqlite');
    if (!fs.existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const from = Number(now) - ACTIVITY_WINDOW_MIN * 60000;
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN self = 0 THEN 1 ELSE 0 END) AS proc,
          SUM(CASE WHEN self = 1 THEN 1 ELSE 0 END) AS gen
        FROM messages WHERE ts >= ? AND ts < ?
      `).get(from, Number(now));
      const proc = Number(row?.proc) || 0;
      const gen = Number(row?.gen) || 0;
      return {
        processed: proc,
        generated: gen,
        value: proc * WORKLOAD_PROCESS_WEIGHT + gen * WORKLOAD_GENERATE_WEIGHT,
        windowMin: ACTIVITY_WINDOW_MIN,
        from, to: Number(now)
      };
    } finally { try { db.close(); } catch { /* ignore */ } }
  } catch { return null; }
}

/**
 * 标定「满负荷基准」= 近 3 天工作量的 p90。
 * ★ 不写死数值：口径一变（权重/窗口），写死的基准会立刻失准。
 */
export function calibrateWorkloadRef(dataDir, now = Date.now()) {
  if (_wlRefAt && now - _wlRefAt < WL_REF_TTL_MS) return _wlRef;
  try {
    const dir = String(dataDir || '').trim();
    const file = dir ? path.join(dir, 'messages.sqlite') : '';
    if (!file || !fs.existsSync(file)) return _wlRef;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const since = Number(now) - 3 * DAY_MS;
      // 取近 3 天的消息，按 5 分钟粒度滑窗采样工作量
      const rows = db.prepare('SELECT ts, self FROM messages WHERE ts >= ? ORDER BY ts').all(since);
      if (rows.length < 50) return _wlRef;
      const procTs = [];
      const genTs = [];
      for (const r of rows) (Number(r.self) === 1 ? genTs : procTs).push(Number(r.ts));
      const lb = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
      const samples = [];
      const STEP = 5 * 60000;
      const W = ACTIVITY_WINDOW_MIN * 60000;
      for (let t = since + W; t <= now; t += STEP) {
        const p = lb(procTs, t) - lb(procTs, t - W);
        const g = lb(genTs, t) - lb(genTs, t - W);
        samples.push(p * WORKLOAD_PROCESS_WEIGHT + g * WORKLOAD_GENERATE_WEIGHT);
      }
      if (samples.length < 20) return _wlRef;
      samples.sort((a, b) => a - b);
      const p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
      _wlRef = Math.max(5, p90);
      _wlRefAt = Number(now);
      return _wlRef;
    } finally { try { db.close(); } catch { /* ignore */ } }
  } catch { return _wlRef; }
}

/**
 * 按活跃度推进精力。
 *
 * @param {number} energy   起始精力
 * @param {number} hours    经过的小时数
 * @param {object|null} wl  recentWorkload() 的结果；null ⇒ 退回旧模型
 * @param {number} ref      满负荷基准
 * @returns {{energy:number, resting:boolean, intensity:number, drain:number}}
 */
export function advanceEnergyByActivity(energy, hours, wl, ref) {
  if (!(hours > 0)) return { energy, resting: false, intensity: 0, drain: 0 };
  if (!wl) {
    // 退路：读不到消息库时按旧口径（醒着 −3.5/h）走，保证不炸
    return { energy: energy - 3.5 * hours, resting: false, intensity: 0, drain: 3.5 * hours };
  }
  const value = Number(wl.value) || 0;
  const refVal = Math.max(1, Number(ref) || WORKLOAD_REF_DEFAULT);
  const threshold = refVal * REST_THRESHOLD_RATIO;
  const resting = value < threshold;

  if (resting) {
    // 朝上限收敛（不是固定加成）—— 这样长时间休息会精确停在 CEILING
    const k = 1 - Math.pow(1 - REST_CONVERGE_PER_HOUR, hours);
    const next = energy + (ENERGY_CEILING - energy) * k;
    return { energy: next, resting: true, intensity: 0, drain: 0 };
  }
  const intensity = Math.min(1, value / refVal);
  const rate = DRAIN_IDLE_PER_HOUR + (DRAIN_PEAK_PER_HOUR - DRAIN_IDLE_PER_HOUR) * intensity;
  const drain = rate * hours;
  return { energy: energy - drain, resting: false, intensity, drain };
}

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-01 心情改造（用户授权）
//
// 【用户原话】
//   「这个心情你也顺手改一下吧，你认为该怎么改才科学，并且符合现在的情况。
//     我现在观测到的模型的心情变化并不大，一直保持在五十」
//   「可以考虑让他加深一点和精力系统的绑定，但是不用绑定太深，相对独立性还是要有的。
//     不过机器人的心情应该在30~70之间徘徊。」
//
// 【真因（不是算法，是输入）】
//   近 7 天有 1,134 次关键词可识别的情绪信号，mood_log 却只记录了 2 条 —— 采集率 0.18%。
//   原因：applyMoodImpact() 唯一调用点在 local-tools.js（模型主动调 record_event 才触发），
//   而模型 7 天只调了 2 次。心情系统是"被动等着被喂，而没人喂它"。
//   ⇒ 所以这次改造的核心是 **A：让消息流自动识别情绪**，不是调参数。
//
// 【五项改动】
//   A 自动识别：见 detectEmotion()（被 local-store 的消息入库回调调用）
//   B 回归加快：心情 REGRESSION 3%/h → 8%/h（半衰期 22.8h → 8.3h）
//     ★ 精力仍保留 3%（用户没要求动它，别顺手改）
//   C 昼夜基线：BASELINE.mood 由常数 50 → 46~54 随小时余弦变化
//   D 精力耦合：心情被精力**单向**弱牵引，权重 0.12/h
//     · 量化：精力 30 时每小时只把心情拉低 0.065 点，一天最多 ±1.6 点
//     · **故意不做反方向**（心情不反过来影响精力），避免正反馈
//   E 软边界：30~70；越界以 0.6/h 压回；硬边界 18~82
// ======================================================================

/** B：心情的回归速率（每小时）。★ 精力仍用 REGRESSION_PER_HOUR(3%)，两者独立。 */
export const MOOD_REGRESSION_PER_HOUR = 0.08;

/** C：昼夜基线（余弦插值，最低点在 03-06 点）。 */
export const MOOD_BASELINE_NIGHT = 46;
export const MOOD_BASELINE_DAY = 54;

/** D：精力对心情的单向牵引权重。★ 只给 0.12 —— "不用绑定太深"。 */
export const MOOD_ENERGY_LINK = 0.12;

/** E：软边界与硬边界。 */
export const MOOD_SOFT_LO = 30;
export const MOOD_SOFT_HI = 70;
export const MOOD_SOFT_PULL_PER_HOUR = 0.6;
export const MOOD_HARD_LO = 18;
export const MOOD_HARD_HI = 82;

/**
 * ★ 2026-11-01 新增：一次情绪冲击折算成的时间跨度（小时）。
 *
 * 为什么是 2 小时：这是实测调出来的。
 *   软边界的压回量 = 越界部分 × SOFT_PULL_PER_HOUR × HOURS。
 *   若 HOURS 取"真实的瞬时跨度"（10 分钟），压回力太弱 ——
 *   连续 praise 仍能把心情推到 81.7；取 2 小时则三种冲击强度下 100 次连续冲击都稳在 70 以内
 *   （praise+1.3→69.8 / humor+2.0→69.7 / 重度+3.0→69.5），
 *   而低频场景（30 分钟一次）仍能自由起伏到 69 左右，不呆板。
 *
 * 语义解释：不是"冲击真的耗时 2 小时"，而是"一次冲击给心情的推动量，
 *   相当于在越界区待了 2 小时所积累的压回力" —— 这是一个**等效阻尼系数**。
 */
export const SOFT_IMPACT_HOURS = 2;

/**
 * ★ 2026-11-01 新增：冲击后的软边界修正。
 *
 * 为什么需要：软边界原本只写在 advanceMoodByDesign() 里，而它**只在时间推进时**被调用。
 * applyMoodImpact() 走的是 `clamp(base + dMood, 0, 100)` —— **直接加，不过软边界**。
 * 实测后果：群里的 praise/humor 连续不断，心情被一路推到 **78**（用户要求 30~70）。
 *
 * 语义与 advanceMoodByDesign 完全一致：不是硬夹断（那会让心情永远撞天花板），
 * 而是"越接近边界阻力越大"——边界内不动，越界部分按 SOFT_PULL/h 压回。
 * 最后仍用硬边界兜底。
 */
export function softBoundAfterImpact(m) {
  let v = Number(m) || 0;
  if (v < MOOD_SOFT_LO) v += (MOOD_SOFT_LO - v) * MOOD_SOFT_PULL_PER_HOUR * SOFT_IMPACT_HOURS;
  else if (v > MOOD_SOFT_HI) v += (MOOD_SOFT_HI - v) * MOOD_SOFT_PULL_PER_HOUR * SOFT_IMPACT_HOURS;
  return clamp(v, MOOD_HARD_LO, MOOD_HARD_HI);
}

/** 精力基线（用于算"精力偏离多少"，与 BASELINE.energy 同值但语义独立）。 */
const MOOD_ENERGY_REF = 65;

/**
 * C：按小时算心情基线。03 点最低(46)，15-18 点最高(54)。
 * ★ 用余弦而不是阶梯：避免"到点跳变"，也符合真人的渐变节律。
 */
export function moodBaselineAt(now = Date.now()) {
  try {
    const d = new Date(Number(now));
    const h = d.getHours() + d.getMinutes() / 60;
    const t = (h - 3 + 24) % 24;
    const w = 0.5 - 0.5 * Math.cos((t / 24) * 2 * Math.PI);
    return MOOD_BASELINE_NIGHT + (MOOD_BASELINE_DAY - MOOD_BASELINE_NIGHT) * w;
  } catch {
    return (MOOD_BASELINE_NIGHT + MOOD_BASELINE_DAY) / 2;
  }
}

// ── A：情绪识别 ────────────────────────────────────────────────────────
// ★ 词表与权重都是**按真实词频标定**过的（近 7 天实测）：
//   praise 253 次（最高频）⇒ 权重必须低，否则 39.4% 的时间会顶到 70 以上
export const EMOTION_RULES = [
  { kind: 'praise', delta: +2.0, words: ['厉害', '牛', '强', '棒', '优秀', '感谢', '谢谢', '多谢', '赞', '好评', '爱了', '喜欢你'] },
  { kind: 'humor', delta: +3.0, words: ['哈哈', 'hhh', '233', '笑死', '绷不住'] },
  { kind: 'care', delta: +4.0, words: ['辛苦了', '注意身体', '早点睡', '别累', '照顾好', '心疼'] },
  { kind: 'insult', delta: -10.0, words: ['傻逼', 'sb', '脑残', '垃圾', '废物', '去死', '弱智', '智障'] },
  { kind: 'annoy', delta: -2.5, words: ['闭嘴', '别说了', '烦死', '滚开', '别烦'] }
];

/** 每群每小时最多采纳几次（防刷屏群把心情打到端点）。 */
export const EMOTION_PER_CHAT_PER_HOUR = 3;

/** 同一小时内同类事件的效果递减：第 1/2/3 次 = 100%/50%/25%。 */
export function emotionDecay(nth) {
  return Math.pow(0.5, Math.max(0, Number(nth) || 0));
}

/**
 * A：从一条消息文本识别情绪事件。命中返回 {kind, delta}，否则 null。
 * ★ 纯函数、无 IO、无副作用 —— 供消息入库回调调用，失败也绝不会影响落库。
 */
export function detectEmotion(text) {
  try {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    for (const rule of EMOTION_RULES) {
      if (rule.words.some((w) => t.includes(w))) return { kind: rule.kind, delta: rule.delta };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * E+D+C+B 的合成：把心情推进 hours 小时。
 * @param {number} mood   起始心情
 * @param {number} hours  经过小时
 * @param {number} energy 当前精力（用于 D 的弱牵引）
 * @param {number} at     推进到的时间点（用于 C 的昼夜基线）
 */
export function advanceMoodByDesign(mood, hours, energy, at) {
  if (!(hours > 0)) return mood;
  let m = Number(mood) || 0;

  // B+C：向昼夜基线回归
  const base = moodBaselineAt(at);
  const k = 1 - Math.pow(1 - MOOD_REGRESSION_PER_HOUR, hours);
  m += (base - m) * k;

  // D：精力单向弱牵引（精力高于 65 带动心情升，反之降）
  const eDelta = ((Number(energy) || MOOD_ENERGY_REF) - MOOD_ENERGY_REF) / MOOD_ENERGY_REF;
  m += eDelta * MOOD_ENERGY_LINK * hours;

  // E：软边界压回（不是硬夹，保留越过一点点的空间）
  if (m < MOOD_SOFT_LO) m += (MOOD_SOFT_LO - m) * MOOD_SOFT_PULL_PER_HOUR * hours;
  else if (m > MOOD_SOFT_HI) m += (MOOD_SOFT_HI - m) * MOOD_SOFT_PULL_PER_HOUR * hours;

  // E：硬边界兜底
  return clamp(m, MOOD_HARD_LO, MOOD_HARD_HI);
}

export function advance(prev = {}, now = Date.now(), dataDir = '') {
  const hasPrev = Number(prev.updatedAt) > 0;
  const updatedAt = Number(prev.updatedAt) || now;
  // ★ 首次：不做任何时间推进（没有"过去"可言），直接基线。
  if (!hasPrev) {
    return {
      energy: Number.isFinite(Number(prev.energy)) ? Number(prev.energy) : BASELINE.energy,
      mood: Number.isFinite(Number(prev.mood)) ? Number(prev.mood) : BASELINE.mood,
      sleeping: sleepingNow(now),
      hours: 0,
      resting: false
    };
  }
  const hours = Math.min(72, Math.max(0, (now - updatedAt) / HOUR_MS));
  let energy = Number.isFinite(Number(prev.energy)) ? Number(prev.energy) : BASELINE.energy;
  let mood = Number.isFinite(Number(prev.mood)) ? Number(prev.mood) : BASELINE.mood;
  const sleeping = sleepingNow(now);
  let resting = false;

  if (hours > 0) {
    // ★★★ 2026-11-01 改：精力不再按钟表扣，改按**真实活跃度**
    //
    // ★★★ 关键：必须**按历史分段推进**，不能用"此刻的活跃度"乘整段时间。
    //   这不是新坑 —— 旧代码就栽在同一件事上（"用此刻的 sleeping 乘整段"⇒ 一次 24h 虚拟睡眠直接顶格）。
    //   实测反例：某次跨度 8 小时，此刻工作量刚好满负荷(ref) ⇒ 整段按 8/h 扣 ⇒ 60 分直接掉到 10.9。
    //   而真实情况是这 8 小时里有大段在休息。
    //
    //   做法：跨度 > STEP 时切成 STEP 大小的段，每段用**该段末尾那一刻**的历史窗口工作量。
    //   数据全在 messages 表里，历史时刻完全可以查 —— 纯回溯，不看未来。
    const ref = calibrateWorkloadRef(dataDir, now);
    const STEP_H = 10 / 60;                       // 10 分钟一段
    const spans = Math.max(1, Math.ceil(hours / STEP_H));
    const stepH = hours / spans;
    let moved = 0;
    for (let i = 0; i < spans; i += 1) {
      const tEnd = updatedAt + (now - updatedAt) * ((i + 1) / spans);
      // 该段末尾的历史工作量（纯回溯窗口 [tEnd-W, tEnd)）
      const wl = spans === 1 ? recentWorkload(dataDir, now) : recentWorkload(dataDir, tEnd);
      const r = advanceEnergyByActivity(energy, stepH, wl, ref);
      energy = r.energy;
      if (r.resting) resting = true;
      moved += 1;
    }

    // ── 心情：走新的设计（B 回归 + C 昼夜基线 + D 精力弱牵引 + E 软边界）──
    //   ★ 2026-11-01：原来这里是"睡/醒节奏 + 回归到常数 50"，
    //     实测导致心情永远钉在 50（半衰期 22.8h，且事件采集率仅 0.18%）。
    //     现在改为分段推进（与精力同样的理由：不能用"此刻"代表整段）。
    const MOOD_STEP_H = 10 / 60;
    const moodSpans = Math.max(1, Math.ceil(hours / MOOD_STEP_H));
    const moodStepH = hours / moodSpans;
    for (let i = 0; i < moodSpans; i += 1) {
      const tEnd = updatedAt + (now - updatedAt) * ((i + 1) / moodSpans);
      mood = advanceMoodByDesign(mood, moodStepH, energy, tEnd);
    }

    // 精力仍按原来的规则向基线回归（★ 精力那条线不动）
    const k = 1 - Math.pow(1 - REGRESSION_PER_HOUR, hours);
    energy += (BASELINE.energy - energy) * k;
  }
  return {
    energy: Math.round(clamp(energy, 0, 100) * 10) / 10,
    mood: Math.round(clamp(mood, 0, 100) * 10) / 10,
    sleeping,
    resting,
    hours: Math.round(hours * 100) / 100
  };
}

/**
 * 统计 [from, to] 里有多少小时落在"睡眠窗口"内。
 * ★ 逐半小时采样：够准（误差 < 0.5h），且不用写时区/夏令时的边界数学。
 */
function asleepHoursBetween(from, to, totalHours) {
  if (!(totalHours > 0)) return 0;
  const STEP = 0.5 * HOUR_MS;
  let n = 0;
  for (let t = Number(from) + STEP / 2; t < Number(to); t += STEP) {
    if (sleepingNow(t)) n += 1;
  }
  const sampled = n * 0.5;
  return Math.min(totalHours, sampled);
}

/** 读当前状态（只读，不推进；推进由 writeState 负责）。 */
export function readMood(dataDir, chatKey = '') {
  const scope = moodScopeOf(chatKey);
  const db = openDb(dataDir);
  if (!db) return { scope, energy: BASELINE.energy, mood: BASELINE.mood, updatedAt: 0, savedAt: 0, exists: false };
  try {
    const row = db.prepare('SELECT * FROM mood WHERE scope = ?').get(scope);
    if (!row) return { scope, energy: BASELINE.energy, mood: BASELINE.mood, updatedAt: 0, savedAt: 0, exists: false };
    return {
      scope,
      energy: Number(row.energy),
      mood: Number(row.mood),
      updatedAt: Number(row.updated_at) || 0,
      savedAt: Number(row.saved_at) || 0,
      exists: true
    };
  } catch {
    return { scope, energy: BASELINE.energy, mood: BASELINE.mood, updatedAt: 0, savedAt: 0, exists: false };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 算"此刻"的**最终**心情 = 全局 base + 本群 local 加权。
 *
 * ★ 这是双层模型的合成点。提示词、行为判断、控制台都用它 ——
 *   保证**同一次运行里所有地方看到的是同一个值**。
 *
 * @param {string} dataDir
 * @param {string} chatKey
 * @param {number} now
 * @returns {{energy:number, mood:number, baseEnergy:number, baseMood:number,
 *            localEnergy:number, localMood:number, sleeping:boolean, scope:string,
 *            updatedAt:number, exists:boolean, derived:boolean}}
 */
export function currentMood(dataDir, chatKey = '', now = Date.now()) {
  const scope = moodScopeOf(chatKey);
  const db = openDb(dataDir);
  // 拿不到库：退回基线（心情是增强项，绝不炸调用方）
  if (!db) {
    return {
      scope,
      energy: BASELINE.energy, mood: BASELINE.mood,
      baseEnergy: BASELINE.energy, baseMood: BASELINE.mood,
      localEnergy: 0, localMood: 0,
      sleeping: sleepingNow(now), updatedAt: 0, exists: false, derived: true
    };
  }
  try {
    const readOne = (s) => {
      const row = db.prepare('SELECT * FROM mood WHERE scope = ?').get(s);
      return row
        ? { energy: Number(row.energy), mood: Number(row.mood), updatedAt: Number(row.updated_at) || 0, savedAt: Number(row.saved_at) || 0 }
        : null;
    };
    const g = readOne('global');
    // 全局基础
    const base = g
      ? advance(g, now, dataDir)
      : { energy: BASELINE.energy, mood: BASELINE.mood, sleeping: sleepingNow(now), hours: 0 };
    // 本群局部（scope 不是 global 时才读；读不到视为 0 偏移）
    let l = null;
    if (scope !== 'global') l = readOne(scope);
    const local = l
      ? advance(l, now, dataDir)
      : { energy: 0, mood: 0, hours: 0 };
    // ★ local 存的是**偏移量**（可正可负），不是绝对分。advance 会把它拉向 0，
    //   所以这里要按"偏移"语义处理：local 的 baseline 是 0，不是 BASELINE。
    //   —— 为避免歧义，local 的推进单独做（见 advanceOffset）。
    const localAdv = l ? advanceOffset(l, now) : { energy: 0, mood: 0 };
    const lE = clamp(Number(localAdv.energy) || 0, -LOCAL_CAP, LOCAL_CAP);
    const lM = clamp(Number(localAdv.mood) || 0, -LOCAL_CAP, LOCAL_CAP);
    const energy = Math.round(clamp(base.energy + lE * LOCAL_WEIGHT, 0, 100) * 10) / 10;
    const mood = Math.round(clamp(base.mood + lM * LOCAL_WEIGHT, 0, 100) * 10) / 10;
    return {
      scope,
      energy, mood,
      baseEnergy: Math.round(base.energy * 10) / 10,
      baseMood: Math.round(base.mood * 10) / 10,
      localEnergy: Math.round(lE * 10) / 10,
      localMood: Math.round(lM * 10) / 10,
      sleeping: base.sleeping,
      updatedAt: Math.max(Number(g?.updatedAt) || 0, Number(l?.updatedAt) || 0),
      exists: Boolean(g || l),
      derived: true
    };
  } catch {
    return {
      scope,
      energy: BASELINE.energy, mood: BASELINE.mood,
      baseEnergy: BASELINE.energy, baseMood: BASELINE.mood,
      localEnergy: 0, localMood: 0,
      sleeping: sleepingNow(now), updatedAt: 0, exists: false, derived: true
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 推进一个**偏移量**（local 用）：基线是 0，不是 BASELINE。
 * ★ 偏移会随时间衰减（同样的 3%/h 回归到 0）—— 这保证"在这个群刚发生的事"
 *   会慢慢淡掉，而不是永久留在这个群上。
 */
function advanceOffset(prev = {}, now = Date.now()) {
  const updatedAt = Number(prev.updatedAt) || 0;
  let energy = Number(prev.energy) || 0;
  let mood = Number(prev.mood) || 0;
  if (updatedAt > 0) {
    const hours = Math.min(72, Math.max(0, (now - updatedAt) / HOUR_MS));
    if (hours > 0) {
      const k = 1 - Math.pow(1 - REGRESSION_PER_HOUR, hours);
      energy += (0 - energy) * k;
      mood += (0 - mood) * k;
    }
  }
  return { energy, mood };
}

/**
 * 记一次情绪冲击。**双层分配**：全局 base 拿 65%，本群 local 拿 35%。
 *
 * ★ 这是"同时被多个群影响、同时反馈到多个群，但每群有相对独立性"的实现点：
 *   · 全局 base 会被**任何**群的事件影响 ⇒ 影响是跨群的；
 *   · 本群 local 只被**这个群**的事件影响 ⇒ 每个群有相对独立性；
 *   · 最终心情 = base + local×0.6 ⇒ 两边都体现。
 *
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} o.chatKey
 * @param {string} o.kind        EVENT_KINDS 的键
 * @param {string} [o.uin]       涉及的人（**只写进 mood_log 供审计，不进归因表**）
 * @param {number} [o.intimacy]  这个人的亲密度（0–100），用来缩放冲击；不给按 0 算
 * @param {number} [o.now]
 * @returns {{ok:boolean, energy:number, mood:number, baseMood:number, localMood:number,
 *            dEnergy:number, dMood:number, dGlobal:number, dLocal:number, reason?:string}}
 */
export function applyMoodImpact({ dataDir, chatKey = '', kind, uin = '', intimacy = 0, now = Date.now() } = {}) {
  const impact = MOOD_IMPACTS[String(kind || '')];
  if (!impact) return { ok: false, reason: `未知事件类型 ${kind}`, energy: 0, mood: 0, dEnergy: 0, dMood: 0 };
  if (!impact.mood && !impact.energy) {
    // 中性事件：不产生冲击，但也不报错（调用方不必特判）
    const cur = currentMood(dataDir, chatKey, now);
    return {
      ok: true, energy: cur.energy, mood: cur.mood,
      baseMood: cur.baseMood, localMood: cur.localMood,
      dEnergy: 0, dMood: 0, dGlobal: 0, dLocal: 0, neutral: true
    };
  }
  const scope = moodScopeOf(chatKey);
  const db = openDb(dataDir);
  if (!db) return { ok: false, reason: '心情库打不开', energy: 0, mood: 0, dEnergy: 0, dMood: 0 };
  try {
    const mul = intimacyMultiplier(intimacy);
    const dMoodTotal = impact.mood * mul;
    const dEnergyTotal = impact.energy * mul;
    // ★ 拆成两份：全局拿大头（跨群影响），本群拿小头（相对独立性）
    const dGlobalMood = dMoodTotal * GLOBAL_SHARE;
    const dGlobalEnergy = dEnergyTotal * GLOBAL_SHARE;
    const dLocalMood = dMoodTotal * (1 - GLOBAL_SHARE);
    const dLocalEnergy = dEnergyTotal * (1 - GLOBAL_SHARE);

    const readOne = (s) => {
      const row = db.prepare('SELECT * FROM mood WHERE scope = ?').get(s);
      return row
        ? { energy: Number(row.energy), mood: Number(row.mood), updatedAt: Number(row.updated_at) || 0 }
        : null;
    };
    const upsert = db.prepare(`INSERT INTO mood (scope, energy, mood, updated_at, saved_at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET energy=excluded.energy, mood=excluded.mood,
        updated_at=excluded.updated_at, saved_at=excluded.saved_at`);
    const logOne = db.prepare('INSERT INTO mood_log (scope, kind, uin, d_mood, d_energy, note, ts) VALUES (?,?,?,?,?,?,?)');

    // ① 全局基础
    const gPrev = readOne('global');
    const gBase = gPrev
      ? advance(gPrev, now, dataDir)
      : { energy: BASELINE.energy, mood: BASELINE.mood };
    const gEnergy = Math.round(clamp(gBase.energy + dGlobalEnergy, 0, 100) * 10) / 10;
    // ★ 2026-11-01 修：冲击后也要过软边界。
    //   原来这里是 `clamp(gBase.mood + dGlobalMood, 0, 100)` —— 只夹硬边界，
    //   而软边界只在 advanceMoodByDesign() 里（时间推进时才跑）。
    //   结果：连续 praise/humor 能把心情一路推过 70，实测到 78（用户要求 30~70）。
    const gMood = Math.round(softBoundAfterImpact(gBase.mood + dGlobalMood) * 10) / 10;
    upsert.run('global', gEnergy, gMood, now, now);
    logOne.run('global', String(kind), String(uin || ''), Math.round(dGlobalMood * 10) / 10, Math.round(dGlobalEnergy * 10) / 10, impact.label, now);

    // ② 本群局部偏移（scope 就是 global 时没有"本群"，跳过）
    let lMoodAfter = 0;
    let lEnergyAfter = 0;
    if (scope !== 'global') {
      const lPrev = readOne(scope);
      const lBase = lPrev ? advanceOffset(lPrev, now) : { energy: 0, mood: 0 };
      lEnergyAfter = Math.round(clamp(lBase.energy + dLocalEnergy, -LOCAL_CAP, LOCAL_CAP) * 10) / 10;
      lMoodAfter = Math.round(clamp(lBase.mood + dLocalMood, -LOCAL_CAP, LOCAL_CAP) * 10) / 10;
      upsert.run(scope, lEnergyAfter, lMoodAfter, now, now);
      logOne.run(scope, String(kind), String(uin || ''), Math.round(dLocalMood * 10) / 10, Math.round(dLocalEnergy * 10) / 10, impact.label, now);
    }

    // ③ 归因记录（**只记群粒度 + 方向 + 粗类型，不记人名/原话**）
    const affect = dMoodTotal > 0 ? 'up' : dMoodTotal < 0 ? 'down' : (dEnergyTotal < 0 ? 'tiring' : 'flat');
    try {
      db.prepare('INSERT INTO mood_origin (scope, affect, kind, strength, ts) VALUES (?,?,?,?,?)')
        .run(scope === 'global' ? 'global' : scope, affect, String(kind), Math.round(Math.abs(dMoodTotal) * 10) / 10, now);
      // 只留最近 200 条
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM mood_origin').get()?.n) || 0;
      if (n > 200) {
        db.prepare('DELETE FROM mood_origin WHERE id IN (SELECT id FROM mood_origin ORDER BY ts ASC LIMIT ?)').run(n - 200);
      }
    } catch { /* 归因失败不影响心情本身 */ }

    // ④ 返回合成后的最终值
    const cur = currentMood(dataDir, chatKey, now);
    return {
      ok: true,
      energy: cur.energy, mood: cur.mood,
      baseMood: cur.baseMood, localMood: cur.localMood,
      dEnergy: Math.round(dEnergyTotal * 10) / 10,
      dMood: Math.round(dMoodTotal * 10) / 10,
      dGlobal: Math.round(dGlobalMood * 10) / 10,
      dLocal: Math.round(dLocalMood * 10) / 10
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), energy: 0, mood: 0, dEnergy: 0, dMood: 0 };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 把推进后的状态落盘（每分钟最多一次，避免高频写）。★ 双层都推进。 */
export function persistMood(dataDir, chatKey = '', now = Date.now()) {
  const scope = moodScopeOf(chatKey);
  const db = openDb(dataDir);
  if (!db) return false;
  try {
    const upsert = db.prepare(`INSERT INTO mood (scope, energy, mood, updated_at, saved_at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET energy=excluded.energy, mood=excluded.mood,
        updated_at=excluded.updated_at, saved_at=excluded.saved_at`);
    let wrote = false;
    // ① 全局基础（按 BASE 基线推进）
    const g = db.prepare('SELECT * FROM mood WHERE scope = ?').get('global');
    if (now - (Number(g?.saved_at) || 0) >= 60000) {
      const prev = g
        ? { energy: Number(g.energy), mood: Number(g.mood), updatedAt: Number(g.updated_at) || now }
        : { energy: BASELINE.energy, mood: BASELINE.mood, updatedAt: now };
      const next = advance(prev, now, dataDir);
      upsert.run('global', next.energy, next.mood, now, now);
      wrote = true;
    }
    // ② 本群局部偏移（按 0 基线推进）
    if (scope !== 'global') {
      const l = db.prepare('SELECT * FROM mood WHERE scope = ?').get(scope);
      if (l && now - (Number(l.saved_at) || 0) >= 60000) {
        const prev = { energy: Number(l.energy), mood: Number(l.mood), updatedAt: Number(l.updated_at) || now };
        const next = advanceOffset(prev, now);
        upsert.run(scope, next.energy, next.mood, now, now);
        wrote = true;
      }
    }
    return wrote;
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ★ 归因：被问"你怎么这样"时，能说一句"在别处遇到点事"，但不透露内容
// ═══════════════════════════════════════════════════════════════════════

/** 事件类型 → 给人听的**模糊说法**（只说方向与大概性质，不含任何内容）。 */
const KIND_VAGUE = {
  defend: '有人替我说话', deep_talk: '聊了很久', care: '有人关心了',
  praise: '有人夸了', help: '帮了点忙', humor: '聊得挺乐', share: '看到点好东西',
  harass: '被缠了一阵', insult: '有人说了难听的话', troll: '有人挑事',
  politics: '有人吵起来了', ignore: '问了没人理', spam: '被人刷屏',
  annoy: '被人反复打扰'
};

/**
 * 找出"最近是什么让我这样"（**只到群粒度**，绝不含内容/人名）。
 *
 * ★ 用户要求：「机器人可以说一句在另外一个群或者在哪里遇到了什么事，但是不用牵涉到具体情况」。
 * ⇒ 这里只回答三件事：**多久以前** / **在别处还是这里** / **朝哪个方向**。
 *   具体是谁、说了什么、哪个群号 —— 一律不返回，也不进提示词。
 *
 * @param {string} dataDir
 * @param {{chatKey?:string, withinHours?:number, now?:number}} opts
 * @returns {{has:boolean, elsewhere:boolean, direction:string, vague:string, hoursAgo:number}|null}
 */
export function moodCause(dataDir, { chatKey = '', withinHours = 12, now = Date.now() } = {}) {
  const scope = moodScopeOf(chatKey);
  const db = openDb(dataDir);
  if (!db) return null;
  try {
    const cutoff = now - Math.max(1, Number(withinHours) || 12) * HOUR_MS;
    const row = db.prepare(
      'SELECT scope, affect, kind, strength, ts FROM mood_origin WHERE ts >= ? ORDER BY strength DESC, ts DESC LIMIT 1'
    ).get(cutoff);
    if (!row) return null;
    const hoursAgo = Math.max(0, Math.round((now - Number(row.ts)) / HOUR_MS * 10) / 10);
    // ★ 关键判断：这条影响力的来源**不是当前群** ⇒ 可以说"在别处"
    //   scope='global' 时无法判断来源群（可能是任何群），也算"别处"。
    const elsewhere = String(row.scope) !== scope;
    const direction = String(row.affect) === 'up' ? 'up'
      : String(row.affect) === 'down' ? 'down'
        : String(row.affect) === 'tiring' ? 'tiring' : 'flat';
    return {
      has: true,
      elsewhere,
      direction,
      vague: KIND_VAGUE[String(row.kind)] || '',
      hoursAgo,
      strength: Number(row.strength) || 0
    };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 差异 3：把数值翻译成**行为约束**（这是"真的影响"的地方）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 算行为档位。纯函数，便于单测。
 * @returns {{energyTier:string, moodTier:string, maxSentences:number,
 *            proactiveAllowed:boolean, participationFactor:number, toneNote:string}}
 */
export function behaviorOf({ energy = BASELINE.energy, mood = BASELINE.mood } = {}) {
  const e = clamp(energy, 0, 100);
  const m = clamp(mood, 0, 100);

  // 精力档：决定"能说多少"
  const energyTier = e < 20 ? 'exhausted' : e < 40 ? 'tired' : e < 70 ? 'normal' : 'fresh';
  const maxSentences = energyTier === 'exhausted' ? 1 : energyTier === 'tired' ? 2 : energyTier === 'normal' ? 3 : 4;

  // 心情档：决定"想不想说话、语气如何"
  const moodTier = m < 25 ? 'bad' : m < 40 ? 'low' : m < 65 ? 'ok' : 'good';

  // ★ 参与意愿：很累或很烦时**主动降权**（不是禁止）。
  //   为什么不禁止：禁止会让机器人在该说话时沉默，比"语气冷淡"糟得多。
  let participationFactor = 1;
  if (energyTier === 'exhausted') participationFactor *= 0.45;
  else if (energyTier === 'tired') participationFactor *= 0.75;
  if (moodTier === 'bad') participationFactor *= 0.6;
  else if (moodTier === 'low') participationFactor *= 0.85;
  participationFactor = Math.round(participationFactor * 100) / 100;

  // 主动开新话题：只有"精神不错 + 心情 ok 以上"才允许
  const proactiveAllowed = energyTier !== 'exhausted' && energyTier !== 'tired' && moodTier !== 'bad';

  const toneNote = moodTier === 'bad' ? '话短、语气平、不卖萌、不接梗'
    : moodTier === 'low' ? '话少一点，别太热络'
      : moodTier === 'good' ? '可以多说一句、可以接梗'
        : '正常';

  return { energyTier, moodTier, maxSentences, proactiveAllowed, participationFactor, toneNote };
}

/**
 * 渲染成给模型看的（**具体行为约束 + 可说的归因**）。
 * 关闭时返回空串（提示词与未启用时逐字一致）。
 */
export function moodPrompt(dataDir, chatKey = '', now = Date.now()) {
  try {
    const cfg = getConfig();
    if (cfg?.moodEngine?.enabled === false) return '';
    const cur = currentMood(dataDir, chatKey, now);
    persistMood(dataDir, chatKey, now);     // 顺手推进（内部有一分钟节流）
    const b = behaviorOf(cur);

    const energyText = {
      exhausted: '几乎没力气了', tired: '有点累', normal: '还行', fresh: '精神不错'
    }[b.energyTier];
    const moodText = {
      bad: '心里很不痛快', low: '情绪偏低', ok: '心情一般', good: '心情不错'
    }[b.moodTier];

    const lines = [
      `【你此刻的状态】${energyText}，${moodText}。`
    ];
    // ★ 这里是"真的影响行为"的地方：给出**可执行的上限**，不是形容词
    lines.push(`- 这一轮最多说 ${b.maxSentences} 句${b.maxSentences <= 2 ? '，能一句说完就别两句' : ''}。`);
    lines.push(`- 语气：${b.toneNote}。`);
    if (!b.proactiveAllowed) {
      lines.push('- 这一轮**不要主动开新话题**；有人找你再说。');
    }
    if (cur.sleeping) {
      lines.push('- 这个点通常已经睡了；被叫醒就回得短一点、慢一点，别硬撑。');
    }

    // ── ★ 归因（用户要求："可以说一句在另外一个群遇到了什么事，但不用牵涉到具体情况"）
    //   ★★ 三条硬约束，缺一条就变成"泄露隐私"或"瞎编原因"：
    //     ① 只在**真有来源**时给（moodCause 返回 null 就不提，绝不编）；
    //     ② **来源不在这个群**时才说"别处"；本群的事说成别处 = 撒谎；
    //     ③ 只说**方向 + 模糊性质**，绝不给群号/人名/原话/具体内容。
    const cause = moodCause(dataDir, { chatKey, now });
    if (cause?.has && cause.strength >= 3) {
      // ★ 措辞按"在哪"分两套模板，不要拼成"在这儿，有人说了难听的话"那种半截话
      const what = cause.vague || '遇到点事';
      const when = cause.hoursAgo <= 1 ? '刚才' : cause.hoursAgo <= 6 ? '这几个小时' : '今天早些时候';
      const utterance = cause.elsewhere
        ? `${when}在别处${what}`
        : `${when}${what}`;
      lines.push(
        `- 有人问你怎么这样时，可以含糊说一句"${utterance}"`
        + `（**不要说出是哪个群、是谁、说了什么、具体发生了什么**）。`
        + `\n- 但如果没人问，**不要主动提起**；也别说"我心情不好"这种自陈。`
      );
    } else {
      lines.push('- 有人问你怎么这样，就说"没什么，就有点累/还好"这类含糊带过；**不要编具体原因**。');
    }

    lines.push('- 不要提"精力""心情""数值"这些词，也不要解释这条设定。');
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** 控制台只读快照（不写库）。★ 现在返回双层明细。 */
export function moodSnapshot(dataDir, chatKey = '', now = Date.now()) {
  try {
    const cfg = getConfig();
    const enabled = cfg?.moodEngine?.enabled !== false;
    const cur = currentMood(dataDir, chatKey, now);
    const b = behaviorOf(cur);
    const cause = moodCause(dataDir, { chatKey, now });
    return {
      enabled,
      scope: cur.scope,
      // 最终值（模型看到的、行为依据的）
      energy: cur.energy,
      mood: cur.mood,
      // 双层明细
      base: { energy: cur.baseEnergy, mood: cur.baseMood },
      local: { energy: cur.localEnergy, mood: cur.localMood },
      // 归因（只到群粒度）
      cause: cause?.has ? { direction: cause.direction, elsewhere: cause.elsewhere, hoursAgo: cause.hoursAgo, vague: cause.vague } : null,
      sleeping: cur.sleeping,
      updatedAt: cur.updatedAt,
      exists: cur.exists,
      ...b,
      baseline: BASELINE,
      weights: { globalShare: GLOBAL_SHARE, localWeight: LOCAL_WEIGHT, localCap: LOCAL_CAP },
      // 明确的刻度说明：两个都是 0–100，50 是心情基线
      scales: { energy: [0, 100], mood: [0, 100], moodBaseline: BASELINE.mood }
    };
  } catch {
    return { enabled: false, error: '心情引擎读取失败' };
  }
}

/** 全局基础心情（跨所有群的那一份）+ 各群局部偏移一览（控制台/调试用）。 */
export function moodOverview(dataDir, { now = Date.now() } = {}) {
  const db = openDb(dataDir);
  if (!db) return { global: null, scopes: [] };
  try {
    const g = db.prepare('SELECT * FROM mood WHERE scope = ?').get('global');
    const global = g
      ? advance({ energy: Number(g.energy), mood: Number(g.mood), updatedAt: Number(g.updated_at) || now }, now)
      : { energy: BASELINE.energy, mood: BASELINE.mood, sleeping: sleepingNow(now) };
    const scopes = [];
    for (const r of db.prepare("SELECT * FROM mood WHERE scope != 'global' ORDER BY updated_at DESC LIMIT 50").all()) {
      const off = advanceOffset({ energy: Number(r.energy), mood: Number(r.mood), updatedAt: Number(r.updated_at) || now }, now);
      scopes.push({
        scope: String(r.scope),
        local: { energy: Math.round(off.energy * 10) / 10, mood: Math.round(off.mood * 10) / 10 },
        // 该群的最终心情
        final: {
          energy: Math.round(clamp(global.energy + off.energy * LOCAL_WEIGHT, 0, 100) * 10) / 10,
          mood: Math.round(clamp(global.mood + off.mood * LOCAL_WEIGHT, 0, 100) * 10) / 10
        },
        updatedAt: Number(r.updated_at) || 0
      });
    }
    return {
      global: {
        energy: Math.round(global.energy * 10) / 10,
        mood: Math.round(global.mood * 10) / 10,
        sleeping: global.sleeping
      },
      scopes,
      weights: { globalShare: GLOBAL_SHARE, localWeight: LOCAL_WEIGHT, localCap: LOCAL_CAP }
    };
  } catch {
    return { global: null, scopes: [] };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 最近 N 条情绪流水（给控制台看"为什么变成这样"）。 */
export function moodLog(dataDir, { scope = '', limit = 30 } = {}) {
  const db = openDb(dataDir);
  if (!db) return [];
  try {
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    const rows = scope
      ? db.prepare('SELECT * FROM mood_log WHERE scope = ? ORDER BY ts DESC LIMIT ?').all(String(scope), n)
      : db.prepare('SELECT * FROM mood_log ORDER BY ts DESC LIMIT ?').all(n);
    return rows.map((r) => ({
      id: Number(r.id),
      scope: String(r.scope),
      kind: String(r.kind),
      uin: String(r.uin || ''),
      dMood: Number(r.d_mood) || 0,
      dEnergy: Number(r.d_energy) || 0,
      note: String(r.note || ''),
      ts: Number(r.ts) || 0
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 手工调整（控制台用；也可给"管理员哄了一下"这种场景）。
 *
 * ★★★ 2026-10-30 修（双层改造后忘记同步这里，实测抓出）：第一版仍按**单层**写 ——
 *   把 `dMood` 当作绝对分往 `mood` 表里塞。但双层模型下：
 *     · scope='global' 的那行是**绝对分**（基线 65/50）；
 *     · scope='group:xxx' 的那行是**偏移量**（基线 0）。
 *   于是 `nudge(chatKey:'group:1', dMood:-40)` 被写成 `local.mood = -40`… 看着对，
 *   但接着 `advance` 把它当**偏移**向 0 回归、再乘权重 —— 而且如果传入的 chatKey 是空，
 *   它会去改 global 的**绝对分**（把 -40 写成绝对分 10），语义完全错。
 *   ⇒ 现在明确：`chatKey` 给了 ⇒ 调**本群偏移**；没给 ⇒ 调**全局绝对分**。
 *     两个分支各自用正确的基线推进。
 */
/**
 * ★★★ 2026-11-01 新增：**管理员绝对值设定**心情/精力。
 *
 * 用户原话：「允许我手动修改心情和精力数值——日志中标明由管理员进行修改。」
 *
 * 与 `nudgeMood` 的区别（两个都保留）：
 *   · `nudgeMood`        相对增减（+5 / −10），日志 kind='manual'
 *   · `setMoodAbsolute`  **绝对值设定**（直接改成 85），日志 kind='admin'
 *
 * ★ 为什么日志要单独一个 kind='admin'：
 *   kind='manual' 现在被"投喂白饭"占用，混在一起就分不清
 *   "是人调的" 还是 "群友喂的" —— 而这两种在审计上的含义完全不同。
 *
 * ★ scope 语义与 nudgeMood 一致：
 *   · chatKey 留空 ⇒ 改**全局基础**（0~100 绝对分）
 *   · 给 chatKey  ⇒ 改**本群局部偏移**（−LOCAL_CAP ~ +LOCAL_CAP）
 *   ⇒ 这是双层模型决定的，不能把"本群偏移"当成绝对分写进去。
 *
 * @param {object} o
 * @param {number|null} o.mood    目标心情（null = 不改）
 * @param {number|null} o.energy  目标精力（null = 不改）
 *
 * @returns {{ok:boolean, before?:object, after?:object, reason?:string}}
 */
export function setMoodAbsolute(dataDir, { chatKey = '', mood = null, energy = null, by = 'console', now = Date.now() } = {}) {
  const scope = moodScopeOf(chatKey);
  const wantMood = mood === null || mood === undefined ? null : Number(mood);
  const wantEnergy = energy === null || energy === undefined ? null : Number(energy);
  if (wantMood === null && wantEnergy === null) return { ok: false, reason: '心情与精力都没有给目标值' };
  if (wantMood !== null && !Number.isFinite(wantMood)) return { ok: false, reason: '心情不是有效数字' };
  if (wantEnergy !== null && !Number.isFinite(wantEnergy)) return { ok: false, reason: '精力不是有效数字' };

  const isGlobal = scope === 'global';
  // 值域：全局 0~100；本群偏移 −LOCAL_CAP~LOCAL_CAP
  const lo = isGlobal ? 0 : -LOCAL_CAP;
  const hi = isGlobal ? 100 : LOCAL_CAP;

  // ★ 超范围必须**明确报错**，不能静默夹取。
  //   管理员以为设成 150 就真是 150，实际被悄悄夹成 100 —— 这是「安静地做了别的事」，比报错更危险。
  if (wantMood !== null && (wantMood < lo || wantMood > hi)) {
    return { ok: false, reason: `心情必须在 ${lo}~${hi} 之间（收到 ${wantMood}）` };
  }
  if (wantEnergy !== null && (wantEnergy < lo || wantEnergy > hi)) {
    return { ok: false, reason: `精力必须在 ${lo}~${hi} 之间（收到 ${wantEnergy}）` };
  }

  const db = openDb(dataDir);
  if (!db) return { ok: false, reason: '心情库打不开' };
  try {
    const upsert = db.prepare(`INSERT INTO mood (scope, energy, mood, updated_at, saved_at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET energy=excluded.energy, mood=excluded.mood,
        updated_at=excluded.updated_at, saved_at=excluded.saved_at`);
    const logOne = db.prepare('INSERT INTO mood_log (scope, kind, uin, d_mood, d_energy, note, ts) VALUES (?,?,?,?,?,?,?)');

    const readPrev = () => {
      const row = db.prepare('SELECT * FROM mood WHERE scope = ?').get(scope);
      if (row) {
        return {
          energy: Number(row.energy), mood: Number(row.mood),
          updatedAt: Number(row.updated_at) || now
        };
      }
      // 全局没有行 ⇒ 用基线；本群没有行 ⇒ 偏移 0
      return isGlobal
        ? { energy: BASELINE.energy, mood: BASELINE.mood, updatedAt: now }
        : { energy: 0, mood: 0, updatedAt: now };
    };

    const prev = readPrev();
    // 先推进到此刻（保证写入的是"现在"的值，而不是上次保存时的陈旧值）
    const base = isGlobal ? advance(prev, now, dataDir) : advanceOffset(prev, now);

    const nextMood = wantMood === null
      ? Math.round(clamp(base.mood, lo, hi) * 10) / 10
      : Math.round(clamp(wantMood, lo, hi) * 10) / 10;
    const nextEnergy = wantEnergy === null
      ? Math.round(clamp(base.energy, lo, hi) * 10) / 10
      : Math.round(clamp(wantEnergy, lo, hi) * 10) / 10;

    upsert.run(scope, nextEnergy, nextMood, now, now);

    // ★ 日志：kind='admin'，note 明确写"管理员修改"，并记录前后值
    const dMood = Math.round((nextMood - Number(base.mood)) * 10) / 10;
    const dEnergy = Math.round((nextEnergy - Number(base.energy)) * 10) / 10;
    const parts = [];
    if (wantMood !== null) parts.push(`心情 ${Number(base.mood).toFixed(1)} → ${nextMood.toFixed(1)}`);
    if (wantEnergy !== null) parts.push(`精力 ${Number(base.energy).toFixed(1)} → ${nextEnergy.toFixed(1)}`);
    const note = `管理员修改：${parts.join('，')}（${String(by || 'console').slice(0, 20)}）`.slice(0, 60);
    logOne.run(scope, 'admin', String(by || '').slice(0, 40), dMood, dEnergy, note, now);

    const cur = currentMood(dataDir, chatKey, now);
    return {
      ok: true,
      scope,
      mode: isGlobal ? 'global' : 'local',
      before: { mood: Math.round(Number(base.mood) * 10) / 10, energy: Math.round(Number(base.energy) * 10) / 10 },
      after: { mood: nextMood, energy: nextEnergy },
      final: { mood: cur.mood, energy: cur.energy }
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export function nudgeMood(dataDir, { chatKey = '', dMood = 0, dEnergy = 0, note = 'manual', now = Date.now() } = {}) {
  const scope = moodScopeOf(chatKey);
  const db = openDb(dataDir);
  if (!db) return { ok: false, reason: '心情库打不开' };
  try {
    const upsert = db.prepare(`INSERT INTO mood (scope, energy, mood, updated_at, saved_at) VALUES (?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET energy=excluded.energy, mood=excluded.mood,
        updated_at=excluded.updated_at, saved_at=excluded.saved_at`);
    const logOne = db.prepare('INSERT INTO mood_log (scope, kind, uin, d_mood, d_energy, note, ts) VALUES (?,?,?,?,?,?,?)');

    if (scope === 'global') {
      // 分支 A：调**全局绝对分**（基线 65/50）
      const g = db.prepare('SELECT * FROM mood WHERE scope = ?').get('global');
      const prev = g
        ? { energy: Number(g.energy), mood: Number(g.mood), updatedAt: Number(g.updated_at) || now }
        : { energy: BASELINE.energy, mood: BASELINE.mood, updatedAt: now };
      const base = advance(prev, now, dataDir);
      const energy = Math.round(clamp(base.energy + Number(dEnergy || 0), 0, 100) * 10) / 10;
      const mood = Math.round(clamp(base.mood + Number(dMood || 0), 0, 100) * 10) / 10;
      upsert.run('global', energy, mood, now, now);
      logOne.run('global', 'manual', '', Math.round(Number(dMood || 0) * 10) / 10, Math.round(Number(dEnergy || 0) * 10) / 10, String(note || '').slice(0, 60), now);
      const cur = currentMood(dataDir, '', now);
      return { ok: true, energy: cur.energy, mood: cur.mood, mode: 'global', base: { energy, mood } };
    }

    // 分支 B：调**本群偏移**（基线 0，上限 ±LOCAL_CAP）
    const l = db.prepare('SELECT * FROM mood WHERE scope = ?').get(scope);
    const prev = l
      ? { energy: Number(l.energy), mood: Number(l.mood), updatedAt: Number(l.updated_at) || now }
      : { energy: 0, mood: 0, updatedAt: now };
    const base = advanceOffset(prev, now);
    const energy = Math.round(clamp(base.energy + Number(dEnergy || 0), -LOCAL_CAP, LOCAL_CAP) * 10) / 10;
    const mood = Math.round(clamp(base.mood + Number(dMood || 0), -LOCAL_CAP, LOCAL_CAP) * 10) / 10;
    upsert.run(scope, energy, mood, now, now);
    logOne.run(scope, 'manual', '', Math.round(Number(dMood || 0) * 10) / 10, Math.round(Number(dEnergy || 0) * 10) / 10, String(note || '').slice(0, 60), now);
    const cur = currentMood(dataDir, chatKey, now);
    return { ok: true, energy: cur.energy, mood: cur.mood, mode: 'local', local: { energy, mood } };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
