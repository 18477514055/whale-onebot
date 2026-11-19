const services = {
  getMsgService: ['addKernelMsgListener', 'removeKernelMsgListener', 'getMsgsByMsgId',
    'sendMsg', 'generateMsgUniqueId', 'getAioFirstViewLatestMsgs', 'getRichMediaFilePathForGuild', 'setMsgRead', 'fetchFavEmojiList'],
  getGroupService: ['addKernelGroupListener', 'removeKernelGroupListener', 'getGroupList', 'getGroupDetailInfo',
    'getUidByUins', 'getGroupRemainAtTimes', 'getJoinGroupLink'],
  getBuddyService: ['getBuddyListV2', 'isBuddy'],
  getProfileService: ['getSelfStatus', 'getUserDetailInfoByUin', 'getCoreAndBaseInfo'],
  getRichMediaService: ['getGroupFileList', 'batchGetGroupFileCount', 'getGroupFileInfo', 'createGroupFolder',
    'deleteGroupFolder', 'deleteGroupFile', 'moveGroupFile', 'translateEnWordToZn'],
  getRobotService: ['getRobotUinRange'],
  getProfileLikeService: ['setBuddyProfileLike'],
};

export function summarizeRoundtripServiceReadiness(report) {
  const has = (accessor, ...names) => report[accessor]?.serviceAvailable === true &&
    names.every(name => report[accessor].methods?.[name] === true);
  const inboundListener = has('getMsgService', 'addKernelMsgListener', 'removeKernelMsgListener');
  const send = has('getMsgService', 'generateMsgUniqueId', 'sendMsg');
  const messageReadback = has('getMsgService', 'getMsgsByMsgId');
  return { inboundListener, send, messageReadback,
    groupInfo: has('getGroupService', 'addKernelGroupListener', 'removeKernelGroupListener', 'getGroupDetailInfo'),
    historyReconciliation: has('getMsgService', 'getAioFirstViewLatestMsgs'),
    roundtripMethodsAvailable: inboundListener && send && messageReadback };
}

function method(object, name) {
  for (let depth = 0; object && depth < 4; depth++, object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor) return typeof descriptor.value === 'function' ? descriptor.value : undefined;
  }
}

// Call only the fixed service accessors. Business methods are inspected, never invoked.
export function inspectServiceReadiness(session, checkCurrent = () => {}) {
  const report = {};
  for (const [accessor, methods] of Object.entries(services)) {
    checkCurrent();
    const acquire = method(session, accessor);
    let service, accessorFailed = false;
    try { service = acquire?.call(session); }
    catch { accessorFailed = true; }
    checkCurrent();
    report[accessor] = {
      accessorAvailable: Boolean(acquire),
      serviceAvailable: service != null,
      ...(accessorFailed && { accessorFailed: true }),
      methods: Object.fromEntries(methods.map(name => [name, Boolean(method(service, name))])),
    };
  }
  return report;
}
