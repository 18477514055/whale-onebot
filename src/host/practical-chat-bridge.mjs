import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NativeBridge, BridgeError, selectMessageReadback } from '../bridge/native-bridge.mjs';
import { BOT_UIN, OWNER_UIN, TEST_GROUP } from '../config/account.mjs';

const BOT = BOT_UIN;
const GROUP = TEST_GROUP;
const MAIN = OWNER_UIN;
const PHASE = 'd6-live-agent-2026-11-15';
const WINDOW_MS = 30000;
const MARK = '[Linux试跑]';
const ACTIONS = ['get_login_info', 'get_group_info', 'get_group_member_info', 'get_msg', 'send_group_msg'];
const error = (code, message, outcome = 'not_started') =>
  new BridgeError(code, message, { retcode: outcome === 'unknown' ? 1502 : 1403, outcome });

function readPhase(file) {
  let phase;
  try {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error();
    phase = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw error('PHASE_REQUIRED', 'Caller must pre-create the phase authorization JSON'); }
  if (phase?.phaseId !== PHASE || phase.bot !== BOT || phase.group !== GROUP || phase.tester !== MAIN ||
      phase.limit !== 3 || !Number.isInteger(phase.count) || phase.count < 0 || phase.count > 3 ||
      typeof phase.pending !== 'boolean' || typeof phase.frozen !== 'boolean' ||
      (phase.pending && phase.count === 0))
    throw error('PHASE_INVALID', 'Phase authorization fields do not match this limited test');
  return { phaseId: PHASE, bot: BOT, group: GROUP, tester: MAIN, limit: 3,
    count: phase.count, pending: phase.pending, frozen: phase.frozen };
}

/**
 * Narrow D9/D10 test binding, NOT a general QQ online classifier. The caller has
 * already observed this BOT's manual QR login and supplies its native session.
 * authObservedAt is an epoch-millisecond observation, not a configured online flag.
 * Before App readiness only that QR observation permits 30-second bootstrap
 * reachability. beginManualChat() ends bootstrap; only a new MAIN onRecvMsg in
 * GROUP after readiness permits a 30-second local receipt window. Native wall
 * time is diagnostic, not an online classifier. isCurrent/getSessionId still match.
 *
 * phaseFile must already contain:
 * {phaseId:'d6-live-agent-2026-11-15',bot:BOT_UIN,group:TEST_GROUP,
 *  tester:OWNER_UIN,limit:3,count:0,pending:false,frozen:false}
 * onUpdate/onUnknown receive only {stage,phaseId,count,pending,frozen,remaining,
 * code?}; onDiagnostics receives bounded prefilter counts and fixed field types/
 * booleans only. Observer failures never become native outcomes or message data.
 */
export function createPracticalChatBridge({ session, identity, isCurrent, authObservedAt,
  phaseFile, onUpdate, onUnknown, onDiagnostics } = {}) {
  if (String(identity?.user_id) !== BOT || typeof identity.uid !== 'string' ||
      !/^u_[A-Za-z0-9_-]{1,125}$/.test(identity.uid) || typeof identity.sessionId !== 'string' ||
      !identity.sessionId || typeof isCurrent !== 'function' || typeof session?.getSessionId !== 'function' ||
      typeof session?.getMsgService !== 'function' || typeof phaseFile !== 'string' || !path.isAbsolute(phaseFile) ||
      !Number.isSafeInteger(authObservedAt) || authObservedAt <= 0 || authObservedAt > Date.now())
    throw error('BINDING_REQUIRED', 'Current native session, observed identity, login time and phase file are required');
  identity = { user_id: Number(BOT), uid: identity.uid, sessionId: identity.sessionId };
  phaseFile = path.resolve(phaseFile);
  const ownerFile = phaseFile + '.owner';
  // An existing owner (including one left by a crash) is never auto-recovered.
  let ownerFd;
  try { ownerFd = fs.openSync(ownerFile, 'wx', 0o600); }
  catch { throw error('PHASE_OWNED', 'Phase already has an owner or its owner file is unavailable'); }
  const ownerStat = fs.fstatSync(ownerFd);
  const releaseOwner = () => {
    if (ownerFd === undefined) return;
    try {
      const current = fs.lstatSync(ownerFile);
      if (current.dev === ownerStat.dev && current.ino === ownerStat.ino) fs.unlinkSync(ownerFile);
    } catch { /* Never remove another owner's file. */ }
    fs.closeSync(ownerFd);
    ownerFd = undefined;
  };
  let phase;
  try { phase = readPhase(phaseFile); }
  catch (failure) { releaseOwner(); throw failure; }

  const facade = new EventEmitter();
  let raw, closed = false, sendContext, lastInboundAt = 0, publishReady = false, flushQueued = false;
  let manualChatReady = false, receiveOverflow = false;
  const buffered = [];
  // Native callback ownership is explicit. In particular, this is the wrapped
  // object actually passed to the SDK, not NativeBridge's different input object.
  const nativeListeners = new Set();
  let msgRegistrationAttempted = false;
  const diagnostics = { receiveCallbacks: 0, updateCallbacks: 0, rejectedBatches: 0, observationErrors: 0, copyFailures: 0,
    receivedMessages: 0, strictGroupCandidates: 0, coercedGroupCandidates: 0,
    mainCandidates: 0, freshMainCandidates: 0, translatedEvents: 0, publishedEvents: 0,
    handleType: 'unregistered', handleUsable: false };
  const capped = (value, increment = 1) => Math.min(value + increment, 100000);
  const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const publishDiagnostics = () => {
    try { onDiagnostics?.({ ...diagnostics, ...(diagnostics.lastShape && { lastShape: { ...diagnostics.lastShape } }),
      ...(diagnostics.lastMainShape && { lastMainShape: { ...diagnostics.lastMainShape } }),
      closed, attached: raw?.attached === true, publishReady, manualChatReady,
      timestampPolicy: 'post-ready-callback-receipt', receiveOverflow, rememberedIds: inboundIds.size,
      listenerOwners: nativeListeners.size, bufferedEvents: buffered.length,
      nativeMalformedEvents: raw?.stats?.malformedEvents ?? 0,
      nativeDroppedEvents: raw?.stats?.droppedEvents ?? 0 }); } catch {}
  };
  const inboundIds = new Set();
  const confirmedIds = new Set();
  const observe = (callback, stage, code) => {
    try { callback?.({ stage, phaseId: PHASE, count: phase.count, pending: phase.pending,
      frozen: phase.frozen, remaining: 3 - phase.count, ...(code && { code }) }); } catch {}
  };
  const update = stage => observe(onUpdate, stage);
  // Same-directory replacement: file contents are flushed before rename, and on
  // Linux the parent directory is flushed too. A failed write never permits send.
  const persist = () => {
    const temporary = phaseFile + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(phase) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, phaseFile);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(phaseFile), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      // A failed replacement is intentionally left for manual diagnosis. There
      // is no reset/refund/retry facility and no attempt to overwrite a stale tmp.
      throw error('PHASE_WRITE_FAILED', 'Phase persistence failed; no automatic retry');
    }
  };
  const freeze = code => {
    if (phase.frozen) return;
    phase.frozen = true;
    try { persist(); } catch { /* pending was committed before native invocation. */ }
    update('frozen');
    observe(onUnknown, 'frozen', code);
  };
  if (phase.pending && !phase.frozen) {
    phase.frozen = true;
    try { persist(); }
    catch (failure) { releaseOwner(); throw failure; }
    observe(onUnknown, 'frozen', 'PENDING_ON_OPEN');
  }
  const proof = () => {
    const now = Date.now();
    const observedAt = manualChatReady ? lastInboundAt : authObservedAt;
    let current = false;
    try { current = !closed && !receiveOverflow && isCurrent() === true && session.getSessionId() === identity.sessionId; } catch {}
    return { ...identity, nickname: '', online: current && now >= observedAt && now - observedAt <= WINDOW_MS };
  };
  const markStale = () => {
    const wasPublished = publishReady;
    publishReady = false;
    // IPCBridge accepts bridge-ready only after an offline generation reset.
    // This is protocol invalidation, NOT removal of the native message listener.
    if (wasPublished) facade.emit('offline');
  };
  const requireOnline = () => {
    const value = proof();
    if (!value.online) {
      markStale();
      throw error('REACHABILITY_EXPIRED', 'Limited test reachability is stale or the session changed');
    }
    return value;
  };
  const scheduleFlush = () => {
    if (flushQueued) return;
    flushQueued = true;
    setImmediate(() => {
      flushQueued = false;
      if (closed || !publishReady) return;
      if (!proof().online) { markStale(); return; }
      while (!closed && publishReady && buffered.length) {
        diagnostics.publishedEvents = capped(diagnostics.publishedEvents);
        facade.emit('event', buffered.shift());
      }
      publishDiagnostics();
    });
  };
  const inGroup = message => message?.chatType === 2 && message.peerUid === GROUP;
  const eligibleMain = message => inGroup(message) && String(message.senderUin) === MAIN &&
    typeof message.msgId === 'string' && /^[1-9]\d{0,127}$/.test(message.msgId) &&
    Array.isArray(message.elements) && message.elements.length > 0 && message.elements.length <= 1000 &&
    ['string', 'number'].includes(typeof message.msgTime) &&
    Number.isSafeInteger(Number(message.msgTime)) && Number(message.msgTime) > 0;
  // This limited manual trial trusts the CURRENT native onRecvMsg observation,
  // not the remote wall clock. Startup batches are remembered but never released.
  const freshMain = message => manualChatReady && eligibleMain(message);
  let msg;
  try { msg = session.getMsgService(); }
  catch { releaseOwner(); throw error('MSG_SERVICE_REQUIRED', 'Real native message service is unavailable'); }
  if (!msg || typeof msg.addKernelMsgListener !== 'function' || typeof msg.removeKernelMsgListener !== 'function') {
    releaseOwner(); throw error('MSG_SERVICE_REQUIRED', 'Real native message listener service is required');
  }
  const service = new Proxy(msg, {
    get(target, key) {
      if (key === 'addKernelMsgListener') return listener => {
        if (msgRegistrationAttempted)
          throw error('LISTENER_REGISTRATION_FAILED', 'This binding already attempted native registration; no retry');
        msgRegistrationAttempted = true;
        const record = { handle: undefined, usable: false, listener: undefined };
        const inspectBatch = (kind, args) => {
          const list = args[0];
          const counter = kind === 'receive' ? 'receiveCallbacks' : 'updateCallbacks';
          diagnostics[counter] = capped(diagnostics[counter]);
          diagnostics.argumentCount = Math.min(args.length, 16);
          diagnostics.firstArgumentType = valueType(list);
          diagnostics.batchLength = Array.isArray(list) ? Math.min(list.length, 513) : 0;
          if (!Array.isArray(list) || list.length > 512) diagnostics.rejectedBatches = capped(diagnostics.rejectedBatches);
          if (kind !== 'receive' || !Array.isArray(list) || list.length > 512) return;
          diagnostics.receivedMessages = capped(diagnostics.receivedMessages, list.length);
          for (const message of list) {
            const numericGroupMatch = String(message?.peerUid) === GROUP;
            if (numericGroupMatch) diagnostics.coercedGroupCandidates = capped(diagnostics.coercedGroupCandidates);
            if (!inGroup(message)) continue;
            diagnostics.strictGroupCandidates = capped(diagnostics.strictGroupCandidates);
            if (String(message?.senderUin) === MAIN) {
              diagnostics.mainCandidates = capped(diagnostics.mainCandidates);
              const now = Date.now(), numericTime = Number(message?.msgTime), secondsMs = numericTime * 1000;
              const band = value => !Number.isSafeInteger(value) ? 'invalid' : value > now ? 'future' :
                now - value <= WINDOW_MS ? 'fresh' : 'old';
              const decimalId = typeof message?.msgId === 'string' && /^[1-9]\d{0,127}$/.test(message.msgId);
              const validElements = Array.isArray(message?.elements) && message.elements.length > 0 && message.elements.length <= 1000;
              const secondsBand = band(secondsMs);
              // Keep the tested MAIN's sample separately: unrelated traffic must
              // never erase the explanation of this scoped receive rejection.
              diagnostics.lastMainShape = { msgIdType: valueType(message?.msgId), decimalId,
                elementsArray: Array.isArray(message?.elements), validElements,
                elementCount: Array.isArray(message?.elements) ? Math.min(message.elements.length, 1001) : 0,
                msgTimeType: valueType(message?.msgTime),
                msgTimeDigits: ['string', 'number'].includes(typeof message?.msgTime) ? Math.min(String(message.msgTime).length, 32) : 0,
                secondsInterpretation: secondsBand, millisecondsInterpretation: band(numericTime),
                duplicateId: inboundIds.has(message?.msgId), rejectionReason: !decimalId ? 'invalid-id' :
                  !validElements ? 'invalid-elements' :
                    !['string', 'number'].includes(typeof message.msgTime) || !Number.isSafeInteger(numericTime) || numericTime <= 0 ? 'invalid-time' :
                      !manualChatReady ? 'before-chat-ready' : inboundIds.has(message?.msgId) ? 'duplicate' : 'none' };
            }
            if (freshMain(message)) diagnostics.freshMainCandidates = capped(diagnostics.freshMainCandidates);
          }
          // Fixed field types and booleans only. No body, IDs, UID, arbitrary keys,
          // native handle values, or raw server timestamp can enter diagnostics.
          const sample = list.find(message => String(message?.peerUid) === GROUP) ?? list[0];
          if (sample !== undefined) {
            const nativeTime = Number(sample?.msgTime) * 1000, age = Date.now() - nativeTime;
            diagnostics.lastShape = { chatTypeType: valueType(sample?.chatType), isGroupType: sample?.chatType === 2,
              peerUidType: valueType(sample?.peerUid), strictGroupMatch: inGroup(sample),
              coercedGroupMatch: String(sample?.peerUid) === GROUP,
              senderUinType: valueType(sample?.senderUin), testerMatches: String(sample?.senderUin) === MAIN,
              msgIdType: valueType(sample?.msgId), decimalId: typeof sample?.msgId === 'string' && /^[1-9]\d{0,127}$/.test(sample.msgId),
              duplicateId: inboundIds.has(sample?.msgId), elementsArray: Array.isArray(sample?.elements),
              elementCount: Array.isArray(sample?.elements) ? Math.min(sample.elements.length, 1001) : 0,
              msgTimeType: valueType(sample?.msgTime), nativeTimeBand: !Number.isSafeInteger(nativeTime) ? 'invalid' :
                age < 0 ? 'future' : age <= WINDOW_MS ? 'fresh' : 'old' };
          }
        };
        const inspectSafely = (kind, args) => {
          try { inspectBatch(kind, args); }
          catch { diagnostics.observationErrors = capped(diagnostics.observationErrors); }
        };
        record.listener = { ...listener,
        onRecvMsg(...args) {
          const list = args[0];
          inspectSafely('receive', args);
          if (closed || receiveOverflow || !Array.isArray(list) || list.length > 512) { publishDiagnostics(); return; }
          const wasOnline = proof().online;
          const accepted = [];
          for (const message of list) {
            try {
              if (!eligibleMain(message)) continue;
              if (inboundIds.has(message.msgId)) continue;
              if (inboundIds.size >= 10000) {
                receiveOverflow = true; // Never forget a startup ID and revive its replay.
                markStale();
                update('receive-capacity-exhausted');
                break;
              }
              inboundIds.add(message.msgId);
              if (!manualChatReady) continue;
              const receivedAt = Date.now();
              // Project only the event envelope. SDK-only Buffers/BigInts or
              // metadata do not belong to OneBot and must not poison translation.
              // Existing readback projection preserves text/mentions without
              // invoking unrelated getters. No original SDK object is modified.
              const source = {};
              for (const key of ['msgId', 'chatType', 'peerUid', 'senderUin', 'senderUid',
                'sendNickName', 'sendMemberName', 'msgSeq', 'clientSeq', 'elements']) {
                const descriptor = Object.getOwnPropertyDescriptor(message, key);
                if (!descriptor) continue;
                if (!Object.hasOwn(descriptor, 'value')) throw Error('INVALID_NATIVE_DESCRIPTOR');
                if (descriptor.value !== undefined) source[key] = descriptor.value;
              }
              source.msgTime = String(Math.floor(receivedAt / 1000));
              const envelope = selectMessageReadback({ result: 0, msgList: [source] },
                { chatType: 2, peerUid: GROUP }, source.msgId);
              if (!envelope) throw Error('INVALID_NATIVE_ENVELOPE');
              accepted.push(envelope);
              lastInboundAt = receivedAt;
              update('inbound-observed');
            } catch { diagnostics.copyFailures = capped(diagnostics.copyFailures); }
          }
          publishDiagnostics();
          if (!proof().online) { markStale(); return; }
          if (!wasOnline) {
            markStale();
            update('reachability');
            facade.emit('bridge-ready');
          }
          listener.onRecvMsg(accepted);
        },
        onMsgInfoListUpdate(...args) {
          const list = args[0];
          inspectSafely('update', args);
          publishDiagnostics();
          if (!closed && proof().online && Array.isArray(list))
            listener.onMsgInfoListUpdate(list.filter(message => inGroup(message) && String(message.senderUin) === BOT));
        },
        // Offline/file callbacks cannot count as a fresh human observation.
        onRecvOfflineFileMsg() {}, onFileMsgCome() {},
        };
        nativeListeners.add(record); // Own the EXACT SDK callback before registration.
        try {
          record.handle = target.addKernelMsgListener(record.listener);
          record.usable = (Number.isSafeInteger(record.handle) && record.handle >= 0) ||
            (typeof record.handle === 'string' && record.handle.length > 0 && record.handle.length <= 256);
          diagnostics.handleType = valueType(record.handle);
          diagnostics.handleUsable = record.usable;
          publishDiagnostics();
          if (!record.usable) throw error('LISTENER_REGISTRATION_FAILED', 'Native listener returned an unusable handle; do not register again');
          return record.handle;
        } catch (failure) {
          // Native acceptance is uncertain. Retain owner until this process ends;
          // never retry registration or call removal with an unverified handle.
          publishDiagnostics();
          throw failure;
        }
      };
      if (key === 'removeKernelMsgListener') return handle => {
        const record = [...nativeListeners].find(item => item.usable && item.handle === handle);
        const result = target.removeKernelMsgListener(handle);
        if (record) nativeListeners.delete(record); // Removal must return successfully first.
        publishDiagnostics();
        return result;
      };
      if (key === 'sendMsg' && typeof target.sendMsg === 'function') return (...args) => {
        const context = sendContext;
        try {
          requireOnline();
          if (!context || closed || context.started || phase.frozen || phase.pending || phase.count >= 3 ||
              context.options.signal?.aborted || (context.options.shouldSubmit && !context.options.shouldSubmit()))
            throw error('SEND_BLOCKED', 'Test send is frozen, pending, cancelled or out of budget');
          if (args[0] !== '0' || !inGroup(args[1]) || args[2]?.length !== 1 ||
              args[2][0]?.elementType !== 1 || args[2][0].textElement?.atType !== undefined ||
              !args[2][0].textElement?.content?.startsWith(MARK))
            throw error('SEND_SCOPE', 'Only marked plain text to the fixed test group is allowed');
          phase.count++;
          phase.pending = true;
          try { persist(); } catch (failure) { freeze('PHASE_WRITE_FAILED'); throw failure; }
        } catch (failure) {
          if (context) context.preError = failure;
          throw failure;
        }
        // No await/observer between durable pending and the final native point.
        context.started = true;
        try { return Reflect.apply(target.sendMsg, target, args); }
        finally { update('submitted'); }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const nativeSession = new Proxy(session, {
    get(target, key) {
      if (key === 'getMsgService') return () => service;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  raw = new NativeBridge({ session: nativeSession, identityProbe: proof,
    acceptProtectedChallenge: message => inGroup(message) && String(message.senderUin) === MAIN });
  raw.on('event', event => {
    if (closed || event.post_type !== 'message' || event.message_type !== 'group' ||
        String(event.group_id) !== GROUP || String(event.user_id) !== MAIN) return;
    // Deliver NativeBridge's original translated event; no fabricated replay.
    diagnostics.translatedEvents = capped(diagnostics.translatedEvents);
    if (!proof().online) markStale();
    if (publishReady && !flushQueued && !buffered.length) {
      diagnostics.publishedEvents = capped(diagnostics.publishedEvents);
      facade.emit('event', event);
    } else if (buffered.length < 128) { buffered.push(event); if (publishReady) scheduleFlush(); }
    publishDiagnostics();
  });
  raw.on('offline', () => { publishReady = false; publishDiagnostics(); facade.emit('offline'); });
  raw.on('bridge-ready', () => facade.emit('bridge-ready'));
  Object.defineProperty(facade, 'attached', { get: () => !closed && raw.attached });
  facade.attach = async () => {
    if (closed) throw error('CLOSED', 'Practical chat bridge is closed');
    requireOnline();
    await raw.attach();
    publishDiagnostics();
    update('attached');
    return proof();
  };
  facade.beginManualChat = () => {
    if (closed || receiveOverflow || !raw.attached || isCurrent() !== true || session.getSessionId() !== identity.sessionId)
      throw error('BINDING_REQUIRED', 'Current native session is required before manual chat');
    if (manualChatReady) return; // Never refresh a lease or replay startup input.
    manualChatReady = true;
    buffered.length = 0;
    markStale();
    publishDiagnostics();
    update('manual-chat-ready');
  };
  facade.probe = async ({ signal } = {}) => {
    if (signal?.aborted) throw error('CANCELLED', 'Probe cancelled');
    const value = proof();
    if (!value.online || !raw.attached) { markStale(); return { ...value, online: false }; }
    publishReady = true;
    publishDiagnostics();
    scheduleFlush();
    return value;
  };
  facade.capabilities = () => !closed && raw.attached ? raw.capabilities().filter(action => ACTIONS.includes(action)) : [];
  facade.call = async (action, params = {}, options = {}) => {
    if (!facade.capabilities().includes(action)) throw error('ACTION_BLOCKED', 'Action is outside the practical test scope');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw error('INVALID_PARAMS', 'Expected action parameters');
    requireOnline();
    if (action === 'get_group_info' || action === 'get_group_member_info' || action === 'send_group_msg') {
      if (String(params.group_id) !== GROUP) throw error('GROUP_BLOCKED', 'Only the fixed test group is allowed');
    }
    if (action === 'get_group_member_info' && String(params.user_id) !== BOT)
      throw error('MEMBER_BLOCKED', 'Only the test BOT member can be queried');
    if (action === 'get_msg' && !confirmedIds.has(Number(params.message_id)))
      throw error('MESSAGE_BLOCKED', 'Only sends confirmed by this binding can be queried');
    if (action !== 'send_group_msg') return raw.call(action, { ...params }, options);
    if (sendContext || phase.frozen || phase.pending || phase.count >= 3)
      throw error('SEND_BLOCKED', 'Test send is frozen, pending or out of budget');
    const text = typeof params.message === 'string' ? params.message :
      Array.isArray(params.message) && params.message.length === 1 && params.message[0]?.type === 'text'
        ? params.message[0].data?.text : undefined;
    if (typeof text !== 'string' || !text.trim() || text.length > 65000 || text.includes('[CQ:') ||
        params.user_id !== undefined || (params.message_type !== undefined && params.message_type !== 'group'))
      throw error('PLAIN_TEXT_REQUIRED', 'Only one plain text segment is accepted; no CQ, quote, mention or media');
    const context = { options, started: false };
    sendContext = context;
    try {
      const result = await raw.call(action, { group_id: GROUP,
        message: [{ type: 'text', data: { text: text.startsWith(MARK) ? text : MARK + ' ' + text } }] }, options);
      if (!context.started || !Number.isSafeInteger(result?.message_id) || phase.frozen || closed)
        throw error('UNCONFIRMED', 'Native send result could not be confirmed', 'unknown');
      phase.pending = false;
      try { persist(); } catch { phase.pending = true; throw error('PHASE_WRITE_FAILED', 'Send confirmation could not be persisted', 'unknown'); }
      confirmedIds.add(result.message_id);
      update('confirmed');
      return result;
    } catch (failure) {
      if (context.started) {
        freeze('NATIVE_OUTCOME_UNCERTAIN');
        throw error('SEND_FROZEN', 'Native send did not finish with durable confirmation; do not retry', 'unknown');
      }
      throw context.preError ?? failure;
    } finally { if (sendContext === context) sendContext = undefined; }
  };
  facade.close = () => {
    if (closed) return;
    closed = true;
    if (phase.pending) freeze('CLOSED_PENDING');
    buffered.length = 0;
    raw.detach();
    releaseOwner();
    update('closed');
  };
  update('opened');
  return facade;
}
