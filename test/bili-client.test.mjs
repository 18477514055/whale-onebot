import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BiliClient } from '../src/platforms/bilibili/client.mjs';

const device = '01020304-0000-4000-8000-001122334455';
const config = { selfId: '11', peerId: '22', deviceId: device, cookie: 'SESSDATA=mock-only; bili_jct=test-only' };
const nav = { code: 0, data: { mid: 11, uname: 'Test', isLogin: true,
  wbi_img: { img_url: 'https://example.invalid/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://example.invalid/4932caff0ff746eab6f01bf08b70ac45.png' } } };
function setup(items, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), ...options });
    if (!items.length) throw Error('unexpected mock fetch');
    const next = items.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : new Response(typeof next === 'string' ? next : JSON.stringify(next));
  };
  return { client: new BiliClient({ ...config, ...overrides, fetchImpl }), calls };
}
const row = (sender,receiver,type,seq) => `{"sender_uid":${sender},"receiver_id":${receiver},"receiver_type":${type},"msg_seqno":${seq},"msg_key":9223372036854775807,"content":"mock"}`;
test('nav verifies both login and configured identity, and fatal failure stops later traffic', async () => {
  for (const bad of [{ ...nav.data, isLogin: false }, { ...nav.data, mid: 22 }]) {
    const { client, calls } = setup([nav, { code: 0, data: bad }]);
    assert.deepEqual(await client.identity(), { user_id: '11', nickname: 'Test' });
    await assert.rejects(client.sendText('test'), { outcome: 'not_sent', fatal: true });
    await assert.rejects(client.messages(), { fatal: true });
    assert.deepEqual(calls.map(c => c.url.href), Array(2).fill('https://api.bilibili.com/x/web-interface/nav'));
  }
});
test('history requests one exclusive page; filters peer and preserves exact numeric tokens', async () => {
  const records = [row(11,22,1,2),row(33,11,1,9),row(22,11,2,10),row(22,11,1,'9007199254740993')];
  const { client, calls } = setup([nav,`{"code":0,"data":{"messages":[${records}]}}`,{ code: 0, data: { messages: null } }]);
  const rows = await client.messages('9007199254740995');
  assert.deepEqual(rows.map(r => [r.msg_seqno,r.msg_key]), [['9007199254740993','9223372036854775807'],[2,'9223372036854775807']]);
  assert.equal(calls[1].url.origin + calls[1].url.pathname,'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs');
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams),{ talker_id:'22', session_type:'1',size:'50',mobi_app:'web',end_seqno:'9007199254740995' });
  assert.deepEqual(await client.messages(), []);
  assert.equal(calls[2].url.searchParams.has('end_seqno'),false);
  await assert.rejects(client.messages(9007199254740992), /cursor/);
  assert.equal(calls.length,3);
});
test('send signs only public routing parameters and returns the exact confirmed receipt', async () => {
  const { client, calls } = setup([nav,'{"code":0,"data":{"msg_key":9223372036854775807,"key_hit_infos":{}}}']);
  const text = 'test: 你好 & =\n🙂';
  assert.deepEqual(await client.sendText(text), { msg_key: '9223372036854775807' });
  assert.equal(calls.length,2);
  const req = calls[1], q = req.url.searchParams, time = q.get('wts');
  assert.equal(req.method,'POST'); assert.equal(req.redirect,'manual');
  assert.equal(req.url.origin + req.url.pathname, 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg');
  const canonical = `w_dev_id=${device}&w_receiver_id=22&w_sender_uid=11&wts=${time}`;
  // Published WBI example uses this independently known mixed key.
  const key = 'ea1db124af3c7062474693fa704f4ff8';
  assert.equal(q.get('w_rid'),createHash('md5').update(canonical + key).digest('hex'));
  assert.equal(req.url.search, '?' + canonical + '&w_rid=' + q.get('w_rid'));
  assert.deepEqual(Object.fromEntries(req.body), { 'msg[sender_uid]':'11','msg[receiver_id]':'22','msg[receiver_type]':'1','msg[msg_type]':'1','msg[content]':JSON.stringify({content:text}),'msg[timestamp]':time,'msg[dev_id]':device,csrf_token:'test-only',csrf:'test-only',mobi_app:'web' });
  assert.equal(req.headers.Cookie,config.cookie);
});
test('unconfirmed, malformed and blocked POSTs never yield success or retry; errors omit private data', async () => {
  for (const [raw, outcome] of [[{code:0,data:{}},'unknown'],[{'code':0,data:{msg_key:'18446744073709551616'}},'unknown'],
    ['{"code":0,"data":{"msg_key":1e12}}','unknown'],[{ code:0,data:{msg_key:1,key_hit_infos:{toast:'private'}} },'unknown'],
    [{code:-352,message:'private response'},'not_sent'],[new Response('',{status:412}),'unknown'],['<html>private</html>','unknown'],[Error(config.cookie),'unknown']]) {
    const { client,calls } = setup([nav,raw]);
    await assert.rejects(client.sendText('private request'), err => err.outcome === outcome && !/private|mock-only|test-only/i.test(err.message));
    assert.equal(calls.length,2);
  }
});
test('filtered pages retain non-enumerable pagination boundaries, no unrelated content', async () => {
  const { client } = setup([nav,`{"code":0,"data":{"messages":[${row(33,11,1,12)},${row(33,11,1,11)}],"has_more":1,"min_seqno":11}}`,
    '{"code":0,"data":{"messages":null,"has_more":0}}']);
  const page = await client.messages();
  assert.deepEqual(page, []); assert.equal(page.highSeqno,'12'); assert.equal(page.nextCursor,'11');
  const last = await client.messages(page.nextCursor);
  assert.equal(last.highSeqno,null); assert.equal(last.nextCursor,null);
});
test('risk responses latch; peer limits and ambiguous receipts do not block a read', async () => {
  const blocked = setup([nav,{ code:-101 }]);
  await assert.rejects(blocked.client.messages(),{ fatal:true,code:'BILI_API_-101' });
  await assert.rejects(blocked.client.identity(),{fatal:true}); assert.equal(blocked.calls.length,2);
  for (const [data,outcome] of [[{ code:21047 },'not_sent'], [{ code:0, data:{} },'unknown']]) {
    const {client,calls} = setup([nav,data,nav]);
    await assert.rejects(client.sendText('test'),{ fatal:false,outcome });
    assert.deepEqual(await client.identity(), {user_id:'11',nickname:'Test'});
    assert.equal(calls.filter(c=>c.method==='POST').length,1);
  }
});
test('missing signing keys, invalid credentials, blank or oversize text cannot issue POST', async () => {
  const { client,calls } = setup([{code:0,data:{...nav.data,wbi_img:null}}]);
  await assert.rejects(client.sendText(' '),{outcome:'not_sent'});
  await assert.rejects(client.sendText('🙂'.repeat(501)),{outcome:'not_sent'});
  await assert.rejects(client.sendText('test'),{outcome:'not_sent',fatal:false});
  assert.deepEqual(calls.map(c=>c.method),['GET']);
  for (const overrides of [{cookie:'a=1'},{cookie:'SESSDATA=a\r\nX: foo'},{cookie:'SESSDATA=a; SESSDATA=b'},{deviceId:'invalid'},{peerId:11}]) assert.throws(()=>setup([],overrides));
  const readOnly = setup([], { cookie:'SESSDATA=mock',deviceId:undefined });
  await assert.rejects(readOnly.client.sendText('test'),{outcome:'not_sent'});
  assert.equal(readOnly.calls.length,0);
});
