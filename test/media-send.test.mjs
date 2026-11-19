// P1：语音/视频/文件 作为消息段发送的单元测试。
// 只验证「段 → 原生 element」这一层（提交由 fake sendMsg 捕获），不做真机断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

const GROUP = '20001';

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-media-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

function fixture() {
  const sent = [];
  let listener;
  const identity = { user_id: BOT_UIN, nickname: 'Synthetic bot', online: true, sessionId: 'media-session' };
  const msg = {
    addKernelMsgListener(value) { listener = value; return 7; },
    removeKernelMsgListener() {},
    generateMsgUniqueId() { return '90071992547409977'; },
    async sendMsg(...args) {
      sent.push(args);
      queueMicrotask(() => listener.onMsgInfoListUpdate([{
        msgId: '90071992547409978', guildId: args[1].guildId, peerUid: args[1].peerUid, chatType: args[1].chatType,
        senderUin: BOT_UIN, sendStatus: 2, msgSeq: '61', msgRandom: '88', elements: args[2],
      }]));
      return { result: 0 };
    },
  };
  const group = {
    addKernelGroupListener() { return 8; },
    removeKernelGroupListener() {},
    async getUidByUins(uins) { return { errCode: 0, uids: new Map(uins.map(x => [x, 'u_fixture'])) }; },
  };
  const bridge = new NativeBridge({
    session: {
      getMsgService: () => msg, getGroupService: () => group,
      getBuddyService: () => ({}), getProfileService: () => ({}),
      getSessionId: () => identity.sessionId,
    },
    identityProbe: async () => identity,
    timeoutMs: 200,
  });
  return { bridge, sent };
}

test('P1 文件段：本地真实文件 → fileElement(elementType 3)，路径与大小进元素', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  const file = tmpFile('hello.txt', 1234);

  const result = await f.bridge.call('send_group_msg', {
    group_id: Number(GROUP),
    message: [{ type: 'file', data: { file } }],
  });
  assert.equal(result.message_id > 0, true);
  const elements = f.sent.at(-1)[2];
  assert.equal(elements.length, 1);
  assert.equal(elements[0].elementType, 3);
  assert.equal(elements[0].fileElement.fileName, 'hello.txt');
  assert.equal(elements[0].fileElement.fileSize, '1234');
});

test('P1 语音段：本地文件 → pttElement(elementType 4)', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  const file = tmpFile('voice.amr', 800);

  await f.bridge.call('send_group_msg', { group_id: Number(GROUP), message: [{ type: 'record', data: { file } }] });
  const elements = f.sent.at(-1)[2];
  assert.equal(elements[0].elementType, 4);
  assert.ok(elements[0].pttElement);
});

test('P1 视频段：本地文件 → videoElement(elementType 5)', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  const file = tmpFile('clip.mp4', 2048);

  await f.bridge.call('send_group_msg', { group_id: Number(GROUP), message: [{ type: 'video', data: { file } }] });
  const elements = f.sent.at(-1)[2];
  assert.equal(elements[0].elementType, 5);
  assert.ok(elements[0].videoElement);
});

test('P1 媒体段：文件不存在 → 1400，且绝不提交', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  await assert.rejects(() => f.bridge.call('send_group_msg', {
    group_id: Number(GROUP),
    message: [{ type: 'file', data: { file: path.join(os.tmpdir(), 'whale-does-not-exist.bin') } }],
  }), (error) => { assert.equal(error.retcode, 1400); return true; });
  assert.equal(f.sent.length, 0, '校验失败不能有任何原生提交');
});

test('P1 媒体段：只接受本地路径，URL 一律拒绝', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  await assert.rejects(() => f.bridge.call('send_group_msg', {
    group_id: Number(GROUP),
    message: [{ type: 'file', data: { file: 'https://example.invalid/a.bin' } }],
  }), (error) => { assert.equal(error.retcode, 1400); return true; });
  assert.equal(f.sent.length, 0);
});
