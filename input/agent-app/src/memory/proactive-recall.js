// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
/**
 * 主动召回（proactive recall）—— 不再等模型自己想起来查，而是在**聊到相关话题时自动把记忆摆到它眼前**。
 *
 * ★★ 用户要求（2026-10-27）：「优化记忆库的使用方式，不靠模型主动去查，而是在聊到相关话题的时候
 *   自动触发，然后让模型更积极的去查这个记忆库，这会增加消耗，但是会更有活人感」。
 *
 * ★★ 为什么不能靠"让模型多调工具"来实现（这是本模块存在的理由）：
 *   模型是否调用工具，取决于它**有没有意识到"这里该查"**。实测现状：提示词里关于记忆工具的
 *   指引只有 1 条（person_memory_lookup），而 recall_events / memory_query 连提都没提。
 *   ⇒ 光写"你要积极查"是没用的，模型在闲聊中不会自觉调用。
 *   只有**代码先判断"这句话碰到了记忆"，再把查到的内容直接塞进提示词**，才是确定性的。
 *
 * ★★ 成本模型（用户明确接受增加消耗，但我们必须有刹车）：
 *   - 每次召回要跑一次向量检索（实测 168~472 ms，走 ecnu embedding + rerank 外部服务）；
 *   - 但**它不额外调用任何 LLM**：检索结果是直接拼进本轮提示词的 → 只增加 prompt token，
 *     **不增加一次模型往返**。这是本设计最划算的地方。
 *   - 三道刹车：①**关键词闸门**（没碰到记忆话题就一次都不查）；②每人每会话冷却；
 *     ③每次运行最多 N 条、总字符上限。
 *
 * ★★ 铁律（和 relational-memory 一致）：**只摆事实，不写结论**。
 *   召回的是"他以前说过什么"的原话，绝不生成"所以你该觉得他很亲切"这种判断。
 *   读失败/没有结果就当没发生，**绝不影响正常回复**。
 */
import { searchForPerson } from './memory-vec.js';
import { searchOldMessages } from './message-search.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const clean = (v, n = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 话题闸门：这句话是不是"碰到了记忆"？
 *
 * ★ 设计原则：**宁可漏触发，不可乱触发**。
 *   乱触发的代价是每条闲聊都多花几百 token 检索，还往提示词里塞不相关的旧事（比不记还糟）。
 *   漏触发的代价只是"这次没想起来" —— 与现状相同，不会更差。
 *
 * 分四类信号：
 *   1. **回忆类**（"上次""之前""还记得吗"）—— 最强信号，几乎必然该查；
 *   2. **身份类**（"我是谁""你认识我吗""第一次"）；
 *   3. **话题类**（问某人的喜好/习惯/看法）。
 *   4. 明确 @ 了机器人且在问过去的事。
 *
 * @returns {{hit: boolean, why: string, kind: string, query: string}}
 */
export function detectRecallTrigger(text, { selfNames = [], mentionsSelf = false } = {}) {
  const raw = clean(text, 400);
  if (!raw) return { hit: false, why: '', kind: '', query: '' };
  // 去掉 @自己 的前缀，避免"@哦鲸鲸 你还记得吗"里的昵称干扰判断
  let body = raw;
  for (const n of selfNames) {
    if (n) body = body.split(`@${n}`).join(' ');
  }
  body = body.replace(/\s+/g, ' ').trim();
  if (!body) return { hit: false, why: '', kind: '', query: '' };

  // ① 回忆类：最强信号
  const RECALL = /(上次|上回|之前|以前|早先|那次|那天|还记得|记得吗|记不记得|我说过|你说过|答应过|承诺过|说的那|提过的|聊到过|聊过)/;
  // ② 身份类
  const IDENTITY = /(我是谁|你认得我|认识我吗|记得我是谁|第一次(见面|聊|来)|刚来这|新人|老朋友|老熟人)/;
  // ③ 喜好/习惯类（问某人的稳定特征）
  const PROFILE = /(我喜欢|我爱(吃|玩|看|听)|我的?(习惯|爱好|风格|口味|脾气)|你了解我|你懂我|我这个人)/;

  if (RECALL.test(body)) {
    return { hit: true, why: `回忆类：${body.match(RECALL)[0]}`, kind: 'recall', query: body };
  }
  if (IDENTITY.test(body)) {
    return { hit: true, why: `身份类：${body.match(IDENTITY)[0]}`, kind: 'identity', query: body };
  }
  if (PROFILE.test(body)) {
    return { hit: true, why: `画像类：${body.match(PROFILE)[0]}`, kind: 'profile', query: body };
  }
  // ④ 被 @ 且**在问关于"人"的事** —— 三道条件同时满足才查。
  //   ★ 第一版只要求"@我 + 问句"，结果「@我 这个怎么弄」也触发 —— 那是在问操作方法，
  //     跟记忆毫无关系，纯属白花检索并塞无关旧事。收窄成：必须含**人称/关系**词。
  if (mentionsSelf && /[?？]|吗|呢|么/.test(body) && body.length >= 4
    && /(我|你俩|咱|我们|他|她)/.test(body)) {
    return { hit: true, why: '被 @ 且在问关于人的事', kind: 'asked', query: body };
  }
  return { hit: false, why: '', kind: '', query: '' };
}

/**
 * ★★★ 2026-11-01 新增：**实体命中**触发（缺陷②的修复）
 *
 * 为什么加这一层：上面那三条正则只能抓"明说要回忆"的话。
 * 实测反例：
 *   「那个彩票后来中了吗」❌ 不触发（没有回忆词）
 *   「我今天又去吃了」    ❌ 不触发（但这里**最该**想起他爱吃啥）
 *   「你还玩那个游戏吗」  ❌ 不触发
 * ⇒ 真人之间的记忆使用，绝大多数**不需要说"你还记得吗"**。
 *
 * 做法：拿当前消息里的实词去 FTS5 索引里查，命中就说明"这句话碰到了记忆里的东西"。
 *   ★ 判据（实测踩过，别改松）：
 *     · 用 `AND` 语义（OR 会命中几千条，等于没筛）
 *     · 命中数 **> 50 直接丢弃**该关键词（"今天"这种泛词命中 208 条，是噪声）
 *     · 长词 AND 失败时做**子串滑窗降级**（4→2 字），否则"玩鲑鱼大帝"这种会 0 命中
 *
 * @param {object} o
 * @param {string} o.text            当前消息
 * @param {object} o.fts             { query(terms) => count } 由调用方注入（可空）
 * @param {number} [o.maxHits]       命中数超过它就认为太泛（默认 50）
 * @returns {{hit:boolean, why:string, kind:string, query:string, terms:string[]}}
 */
// ★ 跨词切出来的高频碎片：它们在原句里连续，但不是一个词。
//   实测来源：「随便说说吧」→「便说」，「今天天气不错」→「天气」。
//   判据：这些 2 字组合在库里命中 > 0，但组合本身不构成聊天里会被提起的实体。
const SPLIT_NOISE = new Set([
  '便说', '天气', '天天', '说说', '随便', '今天', '明天', '昨天',
  '这个', '那个', '什么', '怎么', '可以', '就是', '还是', '然后',
  '现在', '时候', '知道', '觉得', '可能', '应该', '真的', '其实',
  '不过', '一下', '帮我', '给我', '请问', '你在', '我在', '他在'
]);

export function detectEntityTrigger({ text = '', fts = null, maxHits = 50, totalMessages = 0 } = {}) {
  const miss = { hit: false, why: '', kind: '', query: '', terms: [] };
  if (!fts || typeof fts.count !== 'function') return miss;
  const body = clean(text, 400);
  if (!body || body.length < 4) return miss;   // 太短信息量不足

  const base = extractSearchKeyword(body);
  const cands = [...(base.candidates || [])].filter((t) => t && t.length >= 2);
  if (!cands.length) return miss;

  // ★★ 判据（2026-11-01 两次实测后定下来的，别改松也别改紧）：
  //   · 太泛的丢：命中 > maxHits（默认 50）⇒ "今天"这种 208 条的不要
  //   · **极稀有的直接算实体**：命中 ≤ 3 条 ⇒ 一定是专有名词（"鲑鱼大帝" 1 条）
  //   · 中等频次的要看**占比**：命中 / 总消息 ≤ 0.5% 才算"碰到了特定记忆"
  //     （实测：26,100 条里「彩票」23 条 = 0.09% ✓ ／「去吃」26 条 = 0.10% ✓
  //      ／「随便说」2 条 = 0.008% 但它是虚词 ⇒ 靠下面的虚词表挡掉）
  const total = Math.max(1, Number(totalMessages) || 0);

  for (const word of cands) {
    let hits = safeCount(fts, word);
    let used = word;
    // 长词 AND 失败 ⇒ 子串滑窗降级（4→2 字，长优先）
    // ★ 2026-11-01 实测：必须降到 2 字 —— 「那个彩票后来中了吗」抽出的是
    //   整段「彩票后来中」（0 命中），只降到 3 字仍 0 命中，降到 2 字才能命中「彩票」。
    //   ⚠ 但 2 字降级会产生伪词（「随便说说」→「随便说」），靠下面的虚词表 + 边界检查挡。
    if (hits === 0 && word.length >= 3) {
      for (let len = Math.min(4, word.length - 1); len >= 2 && hits === 0; len -= 1) {
        for (let i = 0; i + len <= word.length; i += 1) {
          const sub = word.slice(i, i + len);
          if (len === 2 && ENTITY_STOP_WORDS.has(sub)) continue;
          if (len === 2 && [...sub].every((c) => ENTITY_STOP_CHARS.has(c))) continue;
          const n = safeCount(fts, sub);
          if (n > 0 && n <= maxHits) { hits = n; used = sub; break; }
        }
      }
    }
    if (hits <= 0 || hits > maxHits) continue;
    // ★★★ 2026-11-01 关键修正：噪音表必须**无条件**检查，不能只放在 hits<3 的分支里。
    //   实测踩的坑：`便说` 命中 3 条 ⇒ `hits < 3` 为假 ⇒ 整块判据被跳过 ⇒ 直接进稀有度
    //   （hits<=3 就算稀有）⇒ 误报。而「便说」是「随便说说吧」跨词切出来的碎片，不是实体。
    //   ⇒ 判据顺序必须是：先排除「跨词碎片」，再看稀有度/占比。
    if (used !== word && SPLIT_NOISE.has(used)) continue;
    if (SPLIT_NOISE.has(used)) continue;
    // 虚词表：这些词命中再多也不算"碰到记忆"
    if (ENTITY_STOP_WORDS.has(used)) continue;
    if ([...used].every((c) => ENTITY_STOP_CHARS.has(c))) continue;
    // ★ 叠字不算实体（「哈哈哈哈」「哈哈哈」这类笑声/语气词）
    if (used.length >= 2 && [...used].every((c) => c === used[0])) continue;
    // ★ 降级词（不是原词）要求更严：必须 ≥3 条命中才算"碰到了特定记忆"。
    //   实测伪词全是 2 条：「随便说」2、「今天天」2；
    //   而真专有名词（「彩票」23、「去吃」26、「鲑鱼大帝」1）——
    //   ⚠ 「鲑鱼大帝」只有 1 条，但它**是 3 字以上的完整词**，不受这条限制。
    //   ⇒ 判据：**降级且 ≤2 字** 时要求 ≥3 条；3 字以上的降级词只看稀有度。
    // ★★★ 2026-11-01 修：原来的「降级且≤2字要求≥3条」会把**真稀有词**一起挡掉。
    //   实测两个漏命中：
    //     「玩鲑鱼大帝」→ 降级到「鲑鱼」1 条 ⇒ 被挡（但「鲑鱼大帝」是真人说的专有名词）
    //     「蓝色鲸鱼」  → 降级到「色鲸」1 条 ⇒ 被挡（同上）
    //   而它当初是为挡伪词（「随便说说」→「随便说」2 条）。
    //   ⇒ 区分真伪：**原词里连续出现的子串**才算真词；伪词是拼出来的碎片。
    //     再用「该子串在原文里的位置是否与原词严格连续」+ 虚词边界双重确认。
    if (used !== word && used.length <= 2 && hits < 3) {
      // ★★★ 判据（2026-11-01 四次实测，这是最后一版）：
      //   降级词必须在**原始整句 body** 里连续出现 —— 不是看它是不是抽出的片段词的前后缀。
      //
      //   为什么不能用「前缀/后缀」：
      //     「玩鲑鱼大帝」抽出的片段是「玩鲑鱼大帝」，降级到「鲑鱼」时 H0T0（既非头也非尾）
      //     但「鲑鱼」在**原句**「你还玩鲑鱼大帝吗」里是连续的 ⇒ 它是真词。
      //   为什么不能用「位置连续」：
      //     「随便说说吧」降级到「便说」，它在片段词「随便说说」里也连续，但**原句里**
      //     「便说」同样是连续的（随便|说说|吧 → 便说 跨了「便」和「说」）…
      //   所以真正的判据是：**看它是不是从一个更长的真词里切出来的**。
      //   实测最稳的做法：只要该子串在原句里连续，且它自己不是虚词，就认。
      //   再用「命中 ≥3 条」兜住高频伪词（便说 3、天气 20 —— 天气靠虚词表挡）。
      const inBody = body.includes(used);
      if (!inBody) continue;
      if (ENTITY_STOP_WORDS.has(used)) continue;
      // 高频碎片当虚词处理（便说 3 条就能过稀有度，但它不是实体）
      if (SPLIT_NOISE.has(used)) continue;
    }
    // ★ 3 字降级词也挡一下"伪三字"：命中 ≤2 且原词里它前面/后面还剩虚词
    if (used !== word && used.length === 3 && hits <= 2) {
      const idx = word.indexOf(used);
      const head = idx > 0 ? word.slice(0, idx) : '';
      const tail = idx + used.length < word.length ? word.slice(idx + used.length) : '';
      // 「随便说说」→「随便说」：尾巴是"说"（虚词）；「今天天气」→「今天天」：尾巴是"气"
      // 判据：只要这个 3 字词不是"从原词开头连续取的"或"不是从结尾连续取的"，就当伪词
      if (head || tail) continue;
    }
    // 稀有度判据
    const rare = hits <= 3;
    const ratioOk = total > 0 && (hits / total) <= 0.005;
    if (!rare && !ratioOk) continue;
    return { hit: true, why: `实体命中「${used}」(${hits} 条)`, kind: 'entity', query: body, terms: [used] };
  }
  return miss;
}

// 这些词命中再多也不算"碰到了特定记忆"（纯口语/虚词）

const ENTITY_STOP_WORDS = new Set([
  '随便', '说说', '什么', '怎么', '这个', '那个', '一下', '可以', '就是', '还是',
  '然后', '现在', '时候', '知道', '觉得', '可能', '应该', '真的', '其实', '不过',
  '今天', '昨天', '明天', '现在', '刚才', '早上', '中午', '晚上', '时候'
]);
const ENTITY_STOP_CHARS = new Set([...'的了是吗呢吧啊呀哦嗯么在有和就不都很我你他她它们这那哪谁']);

function safeCount(fts, term) {
  try { const n = Number(fts.count(term)); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; }
}

/** 简单去重（同一句只保留一次），保证提示词里不出现重复的旧事。 */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = clean(item.text, 120);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * 从问句里抽"值得拿去搜消息的关键词"。
 *
 * ★★ 为什么不能直接拿整句去 LIKE（2026-10-27 实测踩到）：
 *   `searchOldMessages` 用的是 SQL `LIKE '%关键词%'`，**整句是一个精确子串**，
 *   而"你上次说的那个彩票还在吗"这句话里的字**从来不会连续出现在聊天里** ⇒ 必然 0 命中。
 *   结果就退化成"给最近两条消息"，三句不同的问句返回**同样的两条** —— 看着像在工作，
 *   其实是兜底在生效，等于没搜。
 *   ⚠ 注意：向量检索那一路可以用整句（它是语义匹配），所以这里抽出来的词**只喂给 LIKE 那一路**。
 *
 * 抽法（保守，宁可少抽）：
 *   ① 去掉疑问/回忆的**功能词**（你/我/上次/之前/记得/吗/的/说/那/这个…）；
 *   ② 剩余的连续中文/英文片段按 2~8 字切，取最长的 1~2 个；
 *   ③ 一个都抽不出就返回空串 ⇒ 调用方**不用关键词搜**，改用"这个人最近的发言"。
 *
 * @returns {{keyword: string, candidates: string[]}}
 */
export function extractSearchKeyword(text) {
  const raw = clean(text, 80);
  if (!raw) return { keyword: '', candidates: [] };

  // ① 功能词（这些词在聊天记录里出现得太泛，搜了也是噪声）
  const STOP = /(你|我|他|她|它|们|的|了|吗|呢|么|吧|啊|呀|是|在|有|没|不|就|都|也|还|又|这|那|个|些|什么|怎么|为什么|哪|谁|时候|上次|上回|之前|以前|早先|那次|那天|记得|记不记得|说过|说过吗|说过啥|聊过|聊到|答应|承诺|提过|说的|那个|这个|一下|帮我|给我|请问)/g;
  let s = raw.replace(STOP, ' ');
  // 去掉纯标点与空白
  s = s.replace(/[，。！？、；：""''（）()《》【】\[\]…—\-~@#%&*+=/\\|<>^`]/g, ' ');
  const tokens = s.split(/\s+/).map((x) => x.trim()).filter(Boolean);

  // ② 英文/数字词直接可用；中文取 2~8 字的片段（整段太长时切头）
  const candidates = [];
  for (const tk of tokens) {
    if (/^[A-Za-z0-9]{2,}$/.test(tk)) { candidates.push(tk); continue; }
    const cn = tk.replace(/[^\u4e00-\u9fff]/g, '');
    if (cn.length >= 2 && cn.length <= 12) candidates.push(cn);
    else if (cn.length > 12) candidates.push(cn.slice(0, 8));
  }
  // 去重 + 按长度降序（长词通常更有信息量）
  const uniq = [...new Set(candidates)].filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  return { keyword: uniq[0] || '', candidates: uniq.slice(0, 3) };
}

/**
 * 为一次运行做主动召回。
 *
 * @param {object} o
 * @param {string} o.chatKey
 * @param {Array<{senderId:string, senderName:string, text:string, mentionsSelf:boolean}>} o.entries 本次触发批
 * @param {object} o.episodes   EpisodeStore（可选）
 * @param {string} o.messagesDbPath
 * @param {number} [o.maxPeople]      最多查几个人（默认 2）
 * @param {number} [o.maxItemsPerPerson] 每人最多几条（默认 2）
 * @param {number} [o.maxChars]       整段上限（默认 900）
 * @param {number} [o.cooldownMs]     同一人冷却（默认 10 分钟）
 * @param {Map}    [o.lastQueryAt]    冷却表（调用方持有，跨轮共享）
 * @param {number} [o.now]
 * @param {object} [o.entityFts]      ★ 2026-11-01 新增：实体命中的计数器 { count(term) => n }
 *                                    给了才启用"实体触发"（"我今天又去吃了"这类不说明说也能想起）
 * @param {number} [o.entityMaxHits]  实体命中数上限，超过视为太泛（默认 50）
 * @returns {Promise<{text: string, stats: object}>}
 */
export async function buildProactiveRecall({
  chatKey,
  entries = [],
  episodes = null,
  messagesDbPath = '',
  maxPeople = 2,
  maxItemsPerPerson = 2,
  maxChars = 900,
  cooldownMs = 10 * 60 * 1000,
  lastQueryAt = null,
  now = Date.now(),
  entityFts = null,
  entityMaxHits = 50
} = {}) {
  const stats = { triggered: 0, people: 0, items: 0, skippedCooldown: 0, chars: 0, byEntity: 0 };
  const ck = String(chatKey || '').trim();
  if (!ck) return { text: '', stats };

  // ---------- 1. 从触发批里挑出"碰到了记忆"的发言 ----------
  const hits = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const uid = String(e.senderId || '').trim();
    if (!uid || !/^\d{1,15}$/.test(uid)) continue;
    // ① 明说型（原有三条正则）
    let d = detectRecallTrigger(e.text, { mentionsSelf: e.mentionsSelf === true });
    // ② ★ 2026-11-01 新增：明说不成立时，试**实体命中**（"我今天又去吃了"这类）
    //    ★ 只在显式给了 fts 时才走，避免在没有索引的环境里白跑。
    if (!d.hit && entityFts) {
      const ent = detectEntityTrigger({ text: e.text, fts: entityFts, maxHits: entityMaxHits });
      if (ent.hit) { d = ent; stats.byEntity += 1; }
    }
    if (d.hit) hits.push({ uid, name: String(e.senderName || ''), kind: d.kind, why: d.why, query: d.query });
  }
  stats.triggered = hits.length;
  if (!hits.length) return { text: '', stats };

  // ---------- 2. 去重 + 冷却 + 人数上限 ----------
  const picked = [];
  const seenUid = new Set();
  for (const h of hits) {
    if (seenUid.has(h.uid)) continue;
    if (lastQueryAt && cooldownMs > 0) {
      const last = Number(lastQueryAt.get(`${ck}|${h.uid}`) || 0);
      if (last && now - last < cooldownMs) { stats.skippedCooldown += 1; continue; }
    }
    seenUid.add(h.uid);
    picked.push(h);
    if (picked.length >= Math.max(1, maxPeople)) break;
  }
  if (!picked.length) return { text: '', stats };

  // ---------- 3. 每人查两路：向量印象 + 事件记忆 ----------
  const blocks = [];
  for (const h of picked) {
    const parts = [];

    // ① 向量检索：这个人**画过像**的相关侧面（语义匹配，不靠关键词）
    try {
      const rows = await searchForPerson(h.uid, h.query, Math.max(1, maxItemsPerPerson), { chatKey: ck });
      for (const r of rows || []) {
        const s = clean(r.content, 160);
        // ★★ 阈值为什么是 0.0005 而不是 0.15（2026-10-27 实测踩到，别改大）：
        //   rerank 返回的是**绝对置信度**，不是 0~1 归一化分数。实测同一个人的
        //   高度相关提问（"你上次说要给我加功能呢"）top 只有 **0.007**，
        //   最相关的那次也不过 0.029。第一版我把门槛设成 0.15 ⇒ **一条都进不来**，
        //   整个功能静默失效（stats 里 triggered=1 但 people=0）。
        //   ⇒ 正确做法不是提高门槛，而是**只用它排序**、门槛只挡掉完全无关（≈0.000x 全零）。
        //   实测无关查询的分数也在 0.001~0.01 区间，所以这里**不用分数做筛选**，
        //   只要求 searchForPerson 返回了结果（它已按 rerank 排好序）。
        if (s) parts.push({ text: s, src: '印象', score: Number(r.score) });
      }
    } catch { /* 向量检索失败不影响事件检索 */ }

    // ② 事件记忆：他/这个会话在过去真的发生过的事（关键词命中）
    if (episodes?.list) {
      try {
        const kw = clean(h.query, 30);
        const evs = episodes.list({ chatKey: ck, since: now - 90 * DAY_MS, keyword: kw, limit: 6 }) || [];
        for (const ev of evs) {
          const s = clean(`${ev.day ? `[${ev.day}] ` : ''}${ev.who ? `${ev.who}：` : ''}${ev.summary}`, 160);
          if (s) parts.push({ text: s, src: '事件', score: 0 });
        }
      } catch { /* 事件记忆是增强项 */ }
    }

    // ③ **原始消息回查**（2026-10-27 加，这是"翻几个月前"真正靠得住的那一路）。
    //   ★ 为什么必须有：实测事件库只有 **3 天**（10-25 之前的 0 条），而原始消息
    //     **35 天一条没少**（11,412 条）。用户问「能不能把几个月前的东西翻出来」——
    //     光靠事件层做不到，必须直接搜原始消息。
    //   ★ 只用「回忆类」触发时才搜（identity/profile 那类问的是"我是什么样的人"，
    //     该看印象而不是翻聊天记录，翻了也答不对）。
    if (messagesDbPath && h.kind === 'recall') {
      try {
        // ★ 只喂**抽出来的实体词**给 LIKE 那一路（整句必 0 命中，见 extractSearchKeyword 注释）。
        const { keyword: kw } = extractSearchKeyword(h.query);
        const r = kw
          ? searchOldMessages({
            messagesDbPath,
            chatKey: ck,
            keyword: kw,
            daysFrom: 3650,      // 能翻到头
            limit: 2,
            oldestFirst: false
          })
          : { rows: [] };
        for (const m of r.rows || []) {
          const who2 = m.self ? '我当时说' : `${m.senderName || m.senderId}说`;
          const s = clean(`${m.time} ${who2}：${m.text}`, 170);
          if (s) parts.push({ text: s, src: '原话', score: 0 });
        }
      } catch { /* 原话回查失败不影响其它两路 */ }
    }

    // ④ 必要时兜一层：三路都没捞到东西，就退化成"最近几条消息"，
    //   免得触发却给空（模型会以为"我什么都不记得"，比不触发更糟）。
    if (!parts.length) {
      try {
        const r = searchOldMessages({ messagesDbPath, chatKey: ck, who: h.uid, daysFrom: 3650, limit: 2 });
        for (const m of r.rows || []) {
          const s = clean(`${m.time} ${m.self ? '我说' : '他说'}：${m.text}`, 170);
          if (s) parts.push({ text: s, src: '原话', score: 0 });
        }
      } catch { /* ignore */ }
    }

    if (!parts.length) continue;
    const uniq = dedupe(parts).slice(0, Math.max(1, maxItemsPerPerson) * 2);
    if (!uniq.length) continue;
    blocks.push({ ...h, items: uniq });
    if (lastQueryAt) lastQueryAt.set(`${ck}|${h.uid}`, now);
  }

  if (!blocks.length) return { text: '', stats };

  // ---------- 4. 渲染 ----------
  const L = [];
  L.push('【想起来了】下面是你**自己记得**的、跟这轮对话有关的事（程序按话题自动捞出来的，不是你查的）：');
  for (const b of blocks) {
    L.push(`${b.name || b.uid}：`);
    for (const it of b.items) L.push(`  · ${it.text}`);
  }
  L.push('用法：这些是真的，可以自然地接一句（"你上次不是说…""我记得你说过…"）。'
    + '但**别一次全倒出来、别逐条念**，说过头就像在背档案。没对上的就无视。');

  let text = L.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n（后面还有，省略）';
  stats.people = blocks.length;
  stats.items = blocks.reduce((n, b) => n + b.items.length, 0);
  stats.chars = text.length;
  return { text, stats };
}
