import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAccountActions } from '../src/platforms/bilibili/account-actions.mjs';

// 假的 web client：只记录被请求过什么，绝不发网络。
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    async request(options) {
      calls.push(options);
      if (typeof reply === 'function') return reply(options);
      return reply ?? { rpid_str: '1234567890123456789' };
    },
  };
}

const base = { selfId: '42', peerId: null, deviceId: 'dev', allowWrites: true, emit: () => {}, onClose: () => {} };

describe('B 站发评论：没有浏览器时必须有纯 Node 回退', () => {
  it('1. 没浏览器也注册 bili_send_comment（否则手机上是 1404）', () => {
    const has = createAccountActions({ ...base, client: fakeClient(), browser: null, allowWrites: true });
    assert.ok(has.names().includes('bili_send_comment'), '纯 Node 回退版必须被注册');
    assert.equal(has.get('bili_send_comment').browser, undefined, '选中的不是浏览器版');
  });

  it('2. allowWrites=false 时不注册写动作；true 时注册', () => {
    const readonly = createAccountActions({ ...base, client: fakeClient(), browser: null, allowWrites: false });
    assert.equal(readonly.names().includes('bili_send_comment'), false, 'allowWrites=false 必须挡住写动作');
    const writable = createAccountActions({ ...base, client: fakeClient(), browser: null, allowWrites: true });
    assert.equal(writable.names().includes('bili_send_comment'), true);
  });

  it('3. 纯 Node 路径打的是 x/v2/reply/add，带 oid/type/message/plat，rpid 转成字符串', async () => {
    const client = fakeClient({ rpid_str: '9876543210123456789' });
    const actions = createAccountActions({ ...base, client, browser: null });
    const spec = actions.get('bili_send_comment');
    const out = await actions.run(spec, { oid: '170001', message: '冰鱼那段真没想到' });
    assert.equal(client.calls.length, 1);
    const [call] = client.calls;
    assert.equal(call.url, 'https://api.bilibili.com/x/v2/reply/add');
    assert.equal(call.method, 'POST');
    assert.equal(call.wbi, true);
    assert.deepEqual(call.form, { oid: '170001', type: 1, message: '冰鱼那段真没想到', plat: 1 });
    assert.equal(typeof out.rpid, 'string', 'rpid 超过 2^53，必须当字符串传');
    assert.equal(out.rpid, '9876543210123456789');
  });

  it('4. 楼层回复把 root/parent 一起带上', async () => {
    const client = fakeClient();
    const actions = createAccountActions({ ...base, client, browser: null });
    await actions.run(actions.get('bili_send_comment'), { oid: '1', message: '同意楼上', root: '111', parent: '222' });
    assert.equal(client.calls[0].form.root, '111');
    assert.equal(client.calls[0].form.parent, '222');
  });

  it('5. 参数非法 / 回执缺 rpid 都如实报错，不假装成功', async () => {
    const actions = createAccountActions({ ...base, client: fakeClient({}), browser: null });
    const spec = actions.get('bili_send_comment');
    await assert.rejects(() => actions.run(spec, { oid: 'x', message: 'a' }), /invalid_oid/);
    await assert.rejects(() => actions.run(spec, { oid: '1', message: '   ' }), /invalid_message/);
    await assert.rejects(() => actions.run(spec, { oid: '1', message: 'ok' }), /missing_rpid/);
    assert.throws(() => actions.run(spec, { oid: '1', message: 'ok', url: 'https://evil' }), /Unknown action parameter/);
  });

  it('6. 有浏览器时仍然优先浏览器版（不改变原来行为）', async () => {
    const browser = { comment: async () => ({ rpid: '777' }) };
    const actions = createAccountActions({ ...base, client: fakeClient(), browser });
    const out = await actions.run(actions.get('bili_send_comment'), { oid: '1', message: 'hi' });
    assert.equal(out.rpid, '777');
  });
});
