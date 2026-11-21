import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const WWW = 'https://www.bilibili.com';
const API = 'https://api.bilibili.com';
const NAV = API + '/x/web-interface/nav';
const ADD = API + '/x/v2/reply/add';
const WAIT = 12000;
const safeError = Symbol('browser error');
function failure(code, outcome = 'not_sent', fatal = false) {
  return Object.assign(new Error(`Bilibili browser: ${code}`), { code: `BILI_${code}`, outcome, fatal, [safeError]: true });
}
function id(v) {
  return (typeof v === 'string' || Number.isSafeInteger(v)) && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n ? String(v) : null;
}
function invalid() { throw Object.assign(new TypeError('Invalid Bilibili comment parameters'), {code:'BILI_INVALID_PARAMS',outcome:'not_sent'}); }
function params(p) {
  if (!p || Object.keys(p).some(k => !['oid','root','parent','message'].includes(k))) invalid();
  const oid = id(p.oid), root = p.root === undefined ? '0' : id(p.root), parent = p.parent === undefined ? root : id(p.parent);
  if (!oid || !root || !parent || (parent !== '0' && root === '0') || typeof p.message !== 'string' || !p.message.trim() || p.message.length > 1000 || /[\u0000\r]/.test(p.message)) invalid();
  return {oid, root, parent, message:p.message};
}
function cookies(cookie) {
  const fields = new Map();
  if (typeof cookie !== 'string' || /[^\x20-\x7e]/.test(cookie)) throw failure('BROWSER_CREDENTIALS', 'not_sent', true);
  for (const field of cookie.split(';')) {
    const match = /^([^=\s;]+)=([^;]*)$/.exec(field.trim());
    if (!match || !['SESSDATA','bili_jct','DedeUserID','buvid3','buvid4'].includes(match[1])) continue;
    if (fields.has(match[1])) throw failure('BROWSER_CREDENTIALS', 'not_sent', true);
    fields.set(match[1],match[2]);
  }
  if (!fields.get('SESSDATA') || !fields.get('bili_jct')) throw failure('BROWSER_CREDENTIALS', 'not_sent', true);
  return [WWW,API].flatMap(url => [...fields].map(([name,value]) => ({url:url+'/',name,value,secure:true,httpOnly:name==='SESSDATA',sameSite:'Lax'})));
}
function trusted(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && ([WWW,API,'https://data.bilibili.com'].includes(url.origin) || url.hostname.endsWith('.hdslb.com') || url.hostname.endsWith('.biliimg.com'));
}
function matches(request, p) {
  if (!(request.headers()['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return false;
  const form = new URLSearchParams(request.postData());
  return Object.entries({type:'1',...p}).every(([key,value]) => {
    const entries = form.getAll(key);
    if ((key === 'root' || key === 'parent') && value === '0' && !entries.length) return true;
    return entries.length === 1 && entries[0] === value;
  });
}
function decode(text) { return JSON.parse(text, (_k,v,c) => typeof v==='number' && !Number.isSafeInteger(v) ? c.source : v); }
const challenge = /验证码|安全验证|人机验证|完成验证|captcha|verify you are human/i;

// Kept separate from process ownership so the exact interaction and request gate can run
// in a real Chromium fixture with all network fulfilled locally. Never constructs a write.
async function commentInContext(context, self, p) {
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  const viewUrl = API + '/x/web-interface/view?aid=' + p.oid;
  let videoUrl, armed = false, sent, stopped = false;
  const outcome = () => sent ? 'unknown' : 'not_sent';
  const halt = () => { stopped = true; };
  page.on('response', r => {
    if (new URL(r.url()).origin === API && [401,403,412,429].includes(r.status())) halt();
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const r = route.request(), url = new URL(r.url());
    const block = () => route.abort('blockedbyclient');
    if (!trusted(url) || r.redirectedFrom()) return block();
    if (r.isNavigationRequest() && !(r.frame() === page.mainFrame() && [NAV,viewUrl,videoUrl].includes(url.href))) return block();
    if (['GET','HEAD','OPTIONS'].includes(r.method())) return url.origin + url.pathname === ADD && r.method() !== 'OPTIONS' ? block() : route.fallback();
    if (r.method() === 'POST' && url.origin === 'https://data.bilibili.com' && ['/log/web','/v2/log/web'].includes(url.pathname) && !stopped) return route.fallback(); // opaque official SDK telemetry, never constructed or inspected
    if (r.method() !== 'POST' || url.origin + url.pathname !== ADD || stopped || !armed || sent || r.frame() !== page.mainFrame() || !matches(r,p)) return block();
    sent = r;
    return route.fallback();
  });
  try {
    const nav = await page.goto(NAV, {waitUntil:'commit'});
    if (nav?.url() !== NAV || !nav.ok()) throw failure('IDENTITY_UNAVAILABLE','not_sent',true);
    const identity = decode(await nav.text());
    if (identity?.code !== 0 || identity.data?.isLogin !== true || id(identity.data.mid) !== self) throw failure('IDENTITY_MISMATCH','not_sent',true);
    const view = await page.goto(viewUrl, {waitUntil:'commit'});
    if (view?.url() !== viewUrl || !view.ok()) throw failure('BROWSER_VIDEO_UNAVAILABLE','not_sent',stopped);
    const video = decode(await view.text());
    if (video.code !== 0 || id(video.data?.aid) !== p.oid || !/^BV[A-Za-z0-9]{10}$/.test(video.data?.bvid)) throw failure('BROWSER_VIDEO_UNAVAILABLE','not_sent',stopped || [-101,-352,-412].includes(video.code));
    videoUrl = `${WWW}/video/${video.data.bvid}/`;
    await page.goto(videoUrl + (p.parent === '0' ? '' : '#reply'+p.parent), {waitUntil:'domcontentloaded'});
    const check = async () => {
      if (stopped || new URL(page.url()).origin !== WWW || await page.getByText(challenge).filter({visible:true}).count()) throw failure('BROWSER_CHALLENGE',outcome(),true);
    };
    await check();
    const area = page.locator('bili-comments, .comment-container').filter({visible:true});
    await area.scrollIntoViewIfNeeded();
    if (p.parent !== '0') {
      // Require a visible control on the identified row, never select a reply by list position.
      const row = area.locator(`[data-rpid="${p.parent}"], [data-id="${p.parent}"], #reply${p.parent}`).filter({visible:true});
      await row.getByText('回复',{exact:true}).filter({visible:true}).click();
    }
    const editor = area.locator('textarea, [contenteditable="true"]').filter({visible:true});
    await editor.fill(p.message);
    await check();
    const submit = area.getByText(/^(发布|发送)$/).filter({visible:true});
    armed = true;
    const [receipt] = await Promise.all([
      page.waitForResponse(r => sent !== undefined && r.request() === sent,{timeout:WAIT}), submit.click(),
    ]);
    if (!receipt.ok() || stopped) throw failure('BROWSER_RECEIPT_UNKNOWN',outcome(),stopped);
    const result = decode(await receipt.text());
    if (Number.isSafeInteger(result?.code) && result.code !== 0) {
      const auth = [-101,-102,-111,-352,-401,-403,-412,-509].includes(result.code);
      throw failure(`API_${result.code}`,auth ? 'not_sent' : 'unknown',auth);
    }
    const reply = result?.data?.reply, rpid = id(result?.data?.rpid_str ?? result?.data?.rpid);
    if (result?.code !== 0 || !rpid || (reply && (id(reply.rpid_str ?? reply.rpid) !== rpid || id(reply.mid) !== self || id(reply.oid) !== p.oid || String(reply.root) !== p.root || String(reply.parent) !== p.parent || reply.content?.message !== p.message))) throw failure('BROWSER_RECEIPT_UNKNOWN',outcome());
    return {rpid,oid:p.oid,root:p.root,parent:p.parent};
  } catch (e) {
    if (e?.[safeError]) throw e;
    let blocked = stopped;
    try { blocked ||= await page.getByText(challenge).filter({visible:true}).count() > 0; } catch {}
    throw failure(blocked ? 'BROWSER_CHALLENGE' : sent ? 'BROWSER_RECEIPT_UNKNOWN' : 'BROWSER_UI_UNAVAILABLE',outcome(),blocked);
  } finally { armed = false; }
}

const loadPlaywright = driverPath => import(driverPath ? pathToFileURL(driverPath).href : 'playwright');
export function createBiliBrowser({selfId,cookie,executablePath,driverPath,headless=true}, loadDriver = loadPlaywright) {
  const self = id(selfId);
  if (!self || typeof headless !== 'boolean' || [executablePath,driverPath].some(v => v !== undefined && (typeof v !== 'string' || !isAbsolute(v)))) throw failure('BROWSER_CONFIG');
  let launching, busy = false, closed = false, stopped = false;
  async function launch() {
    try {
      const driver = await loadDriver(driverPath);
      const browser = await (driver.chromium ?? driver.default.chromium).launch({executablePath,headless,chromiumSandbox:true, args:['--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE www.bilibili.com, EXCLUDE api.bilibili.com, EXCLUDE *.hdslb.com, EXCLUDE *.biliimg.com, EXCLUDE data.bilibili.com']});
      browser.once('disconnected',() => { launching = undefined; });
      return browser;
    } catch { launching = undefined; throw failure('BROWSER_UNAVAILABLE'); }
  }
  return {
    async comment(input) {
      const p = params(input);
      if (closed || stopped || busy) throw failure('BROWSER_NOT_READY','not_sent',stopped);
      busy = true; let context;
      try {
        const credentials = cookies(cookie);
        const browser = await (launching ??= launch());
        context = await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
        await context.addCookies(credentials);
        return await commentInContext(context,self,p);
      } catch (e) {
        if (e?.fatal) stopped = true;
        if (e?.[safeError]) throw e;
        throw failure('BROWSER_UNAVAILABLE');
      } finally { try { await context?.close(); } catch {} busy = false; }
    },
    async close() { closed = true; const browser = await launching?.catch(() => undefined); await browser?.close(); },
  };
}
export const browserActions = {
  bili_send_comment: {params:['oid','message','root','parent'],write:true,browser:true,run:async (ctx,p) => {
    params(p);
    if (typeof ctx.browser?.comment !== 'function') throw failure('BROWSER_UNAVAILABLE');
    return ctx.browser.comment(p);
  }},
};
