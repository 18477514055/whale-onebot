import test from 'node:test';
import assert from 'node:assert/strict';
import {communityActions as actions} from '../src/platforms/bilibili/actions/community.mjs';
import {socialActions} from '../src/platforms/bilibili/actions/social.mjs';
import {publishActions} from '../src/platforms/bilibili/actions/publish.mjs';
const api='https://api.bilibili.com', vc='https://api.vc.bilibili.com', member='https://member.bilibili.com';
const d='9123456789012345678', bvid='BV1xx411c7mD';
const detail={id:d,platform:'web',features:'itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete'};
const matrix=[
  ['dynamic_detail',{dynamic_id:d},api+'/x/polymer/web-dynamic/v1/detail',detail,false,true],
  ...[[true,1],[false,2]].map(([like,up])=>['dynamic_like',{dynamic_id:d,like},vc+'/dynamic_like/v1/dynamic_like/thumb',{dynamic_id:d,up,uid:'42'},true]),
  ['vote_info',{vote_id:3},vc+'/vote_svr/v1/vote_svr/vote_info',{vote_id:'3'}],
  ['vote_cast',{vote_id:3,options:[1,4]},vc+'/vote_svr/v1/vote_svr/do_vote',{vote_id:'3',votes:'1,4',voter_uid:'42'},true],
  ['article_draft_delete',{aid:3},member+'/x/web/draft/delete',{aid:'3'},true],
  ['article_public_read',{cvid:3},api+'/x/article/view',{id:'3'}],
  ['article_info',{cvid:3},api+'/x/article/viewinfo',{id:'3'}],
  ['article_list',{rlid:3},api+'/x/article/list/web/articles',{id:'3'}],
  ...[[true,1],[false,2]].map(([like,type])=>['article_like',{cvid:3,like},api+'/x/article/like',{id:'3',type},true]),
  ...[['add','add'],['remove','del']].map(([operation,s])=>['article_favorite',{cvid:3,operation},api+'/x/article/favorites/'+s,{id:'3'},true]),
  ['article_delete',{cvid:3},member+'/x/web/article/delete',{aid:'3'},true],
  ['video_tags',{bvid,cid:5},api+'/x/web-interface/view/detail/tag',{bvid,cid:'5'}],
  ['video_related',{aid:3},api+'/x/web-interface/archive/related',{aid:'3'}],
  ...[['add','add'],['remove','del']].map(([operation,s])=>['pgc_follow',{season_id:3,operation},api+'/pgc/web/follow/'+s,{season_id:'3'},true]),
  ...[['pin','top'],['dislike','hate']].flatMap(([k,s])=>[true,false].map(v=>['comment_'+k,{aid:1,rpid:3,[k]:v},api+'/x/v2/reply/'+s,{type:1,oid:'1',rpid:'3',action:Number(v)},true])),
  ['history_delete',{business:'archive',id:3},api+'/x/v2/history/delete',{kid:'archive_3'},true],
  ['dm_unread',{},vc+'/session_svr/v1/session_svr/single_unread',{}],
  ['notifications_unread',{},api+'/x/msgfeed/unread',{}],
  ['follow_groups',{},api+'/x/relation/tags',{}],
  ['follow_user_groups',{mid:3},api+'/x/relation/tag/user',{fid:'3'}],
  ['follow_group_create',{name:'friends'},api+'/x/relation/tag/create',{tag:'friends'},true],
  ['follow_group_rename',{tagid:3,name:'friends'},api+'/x/relation/tag/update',{tagid:'3',name:'friends'},true],
  ['follow_group_delete',{tagid:3},api+'/x/relation/tag/del',{tagid:'3'},true],
  ['follow_group_assign',{mid:7,tagid:3},api+'/x/relation/tags/addUsers',{fids:'7',tagids:'3'},true]
];
test('all names distinct from existing social/publish actions; every operation covered',()=>{
  assert.deepEqual(new Set(Object.keys(actions)),new Set(['bili_dynamic_delete',...matrix.map(([n])=>'bili_'+n)]));
  for(const [name,s] of Object.entries(actions)){ assert.ok(!(name in socialActions || name in publishActions)); assert.ok(Array.isArray(s.params)); }
});
for(const [n,p,url,payload,write=false,wbi=false] of matrix) test(`${n} ${JSON.stringify(p)}`,async()=>{
  const s=actions['bili_'+n],calls=[], response={ok:1}; assert.equal(s.write,write);
  assert.equal(await s.run({selfId:'42',request:q=>{calls.push(q);return response;}},p),response);
  assert.deepEqual(calls,[{url,...(write ? {method:'POST',form:payload} : {query:payload}),...(wbi ? {wbi:true} : {})}]);
});
test('delete own dynamic requires exact target and author; no fallback or write on failed preflight',async()=>{
  const s=actions.bili_dynamic_delete;assert.ok(s.write);
  for(const [id_str,mid,ok] of [[d,42,true],[d,43,false],['3',42,false],[d,undefined,false]]){
    const calls=[];const run=s.run({selfId:'42',request:q=>{calls.push(q);return {item:{id_str,modules:{module_author:{mid}}}};}},{dynamic_id:d});
    if(ok) await run;else await assert.rejects(run,{outcome:'not_sent'});
    assert.deepEqual(calls,[{url:api+'/x/polymer/web-dynamic/v1/detail',query:detail,wbi:true},...(ok?[{url:vc+'/dynamic_svr/v1/dynamic_svr/rm_dynamic',method:'POST',form:{dynamic_id:d}}]:[])]);
  }
});
test('invalid IDs, bulk and request overrides never reach transport',async()=>{
  let calls=0;const ctx={selfId:'42',request:()=>++calls};
  for(const s of Object.values(actions)) await assert.rejects(s.run(ctx,{url:'https://example.invalid'}));
  for(const [n,p] of [['vote_cast',{vote_id:3,options:[0]}],['vote_cast',{vote_id:3,options:[1,1]}],['vote_cast',{vote_id:3,options:'1,2'}],['article_draft_delete',{aid:'1,3'}],['history_delete',{business:'all',id:'1'}],['history_delete',{business:'article',id:'1,2'}],['article_delete',{cvid:[3]}],['dynamic_delete',{dynamic_id:Number.MAX_SAFE_INTEGER+1}],['comment_pin',{aid:3,rpid:4,pin:1}],['article_favorite',{cvid:3,operation:'all'}],['video_tags',{aid:2,bvid}],['follow_group_assign',{mid:'1,2',tagid:3}],['follow_group_rename',{tagid:3,name:' '}],['dynamic_like',{dynamic_id:d,like:false,uid:'9'}]]) await assert.rejects(actions['bili_'+n].run(ctx,p));
  assert.equal(calls,0);
});
