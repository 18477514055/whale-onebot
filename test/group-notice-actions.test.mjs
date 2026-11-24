// 第二批 P0/P1 动作的单元测试：群公告读/删、群系统消息。
// 夹具全合成；只验证「段→内核调用」「返回整形」「失败不静默」这几层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

const GROUP = '20001';

function fixture(overrides = {}) {
  const calls = [];
  const identity = { user_id: BOT_UIN, nickname: 'Synthetic bot', online: true, sessionId: 'batch2-session' };
  const msg = { addKernelMsgListener() { return 7; }, removeKernelMsgListener() {} };
  const group = {
    addKernelGroupListener() { return 8; },
    removeKernelGroupListener() {},
    async getGroupBulletinList(...args) { calls.push(['bulletin-list', ...args]); return overrides.bulletinPage ?? { feet: [] }; },
    // 能力门要求 getGroupBulletin 与 getGroupBulletinList 同时存在
    async getGroupBulletin(...args) { calls.push(['bulletin-one', ...args]); return { result: 0 }; },
    async deleteGroupBulletin(...args) { calls.push(['bulletin-del', ...args]); return overrides.deleteResult ?? { result: 0 }; },
    async getSingleScreenNotifies(...args) { calls.push(['notifies', ...args]); return overrides.notifyPage ?? { result: 0, notifies: [] }; },
  };
  const bridge = new NativeBridge({
    session: {
      getMsgService: () => msg, getGroupService: () => group,
      getBuddyService: () => ({}), getProfileService: () => ({}),
      // 群公告的写/删内核签名都带 qun.qq.com 的 pskey；真机上它在 tipOff 服务里
      // （debug_native_surface 实证）。夹具给出它，测试才能钉住「传的是真 pskey」。
      ...(overrides.noPskey ? {} : { getTipOffService: () => ({
        async getPskey(domains) {
          calls.push(['pskey', ...domains]);
          return { domainPskeyMap: new Map(domains.map(d => [d, 'synthetic-pskey-value'])) };
        },
      }) }),
      getSessionId: () => identity.sessionId,
    },
    identityProbe: async () => identity,
    timeoutMs: 200,
  });
  return { bridge, calls };
}

test('群公告：get_group_notice 返回整形后的 notices（并保留 raw 供调用方判断）', async t => {
  const page = { feet: [{ noticeId: '42', senderId: 10002, publishTime: 1700000000, content: '群公告正文' }] };
  const f = fixture({ bulletinPage: page });
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  const result = await f.bridge.call('get_group_notice', { group_id: Number(GROUP) });
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].notice_id, '42');
  assert.equal(result.notices[0].sender_id, 10002);
  assert.equal(result.notices[0].content, '群公告正文');
  assert.deepEqual(result.notices[0].raw, page.feet[0], '未验证语义的字段必须原样保留');
  const hit = f.calls.find(c => c[0] === 'bulletin-list');
  assert.ok(hit, '应调用 getGroupBulletinList');
});

test('群公告：del_group_notice 把 groupCode/noticeId 传给内核 deleteGroupBulletin', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  await f.bridge.call('del_group_notice', { group_id: Number(GROUP), notice_id: '42' });
  const hit = f.calls.find(c => c[0] === 'bulletin-del');
  assert.ok(hit, '应调用 deleteGroupBulletin');
  assert.equal(hit[1], GROUP);
  // ★ 第二参以前一直是空串 —— 空 pskey 被服务端直接拒，却表现成「动作存在但永远失败」。
  assert.equal(hit[2], 'synthetic-pskey-value', 'deleteGroupBulletin 必须带真实 pskey');
  assert.equal(hit[3], '42');
});

test('群公告：取不到 pskey 时明确拒绝，不用空串去发请求', async t => {
  const f = fixture({ noPskey: true });
  t.after(() => f.bridge.detach());
  await f.bridge.attach();
  await assert.rejects(() => f.bridge.call('del_group_notice', { group_id: Number(GROUP), notice_id: '42' }),
    (error) => { assert.equal(error.retcode, 1404); return true; });
  assert.equal(f.calls.some(c => c[0] === 'bulletin-del'), false, '拿不到 pskey 就不该提交');
});

test('群公告：内核拒绝时抛错（不当作成功）', async t => {
  const f = fixture({ deleteResult: { result: -1, errMsg: 'no permission' } });
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  await assert.rejects(() => f.bridge.call('del_group_notice', { group_id: Number(GROUP), notice_id: '42' }),
    (error) => { assert.equal(typeof error.retcode, 'number'); return true; });
});

test('群公告：缺 notice_id 直接 1400，且不提交', async t => {
  const f = fixture();
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  await assert.rejects(() => f.bridge.call('del_group_notice', { group_id: Number(GROUP) }),
    (error) => { assert.equal(error.retcode, 1400); return true; });
  assert.equal(f.calls.some(c => c[0] === 'bulletin-del'), false);
});

test('群系统消息：get_group_system_msg 返回 notifies 与 total', async t => {
  const notifies = [{ seq: '1', type: 1 }, { seq: '2', type: 2 }];
  const f = fixture({ notifyPage: { result: 0, notifies } });
  t.after(() => f.bridge.detach());
  await f.bridge.attach();

  const result = await f.bridge.call('get_group_system_msg', { count: 5 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.notifies, notifies);
  const hit = f.calls.find(c => c[0] === 'notifies');
  assert.ok(hit, '应调用 getSingleScreenNotifies');
  assert.equal(hit[1], false, 'doubt 参数固定 false（只看普通系统消息）');
});
