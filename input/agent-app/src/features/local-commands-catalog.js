// [LOCAL-ONLY] ============================================================
// ★ 这是**我们自己写的**，作者原仓库从来没有过。
//   · 升级作者版本时会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// local-commands-catalog.js —— 「指令清单」里 **插件 / MCP / 技能** 那一段的唯一真源。
//
// ★ 为什么单独一个模块（2026-10-27 用户要求）：
//   用户说：「通过从作者那里下载的插件，已经增加了很多功能，考虑把它们加进清单里面」。
//   原来的指令清单只列**固定回复**，群友问「你会什么」得到的答案漏掉了 5 个插件、2 个 MCP、3 个技能。
//
// ★★★ 2026-10-28 重写（用户第二次要求，原话）：
//   「那个指令清单实在太乱了，我建议你稍微整理一下，也不用那么长，然后也不用描述的那么详细，
//     然后也不用说明是来自什么工具的，群友不需要知道这么多，只需要知道有哪些功能就行了。」
//
//   ⇒ 由此定下三条**显示纪律**（改这个文件之前先读这三条）：
//     ① **不挂来源标签** —— 不再出现「插件《B 站》」「联网《fetch》」「技能《x》」这类前缀。
//        群友只关心"能干什么"，不关心那东西是插件还是 MCP 还是技能。**一律扁平一行一条**。
//     ② **不报实现细节** —— 「12 个动作」「3 类要你批准」「resolve-library-id / query-docs」
//        这类东西对群友零价值，全部删掉。
//     ③ **一句一条，越短越好** —— 目标是"扫一眼就知道能干什么"，不是技术说明书。
//
// ★ 为什么仍然坚持"只列真能用的"（这条没变，也**不许放松**）：
//   插件要求「装了 + 在 enabledIds 里 + 未撤回」，MCP 要求「全局开 + 该 server enabled + 已就绪」，
//   技能要求「全局开 + 在 enabledIds 里」。
//   ⇒ 清单里出现的东西，**一定是真能用的**。列了却用不了，比不列更糟。
//
// ★ 为什么"能力短语"用一张小映射表而不是纯自动截断：
//   自动截断 description 得到的句子常常半截（"搜索与查看 B 站视频、UP 主、热门、评论、"），
//   而且会把括号里的补充说明也带出来。⇒ 已知的几项手工写一句人话（见 ABILITY），
//   **未知的新项才回退到自动截断**（这样以后装新插件也不至于一片空白，只是那句话糙一点）。

/** 来源登记（箭头函数，调用时才解析 —— 避开 console/app.js 里 const 的 TDZ）。 */
let SOURCES = {
  getPlugins: null,   // () => PluginRegistry 实例
  getMcp: null,       // () => McpManager 实例
  getSkills: null,    // () => SkillRegistry 实例
  getConfig: null     // () => 配置对象
};

/**
 * 由注入点调用一次。传进来的必须是**取对象的函数**，不是对象本身。
 * @param {{getPlugins?:Function,getMcp?:Function,getSkills?:Function,getConfig?:Function}} sources
 */
export function setCommandCatalogSources(sources = {}) {
  SOURCES = {
    getPlugins: typeof sources.getPlugins === 'function' ? sources.getPlugins : null,
    getMcp: typeof sources.getMcp === 'function' ? sources.getMcp : null,
    getSkills: typeof sources.getSkills === 'function' ? sources.getSkills : null,
    getConfig: typeof sources.getConfig === 'function' ? sources.getConfig : null
  };
}

/** 供验收脚本用：读回当前登记状态（不触发任何副作用）。 */
export function commandCatalogSources() {
  return { ...SOURCES };
}

const cfgOf = () => {
  try {
    if (SOURCES.getConfig) return SOURCES.getConfig() || {};
    return {};
  } catch { return {}; }
};

/**
 * 已知项的一句话能力。**键是插件 id / MCP id / 技能 id**。
 * ★ 新增插件时可以在这里补一句（没补就走自动截断，不会崩）。
 * ★ 写这里的原则：像**人告诉群友**那样写，不是像文档目录那样写。
 */
const ABILITY = {
  // ── 插件 ──
  bilibili: '搜 B 站视频、UP 主、热门，还能把视频下下来发群里',
  gacha: '抽卡（说「抽一张卡」「来张卡」）',
  'jm-album': '查禁漫本子的信息（只查，不下载）',
  'meme-finder': '按心情找表情包',
  'pixiv-illust': '找 Pixiv 插画',
  // ── 联网 ──
  // ★ 刻意**不写"联网"二字**：那是在描述实现（要出网），不是在说功能。
  //   用户要的是"有哪些功能"，所以直接说它能把什么事办了。
  fetch: '打开一条链接，把网页里的内容读出来',
  context7: '查开发文档、接口怎么用',
  // ── 技能 ──
  'chat-summary': '把一长串群聊总结成几条',
  'comment-analysis': '把一堆评论归成几类观点',
  'video-digest': '看完视频提炼要点'
};

/**
 * ★ 2026-10-29：**我们自己的**本地能力（不是插件、不是 MCP、不是技能）。
 * 这类能力没有 manifest / registry 可查，所以只能在这里**静态登记**。
 * 判据：`local-tools.js` 里真有这个工具名才列（见 BUILTIN_ENABLED 的注释）。
 * ★ 同样遵守三条显示纪律：无来源标签、无实现细节、一句一条。
 */
const BUILTIN = [
  { tool: 'checkin', line: '打卡（说「打卡」「签到」，会回你本群第几个）' },
  { tool: 'checkin_board', line: '看打卡情况（今天谁打了、这周打了几天）' }
];

/** 自动截断：取第一个分句，去尾巴标点，过长再加省略号。回退用。 */
function shortLine(text, max = 40) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.split(/[。；\n]/)[0] || s;
  s = s.replace(/^【[^】]*】/, '').trim();   // 去掉开头的【成人向】这类标记
  s = s.replace(/[，,、]$/, '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 插件那几行。空数组 = 没有可用插件。 */
function pluginLines() {
  const out = [];
  const reg = SOURCES.getPlugins ? SOURCES.getPlugins() : null;
  if (!reg || typeof reg.list !== 'function') return out;
  let listed;
  try { listed = reg.list(); } catch { return out; }
  // ★★ 坑（踩过）：`row.manifest.tools` 是**字符串数组**（registry.js:1055），不是工具对象
  //   ⇒ 拿不到 `tool.action`；判"有几个会写"只能看 `row.manifest.approvals`（registry.js:1052）。
  //   ★ 但 2026-10-28 起这两样**都不再显示了** —— 群友不需要知道，别再加回来。
  for (const row of (listed?.plugins || [])) {
    if (!row || !row.installed || !row.manifest) continue;
    if (row.enabled !== true) continue;          // 没启用的不列（列了就是骗人）
    if (row.revoked) continue;                   // 被撤回的不列
    const id = String(row.id || '').trim();
    const label = String(row.manifest.name || id || '').trim();
    if (!label) continue;
    const what = ABILITY[id] || shortLine(row.manifest.description);
    out.push(what ? `· ${what}` : `· ${label}`);
  }
  return out;
}

/** MCP 那几行。 */
function mcpLines() {
  const out = [];
  const mgr = SOURCES.getMcp ? SOURCES.getMcp() : null;
  if (!mgr || typeof mgr.status !== 'function') return out;
  let rows;
  try { rows = mgr.status(); } catch { return out; }
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || row.ready !== true) continue;    // 只列**真的就绪**的
    const tools = (Array.isArray(row.tools) ? row.tools : []).filter(Boolean);
    if (!tools.length) continue;                 // 没工具等于没用
    const id = String(row.id || '').trim();
    // ★ 不再把 tools.join(' / ') 写出来（`resolve-library-id / query-docs` 对群友毫无意义）
    out.push(`· ${ABILITY[id] || `能查资料（${id}）`}`);
  }
  return out;
}

/** 技能那几行（只在技能全局开启时出现）。 */
function skillLines() {
  const out = [];
  const reg = SOURCES.getSkills ? SOURCES.getSkills() : null;
  if (!reg || typeof reg.list !== 'function') return out;
  let cfg;
  try { cfg = cfgOf().skills || {}; } catch { cfg = {}; }
  if (cfg.enabled !== true) return out;          // 技能没开就一条都不列
  const enabledIds = new Set((Array.isArray(cfg.enabledIds) ? cfg.enabledIds : [])
    .map((x) => String(x || '').trim()).filter(Boolean));
  let list;
  try { list = reg.list(); } catch { return out; }
  for (const skill of (Array.isArray(list) ? list : [])) {
    const id = String(skill?.id || '').trim();
    if (!id || !enabledIds.has(id)) continue;
    const what = ABILITY[id] || shortLine(skill?.description, 36);
    out.push(what ? `· ${what}` : `· ${id}`);
  }
  return out;
}

/**
 * 渲染「能干什么」那一段（**扁平、无来源标签、无实现细节**）。
 * @returns {string[]} 空数组表示一个能用的都没有
 */
export function catalogLines() {
  const sections = [];
  try { const p = pluginLines(); if (p.length) sections.push(...p); } catch { /* 跳过 */ }
  try { const m = mcpLines(); if (m.length) sections.push(...m); } catch { /* 跳过 */ }
  try { const s = skillLines(); if (s.length) sections.push(...s); } catch { /* 跳过 */ }
  // ★ 我们自己的内置能力放最后：插件/联网/技能是"外面装来的"，这几个是"自带的"。
  try { const b = builtinLines(); if (b.length) sections.push(...b); } catch { /* 跳过 */ }
  // 去重（同一个能力可能被插件与技能同时暴露，出现两次只会更乱）
  return [...new Set(sections)];
}

/**
 * 我们自己的内置能力那几行。
 * ★ 为什么静态登记而不像插件那样查 registry：
 *   它们是 `local-tools.js` 里直接定义的工具，没有 manifest、没有注册表可枚举。
 *   能保证"列了就能用"的办法是**两边都写死**：这里写一句人话，
 *   而 verify-checkin.mjs 会断言这些 tool 名**真的在 buildToolDefs() 里**
 *   ⇒ 哪天工具被删了，验收会红，不会出现"清单里有、实际调不到"。
 */
function builtinLines() {
  return BUILTIN.filter((item) => item && item.line).map((item) => `· ${item.line}`);
}

/** 给「指令清单」用的一整段文本；没有就是空串。 */
export function catalogText() {
  const lines = catalogLines();
  return lines.length ? lines.join('\n') : '';
}
