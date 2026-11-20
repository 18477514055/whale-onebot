// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**。
//   · 升级作者版本时它会被覆盖/删除，必须从备份或私有仓库重新拷贝。
// [LOCAL-ONLY] ============================================================
// 打分闸门的小状态库（2026-10-29）
//
// 只存一张表：每个群「上次在什么时候提示过模型打分」+「提示时看到哪条消息」。
//
// ★ 为什么单独一个 sqlite 而不是塞进 config.json：
//   config.json 每次更新都要整份落盘（还带冲突备份），
//   而这个是**高频改动的小状态**（一天几次），塞进去会污染配置文件、也会频繁触发写盘。
//
// ★ 为什么不用内存 Map：
//   电脑不常开，重启后内存清空 ⇒ 会"以为从来没提示过"，开机就立刻提示一次。
//   用户明确说"不要经常打分"，所以这个状态必须持久化。

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB_NAME = 'intimacy-gate.sqlite';

export class DataStore {
  constructor(dataDir) {
    this.dataDir = String(dataDir || '');
    this.file = this.dataDir ? path.join(this.dataDir, DB_NAME) : '';
    this.db = null;
  }

  #open() {
    if (this.db) return this.db;
    if (!this.file) throw new Error('打分闸门库路径未配置（缺少 dataDir）');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS gate (
        chat_key        TEXT PRIMARY KEY,
        last_prompt_at  INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        profile         TEXT NOT NULL DEFAULT '',
        prompts         INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db = db;
    return db;
  }

  get(chatKey) {
    const key = String(chatKey || '');
    if (!key) return null;
    try {
      const r = this.#open().prepare(
        'SELECT chat_key AS chatKey, last_prompt_at AS lastPromptAt, last_message_id AS lastMessageId, profile, prompts, updated_at AS updatedAt FROM gate WHERE chat_key = ?'
      ).get(key);
      return r ? {
        chatKey: String(r.chatKey),
        lastPromptAt: Number(r.lastPromptAt) || 0,
        lastMessageId: Number(r.lastMessageId) || 0,
        profile: String(r.profile || ''),
        prompts: Number(r.prompts) || 0,
        updatedAt: Number(r.updatedAt) || 0
      } : null;
    } catch {
      return null;
    }
  }

  set(chatKey, { lastPromptAt = Date.now(), lastMessageId = 0, profile = '' } = {}) {
    const key = String(chatKey || '');
    if (!key) return false;
    try {
      this.#open().prepare(`
        INSERT INTO gate (chat_key, last_prompt_at, last_message_id, profile, prompts, updated_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(chat_key) DO UPDATE SET
          last_prompt_at = excluded.last_prompt_at,
          last_message_id = excluded.last_message_id,
          profile = excluded.profile,
          prompts = gate.prompts + 1,
          updated_at = excluded.updated_at
      `).run(key, Number(lastPromptAt) || Date.now(), Number(lastMessageId) || 0, String(profile || ''), Date.now());
      return true;
    } catch {
      return false;
    }
  }

  all() {
    try {
      return this.#open().prepare(
        'SELECT chat_key AS chatKey, last_prompt_at AS lastPromptAt, last_message_id AS lastMessageId, profile, prompts FROM gate ORDER BY last_prompt_at DESC'
      ).all().map((r) => ({
        chatKey: String(r.chatKey),
        lastPromptAt: Number(r.lastPromptAt) || 0,
        lastMessageId: Number(r.lastMessageId) || 0,
        profile: String(r.profile || ''),
        prompts: Number(r.prompts) || 0
      }));
    } catch {
      return [];
    }
  }

  remove(chatKey) {
    try {
      this.#open().prepare('DELETE FROM gate WHERE chat_key = ?').run(String(chatKey || ''));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
  }
}
