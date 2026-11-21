import {action, bfs, fields, id, image, int, invalid, text} from './publish-validation.mjs';
import {dmActions} from './publish-dm.mjs';

const API = 'https://api.bilibili.com/';
const VC = 'https://api.vc.bilibili.com/';
const CREATIVE = API + 'x/article/creative/';
function post(ctx,url,form) { return ctx.request({url,method:'POST',form}); }

const createDynamic = action('text images vote',true,(ctx,p) => {
  const raw_text = text(p.text ?? '', 2000, 'text', true);
  const contents = raw_text ? [{raw_text,type:1,biz_id:''}] : [];
  if (p.vote !== undefined) {
    fields(p.vote,['id','title']);
    contents.push({raw_text:text(p.vote.title,80,'vote.title'),type:4,biz_id:id(p.vote.id,'vote.id')});
  }
  const images = p.images === undefined ? [] : p.images;
  if (!Array.isArray(images) || images.length > 9) invalid('images');
  const pics = Array.from(images, item => {
    fields(item,['url','width','height']);
    return {img_src:bfs(item.url),img_width:int(item.width,1,32768,'width'),img_height:int(item.height,1,32768,'height')};
  });
  if (!raw_text.trim() && !pics.length && !p.vote) invalid('empty dynamic');
  const dyn_req = {content:{contents},scene:pics.length ? 2 : 1,...(pics.length && {pics})};
  return ctx.request({url:API+'x/dynamic/feed/create/dyn',method:'POST',json:{dyn_req}});
});
const createVote = action('title description options max_choices duration',true,(ctx,p) => {
  if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 8) invalid('options');
  const options = Array.from(p.options,v => text(v,80,'option'));
  if (new Set(options).size !== options.length) invalid('duplicate options');
  const form = {'info[title]':text(p.title,80,'title'),'info[desc]':text(p.description ?? '',200,'description',true),'info[type]':0,
    'info[choice_cnt]':int(p.max_choices ?? 1,1,options.length,'max_choices'),'info[duration]':int(p.duration,60,2592000,'duration')};
  options.forEach((v,i) => {form[`info[options][${i}][desc]`]=v;});
  return post(ctx,VC+'vote_svr/v1/vote_svr/create_vote',form);
});
function article(path, mode) {
  const editing = mode !== 'new', publicWrite = mode === 'public';
  const keys = ['title','text','category','original','cover_url',...(editing ? ['aid']:[]),...(publicWrite ? ['reprint']:[])];
  return action(keys.join(' '),true,(ctx,p) => {
    const escaped = text(p.text,30000,'text').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    // Full replacement, plain text only: no caller-controlled HTML, resource loads, or scripts.
    const form = {title:text(p.title,80,'title'),content:escaped.split(/\r\n|[\n\r]/).map(s=>`<p>${s}</p>`).join(''),
      original:int(p.original,0,1,'original'),category:int(p.category,1,2147483647,'category')};
    if (editing) form.aid=id(p.aid,'aid');
    if (publicWrite) form.reprint=int(p.reprint,0,1,'reprint');
    if (p.cover_url !== undefined) form.banner_url=bfs(p.cover_url);
    return post(ctx,CREATIVE+path,form);
  });
}
export const publishActions = Object.freeze({
  bili_dynamic_create:createDynamic,
  bili_dynamic_upload_image:action('image',true,(ctx,p) => {
    const {bytes,type} = image(p.image), multipart = new FormData();
    multipart.set('biz','new_dyn'); multipart.set('category','daily');
    multipart.set('file_up',new Blob([bytes],{type:'image/'+type}), 'image.'+type);
    return ctx.request({url:API+'x/dynamic/feed/draw/upload_bfs',method:'POST',multipart});
  }),
  bili_dynamic_repost:action('dynamic_id text',true,(ctx,p)=>post(ctx,VC+'dynamic_repost/v1/dynamic_repost/repost',{
    dynamic_id:id(p.dynamic_id,'dynamic_id'),type:4,rid:0,content:text(p.text ?? '转发动态',2000,'text'),extension:'{"emoji_type":1}',at_uids:'',ctrl:'[]'})),
  bili_vote_create:createVote,
  bili_article_draft_create:article('draft/addupdate','new'),
  bili_article_draft_update:article('draft/addupdate','draft'),
  bili_article_submit:article('article/submit','public'),
  bili_article_update:article('article/update','public'),
  bili_article_upload_cover:action('image',true,(ctx,p)=>{image(p.image);return post(ctx,CREATIVE+'article/upcover',{cover:p.image});}),
  bili_article_draft_view:action('aid',false,(ctx,p)=>ctx.request({url:CREATIVE+'draft/view',query:{aid:id(p.aid,'aid')}})),
  bili_article_view:action('aid',false,(ctx,p)=>ctx.request({url:CREATIVE+'article/view',query:{aid:id(p.aid,'aid')}})),
  ...dmActions,
});
