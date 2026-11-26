import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPublicReader} from './index.mjs';
const id = '7123456789012345678', url = `https://www.douyin.com/video/${id}`, title = '合成的春日';
const page = `<!DOCTYPE html><html lang="zh"><head><link rel="canonical" href="${url}"><meta property="og:url" content="${url}"><meta property="og:title" content="${title}"><title>${title}</title></head><body><main><h1>${title}</h1><video src="https://asset.invalid/not-loaded"></video></main></body></html>`;
function run(body = page, headers = {}, status = 200) {
  let calls = 0;
  const read = createPublicReader({fetch:async (target, init) => {
    assert.equal(++calls,1); assert.equal(target,url); assert.equal(init.method,'GET'); assert.equal(init.credentials,'omit'); assert.equal(init.redirect,'error'); assert.deepEqual(init.headers,{Accept:'text/html'});
    return new Response(body,{status,headers:{'Content-Type':'text/html; charset=UTF-8',...headers}});
  }});
  return read({work_id:id});
}
test('only corroborated header and body return the four contracted fields',async()=>assert.deepEqual(await run(),{work_id:id,visibility:'public',evidence:'anonymous',title}));
test('arbitrary targets and short links never reach fetch',async()=>{
  let calls=0; const read=createPublicReader({fetch:()=>{ calls++; }});
  for(const work_id of [123,'0','123\n','12?x','https://v.douyin.com/abc/','https://evil.invalid/',null]) await assert.rejects(read({work_id}),{code:'invalid_work_id'});
  assert.equal(calls,0);
});
for(const [name,body,code] of [
  ['conflicting identity',page.replace(url,url+'0'),'unconfirmed_identity'],['no identity',page.replace(/<link[^>]+>|<meta property="og:url"[^>]+>/g,''),'unconfirmed_identity'],
  ['preview without a static work element',page.replace(/<video.*?<\/video>/,''),'unconfirmed_body'],['only metadata',page.replace(/<h1>.*?<\/h1>/,''),'unconfirmed_title'],['mismatched heading',page.replace('<h1>'+title,'<h1>别的作品'),'unconfirmed_title'],
  ['login entity',page.replace('</main>','<p>&#30331;录</p></main>'),'restricted_page'],['unknown prompt',page.replace('</main>','<p>请先完成下一步</p></main>'),'unconfirmed_body'],
  ['comment injection',page.replace('<head>','<head><!--'),'unsupported_markup'],['script shell',page.replace('</body>','<script src="/x.js"></script></body>'),'unsupported_markup'],
  ['meta refresh',page.replace('</head>','<meta http-equiv="refresh" content="0"></head>'),'unsupported_attributes'],['hidden heading',page.replace('<h1>','<h1 style="display:none">'),'unsupported_attributes'],
  ['body too large','x'.repeat(524289),'body_limit'],['invalid utf8',new Uint8Array([255]),'request_or_decode_failed']
]) test(name,async()=>assert.rejects(run(body),{code}));
for(const [name,headers,status,code] of [['redirect',{location:url},302,'unexpected_response'],['challenge header',{'cf-mitigated':'challenge'},200,'restricted_response'],['non HTML',{'content-type':'application/json'},200,'unsupported_content_type'],['throttled',{},429,'unexpected_response']]) test(name,async()=>assert.rejects(run(page,headers,status),{code}));
