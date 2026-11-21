import test from 'node:test';
import assert from 'node:assert/strict';
import {createPassportChallenge, PASSPORT_POLL_MS} from '../src/platforms/bilibili/passport.mjs';
import {authorizeBiliClient} from '../src/platforms/bilibili/authorized-client.mjs';
import {BiliClient} from '../src/platforms/bilibili/client.mjs';

const base = 'https://passport.bilibili.com/x/passport-login/web/qrcode/';
const key = 'synthetic-test-qr-key';
const url = `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=${key}&from=`;
const reply = (data, cookies=[]) => Response.json({code:0,data}, {headers:cookies.map(c=>['set-cookie',c])});
const gen = () => reply({url,qrcode_key:key});
const scope = '; Domain=.bilibili.com; Path=/; Secure';
const cookies = ['SESSDATA=synthetic'+scope,'bili_jct=test-only'+scope,'other=ignored'+scope];
function setup(sequence) {
  let time=0, accepted=[]; const requests=[];
  const deps = {now:()=>time, wait:async n=>{time+=n;}, fetchImpl:async (u,options)=>{
    requests.push({u,options}); const next=sequence.shift(); assert.ok(next, 'unexpected network attempt');
    return typeof next === 'function' ? next() : next;
  }};
  const c=createPassportChallenge({...deps,onApproved:v=>{accepted.push(v);}});
  return {deps,c,requests,accepted,advance:(n=PASSPORT_POLL_MS)=>{time+=n;}};
}

test('single generate; poll gate, scanned != approved; one private cookie handoff',async()=>{
  const {c,advance,accepted,requests}=setup([gen(),reply({code:86101},cookies),reply({code:86090},cookies),reply({code:0,url:'ignored',refresh_token:'ignored'},cookies)]);
  assert.deepEqual(await c.start(),{status:'waiting',qrUrl:url,expiresAt:180000});
  await assert.rejects(c.start()); assert.equal((await c.poll()).status,'waiting'); assert.equal(requests.length,1);
  advance(); assert.equal((await c.poll()).status,'waiting'); advance(); assert.equal((await c.poll()).status,'scanned');
  assert.deepEqual(accepted,[]); advance(); assert.deepEqual(await c.poll(),{status:'approved'});
  assert.deepEqual(accepted,['SESSDATA=synthetic; bili_jct=test-only']);
  advance(); await c.poll(); await assert.rejects(c.start());
  assert.deepEqual(requests.map(r=>r.u),[base+'generate',...Array(3).fill(base+'poll?qrcode_key='+key)]);
  for(const {options} of requests) {assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);}
});

test('account scan-web accepts only official destination, literal close callback and matching 32-character key',async()=>{
  const qrcode_key='0123456789abcdef'.repeat(2);
  const prefix='https://account.bilibili.com/h5/account-h5/auth/scan-web?';
  const valid=prefix+`navhide=1&callback=close&qrcode_key=${qrcode_key}&from=`;
  for (const qr of [valid,prefix+`from=&qrcode_key=${qrcode_key}&callback=close&navhide=1`]) {
    const {c,requests}=setup([reply({url:qr,qrcode_key})]); assert.equal((await c.start()).qrUrl,qr);
    c.cancel();assert.deepEqual(requests.map(r=>r.u),[base+'generate']);
  }
  for(const bad of [valid.replace('close','https://invalid.test/'),valid.replace('close','https%3A%2F%2Finvalid.test'),
    valid+'&callback=close',valid.replace('callback=close&',''),valid.replace(qrcode_key,'0'.repeat(32)),valid.replace('account.bilibili.com','invalid.test'),
    valid.replace('scan-web?','scan-web/other?'),valid+'#fragment',valid+'&extra=x']) {
    const {c,requests}=setup([reply({url:bad,qrcode_key})]);await assert.rejects(c.start());assert.equal(requests.length,1);
  }
});

test('unsafe QR, foreign host, mismatched key and duplicate key are not presented',async()=>{
  for(const bad of [url.replace('passport.','other.'),url.replace(key,'different'),url+'&qrcode_key='+key,url+'&next=x',url+'#x']) {
    const {c,requests}=setup([reply({url:bad,qrcode_key:key})]); await assert.rejects(c.start(),{message:'Bilibili passport challenge unavailable'});
    assert.deepEqual(await c.poll(),{status:'failed'});assert.equal(requests.length,1);
  }
});

test('expiry, restriction and bad cookies terminate without redirect, refresh or query-token fallback',async()=>{
  const ok={code:0,url:'https://invalid.test/?SESSDATA=test&bili_jct=test'};
  for (const [res,end] of [[reply({code:86038}),'expired'],[new Response('',{status:429}),'failed'],[new Response('',{status:302}),'failed'],
    [reply({code:-352}),'failed'],[reply(ok),'failed'],[reply(ok,[...cookies,cookies[0]]),'failed'],
    [reply(ok,cookies.map(s=>s.replace('.bilibili.com','passport.bilibili.com'))),'failed']]) {
    const {c,advance,requests,accepted}=setup([gen(),res]);await c.start();advance();assert.deepEqual(await c.poll(),{status:end});
    advance();await c.poll();await assert.rejects(c.start());assert.equal(requests.length,2);assert.deepEqual(accepted,[]);
  }
  const {c,advance,requests}=setup([gen()]);await c.start();advance(180000);assert.deepEqual(await c.poll(),{status:'expired'});assert.equal(requests.length,1);
});

test('abort during poll or local expiry rejects late approval; concurrent polls do not duplicate requests',async()=>{
  for(const end of ['expired','cancelled']) {
    let done; const {c,requests,accepted,advance}=setup([gen(),()=>new Promise(r=>{done=r;})]);
    await c.start();advance();const flight=c.poll();advance();await c.poll();assert.equal(requests.length,2);
    if(end==='cancelled') {c.cancel(); assert.ok(requests[1].options.signal.aborted);}else advance(180000);
    done(reply({code:0},cookies));assert.deepEqual(await flight,{status:end});assert.deepEqual(accepted,[]);
  }
});

test('only same-UID nav returns opaque verified client; host callback sees just official QR descriptor',async()=>{
  for(const mid of [123,456]) {
    const {deps,requests}=setup([gen(),reply({code:0},cookies),reply({mid,isLogin:true,uname:'fixture'})]);
    const events=[]; const login=authorizeBiliClient({selfId:'123',peerId:'789',onQr:q=>events.push(q),signal:new AbortController().signal},deps);
    if(mid===123){const client=await login;assert.ok(client instanceof BiliClient); assert.equal(JSON.stringify(client),'{}');}
    else await assert.rejects(login,{message:'Bilibili authorization failed'});
    assert.deepEqual(events,[{url,expiresAt:180000}]);assert.equal(requests.length,3);
    assert.equal(requests[2].u,'https://api.bilibili.com/x/web-interface/nav');assert.equal(requests[2].options.headers.Cookie,'SESSDATA=synthetic; bili_jct=test-only');
  }
});

test('cancel before generate, or dismiss QR, does not poll; thrown callback details remain private',async()=>{
  for(const mode of ['pre','dismiss','throw']) {
    const ab=new AbortController();if(mode==='pre')ab.abort(); const {deps,requests}=setup([gen()]);
    const task=authorizeBiliClient({selfId:'123',signal:ab.signal,onQr:()=>{if(mode==='dismiss')ab.abort();else throw Error(key);}},deps);
    await assert.rejects(task,e=>!e.message.includes(key)&&/authorization/.test(e.message));assert.equal(requests.length,mode==='pre'?0:1);
  }
});
