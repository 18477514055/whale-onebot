// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
/**
 * 关系史（relational memory）—— 让记忆从"档案标签"变成"人际回忆"。
 *
 * ★★ 为什么需要它（2026-10-27 用户要求「能不能让他更像是一个活人一样的记忆」）：
 *   实测本机 349 条印象里，**268 条（77%）从头到尾没有出现过"我/机器人"**。
 *   也就是说现有的【记忆】全是在描述"他是个什么样的人"——
 *   「他说话幽默爱吐槽」「他爱玩 AI 梗」「他带湖北口音」。
 *   那是**档案**，不是**回忆**。活人记朋友不是这么记的，活人记的是：
 *   「上次他说要给我加个功能，结果加坏了还嘴硬」「他每次都说自己下班了又不下」。
 *
 * ★ 本模块**不改作者的印象文件**（那是作者的存储，动了升级会冲突），
 *   也**不改整理提示词**（那个改动会影响所有人的印象生成，风险大）。
 *   它做的是：在**注入时**额外算一段**确定性的、关于"我们之间"的事实**，
 *   与【记忆】（他是谁）并列，补上【关系】（我们之间怎样）。
 *
 * ★ 三层信息，全部**零 LLM、可复算**：
 *   1. **相处时长与频度**：认识多少天 / 他跟我说过多少句 / 我回过他多少句；
 *   2. **最近一次互动**：多久以前、他最后说的那句话（原话，不是摘要）；
 *   3. **我们之间的"梗"**：他提过的、跟机器人有关的那些固定说法（复算 + 去重）。
 *
 * ★ 铁律：**只放真实算得出来的数字和原话**。算不出来就不写这一段，
 *   绝不为了"显得有记忆"而编一句"你们关系很好"。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { localSourceVisible } from './local-query-policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 把一条存的原文清洗成"能当原话念出来"的样子。
 *
 * ★ 2026-10-29 抽出来（原来只用在"梗"那一段，`lastText` 没清洗）：
 *   实测【我们之间】渲染出了这样一句：
 *
 *   —— 引用头与会话噪点全带进去了，读起来完全不像"他上次跟我说的话"。
 *   ⇒ **凡是会进提示词的原文，都过这一道**。
 */
export function cleanQuote(v, n = 120) {
  let t = clean(v, n);
  t = t.replace(/^\[引用[^\]]*\]\s*/g, '');     // 完整引用头
  t = t.replace(/^[^\]]{0,40}\]\s*/g, '');      // 被截断的引用头残尾
  t = t.replace(/\[at\]/g, '');                 // at 占位符
  t = t.replace(/^@\S+\s*/, '').replace(/^[@\s]+/, '').trim();
  // JSON 数组残留（模型多气泡被原样存进库）：以 [ 或 " 开头、或含 `", "` 的一律不要
  if (/^[[{]/.test(t) || /"\s*,\s*"/.test(t)) return '';
  return t.trim();
}

/** 上海时区的相对时间说法（"3 天前"/"2 小时前"），比绝对时间戳更像人话。 */
export function humanAgo(then, now = Date.now()) {
  const d = now - Number(then || 0);
  if (!Number.isFinite(d) || d < 0) return '';
  const m = Math.round(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const dd = Math.round(h / 24);
  if (dd < 30) return `${dd} 天前`;
  const mo = Math.round(dd / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.round(mo / 12)} 年前`;
}

function openDb(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return new DatabaseSync(file, { readOnly: true });
  } catch { return null; }
}

/**
 * 算一个人跟"我"的相处史。
 *
 * @param {string} uin  对方 QQ
 * @param {object} o
 * @param {string} o.messagesDbPath
 * @param {string} [o.chatKey]  传了就按这个会话算（与 promptScope='chat' 一致）；不传算全部
 * @param {string} [o.selfUin]
 * @param {number} [o.maxMentions]  最多列几条"他提过我的说法"
 * @returns {object|null} null = 数据不足，调用方不要输出这一段
 */
export function getRelationalFacts(uin, {
  messagesDbPath,
  chatKey = '',
  selfUin = '',
  maxMentions = 3,
  now = Date.now()
} = {}) {
  const uid = String(uin || '').trim();
  if (!uid || !messagesDbPath) return null;
  if (chatKey && !localSourceVisible(chatKey, chatKey, uid)) return null;
  const db = openDb(messagesDbPath);
  if (!db) return null;

  try {
    const scope = chatKey ? 'AND chat_key = ?' : '';
    const args = chatKey ? [uid, chatKey] : [uid];

    // ① 基本量：说了多少句、跨度多久
    const agg = db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last
      FROM messages WHERE sender_id = ? ${scope}`).get(...args);
    const count = Number(agg?.n) || 0;
    if (count < 2) return null;   // 只说过一句的人没有"关系史"可言

    const first = Number(agg.first) || 0;
    const last = Number(agg.last) || 0;

    // ★ 「认识多久」必须按**全局**第一次见面算，不能按本群——否则同一个人在小群
    //   今天是"认识 1 天"、在大群是"认识 36 天"，同一个人的关系史会自相矛盾。
// Distribution source.
    //   而他实际从 2026-09-21 就开始了。相处时长是**跨群累计的事实**，不是群内统计。
    let globalFirst = first;
    try {
      const g = db.prepare(`SELECT MIN(ts) AS f FROM messages WHERE sender_id = ?`).get(uid);
      if (Number(g?.f) > 0) globalFirst = Number(g.f);
    } catch { /* 取不到就退回本群口径 */ }
    const days = globalFirst ? Math.max(1, Math.round((now - globalFirst) / DAY_MS)) : 0;

    // ② 这个会话里我发过多少句（**注意措辞**：这是"我在这个群说话的总量"，
    //   不是"我回过他多少句"——后者要按回合配对算，容易算错且意义含糊。
    //   渲染时必须说成"我在这个群里说过 N 句"，不能写成"我一共回了 N 句"。实测写错过一次。）
    let myCount = 0;
    if (chatKey) {
      const mine = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_key = ? AND self = 1`).get(chatKey);
      myCount = Number(mine?.n) || 0;
    }

    // ③ 他最后说的那句原话（比摘要更有"回忆感"）
    const lastMsg = db.prepare(`SELECT ts, text FROM messages
      WHERE sender_id = ? ${scope} AND TRIM(COALESCE(text,'')) <> ''
      ORDER BY ts DESC LIMIT 1`).get(...args);

    // ④ 他 @ 过我多少次（"找我说话"的直接证据）
    const at = db.prepare(`SELECT COUNT(*) AS n FROM messages
      WHERE sender_id = ? ${scope} AND mentions_self = 1`).get(...args);
    const atCount = Number(at?.n) || 0;

    // ⑤ 我们之间的"梗"：他提到机器人/我的那几句里，出现频次最高的短句
    //    ★ 只取**短文**（≤40 字），长段落是正经讨论不是梗。
    //    ★★ 必须排除**指令词**（亲密度 / 赞赏链接 / 指令 …）—— 那些是他触发固定回复时
    //       打的关键词，不是"他常这样提起我"。实测第一版把「亲密度」「赞赏链接」当成
    //       梗列了出来，读起来完全不像回忆。排除表来自 config.json 的 cannedReplies 规则。
    const commandWords = new Set();
    try {
      const cfgFile = path.join(path.dirname(String(messagesDbPath)), 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
      for (const r of cfg?.cannedReplies?.rules || []) {
        for (const tr of r.triggers || []) {
          const s = clean(tr, 20);
          if (s) commandWords.add(s);
        }
      }
    } catch { /* 读不到配置就不排除，宁多勿错 */ }

    const rawMentions = db.prepare(`SELECT text FROM messages
      WHERE sender_id = ? ${scope}
        AND (text LIKE '%哦鲸鲸%' OR text LIKE '%小鲸鱼%' OR text LIKE '%大肥鱼%' OR text LIKE '%DeepSeek%')
        AND LENGTH(TRIM(COALESCE(text,''))) BETWEEN 2 AND 40
      ORDER BY ts DESC LIMIT 200`).all(...args);
    const freq = new Map();
    for (const r of rawMentions) {
      // ★ 与 cleanQuote 同一套清洗（2026-10-29 抽出去了，两处不能再各写一份）
      const body = cleanQuote(r.text, 40);
      if (body.length < 2) continue;
      // 纯指令词 / 指令词+@ 的组合，一律不算"梗"
      const bare = body.replace(/[@\s]/g, '');
      if (commandWords.has(bare) || commandWords.has(body)) continue;
      // 太像命令的也排除（"赞赏链接"这类即便不在配置里也不该当梗）
      if (/^(亲密度|好感度|关系分|赞赏|赞助|指令|帮助|列表)/.test(bare)) continue;
      // 纯符号/纯表情（如「[图片]」「…」「？」）没有回忆价值
      if (!/[\u4e00-\u9fffA-Za-z]/.test(body)) continue;
      freq.set(body, (freq.get(body) || 0) + 1);
    }
    const mentions = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.min(6, Number(maxMentions) || 3)))
      .map(([text, n]) => ({ text, times: n }));

    return {
      uin: uid,
      chatKey: chatKey || '',
      count,
      myCount,
      atCount,
      first,
      last,
      days,
      lastText: cleanQuote(lastMsg?.text, 120),
      lastAt: Number(lastMsg?.ts) || 0,
      lastAgo: humanAgo(lastMsg?.ts, now),
      mentions
    };
  } catch {
    return null;   // 关系史是增强项，读失败绝不能影响正常回复
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 渲染成给模型看的一段【我们之间】。
 * ★ 措辞目标：像"回忆"，不像"报表"。所以先说相处多久，再说最近一次，最后才是梗。
 * ★ 数字必须是真的：一处算不出来就整句不写。
 */
export function formatRelationalFacts(f, { name = '' } = {}) {
  if (!f) return '';
  const who = clean(name, 40) || f.uin;
  const bits = [];

  if (f.days > 0) bits.push(`认识 ${f.days} 天`);
  if (f.count > 0) bits.push(`他说过 ${f.count} 句`);
  // ★ 措辞必须是"我在这个群说过"：这个数是**我在本群说话的总量**，
  //   不是"我回过他多少句"。写成后者是错的（实测写错过一次）。
  if (f.myCount > 0) bits.push(`我在这个群说过 ${f.myCount} 句`);
  if (f.atCount > 0) bits.push(`他 @ 过我 ${f.atCount} 次`);
  if (!bits.length) return '';

  const lines = [`他（${who}）跟我：${bits.join('，')}。`];

  if (f.lastText) {
    const ago = f.lastAgo ? `（${f.lastAgo}）` : '';
    lines.push(`- 他最近一次跟我说话${ago}：「${f.lastText}」`);
  }
  if (f.mentions?.length) {
    const m = f.mentions.map((x) => `「${x.text}」${x.times > 1 ? `（${x.times} 次）` : ''}`).join('、');
    lines.push(`- 他常这样提起我：${m}`);
  }
  lines.push('用法：这些是**你俩之间**的事实，可以自然地当作"我还记得"来用（比如顺口提一句"你上次说要给我加功能"），但别一次全倒出来，也别逐条念数字。');
  return lines.join('\n');
}
