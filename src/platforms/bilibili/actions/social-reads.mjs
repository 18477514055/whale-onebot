import {id,num,choice,text,video,pagination,optional,make} from './social-fields.mjs';

const get = (...args) => make(false,...args);
const signed = {wbi:true};
const uid = (v,c) => id(v === undefined ? c.selfId : v,'mid');
const page = p => num(p.page ?? 1,'page',1,100000);
const keyword = p => text(p.keyword,'keyword',128);
const relations = url => get('mid pn ps',url,(p,c)=>({vmid:uid(p.mid,c),...pagination(p,50)}));
const notification = (url,timeKey) => get('id time',url,p=>({mobi_app:'web',build:0,...optional(p.id,'id',id),...optional(p.time,timeKey,(v,k)=>num(v,k,0,Number.MAX_SAFE_INTEGER))}));

export const readActions = {
  bili_video_info:get('aid bvid','https://api.bilibili.com/x/web-interface/view',p=>video(p)),
  bili_video_playurl:get('aid bvid cid qn format','https://api.bilibili.com/x/player/wbi/playurl',p=>({
    ...video(p,'avid'),cid:id(p.cid,'cid'),qn:choice(p.qn ?? 64,'qn',[6,16,32,64,74,80,112,116,120,125,126,127]),
    fnval:choice(p.format ?? 'dash','format',['dash','mp4']) === 'dash' ? 16 : 1,fnver:0
  }),signed),
  bili_video_danmaku:get('cid','https://api.bilibili.com/x/v1/dm/list.so',p=>({oid:id(p.cid,'cid')}),{format:'text'}),
  bili_comments:get('aid mode offset','https://api.bilibili.com/x/v2/reply/wbi/main',p=>({oid:id(p.aid,'aid'),type:1,mode:choice(p.mode ?? 3,'mode',[1,2,3]),plat:1,web_location:1315875,pagination_str:JSON.stringify({offset:text(p.offset ?? '','offset',4096,true)})}),signed),
  bili_comment_replies:get('aid root pn ps','https://api.bilibili.com/x/v2/reply/reply',p=>({oid:id(p.aid,'aid'),type:1,root:id(p.root,'root'),...pagination(p,20,10)})),
  bili_live_room_info:get('room_id','https://api.live.bilibili.com/room/v1/Room/get_info',p=>({room_id:id(p.room_id,'room_id')})),
  bili_space_videos:get('mid pn ps order keyword','https://api.bilibili.com/x/space/wbi/arc/search',(p,c)=>({mid:uid(p.mid,c),...pagination(p,50,30),order:choice(p.order ?? 'pubdate','order',['pubdate','click','stow']),...optional(p.keyword,'keyword',(v,k)=>text(v,k,128))}),signed),
  bili_user_card:get('mid','https://api.bilibili.com/x/web-interface/card',(p,c)=>({mid:uid(p.mid,c)})),
  bili_followings:relations('https://api.bilibili.com/x/relation/followings'),
  bili_followers:relations('https://api.bilibili.com/x/relation/followers'),
  bili_favorite_folders:get('mid','https://api.bilibili.com/x/v3/fav/folder/created/list-all',(p,c)=>({up_mid:uid(p.mid,c)})),
  bili_favorite_folder_info:get('media_id','https://api.bilibili.com/x/v3/fav/folder/info',p=>({media_id:id(p.media_id,'media_id')})),
  bili_favorite_items:get('media_id pn ps order keyword','https://api.bilibili.com/x/v3/fav/resource/list',p=>({media_id:id(p.media_id,'media_id'),...pagination(p),order:choice(p.order ?? 'mtime','order',['mtime','view','pubtime']),platform:'web',...optional(p.keyword,'keyword',(v,k)=>text(v,k,128))})),
  bili_history:get('max business view_at type ps','https://api.bilibili.com/x/web-interface/history/cursor',p=>({
    ...optional(p.max,'max',(v,k)=>v === 0 || v === '0' ? '0' : id(v,k)),...optional(p.view_at,'view_at',(v,k)=>num(v,k,0,Number.MAX_SAFE_INTEGER)),
    ...optional(p.business,'business',(v,k)=>choice(v,k,['','archive','pgc','live','article-list','article'])),type:choice(p.type ?? 'all','type',['all','archive','live','article']),ps:num(p.ps ?? 20,'ps',1,30)
  })),
  bili_watchlater:get('','https://api.bilibili.com/x/v2/history/toview'),
  bili_notifications_reply:notification('https://api.bilibili.com/x/msgfeed/reply','reply_time'),
  bili_notifications_at:notification('https://api.bilibili.com/x/msgfeed/at','at_time'),
  bili_notifications_like:notification('https://api.bilibili.com/x/msgfeed/like','like_time'),
  bili_notifications_system:get('ps','https://message.bilibili.com/x/sys-msg/query_user_notify',p=>({page_size:num(p.ps ?? 20,'ps',1,20),mobi_app:'web',build:0})),
  bili_dynamic_feed:get('offset host_mid','https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all',p=>({platform:'web',...optional(p.offset,'offset',id),...optional(p.host_mid,'host_mid',id)})),
  bili_relation:get('mid','https://api.bilibili.com/x/relation',p=>({fid:id(p.mid,'mid')})),
  bili_search:get('keyword page','https://api.bilibili.com/x/web-interface/wbi/search/all/v2',p=>({keyword:keyword(p),page:page(p)}),signed),
  bili_search_type:get('keyword page search_type','https://api.bilibili.com/x/web-interface/wbi/search/type',p=>({keyword:keyword(p),page:page(p),search_type:choice(p.search_type,'search_type',['video','media_bangumi','media_ft','live_room','live_user','article','bili_user','photo'])}),signed)
};
