import { EventEmitter } from 'node:events';
import { NativeBridge, BridgeError, readMediaDiagnostics } from '../bridge/native-bridge.mjs';
import { BOT_UIN } from '../config/account.mjs';

const BOT = BOT_UIN;
const uidPattern = /^u_[A-Za-z0-9_-]{1,125}$/;
const fail = (code, outcome = 'not_started') => new BridgeError(code, 'Original native session binding unavailable', { retcode: 1503, outcome });
const fields = ['msgId', 'chatType', 'peerUid', 'peerUin', 'senderUin', 'senderUid', 'msgTime', 'msgSeq',
  'clientSeq', 'sendNickName', 'sendMemberName', 'guildId', 'sendStatus'];
const elementFields = {
  1: ['textElement', ['content', 'atType', 'atUid', 'atNtUid']],
  2: ['picElement', ['fileName', 'md5HexStr', 'picUrl', 'originImageUrl', 'summary']],
  3: ['fileElement', ['fileName', 'fileSize', 'fileUuid']],
  4: ['pttElement', ['fileName', 'text']],
  5: ['videoElement', ['fileName', 'videoUrl']],
  6: ['faceElement', ['faceIndex']],
  7: ['replyElement', ['replayMsgId', 'sourceMsgIdInRecords', 'senderUin', 'senderUinStr', 'senderUidStr', 'replayMsgSeq']],
  10: ['arkElement', ['bytesData']],
  16: ['multiForwardMsgElement', ['resId']],
};
function own(object, key) {
  if (!object || typeof object !== 'object') throw fail('INVALID_NATIVE_ENVELOPE');
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw fail('INVALID_NATIVE_DESCRIPTOR');
  return descriptor.value;
}
function pick(object, names, onReject) {
  const result = {};
  for (const name of names) {
    const value = own(object, name);
    if (value === undefined) continue;
    // Native ids and times sometimes arrive as BigInt. JSON has no BigInt, and
    // every consumer below treats these as opaque identifiers or numbers, so a
    // lossless decimal string is the right shape — dropping the whole message
    // because one envelope field is a BigInt is not.
    if (typeof value === 'bigint') {
      result[name] = value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value.toString();
      continue;
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      onReject?.(name);
      throw fail('INVALID_NATIVE_FIELD');
    }
    result[name] = value;
  }
  return result;
}
function project(message, depth = 0, onReject) {
  // Every structural failure below is labelled. Without a label the only visible
  // trace of a dropped inbound message is a bare counter, which cannot say whether
  // it was the envelope, the element list or one element's payload.
  const envelope = pick(message, fields, key => onReject?.('envelope.' + key));
  let elements;
  try { elements = own(message, 'elements') ?? (depth > 0 ? [] : undefined); }
  catch { onReject?.('elements.accessor'); throw fail('INVALID_NATIVE_ENVELOPE'); }
  if (!Array.isArray(elements) || elements.length > 1000) { onReject?.('elements.shape'); throw fail('INVALID_NATIVE_ELEMENTS'); }
  envelope.elements = Array.from({ length: elements.length }, (_, index) => {
    let source;
    try { source = own(elements, String(index)); }
    catch { onReject?.('element.accessor'); throw fail('INVALID_NATIVE_ENVELOPE'); }
    const element = pick(source, ['elementType', 'elementId'], key => onReject?.('element.' + key));
    const spec = elementFields[element.elementType];
    if (spec) {
      let value;
      try { value = own(source, spec[0]); }
      catch { onReject?.('element.' + spec[0] + '.accessor'); throw fail('INVALID_NATIVE_ENVELOPE'); }
      if (value != null) element[spec[0]] = pick(value, spec[1], key => onReject?.(spec[0] + '.' + key));
    }
    return element;
  });
  let records;
  try { records = own(message, 'records'); }
  catch { onReject?.('records.accessor'); throw fail('INVALID_NATIVE_ENVELOPE'); }
  if (records !== undefined) {
    // A malformed or oversized nested-record list used to reject the WHOLE message,
    // which silently swallowed every inbound message that carried one (measured
    // 2026-11-16: 6 of 55 received minutes after start were lost this way). The
    // records list only feeds merged-forward expansion; the message itself, its text
    // and its forward card id are still valid, so keep the message and report the
    // dropped list instead of losing the turn.
    if (depth >= 1 || !Array.isArray(records) || records.length > 32) {
      onReject?.('records.shape');
      envelope.recordsDropped = Array.isArray(records) ? records.length : 0;
    } else {
      envelope.records = Array.from({ length: records.length }, (_, index) => project(own(records, String(index)), depth + 1, onReject));
    }
  }
  return envelope;
}

/**
 * Resident binding for the explicitly approved original App operation scope.
 * identity MUST originate in this process's accepted BOT authentication event.
 * isCurrent MUST become false on native lifecycle invalidation; this factory
 * cannot manufacture authentication or establish server-online telemetry.
 * No login, human-message gate, phase budget, business ACL, scheduler or retry.
 */
/**
 * 未知结果的结构性指纹：**不含正文、不含 QQ 号**，只留判断问题所需的形状。
 * 例：{ action:'send_group_msg', to:'group', segments:['text','at'], bytes:42, code:'TIMEOUT' }
 */
function fingerprint(action, params, error) {
  const out = { action: typeof action === 'string' ? action : 'unknown', code: String(error?.code || error?.name || '') };
  if (!params || typeof params !== 'object') return out;
  if (params.group_id !== undefined) out.to = 'group';
  else if (params.user_id !== undefined || params.user_id === undefined && params.message_type === 'private') out.to = 'private';
  const message = params.message ?? params.messages;
  if (typeof message === 'string') {
    out.segments = ['text'];
    out.bytes = message.length;
    if (message.includes('CQ:')) out.cq = [...new Set([...message.matchAll(/CQ:(\w+)/g)].map(m => m[1]))].slice(0, 8);
  } else if (Array.isArray(message)) {
    out.segments = [...new Set(message.map(segment => String(segment?.type ?? '?')))].slice(0, 8);
    out.count = message.length;
  } else if (Array.isArray(params.messages)) {
    out.segments = ['forward'];
    out.count = params.messages.length;
  }
  if (params.auto_escape !== undefined) out.auto_escape = params.auto_escape === true;
  return out;
}

export function createOriginalChatBridge({ session, identity, isCurrent, onUpdate, onDiagnostics, onUnknown, imagePlacement } = {}) {
  if (String(identity?.user_id) !== BOT || !uidPattern.test(identity?.uid ?? '') ||
      typeof identity?.sessionId !== 'string' || !identity.sessionId || identity.sessionId.length > 256 ||
      typeof isCurrent !== 'function' || typeof session?.getSessionId !== 'function' || typeof session?.getMsgService !== 'function')
    throw fail('BINDING_REQUIRED');
  identity = Object.freeze({ user_id: Number(BOT), uid: identity.uid, sessionId: identity.sessionId });
  const facade = new EventEmitter();
  let raw, closed = false, attachAttempted = false, publishReady = false, flushQueued = false;
  const owners = new Set(), services = new Map(), buffered = [];
  const counters = { receiveCallbacks: 0, updateCallbacks: 0, projectedMessages: 0, projectionFailures: 0,
    reducedReceipts: 0, rejectedBatches: 0, translatedEvents: 0, publishedEvents: 0, droppedEvents: 0, unknownActions: 0 };
  const bump = (key, amount = 1) => { counters[key] = Math.min(100000, counters[key] + amount); };
  // Field names only (never values): which envelope key or element type made a
  // projection fail. Bounded to 32 distinct causes.
  const projectionFailureKeys = new Map();
  const recordProjectionFailure = label => {
    const key = String(label).slice(0, 48);
    if (!projectionFailureKeys.has(key) && projectionFailureKeys.size >= 32) return;
    projectionFailureKeys.set(key, Math.min(100000, (projectionFailureKeys.get(key) ?? 0) + 1));
  };
  const observe = (fn, value) => { try { fn?.(value); } catch {} };
  const update = (stage, code) => observe(onUpdate, { stage, ...(code && { code }) });
  const diagnostics = () => observe(onDiagnostics, { ...counters, closed, attached: raw?.attached === true,
    publishReady, bufferedEvents: buffered.length, listenerOwners: owners.size,
    uncertainRegistrations: [...owners].filter(owner => !owner.usable).length,
    nativeMalformedEvents: raw?.stats?.malformedEvents ?? 0, nativeDroppedEvents: raw?.stats?.droppedEvents ?? 0,
    // ★ 免 hook 事件面（notice）的可观测计数：没有这几个数，就分不清
    //   「没收到灰条」「收到但解析不出」「解析出但换不出 uin」——三种情况的修法完全不同。
    notices: { emitted: raw?.stats?.noticeEmitted ?? 0, grayTipsSeen: raw?.stats?.grayTipsSeen ?? 0,
      droppedNoUid: raw?.stats?.noticeDroppedNoUid ?? 0, droppedMalformed: raw?.stats?.noticeDroppedMalformed ?? 0,
      duplicatesSuppressed: raw?.stats?.noticeDuplicatesSuppressed ?? 0,
      bulkSkipped: raw?.stats?.noticeBulkSkipped ?? 0,
      grayTipKinds: raw?.stats?.grayTipKinds ?? {} },
    mediaImages: readMediaDiagnostics(),
    projectionFailureKeys: Object.fromEntries(projectionFailureKeys),
    online: false, online_known: false });
  const revoke = code => {
    if (closed) return;
    closed = true; publishReady = false; buffered.length = 0;
    raw?.detach();
    update('revoked', code); diagnostics();
  };
  const proof = () => {
    let current = false;
    try { current = !closed && isCurrent() === true && session.getSessionId() === identity.sessionId; } catch {}
    if (!current) { revoke('NATIVE_SESSION_INVALIDATED'); throw fail('NATIVE_SESSION_INVALIDATED'); }
    return { ...identity, nickname: '', authenticated: true, sessionAuthorized: true, online: false,
      online_known: false, platform_state: 'unknown' };
  };
  const flush = () => {
    if (flushQueued) return;
    flushQueued = true;
    setImmediate(() => {
      flushQueued = false;
      if (closed || !publishReady) return;
      try { proof(); } catch { return; }
      while (!closed && publishReady && buffered.length) {
        bump('publishedEvents'); facade.emit('event', buffered.shift());
      }
      diagnostics();
    });
  };
  // Only the own scalar fields NativeBridge's reduced terminal receipt lane needs.
  // A send confirmation must survive a whole-message projection failure (missing
  // elements, optional BigInt fields, accessors) instead of being dropped here.
  const receiptFields = ['msgId', 'chatType', 'peerUid', 'senderUin', 'senderUid', 'sendStatus', 'guildId'];
  const projectBatch = (list, kind) => {
    const update = kind === 'onMsgInfoListUpdate';
    bump(update ? 'updateCallbacks' : 'receiveCallbacks');
    if (closed || !Array.isArray(list) || list.length > 512) { bump('rejectedBatches'); diagnostics(); return []; }
    const result = [];
    for (const message of list) {
      try { result.push(project(message, 0, recordProjectionFailure)); bump('projectedMessages'); }
      catch {
        if (!update) { bump('projectionFailures'); continue; }
        // Terminal update receipts reach NativeBridge as a scalar-only envelope
        // when optional content is absent or unrepresentable. Without an elements
        // array, NativeBridge confirms the send and never publishes a fabricated
        // empty self event; a non-scalar receipt field still fails closed.
        try { result.push(pick(message, receiptFields, key => recordProjectionFailure('receipt.' + key))); bump('reducedReceipts'); }
        catch { bump('projectionFailures'); }
      }
    }
    diagnostics();
    return result;
  };
  const wrapService = target => {
    if (!target || typeof target !== 'object') return target;
    if (services.has(target)) return services.get(target);
    const registrations = new Set();
    const proxy = new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof key === 'string' && /^addKernel[A-Za-z]+Listener$/.test(key) && typeof value === 'function') return listener => {
        if (registrations.has(key)) throw fail('LISTENER_ALREADY_ATTEMPTED');
        registrations.add(key);
        const record = { service: object, add: key, listener: { ...listener }, handle: undefined, usable: false };
        for (const name of ['onRecvMsg', 'onMsgInfoListUpdate', 'onRecvOfflineFileMsg', 'onFileMsgCome']) {
          if (typeof listener[name] !== 'function') continue;
          record.listener[name] = (list, ...args) => {
            if (closed) return;
            try { proof(); listener[name](projectBatch(list, name), ...args); }
            catch { /* Invalid lifecycle already revoked; native callback never throws. */ }
          };
        }
        owners.add(record); // Retain the exact object BEFORE handing it to native.
        try {
          record.handle = Reflect.apply(value, object, [record.listener]);
          record.usable = (Number.isSafeInteger(record.handle) && record.handle >= 0) ||
            (typeof record.handle === 'string' && record.handle.length > 0 && record.handle.length <= 256);
          if (!record.usable) throw fail('INVALID_LISTENER_HANDLE');
          diagnostics(); return record.handle;
        } catch (error) {
          observe(onUnknown, { stage: 'registration-uncertain', code: 'LISTENER_REGISTRATION_UNCERTAIN' });
          diagnostics(); throw error;
        }
      };
      if (typeof key === 'string' && /^removeKernel[A-Za-z]+Listener$/.test(key) && typeof value === 'function') return handle => {
        const add = key.replace(/^remove/, 'add');
        const record = [...owners].find(owner => owner.service === object && owner.add === add && owner.usable && owner.handle === handle);
        if (!record) throw fail('LISTENER_HANDLE_UNVERIFIED');
        const result = Reflect.apply(value, object, [handle]);
        owners.delete(record); diagnostics(); return result;
      };
      // Readback and history use the same bounded own-data envelope as ingress.
      if (['getMsgsByMsgId', 'getAioFirstViewLatestMsgs', 'getMsgs'].includes(key) && typeof value === 'function') return async (...args) => {
        const response = await Reflect.apply(value, object, args);
        const result = pick(response, ['result', 'needContinueGetMsg']);
        const list = own(response, 'msgList');
        if (!Array.isArray(list) || list.length > 4096) throw fail('INVALID_NATIVE_READBACK');
        result.msgList = Array.from({ length: list.length }, (_, index) => project(own(list, String(index))));
        return result;
      };
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    services.set(target, proxy); return proxy;
  };
  const nativeSession = new Proxy(session, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof key === 'string' && /^get[A-Za-z]+Service$/.test(key) && typeof value === 'function')
      return (...args) => wrapService(Reflect.apply(value, target, args));
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  raw = new NativeBridge({ session: nativeSession, identityProbe: proof,
    authorizationPolicy: 'native-session', conversationPolicy: 'original', imagePlacement });
  raw.on('event', value => {
    if (closed) return;
    try { proof(); } catch { return; }
    bump('translatedEvents');
    if (publishReady && !flushQueued && buffered.length === 0) { bump('publishedEvents'); facade.emit('event', value); }
    else if (buffered.length < 128) { buffered.push(value); if (publishReady) flush(); }
    else bump('droppedEvents');
    diagnostics();
  });
  raw.on('offline', () => { publishReady = false; buffered.length = 0; facade.emit('offline'); diagnostics(); });
  raw.on('bridge-ready', () => facade.emit('bridge-ready'));
  Object.defineProperty(facade, 'attached', { get: () => !closed && raw.attached });
  Object.defineProperty(facade, 'msfDisconnected', { get: () => !closed && raw.msfDisconnected === true });
  facade.setMsfStatus = (status) => { if (!closed && typeof raw.setMsfStatus === 'function') raw.setMsfStatus(status); };
  facade.attach = async () => {
    if (attachAttempted || closed) throw fail('ATTACH_ALREADY_ATTEMPTED');
    attachAttempted = true;
    try { proof(); const value = await raw.attach(); update('attached'); diagnostics(); return value; }
    catch (error) { revoke('ATTACH_FAILED'); throw error; }
  };
  facade.probe = async ({ signal } = {}) => {
    if (signal?.aborted) throw fail('CANCELLED');
    proof();
    if (!raw.attached) throw fail('BRIDGE_DETACHED');
    const value = await raw.probe();
    if (signal?.aborted) throw fail('CANCELLED');
    proof(); publishReady = true; flush(); return value;
  };
  facade.capabilities = () => !closed && raw.attached ? raw.capabilities() : [];
  facade.wakeSession = (options) => !closed && raw.attached ? raw.wakeSession(options) : Promise.resolve({ awake: false, reason: 'detached', invoked: [] });
  facade.call = async (action, params, options = {}) => {
    proof();
    try { return await raw.call(action, params, options); }
    catch (error) {
      if (error instanceof BridgeError && error.outcome === 'unknown') {
        bump('unknownActions');
        // ★ 记下"到底是哪一发"变成了未知：只留结构性指纹（动作/会话/消息段类型与长度），
        //   不留正文。没有这个，事后只能看到一句 action-unknown，无法判断是群还是私聊、
        //   是纯文本还是带 @ / 图片 / 回复（2026-11-17 就因此多查了一小时）。
        observe(onUnknown, { stage: 'action-unknown', code: 'NATIVE_OUTCOME_UNKNOWN', detail: fingerprint(action, params, error) });
        diagnostics();
      }
      throw error;
    }
  };
  facade.close = () => { if (closed) return; closed = true; publishReady = false; buffered.length = 0; raw.detach(); update('closed'); diagnostics(); };
  update('opened'); diagnostics();
  return facade;
}
