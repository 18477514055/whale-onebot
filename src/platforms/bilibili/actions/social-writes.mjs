import {id,num,choice,text,video,optional,make} from './social-fields.mjs';
const post = (...args) => make(true,...args);
const like = p => choice(p.like,'like',[true,false]);
const comment = p => ({type:1,oid:id(p.aid,'aid'),rpid:id(p.rpid,'rpid')});
const relationCode = Object.freeze({follow:1,unfollow:2,block:5,unblock:6,remove_follower:7});
const folder = p => ({title:text(p.title,'title',20),...optional(p.intro,'intro',(v,k)=>text(v,k,100,true)),...optional(p.private,'privacy',(v,k)=>choice(v,k,[true,false]) ? 1 : 0)});

export const writeActions = {
  bili_danmaku_send:post('aid bvid cid msg progress color mode fontsize','https://api.bilibili.com/x/v2/dm/post',p=>({
    ...video(p),type:1,oid:id(p.cid,'cid'),msg:text(p.msg,'msg',99),progress:num(p.progress ?? 0,'progress',0,2147483647),
    color:num(p.color ?? 0xffffff,'color',0,0xffffff),mode:choice(p.mode ?? 1,'mode',[1,4,5]),fontsize:choice(p.fontsize ?? 25,'fontsize',[12,16,18,25,36,45,64]),pool:0
  }),{wbi:true,query:{web_location:1315873}}),
  bili_danmaku_recall:post('cid dmid','https://api.bilibili.com/x/dm/recall',p=>({cid:id(p.cid,'cid'),dmid:id(p.dmid,'dmid')})),
  bili_comment_delete:post('aid rpid','https://api.bilibili.com/x/v2/reply/del',comment),
  bili_comment_like:post('aid rpid like','https://api.bilibili.com/x/v2/reply/action',p=>({...comment(p),action:like(p) ? 1 : 0})),
  bili_video_like:post('aid bvid like','https://api.bilibili.com/x/web-interface/archive/like',p=>({...video(p),like:like(p) ? 1 : 2})),
  bili_video_coin:post('aid bvid multiply select_like','https://api.bilibili.com/x/web-interface/coin/add',p=>({...video(p),multiply:choice(p.multiply,'multiply',[1,2]),select_like:choice(p.select_like === undefined ? false : p.select_like,'select_like',[true,false]) ? 1 : 0})),
  bili_video_favorite:post('aid media_id operation','https://api.bilibili.com/x/v3/fav/resource/deal',p=>({rid:id(p.aid,'aid'),type:2,[choice(p.operation,'operation',['add','remove']) === 'add' ? 'add_media_ids' : 'del_media_ids']:id(p.media_id,'media_id')})),
  bili_video_triple:post('aid bvid','https://api.bilibili.com/x/web-interface/archive/like/triple',p=>video(p)),
  bili_video_share:post('aid bvid','https://api.bilibili.com/x/web-interface/share/add',p=>video(p)),
  bili_relation_modify:post('mid operation','https://api.bilibili.com/x/relation/modify',p=>({fid:id(p.mid,'mid'),act:relationCode[choice(p.operation,'operation',Object.keys(relationCode))],re_src:11})),
  bili_watchlater_add:post('aid bvid','https://api.bilibili.com/x/v2/history/toview/add',p=>video(p)),
  bili_watchlater_delete:post('aid','https://api.bilibili.com/x/v2/history/toview/del',p=>({aid:id(p.aid,'aid')})),
  bili_favorite_folder_create:post('title intro private','https://api.bilibili.com/x/v3/fav/folder/add',folder),
  bili_favorite_folder_edit:post('media_id title intro private','https://api.bilibili.com/x/v3/fav/folder/edit',p=>({media_id:id(p.media_id,'media_id'),title:text(p.title,'title',20),intro:text(p.intro,'intro',100,true),privacy:choice(p.private,'private',[true,false]) ? 1 : 0})),
  bili_favorite_folder_delete:post('media_id','https://api.bilibili.com/x/v3/fav/folder/del',p=>({media_ids:id(p.media_id,'media_id')}))
};
