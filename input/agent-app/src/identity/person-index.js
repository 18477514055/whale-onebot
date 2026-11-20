// [LOCAL-ONLY] ============================================================
// ★ 这个文件是我们自己加的，**作者原仓库从来没有过**（已用 git log origin/HEAD 核实）。
//   · 升级作者版本时它会被覆盖/删除，**必须从备份或私有仓库重新拷贝**。
// Distribution source.
// Distribution source.
// [LOCAL-ONLY] ============================================================
// 跨群身份认知：让机器人**按 QQ 号**认出"不同群里的同一个人"。
//
// ── 为什么要单独一个模块，而不是塞进 memory ──────────────────────────────
// 因为这里要守住一条线：**只给身份，不给内容**。
//
// 人物长期记忆（memory/people/*.json）里存的是"对这个人的印象"，那是内容；
// 一旦注入到另一个群的提示词里，A 群聊过什么就漏到 B 群了 —— 正是用户明确不要的。
// 所以这里的每一个字都来自**消息存档里的元数据**（谁、在哪个会话、那边叫什么、多少条），
// 不取任何消息正文。数据上根本不存在可泄漏的内容，而不是靠提示词叮嘱模型别说。
//
// 数据来源：store.personChatIndex()（见 store.js），零新增采集。
import { getConfig } from '../core/config.js';

/** 会话标识 → 给模型看的说法（**故意的**：不给出那个群的名字/群号） */
function describeChat(chatKey) {
  const m = /^(group|private):/.exec(String(chatKey || ''));
  if (!m) return '别处';
  return m[1] === 'private' ? '一个私聊' : '另一个群';
}

/**
 * 给"本次相关群友里跨会话出现过的人"生成一段提示词。
 *
 * @param store    ChatStore（需要 personChatIndex）
 * @param chatKey  当前会话
 * @param userIds  本次提示词里真正会出现的群友 QQ（与【记忆】用同一批，避免提到看不见的人）
 * @param notes    config.memberNotes：用户手工备注名优先
 * @returns 提示词片段；没有任何跨会话的人时返回 ''
 */
export function buildCrossChatIdentityContext(store, {
  chatKey = '',
  userIds = [],
  notes = {},
  maxPeople = 6,
  showOtherNames = true
} = {}) {
  const cfg = getConfig();
  const opt = cfg?.memory?.crossChatIdentity || {};
  if (opt.enabled === false) return '';
  const limit = Math.min(20, Math.max(1, Number(maxPeople) || Number(opt.maxPeople) || 6));
  const wantNames = showOtherNames !== false && opt.showOtherNames !== false;
  if (!store || typeof store.personChatIndex !== 'function') return '';

  const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
    .map((x) => String(x ?? '').trim()).filter((x) => /^\d{5,15}$/.test(x)))];
  if (!ids.length) return '';

  let index;
  try { index = store.personChatIndex(ids); } catch { return ''; }
  // v0.9.13's native store returns a keyed object; the historical adapter
  // returned Map. Keep both contracts without replacing native store methods.
  if (!index || typeof index !== 'object') return '';
  const lines = [];
  for (const userId of ids) {
    const value = index instanceof Map ? index.get(userId) : index[userId];
    const chats = Array.isArray(value) ? value : [];
    // 只在"这个人在**别的**会话也出现过"时才有意义
    const others = chats.filter((c) => c.chatKey && c.chatKey !== chatKey);
    if (!chats.length || !others.length) continue;

    const here = chats.find((c) => c.chatKey === chatKey) || null;
    const display = String(notes[userId] || here?.name || chats[0]?.name || userId);
    const places = [...new Set(others.map((c) => describeChat(c.chatKey)))];
    const alias = wantNames
      ? [...new Set(others.map((c) => String(c.name || '').trim()).filter((n) => n && n !== display))]
      : [];

    let line = `- ${display}（QQ ${userId}）：你在 ${places.join('、')} 也见过同一个人`;
    if (alias.length) line += `，那边叫「${alias.slice(0, 3).join('」「')}」`;
    line += '。';
    lines.push(line);
    if (lines.length >= limit) break;
  }
  if (!lines.length) return '';

  return [
    '【跨群认得的人】',
    ...lines,
    '用法：这只说明"不同群里的这些 ID 是同一个人"，让你认得他。',
    '⚠️ 不要提他在别处说过什么，也不要说"我在别的群见过你"——别的群的聊天内容对你在这里没有意义，',
    '   除非他自己在这里主动提起。'
  ].join('\n');
}
