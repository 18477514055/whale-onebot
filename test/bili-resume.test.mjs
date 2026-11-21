import test from 'node:test';
import assert from 'node:assert/strict';
import {startOwnedProtocol,enrollOwnedAccount} from '../android/bili-protocol-host.mjs';
import {openOwnedBiliClient} from '../src/platforms/bilibili/authorized-client.mjs';
import {startBiliService} from '../src/platforms/bilibili/service.mjs';

const token='x'.repeat(43),selfId='123',base={selfId,token}, savedCookie='SESSDATA=mock-only; bili_jct=fixture';
const nav='https://api.bilibili.com/x/web-interface/nav', passport='https://passport.bilibili.com/x/passport-login/web/qrcode/';
const identity=()=>Response.json({code:0,data:{isLogin:true,mid:123,uname:'fixture'}});
const key='0'.repeat(32),scan=`https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${key}&from=`;
const gen=()=>Response.json({code:0,data:{url:scan,qrcode_key:key}});
const approved=()=>Response.json({code:0,data:{code:0,refresh_token:'unused',url:'ignored'}},{headers:['DedeUserID=123','other=unused','bili_jct=fixture','SESSDATA=mock-only'].map(v=>['set-cookie',v+'; Domain=bilibili.com; Path=/'])});
test('first interactive enrollment derives UID only after the same login passes nav; mismatched proof is not handed off',async()=>{
  for(const matches of [true,false]){
    const replies=[gen,approved,matches?identity:()=>Response.json({code:0,data:{isLogin:true,mid:456,uname:'other'}})],confirmed=[];
    const task=openOwnedBiliClient({interactive:true,enroll:true,onQr:()=>{},onPersist:(cookie,id)=>{assert.equal(cookie,savedCookie);confirmed.push(id)}},{wait:async()=>{},fetchImpl:async()=>replies.shift()()});
    if(matches){const client=await task;assert.deepEqual(confirmed,['123']);assert.equal((await client.identity()).user_id,'123');}else{await assert.rejects(task);assert.deepEqual(confirmed,[]);}
    assert.equal(replies.length,0);
  }
});
test('enrollment host has no service or peer; emits a single verified private handoff and closes the client',async()=>{
 const input={enroll:true,interactive:true},ids=[];let closed=0;
 const deps={openClient:async opts=>{assert.equal(opts.peerId,undefined);opts.onPersist(savedCookie,'123');return {identity:async()=>({user_id:'123'}),close:()=>closed++}},onEnrolled:(id,c)=>{assert.equal(c,savedCookie);ids.push(id)}};
 await enrollOwnedAccount(input,deps);assert.deepEqual(ids,['123']);assert.equal(closed,1);
 for(const extra of [{interactive:false},{selfId:'123'},{savedCookie},{peerId:'456'},{token}])await assert.rejects(enrollOwnedAccount({...input,...extra},deps),{message:'invalid_configuration'});
 await assert.rejects(enrollOwnedAccount(input,{...deps,openClient:async opts=>{opts.onPersist(savedCookie,'123');return {identity:async()=>({user_id:'456'}),close:()=>closed++}}}),{message:'identity_mismatch'});assert.deepEqual(ids,['123']);assert.equal(closed,2);
});
test('running session yields on explicit invalidation only; another account remains verified, no QR or send',async()=>{
 const otherCookie='SESSDATA=second-fixture; bili_jct=second',otherId='456';
 const otherNav=()=>Response.json({code:0,data:{isLogin:true,mid:Number(otherId),uname:'second'}});
 const other=harness([otherNav,otherNav],otherCookie);const live=await other.run({savedCookie:otherCookie,selfId:otherId});try{
  for(const [reply,expected] of [[()=>Response.json({code:-101}),'reauth_required'],[()=>Response.json({code:0,data:{isLogin:true,mid:789}}),'reauth_required'],[()=>{throw Error('offline')},'disconnected'],[()=>Response.json({code:-352}),'disconnected'],[identity,'verified']]){
   const h=harness([identity,reply]);const host=await h.run({savedCookie});try{assert.equal(await host.checkSession(),expected);assert.deepEqual(h.urls,[nav,nav]);assert.deepEqual(h.qrs,[]);}finally{await host.close();}
  }assert.equal(await live.checkSession(),'verified');
 }finally{await live.close();}
});
test('a refused data read survives a racing successful nav and later checks without recontacting the provider',async()=>{
 for(const [code,state] of [[-101,'reauth_required'],[-352,'disconnected']]){
  const data=Promise.withResolvers(),navReply=Promise.withResolvers(),urls=[];
  let client;
  const host=await startOwnedProtocol({...base,savedCookie},{openClient:async opts=>(client=await openOwnedBiliClient(opts,{fetchImpl:async url=>{
   urls.push(String(url));return urls.length===1?identity():String(url)===nav?navReply.promise:data.promise;
  }})),startService:startBiliService});
  try{
   const endpoint='https://api.bilibili.com/x/web-interface/view';
   const read=client.request({url:endpoint}),checking=host.checkSession();
   data.resolve(Response.json({code}));await assert.rejects(read,{code:`BILI_API_${code}`});
   navReply.resolve(identity());assert.equal(await checking,state);assert.equal(await host.checkSession(),state);
   assert.deepEqual(urls,[nav,endpoint,nav]);
  }finally{await host.close();}
 }
});
function harness(sequence, expectedCookie=savedCookie) {
  const urls=[],qrs=[],handoffs=[];let t=0;
  const deps={wait:async ms=>{t+=ms;},now:()=>t,fetchImpl:async(u,init)=>{
    urls.push(u); if(u===nav)assert.equal(init.headers.Cookie,expectedCookie);
    if(!sequence.length)throw Error('unexpected request');return sequence.shift()();}};
  const run=input=>startOwnedProtocol({...base,...input},{openClient:opts=>openOwnedBiliClient(opts,deps),startService:startBiliService,
    onQr:q=>qrs.push(q),onPersist:v=>handoffs.push(v)});
  return {run,urls,qrs,handoffs};
}

test('default saved login starts real loopback service with exactly one nav, no QR, no repersistence',async()=>{
  const {run,urls,qrs,handoffs}=harness([identity]); const host=await run({savedCookie});
  try{assert.deepEqual(urls,[nav]);assert.deepEqual(qrs,[]);assert.deepEqual(handoffs,[]);assert.equal(host.service.bridge.status().online,true);
    assert.ok(!JSON.stringify(host.service.bridge.status()).includes('SESSDATA'));}finally{await host.close();}
});
test('only explicit fresh and UID-verified QR hands parent two scoped cookies, no refresh token',async()=>{
  const {run,urls,qrs,handoffs}=harness([gen,approved,identity]);const host=await run({interactive:true});
  try{assert.deepEqual(urls,[passport+'generate',passport+'poll?qrcode_key='+key,nav]);assert.deepEqual(qrs,[{url:scan,expiresAt:180000}]);assert.deepEqual(handoffs,[savedCookie]);}finally{await host.close();}
  const bad=harness([gen,approved,()=>Response.json({code:0,data:{isLogin:true,mid:456,uname:'other'}})]);
  await assert.rejects(bad.run({interactive:true}),{message:'Bilibili authorization failed'});assert.deepEqual(bad.handoffs,[]);
});
test('missing session stops offline; proven expiry or different UID requires interactive action; malformed/nav/risk errors never invalidate',async()=>{
  const empty=harness([]);await assert.rejects(empty.run({}),{message:'reauth_required'});assert.deepEqual(empty.urls,[]);
  for(const v of ['','SESSDATA=wrong',savedCookie+'; foreign=1',savedCookie+'\n',savedCookie+'a'.repeat(3100)]) {
    const bad=harness([]);await assert.rejects(bad.run({savedCookie:v}),{message:'authorization_failed'});assert.deepEqual(bad.urls,[]);
  }
  for(const [body,state] of [[{code:-101},'reauth_required'],[{code:0,data:{isLogin:false}},'reauth_required'],[{code:0,data:{isLogin:true,mid:456}},'reauth_required'],
    [{code:0,data:{}},'authorization_failed'],[{code:0,data:{isLogin:true}},'authorization_failed'],[{code:-352},'authorization_failed'],[null,'authorization_failed']]) {
    const bad=harness([()=>body ? Response.json(body):new Response('',{status:429})]);await assert.rejects(bad.run({savedCookie,interactive:true}),{message:state});
    assert.deepEqual(bad.urls,[nav]);assert.deepEqual(bad.handoffs,[]);assert.deepEqual(bad.qrs,[]);
  }
});
