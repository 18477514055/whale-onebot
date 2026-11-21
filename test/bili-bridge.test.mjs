import test from 'node:test';
import assert from 'node:assert/strict';
import { BiliBridge } from '../src/platforms/bilibili/bridge.mjs';

const self = 123, peer = 456;
const row = (seq, extra) => ({ msg_seqno: String(seq), msg_key: String(BigInt(seq) + 9007199254740993n),
  sender_uid: peer, receiver_id: self, receiver_type: 1, msg_type: 1, msg_source: 0, msg_status: 0,
  timestamp: 1700000000, content: JSON.stringify({content: `text ${seq}`}), ...extra });
const send = (params = {}) => ({action: 'send_private_msg', params: {user_id: peer, message: 'test', ...params}});
function fixture(t, overrides = {}, options = {}) {
  const client = {identity: async () => ({user_id: self, nickname: 'bot'}), messages: async () => [],
    sendText: async () => { throw new Error('unexpected send'); }, ...overrides};
  const bridge = new BiliBridge({client, selfId: self, peerId: peer, pollMs: 60000, ...options});
  t.after(() => bridge.close());
  const events = []; bridge.on('event', event => events.push(event));
  return {bridge, events, client};
}

test('startup verifies identity before history and never forwards client diagnostics', async t => {
  let reads = 0;
  const {bridge} = fixture(t, {identity: async () => ({user_id: peer}), messages: async () => { reads++; }});
  await assert.rejects(bridge.start(), /baseline unavailable/);
  assert.equal(reads, 0); assert.equal(bridge.status().state, 'halted');
  const b = fixture(t, {messages: () => { throw Error('sensitive fixture detail'); }}).bridge;
  await assert.rejects(b.start(), e => !e.message.includes('sensitive'));
  assert.equal((await b.dispatch({action:'get_login_info'})).retcode, 1503);
});

test('baseline, lossless exclusive pagination and chronological peer-only text events', async t => {
  const base = 9007199254740993n, at = (n, extra) => row(base + BigInt(n), extra);
  let history = [at(0)], calls = [];
  const {bridge, events} = fixture(t, {messages: async end => {
    calls.push(end); return history.filter(r => !end || BigInt(r.msg_seqno) < BigInt(end)).slice(0, 3);
  }});
  await bridge.start(); assert.deepEqual(events, []);
  history = [at(15), at(14, {msg_type:2}), at(13, {receiver_type:2}), at(12, {sender_uid:self, receiver_id:peer}),
    at(11, {sender_uid:999}), at(10, {receiver_id:999}), at(9, {msg_status:1}), at(8, {msg_source:10}),
    at(7, {msg_source:9}), at(6, {msg_source:8}), at(5, {msg_source:6}), at(4, {msg_source:99}),
    at(3, {content:'invalid'}), at(2, {msg_source:7, content:{content:'[CQ:at,qq=all]'}}), at(1), at(0)];
  await Promise.all([bridge.pollOnce(), bridge.pollOnce()]);
  assert.deepEqual(calls, [undefined, undefined, ...[13,10,7,4].map(i => String(base + BigInt(i)))]);
  assert.deepEqual(events.map(e=>e.raw_message), [`text ${base + 1n}`, '&#91;CQ:at,qq=all&#93;', `text ${base + 15n}`]);
  assert.deepEqual(events[1].message, [{type:'text', data:{text:'[CQ:at,qq=all]'}}]);
  assert.equal(events[1].platform, 'bilibili'); assert.equal(events[1].sender.user_id, peer);
  assert.equal(events[1].self_id, self); assert.equal(events[1].message_type, 'private');
  assert.equal(new Set(events.map(e=>e.message_id)).size, 3);
  assert(events.every(e => Number.isInteger(e.message_id) && e.message_id > 0 && e.message_id <= 0x7fffffff));
  history.unshift(at(16, {msg_key:at(15).msg_key})); await bridge.pollOnce(); assert.equal(events.length, 3);
});

test('pre-filtered empty pages retain startup high-water mark and next cursor', async t => {
  let baseline = true; const calls = [];
  const {bridge, events} = fixture(t, {messages: async end => {
    calls.push(end);
    if (baseline) return Object.assign([], {highSeqno:'90',nextCursor:'42'});
    if (!end) return Object.assign([], {highSeqno:'160',nextCursor:'111'});
    assert.equal(end,'111'); return Object.assign([row(99),row(89)], {highSeqno:'109',nextCursor:null});
  }});
  await bridge.start(); baseline = false; await bridge.pollOnce();
  assert.deepEqual(calls,[undefined,undefined,'111']); assert.deepEqual(events.map(x=>x.raw_message),['text 99']);
});

test('startup exposes only allowlisted diagnostic codes; discovery matches send gate', async t => {
  for (const [code, expected] of [['BILI_HTTP_412','BILI_HTTP_412'],['unsafe_private_detail','BILI_HISTORY_BASELINE']]) {
    const {bridge} = fixture(t, {messages: async () => { throw Object.assign(Error('private detail'),{code}); }});
    await assert.rejects(bridge.start(), e => e.code === expected && !e.message.includes('private detail'));
    assert.equal(bridge.status().reason,expected);
  }
  for (const allowSend of [false,true]) {
    const {bridge} = fixture(t, {}, {allowSend}); await bridge.start();
    const list = (await bridge.dispatch({action:'get_supported_actions'})).data;
    assert(list.includes('get_supported_actions')); assert.equal(list.includes('send_private_msg'),allowSend);
  }
});

test('a failed middle page neither commits the cursor nor publishes partial events', async t => {
  let stage = 0;
  const {bridge, events} = fixture(t, {messages: async end => {
    if (!stage) return [row(1)]; if (!end) return [row(4)];
    if (stage === 1) throw Error('redact'); return [row(3), row(2)];
  }});
  await bridge.start(); stage = 1; await bridge.pollOnce(); assert.deepEqual(events, []);
  assert.equal(bridge.status().good, false); stage = 2; await bridge.pollOnce();
  assert.deepEqual(events.map(e=>e.raw_message), ['text 2','text 3','text 4']); assert.equal(bridge.status().good, true);
});

test('fatal reads and non-progressing pages halt without replay or further I/O', async t => {
  for (const fail of [false, true]) {
    let calls = 0;
    const {bridge, events} = fixture(t, {messages: async () => {
      if (++calls === 1) return [];
      if (fail) throw Object.assign(Error('secret detail'), {fatal:true}); return [row(10)];
    }}, {allowSend:true});
    await bridge.start(); await bridge.pollOnce(); assert.equal(bridge.status().state, 'halted');
    assert.deepEqual(events, []); assert.equal((await bridge.dispatch(send())).retcode, 1503);
    await bridge.pollOnce(); assert.equal(calls, fail ? 2 : 3); assert(!JSON.stringify(bridge.status()).includes('secret'));
  }
});

test('read-only identity, platform/status and unsupported actions', async t => {
  const {bridge} = fixture(t); await bridge.start();
  assert.deepEqual((await bridge.dispatch({action:'get_login_info',echo:7})),
    {status:'ok',retcode:0,data:{platform:'bilibili',user_id:self,nickname:'bot'},echo:7});
  assert.equal((await bridge.dispatch(send())).retcode, 1403);
  assert.equal((await bridge.dispatch({action:'send_group_msg'})).retcode, 1404);
  assert.equal((await bridge.dispatch({action:'get_status'})).data.read_only, true);
});

test('write gate rejects group, other peer, CQ/media, malformed and oversized text before send', async t => {
  const sent = [];
  const {bridge} = fixture(t, {sendText: async text => { sent.push(text); return {msg_key:'9007199254740999'}; }}, {allowSend:true});
  await bridge.start();
  for (const params of [{user_id:'456.0'}, {user_id:self}, {group_id:0}, {message_type:'group'},
    {message:'[CQ:image,file=test]'}, {message:[{type:'image',data:{}}]}, {message:{type:'text',data:{text:55}}},
    {message:'x'.repeat(501)}, {message:'  '}]) assert.notEqual((await bridge.dispatch(send(params))).retcode, 0);
  assert.deepEqual(sent, []);
  const result = await bridge.dispatch({action:'send_msg',params:{user_id:String(peer),message:[{type:'text',data:{text:'ok'}},{type:'text',data:{text:'👍'}}]}});
  assert.equal(result.retcode, 0); assert(Number.isInteger(result.data.message_id)); assert.deepEqual(sent,['ok👍']);
  assert.equal((await bridge.dispatch(send())).retcode, 1429); assert.equal(sent.length, 1);
});

test('definite rejection vs unknown send outcome, fatal halt, redaction, no resend', async t => {
  for (const [outcome, fatal, receipt, expected, state] of [
    ['not_sent',false,null,1500,'running'], ['not_sent',true,null,1500,'halted'],
    ['unknown',false,null,1504,'running'], ['unknown',true,null,1504,'halted'], [null,false,{},1504,'running'],
  ]) {
    let count = 0;
    const {bridge} = fixture(t, {sendText: async () => {
      count++; if (receipt) return receipt; throw Object.assign(Error('sensitive fixture detail'), {outcome, fatal});
    }}, {allowSend:true}); await bridge.start(); const result = await bridge.dispatch(send());
    assert.equal(result.retcode, expected); assert.equal(bridge.status().state, state);
    assert.equal(count, 1); assert(!JSON.stringify(result).includes('sensitive'));
  }
});

test('close during an in-flight poll drops late events and prevents new sends', async t => {
  let release, first = true;
  const {bridge, events} = fixture(t, {messages: () => {
    if (first) { first = false; return []; } return new Promise(resolve => { release = resolve; });
  }}, {allowSend:true}); await bridge.start(); const pending = bridge.pollOnce(), closing = bridge.close();
  release([row(1)]); await Promise.all([pending,closing]); assert.deepEqual(events, []);
  assert.equal((await bridge.dispatch(send())).retcode, 1503);
});
