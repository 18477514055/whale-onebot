// [LOCAL-ONLY] Body/history queries obey the same explicit visibility and
// historical blocklist policy as native prompts. Identity-only metadata is separate.
import { getConfig } from '../core/config.js';
import { memoryVisibilityOf, impressionVisible } from '../core/memory-visibility.js';

export function localSourceVisible(sourceChatKey, currentChatKey, senderId = '', cfg = getConfig()) {
  if (!impressionVisible({ sourceChatKeys: [String(sourceChatKey || '')] }, currentChatKey, memoryVisibilityOf(cfg))) return false;
  const [, group] = /^group:/.test(String(sourceChatKey)) ? String(sourceChatKey).split(':') : [];
  return !group || !(cfg.blocklist?.[group] || []).map(String).includes(String(senderId));
}

export function localHistorySql(chatKey, { alias = '', cfg = getConfig() } = {}) {
  if (alias && !/^[a-z][a-z0-9_]*\.$/i.test(alias)) throw new Error('Invalid SQL alias');
  const key = String(chatKey || '');
  const vis = memoryVisibilityOf(cfg);
  const clauses = [];
  const args = [];
  if (vis.mode === 'perChat') { clauses.push(`${alias}chat_key = ?`); args.push(key); }
  if (vis.hidePrivateInGroup && key.startsWith('group:')) clauses.push(`${alias}chat_key NOT LIKE 'private:%'`);
  for (const [group, raw] of Object.entries(cfg.blocklist || {})) {
    const ids = (Array.isArray(raw) ? raw : []).map(String);
    if (!ids.length) continue;
    clauses.push(`NOT (${alias}chat_key = ? AND ${alias}self = 0 AND ${alias}sender_id IN (${ids.map(() => '?').join(',')}))`);
    args.push(`group:${group}`, ...ids);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
}
