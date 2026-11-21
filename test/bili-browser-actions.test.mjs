import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {browserActions,createBiliBrowser} from '../src/platforms/bilibili/actions/browser.mjs';

const action = browserActions.bili_send_comment;
test('browser is lazy; descriptor validates before handing parameters to the transport',async () => {
  assert.equal(action.write,true); assert.equal(action.browser,true);
  const p = {oid:'1',message:'hello',root:'2',parent:'3'};
  assert.equal(await action.run({browser:{comment:async v=>v}},p),p);
  for (const bad of [{...p,url:'https://untrusted.invalid'},{...p,oid:'../123'}, {...p,root:undefined}, {...p,message:'\r'}, {...p,oid:2**54}]) await assert.rejects(action.run({},bad),{code:'BILI_INVALID_PARAMS'});
  await assert.rejects(action.run({},p),{code:'BILI_BROWSER_UNAVAILABLE'});
  const browser = createBiliBrowser({selfId:'42',cookie:''});
  await assert.rejects(browser.comment(p),{code:'BILI_BROWSER_CREDENTIALS',outcome:'not_sent',fatal:true});
  await browser.close();
});

// Opt in to a real browser already installed on the developer machine. No credentials,
// DNS, local HTTPS listener, or external service required. Every request is intercepted.
const exe = process.env.BILI_BROWSER_TEST_EXECUTABLE_PATH;
test('offline Chromium: visible shadow-DOM controls, exact dispatch gate and receipts', {skip: !exe && 'set BILI_BROWSER_TEST_EXECUTABLE_PATH for real fixture UI'}, async t => {
  const lib = await import(process.env.BILI_BROWSER_TEST_DRIVER_PATH ? pathToFileURL(process.env.BILI_BROWSER_TEST_DRIVER_PATH).href : 'playwright');
  async function run({root='0',parent='0',who='42',challenge=false,wrong=false,reject=false,wrongTarget=false}={}) {
    let c, scopedCookies;
    const calls=[];
    const html = `<!doctype html><meta charset="utf-8"><bili-comments></bili-comments><script>
      const s=document.querySelector('bili-comments').attachShadow({mode:'open'});
      s.innerHTML='<div data-rpid="20"><button>回复</button></div><div data-rpid="30"><button>回复</button></div><textarea></textarea><button id="submit">发布</button>${challenge?'<span>安全验证</span>':''}';
      let pid='0'; s.querySelectorAll('[data-rpid] button').forEach(el=>el.onclick=()=>pid=el.parentNode.dataset.rpid);
      s.querySelector('#submit').onclick=()=>fetch('https://api.bilibili.com/x/v2/reply/add',{method:'POST',body:new URLSearchParams({type:'1',oid:'${wrongTarget?'999':'10'}',root:pid==='0'?'0':'20',parent:pid,message:s.querySelector('textarea').value})}).catch(()=>{});
    </script>`;
    const installFixture = () => c.route('**/*', async r => {
      const url = r.request().url();
      if (url === 'https://api.bilibili.com/x/web-interface/nav') {
        scopedCookies = await c.cookies();
        return r.fulfill({json:{code:0,data:{isLogin:true,mid:who}}});
      }
      if (url === 'https://api.bilibili.com/x/web-interface/view?aid=10') return r.fulfill({json:{code:0,data:{aid:10,bvid:'BV1234567890'}}});
      if (url === 'https://www.bilibili.com/video/BV1234567890/') return r.fulfill({contentType:'text/html',body:html});
      if (url === 'https://api.bilibili.com/x/v2/reply/add') {
        calls.push(new URLSearchParams(r.request().postData()));
        return r.fulfill({headers:{'Access-Control-Allow-Origin':'*'},json:reject ? {code:-352} : {code:0,data:{rpid:9,reply:{rpid:9,mid:'42',oid:'10',root,parent:wrong?'999':parent,content:{message:'test'}}}}});
      }
      return r.abort();
    });
    const driver = {chromium:{launch: async options => {
      const browser = await (lib.chromium ?? lib.default.chromium).launch({...options,args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND']});
      return {once:browser.once.bind(browser),close:browser.close.bind(browser),newContext:async opts=>{
        c = await browser.newContext(opts); await installFixture(); return c;
      }};
    }}};
    const client = createBiliBrowser({selfId:'42',cookie:'SESSDATA=fixture; bili_jct=fixture',executablePath:exe},async()=>driver);
    try { return {value:await client.comment({oid:'10',...(root!=='0' && {root,parent}),message:'test'}),calls}; }
    catch(error) {return {error,calls};} finally {
      await client.close();
      assert.deepEqual(scopedCookies?.map(x=>x.domain).sort(),['api.bilibili.com','api.bilibili.com','www.bilibili.com','www.bilibili.com']);
      assert.ok(scopedCookies.every(x=>x.secure && x.path==='/' && x.httpOnly===(x.name==='SESSDATA')));
    }
  }
  for (const [name,root,parent] of [['root','0','0'],['reply to root','20','20'],['reply to nested','20','30']]) await t.test(name,async()=>{
    const {value,calls,error}=await run({root,parent}); if(error) throw error;
    assert.deepEqual(value,{rpid:'9',oid:'10',root,parent}); assert.deepEqual(calls.map(x=>x.get('parent')),[parent]);
  });
  for(const [name,options,outcome,posts,fatal] of [
    ['wrong identity',{who:'999'},'not_sent',0,true],['visible challenge',{challenge:true},'not_sent',0,true],
    ['wrong DOM target blocked before dispatch',{wrongTarget:true},'not_sent',0,false],
    ['mismatched receipt',{wrong:true},'unknown',1,false],['explicit auth rejection',{reject:true},'not_sent',1,true],
  ]) await t.test(name,async()=>{const {error,calls}=await run(options);assert.equal(error?.outcome,outcome); assert.equal(calls.length,posts); assert.equal(error.fatal,fatal);});
});
