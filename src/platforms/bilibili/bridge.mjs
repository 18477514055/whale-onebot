import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { escapeCQ, normalizeMessage } from '../../segments.mjs';

const decimal = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) :
  typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value) ? value : null;
const uid = value => decimal(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const failure = (retcode, wording) => ({ status: 'failed', retcode, data: null, wording });
const ok = data => ({ status: 'ok', retcode: 0, data });
const invalidPage = () => Object.assign(new Error('Invalid history page'), { fatal: true });
const manualSources = new Set(['0', '1', '2', '3', '4', '7']);
const MAX_PAGES = 100, MAX_IDS = 100_000;

// Exclusive decimal cursor. Reject lossy numbers and unordered/non-advancing pages;
// a malformed sequence cannot safely serve as the next high-water mark.
function pageInfo(rows, end) {
  if (!Array.isArray(rows) || rows.length > 100) throw invalidPage();
  let previous = end;
  const seqs = rows.map(row => {
    const seq = decimal(row?.msg_seqno);
    if (!seq || (previous !== undefined && BigInt(seq) >= BigInt(previous))) throw invalidPage();
    previous = seq;
    return seq;
  });
  // Client may filter the raw page; its bounds can still span unseen sequences.
  const high = rows.highSeqno === undefined ? seqs[0] : decimal(rows.highSeqno);
  const next = rows.nextCursor === undefined ? seqs.at(-1) : rows.nextCursor === null ? null : decimal(rows.nextCursor);
  if ((rows.highSeqno != null && !high) || (rows.nextCursor != null && !next) ||
      (seqs.length && (!high || BigInt(high) < BigInt(seqs[0]))) ||
      (end && high && BigInt(high) >= BigInt(end)) ||
      (next && (!high || BigInt(next) > BigInt(seqs.at(-1) ?? high)))) throw invalidPage();
  return { seqs, high, next };
}

function inbound(row, self, peer) {
  if (uid(row.sender_uid) !== peer || uid(row.receiver_id) !== self ||
      ![1, '1'].includes(row.receiver_type) || ![1, '1'].includes(row.msg_type) ||
      (row.msg_status !== undefined && ![0, '0'].includes(row.msg_status)) ||
      (row.msg_source !== undefined && (!['number', 'string'].includes(typeof row.msg_source) || !manualSources.has(String(row.msg_source))))) return null;
  const key = decimal(row.msg_key), time = uid(row.timestamp);
  if (!key || !time) return null;
  let text;
  try { text = (typeof row.content === 'string' ? JSON.parse(row.content) : row.content)?.content; } catch { return null; }
  if (typeof text !== 'string' || !text.trim()) return null;
  return { key, event: { time, platform: 'bilibili', self_id: self, post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: peer, sender: { user_id: peer, nickname: String(peer) }, font: 0,
    message: [{ type: 'text', data: { text } }], raw_message: escapeCQ(text) } };
}

function sendBody(params) {
  const escape = params.auto_escape ?? false;
  if (![true, false, 'true', 'false'].includes(escape)) return null;
  if (typeof params.message !== 'string') {
    const list = Array.isArray(params.message) ? params.message : [params.message];
    if (list.some(segment => segment?.type !== 'text' || typeof segment.data?.text !== 'string')) return null;
  }
  let segments;
  try { segments = normalizeMessage(params.message, escape === true || escape === 'true'); } catch { return null; }
  if (!segments.length || segments.some(({ type }) => type !== 'text')) return null;
  const text = segments.map(({ data }) => data.text).join('');
  return text.length <= 1000 && text.trim() && [...text].length <= 500 ? text : null;
}

/** Single authorized private conversation. Never replays startup history or queues writes. */
export class BiliBridge extends EventEmitter {
  #client; #self; #peer; #allow; #pollMs; #timer; #poll; #send; #lastAttempt = -Infinity;
  #state = 'new'; #reason = null; #identity; #watermark = 0n;
  // Stable signed-int32 handles within this instance, including collision resolution.
  // No contents are retained and capacity exhaustion halts rather than aliasing IDs.
  #keys = new Map(); #ids = new Map();

  #account; #accountWrite; #lastAccountWrite = -Infinity; #cleanup = new Set();

  constructor({ client, selfId, peerId, allowSend = false, pollMs = 5000, accountFactory } = {}) {
    super();
    this.#self = uid(selfId); this.#peer = uid(peerId);
    if (!this.#self || (!this.#peer && (peerId != null || !accountFactory || allowSend)) || this.#self === this.#peer || typeof allowSend !== 'boolean' ||
        !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 2_147_483_647 ||
        !['identity', 'messages', 'sendText'].every(k => typeof client?.[k] === 'function'))
      throw new TypeError('Invalid Bilibili bridge configuration');
    this.#client = client; this.#allow = allowSend; this.#pollMs = pollMs;
    this.#account = accountFactory?.({emit:e=>{if(this.#state==='running') this.emit('event',{...e, self_id:this.#self, platform:'bilibili'});},
      onClose:fn=>{this.#cleanup.add(fn);return ()=>this.#cleanup.delete(fn);}});
    this.dispatch = this.dispatch.bind(this); this.status = this.status.bind(this);
  }

  status() {
    const online = this.#state === 'running';
    return { online, good: online && !this.#reason, platform: 'bilibili', state: this.#state,
      read_only: !(this.#allow || this.#account?.allowWrites) || !online || !!this.#reason, reason: this.#reason,
      ...(this.#account ? {account_write_ready:!!this.#account.allowWrites && online && !this.#reason, dm_write_ready:this.#allow && online && !this.#reason} : {}) };
  }

  #closingResources;
  #releaseResources() {
    return this.#closingResources ??= Promise.allSettled([...this.#cleanup].map(fn=>Promise.resolve().then(fn))).finally(()=>this.#cleanup.clear());
  }

  #halt(reason) {
    if (this.#state === 'closed') return;
    this.#state = 'halted'; this.#reason = reason; clearTimeout(this.#timer); void this.#releaseResources();
  }

  async start() {
    if (this.#state !== 'new') throw new Error('Bridge already started or closed');
    this.#state = 'starting';
    let fallback = 'BILI_IDENTITY_UNAVAILABLE';
    try {
      const info = await this.#client.identity();
      if (this.#state !== 'starting') throw new Error();
      if (uid(info?.user_id) !== this.#self) throw Object.assign(new Error(), { code: 'BILI_IDENTITY_MISMATCH' });
      fallback = 'BILI_HISTORY_BASELINE';
      this.#identity = { platform: 'bilibili', user_id: this.#self, nickname: typeof info.nickname === 'string' ? info.nickname : String(this.#self) };
      const history = this.#peer ? pageInfo(await this.#client.messages()) : {high:null};
      if (this.#state !== 'starting') throw new Error();
      this.#watermark = BigInt(history.high ?? 0); this.#state = 'running'; this.#schedule();
      return this;
    } catch (error) {
      const code = typeof error?.code === 'string' && /^BILI_(?:CLIENT_ERROR|IDENTITY_MISMATCH|API_-?\d{1,9}|HTTP_[1-5]\d\d)$/.test(error.code) ? error.code : fallback;
      this.#halt(code); throw Object.assign(new Error('Bilibili identity or history baseline unavailable'), {code});
    }
  }

  #schedule() {
    if (this.#state !== 'running' || !this.#peer) return;
    this.#timer = setTimeout(async () => { await this.pollOnce(); this.#schedule(); }, this.#pollMs);
    this.#timer.unref();
  }

  #messageId(key) {
    if (this.#keys.has(key)) return this.#keys.get(key);
    if (this.#keys.size >= MAX_IDS) throw invalidPage();
    let id = (createHash('sha256').update(key).digest().readUInt32BE() & 0x7fffffff) || 1;
    while (this.#ids.has(id)) id = id === 0x7fffffff ? 1 : id + 1;
    this.#ids.set(id, key); this.#keys.set(key, id); return id;
  }

  pollOnce() {
    if (this.#state !== 'running') return Promise.resolve();
    if (!this.#poll) this.#poll = this.#readNew().catch(error => {
      if (this.#state !== 'running') return;
      if (error?.fatal) this.#halt('read_halted'); else this.#reason = 'read_unavailable';
    }).finally(() => { this.#poll = undefined; });
    return this.#poll;
  }

  async #readNew() {
    let end, high = this.#watermark;
    const pending = [];
    for (let page = 0;; page++) {
      if (page >= MAX_PAGES) throw invalidPage();
      const rows = await this.#client.messages(end);
      if (this.#state !== 'running') return;
      const { seqs, high: pageHigh, next } = pageInfo(rows, end);
      if (!end && pageHigh && BigInt(pageHigh) > high) high = BigInt(pageHigh);
      for (let i = 0; i < rows.length && BigInt(seqs[i]) > this.#watermark; i++) {
        const message = inbound(rows[i], this.#self, this.#peer);
        if (message) pending.push(message);
      }
      end = next;
      if (!end || BigInt(end) <= this.#watermark + 1n) break;
    }
    // No partial publication on a failed fetch. Commit before notifying listeners;
    // a throwing listener must never trigger a replay of already delivered events.
    this.#watermark = high; this.#reason = null;
    for (const { key, event } of pending.reverse()) {
      if (this.#state !== 'running') break;
      if (this.#keys.has(key)) continue;
      event.message_id = this.#messageId(key);
      try { this.emit('event', event); } catch { this.#halt('event_delivery_failed'); break; }
    }
  }

  async dispatch(request) {
    const response = await this.#action(request);
    return request && Object.hasOwn(request, 'echo') ? { ...response, echo: request.echo } : response;
  }

  async #action(request) {
    const action = request?.action, params = request?.params === undefined ? {} : request.params;
    if (typeof action !== 'string' || !params || typeof params !== 'object' || Array.isArray(params))
      return failure(1400, 'Invalid action request');
    if (action === 'get_supported_actions') return ok(['get_login_info', 'get_status', 'get_version_info', 'get_supported_actions',
      ...(this.#allow && this.status().good ? ['send_msg', 'send_private_msg'] : []), ...(this.#account && this.status().good ? ['bili_action_catalog',...this.#account.names()] : [])]);
    if (this.#account && action === 'bili_action_catalog') return ok(this.status().good ? this.#account.names().map(name=>({name,write:this.#account.get(name).write,...(this.#account.get(name).params && {params:this.#account.get(name).params})})) : []);
    if (this.#account && action.startsWith('bili_')) {
      const spec=this.#account.get(action);
      if (!spec) return failure(1404,'Unavailable account action');
      if (!this.status().good) return failure(1503,'Account unavailable');
      if (spec.write && !this.#account.allowWrites) return failure(1403,'Account writes disabled');
      if (spec.write && (this.#accountWrite || performance.now()-this.#lastAccountWrite<5000)) return failure(1429,'Account write busy or rate limited');
      if (spec.write) this.#lastAccountWrite=performance.now();
      const operation=Promise.resolve().then(()=>this.#account.run(spec,params));
      if (spec.write) this.#accountWrite=operation;
      try { return ok(await operation ?? null); }
      catch(e) {
        if(e?.fatal) this.#halt('account_halted');
        const code=typeof e?.code==='string' && /^BILI_(?:API_-?\d{1,9}|HTTP_\d{3}|IDENTITY_MISMATCH)$/.test(e.code) ? ` (${e.code})` : '';
        if(e?.outcome==='unknown') return failure(1504,'Outcome unknown; do not retry'+code);
        if(e?.code==='BILI_INVALID_PARAMS' || e instanceof TypeError || e instanceof RangeError) return failure(1400,'Invalid account action parameters');
        if(spec.write && e?.outcome!=='not_sent') return failure(1504,'Outcome unknown; do not retry'+code);
        return failure(1500,'Account action failed'+code);
      } finally { if(spec.write) this.#accountWrite=undefined; }
    }
    if (action === 'get_status') return ok(this.status());
    if (action === 'get_version_info') return ok({ app_name: 'bilibili-private-bridge', app_version: '1', protocol_version: 'v11' });
    if (action === 'get_login_info') return this.#state === 'running' ? ok({ ...this.#identity }) : failure(1503, 'Identity unavailable');
    if (!['send_msg', 'send_private_msg'].includes(action)) return failure(1404, 'Unsupported action');
    if (params.group_id !== undefined || (params.message_type !== undefined && params.message_type !== 'private') || uid(params.user_id) !== this.#peer)
      return failure(1403, 'Only the configured private recipient is permitted');
    if (!this.#allow) return failure(1403, 'Bridge is read-only');
    if (!this.status().good) return failure(1503, 'Bridge is unavailable');
    const text = sendBody(params);
    if (!text) return failure(1400, 'Expected 1–500 characters of plain text');
    if (this.#send || performance.now() - this.#lastAttempt < 5000) return failure(1429, 'Send busy or rate limited');
    if (this.#keys.size >= MAX_IDS) { this.#halt('id_capacity'); return failure(1503, 'Message ID capacity exhausted'); }
    this.#lastAttempt = performance.now();
    this.#send = this.#sendOnce(text);
    try { return await this.#send; } finally { this.#send = undefined; }
  }

  async #sendOnce(text) {
    try {
      const receipt = await this.#client.sendText(text);
      const key = decimal(receipt?.msg_key);
      if (!key) throw new Error();
      return ok({ message_id: this.#messageId(key) });
    } catch (error) {
      if (error?.outcome !== 'not_sent') {
        if (error?.fatal) this.#halt('send_halted');
        return failure(1504, 'Send outcome unknown; do not retry');
      }
      if (error.fatal) this.#halt('send_halted');
      return failure(1500, 'Send was not accepted');
    }
  }

  async close() {
    this.#state = 'closed'; clearTimeout(this.#timer);
    await this.#releaseResources();
    await Promise.allSettled([this.#poll, this.#send, this.#accountWrite]);
  }
}
