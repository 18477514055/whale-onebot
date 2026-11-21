import WebSocket from 'ws';
import { lookup } from 'node:dns';
import { BlockList, isIPv4 } from 'node:net';
import { MAX_FRAME, packet, unpack, liveEvent } from './live-protocol.mjs';

const API = 'https://api.live.bilibili.com';
const err = code => Object.assign(new Error(code), {code});
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(ip,bits);
export const publicV4 = ip => isIPv4(ip) && !blocked.check(ip);
function dial(url) {
  // Pin the actual connect() to a checked public A record; retain TLS hostname verification.
  return new WebSocket(url, {family:4, agent:false, handshakeTimeout:10000, followRedirects:false,
    maxPayload:MAX_FRAME, perMessageDeflate:false, lookup(host, _opts, cb) {
      lookup(host, {all:true, family:4}, (error, rows) => {
        const ip = !error && rows.find(r => publicV4(r.address));
        if (!ip) return cb(err('BILI_LIVE_HOST'));
        cb(null, ip.address, 4);
      });
    }});
}
function room(v) {
  if (!['number','string'].includes(typeof v) || !/^[1-9]\d{0,15}$/.test(String(v)) || !Number.isSafeInteger(Number(v))) throw new TypeError('Invalid room_id');
  return Number(v);
}
async function resolveRoom(ctx, id) {
  const data = await ctx.request({url:API+'/room/v1/Room/get_info', query:{room_id:id}});
  try { return room(data?.room_id); } catch { throw err('BILI_LIVE_ROOM'); }
}
function wsUrl(info) {
  const host = Array.isArray(info?.host_list) && info.host_list.find(x => typeof x?.host === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.chat\.bilibili\.com$/.test(x.host) && x.host.trim() === x.host)?.host;
  if (!host || typeof info.token !== 'string' || !info.token.length || info.token.length > 8192) throw err('BILI_LIVE_DISCOVERY');
  return `wss://${host}/sub`;
}
const view = s => ({room_id:s.real ?? s.id, subscription_id:s.id, state:s.phase});

export function createLiveActions({connect = dial, retryMs = 2000, heartbeatMs = 30000} = {}) {
  const contexts = new WeakMap();
  function state(ctx) {
    if (!contexts.has(ctx)) {
      const state = {rooms:new Map(), closed:false, lastSend:-Infinity, sending:false, challenged:false};
      contexts.set(ctx,state);
      ctx.onClose(() => { state.closed = true; for (const sub of state.rooms.values()) sub.stop('closed'); });
    }
    const state = contexts.get(ctx); if (state.closed) throw err('BILI_LIVE_CLOSED'); return state;
  }
  const find = (state, id) => state.rooms.get(id) ?? [...state.rooms.values()].find(s => s.real === id);
  function subscribe(ctx, p) {
    const id = room(p.room_id), st = state(ctx), existing = find(st,id);
    if (existing) return view(existing);
    if (st.challenged) throw err('BILI_LIVE_CHALLENGE');
    if (st.rooms.size >= 8) throw new RangeError('Live subscription limit reached');
    const s = {id, phase:'connecting'}; st.rooms.set(id,s);
    let ws, timer, pulse, retry, done = false, retried = false;
    function emit(fields) {
      if (st.closed) return;
      try { ctx.emit({time:Math.floor(Date.now()/1000), self_id:Number(ctx.selfId), platform:'bilibili', post_type:'notice', notice_type:'bili_live', room_id:s.real ?? id, subscription_id:id, ...fields}); }
      catch { stop('delivery_failed'); }
    }
    function clear() {
      clearTimeout(timer); clearTimeout(retry); clearInterval(pulse);
      const old = ws; ws = null; old?.terminate();
    }
    function stop(reason, notify = false) {
      if (done) return; done = true; st.rooms.delete(id); clear();
      if (notify) emit({sub_type:'status', state:'stopped', reason});
    }
    s.stop = stop;
    async function start() {
      if (!s.real) {
        const real = await resolveRoom(ctx,id); if (done) throw err('BILI_LIVE_CLOSED');
        if ([...st.rooms.values()].some(x => x !== s && x.real === real)) throw err('BILI_LIVE_DUPLICATE');
        s.real = real;
      }
      const info = await ctx.request({url:API+'/xlive/web-room/v1/index/getDanmuInfo', wbi:true, query:{id:s.real, type:0, web_location:'444.8'}});
      if (done) throw err('BILI_LIVE_CLOSED');
      const sock = connect(wsUrl(info)); ws = sock; s.phase = 'connecting';
      let key = info.token, ack = true;
      timer = setTimeout(() => stop('authentication_timeout',true), 12000); timer.unref();
      sock.on('open', () => {
        if (ws !== sock) return;
        try { sock.send(packet(7,{uid:0, roomid:s.real, protover:2, buvid:'', platform:'web', type:2, key})); }
        catch { stop('socket_error',true); } finally { key = null; }
      });
      sock.on('message',(bytes,binary) => {
        if (ws !== sock) return;
        try {
          if (!binary) throw err('BILI_LIVE_PROTOCOL');
          for (const {op,data} of unpack(bytes)) {
            if (ws !== sock) break;
            if (op === 8) {
              if (data?.code !== 0) { challenge(st); return; }
              if (s.phase !== 'connecting') throw err('BILI_LIVE_PROTOCOL');
              clearTimeout(timer); s.phase = 'active';
              pulse = setInterval(() => {
                if (!ack) return stop('heartbeat_timeout',true);
                ack = false; try { sock.send(packet(2)); } catch { stop('socket_error',true); }
              },heartbeatMs); pulse.unref(); emit({sub_type:'status',state:'active'});
            } else if (s.phase === 'active') {
              if (op === 3) { ack = true; emit({sub_type:'popularity',count:data}); }
              else { const event = liveEvent(data); if (event) emit(event); }
            }
          }
        } catch { stop('invalid_frame',true); }
      });
      sock.on('unexpected-response',(_request,response) => {
        if (ws !== sock) return;
        if ([401,403,412,429].includes(response.statusCode)) challenge(st);
        else stop('handshake_failed',true);
        response.destroy();
      });
      sock.on('error',() => { if (ws === sock) stop('socket_error',true); });
      sock.on('close',code => {
        if (ws !== sock) return;
        if (code === 1008) return challenge(st);
        if (code !== 1006 || retried || s.phase !== 'active') return stop('disconnected',true);
        retried = true; clear(); s.phase = 'reconnecting'; emit({sub_type:'status',state:s.phase});
        retry = setTimeout(() => start().catch(e => { if (isChallenge(e)) challenge(st); else stop('reconnect_failed',true); }),retryMs); retry.unref();
      });
      return view(s);
    }
    return start().catch(e => { if (isChallenge(e)) challenge(st); else stop('discovery_failed'); throw e; });
  }
  const isChallenge = e => e?.fatal === true || /(?:CHALLENGE|RISK|API_-(?:352|401|403|412|509)|HTTP_(?:401|403|412|429))/.test(String(e?.code));
  function challenge(st) { st.challenged = true; for (const s of st.rooms.values()) s.stop('challenge',true); }
  return {
    bili_live_subscribe:{params:['room_id'],write:false, run:async(ctx,p) => subscribe(ctx,p)},
    bili_live_unsubscribe:{params:['room_id'],write:false, run:async(ctx,p) => { const s = find(state(ctx),room(p.room_id)); s?.stop('unsubscribed'); return {removed:!!s}; }},
    bili_live_subscriptions:{params:[],write:false, run:async ctx => ({rooms:[...state(ctx).rooms.values()].map(view)})},
    bili_send_live_text:{params:['room_id','text'],write:true, run:async(ctx,p) => {
      const id = room(p.room_id), msg = p.text;
      if (typeof msg !== 'string' || !msg.trim() || [...msg].length > 20 || /[\u0000-\u001f\u007f]/u.test(msg)) throw new TypeError('Invalid live text');
      const st = state(ctx);
      if (st.challenged) throw err('BILI_LIVE_CHALLENGE');
      if (st.sending || Date.now() - st.lastSend < 10000) throw err('BILI_LIVE_COOLDOWN');
      st.sending = true;
      try {
        const real = await resolveRoom(ctx,id); if (st.closed || st.challenged) throw err('BILI_LIVE_STOPPED');
        st.lastSend = Date.now();
        return await ctx.request({url:API+'/msg/send', method:'POST', wbi:true, form:{roomid:real,msg,color:16777215,fontsize:25,mode:1,rnd:Math.floor(Date.now()/1000),data_extend:'{}'}});
      } catch (e) { if (isChallenge(e)) challenge(st); throw e; } finally { st.sending = false; }
    }}
  };
}
export const liveActions = createLiveActions();
