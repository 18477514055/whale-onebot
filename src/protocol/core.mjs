import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { BridgeError } from '../bridge/error.mjs';
// 对外报的版本号（唯一来源，改版本只改这里）
const APP_VERSION = '1.0.0';
const LOCAL_ACTIONS=['get_login_info','get_status','get_version_info','get_supported_actions','can_send_image','can_send_record'];
const READ_FAILURES = new Map([
  [1400, 'Invalid query parameters or response'],
  [1403, 'Query not permitted'],
  [1404, 'Requested data unavailable'],
  [1500, 'Native query rejected'],
  [1502, 'Native query did not complete'],
]);
// ★ P4（PRINCIPLES.md）：**发送类动作的成败由我们协议端负责，运行端的运行绝不能被发送状态锁死。**
//   原生 `sendMsg` 返回 result:0 就已经是「已接受」，QQ 的回执只是确认。拿不到确认时，我们回
//   「成功 + message_id:null」而不是「未知（1504）」——否则运行端会写 `outbox.state='unknown'`
//   → 该会话被 `held` → 后续消息一律不再发送（用户反复遇到的「静默」）。
//   报错信息仍然记账（`metrics.unknownOutcomes` / `lastUnknownAction`），运行端需要时查得到。
//   **非发送类写动作（踢人/改名等）不套用这条**：它们不进 outbox、不会产生 held，
//   对它们谎报成功才是真的危险。
//   只覆盖**真正会产生 outbox 行**的动作（消息/转发/戳一戳）；像 `send_like`、`set_group_kick`
//   这类不进 outbox 的写不套用——对它们谎报成功才是真的危险。
const ACCEPT_WITHOUT_RECEIPT = action => typeof action === 'string' &&
  (['send_msg', 'send_private_msg', 'send_group_msg', 'send_group_forward_msg',
    'send_private_forward_msg'].includes(action) || action.endsWith('_poke'));

export class OfflineBridge extends EventEmitter {
  capabilities() { return []; }
  async probe() { return {online:false}; }
  async call() { throw new Error('Bridge offline'); }
}
export class OneBotCore extends EventEmitter {
  #bridge; #profile; #readOnly; #statusFromBackground; #authorizationPolicy; #conversationPolicy; #sessionAuthorized = false; #onlineKnown = false; #uid;
  #epoch = 0; #session; #selfId; #online = false; #uncertain = false; #closed = false; #freezeOnUnknown = false;
  #controllers = new Set();
  #eventContexts = new WeakMap();
  #asyncJobs = new Set(); #asyncBytes = 0;
  #rateQueue = []; #rateJobs = new Set(); #rateBytes = 0; #rateTimer; #rateRunning = false; #lastRateEnd = -Infinity;
  #active = 0; #mutatingChats = new Set(); #lastWrite = -Infinity; #verifiedAt = -Infinity; #seen = new Map(); #onEvent; #onOffline;
  #refreshPending = 0;
  #probeSequence = 0;
  #acceptedProbe = 0;
  constructor({profile, bridge = new OfflineBridge(), timeoutMs = 10000, minimumWriteIntervalMs = 750, maxConcurrent = 16, proofMaxAgeMs = 30000, maxAsyncPending = 64, maxAsyncBytes = 8 * 1024 * 1024, rateLimitIntervalMs = 500, maxRatePending = 64, maxRateBytes = 8 * 1024 * 1024, maxRateWaitMs = 60000, clock = () => performance.now(), outcomeStore, statusFromBackground = false, readOnly = false, freezeOnUnknown = false, authorizationPolicy = 'online-proof', conversationPolicy = 'protected'} = {}) {
    super();
    if (!profile?.actions || typeof profile.validateParams !== 'function' || typeof profile.acceptIdentity !== 'function')
      throw new TypeError('A OneBot 11 adapter profile is required');
    this.#profile = profile;
    if (!['online-proof', 'native-session'].includes(authorizationPolicy)) throw new TypeError('Invalid authorization policy');
    this.#authorizationPolicy = authorizationPolicy;
    if (!['protected', 'original'].includes(conversationPolicy) ||
        (conversationPolicy === 'original' && authorizationPolicy !== 'native-session')) throw new TypeError('Invalid conversation policy');
    this.#conversationPolicy = conversationPolicy;
    if (typeof readOnly !== 'boolean') throw new TypeError('Invalid read-only mode');
    this.#readOnly = readOnly;
    this.#statusFromBackground = statusFromBackground;
    for (const n of [timeoutMs,maxConcurrent,proofMaxAgeMs]) if(!Number.isSafeInteger(n)||n<1) throw new TypeError('Invalid core limit');
    if(!Number.isSafeInteger(minimumWriteIntervalMs)||minimumWriteIntervalMs<0) throw new TypeError('Invalid write interval');
    if(!Number.isSafeInteger(maxAsyncPending)||maxAsyncPending<1||maxAsyncPending>1024||!Number.isSafeInteger(maxAsyncBytes)||maxAsyncBytes<1||maxAsyncBytes>32*1024*1024) throw new TypeError('Invalid async limit');
    this.maxAsyncPending=maxAsyncPending; this.maxAsyncBytes=maxAsyncBytes;
    if(!Number.isSafeInteger(rateLimitIntervalMs)||rateLimitIntervalMs<0||rateLimitIntervalMs>3600000||!Number.isSafeInteger(maxRatePending)||maxRatePending<1||maxRatePending>1024||!Number.isSafeInteger(maxRateBytes)||maxRateBytes<1||maxRateBytes>32*1024*1024||!Number.isSafeInteger(maxRateWaitMs)||maxRateWaitMs<1||maxRateWaitMs>3600000)throw new TypeError('Invalid rate queue limit');
    Object.assign(this,{rateLimitIntervalMs,maxRatePending,maxRateBytes,maxRateWaitMs});
    this.#bridge = bridge; this.timeoutMs = timeoutMs; this.minimumWriteIntervalMs = minimumWriteIntervalMs; this.maxConcurrent = maxConcurrent; this.clock = clock; this.proofMaxAgeMs = proofMaxAgeMs;
    this.outcomeStore=outcomeStore; this.#uncertain=outcomeStore?.pending===true;
    // ★ 是否在「上一次写结果未知」时冻结全部写入（fail-closed）。
    //   默认 **关**（用户 2026-11-19 口径：外发优先，真发不出才记账）。
    //   开 = 严格的「宁可不说也不重复说」，适合对幂等要求极高的管理动作。
    this.#freezeOnUnknown = freezeOnUnknown === true;
    this.metrics = {calls:0, blocked:0, failures:0, unknownOutcomes:0, lastUnknownAction:null, lastUnknownLatching:false, lastActionFailure:null, events:0, droppedEvents:0, asyncAccepted:0, asyncCompleted:0, asyncFailed:0, asyncCancelled:0,rateAccepted:0,rateCompleted:0,rateFailed:0,rateCancelled:0,rateExpired:0};
    this.#onEvent = event => this.#receive(event);
    this.#onOffline = () => this.invalidate();
    bridge.on('event',this.#onEvent); bridge.on('offline',this.#onOffline);
  }
  /**
   * （已删除）幽灵锁自愈 `#healPhantomLatch`。
   *
   * ★ 2026-11-19 · P3/P4：它原本是叠在崩溃安全之上的一层补偿（内存闩锁在、磁盘记录没了 ⇒ 永远发不出话）。
   *   现在：①默认模式下 `#uncertain` 不再关闭写闸；②重启遗留记录由 `OutcomeStore.adoptForeign` 隔离；
   *   ③陈旧记录由 `begin()` 的 `superseded` 隔离。三条覆盖了它原本的全部场景 ⇒ 删掉，不再留第二层。
   */

  status = () => {
    if (this.#authorizationPolicy === 'native-session') {
      // Session permission has an explicit lifecycle, not a human-message lease.
      // Online telemetry remains independent, and stale telemetry becomes unknown.
      const ready = this.#sessionAuthorized && !this.#closed;
      const msfDown = this.#bridge?.msfDisconnected === true;
      const known = ready && this.#onlineKnown && this.clock()-this.#verifiedAt<this.proofMaxAgeMs;
      const platformOnline = known && this.#online;
      // ★ `online` 在 native-session 模式下按 OneBot 惯例 = **机器人此刻能不能干活**
      //   （会话已授权、未关闭且原生 MSF 长连接未处于明确断链态）。
      //   当宿主通过 onMSFStatusChange(2) 标记 MSF 断开时，如实返回 online:false / platform_state:'msf_disconnected'，
      //   消除「MSF 已断链但 get_status 仍报全绿」的失明窗口。
      const online = ready && !msfDown;
      return { online, good: online, service_ready: ready, session_authorized: ready,
        // ★ 外发优先（用户 2026-11-19 口径）：未知结果只记账，不再关闭写闸。
        //   以前的 `!this.#uncertain` 让一次拿不到回执的发送把整个机器人静默到重启为止，
        //   代价（永久不说话）远大于重复一条。未知仍记录在 metrics 与 runtime/outcomes 里留证。
        write_ready: online && !this.#readOnly && (!this.#freezeOnUnknown || !this.#uncertain),
        online_known: ready, platform_state: msfDown ? 'msf_disconnected' : (!known ? 'unknown' : platformOnline ? 'online' : 'offline'),
        // Which action froze the write gate. Without it the only visible symptom is
        // write_ready:false, which does not say what to reconcile.
        lastUnknownAction: this.metrics.lastUnknownAction,
        lastUnknownLatching: this.metrics.lastUnknownLatching };
    }
    const online=this.#online && !this.#closed && this.clock()-this.#verifiedAt<this.proofMaxAgeMs;
    return {online,good:online && (!this.#freezeOnUnknown || !this.#uncertain)};
  };
  #blocksAction(action, params) {
    if (this.#conversationPolicy === 'original' && typeof this.#profile.blocksOriginalConversationAction === 'function')
      return this.#profile.blocksOriginalConversationAction(action, params);
    return this.#profile.blocksAction?.(action, params);
  }
  #serviceReady() { return this.#authorizationPolicy === 'native-session' ? this.status().service_ready : this.status().online; }
  #ingressReady() { return this.#authorizationPolicy === 'native-session' ? this.status().service_ready : this.status().good; }
  #cancelQueued(shouldCancel) {
    for (const job of this.#asyncJobs) {
      if (job.handle === null || !shouldCancel(job)) continue;
      clearImmediate(job.handle);
      this.#asyncJobs.delete(job);
      this.#asyncBytes -= job.bytes;
      this.metrics.asyncCancelled++;
    }
    clearTimeout(this.#rateTimer);
    this.#rateQueue = this.#rateQueue.filter(job => {
      if (!shouldCancel(job)) return true;
      this.#rateJobs.delete(job);
      this.#rateBytes -= job.bytes;
      this.metrics.rateCancelled++;
      return false;
    });
  }
  invalidate() { this.#epoch++; this.#online = false; this.#onlineKnown = false; this.#sessionAuthorized = false; this.#uid = undefined; this.#session = undefined; this.#selfId = undefined; this.#seen.clear(); for(const controller of this.#controllers)controller.abort(); this.#cancelQueued(() => true); }
  close() { this.#closed=true; this.invalidate(); this.#bridge.off('event',this.#onEvent); this.#bridge.off('offline',this.#onOffline); }
  // Explicit operator reconciliation for a latched unknown write. It verifies the
  // current native identity FIRST (so a dead session is never silently reopened),
  // then drops the unresolved record and clears the in-memory latch. It never
  // resends the uncertain action and is only reachable from the trusted host
  // control channel, never from a OneBot action.
  async reconcileUnknownOutcome({ reason = '' } = {}) {
    if (this.#closed) return { reconciled: false, reason: 'service_closed' };
    const controller = new AbortController();
    const identity = await this.refreshIdentity(controller.signal);
    if (!identity) return { reconciled: false, reason: 'identity_unavailable' };
    let cleared = null;
    try { cleared = this.outcomeStore?.discard(reason) ?? null; }
    catch (error) { return { reconciled: false, reason: 'discard_failed' }; }
    this.#uncertain = false;
    return { reconciled: true, cleared: cleared?.cleared === true,
      previousAction: cleared?.previous?.action ?? null,
      previousState: cleared?.previous?.state ?? null,
      previousTime: cleared?.previous?.time ?? null };
  }
  // Internal host refresh shares identity checks with requests, without
  // consuming a request slot or appearing in client action metrics.
  async refreshIdentity(signal) {
    if (this.#closed || signal.aborted || this.#refreshPending >= 2) return null;
    const epoch = this.#epoch;
    const sequence = ++this.#probeSequence;
    const deadline = new AbortController();
    const probeSignal = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(probeSignal.reason);
      probeSignal.addEventListener('abort', abort, { once: true });
    });
    this.#refreshPending++;
    // An adapter may ignore cancellation. Keep that work charged until it
    // settles so repeated refreshes cannot accumulate an unbounded backlog.
    const work = this.#verify(probeSignal, sequence, true).finally(() => { this.#refreshPending--; });
    try {
      return await Promise.race([work, interrupted]);
    } catch {
      if (!signal.aborted && epoch === this.#epoch && !this.#closed && sequence > this.#acceptedProbe)
        this.invalidate();
      return null;
    } finally {
      clearTimeout(timer);
      probeSignal.removeEventListener('abort', abort);
    }
  }
  #quickValid(guard) { return !this.#closed && guard.epoch===this.#epoch && this.clock()<guard.deadline && !guard.signal?.aborted; }
  // Only an actual event object emitted by this core can create a one-shot
  // handler. Context is captured before listeners can mutate the event copy.
  prepareQuickOperation = event => {
    const context=this.#eventContexts.get(event);
    if(!context)return null;
    this.#eventContexts.delete(event);
    let used=false;
    return (operation,{signal}={})=>{
      if(used)return {accepted:false,reason:'already_used',queued:0};used=true;
      const guard={epoch:context.epoch,deadline:context.deadline,signal};
      if(!this.#quickValid(guard))return {accepted:false,reason:'stale_event',queued:0};
      let jobs;
      try{jobs=this.#profile.quickOperations.plan(context.event,operation).map(job=>({...job,bytes:Buffer.byteLength(JSON.stringify(job.params))}));}
      catch{return {accepted:false,reason:'invalid_operations',queued:0};}
      if(!jobs.length)return {accepted:true,queued:0};
      if(this.#readOnly&&jobs.some(job=>this.#profile.actions[job.action]?.mutates))return {accepted:false,reason:'read_only',queued:0};
      if(this.#freezeOnUnknown&&this.#uncertain)return {accepted:false,reason:'unknown_previous_outcome',queued:0};
      const capabilities=this.#bridge.capabilities();
      if(jobs.some(job=>!Object.hasOwn(this.#profile.actions,job.action)||!capabilities.includes(job.action)))return {accepted:false,reason:'unsupported_operation',queued:0};
      if(jobs.some(job=>this.#blocksAction(job.action,job.params)))return {accepted:false,reason:'protected_target',queued:0};
      const total=jobs.reduce((sum,job)=>sum+job.bytes,0);
      if(this.#rateJobs.size+jobs.length>this.maxRatePending||this.#rateBytes+total>this.maxRateBytes)
        return {accepted:false,reason:'capacity',queued:0};
      // No await in preflight or insertion: a multi-operation response is either
      // wholly accepted or wholly rejected. Completion remains per operation.
      for(const item of jobs){
        const job={...item,epoch:this.#epoch,guard,deadline:Math.min(guard.deadline,this.clock()+this.maxRateWaitMs)};
        this.#rateQueue.push(job);this.#rateJobs.add(job);this.#rateBytes+=job.bytes;this.metrics.rateAccepted++;
      }
      this.#scheduleRate();
      return {accepted:true,queued:jobs.length};
    };
  };
  // 写动作的串行键：同一个会话（群 / 私聊）一把锁，跨会话互不影响。
  #writeKey(action, params) {
    if (params && typeof params === 'object') {
      if (params.group_id !== undefined && params.group_id !== null) return 'group:' + String(params.group_id);
      if (params.user_id !== undefined && params.user_id !== null && !Array.isArray(params.user_id)) return 'user:' + String(params.user_id);
      if (params.user_id !== undefined) return action;
    }
    return action;
  }
  #scheduleRate() {
    clearTimeout(this.#rateTimer);
    if(this.#closed||this.#rateRunning||!this.#rateQueue.length)return;
    const job=this.#rateQueue[0],now=this.clock();
    const busy=this.#active>=this.maxConcurrent||(this.#profile.actions[job.action].mutates&&this.#mutatingChats.has(this.#writeKey(job.action,job.params)));
    const due=Math.max(this.#lastRateEnd+this.rateLimitIntervalMs,this.#profile.actions[job.action].mutates?this.#lastWrite+this.minimumWriteIntervalMs:-Infinity);
    // Capacity release wakes this scheduler in dispatch.finally. When occupied,
    // only the absolute queue deadline needs a timer; there is no busy polling.
    const delay=Math.max(0,Math.min(job.deadline-now,busy?job.deadline-now:due-now));
    this.#rateTimer=setTimeout(()=>{void this.#runRate();},delay);
  }
  async #runRate() {
    if(this.#closed||this.#rateRunning)return;
    while(this.#rateQueue.length&&this.#rateQueue[0].deadline<=this.clock()){
      const expired=this.#rateQueue.shift();this.#rateJobs.delete(expired);this.#rateBytes-=expired.bytes;this.metrics.rateExpired++;
    }
    const job=this.#rateQueue[0];if(!job)return;
    const now=this.clock(),mutation=this.#profile.actions[job.action].mutates;
    if(this.#active>=this.maxConcurrent||(mutation&&this.#mutatingChats.has(this.#writeKey(job.action,job.params)))||now-this.#lastRateEnd<this.rateLimitIntervalMs||(mutation&&now-this.#lastWrite<this.minimumWriteIntervalMs)){this.#scheduleRate();return;}
    this.#rateQueue.shift();this.#rateRunning=true;
    try{
      if(job.epoch!==this.#epoch||this.#closed){this.metrics.rateCancelled++;return;}
      // This is a first dispatch after waiting for capacity, never a retry of an
      // already-submitted operation. Same proof, crash latch and guards apply.
      const response=await this.#dispatch({action:job.action,params:job.params},job.guard);
      if(response.retcode===0)this.metrics.rateCompleted++;else this.metrics.rateFailed++;
    }catch{this.metrics.rateFailed++;}
    // Preparation/confirmation time cannot consume the next operation's gap.
    finally{this.#lastRateEnd=this.clock();this.#rateJobs.delete(job);this.#rateBytes-=job.bytes;this.#rateRunning=false;this.#scheduleRate();}
  }
  // Only a trusted bridge observation can establish identity; no API can set it.
  async #verify(signal, sequence, background = false) {
    const epoch = this.#epoch;
    const proof = await this.#bridge.probe({signal});
    if (signal.aborted || epoch !== this.#epoch || this.#closed) throw new Error('Session changed');
    if (sequence < this.#acceptedProbe) {
      if (background) return null;
      throw new Error('Identity check superseded');
    }
    const nativeSession = this.#authorizationPolicy === 'native-session';
    const authorized = nativeSession
      ? proof?.authenticated === true && proof?.sessionAuthorized === true &&
        typeof proof.uid === 'string' && /^u_[A-Za-z0-9_-]{1,125}$/.test(proof.uid) &&
        (proof.online_known !== true || typeof proof.online === 'boolean')
      : proof?.online === true;
    if (!authorized || typeof proof.sessionId !== 'string' || !proof.sessionId) {
      this.invalidate(); throw new Error('Identity unavailable');
    }
    const identity = this.#profile.acceptIdentity(proof);
    const id = identity?.user_id;
    if (!(typeof id === 'string' && id.length > 0 && id.length <= 256) && !(Number.isSafeInteger(id) && id > 0)) {
      this.invalidate(); throw new Error('Identity unavailable');
    }
    const selfId = String(id);
    if (this.#session && (this.#session !== proof.sessionId || this.#selfId !== selfId ||
        (nativeSession && this.#uid !== proof.uid))) {
      this.invalidate(); throw new Error('Session changed');
    }
    this.#session = proof.sessionId; this.#selfId = selfId;
    this.#sessionAuthorized = nativeSession;
    this.#uid = nativeSession ? proof.uid : undefined;
    this.#onlineKnown = nativeSession ? proof.online_known === true : true;
    this.#online = nativeSession ? this.#onlineKnown && proof.online === true : true;
    this.#verifiedAt=this.clock();
    this.#acceptedProbe = Math.max(this.#acceptedProbe, sequence);
    this.#bridge.identityAccepted?.(proof);
    if (epoch !== this.#epoch || this.#closed) throw new Error('Session changed during event publication commit');
    return identity;
  }
  #receive(event) {
    if (!this.#ingressReady() || !event || String(event.self_id) !== this.#selfId || Object.hasOwn(event,'echo') || !['message','message_sent','notice','request'].includes(event.post_type)) { this.metrics.droppedEvents++; return; }
    const ingressEpoch=this.#epoch,deadline=this.clock()+this.proofMaxAgeMs;
    let incoming;
    try{incoming=structuredClone(event);}catch{this.metrics.droppedEvents++;return;}
    if (this.#profile.allowsEvent?.(incoming) === false) { this.metrics.droppedEvents++; return; }
    if ((event.post_type === 'message' || event.post_type === 'message_sent') && event.message_id !== undefined) {
      const key = `${this.#session}:${event.post_type}:${event.message_type}:${event.group_id ?? event.user_id}:${event.message_id}`;
      if (this.#seen.has(key)) { this.metrics.droppedEvents++; return; }
      this.#seen.set(key,true); if (this.#seen.size > 4096) this.#seen.delete(this.#seen.keys().next().value);
    }
    this.metrics.events++;
    // Isolate listeners: a broken subscriber must not break the native callback.
    for (const listener of this.rawListeners('event')) { try {
      // A preceding synchronous listener can invalidate the session. Never
      // relabel this older event with the new epoch or continue its delivery.
      if(ingressEpoch!==this.#epoch||!this.#ingressReady())break;
      const copy=structuredClone(incoming);
      if(this.#profile.quickOperations && ['message','request'].includes(incoming.post_type))
        this.#eventContexts.set(copy,{epoch:ingressEpoch,deadline,event:this.#profile.quickOperations.snapshot(incoming)});
      listener.call(this,copy);
    } catch { this.metrics.failures++; } }
  }
  dispatch = async request => { this.metrics.calls++; return this.#dispatch(request); };
  #dispatch = async (request,quickGuard) => {
    let echo;
    const result = (retcode,data=null,wording='') => ({status:retcode===0?'ok':'failed',retcode,data,...(wording ? {message:wording,wording}:{}),...(echo!==undefined?{echo}:{})});
    const unavailableAction = () => this.#bridge.isReattaching?.()
      ? result(1503, null, 'Bridge reattachment awaiting identity verification; action not submitted')
      : result(1404, null, 'Bridge capability unavailable');
    if(quickGuard&&!this.#quickValid(quickGuard))return result(1503,null,'Quick operation context expired');
    if (!request || typeof request !== 'object' || Array.isArray(request)) return result(1400,null,'Invalid request');
    echo = request.echo;
    const asynchronous = typeof request.action==='string' && request.action.endsWith('_async');
    const rateLimited = typeof request.action==='string' && request.action.endsWith('_rate_limited');
    const requestedAction = asynchronous ? request.action.slice(0,-6) : rateLimited ? request.action.slice(0,-13) : request.action;
    const { actions: ACTIONS, aliases: ALIASES = {}, localActions = {}, validateParams } = this.#profile;
    const action = Object.hasOwn(ALIASES,requestedAction) ? ALIASES[requestedAction] : requestedAction;
    if (typeof action !== 'string' || !Object.hasOwn(ACTIONS,action)) return result(1404,null,'Unsupported action');
    if (this.#closed) return result(1503,null,'Service closed');
    const mutation = ACTIONS[action].mutates;
    const nonLatching = this.#profile.nonLatchingActions?.has?.(action) === true;
    const latching = mutation && !nonLatching;
    if (this.#readOnly && mutation) return result(1403, null, 'Service is read-only');
    const outsideScope = params => this.#profile.allowsAction?.(action, params) === false;
    if (outsideScope()) return result(1403, null, 'Action is outside the read-only test group');
    if (asynchronous||rateLimited) {
      let params, bytes;
      try {params=validateParams(action,request.params);bytes=Buffer.byteLength(JSON.stringify(params));} catch {return result(1400,null,'Invalid action parameters');}
      if (outsideScope(params)) return result(1403, null, 'Action is outside the read-only test group');
      if(this.#blocksAction(action,params)) {this.metrics.blocked++;return result(1403,null,'Protected account');}
      if(!LOCAL_ACTIONS.includes(action)&&!Object.hasOwn(localActions,action)&&!this.#bridge.capabilities().includes(action)) return unavailableAction();
      if(this.#freezeOnUnknown&&this.#uncertain&&ACTIONS[action].mutates) return result(1503,null,'Previous action outcome unknown; operator reconciliation required');
      if(rateLimited){
        if(this.#rateJobs.size>=this.maxRatePending||this.#rateBytes+bytes>this.maxRateBytes)return result(1429,null,'Rate queue capacity reached; action not accepted');
        const job={action,params,bytes,epoch:this.#epoch,deadline:this.clock()+this.maxRateWaitMs};
        this.#rateQueue.push(job);this.#rateJobs.add(job);this.#rateBytes+=bytes;this.metrics.rateAccepted++;this.#scheduleRate();
        return {status:'async',retcode:1,data:null,...(echo!==undefined?{echo}:{})};
      }
      if(this.#asyncJobs.size>=this.maxAsyncPending||this.#asyncBytes+bytes>this.maxAsyncBytes) return result(1429,null,'Async capacity reached; action not accepted');
      const job={action,handle:null,bytes,epoch:this.#epoch};
      this.#asyncJobs.add(job);this.#asyncBytes+=bytes;this.metrics.asyncAccepted++;
      job.handle=setImmediate(async()=>{
        job.handle=null;
        try {
          if(this.#closed||job.epoch!==this.#epoch){this.metrics.asyncCancelled++;return;}
          // The same dispatcher revalidates identity, capabilities, rate limits
          // and durable outcome state at execution. No retry or persistence queue.
          const response=await this.#dispatch({action,params});
          if(response.retcode===0)this.metrics.asyncCompleted++;else this.metrics.asyncFailed++;
        } catch {this.metrics.asyncFailed++;}
        finally {this.#asyncJobs.delete(job);this.#asyncBytes-=bytes;}
      });
      return {status:'async',retcode:1,data:null,...(echo!==undefined?{echo}:{})};
    }
    if (action==='get_version_info') return result(0,{app_name:'whale-onebot',app_version:APP_VERSION,protocol_version:'v11',version:APP_VERSION});
    if (action==='get_supported_actions') {
      const available = this.#serviceReady() ? this.#bridge.capabilities() : [];
      const actions = new Set([...LOCAL_ACTIONS, ...Object.keys(localActions), ...available]);
      return result(0, [...actions].filter(name => Object.hasOwn(ACTIONS, name) &&
        this.#profile.allowsAction?.(name) !== false &&
        (!ACTIONS[name].mutates || (!this.#readOnly && (!this.#freezeOnUnknown || !this.#uncertain)))));
    }
    if (action==='can_send_image'||action==='can_send_record') return result(0,{yes:this.#serviceReady()});
    let params;
    try { params=validateParams(action,request.params); } catch { return result(1400,null,'Invalid action parameters'); }
    if (outsideScope(params)) return result(1403, null, 'Action is outside the read-only test group');
    if (Object.hasOwn(localActions,action) && !ACTIONS[action].mutates) return result(0,localActions[action](params));
    if (action === 'get_status' && this.#statusFromBackground) return result(0, this.status());
    if (this.#blocksAction(action,params)) { this.metrics.blocked++; return result(1403,null,'Protected account'); }
    if (action!=='get_login_info' && action!=='get_status' && !this.#bridge.capabilities().includes(action)) return unavailableAction();
    // ★ 严格模式（freezeOnUnknown）才拦写；默认放行（P4：写闸不许因发送状态关闭）。
    if (this.#freezeOnUnknown && this.#uncertain && latching) {
      this.metrics.blocked++;
      return result(1503,null,'Previous action outcome unknown; operator reconciliation required');
    }
    // ★ 2026-11-19：写锁从「全局一把」改成「按会话一把」。
    //   原来是 `#mutating` 一个布尔：A 群在等 QQ 回执时，B/C/D 群的所有写都被 1429 挡掉，
    //   最长挡满整个等待窗口 ⇒ 多群同时活跃就像卡死。同群仍然串行（保序 + 防重复），跨群并行。
    const writeKey = mutation ? this.#writeKey(action, params) : '';
    if (this.#active>=this.maxConcurrent || (mutation && (this.#mutatingChats.has(writeKey) || this.clock()-this.#lastWrite<this.minimumWriteIntervalMs))) return result(1429,null,'Busy; action not submitted');
    this.#active++; if(mutation) this.#mutatingChats.add(writeKey);
    const controller=new AbortController();
    this.#controllers.add(controller);
    const abortQuick=()=>controller.abort();
    quickGuard?.signal?.addEventListener('abort',abortQuick,{once:true});
    const capabilityWithdrawn = Symbol('capability-withdrawn');
    let timer, submitted=false, timedOut=false, reading=false, persistenceFailed=false, operationPromise;
    const epoch=this.#epoch;
    const probeSequence=++this.#probeSequence;
    let verifying=true;
    try {
      const operation=async()=>{
        const identity=await this.#verify(controller.signal,probeSequence);
        verifying=false;
        if (controller.signal.aborted || epoch!==this.#epoch) throw new Error('Cancelled');
        if(quickGuard&&!this.#quickValid(quickGuard))throw new BridgeError('STALE_QUICK_OPERATION','Quick operation context expired',{retcode:1503});
        if(action==='get_login_info') return identity;
        if(action==='get_status') return this.status();
        if (!this.#bridge.capabilities().includes(action)) return capabilityWithdrawn;
        if(mutation) {
          // A non-latching write (light social action) still counts as submitted
          // for pacing but never leaves a crash latch behind.
          if(latching) {
            try { this.outcomeStore?.begin(action); }
            catch (error) {
              if (this.#freezeOnUnknown) { persistenceFailed=true; this.#uncertain=true; throw error; }
              // 放宽模式：记录写不下去不该变成「这条消息不发」，只记账继续。
              this.metrics.outcomeRecordFailed = (this.metrics.outcomeRecordFailed ?? 0) + 1;
            }
          }
          submitted=true;this.#lastWrite=this.clock();
        }
        else reading=true;
        const data=await this.#bridge.call(action,params,{signal:controller.signal,
          ...(quickGuard?{shouldSubmit:()=>this.#quickValid(quickGuard)}:{})});
        if(controller.signal.aborted || epoch!==this.#epoch) throw new Error('Session changed');
        return data;
      };
      const operationTimeout=quickGuard?Math.max(1,Math.min(this.timeoutMs,quickGuard.deadline-this.clock())):this.timeoutMs;
      operationPromise=operation();
      const data=await Promise.race([operationPromise,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error('Deadline'));},operationTimeout);})]);
      if (data === capabilityWithdrawn) return unavailableAction();
      if(submitted && latching)this.outcomeStore?.confirmed();
      return result(0,data??null);
    } catch (error) {
      this.metrics.failures++;
      if(persistenceFailed)return result(1503,null,'Action was not submitted because its outcome record could not be saved');
      if(!submitted&&quickGuard&&!this.#quickValid(quickGuard))return result(1503,null,'Quick operation context expired');
      if(!submitted&&error instanceof BridgeError&&error.code==='STALE_QUICK_OPERATION')return result(1503,null,'Quick operation context expired');
      if(reading && timedOut && epoch===this.#epoch)
        return result(1502,null,'Native query did not complete');
      // An action-scoped read failure must not revoke the session or cancel
      // an unrelated write. Never expose native or adapter error text.
      if(reading && !timedOut && !controller.signal.aborted && epoch===this.#epoch &&
          error instanceof BridgeError && ['not_started','rejected'].includes(error.outcome)) {
        const wording=READ_FAILURES.get(error.retcode);
        if(wording)return result(error.retcode,null,wording);
      }
      if(submitted && !timedOut && error instanceof BridgeError && ['not_started','rejected'].includes(error.outcome)) {
        try{this.outcomeStore?.confirmed();}catch{this.metrics.outcomeRecordFailed=(this.metrics.outcomeRecordFailed??0)+1;return result(1504,null,'Outcome record could not be cleared; action outcome unknown');}
        const code=[1400,1403,1404,1500,1502,1503].includes(error.retcode)?error.retcode:1500;
        return result(code,null,error.outcome==='rejected'?'Native operation rejected':'Action was not submitted');
      }
      if (submitted && !timedOut && !controller.signal.aborted && epoch === this.#epoch &&
          error instanceof BridgeError && error.outcome === 'unknown') {
        // 结果未知：只记账。**发送类动作永不冻结**（P4）；严格模式只对非发送类写动作关闸。
        if (this.#freezeOnUnknown && latching && !ACCEPT_WITHOUT_RECEIPT(action)) {
          this.#uncertain = true;
          this.#cancelQueued(job => ACTIONS[job.action].mutates);
        }
        this.metrics.unknownOutcomes++;this.metrics.lastUnknownAction=action;this.metrics.lastUnknownLatching=!!latching;
        // P4：发送类动作按「已接受」回给运行端（附 null id），不再回 1504。
        if (ACCEPT_WITHOUT_RECEIPT(action)) { this.metrics.acceptedWithoutReceipt=(this.metrics.acceptedWithoutReceipt??0)+1; try{this.outcomeStore?.confirmed();}catch{} return result(0,{message_id:null,accepted_without_receipt:true}); }
        return result(1504, null, 'Action outcome unknown; do not retry automatically');
      }
      if (this.#authorizationPolicy === 'native-session' && !verifying && epoch === this.#epoch && (submitted || reading)) {
        // A missing action result is not evidence that the native authentication
        // binding died. Explicit bridge invalidation still revokes it immediately.
        if (submitted) {
          // 默认只记账不冻结；严格模式才关闸。
                    this.metrics.unknownOutcomes++;this.metrics.lastUnknownAction=action;this.metrics.lastUnknownLatching=!!latching;
          if (ACCEPT_WITHOUT_RECEIPT(action)) { this.metrics.acceptedWithoutReceipt=(this.metrics.acceptedWithoutReceipt??0)+1; try{this.outcomeStore?.confirmed();}catch{} return result(0,{message_id:null,accepted_without_receipt:true}); }
          return result(1504,null,'Action outcome unknown; do not retry automatically');
        }
        return result(timedOut?1502:1503,null,'Native query did not complete');
      }
      // In native-session mode an action-scoped failure is NOT evidence that the
      // session authorization died — #verify already revokes it when the identity is
      // unavailable or changes, and the bridge revokes it on an explicit native
      // session change. Invalidating here detached the whole bridge on one stray send
      // error; every later action then answered 1404 'Bridge capability unavailable'
      // (which the OneBot HTTP layer reports as HTTP 404) until the driver reattached,
      // which is exactly the "goes quiet for a while, then recovers" symptom seen
      // overnight on 2026-11-16.
      // ★ P4：发送类动作**在 invalidate 之前**就按「已接受」返回 —— 否则一次拿不到回执的发送
      //   会顺手把这个会话判掉，后面的消息自然也发不出去。
      if (submitted && ACCEPT_WITHOUT_RECEIPT(action)) {
        this.metrics.unknownOutcomes++;this.metrics.lastUnknownAction=action;this.metrics.lastUnknownLatching=!!latching;
        this.metrics.acceptedWithoutReceipt=(this.metrics.acceptedWithoutReceipt??0)+1;
        try{this.outcomeStore?.confirmed();}catch{}
                return result(0,{message_id:null,accepted_without_receipt:true});
      }
      if (this.#authorizationPolicy === 'native-session') this.metrics.lastActionFailure = action;
      else if (epoch===this.#epoch && !(verifying && probeSequence<this.#acceptedProbe)) this.invalidate();
      if(submitted) {
        // 默认只记账不冻结；严格模式只对**非发送类**写动作关闸（发送类已在上面的 ACCEPT 分支返回）。
        if (this.#freezeOnUnknown && latching && !ACCEPT_WITHOUT_RECEIPT(action)) this.#uncertain=true;
        this.metrics.unknownOutcomes++;this.metrics.lastUnknownAction=action;this.metrics.lastUnknownLatching=!!latching;
        return result(1504,null,'Action outcome unknown; do not retry automatically');
      }
      if(action==='get_status') return result(0,this.#authorizationPolicy === 'native-session' ? this.status() : {online:false,good:false});
      // P4：发送类动作**没提交出去**时，我们确知「没发」——回「未提交(1503)」，不回「未知(1504)」。
      // 未知状态会让运行端写 outbox.state='unknown' → held → 后续消息全被挡住。
      if (!submitted && ACCEPT_WITHOUT_RECEIPT(action)) return result(1503,null,'Action was not submitted');
      return result(timedOut?1504:1503,null,timedOut?'Bridge timed out':this.#authorizationPolicy === 'native-session'?'Native session authorization unavailable':'Verified account is not online');
    } finally {
      clearTimeout(timer);
      quickGuard?.signal?.removeEventListener('abort',abortQuick);
      controller.abort();
      this.#controllers.delete(controller);
      if(mutation){
        if(submitted)this.#lastWrite=this.clock();
        this.#mutatingChats.delete(writeKey);
      }
      const release=()=>{
        this.#active--;
        this.#scheduleRate();
      };
      // A timeout ends the client request, but a probe or native operation
      // that ignores cancellation still occupies a concurrency slot.
      if(timedOut){
        void operationPromise.then(release,release);
        this.#scheduleRate();
      } else release();
    }
  };
}
