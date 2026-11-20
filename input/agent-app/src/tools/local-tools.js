// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 我们（本地）追加的只读工具集 —— **独立文件，不改作者 tools-core 的逻辑**。
//
// ★ 设计意图（为什么单独一个文件）：
//   作者的 `src/tools/tools-core.js` 有 3045 行，是他改得最猛的文件之一（0.9.8→0.9.10 从
//   49K 涨到 175K）。把我们的 6 个工具**内联**进去，等于每次他更新都要在那 3000 行里
//   重新找位置插一次 —— 冲突面最大、最容易出错。
//   ⇒ 改成：我们的工具全住在这个文件里，`tools-core.js` 只加**一处两行**的注册
//     （import + 展开）。将来他重构 tools-core，我们只需要重新放这两行。
//
// ★ 硬约束（照抄我们生产代码的语义，不要改坏）：
//   ① ~~全部只读~~ → **2026-11-09 更正：本条已过时**。现在有写操作：
//      `checkin` / `mark_event` / `feed_rice`（写本群心情与投喂账）、
//      `lesson_remember`（写本群经验教训库）。只读的是**查库类**工具。
//      写操作一律只写 `ctx.chatKey` 指的那一份数据，且都走原子写。
//   ② **只认 ctx.chatKey**，参数里绝不出现 chatKey/groupId —— 模型物理上无法写/查别的群。
//      这是「跨群不污染」的结构性保证，不是靠提示词叮嘱。
//   ③ 路径来自 ctx.memoryPaths（由 orchestrator 注入，见接线点 ②），
//      不在这里硬编码任何绝对路径 —— 否则换个部署目录就废了。
//   ④ 失败一律返回可读错误，绝不抛出去炸掉整轮对话。

// ★ 2026-10-29：亲密度查询改走融合版（见下方 get_intimacy 的 execute）。
//   这两个纯统计入口已不再直接使用，只保留 MIN_CHAT_MESSAGES_FOR_RANK（文案里要报名次门槛）。
import { MIN_CHAT_MESSAGES_FOR_RANK } from '../features/intimacy.js';
import { searchOldMessages, formatOldMessages } from '../memory/message-search.js';
import { getCrossChatProfile, listPeopleSeenElsewhere, chatActivityFor, describeChat } from '../memory/cross-chat-memory.js';
import { publishedMoments, formatMomentsForModel } from '../features/self-moments.js';
import { getRelationalFacts, formatRelationalFacts } from '../memory/relational-memory.js';
// ★ 2026-11-09：经验教训库（我答错过、且已联网核对的结论，按 chatKey 存）
import { rememberLesson, lookupLessons } from '../lessons/store.js';
import { extractSearchKeyword } from '../memory/keyword-extract.js';
import { localHistorySql } from '../memory/local-query-policy.js';
// ★ 2026-10-29：记忆的出处（方案 E）—— 被问"你怎么知道"时从真实聊天记录里捞原话。
//   平时零注入，只在工具被调用时才查。
import { findMemoryQuotes } from '../memory/local-impressions.js';
// ★ 2026-10-27：指令清单里「插件 / MCP / 技能」那一段的唯一真源。
//   与 features/canned-replies.js 的 formatCommandList() 用的是同一个函数 ⇒ 两处永远一致。
import { catalogText } from '../features/local-commands-catalog.js';
// ★ 2026-10-28：多领域知识库（向量+关键词混合，按需检索、默认零注入）。
//   与作者的 knowledge_search 并存：那个适合几十份小文档，这个管"大语料 + 多领域"。
import { search as searchKnowledgeLib, stats as knowledgeLibStats, loadLibraries as loadKnowledgeLibs } from '../features/knowledge-lib.js';
// ★ 2026-10-29：群打卡（每群独立、按天记名次）。同样**不注入提示词**，只在模型调用时读。
import { checkIn, dayBoard, recentStats, personHistory, stats as checkinStats } from '../features/checkin.js';
// ★ 2026-10-29：亲密度事件层 + 融合层。
//   · 事件层：模型写"发生了什么"（正面/负面/中性），代码按类型表折算分数 —— 模型不能直接给分。
//   · 融合层：最终分 = 统计分 × (1 + 0.35 × 事件分)，事件是修正项不是主项。
import {
  recordEvent, listEvents, eventScore, EVENT_KINDS
} from '../features/intimacy-events.js';
import {
  getPersonIntimacyFused, getChatRankingFused
} from '../features/intimacy-fused.js';
// ★ 2026-10-30：心情引擎（关掉了上游那套）。事件 → 情绪冲击的唯一入口在这里。
import { applyMoodImpact, nudgeMood, currentMood } from '../features/mood-engine.js';
// ★ 2026-10-31：投喂白饭（群友 @机器人 喂饭 → 回一点精力）。参数与理由见该文件头部。
import { feedEnergy, feedQuota, feedBoard, FEED_PER_USER_PER_DAY, FEED_ENERGY } from '../features/feed-energy.js';

const ok = (value) => ({
  content: typeof value === 'string' ? value : JSON.stringify(value, null, 1)
});
const err = (message) => ({ content: `错误：${String(message ?? '未知错误')}`, isError: true });

/** 统一的「这条会话的数据路径」取值：缺了就明确报错，绝不猜。 */
function pathsOf(ctx) {
  const p = ctx?.memoryPaths || {};
  if (!p.messagesDbPath) throw new Error('记忆数据路径未配置（ctx.memoryPaths 缺失）');
  return p;
}

export function buildLocalToolDefs() {
  return [
    // ── 1. 亲密度 ────────────────────────────────────────────────────────
    {
      name: 'get_intimacy',
      description:
        '查看亲密度（你对群友的熟悉程度，0–100 分）。' +
        '不带 who 时按「你在这个群里的名次」查你自己（注：机器人自己不是群友，通常查不到自己的分，会如实说明）。' +
        '带 who 查某个群友（QQ 号或本群昵称）。ranking=true 看本群亲密度榜。' +
        '★ 只统计**当前这个会话**的互动，不会去看别的群；名次也是本群内的名次。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '要查谁（QQ 号或本群昵称）。不填就查自己。' },
          ranking: { type: 'boolean', description: 'true 时返回本群亲密度榜（前 10 名），忽略 who。' }
        }
      },
      async execute(ctx, args) {
        try {
          const chatKey = String(ctx.chatKey || '');
          const paths = pathsOf(ctx);
          // ★ 2026-10-29：改用**融合版**（统计分 + 事件分）。
          //   原来直接读 getChatRanking/getPersonIntimacy，模型看到的是"纯统计分"，
          //   而事件是它自己记的 —— 那会让它觉得"我记的事件没用"，于是不再愿意记。
          const dataDir = ctx.memoryPaths?.dataDir || '';
          const common = { messagesDbPath: paths.messagesDbPath, relationshipDbPath: paths.relationshipDbPath, chatKey, dataDir };

          if (args.ranking === true) {
            const board = getChatRankingFused(chatKey, { ...common, limit: 10 });
            if (!board?.ok) return ok('这个会话还没有亲密度数据（可能刚建立，还没有足够互动）。');
            if (!board.total) return ok(`本群还没有人上榜（在群里说过 ${board.minMessages} 句以上才会进榜）。`);
            const lines = board.rows.map((r) => {
              const ev = r.eventDelta ? `，事件 ${r.eventDelta > 0 ? '+' : ''}${r.eventDelta}` : '';
              return `第${r.rank}名 ${r.uin}：${r.score} 分（${r.tier}，本群说了 ${r.chatMessageCount} 句${ev}）`;
            });
            return ok(
              `本群亲密度榜（共 ${board.total} 人上榜，门槛是说过 ${board.minMessages} 句以上；只统计本群）：\n` +
              lines.join('\n')
            );
          }

          // 查自己：机器人自己的消息在库里 sender_id='self'，不在「群友」统计范围内
          const rawWho = String(args.who ?? '').trim();
          if (!rawWho) {
            return ok(
              `亲密度是「群友和你有多熟」的分数，你自己就是那个「你」，所以没有自己的分。\n` +
              `想查谁就告诉我是谁（QQ 号或本群昵称），或者用 ranking=true 看本群榜。`
            );
          }
          const info = getPersonIntimacyFused(rawWho, common);
          // ★★★ 2026-10-27 修：亲密度**绑人，不绑群**。
          //   旧代码在 `info.inRoster === false` 时直接回「在本群只说过 N 句，还太少」——
          //   而 inRoster 当时按"本群 ≥2 句"算 ⇒ 同一个人换个新群就看不到分数。
          //   现在 inRoster 改为"全库有过互动"，跨群一致；本群没名次只影响"报不报名次"。
          if (!info) {
            return ok(`找不到「${rawWho}」——这个人从没跟机器人互动过（任何会话都没有记录），所以还没有亲密度。`);
          }
          // ★ 2026-10-29：把「统计分 / 事件分」拆开展示。
          //   模型需要知道"这个分是怎么来的"——否则它没法解释、也不知道自己记的事件有没有生效。
          const evLine = info.eventCount
            ? `（基础 ${info.baseScore} 分，事件影响 ${info.eventDelta > 0 ? '+' : ''}${info.eventDelta}，共 ${info.eventCount} 条事件）`
            : '（还没有记录过任何事件）';
          const inBoard = info.rank != null && Number(info.total) > 0;
          if (inBoard) {
            return ok(
              `亲密度 ${info.score}/100（${info.tier}）${evLine}，本群第 ${info.rank}/${info.total} 名，本群说了 ${info.chatMessageCount} 句。`
            );
          }
          // 有分数但本群还没入榜：**照样给分数**，只是不报名次
          return ok(
            `亲密度 ${info.score}/100（${info.tier}）${evLine}。他本群还没入榜（本群只说了 ${info.chatMessageCount ?? 0} 句，` +
            `门槛 ${MIN_CHAT_MESSAGES_FOR_RANK} 句），但亲密度是按人算的，换个群看到的分数一样。`
          );
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 2. 搜历史原话 ────────────────────────────────────────────────────
    {
      name: 'search_old_messages',
      description:
        '在当前会话里**按关键词/时间搜历史消息原文** —— 这是唯一能翻到「几个月前」的工具。' +
        '提示词里的【最近的事】只有最近几段，recall_events 的事件也只覆盖较近一段时间，' +
        '但原始消息**全都在**。适合：「我们最早聊过什么」「他几个月前说过那句是什么」「这梗哪来的」。' +
        '★ 只搜**当前这个会话**，不会看别的群。★ 返回原话+时间，不替你总结。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词（不区分大小写，匹配正文或说话人）' },
          who: { type: 'string', description: '可选：只看某人的发言（QQ 号或名字片段）' },
          daysFrom: { type: 'integer', description: '从几天前开始，默认 365（能翻到头）；只看最近就填 7' },
          daysTo: { type: 'integer', description: '查到几天前为止，默认 0 = 今天' },
          limit: { type: 'integer', description: '最多几条，默认 12，最大 50' },
          selfOnly: { type: 'boolean', description: '可选：true 只看我自己说过的' },
          oldestFirst: { type: 'boolean', description: '可选：true 从最早开始给（想翻「我们最早聊了什么」时用）' }
        }
      },
      async execute(ctx, args) {
        try {
          const paths = pathsOf(ctx);
          // ★ 关键词兜底（生产实测踩过的坑）：模型常把**整句**当关键词传进来
          //   （比如 "我们最早聊"），而整句在 SQL LIKE 里**必然 0 命中** —— 症状是
          //   三句不同问句返回同样的两条（看着在工作，其实兜底生效，等于没搜）。
          //   ⇒ 检测到"关键词过长/像一句话"就抽实体词；抽不出就保留原样（宁可搜不到也不瞎搜）。
          const rawKeyword = String(args.keyword ?? '').trim();
          let keyword = rawKeyword;
          if (rawKeyword.length > 6 || /[？?吗呢吧]/.test(rawKeyword)) {
            const ext = extractSearchKeyword(rawKeyword);
            if (ext?.keyword) keyword = ext.keyword;
          }
          const result = searchOldMessages({
            messagesDbPath: paths.messagesDbPath,
            chatKey: String(ctx.chatKey || ''),   // ★ 只认当前会话
            keyword,
            who: String(args.who ?? ''),
            daysFrom: args.daysFrom,
            daysTo: args.daysTo,
            limit: Math.min(50, Math.max(1, Number(args.limit) || 12)),
            selfOnly: args.selfOnly === true,
            oldestFirst: args.oldestFirst === true
          });
          return ok(formatOldMessages(result, {
            keyword,
            who: String(args.who ?? '').trim()
          }));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 3. 跨群记忆 ──────────────────────────────────────────────────────
    {
      name: 'get_cross_chat_memory',
      description:
        '你的**跨群记忆**：某个人在别的群/私聊里也出现过吗、各说了多少句、那边叫什么。' +
        '不传 who：列出**本群里也在别处出现过的人**（只给身份，不含别的群的内容）。' +
        '传 who：给出这个人出现过的地方与发言量。' +
        '★ 平时几乎用不上；**只有当群友明确问起跨群的事**才用。' +
        '★ 绝不主动把别的群的内容搬进当前对话 —— 默认是隔离的，这里是「问起才查」的通道。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '可选：要查谁（QQ 号或名字片段）。不填就列出本群里的跨群人员。' }
        }
      },
      async execute(ctx, args) {
        try {
          const paths = pathsOf(ctx);
          const chatKey = String(ctx.chatKey || '');
          const who = String(args.who ?? '').trim();

          if (!who) {
            const list = listPeopleSeenElsewhere({ peopleDir: paths.peopleDir, chatKey, limit: 20 });
            if (!list?.length) return ok('本群里的人似乎都只在这个群出现过（没有跨群记录）。');
            const lines = list.map((p) => `- ${p.uin}：还在 ${p.otherChats.length} 个地方出现过（${p.otherChatLabels.join('、')}）`);
            return ok(
              `本群里也在别处出现过的人（共 ${list.length} 位；**这里只给身份，不含别的群的内容**）：\n` +
              lines.join('\n') +
              '\n\n想知道某个人的细节，可以传 who 再查。'
            );
          }

          const profile = getCrossChatProfile(who, { peopleDir: paths.peopleDir, chatKey });
          if (!profile) return ok(`找不到「${who}」的记录（可能他还没有被记下印象）。`);
          const acts = chatActivityFor(who, { messagesDbPath: paths.messagesDbPath });
          const lines = [];
          lines.push(`关于 ${who}：`);
          if (acts?.length) {
            lines.push(`- 在以下地方说过话：${acts.map((a) => `${a.label} ${a.messages} 句`).join('、')}`);
          }
          const others = (profile.otherChats || []).filter((k) => k !== chatKey);
          if (others.length) {
            lines.push(`- 除了本群，还在：${(profile.otherChatLabels || []).filter((_, i) => profile.otherChats[i] !== chatKey).join('、')}`);
          } else {
            lines.push('- 只在本群出现过');
          }
          lines.push(`- 印象共 ${profile.totalImpressions} 条（只有一份整体画像，不按群拆）`);
          if (profile.impressions?.length) {
            for (const e of profile.impressions.slice(0, 5)) lines.push(`  · ${e}`);
          }
          lines.push('\n★ 这些是「关于这个人的身份与整体印象」，不是别的群的聊天内容；不要把别群的原话搬过来。');
          return ok(lines.join('\n'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },


    // ── 3b. 搜别的群聊过什么（**按需**，默认不注入）──────────────────────
    {
      name: 'search_other_chats',
      description:
        '去**别的群/私聊**翻聊天记录（你自己不在的那些会话）。' +
        '★ 什么时候用：群友**主动聊起**一件你可能在别处见过的事、或者问"你知不知道那边怎么样"，' +
        '用这个去查；**没人提就别主动查、更不要主动说出来**。' +
        '★ 查到的东西**不要一上来就抖**：先确认对方是不是真的在聊这个话题，再自然接话；' +
        '不要复述原文、不要说"我在另一个群看到有人说"。' +
        '★ 只给当前这个人或者这个话题相关的片段，不做"别群新闻播报"。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要搜的词（具体名词最好，别填整句）' },
          who: { type: 'string', description: '限定某个人（QQ 号）；不填就搜全部别的会话' },
          days: { type: 'integer', description: '只看最近几天，默认 30，最多 365' },
          limit: { type: 'integer', description: '返回几条，默认 8，最多 20' }
        }
      },
      async execute(ctx, args) {
        try {
          const paths = pathsOf(ctx);
          const chatKey = String(ctx.chatKey || '');
          const keyword = String(args.keyword ?? '').trim();
          const who = String(args.who ?? '').trim();
          if (!keyword && !who) return err('至少给 keyword 或 who 一个');
          const dbPath = paths.messagesDbPath;

          const days = Math.min(365, Math.max(1, Number(args.days) || 30));
          const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
          const since = Date.now() - days * 24 * 3600 * 1000;

          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            const where = ["chat_key <> ?", 'self=0', 'ts >= ?', "TRIM(COALESCE(text,'')) <> ''"];
            const argv = [chatKey, since];
            if (keyword) { where.push('text LIKE ? COLLATE NOCASE'); argv.push('%' + keyword + '%'); }
            if (/^\d{5,15}$/.test(who)) { where.push('sender_id = ?'); argv.push(who); }
            const policy = localHistorySql(chatKey);
            argv.push(...policy.args);
            const cond = where.join(' AND ') + policy.clause;
            const rows = db.prepare(
              'SELECT chat_key, ts, sender_name, text FROM messages WHERE ' + cond +
              ' ORDER BY ts DESC LIMIT ?'
            ).all(...argv, limit);

            if (!rows.length) {
              return ok('别的会话里没搜到相关内容（' + (keyword ? '关键词「' + keyword + '」' : '') +
                (who ? ' 人 ' + who : '') + '，最近 ' + days + ' 天）。');
            }
            const lines = rows.map((r) => {
              const when = new Date(Number(r.ts) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
// Distribution source.
              //   群号是可以被外人拿去搜群/加群的，而跨群记忆的价值是"记得内容"，不是"知道那是哪个群"。
              //   ⇒ 这里只给匿名说法。
              const where2 = /^private:/.test(String(r.chat_key)) ? '一个私聊' : '另一个群';
              const clean = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 120);
              return '- [' + where2 + ' · ' + when + '] ' + String(r.sender_name ?? '') + '：' + clean;
            });
            return ok(
              '在**别的会话**里搜到 ' + rows.length + ' 条（最近 ' + days + ' 天）：\n' + lines.join('\n') +
              '\n\n★ 这些是别处的记录。**只在对方正在聊这个话题时**拿来用；不要复述原文、' +
              '不要说"我在另一个群看到"，也不要主动提起别群的人和事。'
            );
          } finally {
            try { db.close(); } catch { /* ignore */ }
          }
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },


    // ── 3c. 知识库检索（多领域，**按需**，默认零注入）──────────────────────
    {
      name: 'kb_search',
      description:
        '查**资料库**（管理员导入的知识库，可能包含游戏资料/学术资料/小说设定等几套）。' +
        '★ 什么时候用：聊到某个具体设定、名词、规则、剧情、公式、剧情人物时，**不确定就别猜**，先查一下；' +
        '  查不到就说不知道，**绝不要凭印象编**。' +
        '★★ 资料库**只覆盖"是什么/有什么数值"**（本地化文本 + 结构化条目），' +
        '  **不覆盖"该怎么玩/哪个强/怎么选"** —— 这类判断性问题资料库里没有答案，' +
        '  查到的多半是名字相近的无关条目。遇到这类问题请直接 web_search，不要用资料库硬凑。' +
        '★ 平时不要主动翻资料库，也不要在没人问的时候引用里面的内容。' +
        '★ 回答时用你自己的话讲，**不要大段照抄原文**，也不要提"资料库里写着"。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的内容（自然语言或关键词都行）' },
          lib: { type: 'string', description: '可选：只查某一套资料（不填就全查）' },
          limit: { type: 'integer', description: '返回几段，默认 6，最多 20' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          if (!dataDir) return err('数据目录未配置，无法查资料库');
          const query = String(args.query ?? '').trim();
          if (!query) return err('query 不能为空');

          // ★★★ 2026-11-09 用户反馈新增：
          //   「他能回答某个东西是什么，但是不能回答该怎么去游玩……问一个游戏中的选择性问题，
          //     他就回答不了了，或者是会回答错误的答案」
          //   实测确认（2026-11-09）：资料库语料是"本地化文本 + 数值条目"，
          //     · 「行星飞升 效果」→ 能对上
          //     · 「开局选哪个起源最强」→ 返回「巨构容量」
          //     · 「早期怎么发展经济」→ 返回「物种发育阶段」
          //   ⇒ 判断型问题**必然**返回名字相近的噪音，而模型会把这个噪音翻译成结论
          //     （用户说的"被翻译过后变成假的"就是这个）。
          //   ⇒ 结构性修法：**在工具层就把这类查询拦下来**，明确告知不覆盖 + 引导联网，
          //     而不是把噪音丢给模型去圆。这比只写提示词可靠 —— 提示词会被忽略，返回值不会。
          const JUDGEMENT_PATTERNS = [
            // ① 强度 / 名次
            /最强|哪个强|哪个好|哪个更|谁强|更强|强度|排名|排行|tier|梯度|榜/,
            // ② 玩法 / 路线（含"起手"）
            /怎么玩|怎么打|如何玩|玩法|攻略|套路|流派|路线|build|配装|加点|开局思路|起手/,
            // ③ 取舍（含用户点名的"该不该建/先建什么好"）
            /怎么选|选哪|该选|推荐|值不值|好不好|要不要|划不划算|该不该|值得建|先建哪|建什么好|建这个/,
            // ④ 节奏 / 优先级
            /怎么发展|怎么运营|怎么开局|前期怎么|中期怎么|后期怎么|该走哪|优先(建|升|点|造)/,
            // ⑤ "哪个 X"：X 是选择题对象（不是"哪个数值"这类事实问法）
            /哪个(文明|种族|国家|领袖|起源|国策|飞升|天赋|区域|建筑|科技|传统|理念)/
          ];
          // ★ 按库分流（2026-11-09 补）：小说库里**有**剧情，问"书里人物为什么选那条路"
          //   是资料库答得出的，不能误拦。所以：
          //   · 模型明确指定了**非游戏库**（novel/academic…）⇒ 尊重它的选择，放行；
          //   · 指定的是**游戏库**（stellaris/civ6）或不指定 ⇒ 判断型一律拦
          //     —— 因为游戏语料里只有名称与数值，没有任何评价。
          const libArg = args.lib ? String(args.lib).trim() : '';
          const GAME_LIB = /^(stellaris|civ6|civilization|群星|文明)/i;
          const trustedLib = Boolean(libArg) && !GAME_LIB.test(libArg);
          const isJudgement = !trustedLib && JUDGEMENT_PATTERNS.some((re) => re.test(query));
          if (isJudgement) {
            return ok(
              `⚠ 这是**判断型问题**（该怎么做/哪个强/怎么选），资料库不覆盖这类内容。\n`
              + `资料库里只有"某个东西是什么、字段数值是多少"这类条目，`
              + `没有强度评价、没有攻略路线、也没有玩家共识 —— `
              + `拿它来答"${query}"只会捞到名字相近的无关条目，再翻译一遍就是错的。\n\n`
              + `★ 正确做法：直接用 web_search 查（查询带游戏名 + 版本/DLC）。\n`
              + `★ 查不到可靠说法就照实说没查到，**不要用资料库条目硬凑一个结论**。\n`
              + `★ 例外：如果这其实是问**小说剧情里的人物选择/走向**（不是游戏玩法），`
              + `  那属于资料库范围 —— 带上 lib 参数（例如 lib:"novel"）再查一次。`
            );
          }

          const libs = args.lib ? [String(args.lib).trim()] : null;
          const r = await searchKnowledgeLib(dataDir, query, {
            libs, limit: Math.min(20, Math.max(1, Number(args.limit) || 6))
          });
          if (!r.results.length) {
            const known = Object.keys(loadKnowledgeLibs(dataDir));
            return ok(known.length
              ? `资料库里没找到和「${query}」相关的内容（已查：${known.join('、')}）。**不要编，直接说没查到**。`
              : '还没配置任何资料库。');
          }
          const body = r.results.map((x, i) =>
            `${i + 1}. [${x.libName}] ${x.text.slice(0, 700)}`).join('\n\n');
          return ok(
            `查到 ${r.results.length} 段（${r.results.map((x) => x.libName).filter((v, i, a) => a.indexOf(v) === i).join('、')}）：\n\n` + body +
            '\n\n★ 用你自己的话讲，别大段照抄，也别提"资料库"这个词。片段不够就直说不知道。' +
            '\n★★ 只写上面原文支持的结论；原文没说的不要补、不要推。数值/条件要照抄，不要意译。'
          );
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 3d. 群打卡（签到）────────────────────────────────────────────────
    // ★★★ 2026-10-29 用户要求（原话）：
    //   「加一个打卡功能（也加固定提示词），模型回复"@XXX 本群第N个打卡"，
    //     然后维护一个清单（不主动进上下文），展示每天打卡情况、近七天打卡统计，
    //     保存在记忆库内或其他你认为适合的地方，注意分好几个群不要互相影响」
    //
    // ★ 四个要点分别落在哪：
    //   ① 「回复 @XXX 本群第N个打卡」→ 本工具返回 seq/total，**由提示词规定怎么说话**；
    //   ② 「清单不主动进上下文」→ 本模块不导出提示词片段、不被 prompt.js 引用（结构性保证）；
    //   ③ 「每天 + 近七天」→ day 看当天榜，days 看统计；
    //   ④ 「分群不互相影响」→ 每条 SQL 都带 chat_key，且 chatKey 只来自 ctx.chatKey。
    {
      name: 'checkin',
      description:
        '给**当前这个群**里某个人记一次今天的打卡（签到），返回他今天在本群是第几个。' +
        '★ 有人说"打卡""签到""报个到""我来了"这类意思时调用它。' +
        '★ 同一个人今天已经打过卡时，会返回**他原来那个名次**（不会重新排、不会重复计数）。' +
        '★ 不填 who 就默认给"刚说话的那个人"打卡——这是最常用的情形，直接不填即可。' +
        '★ 只作用于当前群，不会写到别的群。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '可选：给谁打卡（QQ 号或本群昵称）。不填 = 刚说话的那个人。' },
          name: { type: 'string', description: '可选：显示用的名字。一般不填，会自动取对方的群昵称。' }
        }
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          if (!dataDir) return err('数据目录未配置，无法记录打卡');
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失，无法记录打卡');

          // 默认打卡对象 = 本轮触发消息里**最后一个非机器人**的发送者
          const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
          const lastSpeaker = [...entries].reverse().find((m) => !m?.self && m?.senderId);

          const rawWho = String(args.who ?? '').trim();
          let userId = '';
          let userName = String(args.name ?? '').trim();

          if (!rawWho) {
            if (!lastSpeaker) return err('不知道要给谁打卡：没有指定 who，本轮也没有可识别的发言人。');
            userId = String(lastSpeaker.senderId || '').trim();
            if (!userName) userName = String(lastSpeaker.senderName || '').trim();
          } else if (/^\d{4,15}$/.test(rawWho)) {
            userId = rawWho;
            if (!userName) {
              const hit = entries.find((m) => String(m?.senderId || '') === rawWho);
              userName = String(hit?.senderName || '').trim();
            }
          } else {
            // 按昵称在本轮发言人里找（只在本轮里找，不去全库猜——猜错就是给错人打卡）
            const hit = [...entries].reverse().find(
              (m) => !m?.self && String(m?.senderName || '').trim() === rawWho
            );
            if (!hit?.senderId) {
              return err(`没在本轮发言里找到「${rawWho}」。请改用他的 QQ 号，或不填 who 直接给刚说话的人打卡。`);
            }
            userId = String(hit.senderId).trim();
            if (!userName) userName = rawWho;
          }

          const r = checkIn(dataDir, { chatKey, userId, userName });
          const lines = [
            `${r.isRepeat ? '今天已经打过卡了' : '打卡成功'}：${r.userName || userId}（QQ ${userId}）`,
            `本群今天第 ${r.seq} 个打卡，今天一共 ${r.total} 人。`,
            `他本群累计打卡 ${r.personTotalDays} 天，当前连续 ${r.personStreak} 天。`
          ];
          if (r.isRepeat) {
            lines.push('★ 这是重复打卡：名次保持第一次的那个，没有重新排、也没有重复计数。');
          }
          lines.push('★ 回复时按人设自然说一句，形如「@对方 本群第 N 个打卡」；不要提"数据库""记录"这类词。');
          return ok(lines.join('\n'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 亲密度事件（2026-10-29）：让模型主动记录"发生了什么" ──────────────
    // ★ 设计核心：**模型只说事件，不说分数**。
    //   分数由 EVENT_KINDS 表折算（features/intimacy-events.js），模型改不了规则。
    //   这样既满足了"让模型主动打分"的需求，又不会出现"它心情好就全员满分"。
    {
      name: 'mark_event',
      description:
        '给**某个群友**记一条亲密度事件（他做了什么、你对他印象往哪边挪）。' +
        '★ 这不是"打个分"，而是记录**发生过什么**；具体加多少分由系统按事件类型折算，你不需要也不应该自己算分。' +
        '★ 什么时候用：一轮对话结束、你确实对这个人产生了新的看法时记一条；' +
        '  **不要每句话都记**，也不要因为一次小事就夸张地记负面事件。' +
        '★ 同一个人在同一天、同一类型只会记一次（重复调用不会重复计分），所以你不用自己去重。' +
        '★ kind 选最贴近的那个；拿不准就用 chat（中性，不计分）。' +
        '★ 不填 who 就默认记给"刚说话的那个人"。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description:
              '事件类型。正面：help(帮忙/解决问题) care(关心) humor(玩梗搞笑) share(分享好东西) '
              + 'praise(夸奖/感谢) deep_talk(深入聊天) defend(维护别人)；'
              + '负面：insult(辱骂) harass(骚扰) spam(刷屏) troll(挑事) annoy(反复打扰) '
              + 'ignore(问了不理) politics(引战/敏感)；'
              + '中性：chat(普通聊天) greet(打招呼) question(提问) met(初次见)',
            enum: Object.keys(EVENT_KINDS)
          },
          who: { type: 'string', description: '可选：给谁记（QQ 号或本群昵称）。不填 = 刚说话的那个人。' },
          note: { type: 'string', description: '可选：一句话说明发生了什么（会被存下来，以后你自己能看到）。控制在 40 字内。' }
        },
        required: ['kind']
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          if (!dataDir) return err('数据目录未配置，无法记录事件');
          const paths = pathsOf(ctx);
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失，无法记录事件');

          const kind = String(args.kind ?? '').trim();
          if (!EVENT_KINDS[kind]) {
            return err(`未知事件类型「${kind}」。可用：${Object.keys(EVENT_KINDS).join(' / ')}`);
          }

          // 找目标人（与 checkin 同一套口径：只在本轮发言人里找，不去全库猜）
          const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
          const rawWho = String(args.who ?? '').trim();
          let userId = '';
          if (!rawWho) {
            const lastSpeaker = [...entries].reverse().find((m) => !m?.self && m?.senderId);
            if (!lastSpeaker) return err('不知道要记给谁：没指定 who，本轮也没有可识别的发言人。');
            userId = String(lastSpeaker.senderId || '').trim();
          } else if (/^\d{4,15}$/.test(rawWho)) {
            userId = rawWho;
          } else {
            const hit = [...entries].reverse().find(
              (m) => !m?.self && String(m?.senderName || '').trim() === rawWho
            );
            if (!hit?.senderId) {
              return err(`没在本轮发言里找到「${rawWho}」。请改用 QQ 号，或不填 who 记给刚说话的人。`);
            }
            userId = String(hit.senderId).trim();
          }

          const r = recordEvent(dataDir, {
            uin: userId,
            chatKey,
            kind,
            note: String(args.note ?? '').trim()
          });
          if (!r.ok) return err(r.error);

          const meta = EVENT_KINDS[kind];
          // ★★ 2026-10-30：把事件喂给心情引擎（这才是"心情有来源"的地方）。
          //   ★ 只在**真的新记了一条**时施加冲击 —— 去重命中的那条不该再影响一次心情
          //     （那边去重是"同人同群同类同天"，心情冲击如果重复施加会一天被骂几十次扣到 0）。
          //   ★ 冲击大小按**这个人的亲密度**缩放（陌生人骂一句 0.7 倍，熟人 1.4 倍）——
          //     见 mood-engine.js 的 intimacyMultiplier。
          //   ★ 任何异常都吞掉：心情是增强项，绝不能因为算心情失败而让"记事件"失败。
          let moodNote = '';
          if (!r.duplicate) {
            try {
              let intimacy = 0;
              try {
                const fused = getPersonIntimacyFused(userId, {
                  messagesDbPath: paths.messagesDbPath,
                  relationshipDbPath: paths.relationshipDbPath,
                  chatKey,
                  dataDir
                });
                intimacy = Number(fused?.score) || 0;
              } catch { /* 取不到亲密度就按 0 算（倍率 0.7，影响更小） */ }
              const m = applyMoodImpact({ dataDir, chatKey, kind, uin: userId, intimacy });
              if (m.ok && (m.dMood || m.dEnergy)) {
                moodNote = '（这条也影响了我此刻的状态）';
              }
            } catch { /* ignore */ }
          }

          if (r.duplicate) {
            return ok(`已记过：${userId} 今天在这个群已经有一条「${meta.label}」，不重复计分。`);
          }
          // ★ 不给模型看具体分数 —— 它只需要知道"记下了"，不需要拿分数做文章
          const toneText = meta.tone === 'good' ? '正面' : meta.tone === 'bad' ? '负面' : '中性（不计分）';
          return ok(`已记录：${userId} 的「${meta.label}」（${toneText}）${moodNote}。`);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    {
      name: 'checkin_board',
      description:        '查**当前这个群**的打卡清单：某一天的名单，或近几天的统计（每天多少人、谁最勤）。' +
        '★ 有人说"今天谁打卡了""这周打卡情况""我连续几天了"时用。' +
        '★ 平时**不要主动查**、也不要主动播报打卡情况——没人问就别提。' +
        '★ 只查当前群，看不到别的群的打卡。',
      parameters: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            description: 'today=今天名单（默认）；days=近几天统计；me=某个人的明细',
            enum: ['today', 'days', 'me']
          },
          days: { type: 'integer', description: 'view=days 时看几天，默认 7，最多 400' },
          day: { type: 'string', description: 'view=today 时可指定某天（YYYY-MM-DD），不填就是今天' },
          who: { type: 'string', description: 'view=me 时必填：QQ 号或本群昵称' }
        }
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          if (!dataDir) return err('数据目录未配置，无法查打卡');
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失');
          const view = String(args.view || 'today');

          if (view === 'days') {
            const n = Math.min(400, Math.max(1, Number(args.days) || 7));
            const s = recentStats(dataDir, { chatKey, days: n });
            if (!s.summary.totalCheckins) {
              return ok(`本群近 ${n} 天还没有任何打卡记录。`);
            }
            const perDay = s.days.map((d) => `  ${d.day}：${d.count} 人`).join('\n');
            const top = s.summary.topPeople.length
              ? s.summary.topPeople.map((p, i) => `  ${i + 1}. ${p.name || p.userId}（${p.days} 天）`).join('\n')
              : '  （无）';
            return ok(
              `本群近 ${n} 天打卡（${s.from} ~ ${s.to}）：\n${perDay}\n\n` +
              `合计 ${s.summary.totalCheckins} 次，有打卡的天数 ${s.summary.activeDays}/${n}，` +
              `参与 ${s.summary.distinctPeople} 人，有打卡的日子平均每天 ${s.summary.averagePerActiveDay} 人。\n` +
              (s.summary.bestDay ? `最多的一天：${s.summary.bestDay.day}（${s.summary.bestDay.count} 人）\n` : '') +
              `\n最勤的人：\n${top}\n\n★ 用你自己的话讲，别把这张表原样贴出去。`
            );
          }

          if (view === 'me') {
            const rawWho = String(args.who ?? '').trim();
            const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
            let userId = '';
            if (!rawWho) {
              const last = [...entries].reverse().find((m) => !m?.self && m?.senderId);
              if (!last) return err('view=me 需要 who（QQ 号或本群昵称）');
              userId = String(last.senderId).trim();
            } else if (/^\d{4,15}$/.test(rawWho)) {
              userId = rawWho;
            } else {
              const hit = [...entries].reverse().find(
                (m) => !m?.self && String(m?.senderName || '').trim() === rawWho
              );
              if (!hit?.senderId) return err(`没在本轮发言里找到「${rawWho}」，请改用 QQ 号。`);
              userId = String(hit.senderId).trim();
            }
            const n = Math.min(400, Math.max(1, Number(args.days) || 7));
            const h = personHistory(dataDir, { chatKey, userId, days: n });
            const marks = h.days.map((d) => `${d.day}：${d.checked ? `第 ${d.seq} 个` : '没打卡'}`).join('\n');
            return ok(
              `QQ ${userId} 在本群近 ${n} 天：\n${marks}\n\n` +
              `打满 ${h.checkedDays}/${n} 天，累计 ${h.personTotalDays} 天，当前连续 ${h.personStreak} 天。`
            );
          }

          // 默认：今天（或指定某天）的名单
          const b = dayBoard(dataDir, { chatKey, day: args.day || null, limit: 200 });
          if (!b.total) {
            return ok(`${b.day} 本群还没有人打卡。`);
          }
          const list = b.people.map((p) => `  第${p.seq}个 ${p.name || p.userId}`).join('\n');
          return ok(`${b.day} 本群打卡（共 ${b.total} 人，按先后顺序）：\n${list}`);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 4. 我自己发过的动态 ──────────────────────────────────────────────
    {
      name: 'get_my_moments',
      description:
        '查看**你自己发过的 QQ 空间动态（说说）** —— 你每天会自己写一条，这里能看到写过的内容和日期。' +
        '别人说「你昨天那条说说」「你上次发的那个」时先查一下再聊，别凭印象编。' +
        '★ 状态含义：标「发送结果未知」的是写了但不确定发出去没有，**不能说成「我发过」**。' +
        '★ 平时不用主动提，没人问就当它不存在。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '可选：看最近几条，默认 8，最多 50' },
          includeFailed: { type: 'boolean', description: '可选：true 时连失败/没发的草稿也列出来' }
        }
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          const result = publishedMoments({
            dataDir,
            limit: Math.min(50, Math.max(1, Number(args.limit) || 8)),
            includeFailed: args.includeFailed === true
          });
          return ok(formatMomentsForModel(result));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 5. 指令清单 ──────────────────────────────────────────────────────
    // ★ 2026-10-27：模型侧与聊天侧（cannedReplies 的 dynamic:'commands'）必须同一份真源。
    //   插件/MCP/技能那段来自 local-commands-catalog.js —— 与 formatCommandList() 用的是同一个函数，
    //   所以「群友 @ 我问」和「模型查了再答」永远不会对不上。
    {
      name: 'list_commands',
      description:
        '列出**当前能用的全部指令与能力**：①固定回复指令（@ 我说哪些词会触发、触发后大概给什么）' +
        '②插件（B站/抽卡/禁漫/表情包/Pixiv…）③联网 MCP 工具 ④技能。' +
        '有人问「你有哪些指令 / 会什么 / 有什么功能 / 怎么赞助」时用它查一下再答，**别凭印象编**。' +
        '★ **不要把固定回复的正文复述出来**（比如赞助链接），告诉他们怎么触发就行。★ 平时不要主动推销功能。',
      parameters: {
        type: 'object',
        properties: {
          detail: { type: 'boolean', description: '可选：true 时列出每条规则的全部触发说法' }
        }
      },
      async execute(ctx, args) {
        try {
          const rules = ctx.cannedRules;
          const detail = args.detail === true;
          const list = typeof rules === 'function' ? rules() : [];
          const lines = [];
          if (list?.length) {
            lines.push(`目前有 ${list.length} 条固定回复指令（要 @ 我才生效，除非特别说明）：`);
            for (const r of list) {
              const trig = detail ? r.triggers : (r.triggers || []).slice(0, 4);
              lines.push(`- ${r.name || r.id}：说「${trig.join('」「')}」${r.triggers?.length > 4 && !detail ? ' 等' : ''}`);
              if (r.does) lines.push(`    作用：${r.does}`);
            }
          } else {
            lines.push('当前没有配置固定回复指令。');
          }

          // ── 插件 / 联网 / 技能（与聊天侧同一份真源）────────────────────
          let extra = '';
          try { extra = catalogText(); } catch { extra = ''; }
          if (extra) {
            lines.push('');
            lines.push('另外还有这些能力（这些不用 @ 我，直接在群里说事情就行）：');
            lines.push(extra);
          }

          lines.push('\n★ 不要自己说固定回复的内容、也不要复述正文 —— 告诉群友怎么触发就行。');
          return ok(lines.join('\n'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 6. 我们之间（关系史） ────────────────────────────────────────────
    {
      name: 'get_our_history',
      description:
        '查你和某个人之间的**相处史**：认识多少天、他说过多少句、他 @ 过你几次、他最近一次跟你说话是什么时候。' +
        '适合「我们认识多久了」「你还记得我吗」这类话题。' +
        '★ 只统计**当前会话**的互动次数（「认识多久」按全局第一次见面算，因为相处时长是跨群累计的事实）。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '要查谁（QQ 号）。不填则用本轮说话的人。' }
        }
      },
      async execute(ctx, args) {
        try {
          const paths = pathsOf(ctx);
          let who = String(args.who ?? '').trim();
          if (!who) {
            // 本轮唯一的非自己发言人
            const entries = (ctx.triggerEntries || []).filter((e) => !e.self && e.senderId);
            const uniq = [...new Set(entries.map((e) => e.senderId))];
            if (uniq.length !== 1) return ok('这一轮不止一个人说话，请告诉我要查谁的 QQ 号。');
            who = uniq[0];
          }
          const facts = getRelationalFacts(who, {
            messagesDbPath: paths.messagesDbPath,
            chatKey: String(ctx.chatKey || ''),
            selfUin: String(ctx.selfId || ''),
            now: Date.now()
          });
          if (!facts) return ok(`关于 ${who} 的相处记录还太少，暂时算不出来。`);
          const name = (ctx.triggerEntries || []).find((e) => e.senderId === who)?.senderName || who;
          return ok(formatRelationalFacts(facts, { name }));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 7. 回想过去真实发生过的事（事件记忆） ─────────────────────────────
    // ★ 与 search_old_messages 的分工（模型经常搞混，描述里写清）：
    //   search_old_messages = 翻**原话**（某条消息的逐字内容，能翻到几个月前）
    //   recall_events       = 翻**事件**（整理过的一句话事实，能按人/关键词筛）
    //   想引用"他当时到底怎么说的"用前者；想知道"上周发生过什么"用后者。
    {
      name: 'recall_events',
      description:
        '回想这个会话**过去真实发生过的事**。提示词里的【最近的事】只有最近这一段，'
        + '更早的（上周、上个月、前几天）必须靠这个工具查。适合：「上周说过什么」「他之前答应过我什么」'
        + '「我们上次聊到哪了」「上次那件事怎么说的」。返回按时间倒序的事件列表。参数都可选。' +
        '★ 只想找**原话**（逐字引用）用 search_old_messages，这个给的是整理过的短句。',
      parameters: {
        type: 'object',
        properties: {
          daysFrom: { type: 'integer', description: '从几天前开始查（含当天），默认 7；查一个月填 30' },
          daysTo: { type: 'integer', description: '查到几天前为止（含当天），默认 0 = 今天' },
          userId: { type: 'string', description: '只看某个人相关的事件（QQ 号）；不填 = 所有人' },
          keyword: { type: 'string', description: '关键词过滤，命中事件正文/主题/说话人（不区分大小写）' },
          limit: { type: 'integer', description: '最多返回几条，默认 20，最大 100' }
        }
      },
      async execute(ctx, args) {
        // ★ 事件库实例由 orchestrator 注入 ctx.episodes（与 prompt 里的【最近的事】同一个实例）。
        //   没接上时如实说，不要让模型以为"发生过但查不到"。
        if (!ctx?.episodes?.list) return err('事件记忆未启用（设置 → 记忆 → 事件记忆）');
        try {
          const DAY = 86400000;
          const now = Date.now();
          let daysFrom = Math.min(365, Math.max(0, Number(args.daysFrom ?? 7) || 0));
          let daysTo = Math.min(365, Math.max(0, Number(args.daysTo ?? 0) || 0));
          if (daysFrom < daysTo) { const t = daysFrom; daysFrom = daysTo; daysTo = t; }
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
          const events = ctx.episodes.list({
            chatKey: ctx.chatKey,
            since: now - (daysFrom + 1) * DAY,
            until: now - daysTo * DAY,
            userId: args.userId,
            keyword: args.keyword,
            limit
          });
          const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', {
            hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
          });
          return ok({
            window: { from: fmt(now - (daysFrom + 1) * DAY), to: fmt(now - daysTo * DAY) },
            count: events.length,
            events: events.map((e) => ({
              time: fmt(e.occurredAt),
              userId: e.userId || undefined,
              who: e.who || undefined,
              what: e.summary,
              topics: e.topics || undefined
            })),
            note: events.length ? undefined
              // ★ 保留期现在是 0 = 永久保留（用户决定），所以不再提"默认 45 天"
              : '没有查到。可能这段还没开始记录（事件记忆是后来才启用的），或关键词没命中——'
                + '换更具体的名词再试，或改用 search_old_messages 直接翻原话。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 13. 记忆的出处（2026-10-29）：被问"你怎么知道"时答得出来 ───────────
    // ★ 为什么做成工具而不是把原话塞进印象：原话就在 messages.sqlite 里，
    //   那是唯一真实的版本；塞进印象既多花 token，又给了模型编造引文的机会。
    //   ⇒ **平时零注入**（不进提示词），只有真被追问时才查一次。
    {
      name: 'memory_why',
      description:
        '回想**你为什么会记得某件事**——从真实聊天记录里捞出他当时说的**原话**。'
        + '★ 用在：有人问"你怎么知道的""我什么时候说过""你记错了吧"，而你要给出依据的时候。'
        + '★ 返回的是**逐字原话**（带多久以前），不是你的转述 —— 可以直接说"你上次说过……"。'
        + '★ 如果 matched=false，说明没找到关于这个话题的原话，返回的只是"他最近说过的话"，'
        + '  **不能当证据用**；这时就如实说"记不清了/我可能记错了"，别硬圆。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: 'QQ 号或本群昵称。不填 = 刚说话的那个人。' },
          topic: { type: 'string', description: '要回忆的话题（具体名词最好，例如"猫""毕业设计"）。不填 = 他最近说过什么。' },
          limit: { type: 'integer', description: '最多几条原话，默认 2，最大 5' }
        }
      },
      async execute(ctx, args) {
        try {
          const paths = pathsOf(ctx);
          const chatKey = String(ctx.chatKey || '');
          const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];

          // 找目标人：与 mark_event 同一套口径（只在本轮发言人里找，不去全库猜）
          const rawWho = String(args.who ?? '').trim();
          let userId = '';
          if (!rawWho) {
            const last = [...entries].reverse().find((m) => !m?.self && m?.senderId);
            if (!last) return err('不知道要查谁：没指定 who，本轮也没有可识别的发言人。');
            userId = String(last.senderId || '').trim();
          } else if (/^\d{5,15}$/.test(rawWho)) {
            userId = rawWho;
          } else {
            const hit = [...entries].reverse().find(
              (m) => !m?.self && String(m?.senderName || '').trim() === rawWho
            );
            if (!hit?.senderId) {
              return err(`没在本轮发言里找到「${rawWho}」。请改用 QQ 号，或不填 who 查刚说话的人。`);
            }
            userId = String(hit.senderId).trim();
          }
          if (!/^\d{5,15}$/.test(userId)) return err('解析不出这个人的 QQ 号，无法查原话。');

          const topic = String(args.topic ?? '').trim();
          const limit = Math.min(5, Math.max(1, Number(args.limit) || 2));
          // ★ 先在本会话找（与【最近的事】同一隔离口径），找不到再跨群 ——
          //   跨群那一档只在本会话确实没有时启用，避免把别处的话当成"在这里说过"。
          let r = findMemoryQuotes({
            uin: userId, topic, messagesDbPath: paths.messagesDbPath, chatKey, limit
          });
          let scope = '本会话';
          if (topic && (!r?.quotes?.length)) {
            const cross = findMemoryQuotes({
              uin: userId, topic, messagesDbPath: paths.messagesDbPath, chatKey: '', policyChatKey: chatKey, limit
            });
            if (cross?.quotes?.length) { r = cross; scope = '别的会话'; }
          }
          if (!r || !r.quotes.length) {
            return ok(`查不到 ${userId} 说过的相关原话。\n`
              + '★ 这时**不要编**：可以如实说"记不清了""可能是我记混了"。');
          }

          const lines = r.matched
            ? [`他（${userId}）关于「${topic}」说过的原话（${scope}）：`]
            : [`没找到关于「${topic || '这个话题'}」的原话。以下是他**最近**说过的话（${scope}），只能当语气参考，**不是这件事的依据**：`];
          for (const q of r.quotes) {
            lines.push(`- ${q.ago || '某时'}：「${q.text}」`);
          }
          lines.push('★ 引用时要自然（"你上次不是说…"），不要把"我查了记录"说出来；'
            + '也不要把上面这句提示原样念给群友听。');
          return ok(lines.join('\n'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 投喂白饭（2026-10-31）────────────────────────────────────────────
    // ★★★ 用户原话（定的就是这两个数，别自己改大）：
    //   「让每个群友每天有两次或者三次投喂白饭的机会，可以让机器人加精力的。
    //     他现在每天聊五六个小时就累了，这可不行。可以提供每天三次喂白饭的机会，
    //     通过艾特他加一点白饭，不过要注意这个参数不要配太高，也不要配太低。」
    //   「一个群 2000 人活跃的也有 200 多，每个人投喂一次就直接爆掉了。加那么 0 点几左右。」
    //   「通过我们已有的办法将受到单个群受到的精力偏移，通过整体成算到机器人的全局状态中。」
    //
    // ★ 折算链路（**不直接改全局**，走的是 mood-engine 现成的双层模型）：
    //     每次 +0.3 → 写进本群局部偏移(group:xxx) → 最终精力 = 全局 + 局部 × 0.6
    //     ⇒ 每次都只给最终精力 +0.18；而局部偏移本身封顶 ±25 ⇒
    //       **一个群无论 2000 人还是 20000 人喂，最多只给整体 +15 精力**。
    {
      name: 'feed_rice',
      description:
        '群友给你**投喂白饭**（喂饭、喂你吃东西、"给你吃口饭""辛苦了吃口饭"这类意思），你因此回一点精力。'
        + `★ 每人每天在**这个群**最多喂 ${FEED_PER_USER_PER_DAY} 次，超了会拒绝。`
        + '★ 只在有人**明确表达喂饭/投喂/请你吃饭**时调用；只是随口说"吃饭了吗"不要调用。'
        + '★ 回复要自然、短：一句"谢谢，吃到了"这种感觉就行；'
        + '  **不要说"精力+0.18""恢复了几点"这类数字**，也不要提"记录""数据库"。'
        + '★ 如果返回里有 already/今天喂过了，就笑着打回（"今天已经吃过你的饭啦"），别重复道谢。',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: '可选：谁喂的（QQ 号或本群昵称）。不填 = 刚说话的那个人。' }
        }
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          if (!dataDir) return err('数据目录未配置，无法记录投喂');
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失，无法记录投喂');

          // 默认投喂人 = 本轮触发消息里最后一个非机器人发送者
          const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
          const lastSpeaker = [...entries].reverse().find((m) => !m?.self && m?.senderId);

          const rawWho = String(args.who ?? '').trim();
          let userId = '';
          let userName = '';
          if (!rawWho) {
            if (!lastSpeaker) return err('不知道是谁喂的：没有指定 who，本轮也没有可识别的发言人。');
            userId = String(lastSpeaker.senderId || '').trim();
            userName = String(lastSpeaker.senderName || '').trim();
          } else if (/^\d{4,15}$/.test(rawWho)) {
            userId = rawWho;
            const hit = entries.find((m) => String(m?.senderId || '') === rawWho);
            userName = String(hit?.senderName || '').trim();
          } else {
            const hit = [...entries].reverse().find(
              (m) => !m?.self && String(m?.senderName || '').trim() === rawWho
            );
            if (!hit?.senderId) {
              return err(`没在本轮发言里找到「${rawWho}」。请改用他的 QQ 号，或不填 who 直接给刚说话的人喂。`);
            }
            userId = String(hit.senderId).trim();
            userName = rawWho;
          }
          if (!userId) return err('取不到投喂人的 QQ 号，无法记录。');

          // ① 先看额度（不写库），把"还能喂几次"如实告诉模型
          const q0 = feedQuota(dataDir, { chatKey, userId });
          if (q0.left <= 0) {
            return ok(`${userName || userId} 今天在这个群已经喂满 ${q0.cap} 次了。\n`
              + '★ 回复时笑着打回即可（形如"今天已经吃过你的饭啦，明天再喂我"）；'
              + '不要说数字，也不要提"额度""限制"这类词。');
          }

          // ② 记账
          const sourceEntry = [...entries].reverse().find(m => !m?.self && String(m?.senderId || '') === userId);
          const sourceId = sourceEntry?.id != null ? `db:${sourceEntry.id}`
            : (sourceEntry?.mid != null ? `mid:${sourceEntry.mid}` : '');
          const r = feedEnergy(dataDir, { chatKey, userId, userName, sourceId });
          if (r.duplicate) return ok('这条投喂已经吃到了，不重复记账或恢复精力。');
          if (!r.ok) {
            return ok(`${r.reason}\n`
              + '★ 回复时笑着打回即可（形如"今天已经吃过你的饭啦，明天再喂我"）；'
              + '不要说数字，也不要提"额度""限制"这类词。');
          }

          // ③ ★ 把这一口饭真正折算进精力 —— 只写**本群局部偏移**，
          //    由 mood-engine 的 (全局 + 局部 × LOCAL_WEIGHT) 折进整体。
          //    ★ 任何异常都吞掉：喂饭记录本身不该因为心情算失败而失败。
          let moodOk = false;
          try {
            const m = nudgeMood(dataDir, {
              chatKey,
              dEnergy: r.energyGain,     // = FEED_ENERGY（0.3），进的是本群偏移
              dMood: 0,                  // 只回精力，不动心情（用户只要求"加精力"）
              note: '投喂白饭'
            });
            moodOk = Boolean(m?.ok);
          } catch { /* ignore */ }

          const lines = [
            `喂到了：${userName || userId}（QQ ${userId}）给你投喂了一份白饭。`,
            `他今天在这个群还能喂 ${r.left} 次（每人每天 ${FEED_PER_USER_PER_DAY} 次）。`
          ];
          if (!moodOk) lines.push('（这口饭记下了，但状态换算这会儿没成功 —— 不影响投喂记录。）');
          lines.push('★ 回复一句自然的感谢就行，**别报数字**（不要说尽力值/加了几点）；'
            + '也别提"记录""数据库""额度"。');
          return ok(lines.join('\n'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 今天谁喂了饭（不主动查、不主动播报）──────────────────────────────
    {
      name: 'feed_board',
      description:
        '查**当前这个群**今天谁投喂了白饭、各喂了几次。'
        + '★ 只有人问"今天谁喂我了""今天被喂了几次"时才用；'
        + '  **平时绝对不要主动查、也不要主动播报**。'
        + '★ 只看当前群，看不到别的群。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多列出几个人，默认 10，最大 50' }
        }
      },
      async execute(ctx, args) {
        try {
          const dataDir = ctx.memoryPaths?.dataDir || '';
          if (!dataDir) return err('数据目录未配置，无法查询投喂');
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失，无法查询投喂');
          const r = feedBoard(dataDir, { chatKey, limit: Math.min(50, Math.max(1, Number(args.limit) || 10)) });
          if (!r.totalFeeds) {
            return ok(`今天（${r.day}）这个群还没人喂过我。\n`
              + '★ 回复时随口说一句就行，别卖惨、别主动讨饭。');
          }
          const lines = [`今天（${r.day}）本群一共被投喂 ${r.totalFeeds} 次：`];
          for (const p of r.people) lines.push(`- ${p.name || p.userId}：${p.times} 次`);
          lines.push('★ 回复时随口夸一句就行，别说"数据""统计"这类词。');
          return ok(lines.join('\n'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

    // ── 3z. 经验教训库（本群独立、只在被纠正后写、强制核对）────────────────
    // ★★★ 2026-11-09 用户要求（原话）：
    //   「群友指出来之后还不一定会认。然后认了之后也不会当成记忆，长期存下去，
    //     我认为可以给他搞一个经验教训记忆。」
    //   「群友说的也未必是对的……有人指出了他的错误，他会优先进行联网搜索和核对，
    //     核对之后再加入经验教训中」
    //
    // ★ 三条硬约束：
    //   ① **没核对就写不进去**：store.js 里 verified !== true 或 source 为空直接抛错。
    //      这是代码强制，不是提示词叮嘱 —— 因为"把群友的错话永久记成正确"比不记更糟。
    //   ② **按群隔离**：chatKey 只来自 ctx.chatKey，参数里没有群号。
    //   ③ **不主动进上下文**：不被 prompt.js 引用，只在模型主动调 lesson_lookup 时读。
    {
      name: 'lesson_remember',
      description:
        '记一条**经验教训**：我刚才把某件事说错了、群友指出来、我联网核对后确认确实错了，' +
        '把"错在哪、对的是什么"存进本群教训库，以后不再犯。' +
        '★★ **必须先核对再记**：verified 必须传 true 且 source 要写清依据（哪个搜索结果/页面），' +
        '  否则工具会直接拒收。群友说的也可能是错的 —— 没核实的纠正不许入库。' +
        '★ 只记可复用的判断（数值、规则、结论），不记"我错了对不起"这类情绪表达。' +
        '★ 只作用于当前群。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '这事的话题/检索钥匙，例如「群星 行星飞升 效果」' },
          wrong: { type: 'string', description: '我原来错说成什么' },
          right: { type: 'string', description: '核对后正确的说法（照抄原文口径）' },
          source: { type: 'string', description: '核对依据（哪个搜索结果/页面），必填。例如「web_search：群星 wiki 飞升页」' },
          verified: { type: 'boolean', description: '是否已联网核对通过。必须传 true，否则拒收' }
        },
        required: ['topic', 'wrong', 'right', 'source', 'verified']
      },
      async execute(ctx, args) {
        try {
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失，无法记录教训');
          const r = rememberLesson({
            chatKey,
            topic: args.topic,
            wrong: args.wrong,
            right: args.right,
            source: args.source,
            verified: args.verified === true,
            createdBy: String(ctx.triggerSenderId || ctx.triggerSenderName || '')
          });
          return ok(r.updated
            ? `已更新本群教训（同一话题原来是记过的）：「${args.topic}」`
            : `已记下本群教训：「${args.topic}」`);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'lesson_lookup',
      description:
        '查**本群的经验教训库**：我以前在这个群把什么说错过、正确的是什么。' +
        '★ 什么时候用：准备回答一个"我可能记混过"的结论之前，先查一眼，别又按老样子答一遍。' +
        '★ 只查本群，查不到就说没有。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的话题/关键词' },
          limit: { type: 'integer', description: '返回几条，默认 6，最多 20' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const chatKey = String(ctx.chatKey || '');
          if (!chatKey) return err('当前会话标识缺失，无法查教训');
          const q = String(args.query ?? '').trim();
          if (!q) return err('query 不能为空');
          const list = lookupLessons(chatKey, q, Math.min(20, Math.max(1, Number(args.limit) || 6)));
          if (!list.length) return ok(`本群教训库里没有和「${q}」相关的记录。`);
          const lines = list.map((e, i) =>
            `${i + 1}. 【${e.topic}】曾错说成「${e.wrong}」→ 正确的是「${e.right}」`
            + (e.source ? `（依据：${e.source}）` : ''));
          return ok(`本群教训库查到 ${list.length} 条：\n\n` + lines.join('\n')
            + '\n\n★ 按正确的说，别再重复那个错。');
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    }
  ];
}
