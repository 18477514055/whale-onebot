import { randomBytes } from 'node:crypto';
import { on, once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createSessionService } from '../service.mjs';
import { OfflineBridge } from '../core.mjs';
import { NativeBridge, selectMessageReadback } from '../bridge/native-bridge.mjs';
import { manageOneBotProcess } from './onebot-process.mjs';
import { isVerifiedProtectedChallenge } from './inbound-challenge.mjs';
import { BOT_UIN } from '../config/account.mjs';

export async function openRoundtripReverseReceiver() {
  const token = randomBytes(24).toString('hex');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 64 * 1024,
    verifyClient: ({ req }) => req.url === '/roundtrip' && req.headers.authorization === `Bearer ${token}` &&
      req.headers['x-client-role'] === 'Universal' && req.headers['x-self-id'] === BOT_UIN });
  try { await once(server, 'listening', { signal: AbortSignal.timeout(2000) }); }
  catch (error) { server.close(); throw error; }
  let socket;
  server.on('connection', connection => {
    socket = connection;
    connection.on('error', () => {});
  });
  return {
    options: { url: `ws://127.0.0.1:${server.address().port}/roundtrip`, token, role: 'Universal', heartbeatMs: 0 },
    current: () => socket?.readyState === WebSocket.OPEN ? socket : undefined,
    async close() {
      for (const connection of server.clients) connection.terminate();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function probeRoundtripReverseReceiver(receiver, signal) {
  const socket = receiver.current();
  if (!socket) return { connected: false, pongVerified: false };
  const nonce = randomBytes(16);
  const deadline = AbortSignal.timeout(750);
  const timeout = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const replies = on(socket, 'pong', { signal: timeout, close: ['close'] });
  try {
    timeout.throwIfAborted();
    socket.ping(nonce, error => {
      if (error) void replies.return();
    });
    for await (const [reply] of replies) {
      if (!timeout.aborted && nonce.equals(reply) && receiver.current() === socket)
        return { connected: true, pongVerified: true };
    }
  } catch {
    // A timed-out or retired socket is not evidence of a responsive peer.
  } finally { await replies.return(); }
  return { connected: Boolean(receiver.current()), pongVerified: false };
}

export async function checkRoundtripReverseReady(receiver, signal) {
  const deadline = AbortSignal.timeout(2000);
  const timeout = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    while (!receiver.current()) await delay(10, undefined, { signal: timeout });
    const status = await probeRoundtripReverseReceiver(receiver, timeout);
    if (status.pongVerified) return status;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!deadline.aborted) throw error;
  }
  throw new Error('Reverse OneBot endpoint did not respond to the readiness check');
}

export async function checkOfflineRoundtripReverse(receiver, signal, previousSocket, { requirePong = false } = {}) {
  const deadline = AbortSignal.timeout(2000);
  const timeout = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let socket;
  while (!(socket = receiver.current()) || socket === previousSocket)
    await delay(10, undefined, { signal: timeout });
  const status = await readOneBotSocketStatus(socket, timeout);
  if (receiver.current() !== socket || status.online || status.good)
    throw new Error('Reverse OneBot endpoint did not report offline status');
  if (requirePong) {
    const pinned = { current: () => receiver.current() === socket ? socket : undefined };
    const probe = await probeRoundtripReverseReceiver(pinned, timeout);
    if (!probe.pongVerified || receiver.current() !== socket)
      throw new Error('Reverse OneBot offline endpoint did not confirm readiness on the same connection');
  }
  return { connected: true, authenticatedOfflineStatus: true, ...(requirePong && { pongVerified: true }) };
}

export async function observeOneBotReverseStatus(receiver, signal) {
  const socket = receiver.current();
  let status = null;
  if (socket) {
    const deadline = AbortSignal.timeout(1000);
    const timeout = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const result = await readOneBotSocketStatus(socket, timeout);
      if (receiver.current() === socket) status = result;
    } catch {}
  }
  return { connected: Boolean(receiver.current()), endpointResponded: status !== null, status };
}

export async function observeOneBotReverseEndpoint(receiver, signal) {
  const socket = receiver.current();
  const pinned = { current: () => receiver.current() === socket ? socket : undefined };
  const [transport, protocol] = await Promise.all([
    probeRoundtripReverseReceiver(pinned, signal), observeOneBotReverseStatus(pinned, signal),
  ]);
  const connected = Boolean(receiver.current());
  if (!socket || receiver.current() !== socket)
    return { connected, pongVerified: false, endpointResponded: false, status: null };
  return { ...protocol, connected, pongVerified: transport.pongVerified };
}

export async function findSubmittedReply({ reply, senderUin, senderUid, readRecent, signal }) {
  const { group, correlation, inboundNativeId, text, submittedAt } = reply;
  if (typeof group !== 'string' || !/^[1-9]\d{4,15}$/.test(group) || !Number.isSafeInteger(Number(group)) ||
      typeof correlation !== 'string' || !/^[1-9]\d{0,127}$/.test(correlation) ||
      typeof inboundNativeId !== 'string' || !/^[1-9]\d{0,127}$/.test(inboundNativeId) ||
      typeof text !== 'string' || !/^whale-reply-[a-f0-9]{32}$/.test(text) ||
      !Number.isSafeInteger(submittedAt) || submittedAt < 1) throw new TypeError('Invalid submitted reply');
  signal.throwIfAborted();
  const peer = { chatType: 2, peerUid: group, guildId: '' };
  const response = await readRecent(peer, 20);
  signal.throwIfAborted();
  if (response?.result !== 0 || response.needContinueGetMsg !== false ||
      !Array.isArray(response.msgList) || response.msgList.length > 20) return null;
  const matches = response.msgList.filter(message => {
    const uin = message?.senderUin;
    const uid = message?.senderUid;
    const exactAccount = uin === senderUin || uin === Number(senderUin);
    const boundUidOnly = typeof senderUid === 'string' && senderUid.length > 0 && uid === senderUid &&
      [undefined, null, ''].includes(uin);
    if (message?.chatType !== 2 || message.peerUid !== group ||
        (!exactAccount && !boundUidOnly) || (uid && uid !== senderUid) ||
        (message.guildId && message.guildId !== correlation) ||
        !['string', 'number'].includes(typeof message.msgTime) || !/^\d{1,16}$/.test(String(message.msgTime))) return false;
    const time = Number(message.msgTime);
    if (!Number.isSafeInteger(time) || time < submittedAt - 5 || time > submittedAt + 300) return false;
    const element = Array.isArray(message.elements) && message.elements.length === 1 ? message.elements[0] : null;
    return element?.elementType === 1 && element.textElement?.content === text &&
      (element.textElement.atType === undefined || element.textElement.atType === 0);
  });
  if (matches.length !== 1) return null;
  const { sendStatus, msgId } = matches[0];
  return [2, 3].includes(sendStatus) && typeof msgId === 'string' && /^[1-9]\d{0,127}$/.test(msgId) &&
    msgId !== correlation && msgId !== inboundNativeId
    ? { group, nativeId: msgId, text } : null;
}

function bindOmittedReplyAccount(message, identity) {
  if (!message || !identity?.uid || message.senderUid !== identity.uid ||
      ![undefined, null, ''].includes(message.senderUin)) return message;
  return { ...message, senderUin: String(identity.user_id) };
}

export async function verifyConfirmedReplyReadback({ projectRoot, reply, identityProbe, readMessage, signal }) {
  const { group, nativeId, text } = reply;
  if (typeof group !== 'string' || !/^[1-9]\d{4,15}$/.test(group) || !Number.isSafeInteger(Number(group)) ||
      typeof nativeId !== 'string' || !/^[1-9]\d{0,127}$/.test(nativeId) ||
      typeof text !== 'string' || !/^whale-reply-[a-f0-9]{32}$/.test(text)) throw new TypeError('Invalid confirmed reply');
  signal.throwIfAborted();
  const token = randomBytes(24).toString('hex');
  let attempted = false;
  let nativeFailed = false;
  let nativeStatus;
  let sender, senderUid;
  const msg = {
    addKernelMsgListener() { return 1; },
    removeKernelMsgListener() {},
    async getMsgsByMsgId(peer, ids) {
      signal.throwIfAborted();
      if (attempted || peer.chatType !== 2 || peer.peerUid !== group || peer.guildId !== '' ||
          ids.length !== 1 || ids[0] !== nativeId) throw new Error('Read exceeds the confirmed reply scope');
      attempted = true;
      try {
        const result = await readMessage(peer, ids);
        if (result && typeof result === 'object') nativeStatus = Object.getOwnPropertyDescriptor(result, 'result')?.value;
        if (nativeStatus !== 0) return result;
        // Narrow recovery to this already bound group message. Project the
        // native response before substituting the authenticated account.
        let match;
        try { match = selectMessageReadback(result, peer, nativeId); }
        catch { return result; }
        const bound = bindOmittedReplyAccount(match, { user_id: sender, uid: senderUid });
        if (bound !== match) return { result: 0, msgList: [bound] };
        return result;
      }
      catch (error) { nativeFailed = true; throw error; }
    },
  };
  let service;
  try {
    service = await createSessionService({ projectRoot, port: 0, token, identityProbe,
      session: { getMsgService: () => msg }, timeoutMs: 2000 });
  } catch {
    signal.throwIfAborted();
    return { attempted: false, verified: false, outcome: 'service-start-failed' };
  }
  try {
    ({ user_id: sender, uid: senderUid } = service.bridge.identity);
    const messageId = service.bridge.messages.put({ chatType: 2, peerUid: group, msgId: nativeId, senderUin: sender,
      ...(senderUid !== undefined && { senderUid }) });
    let response, result;
    try {
      response = await fetch(`http://127.0.0.1:${service.address.port}/get_msg?message_id=${messageId}`, {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      });
      result = await response.json();
    } catch {
      signal.throwIfAborted();
      return { attempted, verified: false, outcome: 'transport-failed' };
    }
    const verified = attempted && response.status === 200 && result?.retcode === 0 &&
      result.data?.message_id === messageId && result.data.group_id === Number(group) &&
      result.data.user_id === sender && result.data.raw_message === text;
    let outcome = 'onebot-rejected';
    if (verified) outcome = 'verified';
    else if (!attempted) outcome = 'not-started';
    else if (nativeFailed || nativeStatus !== 0) outcome = 'native-read-failed';
    else if ([0, 1404, 1502].includes(result?.retcode)) outcome = 'response-mismatch';
    return { attempted, verified, outcome };
  } finally { await service.close(); }
}

export async function readOneBotWebSocketStatus(port, token, signal) {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/api', {
    headers: { Authorization: 'Bearer ' + token },
  });
  socket.on('error', () => {});
  try {
    await once(socket, 'open', { signal });
    return await readOneBotSocketStatus(socket, signal);
  } finally { socket.terminate(); }
}

async function readOneBotSocketStatus(socket, signal) {
  const result = await readOneBotSocketAction(socket, 'get_status', signal);
  if (typeof result?.online !== 'boolean' || typeof result?.good !== 'boolean')
    throw new Error('Unexpected OneBot WebSocket status');
  return { online: result.online, good: result.good };
}

async function readOneBotSocketAction(socket, action, signal) {
  const echo = randomBytes(16).toString('hex');
  const frames = on(socket, 'message', { signal, close: ['close'] });
  try {
    signal?.throwIfAborted();
    socket.send(JSON.stringify({ action, echo }), error => {
      if (error) void frames.return();
    });
    for await (const [data] of frames) {
      const result = JSON.parse(data.toString());
      if (result?.echo !== echo) continue;
      if (result.retcode !== 0) break;
      signal?.throwIfAborted();
      return result.data;
    }
    throw new Error('OneBot WebSocket action did not return a successful response');
  } finally { await frames.return(); }
}

export async function checkOfflineOneBot(port, token, signal, wsPort = port, onHttpVerified = () => {}) {
  const url = 'http://127.0.0.1:' + port;
  const timeout = AbortSignal.timeout(1000);
  const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Connection: 'close' } };
  const denied = await fetch(url + '/get_status', options);
  await denied.body?.cancel();
  if (denied.status !== 401) throw new Error('Offline endpoint did not require a token');
  const authenticated = { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + token } };
  const status = await fetch(url + '/get_status', authenticated);
  const state = await status.json();
  if (status.status !== 200 || state.retcode !== 0 || state.data?.online !== false || state.data?.good !== false)
    throw new Error('OneBot did not report offline status');
  const actions = await fetch(url + '/get_supported_actions', authenticated);
  const result = await actions.json();
  const expected = ['get_login_info', 'get_status', 'get_version_info', 'get_supported_actions', 'can_send_image', 'can_send_record', 'fetch_sys_faces'];
  if (actions.status !== 200 || result.retcode !== 0 || !Array.isArray(result.data) ||
      result.data.length !== expected.length || !expected.every(action => result.data.includes(action)))
    throw new Error('Offline endpoint advertised unexpected actions');
  onHttpVerified();
  const report = { unauthenticatedStatusRejected: true, authenticatedOfflineStatus: true, businessActionsAdvertised: false };
  const wsUrl = 'ws://127.0.0.1:' + wsPort + '/api';
  const unauthenticated = new WebSocket(wsUrl);
  unauthenticated.on('error', () => {});
  try {
    await once(unauthenticated, 'open', { signal: options.signal });
    throw new Error('Offline WebSocket did not require a token');
  } catch (error) {
    if (error.message !== 'Unexpected server response: 401') throw error;
  } finally { unauthenticated.terminate(); }
  const statusOnWs = await readOneBotWebSocketStatus(wsPort, token, options.signal);
  if (statusOnWs.online || statusOnWs.good) throw new Error('OneBot WebSocket did not report offline status');
  return { ...report, authenticatedOfflineWebSocket: true };
}

export async function checkRoundtripChallengeEndpoints({ child, token, reverse }, signal) {
  const { port, wsPort } = child;
  await Promise.all([checkOfflineOneBot(port, token, signal, wsPort),
    checkOfflineRoundtripReverse(reverse, signal)]);
}

export function createSendReceiptObservation(peer, senderUin, receive, senderUid) {
  const counts = { batches: 0, unusableBatches: 0, samePeerAndSender: 0,
    samePeer: 0, sameRequest: 0, senderUidMatches: 0, senderIdentityConflicts: 0, senderUinRecovered: 0,
    receiveBatches: 0, updateBatches: 0,
    unrelatedRequest: 0, requestIdAsMessageId: 0, nonterminalStatus: 0,
    terminalFailure: 0, terminalSuccess: 0, terminalSuccessWithValidId: 0, forwarded: 0 };
  return {
    observe(messages, source) {
      counts.batches++;
      if (source === 'receive') counts.receiveBatches++;
      if (source === 'update') counts.updateBatches++;
      if (!Array.isArray(messages) || messages.length > 128) {
        counts.unusableBatches++;
        return;
      }
      const matching = [];
      for (const item of messages) {
        if (item?.chatType !== peer.chatType || item.peerUid !== peer.peerUid) continue;
        counts.samePeer++;
        const requestMatches = item.guildId === peer.guildId;
        if (requestMatches) counts.sameRequest++;
        const matchesUin = item.senderUin === senderUin || item.senderUin === Number(senderUin);
        const hasUid = typeof senderUid === 'string' && senderUid.length > 0;
        const matchesUid = hasUid && item.senderUid === senderUid;
        if (matchesUid) counts.senderUidMatches++;
        const hasUin = item.senderUin !== undefined && item.senderUin !== null && item.senderUin !== '';
        const hasObservedUid = item.senderUid !== undefined && item.senderUid !== null && item.senderUid !== '';
        if ((matchesUid && hasUin && !matchesUin) || (matchesUin && hasUid && hasObservedUid && !matchesUid)) {
          counts.senderIdentityConflicts++;
          continue;
        }
        const recoverUin = !hasUin && matchesUid;
        if (!matchesUin && !recoverUin) continue;
        counts.samePeerAndSender++;
        if (!requestMatches) { counts.unrelatedRequest++; continue; }
        if (item.msgId === peer.guildId) { counts.requestIdAsMessageId++; continue; }
        // A receive notification can contribute positive terminal evidence;
        // only the send-status update stream is used to report rejection.
        if (source === 'receive' && item.sendStatus !== 2 && item.sendStatus !== 3) continue;
        if (item.sendStatus === 0) counts.terminalFailure++;
        else if (item.sendStatus === 2 || item.sendStatus === 3) {
          counts.terminalSuccess++;
          if (typeof item.msgId === 'string' && /^[1-9]\d{0,127}$/.test(item.msgId))
            counts.terminalSuccessWithValidId++;
        } else counts.nonterminalStatus++;
        if (recoverUin) {
          counts.senderUinRecovered++;
          matching.push({ chatType: peer.chatType, peerUid: peer.peerUid, guildId: peer.guildId,
            msgId: item.msgId, senderUin, senderUid, sendStatus: item.sendStatus });
        } else matching.push(item);
      }
      counts.forwarded += matching.length;
      if (matching.length) receive(matching);
    },
    snapshot() { return { ...counts }; },
  };
}

// Replay one normalized challenge record through the actual bridge. When a
// fixed native send adapter is supplied, enable only its one matching reply.
export async function verifyOneBotReceive({ projectRoot, identityProbe, takeMessage, signal, nativeSend,
  readInboundMessage,
  timeoutMs = 2000, restartOneBot = false, preLoginOneBot, onProgress = () => {}, onSendResponse = () => {},
  onBridgeStats = () => {}, onRestartVerified = () => {}, onBridgeRestartVerified = () => {},
  onEndpointCheck = () => {}, nativeGroup, onGroupRead = () => {}, onMessageRead = () => {}, onConfirmedReply = () => {},
  onSubmittedReply = () => {} }) {
  signal.throwIfAborted();
  const progress = { oneBotEventVerified: false, nativeSubmissionAttempted: false, oneBotSendConfirmed: false };
  const reverse = preLoginOneBot?.reverse;
  if (reverse) Object.assign(progress, { reverseConnected: false, reverseEventVerified: false });
  const record = key => { progress[key] = true; onProgress({ ...progress }); };
  if (reverse) onProgress({ ...progress });
  const token = preLoginOneBot?.token ?? randomBytes(24).toString('hex');
  let listener, groupListener;
  let approvedGroup, approvedText, correlation, inboundNativeId, sendAttempted = false, groupReadAttempted = false;
  let nativeReadOutcome;
  let savedReadback, allowSnapshotRead = false;
  let groupReadSignal, messageReadSignal, confirmedNativeId, messageReadAttempted = false;
  const msg = {
    addKernelMsgListener(value) { listener = value; return 1; },
    removeKernelMsgListener() { listener = undefined; },
  };
  if (nativeSend) {
    msg.generateMsgUniqueId = (...args) => nativeSend.generateId(...args);
    msg.sendMsg = (first, peer, elements, extension) => {
      signal.throwIfAborted();
      if (sendAttempted || !approvedGroup || peer.chatType !== 2 || peer.peerUid !== approvedGroup ||
          elements.length !== 1 || elements[0].elementType !== 1 ||
          elements[0].textElement?.content !== approvedText)
        throw new Error('Send falls outside the fixed test');
      sendAttempted = true;
      correlation = peer.guildId;
      return nativeSend.submit(first, peer, elements, extension, batch => {
        if (Array.isArray(batch) && batch.length <= 128)
          listener?.onMsgInfoListUpdate(batch.filter(entry => entry?.msgId !== inboundNativeId));
      },
        () => {
          record('nativeSubmissionAttempted');
          onSubmittedReply({ group: approvedGroup, correlation, inboundNativeId, text: approvedText,
            submittedAt: Math.floor(Date.now() / 1000) });
        });
    };
  }
  const readNativeMessage = nativeSend?.readMessage ?? readInboundMessage;
  if (typeof readNativeMessage === 'function') {
    msg.getMsgsByMsgId = async (peer, ids) => {
      if (!messageReadSignal || messageReadSignal.aborted ||
          peer.chatType !== 2 || peer.peerUid !== approvedGroup || peer.guildId !== '' ||
          !Array.isArray(ids) || ids.length !== 1 || ids[0] !== confirmedNativeId)
        throw new Error('Message query falls outside the fixed test');
      if (messageReadAttempted) {
        if (!allowSnapshotRead || !savedReadback) throw new Error('Message query was already attempted');
        allowSnapshotRead = false;
        return savedReadback;
      }
      messageReadAttempted = true;
      nativeReadOutcome = 'pending';
      try {
        const response = await readNativeMessage(peer, ids);
        const result = response && Object.getOwnPropertyDescriptor(response, 'result')?.value;
        const messages = response && Object.getOwnPropertyDescriptor(response, 'msgList')?.value;
        nativeReadOutcome = typeof result !== 'number' ? 'unclassified' : result !== 0 ? 'rejected' :
          !Array.isArray(messages) ? 'unclassified' : messages.length === 0 ? 'empty' : 'nonempty';
        if ((reverse || nativeSend) && nativeReadOutcome === 'nonempty') {
          const match = selectMessageReadback(response, peer, ids[0]);
          const bound = nativeSend ? bindOmittedReplyAccount(match, service.bridge.identity) : match;
          if (reverse) {
            savedReadback = { result: 0, msgList: bound ? [structuredClone(bound)] : [] };
            return savedReadback;
          }
          if (bound !== match) return { result: 0, msgList: [bound] };
        }
        return response;
      } catch (error) {
        nativeReadOutcome = 'failed';
        throw error;
      }
    };
  }
  const config = { projectRoot, token, port: 0, timeoutMs };
  async function verifyWebSocketReadback(connection, messageId, expected, readSignal) {
    if (connection?.readyState !== WebSocket.OPEN || readSignal.aborted) return false;
    const echo = randomBytes(16).toString('hex');
    const frames = on(connection, 'message', { signal: readSignal, close: ['close'] });
    allowSnapshotRead = true;
    try {
      connection.send(JSON.stringify({ action: 'get_msg', params: { message_id: messageId }, echo }));
      for await (const [bytes] of frames) {
        const readback = JSON.parse(bytes.toString());
        if (readback.echo !== echo) continue;
        return !readSignal.aborted && readback.retcode === 0 && isDeepStrictEqual(readback.data, expected);
      }
    } catch {} finally {
      allowSnapshotRead = false;
      await frames.return();
    }
    return false;
  }

  async function verifyReadback(address, messageId, sender, reverseSocket, forwardApi) {
    let verified = false;
    let outcome;
    let reverseVerified = false;
    let forwardVerified = false;
    const readController = new AbortController();
    messageReadSignal = AbortSignal.any([signal, readController.signal, AbortSignal.timeout(1000)]);
    try {
      const response = await fetch('http://' + address + '/get_msg?message_id=' + messageId, {
        headers: { Authorization: 'Bearer ' + token }, signal: messageReadSignal,
      });
      const reply = await response.json();
      verified = response.status === 200 && reply.retcode === 0 &&
        reply.data?.message_id === messageId && reply.data.group_id === Number(approvedGroup) &&
        reply.data.user_id === sender && reply.data.raw_message === approvedText;
      outcome = verified ? 'verified' : reply?.retcode === 0 ? 'response-mismatch' : 'onebot-rejected';
      if (verified && reverseSocket) {
        const forwardSignal = AbortSignal.any([signal, AbortSignal.timeout(750)]);
        messageReadSignal = forwardSignal;
        forwardVerified = await verifyWebSocketReadback(forwardApi, messageId, reply.data, forwardSignal);
        if (reverse.current() === reverseSocket && !signal.aborted) {
          const reverseSignal = AbortSignal.any([signal, AbortSignal.timeout(750)]);
          messageReadSignal = reverseSignal;
          reverseVerified = await verifyWebSocketReadback(reverseSocket, messageId, reply.data, reverseSignal) &&
            reverse.current() === reverseSocket;
        }
      }
    } catch {
      outcome = messageReadSignal.aborted ? 'deadline-or-cancelled' : 'transport-failed';
    } finally {
      readController.abort();
      messageReadSignal = undefined;
      savedReadback = undefined;
    }
    return { attempted: messageReadAttempted, verified, outcome, nativeOutcome: nativeReadOutcome ?? 'not-started',
      ...(reverseSocket && { forwardVerified, reverseVerified }) };
  }
  const session = { getMsgService: () => msg };
  if (nativeGroup) session.getGroupService = () => ({
    addKernelGroupListener(value) { groupListener = value; return 1; },
    removeKernelGroupListener() { groupListener = undefined; },
    getGroupDetailInfo(code, source) {
      signal.throwIfAborted();
      if (!groupReadSignal || groupReadSignal.aborted || code !== approvedGroup || source !== 1 || groupReadAttempted)
        throw new Error('Group query falls outside the fixed test');
      groupReadAttempted = true;
      return nativeGroup.getGroupDetailInfo(code, source);
    },
  });
  let service, residentBridge, controller, reusesPreLoginPort = false, activeChild;
  const previousReverseSocket = reverse?.current();
  let httpPortReused = false, webSocketPortReused = false;
  let socket, forwardApi;
  try {
    if (restartOneBot) {
      residentBridge = new NativeBridge({ session, identityProbe, timeoutMs,
        acceptProtectedChallenge: isVerifiedProtectedChallenge });
      const identityBefore = await residentBridge.attach();
      const originalListener = listener;
      const generation = residentBridge.generation;
      controller = preLoginOneBot?.controller ?? manageOneBotProcess(residentBridge, config);
      const original = await controller.start();
      activeChild = original;
      signal.throwIfAborted();
      if (preLoginOneBot) {
        if (original.instance !== preLoginOneBot.child.instance || original.port !== preLoginOneBot.child.port ||
            original.wsPort !== preLoginOneBot.child.wsPort)
          throw new Error('Pre-login OneBot endpoint was replaced');
        await controller.replaceBridge(residentBridge);
      }
      const child = await controller.restart();
      activeChild = child;
      signal.throwIfAborted();
      if (preLoginOneBot && child.instance !== original.instance) {
        httpPortReused = child.port === original.port;
        webSocketPortReused = child.wsPort === original.wsPort;
      }
      if (child.instance === original.instance || child.port !== original.port || child.wsPort !== original.wsPort ||
          listener !== originalListener || residentBridge.generation !== generation)
        throw new Error('OneBot restart changed the resident bridge');
      reusesPreLoginPort = Boolean(preLoginOneBot);
      onRestartVerified();
      // Reattach the adapter to the same resident session. The protocol child
      // keeps its port and inherited IPC channel throughout the reattachment.
      const identityAfter = await residentBridge.reattach();
      signal.throwIfAborted();
      if (identityAfter.sessionId !== identityBefore.sessionId ||
          identityAfter.user_id !== identityBefore.user_id || identityAfter.uid !== identityBefore.uid ||
          !listener || listener === originalListener || residentBridge.generation !== generation + 1)
        throw new Error('Bridge restart changed the resident session');
      onBridgeRestartVerified();
      service = { address: { port: child.port }, wsAddress: { port: child.wsPort }, bridge: residentBridge, close: controller.close };
    } else {
      service = await createSessionService({ ...config, session, identityProbe });
    }
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    const address = '127.0.0.1:' + service.address.port;
    const denied = await fetch('http://' + address + '/get_status', { signal: timeout });
    await denied.body?.cancel();
    if (denied.status !== 401) throw new Error('OneBot authentication check failed');
    if (restartOneBot) {
      const login = await fetch('http://' + address + '/get_login_info', {
        signal: timeout, headers: { Authorization: 'Bearer ' + token },
      });
      const proof = await login.json();
      if (login.status !== 200 || proof.retcode !== 0 || proof.data.user_id !== residentBridge.identity.user_id)
        throw new Error('OneBot did not verify the reattached bridge');
    }
    socket = new WebSocket('ws://127.0.0.1:' + service.wsAddress.port + '/event', { headers: { Authorization: 'Bearer ' + token } });
    socket.on('error', () => {});
    await once(socket, 'open', { signal: timeout });
    timeout.throwIfAborted();
    let reverseSocket;
    if (reverse) {
      while (!(reverseSocket = reverse.current()) || reverseSocket === previousReverseSocket)
        await delay(10, undefined, { signal: timeout });
      record('reverseConnected');
      const actions = await readOneBotSocketAction(reverseSocket, 'get_supported_actions', timeout);
      if (reverse.current() !== reverseSocket || !Array.isArray(actions) || !actions.includes('get_msg'))
        throw new Error('Reverse OneBot endpoint did not advertise message readback');
      forwardApi = new WebSocket(`ws://127.0.0.1:${service.wsAddress.port}/api`, { headers: { Authorization: 'Bearer ' + token } });
      forwardApi.on('error', () => {});
      await once(forwardApi, 'open', { signal: timeout });
      const forwardActions = await readOneBotSocketAction(forwardApi, 'get_supported_actions', timeout);
      if (!Array.isArray(forwardActions) || !forwardActions.includes('get_msg'))
        throw new Error('Forward OneBot API endpoint did not advertise message readback');
    }
    const raw = takeMessage();
    if (!raw) throw new Error('Recent inbound challenge unavailable');
    const sendText = (message) => fetch('http://' + address + '/send_group_msg', {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 1000)]),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ group_id: Number(raw.peerUid), message }),
    });
    if (!nativeSend) {
      const send = await sendText('receive-check');
      if (send.status !== 404 || (await send.json()).retcode !== 1404)
        throw new Error('Receive-only endpoint unexpectedly exposed a send action');
    }
    timeout.throwIfAborted();
    const matchEvent = connection => new Promise((resolve, reject) => {
      const abort = () => finish(new Error('OneBot receive check timed out'));
      const closed = () => finish(new Error('OneBot event connection closed during verification'));
      function finish(error, event) {
        connection.off('message', receive);
        connection.off('close', closed);
        timeout.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(event);
      }
      function receive(bytes) {
        try {
          const event = JSON.parse(bytes.toString());
          if (event.post_type === 'meta_event') return;
          if (event.post_type !== 'message' || event.message_type !== 'group' ||
              event.group_id !== Number(raw.peerUid) || event.user_id !== Number(raw.senderUin) ||
              !Number.isSafeInteger(event.message_id) || event.message_id < 1 ||
              event.message?.length !== 1 || event.message[0]?.type !== 'text' ||
              event.message[0]?.data?.text !== raw.elements[0].textElement.content)
            throw new Error('OneBot event did not match the challenge');
          finish(null, event);
        } catch (error) { finish(error); }
      }
      if (connection.readyState !== WebSocket.OPEN) { closed(); return; }
      connection.on('message', receive);
      connection.once('close', closed);
      timeout.addEventListener('abort', abort, { once: true });
      if (timeout.aborted) abort();
    });
    const matches = [matchEvent(socket)];
    if (reverseSocket) matches.push(matchEvent(reverseSocket));
    listener.onRecvMsg([raw]);
    const [forwardEvent, reverseEvent] = await Promise.all(matches);
    if (reverse) {
      if (!isDeepStrictEqual(reverseEvent, forwardEvent))
        throw new Error('Reverse event did not match the forward event');
      record('reverseEventVerified');
    }
    const receivedMessageId = forwardEvent.message_id;
    record('oneBotEventVerified');
    if (!nativeSend && readInboundMessage) {
      approvedGroup = raw.peerUid;
      approvedText = raw.elements[0].textElement.content;
      confirmedNativeId = raw.msgId;
      return { oneBotEventVerified: true, authenticatedLoopback: true, outboundAvailable: false,
        messageReadback: await verifyReadback(address, receivedMessageId, Number(raw.senderUin)) };
    }
    if (nativeSend) {
      signal.throwIfAborted();
      if (reverse && reverse.current() !== reverseSocket)
        throw new Error('Reverse OneBot connection changed before reply submission');
      if (forwardApi && forwardApi.readyState !== WebSocket.OPEN)
        throw new Error('Forward OneBot API connection closed before reply submission');
      approvedGroup = raw.peerUid;
      inboundNativeId = raw.msgId;
      approvedText = raw.elements[0].textElement.content.replace(/^whale-check-/, 'whale-reply-');
      if (!/^whale-reply-[a-f0-9]{32}$/.test(approvedText)) throw new Error('Invalid challenge reply');
      const response = await sendText(approvedText);
      const result = await response.json();
      const messageId = result?.data?.message_id;
      onSendResponse({
        httpStatus: response.status,
        retcode: Number.isSafeInteger(result?.retcode) ? result.retcode : null,
      });
      if (response.status !== 200 || result?.retcode !== 0 || !progress.nativeSubmissionAttempted ||
          !Number.isSafeInteger(messageId) || messageId < 1 || messageId > 2147483647 || messageId === receivedMessageId)
        throw new Error('OneBot send did not produce a terminal confirmation');
      const terminal = service.bridge.messages.get(messageId);
      if (terminal.chatType !== 2 || terminal.peerUid !== approvedGroup ||
          String(terminal.senderUin) !== String(service.bridge.identity?.user_id) ||
          typeof terminal.msgId !== 'string' || !/^[1-9]\d{0,127}$/.test(terminal.msgId) ||
          terminal.msgId === correlation || terminal.msgId === raw.msgId)
        throw new Error('OneBot send did not produce a distinct terminal native message ID');
      confirmedNativeId = terminal.msgId;
      progress.terminalMessageIdVerified = true;
      record('oneBotSendConfirmed');
      onConfirmedReply({ group: approvedGroup, nativeId: confirmedNativeId, text: approvedText });
      if (msg.getMsgsByMsgId) {
        onMessageRead(await verifyReadback(address, messageId, service.bridge.identity?.user_id, reverseSocket, forwardApi));
      }
      if (nativeGroup) {
        let verified = false;
        let handle;
        const controller = new AbortController();
        groupReadSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(1000)]);
        try {
          groupReadSignal.throwIfAborted();
          const registration = nativeGroup.addKernelGroupListener({
            onGroupDetailInfoChange(detail) {
              if (!groupReadSignal.aborted) groupListener?.onGroupDetailInfoChange(detail);
            },
          });
          if (!((Number.isSafeInteger(registration) && registration >= 0) ||
              (typeof registration === 'string' && registration.length > 0 && registration.length <= 256)))
            throw new Error('Native group listener returned no usable handle');
          handle = registration;
          const response = await fetch('http://' + address + '/get_group_info?group_id=' + approvedGroup, {
            headers: { Authorization: 'Bearer ' + token },
            signal: groupReadSignal,
          });
          const result = await response.json();
          verified = response.status === 200 && result.retcode === 0 &&
            result.data?.group_id === Number(approvedGroup) && typeof result.data.group_name === 'string' &&
            Number.isSafeInteger(result.data.member_count) && Number.isSafeInteger(result.data.max_member_count);
        } catch {}
        finally {
          controller.abort();
          if (handle !== undefined) {
            try { nativeGroup.removeKernelGroupListener(handle); } catch {}
          }
        }
        onGroupRead({ attempted: groupReadAttempted, verified });
      }
      return { oneBotEventVerified: true, authenticatedLoopback: true, oneBotSendConfirmed: true };
    }
    return { oneBotEventVerified: true, authenticatedLoopback: true, outboundAvailable: false };
  } finally {
    forwardApi?.terminate();
    socket?.terminate();
    try {
      if (preLoginOneBot && controller) {
        let offlineRestored = false;
        const splitPorts = preLoginOneBot.child.wsPort !== preLoginOneBot.child.port;
        let httpOfflineVerified = false;
        let webSocketOfflineVerified = false;
        let reverseOfflineVerified = false;
        try {
          await controller.replaceBridge(new OfflineBridge());
          if (activeChild) {
            const status = await checkOfflineOneBot(activeChild.port, token, undefined, activeChild.wsPort,
              () => { httpOfflineVerified = true; });
            webSocketOfflineVerified = status.authenticatedOfflineWebSocket === true;
            if (reverse) {
              await checkOfflineRoundtripReverse(reverse, undefined, previousReverseSocket);
              reverseOfflineVerified = true;
            }
            offlineRestored = true;
          }
        } catch {
          // Any failure to verify the fallback leaves no business endpoint.
        }
        if (offlineRestored) preLoginOneBot.child = activeChild;
        else try { await controller.stopOffline(); } catch {}
        onEndpointCheck({ reusesPreLoginPort, offlineRestored, ...(reverse && { reverseOfflineVerified }), ...((splitPorts || reverse) && {
          httpPortReused, webSocketPortReused, httpOfflineVerified, webSocketOfflineVerified,
        }) });
      } else if (service) await service.close();
      else await controller?.close();
    } finally {
      residentBridge?.detach();
      if (nativeSend && service) onBridgeStats({ ...service.bridge.stats });
    }
  }
}
