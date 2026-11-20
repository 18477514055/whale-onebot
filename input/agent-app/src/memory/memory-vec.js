// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 机器人记忆检索层 v3
// 设计：sqlite-vec + ecnu embedding/rerank；零 LLM；任何失败都降级为空结果，不抛错。
// 存储：<DATA_DIR>/memory-vec.sqlite；表 impressions_vec(partition key=uin, chunk_size=8) + impressions_meta。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, getConfig } from '../core/config.js';

const DIM = 1024;
const DEFAULT_DB = path.join(DATA_DIR, 'memory-vec.sqlite');
const DEFAULT_ECNU_ENV = path.join(os.homedir(), '.hindsight', 'profiles', 'ecnu.env');
const clean = (v, n = 2000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

let db = null;
let initPromise = null;
let lastError = '';

function readEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {}
  return out;
}

/**
 * 从 config.json 的 providers / providerKeys 里取某个 provider 的 baseURL 与 key。
 * ★ 2026-11-01 新增：手机上根本没有 ~/.hindsight/profiles/ecnu.env，
 *   且 ECNU 端点在手机上 TLS 握手不通（TCP 20ms 通、握手 15s 超时；PC 侧正常 401/307ms）。
 *   ⇒ 改成优先读 config.json 里**已经在用**的 provider，env 只作为兜底。
 * ★ 安全：key 只在本函数作用域内传递，不打印、不回显。
 */
function providerFromConfig(providerId) {
  try {
    const cfg = getConfig() || {};
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
  const env = { ...readEnvFile(process.env.HINDSIGHT_ECNU_ENV || DEFAULT_ECNU_ENV), ...process.env };
  const pick = (...keys) => { for (const k of keys) if (env[k]) return env[k]; return ''; };

  // ① 显式环境变量优先（PC 上继续用 ECNU，行为与历史完全一致）
  let base = pick('HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL', 'ECNU_BASE_URL', 'ECNU_API_BASE');
  let key = pick('HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY', 'ECNU_API_KEY', 'HINDSIGHT_API_LLM_API_KEY');
  let embModel = pick('HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL', 'ECNU_EMBEDDING_MODEL');
  let rerankBase = pick('HINDSIGHT_API_RERANKER_BASE_URL', 'ECNU_RERANK_BASE_URL');
  let rerankKey = pick('HINDSIGHT_API_RERANKER_API_KEY', 'ECNU_RERANK_API_KEY');
  let rerankModel = pick('HINDSIGHT_API_RERANKER_MODEL', 'ECNU_RERANK_MODEL');

  // ② env 缺 key 时回落到 config.json 的 provider（手机走这条）
  //   ★ 选 siliconflow 的 BAAI/bge-m3，因为实测它与 ECNU 的 ecnu-embedding-small
// Distribution source.
  //     ⇒ 660 条旧向量与新查询向量同空间，**不需要重建索引**。
// Distribution source.
  //   ★ rerank 用 BAAI/bge-reranker-v2-m3（实测 319~375ms，接口与现有解析完全兼容）。
  if (!key) {
    const pid = String(process.env.QQ_MEMORY_EMBED_PROVIDER || 'custom_siliconflow');
    const p = providerFromConfig(pid);
    if (p) {
      base = base || p.base;
      key = p.key;
      embModel = embModel || String(process.env.QQ_MEMORY_EMBED_MODEL || 'BAAI/bge-m3');
      rerankBase = rerankBase || p.base;
      rerankKey = rerankKey || p.key;
      rerankModel = rerankModel || String(process.env.QQ_MEMORY_RERANK_MODEL || 'BAAI/bge-reranker-v2-m3');
    }
  }

  // ③ 最后兜底：保持原有默认值（PC 无 env 时行为与历史一致）
  base = base || 'https://chat.ecnu.edu.cn/open/api/v1';
  embModel = embModel || 'ecnu-embedding-small';
  rerankBase = rerankBase || base;
  rerankKey = rerankKey || key;
  rerankModel = rerankModel || 'ecnu-rerank';

  return {
    base: String(base).replace(/\/+$/, ''), key, embModel,
    rerankBase: String(rerankBase).replace(/\/+$/, ''), rerankKey, rerankModel,
  };
}

async function fetchJson(url, body, key, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * bge-m3 这一族**不支持 Matryoshka**（不能指定输出维度）。
 * ★ 2026-11-01 实测：对 bge-m3 / bge-large-zh / Pro/bge-m3 带上 `dimensions` 会报
 *   `20015`；去掉就正常。而 Qwen3-Embedding-* 接受该字段。
 * ⇒ 只在"模型名看起来支持"时才发这个字段，避免一换模型就 100% 失败。
 *   判据保守：默认**不发**，仅当模型名含 qwen3-embedding / text-embedding-3 这类
 *   已知支持 Matryoshka 的家族时才带。
 */
function supportsDimensions(model) {
  const m = String(model || '').toLowerCase();
  return /qwen3-embedding|text-embedding-3|embedding-3-|voyage/.test(m);
}

async function embedMany(texts) {
  const cfg = ecnuConfig();
  if (!cfg.key || !texts.length) return null;
  try {
    const body = { model: cfg.embModel, input: texts, encoding_format: 'float' };
    if (supportsDimensions(cfg.embModel)) body.dimensions = DIM;
    const json = await fetchJson(`${cfg.base}/embeddings`, body, cfg.key, 12000);
    const list = Array.isArray(json?.data) ? json.data : [];
    if (list.length !== texts.length) return null;
    return list.map((x) => (Array.isArray(x?.embedding) ? x.embedding.map(Number) : null));
  } catch (e) {
    lastError = `embed: ${e?.message || e}`;
    return null;
  }
}

async function embedOne(text) {
  const out = await embedMany([text]);
  return out && out[0] ? out[0] : null;
}

async function rerank(query, docs, topK) {
  const cfg = ecnuConfig();
  if (!cfg.rerankKey || !docs.length) return null;
  try {
    const json = await fetchJson(`${cfg.rerankBase}/rerank`, {
      model: cfg.rerankModel, query, documents: docs, top_n: topK,
    }, cfg.rerankKey, 20000);
    const list = Array.isArray(json?.results) ? json.results : Array.isArray(json?.data) ? json.data : [];
    return list
      .map((x) => ({ index: Number(x.index), score: Number(x.relevance_score ?? x.score ?? 0) }))
      .filter((x) => Number.isInteger(x.index) && x.index >= 0 && x.index < docs.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  } catch (e) {
    lastError = `rerank: ${e?.message || e}`;
    return null;
  }
}

/**
 * 解析 sqlite-vec 的可加载扩展路径。
 *
 * ★ 2026-11-01 新增旁路：npm 包 `sqlite-vec` 的 `optionalDependencies` 与
 *   `supportedPlatforms` **都没有 android**（只有 darwin/linux/win32），
 *   而 Termux 的 `process.platform` 是 `"android"` ⇒ `getLoadablePath()` 必抛
 *   `Unsupported platform for sqlite-vec, on a android-arm64 machine`。
 *   ⇒ 手机上这条语义检索从部署起**一次都没成功过**（被三层 try/catch 静默吞掉）。
 *
 * ★ 解法：官方其实发了 android-aarch64 预编译（release v0.1.9，
 *   `sqlite-vec-0.1.9-loadable-android-aarch64.tar.gz`，解出 `vec0.so` 151,680 B），
 *   只是 npm 没接进平台表。把 `vec0.so` 放到 `<DATA_DIR>/native/vec0.so` 即可。
 *   ★ **不要放 node_modules** —— push-app 会整个覆盖 node_modules，
 *     而 PC 上只有 Windows 的 `vec0.dll`，推过去等于把好的换成坏的。
 *
 * 实测（真机 Termux / Node v24.22.1 / android arm64）：
 *   loadExtension 成功、`vec_version() = v0.1.9`、660 条真实向量 KNN 命中正确。
 */
async function resolveVecPath() {
  // ① 显式环境变量
  const envPath = String(process.env.QQ_SQLITE_VEC_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  // ② 项目内固定位置（手机走这条；PC 上一般不存在，自动落到 ③）
  const local = path.join(DATA_DIR, 'native', process.platform === 'win32' ? 'vec0.dll' : 'vec0.so');
  if (fs.existsSync(local)) return local;

  // ③ npm 包（PC 上的历史行为，保持不变）
  const mod = await import('sqlite-vec');
  const fn = mod.getLoadablePath || mod.default?.getLoadablePath;
  if (typeof fn === 'function') return fn();
  throw new Error('sqlite-vec: getLoadablePath not found');
}

async function ensureDb() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (getConfig()?.memoryVec?.enabled === false) throw new Error('memoryVec disabled');
      const loadable = await resolveVecPath();
      const file = getConfig()?.memoryVec?.dbPath || DEFAULT_DB;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const d = new DatabaseSync(file, { allowExtension: true });
      d.loadExtension(loadable);
      d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS impressions_vec USING vec0(uin TEXT partition key, embedding float[${DIM}], chunk_size=8)`);
      d.exec(`CREATE TABLE IF NOT EXISTS impressions_meta(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uin TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER,
        source_chat_keys TEXT,
        updated_at INTEGER,
        UNIQUE(uin, hash)
      )`);
      d.exec('CREATE INDEX IF NOT EXISTS idx_meta_uin ON impressions_meta(uin)');
      db = d;
      return true;
    } catch (e) {
      lastError = `init: ${e?.message || e}`;
      db = null;
      return false;
    }
  })();
  return initPromise;
}

export function isAvailable() {
  return Boolean(db);
}
export function getLastError() {
  return lastError;
}

export async function upsertImpression({ uin, content, createdAt, sourceChatKeys }) {
  if (!(await ensureDb())) return false;
  const text = clean(content);
  const user = String(uin || '').trim();
  if (!text || !user) return false;
  try {
    const hash = crypto.createHash('sha256').update(`${user}\n${text}`).digest('hex');
    const old = db.prepare('SELECT id FROM impressions_meta WHERE uin = ? AND hash = ?').get(user, hash);
    if (old) {
      db.prepare('UPDATE impressions_meta SET updated_at = ? WHERE id = ?').run(Date.now(), old.id);
      return true;
    }
    const emb = await embedOne(text);
    if (!emb) return false;
    const info = db.prepare(
      'INSERT INTO impressions_meta(uin, content, hash, created_at, source_chat_keys, updated_at) VALUES(?,?,?,?,?,?)'
    ).run(user, text, hash, Number(createdAt) || Date.now(), JSON.stringify(sourceChatKeys || []), Date.now());
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO impressions_vec(rowid, uin, embedding) VALUES(CAST(? AS INTEGER), ?, ?)')
      .run(id, user, Buffer.from(new Float32Array(emb).buffer));
    return true;
  } catch (e) {
    lastError = `upsert: ${e?.message || e}`;
    return false;
  }
}

export async function searchForPerson(uin, query, topK = 3, opts = {}) {
  if (!(await ensureDb())) return [];
  const user = String(uin || '').trim();
  const q = clean(query, 200);
  if (!user || !q) return [];
  // 会话隔离：和 memory-global 的 visible() 保持同一规则 —— 有来源标记的必须命中当前 chatKey；
  // 没有来源标记的老条目无法归属，宁可保留。不传 chatKey 则不隔离（内部工具/调试用）。
  const chatKey = String(opts?.chatKey || '').trim();
  const inScope = (raw) => {
    if (!chatKey) return true;
    try {
      const arr = JSON.parse(raw || '[]');
      if (!Array.isArray(arr) || !arr.length) return true;
      return arr.includes(chatKey);
    } catch {
      return true;
    }
  };
  try {
    const emb = await embedOne(q);
    if (!emb) return [];
    const k = Math.max(topK * 4, 12);
    const rows = db.prepare(
      'SELECT rowid, distance FROM impressions_vec WHERE embedding MATCH ? AND k = ? AND uin = ?'
    ).all(Buffer.from(new Float32Array(emb).buffer), k, user);
    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.rowid));
    const placeholders = ids.map(() => '?').join(',');
    const metas = db.prepare(`SELECT id, content, source_chat_keys FROM impressions_meta WHERE id IN (${placeholders})`).all(...ids);
    const byId = new Map(metas.map((m) => [Number(m.id), m]));
    const docs = ids.map((id) => byId.get(id)).filter((m) => m && inScope(m.source_chat_keys)).map((m) => m.content);
    if (!docs.length) return [];
    const ranked = await rerank(q, docs, topK);
    if (ranked) return ranked.map((r) => ({ content: docs[r.index], score: r.score }));
    return docs.slice(0, topK).map((content, i) => ({ content, score: 1 - i / Math.max(docs.length, 1) }));
  } catch (e) {
    lastError = `search: ${e?.message || e}`;
    return [];
  }
}

export async function rebuildFromPeople(peopleDir = path.join(DATA_DIR, 'memory', 'people')) {
  if (!(await ensureDb())) return { ok: false, error: lastError };
  try {
    const items = [];
    for (const name of fs.readdirSync(peopleDir)) {
      if (!name.endsWith('.json')) continue;
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(path.join(peopleDir, name), 'utf8').replace(/^\uFEFF/, ''));
      } catch { continue; }
      const uin = String(data?.userId || name.replace(/\.json$/i, ''));
      for (const imp of Array.isArray(data?.impressions) ? data.impressions : []) {
        const text = clean(imp?.content);
        if (text) items.push({ uin, text, createdAt: Number(imp?.createdAt) || Date.now(), sourceChatKeys: imp?.sourceChatKeys || data?.sourceChatKeys || [] });
      }
    }

    // ★ 2026-10-26 修：原来是「先 DELETE 再逐批 embedding」，embedding 一挂（ECNU 是外部服务，
    //   实测会偶发失败）就 return，而表已被清空 ⇒ 向量库归零且不恢复。实测踩到过一次（meta=0 vec=0）。
    //   改成**先把所有 embedding 算完**，全部成功后再在一个事务里替换；任何一批失败就直接返回，
    //   原库原封不动（preserved:true）。
    const BATCH = 16;
    const embsAll = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH);
      const embs = await embedMany(slice.map((x) => x.text));
      if (!embs) return { ok: false, error: lastError, total: items.length, added: 0, preserved: true };
      for (let j = 0; j < slice.length; j += 1) embsAll.push(embs[j] || null);
    }

    let added = 0;
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM impressions_vec');
      db.exec('DELETE FROM impressions_meta');
      for (let idx = 0; idx < items.length; idx += 1) {
        const it = items[idx];
        const emb = embsAll[idx];
        if (!emb) continue;
        const hash = crypto.createHash('sha256').update(`${it.uin}\n${it.text}`).digest('hex');
        const info = db.prepare(
          'INSERT INTO impressions_meta(uin, content, hash, created_at, source_chat_keys, updated_at) VALUES(?,?,?,?,?,?)'
        ).run(it.uin, it.text, hash, it.createdAt, JSON.stringify(it.sourceChatKeys), Date.now());
        db.prepare('INSERT INTO impressions_vec(rowid, uin, embedding) VALUES(CAST(? AS INTEGER), ?, ?)')
          .run(Number(info.lastInsertRowid), it.uin, Buffer.from(new Float32Array(emb).buffer));
        added += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败也要把原始错误抛出去 */ }
      throw e;
    }
    return { ok: true, total: items.length, added };
  } catch (e) {
    lastError = `rebuild: ${e?.message || e}`;
    return { ok: false, error: lastError };
  }
}

export async function stats() {
  if (!(await ensureDb())) return { ok: false, error: lastError };
  try {
    const meta = db.prepare('SELECT COUNT(*) AS n FROM impressions_meta').get();
    const vec = db.prepare('SELECT COUNT(*) AS n FROM impressions_vec').get();
    return { ok: true, meta: Number(meta?.n || 0), vec: Number(vec?.n || 0), db: getConfig()?.memoryVec?.dbPath || DEFAULT_DB };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function close() {
  try { db?.close(); } catch {}
  db = null;
  initPromise = null;
}
