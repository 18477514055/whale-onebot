import test from 'node:test';
import assert from 'node:assert/strict';
import {profileActions as actions} from '../src/platforms/bilibili/actions/social-profile.mjs';
const API = 'https://api.bilibili.com';
const prev = {uname:'Alice',sex:'保密',birthday:'2000-02-29',sign:'original'};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=';
function fixture(...responses) {
  const requests = [];
  const ctx = {request: async r => { requests.push(r); assert.ok(responses.length,'unexpected request'); return responses.shift(); }};
  return {requests, call:(name,p) => actions['bili_'+name].run(ctx,p)};
}
test('only current profile is read-only; project only supported fields', async () => {
  assert.deepEqual(Object.keys(actions).filter(k=>!actions[k].write), ['bili_get_self_profile']);
  const f = fixture({...prev,email:'omit',mid:4});
  assert.deepEqual(await f.call('get_self_profile',{}),prev);
  assert.deepEqual(f.requests,[{method:'GET',url:API+'/x/member/web/account'}]);
});
test('profile patch preserves untouched fields; rename checks eligibility and explicit confirmation',async () => {
  const f = fixture(prev,{allow:true},{code:0});
  await f.call('update_profile',{uname:'新的昵称',confirm_rename:true,birthday:'2004-02-29'});
  assert.deepEqual(f.requests.map(x=>x.url),['/x/member/web/account','/x/member/uname/update/message','/x/member/web/update'].map(p=>API+p));
  assert.deepEqual(f.requests[2].form,{uname:'新的昵称',sex:'保密',birthday:'2004-02-29',usersign:'original',source:'profile_web'});
  for (const permission of [{allow:false},{allow:'false'},null,{}]) {
    const g = fixture(prev,permission);
    await assert.rejects(g.call('update_profile',{uname:'new',confirm_rename:true}),{outcome:'not_sent'});
    assert.ok(g.requests.every(x=>x.method==='GET'));
  }
  const g = fixture({...prev,sign:null});
  await assert.rejects(g.call('update_profile',{sex:'女'}),{outcome:'not_sent'});
  assert.equal(g.requests.length,1);
});
test('signature supports clear and checks inner rejection without echoing upstream',async () => {
  const f = fixture(null,{code:40015,message:'do not echo'});
  assert.equal(await f.call('update_signature',{sign:''}),null);
  assert.deepEqual(f.requests[0],{url:API+'/x/member/web/sign/update',method:'POST',form:{user_sign:''}});
  await assert.rejects(f.call('update_signature',{sign:'valid'}),{code:'BILI_API_40015',message:'Profile update rejected'});
});
test('avatar is bounded inline multipart with derived name/type, no caller csrf',async () => {
  const f = fixture('ok');
  await f.call('update_avatar',{image_base64:png});
  const [{multipart:body,...request}] = f.requests;
  assert.deepEqual(request,{method:'POST',url:API+'/x/member/web/face/update'});
  assert.deepEqual([...body.keys()],['dopost','DisplayRank','face']);
  assert.equal(body.get('dopost'),'save'); assert.equal(body.get('DisplayRank'),'10000');
  assert.equal(body.get('face').name,'avatar.png'); assert.equal(body.get('face').type,'image/png');
  assert.deepEqual(Buffer.from(await body.get('face').arrayBuffer()),Buffer.from(png,'base64'));
});
const create = (type,values) => ({aid:101,cid:'202',type,...values});
test('build typed command bodies, preserve exact string IDs, never forward raw data',async () => {
  for (const [params,data] of [
    [create(1,{msg:'你好'}),{msg:'你好'}],
    [create(2,{msg:'link',bvid:'BV1kz4y1X7XP'}),{msg:'link',bvid:'BV1kz4y1X7XP'}],
    [create(5,{duration:5000,posX:549,posY:82}),{duration:5000,posX:549,posY:82}],
    [create(9,{question:'Which?',options:['A','B']}),{duration:7000,posX:300,posY:150,posX_2:30,posY_2:40,pub_dynamic:false,vote_type:0,has_self_def:'0',question:'Which?',optionA:'A',optionB:'B'}],
    [create(11,{title:'Rate',skin:2}),{msg:'Rate',skin:2,duration:5000,posX_2:30,posY_2:40}]
  ]) {
    const f = fixture({idStr:'39053842117558279'});
    assert.deepEqual(await f.call('create_command_danmaku',params),{idStr:'39053842117558279'});
    assert.deepEqual(f.requests,[{url:API+'/x/v2/dm/command/post',method:'POST',form:{type:params.type,aid:'101',cid:'202',plat:1,progress:0,data:JSON.stringify(data)}}]);
  }
  const f = fixture(null);
  await f.call('delete_command_danmaku',{cid:'202',dmid:'39053842117558279'});
  assert.deepEqual(f.requests,[{method:'POST',url:API+'/x/v2/dm/command/del',form:{oid:'202',dmid:'39053842117558279'}}]);
});
test('reject malformed or overbroad requests before any transport call', async () => {
  const f = fixture();
  for (const [name,list] of Object.entries({
    get_self_profile:[{mid:'123'}], update_profile:[{}, {uname:'x'}, {birthday:'2025-02-29'},{sex:'unknown'},{sex:'女',csrf:'x'},Object.create({uname:'x'})],
    update_signature:[{sign:'x'.repeat(71)},{sign:null},{sign:'x\u0000y'},{sign:'ok',form:{}}],
    update_avatar:[{path:'avatar.png'},{url:'https://example.invalid/'},{image_base64:'data:image/png;base64,'+png},{image_base64:png+'\n'},{image_base64:Buffer.from('<svg/>').toString('base64')},{image_base64:'A'.repeat(3*1024*1024)}],
    create_command_danmaku:[create(1,{msg:'x',data:'{}'}),create(2,{msg:'x',bvid:'https://example.invalid/'}),create(1,{msg:'x',progress:-1}),create(9,{question:'?',options:['a','a']}),create(5,{duration:5000,posX:550,posY:82}),create(10,{}),create(11,{title:'t',skin:4}),create(1,{msg:'x',aid:9007199254740992})],
    delete_command_danmaku:[{cid:'2',dmid:'2,3'},{cid:'0',dmid:'3'},{cid:'2',dmid:'9223372036854775808'}]
  })) for (const p of list) await assert.rejects(f.call(name,p),TypeError);
  assert.equal(f.requests.length,0);
});
