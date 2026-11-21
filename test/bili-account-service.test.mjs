import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startBiliService} from '../src/platforms/bilibili/service.mjs';

async function serve(t,options={}) {
  const token=randomUUID(), requests=[];
  const client={identity:async()=>({user_id:'123',nickname:'fixture'}),messages:async()=>{throw Error('Account-only must not read an inbox');},sendText:async()=>assert.fail(),
    request:async r=>{requests.push(r);return {fixture:true};}};
  const service=await startBiliService({selfId:'123',port:0,client,token,accountActions:true,...options});
  t.after(()=>service.close());
  const call=async(action,params={},auth=token)=>{
    const r=await fetch(`http://127.0.0.1:${service.address.port}/`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify({action,params,echo:'test'})});
    return r.json();
  };
  return {call,requests,client};
}
test('HTTP account-only service: no DM baseline; read discovery, real dispatch and auth',async t=>{
  const {call,requests}=await serve(t);
  assert.equal((await call('bili_video_info',{aid:1},'wrong')).retcode,1403);
  const r=await call('bili_video_info',{aid:1});assert.equal(r.retcode,0);assert.deepEqual(r.data,{fixture:true});assert.equal(r.echo,'test');
  assert.equal(requests[0].url,'https://api.bilibili.com/x/web-interface/view');
  const names=(await call('get_supported_actions')).data;
  assert(names.includes('bili_live_subscribe'));assert(!names.includes('bili_video_coin'));assert(!names.includes('send_private_msg'));
  assert.equal((await call('bili_video_coin',{aid:1,multiply:1})).retcode,1403);
  assert.equal((await call('bili_request',{url:'https://example.invalid'})).retcode,1404);
  const catalog=(await call('bili_action_catalog')).data;assert(catalog.every(row=>!row.write && names.includes(row.name)));
});
test('HTTP account write does not unlock DM, resolve caller URLs, or retry an unknown write',async t=>{
  const {call,requests,client}=await serve(t,{allowAccountWrites:true});
  const names=(await call('get_supported_actions')).data;assert(names.includes('bili_video_coin'));
  // ★ 契约变更（2026-11-22）：`bili_send_comment` 现在**没有浏览器也会出现** —— 手机内置环境包
  //   没有 chromium，浏览器版在手机上永不注册，实测「待审通过」发不出去（1404）。改为纯 Node 回退
  //   （src/platforms/bilibili/actions/reply.mjs）。写权限仍由 allowAccountWrites 把门。
  assert(names.includes('bili_send_comment'));
  const catalog=(await call('bili_action_catalog')).data;
  assert.equal(catalog.find(row=>row.name==='bili_send_comment')?.write, true);
  assert(!names.includes('send_private_msg'));
  assert.equal((await call('send_private_msg',{user_id:456,message:'hi'})).retcode,1403);
  let attempts=0;client.request=async()=>{attempts++;throw Object.assign(new Error('PRIVATE_DIAGNOSTIC'),{outcome:'unknown'});};
  const r=await call('bili_video_coin',{aid:'1',multiply:1});assert.equal(r.retcode,1504);assert(!JSON.stringify(r).includes('PRIVATE_DIAGNOSTIC'));assert.equal(attempts,1);assert.equal(requests.length,0);
});
test('browser action is discoverable only when backend provided and write enabled; owned browser is closed',async()=>{
  let closed=0;const service=await startBiliService({selfId:123,token:randomUUID(),port:0,accountActions:true,allowAccountWrites:true,
    client:{identity:async()=>({user_id:'123'}),messages(){},sendText(){},request(){}},browser:{comment:async()=>({rpid:'321'}),close(){closed++;}}});
  try { const r=await service.bridge.dispatch({action:'bili_action_catalog'});assert(r.data.some(x=>x.name==='bili_send_comment' && x.write)); }
  finally {await service.close();}assert.equal(closed,1);
});
