import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BiliClient } from '../src/platforms/bilibili/client.mjs';

const url = 'https://api.bilibili.com/x/mock';
const cookie = 'SESSDATA=mock-session; bili_jct=mock-csrf; DedeUserID=123456';
const nav = { code:0, data:{ mid:123456, uname:'fixture', isLogin:true, wbi_img:{
  img_url:'https://example.invalid/7cd084941338484aae1ad9425b84077c.png',
  sub_url:'https://example.invalid/4932caff0ff746eab6f01bf08b70ac45.png' } } };
function mock(...items) {
  const calls=[];
  const client = new BiliClient({ selfId:123456, cookie, fetchImpl:async (u,opt) => {
    calls.push({url:new URL(u),...opt});
    assert.ok(items.length,'unexpected fetch');
    const next=items.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : new Response(typeof next === 'string' ? next : JSON.stringify(next));
  } });
  return {calls, client};
}
const ok = {code:0,data:{ok:true}};
test('fixed HTTPS origins; invalid URL, method, body, and credential overrides fail before network', async () => {
  const {client,calls} = mock();
  const parts = new FormData(); parts.append('csrf_token','override');
  const inputs = [ ...['http://api.bilibili.com/x','https://api.bilibili.tv/x','https://api.bilibili.com.example.com/x',
    'https://u@api.bilibili.com/x','https://api.bilibili.com:444/x','//api.bilibili.com/x',url+'?csrf=x',url+'#x'].map(url=>({url})),
    {method:'DELETE'},{form:{}},{method:'POST',json:{},form:{}},{method:'POST',format:'text'},
    {query:{BILI_JCT:'override'}},{query:{w_rid:'override'}},{method:'POST',form:{csrf:'override'}},
    {method:'POST',json:{foo:[{csrf_token:'override'}]}},{method:'POST',multipart:parts} ];
  for (const options of inputs) await assert.rejects(client.request({url,...options}),{outcome:'not_sent'});
  await assert.rejects(client.messages(),/peer/); await assert.rejects(client.sendText('mock'),/peer/);
  assert.equal(calls.length,0);
});
test('GET signs filtered encoded query with nav key, preserves exact IDs, strips secrets recursively',async()=>{
  const {client,calls}=mock(nav,'{"code":0,"data":{"id":9223372036854775807,"uid":"123456","items":[{"csrf":"x","SESSDATA":"y","access_token":"z","safe":"got mock-session"}]}}');
  assert.deepEqual(await client.request({url,query:{z:"中 !'()*+",a:2},wbi:true}),{id:'9223372036854775807',uid:'123456',items:[{safe:'got [redacted]'}]});
  const req=calls[1]; const canonical=`a=2&wts=${req.url.searchParams.get('wts')}&z=%E4%B8%AD%20%2B`;
  assert.equal(req.url.search,`?${canonical}&w_rid=`+createHash('md5').update(canonical+'ea1db124af3c7062474693fa704f4ff8').digest('hex'));
  assert.ok(calls.every(c=>c.redirect==='manual' && c.headers.Cookie===cookie));
});
test('all write styles require fresh verified identity; multipart copied, filename preserved, csrf placed by transport',async()=>{
  const {client,calls}=mock(nav,ok,nav,ok,nav,ok,nav,ok);
  const multipart=new FormData(); multipart.append('file',new Blob(['fixture'],{type:'text/plain'}),'test.txt');
  for(const payload of [{form:{a:1}},{json:{a:[2]}},{multipart},{multipart,url:'https://api.bilibili.com/x/member/web/face/update'}]) {
    assert.deepEqual(await client.request({url,method:'POST',...payload}),{ok:true});
  }
  assert.deepEqual(calls.map(c=>c.method),Array(4).fill(['GET','POST']).flat());
  assert.equal(calls[1].url.search,''); assert.equal(calls[1].body.get('csrf_token'),'mock-csrf');
  assert.equal(calls[3].url.search,'?csrf=mock-csrf'); assert.equal(calls[3].body,'{"a":[2]}');
  assert.equal(calls[5].body.get('file').name,'test.txt'); assert.equal(calls[5].body.get('csrf'),'mock-csrf');
  assert.equal(calls[5].headers['Content-Type'],undefined); assert.equal(multipart.has('csrf'),false);
  assert.equal(calls[7].url.search,'?csrf=mock-csrf');
  const mismatch=mock(nav,ok,{code:0,data:{...nav.data,mid:7}});
  await mismatch.client.request({url}); await assert.rejects(mismatch.client.request({url,method:'POST'}),{fatal:true,outcome:'not_sent'});
  assert.equal(mismatch.calls.filter(c=>c.method==='POST').length,0);
});
test('XML/plain text only; JSON and HTML errors must never masquerade as text data', async()=>{
  const {client}=mock(nav,new Response('<i>fixture</i>',{headers:{'content-type':'text/xml'}}),'raw text',ok,'<html>error</html>');
  const read=()=>client.request({url,format:'text'});
  assert.equal(await read(),'<i>fixture</i>'); assert.equal(await read(),'raw text');
  await assert.rejects(read(),/invalid text/); await assert.rejects(read(),/invalid text/);
});
test('manual redirects latch, ambiguous writes never retry, diagnostics contain no payload/URL/headers', async()=>{
  for(const [reply,expected] of [[new Response(null,{status:302,headers:{location:'https://foreign.invalid/mock-csrf'}}),{fatal:true,outcome:'unknown',code:'BILI_HTTP_302'}],
    [Error(cookie),{outcome:'unknown'}],['bad mock-session',{outcome:'unknown'}],[{code:1234,message:cookie},{outcome:'not_sent',code:'BILI_API_1234'}]]) {
    const {calls,client}=mock(nav,reply);
    await assert.rejects(client.request({url,method:'POST',form:{text:'private'}}),e=>{
      for(const [k,v] of Object.entries(expected))assert.equal(e[k],v);
      assert.doesNotMatch(e.message,/mock-session|mock-csrf|private|https:/); return true;
    });
    if(expected.fatal)await assert.rejects(client.request({url}),{fatal:true,outcome:'not_sent'});
    assert.equal(calls.length,2);
  }
});
test('wire decimals stay numeric when exact, otherwise keep the original token', async()=>{
  const {client}=mock(nav,'{"code":0,"data":[1.5,1.00000000000000001,18446744073709551615]}');
  assert.deepEqual(await client.request({url}),[1.5,'1.00000000000000001','18446744073709551615']);
});
test('live moderation in a code-zero envelope is not a confirmed write',async()=>{
  const {client,calls}=mock(nav,{code:0,message:'f',data:{}},nav,{code:0,message:'',data:{}});
  const post=()=>client.request({url:'https://api.live.bilibili.com/msg/send',method:'POST',form:{msg:'fixture'}});
  await assert.rejects(post(),{code:'BILI_LIVE_UNCONFIRMED',outcome:'unknown'});
  assert.deepEqual(await post(),{}); assert.equal(calls.length,4);
});
test('live handshake exposes a nonserializable ticket only for its fixed internal GET', async()=>{
  const {client}=mock(nav,{code:0,data:{token:'ephemeral',host_list:[]}},{code:0,data:{token:'ephemeral'}});
  const data=await client.request({url:'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'});
  assert.equal(data.token,'ephemeral'); assert.equal(JSON.stringify(data),'{"host_list":[]}');
  assert.deepEqual(await client.request({url}),{});
});
