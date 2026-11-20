import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { OneBotCore } from '../src/core.mjs';
import { createTransport } from '../src/transport/index.mjs';
import { BridgeError } from '../src/bridge/error.mjs';
import { ImageStore } from '../src/media/image-store.mjs';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { startOneBotProcess } from '../src/host/onebot-process.mjs';
import { openReadOnlySession } from '../src/host/read-only-session.mjs';
import { InboundChallenge } from '../src/host/inbound-challenge.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const app = path.resolve(process.argv[2] ?? (process.platform === 'win32' ? 'D:/QQ-Agent/app' : '/mnt/d/QQ-Agent/app'));
const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const temporary = path.join(root, '.tmp');
if (!fs.existsSync(temporary)) fs.mkdirSync(temporary);
assert.equal(fs.realpathSync(temporary), temporary);
const fixture = fs.mkdtempSync(path.join(temporary, 'agent-plus-client-'));
process.env.QQ_AGENT_DATA_DIR = fixture;
process.chdir(fixture);
const mediaRoot = path.join(fixture, 'qq-onebot');
fs.mkdirSync(mediaRoot);
const images = new ImageStore({ projectRoot: mediaRoot });
const sticker = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMQWm3yHwADtQHxqGjRKQAAAABJRU5ErkJggg==', 'base64');
const source = path.join(app, 'src', 'onebot', 'onebot.js');
const { OneBotClient, extractMediaFromSegments, segmentsToText } = await import(pathToFileURL(source));
const readerSource = path.join(app, 'src', 'onebot', 'forward-reader.js');
const { readForwardMessages } = await import(pathToFileURL(readerSource));
const audioSource = path.join(app, 'src', 'tools', 'audio-transcribe.js');
const { transcribeMessageAudio } = await import(pathToFileURL(audioSource));
const bridge = new EventEmitter();
let mode = 'success';
let attempts = 0;
bridge.probe = async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-session' });
bridge.capabilities = () => ['send_group_msg', 'get_forward_msg'];
bridge.call = async (action, params) => {
  if (action === 'get_forward_msg') {
    assert(params.id === 'synthetic-forward-id' || params.message_id === 30);
    if (mode === 'query-timeout') return new Promise(() => {});
    return { message: [{ type: 'node', data: {
      user_id: '10001', nickname: 'Synthetic sender', content: [{ type: 'text', data: { text: 'synthetic node' } }],
    } }] };
  }
  assert.equal(action, 'send_group_msg');
  assert.equal(params.group_id, 123456);
  if (mode === 'sticker') {
    assert.deepEqual(params.message.map(segment => segment.type), ['reply', 'at', 'image']);
    const fields = params.message[2].data;
    assert.equal(fields.sub_type, 1);
    assert.equal(fields.summary, '\u005b\u52a8\u753b\u8868\u60c5\u005d');
    const asset = await images.stageOneBotFile(fields.file);
    assert.equal(asset.format, 'png');
    assert.equal(asset.decoded, true);
    assert.deepEqual(images.read(asset.token), sticker);
    return { message_id: 40 };
  }
  attempts++;
  if (mode === 'rejected') throw new BridgeError('REJECTED', 'Synthetic rejection', { retcode: 1500, outcome: 'rejected' });
  if (mode === 'unknown') throw new Error('Synthetic loss of receipt');
  return { message_id: attempts };
};
let core = new OneBotCore({ bridge, minimumWriteIntervalMs: 0 });
const token = randomBytes(24).toString('hex');
let requestEcho;
const server = await createTransport({ dispatch: request => {
  requestEcho = request.echo;
  return core.dispatch(request);
}, events: core,
  status: () => core.status(), token, heartbeatMs: 100, agentPlusCompatibility: true });
const events = new EventEmitter();
const client = new OneBotClient({
  wsUrl: 'ws://127.0.0.1:' + server.address.port,
  httpUrl: 'http://127.0.0.1:' + server.address.port,
  accessToken: token,
  onEvent(event) { events.emit(event.meta_event_type ?? event.post_type, event); },
});
const report = { source, sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  forwardReaderSha256: createHash('sha256').update(fs.readFileSync(readerSource)).digest('hex'),
  audioToolSha256: createHash('sha256').update(fs.readFileSync(audioSource)).digest('hex'),
  actualAgentClient: true, syntheticBridge: true, checks: {} };

async function verifyComposedClient() {
  const group = '123456';
  const sender = '10001';
  const bot = BOT_UIN;
  const inboundNative = {
    chatType: 2, peerUid: group, msgId: '90071992547409931', msgSeq: '90071992547409932',
    clientSeq: '90071992547409933', msgTime: '1700000000', senderUin: sender,
    senderUid: 'u_sender', sendNickName: 'Synthetic sender',
    elements: [{ elementType: 1, textElement: {
      content: '@Synthetic bot', atType: 2, atUid: '0', atNtUid: 'u_bot',
    } }],
  };
  const fileNative = {
    ...inboundNative, msgId: '90071992547409942',
    elements: [{ elementType: 3, fileElement: {
      fileName: 'Synthetic audio.m4a', fileSize: '9007199254740993', fileUuid: 'synthetic-file-uuid',
      filePath: '/synthetic/private/path', url: 'https://example.invalid/synthetic',
    } }],
  };
  const imagePath = '/download?appid=1407&fileid=synthetic&rkey=fixture-key';
  const imageUrl = 'https://multimedia.nt.qq.com.cn' + imagePath;
  const imageNative = {
    ...inboundNative, msgId: '90071992547409943',
    elements: [{ elementType: 2, picElement: {
      fileName: 'synthetic.png', originImageUrl: imagePath, filePath: '/synthetic/private/image',
    } }],
  };
  const voice = { elementType: 4, elementId: '17', pttElement: { fileName: 'synthetic.silk', text: '' } };
  const voiceNative = { ...inboundNative, msgId: '90071992547409944', elements: [voice] };
  const queryMessages = new Map([fileNative, imageNative, voiceNative].map(message => [message.msgId, message]));
  const missedNative = { ...inboundNative, msgId: '90071992547409945', msgSeq: '90071992547409946',
    elements: [{ elementType: 1, textElement: { content: 'Synthetic message during restart' } },
      { elementType: 999, opaque: 'Synthetic opaque native data' }] };
  let gapHistoryReads = 0;
  let voiceReads = 0, voiceTranslations = 0;
  const reactionWrites = [];
  let listener;
  let submitted = 0;
  let lookups = 0;
  let registrations = 0;
  let holdReattachmentProof = false;
  const reattachmentProbe = Promise.withResolvers();
  const releaseReattachmentProof = Promise.withResolvers();
  let removals = 0;
  let anchoredHistoryReads = 0;
  let sentReadbacks = 0;
  let buddyListener;
  let groupListener;
  let groupMute = 1;
  let membersCached = false;
  const memberQueries = [];
  let includeReactionMember = false;
  const directoryQueries = [];
  let accepted = false;
  let remark = '';
  const birthday = { birthday_year: '2000', birthday_month: '2', birthday_day: '3' };
  let selfProfile = { nick: 'Synthetic bot', longNick: 'Synthetic note', sex: 255, birthday };
  const profileWrites = [];
  const decisions = [];
  const application = { friendUid: 'u_sender', reqTime: '1700000001', reqType: 1, isDecide: false, extWords: 'Synthetic application' };
  const buddy = {
    addKernelBuddyListener(value) { buddyListener = value; return 11; },
    removeKernelBuddyListener(handle) { assert.equal(handle, 11); },
    approvalFriendRequest(decision) {
      decisions.push(decision);
      accepted = decision.accept;
      buddyListener.onBuddyReqChange({ buddyReqs: [{ ...application, reqTime: decision.reqTime,
        reqType: accepted ? 3 : 7, isDecide: true }] });
      if (decision.reqTime === '1700000003') return Promise.reject(new Error('Synthetic approval failed after callback'));
    },
    isBuddy(uid) { return uid === application.friendUid && accepted; },
    setBuddyRemark(value) { assert.equal(value.uid, application.friendUid); remark = value.remark; },
  };
  const msg = {
    addKernelMsgListener(value) { listener = value; return ++registrations; },
    removeKernelMsgListener(handle) { assert.equal(handle, ++removals); },
    generateMsgUniqueId() { return String(90071992547409940n + BigInt(submitted)); },
    getAioFirstViewLatestMsgs(peer, count) {
      assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '' });
      assert.equal(count, 20);
      gapHistoryReads++;
      const protectedRecord = { ...missedNative, senderUin: OWNER_UIN, senderUid: 'u_protected',
        msgId: '90071992547409947', msgSeq: '90071992547409948',
        elements: [{ elementType: 1, textElement: { content: 'Synthetic protected record' } }] };
      return { result: 0, needContinueGetMsg: false,
        msgList: [protectedRecord, queryMessages.get(missedNative.msgId)].filter(Boolean) };
    },
    getMsgs(peer, anchor, count, direction) {
      assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '' });
      assert.equal(anchor, missedNative.msgId);
      assert.equal(count, 20);
      assert.equal(direction, false);
      anchoredHistoryReads++;
      return { result: 0, msgList: [missedNative] };
    },
    getMsgEmojiLikesList(peer, seq, emoji, type, cookie, forward, count) {
      assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '' });
      assert.deepEqual([seq, emoji, type, cookie, forward, count], [imageNative.msgSeq, '128077', '2', '', false, 15]);
      return { result: 0, isFirstPage: true, isLastPage: true, cookie: '',
        emojiLikesList: [{ tinyId: sender, nickName: 'Synthetic sender' }] };
    },
    getMsgsByMsgId(peer, ids) {
      assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '' });
      assert.equal(ids.length, 1);
      assert(queryMessages.has(ids[0]));
      const message = queryMessages.get(ids[0]);
      if (message === voiceNative) {
        voiceReads++;
        if (voiceTranslations && voiceReads >= 4) voice.pttElement.text = 'Synthetic voice transcript';
      }
      if (message.senderUin !== bot) return { result: 0, msgList: [message] };
      sentReadbacks++;
      const decorated = { ...message, nativeCounter: 1n, elements: message.elements.map(element => {
        if (element.elementType !== 1) return element;
        return { ...element, nativeCounter: 1n, textElement: {
          ...element.textElement,
          get nativeMetadata() { assert.fail('Unexpected access to native text metadata'); },
        } };
      }) };
      return { result: 0, msgList: [decorated], nativeCounter: 1n };
    },
    translatePtt2Text(msgId, peer, segment) {
      assert.equal(msgId, voiceNative.msgId);
      assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '' });
      assert.deepEqual(segment, voice);
      voiceTranslations++;
      return { result: 0 };
    },
    setMsgEmojiLikes(...args) {
      reactionWrites.push(args);
      return { result: 0 };
    },
    sendMsg(first, peer, elements, extension) {
      submitted++;
      assert.equal(first, '0');
      assert(extension instanceof Map);
      if (submitted === 2) {
        assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '90071992547409941' });
        assert.deepEqual(elements, [{ elementType: 6, faceElement: { faceIndex: 222, faceType: 2 } }]);
        const sent = { ...inboundNative, ...peer, msgId: '90071992547409949',
          senderUin: bot, senderUid: 'u_bot', sendStatus: 2, elements };
        queryMessages.set(sent.msgId, sent);
        listener.onMsgInfoListUpdate([sent]);
        return { result: 0 };
      }
      assert.deepEqual(peer, { chatType: 2, peerUid: group, guildId: '90071992547409940' });
      assert.deepEqual(elements.map(element => element.elementType), [7, 1, 1]);
      assert.deepEqual(elements[0].replyElement, {
        replayMsgId: inboundNative.msgId, replayMsgSeq: inboundNative.msgSeq,
        replyMsgClientSeq: inboundNative.clientSeq, replyMsgTime: inboundNative.msgTime,
        senderUin: sender, senderUinStr: sender, senderUidStr: 'u_sender',
      });
      assert.deepEqual(elements[1].textElement, {
        content: '@10001', atType: 2, atUid: sender, atNtUid: 'u_sender', atTinyId: '',
      });
      assert.equal(elements[2].textElement.content, 'Synthetic reply');
      const sent = { ...inboundNative, ...peer, msgId: '90071992547409941',
        senderUin: bot, senderUid: 'u_bot', sendStatus: 2, elements };
      queryMessages.set(sent.msgId, sent);
      const { elements: _elements, ...receipt } = sent;
      listener.onMsgInfoListUpdate([receipt]);
      return { result: 0 };
    },
  };
  const resident = new NativeBridge({
    timeoutMs: 2500,
    session: { getMsgService: () => msg, getBuddyService: () => buddy, getRichMediaService: () => ({
      getGroupFileList(code, params) {
        assert.equal(code, group);
        directoryQueries.push(params);
        const root = params.folderId === undefined;
        listener.onGroupFileInfoUpdate({ retCode: 0, isEnd: true, reqId: directoryQueries.length, item: [{ peerId: code,
          fileInfo: { fileId: root ? '/synthetic-root-file' : '/synthetic-sub-file', fileName: 'Synthetic report.txt',
            fileSize: '2048', uploaderUin: sender, uploaderName: 'Synthetic sender', busId: 1,
            parentFolderId: params.folderId ?? '/', localPath: '/synthetic/private/group-file' },
        }, ...(root ? [{ peerId: code, folderInfo: { folderId: '/reports', parentFolderId: '/',
          folderName: 'Synthetic reports', totalFileCount: 1 } }] : [])] });
        return { result: 0 };
      },
    }), getProfileService: () => ({
      getUserDetailInfoByUin(uin) {
        assert.equal(uin, bot);
        const { nick, longNick, sex, birthday } = selfProfile;
        const dates = Object.fromEntries(Object.entries(birthday).map(([key, value]) => [key, Number(value)]));
        return { result: 0, detail: { uin, uid: 'u_bot', simpleInfo: {
          coreInfo: { nick }, baseInfo: { ...dates, longNick, sex },
        } } };
      },
      modifyDesktopMiniProfile(value) {
        profileWrites.push(value);
        selfProfile = structuredClone(value);
        return { result: 0 };
      },
      getCoreAndBaseInfo(source, [uid]) {
        assert.equal(source, 'nodeStore');
        assert.equal(uid, application.friendUid);
        return new Map([[uid, { coreInfo: { uid, uin: sender, remark } }]]);
      },
    }), getGroupService: () => ({
      addKernelGroupListener(listener) { groupListener = listener; return 12; },
      removeKernelGroupListener(handle) { assert.equal(handle, 12); groupListener = undefined; },
      getGroupDetailInfo(code, source) {
        assert.equal(code, group);
        assert.equal(source, 1);
        groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Synthetic group', memberNum: 1,
          maxMemberNum: 100, shutUpAllTimestamp: groupMute });
        return { result: 0 };
      },
      getAllMemberList(code, fresh) {
        assert.equal(code, group);
        memberQueries.push(fresh);
        if (fresh) membersCached = true;
        if (!membersCached) return { errCode: 0, result: { finish: true, infos: new Map() } };
        return { errCode: 0, result: { finish: true, infos: new Map([['u_bot', {
          uid: 'u_bot', uin: bot, nick: selfProfile.nick, role: 2, memberRealLevel: 7,
          shutUpTime: 4102444800, isRobot: false,
        }], ...(includeReactionMember ? [['u_sender', { uid: 'u_sender', uin: sender }]] : [])]) } };
      },
      getUidByUins(values) {
        lookups++;
        assert.deepEqual(values, [sender]);
        return { errCode: 0, uids: new Map([[sender, 'u_sender']]) };
      },
    }) },
    async identityProbe() {
      if (holdReattachmentProof && registrations === 2) {
        reattachmentProbe.resolve();
        await releaseReattachmentProof.promise;
      }
      return { user_id: bot, uid: 'u_bot', nickname: selfProfile.nick, online: true, sessionId: 'synthetic-reply' };
    },
  });
  await resident.attach();
  let service, composedClient;
  const incoming = new EventEmitter();
  let gapEventsDelivered = 0;
  incoming.on('message', event => {
    if (event.raw_message?.startsWith('Synthetic message during restart')) gapEventsDelivered++;
  });
  const reverse = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const reverseToken = 'synthetic-resident-reverse-token';
  const reverseConnections = new EventEmitter();
  reverse.on('connection', (socket, request) => {
    const frames = new EventEmitter();
    socket.on('message', payload => {
      const frame = JSON.parse(payload.toString());
      frames.emit(frame.echo ?? frame.meta_event_type ?? frame.post_type, frame);
    });
    reverseConnections.emit('connection', { socket, headers: request.headers, frames });
  });
  const nextReverse = () => once(reverseConnections, 'connection', { signal: AbortSignal.timeout(7000) });
  const reverseFrame = (connection, event) => once(connection.frames, event, { signal: AbortSignal.timeout(5000) }).then(([frame]) => frame);
  const reverseCall = async (connection, action, params, echo) => {
    const response = reverseFrame(connection, echo);
    connection.socket.send(JSON.stringify({ action, params, echo }));
    const result = await response;
    assert.equal(result.retcode, 0);
    return result.data;
  };
  const verifyReverseIdentity = async connection => {
    assert.equal(connection.headers.authorization, 'Bearer ' + reverseToken);
    assert.equal(connection.headers['x-client-role'], 'Universal');
    assert.equal(connection.headers['x-self-id'], bot);
    assert.equal(String((await reverseCall(connection, 'get_login_info', {}, 'reverse-identity')).user_id), bot);
  };
  try {
    await once(reverse, 'listening', { signal: AbortSignal.timeout(3000) });
    const serviceOptions = { projectRoot: mediaRoot, token, timeoutMs: 2500, minimumWriteIntervalMs: 0, agentPlusCompatibility: true,
      reverseWebSocket: { url: `ws://127.0.0.1:${reverse.address().port}/onebot`, token: reverseToken,
        role: 'Universal', heartbeatMs: 0 } };
    const reverseBefore = nextReverse();
    service = await startOneBotProcess(resident, { ...serviceOptions, port: 0, wsPort: 0 });
    const [firstReverse] = await reverseBefore;
    await verifyReverseIdentity(firstReverse);
    const { port, wsPort } = service;
    assert.notEqual(wsPort, port);
    const newLifecycle = () => once(incoming, 'lifecycle', { signal: AbortSignal.timeout(7000) });
    composedClient = new OneBotClient({
      wsUrl: 'ws://127.0.0.1:' + wsPort,
      httpUrl: 'http://127.0.0.1:' + port,
      accessToken: token,
      onEvent(event) { incoming.emit(event.meta_event_type ?? event.post_type, event); },
    });
    const lifecycle = newLifecycle();
    await composedClient.connect();
    await lifecycle;
    const identity = await composedClient.call('get_login_info');
    assert.equal(String(identity.user_id), bot);
    for (let i = 0; !composedClient.selfId && i < 50; i++) await delay(20);
    assert.equal(composedClient.selfId, bot);
    const firstProcess = service;
    const reconnected = newLifecycle();
    const reverseAfter = nextReverse();
    const reverseClosed = once(firstReverse.socket, 'close', { signal: AbortSignal.timeout(7000) });
    assert.deepEqual(await firstProcess.close(), { code: 0, signal: null });
    await reverseClosed;
    const missed = once(resident, 'event', { signal: AbortSignal.timeout(3000) });
    queryMessages.set(missedNative.msgId, missedNative);
    listener.onRecvMsg([missedNative]);
    const [gapEvent] = await missed;
    assert.match(gapEvent.raw_message, /^Synthetic message during restart/);
    service = await startOneBotProcess(resident, { ...serviceOptions, port, wsPort });
    assert.notEqual(service.instance, firstProcess.instance);
    assert.equal(service.port, port);
    assert.equal(service.wsPort, wsPort);
    const [secondReverse] = await reverseAfter;
    assert.notEqual(secondReverse.socket, firstReverse.socket);
    await verifyReverseIdentity(secondReverse);
    await reconnected;
    assert.equal(String((await composedClient.callViaWs('get_login_info')).user_id), bot);
    assert.equal(registrations, 1);
    report.checks.actualClientReconnectsAfterOneBotChildRestart = true;
    report.checks.actualClientUsesSeparateHttpAndWsPorts = true;
    const history = await composedClient.call('get_group_msg_history', { group_id: Number(group), count: 20 });
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].message_id, gapEvent.message_id);
    assert.equal(history.messages[0].message_seq, missedNative.msgSeq);
    assert.equal(history.messages[0].raw_message, gapEvent.raw_message);
    assert.deepEqual(history.messages[0].message[1], { type: 'qq_unknown', data: { element_type: '999' } });
    assert(!JSON.stringify(history).includes('Synthetic opaque native data'));
    const gapRead = await composedClient.callViaWs('get_msg', { message_id: gapEvent.message_id });
    assert.equal(gapRead.raw_message, gapEvent.raw_message);
    assert.equal(gapRead.group_id, Number(group));
    assert.equal(gapHistoryReads, 1);
    assert.equal(gapEventsDelivered, 0);
    assert.equal(resident.messages.find({ chatType: 2, peerUid: group }, '90071992547409947'), undefined);
    report.checks.composedNativeBridgeRecoversRestartGapViaHistory = true;
    const oldListener = listener;
    const generation = resident.generation;
    const sessionId = resident.identity.sessionId;
    holdReattachmentProof = true;
    assert.equal((await resident.reattach()).sessionId, sessionId);
    assert.equal(resident.generation, generation + 1);
    assert.notEqual(listener, oldListener);
    assert.equal(registrations, 2);
    assert.equal(removals, 1);
    try {
      await Promise.race([reattachmentProbe.promise, delay(3000, undefined, { ref: false }).then(() => {
        assert.fail('The child did not request a proof after reattachment');
      })]);
      const params = { group_id: Number(group), count: 20, message_seq: history.messages[0].message_seq };
      for (const call of [composedClient.call.bind(composedClient), composedClient.callViaWs.bind(composedClient)]) {
        await assert.rejects(call('get_group_msg_history', params), error =>
          error.retcode === 1503 && error.outcome === 'failed' && /action not submitted/.test(error.message));
      }
      const echo = 'reattachment-pending';
      const response = reverseFrame(secondReverse, echo);
      secondReverse.socket.send(JSON.stringify({ action: 'get_group_msg_history', params, echo }));
      const blocked = await response;
      assert.equal(blocked.retcode, 1503);
      assert.match(blocked.wording, /action not submitted/);
      assert.equal(anchoredHistoryReads, 0);
      report.checks.composedNativeBridgeReportsUnsubmittedReattachmentAcrossTransports = true;
    } finally { releaseReattachmentProof.resolve(); }
    // Reattachment signals a fresh proof over IPC. Poll the published action
    // list without using get_login_info to force a foreground proof.
    const proofDeadline = performance.now() + 3000;
    let actions = [];
    do {
      actions = await composedClient.callViaWs('get_supported_actions');
      if (actions.includes('get_group_msg_history')) break;
      await delay(20);
    } while (performance.now() < proofDeadline);
    assert(actions.includes('get_group_msg_history'), 'New bridge proof did not publish history capability');
    const anchored = await composedClient.callViaWs('get_group_msg_history', {
      group_id: Number(group), count: 20, message_seq: history.messages[0].message_seq,
    });
    assert.deepEqual(anchored, history);
    assert.deepEqual(await reverseCall(secondReverse, 'get_msg', { message_id: gapEvent.message_id }, 'reattached-readback'), gapRead);
    assert.equal(anchoredHistoryReads, 1);
    report.checks.composedNativeBridgePreservesHistoryCursorAcrossReattachment = true;
    const waiting = once(incoming, 'message', { signal: AbortSignal.timeout(5000) });
    const reverseWaiting = reverseFrame(secondReverse, 'message');
    listener.onRecvMsg([inboundNative]);
    const [event] = await waiting;
    assert.deepEqual(await reverseWaiting, event);
    assert.equal(event.group_id, Number(group));
    assert.deepEqual(event.message, [{ type: 'at', data: { qq: bot } }]);
    const options = { replyToMessageId: event.message_id, atUserId: sender };
    const receipt = await composedClient.sendText('group', group, 'Synthetic reply', options);
    assert.notEqual(receipt.message_id, event.message_id);
    const confirmed = resident.messages.get(receipt.message_id);
    assert.equal(confirmed.msgId, '90071992547409941');
    const receiptQuery = { message_id: receipt.message_id };
    const sentReadback = await composedClient.getMsg(receipt.message_id);
    assert.equal(sentReadback.message_id, receipt.message_id);
    assert.equal(sentReadback.group_id, Number(group));
    assert.equal(sentReadback.sender.user_id, Number(bot));
    assert.deepEqual(sentReadback.message, [
      { type: 'reply', data: { id: String(event.message_id) } },
      { type: 'at', data: { qq: sender } },
      { type: 'text', data: { text: 'Synthetic reply' } },
    ]);
    assert.deepEqual(await composedClient.callViaWs('get_msg', receiptQuery), sentReadback);
    assert.deepEqual(await reverseCall(secondReverse, 'get_msg', receiptQuery, 'reverse-readback'), sentReadback);
    assert.equal(sentReadbacks, 3);
    report.checks.reverseWebSocketReconnectsAndReadsSameReceipt = true;
    report.checks.actualClientReadsBackReducedSendReceipt = true;
    report.checks.actualClientReadsBackOpaqueNativeMetadata = true;
    await assert.rejects(composedClient.sendText('group', '123457', 'Synthetic reply', options),
      { outcome: 'failed', httpStatus: 400 });
    await assert.rejects(composedClient.callViaWs('send_group_msg', { group_id: 123457, message: [
      { type: 'reply', data: { id: String(event.message_id) } },
      { type: 'text', data: { text: 'Synthetic reply' } },
    ] }), { outcome: 'failed', retcode: 1400 });
    assert.equal(submitted, 1);
    assert.equal(lookups, 1);
    assert(!fs.existsSync(path.join(mediaRoot, 'runtime', 'outcomes', 'pending.json')));
    report.checks.composedNativeBridgeReplyAndMention = true;
    const fileWaiting = once(incoming, 'message', { signal: AbortSignal.timeout(5000) });
    listener.onFileMsgCome([fileNative]);
    const [fileEvent] = await fileWaiting;
    const fileMessage = await composedClient.call('get_msg', { message_id: fileEvent.message_id });
    const expectedSegments = [{ type: 'file', data: {
      name: 'Synthetic audio.m4a', file: 'Synthetic audio.m4a',
      file_size: '9007199254740993', file_id: 'synthetic-file-uuid',
    } }];
    assert.deepEqual(fileEvent.message, expectedSegments);
    assert.equal(fileMessage.message_id, fileEvent.message_id);
    assert.deepEqual(fileMessage.message, expectedSegments);
    assert.deepEqual(extractMediaFromSegments(fileMessage.message),
      [{ kind: 'audio', file: 'Synthetic audio.m4a', url: '' }]);
    assert.equal((await segmentsToText(fileEvent.message)).replace(/\s+/g, ''), '[\u6587\u4ef6Syntheticaudio.m4a]');
    report.checks.composedNativeBridgeFileMetadata = true;
    const rootFiles = await composedClient.call('get_group_root_files', { group_id: Number(group) });
    const firstFile = { group_id: Number(group), file_id: '/synthetic-root-file', file_name: 'Synthetic report.txt',
      file_size: 2048, size: 2048, uploader: Number(sender), uploader_name: 'Synthetic sender', busid: 1 };
    assert.deepEqual(rootFiles, { files: [firstFile], folders: [{ group_id: Number(group), folder_id: '/reports',
      folder: '/reports', folder_name: 'Synthetic reports', total_file_count: 1 }], is_end: true });
    const folderFiles = await composedClient.callViaWs('get_group_files_by_folder', { group_id: Number(group), folder: '/reports' });
    assert.deepEqual(folderFiles, { files: [{ ...firstFile, file_id: '/synthetic-sub-file' }], folders: [], is_end: true });
    assert.deepEqual(directoryQueries.map(query => query.folderId), [undefined, '/reports']);
    report.checks.composedNativeBridgeGroupFileList = true;
    const imageWaiting = once(incoming, 'message', { signal: AbortSignal.timeout(5000) });
    listener.onRecvMsg([imageNative]);
    const [imageEvent] = await imageWaiting;
    const imageMessage = await composedClient.getMsg(imageEvent.message_id);
    const expectedMedia = [{ kind: 'image', file: 'synthetic.png', url: imageUrl, summary: '' }];
    assert.deepEqual(extractMediaFromSegments(imageEvent.message), expectedMedia);
    assert.deepEqual(extractMediaFromSegments(imageMessage.message), expectedMedia);
    report.checks.composedNativeBridgeImageUrl = true;
    imageNative.emojiLikesList = [{ emojiId: '128077', emojiType: '2', likesCnt: '1' }];
    const reactionQuery = { message_id: imageEvent.message_id };
    const faceReceipt = await composedClient.sendFace('group', group, '222');
    assert.notEqual(faceReceipt.message_id, receipt.message_id);
    assert.deepEqual((await composedClient.getMsg(faceReceipt.message_id)).message, [{ type: 'face', data: { id: '222' } }]);
    report.checks.composedNativeBridgeExtendedFace = true;
    assert.equal(await composedClient.reactToMessage(imageEvent.message_id, 128077), null);
    await reverseCall(secondReverse, 'set_msg_emoji_like',
      { message_id: imageEvent.message_id, emoji_id: '128077', set: 'false' }, 'remove-reaction');
    const imagePeer = { chatType: 2, peerUid: group, guildId: '' };
    assert.deepEqual(reactionWrites, [[imagePeer, imageNative.msgSeq, '128077', '2', true],
      [imagePeer, imageNative.msgSeq, '128077', '2', false]]);
    report.checks.composedNativeBridgeUnicodeReaction = true;

    const voiceWaiting = once(incoming, 'message', { signal: AbortSignal.timeout(5000) });
    listener.onRecvMsg([voiceNative]);
    const [voiceEvent] = await voiceWaiting;
    const transcript = await transcribeMessageAudio({ onebot: composedClient, kind: 'group', chatId: group },
      { mid: voiceEvent.message_id, media: [] });
    assert.deepEqual(transcript, { ok: true, text: 'Synthetic voice transcript' });
    assert.equal(voiceReads, 4);
    assert.equal(voiceTranslations, 1);
    report.checks.composedNativeBridgeVoiceTranscription = true;

    assert.equal((await composedClient.refreshSelfInfo()).nickname, 'Synthetic bot');
    const expectedProfile = { nick: 'Renamed synthetic bot', longNick: '', sex: 255, birthday, location: undefined };
    assert.equal(await composedClient.setProfile({ nickname: ' Renamed synthetic bot ', personalNote: '' }), null);
    assert.deepEqual(profileWrites, [expectedProfile]);
    assert.deepEqual(await composedClient.refreshSelfInfo(), { user_id: Number(bot), nickname: expectedProfile.nick });
    assert.deepEqual(await composedClient.callViaWs('get_login_info'), { user_id: Number(bot), nickname: expectedProfile.nick });
    assert.equal(await composedClient.setProfile({ nickname: expectedProfile.nick }), null);
    assert.equal(profileWrites.length, 1);
    assert(!fs.existsSync(path.join(mediaRoot, 'runtime', 'outcomes', 'pending.json')));
    report.checks.composedNativeBridgeSelfProfile = true;

    const groupMember = await composedClient.getGroupMemberInfo(group, bot);
    assert.equal(groupMember.user_id, Number(bot));
    assert.equal(groupMember.group_id, Number(group));
    assert.equal(groupMember.shut_up_timestamp, 4102444800);
    assert.equal(groupMember.level, '7');
    assert.equal(groupMember.is_robot, false);
    assert.deepEqual(await composedClient.callViaWs('get_group_member_list', { group_id: group }), [groupMember]);
    assert.deepEqual(memberQueries, [false, true, false]);
    includeReactionMember = true;
    const reactionSummary = [{ emoji_id: '128077', emoji_type: 2, count: 1, users: [{ user_id: sender }], users_complete: true }];
    assert.deepEqual(await composedClient.call('get_msg_emoji_likes', reactionQuery), reactionSummary);
    assert.deepEqual(await composedClient.callViaWs('get_msg_emoji_likes', reactionQuery), reactionSummary);
    report.checks.composedNativeBridgeReactionResponders = true;
    report.checks.composedNativeBridgeGroupMemberFields = true;
    report.checks.composedNativeBridgeMemberCacheMiss = true;

    const mutedGroup = await composedClient.getGroupInfo(group);
    assert.equal(mutedGroup.group_all_shut, 1);
    assert.deepEqual(await composedClient.callViaWs('get_group_info', { group_id: group }), mutedGroup);
    assert.deepEqual(await reverseCall(secondReverse, 'get_group_info', { group_id: group }, 'reverse-group-mute'), mutedGroup);
    groupMute = 0;
    assert.equal((await composedClient.getGroupInfo(group)).group_all_shut, 0);
    groupMute = undefined;
    assert.equal(Object.hasOwn(await composedClient.getGroupInfo(group), 'group_all_shut'), false);
    report.checks.composedNativeBridgeWholeGroupMute = true;
    report.checks.reverseWebSocketUsesAgentPlusMuteFormat = true;

    const applicationEvent = async reqTime => {
      const waiting = once(incoming, 'request', { signal: AbortSignal.timeout(5000) });
      buddyListener.onBuddyReqChange({ buddyReqs: [{ ...application, reqTime }] });
      const [request] = await waiting;
      assert.equal(request.request_type, 'friend');
      assert.equal(request.user_id, Number(sender));
      assert.equal(request.comment, application.extWords);
      assert.match(request.flag, /^friend-[a-f0-9]{32}$/);
      return request.flag;
    };
    const rejectFlag = await applicationEvent(application.reqTime);
    assert.equal(await composedClient.callViaWs('set_friend_add_request', { flag: rejectFlag, approve: false }), null);
    const nextTime = '1700000002';
    const approveFlag = await applicationEvent(nextTime);
    assert.equal(await composedClient.call('set_friend_add_request', { flag: approveFlag, approve: true, remark: 'Synthetic remark' }), null);
    assert.equal(remark, 'Synthetic remark');
    await assert.rejects(composedClient.callViaWs('set_friend_add_request', { flag: approveFlag, approve: true }),
      { outcome: 'failed', retcode: 1400 });
    assert.deepEqual(decisions, [
      { friendUid: application.friendUid, reqTime: application.reqTime, accept: false },
      { friendUid: application.friendUid, reqTime: nextTime, accept: true },
    ]);
    assert(!fs.existsSync(path.join(mediaRoot, 'runtime', 'outcomes', 'pending.json')));
    report.checks.composedNativeBridgeFriendRequests = true;
    const uncertainFlag = await applicationEvent('1700000003');
    await assert.rejects(composedClient.call('set_friend_add_request', {
      flag: uncertainFlag, approve: true, remark: 'Must remain unapplied',
    }), { outcome: 'unknown' });
    const pendingPath = path.join(mediaRoot, 'runtime', 'outcomes', 'pending.json');
    const pending = fs.readFileSync(pendingPath, 'utf8');
    assert.equal(JSON.parse(pending).action, 'set_friend_add_request');
    await assert.rejects(composedClient.call('set_friend_add_request', { flag: uncertainFlag, approve: true }));
    assert.equal(fs.readFileSync(pendingPath, 'utf8'), pending);
    assert.equal(remark, 'Synthetic remark');
    assert.equal(decisions.length, 3);
    report.checks.composedNativeFriendRequestFailurePreservesOutcome = true;

    const expectedStatus = { online: true, good: false };
    const verifyReadOnlyService = async (connection, stage) => {
      // The action list uses the current proof without triggering a new one.
      // Check it before get_status or get_msg can refresh identity.
      const capabilities = await composedClient.call('get_supported_actions');
      assert(capabilities.includes('get_msg'));
      assert(!capabilities.includes('send_group_msg'));
      assert(!capabilities.includes('set_friend_add_request'));
      assert.deepEqual(await composedClient.call('get_status'), expectedStatus);
      assert.deepEqual(await composedClient.callViaWs('get_status'), expectedStatus);
      assert.deepEqual(await reverseCall(connection, 'get_status', {}, `${stage}-status`), expectedStatus);
      assert.deepEqual(await composedClient.getMsg(receipt.message_id), sentReadback);
      assert.deepEqual(await composedClient.callViaWs('get_msg', receiptQuery), sentReadback);
      assert.deepEqual(await reverseCall(connection, 'get_msg', receiptQuery, `${stage}-readback`), sentReadback);
      for (const call of [composedClient.call.bind(composedClient), composedClient.callViaWs.bind(composedClient)])
        await assert.rejects(call('send_group_msg', { group_id: Number(group), message: 'Must remain unsent' }),
          { outcome: 'failed', retcode: 1503 });
      const echo = `${stage}-write`;
      const blocked = reverseFrame(connection, echo);
      connection.socket.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: Number(group),
        message: 'Must remain unsent' }, echo }));
      assert.equal((await blocked).retcode, 1503);
      assert.equal(submitted, 2);
      assert.equal(fs.readFileSync(pendingPath, 'utf8'), pending);
    };
    await verifyReadOnlyService(secondReverse, 'before-restart');
    report.checks.composedNativeBridgeRetainsReadOnlyServiceAfterUnknownWrite = true;

    const degradedLifecycle = newLifecycle();
    const degradedReverse = nextReverse();
    const retired = service;
    assert.deepEqual(await retired.close(), { code: 0, signal: null });
    service = await startOneBotProcess(resident, { ...serviceOptions, port, wsPort });
    const [pendingReverse] = await degradedReverse;
    await degradedLifecycle;
    assert.equal(service.port, port);
    assert.equal(service.wsPort, wsPort);
    assert.equal(registrations, 2);
    await verifyReadOnlyService(pendingReverse, 'after-restart');
    report.checks.composedNativeBridgeReportsReadOnlyRecoveryWithPendingOutcome = true;
  } finally {
    composedClient?.close();
    try { await service?.close(); }
    finally {
      resident.detach();
      for (const socket of reverse.clients) socket.terminate();
      await new Promise(resolve => reverse.close(resolve));
    }
  }
}

async function verifyScopedClient(admin = false) {
  const group = '123456';
  const account = Number(BOT_UIN);
  const sender = admin ? OWNER_UIN : '10001';
  const challengeSource = new InboundChallenge(undefined, { allowProtectedSender: admin });
  const { text } = challengeSource.arm(1, group, { readbackOnly: true, allowAdminChallenge: admin });
  challengeSource.observe([{ msgId: '90071992547410011', chatType: 2, peerUid: group, senderUin: sender,
    msgTime: '1700000000', elements: [{ elementType: 1, textElement: { content: text } }] }], 1);
  const challenge = challengeSource.takeRecent(1, true, admin);
  assert(challenge);
  const incoming = new EventEmitter();
  const lifetime = new AbortController();
  const projectRoot = path.join(fixture, admin ? 'read-only-admin' : 'read-only', 'qq-onebot');
  fs.mkdirSync(projectRoot, { recursive: true });
  let groupListener, reads = 0, sends = 0, removals = 0;
  const messageService = {
    addKernelMsgListener: () => 1,
    removeKernelMsgListener: () => { removals++; },
    generateMsgUniqueId: () => '90071992547410010',
    sendMsg() { sends++; return { result: 0 }; },
  };
  const groupService = {
    addKernelGroupListener(listener) { groupListener = listener; return 2; },
    removeKernelGroupListener() {},
    getGroupDetailInfo(code) {
      reads++;
      assert.equal(code, group);
      groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Scoped group', memberNum: 1, maxMemberNum: 100 });
      return { result: 0 };
    },
  };
  const accessToken = randomBytes(24).toString('hex');
  const endpoint = await openReadOnlySession({ projectRoot, group, token: accessToken, signal: lifetime.signal, challenge,
    session: { getMsgService: () => messageService, getGroupService: () => groupService },
    identityProbe: async () => ({ user_id: account, online: true, sessionId: 'scoped-agent-fixture' }) });
  const scoped = new OneBotClient({ wsUrl: 'ws://127.0.0.1:' + endpoint.wsPort,
    httpUrl: 'http://127.0.0.1:' + endpoint.port, accessToken, onEvent: event => incoming.emit(event.post_type, event) });
  try {
    const signal = AbortSignal.timeout(3500);
    const lifecycle = once(incoming, 'meta_event', { signal });
    await scoped.connect();
    await lifecycle;
    while (!scoped.selfId) await delay(20, undefined, { signal });
    assert.equal(scoped.selfId, String(account));
    assert.equal((await scoped.call('get_group_info', { group_id: Number(group) })).group_id, Number(group));
    await assert.rejects(scoped.call('get_group_info', { group_id: Number(group) + 1 }), { outcome: 'failed', retcode: 1403 });
    await assert.rejects(scoped.callViaWs('get_friend_list', {}), { outcome: 'failed', retcode: 1403 });
    const params = { group_id: Number(group), message: 'Synthetic scoped write' };
    await assert.rejects(scoped.call('send_group_msg', params), { outcome: 'failed', retcode: 1403 });
    await assert.rejects(scoped.callViaWs('send_group_msg', params), { outcome: 'failed', retcode: 1403 });
    const event = once(incoming, 'message', { signal });
    endpoint.replayChallenge(challenge);
    const [matched] = await event;
    assert.equal(matched.raw_message, text);
    assert.equal(matched.group_id, Number(group));
    assert.equal(matched.user_id, Number(sender));
    assert(Number.isSafeInteger(matched.message_id) && matched.message_id > 0);
    assert.equal(reads, 1);
    assert.equal(sends, 0);
  } finally {
    scoped.close();
    lifetime.abort();
    await endpoint.close();
  }
  assert.equal(removals, 1);
  report.checks[admin ? 'scopedAdminReadOnlyAgentClient' : 'scopedReadOnlyAgentClient'] = true;
}

try {
  const heartbeat = once(events, 'heartbeat', { signal: AbortSignal.timeout(5000) });
  await client.connect();
  await heartbeat;
  for (let i = 0; !client.selfId && i < 50; i++) await delay(20);
  assert.equal(client.selfId, BOT_UIN);
  report.checks.handshakeAndHttpIdentity = true;
  const inbound = once(events, 'message', { signal: AbortSignal.timeout(5000) });
  bridge.emit('event', { self_id: Number(BOT_UIN), post_type: 'message', message_type: 'group',
    group_id: 123456, user_id: 10001, message_id: 30, message: [{ type: 'text', data: { text: 'synthetic' } }] });
  assert.equal((await inbound)[0].message_id, 30);
  report.checks.heartbeatAndMessage = true;
  const nodes = await readForwardMessages(client, 30, [{ type: 'forward', data: { id: 'synthetic-forward-id' } }]);
  assert.deepEqual(nodes, [{
    user_id: '10001', sender: { user_id: '10001', nickname: 'Synthetic sender' },
    message: [{ type: 'text', data: { text: 'synthetic node' } }],
  }]);
  report.checks.actualForwardReader = true;
  const legacy = await readForwardMessages(client, 30, []);
  assert.deepEqual(legacy, nodes);
  report.checks.actualForwardReaderLegacyFallback = true;
  assert.equal((await client.sendText('group', 123456, 'synthetic')).message_id, 1);
  const overWs = await client.callViaWs('send_group_msg', { group_id: 123456, message: 'synthetic' });
  assert.equal(overWs.message_id, 2);
  report.checks.httpAndWsActions = true;
  const large = await client.call('send_group_msg', {
    group_id: 123456, message: 'synthetic', padding: 'x'.repeat(1600000),
  });
  assert.equal(large.message_id, 3);
  assert.match(requestEcho, /^ws_/);
  report.checks.largeRequestAutomaticallyUsesWs = true;
  mode = 'sticker';
  const stickerResponse = await client.sendSticker('group', 123456, 'base64://' + sticker.toString('base64'), {
    replyToMessageId: 30, atUserId: 10001,
  });
  assert.equal(stickerResponse.message_id, 40);
  report.checks.actualStickerClientAndImageStaging = true;
  mode = 'query-timeout';
  const regularTimeout = core.timeoutMs;
  core.timeoutMs = 40;
  try {
    const query = { id: 'synthetic-forward-id' };
    await assert.rejects(client.call('get_forward_msg', query), { outcome: 'failed', retcode: 1502, httpStatus: 200 });
    await assert.rejects(client.callViaWs('get_forward_msg', query), { outcome: 'failed', retcode: 1502 });
    assert.deepEqual(core.status(), { online: true, good: true });
  } finally {
    core.timeoutMs = regularTimeout;
  }
  mode = 'rejected';
  await assert.rejects(client.sendText('group', 123456, 'synthetic'), { outcome: 'failed', retcode: 1500 });
  report.checks.explicitRejection = true;
  report.checks.queryTimeoutIsActionFailure = true;
  mode = 'unknown';
  let unknown;
  try { await client.sendText('group', 123456, 'synthetic'); } catch (error) {
    unknown = { outcome: error.outcome, retcode: error.retcode, httpStatus: error.httpStatus };
  }
  assert(unknown);
  report.unknownHttp = unknown;
  assert.equal(unknown.outcome, 'unknown');
  await assert.rejects(client.sendText('group', 123456, 'synthetic'));
  assert.equal(attempts, 5);
  report.checks.unknownOutcomeAndLock = true;
  // Fresh synthetic dispatcher solely for the separate WS uncertainty case.
  core.close();
  core = new OneBotCore({ bridge, minimumWriteIntervalMs: 0 });
  await assert.rejects(client.callViaWs('send_group_msg', { group_id: 123456, message: 'synthetic' }), { outcome: 'unknown' });
  assert.equal(attempts, 6);
  await assert.rejects(client.sendText('group', 123456, 'synthetic'));
  assert.equal(attempts, 6);
  report.checks.unknownWsOutcomeAndLock = true;
  await verifyComposedClient();
  await verifyScopedClient();
  await verifyScopedClient(true);
} finally {
  client.close();
  core.close();
  await server.close();
  console.log(JSON.stringify(report));
}
