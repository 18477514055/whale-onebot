// Community-documented official web contract (not an Open Platform SDK):
// https://github.com/SocialSisterYi/bilibili-API-collect/blob/917a90a/docs/login/login_action/QR.md
// No cookie jar, callback URL exchange, refresh token, redirects or implicit retry.
const origin = 'https://passport.bilibili.com';
const base = origin + '/x/passport-login/web/qrcode/';
const scan = origin + '/h5-app/passport/login/scan?';
const lifetime = 180_000;
export const PASSPORT_POLL_MS = 3000;
const unavailable = () => new Error('Bilibili passport challenge unavailable');

function scanUrl(data) {
  if (typeof data?.qrcode_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.qrcode_key) ||
      typeof data.url !== 'string' || data.url.length > 512) throw unavailable();
  const accountScan = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?';
  const modern = data.url.startsWith(accountScan);
  if (modern ? data.qrcode_key.length !== 32 : !data.url.startsWith(scan)) throw unavailable();
  const allowed = new Map([['navhide',['1']], ['from',modern ? [''] : ['', 'main-fe-header']], ['qrcode_key',[data.qrcode_key]]]);
  if (modern) allowed.set('callback',['close']); // An action literal, never a URL.
  for (const pair of data.url.slice(modern ? accountScan.length : scan.length).split('&')) {
    const [k,v,...rest] = pair.split('=');
    if (!allowed.get(k)?.includes(v) || rest.length) throw unavailable();
    allowed.delete(k);
  }
  if (allowed.has('qrcode_key') || (modern && allowed.size)) throw unavailable();
  return data.url;
}

function approvedCookies(headers, now) {
  // getSetCookie preserves individual fields (Expires can contain commas).
  const values = new Map();
  for (const field of headers.getSetCookie()) {
    const [pair, ...attrs] = field.split(';').map(s => s.trim());
    const name = pair.split('=',1)[0];
    if (!['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5'].includes(name)) continue;
    const value = pair.slice(name.length + 1);
    if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/.test(value) || values.has(name)) throw unavailable();
    // Only cookies scoped to the parent domain and the root path belong on API requests.
    const attr = key => attrs.filter(s => s.toLowerCase().startsWith(key+'=')).map(s => s.slice(key.length+1));
    if (!/^\.?bilibili\.com$/i.test(attr('domain').join(',')) || attr('path').join(',') !== '/') throw unavailable();
    const maxAge = attr('max-age'), expires = attr('expires');
    if (maxAge.length ? !(maxAge.length === 1 && /^\d+$/.test(maxAge[0]) && Number(maxAge[0]) > 0) :
        expires.length && !(expires.length === 1 && Date.parse(expires[0]) > now)) throw unavailable();
    values.set(name,value);
  }
  if (!values.has('SESSDATA') || !values.has('bili_jct')) throw unavailable();
  return Array.from(values, ([k,v]) => `${k}=${v}`).join('; ');
}

export function createPassportChallenge({onApproved, fetchImpl = globalThis.fetch, now = Date.now}) {
  if (typeof onApproved !== 'function') throw unavailable();
  const controller = new AbortController();
  let status = 'idle', expiresAt, nextPoll, key, busy = false;
  const snapshot = () => ({status});
  const active = () => ['starting','waiting','scanned'].includes(status);
  function stop(end) {
    status = end; key = undefined; controller.abort();
    return snapshot();
  }
  function expire() { if (active() && now() >= expiresAt) stop('expired'); }
  async function get(url) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    const res = await fetchImpl(url, {method:'GET', redirect:'error', credentials:'omit', cache:'no-store', signal});
    if (res.status !== 200 || res.redirected || (res.url && res.url !== url)) throw unavailable();
    const body = await res.json();
    if (body?.code !== 0 || !body.data) throw unavailable();
    return {data:body.data,headers:res.headers};
  }
  return {
    async start() {
      if (status !== 'idle') throw unavailable();
      status = 'starting'; expiresAt = now() + lifetime;
      try {
        const {data} = await get(base+'generate');
        expire(); if (!active()) throw unavailable();
        const qrUrl = scanUrl(data);
        key = data.qrcode_key; status = 'waiting'; nextPoll = now()+PASSPORT_POLL_MS;
        return {status,qrUrl,expiresAt};
      } catch { if (active()) stop('failed'); throw unavailable(); }
    },
    async poll() {
      expire();
      if (busy || !['waiting','scanned'].includes(status) || now() < nextPoll) return snapshot();
      busy = true; nextPoll = now()+PASSPORT_POLL_MS;
      try {
        const {data,headers} = await get(base+'poll?qrcode_key='+key);
        expire(); if (!active()) return snapshot();
        switch (data.code) {
          case 86101: status = 'waiting'; break;
          case 86090: status = 'scanned'; break;
          case 86038: return stop('expired');
          case 0:
            await onApproved(approvedCookies(headers, now()), {
              refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '',
            });
            expire(); if (active()) stop('approved');
            break;
          default: return stop('failed');
        }
      } catch { if (active()) stop('failed'); }
      finally { busy = false; }
      return snapshot();
    },
    cancel() { return active() || status === 'idle' ? stop('cancelled') : snapshot(); },
  };
}
