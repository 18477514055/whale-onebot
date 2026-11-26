// Only these fields may cross the provider boundary; opaque IDs are not file paths or URLs.
export const writes=['send_private_msg','send_group_msg','reply_comment','post_comment','set_like','set_favorite','set_follow','publish_images','update_profile'];
export const actions=[...writes,'get_recent_context','get_feed','get_work_media','resolve_public_work'];
export const kinds=['private','group','comment'];
export function check(ok){if(!ok)throw Error('invalid contract');}
export function obj(o){check(o && typeof o==='object' && !Array.isArray(o));return o;}
export function only(o,keys){obj(o);check(Object.keys(o).every(k=>keys.includes(k)));}
export function id(v){check(typeof v==='string'&&/^[A-Za-z0-9_:.@-]{1,128}$/.test(v));return v;}
function text(v,max=4096,empty=false){check(typeof v==='string'&&v.length<=max&&(empty||v.trim().length>0));return v;}
function int(v,min,max){check(Number.isSafeInteger(v)&&v>=min&&v<=max);return v;}
function bool(v){check(typeof v==='boolean');return v;}
function list(v,min,max,fn){check(Array.isArray(v)&&v.length>=min&&v.length<=max);return v.map(fn);}
function msg(v){return list(v,1,16,s=>{only(s,['type','data']);const k=new Map([['text','text'],['image','media_id'],['share','work_id'],['at','user_id']]).get(s.type);check(k);only(s.data,[k]);return {type:s.type,data:{[k]:k==='text'?text(s.data[k]):id(s.data[k])}};});}
export function paramsFor(a,p){
 const allowed={send_private_msg:['user_id','message'],send_group_msg:['group_id','message'],reply_comment:['work_id','comment_id','text'],post_comment:['work_id','text'],set_like:['work_id','enabled'],set_favorite:['work_id','enabled'],set_follow:['user_id','enabled'],publish_images:['media_ids','text'],update_profile:['nickname','bio'],get_recent_context:['user_id','group_id','limit'],get_feed:['source','value','limit'],get_work_media:['work_id'],resolve_public_work:['work_id']}[a];
 only(p,writes.includes(a)?[...allowed,'request_id']:allowed);
 const optional=['value','nickname','bio',...(a==='get_recent_context'?['user_id','group_id']:[])];
 for(const k of allowed)if(!optional.includes(k))check(Object.hasOwn(p,k));
 for(const [k,v] of Object.entries(p)){
  if(k.endsWith('_id'))id(v); else if(k==='message')msg(v); else if(k==='media_ids')list(v,1,9,id); else if(k==='enabled')bool(v);
  else if(k==='limit')int(v,1,32);else if(k==='source')check(['recommended','following','author','topic','search'].includes(v));
  else text(v,k==='nickname'?64:k==='value'?200:4096,k==='bio'||(a==='publish_images'&&k==='text'));
 }
 if(writes.includes(a))id(p.request_id);
 if(a==='get_recent_context')check(+('user_id'in p)+ +('group_id'in p)===1);
 if(a==='get_feed')check(['author','topic','search'].includes(p.source)===('value'in p));
 if(a==='update_profile')check('nickname'in p||'bio'in p);
 return p;
}
function bytes(v,max){check(typeof v==='string'&&v.length<=4*Math.ceil(max/3)&&v.length>0);const b=Buffer.from(v,'base64');check(b.length<=max&&b.toString('base64')===v);return b.length;}
export function resultFor(a,p,r){
 obj(r);
 if(writes.includes(a)){check(r.accepted===true);const o={accepted:true};for(const k of ['work_id','message_id','comment_id'])if(k in r)o[k]=id(r[k]);return o;}
 if(a==='resolve_public_work'){check(r.visibility==='public'&&r.evidence==='anonymous'&&r.work_id===p.work_id);return {work_id:p.work_id,visibility:'public',evidence:'anonymous',title:text(r.title,512,true),...(Object.hasOwn(r,'public_clip')?{public_clip:resultFor('get_work_media',p,r.public_clip)}:{})};}
 if(a==='get_recent_context')return {messages:list(r.messages,0,p.limit,m=>({user_id:id(m.user_id),message:msg(m.message)}))};
 if(a==='get_feed')return {items:list(r.items,0,p.limit,m=>({work_id:id(m.work_id),tags:list(m.tags,0,16,t=>text(t,100))}))};
 check(a==='get_work_media'&&r.work_id===p.work_id);
 const frames=list(r.frames,1,4,f=>{const width=int(f.width,1,160),height=int(f.height,1,160);check(bytes(f.rgb24,width*height*3)===width*height*3);return {ms:int(f.ms,0,86400000),width,height,rgb24:f.rgb24};});
 const rate=int(r.audio.rate,8000,48000),len=bytes(r.audio.pcm16le,rate*2*5);check(len>0&&len%2===0);
 return {work_id:p.work_id,frames,audio:{rate,pcm16le:r.audio.pcm16le}};
}
export function eventFor(raw,identity){
 obj(raw);check(raw.account_id===identity.account_id&&raw.bot_id===identity.bot_id&&kinds.includes(raw.kind));
 const kind=raw.kind,user=id(raw.user_id),message=msg(raw.message),event_id=id(raw.event_id);
 const e={...identity,time:raw.time===undefined?Math.floor(Date.now()/1000):int(raw.time,0,0x1fffffffffffff),self_id:identity.account_id,user_id:user,sender:{user_id:user},event_id,message_id:id(raw.message_id??event_id),is_history:bool(raw.is_history),mentioned:kind==='group'?bool(raw.mentioned):false,message,raw_message:message.filter(s=>s.type==='text').map(s=>s.data.text).join('')};
 if(kind==='comment')return {...e,post_type:'notice',notice_type:'douyin_comment',work_id:id(raw.work_id),comment_id:id(raw.comment_id)};
 return {...e,post_type:'message',message_type:kind,sub_type:kind==='group'?'normal':'friend',...(kind==='group'?{group_id:id(raw.group_id)}:{})};
}
