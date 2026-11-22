import {choice, id, invalid, num, optional, params, text, video} from './social-fields.mjs';

const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const MEMBER = 'https://member.bilibili.com';
function spec(write, fields, run) {
  const keys = Object.freeze(fields.split(' ').filter(Boolean));
  return Object.freeze({write, params:keys, async run(ctx, input = {}) { return run(ctx, params(input, keys)); }});
}
const get = (keys, url, build = () => ({})) => spec(false, keys, (ctx,p) => ctx.request({url, query:build(p)}));
const post = (ctx,url,form) => ctx.request({url,method:'POST',form});
const set = (keys,url,build) => spec(true,keys,(ctx,p) => post(ctx,url,build(p,ctx)));
const single = (name,wire = name) => p => ({[wire]:id(p[name],name)});
const enabled = (p,k) => choice(p[k],k,[true,false]);
const comment = (p,k) => ({oid:id(p.aid,'aid'),type:1,rpid:id(p.rpid,'rpid'),action:Number(enabled(p,k))});
const articleId = single('cvid','id');
const selectEndpoint = (keys,add,remove,build) => spec(true,keys+' operation',(ctx,p) => post(ctx,
  choice(p.operation,'operation',['add','remove']) === 'add' ? add : remove,build(p)));
const detail = (ctx,dynamicId) => ctx.request({url:API+'/x/polymer/web-dynamic/v1/detail',wbi:true,
  query:{id:dynamicId,platform:'web',features:'itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete'}});

export const communityActions = Object.freeze({
  bili_dynamic_detail:spec(false,'dynamic_id',(ctx,p) => detail(ctx,id(p.dynamic_id,'dynamic_id'))),
  bili_dynamic_like:set('dynamic_id like',VC+'/dynamic_like/v1/dynamic_like/thumb',(p,ctx) => ({dynamic_id:id(p.dynamic_id,'dynamic_id'),uid:id(ctx.selfId,'selfId'),up:enabled(p,'like') ? 1 : 2})),
  bili_dynamic_delete:spec(true,'dynamic_id',async (ctx,p) => {
    const dynamic_id = id(p.dynamic_id,'dynamic_id'), self = id(ctx.selfId,'selfId');
    try {
      const {item} = await detail(ctx,dynamic_id) ?? {};
      if (item?.id_str !== dynamic_id || id(item.modules?.module_author?.mid,'author') !== self) throw new Error();
    } catch {
      throw Object.assign(new Error('Dynamic ownership not established; deletion not sent'),{outcome:'not_sent'});
    }
    return post(ctx,VC+'/dynamic_svr/v1/dynamic_svr/rm_dynamic',{dynamic_id});
  }),
  bili_vote_info:get('vote_id',VC+'/vote_svr/v1/vote_svr/vote_info',single('vote_id')),
  bili_vote_cast:set('vote_id options',VC+'/vote_svr/v1/vote_svr/do_vote',(p,ctx)=>{
    if (!Array.isArray(p.options) || p.options.length < 1 || p.options.length > 32) invalid('options');
    const indices = Array.from(p.options, v=>num(v,'options',1,2147483647));
    if (new Set(indices).size !== indices.length) invalid('options');
    return {vote_id:id(p.vote_id,'vote_id'),votes:indices.join(','),voter_uid:id(ctx.selfId,'selfId')};
  }),
  bili_article_draft_delete:set('aid',MEMBER+'/x/web/draft/delete',single('aid')),
  bili_article_public_read:get('cvid',API+'/x/article/view',articleId),
  bili_article_info:get('cvid',API+'/x/article/viewinfo',articleId),
  bili_article_list:get('rlid',API+'/x/article/list/web/articles',single('rlid','id')),
  bili_article_like:set('cvid like',API+'/x/article/like',p=>({...articleId(p),type:enabled(p,'like') ? 1 : 2})),
  bili_article_favorite:selectEndpoint('cvid',API+'/x/article/favorites/add',API+'/x/article/favorites/del',articleId),
  bili_article_delete:set('cvid',MEMBER+'/x/web/article/delete',single('cvid','aid')),
  bili_video_tags:get('aid bvid cid',API+'/x/web-interface/view/detail/tag',p=>({...video(p),...optional(p.cid,'cid',id)})),
  bili_video_related:get('aid bvid',API+'/x/web-interface/archive/related',p=>video(p)),
  bili_pgc_follow:selectEndpoint('season_id',API+'/pgc/web/follow/add',API+'/pgc/web/follow/del',single('season_id')),
  bili_comment_pin:set('aid rpid pin',API+'/x/v2/reply/top',p=>comment(p,'pin')),
  bili_comment_dislike:set('aid rpid dislike',API+'/x/v2/reply/hate',p=>comment(p,'dislike')),
  bili_history_delete:set('business id',API+'/x/v2/history/delete',p=>({kid:choice(p.business,'business',['archive','live','article','pgc','article-list'])+'_'+id(p.id,'id')})),
  bili_dm_unread:get('',VC+'/session_svr/v1/session_svr/single_unread'),
  bili_notifications_unread:get('',API+'/x/msgfeed/unread'),
  bili_follow_groups:get('',API+'/x/relation/tags'),
  bili_follow_user_groups:get('mid',API+'/x/relation/tag/user',single('mid','fid')),
  bili_follow_group_create:set('name',API+'/x/relation/tag/create',p=>({tag:text(p.name,'name',16)})),
  bili_follow_group_rename:set('tagid name',API+'/x/relation/tag/update',p=>({tagid:id(p.tagid,'tagid'),name:text(p.name,'name',16)})),
  bili_follow_group_delete:set('tagid',API+'/x/relation/tag/del',single('tagid')),
  bili_follow_group_assign:set('mid tagid',API+'/x/relation/tags/addUsers',p=>({fids:id(p.mid,'mid'),tagids:id(p.tagid,'tagid')})),
});

/**
 * 归一化 B 站推荐流单条视频字段。
 * @param {any} item
 * @param {string} fallbackPartition
 */
function normalizeRecommendItem(item, fallbackPartition) {
  return {
    bvid: String(item.bvid),
    title: String(item.title ?? ''),
    authorId: item.owner?.mid != null ? String(item.owner.mid) : String(item.mid ?? ''),
    author: String(item.owner?.name ?? item.author ?? ''),
    durationSec: Number(item.duration ?? item.durationSec ?? 0) || 0,
    desc: String(item.desc ?? item.rcmd_reason?.content ?? ''),
    partition: String(item.tname ?? fallbackPartition),
  };
}

/**
 * 推荐流扩展动作（独立导出，避免破坏 communityActions 的精确键集契约）。
 * <p>两种取流方式：不给 rid = 综合推荐流（自由巡看）；给 rid = 该分区（含子分区）的推荐流。
 * 之前这里只把 partition 当展示标签、请求永远走综合流，等于「分区」形同虚设。</p>
 */
export const recommendActions = Object.freeze({
  bili_recommend: spec(false, 'partition rid count', async (ctx, p) => {
    const count = num(p.count ?? 10, 'count', 1, 30);
    const rawPartition = p.partition === undefined ? '' : text(p.partition, 'partition', 32, true).trim();
    const partition = rawPartition && rawPartition !== 'all' ? rawPartition : '';
    const rawRid = p.rid === undefined || p.rid === null ? '' : String(p.rid).trim();
    const rid = rawRid === '' || rawRid === 'all' ? 0 : id(rawRid, 'rid');
    const feed = (url, query) => ctx.request({ url, wbi: true, query });
    let data;
    let fallback = '';
    if (rid) {
      try {
        data = await feed(API + '/x/web-interface/region/feed/rcmd', { rid, ps: count, fresh_type: 3, version: 1 });
      } catch (error) {
        // 分区流在当前账号/接口上不可用（真机实测 1500）⇒ 回退综合流，并把这个事实带回去，
        // 让运行端能在流水里留下「分区没取到，这一轮走了综合流」而不是静默什么都不看。
        // 删除条件：B 站分区流恢复可用且真机复验 ok 之后。
        fallback = 'region-unavailable';
        data = await feed(API + '/x/web-interface/wbi/index/top/feed/rcmd', { ps: count, fresh_type: 4, version: 1 });
      }
    } else {
      data = await feed(API + '/x/web-interface/wbi/index/top/feed/rcmd', { ps: count, fresh_type: 4, version: 1 });
    }
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.item)
        ? data.item
        : Array.isArray(data?.list)
          ? data.list
          : Array.isArray(data?.videos)
            ? data.videos
            : [];
    const videos = list
      .filter(item => item && typeof item.bvid === 'string' && item.bvid.length > 0)
      .slice(0, count)
      .map(item => normalizeRecommendItem(item, partition));
    return fallback ? { videos, fallback } : { videos };
  }),
});
