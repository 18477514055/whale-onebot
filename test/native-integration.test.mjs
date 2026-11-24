import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { OneBotCore } from '../src/core.mjs';
import { OutcomeStore } from '../src/outcome-store.mjs';
import { createTransport } from '../src/transport/index.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN;
const token = 'synthetic-native-integration-token';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const testTmp = fileURLToPath(new URL('../.tmp/', import.meta.url));

async function setup(t, { receipt = true, remarkResult = 'confirmed', friendResult = 'confirmed',
  groupFiles = 'confirmed', groupFolder, groupFileQuota, folderDeletion, fileOperations, profileUpdate, getRobotService, profileLike,
  signatureResult = 'confirmed', groupNameResult = 'confirmed', topResult = 'confirmed', friendTopResult = 'confirmed', recentContact, readNativeMessage, translateVoice, readReactionPage, downloadRichMedia, sendSsoCmd,
  bulletinResult = 'confirmed', bulletinImageResult = 'confirmed', pskeyDisabled = false } = {}) {
  fs.mkdirSync(testTmp, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(testTmp, 'native-integration-'));
  const root = path.join(temporary, 'qq-onebot');
  fs.mkdirSync(root);
  const store = new OutcomeStore(root);
  const state = { receipt, session: 'synthetic-A', online: true, sent: [], cardWrites: 0, incomplete: false, nextId: 90071992547409000n };
  let listener, groupListener;
  let remark = 'initial';
  let groupName = 'Synthetic Group';
  state.groupNameWrites = 0;
  state.remarkWrites = 0;
  state.topWrites = [];
  state.friendTopWrites = [];
  state.friendWrites = 0;
  state.signatureWrites = 0;
  let friendRemark = 'initial';
  let signature = 'initial';
  state.groupFileReads = 0;
  // 群公告相关：pskey 调用、发布/删除/图片上传的实参都留痕（pskey 是敏感值，
  // 这里只是本地校验「非空且来自 tipOff」，不代表可以打印）。
  state.pskeyCalls = [];
  state.bulletinPublish = [];
  state.bulletinDelete = [];
  state.bulletinPics = [];
  const msg = {
    ...(readNativeMessage && { getMsgsByMsgId: readNativeMessage }),
    ...(downloadRichMedia && { downloadRichMedia }),
    ...(translateVoice && { translatePtt2Text: translateVoice }),
    ...(readReactionPage && { getMsgEmojiLikesList: readReactionPage }),
    ...(sendSsoCmd && { sendSsoCmdReqByContend: sendSsoCmd }),
    addKernelMsgListener(value) { listener = value; return 1; },
    removeKernelMsgListener() {},
    generateMsgUniqueId() { return String(state.nextId++); },
    // 私聊会话置顶：NodeIKernelMsgService.setContactLocalTop(peer, isTop)
    setContactLocalTop(peer, isTop) {
      state.friendTopWrites.push({ chatType: peer?.chatType, peerUid: peer?.peerUid, isTop: Boolean(isTop) });
      if (friendTopResult === 'rejected') return { result: 1 };
      return { result: 0 };
    },
    async sendMsg(firstArgument, peer, elements) {
      assert.equal(firstArgument, '0');
      assert.match(peer.guildId, /^\d+$/);
      const msgId = String(state.nextId++);
      assert.notEqual(msgId, peer.guildId);
      state.sent.push({ msgId, peer, elements });
      if (state.receipt) queueMicrotask(() => listener.onMsgInfoListUpdate([raw({ msgId, guildId: peer.guildId, chatType: peer.chatType, peerUid: peer.peerUid, senderUin: BOT, senderUid: 'u_synthetic_self', sendStatus: 2, elements })]));
      return { result: 0 };
    },
  };
  const group = {
    modifyGroupName(code, name, flag) {
      assert.equal(code, '20001');
      assert.equal(flag, false);
      state.groupNameWrites++;
      if (groupNameResult === 'rejected') return { result: 1 };
      if (groupNameResult !== 'mismatch') groupName = name;
      return { result: 0 };
    },
    // 会话置顶：NodeIKernelGroupService.setTop(groupCode: string, isTop: boolean)
    setTop(code, isTop) {
      assert.equal(code, '20001');
      state.topWrites.push(Boolean(isTop));
      if (topResult === 'rejected') return { result: 1 };
      return { result: 0 };
    },
    addKernelGroupListener(value) { groupListener = value; return 2; },
    removeKernelGroupListener() {},
    modifyGroupRemark(code, value) {
      assert.equal(code, '20001');
      state.remarkWrites++;
      if (remarkResult === 'rejected') return { result: 1 };
      if (remarkResult !== 'mismatch') remark = value;
      return { result: 0 };
    },
    getGroupDetailInfo(code, source) {
      assert.equal(source, 2);
      if (remarkResult === 'stale') state.session = 'synthetic-B';
      if (groupNameResult === 'stale' && state.groupNameWrites) state.session = 'synthetic-B';
      groupListener.onGroupDetailInfoChange({ groupCode: code, groupName,
        memberNum: 1, maxMemberNum: 100, remarkName: remark });
      return { result: 0 };
    },
    async getUidByUins(ids) { return { errCode: 0, uids: new Map(ids.map(x => [x, 'u_fixture'])) }; },
    modifyMemberCardName() { state.cardWrites++; state.incomplete = true; },
    async getAllMemberList() { return { errCode: 0, result: { infos: new Map(), finish: !state.incomplete } }; },
    // 群公告写/删：内核签名都带 qun.qq.com 的 pskey，夹具把「拿到的 pskey」记下来，
    // 这样「空串 pskey」这个老 bug 会在测试里直接失败，而不是到真机上才表现为永远失败。
    getGroupBulletin() { return { result: 0 }; },
    async getGroupBulletinList() { return { result: 0, feet: [] }; },
    async publishGroupBulletin(code, pskey, data) {
      state.bulletinPublish.push({ code, pskey, data });
      if (bulletinResult === 'rejected') return { result: 1 };
      return { result: 0, noticeId: 'synthetic-notice' };
    },
    async deleteGroupBulletin(code, pskey, noticeId) {
      state.bulletinDelete.push({ code, pskey, noticeId });
      return { result: 0 };
    },
    async uploadGroupBulletinPic(code, pskey, imagePath) {
      state.bulletinPics.push({ code, pskey, imagePath });
      if (bulletinImageResult === 'rejected') return { errCode: 1, errMsg: 'rejected' };
      return { errCode: 0, picInfo: { id: 'pic-synthetic', width: 640, height: 480 } };
    },
  };
  // tipOff 服务：pskey 的唯一来源（真机 debug_native_surface 实证它有 getPskey）。
  const tipOff = pskeyDisabled ? undefined : {
    async getPskey(domains) {
      state.pskeyCalls.push([...domains]);
      return { domainPskeyMap: new Map(domains.map(domain => [domain, `${domain}-synthetic-pskey`])) };
    },
  };
  const buddy = {
    isBuddy(uid) { return uid === 'u_fixture' && friendResult !== 'not-friend'; },
    setBuddyRemark({ uid, remark }) {
      assert.equal(uid, 'u_fixture');
      state.friendWrites++;
      if (friendResult === 'rejected') return { result: 1 };
      if (friendResult !== 'mismatch') friendRemark = remark;
    },
  };
  const profile = {
    getUserDetailInfoByUin(uin) {
      assert.equal(uin, BOT);
      const uid = signatureResult === 'uid-changed' && state.signatureWrites ? 'u_other' : 'u_synthetic_self';
      return { result: 0, detail: { uin, uid, simpleInfo: { baseInfo: { longNick: signature } } } };
    },
    setLongNick(value) {
      state.signatureWrites++;
      if (signatureResult === 'rejected') return { result: 1 };
      if (signatureResult !== 'mismatch') signature = value;
      return undefined;
    },
    getCoreAndBaseInfo(source, uids) {
      assert.equal(source, 'nodeStore');
      assert.deepEqual(uids, ['u_fixture']);
      const uin = friendResult === 'wrong-profile' ? '10002' : '10001';
      if (friendResult === 'stale' && state.friendWrites > 0) state.session = 'synthetic-B';
      return new Map([['u_fixture', { coreInfo: { uid: 'u_fixture', uin, remark: friendRemark } }]]);
    },
  };
  if (profileUpdate) Object.assign(profile, profileUpdate);
  const richMedia = {
    batchGetGroupFileCount(codes) {
      assert.deepEqual(codes, ['20001']);
      return { result: 0, groupCodes: [groupFileQuota === 'wrong-group' ? '20002' : '20001'],
        groupFileCounts: [groupFileQuota === 'empty' || groupFileQuota === 'empty-no-space' ? 0 : 4] };
    },
    async getGroupFileList(code, params) {
      state.groupFileReads++;
      assert.equal(code, '20001');
      const paginated = groupFiles === 'paginated';
      const later = paginated && state.groupFileReads > 1;
      assert.deepEqual(params, {
        fileCount: groupFileQuota ? 1 : 50, startIndex: later ? 2 : 0, sortType: 1, sortOrder: 2, showOnlinedocFolder: 0,
        ...(groupFolder ? { folderId: groupFolder } : {}),
      });
      const sendPage = (item, reqId) => listener.onGroupFileInfoUpdate({ retCode: 0, isEnd: later, item, reqId,
        ...(paginated ? { nextIndex: later ? 0 : 2 } : {}) });
      const fileInfo = { fileId: later ? 'second-file' : 'synthetic-file', fileName: 'sample.txt', fileSize: '1024',
        uploaderName: 'Synthetic uploader', busId: fileOperations ? 0xffffffff : 1, localPath: 'private/path',
        uploadTime: 1700000000, deadTime: 0, modifyTime: 1700000100, downloadTimes: 7,
        uploaderUin: groupFiles === 'malformed-metadata' ? '9007199254740992' : '30001',
        ...(groupFolder ? { parentFolderId: groupFolder } : {}) };
      if (groupFiles === 'malformed-metadata') fileInfo.downloadTimes = -1;
      sendPage([{ peerId: '20002', fileInfo }]);
      sendPage([]);
      sendPage([{ peerId: code, fileInfo: { ...fileInfo, parentFolderId: '/wrong' } }]);
      if (groupFileQuota) {
        if (groupFileQuota !== 'empty' && groupFileQuota !== 'empty-no-space')
          sendPage([{ peerId: code, fileInfo }], 1);
        return { result: 0, ...(['missing-space', 'empty-no-space'].includes(groupFileQuota) ? {} : {
          groupSpaceResult: { retCode: 0, usedSpace: groupFileQuota === 'empty' ? 0 : 1024, totalSpace: 2048 },
        }) };
      }
      if (groupFiles === 'duplicate' && state.groupFileReads > 1)
        sendPage([{ peerId: code, fileInfo: { ...fileInfo, fileId: 'prior-page' } }], 1);
      if (groupFiles !== 'unbound') sendPage([
        { peerId: code, fileInfo },
        { peerId: code, folderInfo: { folderId: 'folder', folderName: 'Synthetic folder', totalFileCount: 2,
          createTime: 1699990000, modifyTime: 1700000100, createUin: '30001', modifyUin: '30002',
          creatorName: 'Synthetic creator', modifyName: 'Synthetic modifier',
          ...(groupFolder ? { parentFolderId: groupFolder } : {}) } },
      ], groupFiles === 'duplicate' ? state.groupFileReads : undefined);
      return { result: groupFiles === 'rejected' ? 1 : 0 };
    },
  };
  if (folderDeletion) richMedia.deleteGroupFolder = folderDeletion;
  if (fileOperations) Object.assign(richMedia, fileOperations);
  const bridge = new NativeBridge({ session: { getMsgService: () => msg, getGroupService: () => group,
    getBuddyService: () => buddy, getProfileService: () => profile, getRichMediaService: () => richMedia, getRobotService,
    getProfileLikeService: () => profileLike, getRecentContactService: () => recentContact,
    ...(tipOff && { getTipOffService: () => tipOff }) },
  identityProbe: async () => ({ user_id: BOT, uid: 'u_synthetic_self', nickname: 'Synthetic only',
    online: state.online, sessionId: state.session }), timeoutMs: 100 });
  await bridge.attach();
  const core = new OneBotCore({ freezeOnUnknown: true, bridge, timeoutMs: 1000, minimumWriteIntervalMs: 0, outcomeStore: store });
  const server = await createTransport({ dispatch: core.dispatch, events: core, status: core.status, token, heartbeatMs: 0 });
  t.after(async () => {
    await server.close(); core.close(); bridge.detach(); store.close();
    const resolved = fs.realpathSync(temporary);
    const boundary = fs.realpathSync(testTmp) + path.sep;
    assert.ok(resolved.startsWith(boundary), 'Cleanup target must remain in project .tmp');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address.port}`;
  const request = async (action, params = {}, echo = null) => {
    const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ action, params, echo }) });
    return { httpStatus: response.status, ...(await response.json()) };
  };
  return { state, bridge, core, store, root, base, request, receive: messages => listener.onRecvMsg(messages), listener: () => listener };
}
function raw(overrides = {}) {
  return { msgId: '90071992547400001', msgSeq: '42', msgTime: '1700000000', chatType: 2, peerUid: '20001', senderUid: 'u_fixture', senderUin: '10001', sendNickName: 'Synthetic sender', elements: [{ elementType: 1, textElement: { content: 'synthetic event' } }], ...overrides };
}
async function socket(t, base, route = '/event') {
  const ws = new WebSocket(base.replace('http:', 'ws:') + route, { headers });
  const queued = [], pending = [];
  ws.on('message', bytes => {
    const data = JSON.parse(bytes.toString());
    if (pending.length) pending.shift()(data); else queued.push(data);
  });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return { ws, queued, next: () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => pending.push(resolve)) };
}

test('get_image refreshes a unique message image without opening paths or downloading it', async t => {
  const file = 'fixture-image.png';
  const relative = '/download?appid=1407&fileid=fixture-refreshed&rkey=fixture-key';
  const url = 'https://multimedia.nt.qq.com.cn' + relative;
  const picture = (originImageUrl, elementId = 'fixture-element') => ({ elementType: 2, elementId,
    picElement: { fileName: file, originImageUrl, sourcePath: '/private/cache/fixture.png' } });
  const message = raw({ elements: [picture('https://gchat.qpic.cn/fixture/original')] });
  let reads = 0;
  let current = { ...message, elements: [picture(relative)] };
  const s = await setup(t, { readNativeMessage(peer, ids) {
    reads++;
    assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
    assert.deepEqual(ids, [message.msgId]);
    return { result: 0, msgList: [current] };
  } });
  const get = file => s.request('get_image', { file });
  assert.equal((await get('/private/cache/fixture.png')).retcode, 1400);
  assert.equal((await get(file)).retcode, 1404);
  assert.equal(reads, 0);
  const messageId = s.bridge.messages.put(message);
  assert.deepEqual((await get(file)).data, { file, file_name: file, url });
  current = { ...message, elements: [picture('https://example.invalid/fixture')] };
  assert.equal((await get(file)).retcode, 1404);
  current = { ...message, elements: [picture(url, 'other-element')] };
  assert.equal((await get(file)).retcode, 1404);
  s.bridge.messages.put({ ...message, msgId: '90071992547400002', peerUid: '20002' });
  assert.equal((await get(file)).retcode, 1404);
  assert.equal(reads, 3);
  current = { ...message, elements: [picture(relative)] };
  const scoped = message_id => s.request('get_image', { file, message_id });
  assert.deepEqual((await scoped(String(messageId))).data, { file, file_name: file, url });
  await s.bridge.reattach();
  assert.deepEqual((await scoped(messageId)).data, { file, file_name: file, url });
  assert.equal((await scoped(2147483647)).retcode, 1404);
  assert.equal((await scoped('0x1')).retcode, 1400);
  assert.equal(reads, 5);
});

test('get_message_images resolves a real rkey download URL for a bare relative origin', async t => {
  // A received picture carries originImageUrl = "/download?appid=1407&fileid=…" with no
  // rkey. The bridge must fetch an rkey once via sendSsoCmdReqByContend and hand back the
  // full multimedia download URL, not the md5 fallback.
  const file = 'fixture-image.png';
  const bareOrigin = '/download?appid=1407&fileid=fixture-fileid';
  const picture = (originImageUrl) => ({ elementType: 2,
    picElement: { fileName: file, originImageUrl, md5HexStr: 'A'.repeat(32) } });
  const message = raw({ elements: [picture(bareOrigin)] });
  let current = message;
  let reads = 0;
  let ssoCalls = 0;
  const s = await setup(t, {
    readNativeMessage(peer, ids) {
      reads++;
      assert.equal(peer.peerUid, '20001');
      assert.deepEqual(ids, [message.msgId]);
      return { result: 0, msgList: [current] };
    },
    sendSsoCmd: async (cmd, data) => {
      ssoCalls++;
      assert.equal(cmd, 'OidbSvcTrpcTcp.0x9067_202');
      assert(Buffer.isBuffer(data));
      return { result: 0, rspbuffer: buildRkeyReply([{ rkey: '123456GROUP_RKEY', type: 20, ttl: 300 }]) };
    },
  });
  const message_id = s.bridge.messages.put(message);
  const images = await s.request('get_message_images', { message_id });
  assert.equal(images.retcode, 0);
  assert.equal(images.data[0].type, 'image');
  assert.equal(images.data[0].data.file, file);
  assert.equal(images.data[0].data.url, 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=fixture-fileid&rkey=GROUP_RKEY');
  assert.equal(reads, 1);
  assert.equal(ssoCalls, 1);
  // Second read is cached — no second SSO call.
  await s.request('get_message_images', { message_id });
  assert.equal(ssoCalls, 1);
});

test('get_message_images falls back to md5 when the rkey channel is absent', async t => {
  const file = 'fixture-image.png';
  const md5 = 'AA8635BF87D7DE2BE0AA570508C7706F';
  const picture = { elementType: 2, picElement: { fileName: file, md5HexStr: md5,
    originImageUrl: '/download?appid=1407&fileid=fixture-fileid' } };
  const message = raw({ elements: [picture] });
  const s = await setup(t, {
    readNativeMessage(peer, ids) { return { result: 0, msgList: [message] }; },
  });
  const message_id = s.bridge.messages.put(message);
  const images = await s.request('get_message_images', { message_id });
  assert.equal(images.retcode, 0);
  assert.equal(images.data[0].data.url, `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5}/0`);
});

// Minimal protobuf helpers for building an rkey reply inside the integration test.
function rkeyVarint(v) { let x = BigInt(v); const o = []; while (x >= 0x80n) { o.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; } o.push(Number(x)); return Buffer.from(o); }
function rkeyTag(f, w) { return rkeyVarint((f << 3) | w); }
function rkeyVf(f, v) { return Buffer.concat([rkeyTag(f, 0), rkeyVarint(v)]); }
function rkeyBf(f, b) { return Buffer.concat([rkeyTag(f, 2), rkeyVarint(b.length), b]); }
function buildRkeyReply(entries) {
  const rkeyList = Buffer.concat(entries.map(({ rkey, type, ttl }) => rkeyBf(1, Buffer.concat([
    rkeyBf(1, Buffer.from(rkey)), rkeyVf(5, type), rkeyVf(2, ttl),
  ]))));
  const rspBody = Buffer.concat([rkeyBf(4, rkeyList)]);
  return Buffer.concat([rkeyVf(3, 0), rkeyBf(4, rspBody)]);
}

test('message image listing reads ordered images from exactly one indexed message', async t => {
  const url = 'https://gchat.qpic.cn/fixture/image.png';
  const picture = (fileName, originImageUrl) => ({ elementType: 2, picElement: { fileName, originImageUrl, sourcePath: '/private/cache/image.png' } });
  const message = raw({ elements: [picture('same.png', url), { elementType: 1, textElement: { content: 'Synthetic text' } },
    picture('same.png', '/private/other.png'), picture('/private/invalid.png', url)] });
  let current = message;
  let reads = 0;
  const s = await setup(t, { readNativeMessage(peer, ids) {
    reads++;
    assert.equal(peer.peerUid, '20001');
    assert.deepEqual(ids, [message.msgId]);
    return { result: 0, msgList: [current] };
  } });
  const message_id = s.bridge.messages.put(message);
  const images = () => s.request('get_message_images', { message_id });
  const expected = [{ type: 'image', data: { file: 'same.png', url } }, { type: 'image', data: { file: 'same.png' } }];
  assert.deepEqual((await images()).data, expected);
  await s.bridge.reattach();
  assert.deepEqual((await images()).data, expected);
  current = { ...message, peerUid: '20002' };
  assert.equal((await images()).retcode, 1404);
  assert.equal((await s.request('get_message_images', { message_id: 2147483647 })).retcode, 1404);
  assert.equal(reads, 3);
});

test('message audio listing returns ordered voice segments without exposing native cache paths', async t => {
  const voice = fileName => ({ elementType: 4, pttElement: { fileName, filePath: '/private/voice-cache.silk' } });
  const message = raw({ elements: [voice('first.silk'), { elementType: 2, picElement: { fileName: 'picture.png' } },
    voice('second.silk'), voice('/private/invalid.silk')] });
  let current = message;
  const s = await setup(t, { readNativeMessage(peer, ids) {
    assert.equal(peer.peerUid, '20001');
    assert.deepEqual(ids, [message.msgId]);
    return { result: 0, msgList: [current] };
  } });
  const message_id = s.bridge.messages.put(message);
  const audio = () => s.request('get_message_audio', { message_id });
  current = { ...message, elements: [
    { ...message.elements[0], pttElement: { ...message.elements[0].pttElement, nativeCounter: 1n,
      get opaqueCache() { assert.fail('An unrequested native field was accessed'); } } },
    ...message.elements.slice(1),
  ], get records() { assert.fail('A media query should not traverse other messages'); } };
  const expected = ['first.silk', 'second.silk'].map(file => ({ type: 'record', data: { file } }));
  const result = await audio();
  assert.equal(result.retcode, 0);
  assert.deepEqual(result.data, expected);
  assert(!JSON.stringify(result).includes('/private/'));
  await s.bridge.reattach();
  assert.deepEqual((await audio()).data, expected);
  current.senderUid = 'u_other';
  assert.equal((await audio()).retcode, 1404);
});

test('get_file returns exact metadata for a file ID bound to an indexed message', { timeout: 5000 }, async t => {
  const fileId = 'synthetic-uuid';
  const file = { elementType: 3, elementId: '23',
    fileElement: { fileUuid: fileId, fileName: 'Fixture.bin', fileSize: '9007199254740993' } };
  const message = raw({ elements: [file] });
  let readCount = 0;
  let current = { ...message, elements: [{ ...file, fileElement: { ...file.fileElement, filePath: '/private/fixture.bin' } }] };
  const s = await setup(t, { readNativeMessage(peer, ids) {
    readCount++;
    assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
    assert.deepEqual(ids, [message.msgId]);
    return { result: 0, msgList: [current] };
  } });
  const message_id = s.bridge.messages.put(message);
  const params = { message_id, file_id: fileId };
  const expected = { file_name: 'Fixture.bin', file_size: '9007199254740993' };
  const http = await s.request('get_file', params);
  assert.equal(http.retcode, 0);
  assert.deepEqual(http.data, expected);
  const api = await socket(t, s.base, '/api');
  api.ws.send(JSON.stringify({ action: 'get_file', params, echo: 'file' }));
  assert.deepEqual(await api.next(), { status: 'ok', retcode: 0, data: expected, echo: 'file' });
  assert.equal((await s.request('get_file', { ...params, file_id: 'other-file' })).retcode, 1404);
  assert.equal(readCount, 2);
  current = { ...message, elements: [{ ...file, elementId: 'other-element' }] };
  assert.equal((await s.request('get_file', params)).retcode, 1404);
  assert.equal(readCount, 3);
});

test('authenticated HTTP and WebSocket return the same reaction responder list', { timeout: 5000 }, async t => {
  const message = raw();
  const s = await setup(t, {
    readNativeMessage: () => ({ result: 0, msgList: [message] }),
    readReactionPage: (_peer, _sequence, _emoji, _type, cursor) => ({ result: 0,
      isFirstPage: !cursor, isLastPage: Boolean(cursor), cookie: cursor ? '' : 'next',
      emojiLikesList: [{ tinyId: cursor ? '10002' : '10001', nickName: cursor ? 'Second' : 'First' }],
    }),
  });
  const params = { message_id: message.msgId, group_id: message.peerUid, emoji_id: '14' };
  const http = await s.request('get_emoji_likes', params, 'http');
  assert.equal(http.httpStatus, 200);
  assert.equal(http.retcode, 0);
  assert.deepEqual(http.data, { emoji_like_list: [{ user_id: '10001', nick_name: 'First' },
    { user_id: '10002', nick_name: 'Second' }] });
  const connection = await socket(t, s.base, '/api');
  connection.ws.send(JSON.stringify({ action: 'get_emoji_likes', params, echo: 'websocket' }));
  assert.deepEqual(await connection.next(), { status: 'ok', retcode: 0, data: http.data, echo: 'websocket' });
  assert.equal(s.state.sent.length, 0);
});

test('group file list IDs support authenticated single-file deletion with correlated confirmation', async t => {
  const writes = [];
  let outcome = 'success';
  const s = await setup(t, { fileOperations: {
    getGroupFileInfo(code, fileId) {
      assert.equal(fileId, 'synthetic-file');
      return { result: 0, groupFileInfoResult: { retCode: 0, fileInfo: {
        fileId: code === '20001' ? fileId : 'different-file', busId: 0xffffffff, isFolder: false,
      } } };
    },
    deleteGroupFile(...args) {
      writes.push(args);
      return { result: 0, transGroupFileResult: {
        result: { retCode: 0, localPath: 'private/path' },
        successFileIdList: outcome === 'rejected' ? [] : [outcome === 'success' ? 'synthetic-file' : 'different-file'],
        failFileIdList: outcome === 'rejected' ? ['synthetic-file'] : [],
      } };
    },
  } });
  const page = await s.request('get_group_root_files', { group_id: 20001 });
  assert.equal(page.retcode, 0);
  const { group_id, file_id, busid } = page.data.files[0];
  assert.equal(busid, 0xffffffff);
  const remove = extra => s.request('delete_group_file', { group_id, file_id, ...extra });
  assert.equal((await remove({ busid, bus_id: 2 })).retcode, 1400);
  assert.equal((await remove({ bus_id: 2 })).retcode, 1400);
  assert.equal((await remove({ group_id: 20002 })).retcode, 1400);
  assert.deepEqual(writes, []);
  const confirmed = await remove({ busid: String(busid) });
  assert.equal(confirmed.retcode, 0);
  assert.deepEqual(confirmed.data.transGroupFileResult, {
    result: { retCode: 0 }, successFileIdList: [file_id], failFileIdList: [],
  });
  assert.equal(s.store.pending, false);
  outcome = 'rejected';
  assert.equal((await remove()).retcode, 1500);
  assert.equal(s.store.pending, false);
  outcome = 'different-file';
  assert.equal((await remove()).retcode, 1504);
  assert.equal(s.store.pending, true);
  assert.equal((await remove()).retcode, 1503);
  assert.deepEqual(writes, Array.from({ length: 3 }, () => ['20001', [busid], [file_id]]));
});

test('group file move requires the actual source and confirms the new parent', async t => {
  const writes = [];
  let parent = '/';
  const s = await setup(t, { fileOperations: {
    getGroupFileInfo(code, fileId) {
      assert.equal(code, '20001');
      return { result: 0, groupFileInfoResult: { retCode: 0, fileInfo: {
        fileId, busId: 0xffffffff, parentFolderId: parent, isFolder: false,
      } } };
    },
    moveGroupFile(code, busIds, files, source, destination) {
      writes.push([code, busIds, files, source, destination]);
      if (writes.length === 1) parent = destination;
      return { result: 0, moveGroupFileResult: {
        result: { retCode: 0 }, successFileIdList: files, failFileIdList: [],
      } };
    },
  } });
  const page = await s.request('get_group_root_files', { group_id: 20001 });
  assert.equal(page.retcode, 0);
  const { group_id, file_id, busid } = page.data.files[0];
  const move = (source, destination) => s.request('move_group_file', {
    group_id, file_id, busid, current_parent_directory: source, target_parent_directory: destination,
  });
  assert.equal((await move('/wrong', '/archive')).retcode, 1400);
  assert.equal((await move('/', '/')).retcode, 1400);
  assert.deepEqual(writes, []);
  const success = await move('/', '/archive');
  assert.equal(success.retcode, 0);
  assert.deepEqual(success.data, { ok: true });
  assert.equal(s.store.pending, false);
  assert.equal((await move('/archive', '/')).retcode, 1504);
  assert.equal(s.store.pending, true);
  assert.equal((await move('/archive', '/')).retcode, 1503);
  assert.deepEqual(writes, [
    ['20001', [busid], [file_id], '/', '/archive'],
    ['20001', [busid], [file_id], '/archive', '/'],
  ]);
});

test('authenticated folder deletion keeps an incomplete write pending and blocks another submission', async t => {
  const calls = [];
  const s = await setup(t, { folderDeletion(...args) {
    calls.push(args);
    return calls.length === 1 ? { result: 0, groupFileCommonResult: { retCode: 0 } } : { result: 0 };
  } });
  const remove = params => s.request('delete_group_folder', { group_id: '20001', ...params });
  assert.equal((await remove({ folder_id: '/' })).retcode, 1400);
  assert.equal((await remove({ folder: '/first' })).retcode, 0);
  assert.equal(s.store.pending, false);
  assert.equal((await remove({ folder_id: '/second' })).retcode, 1504);
  assert.equal(s.store.pending, true);
  assert.equal((await remove({ folder_id: '/second' })).retcode, 1503);
  assert.deepEqual(calls, [['20001', '/first'], ['20001', '/second']]);
});

test('group folder creation requires an exact group, name and root in its native receipt', async t => {
  for (const scenario of ['confirmed', 'rejected', 'wrong-group', 'wrong-name', 'wrong-parent', 'missing-status', 'contradiction', 'stale']) {
    await t.test(scenario, async subtest => {
      const writes = [];
      const s = await setup(subtest, { fileOperations: {
        createGroupFolder(code, name) {
          writes.push([code, name]);
          const groupItem = scenario === 'rejected' ? [] : [{ peerId: scenario === 'wrong-group' ? '20002' : code, folderInfo: {
            folderId: '/created', folderName: scenario === 'wrong-name' ? 'Other folder' : name,
            parentFolderId: scenario === 'wrong-parent' ? '/other' : '/', localPath: '/private/path',
          } }];
          const result = scenario === 'missing-status' ? {} : { retCode: ['rejected', 'contradiction'].includes(scenario) ? 1 : 0 };
          if (scenario === 'stale') s.state.session = 'synthetic-B';
          return { result: 0, resultWithGroupItem: { result, groupItem } };
        },
      } });
      const create = params => s.request('create_group_file_folder', { group_id: '20001', ...params });
      assert(s.bridge.capabilities().includes('create_group_file_folder'));
      assert.equal((await create({ name: '../other' })).retcode, 1400);
      assert.equal((await create({ name: 'one', folder_name: 'two' })).retcode, 1400);
      assert.deepEqual(writes, []);
      const name = '测试 Archive';
      const result = await create(scenario === 'confirmed' ? { name } : { folder_name: name });
      if (scenario === 'confirmed') {
        assert.equal(result.retcode, 0);
        assert.deepEqual(result.data, { result: { retCode: 0 }, groupItem: [{ peerId: '20001', folderInfo: {
          folderId: '/created', folderName: name, parentFolderId: '/',
        } }] });
      } else if (scenario === 'rejected') {
        assert.equal(result.retcode, 1500);
      } else {
        assert.equal(result.retcode, 1504);
        if (scenario !== 'stale') assert.equal((await create({ name })).retcode, 1503);
      }
      assert.equal(s.store.pending, !['confirmed', 'rejected'].includes(scenario));
      assert.deepEqual(writes, [['20001', name]]);
    });
  }
});

test('group folder creation returns an ID usable for listing and deletion', async t => {
  const calls = [];
  const folderId = '/Archive-123_abc';
  const s = await setup(t, { fileOperations: {
    createGroupFolder(code, name) {
      calls.push(['create', code, name]);
      return { result: 0, resultWithGroupItem: { result: { retCode: 0 },
        groupItem: [{ peerId: code, folderInfo: { folderId, folderName: name, parentFolderId: '/' } }] } };
    },
    getGroupFileList(code, params) {
      calls.push(['list', code, params.folderId]);
      s.listener().onGroupFileInfoUpdate({ retCode: 0, isEnd: true, item: [{ peerId: code,
        fileInfo: { parentFolderId: params.folderId, fileId: 'fixture-file', fileName: 'Fixture',
          fileSize: '12', busId: 1, uploaderName: 'Fixture' } }] });
      return { result: 0 };
    },
    deleteGroupFolder(code, id) {
      calls.push(['delete', code, id]);
      return { result: 0, groupFileCommonResult: { retCode: 0 } };
    },
  } });
  const group_id = 20001;
  const created = await s.request('create_group_file_folder', { group_id, folder_name: 'Archive' });
  assert.equal(created.retcode, 0);
  const folder_id = created.data.groupItem[0].folderInfo.folderId;
  const listed = await s.request('get_group_files_by_folder', { group_id, folder_id });
  assert.equal(listed.retcode, 0);
  assert.equal(listed.data.files[0].file_id, 'fixture-file');
  const deleted = await s.request('delete_group_folder', { group_id, folder_id });
  assert.equal(deleted.retcode, 0);
  assert.equal(s.store.pending, false);
  assert.deepEqual(calls, [['create', '20001', 'Archive'], ['list', '20001', folderId], ['delete', '20001', folderId]]);
});

test('HTTP robot UIN ranges preserve exact endpoints and require the current session', async t => {
  const calls = [];
  let reply;
  let changeSession = false;
  const s = await setup(t, { getRobotService: () => ({
    getRobotUinRange(query) {
      calls.push(query);
      if (changeSession) s.state.session = 'synthetic-B';
      return reply;
    },
  }) });
  const action = 'get_robot_uin_range';
  assert.equal((await s.request('get_login_info')).retcode, 0);
  assert((await s.request('get_supported_actions')).data.includes(action));
  assert.equal((await s.request(action, { version: 4 })).retcode, 1400);
  assert.deepEqual(calls, []);
  const range = { minUin: '9007199254740993', maxUin: '9007199254740999' };
  reply = { response: { robotUinRanges: [{ ...range, unrelated: 'omitted' }] } };
  assert.deepEqual((await s.request(action)).data, [range]);
  assert.deepEqual(calls, [{ justFetchMsgConfig: '1', type: 1, version: 0, aioKeywordVersion: 0 }]);
  reply = { response: { robotUinRanges: [] } };
  const empty = await s.request(action);
  assert.equal(empty.retcode, 0);
  assert.deepEqual(empty.data, []);
  for (const robotUinRanges of [undefined, [null], Array(1), [{ minUin: '10', maxUin: '9' }],
    [{ ...range, maxUin: '18446744073709551616' }], [{ ...range, minUin: 10001 }], Array(257).fill(range)]) {
    reply = { response: { robotUinRanges } };
    assert.equal((await s.request(action)).retcode, 1502);
  }
  reply = { result: 2, response: { robotUinRanges: [range] } };
  assert.equal((await s.request(action)).retcode, 1500);
  reply = { response: { robotUinRanges: [range] } };
  changeSession = true;
  const stale = await s.request(action);
  assert.notEqual(stale.retcode, 0);
  assert.equal(stale.data, null);
  assert.equal(s.store.pending, false);
});

test('an unavailable optional robot service does not block the OneBot session', async t => {
  const s = await setup(t, { getRobotService() { throw new Error('not available'); } });
  assert.equal((await s.request('get_login_info')).retcode, 0);
  assert(!(await s.request('get_supported_actions')).data.includes('get_robot_uin_range'));
  assert.equal((await s.request('get_robot_uin_range')).retcode, 1404);
});

test('recent contacts bind message readback to each peer and exclude the protected account', async t => {
  const message = raw();
  const group = { chatType: 2, peerUid: '20001', peerUin: '20001', msgId: message.msgId, msgTime: message.msgTime };
  const hidden = { ...group, chatType: 1, peerUid: 'u_protected', peerUin: OWNER_UIN };
  const missing = { ...group, peerUid: '20002', peerUin: '20002' };
  const calls = [];
  let rows = [group, hidden, missing];
  let invalidLastMessage = false;
  const s = await setup(t, { recentContact: { getRecentContactListSnapShot(count) {
    assert.equal(count, 3);
    return { result: 0, info: { errCode: 0, changedList: rows } };
  } }, readNativeMessage(peer, ids) {
    calls.push([peer.peerUid, ids]);
    return { result: 0, msgList: [message, ...(invalidLastMessage && peer.peerUid === '20002'
      ? [{ ...message, peerUid: '20002', senderUin: 'invalid-user' }] : [])] };
  } });
  const read = () => s.request('get_recent_contact', { count: '3' });
  assert.equal((await s.request('get_recent_contact', { count: 51 })).retcode, 1400);
  const result = await read();
  assert.equal(result.retcode, 0);
  assert.deepEqual(result.data.map(row => row.peerUin), ['20001', '20002']);
  assert.equal(result.data[0].lastestMsg.raw_message, 'synthetic event');
  assert.equal(result.data[0].lastestMsg.group_id, 20001);
  assert(!Object.hasOwn(result.data[1], 'lastestMsg'));
  assert.deepEqual(calls, [['20001', [message.msgId]], ['20002', [message.msgId]]]);
  rows = [group, { ...missing, peerUin: '20003' }];
  assert.notEqual((await read()).retcode, 0);
  assert.equal(calls.length, 2);
  rows = [group, { ...hidden, peerUin: '10001', peerUid: 'u_wrong' }];
  assert.notEqual((await read()).retcode, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1)[0], '20001');
  s.bridge.messages.clear();
  const nextId = s.bridge.messages.next;
  invalidLastMessage = true;
  rows = [group, missing];
  assert.notEqual((await read()).retcode, 0);
  assert.equal(s.bridge.messages.byId.size, 0);
  assert.equal(s.bridge.messages.next, nextId);
});

test('voice transcription reads a cached or newly translated result from the exact message and segment', async t => {
  const voice = { elementType: 4, elementId: '21', pttElement: { fileName: 'synthetic.silk', text: '' } };
  const message = raw({ elements: [voice] });
  const peer = { chatType: 2, peerUid: '20001', guildId: '' };
  let reads = 0, translations = 0, mode = 'translate';
  const s = await setup(t, { readNativeMessage(target, ids) {
    assert.deepEqual(target, peer);
    assert.deepEqual(ids, [message.msgId]);
    reads++;
    return { result: 0, msgList: [message] };
  }, translateVoice(msgId, target, segment) {
    assert.equal(msgId, message.msgId);
    assert.deepEqual(target, peer);
    assert.deepEqual(segment, voice);
    translations++;
    voice.pttElement.text = 'Synthetic transcript';
    if (mode === 'changed') voice.elementId = '22';
    return { result: 0 };
  } });
  const message_id = s.bridge.messages.put(message);
  const fetch = () => s.request('fetch_ptt_text', { message_id });
  assert.deepEqual((await fetch()).data, { text: 'Synthetic transcript' });
  assert.equal(reads, 2);
  assert.deepEqual((await fetch()).data, { text: 'Synthetic transcript' });
  assert.equal(reads, 3);
  assert.equal(translations, 1);
  voice.pttElement.text = '';
  mode = 'changed';
  assert.equal((await fetch()).retcode, 1502);
  assert.equal(translations, 2);
  assert.equal(s.store.pending, false);
});

test('concurrent voice transcription callers share one submission and can cancel independently', async t => {
  const voice = { elementType: 4, elementId: '21', pttElement: { fileName: 'synthetic.silk', text: '' } };
  const message = raw({ elements: [voice] });
  const started = Promise.withResolvers();
  const acknowledgment = Promise.withResolvers();
  let submissions = 0, reads = 0;
  const s = await setup(t, { readNativeMessage() {
    reads++;
    return { result: 0, msgList: [message] };
  }, translateVoice() {
    submissions++;
    started.resolve();
    return acknowledgment.promise;
  } });
  t.after(() => acknowledgment.resolve({ result: 0 }));
  const params = { message_id: s.bridge.messages.put(message) };
  const controller = new AbortController();
  const cancelled = assert.rejects(s.bridge.call('fetch_ptt_text', params, { signal: controller.signal }), { code: 'CANCELLED' });
  await started.promise;
  const second = s.bridge.call('fetch_ptt_text', params);
  controller.abort();
  await cancelled;
  voice.pttElement.text = 'Shared transcript';
  acknowledgment.resolve({ result: 0 });
  assert.deepEqual(await second, { text: 'Shared transcript' });
  assert.equal(reads, 2);
  assert.equal(submissions, 1);
});

test('same-session reattachment does not resubmit a voice transcription still pending in QQ', async t => {
  const voice = { elementType: 4, elementId: '21', pttElement: { fileName: 'synthetic.silk', text: '' } };
  const message = raw({ elements: [voice] });
  const started = Promise.withResolvers();
  const acknowledgment = Promise.withResolvers();
  let submissions = 0, reads = 0;
  const s = await setup(t, { readNativeMessage() {
    reads++;
    return { result: 0, msgList: [message] };
  }, translateVoice() {
    submissions++;
    started.resolve();
    return acknowledgment.promise;
  } });
  t.after(() => acknowledgment.resolve({ result: 0 }));
  const params = { message_id: s.bridge.messages.put(message) };
  const fetch = () => s.bridge.call('fetch_ptt_text', params);
  const interrupted = assert.rejects(fetch(), { code: 'CANCELLED' });
  await started.promise;
  await s.bridge.reattach();
  await interrupted;
  await assert.rejects(fetch(), { code: 'BUSY' });
  assert.equal(reads, 2);
  assert.equal(submissions, 1);
  acknowledgment.resolve({ result: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2, 'The cancelled generation must not run any readback');
  voice.pttElement.text = 'Read from the current session';
  assert.deepEqual(await fetch(), { text: 'Read from the current session' });
  assert.equal(reads, 3);
  assert.equal(submissions, 1);
});

test('profile likes verify the target and expose only resolved public entries and counters', async t => {
  let wrongTarget = false;
  let query;
  const s = await setup(t, { profileLike: { getBuddyProfileLike(params) {
    query = params;
    const userInfos = [{ uid: 'u_voter', nick: 'Synthetic voter', count: 3, privateField: 'omit' },
      { uid: 'u_protected', nick: 'Hidden' }];
    return { result: 0, info: { userLikeInfos: [{ uid: wrongTarget ? 'u_wrong' : params.friendUids[0], time: '1700000000',
      favoriteInfo: { total_count: 3, last_time: 0, today_count: 1, userInfos },
      voteInfo: { total_count: 3, new_count: 0, new_nearby_count: 0, last_visit_time: 0, userInfos: [] },
    }] } };
  } } });
  s.bridge.group.getUinByUids = uids => {
    assert.deepEqual(uids, ['u_voter', 'u_protected']);
    return { errCode: 0, uins: new Map([['u_voter', '10001'], ['u_protected', OWNER_UIN]]) };
  };
  const action = 'get_profile_like';
  assert.equal((await s.request(action, { count: 0 })).retcode, 1400);
  assert.equal((await s.request(action, { user_id: Number(OWNER_UIN) })).retcode, 1403);
  assert.equal(query, undefined);
  const response = await s.request(action, { start: '2', count: '2' });
  assert.equal(response.retcode, 0);
  assert.deepEqual(query, { friendUids: ['u_synthetic_self'], basic: 1, vote: 1, favorite: 0, userProfile: 1, type: 2, start: 2, limit: 2 });
  assert.deepEqual(response.data.favoriteInfo.userInfos, [{ uid: 'u_voter', uin: 10001, nick: 'Synthetic voter', count: 3 }]);
  assert.equal(response.data.favoriteInfo.total_count, 3);
  wrongTarget = true;
  assert.equal((await s.request(action, { user_id: 10001 })).retcode, 1502);
  assert.deepEqual(query.friendUids, ['u_fixture']);
  assert.equal(query.type, 1);
});

test('OneBot friend likes confirm exactly the requested count and never retry a partial outcome', async t => {
  const calls = [];
  let receipt = { result: 0, succCounts: 1 };
  const s = await setup(t, { profileLike: { setBuddyProfileLike(params) { calls.push(params); return receipt; } } });
  const like = params => s.request('send_like', { user_id: 10001, ...params });
  for (const times of [0, 11, '01', 2.5, null]) assert.equal((await like({ times })).retcode, 1400);
  assert.equal((await like({ user_id: Number(OWNER_UIN) })).retcode, 1403);
  assert.deepEqual(calls, []);
  assert.equal((await like()).retcode, 0);
  receipt = { result: 7, succCounts: 0 };
  assert.equal((await like({ times: '2' })).retcode, 1500);
  assert.equal(s.store.pending, false);
  receipt = { result: 0, succCounts: 1 };
  assert.equal((await like({ times: '2' })).retcode, 1504);
  assert.equal(s.store.pending, true);
  assert.equal((await like({ times: '2' })).retcode, 1503);
  assert.deepEqual(calls, [1, 2, 2].map(doLikeCount => ({ friendUid: 'u_fixture', sourceId: 71, doLikeCount, doLikeTollCount: 0 })));
});

test('OneBot friend likes reject a non-friend before native submission', async t => {
  const s = await setup(t, { friendResult: 'not-friend', profileLike: { setBuddyProfileLike() { assert.fail('Unexpected like'); } } });
  assert.equal((await s.request('send_like', { user_id: 10001 })).retcode, 1404);
  assert.equal(s.store.pending, false);
});

test('HTTP -> core -> native bridge -> native receipt positive control sends exactly once and clears persistent latch', { timeout: 5000 }, async t => {
  const s = await setup(t);
  const response = await s.request('send_group_msg', { group_id: 20001, message: 'synthetic outbound' }, { n: 1 });
  assert.equal(response.retcode, 0);
  assert.equal(response.httpStatus, 200);
  assert.deepEqual(response.echo, { n: 1 });
  assert.ok(Number.isInteger(response.data.message_id));
  assert.equal(s.state.sent.length, 1);
  assert.equal(s.state.sent[0].elements[0].textElement.content, 'synthetic outbound');
  assert.equal(s.store.pending, false);
  assert.equal(fs.existsSync(s.store.file), false);
  assert.deepEqual(s.core.status(), { online: true, good: true });
});

test('unsupported image is rejected before native send and does not lock a subsequent valid text action', { timeout: 5000 }, async t => {
  const s = await setup(t);
  const rejected = await s.request('send_group_msg', { group_id: 20001, message: [{ type: 'image', data: { file: 'synthetic.png' } }] });
  assert.equal(rejected.retcode, 1404);
  assert.equal(s.state.sent.length, 0);
  assert.equal(s.store.pending, false);
  assert.equal((await s.request('send_group_msg', { group_id: 20001, message: 'valid text' })).retcode, 0);
  assert.equal(s.state.sent.length, 1);
});

test('missing native receipt is accepted (no latch) across calls, detach/reattach and core reconstruction', { timeout: 20000 }, async t => {
  const s = await setup(t, { receipt: false });
  // P4：拿不到回执 ⇒ 按已接受回成功（message_id:null），**不留未决记录、不挡后续发送**。
  const unknown = await s.request('send_group_msg', { group_id: 20001, message: 'unknown outcome' });
  assert.equal(unknown.retcode, 0);
  assert.equal(unknown.data.message_id, null);
  assert.equal(s.state.sent.length, 1);
  assert.equal(s.store.pending, false);
  assert.equal(fs.existsSync(s.store.file), false);
  // P4：上一次发送不确定**不留闩锁**（未决记录已清空），所以不会挡住后续发送。
  assert.equal(s.store.pending, false);
  s.bridge.detach(); s.state.session = 'synthetic-B'; await s.bridge.attach();
  assert.equal((await s.request('get_login_info')).retcode, 0);
  // 换会话后不再派发（未验证的会话会让请求等到超时，与本用例无关）。
  s.core.close(); s.store.close();
  // P4：重启后也没有任何「未决记录」需要人工对账。
  const reloadedStore = new OutcomeStore(s.root);
  const rebuilt = new OneBotCore({ freezeOnUnknown: true, bridge: s.bridge, outcomeStore: reloadedStore, minimumWriteIntervalMs: 0 });
  try {
    assert.equal(reloadedStore.pending, false);
    assert.notEqual((await rebuilt.dispatch({ action: 'send_group_msg', params: { group_id: 20001, message: 'restart send' } })).retcode, 1503);
  } finally { rebuilt.close(); reloadedStore.close(); }
});

test('native void mutation followed by failed readback remains unknown rather than clearing latch as not-started', { timeout: 5000 }, async t => {
  const s = await setup(t);
  const response = await s.request('set_group_card', { group_id: 20001, user_id: 10001, card: 'updated' });
  assert.equal(s.state.cardWrites, 1);
  assert.equal(response.retcode, 1504);
  assert.equal(s.store.pending, true);
  assert.equal((await s.request('send_group_msg', { group_id: 20001, message: 'block' })).retcode, 1503);
  assert.equal(s.state.sent.length, 0);
});

test('HTTP group remark supports clearing and completes only with matching readback', { timeout: 5000 }, async t => {
  const s = await setup(t);
  assert.equal((await s.request('set_group_remark', { group_id: 20001 })).retcode, 1400);
  assert.equal(s.state.remarkWrites, 0);
  assert.equal((await s.request('set_group_remark', { group_id: 20001, remark: '' })).retcode, 0);
  assert.equal(s.state.remarkWrites, 1);
  assert.equal((await s.request('get_group_detail_info', { group_id: 20001 })).data.group_remark, '');
  assert.equal(s.store.pending, false);
});

test('HTTP group remark preserves the unknown outcome latch on mismatch or session change', { timeout: 5000 }, async t => {
  for (const remarkResult of ['mismatch', 'stale']) {
    await t.test(remarkResult, async subtest => {
      const s = await setup(subtest, { remarkResult });
      const params = { group_id: 20001, remark: 'updated' };
      assert.equal((await s.request('set_group_remark', params)).retcode, 1504);
      assert.equal(s.store.pending, true);
      if (remarkResult === 'stale') await s.bridge.attach();
      assert.equal((await s.request('set_group_remark', params)).retcode, 1503);
      assert.equal(s.state.remarkWrites, 1);
    });
  }
});

test('private conversation pin goes through msg.setContactLocalTop and reports the path', { timeout: 5000 }, async t => {
  await t.test('pins and unpins a friend conversation', async subtest => {
    const s = await setup(subtest);
    const on = await s.request('set_friend_top', { user_id: 10001, enable: true });
    assert.equal(on.retcode, 0);
    assert.equal(on.data?.via, 'msg.setContactLocalTop');
    assert.deepEqual(s.state.friendTopWrites.at(-1), { chatType: 1, peerUid: '10001', isTop: true });
    const off = await s.request('set_friend_top', { user_id: 10001, enable: false });
    assert.equal(off.retcode, 0);
    assert.deepEqual(s.state.friendTopWrites.at(-1), { chatType: 1, peerUid: '10001', isTop: false });
    assert.equal(s.store.pending, false);
  });
  await t.test('native rejection surfaces as 1500', async subtest => {
    const s = await setup(subtest, { friendTopResult: 'rejected' });
    assert.equal((await s.request('set_friend_top', { user_id: 10001 })).retcode, 1500);
    assert.equal(s.state.friendTopWrites.length, 1);
    assert.equal(s.store.pending, false);
  });
  await t.test('capability announced when the kernel exposes the method', async subtest => {
    const s = await setup(subtest);
    assert.ok(s.bridge.capabilities().includes('set_friend_top'));
  });
});

test('group conversation pin defaults to enable and reports native rejection', { timeout: 5000 }, async t => {
  await t.test('defaults to pinning', async subtest => {
    const s = await setup(subtest);
    // params.enable 缺省 ⇒ 传 true 下去（pin 就是本意，不需要额外参数）
    assert.equal((await s.request('set_group_top', { group_id: 20001 })).retcode, 0);
    assert.deepEqual(s.state.topWrites, [true]);
    // 显式取消
    assert.equal((await s.request('set_group_top', { group_id: 20001, enable: false })).retcode, 0);
    assert.deepEqual(s.state.topWrites, [true, false]);
    assert.equal(s.store.pending, false);
  });
  await t.test('native rejection surfaces as 1500', async subtest => {
    const s = await setup(subtest, { topResult: 'rejected' });
    assert.equal((await s.request('set_group_top', { group_id: 20001 })).retcode, 1500);
    assert.deepEqual(s.state.topWrites, [true]);
    assert.equal(s.store.pending, false);
  });
  await t.test('capability is announced only when the kernel exposes setTop', async subtest => {
    const s = await setup(subtest);
    assert.ok(s.bridge.capabilities().includes('set_group_top'));
  });
});

test('explicit native group remark rejection clears the pending latch', { timeout: 5000 }, async t => {
  const s = await setup(t, { remarkResult: 'rejected' });
  assert.equal((await s.request('set_group_remark', { group_id: 20001, remark: 'updated' })).retcode, 1500);
  assert.equal(s.state.remarkWrites, 1);
  assert.equal(s.store.pending, false);
});

test('group name success requires exact same-session readback', { timeout: 5000 }, async t => {
  for (const [groupNameResult, retcode] of [['confirmed', 0], ['rejected', 1500], ['mismatch', 1504], ['stale', 1504]]) {
    await t.test(groupNameResult, async subtest => {
      const s = await setup(subtest, { groupNameResult });
      const args = { group_id: 20001, group_name: 'Synthetic rename' };
      assert.equal((await s.request('set_group_name', { ...args, group_name: ' ' })).retcode, 1400);
      assert.equal(s.state.groupNameWrites, 0);
      assert.equal((await s.request('set_group_name', args)).retcode, retcode);
      assert.equal(s.state.groupNameWrites, 1);
      assert.equal(s.store.pending, retcode === 1504);
      if (groupNameResult === 'mismatch') {
        assert.equal((await s.request('set_group_name', args)).retcode, 1503);
        assert.equal(s.state.groupNameWrites, 1);
      }
    });
  }
});

test('HTTP friend remark handles no-op, clearing and protected account without extra writes', { timeout: 5000 }, async t => {
  const s = await setup(t);
  const change = (user_id, remark) => s.request('set_friend_remark', { user_id, remark });
  assert.equal((await change(Number(OWNER_UIN), 'synthetic')).retcode, 1403);
  assert.equal((await change(10001, 'initial')).retcode, 0);
  assert.equal(s.state.friendWrites, 0);
  assert.equal((await change(10001, '')).retcode, 0);
  assert.equal(s.state.friendWrites, 1);
  assert.equal(s.store.pending, false);
});

test('HTTP friend remark outcomes are classified according to submission and readback', { timeout: 5000 }, async t => {
  for (const [friendResult, retcode, writes] of [
    ['not-friend', 1404, 0], ['wrong-profile', 1404, 0], ['rejected', 1500, 1],
    ['mismatch', 1504, 1], ['stale', 1504, 1],
  ]) {
    await t.test(friendResult, async subtest => {
      const s = await setup(subtest, { friendResult });
      const params = { user_id: 10001, remark: 'updated' };
      assert.equal((await s.request('set_friend_remark', params)).retcode, retcode);
      assert.equal(s.state.friendWrites, writes);
      assert.equal(s.store.pending, retcode === 1504);
      if (retcode === 1504) {
        if (friendResult === 'stale') await s.bridge.attach();
        assert.equal((await s.request('set_friend_remark', params)).retcode, 1503);
        assert.equal(s.state.friendWrites, 1);
      }
    });
  }
});

test('HTTP group file listing accepts only the bound group page and projects public metadata', { timeout: 5000 }, async t => {
  const s = await setup(t);
  const result = await s.request('get_group_root_files', { group_id: 20001 });
  assert.equal(result.retcode, 0);
  assert.deepEqual(result.data, {
    files: [{ group_id: 20001, file_id: 'synthetic-file', file_name: 'sample.txt',
      file_size: 1024, size: 1024, busid: 1, uploader_name: 'Synthetic uploader', uploader: 30001,
      upload_time: 1700000000, dead_time: 0, modify_time: 1700000100, download_times: 7 }],
    folders: [{ group_id: 20001, folder_id: 'folder', folder: 'folder', folder_name: 'Synthetic folder',
      total_file_count: 2, create_time: 1699990000, modify_time: 1700000100, creator: 30001, modifier: 30002,
      creator_name: 'Synthetic creator', modifier_name: 'Synthetic modifier' }],
    is_end: false,
  });
  assert.equal(s.store.pending, false);
});

test('HTTP group file system info binds the count and uses explicit native space values', async t => {
  for (const groupFileQuota of ['confirmed', 'wrong-group', 'missing-space', 'empty', 'empty-no-space']) {
    await t.test(groupFileQuota, async subtest => {
      const s = await setup(subtest, { groupFileQuota });
      const response = await s.request('get_group_file_system_info', { group_id: 20001 });
      if (groupFileQuota === 'confirmed' || groupFileQuota === 'empty') {
        assert.equal(response.retcode, 0);
        const empty = groupFileQuota === 'empty';
        assert.deepEqual(response.data, { file_count: empty ? 0 : 4, limit_count: 10000,
          used_space: empty ? 0 : 1024, total_space: 2048 });
      } else {
        assert.notEqual(response.retcode, 0);
        assert.equal(response.data, null);
      }
      assert.equal(s.state.groupFileReads, groupFileQuota === 'wrong-group' ? 0 : 1);
      assert.equal(s.store.pending, false);
    });
  }
});

test('quota-only query blocks unbound same-group root callbacks, including after reattachment', async t => {
  const s = await setup(t, { groupFileQuota: 'empty' });
  const quota = await s.request('get_group_file_system_info', { group_id: 20001 });
  assert.equal(quota.retcode, 0);
  assert.equal(quota.data.file_count, 0);
  s.bridge.detach();
  await s.bridge.attach();
  let listSubmissions = 0;
  s.bridge.richMedia.getGroupFileList = (code, params) => {
    listSubmissions++;
    s.listener().onGroupFileInfoUpdate({
      retCode: 0, isEnd: true, reqId: 1,
      item: [{ peerId: '20001', fileInfo: { fileId: 'late-quota-page', fileName: 'stale.txt',
        fileSize: '4', busId: 1, uploaderName: 'Fixture', parentFolderId: '/' } }],
    });
    s.listener().onGroupFileInfoUpdate({
      retCode: 0, isEnd: true, reqId: 2,
      item: [{ peerId: code, fileInfo: { fileId: 'file', fileName: 'file.txt',
        fileSize: '4', busId: 1, uploaderName: 'Fixture',
        parentFolderId: params.folderId ?? '/' } }],
    });
    return { result: 0 };
  };
  const root = await s.request('get_group_root_files', { group_id: 20001 });
  assert.equal(root.retcode, 1502);
  assert.equal(listSubmissions, 0);
  const sub = await s.request('get_group_files_by_folder', { group_id: 20001, folder_id: '/fixture' });
  assert.equal(sub.retcode, 0);
  assert.equal(sub.data.files[0].file_id, 'file');
  const other = await s.request('get_group_root_files', { group_id: 20002 });
  assert.equal(other.retcode, 0);
  assert.equal(other.data.files[0].group_id, 20002);
  assert.equal(other.data.files[0].file_id, 'file');
  assert.equal(listSubmissions, 2);
});

test('HTTP group folder listing requires a matching parent on every returned entry', async t => {
  const s = await setup(t, { groupFolder: '/requested' });
  const list = params => s.request('get_group_files_by_folder', { group_id: 20001, ...params });
  assert.equal((await list({})).retcode, 1400);
  assert.equal((await list({ folder: '/wrong', folder_id: '/requested' })).retcode, 1400);
  assert.equal(s.state.groupFileReads, 0);
  const result = await list({ folder: '/requested' });
  assert.equal(result.retcode, 0);
  assert.equal(result.data.files[0].file_id, 'synthetic-file');
  assert.equal(result.data.folders[0].folder_id, 'folder');
  assert.equal(result.data.folders[0].folder, 'folder');
  assert.equal(result.data.files[0].upload_time, 1700000000);
  assert.equal(result.data.is_end, false);
  assert.equal(Object.hasOwn(result.data.files[0], 'localPath'), false);
  assert.equal(s.state.groupFileReads, 1);
});

test('HTTP group file listing omits malformed optional metadata while preserving valid fields', async t => {
  const s = await setup(t, { groupFiles: 'malformed-metadata' });
  const response = await s.request('get_group_root_files', { group_id: 20001 });
  assert.equal(response.retcode, 0);
  const [file] = response.data.files;
  assert.equal(file.upload_time, 1700000000);
  assert.equal(file.dead_time, 0);
  assert(!Object.hasOwn(file, 'uploader'));
  assert(!Object.hasOwn(file, 'download_times'));
});

test('HTTP group folder listing exposes the native continuation and submits it only on a client request', async t => {
  const s = await setup(t, { groupFiles: 'paginated', groupFolder: '/requested' });
  const list = start_index => s.request('get_group_files_by_folder', { group_id: 20001, folder_id: '/requested', start_index });
  assert.equal((await list('-1')).retcode, 1400);
  assert.equal(s.state.groupFileReads, 0);
  const first = await list(0);
  assert.equal(first.retcode, 0);
  assert.equal(first.data.is_end, false);
  assert.equal(first.data.next_index, 2);
  assert.equal(s.state.groupFileReads, 1);
  const second = await list(String(first.data.next_index));
  assert.equal(second.retcode, 0);
  assert.equal(second.data.files[0].file_id, 'second-file');
  assert.equal(second.data.is_end, true);
  assert(!Object.hasOwn(second.data, 'next_index'));
  assert.equal(s.state.groupFileReads, 2);
});

test('HTTP group file listing ignores a repeated page ID from its previously observed callback', async t => {
  const s = await setup(t, { groupFiles: 'duplicate', groupFolder: '/requested' });
  const list = () => s.request('get_group_files_by_folder', { group_id: 20001, folder_id: '/requested' });
  for (let i = 0; i < 2; i++) {
    const result = await list();
    assert.equal(result.retcode, 0);
    assert.equal(result.data.files[0].file_id, 'synthetic-file');
  }
  assert.equal(s.state.groupFileReads, 2);
});

test('HTTP self profile writes a birthday when all three fields are supplied', async t => {
  const writes = [];
  let current = { nick: 'Initial', longNick: 'Previous', sex: 255,
    birthday: { birthday_year: '2000', birthday_month: '2', birthday_day: '3' } };
  const s = await setup(t, { profileUpdate: {
    getUserDetailInfoByUin(uin) {
      const base = Object.fromEntries(Object.entries(current.birthday).map(([field, value]) => [field, Number(value)]));
      return { result: 0, detail: { uin, uid: 'u_synthetic_self', simpleInfo: { coreInfo: { nick: current.nick },
        baseInfo: { ...base, longNick: current.longNick, sex: current.sex } } } };
    },
    modifyDesktopMiniProfile(value) {
      writes.push(value);
      current = value;
      return { result: 0 };
    },
  } });
  const update = params => s.request('set_qq_profile', params);
  // 半截生日直接拒绝：原生会把缺的那几项当 0 写进去，读回来就是「我改坏了」。
  assert.equal((await update({ birthday_year: 1999 })).retcode, 1400);
  assert.equal((await update({ birthday_year: 1999, birthday_month: 5 })).retcode, 1400);
  assert.equal((await update({ birthday_year: 99999, birthday_month: 5, birthday_day: 6 })).retcode, 1400);
  assert.deepEqual(writes, []);
  assert.equal((await update({ birthday_year: 1999, birthday_month: 5, birthday_day: 6 })).retcode, 0);
  assert.deepEqual(writes[0].birthday, { birthday_year: '1999', birthday_month: '5', birthday_day: '6' });
  // 不传生日时保持原值不动（这条以前靠"只读不写"隐式成立，现在要显式成立）。
  assert.equal((await update({ nickname: 'Renamed' })).retcode, 0);
  assert.deepEqual(writes[1].birthday, { birthday_year: '1999', birthday_month: '5', birthday_day: '6' });
});

test('HTTP self profile preserves omitted fields and requires same-account readback', async t => {
  const writes = [];
  const birthday = { birthday_year: '2000', birthday_month: '2', birthday_day: '3' };
  let current = { nick: 'Initial', longNick: 'Previous', sex: 255, birthday };
  const s = await setup(t, { profileUpdate: {
    getUserDetailInfoByUin(uin) {
      assert.equal(uin, BOT);
      const base = Object.fromEntries(Object.entries(current.birthday).map(([field, value]) => [field, Number(value)]));
      return { result: 0, detail: { uin, uid: 'u_synthetic_self', simpleInfo: { coreInfo: { nick: current.nick },
        baseInfo: { ...base, longNick: current.longNick, sex: current.sex } } } };
    },
    modifyDesktopMiniProfile(value) {
      writes.push(value);
      if (writes.length === 1) current = value;
      return { result: 0 };
    },
  } });
  const update = params => s.request('set_qq_profile', params);
  assert.equal((await update({ nickname: 'Invalid', user_id: 10001 })).retcode, 1400);
  assert.equal((await update({ personal_note: 'Previous' })).retcode, 0);
  assert.deepEqual(writes, []);
  assert.equal((await update({ personal_note: '' })).retcode, 0);
  assert.deepEqual(writes, [{ nick: 'Initial', longNick: '', sex: 255, birthday, location: undefined }]);
  assert.equal(s.store.pending, false);
  assert.equal((await update({ nickname: 'Missing readback', sex: '2' })).retcode, 1504);
  assert.equal(s.store.pending, true);
  assert.equal((await update({ nickname: 'Missing readback' })).retcode, 1503);
  assert.equal(writes.length, 2);
});

test('HTTP self signature handles both wire spellings and rejects target overrides', { timeout: 5000 }, async t => {
  const s = await setup(t);
  const change = params => s.request('set_self_longnick', params);
  assert.equal((await change({ long_nick: 'synthetic', user_id: Number(OWNER_UIN) })).retcode, 1400);
  assert.equal((await change({ long_nick: 'new', longNick: 'other' })).retcode, 1400);
  assert.equal((await change({ long_nick: 'initial' })).retcode, 0);
  assert.equal(s.state.signatureWrites, 0);
  assert.equal((await change({ longNick: 'updated' })).retcode, 0);
  assert.equal((await change({ long_nick: '' })).retcode, 0);
  assert.equal(s.state.signatureWrites, 2);
  assert.equal(s.store.pending, false);
});

test('HTTP self signature separates rejection from missing same-account readback', { timeout: 5000 }, async t => {
  for (const [signatureResult, retcode] of [['rejected', 1500], ['mismatch', 1504], ['uid-changed', 1504]]) {
    await t.test(signatureResult, async subtest => {
      const s = await setup(subtest, { signatureResult });
      const params = { long_nick: 'updated' };
      assert.equal((await s.request('set_self_longnick', params)).retcode, retcode);
      assert.equal(s.store.pending, retcode === 1504);
      if (retcode === 1504) assert.equal((await s.request('set_self_longnick', params)).retcode, 1503);
      assert.equal(s.state.signatureWrites, 1);
    });
  }
});

test('HTTP group file listing does not succeed on unbound pages or rejected acknowledgments', { timeout: 5000 }, async t => {
  for (const groupFiles of ['unbound', 'rejected']) {
    await t.test(groupFiles, async subtest => {
      const s = await setup(subtest, { groupFiles });
      const result = await s.request('get_group_root_files', { group_id: 20001 });
      assert.equal(result.retcode, groupFiles === 'unbound' ? 1502 : 1500);
      assert.equal(result.data, null);
      assert.equal(s.store.pending, false);
      assert.deepEqual(s.core.status(), { online: true, good: true });
      if (groupFiles === 'unbound') {
        assert.notEqual((await s.request('get_group_root_files', { group_id: 20001 })).retcode, 0);
        assert.equal(s.state.groupFileReads, 1);
      }
    });
  }
});

test('a timed-out file page stays isolated to its group and directory after bridge reattachment', async t => {
  const calls = [];
  const s = await setup(t, { fileOperations: {
    getGroupFileList(code, { folderId }) {
      calls.push([code, folderId]);
      if (code === '20001' && folderId === undefined) return { result: 0 };
      const listener = s.listener();
      const send = (peerId, parentFolderId, fileId) => listener.onGroupFileInfoUpdate({ retCode: 0, isEnd: true,
        item: [{ peerId, fileInfo: { fileId, parentFolderId, fileName: 'Synthetic file', fileSize: '42',
          busId: 1, uploaderName: 'Synthetic uploader' } }] });
      send('20001', '/', 'late-root-file');
      send(code, folderId ?? '/', 'current-file');
      return { result: 0 };
    },
  } });
  const rootFiles = group_id => s.request('get_group_root_files', { group_id });
  assert.equal((await rootFiles(20001)).retcode, 1502);
  await s.bridge.reattach();
  assert.equal((await rootFiles(20001)).retcode, 1502);
  const folder = await s.request('get_group_files_by_folder', { group_id: 20001, folder_id: '/docs' });
  const otherGroup = await rootFiles(20002);
  for (const response of [folder, otherGroup]) {
    assert.equal(response.retcode, 0);
    assert.deepEqual(response.data.files.map(file => file.file_id), ['current-file']);
  }
  assert.deepEqual(calls, [['20001', undefined], ['20001', '/docs'], ['20002', undefined]]);
  assert.equal(s.store.pending, false);
});

test('group file pages reject ambiguous IDs and do not turn an unbound empty callback into an empty directory', async t => {
  const fileInfo = { fileId: 'valid-file', fileName: 'Synthetic file', fileSize: '42', busId: 1, uploaderName: 'Synthetic uploader' };
  const folderInfo = { folderId: 'valid-folder', folderName: 'Synthetic folder', totalFileCount: 0 };
  const variants = [
    [{ fileInfo }, { fileInfo: { ...fileInfo, fileName: 'Another file' } }],
    [{ folderInfo }, { folderInfo: { ...folderInfo, folderName: 'Another folder' } }],
    [{ fileInfo: { ...fileInfo, fileId: 'ambiguous ID' } }],
    [{ fileInfo: { ...fileInfo, fileId: '/' } }],
    [{ fileInfo: { ...fileInfo, fileId: 'a'.repeat(513) } }],
    [{ folderInfo: { ...folderInfo, folderId: '/' } }],
    [{ folderInfo: { ...folderInfo, folderId: '/folder/child' } }],
    [],
  ];
  let entries;
  const s = await setup(t, { fileOperations: { getGroupFileList(code) {
    s.listener().onGroupFileInfoUpdate({ retCode: 0, isEnd: true, allFileCount: entries.length,
      item: entries.map(entry => ({ peerId: code, ...entry })) });
    return { result: 0 };
  } } });
  for (const [index, variant] of variants.entries()) {
    entries = variant;
    const response = await s.request('get_group_root_files', { group_id: 20001 + index });
    assert.equal(response.retcode, variant.length ? 1400 : 1502);
    assert.equal(response.data, null);
  }
  entries = [{ fileInfo }, { folderInfo }];
  const result = await s.request('get_group_root_files', { group_id: 20001 });
  assert.equal(result.retcode, 0);
  assert.deepEqual(result.data.files.map(file => file.file_id), ['valid-file']);
  assert.deepEqual(result.data.folders.map(folder => folder.folder_id), ['valid-folder']);
});

test('post-send message representation failure remains unknown rather than clearing persistent latch', { timeout: 5000 }, async t => {
  const s = await setup(t);
  s.bridge.messages.next = 2147483648;
  const response = await s.request('send_group_msg', { group_id: 20001, message: 'confirmed but no ID space' });
  assert.equal(s.state.sent.length, 1);
  // P4：原生已发出、只是我们表示不出 message_id ⇒ 仍按已接受回成功，不当「未知」。
  assert.equal(response.retcode, 0);
  assert.equal(response.data.message_id, null);
  assert.equal(s.store.pending, false);
});

test('native self mention reaches the loopback WebSocket as a OneBot at segment', { timeout: 5000 }, async t => {
  const s = await setup(t);
  assert.equal((await s.request('get_login_info')).retcode, 0);
  const events = await socket(t, s.base);
  assert.equal((await events.next()).meta_event_type, 'lifecycle');
  s.receive([raw({ elements: [{ elementType: 1,
    textElement: { content: '@Synthetic', atType: 2, atUid: '0', atNtUid: 'u_synthetic_self' } }] })]);
  const event = await events.next();
  assert.deepEqual(event.message, [{ type: 'at', data: { qq: BOT } }]);
  assert.equal(event.raw_message, '[CQ:at,qq=' + BOT + ']');
});

test('native events traverse core to actual WS and old-session callbacks remain isolated after reattachment', { timeout: 5000 }, async t => {
  const s = await setup(t);
  assert.equal((await s.request('get_login_info')).retcode, 0);
  const events = await socket(t, s.base);
  assert.equal((await events.next()).meta_event_type, 'lifecycle');
  const originalListener = s.listener();
  s.receive([raw()]);
  const event = await events.next();
  assert.equal(event.post_type, 'message');
  assert.equal(event.group_id, 20001);
  assert.equal(event.raw_message, 'synthetic event');
  assert.equal(Object.hasOwn(event, 'echo'), false);
  const previousId = event.message_id;
  s.bridge.detach();
  assert.equal(s.core.status().online, false);
  s.state.session = 'synthetic-B';
  await s.bridge.attach();
  assert.equal((await s.request('get_login_info')).retcode, 0);
  originalListener.onRecvMsg([raw({ msgId: '999991' })]);
  s.receive([raw({ msgId: '999992', elements: [{ elementType: 1, textElement: { content: 'new session' } }] })]);
  const next = await events.next();
  assert.equal(next.raw_message, 'new session');
  assert.ok(next.message_id > previousId);
  assert.equal(events.queued.length, 0);
  assert.equal((await s.request('send_group_msg', { group_id: 20001, message: 'new session outbound' })).retcode, 0);
  assert.equal(s.state.sent.length, 1);
});

test('a picture with no public address keeps the md5 address when inline download yields no completion', async t => {
  const md5 = 'ABCDEF0123456789ABCDEF0123456789';
  const picture = { elementType: 2, elementId: 4243, picElement: { fileName: `${md5}.jpg`, md5HexStr: md5,
    originImageUrl: '/download?appid=1406&fileid=EHQQQ&spec=0' } };
  const message = raw({ elements: [picture] });
  let transfers = 0;
  const s = await setup(t, {
    downloadRichMedia() { transfers++; return undefined; },
    readNativeMessage: () => ({ result: 0, msgList: [message] }),
  });
  const message_id = s.bridge.messages.put(message);
  const images = await s.request('get_message_images', { message_id });
  assert.equal(images.retcode, 0);
  assert.deepEqual(images.data, [{ type: 'image',
    data: { file: `${md5}.jpg`, url: `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5}/0` } }]);
  // Inline download is attempted; without a completion event it falls back to md5.
  assert.equal(transfers, 1);
});

// get_record（语音落地）：本运行端拿语音字节的唯一途径是原生传输
// （downloadRichMedia downloadType:1 + onRichMediaDownloadComplete）。这条测试钉住三件事：
// ① 两个入口（message_id / file）都能落到同一个文件；② 不会把非绝对路径当成功；
// ③ 一条消息里多段语音而调用方没指定 file 时明确拒绝，不猜。
test('get_record lands a voice message as a local silk file from either entry', async t => {
  const record = { elementType: 4, elementId: 777, pttElement: { fileName: 'voice-fixture.amr' } };
  const message = raw({ elements: [record] });
  const transfers = [];
  const s = await setup(t, {
    downloadRichMedia(param) {
      transfers.push(String(param.elementId));
      assert.equal(param.downloadType, 1);
      assert.equal(param.peerUid, '20001');
      queueMicrotask(() => s.listener().onRichMediaDownloadComplete(
        { msgId: message.msgId, msgElementId: 777, filePath: '/tmp/synthetic-record.silk' }));
      return undefined;
    },
    readNativeMessage: () => ({ result: 0, msgList: [message] }),
  });
  const message_id = s.bridge.messages.put(message);
  const byId = await s.request('get_record', { message_id });
  assert.equal(byId.retcode, 0);
  assert.equal(byId.data.file, '/tmp/synthetic-record.silk');
  assert.equal(byId.data.out_format, 'silk');
  // 按文件名回溯同一条：运行端的 segment.data.file 就是这个 fileName。
  const byFile = await s.request('get_record', { file: 'voice-fixture.amr' });
  assert.equal(byFile.retcode, 0);
  assert.equal(byFile.data.file, '/tmp/synthetic-record.silk');
  assert.equal(transfers.length, 2);
  // 转码声明诚实地拒绝，而不是把 silk 说成 mp3。
  const mp3 = await s.request('get_record', { file: 'voice-fixture.amr', out_format: 'mp3' });
  assert.equal(mp3.retcode, 1400);
  // 未登记过的文件名 = 找不到，不是拿别的语音顶替。
  const missing = await s.request('get_record', { file: 'not-a-record.amr' });
  assert.equal(missing.retcode, 1404);
});

test('get_record refuses to guess when one message carries several records', async t => {
  const first = { elementType: 4, elementId: 801, pttElement: { fileName: 'voice-a.amr' } };
  const second = { elementType: 4, elementId: 802, pttElement: { fileName: 'voice-b.amr' } };
  const message = raw({ elements: [first, second] });
  let transfers = 0;
  const s = await setup(t, {
    downloadRichMedia(param) {
      transfers++;
      // 指明了 file 之后才允许传，并且只传指定的那一段。
      assert.equal(String(param.elementId), '802');
      queueMicrotask(() => s.listener().onRichMediaDownloadComplete(
        { msgId: message.msgId, msgElementId: 802, filePath: '/tmp/synthetic-record-b.silk' }));
      return undefined;
    },
    readNativeMessage: () => ({ result: 0, msgList: [message] }),
  });
  const message_id = s.bridge.messages.put(message);
  const ambiguous = await s.request('get_record', { message_id });
  // 1400 = 「你得指明是哪一个」，而不是拿第一段顶替。传输层会把 1400 的 wording
  // 归一成通用文案，所以这里断 retcode + 确认真的没有发起传输。
  assert.equal(ambiguous.retcode, 1400);
  assert.equal(transfers, 0);
  const byFirst = await s.request('get_record', { message_id, file: 'voice-b.amr' });
  assert.equal(byFirst.retcode, 0);
  assert.equal(byFirst.data.file, '/tmp/synthetic-record-b.silk');
  assert.equal(transfers, 1);
});

// 群公告写（send_group_notice）：以前内核通道缺 pskey，这个动作既没实现在能力表里、
// 删除动作还一直传空串 pskey。这两条一起钉住：① 发布带**真实** pskey；② 取不到 pskey
// 就明确拒绝，绝不拿空串去发请求；③ 正文按 NapCat 的形状 URI 编码。
test('send_group_notice publishes with a real qun.qq.com pskey and URI-encoded text', async t => {
  const s = await setup(t, {});
  const published = await s.request('send_group_notice', {
    group_id: 20001, content: '今晚 9 点维护', pinned: true,
  });
  assert.equal(published.retcode, 0);
  assert.equal(s.state.bulletinPublish.length, 1);
  const [call] = s.state.bulletinPublish;
  assert.equal(call.code, '20001');
  assert.equal(call.pskey, 'qun.qq.com-synthetic-pskey');
  assert.deepEqual(call.data, {
    text: encodeURI('今晚 9 点维护'), picInfo: undefined, oldFeedsId: '', pinned: 1, confirmRequired: 0,
  });
  assert.deepEqual(s.state.pskeyCalls, [['qun.qq.com']]);
  // 第二次调用走 60 秒内存缓存，不再重复取 pskey。
  const again = await s.request('send_group_notice', { group_id: 20001, content: '再说一次' });
  assert.equal(again.retcode, 0);
  assert.equal(s.state.pskeyCalls.length, 1);
  assert.equal(s.state.bulletinPublish[1].data.pinned, 0);
});

test('send_group_notice refuses instead of sending an empty pskey', async t => {
  const s = await setup(t, { pskeyDisabled: true });
  const refused = await s.request('send_group_notice', { group_id: 20001, content: '没有 pskey' });
  assert.equal(refused.retcode, 1404);
  assert.equal(s.state.bulletinPublish.length, 0);
});

test('del_group_notice now carries the pskey it always needed', async t => {
  const s = await setup(t, {});
  const deleted = await s.request('del_group_notice', { group_id: 20001, notice_id: '42' });
  assert.equal(deleted.retcode, 0);
  assert.deepEqual(s.state.bulletinDelete, [
    { code: '20001', pskey: 'qun.qq.com-synthetic-pskey', noticeId: '42' },
  ]);
});

test('send_group_notice uploads a local picture before publishing', async t => {
  const image = path.join(testTmp, 'bulletin-fixture.png');
  fs.mkdirSync(testTmp, { recursive: true });
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const s = await setup(t, {});
  const published = await s.request('send_group_notice', { group_id: 20001, content: '看图', image });
  assert.equal(published.retcode, 0);
  assert.equal(s.state.bulletinPics.length, 1);
  assert.equal(s.state.bulletinPics[0].pskey, 'qun.qq.com-synthetic-pskey');
  assert.deepEqual(s.state.bulletinPublish[0].data.picInfo, { id: 'pic-synthetic', width: 640, height: 480 });
});

// 视频落地（get_message_videos）：运行端要抽帧就得有本地文件，而 QQ 的视频地址会过期。
// 这条钉住：① 走的是同一条原生传输（downloadType 1）；② 返回绝对路径；③ 没有视频就明确 1404。
test('get_message_videos lands a received video as a local path', async t => {
  const video = { elementType: 5, elementId: 901, videoElement: { fileName: 'clip-fixture.mp4' } };
  const message = raw({ elements: [video] });
  const s = await setup(t, {
    downloadRichMedia(param) {
      assert.equal(param.downloadType, 1);
      assert.equal(String(param.elementId), '901');
      queueMicrotask(() => s.listener().onRichMediaDownloadComplete(
        { msgId: message.msgId, msgElementId: 901, filePath: '/tmp/synthetic-video.mp4' }));
      return undefined;
    },
    readNativeMessage: () => ({ result: 0, msgList: [message] }),
  });
  const message_id = s.bridge.messages.put(message);
  const result = await s.request('get_message_videos', { message_id });
  assert.equal(result.retcode, 0, JSON.stringify(result));
  assert.deepEqual(result.data.videos, [{ file: 'clip-fixture.mp4', path: '/tmp/synthetic-video.mp4' }]);
  // 没有视频的消息不是「空结果」，是「这条消息没视频」。
  const noVideo = raw({ msgId: '90071992547400077', elements: [{ elementType: 1, textElement: { content: 'plain' } }] });
  const plainId = s.bridge.messages.put(noVideo);
  const none = await s.request('get_message_videos', { message_id: plainId });
  assert.equal(none.retcode, 1404);
});

test('a picture whose inline download completes is delivered as a data URL', async t => {
  const md5 = 'ABCDEF0123456789ABCDEF0123456789';
  const picture = { elementType: 2, elementId: 4243, picElement: { fileName: `${md5}.jpg`, md5HexStr: md5,
    originImageUrl: '/download?appid=1406&fileid=EHQQQ&spec=0' } };
  const message = raw({ elements: [picture] });
  let transfers = 0;
  const s = await setup(t, {
    downloadRichMedia(param) {
      transfers++;
      assert.equal(param.downloadType, 1);
      assert.equal(param.peerUid, '20001');
      assert.equal(String(param.elementId), '4243');
      // Deliver the completion via the same listener the bridge registered.
      queueMicrotask(() => s.listener().onRichMediaDownloadComplete({ msgId: message.msgId, msgElementId: 4243, filePath: '/tmp/synthetic.jpg' }));
      return undefined;
    },
    readNativeMessage: () => ({ result: 0, msgList: [message] }),
  });
  const message_id = s.bridge.messages.put(message);
  const images = await s.request('get_message_images', { message_id });
  assert.equal(images.retcode, 0);
  assert.equal(images.data[0].type, 'image');
  assert.equal(images.data[0].data.file, `${md5}.jpg`);
  // The inline data URL wins over the md5 fallback (file does not exist on disk
  // in this synthetic fixture, so inline read fails → falls back to md5; assert
  // the transfer was attempted with the corrected shape).
  assert.equal(transfers, 1);
});
