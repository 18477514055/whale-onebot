const API = 'https://api.bilibili.com';
const MAX_FACE = 2 * 1024 * 1024;
const bad = field => { throw new TypeError(`Invalid ${field}`); };
const notSent = () => Object.assign(new Error('Profile preflight unavailable or refused'), {outcome:'not_sent'});
function fields(p, keys) {
  if (!p || ![Object.prototype,null].includes(Object.getPrototypeOf(p)) ||
      Reflect.ownKeys(p).some(k => !keys.includes(k))) bad('parameters');
}
function text(v, k, max, empty = false) {
  if (typeof v !== 'string' || v.length > max * 2 || [...v].length > max || (!empty && !v.trim()) || /[\p{Cc}\p{Cs}]/u.test(v)) bad(k);
  return v;
}
function id(v, k) {
  if (typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== 'string' || !/^[1-9]\d{0,18}$/.test(v) || BigInt(v) > 9223372036854775807n) bad(k);
  return v;
}
function integer(v, k, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) bad(k);
  return v;
}
function sex(v) { if (!['男','女','保密'].includes(v)) bad('sex'); return v; }
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad('birthday');
  const parsed = new Date(`${v}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== v || v > new Date().toISOString().slice(0,10)) bad('birthday');
  return v;
}
function face(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_FACE / 3) * 4) bad('image_base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_FACE || bytes.toString('base64') !== value) bad('image_base64');
  const png = bytes.length >= 45 && bytes.subarray(0,16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452','hex')) &&
    bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'));
  const jpg = bytes.length >= 16 && bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')) && bytes.readUInt16BE(bytes.length-2) === 0xffd9;
  if (!png && !jpg) bad('PNG/JPEG signature');
  const form = new FormData();
  form.set('dopost', 'save'); form.set('DisplayRank','10000');
  form.set('face', new Blob([bytes], {type:png ? 'image/png' : 'image/jpeg'}), png ? 'avatar.png' : 'avatar.jpg');
  return form;
}
const get = (ctx, path) => ctx.request({url:API+path, method:'GET'});
const post = (ctx, path, form) => ctx.request({url:API+path, method:'POST', form});
function checked(data) {
  if (data && typeof data === 'object' && Object.hasOwn(data,'code') && ![0,'0'].includes(data.code)) {
    const code = /^-?\d{1,9}$/.test(String(data.code)) ? 'BILI_API_'+data.code : 'BILI_CLIENT_ERROR';
    throw Object.assign(new Error('Profile update rejected'), {code,outcome:'not_sent'});
  }
  return data;
}
async function current(ctx) {
  const v = await get(ctx,'/x/member/web/account');
  try {
    return {uname:text(v.uname,'uname',32), sign:text(v.sign,'sign',70,true), sex:sex(v.sex),
      birthday: v.birthday === '' || v.birthday === '0000-00-00' ? v.birthday : date(v.birthday)};
  } catch { throw notSent(); }
}
async function update(ctx,p) {
  if (![p.uname,p.sex,p.birthday].some(v => v !== undefined)) bad('profile patch');
  if (p.uname !== undefined) { text(p.uname,'uname',32); if (p.confirm_rename !== true) bad('confirm_rename'); }
  else if (Object.hasOwn(p,'confirm_rename')) bad('confirm_rename');
  if (p.sex !== undefined) sex(p.sex);
  if (p.birthday !== undefined) date(p.birthday);
  const prev = await current(ctx);
  if (p.uname !== undefined && p.uname !== prev.uname) {
    const permission = await get(ctx,'/x/member/uname/update/message');
    if (permission?.allow !== true) throw notSent();
  }
  return checked(await post(ctx,'/x/member/web/update',{uname:p.uname ?? prev.uname, usersign:prev.sign,
    sex:p.sex ?? prev.sex, birthday:p.birthday ?? prev.birthday, source:'profile_web'}));
}
const variants = new Map([[1,['msg']],[2,['msg','bvid']],[5,['duration','posX','posY']],[9,['question','options']],[11,['title','skin']]]);
async function create(ctx,p) {
  const variant = variants.get(p?.type);
  if (!variant) bad('type');
  fields(p,['aid','cid','type','progress',...variant]);
  const form = {aid:id(p.aid,'aid'), cid:id(p.cid,'cid'), type:p.type, plat:1,
    progress:integer(Object.hasOwn(p,'progress') ? p.progress : 0,'progress',0,2147483647)};
  let data;
  if (p.type === 1 || p.type === 2) {
    data = {msg:text(p.msg,'msg',99)};
    if (p.type === 2) {
      if (typeof p.bvid !== 'string' || !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(p.bvid)) bad('bvid');
      data.bvid = p.bvid;
    }
  } else if (p.type === 5) {
    data = {duration:integer(p.duration,'duration',5000,60000),posX:integer(p.posX,'posX',118,549),posY:integer(p.posY,'posY',82,293)};
  } else if (p.type === 9) {
    const q = text(p.question,'question',12), opts = p.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4 || new Set(opts).size !== opts.length) bad('options');
    data = {duration:7000,posX:300,posY:150,posX_2:30,posY_2:40,pub_dynamic:false,vote_type:0,has_self_def:'0',question:q};
    for (const [i,opt] of opts.entries()) {
      if (text(opt,'option',6).includes(';')) bad('option');
      data[['optionA','optionB','optionC','optionD'][i]] = opt;
    }
  } else {
    data = {msg:text(p.title,'title',12),skin:integer(p.skin,'skin',1,3),duration:5000,posX_2:30,posY_2:40};
  }
  return post(ctx,'/x/v2/dm/command/post',{...form,data:JSON.stringify(data)});
}
function action(write, keys, run) {
  const params = Object.freeze(keys);
  return {write, params, async run(ctx,p) { fields(p,params); return run(ctx,p); }};
}
export const profileActions = {
  bili_get_self_profile: action(false,[],current),
  bili_update_profile: action(true,['uname','sex','birthday','confirm_rename'],update),
  bili_update_signature: action(true,['sign'],async (ctx,p) => checked(await post(ctx,'/x/member/web/sign/update',{user_sign:text(p.sign,'sign',70,true)}))),
  bili_update_avatar: action(true,['image_base64'],async (ctx,p) => checked(await ctx.request({url:API+'/x/member/web/face/update',method:'POST',multipart:face(p.image_base64)}))),
  bili_create_command_danmaku: action(true,['aid','cid','type','progress',...new Set([...variants.values()].flat())],create),
  bili_delete_command_danmaku: action(true,['cid','dmid'],(ctx,p) => post(ctx,'/x/v2/dm/command/del',{oid:id(p.cid,'cid'),dmid:id(p.dmid,'dmid')}))
};
