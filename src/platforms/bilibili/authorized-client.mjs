import {setTimeout as sleep} from 'node:timers/promises';
import {BiliClient} from './client.mjs';
import {createPassportChallenge, PASSPORT_POLL_MS} from './passport.mjs';

const cookiePair = /^SESSDATA=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+; bili_jct=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
function validateSaved(cookie) {
  if (typeof cookie !== 'string' || cookie.length > 3072 || /[^\x20-\x7e]/.test(cookie) || !cookiePair.test(cookie)) throw Error('authorization_failed');
  return cookie;
}
function minimumCookie(header) {
  const parts = header.split('; ');
  return validateSaved(['SESSDATA=', 'bili_jct='].map(k => parts.find(p => p.startsWith(k))).join('; '));
}

// The service bridge validates identity as its first startup action. Hand it the result
// of this SAME client's freshly completed nav once; subsequent calls remain live.
class StartupClient extends BiliClient {
  #initial;
  async verify() { this.#initial = await super.identity(); }
  async identity() {
    if (!this.#initial) return super.identity();
    const info = this.#initial; this.#initial = undefined; return info;
  }
}
async function checked(options, cookie, fetchImpl, owned) {
  const {selfId,peerId,deviceId,signal}=options;
  if (signal?.aborted) throw Error('cancelled');
  const Client = owned ? StartupClient : BiliClient;
  const client = new Client({selfId,peerId,deviceId,cookie,fetchImpl:(url,init)=>
    fetchImpl(url,signal ? {...init,signal:AbortSignal.any([signal,init.signal])} : init)});
  if (owned) await client.verify(); else await client.identity();
  if (signal?.aborted) throw Error('cancelled');
  return client;
}

// Existing public QR-only API. It never accepts a saved credential or exports one.
export function authorizeBiliClient(options,deps) { return interactive(options,deps,false); }

// Call only inside the owned host. Saved data originates in the authenticated app's
// private inherited pipe, never in OneBot / HTTP, argv, process environment or a file.
export async function openOwnedBiliClient(options, deps={}) {
  if (options.savedCookie !== undefined) {
    try { return await checked(options,validateSaved(options.savedCookie),deps.fetchImpl??globalThis.fetch,true); }
    catch (e) {
      if (options.signal?.aborted) throw Error('Bilibili authorization cancelled');
      // Only positive evidence of logout/UID mismatch invalidates a saved session.
      throw Error(['BILI_API_-101','BILI_IDENTITY_MISMATCH'].includes(e?.code) ? 'reauth_required' : 'authorization_failed');
    }
  }
  if (options.interactive !== true) throw Error('reauth_required');
  return interactive(options,deps,true);
}
async function interactive(options,{fetchImpl = globalThis.fetch, now = Date.now, wait = sleep} = {},owned) {
  const {onQr,signal}=options;
  if (typeof onQr !== 'function' || signal?.aborted) throw Error('Bilibili authorization unavailable');
  let verified, minimum;
  const challenge = createPassportChallenge({fetchImpl,now,async onApproved(cookie) {
    if (owned) minimum=minimumCookie(cookie);
    verified = await checked(options,owned ? minimum : cookie,fetchImpl,owned);
  }});
  const cancel=()=>challenge.cancel();
  signal?.addEventListener('abort',cancel,{once:true});
  let end='failed';
  try {
    const {qrUrl,expiresAt}=await challenge.start();
    if (!signal?.aborted) await onQr({url:qrUrl,expiresAt});
    while (!signal?.aborted) {
      await wait(PASSPORT_POLL_MS,undefined,{signal});
      const {status}=await challenge.poll();
      if (status==='approved' && verified && !signal?.aborted) {
        if (owned) await options.onPersist(minimum);
        if (!signal?.aborted) return verified;
        break;
      }
      if (status!=='waiting' && status!=='scanned') { end=status; break; }
    }
  } catch { /* Never forward errors, response text, or URLs across the host boundary. */ }
  finally { minimum=undefined; signal?.removeEventListener('abort',cancel); cancel(); }
  throw Error(`Bilibili authorization ${signal?.aborted?'cancelled':end}`);
}
