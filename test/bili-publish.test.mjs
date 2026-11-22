import test from 'node:test';
import assert from 'node:assert/strict';
import {publishActions as A} from '../src/platforms/bilibili/actions/publish.mjs';

const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRtoAAAAASUVORK5CYII=';
const url='https://i0.hdslb.com/bfs/new_dyn/a123.png';
const self='101',peer='202',dev='00000000-0000-4000-8000-000000000000';
const key='18446744073709551613', seq='9007199254740993';
const msg=(extra={})=>({sender_uid:self,receiver_id:peer,receiver_type:1,msg_type:1,msg_status:0,msg_key:key,msg_seqno:seq,timestamp:Math.floor(Date.now()/1000),content:'hello',...extra});
function harness(...responses) {
  const calls=[]; const ctx={selfId:self,peerId:peer,deviceId:dev,request:async spec=>{calls.push(spec); return responses.shift() ?? {};}};
  return {ctx,calls,run:(name,p)=>A['bili_'+name].run(ctx,p)};
}

test('text and image/vote dynamics use verified JSON component types',async()=>{
  const {run,calls}=harness({dyn_id:'1'});
  assert.deepEqual(await run('dynamic_create',{text:'offline'}),{dyn_id:'1'});
  await run('dynamic_create',{images:[{url,width:1,height:2}],vote:{id:5,title:'choose'}});
  assert.equal(calls[0].url,'https://api.bilibili.com/x/dynamic/feed/create/dyn');
  assert.deepEqual(calls[0].json,{dyn_req:{content:{contents:[{raw_text:'offline',type:1,biz_id:''}]},scene:1}});
  assert.deepEqual(calls[1].json,{dyn_req:{content:{contents:[{raw_text:'choose',type:4,biz_id:'5'}]},scene:2,pics:[{img_src:url,img_width:1,img_height:2}]}});
});
test('one upload, one vote, and one repost; no implicit follow-up publication',async()=>{
  const {run,calls}=harness();
  await run('dynamic_upload_image',{image}); await run('vote_create',{title:'a',options:['b','c'],duration:86400}); await run('dynamic_repost',{dynamic_id:key});
  const m=calls[0].multipart; assert.ok(m instanceof FormData); assert.equal(m.get('file_up').type,'image/png'); assert.equal(m.get('category'),'daily');
  assert.deepEqual(Buffer.from(await m.get('file_up').arrayBuffer()),Buffer.from(image.split(',')[1],'base64'));
  assert.equal(calls[1].form['info[options][1][desc]'],'c'); assert.equal(calls[1].form['info[choice_cnt]'],1); assert.equal(calls[2].form.dynamic_id,key);
  assert.ok(calls[2].url.endsWith('/dynamic_repost/repost'));assert.equal(calls.length,3);
});
test('article draft, submit and update are distinct full-form operations',async()=>{
  const {run,calls}=harness(); const p={title:'a',text:'<img src="test">\n&',category:34,original:1,cover_url:url};
  await run('article_draft_create',p); await run('article_draft_update',{...p,aid:key});
  await run('article_submit',{...p,aid:key,reprint:0}); await run('article_update',{...p,aid:key,reprint:1});
  await run('article_upload_cover',{image}); await run('article_view',{aid:key}); await run('article_draft_view',{aid:key});
  assert.deepEqual(calls.map(x=>x.url.split('/creative/')[1]),['draft/addupdate','draft/addupdate','article/submit','article/update','article/upcover','article/view','draft/view']);
  assert.equal(calls[0].form.aid,undefined);assert.equal(calls[1].form.aid,key);assert.equal(calls[2].form.category,34);
  assert.equal(calls[2].form.content,'<p>&lt;img src="test"&gt;</p><p>&amp;</p>'); assert.equal(calls[3].form.reprint,1);assert.equal(calls[4].form.cover,image);
});
test('invalid parameters cannot supply paths, transports, csrf, huge data or unknown fields',async()=>{
  const {run,calls}=harness();
  for(const [name,p] of [['dynamic_upload_image',{image:'file:///synthetic'}],['dynamic_upload_image',{image:'data:image/png;base64,YQ=='}],['article_upload_cover',{image:'a'.repeat(3000000)}],['article_submit',{aid:1}],['dynamic_create',{text:'ok',csrf:'fake'}],['dynamic_create',{text:' '}],['dm_ack',{ack_seqno:1,peer_id:'303'}],['vote_create',{title:'a',options:['b','c'],duration:50}],['dynamic_repost',{dynamic_id:9007199254740992}],['dm_history',{size:51}],['dm_send_image',{url:'https://i0.hdslb.com.example.org/bfs/new_dyn/evil.png',width:1,height:1}]]) await assert.rejects(run(name,p),TypeError);
  assert.equal(calls.length,0);
});
test('session list exposes only configured peer summary even on mixed pages',async()=>{
  const {run,calls}=harness({session_list:[{session_type:1,talker_id:peer,session_ts:'123',ack_seqno:'99',unread_count:2,last_msg:'not exposed'},{session_type:1,talker_id:'88',session_ts:'122'},{session_type:2,talker_id:peer,session_ts:'121'}],system_msg:'private',has_more:1});
  assert.deepEqual(await run('dm_sessions',{size:3,end_ts:'130'}),{session_list:[{talker_id:peer,session_type:1,session_ts:'123',ack_seqno:'99',unread_count:2}],next_end_ts:'121'});
  assert.equal(calls[0].query.end_ts,'130');
});
test('history and ack stay peer scoped; recalled and automatic content omitted',async()=>{
  const {run,calls}=harness({messages:[msg(),msg({sender_uid:'303'}),msg({msg_status:1}),msg({msg_source:8})],has_more:1});
  const page=await run('dm_history',{end_seqno:'9007199254740995',size:4}); assert.equal(page.messages.length,1);assert.equal(page.next_end_seqno,seq);assert.equal(page.messages[0].msg_key,key);
  await run('dm_ack',{ack_seqno:seq});assert.deepEqual(calls[1].form,{talker_id:peer,session_type:1,ack_seqno:seq,mobi_app:'web'});assert.equal(A.bili_dm_ack.write,true);
});
test('peer actions unavailable in account-only mode and invalid device cannot send',async()=>{
  const {ctx,run,calls}=harness();ctx.peerId=null;
  // ★ 2026-11-22：`bili_dm_inbox` / `bili_dm_peer_history` 是**故意不绑 peer** 的读动作
  //   （没配私信对端时也要能看到收件箱与正文），其余 dm 动作仍然必须绑 peer。
  const peerBound = Object.keys(A).filter(n=>n.startsWith('bili_dm_') && !['bili_dm_inbox','bili_dm_peer_history'].includes(n));
  for(const n of peerBound){assert.equal(A[n].peer,true);await assert.rejects(A[n].run(ctx,{}),TypeError);}
  ctx.peerId=peer;ctx.deviceId='bad';await assert.rejects(run('dm_send_image',{url,width:1,height:1}),TypeError);assert.equal(calls.length,0);
});
test('image send uses fixed WBI signed peer, and ambiguous receipt is not retried',async()=>{
  const {run,calls}=harness({msg_key:key},{msg_key:key,key_hit_infos:{rule_id:1}});
  assert.deepEqual(await run('dm_send_image',{url,width:300,height:200}),{msg_key:key});assert.equal(calls[0].wbi,true);assert.deepEqual(calls[0].query,{w_sender_uid:self,w_receiver_id:peer,w_dev_id:dev});
  assert.deepEqual(JSON.parse(calls[0].form['msg[content]']),{url,width:300,height:200});
  await assert.rejects(run('dm_send_image',{url,width:300,height:200}),{outcome:'unknown'});assert.equal(calls.length,2);
});
test('empty and non-advancing pages have explicit outcomes; catalog advertises argument names',async()=>{
  const {run,calls}=harness({messages:null,has_more:0},{session_list:[{talker_id:'404',session_type:1,session_ts:'123'}],has_more:1},{messages:[msg()],has_more:1});
  assert.deepEqual(await run('dm_history',{}),{messages:[],next_end_seqno:null});
  assert.deepEqual(await run('dm_sessions',{}),{session_list:[],next_end_ts:'123'});
  await assert.rejects(run('dm_history',{end_seqno:seq}),/cursor/);assert.equal(calls.length,3);
  assert.deepEqual(A.bili_dm_recall.params,['msg_key','msg_seqno']);
  assert.deepEqual(A.bili_dynamic_create.params,['text','images','vote']);
});
test('recall verifies same peer, outgoing direction, exact key/sequence and freshness before sending',async()=>{
  for(const patch of [{receiver_id:'303'},{sender_uid:peer,receiver_id:self},{timestamp:Math.floor(Date.now()/1000)-120},{msg_seqno:'15'},{msg_key:'19'},{msg_status:1}]) {
    const {run,calls}=harness({messages:[msg(patch)]}); await assert.rejects(run('dm_recall',{msg_key:key,msg_seqno:seq}),TypeError);assert.equal(calls.length,1);assert.equal(calls[0].method,undefined);
  }
  const {run,calls}=harness({messages:[msg()]},{msg_key:'77'});await run('dm_recall',{msg_key:key,msg_seqno:seq});assert.deepEqual(calls[0].query,{talker_id:peer,session_type:1,size:1,mobi_app:'web',end_seqno:'9007199254740994'});assert.equal(calls[1].form['msg[msg_type]'],5);assert.equal(calls[1].form['msg[content]'],key);
});
