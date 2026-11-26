// Hook-free QQ Web CGI & Cookie/p_skey adapter (Qzone / Qun / File URL).
// Uses official NTQQ TipOff / Ticket N-API services only; NEVER logs or archives plaintext cookies/keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './error.mjs';

const COOKIE_CACHE_TTL_MS = 15 * 60 * 1000;
const PSKEY_CACHE_TTL_MS = 60 * 1000;
const GROUP_LIST_CACHE_TTL_MS = 60 * 1000;
const MAX_UPLOAD_IMAGE_BYTES = 15 * 1024 * 1024;
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export function isValidQqDomain(domain) {
  if (typeof domain !== 'string') return false;
  const host = domain.trim().toLowerCase();
  if (!host || host.length > 128) return false;
  if (host !== 'qq.com' && !host.endsWith('.qq.com')) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host);
}

export function computeBkn(skeyOrPskey) {
  const s = typeof skeyOrPskey === 'string' ? skeyOrPskey : '';
  if (!s) return 0;
  let hash = 5381;
  for (let i = 0; i < s.length; i += 1) {
    hash += (hash << 5) + s.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

function sanitizeToken(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 1024) return '';
  if (/[\s\x00-\x1f\x7f;]/.test(value)) return '';
  return value;
}

function targetUrlForDomain(domain, botUin) {
  if (domain === 'qun.qq.com' || domain === 'pan.qun.qq.com') return 'https://qun.qq.com/member.html';
  if (domain === 'user.qzone.qq.com' || domain === 'qzone.qq.com' || domain === 'h5.qzone.qq.com') {
    return `https://user.qzone.qq.com/${botUin}`;
  }
  return `https://${domain}/`;
}

function daidForDomain(domain) {
  if (domain === 'qun.qq.com' || domain === 'pan.qun.qq.com') return '73';
  if (domain.includes('qzone.qq.com')) return '5';
  if (domain === 'mail.qq.com') return '2';
  if (domain === 'vip.qq.com') return '18';
  return '';
}

function extractSetCookies(response) {
  if (!response?.headers) return [];
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get?.('set-cookie');
  return single ? [single] : [];
}

function parseSetCookiePairs(rawList, jar) {
  for (const line of Array.isArray(rawList) ? rawList : []) {
    const first = String(line || '').split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const val = sanitizeToken(first.slice(eq + 1).trim());
    if (name && val) jar.set(name, val);
  }
}

export class WebCgiClient {
  #getUin;
  #getTipOff;
  #getTicketService;
  #fetchImpl;
  #cookies = new Map();
  #pskeyCache = new Map();
  #groupListCache = null;

  constructor({ getUin, getTipOff, getTicketService, fetchImpl = globalThis.fetch } = {}) {
    this.#getUin = getUin;
    this.#getTipOff = getTipOff;
    this.#getTicketService = getTicketService;
    this.#fetchImpl = fetchImpl;
  }

  clear() {
    this.#cookies.clear();
    this.#pskeyCache.clear();
    this.#groupListCache = null;
  }

  hasAuthProvider() {
    return Boolean(
      typeof this.#getTipOff?.()?.getPskey === 'function'
      || typeof this.#getTicketService?.()?.forceFetchClientKey === 'function'
    );
  }

  async readiness() {
    const tipOff = typeof this.#getTipOff?.()?.getPskey === 'function';
    const ticket = typeof this.#getTicketService?.()?.forceFetchClientKey === 'function';
    const cachedDomains = [...this.#cookies.entries()]
      .filter(([, v]) => v.expiresAt > Date.now())
      .map(([d]) => d);
    return {
      tipOffPskey: tipOff,
      ticketClientKey: ticket,
      cachedDomainsCount: cachedDomains.length,
    };
  }

  async #fetchPskeyDirect(domain, timeoutMs = 6000) {
    const now = Date.now();
    const cached = this.#pskeyCache.get(domain);
    if (cached && cached.expiresAt > now) {
      cached.expiresAt = now + PSKEY_CACHE_TTL_MS;
      return cached.value;
    }
    const tipOff = this.#getTipOff?.();
    if (typeof tipOff?.getPskey !== 'function') return '';
    try {
      const resp = await Promise.race([
        Promise.resolve(tipOff.getPskey([domain], true)),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('pskey_timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const map = resp?.domainPskeyMap;
      const raw = map instanceof Map ? map.get(domain) : (map && typeof map === 'object' ? map[domain] : '');
      const clean = sanitizeToken(raw);
      if (clean && clean.length >= 8) {
        this.#pskeyCache.set(domain, { value: clean, expiresAt: Date.now() + PSKEY_CACHE_TTL_MS });
        return clean;
      }
    } catch { /* Fall back to clientKey jump flow cleanly */ }
    return '';
  }

  async #fetchJumpCookies(domain, timeoutMs = 15000) {
    const ticketService = this.#getTicketService?.();
    if (typeof ticketService?.forceFetchClientKey !== 'function' || typeof this.#fetchImpl !== 'function') {
      return null;
    }
    const botUin = String(this.#getUin?.() || '').trim();
    if (!/^[1-9]\d{4,15}$/.test(botUin)) return null;

    let ticket;
    try {
      ticket = await Promise.race([
        Promise.resolve(ticketService.forceFetchClientKey('')),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('ticket_timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      return null;
    }
    const clientKey = sanitizeToken(ticket?.clientKey);
    if (!clientKey) return null;

    const daid = daidForDomain(domain);
    const keyIndex = ticket?.keyIndex ?? 19;
    const u1 = targetUrlForDomain(domain, botUin);
    const jumpUrl = 'https://ssl.ptlogin2.qq.com/jump?ptlang=2052'
      + `&clientuin=${encodeURIComponent(botUin)}`
      + `&clientkey=${encodeURIComponent(clientKey)}`
      + `&u1=${encodeURIComponent(u1)}`
      + `&keyindex=${encodeURIComponent(String(keyIndex))}`
      + (daid ? `&daid=${encodeURIComponent(daid)}` : '');

    const jar = new Map();
    jar.set('uin', `o${botUin}`);
    jar.set('p_uin', `o${botUin}`);

    const r1 = await this.#fetchImpl(jumpUrl, {
      redirect: 'manual',
      headers: { 'user-agent': DEFAULT_UA },
      signal: AbortSignal.timeout(8000),
    });
    parseSetCookiePairs(extractSetCookies(r1), jar);
    const loc = r1.headers?.get?.('location') || '';
    if (loc) {
      let parsedLoc;
      try { parsedLoc = new URL(loc); } catch { parsedLoc = null; }
      if (!parsedLoc || parsedLoc.protocol !== 'https:' || !isValidQqDomain(parsedLoc.hostname)) {
        throw new BridgeError('CGI_UNTRUSTED_REDIRECT', 'Cookie exchange redirected outside qq.com', { retcode: 1500 });
      }
      const r2 = await this.#fetchImpl(loc, {
        redirect: 'manual',
        headers: { 'user-agent': DEFAULT_UA },
        signal: AbortSignal.timeout(8000),
      });
      parseSetCookiePairs(extractSetCookies(r2), jar);
    }

    const pSkey = jar.get('p_skey') || '';
    const skey = jar.get('skey') || '';
    if (!pSkey && !skey) return null;

    const cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    return {
      domain,
      cookies,
      p_skey: pSkey,
      skey,
      bkn: computeBkn(pSkey || skey),
      expiresAt: Date.now() + COOKIE_CACHE_TTL_MS,
    };
  }

  async getCookies(rawDomain = 'qun.qq.com', { noCache = false } = {}) {
    const domain = String(rawDomain || 'qun.qq.com').trim().toLowerCase();
    if (!isValidQqDomain(domain)) {
      throw new BridgeError('INVALID_PARAMS', 'domain must be a valid qq.com host', { retcode: 1400 });
    }
    const now = Date.now();
    if (!noCache) {
      const cached = this.#cookies.get(domain);
      if (cached && cached.expiresAt > now) {
        return { cookies: cached.cookies, bkn: cached.bkn, p_skey: cached.p_skey, skey: cached.skey, domain };
      }
    }

    const botUin = String(this.#getUin?.() || '').trim();
    const jump = await this.#fetchJumpCookies(domain).catch(() => null);
    if (jump) {
      this.#cookies.set(domain, jump);
      return { cookies: jump.cookies, bkn: jump.bkn, p_skey: jump.p_skey, skey: jump.skey, domain };
    }

    const pskey = await this.#fetchPskeyDirect(domain);
    if (pskey && /^[1-9]\d{4,15}$/.test(botUin)) {
      const entry = {
        domain,
        cookies: `uin=o${botUin}; p_uin=o${botUin}; p_skey=${pskey}`,
        p_skey: pskey,
        skey: '',
        bkn: computeBkn(pskey),
        expiresAt: Date.now() + PSKEY_CACHE_TTL_MS,
      };
      this.#cookies.set(domain, entry);
      return { cookies: entry.cookies, bkn: entry.bkn, p_skey: entry.p_skey, skey: '', domain };
    }

    throw new BridgeError('COOKIE_UNAVAILABLE', `Unable to acquire QQ web cookies for ${domain}`, { retcode: 1404 });
  }

  async #cgiRequest(domain, url, { method = 'GET', body, headers = {}, retryOnAuth = true } = {}) {
    if (typeof this.#fetchImpl !== 'function') {
      throw new BridgeError('UNSUPPORTED', 'HTTP fetch is not available', { retcode: 1404 });
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !isValidQqDomain(parsed.hostname)) {
      throw new BridgeError('INVALID_PARAMS', 'Target URL must be HTTPS on qq.com', { retcode: 1400 });
    }

    for (let attempt = 0; attempt < (retryOnAuth ? 2 : 1); attempt += 1) {
      const auth = await this.getCookies(domain, { noCache: attempt > 0 });
      const finalUrl = url.replaceAll('__BKN__', String(auth.bkn));
      const finalBody = typeof body === 'string' ? body.replaceAll('__BKN__', String(auth.bkn)) : body;
      const resp = await this.#fetchImpl(finalUrl, {
        method,
        headers: {
          'user-agent': DEFAULT_UA,
          cookie: auth.cookies,
          ...headers,
        },
        body: finalBody,
        signal: AbortSignal.timeout(10000),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* May be JSONP or HTML */ }
      const authFailed = resp.status === 401 || resp.status === 403
        || (json && (json.ec === 4 || json.code === -3000 || json.retcode === -3000));
      if (authFailed && attempt === 0 && retryOnAuth) {
        this.#cookies.delete(domain);
        this.#pskeyCache.delete(domain);
        continue;
      }
      return { status: resp.status, text, json, auth };
    }
    throw new BridgeError('CGI_FAILED', 'QQ Web CGI request failed after auth refresh', { retcode: 1500 });
  }

  async getGroupList({ noCache = false } = {}) {
    if (!noCache && this.#groupListCache && this.#groupListCache.expiresAt > Date.now()) {
      return structuredClone(this.#groupListCache.data);
    }
    const { json } = await this.#cgiRequest('qun.qq.com', 'https://qun.qq.com/cgi-bin/qun_mgr/get_group_list', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://qun.qq.com/member.html',
        origin: 'https://qun.qq.com',
      },
      body: 'bkn=__BKN__',
    });
    if (!json || json.ec !== 0) {
      throw new BridgeError('CGI_FAILED', `qun_mgr/get_group_list returned ec=${json?.ec ?? 'null'}`, { retcode: 1500 });
    }
    const buckets = [
      ...(Array.isArray(json.create) ? json.create : []),
      ...(Array.isArray(json.manage) ? json.manage : []),
      ...(Array.isArray(json.join) ? json.join : []),
    ];
    const seen = new Set();
    const groups = [];
    for (const item of buckets) {
      const gc = item?.gc;
      if (gc === undefined || gc === null || !/^[1-9]\d{0,15}$/.test(String(gc))) continue;
      const key = String(gc);
      if (seen.has(key)) continue;
      seen.add(key);
      const count = Number.isSafeInteger(Number(item.cnt)) ? Number(item.cnt) : 0;
      const maxCount = Number.isSafeInteger(Number(item.max)) ? Math.max(count, Number(item.max)) : Math.max(count, 200);
      groups.push({
        group_id: Number(key),
        group_name: typeof item.gn === 'string' ? item.gn : '',
        member_count: count,
        max_member_count: maxCount,
      });
    }
    this.#groupListCache = { data: groups, expiresAt: Date.now() + GROUP_LIST_CACHE_TTL_MS };
    return structuredClone(groups);
  }

  async getEssenceMsgList(groupId) {
    const gid = String(groupId);
    const { json } = await this.#cgiRequest(
      'qun.qq.com',
      `https://qun.qq.com/cgi-bin/group_share_msg/get_essence_msg_list?gc=${gid}&bkn=__BKN__`,
      { headers: { referer: 'https://qun.qq.com/' } },
    );
    if (!json || (json.ec !== 0 && json.retcode !== 0)) {
      throw new BridgeError('CGI_FAILED', `get_essence_msg_list failed ec=${json?.ec ?? json?.retcode ?? 'null'}`, { retcode: 1500 });
    }
    const list = Array.isArray(json.msg_list) ? json.msg_list : Array.isArray(json.data?.msg_list) ? json.data.msg_list : [];
    return list.map((m) => ({
      sender_id: Number(m?.sender_uin || 0),
      sender_nick: String(m?.sender_nick || ''),
      sender_time: Number(m?.sender_time || 0),
      operator_id: Number(m?.add_digest_uin || m?.operator_uin || 0),
      operator_nick: String(m?.add_digest_nick || ''),
      operator_time: Number(m?.add_digest_time || 0),
      message_seq: Number(m?.msg_seq || 0),
      message_id: Number(m?.msg_random || m?.msg_seq || 0),
      content: Array.isArray(m?.msg_content) ? m.msg_content : [],
    }));
  }

  async getGroupFileUrl(groupId, fileId, busId = 102) {
    const gid = String(groupId);
    const { json } = await this.#cgiRequest(
      'qun.qq.com',
      'https://qun.qq.com/cgi-bin/group_share_get_downurl',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://qun.qq.com/',
        },
        body: `gc=${encodeURIComponent(gid)}&file_id=${encodeURIComponent(fileId)}&bus_id=${encodeURIComponent(String(busId))}&bkn=__BKN__`,
      },
    );
    const url = json?.url || json?.data?.url || json?.download_url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new BridgeError('FILE_URL_UNAVAILABLE', `Failed to resolve group file URL (ec=${json?.ec ?? json?.retcode ?? 'null'})`, { retcode: 1500 });
    }
    return { url };
  }

  // ---------------- Qzone Web CGI ----------------

  async getQzoneMsgList({ user_id, pos = 0, num = 20 } = {}) {
    const targetUin = String(user_id || this.#getUin?.() || '');
    const start = Math.max(0, Number(pos) || 0);
    const count = Math.max(1, Math.min(40, Number(num) || 20));
    const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
      + `?uin=${encodeURIComponent(targetUin)}&pos=${start}&num=${count}&replynum=10&code_version=1&format=json&need_private_comment=1&g_tk=__BKN__`;
    const { json } = await this.#cgiRequest('user.qzone.qq.com', url, {
      headers: { referer: `https://user.qzone.qq.com/${targetUin}` },
    });
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('QZONE_FAILED', `Qzone msglist returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    const list = Array.isArray(json.msglist) ? json.msglist : [];
    return {
      total: Number(json.total ?? list.length),
      msglist: list.map((item) => ({
        tid: String(item?.tid || ''),
        uin: Number(item?.uin || targetUin),
        nickname: String(item?.name || ''),
        content: String(item?.content || ''),
        created_time: Number(item?.created_time || 0),
        comment_count: Number(item?.cmtnum || 0),
        pics: Array.isArray(item?.pic) ? item.pic.map((p) => String(p?.url2 || p?.url1 || '')).filter(Boolean) : [],
      })),
    };
  }

  async getQzoneFeeds({ count = 20, offset = 0 } = {}) {
    const botUin = String(this.#getUin?.() || '');
    const url = 'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more'
      + `?uin=${encodeURIComponent(botUin)}&scope=0&view=1&daylist=&uinlist=&gid=&flag=1&filter=all&applist=all&refresh=0&aisortEndTime=0&aisortOffset=0&getAisort=0&aisortBeginTime=0&pagenum=1&externparam=&firstGetGroup=0&icServerTime=0&mixnocache=0&scene=0&begintime=0&count=${Math.max(1, Math.min(50, Number(count) || 20))}&dayspac=0&sidomain=qzonestyle.gtimg.cn&useutf8=1&outputhtmlfeed=1&rd=${Math.random()}&g_tk=__BKN__`;
    const { text, json } = await this.#cgiRequest('user.qzone.qq.com', url, {
      headers: { referer: `https://user.qzone.qq.com/${botUin}` },
    });
    if (json && json.code && json.code !== 0) {
      throw new BridgeError('QZONE_FAILED', `Qzone feeds returned code=${json.code}`, { retcode: 1500 });
    }
    // Parse standard JSONP _Callback(...) response if present, else fallback to emotion_cgi_msglist_v6 of self
    if (json && Array.isArray(json?.data?.data)) {
      return { feeds: json.data.data.slice(offset, offset + count) };
    }
    const stripped = text.trim();
    if (stripped.startsWith('_Callback(')) {
      const inner = stripped.slice('_Callback('.length, stripped.endsWith(');') ? -2 : -1);
      try {
        const parsed = Function(`"use strict"; return (${inner});`)();
        const items = Array.isArray(parsed?.data?.data) ? parsed.data.data : [];
        return {
          feeds: items.slice(0, count).map((f) => ({
            uin: Number(f?.uin || 0),
            nickname: String(f?.nickname || ''),
            tid: String(f?.key || ''),
            time: Number(f?.abstime || 0),
            summary: String(f?.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000),
          })),
        };
      } catch { /* fallback below */ }
    }
    const own = await this.getQzoneMsgList({ user_id: botUin, pos: offset, num: count });
    return { feeds: own.msglist };
  }

  async sendQzoneMsg({ content } = {}) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text || text.length > 5000) {
      throw new BridgeError('INVALID_PARAMS', 'Qzone content must be 1 to 5000 chars', { retcode: 1400 });
    }
    const botUin = String(this.#getUin?.() || '');
    const form = new URLSearchParams({
      syn_tweet_verson: '1',
      paramstr: '1',
      pic_template: '',
      richtype: '',
      richval: '',
      special_url: '',
      subrichtype: '',
      con: text,
      feedversion: '1',
      ver: '1',
      ugc_right: '1',
      to_sign: '0',
      hostuin: botUin,
      code_version: '1',
      format: 'json',
      qzreferrer: `https://user.qzone.qq.com/${botUin}`,
    });
    const { json } = await this.#cgiRequest(
      'user.qzone.qq.com',
      'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=__BKN__',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: `https://user.qzone.qq.com/${botUin}`,
        },
        body: form.toString(),
      },
    );
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('QZONE_FAILED', `Qzone publish returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    return { tid: String(json.tid || ''), now: Number(json.now || Math.floor(Date.now() / 1000)) };
  }

  async commentQzone({ user_id, tid, content } = {}) {
    const botUin = String(this.#getUin?.() || '');
    const targetUin = String(user_id || botUin);
    const comment = typeof content === 'string' ? content.trim() : '';
    if (!tid || !comment) throw new BridgeError('INVALID_PARAMS', 'tid and content are required', { retcode: 1400 });
    const form = new URLSearchParams({
      topicId: `${targetUin}_${tid}__1`,
      feedsType: '100',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      plat: 'qzone',
      source: 'ic',
      hostUin: targetUin,
      isSignIn: '',
      platformid: '52',
      uin: botUin,
      format: 'json',
      ref: 'feeds',
      content: comment,
      richval: '',
      richtype: '',
      private: '0',
      paramstr: '',
      qzreferrer: `https://user.qzone.qq.com/${botUin}`,
    });
    const { json } = await this.#cgiRequest(
      'user.qzone.qq.com',
      'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_v6?g_tk=__BKN__',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: `https://user.qzone.qq.com/${botUin}`,
        },
        body: form.toString(),
      },
    );
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('QZONE_FAILED', `Qzone comment returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    return { comment_id: String(json?.data?.id || '') };
  }

  async likeQzone({ user_id, tid, unikekey } = {}) {
    const botUin = String(this.#getUin?.() || '');
    const targetUin = String(user_id || botUin);
    const key = unikekey || `http://user.qzone.qq.com/${targetUin}/mood/${tid}`;
    const form = new URLSearchParams({
      qzreferrer: `https://user.qzone.qq.com/${botUin}`,
      opuin: botUin,
      unikey: key,
      curkey: key,
      from: '1',
      appid: '311',
      typeid: '0',
      abstime: String(Math.floor(Date.now() / 1000)),
      fid: String(tid),
      active: '0',
      fupdate: '1',
    });
    const { json, status } = await this.#cgiRequest(
      'user.qzone.qq.com',
      'https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=__BKN__',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: `https://user.qzone.qq.com/${botUin}`,
        },
        body: form.toString(),
      },
    );
    if (json && json.ret !== undefined && json.ret !== 0 && json.code !== 0) {
      throw new BridgeError('QZONE_FAILED', `Qzone like returned ret=${json.ret}`, { retcode: 1500 });
    }
    if (!json && status >= 400) {
      throw new BridgeError('QZONE_FAILED', `Qzone like failed HTTP ${status}`, { retcode: 1500 });
    }
    return { ok: true };
  }

  // ---------------- Group Album Web CGI ----------------

  async getGroupAlbumList({ group_id } = {}) {
    const gid = String(group_id);
    const botUin = String(this.#getUin?.() || '');
    const url = 'https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_list_album_v2'
      + `?g_tk=__BKN__&uin=${encodeURIComponent(botUin)}&qunId=${encodeURIComponent(gid)}&inCharset=utf-8&outCharset=utf-8&format=json`;
    const { json } = await this.#cgiRequest('h5.qzone.qq.com', url, {
      headers: { referer: 'https://h5.qzone.qq.com/' },
    });
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('GROUP_ALBUM_FAILED', `qun_list_album_v2 returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    const albums = Array.isArray(json?.data?.album) ? json.data.album : [];
    return {
      albums: albums.map((a) => ({
        album_id: String(a?.id || ''),
        name: String(a?.title || ''),
        desc: String(a?.desc || ''),
        total: Number(a?.photocnt || 0),
        create_time: Number(a?.createtime || 0),
      })),
    };
  }

  async getGroupAlbumMediaList({ group_id, album_id, attach_info = '' } = {}) {
    const gid = String(group_id);
    const botUin = String(this.#getUin?.() || '');
    const url = 'https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_list_photo_v2'
      + `?g_tk=__BKN__&uin=${encodeURIComponent(botUin)}&qunId=${encodeURIComponent(gid)}&albumId=${encodeURIComponent(String(album_id))}&attachInfo=${encodeURIComponent(String(attach_info))}&inCharset=utf-8&outCharset=utf-8&format=json`;
    const { json } = await this.#cgiRequest('h5.qzone.qq.com', url, {
      headers: { referer: 'https://h5.qzone.qq.com/' },
    });
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('GROUP_ALBUM_FAILED', `qun_list_photo_v2 returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    const photos = Array.isArray(json?.data?.photo) ? json.data.photo : [];
    return {
      attach_info: String(json?.data?.attachInfo || ''),
      has_more: json?.data?.hasMore === true || json?.data?.hasMore === 1,
      media_list: photos.map((p) => ({
        lloc: String(p?.lloc || ''),
        url: String(p?.url || ''),
        desc: String(p?.desc || ''),
        uploader_uin: Number(p?.uploader || 0),
        upload_time: Number(p?.uploadtime || 0),
        like_count: Number(p?.likeTotal || 0),
      })),
    };
  }

  async setGroupAlbumMediaLike({ group_id, album_id, lloc, is_like = true } = {}) {
    const gid = String(group_id);
    const botUin = String(this.#getUin?.() || '');
    const form = new URLSearchParams({
      g_tk: '__BKN__',
      uin: botUin,
      qunId: gid,
      albumId: String(album_id),
      lloc: String(lloc),
      op: is_like ? '1' : '0',
      format: 'json',
    });
    const { json } = await this.#cgiRequest(
      'h5.qzone.qq.com',
      'https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_like_v2?g_tk=__BKN__',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://h5.qzone.qq.com/',
        },
        body: form.toString(),
      },
    );
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('GROUP_ALBUM_FAILED', `qun_like_v2 returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    return { ok: true };
  }

  async doGroupAlbumComment({ group_id, album_id, lloc, content } = {}) {
    const gid = String(group_id);
    const botUin = String(this.#getUin?.() || '');
    const form = new URLSearchParams({
      g_tk: '__BKN__',
      uin: botUin,
      qunId: gid,
      albumId: String(album_id),
      lloc: String(lloc),
      content: String(content),
      format: 'json',
    });
    const { json } = await this.#cgiRequest(
      'h5.qzone.qq.com',
      'https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_add_comment_v2?g_tk=__BKN__',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://h5.qzone.qq.com/',
        },
        body: form.toString(),
      },
    );
    if (!json || (json.code !== 0 && json.subcode !== 0)) {
      throw new BridgeError('GROUP_ALBUM_FAILED', `qun_add_comment_v2 returned code=${json?.code ?? 'null'}`, { retcode: 1500 });
    }
    return { ok: true };
  }

  async uploadImageToQunAlbum({ group_id, album_id, file, desc = '' } = {}) {
    const gid = String(group_id);
    const botUin = String(this.#getUin?.() || '');
    let buffer;
    if (typeof file === 'string' && file.startsWith('base64://')) {
      buffer = Buffer.from(file.slice('base64://'.length), 'base64');
    } else if (typeof file === 'string' && path.isAbsolute(file)) {
      const st = await fs.stat(file);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_UPLOAD_IMAGE_BYTES) {
        throw new BridgeError('INVALID_PARAMS', 'Local image file is missing or exceeds 15 MiB', { retcode: 1400 });
      }
      buffer = await fs.readFile(file);
    } else {
      throw new BridgeError('INVALID_PARAMS', 'upload_image_to_qun_album expects an absolute local path or base64:// image', { retcode: 1400 });
    }
    if (!buffer.length || buffer.length > MAX_UPLOAD_IMAGE_BYTES) {
      throw new BridgeError('INVALID_PARAMS', 'Image payload is empty or exceeds 15 MiB', { retcode: 1400 });
    }

    const form = new URLSearchParams({
      qunid: gid,
      albumid: String(album_id),
      uin: botUin,
      picdesc: String(desc || '').slice(0, 500),
      filename: 'upload.jpg',
      output_type: 'json',
      json: '1',
      base64: '1',
      picfile: buffer.toString('base64'),
    });
    const { json } = await this.#cgiRequest(
      'h5.qzone.qq.com',
      'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=__BKN__',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: 'https://h5.qzone.qq.com/',
        },
        body: form.toString(),
      },
    );
    if (!json || (json.ret !== undefined && json.ret !== 0 && json.code !== 0)) {
      throw new BridgeError('GROUP_ALBUM_FAILED', `cgi_upload_image returned ret=${json?.ret ?? json?.code ?? 'null'}`, { retcode: 1500 });
    }
    return {
      lloc: String(json?.data?.lloc || json?.lloc || ''),
      url: String(json?.data?.url || json?.url || ''),
    };
  }
}
