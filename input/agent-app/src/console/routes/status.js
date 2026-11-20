// 控制台 /api/status 与用量统计路由（从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// 状态聚合只做投影：数据来源（onebot/orchestrator/sessions/effects）全部注入，
// 统计函数 buildUsageStats/buildUsageBreakdown 仍留在 app.js（它们与用量缓存同处一文件）。
import { uiBuildStamp } from '../ui-build.js';

import {
  moodSnapshot as __localMoodSnapshot,
  moodOverview as __localMoodOverview,
  moodLog as __localMoodLog,
  nudgeMood as __localNudgeMood,
  setMoodAbsolute as __localSetMood,
  MOOD_IMPACTS as __localMoodImpacts,
  BASELINE as __localMoodBaseline,
  GLOBAL_SHARE as __localMoodGlobalShare,
  LOCAL_WEIGHT as __localMoodLocalWeight,
  LOCAL_CAP as __localMoodLocalCap,
  REGRESSION_PER_HOUR as __localMoodRegression
} from '../../features/mood-engine.js'; /*__local_mood_admin_import__*/

import {
  listAllFused as __localListAllFused,
  getPersonIntimacyFused as __localGetPersonIntimacyFused,
  recordEvent as __localRecordEvent,
  listEvents as __localListEvents,
  eventStats as __localEventStats,
  EVENT_KINDS as __localEventKinds,
  EVENT_INFLUENCE as __localEventInfluence,
  HALF_LIFE_DAYS as __localHalfLifeDays
} from '../../features/intimacy-fused.js';
import {
  scoringOptions as __localScoringOptions,
  listGateStates as __localListGateStates,
  resetGate as __localResetGate,
  SCORING_PROFILES as __localScoringProfiles
} from '../../features/intimacy-gate.js'; /*__local_intimacy_admin_import__*/
import path from 'node:path';
import { DATA_DIR } from '../../core/config-legacy.js'; /*__local_status_deps__*/
/*__local_feed_status_import__*/
import { catalogLines as __localCatalogLines } from '../../features/local-commands-catalog.js'; /*__local_commands_catalog_import__*/
import { fetchOpencodeUsage as __localFetchOpencodeUsage } from '../../features/local-opencode-quota.js';
import { resolveApiKey as __localResolveApiKey } from '../../llm/llm.js'; /*__local_opencode_quota_import__*/
import { todayKey } from '../../core/util.js';
import { tokenSaverEffective } from '../../core/token-saver.js';
import { budgetStatus } from '../../core/budget.js';
import { lastTraceId } from '../../core/logger.js';
import { timeControlState } from '../../core/time-control.js';
import { vendorOfConfig, resolveModelPrice, priceAt, costModeOf } from '../../pricing/model-prices.js';

export function registerStatusRoutes(router, deps = {}) {
  const json = deps.json;
  // 2026-11-05: 4 POST routes (intimacy/reset-gate, intimacy/event, mood/nudge, mood/set)
  // all use readBody / auditWrite, but this module never destructured them.
  // Same convention as upstream routes (chats/assets/memory/memes): take from deps.
  const readBody = deps.readBody;
  const auditWrite = deps.auditWrite;
  const getConfig = deps.getConfig;
  const sessions = deps.sessions;
  const onebot = deps.onebot;
  const orchestrator = deps.orchestrator;
  const incidentPilotStatus = deps.incidentPilotStatus;
  const effects = deps.effects;
  const uiDir = deps.uiDir;
  const version = deps.version;
  const getConfigConflict = deps.getConfigConflict;
  const buildUsageStats = deps.buildUsageStats;
  const buildUsageBreakdown = deps.buildUsageBreakdown;
  if (!router || !json || !getConfig || !sessions || !onebot || !orchestrator
    || !incidentPilotStatus || !effects || !uiDir || !version || !getConfigConflict
    || !buildUsageStats || !buildUsageBreakdown) {
    throw new Error('registerStatusRoutes 需要 router/json/getConfig/sessions/onebot/orchestrator/effects/uiDir/version/统计函数');
  }

  // /api/status 可能被多个页面/脚本高频轮询；uiBuildStamp 递归 readdir+stat 全量 ui/ 文件，
  // 每请求几十次 statSync（2026-11-03 第五轮复审 A9）。3 秒缓存足够让“控制台已更新”提示
  // 及时出现，又把常态轮询的成本压到最低。
  let uiStampCache = null;
  const cachedUiBuildStamp = () => {
    const now = Date.now();
    if (uiStampCache && now - uiStampCache.at < 3000) return uiStampCache.stamp;
    const stamp = uiBuildStamp(uiDir);
    uiStampCache = { at: now, stamp };
    return stamp;
  };

  router.add('GET', '/api/status', async (req, res) => {
    const dayKey = todayKey();
    const sessionUsage = sessions.todayUsage(dayKey);
    const dailyStats = buildUsageStats({ range: 'today' });
    const totals = dailyStats.totals;
    const usage = {
      dayKey,
      // token / 次数从 usage-today + 运行中会话直接取（实时）；cost 仍来自会话文件聚合，
      // 最多滞后 USAGE_CACHE_TTL_MS（Issue #45：不能让顶栏轮询驱动全量扫盘）。
      promptTokens: sessionUsage.promptTokens,
      completionTokens: sessionUsage.completionTokens,
      totalTokens: sessionUsage.totalTokens,
      cachedTokens: sessionUsage.cachedTokens,
      runs: sessionUsage.runs,
      webSearchCount: sessionUsage.webSearchCount,
      // 改进方案 #8：当日估算金额与未计价运行数（budgetStatus 的口径来源）
      estimatedYuan: Number(sessionUsage.estimatedYuan) || 0,
      unpricedRuns: Number(sessionUsage.unpricedRuns) || 0
    };
    const cfgNow = getConfig();
    // 省 Token 模式的"用户值 / 生效值"对照表：控制台设置页直接渲染，避免两边各写一份上限数字
    const tokenSaver = tokenSaverEffective(cfgNow);
    const currentVendor = vendorOfConfig(cfgNow) || '';
    const currentPrice = resolveModelPrice(cfgNow.api?.model, cfgNow, null, { vendor: currentVendor });
    const currentTier = currentPrice.peak
      ? priceAt(currentPrice, Date.now())
      : currentPrice;
    const cost = {
      cost: totals.cost,
      // 台账口径（usage-today 的 estimatedYuan）：含记忆整理等不写 session 的后台调用；
      // 旧字段 cost 保留会话口径给明细用（2026-11-01 插件仓库 issue #25）。
      ledgerCost: Number(sessionUsage.estimatedYuan) || 0,
      source: currentPrice.source,
      calculation: 'per-call',
      breakdown: totals.breakdown,
      // 口径：实付（用户自己填的价）/ 估算（官方表、兜底）/ 未定价
      kind: currentPrice.kind || 'estimate',
      billing: currentPrice.billing || 'token',
      costMode: costModeOf(cfgNow).mode,
      costMultiplier: costModeOf(cfgNow).multiplier,
      costMonthlyFee: costModeOf(cfgNow).monthlyFee,
      fallbackCalls: totals.fallbackCalls || 0,
      billingAmount: Number(currentPrice.amount) || 0,
      billingPeriod: currentPrice.period === 'day' ? 'day' : 'month',
      actualCost: totals.actualCost || 0,
      estimateCost: totals.estimateCost || 0,
      flatCost: (totals.flatItems || []).reduce((sum, item) => (
        item.period === 'month' ? sum + (Number(item.amount) || 0) : sum
      ), 0),
      flatCalls: totals.flatCalls || 0,
      localCalls: totals.localCalls || 0,
      prices: {
        in: currentTier.in,
        out: currentTier.out,
        cached: currentTier.cached
      },
      matched: currentPrice.matched,
      // 未定价 = 当前模型没有单价（不是免费）；界面据此提示"含未定价调用"
      unpriced: currentPrice.unpriced === true,
      confidence: currentPrice.confidence || '',
      via: currentPrice.via || '',
      peak: Boolean(currentTier.peak),
      hasPeakTiers: totals.hasPeakModel,
      peakCost: totals.peakCost,
      offPeakCost: totals.offPeakCost,
      exactCalls: totals.exactCalls,
      calls: totals.runs
    };
    return json(res, 200, {
      onebot: {
        connected: onebot.connected,
        everConnected: onebot.everConnected,
        error: onebot.lastConnectError,
        lastEventAt: Number(onebot.lastEventAt) || 0,
        lastHeartbeatAt: Number(onebot.lastHeartbeatAt) || 0,
        self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
      },
      orchestrator: orchestrator.statusSummary(),
      incidentPilot: incidentPilotStatus(),
      usage,
      // 改进方案 #8：当日预算状态（enabled/limit/spent/exceeded/onExceed/unpricedRuns）
      budget: budgetStatus(cfgNow, usage),
      // 改进方案 #6：最近一次运行的 trace id（拿它去 journalctl / 日志文件捞整条链路）
      lastTraceId: lastTraceId(),
      cost,
      // 与 usage 同口径（实时）：cached/prompt；totals 的命中率来自滞后的会话聚合
      cacheHitRate: usage.promptTokens ? Math.min(1, usage.cachedTokens / usage.promptTokens) : 0,
      webSearchCount: usage.webSearchCount || 0,
      // 前端构建戳：轮询时发现它变了 → 前端提示"控制台已更新，点击刷新"
      uiBuild: cachedUiBuildStamp(),
      // 进程运行期间 config.json 被外部改过：磁盘版本已备份，控制台据此提示
      configConflict: getConfigConflict(),
      // 当前版本号（package.json 的 version）：控制台侧栏与控制页的版本徽标用它。
      // 之前控制页只显示部署提交号（sha），用户看不出"这是哪个版本"。
      version,
      // 省 Token 模式：模式 + 每项的"用户值 / 生效值"（设置页渲染用）
      tokenSaver,
      ...(cfgNow.timeControl?.enabled ? {
        timeControl: timeControlState(cfgNow.timeControl)
      } : {}),
      paused: orchestrator.paused,
      pauseReason: orchestrator.pauseReason ?? null,
      // 留档占用（文件数/字节/压缩数/上限）：总览页"主机资源"用它显示，
      // 避免用户收到磁盘告警才知道 data/sessions 在涨。模块内 30 秒缓存。
      storage: sessions.storageStats(),
      // 出站副作用账本：unknown > 0 说明有"不知道发没发出去"的动作，需要人工核对
      effects: effects.stats()
    });
  });
  /*__local_opencode_quota__*/ // OpenCode Go 额度（本地补丁，重锚到 routes/status.js）
  // 作者的用量页是"token×单价"的通用估算；Go 的真实约束是订阅额度百分比，这里直接问上游。
  // ★ 只读接口：不写配置、不改任何状态、不回传 Key。Key 只发给配置里已知的地址。
  router.add('GET', '/api/local/opencode-quota', async (req, res) => {
    const normBase = (v) => String(v || '').trim().replace(/\/+$/, '').toLowerCase();
    const storedKeyAllowedForLocal = (cfgNow, baseUrl) => {
      const target = normBase(baseUrl);
      if (!target) return true;
      const known = [normBase(cfgNow?.api?.baseUrl), ...(cfgNow?.providers || []).map((p) => normBase(p?.baseURL))].filter(Boolean);
      return known.includes(target);
    };
    try {
      const cfgNow = getConfig();
      const base = String(cfgNow?.api?.baseUrl || '');
      let key = '';
      try { if (storedKeyAllowedForLocal(cfgNow, base)) key = String(__localResolveApiKey(cfgNow) || ''); } catch { /* 取不到按空处理 */ }
      const r = await __localFetchOpencodeUsage({ baseUrl: base, apiKey: key });
      return json(res, 200, { ok: r.ok, supported: r.supported !== false, ...r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  /*__local_commands_catalog__*/ // 指令目录（本地补丁，重锚到 routes/status.js）
  router.add('GET', '/api/local/commands', async (req, res) => {
    try {
      const list = __localCatalogLines();
      return json(res, 200, { ok: true, commands: list });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  /*__local_feed_status__*/ // 觅食状态（本地补丁，重锚到 routes/status.js）
  router.add('GET', '/api/local/feed-status', async (req, res) => {
    try {
      const cfgNow = getConfig();
      const lf = cfgNow?.lifeFeed || {};
      return json(res, 200, {
        ok: true,
        enabled: lf.enabled === true,
        sources: Array.isArray(lf.sources) ? lf.sources : [],
        shareMode: lf.shareMode || 'auto',
        shareGroups: Array.isArray(lf.shareGroups) ? lf.shareGroups : []
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });


   // ── 亲密度管理（本地补丁）──────────────────────────────────────────
  // 只读为主；唯一的写接口是「手工补记一条事件」（人工纠正模型漏记/记错）。
  // ★ 三套分数都返回：baseScore(纯统计) / eventScore(事件) / score(融合后) ——
  //   界面上必须能看出"这条分数是被事件抬了还是压了"，否则没法调参。
  router.add('GET', '/api/local/intimacy/meta', async (req, res) => {
    try {
      // ★ 2026-10-29：连打分的时机参数一起给出 —— 界面要显示"多久会提示一次"，
      //   而且要能看出"上次什么时候提示过、还差多少条"。
      return json(res, 200, {
        ok: true,
        kinds: __localEventKinds,
        influence: __localEventInfluence,
        halfLifeDays: __localHalfLifeDays,
        scoring: __localScoringOptions(getConfig()),
        profiles: __localScoringProfiles,
        gates: __localListGateStates(String(DATA_DIR || ''))
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 重置某个群的「刚提示过」记录 —— 让下一次立刻可触发（排查"为什么它一直不打分"用）
  router.add('POST', '/api/local/intimacy/reset-gate', async (req, res) => {
    try {
      const body = await readBody(req);
      const chatKey = String(body?.chatKey ?? '').trim();
      if (!/^(group|private):\d+$/.test(chatKey)) {
        return json(res, 400, { ok: false, error: 'chatKey 必须是 group:<群号> 或 private:<QQ号>' });
      }
      const okReset = __localResetGate(String(DATA_DIR || ''), chatKey);
      auditWrite('local.intimacy.reset-gate', chatKey, { req });
      return json(res, 200, { ok: okReset });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', '/api/local/intimacy/list', async (req, res, params, url) => {
    try {
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 400));
      const dataDir = String(DATA_DIR || '');
      const r = __localListAllFused({
        messagesDbPath: path.join(dataDir, 'messages.sqlite'),
        relationshipDbPath: path.join(dataDir, 'relationship-pilot.sqlite'),
        dataDir,
        limit
      });
      return json(res, 200, { ok: true, ...r, stats: __localEventStats(dataDir) });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', '/api/local/intimacy/person', async (req, res, params, url) => {
    try {
      const uin = String(url.searchParams.get('uin') || '').trim();
      if (!/^\d{5,15}$/.test(uin)) return json(res, 400, { ok: false, error: 'uin 不是有效的 QQ 号' });
      const dataDir = String(DATA_DIR || '');
      const info = __localGetPersonIntimacyFused(uin, {
        messagesDbPath: path.join(dataDir, 'messages.sqlite'),
        relationshipDbPath: path.join(dataDir, 'relationship-pilot.sqlite'),
        dataDir,
        withEvents: false
      });
      if (!info) return json(res, 404, { ok: false, error: '这个人没有任何互动记录' });
      return json(res, 200, {
        ok: true,
        info: {
          uin,
          score: info.score, baseScore: info.baseScore,
          eventScore: info.eventScore, eventDelta: info.eventDelta,
          tier: info.tier, rank: info.rank ?? null, total: info.total ?? 0,
          messageCount: info.metrics?.messageCount ?? 0,
          activeDays: info.metrics?.activeDays ?? 0,
          mentions: info.metrics?.mentions ?? 0,
          chatCount: info.metrics?.chatCount ?? 0,
          rounds: info.metrics?.rounds ?? 0,
          eventByKind: info.eventByKind || {}
        },
        events: __localListEvents(dataDir, uin, { limit: 50 })
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('POST', '/api/local/intimacy/event', async (req, res) => {
    try {
      const body = await readBody(req);
      const uin = String(body?.uin ?? '').trim();
      const chatKey = String(body?.chatKey ?? '').trim();
      const kind = String(body?.kind ?? '').trim();
      if (!/^\d{5,15}$/.test(uin)) return json(res, 400, { ok: false, error: 'uin 不是有效的 QQ 号' });
      // ★ 手填的 chatKey 必须是我们认识的会话形态，防止写进奇怪的地方
      if (!/^(group|private):\d+$/.test(chatKey)) {
        return json(res, 400, { ok: false, error: 'chatKey 必须是 group:<群号> 或 private:<QQ号>' });
      }
      const r = __localRecordEvent(String(DATA_DIR || ''), {
        uin, chatKey, kind, note: String(body?.note ?? '').slice(0, 200)
      });
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      auditWrite('local.intimacy.event', uin, { req, after: { uin, chatKey, kind, duplicate: !!r.duplicate } });
      return json(res, 200, { ok: true, duplicate: !!r.duplicate });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });


   // ── 当前心情（本地补丁，2026-10-30）────────────────────────────────
  // ★ 全部只读，除了 nudge。★ 归因只回群粒度，不回人名/原话（与提示词口径一致）。
  router.add('GET', '/api/local/mood/overview', async (req, res) => {
    try {
      const ov = __localMoodOverview(DATA_DIR);
      return json(res, 200, { ok: true, ...ov });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', '/api/local/mood/chat', async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const chatKey = String(u.searchParams.get('chatKey') || '').trim();
      if (!/^(group|private):\d+$/.test(chatKey)) {
        return json(res, 400, { ok: false, error: 'chatKey 必须是 group:数字 或 private:数字' });
      }
      return json(res, 200, { ok: true, ...__localMoodSnapshot(DATA_DIR, chatKey) });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', '/api/local/mood/log', async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const scope = String(u.searchParams.get('scope') || '').trim();
      const limit = Number(u.searchParams.get('limit')) || 30;
      return json(res, 200, { ok: true, rows: __localMoodLog(DATA_DIR, { scope, limit }) });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('GET', '/api/local/mood/meta', async (req, res) => {
    try {
      return json(res, 200, {
        ok: true,
        impacts: __localMoodImpacts,
        baseline: __localMoodBaseline,
        weights: {
          globalShare: __localMoodGlobalShare,
          localWeight: __localMoodLocalWeight,
          localCap: __localMoodLocalCap,
          regressionPerHour: __localMoodRegression
        },
        scales: { energy: [0, 100], mood: [0, 100], moodBaseline: __localMoodBaseline.mood }
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  router.add('POST', '/api/local/mood/nudge', async (req, res) => {
    try {
      const body = await readBody(req);
      const chatKey = String(body?.chatKey || '').trim();
      if (chatKey && !/^(group|private):\d+$/.test(chatKey)) {
        return json(res, 400, { ok: false, error: 'chatKey 形态不合法（留空=全局）' });
      }
      const dMood = Number(body?.dMood) || 0;
      const dEnergy = Number(body?.dEnergy) || 0;
      if (!dMood && !dEnergy) return json(res, 400, { ok: false, error: 'dMood 与 dEnergy 都是 0，无事可做' });
      if (Math.abs(dMood) > 60 || Math.abs(dEnergy) > 60) {
        return json(res, 400, { ok: false, error: '单次调整不能超过 ±60（防止手滑把心情拉到底）' });
      }
      const r = __localNudgeMood(DATA_DIR, {
        chatKey, dMood, dEnergy,
        note: String(body?.note || '控制台手工调整').slice(0, 60)
      });
      if (!r.ok) return json(res, 500, r);
      // 审计：写操作必须留痕（与亲密度写接口同口径）
      try {
        auditWrite(req, 'mood.nudge', { chatKey: chatKey || 'global', dMood, dEnergy });
      } catch { /* 审计失败不影响结果 */ }
      return json(res, 200, { ok: true, ...r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // ── 绝对值设定（管理员）───────────────────────────────────────────────
  // ★ 与上面的 nudge 不同：这里给的是**目标值**，不是增量。
  //   用户要求：「允许我手动修改心情和精力数值——日志中标明由管理员进行修改。」
  router.add('POST', '/api/local/mood/set', async (req, res) => {
    try {
      const body = await readBody(req);
      const chatKey = String(body?.chatKey || '').trim();
      if (chatKey && !/^(group|private):\d+$/.test(chatKey)) {
        return json(res, 400, { ok: false, error: 'chatKey 形态不合法（留空=全局）' });
      }
      const hasMood = body?.mood !== undefined && body?.mood !== null && body?.mood !== '';
      const hasEnergy = body?.energy !== undefined && body?.energy !== null && body?.energy !== '';
      if (!hasMood && !hasEnergy) {
        return json(res, 400, { ok: false, error: 'mood 与 energy 至少要给一个' });
      }
      const mood = hasMood ? Number(body.mood) : null;
      const energy = hasEnergy ? Number(body.energy) : null;
      if (hasMood && (!Number.isFinite(mood) || mood < 0 || mood > 100)) {
        return json(res, 400, { ok: false, error: '心情必须是 0~100 的数字' });
      }
      if (hasEnergy && (!Number.isFinite(energy) || energy < 0 || energy > 100)) {
        return json(res, 400, { ok: false, error: '精力必须是 0~100 的数字' });
      }
      const r = __localSetMood(DATA_DIR, {
        chatKey, mood, energy,
        by: String(body?.by || 'console').slice(0, 40)
      });
      if (!r.ok) return json(res, 500, r);
      try {
        auditWrite(req, 'mood.set', {
          chatKey: chatKey || 'global',
          mood: hasMood ? mood : null,
          energy: hasEnergy ? energy : null,
          before: r.before, after: r.after
        });
      } catch { /* 审计失败不影响结果 */ }
      return json(res, 200, { ok: true, ...r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/usage/stats', async (req, res, params, url) => {
    try {
      const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
      const stats = buildUsageStats({ range: raw });
      return json(res, 200, { ok: true, range: raw, ...stats });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/usage/breakdown', async (req, res, params, url) => {
    try {
      const raw = String(url.searchParams.get('range') || '7');
      const dim = String(url.searchParams.get('dim') || '');
      const key = String(url.searchParams.get('key') || '');
      const by = String(url.searchParams.get('by') || '');
      const r = buildUsageBreakdown({ range: raw, dim, key, by });
      return json(res, 200, { ok: true, ...r });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });
}
