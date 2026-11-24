import { normalizeMessage } from './segments.mjs';
import { BOT_UIN, OWNER_UIN } from './config/account.mjs';
export const EXPECTED_ACCOUNT = BOT_UIN;
export const PROTECTED_ACCOUNT = OWNER_UIN;
const descriptors = {};
function add(names, fields = {}, mutates = false) {
  for (const name of names.split(' ')) descriptors[name] = Object.freeze({fields: Object.freeze(fields), mutates});
}
add('get_login_info get_status get_version_info get_supported_actions');
add('send_private_msg', {user_id:'id', message:'message'}, true);
add('send_group_msg', {group_id:'id', message:'message'}, true);
add('send_msg', {message:'message'}, true);
add('delete_msg', {message_id:'messageId'}, true);
add('get_msg', {message_id:'messageId'});
add('get_forward_msg');
add('get_group_msg_history', {group_id:'id'});
add('get_friend_msg_history', {user_id:'id'});
add('send_like', {user_id:'id'}, true);
add('get_friend_list get_friends_with_category get_group_list get_cookies get_credentials can_send_image can_send_record get_csrf_token');
add('get_stranger_info', {user_id:'id'});
add('get_group_info get_group_detail_info get_group_info_ex get_group_member_list get_group_honor_info', {group_id:'id'});
add('get_group_root_files get_group_files_by_folder get_group_file_system_info', {group_id:'id'});
add('create_group_file_folder delete_group_folder', {group_id:'id'}, true);
add('delete_group_file move_group_file', {group_id:'id', file_id:'string'}, true);
add('get_group_at_all_remain get_group_shut_list', {group_id:'id'});
add('get_group_share_link', {group_id:'id'});
add('get_group_member_info', {group_id:'id', user_id:'id'});
add('set_group_kick set_group_ban set_group_admin set_group_card set_group_special_title', {group_id:'id', user_id:'id'}, true);
add('set_group_kick_members', {group_id:'id'}, true);
add('set_group_name', {group_id:'id', group_name:'string'}, true);
add('set_group_remark', {group_id:'id'}, true);
// 置顶＝群会话置顶（内核 group.setTop(groupCode, isTop)）。默认 enable:true。
add('set_group_top', {group_id:'id'}, true);
// 私聊（好友）会话置顶：两个内核候选都试，返回实际生效的那条。
add('set_friend_top', {user_id:'id'}, true);
add('set_friend_remark', {user_id:'id'}, true);
add('set_group_whole_ban set_group_leave', {group_id:'id'}, true);
add('set_group_anonymous', {group_id:'id'}, true);
add('set_group_anonymous_ban', {group_id:'id'}, true);
add('set_friend_add_request', {flag:'string'}, true);
add('set_group_add_request', {flag:'string', sub_type:'string'}, true);
add('get_record get_image', {file:'string'});
add('get_file', {message_id:'messageId', file_id:'string'});
add('set_restart clean_cache', {}, true);
// Extensions requested by the existing QQ-Agent consumer; registration is not implementation.
add('send_group_forward_msg', {group_id:'id', messages:'nodes'}, true);
add('send_private_forward_msg', {user_id:'id', messages:'nodes'}, true);
add('send_forward_msg', {messages:'nodes'}, true);
add('upload_group_file send_group_file', {group_id:'id', file:'string', name:'string'}, true);
add('upload_private_file send_private_file', {user_id:'id', file:'string', name:'string'}, true);
add('mark_msg_as_read mark_group_msg_as_read mark_private_msg_as_read', {}, true);
add('set_msg_emoji_like', {message_id:'messageId'}, true);
add('get_message_images get_message_audio', {message_id:'messageId'});
// 视频落地（2026-11-23）：QQ 的视频地址带 rkey 会过期，运行端要抽帧就得有本地文件。
// 返回的是协议端在本机落盘的绝对路径（两端同一个容器文件系统）。
add('get_message_videos', {message_id:'messageId'});
add('get_msg_emoji_likes', {message_id:'messageId'});
add('fetch_emoji_like', {message_id:'messageId'});
add('get_emoji_likes');
add('fetch_ptt_text', {message_id:'messageId'});
add('set_qq_profile', {}, true);
add('set_self_longnick', {}, true);
add('set_qq_avatar', {file:'string'}, true);
add('set_input_status', {user_id:'id'}, true);
add('translate_en2zh');
add('get_robot_uin_range');
add('get_recent_contact');
add('get_profile_like');
add('fetch_custom_face');
add('add_custom_face', {file:'string'}, true);
add('set_online_status', {}, true);
add('fetch_sys_faces');
add('get_ai_characters', {group_id:'id'});
add('send_group_ai_record', {group_id:'id', text:'string', character:'string'}, true);
add('send_qq_voice send_face', {}, true);
add('group_poke', {group_id:'id', user_id:'id'}, true);
// P0/P1 新增（2026-11-18）。★ 必须先在这里声明，否则 core 会以 1404 拒绝调用
// （core 的 dispatch 只认 ACTIONS 注册表里的名字，能力门只是第二道）。
add('can_send_image can_send_record get_version_info');
add('set_essence_msg del_essence_msg', {group_id:'id', message_id:'messageId'}, true);
add('forward_friend_single_msg', {user_id:'id', message_id:'messageId'}, true);
add('forward_group_single_msg', {group_id:'id', message_id:'messageId'}, true);
// 内部诊断：只返回内核方法名列表，无副作用、无账号数据；用于决定哪些动作在本机 QQ build 可实现。
add('debug_native_surface');
// 内部诊断（2026-11-23）：历史读取到底卡在哪一步。绕开 wait() 的归一化错误，
// 直接 await 内核 Promise 并报耗时/错误名/返回外形。只读、无副作用。
add('debug_history_probe', {group_id:'id'});
// 内部诊断（2026-11-23）：合并转发读不出来时，逐个试内核方法看该用哪条。只读、无副作用。
add('debug_forward_probe', {group_id:'id', message_id:'messageId'});
// 我们自己的扩展（2026-11-18）：机器人「见过」的会话清单（真的收到过消息的群/私聊）。
// 手机面板用它做白名单勾选 —— 本机 get_group_list 只能回 1502（原生回调永不触发）。
add('get_known_chats');
// 群名补充（2026-11-19）：白名单候选只有群号，面板拿群号再问一次群名。
// 只读；读法与 get_group_info 相同（getGroupDetailInfo 回调），失败项只进 failed。
add('get_chat_names');
// P0/P1 第二批（2026-11-18）：本机 QQ build 上真实存在的内核方法（见 debug_native_surface 实测）
add('get_group_notice', {group_id:'id'});
add('del_group_notice', {group_id:'id', notice_id:'string'}, true);
// 群公告写（2026-11-23 补齐）：内核 publishGroupBulletin 需要 qun.qq.com 的 pskey，
// 现在能从 tipOff.getPskey 取到（真机 debug_native_surface 实证）。image 只收本地绝对路径。
add('send_group_notice', {group_id:'id', content:'string'}, true);
add('get_group_system_msg', {count:'number'});
add('get_doubt_friends_add_request', {count:'number'});
add('friend_poke', {user_id:'id'}, true);
export const ACTIONS = Object.freeze(descriptors);
export const ALIASES = Object.freeze({send_message:'send_msg'});
// Light social / cosmetic writes whose native confirmation is documented as
// unreliable (`sendNudge` returns Promise<unknown>; the emoji, avatar and
// presence setters are idempotent and the App already falls back locally).
// They remain mutating for read-only, protected-account and pacing checks, but
// MUST NOT poison the global outcome latch: repeating them is harmless, while
// latching on an unconfirmable cosmetic write would freeze every later send.
export const NON_LATCHING_ACTIONS = Object.freeze(new Set([
  'group_poke', 'friend_poke', 'set_online_status', 'add_custom_face', 'set_qq_avatar',
]));

export function isGroupFileId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value !== '/' &&
    !/[\x00-\x20\x7f\\]/.test(value);
}

export function isGroupFolderId(value) {
  return typeof value === 'string' && value.length <= 256 && /^\/?[A-Za-z0-9_-]+$/.test(value);
}
// History is a bounded extension. Sequence numbers remain exact decimal strings;
// they are not OneBot message IDs or native message IDs.
export function normalizeGroupHistoryParams(input) {
  return normalizeHistoryParams(input, 'group_id');
}
export function normalizeHistoryParams(input, peerField) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('History parameters must be an object');
  if (Object.keys(input).some(key => ![peerField, 'count', 'message_seq'].includes(key))) throw new TypeError('Unsupported history parameter or uncalibrated direction flag');
  const peer = input[peerField];
  if (!['string', 'number'].includes(typeof peer) || !/^[1-9]\d{0,15}$/.test(String(peer)) || !Number.isSafeInteger(Number(peer))) throw new TypeError('Invalid history peer');
  const count = input.count === undefined ? 20 : input.count;
  if (!['string', 'number'].includes(typeof count) || !/^[1-9]\d{0,2}$/.test(String(count)) || Number(count) > 100) throw new TypeError('History count must be 1 through 100');
  const result = { [peerField]: Number(peer), count: Number(count) };
  if (input.message_seq !== undefined) {
    const seq = input.message_seq;
    if (!['string', 'number'].includes(typeof seq) || (typeof seq === 'number' && !Number.isSafeInteger(seq)) || !/^[1-9]\d{0,18}$/.test(String(seq)) || BigInt(seq) > 9223372036854775807n) throw new TypeError('History message_seq must be an exact positive int64');
    result.message_seq = String(seq);
  }
  return result;
}
export function validateParams(action, input) {
  if (input === undefined) input = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('params must be an object');
  const params = structuredClone(input);
  if (action === 'get_group_msg_history') return normalizeGroupHistoryParams(params);
  if (action === 'get_friend_msg_history') return normalizeHistoryParams(params, 'user_id');
  for (const field of ['__proto__', 'prototype', 'constructor']) if (Object.hasOwn(params,field)) throw new TypeError('Invalid parameter');
  if (action === 'fetch_sys_faces' && Object.keys(params).length) throw new TypeError('System face catalog takes no parameters');
  if (action === 'set_msg_emoji_like') {
    const { message_id, emoji_id, set = true } = params;
    if (Object.keys(params).some(key => !['message_id', 'emoji_id', 'set'].includes(key)) ||
        !['string', 'number'].includes(typeof message_id) || !/^[1-9]\d{0,9}$/.test(String(message_id)) ||
        Number(message_id) > 2147483647 || !['string', 'number'].includes(typeof emoji_id) ||
        !/^[1-9]\d{0,15}$/.test(String(emoji_id)) || !Number.isSafeInteger(Number(emoji_id)) ||
        ![true, false, 'true', 'false'].includes(set)) throw new TypeError('Invalid message reaction');
    return { message_id: Number(message_id), emoji_id: String(emoji_id), set: set === true || set === 'true' };
  }
  if (action === 'get_emoji_likes') {
    const { message_id, group_id, emoji_id, emoji_type, count = 0 } = params;
    const decimal = value => typeof value === 'string' || Number.isSafeInteger(value);
    if (Object.keys(params).some(key => !['message_id', 'group_id', 'emoji_id', 'emoji_type', 'count'].includes(key)) ||
        !decimal(message_id) || !/^[1-9]\d{0,127}$/.test(String(message_id)) ||
        (group_id !== undefined && (!decimal(group_id) || !/^[1-9]\d{0,15}$/.test(String(group_id)) ||
          !Number.isSafeInteger(Number(group_id)))) ||
        !decimal(emoji_id) || !/^(0|[1-9]\d{0,15})$/.test(String(emoji_id)) || !Number.isSafeInteger(Number(emoji_id)) ||
        (emoji_type !== undefined && ![1, 2, '1', '2'].includes(emoji_type)) ||
        !decimal(count) || !/^(0|[1-9]\d{0,3})$/.test(String(count)) || Number(count) > 3000)
      throw new TypeError('Invalid emoji like query');
    const emoji = String(emoji_id);
    return { message_id: String(message_id), group_id: group_id === undefined ? undefined : String(group_id),
      emoji_id: emoji, emoji_type: String(emoji_type ?? (emoji.length > 3 ? 2 : 1)), count: Number(count) };
  }
  if (action === 'send_like') {
    const times = Object.hasOwn(params, 'times') ? params.times : 1;
    if (Object.keys(params).some(key => !['user_id', 'times'].includes(key)) ||
        !['number', 'string'].includes(typeof params.user_id) || !['number', 'string'].includes(typeof times) ||
        !/^(?:[1-9]|10)$/.test(String(times))) throw new TypeError('Expected one friend and a like count from 1 through 10');
    params.times = Number(times);
  }
  if (action === 'set_qq_profile') {
    // 资料写入补全（2026-11-23）：内核 modifyDesktopMiniProfile 本来就收生日，
    // 以前只放行 nickname/personal_note/sex —— 生日只能读、不能写。
    // 三个生日字段必须**一起**给：只给年或只给月，原生会把缺的那几项写成 0，
    // 读回来就表现为「我把它改坏了」。
    const { nickname, personal_note, sex } = params;
    const birthdayKeys = ['birthday_year', 'birthday_month', 'birthday_day'];
    const birthday = birthdayKeys.filter(key => Object.hasOwn(params, key));
    if (!Object.keys(params).length ||
        Object.keys(params).some(key => !['nickname', 'personal_note', 'sex', ...birthdayKeys].includes(key)) ||
        (Object.hasOwn(params, 'nickname') && (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 128)) ||
        (Object.hasOwn(params, 'personal_note') && (typeof personal_note !== 'string' || personal_note.length > 256)) ||
        (Object.hasOwn(params, 'sex') && ![0, 1, 2, '0', '1', '2'].includes(sex)))
      throw new TypeError('Expected one or more supported self profile fields');
    if (birthday.length && birthday.length !== 3)
      throw new TypeError('birthday_year, birthday_month and birthday_day must be given together');
    if (sex !== undefined) params.sex = Number(sex);
    for (const [index, key] of birthdayKeys.entries()) {
      if (!Object.hasOwn(params, key)) continue;
      const limit = [9999, 12, 31][index];
      const value = params[key];
      if (!['number', 'string'].includes(typeof value) || !/^\d{1,4}$/.test(String(value)) ||
          Number(value) > limit)
        throw new TypeError(`Invalid ${key}`);
      params[key] = Number(value);
    }
    return params;
  }
  if (action === 'set_friend_add_request' && (Object.keys(params).some(key => !['flag', 'approve', 'remark'].includes(key)) ||
      typeof params.flag !== 'string' || !params.flag || params.flag.length > 500 ||
      (params.remark !== undefined && (typeof params.remark !== 'string' || params.remark.length > 60 ||
        /[\x00-\x1f\x7f]/.test(params.remark) || (params.remark !== '' && [false, 'false'].includes(params.approve))))))
    throw new TypeError('Invalid friend request decision');
  if (action === 'get_group_share_link') {
    const { need_short_url = true, src_id = 73, additional_param = '' } = params;
    if (Object.keys(params).some(key => !['group_id', 'need_short_url', 'src_id', 'additional_param'].includes(key)) ||
        ![true, false, 'true', 'false'].includes(need_short_url) ||
        !['number', 'string'].includes(typeof src_id) || !/^(0|[1-9]\d{0,9})$/.test(String(src_id)) ||
        Number(src_id) > 2147483647 || typeof additional_param !== 'string' ||
        Buffer.byteLength(additional_param) > 2048 || /[\x00-\x1f\x7f]/.test(additional_param))
      throw new TypeError('Invalid group share link parameters');
    params.need_short_url = need_short_url === true || need_short_url === 'true';
    params.src_id = Number(src_id);
    params.additional_param = additional_param;
  }
  if (action === 'create_group_file_folder') {
    const { group_id, folder_name, name } = params;
    const label = folder_name ?? name;
    if (Object.keys(params).some(key => !['group_id', 'folder_name', 'name'].includes(key)) ||
        !['string', 'number'].includes(typeof group_id) ||
        (Object.hasOwn(params, 'folder_name') && Object.hasOwn(params, 'name') && folder_name !== name) ||
        typeof label !== 'string' || label.trim() !== label || !label || label === '.' || label === '..' ||
        Buffer.byteLength(label) > 255 || /[\x00-\x1f\x7f/\\]/.test(label))
      throw new TypeError('Expected one bounded group folder name');
    params.folder_name = label;
    delete params.name;
  }
  if (action === 'get_group_files_by_folder' || action === 'delete_group_folder') {
    const { group_id, folder, folder_id, file_count, start_index } = params;
    const folderId = folder ?? folder_id;
    const deleting = action === 'delete_group_folder';
    const allowed = deleting ? ['group_id', 'folder', 'folder_id'] : ['group_id', 'folder', 'folder_id', 'file_count', 'start_index'];
    if (Object.keys(params).some(key => !allowed.includes(key)) ||
        (Object.hasOwn(params, 'folder') && Object.hasOwn(params, 'folder_id') && folder !== folder_id) ||
        typeof folderId !== 'string' || !folderId.length || folderId.length > 256 ||
        /[\x00-\x20\x7f\\]/.test(folderId) ||
        (deleting && (!isGroupFolderId(folderId) || !['string', 'number'].includes(typeof group_id))))
      throw new TypeError('Expected one explicit group folder ID');
    if (!deleting)
      return { ...validateParams('get_group_root_files', { group_id, file_count, start_index }), folder_id: folderId };
    params.folder_id = folderId;
    delete params.folder;
  }
  if (action === 'get_group_root_files' && params.start_index !== undefined) {
    const index = params.start_index;
    if (!['string', 'number'].includes(typeof index) || !/^(0|[1-9]\d{0,9})$/.test(String(index)) ||
        Number(index) > 2147483647) throw new TypeError('Invalid group file start_index');
    params.start_index = Number(index);
  }
  if (action === 'delete_group_file' || action === 'move_group_file') {
    const { group_id, file_id, bus_id, busid, current_parent_directory, target_parent_directory } = params;
    const allowed = ['group_id', 'file_id', 'bus_id', 'busid'];
    if (action === 'move_group_file') {
      allowed.push('current_parent_directory', 'target_parent_directory');
      if (current_parent_directory === target_parent_directory ||
          ![current_parent_directory, target_parent_directory].every(value => value === '/' || isGroupFolderId(value)))
        throw new TypeError('Expected two distinct group directory IDs');
    }
    if (Object.keys(params).some(key => !allowed.includes(key)) ||
        !['string', 'number'].includes(typeof group_id) || !isGroupFileId(file_id))
      throw new TypeError('Expected one explicit group file ID');
    const businessIds = [bus_id, busid].filter(value => value !== undefined);
    if (businessIds.some(value => !['string', 'number'].includes(typeof value) ||
        !/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > 0xffffffff) ||
        (businessIds.length === 2 && Number(bus_id) !== Number(busid)))
      throw new TypeError('Invalid group file business ID');
    if (businessIds.length) params.bus_id = Number(businessIds[0]);
    delete params.busid;
  }
  if (action === 'get_chat_names') {
    // 只收字符串群号（不接受数字：调用方传错了要立刻知道，而不是被悄悄转成字符串）。
    const { groups } = params;
    if (Object.keys(params).length !== 1 || !Array.isArray(groups) || groups.length > 50)
      throw new TypeError('Expected 0 to 50 group codes');
    const out = [];
    const seen = new Set();
    for (const code of groups) {
      if (typeof code !== 'string' || !/^\d{5,15}$/.test(code) || seen.has(code))
        throw new TypeError('Expected group codes as 5 to 15 digit strings');
      seen.add(code);
      out.push(code);
    }
    return { groups: out };
  }
  if (action === 'fetch_custom_face') {
    const count = params.count === undefined ? 48 : params.count;
    if (Object.keys(params).some(key => key !== 'count') ||
        !['number', 'string'].includes(typeof count) ||
        !/^[1-9]\d{0,2}$/.test(String(count)) || Number(count) > 500)
      throw new TypeError('Expected a face count from 1 through 500');
    return { count: Number(count) };
  }
  if (action === 'translate_en2zh') {
    const { words } = params;
    if (Object.keys(params).length !== 1 || !Array.isArray(words) || words.length < 1 || words.length > 32)
      throw new TypeError('Expected a bounded list of words');
    for (const word of words)
      if (typeof word !== 'string' || !word.trim() || Buffer.byteLength(word) > 4096)
        throw new TypeError('Invalid translation input');
    return { words };
  }
  if (action === 'get_robot_uin_range' && Object.keys(params).length !== 0)
    throw new TypeError('Robot UIN range query takes no parameters');
  if (action === 'get_recent_contact') {
    const count = Object.hasOwn(params, 'count') ? params.count : 10;
    if (Object.keys(params).some(key => key !== 'count') || !['number', 'string'].includes(typeof count) ||
        !/^[1-9]\d?$/.test(String(count)) || Number(count) > 50) throw new TypeError('Expected 1 to 50 recent contacts');
    params.count = Number(count);
  }
  if (action === 'get_profile_like') {
    const { user_id, start = 0, count = 10 } = params;
    if (Object.keys(params).some(key => !['user_id', 'start', 'count'].includes(key)) ||
        (user_id !== undefined && (!['number', 'string'].includes(typeof user_id) ||
          !/^[1-9]\d{0,15}$/.test(String(user_id)) || !Number.isSafeInteger(Number(user_id)))) ||
        !['number', 'string'].includes(typeof start) || !/^(?:0|[1-9]\d{0,5})$/.test(String(start)) ||
        !['number', 'string'].includes(typeof count) || !/^[1-9]\d?$/.test(String(count)) || Number(count) > 50)
      throw new TypeError('Invalid profile like query');
    return { start: Number(start), count: Number(count), ...(user_id !== undefined && { user_id: String(user_id) }) };
  }
  if (['mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read'].includes(action)) {
    const keys = Object.keys(params);
    const [target] = keys;
    if (keys.length !== 1 || !['message_id', 'group_id', 'user_id'].includes(target) ||
        (action === 'mark_group_msg_as_read' && target === 'user_id') ||
        (action === 'mark_private_msg_as_read' && target === 'group_id') ||
        !['string', 'number'].includes(typeof params[target]) ||
        !/^[1-9]\d{0,15}$/.test(String(params[target])) || !Number.isSafeInteger(Number(params[target])) ||
        (target === 'message_id' && Number(params[target]) > 2147483647))
      throw new TypeError('Expected one read target');
    return { [target]: Number(params[target]) };
  }
  if (action === 'set_self_longnick') {
    const keys = Object.keys(params);
    if (keys.length !== 1 || !['long_nick', 'longNick'].includes(keys[0]) ||
        typeof params[keys[0]] !== 'string' || params[keys[0]].length > 256)
      throw new TypeError('Expected one bounded signature field');
    return { long_nick: params[keys[0]] };
  }
  if (['set_group_remark', 'set_friend_remark'].includes(action) &&
      (typeof params.remark !== 'string' || params.remark.length > 256))
    throw new TypeError('Invalid remark');
  if (action === 'get_record') {
    // OneBot 的 get_record {file} 语义是「把这个语音落成本地文件」。
    // 本机运行环境里语音的唯一可靠来源是原生消息元素：要么按 message_id 指一条
    // 收过的语音，要么按 file（= pttElement.fileName，也就是 segment.data.file）
    // 在本会话索引里回溯那条消息。两者必须给一个，且只认 silk——本运行端没有
    // 转码器，谎报 mp3 比明确拒绝更糟。
    const keys = Object.keys(params);
    if (keys.some(key => !['file', 'message_id', 'out_format'].includes(key)))
      throw new TypeError('Expected a record file name or message ID');
    const { file, message_id, out_format = 'silk' } = params;
    if (file === undefined && message_id === undefined)
      throw new TypeError('Expected a record file name or message ID');
    if (file !== undefined && (typeof file !== 'string' || !file || file.length > 4096))
      throw new TypeError('Invalid record file name');
    if (message_id !== undefined && (!['string', 'number'].includes(typeof message_id) ||
        !/^[1-9]\d{0,9}$/.test(String(message_id)) || Number(message_id) > 2147483647))
      throw new TypeError('Invalid record message ID');
    if (out_format !== 'silk')
      throw new TypeError('Only the native silk format is available; audio transcoding is not supported');
    return {
      out_format: 'silk',
      ...(file !== undefined && { file }),
      ...(message_id !== undefined && { message_id: Number(message_id) }),
    };
  }
  if (action === 'send_group_notice') {
    const keys = Object.keys(params);
    if (keys.some(key => !['group_id', 'content', 'image', 'pinned'].includes(key)))
      throw new TypeError('Expected group_id, content and optional image/pinned');
    const content = typeof params.content === 'string' ? params.content.trim() : '';
    if (!content || content.length > 2000) throw new TypeError('Group notice content must be 1 to 2000 characters');
    if (params.image !== undefined &&
        (typeof params.image !== 'string' || !params.image || params.image.length > 4096))
      throw new TypeError('Invalid notice image path');
    return {
      group_id: params.group_id,
      content,
      ...(params.image !== undefined && { image: params.image }),
      pinned: params.pinned === true || params.pinned === 'true',
    };
  }
  if (action === 'get_forward_msg') {
    const hasId = Object.hasOwn(params, 'id');
    const hasMessage = Object.hasOwn(params, 'message_id');
    if (hasId === hasMessage) throw new TypeError('Expected exactly one forward reference');
    if (hasId && (typeof params.id !== 'string' || !params.id || params.id.length > 4096))
      throw new TypeError('Invalid forward ID');
    if (hasMessage && (!['number', 'string'].includes(typeof params.message_id) ||
        !/^[1-9]\d{0,9}$/.test(String(params.message_id)) || Number(params.message_id) > 2147483647))
      throw new TypeError('Invalid outer message ID');
  }
  for (const [key, kind] of Object.entries(ACTIONS[action].fields)) {
    const value = params[key];
    if (kind === 'id') {
      if (!/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new TypeError(`Invalid ${key}`);
      params[key] = Number(value);
    } else if (kind === 'messageId') {
      if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new TypeError(`Invalid ${key}`);
      params[key] = Number(value);
    } else if (kind === 'string') {
      if (typeof value !== 'string' || !value || value.length > 32768) throw new TypeError(`Invalid ${key}`);
    } else if (kind === 'message') {
      const autoEscape = params.auto_escape === true || params.auto_escape === 'true';
      params[key] = normalizeMessage(value, autoEscape);
      if (params[key].length === 0) throw new TypeError('Empty message');
    } else if (kind === 'nodes') {
      params[key] = normalizeMessage(value);
      if (!params[key].length || params[key].some(x => x.type !== 'node')) throw new TypeError('Expected forward nodes');
    }
  }
  for (const key of ['enable','approve','reject_add_request','is_dismiss','no_cache','auto_escape']) if (key in params) {
    if (![true,false,'true','false'].includes(params[key])) throw new TypeError(`Invalid ${key}`);
    params[key] = params[key] === true || params[key] === 'true';
  }
  if ('duration' in params) {
    if (!/^\d+$/.test(String(params.duration)) || Number(params.duration)>2592000) throw new TypeError('Invalid duration');
    params.duration = Number(params.duration);
  }
  if (['set_group_ban','set_group_anonymous_ban'].includes(action)) params.duration ??= 1800;
  if (['set_group_admin','set_group_whole_ban','set_group_anonymous','set_group_top','set_friend_top'].includes(action)) params.enable ??= true;
  if (['set_friend_add_request','set_group_add_request'].includes(action)) params.approve ??= true;
  if (action === 'send_msg') {
    const kind = params.message_type ?? (params.group_id ? 'group' : 'private');
    if (!['group','private'].includes(kind)) throw new TypeError('Invalid message_type');
    const key = kind === 'group' ? 'group_id':'user_id';
    if (!/^[1-9]\d{0,15}$/.test(String(params[key])) || !Number.isSafeInteger(Number(params[key]))) throw new TypeError(`Invalid ${key}`);
    params[key] = Number(params[key]); params.message_type = kind;
  }
  return params;
}
