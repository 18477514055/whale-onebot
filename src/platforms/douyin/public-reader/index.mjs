// Optional, deliberately conservative Node adapter. Importing makes no request.
const BASE = 'https://www.douyin.com/video/';
const MAX = 512 * 1024;
const GATE = /登录|登陆|注册|验证|验证码|滑块|访问受限|频繁|不存在|不可见|不公开|已删除|已下架|无法查看|暂不可|无权|仅自己|私密|朋友可见|好友可见|页面错误|出错|人机|安全检查|请稍后|打开抖音|下载抖音|captcha|challenge|verify|verification|log[ -]?in|sign[ -]?in|forbidden|access denied|not found|unavailable|private|error|enable javascript/i;
class Refusal extends Error { constructor(code) { super(`Public work refused: ${code}`); this.code = code; } }
function refuse(code) { throw new Refusal(code); }
function clean(s) { return s.replace(/\s+/gu, ' ').trim(); }
function decode(s) {
  const names = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' '};
  return s.replace(/&(?:([a-z]+);|#(\d+);|#x([\da-f]+);)?/gi, (_, name, dec, hex) => {
    if (name && Object.hasOwn(names, name)) return names[name];
    const n = dec ? Number(dec) : hex ? parseInt(hex,16) : 0;
    if (!Number.isSafeInteger(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) refuse('unsupported_entity');
    return String.fromCodePoint(n);
  });
}
// Recognise a small unambiguous HTML subset instead of searching arbitrary HTML for tags.
function evidence(html, url) {
  const shape = /^\s*<!doctype html>\s*/i.exec(html);
  if (!shape || /[\u0000-\u0008\u000b\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(html)) refuse('unsupported_document');
  const token = /([^<]+)|<\/(\w+)[ \t\r\n\f]*>|<([a-z][a-z0-9]*)((?:[ \t\r\n\f]+[a-z_:][\w:.-]*[ \t\r\n\f]*=[ \t\r\n\f]*(?:"[^"<>]*"|'[^'<>]*'))*)[ \t\r\n\f]*(\/?)>/giy;
  const stack = [], seen = new Set(), ids = [], titles = [], heading = [], visible = [];
  const blocks = new Set(['main','article','section','header','footer','div','h1','p','span','br']);
  let pos = shape[0].length, count = 0;
  while (pos < html.length) {
    token.lastIndex = pos;
    const t = token.exec(html); if (!t || ++count > 20000) refuse('unsupported_markup');
    pos = token.lastIndex;
    const parent = stack.at(-1);
    if (t[1] !== undefined) {
      const s = decode(t[1]);
      if (GATE.test(s)) refuse('restricted_page');
      if (parent === 'title') titles.push(s);
      else if (parent === 'h1') heading.push(s);
      else if (s.trim() && !stack.includes('body')) refuse('unexpected_text');
      if (stack.includes('body')) visible.push(s);
      continue;
    }
    if (t[2]) { if (stack.pop() !== t[2].toLowerCase()) refuse('malformed_markup'); continue; }
    const tag = t[3].toLowerCase(), a = Object.create(null);
    for (const m of t[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = m[1].toLowerCase(), val = decode(m[2] ?? m[3]);
      if (key in a || GATE.test(val)) refuse('ambiguous_or_restricted');
      a[key] = val;
    }
    if (['html','head','body','title','h1'].includes(tag)) {
      if (seen.has(tag)) refuse('duplicate_element'); seen.add(tag);
    }
    let attrs = [];
    if (tag === 'html' && !parent) attrs = ['lang'];
    else if (tag === 'head' && parent === 'html' && !seen.has('body')) { /* ok */ }
    else if (tag === 'body' && parent === 'html' && seen.has('head')) { /* ok */ }
    else if (tag === 'title' && parent === 'head') { /* ok */ }
    else if (tag === 'meta' && parent === 'head') {
      attrs = ['charset','property','content','name'];
      if (a.charset && !/^utf-8$/i.test(a.charset)) refuse('unsupported_charset');
      if (a.property?.toLowerCase() === 'og:url') ids.push(a.content);
      if (a.property?.toLowerCase() === 'og:title') titles.push(a.content ?? '');
    } else if (tag === 'link' && parent === 'head' && a.rel?.toLowerCase() === 'canonical') {
      attrs = ['rel','href']; ids.push(a.href);
    } else if (tag === 'video' && stack.includes('body') && ['main','article','section','div','body'].includes(parent)) {
      attrs = ['src','poster','preload']; // Opaque, never opened or returned.
      if (!/^https:\/\/[^\s]+$/i.test(a.src ?? '')) refuse('unconfirmed_body');
      seen.add('video');
    } else if (blocks.has(tag) && stack.includes('body') && !['h1','span','p','video'].includes(parent)) { /* static text only */ }
    else refuse('unsupported_markup');
    if (Object.keys(a).some(k => !attrs.includes(k))) refuse('unsupported_attributes');
    if (!['meta','link','br'].includes(tag)) {
      if (t[5] || stack.length > 64) refuse('malformed_markup'); stack.push(tag);
    }
  }
  if (stack.length || !seen.has('body') || !ids.length || ids.some(id => id !== url)) refuse('unconfirmed_identity');
  const title = clean(heading.join(''));
  if (!title || title.length > 256 || /^(抖音|douyin|抖音短视频|记录美好生活)$/i.test(title) || !titles.length || titles.some(s => clean(s) !== title)) refuse('unconfirmed_title');
  if (GATE.test(visible.join('').replace(/\s+/g,'')) || GATE.test(title)) refuse('restricted_page');
  // Unknown extra body copy could be a new restriction prompt, not work evidence.
  if (!seen.has('video') || clean(visible.join('')) !== title) refuse('unconfirmed_body');
  return title;
}
export function createPublicReader({fetch: fetchImpl = globalThis.fetch} = {}) {
  return async function resolvePublicWork(input) {
    const id = input?.work_id;
    if (typeof id !== 'string' || id.length > 20 || !/^[1-9][0-9]{0,19}$/.test(id) || /\D/.test(id)) refuse('invalid_work_id');
    const url = BASE + id, controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetchImpl(url, {method:'GET', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', headers:{Accept:'text/html'}, signal:controller.signal});
      if (r.status !== 200 || r.redirected || (r.url && r.url !== url)) refuse('unexpected_response');
      if (!/^text\/html(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i.test(r.headers.get('content-type') ?? '')) refuse('unsupported_content_type');
      if (['refresh','www-authenticate','proxy-authenticate','location','cf-mitigated'].some(h => r.headers.has(h))) refuse('restricted_response');
      if (!r.body || Number(r.headers.get('content-length')) > MAX) refuse('body_limit');
      const decoder = new TextDecoder('utf-8', {fatal:true}); let bytes = 0, html = '';
      for await (const chunk of r.body) {
        bytes += chunk.byteLength; if (bytes > MAX) refuse('body_limit'); html += decoder.decode(chunk,{stream:true});
      }
      html += decoder.decode();
      const title = evidence(html, url);
      return {work_id:id,visibility:'public',evidence:'anonymous',title};
    } catch (err) { if (err instanceof Refusal) throw err; refuse(controller.signal.aborted ? 'timeout' : 'request_or_decode_failed'); }
    finally { clearTimeout(timeout); controller.abort(); }
  };
}
export const resolvePublicWork = createPublicReader();
