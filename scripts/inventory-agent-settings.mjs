#!/usr/bin/env node
/**
 * inventory-agent-settings.mjs — 只读清点「运行端（qq-agent-plus）」暴露了多少设置项，
 * 并与我们手机面板（android/…/BotConfigSchema.java）做差异对照。
 *
 * ── 只读保证 ────────────────────────────────────────────────────────────────
 * 本脚本只读文件，不写任何文件、不发网络请求、不启动运行端。它唯一"运行"的代码是
 * 动态 import 运行端自己的 `src/core/config.js`（只为拿到 `DEFAULT_CONFIG` 对象字面量，
 * 因为那里面用了 spread / 引用了别的模块的常量，文本解析拿不全）。该模块顶层只有常量定义，
 * `loadConfig()` 等读盘函数不会被调用。为绝对安全，import 前把 QQ_AGENT_DATA_DIR 指向一个
 * 不存在的路径，这样即便有意外读盘也读不到真实数据目录。
 *
 * ── 脱敏 ───────────────────────────────────────────────────────────────────
 * 报告里**绝不出现**任何配置的真实值。判定口径直接抄运行端的
 * `src/core/secret-keys.js`：SECRET_KEY_PATTERN / SECRET_KEY_EXCLUDE。
 * - 默认值（来自源码 DEFAULT_CONFIG）只打印 boolean / number / 短枚举字符串；
 * - 活配置 config.json 只打印「键名 / 类型 / 是否存在」，值一律不打印。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   node scripts/inventory-agent-settings.mjs
 *   node scripts/inventory-agent-settings.mjs --json
 *   node scripts/inventory-agent-settings.mjs --agent-app ".tmp/phone-agent-runtime-6g9XJC/app"
 *   node scripts/inventory-agent-settings.mjs --config ".tmp/phone-agent-runtime-6g9XJC/data/config.json"
 *
 * 退出码：0 = 全部数据源都拿到了；1 = 有必需数据源缺失（会打印 FAILED 段）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 输出被 `| Select-Object -First N` 之类提前关掉管道时不要抛栈
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/* ═══════════════════════════════════════════════════════════════════════════
 * 0. 参数
 * ═══════════════════════════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const out = { json: false, agentApp: '', config: '', android: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--agent-app') out.agentApp = argv[++i] || '';
    else if (a === '--config') out.config = argv[++i] || '';
    else if (a === '--android') out.android = argv[++i] || '';
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. 密钥判定（口径抄自运行端 src/core/secret-keys.js:15 / :17 / :140）
 * ═══════════════════════════════════════════════════════════════════════════ */

const SECRET_KEY_PATTERN = /(^token$|apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key|authorization|^auth$|x-api-key|x_api_key|^cookie$|^bearer$)/i;
const SECRET_KEY_EXCLUDE = /from$/i;
const SECRET_CONTAINER = /^(keys|providerkeys|ttskeys)$/i;

function isSecretKey(key) {
  if (SECRET_KEY_EXCLUDE.test(key)) return false;
  return SECRET_KEY_PATTERN.test(key) || SECRET_CONTAINER.test(key);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. 发现运行端源码目录
 * ═══════════════════════════════════════════════════════════════════════════ */

function looksLikeAgentApp(dir) {
  return fs.existsSync(path.join(dir, 'src', 'core', 'config-legacy.js'))
    && fs.existsSync(path.join(dir, 'src', 'console', 'routes', 'config.js'))
    && fs.existsSync(path.join(dir, 'ui', 'pages', 'settings-save.js'));
}

/** 在 .tmp 下找所有像运行端源码的目录，按「有 node_modules > data/config.json 更新时间新」排序。 */
function discoverAgentApps(tmpDir) {
  const found = [];
  if (!fs.existsSync(tmpDir)) return found;
  for (const ent of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const base = path.join(tmpDir, ent.name);
    for (const candidate of [path.join(base, 'app'), path.join(base, 'agent-app'), base]) {
      if (!looksLikeAgentApp(candidate)) continue;
      const cfg = path.join(base, 'data', 'config.json');
      const altCfg = path.join(candidate, 'data', 'config.json');
      let mtime = 0;
      for (const c of [cfg, altCfg]) {
        try { mtime = Math.max(mtime, fs.statSync(c).mtimeMs); } catch { /* 缺失即忽略 */ }
      }
      found.push({
        app: candidate,
        dataDir: fs.existsSync(path.join(base, 'data')) ? path.join(base, 'data') : path.dirname(cfg),
        configFile: fs.existsSync(cfg) ? cfg : (fs.existsSync(altCfg) ? altCfg : ''),
        hasNodeModules: fs.existsSync(path.join(candidate, 'node_modules')),
        mtime
      });
      break; // 一个目录只认第一个命中的形态
    }
  }
  found.sort((a, b) => (Number(b.hasNodeModules) - Number(a.hasNodeModules)) || (b.mtime - a.mtime));
  return found;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. 控制台分区（ui/pages/settings.js 的侧栏 menu 字面量）
 * ═══════════════════════════════════════════════════════════════════════════ */

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * 从 settings.js 抓 `const menu = [ ['组名', [['secId','标签'], …]], … ];`
 *
 * 不能用正则硬啃嵌套数组（上一版就因此每组少算最后一项：`]]]` 里先匹配到了
 * 内层收尾）。这里做一次最小的手写扫描：跳过字符串字面量，按括号深度取
 * 「外层数组 → 组 → 组内条目数组 → ['id','标签']」这一固定形状。
 */
function parseConsoleMenu(settingsJs) {
  const src = readText(settingsJs);
  const anchor = src.indexOf('const menu = [');
  if (anchor < 0) return { groups: [], error: '未找到 const menu = [' };

  let i = anchor + 'const menu ='.length;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== '[') return { groups: [], error: 'menu 后不是数组' };

  const lineAt = (idx) => src.slice(0, idx).split('\n').length;

  // 读一个字符串字面量（'…' 或 "…"），返回 [内容, 结束后的下标]
  const readString = (pos) => {
    const quote = src[pos];
    let out = '';
    let k = pos + 1;
    while (k < src.length && src[k] !== quote) {
      if (src[k] === '\\') { out += src[k + 1] ?? ''; k += 2; continue; }
      out += src[k];
      k += 1;
    }
    return [out, k + 1];
  };
  const skipWs = (pos) => { let k = pos; while (k < src.length && /[\s,]/.test(src[k])) k += 1; return k; };

  const groups = [];
  let p = skipWs(i + 1); // 进入外层数组
  while (p < src.length && src[p] === '[') {
    // ── 组标题
    let q = skipWs(p + 1);
    if (src[q] !== "'" && src[q] !== '"') break;
    const titleLine = lineAt(q);
    const [title, afterTitle] = readString(q);
    q = skipWs(afterTitle);
    if (src[q] !== '[') break;
    // ── 组内条目数组
    const items = [];
    q = skipWs(q + 1);
    while (q < src.length && src[q] === '[') {
      let r = skipWs(q + 1);
      if (src[r] !== "'" && src[r] !== '"') break;
      const [id, afterId] = readString(r);
      r = skipWs(afterId);
      let label = '';
      if (src[r] === "'" || src[r] === '"') {
        const [lb, afterLb] = readString(r);
        label = lb;
        r = skipWs(afterLb);
      }
      if (src[r] === ']') r += 1;
      items.push({ id, label });
      q = skipWs(r);
    }
    if (src[q] === ']') q += 1;   // 条目数组收尾
    if (src[q] === ']') q += 1;   // 组收尾
    if (items.length) groups.push({ title, items, line: titleLine });
    p = skipWs(q);
  }
  return { groups, error: groups.length ? '' : '菜单解析为空' };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. 控制台控件 → 配置路径
 *
 *   控制台每个输入框的 id 形如 `cfg-xxx`，提交时在 settings-save.js（及其它页面的
 *   save 逻辑）里被映射回配置路径。抓法：定位 '#cfg-xxx'，往后取一段窗口，窗口里
 *   第一个 `c.a.b` / `state.config?.a.b` 就是它的配置路径。
 * ═══════════════════════════════════════════════════════════════════════════ */

// 只认「读配置」的 `c.a.b`：`patch.a.b` 是赋值目标（如 patch.reminders = {…}），
// 拿它当路径会得到 `reminders` 这种裸顶层键，属于假阳性。
const PATH_RE = /\bc\s*\.\s*([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)/;
const STATE_PATH_RE = /\bstate\s*\.\s*config\s*\?*\s*\.\s*([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)/;

/**
 * 控件所在"行"里的 `<label>` 文本 —— 这是"控制台上用户看到的项名"。
 * 行边界：最近的 `<div class="field…">` / `<div class="checkbox-row…">` 到下一个同类之前。
 * 复选框那类把 `<label for="cfg-x">` 放在 input **之后**，所以先找 for=，再找行内第一个 label。
 * 找不到返回 ''（宁缺勿错；上一版直接往前 700 字符捞最后一个 label，会取到上一行的文字）。
 */
function labelBefore(src, idPos, id) {
  const rowStart = Math.max(
    src.lastIndexOf('<div class="field', idPos),
    src.lastIndexOf('<div class="checkbox-row', idPos)
  );
  const from = rowStart > 0 && idPos - rowStart < 900 ? rowStart : Math.max(0, idPos - 400);
  const nextRow = src.indexOf('<div class="field', idPos);
  const to = Math.min(src.length, (nextRow > 0 ? nextRow : idPos + 500), from + 1200);
  const row = src.slice(from, to);

  const forRe = new RegExp(`<label[^>]*for=["']cfg-${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]{1,160}?)</label>`);
  const byFor = forRe.exec(row);
  const byFirst = /<label[^>]*>([\s\S]{1,160}?)<\/label>/.exec(row);
  const raw = (byFor || byFirst)?.[1];
  if (!raw) return '';
  const text = raw
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 60);
}

function extractCfgBindings(files) {
  const items = [];
  for (const file of files) {
    const src = readText(file);
    // 只有"会写配置"的文件里，`#cfg-x` 后面才跟着 `c.a.b` 这种配置路径；
    // 渲染文件里紧邻的 `c.xxx` 往往是渲染代码的局部变量 —— 那里的 c.* 一律不当路径用。
    const writesConfig = /\bpatch\.[A-Za-z_$]|saveConfig/.test(src);
    const hasLabels = /<label/.test(src);
    const lineStarts = [0];
    for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
    const lineAt = (idx) => {
      let lo = 0; let hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    // 两种写法都要认：JS 选择器 `'#cfg-x'`（save/bind 文件）与 HTML 属性 `id="cfg-x"`
    //（渲染文件，只有这种里才有 <label>）。
    const idRe = /['"]#cfg-([A-Za-z0-9_-]+)['"]|\bid="cfg-([A-Za-z0-9_-]+)"/g;
    const idPositions = [];
    let im;
    while ((im = idRe.exec(src))) {
      idPositions.push({ id: im[1] || im[2], start: im.index, end: im.index + im[0].length });
    }
    idRe.lastIndex = 0;

    for (let k = 0; k < idPositions.length; k += 1) {
      const { id, start, end } = idPositions[k];
      // 窗口到**下一个 #cfg id**为止：那是表达式边界，既能跨行又不会截断到半个词
      // （上一版用固定 420 字符，切口正好落在 `c.dailyMoments` 中间就得到 `daily`）。
      const nextStart = idPositions[k + 1] ? idPositions[k + 1].start : src.length;
      const win = src.slice(end, Math.min(nextStart, end + 1600));
      let p = '';
      let typeHint = 'none';
      if (writesConfig) {
        const cm = PATH_RE.exec(win);
        const sm = STATE_PATH_RE.exec(win);
        const pm = /\bpatch\s*\.\s*([A-Za-z_$][\w$]*)/.exec(win);
        if (cm) { p = cm[1].replace(/\s+/g, '').replace(/\?\./g, '.'); typeHint = 'c'; }
        else if (sm) { p = sm[1].replace(/\s+/g, '').replace(/\?\./g, '.'); typeHint = 'state'; }
        else if (pm) { p = pm[1]; typeHint = 'patchkey'; }
      }

      // 顶层标量（patch.wakeDelayMinMs = …）只有一段；其它必须是「父.子…」才算定位到叶子。
      const mapped = !p ? 'none'
        : (typeHint === 'patchkey' ? 'topleaf' : (p.includes('.') ? 'leaf' : 'parent'));
      const rec = {
        id,
        path: p,
        depth: p ? p.split('.').length : 0,
        mapped,
        kind: typeHint,
        label: hasLabels ? labelBefore(src, start, id) : '',
        file: rel(file),
        line: lineAt(start)
      };
      items.push(rec);
    }
  }

  // 按 id 合流：路径取第一条**有路径**的（save/bind 文件在前），标签取第一条**有标签**的
  // （渲染文件在前），两者通常不在同一个文件里。
  const merged = new Map();
  for (const rec of items) {
    if (!merged.has(rec.id)) merged.set(rec.id, { id: rec.id, path: '', depth: 0, mapped: 'none', kind: 'none', label: '', file: rec.file, line: rec.line });
    const cur = merged.get(rec.id);
    if (!cur.path && rec.path) {
      cur.path = rec.path; cur.depth = rec.depth; cur.mapped = rec.mapped;
      cur.kind = rec.kind; cur.file = rec.file; cur.line = rec.line;
    }
    if (!cur.label && rec.label) cur.label = rec.label;
  }
  return { all: items, unique: [...merged.values()] };
}

/** 不是 `#cfg-*` 的控件（单选框组、列表编辑、JSON 文本域），单独数出来。 */
function extractNonCfgWidgets(files) {
  const out = { radioGroups: [], namedInputs: [], listEditors: [] };
  for (const file of files) {
    const src = readText(file);
    for (const m of src.matchAll(/name="([a-z0-9-]{3,40})"/g)) out.namedInputs.push({ name: m[1], file: rel(file) });
    for (const m of src.matchAll(/class="(mcp-[a-z]+|tc-[a-z-]+|provider-[a-z-]+)"/g)) out.listEditors.push({ cls: m[1], file: rel(file) });
  }
  const uniq = (arr, k) => [...new Map(arr.map((x) => [x[k], x])).values()];
  out.radioGroups = uniq(out.namedInputs, 'name');
  out.namedInputs = uniq(out.namedInputs, 'name');
  out.listEditors = uniq(out.listEditors, 'cls');
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. 默认配置树（动态 import 运行端的 DEFAULT_CONFIG）
 * ═══════════════════════════════════════════════════════════════════════════ */

async function loadDefaultConfig(agentApp) {
  const mod = path.join(agentApp, 'src', 'core', 'config.js');
  // 防意外读盘：指向不存在的路径（该模块顶层不读盘，双保险）
  process.env.QQ_AGENT_DATA_DIR = path.join(PROJECT_ROOT, '.tmp', '__inventory_no_such_dir__');
  try {
    const m = await import(pathToFileURL(mod).href);
    if (!m.DEFAULT_CONFIG || typeof m.DEFAULT_CONFIG !== 'object') {
      return { ok: false, error: 'DEFAULT_CONFIG 不是对象' };
    }
    return { ok: true, config: m.DEFAULT_CONFIG, file: rel(mod) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. 配置树遍历 / 分类
 * ═══════════════════════════════════════════════════════════════════════════ */

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/** 运行态 / 缓存键：不是用户会去改的设置。 */
const RUNTIME_TOP_KEYS = new Set(['runtime']);
const RUNTIME_KEY_RE = /(^|\.)(last[A-Z]\w*|changedAt|updatedAt|createdAt|firstSeenAt|conflictAt|.*From|has[A-Z]\w*)$/;

function walkTree(node, prefix, out, opts = {}) {
  const { withDefaults = true, depth = 0 } = opts;
  if (depth > 8 || node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${k}` : k;
    const secret = isSecretKey(k);
    const t = typeOf(v);
    const rec = { path: full, key: k, type: t, secret };
    if (t === 'object') {
      rec.children = Object.keys(v).length;
      out.push(rec);
      walkTree(v, full, out, { withDefaults, depth: depth + 1 });
    } else if (t === 'array') {
      rec.items = v.length;
      rec.itemType = v.length ? typeOf(v[0]) : 'empty';
      out.push(rec);
    } else {
      if (withDefaults) {
        if (secret) rec.default = '<redacted>';
        else if (typeof v === 'boolean' || typeof v === 'number') rec.default = v;
        else if (typeof v === 'string' && v.length <= 48) rec.default = v;
        else if (typeof v === 'string') rec.default = `<str:${v.length}>`;
        else rec.default = t;
      }
      out.push(rec);
    }
  }
}

function classifyPath(p) {
  if (isSecretKey(p.split('.').pop())) return '密钥';
  if (RUNTIME_TOP_KEYS.has(p.split('.')[0])) return '运行态';
  if (RUNTIME_KEY_RE.test(p)) return '运行态/派生';
  return '功能性设置';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. 手机面板 schema（BotConfigSchema.java）
 * ═══════════════════════════════════════════════════════════════════════════ */

const JAVA_TYPE = { b: 'BOOL', i: 'INT', d: 'DEC', s: 'TEXT', m: 'MULTI', list: 'LIST', e: 'ENUM' };

function parseAndroidSchema(javaFile) {
  const src = readText(javaFile);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (idx) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };

  const groups = [];
  const groupRe = /new Group\("([^"]+)",\s*\n?\s*"([^"]*)",\s*\n?\s*(IconView\.[A-Z_]+)/g;
  let gm;
  while ((gm = groupRe.exec(src))) groups.push({ title: gm[1], desc: gm[2], icon: gm[3], line: lineAt(gm.index), fields: [] });

  const groupStarts = groups.map((g, idx) => ({ ...g, idx }));

  const fields = [];
  // 只认 `xxx("path", "label"` 形态：构造助手 b/i/d/s/m/list/e
  const fre = /\b(b|i|d|s|m|list|e)\(\s*"([a-zA-Z][\w.]*)",\s*\n?\s*"([^"]*)"/g;
  let fm;
  while ((fm = fre.exec(src))) {
    const [, kind, cfgPath, label] = fm;
    const line = lineAt(fm.index);
    // 归属分组：找它前面最近的一个 new Group(
    let gi = -1;
    for (let i = 0; i < groupStarts.length; i += 1) if (groupStarts[i].line < line) gi = i;
    const rec = { path: cfgPath, label, javaType: JAVA_TYPE[kind] || kind, line };
    fields.push(rec);
    if (gi >= 0) groupStarts[gi].fields.push(rec);
  }

  const sections = (src.match(/\bsec\(/g) || []).length;
  return { groups, fields, sectionCalls: sections, file: rel(javaFile), lines: lineStarts.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7b. 按分区数控件：用 settings-save.js 里 `if (sec === 'x')` 的区块边界归属
 * ═══════════════════════════════════════════════════════════════════════════ */

function sectionItemCounts(agentApp, bindings) {
  const saveFile = path.join(agentApp, 'ui', 'pages', 'settings-save.js');
  if (!fs.existsSync(saveFile)) return [];
  const src = readText(saveFile);
  const relSave = rel(saveFile);
  const marks = [];
  for (const m of src.matchAll(/sec\s*===\s*'([\w-]+)'/g)) {
    marks.push({ sec: m[1], pos: src.slice(0, m.index).split('\n').length }); // 记行号，便于比大小
  }
  if (!marks.length) return [];
  const counts = new Map();
  for (const b of bindings) {
    if (b.file !== relSave) continue;
    let sec = '(页首)';
    for (const mk of marks) if (mk.pos <= b.line) sec = mk.sec;
    b.section = sec;                       // 顺手把分区钉在记录上，供明细表用
    if (!counts.has(sec)) counts.set(sec, new Set());
    counts.get(sec).add(b.id);
  }
  return [...counts.entries()]
    .map(([sec, set]) => ({ section: sec, items: set.size }))
    .sort((a, b) => b.items - a.items);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 7c. 顶层键在控制台前端源码里被提到多少次
 *
 *     为什么需要：`#cfg-*` 只覆盖「设置页 24 分区」那一套表单。人物记忆（livingMemory）、
 *     插件（plugins）等页面是**自己拼 patch 直接 POST /api/config**，没有 #cfg id。
 *     所以「我们没覆盖 237 条路径」不能读成「控制台没暴露」。这一节给一个反向口径：
 *     这个顶层键在 ui/**.js 里到底有没有被碰过。
 * ═══════════════════════════════════════════════════════════════════════════ */

function topKeyUiMentions(agentApp, topKeys) {
  const uiDir = path.join(agentApp, 'ui');
  const files = [];
  const push = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) push(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  };
  push(uiDir);
  const corpus = files.map((f) => readText(f)).join('\n');
  return topKeys.map((k) => ({
    key: k,
    mentions: (corpus.match(new RegExp(`\\b${k}\\b`, 'g')) || []).length
  })).sort((a, b) => a.mentions - b.mentions);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. 控制台 API 面（路由枚举 + 危险操作判定）
 * ═══════════════════════════════════════════════════════════════════════════ */
const DANGER_RE = /(delete|remove|clear|reset|restore|uninstall|rollback|stop|pause|compress|master|revoke|kill|purge|wipe|reconcile|approval)/i;

function enumerateRoutes(agentApp) {
  const consoleDir = path.join(agentApp, 'src', 'console');
  const files = [];
  const push = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) push(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  };
  push(consoleDir);

  const routes = [];
  const re = /router\.add\(\s*'([A-Z]+)'\s*,\s*(?:'([^']+)'|\/((?:\\.|[^/\n])+)\/)/g;
  for (const file of files) {
    const src = readText(file);
    const lineStarts = [0];
    for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
    const lineAt = (idx) => {
      let lo = 0; let hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    let m;
    while ((m = re.exec(src))) {
      const method = m[1];
      const p = m[2] !== undefined ? m[2] : `/${m[3]}/`;
      routes.push({
        method,
        path: p,
        file: rel(file),
        line: lineAt(m.index),
        mutating: method !== 'GET',
        dangerous: method !== 'GET' && DANGER_RE.test(p)
      });
    }
  }
  return routes;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 9. 热更新（改完不用重启）证据：routes/config.js 里保存后重排的子系统
 * ═══════════════════════════════════════════════════════════════════════════ */

function hotReloadEvidence(agentApp) {
  const file = path.join(agentApp, 'src', 'console', 'routes', 'config.js');
  const src = readText(file);
  const found = new Set();
  // next.<key> 与 cfgNow.<key> / previous<Key> 对比 = 保存后立刻重排
  for (const m of src.matchAll(/JSON\.stringify\(\s*next\.(\w+)/g)) found.add(m[1]);
  // 直接改运行期对象的调用
  for (const m of src.matchAll(/(?:store|sessions|orchestrator|mcpManager|pluginRegistry|dailyMoments|lifeFeed|qzoneInteractions|groupDigest|adminBriefing|identityPilot|slangPilot|incidentPilot)\.(?:set\w+|start\w+|stop\w+|reload|reconfigure)/g)) found.add(`(call) ${m[0]}`);
  // 明确被丢弃、控制台不写的键
  const ignored = [...src.matchAll(/delete\s+patch\.(\w+)/g)].map((m) => m[1]);
  return { hot: [...found].sort(), ignoredPatchKeys: [...new Set(ignored)].sort(), file: rel(file) };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 10. 主流程
 * ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  const problems = [];

  /* ---- 定位运行端 ---- */
  let appDir = ARGS.agentApp ? path.resolve(PROJECT_ROOT, ARGS.agentApp) : '';
  let configFile = ARGS.config ? path.resolve(PROJECT_ROOT, ARGS.config) : '';
  const discovered = discoverAgentApps(path.join(PROJECT_ROOT, '.tmp'));
  let picked = null;
  if (appDir) {
    picked = discovered.find((d) => path.resolve(d.app) === appDir) || { app: appDir, configFile: '', dataDir: '' };
  } else if (discovered.length) {
    picked = discovered[0];
    appDir = picked.app;
  }
  if (!appDir || !looksLikeAgentApp(appDir)) {
    problems.push(`FAILED: 没找到运行端源码根（需要同时含 src/core/config-legacy.js + src/console/routes/config.js + ui/pages/settings-save.js）`);
  }
  if (!configFile) configFile = picked?.configFile || '';
  if (!configFile || !fs.existsSync(configFile)) problems.push('FAILED: 没找到 data/config.json');

  const androidFile = ARGS.android
    ? path.resolve(PROJECT_ROOT, ARGS.android)
    : path.join(PROJECT_ROOT, 'android', 'app', 'src', 'com', 'whaleonebot', 'ui', 'BotConfigSchema.java');
  if (!fs.existsSync(androidFile)) problems.push('FAILED: 没找到 BotConfigSchema.java');

  const result = {
    generatedAt: new Date().toISOString(),
    agentApp: rel(appDir),
    agentAppCandidates: discovered.map((d) => ({ app: rel(d.app), config: d.configFile ? rel(d.configFile) : '', hasNodeModules: d.hasNodeModules })),
    configFile: configFile ? rel(configFile) : '',
    androidFile: rel(androidFile),
    problems
  };

  /* ---- 1. 控制台分区 ---- */
  if (looksLikeAgentApp(appDir)) {
    const menu = parseConsoleMenu(path.join(appDir, 'ui', 'pages', 'settings.js'));
    const itemRe = /\[\['[\w-]+'/; // 仅用于自检
    result.consoleMenu = menu;
    if (!menu.groups.length) problems.push(`FAILED: 解析控制台分区菜单失败：${menu.error || '空'}`);

    /* ---- 2. 控件绑定 ---- */
    const uiPagesDir = path.join(appDir, 'ui', 'pages');
    const pageFiles = fs.readdirSync(uiPagesDir).filter((f) => f.endsWith('.js')).map((f) => path.join(uiPagesDir, f));
    const appJs = path.join(appDir, 'ui', 'app.js');
    const bindingFiles = [path.join(uiPagesDir, 'settings-save.js'), ...pageFiles.filter((f) => !f.includes('settings-save.js')), appJs]
      .filter((f) => fs.existsSync(f));
    const bind = extractCfgBindings(bindingFiles);
    result.consoleBindings = {
      cfgIdsTotal: bind.all.length,
      cfgIdsUnique: bind.unique.length,
      withPath: bind.unique.filter((b) => b.path).length,
      sample: bind.unique.slice(0, 0),
      widgets: extractNonCfgWidgets(bindingFiles)
    };
    result.consoleBindingDetail = bind.unique;
    result.consoleSections = sectionItemCounts(appDir, bind.unique);
    /* ---- 3. 默认配置树 ---- */
    const defaults = await loadDefaultConfig(appDir);
    if (!defaults.ok) {
      problems.push(`FAILED: 载入 DEFAULT_CONFIG 失败：${defaults.error}`);
    } else {
      const tree = [];
      walkTree(defaults.config, '', tree);
      const leaves = tree.filter((r) => r.type !== 'object');
      result.defaultConfig = {
        file: defaults.file,
        topKeys: Object.keys(defaults.config).length,
        nodeCount: tree.length,
        leafCount: leaves.length,
        tree,
        byClass: leaves.reduce((acc, r) => {
          const c = classifyPath(r.path);
          acc[c] = (acc[c] || 0) + 1;
          return acc;
        }, {}),
        // 顶层键 → 其下叶子数（报告 §2 的键树骨架）
        topKeyLeaves: Object.keys(defaults.config).map((k) => ({
          key: k,
          type: typeOf(defaults.config[k]),
          leaves: leaves.filter((r) => r.path === k || r.path.startsWith(`${k}.`)).length,
          cls: classifyPath(k)
        }))
      };
    }

    /* ---- 4. 控制台 API 面 ---- */
    const routes = enumerateRoutes(appDir);
    result.routes = {
      total: routes.length,
      get: routes.filter((r) => r.method === 'GET').length,
      mutating: routes.filter((r) => r.mutating).length,
      dangerous: routes.filter((r) => r.dangerous).length,
      byFile: routes.reduce((acc, r) => { acc[r.file] = (acc[r.file] || 0) + 1; return acc; }, {}),
      dangerousList: routes.filter((r) => r.dangerous).map((r) => `${r.method} ${r.path}  (${r.file}:${r.line})`)
    };

    /* ---- 5. 热更新证据 ---- */
    result.hotReload = hotReloadEvidence(appDir);

    /* ---- 5b. 顶层键在前端源码里的出现次数（反向口径） ---- */
    if (result.defaultConfig?.topKeyLeaves) {
      result.uiMentions = topKeyUiMentions(appDir, result.defaultConfig.topKeyLeaves.map((t) => t.key));
    }
  }

  /* ---- 6. 活配置（只出键名/类型，不出值）---- */
  if (configFile && fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(readText(configFile));
      const tree = [];
      walkTree(raw, '', tree, { withDefaults: false });
      const tops = Object.keys(raw);
      result.liveConfig = {
        topKeys: tops.length,
        topKeysIsSecret: tops.filter((k) => isSecretKey(k)),
        nodeCount: tree.length,
        leaves: tree.filter((r) => r.type !== 'object').length,
        tree,
        topKeyList: tops.sort()
      };
    } catch (error) {
      problems.push(`FAILED: 解析 ${rel(configFile)} 失败：${String(error?.message ?? error)}`);
    }
  }

  /* ---- 7. 手机面板 + 差异对照 ---- */
  if (fs.existsSync(androidFile)) {
    const android = parseAndroidSchema(androidFile);
    result.android = {
      groups: android.groups.map((g) => ({ title: g.title, fields: g.fields.length, line: g.line })),
      groupCount: android.groups.length,
      sectionCalls: android.sectionCalls,
      fieldCount: android.fields.length,
      topKeys: [...new Set(android.fields.map((f) => f.path.split('.')[0]))].sort(),
      fields: android.fields
    };

    // 控制台侧的"设置项"：**所有能推出路径的绑定**都算（含 13 条只能推到父对象/顶层标量的，
    // 它们在控制台上同样是可改的设置项），但带 `certainty` 标注，报告里能区分虚实。
    const allBindings = result.consoleBindingDetail || [];
    const consoleItems = allBindings.filter((b) => b.path);
    const consolePaths = [...new Set(consoleItems.map((b) => b.path))];
    const certaintyOf = new Map();
    for (const b of consoleItems) {
      // 只要有一条绑定把它精确定位到叶子，这条路径就算 exact
      if (b.mapped === 'leaf') certaintyOf.set(b.path, 'exact');
      else if (!certaintyOf.has(b.path)) certaintyOf.set(b.path, 'approx');
    }
    result.consoleBindings.mappedLeaf = allBindings.filter((b) => b.mapped === 'leaf').length;
    result.consoleBindings.mappedTopLeaf = allBindings.filter((b) => b.mapped === 'topleaf').length;
    result.consoleBindings.unmappedParent = allBindings.filter((b) => b.mapped === 'parent').length;
    result.consoleBindings.unmappedNone = allBindings.filter((b) => b.mapped === 'none').length;
    result.consoleBindings.uniquePaths = consolePaths.length;
    result.consoleBindings.unmappedList = allBindings
      .filter((b) => b.mapped === 'parent' || b.mapped === 'none')
      .map((b) => ({ id: b.id, guessed: b.path, at: `${b.file}:${b.line}` }));
    const androidPaths = new Set(android.fields.map((f) => f.path));

    // 默认配置里所有"功能性设置"叶子（用于衡量覆盖面）
    const defaultLeaves = (result.defaultConfig?.tree || [])
      .filter((r) => r.type !== 'object')
      .filter((r) => classifyPath(r.path) === '功能性设置');

    const verdictOf = (p) => {
      if (androidPaths.has(p)) return 'covered';
      // 我们有它的祖先（把整段当整体编辑）
      const segs = p.split('.');
      for (let i = segs.length - 1; i > 0; i -= 1) if (androidPaths.has(segs.slice(0, i).join('.'))) return 'partial';
      // 我们只覆盖了它的一部分子键
      for (const a of androidPaths) if (a.startsWith(`${p}.`)) return 'partial';
      return 'missing';
    };

    const verdictAll = (paths) => paths.reduce((acc, p) => {
      const v = verdictOf(p);
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, { covered: 0, partial: 0, missing: 0 });

    const gapConsole = consolePaths
      .map((p) => ({ path: p, certainty: certaintyOf.get(p) || 'approx' }))
      .filter((x) => verdictOf(x.path) !== 'covered');
    const gapDefault = defaultLeaves
      .filter((r) => verdictOf(r.path) !== 'covered')
      .map((r) => ({ path: r.path, type: r.type, default: r.default }));

    result.diff = {
      consolePaths: consolePaths.length,
      consoleVerdict: verdictAll(consolePaths),
      consoleGaps: gapConsole,
      defaultFunctionalLeaves: defaultLeaves.length,
      defaultVerdict: verdictAll(defaultLeaves.map((r) => r.path)),
      defaultGaps: gapDefault,
      // 顶层键 × 覆盖面：报告 §3 的主表
      topKeyCoverage: (result.defaultConfig?.topKeyLeaves || []).map((t) => {
        const leaves = defaultLeaves.filter((r) => r.path === t.key || r.path.startsWith(`${t.key}.`));
        const v = verdictAll(leaves.map((r) => r.path));
        return {
          key: t.key,
          functionalLeaves: leaves.length,
          covered: v.covered,
          partial: v.partial,
          missing: v.missing,
          pct: leaves.length ? Math.round((v.covered / leaves.length) * 100) : 0
        };
      }).sort((a, b) => (b.missing - a.missing) || (b.functionalLeaves - a.functionalLeaves)),
      // 反向：我们面板里有、控制台这 240 条路径里没有的字段
      androidNotInConsole: android.fields
        .map((f) => f.path)
        .filter((p) => !consolePaths.includes(p)),
      androidPathsNotInDefaults: android.fields
        .map((f) => f.path)
        .filter((p) => !(result.defaultConfig?.tree || []).some((r) => r.path === p)
          && !(result.liveConfig?.tree || []).some((r) => r.path === p))
    };
  }

  /* ---- 输出 ---- */
  if (ARGS.json) {
    console.log(JSON.stringify(result, null, 2));
    return problems.length ? 1 : 0;
  }

  const L = [];
  const section = (t) => { L.push('', `── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); };

  L.push(`运行端源码：${result.agentApp}`);
  L.push(`运行端配置：${result.configFile || '(未找到)'}`);
  L.push(`手机面板 schema：${result.androidFile}`);

  if (result.consoleMenu?.groups?.length) {
    section('控制台设置分区（ui/pages/settings.js 侧栏）');
    for (const g of result.consoleMenu.groups) {
      L.push(`  ${g.title}（${g.items.length} 个分区）`);
      for (const it of g.items) L.push(`    - ${it.id.padEnd(18)} ${it.label}`);
    }
    L.push(`  合计：${result.consoleMenu.groups.reduce((n, g) => n + g.items.length, 0)} 个分区`);
  }

  if (result.consoleBindings) {
    section('控制台控件绑定');
    const b = result.consoleBindings;
    L.push(`  #cfg-* 出现次数：${b.cfgIdsTotal}；去重后：${b.cfgIdsUnique}；能解析出配置路径的：${b.withPath}`);
    L.push(`  其中精确定位到叶子 ${b.mappedLeaf}，顶层标量 ${b.mappedTopLeaf}，只到父对象 ${b.unmappedParent}，无 ${b.unmappedNone}`);
    L.push(`  唯一配置路径：${b.uniquePaths}`);
    L.push(`  非 #cfg-* 控件：radio/命名输入 ${b.widgets.namedInputs.length} 个，列表编辑器类 ${b.widgets.listEditors.length} 个`);
    if (result.consoleSections?.length) {
      L.push('  按分区（settings-save.js 的 sec 区块）计控件数：');
      for (const s of result.consoleSections) L.push(`    ${s.section.padEnd(20)} ${s.items}`);
    }
  }

  if (result.defaultConfig) {
    section('运行端默认配置（DEFAULT_CONFIG，值已脱敏）');
    const d = result.defaultConfig;
    L.push(`  顶层键：${d.topKeys}；节点：${d.nodeCount}；叶子：${d.leafCount}`);
    L.push(`  叶子按性质：${Object.entries(d.byClass).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    L.push('  顶层键（叶子数）：');
    for (const t of d.topKeyLeaves) L.push(`    ${t.key.padEnd(18)} ${String(t.leaves).padStart(3)}  ${t.type}`);
  }

  if (result.liveConfig) {
    section('活配置 config.json（只有键名与类型，无值）');
    L.push(`  顶层键：${result.liveConfig.topKeys}；叶子：${result.liveConfig.leaves}`);
  }

  if (result.uiMentions) {
    section('顶层键在前端源码里的出现次数（0 = 界面完全不提）');
    const zero = result.uiMentions.filter((x) => x.mentions === 0);
    L.push(`  完全不出现（${zero.length}）：${zero.map((x) => x.key).join(', ') || '无'}`);
    L.push(`  出现 1–2 次的：${result.uiMentions.filter((x) => x.mentions > 0 && x.mentions <= 2).map((x) => `${x.key}(${x.mentions})`).join(', ') || '无'}`);
  }

  if (result.routes) {
    section('控制台 API（素材，供 §4 危险操作）');
    L.push(`  路由总数 ${result.routes.total}（GET ${result.routes.get} / 写 ${result.routes.mutating}），疑似危险操作 ${result.routes.dangerous}`);
  }

  if (result.android) {
    section('手机面板 schema');
    L.push(`  分组 ${result.android.groupCount}；字段 ${result.android.fieldCount}；顶层键 ${result.android.topKeys.length}`);
    for (const g of result.android.groups) L.push(`    - ${g.title.padEnd(16)} ${g.fields} 项（L${g.line}）`);
  }

  if (result.diff) {
    section('差距');
    const df = result.diff;
    L.push(`  控制台可写配置路径 ${df.consolePaths} 条 → ${JSON.stringify(df.consoleVerdict)}`);
    L.push(`  默认配置功能性叶子 ${df.defaultFunctionalLeaves} 条 → ${JSON.stringify(df.defaultVerdict)}`);
    if (df.consoleGaps.length) {
      L.push('  控制台有、我们没覆盖（前 60，x=精确路径，?=只能推到父对象）：');
      for (const g of df.consoleGaps.slice(0, 60)) {
        L.push(`    ${g.certainty === 'exact' ? 'x' : '?'} ${g.path}`);
      }
    }
    if (df.topKeyCoverage?.length) {
      const t = df.topKeyCoverage.filter((x) => x.functionalLeaves > 0);
      const full = t.filter((x) => x.missing === 0 && x.partial === 0);
      const part = t.filter((x) => x.missing > 0 && (x.covered > 0 || x.partial > 0));
      const none = t.filter((x) => x.covered === 0 && x.partial === 0 && x.missing > 0);
      L.push(`  顶层键判定：有功能叶子 ${t.length} → 完全覆盖 ${full.length} / 部分 ${part.length} / 未覆盖 ${none.length}`
        + `（另 ${df.topKeyCoverage.length - t.length} 个键没有功能性叶子）`);
      L.push(`  部分覆盖：${part.map((x) => `${x.key}(${x.covered}/${x.functionalLeaves})`).join(', ') || '无'}`);
      L.push('  顶层键覆盖（功能叶子 / 我们已覆盖 / 缺）：');
      for (const x of df.topKeyCoverage) {
        if (!x.functionalLeaves) continue;
        L.push(`    ${x.key.padEnd(18)} ${String(x.functionalLeaves).padStart(3)}  ${String(x.covered).padStart(3)}  ${String(x.missing).padStart(3)}  ${String(x.pct).padStart(3)}%`);
      }
    }
    if (df.androidNotInConsole?.length) {
      L.push(`  我们面板有、控制台这 ${df.consolePaths} 条路径里没有的字段（${df.androidNotInConsole.length} 条）：`);
      for (const p of df.androidNotInConsole) L.push(`    + ${p}`);
    }
  }

  if (problems.length) {
    section('问题');
    for (const p of problems) L.push(`  ${p}`);
  }

  console.log(L.join('\n'));
  return problems.length ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error('inventory-agent-settings 失败：', error?.stack || error);
    process.exitCode = 1;
  });
