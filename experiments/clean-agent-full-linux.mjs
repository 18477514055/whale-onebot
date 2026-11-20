import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Duplex } from 'node:stream';
import { NativeBridge } from '../src/bridge/native-bridge.mjs';
import { BridgeError } from '../src/bridge/error.mjs';
import { manageOneBotProcess } from '../src/host/onebot-process.mjs';
import { createModelBroker } from '../src/host/full-agent-model-broker.mjs';
import { BOT_UIN } from '../src/config/account.mjs';

// An experiment-only gate. It is NOT the real-QQ administrator challenge grant.
// Real-host integration requires its own branded, persistent, bounded capability.
export class SyntheticAgentGate extends EventEmitter {
  constructor(bridge, groupId) {
    super(); this.bridge = bridge; this.groupId = groupId; this.blockedEvents = 0;
    this.blockedCalls = 0;
    this.forward = event => {
      if (event.post_type === 'message' && event.message_type === 'group' && event.group_id === groupId)
        this.emit('event', event);
      else this.blockedEvents++;
    };
    bridge.on('event', this.forward);
    this.offline = value => this.emit('offline', value);
    bridge.on('offline', this.offline);
    this.ready = value => this.emit('bridge-ready', value);
    bridge.on('bridge-ready', this.ready);
  }
  get attached() { return this.bridge.attached; }
  probe() { return this.bridge.probe(); }
  capabilities() {
    const safe = new Set(['get_login_info', 'get_status', 'get_group_info', 'get_group_member_list',
      'get_group_member_info', 'get_msg', 'send_group_msg']);
    return this.bridge.capabilities().filter(action => safe.has(action));
  }
  call(action, params, ...rest) {
    if (!this.capabilities().includes(action) ||
        (action.includes('group') && Number(params?.group_id) !== this.groupId)) {
      this.blockedCalls++;
      throw new BridgeError('TEST_SCOPE_DENIED', 'Synthetic test scope denied', { retcode: 1403 });
    }
    return this.bridge.call(action, params, ...rest);
  }
  close() { this.bridge.off('event', this.forward); this.bridge.off('offline', this.offline); this.bridge.off('bridge-ready', this.ready); }
}
const nonce = () => randomBytes(12).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function poll(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(label);
}
export async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.QQ_AGENT_DATA_DIR, '/working');
  assert(!fs.existsSync('/mnt') && !fs.existsSync('/app/data'));
  assert.deepEqual(fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1), []);
  assert(!fs.existsSync('/working/messages.sqlite'), 'FRESH_DATABASE_REQUIRED');
  const namespaces = Object.fromEntries(['net', 'pid', 'mnt', 'user'].map(name => [name, fs.readlinkSync(`/proc/self/ns/${name}`)]));
  const token = randomBytes(24).toString('hex'), upstreamKey = `synthetic-${nonce()}`;
  const bot = Number(BOT_UIN), groupId = 123456, senderId = 10001, botUid = 'u_clean_bot';
  let current, modelFault, listener, groupListener, online = true, observedBot = bot;
  let registrations = 0, removals = 0, agent, exitPromise, broker, controller;
  const sent = new Map(), runs = [], appLogs = [], negativeTexts = [];
  const channelMode = process.env.WHALE_CLEAN_MODEL_CHANNEL === '1';
  const realModel = process.env.WHALE_CLEAN_REAL_MODEL === '1';
  assert(!realModel || channelMode);
  const configuredModel = realModel ? 'deepseek-v4.1-flash' : 'clean-fixture-model';
  let modelRequests = 0, inspectTerminalOutbox;
  const requestCount = () => channelMode ? broker.stats().requests : modelRequests;
  function observeModelRequest(body) {
    if (!current || !JSON.stringify(body.messages).includes(current.incoming)) return null;
    current.modelSawIncoming = true;
    const toolId = `clean_${current.name}`;
    const result = realModel
      ? body.messages.findLast(item => item.role === 'tool' && /"messageIds"/.test(String(item.content)))
      : body.messages.find(item => item.role === 'tool' && item.tool_call_id === toolId);
    if (result) {
      const id = /"messageIds"\s*:\s*\[\s*"?(\d+)"?\s*\]/.exec(String(result.content))?.[1];
      assert(id && Number(id) > 0); current.terminalId = Number(id);
      assert(inspectTerminalOutbox(current.terminalId), 'TERMINAL_OUTBOX_NOT_OBSERVED');
      current.outboxTerminalObserved = true; current.modelGotResult = true;
    }
    return { toolId, result };
  }
  const upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, `Bearer ${upstreamKey}`);
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 2097152); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks)); modelRequests++;
      let message = { role: 'assistant', content: '' };
      const observed = observeModelRequest(body);
      if (observed && !observed.result) {
        assert(body.tools?.some(tool => tool.function?.name === 'send_message'));
        message = { role: 'assistant', content: null, tool_calls: [{ id: observed.toolId, type: 'function',
          function: { name: 'send_message', arguments: JSON.stringify({ messages: current.reply }) } }] };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    } catch { modelFault = true; res.writeHead(400).end('{}'); }
  });
  const msg = {
    addKernelMsgListener(value) { listener = value; return ++registrations; },
    removeKernelMsgListener() { removals++; listener = undefined; },
    generateMsgUniqueId() { return current.correlation; },
    sendMsg(first, peer, elements, extension) {
      assert.equal(first, '0'); assert(extension instanceof Map);
      assert.deepEqual(peer, { chatType: 2, peerUid: String(groupId), guildId: current.correlation });
      assert.equal(++current.nativeSends, 1, 'DUPLICATE_SYNTHETIC_SEND');
      assert.deepEqual(elements.map(item => [item.elementType, item.textElement?.content]), [[1, current.reply]]);
      const record = { ...peer, msgId: current.nativeId, senderUid: botUid,
        msgTime: String(Math.floor(Date.now() / 1000)), sendStatus: 2, elements };
      sent.set(record.msgId, record);
      const { elements: _elements, ...receipt } = record; listener.onMsgInfoListUpdate([receipt]);
      return { result: 0 };
    },
    getMsgsByMsgId(peer, ids) {
      assert.deepEqual(peer, { chatType: 2, peerUid: String(groupId), guildId: '' });
      assert.equal(ids.length, 1); assert(sent.has(ids[0]));
      return { result: 0, msgList: [sent.get(ids[0])] };
    },
  };
  const groups = {
    addKernelGroupListener(value) { groupListener = value; return 1; }, removeKernelGroupListener() { groupListener = undefined; },
    getGroupDetailInfo(code) { assert.equal(code, String(groupId));
      groupListener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Clean Lab', memberNum: 2, maxMemberNum: 100, shutUpAllTimestamp: 0 });
      return { result: 0 }; },
    getAllMemberList(code) { assert.equal(code, String(groupId)); return { errCode: 0, result: { finish: true, infos: new Map([
      [botUid, { uid: botUid, uin: String(bot), nick: 'Clean Lab', role: 0, shutUpTime: 0 }],
      ['u_clean_sender', { uid: 'u_clean_sender', uin: String(senderId), nick: 'Synthetic sender', role: 0, shutUpTime: 0 }],
    ]) } }; },
  };
  const bridge = new NativeBridge({ session: { getMsgService: () => msg, getGroupService: () => groups },
    identityProbe: async () => ({ user_id: observedBot, uid: botUid, nickname: 'Clean Lab', online, sessionId: 'new-synthetic-session' }) });
  const gate = new SyntheticAgentGate(bridge, groupId);
  const consoleReservation = net.createServer(); const consolePort = await listen(consoleReservation);
  await new Promise(resolve => consoleReservation.close(resolve));
  function inbound(text, id, group = groupId) {
    return { chatType: 2, peerUid: String(group), msgId: String(id), msgSeq: String(id),
      msgTime: String(Math.floor(Date.now() / 1000)), senderUin: String(senderId), senderUid: 'u_clean_sender', sendNickName: 'Synthetic sender',
      elements: [{ elementType: 1, textElement: { content: '@Clean Lab', atType: 2, atUid: String(bot), atNtUid: botUid } },
        { elementType: 1, textElement: { content: text } }] };
  }
  async function startAgent() {
    const logs = { stdout: '', stderr: '' }; appLogs.push(logs);
    agent = spawn(process.execPath, ['--import', '/project/experiments/clean-agent-preload.mjs', '/app/src/server.js'], {
      cwd: '/app', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/bin', HOME: '/lab-home', TMPDIR: '/tmp',
        QQ_AGENT_DATA_DIR: '/working', WHALE_CLEAN_AGENT_PRELOAD: '1', WHALE_ONEBOT_TOKEN: token } });
    for (const name of ['stdout', 'stderr']) agent[name].on('data', chunk => {
      logs[name] += chunk; if (logs[name].length > 4194304) agent.kill('SIGTERM');
    });
    exitPromise = once(agent, 'exit');
    await poll(async () => {
      if (agent.exitCode !== null || agent.signalCode !== null) throw new Error('AGENT_START_EXIT');
      try { const res = await fetch(`http://127.0.0.1:${consolePort}/healthz`, { signal: AbortSignal.timeout(1000) });
        return res.ok && (await res.json()).onebotConnected; } catch { return false; }
    }, 'AGENT_CONNECT_TIMEOUT');
  }
  async function stopAgent() {
    if (!agent) return;
    agent.kill('SIGTERM'); const kill = setTimeout(() => agent.kill('SIGKILL'), 5000);
    try { const [code, signal] = await exitPromise; assert.equal(code, 0); assert.equal(signal, null); }
    finally { clearTimeout(kill); agent = undefined; }
  }
  try {
    if (channelMode) {
      assert.equal(process.env.WHALE_E2E_MODEL_API_KEY, undefined);
      assert.equal(process.env.OPENCODE_API_KEY, undefined);
      const { createChannelModelRelay } = await import('../scripts/lib/clean-agent-model-channel.mjs');
      const stream = Duplex.from({ readable: process.stdin, writable: process.stdout });
      stream.on('error', () => {});
      broker = createChannelModelRelay(stream, { model: configuredModel, maxRequests: realModel ? 6 : 16, timeoutMs: realModel ? 120000 : 20000 });
      // Observe only this synthetic model exchange, including the terminal outbox
      // while the second model round is still pending. Do not alter its payload.
      broker.server.on('request', req => {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return;
        let bytes = 0; const chunks = [];
        req.on('data', chunk => { bytes += chunk.length; if (bytes <= 2097152) chunks.push(chunk); });
        req.on('end', () => {
          try { assert(bytes <= 2097152); observeModelRequest(JSON.parse(Buffer.concat(chunks))); }
          catch { modelFault = true; }
        });
      });
    } else {
      const upstreamPort = await listen(upstream);
      broker = createModelBroker({ baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: upstreamKey,
        model: 'clean-fixture-model', maxRequests: 16, maxTokens: 512, allowLoopbackUpstream: true });
    }
    const brokerPort = await listen(broker.server);
    fs.mkdirSync('/working/qq-onebot');
    await bridge.attach();
    controller = manageOneBotProcess(gate, { token, port: 0, wsPort: 0, projectRoot: '/working/qq-onebot', agentPlusCompatibility: true });
    const first = await controller.start();
    fs.writeFileSync('/working/config.json', JSON.stringify({
      onebot: { wsUrl: `ws://127.0.0.1:${first.wsPort}`, httpUrl: `http://127.0.0.1:${first.port}`,
        accessToken: '', httpAccessToken: '', catchupReplyWindowMs: 0 },
      server: { host: '127.0.0.1', port: consolePort, strictPort: true, token: '' },
      api: { baseUrl: `http://127.0.0.1:${brokerPort}/v1`, apiKey: '', model: configuredModel,
        priceRemoteUrl: 'none', channelPriceFeeds: [], vision: false, maxRounds: 3, maxRunTokens: realModel ? 64000 : 4096,
        ...(realModel ? { extraBody: { max_tokens: 4096 }, timeoutMs: 120000, runTimeoutMs: 240000 } : {}) },
      persona: { botName: 'Clean Lab', templateId: '', roleText: 'Isolated synthetic test. Use send_message exactly once when asked.' },
      allow: { groups: [groupId], private: [] }, allowAllWhenEmpty: false,
      runtime: { mode: 'active', paused: false }, timeControl: { enabled: false },
      wakeDelayMs: 100, wakeDelayMinMs: 100, wakeDelayMaxMs: 100, drainDelayMs: 100, maxBatchWaitMs: 500,
      plugins: { enabled: false }, autoUpdate: { enabled: false }, webSearch: { enabled: false },
      conversation: { replyGuardEnabled: false },
    }), { mode: 0o600 });
    await startAgent();
    const { DatabaseSync } = await import('node:sqlite');
    inspectTerminalOutbox = messageId => {
      const db = new DatabaseSync('/working/messages.sqlite', { readOnly: true });
      try { return db.prepare("SELECT count(*) AS n FROM outbox WHERE chat_key=? AND state='sent' AND message_id=?")
        .get(`group:${groupId}`, String(messageId)).n === 1; }
      finally { db.close(); }
    };
    function count(text, acknowledgedOnly = false) {
      const db = new DatabaseSync('/working/messages.sqlite', { readOnly: true });
      try { return db.prepare("SELECT count(*) AS n FROM messages WHERE instr(text, ?) > 0 AND (?=0 OR state='acked')")
        .get(text, acknowledgedOnly ? 1 : 0).n; }
      finally { db.close(); }
    }
    async function verify(name, index) {
      await delay(1100); // Honor the real protocol/native rate guard, even for synthetic sends.
      const caseNonce = nonce();
      current = { name, incoming: `clean-in-${name}-${caseNonce}`, reply: `clean-reply-${caseNonce}`,
        eventId: 1900000000 + index * 10, correlation: String(90071992547410000n + BigInt(index) * 10n),
        nativeId: String(90071992547410001n + BigInt(index) * 10n), nativeSends: 0 };
      if (realModel) current.incoming += ` Please call send_message exactly once with messages set to ${current.reply}. Send just that plain text, with no prefix or suffix. This is a synthetic tool with no QQ connection.`;
      listener.onRecvMsg([inbound(current.incoming, current.eventId)]);
      await poll(() => { if (modelFault) throw new Error('MODEL_FIXTURE_FAULT');
        return current.modelGotResult && count(current.incoming, true) === 1; }, 'TOOL_RESULT_TIMEOUT', realModel ? 240000 : 30000);
      assert.equal(count(current.incoming), 1); assert(current.modelSawIncoming); assert.equal(current.nativeSends, 1);
      const result = await fetch(`http://127.0.0.1:${first.port}/get_msg?message_id=${current.terminalId}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
      const body = await result.json(); assert.equal(body.retcode, 0);
      assert.equal(body.data.raw_message, current.reply); assert.equal(body.data.group_id, groupId); assert.equal(body.data.user_id, bot);
      assert.equal(current.outboxTerminalObserved, true);
      runs.push({ name, inboundRows: 1, modelSawIncoming: true, toolResultReturned: true,
        nativeSends: 1, terminalReadback: true, terminalOutboxObservedBeforeAck: true });
      const saved = current; current = undefined; return saved;
    }
    const saved = await verify('initial', 0);
    async function waitOnline() {
      await poll(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${first.port}/get_status`, {
            headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
          const value = await response.json();
          const health = await fetch(`http://127.0.0.1:${consolePort}/healthz`, { signal: AbortSignal.timeout(1000) });
          return value.retcode === 0 && value.data.online === true && (await health.json()).onebotConnected;
        } catch { return false; }
      }, 'RECOVERY_ONLINE_TIMEOUT');
    }
    if (!realModel) {
    const previous = await controller.restart(); assert.notEqual(previous.instance, first.instance);
    assert.deepEqual([previous.port, previous.wsPort], [first.port, first.wsPort]); await waitOnline();
    await verify('protocolRestart', 1);
    await stopAgent(); await startAgent(); assert.equal(count(saved.incoming), 1);
    await verify('appRestart', 2);
    let id = 1900010000;
    const retired = listener; await bridge.reattach(); await waitOnline();
    await verify('bridgeReattached', 3);
    const beforeRequests = requestCount(), beforeSends = sent.size;
    const outside = `negative-other-group-${nonce()}`; negativeTexts.push(outside);
    listener.onRecvMsg([inbound(outside, id++, groupId + 1)]); await delay(300);
    const stale = `negative-retired-${nonce()}`; negativeTexts.push(stale); retired.onRecvMsg([inbound(stale, id++)]);
    for (const kind of ['offline', 'wrongAccount']) {
      const text = `negative-${kind}-${nonce()}`; negativeTexts.push(text);
      if (kind === 'offline') online = false; else observedBot = bot + 1;
      listener.onRecvMsg([inbound(text, id++)]);
      await poll(() => !bridge.attached, 'NEGATIVE_IDENTITY_NOT_DETACHED');
      online = true; observedBot = bot; await bridge.attach();
    }
    await delay(1200);
    for (const text of negativeTexts) assert.equal(count(text), 0);
    assert.equal(requestCount(), beforeRequests); assert.equal(sent.size, beforeSends); assert.equal(sent.size, 4);
    await waitOnline(); await verify('identityRestored', 4); assert.equal(sent.size, 5);
    }
    await stopAgent();
    // Verify credentials never entered the new application data, including SQLite bytes.
    let scannedBytes = 0, scannedFiles = 0;
    function scan(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
        assert(!stat.isSymbolicLink()); if (stat.isDirectory()) { scan(file); continue; }
        assert(stat.isFile()); scannedBytes += stat.size; assert(scannedBytes < 268435456);
        const bytes = fs.readFileSync(file); assert(!bytes.includes(Buffer.from(token))); assert(!bytes.includes(Buffer.from(upstreamKey))); scannedFiles++;
      }
    }
    scan('/working'); scan('/lab-home'); scan('/tmp');
    for (const log of appLogs) for (const text of Object.values(log)) {
      assert(!text.includes(token) && !text.includes(upstreamKey));
    }
    const cfg = JSON.parse(fs.readFileSync('/working/config.json', 'utf8'));
    assert.equal(cfg.api.apiKey, ''); assert.equal(cfg.onebot.accessToken, ''); assert.equal(cfg.server.token, '');
    return { passed: true, privateNetwork: true, freshDatabase: true, fullApplication: true,
      entry: '/app/src/server.js', instrumentation: 'SHA-pinned constructor-local environment token injection', namespaces,
      syntheticQQ: true, realQQ: false, realModel, realSends: 0, runs,
      negativeCases: realModel ? { executed: false } : { outsideGroup: true, retiredListener: true, offline: true, wrongAccount: true, noRowsNoModelNoSends: true },
      modelRequests: requestCount(), broker: broker.stats(), modelTransport: channelMode ? 'external-credential-broker-over-stdio' : 'local-synthetic-broker',
      registrations, removals, secretsAbsentFromDataAndLogs: true, scannedFiles,
      appLogs: appLogs.map(log => Object.fromEntries(Object.entries(log).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: sha(text) }]))),
      limitations: [realModel ? 'Real OpenCode model with synthetic native QQ only; not real QQ acceptance. Restart/negative matrix was not run in real-model mode.' : 'Synthetic model and synthetic native QQ services only; not real QQ or real-model acceptance.',
        'No historical/production data or existing phone environment used. No real administrator challenge permission consumed.'] };
  } finally {
    let cleanupFailed = false;
    const cleanup = async operation => { try { await operation(); } catch { cleanupFailed = true; } };
    if (agent) await cleanup(stopAgent);
    await cleanup(() => controller?.close());
    await cleanup(() => { gate.close(); bridge.detach(); });
    await cleanup(() => broker?.close());
    await cleanup(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
    await cleanup(() => {
      for (let index = 0; index < appLogs.length; index++) for (const [name, text] of Object.entries(appLogs[index])) {
        const safe = text.split(token).join('[REDACTED_ONEBOT_TOKEN]').split(upstreamKey).join('[REDACTED_SYNTHETIC_MODEL_KEY]');
        fs.writeFileSync(`/working/app-${index}.${name}.txt`, safe, { flag: 'wx', mode: 0o600 });
      }
    });
    if (cleanupFailed) throw new Error('CLEAN_AGENT_CLEANUP_FAILED');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = JSON.stringify(await main());
    if (process.env.WHALE_CLEAN_MODEL_CHANNEL === '1') console.error('CLEAN_AGENT_FULL_RESULT=' + report);
    else console.log(report);
  }
  catch (error) { console.error(JSON.stringify({ passed: false, code: error.code || error.name,
    stage: /^[A-Z_]+$/.test(error.message) ? error.message : 'CLEAN_AGENT_ASSERTION_FAILED' })); process.exitCode = 1; }
}
