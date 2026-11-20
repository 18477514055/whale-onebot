import {action, bfs, id, int, invalid} from './publish-validation.mjs';

const IM = 'https://api.vc.bilibili.com/';
const SESSION = IM+'session_svr/v1/session_svr/';
const HISTORY = IM+'svr_sync/v1/svr_sync/fetch_session_msgs';
function peers(ctx) {return {self:id(ctx.selfId,'self'),peer:id(ctx.peerId,'peer')};}
function list(data,key) {
  if (data?.[key] === null) return [];
  if (!Array.isArray(data?.[key])) throw new Error('Invalid Bilibili page');
  return data[key];
}
function cursor(data,rows,key,before) {
  if (data.has_more === 0) return null;
  if (data.has_more !== 1 || !rows.length) throw new Error('Invalid Bilibili page boundary');
  const min = rows.reduce((acc,r) => {const n=BigInt(id(r?.[key],'upstream cursor')); return acc === null || n<acc ? n:acc;},null);
  if (before && min >= BigInt(before)) throw new Error('Non-advancing Bilibili cursor');
  return String(min);
}
function sameId(value,known) {return (typeof value === 'string' || Number.isSafeInteger(value)) && String(value) === known;}
function visible(m,self,peer) {
  return m?.receiver_type === 1 && m.msg_status === 0 && Number(m.msg_source) !== 8 &&
    ((sameId(m.sender_uid,self) && sameId(m.receiver_id,peer)) || (sameId(m.sender_uid,peer) && sameId(m.receiver_id,self)));
}
function device(ctx) {
  if (typeof ctx.deviceId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(ctx.deviceId)) invalid('configured device');
  return ctx.deviceId;
}
async function send(ctx,type,content) {
  const {self,peer}=peers(ctx), dev=device(ctx);
  const data=await ctx.request({url:IM+'web_im/v1/web_im/send_msg',method:'POST',wbi:true,
    query:{w_sender_uid:self,w_receiver_id:peer,w_dev_id:dev}, form:{'msg[sender_uid]':self,'msg[receiver_id]':peer,'msg[receiver_type]':1,'msg[msg_type]':type,
      'msg[msg_status]':0,'msg[content]':content,'msg[dev_id]':dev,'msg[timestamp]':Math.floor(Date.now()/1000),mobi_app:'web'}});
  try {
    const key=id(data?.msg_key,'receipt');
    if (data.key_hit_infos != null && Object.keys(data.key_hit_infos).length) throw Error();
    return {msg_key:key};
  } catch {throw Object.assign(new Error('Unconfirmed Bilibili message receipt'),{outcome:'unknown'});}
}
function history(ctx,size,end) {
  return ctx.request({url:HISTORY,query:{talker_id:peers(ctx).peer,session_type:1,size,mobi_app:'web',...(end && {end_seqno:end})}});
}
export const dmActions = {
  bili_dm_sessions:action('size end_ts',false,async(ctx,p)=>{
    const {peer}=peers(ctx), size=int(p.size ?? 20,1,50,'size'), end=p.end_ts === undefined ? null:id(p.end_ts,'end_ts');
    const data=await ctx.request({url:SESSION+'get_sessions',query:{session_type:1,size,mobi_app:'web',...(end && {end_ts:end})}});
    const rows=list(data,'session_list');
    const session_list=rows.filter(r=>r?.session_type === 1 && sameId(r.talker_id,peer)).map(r=>({talker_id:peer,session_type:1,session_ts:r.session_ts,ack_seqno:r.ack_seqno,unread_count:r.unread_count}));
    return {session_list,next_end_ts:cursor(data,rows,'session_ts',end)};
  },true),
  bili_dm_history:action('size end_seqno',false,async(ctx,p)=>{
    const {self,peer}=peers(ctx), size=int(p.size ?? 30,1,50,'size'),end=p.end_seqno === undefined ? null:id(p.end_seqno,'end_seqno');
    const data=await history(ctx,size,end), rows=list(data,'messages');
    const messages=rows.filter(m=>visible(m,self,peer)).map(m=>({sender_uid:String(m.sender_uid),receiver_id:String(m.receiver_id),msg_key:id(m.msg_key,'message key'),msg_seqno:id(m.msg_seqno,'message sequence'),msg_type:m.msg_type,timestamp:m.timestamp,content:m.content}));
    return {messages,next_end_seqno:cursor(data,rows,'msg_seqno',end)};
  },true),
  bili_dm_ack:action('ack_seqno',true,(ctx,p)=>ctx.request({url:SESSION+'update_ack',method:'POST',form:{talker_id:peers(ctx).peer,session_type:1,ack_seqno:id(p.ack_seqno,'ack_seqno'),mobi_app:'web'}}),true),
  bili_dm_send_image:action('url width height',true,(ctx,p)=>send(ctx,2,JSON.stringify({url:bfs(p.url),width:int(p.width,1,32768,'width'),height:int(p.height,1,32768,'height')})),true),
  bili_dm_recall:action('msg_key msg_seqno',true,async(ctx,p)=>{
    const {self,peer}=peers(ctx),key=id(p.msg_key,'msg_key'),seq=id(p.msg_seqno,'msg_seqno');
    device(ctx);
    // Single bounded read proves the key is a recent outgoing message in the authorized conversation.
    const end=id(String(BigInt(seq)+1n),'end_seqno');
    const rows=list(await history(ctx,1,end),'messages'),m=rows[0],now=Math.floor(Date.now()/1000);
    if (rows.length !== 1 || !visible(m,self,peer) || String(m.sender_uid) !== self || !sameId(m.msg_key,key) || !sameId(m.msg_seqno,seq) || ![1,2].includes(m.msg_type) || !Number.isSafeInteger(m.timestamp) || m.timestamp>now || now-m.timestamp>=120) invalid('recall target');
    return send(ctx,5,key);
  },true),
};
