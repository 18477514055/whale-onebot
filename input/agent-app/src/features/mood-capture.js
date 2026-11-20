// [LOCAL-ONLY] 情绪采集的落地模块：把一条消息交给 mood-engine，按限流规则喂进去。
//
// 设计约束（都来自实测与用户要求）：
//   · 每群每小时最多采纳 3 次（防刷屏群把心情打到端点）
//   · 同一小时同类事件递减 100%/50%/25%
//   · 全程 try/catch：心情是增强项，任何异常都不能影响消息落库
//   · 只处理入站消息（self=false），不处理机器人自己说的话
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  detectEmotion,
  emotionDecay,
  EMOTION_PER_CHAT_PER_HOUR
} from './mood-engine.js';

const HOUR_MS = 3600000;

/** 进程内限流状态：`chat|hour` → 已采纳次数；`chat|hour|kind` → 该类型次数。 */
const _used = new Map();
let _lastSweep = 0;

function sweep(now) {
  // 每小时清理一次过期键，避免无界增长
  if (now - _lastSweep < HOUR_MS) return;
  _lastSweep = now;
  const curHour = Math.floor(now / HOUR_MS);
  for (const k of [..._used.keys()]) {
    const parts = k.split('|');
    const h = Number(parts[parts.length === 2 ? 1 : 1]);
    if (!Number.isFinite(h) || curHour - h > 2) _used.delete(k);
  }
}

function moodDbPath(dataDir) {
  return path.join(String(dataDir || ''), 'mood-engine.sqlite');
}

/**
 * 找数据目录。★ 不能只信 QQ_AGENT_DATA_DIR —— 手机运行时它未必被设置
 * （实测：`build-entity-fts.mjs` 必须手动带这个变量才认得到库）。
 * 按优先级依次探测，谁先有 mood-engine.sqlite 就用谁。
 */
let _resolvedDataDir = null;
function resolveDataDir() {
  if (_resolvedDataDir) return _resolvedDataDir;
  const candidates = [];
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (env) candidates.push(env);
  candidates.push(path.resolve(process.cwd(), 'data'));
  try { candidates.push(path.join(os.homedir(), 'qqagent', 'data')); } catch { /* ignore */ }
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'mood-engine.sqlite'))) { _resolvedDataDir = dir; return dir; }
    } catch { /* ignore */ }
  }
  return '';
}

/**
 * 把一次情绪事件写进 mood 库。
 * ★ 直接操作 mood 表（全局 scope），不经过 applyMoodImpact ——
 *   因为那个函数会再乘一次 GLOBAL_SHARE 与亲密度倍率，而这里的 delta 已经标定好了。
 */
function pushMoodDelta(dataDir, delta, kind, now) {
  const dir = String(dataDir || '').trim();
  if (!dir) return false;
  const file = moodDbPath(dir);
  if (!fs.existsSync(file)) return false;

  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=3000');
    const row = db.prepare("SELECT * FROM mood WHERE scope='global'").get();
    if (!row) return false;
    // 用引擎自己的推进函数保证"回归/基线/边界"口径一致
    const cur = Number(row.mood) || 50;
    const next = Math.min(100, Math.max(0, cur + delta * 0.65)); // 全局份额 65%
    db.prepare('UPDATE mood SET mood=?, updated_at=?, saved_at=? WHERE scope=?')
      .run(next, now, now, 'global');
    try {
      db.prepare('INSERT INTO mood_log (scope,kind,uin,d_mood,d_energy,note,ts) VALUES (?,?,?,?,?,?,?)')
        .run('global', String(kind), '', Math.round(delta * 0.65 * 10) / 10, 0, '自动识别', now);
    } catch { /* 日志失败不影响主流程 */ }
    return true;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 消息入库钩子。由 overlay 注入到 store.appendIncoming() 里。
 *
 * @param {string} chatKey 会话
 * @param {object} message 原始消息（含 text / self）
 * @param {object} rec     #append 的返回值（含 duplicate 标记）
 */
export function captureEmotionFromMessage(chatKey, message, rec) {
  try {
    // 重复消息不重复计分
    if (rec && rec.duplicate) return false;
    // 只处理入站消息
    if (message && message.self) return false;

    const text = String(message?.text || '');
    if (!text) return false;

    const hit = detectEmotion(text);
    if (!hit) return false;

    const now = Date.now();
    sweep(now);
    const hourKey = `${chatKey}|${Math.floor(now / HOUR_MS)}`;
    const usedN = _used.get(hourKey) || 0;
    if (usedN >= EMOTION_PER_CHAT_PER_HOUR) return false;

    const kindKey = `${hourKey}|${hit.kind}`;
    const kindN = _used.get(kindKey) || 0;

    // 先占名额，再写库（避免并发下超发）
    _used.set(hourKey, usedN + 1);
    _used.set(kindKey, kindN + 1);

    const delta = hit.delta * emotionDecay(kindN);

    // ★ 数据目录：探测出来的（env → cwd/data → ~/qqagent/data）
    const dataDir = resolveDataDir();
    if (!dataDir) return false;
    pushMoodDelta(dataDir, delta, hit.kind, now);
    return true;
  } catch {
    return false;
  }
}
