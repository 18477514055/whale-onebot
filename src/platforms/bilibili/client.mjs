import { createHash } from 'node:crypto';

// Community web contract, not a public developer API:
// https://github.com/SocialSisterYi/bilibili-API-collect/blob/917a90a/docs/message/private_msg.md
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const IM = 'https://api.vc.bilibili.com/';
const HISTORY = IM + 'svr_sync/v1/svr_sync/fetch_session_msgs';
const SEND = IM + 'web_im/v1/web_im/send_msg';
const UUID4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const KEY_ORDER = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
const MAX_U64 = '18446744073709551615';
const stopCodes = new Set([-101,-102,-111,-352,-401,-403,-412,-509,21020,21046]);
const definiteRejections = new Set([-101,-102,-111,-352,-400,-401,-403,21007,21020,21026,21028,21035,21046,21047,25003,25005]);

function problem(message, outcome = 'not_sent', fatal = false, code = 'BILI_CLIENT_ERROR') {
  return Object.assign(new Error(`Bilibili: ${message}`), { outcome, fatal, code });
}
function decimal(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return null;
  const s = String(value);
  return /^[1-9]\d{0,19}$/.test(s) && (s.length < 20 || s <= MAX_U64) ? s : null;
}
function decode(text) {
  // Node >=24 exposes the original numeric token, before IEEE-754 rounding.
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && (key === 'msg_key' || !Number.isSafeInteger(value))) return context.source;
    return value;
  });
}
function decodeAction(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value !== 'number') return value;
    // Leave round-trippable decimals numeric; never publish a rounded identifier or decimal.
    return key === 'msg_key' || (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
      String(value) !== context.source ? context.source : value;
  });
}
function mixin(wbi) {
  const key = url => typeof url === 'string' && /\/([0-9a-f]{32})\.\w+$/i.exec(url)?.[1];
  const a = key(wbi?.img_url), b = key(wbi?.sub_url);
  return a && b ? KEY_ORDER.map(i => (a + b)[i]).join('') : null;
}

// Internal action transport. Public action handlers own paths and parameter schemas.
const API_ORIGINS = new Set(['api', 'api.live', 'api.vc', 'member', 'message']
  .map(subdomain => `https://${subdomain}.bilibili.com`));
const sensitive = /^(?:cookie|set-cookie|cookie_info|cookies|sessdata|bili_jct|csrf(?:_?token)?|authorization|access_?key|(?:access_|refresh_|auth_?)?token|password|buvid[34]?|dedeuserid(?:__ckmd5)?|wbi_img)$/i;
const reserved = key => sensitive.test(key) || /^(?:w_rid|wts|__proto__|constructor|prototype)$/i.test(key);
const record = value => value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function scalar(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return String(value);
  throw problem('invalid action parameter');
}
function fields(value, multipart = false) {
  const entries = multipart && value instanceof FormData ? [...value] : record(value) ? Object.entries(value) : null;
  if (!entries) throw problem('invalid action fields');
  return entries.map(([k,v]) => {
    if (!k || reserved(k) || k.split(/[.\[\]]/).some(reserved)) throw problem('reserved action field');
    return [k, multipart && v instanceof Blob ? v : scalar(v)];
  });
}
function jsonBody(value) {
  if (!record(value)) throw problem('invalid action JSON');
  try {
    return JSON.stringify(value, (k,v) => {
      if (reserved(k) || v !== null && !['string','number','boolean','object'].includes(typeof v) ||
          typeof v === 'number' && !Number.isFinite(v)) throw Error();
      return v;
    });
  } catch { throw problem('invalid action JSON'); }
}
function signedQuery(params, key) {
  if (!key) throw problem('missing signing metadata');
  params.set('wts', String(Math.floor(Date.now() / 1000)));
  params.sort();
  const query = [...params].map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.replace(/[!'()*]/g,''))}`).join('&');
  const digest = createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${digest}`;
}

export class BiliClient {
  #fetch; #cookie; #csrf; #self; #peer; #device; #verified = false; #key; #stopCode;
  constructor({ cookie, selfId, peerId, deviceId, fetchImpl = globalThis.fetch }) {
    this.#self = decimal(selfId); this.#peer = decimal(peerId);
    if (!this.#self || (peerId != null && !this.#peer) || this.#self === this.#peer) throw problem('invalid account or peer');
    if (typeof fetchImpl !== 'function') throw problem('fetch unavailable');
    if (typeof cookie !== 'string' || /[^\x20-\x7e]/.test(cookie)) throw problem('invalid cookie');
    const fields = cookie.split(';').map(field => field.trim());
    const part = name => {
      const matches = fields.filter(f => f.startsWith(name + '='));
      if (matches.length > 1) throw problem('ambiguous cookie');
      return matches[0]?.slice(name.length + 1);
    };
    if (!part('SESSDATA')) throw problem('missing login');
    if (deviceId != null && !UUID4.test(deviceId)) throw problem('invalid device id');
    this.#csrf = part('bili_jct'); this.#cookie = cookie; this.#device = deviceId; this.#fetch = fetchImpl;
  }
  #stop(message, outcome, code) {
    this.#stopCode ??= code;
    this.#verified = false;
    throw problem(message, outcome, true, code);
  }
  #active() {
    if (this.#stopCode) throw problem('session stopped; manual review required', 'not_sent', true, this.#stopCode);
  }
  async #exchange(url, method, headers, body) {
    this.#active();
    const uncertain = method === 'POST' ? 'unknown' : 'not_sent';
    let response;
    try {
      response = await this.#fetch(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Cookie: this.#cookie, ...headers }, body,
      });
    } catch { throw problem('transport failed', uncertain); }
    if (!response.ok) {
      if ((response.status >= 300 && response.status < 400) || [401,403,412,429].includes(response.status)) this.#stop(`HTTP ${response.status}`, uncertain, `BILI_HTTP_${response.status}`);
      throw problem('upstream unavailable', uncertain, false, `BILI_HTTP_${response.status}`);
    }
    return response;
  }
  async #request(url, body) {
    const writing = body !== undefined;
    const response = await this.#exchange(url, writing ? 'POST' : 'GET', {
      Referer: 'https://message.bilibili.com/', ...(writing && { Origin: 'https://message.bilibili.com',
        'Content-Type': 'application/x-www-form-urlencoded' }),
    }, body);
    return this.#data(response, writing ? 'unknown' : 'not_sent');
  }
  async #data(response, uncertain, action = false) {
    let result;
    try { result = (action ? decodeAction : decode)(await response.text()); } catch { throw problem('invalid response', uncertain); }
    if (!Number.isSafeInteger(result?.code)) throw problem('invalid response code', uncertain);
    if (result.code !== 0) {
      const outcome = definiteRejections.has(result.code) || (action && result.code > 0) ? 'not_sent' : uncertain;
      const label = `API rejection (${result.code})`;
      const code = `BILI_API_${result.code}`;
      if (stopCodes.has(result.code)) this.#stop(label, outcome, code);
      throw problem(label, outcome, false, code);
    }
    if (action === 'https://api.live.bilibili.com/msg/send' && ![undefined, null, '', '0', 'ok', 'OK', 'success'].includes(result.message)) {
      // Live chat may report moderation or rejection inside a code-zero envelope.
      throw problem('live message not confirmed', 'unknown', false, 'BILI_LIVE_UNCONFIRMED');
    }
    return result.data;
  }
  async request({ url, method = 'GET', query = {}, form, json, multipart, wbi = false, format = 'json' }) {
    this.#active();
    let endpoint;
    try { endpoint = new URL(url); } catch { throw problem('invalid action endpoint'); }
    if (typeof url !== 'string' || endpoint.href !== url || !API_ORIGINS.has(endpoint.origin) ||
        endpoint.username || endpoint.password || /[?#]/.test(url)) throw problem('invalid action endpoint');
    const writing = method === 'POST';
    const count = [form, json, multipart].filter(v => v !== undefined).length;
    if ((!writing && method !== 'GET') || count > (writing ? 1 : 0) || !['text','json'].includes(format) ||
        (writing && format === 'text') || typeof wbi !== 'boolean') throw problem('invalid action options');
    if (writing && !this.#csrf) throw problem('send credentials incomplete');
    const params = new URLSearchParams(fields(query));
    const profile = endpoint.hostname === 'api.bilibili.com' && /^\/x\/member\/(?:web\/(?:account|update|sign\/update|face\/update)|uname\/update\/message)$/.test(endpoint.pathname);
    const origin = profile ? 'https://account.bilibili.com' : endpoint.hostname === 'api.live.bilibili.com' ? 'https://live.bilibili.com' :
      ['api.vc.bilibili.com','message.bilibili.com'].includes(endpoint.hostname) ? 'https://message.bilibili.com' : 'https://www.bilibili.com';
    const headers = { Referer: origin + (profile ? endpoint.pathname.endsWith('/face/update') ? '/account/face/upload' : '/account/setting' : '/') };
    let body;
    if (writing) {
      headers.Origin = origin;
      if (json !== undefined) {
        body = jsonBody(json);
        headers['Content-Type'] = 'application/json';
        params.set('csrf', this.#csrf);
      } else {
        if (multipart !== undefined) {
          body = new FormData();
          for (const [k,v] of fields(multipart, true)) body.append(k,v);
          if (url === 'https://api.bilibili.com/x/member/web/face/update') params.set('csrf', this.#csrf);
        } else {
          body = new URLSearchParams(fields(form === undefined ? {} : form));
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        body.set('csrf', this.#csrf);
        body.set('csrf_token', this.#csrf);
      }
    }
    if (writing || !this.#verified || (wbi && !this.#key)) await this.identity();
    endpoint.search = wbi ? signedQuery(params, this.#key) : params.toString();
    const response = await this.#exchange(endpoint, method, headers, body);
    const secrets = this.#cookie.split(';').map(part => part.trim().split(/=(.*)/s))
      .filter(([name, val]) => /^(?:SESSDATA|bili_jct|DedeUserID__ckMd5|buvid[34])$/i.test(name) && val).map(([,val]) => val);
    const scrub = text => secrets.reduce((s,v) => s === v ? '[redacted]' : v.length >= 6 ? s.replaceAll(v,'[redacted]') : s, text);
    if (format === 'text') {
      let text;
      try { text = await response.text(); } catch { throw problem('invalid text response'); }
      const type = (response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if ((type && !['text/xml','application/xml','text/plain'].includes(type)) || /^\s*(?:[\[{]|<!doctype\s+html|<html\b)/i.test(text)) throw problem('invalid text response');
      return scrub(text);
    }
    const data = await this.#data(response, writing ? 'unknown' : 'not_sent', url);
    const clean = value => typeof value === 'string' ? scrub(value) : Array.isArray(value) ? value.map(clean) :
      value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k]) => !reserved(k)).map(([k,v]) => [k,clean(v)])) : value;
    const result = clean(data);
    // Only the live socket connector needs this ephemeral ticket. Never serialize it to OneBot.
    if (!writing && url === 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo' && typeof data?.token === 'string') {
      Object.defineProperty(result, 'token', { value: data.token });
    }
    return result;
  }
  async identity() {
    this.#verified = false;
    const nav = await this.#request(NAV);
    this.#active(); // A concurrent read can invalidate the session while nav is in flight.
    if (typeof nav?.isLogin !== 'boolean' || (nav.isLogin && !decimal(nav.mid))) throw problem('invalid identity response');
    if (!nav.isLogin || decimal(nav.mid) !== this.#self) this.#stop('login or account mismatch', 'not_sent', 'BILI_IDENTITY_MISMATCH');
    if (typeof nav.uname !== 'string') throw problem('invalid identity response');
    this.#key = mixin(nav.wbi_img); this.#verified = true;
    return { user_id: this.#self, nickname: nav.uname };
  }
  async messages(endSeqno) {
    if (!this.#peer) throw problem('peer not configured');
    const url = new URL(HISTORY);
    url.search = new URLSearchParams({ talker_id: this.#peer, session_type: '1', size: '50', mobi_app: 'web' });
    if (endSeqno !== undefined) {
      if (!decimal(endSeqno)) throw problem('invalid history cursor');
      url.searchParams.set('end_seqno', String(endSeqno));
    }
    if (!this.#verified) await this.identity();
    const data = await this.#request(url);
    const raw = data?.messages === null ? [] : data?.messages;
    if (!Array.isArray(raw)) throw problem('invalid history response');
    let high = null, low = null;
    for (const message of raw) {
      const seq = decimal(message?.msg_seqno);
      if (!seq || (endSeqno !== undefined && BigInt(seq) >= BigInt(endSeqno))) throw problem('invalid message sequence');
      if (high === null || BigInt(seq) > BigInt(high)) high = seq;
      if (low === null || BigInt(seq) < BigInt(low)) low = seq;
    }
    const rows = raw.filter(m => {
      const sender = decimal(m?.sender_uid), receiver = decimal(m?.receiver_id);
      return m?.receiver_type === 1 && ((sender === this.#self && receiver === this.#peer) ||
        (sender === this.#peer && receiver === this.#self));
    });
    Object.defineProperty(rows, 'highSeqno', { value: high });
    if (data.has_more === 1) {
      if (low === null || (data.min_seqno !== undefined && decimal(data.min_seqno) !== low)) throw problem('invalid next cursor');
      Object.defineProperty(rows, 'nextCursor', { value: low });
    } else if (data.has_more === 0) Object.defineProperty(rows, 'nextCursor', { value: null });
    for (const row of rows) {
      if (!decimal(row.msg_key) || !decimal(row.msg_seqno)) throw problem('invalid message identifiers');
      row.msg_key = String(row.msg_key);
    }
    return rows.sort((a,b) => BigInt(a.msg_seqno) > BigInt(b.msg_seqno) ? -1 : BigInt(a.msg_seqno) < BigInt(b.msg_seqno) ? 1 : 0);
  }
  async sendText(text) {
    if (!this.#peer) throw problem('peer not configured');
    if (typeof text !== 'string' || !text.trim() || [...text].length > 500) throw problem('invalid text');
    if (!this.#device || !this.#csrf) throw problem('send credentials incomplete');
    await this.identity(); // A fresh proof before every mutation, never trust a caller-provided UID.
    if (!this.#key) throw problem('missing signing metadata');
    const now = String(Math.floor(Date.now() / 1000));
    // Fixed keys in lexicographic order; values are strictly decimal or UUID.
    const query = new URLSearchParams({ w_dev_id: this.#device, w_receiver_id: this.#peer, w_sender_uid: this.#self, wts: now });
    const digest = createHash('md5').update(query.toString() + this.#key).digest('hex');
    query.set('w_rid', digest);
    const body = new URLSearchParams({ 'msg[sender_uid]': this.#self, 'msg[receiver_id]': this.#peer,
      'msg[receiver_type]': '1', 'msg[msg_type]': '1', 'msg[content]': JSON.stringify({ content: text }),
      'msg[dev_id]': this.#device, 'msg[timestamp]': now, csrf_token: this.#csrf, csrf: this.#csrf, mobi_app: 'web' });
    const data = await this.#request(SEND + '?' + query, body);
    if (!decimal(data?.msg_key) || (data.key_hit_infos != null && Object.keys(data.key_hit_infos).length)) {
      throw problem('unconfirmed send receipt', 'unknown');
    }
    return { msg_key: String(data.msg_key) };
  }
}
