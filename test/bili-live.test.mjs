import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { deflateSync, brotliCompressSync } from 'node:zlib';
import { setImmediate as turn } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createLiveActions, publicV4 } from '../src/platforms/bilibili/actions/live.mjs';
import { packet, unpack, MAX_FRAME, liveEvent } from '../src/platforms/bilibili/actions/live-protocol.mjs';

const HOST = 'fixture.chat.bilibili.com';
const fixture = {token:'synthetic-handshake',host_list:[{host:HOST}]};
function context(info = fixture) {
  const events = [], calls = [], handlers = [];
  return {ctx:{selfId:'99',emit:e => events.push(e),onClose:f => handlers.push(f),request:async req => {
    calls.push(req); return req.url.endsWith('get_info') ? {room_id:700} : req.url.endsWith('/msg/send') ? {sent:true} : info;
  }}, events,calls,close:() => handlers.forEach(f => f())};
}
function frame(op,v,body) {
  const h = packet(op); h.writeUInt16BE(v,6); h.writeUInt32BE(16+body.length); return Buffer.concat([h,body]);
}
const cmd = (name,data) => packet(5,{cmd:name,data});
const pb = Buffer.from([8,42,18,3,66,111,98,40,1]).toString('base64');
const msgs = [packet(5,{cmd:'DANMU_MSG:4',info:[[], 'fixture text', [42,'Bob']]}),cmd('INTERACT_WORD_V2',{pb}),cmd('SEND_GIFT',{uid:42,uname:'Bob',giftId:1,giftName:'star',num:2}),cmd('ONLINE_RANK_COUNT',{count:3}),cmd('ONLINE_RANK_V3',{pb:'CgA='}),cmd('WATCHED_CHANGE',{num:22})];
class Sock extends EventEmitter { sent = []; send(b){this.sent.push(b);} terminate(){this.terminated=true;} }
function mock(options = {}) {
  const sockets = [], urls = [];
  const actions = createLiveActions({connect:url => {urls.push(url); const s = new Sock(); sockets.push(s); return s;}, ...options});
  return {sockets,urls,run:(name,ctx,p={room_id:6}) => actions['bili_'+name].run(ctx,p)};
}

test('loopback WS: guest auth, packed notices, heartbeat, unsubscribe and disposal', {timeout:5000}, async t => {
  const wss = new WebSocketServer({host:'127.0.0.1',port:0});
  t.after(() => { for(const c of wss.clients)c.terminate(); wss.close(); });
  await once(wss,'listening');
  const {ctx,events,calls,close} = context(); t.after(close);
  const pulse = Promise.withResolvers(), batch = Promise.withResolvers();
  ctx.emit = e => {events.push(e); if (e.sub_type === 'popularity') batch.resolve();};
  const peer = once(wss,'connection');
  const {run} = mock({heartbeatMs:40,connect:url => { assert.equal(url,`wss://${HOST}/sub`); return new WebSocket(`ws://127.0.0.1:${wss.address().port}`); }});
  assert.equal((await run('live_subscribe',ctx)).state,'connecting');
  const [ws,req] = await peer; assert.equal(req.headers.cookie,undefined);
  const [auth] = await once(ws,'message'); assert.equal(auth.readUInt32BE(8),7);
  assert.deepEqual(JSON.parse(auth.subarray(16)),{uid:0, roomid:700, protover:2, buvid:'', platform:'web',type:2,key:'synthetic-handshake'});
  ws.on('message',b => { if (b.readUInt32BE(8) === 2) {pulse.resolve(); ws.send(frame(3,1,Buffer.from([0,0,0,12])));} });
  ws.send(packet(8,{code:0})); ws.send(frame(5,2,deflateSync(Buffer.concat(msgs))));
  await pulse.promise; await batch.promise;
  assert.deepEqual(events.map(e => e.sub_type),['status','danmu','presence','gift','rank_count','rank_update','watched','popularity']);
  assert.ok(events.every(e => e.self_id === 99 && e.post_type === 'notice' && e.notice_type === 'bili_live' && e.room_id === 700 && e.subscription_id === 6));
  assert.equal(events[1].text,'fixture text'); assert.equal(events[2].user_id,'42'); assert.equal(events[2].nickname,'Bob');
  assert.equal(events[3].quantity,2); assert.equal(events.at(-1).count,12);
  assert.ok(!JSON.stringify(events).includes(fixture.token));
  assert.deepEqual(calls[1].query,{id:700,type:0,web_location:'444.8'}); assert.equal(calls[1].wbi,true);
  assert.equal((await run('live_subscribe',ctx,{room_id:700})).state,'active'); assert.equal(calls.length,2);
  const disconnected = once(ws,'close'); assert.deepEqual(await run('live_unsubscribe',ctx),{removed:true}); await disconnected;
  assert.deepEqual(await run('live_subscriptions',ctx),{rooms:[]}); close(); await assert.rejects(run('live_subscribe',ctx),{code:'BILI_LIVE_CLOSED'});
});

test('challenge latches only this context; close cancels pending discovery', async () => {
  const a = context(), b = context(), {run,sockets} = mock();
  await run('live_subscribe',a.ctx); await run('live_subscribe',b.ctx);
  sockets[0].emit('message',packet(8,{code:-352, detail:'never expose'}),true);
  assert.ok(sockets[0].terminated); assert.equal(sockets[1].terminated,undefined);
  await assert.rejects(run('live_subscribe',a.ctx),{code:'BILI_LIVE_CHALLENGE'});
  await assert.rejects(run('send_live_text',a.ctx,{room_id:6,text:'hi'}),{code:'BILI_LIVE_CHALLENGE'});
  assert.equal(a.events.at(-1).reason,'challenge'); assert.ok(!JSON.stringify(a.events).includes('never expose'));
  b.close(); assert.ok(sockets[1].terminated); sockets[1].emit('message',msgs[0],true); assert.equal(b.events.length,0);
  const c = context(); const deferred = Promise.withResolvers(); c.ctx.request = () => deferred.promise;
  const pending = run('live_subscribe',c.ctx); c.close(); deferred.resolve({room_id:700});
  await assert.rejects(pending,{code:'BILI_LIVE_CLOSED'}); assert.equal(sockets.length,2);
});

test('authenticated network loss allows only one reconnect; never retries policy refusal', async () => {
  const c = context(), {run,sockets} = mock({retryMs:1}); await run('live_subscribe',c.ctx);
  const reconnect = Promise.withResolvers(); c.ctx.request = async () => {reconnect.resolve(); return fixture;};
  sockets[0].emit('message',packet(8,{code:0}),true); sockets[0].emit('close',1006);
  const alive = setTimeout(()=>{},1000); try {await reconnect.promise; await turn();} finally {clearTimeout(alive);}
  assert.equal(sockets.length,2); sockets[1].emit('message',packet(8,{code:0}),true); sockets[1].emit('close',1006);
  assert.deepEqual(await run('live_subscriptions',c.ctx),{rooms:[]});
  c.close();
});

test('HTTP challenge during discovery or upgrade stops the instance without retry', async () => {
  const c = context(), {run,sockets} = mock();
  const challenge = Object.assign(new Error('fixture rejection'),{code:'BILI_API_-352'});
  c.ctx.request = async r => {if(r.wbi) throw challenge; return {room_id:700};};
  await assert.rejects(run('live_subscribe',c.ctx),{code:'BILI_API_-352'});
  await assert.rejects(run('live_subscribe',c.ctx),{code:'BILI_LIVE_CHALLENGE'}); assert.equal(sockets.length,0);
  const d = context(); await run('live_subscribe',d.ctx); let destroyed = false;
  sockets[0].emit('unexpected-response',null,{statusCode:403,destroy:()=>{destroyed=true;}});
  assert.ok(destroyed); assert.ok(sockets[0].terminated);
  await assert.rejects(run('live_subscribe',d.ctx),{code:'BILI_LIVE_CHALLENGE'}); assert.equal(sockets.length,1);
});

test('bounded frames, Brotli, malformed protobuf and public host policy', async () => {
  assert.equal(unpack(frame(5,3,brotliCompressSync(msgs[0])))[0].data.info[1],'fixture text');
  assert.throws(() => unpack(Buffer.alloc(5))); assert.throws(() => unpack(Buffer.alloc(MAX_FRAME+1)));
  assert.throws(() => unpack(frame(5,2,deflateSync(Buffer.alloc(4*MAX_FRAME+1)))));
  assert.equal(liveEvent({cmd:'INTERACT_WORD_V2',data:{pb:'gA=='}}),null);
  for (const host of ['127.0.0.1','user@'+HOST,HOST+'.bad.net',HOST+':9000','https://'+HOST,HOST+'\n']) {
    const c=context({token:'x',host_list:[{host}]}), {run,urls} = mock();
    await assert.rejects(run('live_subscribe',c.ctx),{code:'BILI_LIVE_DISCOVERY'}); assert.equal(urls.length,0);
  }
  for (const addr of ['127.0.0.1','10.0.0.1','169.254.169.254','172.31.0.1','192.168.0.1','198.18.0.1','224.0.0.1','::1']) assert.equal(publicV4(addr),false);
  assert.equal(publicV4('8.8.8.8'),true);
});

test('W1 fixed one-shot signed form; validates text and never retries unknown outcome', async () => {
  const c = context(), {run} = mock(), send = text => run('send_live_text',c.ctx,{room_id:'6',text});
  assert.equal(createLiveActions().bili_send_live_text.write,true);
  for (const bad of [[], ' ', 'x'.repeat(21), 'a\nb']) await assert.rejects(send(bad),TypeError);
  assert.equal(c.calls.length,0); assert.deepEqual(await send('hello'),{sent:true});
  const req = c.calls.at(-1); assert.equal(req.url,'https://api.live.bilibili.com/msg/send');
  assert.equal(req.method,'POST'); assert.equal(req.form.roomid,700); assert.equal(req.form.msg,'hello');
  assert.equal(req.wbi,true); assert.ok(!('csrf' in req.form)); await assert.rejects(send('again'),{code:'BILI_LIVE_COOLDOWN'});
  const b = context(); let writes = 0; b.ctx.request = async r => {if(r.method==='POST'){writes++; throw new Error('uncertain');}return {room_id:700};};
  const retry = () => run('send_live_text',b.ctx,{room_id:6,text:'hi'});
  await assert.rejects(retry(),/uncertain/); await assert.rejects(retry(),{code:'BILI_LIVE_COOLDOWN'}); assert.equal(writes,1);
});
