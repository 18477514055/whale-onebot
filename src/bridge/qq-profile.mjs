import { ACTIONS, ALIASES, EXPECTED_ACCOUNT, NON_LATCHING_ACTIONS, PROTECTED_ACCOUNT, validateParams } from '../actions.mjs';
import { planQuickOperations, snapshotQuickContext } from '../quick-operations.mjs';

// Small, audited name/ID fallback. No image assets or account data.
const systemFaceNames = {
  4: '得意', 14: '微笑', 22: '白眼', 63: '玫瑰', 66: '爱心', 76: '赞',
  78: '握手', 99: '鼓掌', 118: '抱拳', 182: '笑哭', 212: '托腮', 222: '抱抱',
};
const localActions = Object.freeze({
  fetch_sys_faces: () => ({ packs: [{ emojis: Object.entries(systemFaceNames)
    .map(([q_sid, name]) => ({ q_sid, q_des: '/' + name })) }] }),
});

export const qqOneBot11Profile = Object.freeze({
  actions: ACTIONS,
  aliases: ALIASES,
  nonLatchingActions: NON_LATCHING_ACTIONS,
  localActions,
  validateParams,
  acceptIdentity(proof) {
    if (String(proof.user_id) !== EXPECTED_ACCOUNT) return null;
    return {
      user_id: Number(EXPECTED_ACCOUNT),
      nickname: typeof proof.nickname === 'string' ? proof.nickname : '',
    };
  },
  blocksAction(action, params) {
    if (action === 'set_group_kick_members' && Array.isArray(params.user_id))
      return params.user_id.some(value => (typeof value === 'string' || typeof value === 'number') && String(value) === PROTECTED_ACCOUNT);
    return ACTIONS[action].mutates && String(params.user_id) === PROTECTED_ACCOUNT;
  },
  // Only Core's explicit native-session + original constructor selects this.
  // Ordinary conversations are not account takeover or group administration.
  blocksOriginalConversationAction(action, params) {
    if (['send_private_msg', 'send_group_msg', 'send_msg', 'send_message',
      'send_private_forward_msg', 'send_group_forward_msg', 'send_forward_msg',
      'mark_msg_as_read', 'mark_private_msg_as_read', 'mark_group_msg_as_read', 'set_input_status',
      'friend_poke', 'group_poke'].includes(action)) return false;
    return qqOneBot11Profile.blocksAction(action, params);
  },
  quickOperations: Object.freeze({
    snapshot: snapshotQuickContext,
    plan: planQuickOperations,
  }),
});

const scopedGroupQueries = new Set(['get_group_info', 'get_group_member_info', 'get_group_msg_history']);
const scopedLocalQueries = new Set(['get_status', 'get_login_info', 'get_version_info', 'get_supported_actions',
  'can_send_image', 'can_send_record', ...Object.keys(localActions)]);

export function scopeQQProfileToGroup(group, readOnlyChallengeText) {
  if (!['string', 'number'].includes(typeof group) || !/^[1-9]\d{4,15}$/.test(String(group)) ||
      !Number.isSafeInteger(Number(group))) throw new TypeError('Invalid read-only test group');
  if (readOnlyChallengeText !== undefined && (typeof readOnlyChallengeText !== 'string' ||
      !/^whale-check-[a-f0-9]{32}$/.test(readOnlyChallengeText))) throw new TypeError('Invalid protected test challenge');
  const groupId = String(group);
  let protectedChallengeConsumed = false;
  return {
    ...qqOneBot11Profile,
    allowsAction(action, params) {
      return scopedLocalQueries.has(action) || (scopedGroupQueries.has(action) &&
        (params === undefined || (String(params.group_id) === groupId && String(params.user_id) !== PROTECTED_ACCOUNT)));
    },
    allowsEvent(event) {
      if (event.post_type !== 'message' || event.message_type !== 'group' || String(event.group_id) !== groupId) return false;
      if (String(event.user_id) !== PROTECTED_ACCOUNT) return true;
      if (protectedChallengeConsumed || readOnlyChallengeText === undefined || event.raw_message !== readOnlyChallengeText ||
          !Number.isSafeInteger(event.message_id) || event.message_id < 1 || !Array.isArray(event.message) ||
          event.message.length !== 1 || event.message[0]?.type !== 'text' ||
          event.message[0]?.data?.text !== readOnlyChallengeText) return false;
      protectedChallengeConsumed = true;
      return true;
    },
  };
}
