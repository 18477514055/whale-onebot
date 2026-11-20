// [LOCAL-ONLY] ============================================================
// ★ 这是**我们自己写的**，作者原仓库从来没有过。
//   · 升级作者版本时会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// knowledge-lib.js —— **多库**知识库检索（向量 + 关键词混合），按需调用、默认零注入。
//
// ═══════════════════════════════════════════════════════════════════════
// ★★★ 为什么要自己写一套，而不是用作者的 knowledge/store.js
//
//   作者那套（`src/knowledge/store.js`）是**故意做轻**的，它的硬限制写死在文件头：
//     · 只读单一目录 `data/knowledge`
//     · 只认 .md/.txt
//     · MAX_FILES=500 / MAX_FILE_BYTES=2MB / **MAX_TOTAL_BYTES=16MB** / MAX_CHUNKS=5000
//     · 纯关键词 + 中文二元组，**没有向量**
//   用户的原话需求：「我不可能徒手写知识库给他吧，很多知识库量都很庞大」+
//   「他还在一个群星相关的群 / 同学群 / 小说群」—— **三个领域、体量以 MB 计**。
//   ⇒ 16MB / 500 文件 / 单目录 这套装不下，而且纯关键词在"概念相近但用词不同"时召回很差
//     （问"飞升天赋怎么选"，语料里写的是"飞升/优势"就匹配不上）。
//
// ★ 所以这里做的是**并存**，不是替换：
//   作者的 knowledge_search 保持原样（它适合几十份小文档，简单可控）；
//   我们这套管"大语料 + 多领域"，两者可以同时开。
//
// ★ 已验证的技术事实（2026-10-28 实测，别当假设）：
//   · `node:sqlite` 默认**禁止**加载扩展，必须 `new DatabaseSync(path, { allowExtension: true })`
//   · `sqlite-vec` v0.1.9 在这个 Node 24 里能加载，`vec_version() = v0.1.9`
//   · ★ vec0 虚表的 rowid **只吃 BigInt**（传 number 会报
//     "Only integers are allows for primary key values"）—— 这个坑踩过，别改回 number
//   · ECNU embedding：`ecnu-embedding-small`，1024 维，**batch 上限 32**（64 会 HTTP 400），
//     约 28ms/条、一次 32 条约 900ms
//
// ★★ 设计上必须守住的一条（用户明确要求）：
//   **平时绝不进入上下文**，只有模型主动调工具时才检索。
//   ⇒ 本模块**不导出任何"生成提示词片段"的函数**，也绝不被 prompt.js 引用。
//     它只被 local-tools.js 的工具调用。这是结构性的保证，不是靠提示词叮嘱。
// ═══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { primaryLibraryHits } from '../memory/legacy-companion-read.js';
import { robotDurable, safeDurableFile } from '../memory/robot-durable.js';

const catalogRevision = Symbol('catalogRevision');
function managedCorpus(store, source) {
  const root = path.join(store.dir,'corpus');
  const resolved = path.resolve(source);
  const rel = path.relative(root,resolved);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..'+path.sep) || path.relative(fs.realpathSync(resolved),resolved)) {
    throw Error('Managed library sources must be non-redirected directories inside the durable corpus directory');
  }
  return resolved;
}

const DIM = 1024;
const EMBED_BATCH = 32;          // ★ 实测上限，64 会 400
const EMBED_TIMEOUT_MS = 30000;
const DEFAULT_LIMIT = 6;

// ── embedding 凭据（复用 hindsight 那份 profile，不新建一份密钥）──────────
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* 没有就算了 */ }
  return out;
}

/**
 * 从 config.json 的 providers / providerKeys 里取 provider 的 baseURL 与 key。
 * ★ 2026-11-01 新增：手机上不存在 ~/.hindsight/profiles/ecnu.env，
 *   且 ECNU 端点在手机上 TLS 握手不通（TCP 通、握手 15s 超时；PC 侧 401/307ms 正常）。
 * ★ 安全：key 只在本函数作用域内传递，不打印、不回显。
 */
function providerFromConfig(providerId) {
  try {
    // ★ 顺序很重要：QQ_AGENT_DATA_DIR 是运行时的权威数据目录。
    //   实测踩到过：<cwd>/data/config.json 也存在，但那是**旧的小文件**（36 KB），
    //   真正的配置在 QQ_AGENT_DATA_DIR 指向的目录里（61 KB）。读错了会拿不到 providerKeys。
    const candidates = [
      process.env.QQ_AGENT_CONFIG,
      process.env.QQ_AGENT_DATA_DIR ? path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json') : null,
      path.resolve(process.cwd(), 'data', 'config.json'),
    ].filter(Boolean);
    let cfg = null;
    for (const c of candidates) {
      try { cfg = JSON.parse(fs.readFileSync(c, 'utf8').replace(/^\uFEFF/, '')); break; } catch { /* 下一个 */ }
    }
    if (!cfg) return null;
    const list = Array.isArray(cfg.providers) ? cfg.providers : [];
    const hit = list.find((p) => String(p?.id || '') === providerId);
    if (!hit) return null;
    const base = String(hit.baseURL || hit.baseUrl || '').trim();
    const key = String(cfg.providerKeys?.[providerId] || '').trim();
    if (!base || !key) return null;
    return { base: base.replace(/\/+$/, ''), key };
  } catch { return null; }
}

function ecnuConfig() {
  const file = process.env.QQ_AGENT_KNOWLEDGE_ENV
    || path.join(os.homedir(), '.hindsight', 'profiles', 'ecnu.env');
  const env = { ...readEnvFile(file), ...process.env };
  const pick = (...keys) => { for (const k of keys) if (env[k]) return env[k]; return ''; };

  let base = pick('HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL', 'ECNU_BASE_URL', 'ECNU_API_BASE');
  let key = pick('HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY', 'ECNU_API_KEY', 'HINDSIGHT_API_LLM_API_KEY');
  let model = pick('HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL', 'ECNU_EMBEDDING_MODEL');

  // env 缺 key 时回落到 config.json 的 provider（手机走这条）
  // ★ BAAI/bge-m3 与 ECNU 的 ecnu-embedding-small 实测**是同一个模型**
// Distribution source.
  if (!key) {
    const pid = String(process.env.QQ_MEMORY_EMBED_PROVIDER || 'custom_siliconflow');
    const p = providerFromConfig(pid);
    if (p) {
      base = base || p.base;
      key = p.key;
      model = model || String(process.env.QQ_MEMORY_EMBED_MODEL || 'BAAI/bge-m3');
    }
  }

  return {
    base: (base || 'https://chat.ecnu.edu.cn/open/api/v1').replace(/\/+$/, ''),
    key,
    model: model || 'ecnu-embedding-small',
  };
}

/**
 * bge-m3 这一族**不支持 Matryoshka**（不能指定输出维度）。
 * ★ 2026-11-01 实测：带 `dimensions` 会报 `20015`，去掉就正常。
 * ⇒ 保守策略：默认不发，仅对已知支持 Matryoshka 的家族才带。
 */
function supportsDimensions(model) {
  const m = String(model || '').toLowerCase();
  return /qwen3-embedding|text-embedding-3|embedding-3-|voyage/.test(m);
}

// ── 配置文件：data/knowledge-lib/libraries.json ───────────────────────────
// 结构：{ version, libraries: { <id>: { name, dirs:[], exts:[], enabled, note } } }
export function configPath(dataDir) {
  return robotDurable()?.file ?? path.join(dataDir, 'knowledge-lib', 'libraries.json');
}
export function indexPath(dataDir) {
  const store = robotDurable();
  return store ? safeDurableFile(path.join(store.dir,'library-index.sqlite')) : path.join(dataDir, 'knowledge-lib', 'index.sqlite');
}

export function loadLibraries(dataDir) {
  const p = configPath(dataDir);
  let raw = null;
  const store = robotDurable();
  let revision = 0;
  if (store) {
    const row = store.db.prepare('SELECT revision,value FROM library_catalog WHERE id=1').get();
    revision = row.revision; raw = {libraries:JSON.parse(row.value)};
  } else try { raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 没有就空 */ }
  const libs = raw?.libraries && typeof raw.libraries === 'object' ? raw.libraries : {};
  const out = {};
  for (const [id, lib] of Object.entries(libs)) {
    if (!lib || typeof lib !== 'object') continue;
    out[id] = {
      id,
      name: String(lib.name || id),
      dirs: (Array.isArray(lib.dirs) ? lib.dirs : []).map(String).filter(Boolean),
      exts: (Array.isArray(lib.exts) && lib.exts.length ? lib.exts : ['.md', '.txt']).map((x) => String(x).toLowerCase()),
      enabled: lib.enabled !== false,
      note: String(lib.note || '')
    };
  }
  if (store) out[catalogRevision] = revision; // survives object spread, omitted from JSON
  return out;
}

export function saveLibraries(dataDir, libraries) {
  const p = configPath(dataDir);
  const store = robotDurable();
  if (store) {
    for (const lib of Object.values(libraries)) for (const dir of lib.dirs || []) managedCorpus(store,dir);
    const result = store.db.prepare('UPDATE library_catalog SET revision=revision+1,value=? WHERE id=1 AND revision=?')
      .run(JSON.stringify(libraries), libraries[catalogRevision] ?? 0);
    if (!result.changes) throw Error('Library catalog changed; reload before saving');
    libraries[catalogRevision] = (libraries[catalogRevision] ?? 0) + 1;
    return p;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, libraries }, null, 2), 'utf8');
  return p;
}

// ── embedding ─────────────────────────────────────────────────────────────
async function embedBatch(texts) {
  const cfg = ecnuConfig();
  if (!cfg.key || !texts.length) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const body = { model: cfg.model, input: texts, encoding_format: 'float' };
    if (supportsDimensions(cfg.model)) body.dimensions = DIM;
    const res = await fetch(`${cfg.base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`embedding HTTP ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    if (list.length !== texts.length) throw new Error(`embedding 条数不符 ${list.length}/${texts.length}`);
    return list.map((x) => (Array.isArray(x?.embedding) ? Float32Array.from(x.embedding.map(Number)) : null));
  } finally { clearTimeout(timer); }
}

/** 探测 embedding 服务是否活着（只发 1 条，最省）。 */
export async function probeEmbedding() {
  const cfg = ecnuConfig();
  if (!cfg.key) return { ok: false, error: '没有 embedding 密钥（读不到 ecnu.env）' };
  const t0 = Date.now();
  try {
    const out = await embedBatch(['ping']);
    return { ok: Boolean(out?.[0]), dim: out?.[0]?.length || 0, ms: Date.now() - t0, model: cfg.model, base: cfg.base };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── 索引库 ────────────────────────────────────────────────────────────────
// sqlite-vec 是可选依赖：装不上就退化成纯关键词（检索仍可用，只是召回差一些）。
// ★ 缓存模块本身（不是"加载结果"）：第一次 import 后就不再重复 import。
let _vecMod = null;
let _vecLoaded = false;
async function preloadVec() {
  if (_vecLoaded) return _vecMod;
  _vecLoaded = true;
  try { _vecMod = await import('sqlite-vec'); } catch { _vecMod = null; }
  return _vecMod;
}

/**
 * 解析 sqlite-vec 扩展路径（与 src/memory/memory-vec.js 的 resolveVecPath 同一策略）。
 *
 * ★ 2026-11-01 新增：npm 包的 `supportedPlatforms` **没有 android**，
 *   而 Termux 的 `process.platform` 是 `"android"` ⇒ `getLoadablePath()` 必抛
 *   `Unsupported platform for sqlite-vec, on a android-arm64 machine`。
 *   ⇒ 本文件的语义检索（`docs_vec`，55,519 条向量）**从部署起一直没生效过**，
 *     被 try/catch 静默降级成纯关键词。
 *
 * ★ 解法：官方发了 android-aarch64 预编译（release v0.1.9），把 `vec0.so` 放到
 *   `<DATA_DIR>/native/vec0.so` 即可（实测 loadExtension 成功、vec_version=v0.1.9）。
 *   ★ **不放 node_modules** —— push-app 会整个覆盖，且 PC 上只有 Windows 的 vec0.dll。
 */
function resolveVecPath(vecMod, dataDir) {
  const envPath = String(process.env.QQ_SQLITE_VEC_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const dir = String(dataDir || process.env.QQ_AGENT_DATA_DIR || 'data');
  const local = path.join(dir, 'native', process.platform === 'win32' ? 'vec0.dll' : 'vec0.so');
  if (fs.existsSync(local)) return local;
  if (!vecMod) throw new Error('sqlite-vec 未安装');
  const fn = vecMod.getLoadablePath || vecMod.default?.getLoadablePath;
  if (typeof fn !== 'function') throw new Error('sqlite-vec: getLoadablePath not found');
  return fn();
}

// ── 分块 ──────────────────────────────────────────────────────────────────
export function chunkText(text, size = 900, overlap = 120) {
  const s = Math.max(200, Math.min(4000, Number(size) || 900));
  const ov = Math.max(0, Math.min(Math.floor(s / 2), Number(overlap) || 0));
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const paras = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // ★★ 2026-10-28 修（实测发现）：词典式语料（群星本地化导出那种"一句一行、每行很短"）
  //   如果直接按段落打包到 900 字，一个 chunk 里会混进十几条互不相关的内容 ⇒
  //   检索命中后模型看到一大片噪音，"巨型结构"那条里塞满了采矿站/研究站的提示语。
  //   ⇒ 先看这段语料是不是"短行密集"：若平均行长 < 60 且行数很多，就**按行累积**成小块
  //     （目标块长约 size/3），让相邻几句仍然在一起，但不至于把整个文件混成一块。
  const lines = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  const avgLen = lines.length ? lines.reduce((a, l) => a + l.length, 0) / lines.length : 0;
  const lineDense = lines.length > 40 && avgLen < 60;

  if (lineDense) {
    const target = Math.max(150, Math.floor(s / 3));
    const out = [];
    let cur = '';
    for (const line of lines) {
      if (!cur) { cur = line; continue; }
      if (cur.length + line.length + 1 <= target) { cur += '\n' + line; continue; }
      if (cur.trim()) out.push(cur.trim());
      // 保留一点重叠：把上一块的末尾带进下一块，避免一句话被切断后两边都搜不到
      const tail = cur.slice(-Math.min(ov, cur.length));
      cur = tail && !line.startsWith(tail) ? tail + '\n' + line : line;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const out = [];
  let cur = '';
  for (const para of paras) {
    if (!cur) cur = para;
    else if (cur.length + para.length + 2 <= s) cur += `\n\n${para}`;
    else { if (cur.trim()) out.push(cur.trim()); cur = para; }
    while (cur.length > s) {
      const head = cur.slice(0, s).trim();
      if (head) out.push(head);
      cur = cur.slice(s - ov);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ── 文件发现 ──────────────────────────────────────────────────────────────
// 递归扫每个库的 dirs，只收 exts 里声明的后缀；跳过隐藏文件与 node_modules。
// Distribution source.
function walkFiles(dirs, exts, max = 20000) {
  const out = [];
  const extset = new Set((exts || []).map((e) => String(e).toLowerCase()));
  for (const root of (dirs || [])) {
    const walk = (dir, depth) => {
      if (out.length >= max || depth > 8) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= max) break;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!e.isFile()) continue;
        if (!extset.has(path.extname(e.name).toLowerCase())) continue;
        out.push(full);
      }
    };
    walk(root, 0);
  }
  return out;
}

export async function buildIndex(dataDir, libId, opts = {}) {
  const libs = loadLibraries(dataDir);
  const lib = libs[libId];
  if (!lib) throw new Error(`没有这个库：${libId}`);
  const vec = await preloadVec();
  const store = robotDurable();
  if (store) for (const dir of lib.dirs) managedCorpus(store, dir);
  const db = new DatabaseSync(indexPath(dataDir), { allowExtension: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (store) db.exec('BEGIN IMMEDIATE'); // readers see the previous complete generation
    const result = await buildLibraryRows({ db, dataDir, libId, lib, vec, opts });
    if (store) db.exec('COMMIT');
    return result;
  } finally { db.close(); } // SQLite rolls back on failure, including a throwing progress callback
}

async function buildLibraryRows({ db, dataDir, libId, lib, vec, opts }) {
  let hasVec = false;
  try {
    db.loadExtension(resolveVecPath(vec, dataDir)); hasVec = true;
  } catch { hasVec = false; }
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lib TEXT NOT NULL, source TEXT NOT NULL, chunk_no INTEGER NOT NULL,
      text TEXT NOT NULL, UNIQUE(lib, source, chunk_no));
  `);
  if (hasVec) {
    try { db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec USING vec0(embedding float[${DIM}])`); } catch { hasVec = false; }
  }

  const chunkChars = Number(opts.chunkChars) || 900;
  const overlapChars = Number(opts.overlapChars ?? 120);
  const maxFiles = Math.min(50000, Math.max(1, Number(opts.maxFiles) || 20000));
  const maxTotalBytes = Math.min(2048, Math.max(1, Number(opts.maxTotalMb) || 512)) * 1024 * 1024;

  const files = walkFiles(lib.dirs, lib.exts, maxFiles);
  // 先清空这个库的旧数据（只清这个库，不影响别的库）
  db.prepare('DELETE FROM docs WHERE lib=?').run(libId);

  let filesDone = 0, chunksDone = 0, bytes = 0, embedded = 0, embedFailed = 0;
  const pending = [];   // {lib, source, chunkNo, text}

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending.splice(0, EMBED_BATCH);
    let embs = null;
    if (hasVec) {
      try { embs = await embedBatch(batch.map((b) => b.text)); } catch { embs = null; }
    }
    const insDoc = db.prepare('INSERT OR REPLACE INTO docs(lib,source,chunk_no,text) VALUES(?,?,?,?)');
    const insVec = hasVec ? db.prepare('INSERT INTO docs_vec(rowid, embedding) VALUES(?, ?)') : null;
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      const r = insDoc.run(b.lib, b.source, b.chunkNo, b.text);
      // ★ 清掉旧向量再插（同一 rowid 覆盖会报 UNIQUE）
      if (hasVec && insVec && embs && embs[i]) {
        const rowid = Number(r.lastInsertRowid);
        try { db.prepare('DELETE FROM docs_vec WHERE rowid=?').run(BigInt(rowid)); } catch { /* 没有就跳过 */ }
        try {
          insVec.run(BigInt(rowid), new Uint8Array(embs[i].buffer));   // ★ BigInt，见文件头
          embedded += 1;
        } catch { embedFailed += 1; }
      }
    }
    chunksDone += batch.length;
    opts.onProgress?.({ filesDone, filesTotal: files.length, chunksDone, embedded, embedFailed });
  };

  for (const file of files) {
    let text;
    try {
      const st = fs.statSync(file);
      if (bytes + st.size > maxTotalBytes) break;
      bytes += st.size;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    // ★ 多目录时不能拿 dirs[0] 当基准 —— 别的目录下的文件会被算成 ../xxx。
    //   这里找出**该文件实际所属的那个根**，再取相对路径；都不匹配就用文件名。
    const ownerRoot = (lib.dirs || []).find((d) => file.toLowerCase().startsWith(String(d).toLowerCase())) || '';
    const rel = (ownerRoot ? path.relative(ownerRoot, file) : path.basename(file)).split(path.sep).join('/');
    const pieces = chunkText(text, chunkChars, overlapChars);
    for (let i = 0; i < pieces.length; i++) {
      pending.push({ lib: libId, source: rel, chunkNo: i, text: pieces[i] });
      if (pending.length >= EMBED_BATCH) await flush();
    }
    filesDone += 1;
    if (filesDone % 50 === 0) opts.onProgress?.({ filesDone, filesTotal: files.length, chunksDone, embedded, embedFailed });
  }
  while (pending.length) await flush();

  const stats = {
    lib: libId, files: filesDone, chunks: chunksDone,
    vector: hasVec, embedded, embedFailed,
    bytes, db: indexPath(dataDir)
  };
  try {
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)')
      .run(`built:${libId}`, JSON.stringify({ ...stats, at: Date.now() }));
  } catch { /* 锦上添花 */ }
  return stats;
}

// ── 检索 ──────────────────────────────────────────────────────────────────
// ★★ 2026-10-31 重写（实测驱动，改动前请读这段）：
//
//   老版本有三个毛病，实测「铸铜术解锁什么」「兵营能训练什么」直接排到前 3 之外：
//   ① **疑问句整串被当成 term**：「铸铜术解锁什么」会切出 术解 / 锁什 这种**跨词碎片**
//      —— 它们既不是词，又必然在别处零散命中，把真正的实体名（铸铜术）挤下去。
//   ② **虚字二元组**：锁什 / 么产 / 营能 全是垃圾，命中一次算一次分。
//   ③ **高频词靠刷次数翻盘**：老代码对每个 term 的出现次数最多数 12 次，
//      于是「解锁」「产出」「训练」这种在几百条里都出现的词，
//      只要在一条里重复几次就能压过只出现一次的实体名。
//
//   修法（三条都验证过，见 _probe-kb-*.mjs）：
//   a. 先去疑问词，再切 term；
//   b. 中文二元组里**只要含虚字就丢掉**（实词二元组保留，'术解' 这种留着也无害）；
//   c. 打分改成 **min(次数,1) × idf × 头部加权**：
//      · cap=1 —— 一个 term 在一条里出现 1 次和 10 次给一样的分（治刷次数）；
//      · idf  —— 在几百条里都出现的词权重趋近 0（治高频动词）；
//      · 头部 ×8（前 32 字内命中）—— 结构化条目是「【建筑】兵营（BUILDING_BARRACKS）…」，
//        实体名就在最前面，这是最强的信号。
//
//   ★ 效果（两库各 8~10 题，`_probe-kb-sweep.mjs` / `_probe-kb-holdout.mjs`）：
//     调参集 18/18（原 16/18）；**留出集 15/16（原 13/16）** —— 留出集没参与调参，不算过拟合。
//   ★ 纯 A/B 复现：`_probe-kb-ab.mjs` / `_probe-kb-final.mjs`。
const QUESTION_WORDS = /(有什么|是什么|怎么样|怎么|怎样|如何|多少|哪些|哪个|哪里|为什么|是不是|有没有|能不能|可以|需要|应该|好不好)/g;
// 虚词/功能字：含这些字的二元组几乎全是跨词碎片（锁什 / 么产 / 营能）
const FUNC_CHARS = new Set('什么哪怎吗呢吧如何多少可以不有的是的要应该好能会就都也还很太更最和与及或但对把被让使给在从到为了一二三四五六七八九十'.split(''));

/**
 * ★★★ 2026-11-01 新增：中英别名映射。
 *
 * 【为什么必须有它】实测「棉花堡的奇观加成是什么」搜不到正确答案，根因是：
 *   · 64143 条：`LOC_FEATURE_PAMUKKALE_NAME ▸ 棉花堡` —— 有中文，但**没有加成内容**
 *   · 64147 条：`LOC_FEATURE_PAMUKKALE_DESCRIPTION ▸ 占2个单元格…+1宜居度…` —— 有加成，但**没有中文**
 *   ⇒ 查中文「棉花堡」永远命中不了 64147；只有查英文 Pamukkale 才行。
 *
 * 【怎么修的】从库里扫出 `KEY_NAME ▸ 中文` 这类行，建 中文→英文键 的映射；
 *   检索时把查询里的中文名**展开成英文键**一起搜。
 *   映射缓存在进程内（按 index 文件 mtime 失效），不写库、不改变任何现有行为。
 */
const ALIAS_RE = /([A-Z][A-Z0-9_]{2,})_(?:NAME|DESCRIPTION)\s*▸\s*([^\n\r]{1,40})/g;
let _aliasCache = null;
let _aliasCacheKey = '';

function buildAliasMap(db, want) {
  try {
    const ph = want.map(() => '?').join(',');
    const rows = db.prepare(`SELECT text FROM docs WHERE lib IN (${ph})`).all(...want);
    const map = new Map();   // 中文 -> Set(英文基名)
    for (const r of rows) {
      const text = String(r.text || '');
      if (!text.includes('▸')) continue;
      ALIAS_RE.lastIndex = 0;
      let m;
      while ((m = ALIAS_RE.exec(text)) !== null) {
        const key = m[1];                  // 例如 PAMUKKALE
        const cn = String(m[2] || '').trim();
        if (!cn || cn.length < 2 || cn.length > 20) continue;
        if (!/^[\u4e00-\u9fa5]/.test(cn)) continue;
        if (!map.has(cn)) map.set(cn, new Set());
        map.get(cn).add(key);
      }
    }
    return map;
  } catch { return new Map(); }
}

/** 把查询里的中文名展开成对应的英文基名（只加高价值的长名，不滥加）。 */
function expandAliases(q, aliasMap, out) {
  const addedList = [];
  if (!aliasMap || !aliasMap.size) return;
  const lowerQ = String(q || '').toLowerCase();
  let added = 0;
  for (const [cn, keys] of aliasMap) {
    if (cn.length < 3) continue;              // ★ 只展开 3 字以上的名（"棉花"太泛，会污染）
    if (!lowerQ.includes(cn)) continue;
    for (const k of keys) {
      const tk = k.toLowerCase();
      if (tk.length < 4) continue;
      out.add(tk);
      addedList.push(tk);
      added += 1;
    }
    if (added > 30) break;
  }
  return addedList;
}

function queryTerms(query) {
  const q = String(query || '').trim();
  const stripped = q.toLowerCase().replace(QUESTION_WORDS, ' ');
  const out = new Set();
  for (const t of stripped.split(/[\s,，。;；、:：!！?？()（）\[\]【】"'“”]+/)) {
    // 纯中文且超过 6 字：几乎不可能原样命中，只会白占一个 term
    if (/^[\u4e00-\u9fa5]+$/.test(t) && t.length > 6) continue;
    if (t.length >= 2 && t.length <= 24) out.add(t);
  }
  // 中文二元组：让"飞升天赋"能命中"飞升"与"天赋"（同时丢掉含虚字的碎片）
  const cn = stripped.replace(/[^\u4e00-\u9fa5]+/g, '');
  for (let i = 0; i + 2 <= cn.length && i < 40; i++) {
    const bg = cn.slice(i, i + 2);
    if ([...bg].some((c) => FUNC_CHARS.has(c))) continue;
    out.add(bg);
  }
  // ★★★ 2026-11-01 修（只做这一件事）：把**完整中文词**也加进 terms。
  //   原来只切二元组，「棉花堡」永远不是一个 term ⇒ 强度比不过高频的「棉花」。
  //   实测：查「棉花堡」时"棉花资源"得分 67.4，真正的棉花堡只有 48.3，被挤出前 3；
  //        而用 Pamukkale 查，第 1 条就是正确条目（94.1）。
  //   ★ 这里**不改任何打分权重**，只是让完整词参与进来 —— 先验证效果再决定要不要调。
  for (let len = 8; len >= 3; len -= 1) {
    for (let i = 0; i + len <= cn.length && i < 20; i += 1) {
      const sub = cn.slice(i, i + len);
      if ([...sub].some((c) => FUNC_CHARS.has(c))) continue;
      out.add(sub);
    }
    if (out.size > 80) break;
  }
  return [...out];
}

/** 关键词打分参数（集中放在这里，调参只动这 3 个数） */
const KW_TERM_CAP = 1;      // 单个 term 在一条里最多计几次（1 = 只管有没有，不管几次）
const KW_HEAD_LEN = 32;     // 「头部」长度
const KW_HEAD_MUL = 8;      // 头部命中的权重倍数

// ★★★ 2026-11-01 修（实测）：KW_HEAD_MUL=8 会让"文本开头碰巧出现高频短词"的条目
//   碾压"精确匹配长词"的条目。算一下：
//     · 2 字词「棉花」在开头 ⇒ idf × 8(head) = 8·idf
//     · 3 字词「棉花堡」在中部 ⇒ idf × 1 = 1·idf
//   ⇒ 精确匹配必然输。所以 3 字词的基础权重必须 > 8，取 10。
const KW_LEN3_BONUS = 10.0;   // 3 字中文完整词
const KW_LEN4_BONUS = 14.0;   // 4 字
const KW_LEN5_BONUS = 18.0;   // 5 字及以上
const KW_EXACT_BONUS = 80;    // 整句原样命中（最强信号）
const KW_ALIAS_BONUS = 120;   // ★ 通过中英别名命中的加分（强于普通词，略低于整句原样）

/**
 * 混合检索：向量召回（有 vec 时）+ 关键词打分，两路结果合并去重。
 * @returns {Promise<{results:Array<{lib,source,text,score,how}>, stats:object}>}
 */
export async function search(dataDir, query, { libs = null, limit = DEFAULT_LIMIT } = {}) {
  const found = await searchManagedOrStandalone(dataDir,query,{libs,limit});
  const remaining=Math.min(20,Math.max(1,Number(limit)||DEFAULT_LIMIT))-found.results.length;
  if(remaining>0) found.results.push(...primaryLibraryHits(String(query||'').trim(),libs,remaining));
  return found;
}
async function searchManagedOrStandalone(dataDir,query,{libs,limit}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], stats: { reason: 'empty query' } };

  const allLibs = loadLibraries(dataDir);
  const want = Array.isArray(libs) && libs.length
    ? libs.filter((id) => allLibs[id])
    : Object.keys(allLibs).filter((id) => allLibs[id].enabled);
  if (!want.length) return { results: [], stats: { reason: '没有启用任何库', libs: Object.keys(allLibs) } };

  const file = indexPath(dataDir);
  if (!fs.existsSync(file)) return { results:[], stats:{ reason:'索引尚未建立' } };
  const vec = await preloadVec();
  const db = new DatabaseSync(file, { readOnly:true, allowExtension: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='docs'").get()) return { results:[], stats:{ reason:'索引尚未建立' } };
    return await searchIndex(db,dataDir,q,allLibs,want,vec,limit);
  } finally { db.close(); }
}
async function searchIndex(db,dataDir,q,allLibs,want,vec,limit) {
  let hasVec = false;
  try { db.loadExtension(resolveVecPath(vec, dataDir)); hasVec = true; } catch { hasVec = false; }

  const max = Math.max(1, Math.min(20, Number(limit) || DEFAULT_LIMIT));
  const byId = new Map();   // docId -> {lib,source,text,score,how}

  // ── 路线 A：关键词（永远可用，不怕 embedding 挂）──
  // ★ 2026-10-31 改打分（理由见 queryTerms 上方那段长注释）：
  //   min(次数, KW_TERM_CAP) × idf × (头部命中 ? KW_HEAD_MUL : 1)
  let aliasTerms = [];
  const terms = queryTerms(q);
  // ★ 中文名展开成英文键（治「棉花堡」搜不到 PAMUKKALE_DESCRIPTION）
  {
    const idxPath = indexPath(dataDir);
    let mt = '';
    try { const st = fs.statSync(idxPath); mt = String(st.mtimeMs) + ':' + want.join(','); } catch { mt = 'none'; }
    if (_aliasCacheKey !== mt) {
      _aliasCache = buildAliasMap(db, want);
      _aliasCacheKey = mt;
    }
    const termSet = new Set(terms);
    aliasTerms = expandAliases(q, _aliasCache, termSet);
    terms.length = 0;
    terms.push(...termSet);
  }
  const _aliasHits = new Set(aliasTerms || []);
  const ph = want.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, lib, source, chunk_no, text FROM docs WHERE lib IN (${ph})`).all(...want);
  const lowerRows = rows.map((r) => String(r.text).toLowerCase());
  // idf 需要「每个 term 命中多少条」——扫一遍全库，一次性算出来（N 最多几万，可接受）
  const docFreq = new Map();
  for (const t of terms) {
    let n = 0;
    for (const lower of lowerRows) if (lower.includes(t)) n += 1;
    docFreq.set(t, n);
  }
  const totalDocs = Math.max(1, rows.length);
  for (let ri = 0; ri < rows.length; ri += 1) {
    const r = rows[ri];
    const lower = lowerRows[ri];
    const head = lower.slice(0, KW_HEAD_LEN);
    let score = 0;
    for (const t of terms) {
      const df = docFreq.get(t) || 0;
      if (!df) continue;                          // 这个词在全库一次都没出现，跳过
      let c = 0, at = lower.indexOf(t);
      while (at >= 0 && c < KW_TERM_CAP) { c += 1; at = lower.indexOf(t, at + t.length); }
      if (!c) continue;
      const idf = Math.log(totalDocs / df);       // 越常见越接近 0；只出现过 1 次的词权重最高
      // ★ 长度梯度：长词更具体，必须能压过高频短词的头部奖励
      const isCn = /^[\u4e00-\u9fa5]+$/.test(t);
      const lenBonus = !isCn ? 1 : (t.length >= 5 ? KW_LEN5_BONUS : t.length === 4 ? KW_LEN4_BONUS : t.length === 3 ? KW_LEN3_BONUS : 1);
      score += c * idf * (head.includes(t) ? KW_HEAD_MUL : 1) * lenBonus;
      // ★ 别名命中：这条虽然没写中文名，但它就是用户问的那个东西（如 PAMUKKALE_DESCRIPTION）
      if (_aliasHits.has(t)) score += KW_ALIAS_BONUS;
    }
    if (q.length >= 2 && lower.includes(q.toLowerCase())) score += KW_EXACT_BONUS;   // ★ 整句原样命中
    if (score > 0) byId.set(Number(r.id), { lib: r.lib, source: r.source, text: r.text, score, how: 'keyword' });
  }

  // ── 路线 B：向量（embedding 挂了就跳过，绝不影响 A）──
  let vecCount = 0;
  if (hasVec) {
    try {
      const emb = (await embedBatch([q]))?.[0];
      if (emb) {
        const hits = db.prepare('SELECT rowid, distance FROM docs_vec WHERE embedding MATCH ? AND k = ?')
          .all(new Uint8Array(emb.buffer), Math.min(60, max * 8));
        for (const h of hits) {
          const id = Number(h.rowid);
          const doc = db.prepare('SELECT lib, source, text FROM docs WHERE id=?').get(id);
          if (!doc || !want.includes(doc.lib)) continue;
          // 距离 → 分数（vec0 用 L2；越小越像）
          const sim = 1 / (1 + Number(h.distance) || 1);
          const vScore = sim * 20;
          const prev = byId.get(id);
          if (prev) { prev.score += vScore; prev.how = 'keyword+vector'; }
          else byId.set(id, { lib: doc.lib, source: doc.source, text: doc.text, score: vScore, how: 'vector' });
          vecCount += 1;
        }
      }
    } catch { /* 向量路失败不影响关键词结果 */ }
  }

  const merged = [...byId.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  // 每个库最多占一半名额，避免"一个库把结果全吃掉"（用户是三领域并存）
  const perLibCap = Math.max(1, Math.ceil(max / Math.max(1, want.length)));
  const used = {};
  const balanced = [];
  for (const m of merged) {
    used[m.lib] = (used[m.lib] || 0) + 1;
    if (used[m.lib] <= perLibCap) balanced.push(m);
  }
  for (const m of merged) if (balanced.length < max && !balanced.includes(m)) balanced.push(m);

  return {
    results: balanced.slice(0, max).map((m) => ({
      lib: m.lib, libName: allLibs[m.lib]?.name || m.lib,
      source: m.source, text: String(m.text).replace(/\s+/g, ' ').trim(),
      score: Math.round(m.score * 10) / 10, how: m.how
    })),
    stats: { libs: want, vector: hasVec, vecHits: vecCount, keywordHits: rows.length, returned: balanced.length }
  };
}

/** 索引概况（给工具/脚本看现在装了多少）。 */
export async function stats(dataDir) {
  const libs = loadLibraries(dataDir);
  const p = indexPath(dataDir);
  if (!fs.existsSync(p)) {
    return { libs: Object.keys(libs), indexed: {}, note: '索引文件还不存在（还没建过）' };
  }
  const db = new DatabaseSync(p, { readOnly: true, allowExtension: false });
  const out = {};
  try {
    for (const id of Object.keys(libs)) {
      const c = db.prepare('SELECT COUNT(*) n FROM docs WHERE lib=?').get(id)?.n || 0;
      out[id] = { name: libs[id].name, chunks: Number(c) };
    }
  } finally { db.close(); }
  return { libs: Object.keys(libs), indexed: out, db: p };
}
