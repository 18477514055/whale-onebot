import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

const BOT = BOT_UIN;
const FRIEND = '10001';
const base64Png = 'base64://' + Buffer.from([137, 80, 78, 71]).toString('base64');

function raw(overrides = {}) {
  return { msgId: '90071992547409931', msgSeq: '51', msgTime: '1700000000', chatType: 2, peerUid: '20001',
    peerUin: '20001', senderUid: 'u_fixture', senderUin: FRIEND, sendNickName: 'Synthetic',
    elements: [{ elementType: 1, textElement: { content: 'hello' } }], ...overrides };
}
function fixture({ imagePlacement, buildResult, buildError } = {}) {
  const calls = [];
  let listener, nextId = 90071992547409939n, nextFinalId = 91071992547409939n;
  const identity = { user_id: BOT, nickname: 'Synthetic bot', online: true, sessionId: 'synthetic-session-A' };
  let built = 0;
  const msg = {
    addKernelMsgListener(value) { listener = value; return 7; },
    removeKernelMsgListener() { calls.push(['remove-msg']); },
    generateMsgUniqueId() { return String(nextId++); },
    async sendMsg(...args) {
      calls.push(['send', ...args]);
      queueMicrotask(() => listener.onMsgInfoListUpdate([raw({ msgId: String(nextFinalId++), guildId: args[1].guildId, peerUid: args[1].peerUid, chatType: args[1].chatType, senderUin: BOT, sendStatus: 2, elements: args[2] })]));
      return { result: 0 };
    },
    getMsgsByMsgId() { return { result: 0, msgList: [] }; },
  };
  const group = { getUidByUins(uins) { return { errCode: 0, uids: new Map(uins.map(x => [x, 'u_fixture'])) }; } };
  const placement = imagePlacement === 'none' ? undefined : {
    buildImageElement: async (file) => {
      built++;
      if (buildError) throw buildError;
      return buildResult ?? { elementType: 2, elementId: '', picElement: {
        md5HexStr: 'md5', fileSize: '4', fileName: 'image.png', sourcePath: 'cache/image.png',
        picWidth: 0, picHeight: 0, original: true, picType: 1000, picSubType: 0, fileUuid: '', fileSubId: '', summary: '', thumbFileSize: 0 } };
    },
  };
  const bridge = new NativeBridge({ session: { getMsgService: () => msg, getGroupService: () => group },
    identityProbe: async () => identity, timeoutMs: 50, imagePlacement: placement });
  return { bridge, calls, msg, get built() { return built; } };
}

test('image segment requires an injected placement backend and still fails closed without one', async () => {
  const f = fixture({ imagePlacement: 'none' });
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: [{ type: 'image', data: { file: base64Png } }] }),
    { code: 'UNSUPPORTED_SEGMENT' });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 0);
  f.bridge.detach();
});

test('injected placement builds a picElement and submits the native send exactly once', async () => {
  const f = fixture({ buildResult: { elementType: 2, elementId: '', picElement: { md5HexStr: 'md5', fileSize: '4', fileName: 'image.png', sourcePath: 'cache/image.png', picWidth: 0, picHeight: 0, original: true, picType: 1000, picSubType: 0, fileUuid: '', fileSubId: '', summary: '', thumbFileSize: 0 } } });
  await f.bridge.attach();
  const result = await f.bridge.call('send_group_msg', { group_id: 20001, message: [{ type: 'image', data: { file: base64Png } }] });
  assert.ok(Number.isInteger(result.message_id));
  const send = f.calls.find(x => x[0] === 'send');
  assert.equal(send[3][0].elementType, 2);
  assert.equal(send[3][0].picElement.fileName, 'image.png');
  assert.equal(f.built, 1);
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  f.bridge.detach();
});

test('a placement preparation failure aborts before any native send and does not lock later text', async () => {
  const f = fixture({ buildError: new (class extends Error { constructor() { super('decode failed'); this.name = 'ImageStoreError'; } })() });
  await f.bridge.attach();
  await assert.rejects(f.bridge.call('send_group_msg', { group_id: 20001, message: [{ type: 'image', data: { file: base64Png } }] }),
    { code: 'IMAGE_PREPARE_FAILED' });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 0);
  // A subsequent plain text send still works.
  const ok = await f.bridge.call('send_group_msg', { group_id: 20001, message: 'still works' });
  assert.ok(Number.isInteger(ok.message_id));
  f.bridge.detach();
});

test('image placement receives the exact file source without native-layer URL assumptions', async () => {
  const f = fixture();
  await f.bridge.attach();
  // NativeBridge hands the raw source through; source-shape policy (base64-only)
  // belongs to the injected factory, not the bridge.
  const result = await f.bridge.call('send_group_msg', { group_id: 20001, message: [{ type: 'image', data: { file: 'base64://synthetic' } }] });
  assert.ok(Number.isInteger(result.message_id));
  assert.equal(f.built, 1);
  f.bridge.detach();
});
