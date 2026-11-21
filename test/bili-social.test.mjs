import test from 'node:test';
import assert from 'node:assert/strict';
import {readActions} from '../src/platforms/bilibili/actions/social-reads.mjs';
import {writeActions} from '../src/platforms/bilibili/actions/social-writes.mjs';
import {socialActions} from '../src/platforms/bilibili/actions/social.mjs';
import {profileActions} from '../src/platforms/bilibili/actions/social-profile.mjs';
const catalog = {...readActions,...writeActions};
test('public registry includes every read, write, profile and interactive action',()=>{
 const all=[...Object.keys(catalog),...Object.keys(profileActions)];
 assert.equal(new Set(all).size,all.length); assert.deepEqual(Object.keys(socialActions).sort(),all.sort());
 assert.equal(Object.getPrototypeOf(socialActions),null);
 for (const name of all) {assert.match(name,/^bili_/);assert.equal(typeof socialActions[name].write,'boolean');assert.equal(typeof socialActions[name].run,'function');}
});
const api='https://api.bilibili.com', live='https://api.live.bilibili.com', msg='https://message.bilibili.com';
const bvid='BV1GJ411x7h7', aid='9007199254740993',cid='22',media_id='33',mid='44',root='55',rpid='66';
const page={pn:1,ps:20}, self='77';
const cases=[
 ['video_info',{bvid},'/x/web-interface/view',{bvid}],
 ['video_playurl',{aid,cid},'/x/player/wbi/playurl',{avid:aid,cid,qn:64,fnval:16,fnver:0},'wbi'],
 ['video_danmaku',{cid},'/x/v1/dm/list.so',{oid:cid},'text'],
 ['comments',{aid,offset:'{"Data":{"cursor":8}}'},'/x/v2/reply/wbi/main',{oid:aid,type:1,mode:3,plat:1,web_location:1315875,pagination_str:JSON.stringify({offset:'{"Data":{"cursor":8}}'})},'wbi'],
 ['comment_replies',{aid,root},'/x/v2/reply/reply',{type:1,oid:aid,root,pn:1,ps:10}],
 ['live_room_info',{room_id:1},live+'/room/v1/Room/get_info',{room_id:'1'}],
 ['space_videos',{},'/x/space/wbi/arc/search',{mid:self,pn:1,ps:30,order:'pubdate'},'wbi'],
 ['user_card',{mid},'/x/web-interface/card',{mid}],
 ['followings',{},'/x/relation/followings',{vmid:self,...page}],
 ['followers',{mid},'/x/relation/followers',{vmid:mid,...page}],
 ['favorite_folders',{},'/x/v3/fav/folder/created/list-all',{up_mid:self}],
 ['favorite_folder_info',{media_id},'/x/v3/fav/folder/info',{media_id}],
 ['favorite_items',{media_id},'/x/v3/fav/resource/list',{media_id,...page,order:'mtime',platform:'web'}],
 ['history',{max:aid,business:'archive',view_at:10},'/x/web-interface/history/cursor',{max:aid,business:'archive',view_at:10,ps:20,type:'all'}],
 ['watchlater',{},'/x/v2/history/toview',{}],
 ...['reply','at','like'].map(k=>['notifications_'+k,{time:100,id:1},'/x/msgfeed/'+k,{mobi_app:'web',build:0,id:'1',[k+'_time']:100}]),
 ['notifications_system',{},msg+'/x/sys-msg/query_user_notify',{mobi_app:'web',build:0,page_size:20}],
 ['dynamic_feed',{offset:aid},'/x/polymer/web-dynamic/v1/feed/all',{offset:aid,platform:'web'}],
 ['relation',{mid},'/x/relation',{fid:mid}],
 ['search',{keyword:'science'},'/x/web-interface/wbi/search/all/v2',{keyword:'science',page:1},'wbi'],
 ['search_type',{keyword:'example',search_type:'video'},'/x/web-interface/wbi/search/type',{keyword:'example',page:1,search_type:'video'},'wbi'],
 ['danmaku_send',{cid,bvid,msg:'sample'},'/x/v2/dm/post',{bvid,oid:cid,type:1,msg:'sample',progress:0,color:16777215,mode:1,fontsize:25,pool:0},'write-wbi'],
 ['danmaku_recall',{cid,dmid:aid},'/x/dm/recall',{cid,dmid:aid},'write'],
 ['comment_delete',{aid,rpid},'/x/v2/reply/del',{type:1,oid:aid,rpid},'write'],
 ['comment_like',{aid,rpid,like:false},'/x/v2/reply/action',{type:1,oid:aid,rpid,action:0},'write'],
 ['video_like',{aid,like:false},'/x/web-interface/archive/like',{aid,like:2},'write'],
 ['video_coin',{bvid,multiply:2,select_like:true},'/x/web-interface/coin/add',{bvid,multiply:2,select_like:1},'write'],
 ['video_favorite',{aid,media_id,operation:'remove'},'/x/v3/fav/resource/deal',{rid:aid,type:2,del_media_ids:media_id},'write'],
 ['video_triple',{aid},'/x/web-interface/archive/like/triple',{aid},'write'],
 ['video_share',{bvid},'/x/web-interface/share/add',{bvid},'write'],
 ['relation_modify',{mid,operation:'unblock'},'/x/relation/modify',{fid:mid,act:6,re_src:11},'write'],
 ['watchlater_add',{bvid},'/x/v2/history/toview/add',{bvid},'write'],
 ['watchlater_delete',{aid},'/x/v2/history/toview/del',{aid},'write'],
 ['favorite_folder_create',{title:'Folder',private:true},'/x/v3/fav/folder/add',{title:'Folder',privacy:1},'write'],
 ['favorite_folder_edit',{media_id,title:'New',intro:'',private:false},'/x/v3/fav/folder/edit',{media_id,title:'New',intro:'',privacy:0},'write'],
 ['favorite_folder_delete',{media_id},'/x/v3/fav/folder/del',{media_ids:media_id},'write']
];
for (const [key,p,path,payload,flags=''] of cases) test('social fixed contract: '+key,async()=>{
 const action=catalog['bili_'+key], write=flags.includes('write'); assert.equal(action.write,write);
 const data=flags==='text' ? '<i><d>sample</d></i>' : {sample:true}, calls=[];
 const result=await action.run({selfId:self,request:async r=>{calls.push(r);return data}},p);
 assert.deepEqual(calls,[{url:path.startsWith('https:') ? path : api+path,...(flags.includes('wbi')?{wbi:true}:{}),...(flags==='text'?{format:'text'}:{}),...(flags==='write-wbi'?{query:{web_location:1315873}}:{}),...(write?{method:'POST',form:payload}:{query:payload})}]); assert.strictEqual(result,data);
});
test('every contract rejects extraneous transport, credential and prototype keys before calling upstream',async()=>{
 assert.deepEqual(cases.map(c=>'bili_'+c[0]).sort(),Object.keys(catalog).sort());
 for(const [key,p] of cases) for(const extra of ['url','method','path','headers','form','json','multipart','csrf','cookie','__proto__']){
   await assert.rejects(catalog['bili_'+key].run({request:assert.fail},{...p,[extra]:'not allowed'}),TypeError);
 }
});
test('ambiguous, oversized, invalid, bulk and stale inputs do not cause side effects',async()=>{
 const invalid=[['video_coin',{aid,bvid,multiply:1}],['video_coin',{aid,multiply:0}],['video_like',{aid,like:1}],['user_card',{mid:9007199254740992}],['relation_modify',{mid,operation:'constructor'}],['favorite_folder_delete',{media_id:'1,2'}],['danmaku_send',{bvid,cid,msg:'x'.repeat(100)}],['comment_replies',{aid,root,ps:21}],['search',{keyword:'\nabc'}],['video_info',{aid:null}],['watchlater_delete',{}],['favorite_folder_edit',{media_id,title:'new'}]];
 for(const [key,p] of invalid) await assert.rejects(catalog['bili_'+key].run({request:assert.fail},p),TypeError);
});
test('upstream risk errors propagate unchanged; action does not try again',async()=>{
 let n=0;const err=new Error('challenge');const ctx={request:async()=>{n++;throw err}};
 await assert.rejects(catalog.bili_video_coin.run(ctx,{aid,multiply:1}),e=>e===err);assert.equal(n,1);
});
