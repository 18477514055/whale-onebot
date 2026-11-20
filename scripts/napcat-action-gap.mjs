import fs from 'node:fs';
const ours = new Set(JSON.parse(fs.readFileSync('.tmp/ours.json', 'utf8')));
const ev = JSON.parse(fs.readFileSync('evidence/napcat-hook-dependency.json', 'utf8'));
const snake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();
// 手工归并：NapCat 的 ActionName 与我们命名差异较大的直接映射
const map = {
  SendMsg: 'send_msg', SendPrivateMsg: 'send_private_msg', SendGroupMsg: 'send_group_msg',
  DeleteMsg: 'delete_msg', GetMsg: 'get_msg', GetForwardMsg: 'get_forward_msg',
  GetGroupMsgHistory: 'get_group_msg_history', GetFriendMsgHistory: 'get_friend_msg_history',
  GetGroupList: 'get_group_list', GetGroupInfo: 'get_group_info', GetGroupMemberList: 'get_group_member_list',
  GetGroupMemberInfo: 'get_group_member_info', GetFriendList: 'get_friend_list', GetStrangerInfo: 'get_stranger_info',
  SetGroupBan: 'set_group_ban', SetGroupWholeBan: 'set_group_whole_ban', SetGroupKick: 'set_group_kick',
  SetGroupKickMembers: 'set_group_kick_members', SetGroupAdmin: 'set_group_admin', SetGroupCard: 'set_group_card',
  SetGroupName: 'set_group_name', SetGroupLeave: 'set_group_leave', SetGroupAddRequest: 'set_group_add_request',
  SetFriendAddRequest: 'set_friend_add_request', SetFriendRemark: 'set_friend_remark', SetMsgEmojiLike: 'set_msg_emoji_like',
  GetEmojiLikes: 'get_emoji_likes', FetchEmojiLike: 'fetch_emoji_like', GetRecentContact: 'get_recent_contact',
  GetProfileLike: 'get_profile_like', FetchCustomFace: 'fetch_custom_face', AddCustomFace: 'add_custom_face',
  SetQQAvatar: 'set_qq_avatar', SetInputStatus: 'set_input_status', GetGroupHonorInfo: 'get_group_honor_info',
  GetGroupDetailInfo: 'get_group_detail_info', GetGroupInfoEx: 'get_group_info_ex', GetGroupShutList: 'get_group_shut_list',
  GetGroupFileSystemInfo: 'get_group_file_system_info', GetGroupRootFiles: 'get_group_root_files',
  GetGroupFilesByFolder: 'get_group_files_by_folder', CreateGroupFileFolder: 'create_group_file_folder',
  DeleteGroupFile: 'delete_group_file', DeleteGroupFileFolder: 'delete_group_folder', MoveGroupFile: 'move_group_file',
  GetImage: 'get_image', GetFile: 'get_file', GetRecord: 'get_message_audio', FetchPttText: 'fetch_ptt_text',
  GetGroupAtAllRemain: 'get_group_at_all_remain', GetGroupShareLink: 'get_group_share_link',
  MarkMsgAsRead: 'mark_msg_as_read', MarkGroupMsgAsRead: 'mark_group_msg_as_read',
  MarkPrivateMsgAsRead: 'mark_private_msg_as_read', GetRobotUinRange: 'get_robot_uin_range',
  GetAiCharacters: 'get_ai_characters', SendGroupAiRecord: 'send_group_ai_record',
  SendForwardMsg: 'send_forward_msg', SendGroupForwardMsg: 'send_group_forward_msg',
  SendPrivateForwardMsg: 'send_private_forward_msg', SendLike: 'send_like', SetQQProfile: 'set_qq_profile',
  SetLongNick: 'set_self_longnick', SetGroupRemark: 'set_group_remark', TranslateEnWordToZn: 'translate_en2zh',
  GroupPoke: 'group_poke', FriendPoke: 'friend_poke', SendPoke: 'send_poke',
};
const rest = [];
for (const a of ev.actions) {
  const oursName = map[a.action] ?? snake(a.action);
  if (ours.has(oursName)) continue;
  rest.push({ napcat: a.action, guess: oursName, hook: a.hookDependency });
}
const svc = rest.filter(r => r.hook === 'service-only');
const hook = rest.filter(r => r.hook === 'hook-required');
console.log('missing total', rest.length, '| service-only', svc.length, '| hook-required', hook.length);
console.log('\nSERVICE:', svc.map(r => r.guess).join(' '));
console.log('\nHOOK:', hook.map(r => r.guess).join(' '));
