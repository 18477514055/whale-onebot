import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { on, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { NativeBridge } from '../bridge/native-bridge.mjs';
import { manageOneBotProcess } from './onebot-process.mjs';
import { isVerifiedProtectedChallenge } from './inbound-challenge.mjs';
import { BOT_UIN } from '../config/account.mjs';

const leasedProtectedChallenges = new WeakSet();

export async function openReadOnlySession({ session, identityProbe, projectRoot, group, token, signal, challenge, leaseMs = 10000 }) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 20000)
    throw new TypeError('Invalid read-only session lease');
  signal.throwIfAborted();
  const protectedChallenge = isVerifiedProtectedChallenge(challenge) ? challenge : undefined;
  if (protectedChallenge && protectedChallenge.peerUid !== String(group))
    throw new TypeError('Protected challenge does not belong to this read-only group');
  if (protectedChallenge) {
    if (leasedProtectedChallenges.has(protectedChallenge)) throw new TypeError('Protected challenge has already been leased');
    leasedProtectedChallenges.add(protectedChallenge);
  }
  const readOnlyChallengeText = protectedChallenge?.elements[0]?.textElement?.content;
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(leaseMs)]);
  let protectedForwarded = false;
  const bridge = new NativeBridge({ session, identityProbe: async () => {
    lifetime.throwIfAborted();
    return identityProbe();
  }, acceptProtectedChallenge(raw) {
    if (lifetime.aborted || protectedForwarded || raw !== protectedChallenge || !isVerifiedProtectedChallenge(raw)) return false;
    protectedForwarded = true;
    return true;
  } });
  const controller = manageOneBotProcess(bridge, { projectRoot, token, readOnly: true, readOnlyGroup: group,
    ...(readOnlyChallengeText !== undefined && { readOnlyChallengeText }),
    port: 0, wsPort: 0, agentPlusCompatibility: true });
  let closing;
  const close = () => closing ??= Promise.resolve().then(async () => {
    lifetime.removeEventListener('abort', onAbort);
    bridge.detach();
    await controller.close();
  });
  const onAbort = () => { void close().catch(() => {}); };
  lifetime.addEventListener('abort', onAbort, { once: true });
  try {
    await bridge.attach();
    lifetime.throwIfAborted();
    const child = await controller.start();
    lifetime.throwIfAborted();
    const active = () => !closing && !lifetime.aborted && controller.isCurrent(child);
    return { port: child.port, wsPort: child.wsPort, close, active, replayChallenge(message) {
      if (!active() || message?.chatType !== 2 || message.peerUid !== String(group))
        throw new Error('Read-only challenge is outside the active test group');
      bridge.receive([message], false);
    } };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function verifyReadOnlySession(options) {
  const { group, challenge, signal, AgentClient } = options;
  const expectedText = challenge?.elements?.[0]?.textElement?.content;
  if (typeof expectedText !== 'string' || !/^whale-check-[a-f0-9]{32}$/.test(expectedText))
    throw new TypeError('Invalid read-only challenge text');
  const token = randomBytes(24).toString('hex');
  const endpoint = await openReadOnlySession({ ...options, token });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const headers = { Authorization: 'Bearer ' + token };
  let ws, client;
  try {
    const call = async action => (await fetch('http://127.0.0.1:' + endpoint.port + '/' + action,
      { headers, signal: deadline })).json();
    const identity = (await call('get_login_info')).data;
    assert.equal(identity?.user_id, Number(BOT_UIN));
    assert.equal((await call('get_friend_list')).retcode, 1403);
    const actions = (await call('get_supported_actions')).data;
    assert(Array.isArray(actions) && actions.includes('get_group_info') && !actions.includes('send_group_msg'));
    assert.equal((await call('get_group_info?group_id=' + group)).data?.group_id, Number(group));
    const matches = event => event?.post_type === 'message' && event.message_type === 'group' &&
      event.self_id === identity.user_id && event.group_id === Number(group) &&
      event.user_id === Number(challenge.senderUin) && event.raw_message === expectedText &&
      Number.isSafeInteger(event.message_id) && event.message_id > 0;
    const verified = { authenticatedLoopback: true, readOnly: true, groupScoped: true, groupInfoVerified: true,
      webSocketVerified: true, challengeEventVerified: true };
    if (AgentClient) {
      let matched = false;
      client = new AgentClient({ wsUrl: 'ws://127.0.0.1:' + endpoint.wsPort,
        httpUrl: 'http://127.0.0.1:' + endpoint.port, accessToken: token,
        onEvent(event) { if (matches(event)) matched = true; } });
      await client.connect();
      while (!client.selfId) await delay(20, undefined, { signal: deadline });
      assert.equal(client.selfId, String(identity.user_id));
      assert.equal((await client.call('get_group_info', { group_id: Number(group) }, 2000, deadline)).group_id, Number(group));
      endpoint.replayChallenge(challenge);
      while (!matched) await delay(20, undefined, { signal: deadline });
      return { ...verified, agentClientVerified: true };
    }
    ws = new WebSocket('ws://127.0.0.1:' + endpoint.wsPort + '/', { headers });
    ws.on('error', () => {});
    await once(ws, 'open', { signal: deadline });
    const frames = on(ws, 'message', { signal: deadline, close: ['close'] });
    try {
      endpoint.replayChallenge(challenge);
      for await (const [bytes] of frames) {
        const event = JSON.parse(bytes.toString());
        if (matches(event)) return verified;
      }
      throw new Error('Read-only event socket closed before the challenge');
    } finally { await frames.return(); }
  } finally {
    client?.close();
    ws?.terminate();
    await endpoint.close();
  }
}
