// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// ★ 2026-10-27 起：这里的「指令清单」不再只列固定回复 ——
//   插件 / MCP / 技能由 local-commands-catalog.js 单独渲染（那个文件是唯一真源，
//   local-tools.js 的 list_commands 用的是同一份，两处永远一致）。
import { catalogText } from './local-commands-catalog.js';

// 固定回复（"嵌进去的东西"）：命中「激发指令」就把**固定内容**原样发出去，完全不经过模型。
//
// 为什么不让模型去说（2026-09-21 用户要求）：
//   1. 像爱发电链接、群规、联系方式这类内容必须**逐字准确**，模型 paraphrase 一次就可能写错；
//   2. 更要紧的是"**平时绝对不许主动提**"—— 写进人设就进了每一次提示词，
//      模型有概率在闲聊里顺嘴说出来；放在这里则物理上不可能：模型根本不知道这段内容存在。
//   3. 顺带零 token、零延迟、结果完全确定。
//
// 触发条件（默认最严，可在设置页逐条改）：
//   - 群里必须**真的 @ 到它**（requireAt），且正文里出现激发指令；
//   - 私聊默认**不允许**触发（allowPrivate 默认 false）；
//   - 同一个人同一条规则有冷却，防止刷屏把链接刷出来。

/** 逐条清洗规则：凡是缺激发指令或固定回复的，直接丢掉（宁可不出手，不可乱出手）。 */
export function normalizeCannedReplies(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const out = [];
  for (const raw of rawRules) {
    if (!raw || typeof raw !== 'object') continue;
    const triggers = (Array.isArray(raw.triggers) ? raw.triggers : [])
      .map((t) => String(t ?? '').trim())
      .filter(Boolean);
    const replies = (Array.isArray(raw.replies) ? raw.replies : [])
      .map((r) => String(r ?? '').trim())
      .filter(Boolean);
    if (!triggers.length || !replies.length) continue;
    const chats = (Array.isArray(raw.chats) ? raw.chats : [])
      .map((c) => String(c ?? '').trim())
      .filter(Boolean);
    out.push({
      id: String(raw.id || '').trim() || `rule-${out.length + 1}`,
      name: String(raw.name || '').trim() || triggers[0],
      enabled: raw.enabled !== false,
      triggers,
      matchAll: raw.matchAll === true,
      // ★★★ 2026-11-01 加：**精确模式** —— 去掉 @ 之后整句必须**恰好等于**激发指令。
      //   用户原话：「只要和机器人的任何聊天中包含指令两个字，就会艾特出那么长的一个指令清单，
      //   这个不好。我们把这个固定回复限制在唯一一个就是艾特他，然后加一个空格，然后指令」
      //   动机：`"指令"` 只有两个字，子串匹配会把「这个指令真难用」也当成请求 ⇒ 刷屏。
      //   ★ 默认 false，**其它规则行为完全不变**，只对声明了 exactMatch 的规则生效。
      exactMatch: raw.exactMatch === true,
      replies,
      chats,
      requireAt: raw.requireAt !== false,      // 默认必须 @
      allowPrivate: raw.allowPrivate === true, // 默认私聊不触发
      // ★★★ 2026-10-28 加：**只允许指定的人触发**（空数组 = 不限制）。
      //   用户原话：「刚刚被监管警告了…以后这个赞赏链接**仅能被我艾特出来**。」
      //   动机不是防滥用，是**合规**：赞助链接挂在"任何人 @ 一下就能拿到"的路径上，
      //   在一个几百人的群里等于半公开投放。收窄到本人是唯一可控的做法。
      //   ★ 用 QQ 号比对，不用昵称（昵称可改、可重名、可仿冒）。
      onlyFrom: (Array.isArray(raw.onlyFrom) ? raw.onlyFrom : [])
        .map((u) => String(u ?? '').trim())
        .filter((u) => /^\d{5,15}$/.test(u)),
      replyToSender: raw.replyToSender !== false,
      cooldownMs: Math.max(0, Number(raw.cooldownMs) || 0),
      // 按"群"的冷却：不管是谁问，同一个群里这条规则多久内只发一次。
      // 没有它时，一群人轮流问就会把同一段内容刷成屏。
      chatCooldownMs: Math.max(0, Number(raw.chatCooldownMs ?? 120000) || 0),
      // ★ 2026-10-26 加：动态正文。
      //   有些固定回复的内容**不是常量**（例如「亲密度」要按提问者实时算），
      //   写死在 replies 里做不到。这里只登记"用哪个数据源"，真正的文本由
      //   resolveDynamic() 在命中时生成 —— 内容仍然绕开模型，逐字可控。
      dynamic: typeof raw.dynamic === 'string' && raw.dynamic.trim() ? raw.dynamic.trim() : null,
      // ★ 动态规则查不到数据时用的提示（例如「互动太少，暂时没有亲密度」）。
      //   没有它就只能不发，让用户觉得"@了没反应"。
      notInRoster: (Array.isArray(raw.notInRoster) ? raw.notInRoster : [])
        .map((r) => String(r ?? '').trim())
        .filter(Boolean)
    });
  }
  return out;
}

/**
 * 把正文里"@机器人自己"的部分去掉，剩下的才算真正要说的话。
 * 否则「@小鲸鱼」本身就可能命中以昵称做的激发指令，变成自己触发自己。
 */
export function stripSelfMentions(text, selfNames = []) {
  let s = String(text ?? '');
  const names = [...new Set((selfNames || []).map((n) => String(n ?? '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length); // 长名字先替换，避免短名字截断长名字
  for (const name of names) {
    s = s.split(`@${name}`).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 激发指令匹配：不区分大小写；matchAll=true 时要求全部出现。
 *
 * ★ 2026-11-01 加 exactMatch：整句**恰好等于**激发指令才算命中（只对声明了它的规则生效）。
 *   为什么需要：`"指令"` 只有两个字，子串匹配会让「这个指令真难用」「指令列表在哪」
 *   都把整段指令清单刷出来。开启后只有「@我 指令」这种"单独一句"才触发。
 */
export function triggersHit(text, rule) {
  const hay = String(text ?? '').toLowerCase().trim();
  if (!hay) return false;
  const keys = rule.triggers.map((t) => String(t ?? '').toLowerCase().trim()).filter(Boolean);
  if (!keys.length) return false;

  if (rule.exactMatch === true) {
    // 归一：压缩空白、去掉首尾标点与空白。这样「@我 指令」「 指令 」「指令！」都算，
    // 而「这个指令真难用」不算（归一后不等）。
    const norm = (s) => String(s)
      .replace(/\s+/g, ' ')
      .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
      .trim();
    const h = norm(hay);
    return keys.some((k) => norm(k) === h);
  }

  return rule.matchAll ? keys.every((k) => hay.includes(k)) : keys.some((k) => hay.includes(k));
}

/**
 * 动态正文：规则里的内容不是常量时在这里生成。
 *
 * ★ 约束（为什么放这里而不是让模型说）：生成过程**完全确定性**，不调 LLM。
 *   拿不到数据时返回 null —— 调用方会退化成"不发"，而不是编一个数字出来。
 *
 * 支持的 dynamic 值：
 *   intimacy —— 按「提问者本人」算亲密度，用 replies 里的 {score} / {tier} / {rank} / {total} 占位符。
 *   commands —— 列出当前生效的固定回复指令（自描述）。见 buildCommandList()。
 *
 * @returns {string[]|null} 替换好占位符的正文数组；null = 这次生成不出来（放弃发送）
 */
function resolveDynamic(rule, { senderId, chatKey, intimacy, commands }) {
  // ★ 无论有没有 dynamic，最后都要做一次「占位符残留」检查。
  //   静态规则里如果有人手误写了 {xxx}，也绝不能原样发出去。
  const guard = (lines) => {
    if (!lines) return null;
    return lines.some((line) => /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(String(line))) ? null : lines;
  };

  if (!rule.dynamic) return guard(rule.replies);

  if (rule.dynamic === 'intimacy') {
    // ★ 2026-10-26：把 chatKey 传下去 —— 排名要按**所在群**算，不能拿全库总榜。
    const info = intimacy?.lookup ? intimacy.lookup(senderId, chatKey) : null;

    // ★★★ 2026-10-27 修（用户要求：亲密度绑人，不绑群）：
    //   旧逻辑是 `notInRoster = !info || info.inRoster === false` 就发"交流太少"，
    //   而 inRoster 当时取决于"**这个群里**说了 ≥2 句" ⇒ 同一个人换个新群就看不到分数。
    //   现在 inRoster 改为"这个人**在任何会话**里跟机器人有过互动"，跨群一致。
    //   ⇒ 只有**真的从没互动过**（info 为 null）才发提示；有名次只是加分项，没有名次也照给分数。
    if (!info) {
      const hint = rule.notInRoster;
      if (!hint || !hint.length) return null;   // 没配提示就不发（绝不编数字）
      return guard(hint);
    }

    const vars = {
      score: String(Math.round(info.score)),
      tier: String(info.tier || ''),
      rank: info.rank == null ? '—' : String(info.rank),
      total: info.total == null ? '—' : String(info.total)
    };
    // ★ 没进本群榜（rank 为空）时，把 `{rank}/{total}` 换成"本群暂未入榜"，
    //   而不是让 '{rank}' 残留（guard 会因此拒发 → 用户什么都看不到）。
    const inBoard = info.rank != null && Number(info.total) > 0;
    const filled = rule.replies.map((r) => {
      if (!inBoard && /\{rank\}|\{total\}/.test(String(r))) {
        // 这一条引用了名次，但本群没入榜 ⇒ 用一句不含占位符的替代，绝不残留 {xxx}
        return `你现在的亲密度是 ${vars.score}/100（${vars.tier}，本群暂未入榜）`;
      }
      return String(r).replace(/\{(score|tier|rank|total)\}/g, (_, k) => vars[k] ?? '');
    });
    return guard(filled);
  }

  // ★ 2026-10-26 加：列出全部固定回复指令（自描述）。
  //   为什么也放这个模块：它列的正是**本模块**认识的那些规则，
  //   所以永远不会出现"列表里有、实际却触发不了"的漂移。
  if (rule.dynamic === 'commands') {
    const list = commands?.list ? commands.list() : null;
    if (!list || !list.length) return null;   // 一条可用的都没有 → 不发，别编
    const vars = { commands: formatCommandList(list) };
    const filled = rule.replies.map((r) => String(r).replace(/\{commands\}/g, () => vars.commands));
    return guard(filled);
  }

  return null; // 未知的 dynamic 类型：不发，别乱说
}

/**
 * 把规则列表渲染成「说哪些词 → 我做什么」的清单。
 *
 * ★ 刻意**不暴露** replies 正文：爱发电链接、亲密度文案这些属于"用户问了才给"的内容，
 *   在清单里列出来等于把它变成了常驻提示。只列**怎么触发**，不列**触发后说什么**。
 *
 * ★★★ 2026-10-28 大改（用户原话）：
 *   「那个指令清单实在太乱了…也不用那么长，也不用描述的那么详细，
 *     也不用说明是来自什么工具的，群友不需要知道这么多，只需要知道有哪些功能就行了。」
 *   ⇒ 现在每个固定回复只占**一句**：「关键词 → 干什么」。
 *     删掉的东西（别再加回来）：序号、「等 N 个说法」、`→ 就是你现在看到的这张清单`、
 *     「（要 @ 我、私聊也行）」这种条件说明、以及"另外这些是我借来的本事"那种解释性小标题。
 *     触发词只取前 2 个 —— 3 个以上对读者是噪音（真要知道全部，直接 @ 它问）。
 */
export function formatCommandList(rules) {
  const lines = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    // 触发词最多留 2 个：清单是"目录"，不是"说明书"
    const keys = rule.triggers.slice(0, 2).map((t) => `${t}`).join(' / ');
    let what;
    if (rule.dynamic === 'intimacy') what = '查亲密度';
    else if (rule.dynamic === 'commands') what = '这份清单';
    else what = rule.name || '固定回复';
    lines.push(`· ${keys} → ${what}`);
  }

  // ── 能力段（插件 / 联网 / 技能，扁平、无来源标签）──────────────────────
  // ★ 顺序讲究：**先说"嘴上的话"，再说"手上的活"**。固定回复更短、放前面不挡事。
  // ★ 一个都渲染不出来时不留空标题（少一段比留一个空段强）。
  let extra = '';
  try { extra = catalogText(); } catch { extra = ''; }
  if (extra) {
    if (lines.length) lines.push('');
    lines.push('还能：');
    lines.push(extra);
  }
  return lines.join('\n');
}

/**
 * 建一个"固定回复应答器"。
 * 依赖全部注入，方便用假的 sender/store 做离线测试（真的往群里发要单独验证）。
 *
 * @param {object} deps
 * @param {{sendTextBatch: Function}} deps.sender 真正负责发送的对象
 * @param {{markRead: Function}} deps.store 用来把"已用固定回复答过"的消息标记已读，避免模型再答一遍
 * @param {Function} deps.getConfig
 * @param {Function} [deps.log]
 * @param {{lookup: (uin:string)=>({score:number,tier:string,rank:number|null,total:number}|null)}} [deps.intimacy]
 *        动态正文 `dynamic:'intimacy'` 用的查询入口
 * @param {{list: ()=>Array}} [deps.commands]
 *        动态正文 `dynamic:'commands'` 用的清单来源（返回归一化后的规则数组）
 */
export function createCannedResponder({ sender, store, getConfig, log = console.log, intimacy = null, commands = null }) {
  // 冷却表：`${ruleId}|${chatKey}|${senderId}` -> 上次回复时间
  const lastSentAt = new Map();
  // 归一化结果缓存，避免每条消息都重算一遍
  let cacheKey = null;
  let cacheRules = [];

  function rulesNow() {
    const raw = getConfig()?.cannedReplies;
    if (!raw || raw.enabled === false) return [];
    const key = JSON.stringify(raw.rules || []);
    if (key !== cacheKey) {
      cacheKey = key;
      cacheRules = normalizeCannedReplies(raw.rules);
    }
    return cacheRules;
  }

  // ★ 给 dynamic:'commands' 用 —— 返回当前归一化后的规则（已缓存，不会每条消息重算）。
  const commandsApi = commands || { list: () => rulesNow() };

  /**
   * 尝试用固定回复作答。
   * @returns {Promise<{handled:boolean, ruleId?:string, reason?:string, sent?:number}>}
   *   handled=true 表示这条消息已被"固定回复"接管（调用方不要再唤醒模型）；
   *   即使因冷却而没发出去，也算 handled —— 目的就是绝不让模型碰这个话题。
   */
  async function maybeRespond({
    chatKey, kind, senderId, senderName, text, mentionsSelf, dbId, selfNames
  }) {
    const rules = rulesNow();
    if (!rules.length) return { handled: false };

    const isPrivate = kind === 'private';
    // 只在"去掉 @自己"之后的正文里匹配，避免 @昵称 自己触发自己
    const body = stripSelfMentions(text, selfNames);
    const now = Date.now();

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.chats.length && !rule.chats.includes(chatKey)) continue;
      // ★★★ 2026-10-28：**只允许指定的人触发**（onlyFrom 非空时生效）。
      //   必须在最前面判 —— 连"命中但被拦"的痕迹都不该留，更不能进冷却占位。
      //   ★ 这里**静默跳过**（不 log、不 markRead）：让这条消息继续走正常模型链路，
      //     看起来就是"它根本没这条指令" —— 这正是用户要的效果（合规收口，不是"拒绝服务"）。
      if (rule.onlyFrom.length && !rule.onlyFrom.includes(String(senderId ?? '').trim())) continue;
      if (isPrivate) {
        if (!rule.allowPrivate) continue;
      } else if (rule.requireAt && !mentionsSelf) {
        continue; // 群里没 @ 它 —— 一个字都不给
      }
      if (!triggersHit(body, rule)) continue;

      const key = `${rule.id}|${chatKey}|${senderId}`;      // 按人
      const chatKeyKey = `${rule.id}|${chatKey}`;           // 按群
      const last = lastSentAt.get(key) || 0;
      const lastChat = lastSentAt.get(chatKeyKey) || 0;
      const personBlocked = rule.cooldownMs > 0 && now - last < rule.cooldownMs;
      const chatBlocked = rule.chatCooldownMs > 0 && now - lastChat < rule.chatCooldownMs;
      if (personBlocked || chatBlocked) {
        const waitMs = personBlocked
          ? rule.cooldownMs - (now - last)
          : rule.chatCooldownMs - (now - lastChat);
        const who = personBlocked ? (senderName || senderId) : '本群';
        log(`[canned] ${chatKey} 命中「${rule.name}」，但${who} ${Math.ceil(waitMs / 1000)} 秒内已经发过，这次不发`);
        store?.markRead?.(chatKey, [dbId]);
        return { handled: true, ruleId: rule.id, reason: 'cooldown' };
      }

      // ★ 动态正文在「命中之后、占冷却之前」生成：
      //   生成不出来（例如查不到这个人的亲密度）就当没命中，交给别的链路，
      //   绝不能因为算不出来就编一段话发出去。
      const replies = resolveDynamic(rule, { senderId, chatKey, intimacy, commands: commandsApi });
      if (!replies || !replies.length) {
        log(`[canned] ${chatKey} 命中「${rule.name}」，但动态内容生成失败（${rule.dynamic}），这次不发`);
        return { handled: false, ruleId: rule.id, reason: 'dynamic-failed' };
      }

      // ★ 先占位、再发送。
      // 发送会被"像真人一样的停顿"和限频排队拖几十秒；如果等发完才记冷却，
      // 排队期间进来的新请求看不到冷却，就会把同一段内容再发一遍（实测发生过）。
      lastSentAt.set(key, now);
      lastSentAt.set(chatKeyKey, now);

      try {
        await sender.sendTextBatch(chatKey, replies, {
          atUserId: rule.replyToSender && !isPrivate ? senderId : null,
          // 发到 QQ 的是原文；写进聊天存档的只是占位符。
          // 存档会进提示词 —— 存原文的话模型就能照抄着说（实测已发生）。
          archiveText: `[已自动发出：${rule.name}]`
        });
        log(`[canned] ${chatKey} 命中「${rule.name}」→ 已发固定回复 ${replies.length} 条（未经过模型）`);
        store?.markRead?.(chatKey, [dbId]);
        return { handled: true, ruleId: rule.id, sent: replies.length };
      } catch (error) {
        // 发送失败（限频排队超时 / 观察模式 / 非活跃时间）：撤掉占位，
        // 让群友等一下还能再要；消息不标记已读，交给日志说明。
        lastSentAt.delete(key);
        lastSentAt.delete(chatKeyKey);
        log(`[canned] ${chatKey} 固定回复「${rule.name}」发送失败：${error?.message ?? error}`);
        return { handled: true, ruleId: rule.id, reason: 'send-failed' };
      }
    }
    return { handled: false };
  }

  return { maybeRespond, rulesNow, _cooldown: lastSentAt };
}
