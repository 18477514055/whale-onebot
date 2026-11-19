import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket, WebSocketServer} from 'ws';
import {NativeBridge} from '../src/bridge/native-bridge.mjs';
import {manageOneBotProcess, startOneBotProcess} from '../src/host/onebot-process.mjs';
import {openReadOnlySession} from '../src/host/read-only-session.mjs';
import {IPCBridge, serveBridgeIPC} from '../src/host/bridge-ipc.mjs';
import {checkOfflineOneBot, checkOfflineRoundtripReverse, openRoundtripReverseReceiver} from '../src/host/onebot-receive-check.mjs';
import {OfflineBridge, OneBotCore} from '../src/core.mjs';
import {createOneBotService, createSessionService} from '../src/service.mjs';
import { BOT_UIN, OWNER_UIN } from '../src/config/account.mjs';
const parentRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.tmp');
function root(t, close=()=>{}) {
  fs.mkdirSync(parentRoot,{recursive:true});
  const parent=fs.mkdtempSync(path.join(parentRoot,'service-'));
  const root=path.join(parent,'qq-onebot');
  fs.mkdirSync(root);
  t.after(async()=>{
    await close();
    const resolved=fs.realpathSync(parent);
    assert.equal(path.dirname(resolved),fs.realpathSync(parentRoot));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return root;
}
test('the scoped read-only session closes both ports and detaches its listener on cancellation', async t => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  let registrations = 0, removals = 0;
  const token = 'synthetic-read-only-session';
  const endpoint = await openReadOnlySession({ projectRoot: root(t), group: '20001', token,
    signal: lifetime.signal, session: { getMsgService: () => ({
      addKernelMsgListener() { return ++registrations; }, removeKernelMsgListener() { removals++; },
    }) }, identityProbe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'scoped-fixture' }) });
  t.after(() => endpoint.close());
  assert(endpoint.active());
  assert.notEqual(endpoint.port, endpoint.wsPort);
  const response = await fetch('http://127.0.0.1:' + endpoint.port + '/get_login_info',
    { headers: { Authorization: 'Bearer ' + token } });
  assert.equal((await response.json()).data.user_id, Number(BOT_UIN));
  lifetime.abort();
  assert(!endpoint.active());
  await endpoint.close();
  assert.equal(registrations, 1);
  assert.equal(removals, 1);
  for (const port of [endpoint.port, endpoint.wsPort])
    await assert.rejects(fetch('http://127.0.0.1:' + port + '/get_status', { signal: AbortSignal.timeout(1000) }));
});

test('composed session service refreshes proof without logging in and closes resources',async t=>{
  let probes=0,attached=0,removed=0;
  const app=await createSessionService({projectRoot:root(t),token:'synthetic-token-0123456789',port:0,timeoutMs:1000,proofMaxAgeMs:200,verifyEveryMs:20,
    session:{getMsgService:()=>({addKernelMsgListener:()=>++attached,removeKernelMsgListener:()=>removed++})},
    identityProbe:async()=>{probes++;return {user_id:Number(BOT_UIN),online:true,sessionId:'fixture'};}});
  await new Promise(resolve=>setTimeout(resolve,250));assert(probes>3);assert.equal(attached,1);assert.equal(app.core.status().good,true);
  assert.equal(app.core.metrics.calls,0);
  const closing=app.close();
  assert.equal(app.close(),closing);
  await closing;assert.equal(removed,1);assert.equal(app.core.status().online,false);
});

test('background identity loss detaches once and stops future probes', async t=>{
  let probes=0, removed=0, online=true;
  let app;
  app=await createSessionService({projectRoot:root(t,()=>app?.close()),token:'synthetic-token-0123456789',
    port:0,timeoutMs:1000,proofMaxAgeMs:100,verifyEveryMs:10,
    session:{getMsgService:()=>({addKernelMsgListener:()=>1,removeKernelMsgListener:()=>removed++})},
    identityProbe:async()=>{probes++;return {user_id:Number(BOT_UIN),online,sessionId:'fixture'};}});
  const offline=once(app.bridge,'offline',{signal:AbortSignal.timeout(1000)});
  online=false;
  await offline;
  const stoppedAt=probes;
  await delay(40);
  assert.equal(probes,stoppedAt);
  assert.equal(removed,1);
  assert.equal(app.core.metrics.calls,0);
  assert.deepEqual(app.core.status(),{online:false,good:false});
});

test('resident child can replace the offline bridge without dropping its listening socket', async t => {
  let listener, submissions = 0;
  const msg = {
    addKernelMsgListener(value) { listener = value; return 1; },
    removeKernelMsgListener() {},
    generateMsgUniqueId() { return '90071992547409930'; },
    sendMsg(_first, peer, elements) {
      submissions++;
      listener.onMsgInfoListUpdate([{ ...peer, elements, senderUin: BOT_UIN,
        msgId: '90071992547409942', sendStatus: 2 }]);
      return { result: 0 };
    },
  };
  const resident = new NativeBridge({ session: { getMsgService: () => msg },
    identityProbe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-offline-start' }) });
  let controller;
  const projectRoot = root(t, async () => {
    try { await controller?.close(); }
    finally { resident.detach(); }
  });
  const token = 'synthetic-offline-start-token';
  controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0, startOffline: true,
    verifyEveryMs: 10000, proofMaxAgeMs: 30000 });
  const child = await controller.start();
  const headers = { Authorization: 'Bearer ' + token, Connection: 'close' };
  const base = '127.0.0.1:' + child.port;
  const call = async (action, params = {}) => {
    const response = await fetch('http://' + base + '/' + action, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      signal: AbortSignal.timeout(3000) });
    return response.json();
  };
  const send = () => call('send_group_msg', { group_id: 20001, message: 'fixture' });
  assert.deepEqual((await call('get_status')).data, { online: false, good: false });
  assert.notEqual((await send()).retcode, 0);
  assert.equal(submissions, 0);
  assert.equal(resident.attached, false);
  const socket = new WebSocket('ws://' + base + '/event', { headers: { Authorization: headers.Authorization } });
  t.after(() => socket.terminate());
  const signal = AbortSignal.timeout(3000);
  const events = Promise.withResolvers();
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.post_type === 'message') events.resolve(event);
  });
  await once(socket, 'open', { signal });
  await resident.attach();
  await controller.replaceBridge(resident);
  let msgId = 90071992547409950n;
  const publisher = setInterval(() => listener.onRecvMsg([{ chatType: 2, peerUid: '20001',
    senderUin: '10001', msgId: String(msgId++), msgTime: '1700000000',
    elements: [{ elementType: 1, textElement: { content: 'after attach' } }] }]), 35);
  try {
    const event = await Promise.race([events.promise, delay(2000, undefined, { ref: false }).then(() => {
      throw new Error('Background verification did not enable incoming events');
    })]);
    assert.equal(event.raw_message, 'after attach');
    const result = await send();
    assert.equal(result.retcode, 0);
    assert.equal(resident.messages.get(result.data.message_id).msgId, '90071992547409942');
    assert.equal(submissions, 1);
  } finally { clearInterval(publisher); }
  const offline = new OfflineBridge();
  await controller.replaceBridge(offline);
  const deadline = performance.now() + 2000;
  while ((await call('get_status')).data.online) {
    assert(performance.now() < deadline, 'Bridge removal did not clear published identity');
    await delay(20);
  }
  assert.notEqual((await send()).retcode, 0);
  assert.equal(submissions, 1);
  assert.equal(await controller.start(), child);
});

test('background refresh continues while all client request slots are occupied', async t=>{
  let probes=0;
  const pending=[];
  let app;
  app=await createSessionService({projectRoot:root(t,()=>app?.close()),token:'synthetic-token-0123456789',
    port:0,timeoutMs:1500,proofMaxAgeMs:500,verifyEveryMs:20,
    session:{
      getMsgService:()=>({addKernelMsgListener:()=>1,removeKernelMsgListener(){}}),
      getBuddyService:()=>({getBuddyListV2:()=>new Promise(resolve=>pending.push(resolve))}),
    },
    identityProbe:async()=>{probes++;return {user_id:Number(BOT_UIN),online:true,sessionId:'fixture'};}});
  const query={action:'get_friend_list'};
  const jobs=Array.from({length:16},()=>app.core.dispatch(query));
  for(let i=0;pending.length<16&&i<100;i++)await delay(5);
  assert.equal(pending.length,16);
  const before=probes;
  assert.equal((await app.core.dispatch(query)).retcode,1429);
  for(let i=0;probes===before&&i<100;i++)await delay(5);
  assert(probes>before);
  assert.equal(app.core.metrics.calls,17);
  for(const resolve of pending)resolve({result:0,data:[]});
  assert((await Promise.all(jobs)).every(result=>result.retcode===0));
});

test('reattaching the same resident bridge refreshes status across three transports without a client proof', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let controller, forward;
  const projectRoot = root(t, () => controller?.close());
  t.after(async () => {
    forward?.terminate();
    for (const socket of receiver.clients) socket.terminate();
    await new Promise(resolve => receiver.close(resolve));
  });
  const signal = AbortSignal.timeout(8000);
  await once(receiver, 'listening', { signal });
  const identity = { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-same-resident' };
  let listeners = 0;
  const bridge = new NativeBridge({ identityProbe: async () => identity, session: {
    getMsgService: () => ({ addKernelMsgListener: () => ++listeners, removeKernelMsgListener() {} }),
  } });
  t.after(() => bridge.detach());
  await bridge.attach();
  const token = 'synthetic-resident-status-token';
  const connected = once(receiver, 'connection', { signal });
  controller = manageOneBotProcess(bridge, { projectRoot, token, port: 0, wsPort: 0, startOffline: true,
    reverseWebSocket: { url: `ws://127.0.0.1:${receiver.address().port}`, token, role: 'API' } });
  const child = await controller.start();
  const [reverse] = await connected;
  const headers = { Authorization: `Bearer ${token}` };
  forward = new WebSocket(`ws://127.0.0.1:${child.wsPort}/api`, { headers });
  await once(forward, 'open', { signal });
  const httpStatus = async () => (await (await fetch(`http://127.0.0.1:${child.port}/get_status`, { headers, signal })).json()).data;
  const socketStatus = async socket => {
    const response = once(socket, 'message', { signal });
    socket.send(JSON.stringify({ action: 'get_status', echo: 'status' }));
    const result = JSON.parse((await response)[0].toString());
    assert.equal(result.echo, 'status');
    return result.data;
  };
  for (const online of [true, false, true]) {
    while ((await httpStatus()).online !== online) await delay(10, undefined, { signal });
    for (const socket of [forward, reverse]) assert.deepEqual(await socketStatus(socket), { online, good: online });
    if (listeners === 2) break;
    if (online) bridge.detach();
    else {
      const proofs = await Promise.all([bridge.attach(), bridge.attach()]);
      assert(proofs.every(proof => proof.sessionId === identity.sessionId));
    }
  }
  assert.equal(listeners, 2);
  assert.equal(await controller.start(), child);
});

test('bind collision cleans failed instance and concurrent close allows deterministic port handoff',async t=>{
  const token='synthetic-token-0123456789';
  const headers={Authorization:'Bearer '+token};
  const firstRoot=root(t), secondRoot=root(t);
  let attached=0, detached=0;
  const session={
    getMsgService:()=>({
      addKernelMsgListener:()=>++attached,
      removeKernelMsgListener:()=>detached++,
    }),
  };
  const options={token,session,identityProbe:async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'fixture'})};
  const first=await createSessionService({...options,projectRoot:firstRoot,port:0});
  t.after(()=>first.close());
  const {port}=first.address;
  const url='http://127.0.0.1:'+port+'/get_login_info';
  await assert.rejects(createSessionService({...options,projectRoot:secondRoot,port}),{code:'EADDRINUSE'});
  assert.equal(detached,1);
  assert.equal(fs.existsSync(path.join(secondRoot,'runtime/outcomes/owner.lock')),false);
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(3000)});
  assert.equal((await response.json()).data.user_id,Number(BOT_UIN));
  let reentrant;
  first.bridge.once('offline',()=>{reentrant=first.close();});
  const close=first.close();
  await first.close();
  assert.equal(reentrant,close);
  assert.equal(detached,2);
  assert.equal(fs.existsSync(path.join(firstRoot,'runtime/outcomes/owner.lock')),false);
  const second=await createSessionService({...options,projectRoot:secondRoot,port});
  t.after(()=>second.close());
  const rebound=await fetch(url,{headers,signal:AbortSignal.timeout(3000)});
  assert.equal((await rebound.json()).data.user_id,Number(BOT_UIN));
  assert.equal(attached,3);
  await second.close();
  assert.equal(detached,3);
});

test('onebot startup rolls back a failed bridge subscription before the next explicit start', async t => {
  let controller;
  const projectRoot = root(t, () => controller?.close());
  const bridge = new OfflineBridge();
  const subscribe = bridge.on.bind(bridge);
  const subscriptions = [];
  const failure = new Error('Synthetic subscription failure');
  let fail = true;
  bridge.on = (name, listener) => {
    subscriptions.push(name);
    if (fail && name === 'bridge-ready') throw failure;
    return subscribe(name, listener);
  };
  controller = manageOneBotProcess(bridge, { projectRoot, token: 'synthetic-ipc-setup-token', startOffline: true, port: 0 });
  await assert.rejects(controller.start(), error => error === failure);
  assert.deepEqual(subscriptions, ['event', 'offline', 'bridge-ready']);
  for (const name of subscriptions) assert.equal(bridge.listenerCount(name), 0);
  assert(!fs.existsSync(path.join(projectRoot, 'runtime', 'outcomes', 'owner.lock')));
  fail = false;
  const child = await controller.start();
  assert.equal((await checkOfflineOneBot(child.port, 'synthetic-ipc-setup-token')).authenticatedOfflineStatus, true);
  for (const name of subscriptions) assert.equal(bridge.listenerCount(name), 1);
});

test('child port collision reports the cause and leaves its controller able to start on the same port', async t => {
  let childController;
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const projectRoot = root(t, async () => {
    try { await childController?.close(); }
    finally {
      if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    }
  });
  const bridge = new OfflineBridge();
  const token = 'synthetic-port-conflict-token';
  const port = occupied.address().port;
  childController = manageOneBotProcess(bridge, { projectRoot, token, port: 0, wsPort: port, startOffline: true });
  await assert.rejects(childController.start(), { code: 'EADDRINUSE' });
  const lock = path.join(projectRoot, 'runtime/outcomes/owner.lock');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(bridge.listenerCount('event'), 0);
  await new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  const child = await childController.start();
  assert.equal(child.wsPort, port);
  assert.notEqual(child.port, port);
  const response = await fetch('http://127.0.0.1:' + child.port + '/get_status', {
    headers: { Authorization: 'Bearer ' + token, Connection: 'close' },
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { online: false, good: false });
});

test('a child that exits before readiness leaves its owner identity available for explicit recovery', async t => {
  let controller;
  const projectRoot = root(t, () => controller?.close());
  const ownerLock = path.join(projectRoot, 'runtime/outcomes/owner.lock');
  const pending = path.join(projectRoot, 'runtime/outcomes/pending.json');
  let interruptedOwner;
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'resident-startup-recovery' };
  const bridge = Object.assign(new OfflineBridge(), {
    async probe() {
      if (!interruptedOwner) {
        interruptedOwner = JSON.parse(fs.readFileSync(ownerLock, 'utf8'));
        fs.writeFileSync(pending, '{"state":"synthetic pending outcome"}');
        process.kill(interruptedOwner.pid, 'SIGKILL');
        throw new Error('Synthetic startup interruption');
      }
      return proof;
    },
  });
  controller = manageOneBotProcess(bridge, { projectRoot, token: 'synthetic-startup-recovery-token', port: 0, wsPort: 0 });
  const unlink = fs.unlinkSync;
  const fault = t.mock.method(fs, 'unlinkSync', file => {
    if (file === ownerLock) throw Object.assign(new Error('Synthetic owner lock held'), { code: 'EBUSY' });
    return unlink(file);
  });
  try {
    await assert.rejects(controller.start(), { lockCleanupFailed: true });
  } finally { fault.mock.restore(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerLock, 'utf8')), interruptedOwner);
  assert.equal(bridge.listenerCount('event'), 0);
  const replacement = await controller.restart();
  assert.notEqual(replacement.instance, interruptedOwner.instance);
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerLock, 'utf8')), { pid: replacement.pid, instance: replacement.instance });
  // adoptForeign：重启把上个进程的未决记录隔离留证，闸打开（不再带着它冻结）。
  assert.equal(fs.existsSync(pending), false, '遗留记录应被隔离');
  const orphaned = fs.readdirSync(path.dirname(pending)).filter((n) => n.startsWith('pending.orphaned-'));
  assert.equal(orphaned.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(pending), orphaned[0]), 'utf8'), '{"state":"synthetic pending outcome"}');
});

test('OneBot child can restart over the same live bridge without replacing its listener or message index', async t => {
  let listener, registrations = 0, removals = 0, submissions = 0;
  const senderUin = BOT_UIN;
  const nativeMessages = new Map();
  const readback = [];
  const msg = {
    addKernelMsgListener(value) { listener = value; return ++registrations; },
    removeKernelMsgListener() { removals++; },
    generateMsgUniqueId() { return String(90071992547409930n + BigInt(submissions)); },
    sendMsg(_first, peer, elements) {
      submissions++;
      const message = { ...peer, senderUin, msgId: String(90071992547409940n + BigInt(submissions)),
        msgTime: '1700000000', sendStatus: 2, elements };
      nativeMessages.set(message.msgId, message);
      listener.onMsgInfoListUpdate([submissions === 1 ? { ...message, unsupportedNativeField: 1n } : message]);
      return { result: 0 };
    },
    getMsgsByMsgId(peer, ids) {
      assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
      readback.push(...ids);
      return { result: 0, msgList: ids.map(id => nativeMessages.get(id)).filter(Boolean) };
    },
  };
  const bridge = new NativeBridge({ session: { getMsgService: () => msg },
    identityProbe: async () => ({ user_id: senderUin, sessionId: 'resident-test', online: true }) });
  await bridge.attach();
  let controller;
  const projectRoot = root(t, async () => {
    try { await controller?.close(); }
    finally { bridge.detach(); }
  });
  const generation = bridge.generation;
  const token = 'synthetic-restart-token';
  const headers = { Authorization: 'Bearer ' + token, Connection: 'close' };
  const reverseReceiver = await openRoundtripReverseReceiver();
  t.after(() => reverseReceiver.close());
  controller = manageOneBotProcess(bridge, { projectRoot, token, port: 0, wsPort: 0, minimumWriteIntervalMs: 0,
    verifyEveryMs: 25, proofMaxAgeMs: 500, reverseWebSocket: reverseReceiver.options });
  const send = async port => {
    const response = await fetch('http://127.0.0.1:' + port + '/send_group_msg',
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: 20001, message: 'group reply' }), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.retcode, 0);
    return body.data.message_id;
  };
  const [first, mirrored] = await Promise.all([controller.start(), controller.start()]);
  assert.equal(first, mirrored);
  const { port } = first;
  const firstMessageId = await send(port);
  const waitForReverse = async previous => {
    const deadline = AbortSignal.timeout(3000);
    while (!reverseReceiver.current() || reverseReceiver.current() === previous)
      await delay(10, undefined, { signal: deadline });
    return reverseReceiver.current();
  };
  const oldReverse = await waitForReverse();
  assert.equal(bridge.stats.sendReceiptsReduced, 1);
  const savedListener = listener;
  const active = await controller.restart();
  const activeReverse = await waitForReverse(oldReverse);
  assert.deepEqual(await first.exited, { code: 0, signal: null });
  assert.equal(bridge.attached, true);
  assert.equal(bridge.generation, generation);
  assert.equal(active.port, port);
  assert.notEqual(first.wsPort, port);
  assert.equal(active.wsPort, first.wsPort);
  assert.notEqual(active.instance, first.instance);
  assert.equal(listener, savedListener);
  assert.equal(registrations, 1);
  assert.equal(removals, 0);
  const getMessage = async messageId => {
    const response = await fetch('http://127.0.0.1:' + port + '/get_msg?message_id=' + messageId,
      { headers, signal: AbortSignal.timeout(3000) });
    return response.json();
  };
  const firstRead = await getMessage(firstMessageId);
  assert.equal(firstRead.retcode, 0);
  assert.equal(firstRead.data.message_id, firstMessageId);
  assert.equal(firstRead.data.raw_message, 'group reply');
  assert.deepEqual(readback, ['90071992547409941']);
  const socket = new WebSocket('ws://127.0.0.1:' + active.wsPort + '/event', { headers: { Authorization: headers.Authorization } });
  t.after(() => socket.terminate());
  const signal = AbortSignal.timeout(3000);
  await once(socket, 'open', { signal });
  const inbound = new Promise((resolve, reject) => {
    socket.on('message', payload => {
      const event = JSON.parse(payload.toString());
      if (event.post_type === 'message') resolve(event);
    });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  listener.onRecvMsg([{ chatType: 2, peerUid: '20001', senderUin: '10001', msgId: '90071992547409950',
    msgTime: '1700000001', elements: [{ elementType: 1, textElement: { content: 'after restart' } }] }]);
  assert.equal((await inbound).raw_message, 'after restart');
  assert.notEqual(await send(port), firstMessageId);
  assert.equal(bridge.messages.get(firstMessageId).msgId, '90071992547409941');
  assert.equal(submissions, 2);

  await bridge.reattach();
  // Wait for an event that can only pass once the child has refreshed its
  // proof. Calling get_login_info here would itself refresh the proof.
  const resumed = once(socket, 'message', { signal: AbortSignal.timeout(2000) });
  let recoveryMessageId = 90071992547410000n;
  const publisher = setInterval(() => listener.onRecvMsg([{ chatType: 2, peerUid: '20001', senderUin: '10001',
    msgId: String(recoveryMessageId++), msgTime: '1700000001',
    elements: [{ elementType: 1, textElement: { content: 'automatic recovery' } }] }]), 30);
  try {
    const [payload] = await resumed;
    assert.equal(JSON.parse(payload.toString()).raw_message, 'automatic recovery');
  } finally { clearInterval(publisher); }
  assert.equal(registrations, 2);
  assert.equal(removals, 1);
  const thirdMessageId = await send(port);
  assert(thirdMessageId > firstMessageId);
  assert.equal(bridge.messages.get(firstMessageId).msgId, '90071992547409941');
  assert.deepEqual(await getMessage(firstMessageId), firstRead);
  assert.deepEqual(readback, ['90071992547409941', '90071992547409941']);
  assert.equal(bridge.messages.get(thirdMessageId).msgId, '90071992547409943');
  const thirdRead = await getMessage(thirdMessageId);
  assert.equal(thirdRead.retcode, 0);
  assert.equal(thirdRead.data.message_id, thirdMessageId);
  assert.equal(thirdRead.data.raw_message, 'group reply');
  assert.deepEqual(readback, ['90071992547409941', '90071992547409941', '90071992547409943']);
  assert.equal(await controller.start(), active);
  assert.equal(reverseReceiver.current(), activeReverse);
  const forwardApi = new WebSocket('ws://127.0.0.1:' + active.wsPort + '/api', { headers: { Authorization: headers.Authorization } });
  t.after(() => forwardApi.terminate());
  await once(forwardApi, 'open', { signal: AbortSignal.timeout(3000) });
  for (const [index, channel] of [forwardApi, activeReverse].entries()) {
    const echo = 'resident-readback-' + index;
    const response = once(channel, 'message', { signal: AbortSignal.timeout(3000) });
    channel.send(JSON.stringify({ action: 'get_msg', params: { message_id: thirdMessageId }, echo }));
    const value = JSON.parse((await response)[0].toString());
    assert.equal(value.echo, echo);
    assert.equal(value.retcode, 0);
    assert.deepEqual(value.data, thirdRead.data);
  }
  assert.deepEqual(readback.slice(-3), Array(3).fill('90071992547409943'));
  assert.equal(submissions, 3);
  const closing = controller.close();
  assert.equal(controller.close(), closing);
  await closing;
  await assert.rejects(controller.start(), /controller is closed/);
  assert.equal(bridge.attached, true);
});

for (const splitPorts of [false, true]) test(`explicit restart verifies forward and reverse status with ${splitPorts ? 'split' : 'shared'} ports`, async t => {
  const receiver = await openRoundtripReverseReceiver();
  let controller;
  const projectRoot = root(t, () => controller?.close());
  t.after(() => receiver.close());
  const token = 'synthetic-restart-status-token';
  controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0, wsPort: splitPorts ? 0 : undefined,
    startOffline: true, reverseWebSocket: receiver.options });
  const old = await controller.start();
  assert.equal(old.port !== old.wsPort, splitPorts);
  const expected = { connected: true, authenticatedOfflineStatus: true };
  assert.deepEqual(await checkOfflineRoundtripReverse(receiver), expected);
  const oldSocket = receiver.current();
  await assert.rejects(checkOfflineRoundtripReverse(receiver, AbortSignal.timeout(100), oldSocket), { code: 'ABORT_ERR' });
  const next = await controller.restart();
  assert.notEqual(next.instance, old.instance);
  assert.equal(next.port, old.port);
  assert.equal(next.wsPort, old.wsPort);
  const endpoints = await checkOfflineOneBot(next.port, token, undefined, next.wsPort);
  assert.equal(endpoints.authenticatedOfflineStatus, true);
  assert.equal(endpoints.authenticatedOfflineWebSocket, true);
  assert.deepEqual(await checkOfflineRoundtripReverse(receiver, undefined, oldSocket), expected);
  const nextSocket = receiver.current();
  assert.notEqual(nextSocket, oldSocket);
  const online = Object.assign(new OfflineBridge(), { probe: async () => ({
    online: true, user_id: Number(BOT_UIN), sessionId: 'synthetic-resident',
  }) });
  await controller.replaceBridge(online);
  const headers = { Authorization: 'Bearer ' + token };
  const signal = AbortSignal.timeout(2000);
  while (!(await (await fetch(`http://127.0.0.1:${next.port}/get_status`, { headers, signal })).json()).data.online)
    await delay(10, undefined, { signal });
  assert.equal(receiver.current(), nextSocket);
  await assert.rejects(checkOfflineRoundtripReverse(receiver, signal, oldSocket), /did not report offline status/);
});

test('explicit restart reclaims both ports after the old child stops responding', { skip: process.platform !== 'linux', timeout: 12000 }, async t => {
  const bridge = new OfflineBridge();
  let controller;
  const projectRoot = root(t, () => controller?.close());
  const token = 'synthetic-stalled-restart-token';
  controller = manageOneBotProcess(bridge, { projectRoot, token, port: 0, wsPort: 0, startOffline: true });
  const old = await controller.start();
  const ownerLock = path.join(projectRoot, 'runtime/outcomes/owner.lock');
  assert.equal(JSON.parse(fs.readFileSync(ownerLock, 'utf8')).pid, old.pid);
  process.kill(old.pid, 'SIGSTOP');
  const releaseStoppedChild = setTimeout(() => {
    try { process.kill(old.pid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }, 8000);
  void old.exited.then(() => clearTimeout(releaseStoppedChild));
  const successor = await controller.restart();
  assert.deepEqual(await old.exited, { code: null, signal: 'SIGKILL' });
  assert.notEqual(successor.instance, old.instance);
  assert.equal(successor.port, old.port);
  assert.equal(successor.wsPort, old.wsPort);
  assert.equal(JSON.parse(fs.readFileSync(ownerLock, 'utf8')).pid, successor.pid);
  assert.equal((await checkOfflineOneBot(successor.port, token, undefined, successor.wsPort)).authenticatedOfflineWebSocket, true);
  await controller.close();
  assert(!fs.existsSync(ownerLock));
});

test('explicit restart recovers both ports when the old child crashes during shutdown', async t => {
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-resident-session' };
  const bridge = Object.assign(new OfflineBridge(), { probe: async () => proof });
  let controller;
  const projectRoot = root(t, () => controller?.close());
  const token = 'synthetic-crash-restart-token';
  controller = manageOneBotProcess(bridge, { projectRoot, token, port: 0, wsPort: 0 });
  const old = await controller.start();
  assert.equal(controller.isCurrent(old), true);
  const restart = controller.restart();
  await Promise.resolve();
  process.kill(old.pid, 'SIGKILL');
  const exit = await old.exited;
  assert.notDeepEqual(exit, { code: 0, signal: null });
  assert.equal(controller.isCurrent(old), false);
  const current = await restart;
  assert.equal(controller.isCurrent(current), true);
  assert.equal(exit.lockCleanupFailed, undefined);
  assert.notEqual(current.instance, old.instance);
  assert.equal(current.port, old.port);
  assert.equal(current.wsPort, old.wsPort);
  const response = await fetch(`http://127.0.0.1:${current.port}/get_status`, {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { online: true, good: true });
  const signal = AbortSignal.timeout(3000);
  const socket = new WebSocket(`ws://127.0.0.1:${current.wsPort}/event`, { headers: { Authorization: 'Bearer ' + token } });
  t.after(() => socket.terminate());
  await once(socket, 'open', { signal });
  socket.close();
  await once(socket, 'close', { signal });
  assert.equal((await controller.start()).instance, current.instance);
});

test('child exit retries a transient lock sharing conflict before starting its replacement', async t => {
  let controller;
  const projectRoot = root(t, () => controller?.close());
  const token = 'synthetic-lock-handoff-token';
  controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0, wsPort: 0, startOffline: true });
  const old = await controller.start();
  const ownerLock = path.join(projectRoot, 'runtime/outcomes/owner.lock');
  const pending = path.join(projectRoot, 'runtime/outcomes/pending.json');
  fs.writeFileSync(pending, '{"state":"synthetic fixture"}');
  const unlink = fs.unlinkSync;
  let conflicts = 0;
  const fault = t.mock.method(fs, 'unlinkSync', filename => {
    if (filename === ownerLock && conflicts < 2) {
      conflicts++;
      throw Object.assign(new Error('Synthetic owner lock sharing conflict'), { code: conflicts === 1 ? 'EPERM' : 'EBUSY' });
    }
    return unlink(filename);
  });
  let replacement;
  try {
    process.kill(old.pid, 'SIGKILL');
    replacement = await controller.restart();
  } finally { fault.mock.restore(); }
  assert.equal(conflicts, 2);
  assert.equal((await old.exited).lockCleanupFailed, undefined);
  assert.equal(replacement.port, old.port);
  assert.equal(replacement.wsPort, old.wsPort);
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerLock, 'utf8')), { pid: replacement.pid, instance: replacement.instance });
  assert.equal(fs.existsSync(pending), false, '遗留记录应被隔离');
  const quarantined = fs.readdirSync(path.dirname(pending)).filter((n) => n.startsWith('pending.orphaned-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(pending), quarantined[0]), 'utf8'), '{"state":"synthetic fixture"}');
});

test('explicit recovery retries an exited child owner lock after the original retries are exhausted', async t => {
  let controller;
  const projectRoot = root(t, () => controller?.close());
  const token = 'synthetic-outcome-recovery-token';
  controller = manageOneBotProcess(new OfflineBridge(), { projectRoot, token, port: 0, wsPort: 0, startOffline: true });
  const old = await controller.start();
  const ownerLock = path.join(projectRoot, 'runtime/outcomes/owner.lock');
  const pending = path.join(projectRoot, 'runtime/outcomes/pending.json');
  const record = '{"state":"synthetic pending outcome"}';
  fs.writeFileSync(pending, record);
  const unlink = fs.unlinkSync;
  let conflicts = 0;
  const fault = t.mock.method(fs, 'unlinkSync', file => {
    if (file === ownerLock) {
      conflicts++;
      throw Object.assign(new Error('Synthetic owner lock held'), { code: 'EBUSY' });
    }
    return unlink(file);
  });
  try {
    process.kill(old.pid, 'SIGKILL');
    assert.equal((await old.exited).lockCleanupFailed, true);
    assert.equal(conflicts, 5);
    await assert.rejects(controller.restart(), { code: 'EBUSY' });
    assert.equal(conflicts, 10);
  } finally { fault.mock.restore(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerLock, 'utf8')), { pid: old.pid, instance: old.instance });
  const replacement = await controller.restart();
  assert.notEqual(replacement.instance, old.instance);
  assert.equal(replacement.port, old.port);
  assert.equal(replacement.wsPort, old.wsPort);
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerLock, 'utf8')), { pid: replacement.pid, instance: replacement.instance });
  assert.equal(fs.existsSync(pending), false, '遗留记录应被隔离');
  const kept = fs.readdirSync(path.dirname(pending)).filter((n) => n.startsWith('pending.orphaned-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(pending), kept[0]), 'utf8'), record);
});

for (const stall of [false, true]) {
  test(`OneBot child exits when the resident IPC disconnects${stall ? ' even if HTTP close stalls' : ''}`, { timeout: 10000 }, async t => {
    let child, exited;
    const projectRoot = root(t, async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    const execArgv = stall ? ['--import', 'data:text/javascript,' + encodeURIComponent(
      "import { Server } from 'node:http'; Server.prototype.close = function () { return this; };"
    )] : [];
    child = fork(new URL('../src/host/onebot-child.mjs', import.meta.url), [], { execArgv,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    exited = once(child, 'exit');
    const ready = once(child, 'message', { signal: AbortSignal.timeout(3000) });
    const token = 'synthetic-ipc-disconnect-token';
    child.send({ type: 'start-onebot', config: { projectRoot, token, port: 0, wsPort: 0, startOffline: true } });
    const [message] = await ready;
    assert.equal(message.type, 'onebot-ready');
    assert.notEqual(message.port, message.wsPort);
    const headers = { Authorization: `Bearer ${token}`, Connection: 'close' };
    const statusUrl = `http://127.0.0.1:${message.port}/get_status`;
    assert.deepEqual((await (await fetch(statusUrl, { headers, signal: AbortSignal.timeout(2000) })).json()).data,
      { online: false, good: false });
    child.disconnect();
    const [code, signal] = await exited;
    assert.equal(code, stall ? 1 : 0);
    assert.equal(signal, null);
    for (const port of [message.port, message.wsPort]) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/get_status`, { headers, signal: AbortSignal.timeout(1000) }),
        error => error.cause?.code === 'ECONNREFUSED');
    }
    const lock = path.join(projectRoot, 'runtime', 'outcomes', 'owner.lock');
    assert.equal(fs.existsSync(lock), stall);
  });
}

for (const interruption of ['bridge reattachment', 'child crash before receipt', 'stalled child shutdown']) {
  const stalled = interruption === 'stalled child shutdown';
  test(`interrupted IPC write stays latched after ${interruption}`, { skip: stalled && process.platform !== 'linux', timeout: 15000 }, async t => {
    let listener, controller, submissions = 0, reads = 0;
    const submitted = Promise.withResolvers();
    const senderUin = BOT_UIN;
    const earlier = { chatType: 2, peerUid: '20001', senderUin: '10001', msgId: '90071992547409942',
      msgTime: '1700000001', elements: [{ elementType: 1, textElement: { content: 'Previously indexed' } }] };
    const msg = {
      addKernelMsgListener(value) { listener = value; return 1; },
      removeKernelMsgListener() {},
      generateMsgUniqueId() { return '90071992547409930'; },
      getMsgsByMsgId(peer, ids) {
        assert.deepEqual(peer, { chatType: 2, peerUid: '20001', guildId: '' });
        assert.deepEqual(ids, [earlier.msgId]);
        reads++;
        return { result: 0, msgList: [earlier] };
      },
      sendMsg(_first, peer, elements) {
        submissions++;
        submitted.resolve({ ...peer, senderUin, msgId: '90071992547409941', sendStatus: 2, elements });
        return { result: 0 };
      },
    };
    const bridge = new NativeBridge({ session: { getMsgService: () => msg },
      identityProbe: async () => ({ user_id: senderUin, sessionId: 'resident-test', online: true }) });
    await bridge.attach();
    const earlierId = bridge.messages.put(earlier);
    const projectRoot = root(t, async () => {
      try { await controller?.close(); }
      finally { bridge.detach(); }
    });
    const token = 'synthetic-interruption-token';
    const reverse = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    t.after(async () => {
      for (const socket of reverse.clients) socket.terminate();
      await new Promise(resolve => reverse.close(resolve));
    });
    await once(reverse, 'listening');
    const connectReverse = () => once(reverse, 'connection', { signal: AbortSignal.timeout(9000) });
    const initialReverse = connectReverse();
    controller = manageOneBotProcess(bridge, { projectRoot, token, minimumWriteIntervalMs: 0, port: 0, wsPort: 0,
      reverseWebSocket: { url: `ws://127.0.0.1:${reverse.address().port}`, role: 'API', token } });
    const child = await controller.start();
    await initialReverse;
    let replacement;
    const replacementReverse = connectReverse();
    void replacementReverse.catch(() => {});
    const port = child.port;
    const base = 'http://127.0.0.1:' + port;
    const headers = { Authorization: 'Bearer ' + token, Connection: 'close', 'Content-Type': 'application/json' };
    const verifyIdentity = async () => {
      const response = await fetch(base + '/get_login_info', { headers, signal: AbortSignal.timeout(3000) });
      assert.equal((await response.json()).data.user_id, Number(senderUin));
    };
    const send = () => fetch(base + '/send_group_msg', { method: 'POST', headers,
      body: JSON.stringify({ group_id: 20001, message: 'interrupted reply' }), signal: AbortSignal.timeout(stalled ? 10000 : 3000) });
    const request = send().then(response => ({ response }), error => ({ error }));
    const receipt = await Promise.race([submitted.promise, request.then(({ error }) => {
      throw new Error('HTTP ended before the expected native submission', { cause: error });
    })]);
    const oldListener = listener;
    const generation = bridge.generation;
    const pendingFile = path.join(projectRoot, 'runtime/outcomes/pending.json');
    const recorded = fs.readFileSync(pendingFile, 'utf8');
    assert.equal(JSON.parse(recorded).action, 'send_group_msg');
    const ownerFile = path.join(projectRoot, 'runtime/outcomes/owner.lock');
    if (interruption === 'bridge reattachment') {
      await bridge.reattach();
      assert.equal(bridge.generation, generation + 1);
      assert.notEqual(listener, oldListener);
      oldListener.onMsgInfoListUpdate([receipt]);
      const { response, error } = await request;
      assert.ifError(error);
      // P4：发送类动作拿不到回执 ⇒ HTTP 200 + 成功（message_id:null），不再是 504/1504。
      assert.equal(response.status, 200);
      const acceptedBody = await response.json();
      assert.equal(acceptedBody.retcode, 0);
      assert.equal(acceptedBody.data.message_id, null);
      await verifyIdentity();
      assert.equal(bridge.pending.size, 0);
      assert.equal(bridge.stats.sendReceiptsIndexed, 0);
      assert.equal(bridge.messages.find({ chatType: 2, peerUid: '20001' }, receipt.msgId), undefined);
      // 外发优先：重连之后写闸不关 —— 这条发送会被真正提交（拿不到回执就挂到超时，而不是 1503 拒发）。
      const secondAfterReattach = await send().then((r) => r.json()).then((j) => j, (e) => ({ error: e.name }));
      assert.doesNotMatch(JSON.stringify(secondAfterReattach), /operator reconciliation required/);
      assert.deepEqual(await child.close(), { code: 0, signal: null });
    } else {
      assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, child.pid);
      if (stalled) {
        process.kill(child.pid, 'SIGSTOP');
        const resume = setTimeout(() => {
          try { process.kill(child.pid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }, 8000);
        void child.exited.then(() => clearTimeout(resume));
      }
      const restart = controller.restart();
      if (!stalled) {
        await Promise.resolve();
        process.kill(child.pid, 'SIGKILL');
      }
      const [exit, successor] = await Promise.all([child.exited, restart]);
      replacement = successor;
      assert(exit.signal === 'SIGKILL' || (process.platform === 'win32' && exit.code !== 0));
      assert.equal(exit.lockCleanupFailed, undefined);
      assert(['UND_ERR_SOCKET', 'ECONNRESET'].includes((await request).error?.cause?.code));
      assert.equal(bridge.pending.size, 0);
      assert.equal(bridge.attached, true);
      assert.equal(bridge.generation, generation);
      assert.equal(listener, oldListener);
      assert.equal(bridge.stats.sendReceiptsIndexed, 0);
    }
    replacement ??= await controller.start();
    assert.notEqual(replacement.instance, child.instance);
    assert.equal(replacement.port, port);
    assert.equal(replacement.wsPort, child.wsPort);
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')), { pid: replacement.pid, instance: replacement.instance });
    await verifyIdentity();
    // 外发优先：重启后写闸不关 —— 这条发送会被真正提交（拿不到回执就挂到超时，而不是 1503 拒发）。
    const secondAfterRestart = await send().then((r) => r.json()).then((j) => j, (e) => ({ error: e.name }));
    assert.doesNotMatch(JSON.stringify(secondAfterRestart), /operator reconciliation required/);
    const httpRead = await (await fetch(`${base}/get_msg?message_id=${earlierId}`, { headers,
      signal: AbortSignal.timeout(3000) })).json();
    assert.equal(httpRead.retcode, 0);
    assert.equal(httpRead.data.raw_message, 'Previously indexed');
    assert.deepEqual((await (await fetch(`${base}/get_status`, { headers,
      signal: AbortSignal.timeout(3000) })).json()).data, { online: true, good: true });
    const signal = AbortSignal.timeout(3000);
    const socket = new WebSocket(`ws://127.0.0.1:${replacement.wsPort}/api`, { headers });
    t.after(() => socket.terminate());
    await once(socket, 'open', { signal });
    const [outbound] = await replacementReverse;
    for (const connection of [socket, outbound]) {
      const call = async (action, params) => {
        const reply = once(connection, 'message', { signal });
        connection.send(JSON.stringify({ action, params, echo: action }));
        const result = JSON.parse((await reply)[0]);
        assert.equal(result.echo, action);
        return result;
      };
      assert.doesNotMatch(JSON.stringify(await call('send_group_msg', { group_id: 20001, message: 'fixture' })), /operator reconciliation required/);
      assert.deepEqual((await call('get_msg', { message_id: earlierId })).data, httpRead.data);
      assert.deepEqual((await call('get_status', {})).data, { online: true, good: true });
    }
    socket.close();
    await once(socket, 'close', { signal });
    assert.equal(submissions, 1);
    assert.equal(reads, 3);
    // adoptForeign：重启不会带着上个进程的未决记录继续冻结（记录要么被取用后清掉、要么被隔离留证）。
    assert.equal(fs.existsSync(pendingFile), false, '重启后不应再有未决记录拦住写闸');
  });
}

test('IPC rejects a write from a prior verified bridge generation before native submission', async t => {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (message, callback) => {
      queueMicrotask(() => { to.emit('message', message); callback?.(); });
      return true;
    };
  }
  let submissions = 0;
  const resident = Object.assign(new EventEmitter(), {
    probe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'same-resident-session' }),
    capabilities: () => ['send_group_msg'],
    async call() { return { message_id: ++submissions }; },
  });
  const binding = serveBridgeIPC(parent, resident);
  const remote = new IPCBridge(child);
  t.after(() => { remote.close(); binding.close(); });
  await remote.probe();
  // The child has not received the offline frame when it queues the old write.
  resident.emit('offline');
  const send = () => remote.call('send_group_msg', { group_id: 20001, message: 'fixture' });
  await assert.rejects(send(), { retcode: 1503, outcome: 'not_started' });
  assert.equal(submissions, 0);
  await remote.probe();
  assert.deepEqual(await send(), { message_id: 1 });
  assert.equal(submissions, 1);
});

test('core-owned IPC holds events until identity commit and discards retired-generation buffers', async t => {
  const parent = new EventEmitter(), child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (message, callback) => queueMicrotask(() => { to.emit('message', message); callback?.(); });
  }
  const identity = { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-core-commit' };
  const resident = Object.assign(new EventEmitter(), { probe: async () => identity, capabilities: () => [] });
  const binding = serveBridgeIPC(parent, resident);
  const remote = new IPCBridge(child, { requireIdentityCommit: true });
  const received = [];
  remote.on('event', event => received.push(event));
  t.after(() => { remote.close(); binding.close(); });
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const first = await remote.probe();
  const mutable = { source: 'first' };
  resident.emit('event', mutable);
  mutable.source = 'mutated-after-publication';
  await settle();
  assert.deepEqual(received, [], 'a probe response alone is not core acceptance');
  remote.identityAccepted(first);
  await settle();
  assert.deepEqual(received, [{ source: 'first' }], 'the buffered event is a snapshot, not a mutable alias');
  resident.emit('offline'); await settle();
  const retiring = await remote.probe();
  resident.emit('event', { source: 'retired-buffer' });
  resident.emit('offline');
  remote.identityAccepted(retiring); // Child has not yet received this offline generation.
  resident.emit('event', { source: 'current-buffer' });
  await settle();
  assert.equal(received.length, 1, 'stale commit must not release either generation');
  remote.identityAccepted(await remote.probe());
  await settle();
  assert.deepEqual(received, [{ source: 'first' }, { source: 'current-buffer' }]);
});

test('IPC prevents submission when capability inspection replaces the bridge or throws', async t => {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (message, callback) => queueMicrotask(() => { to.emit('message', message); callback?.(); });
  }
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-resident-session' };
  let beforeSubmit;
  let retiredSubmissions = 0;
  let replacements = 0;
  const next = Object.assign(new EventEmitter(), { probe: async () => proof,
    capabilities: () => ['send_group_msg'], async call() { return { message_id: ++replacements }; } });
  const old = Object.assign(new EventEmitter(), { probe: async () => proof,
    capabilities() { beforeSubmit?.(); return ['send_group_msg']; },
    async call() { return { message_id: ++retiredSubmissions }; } });
  const binding = serveBridgeIPC(parent, old);
  const remote = new IPCBridge(child);
  t.after(() => { remote.close(); binding.close(); });
  await remote.probe();
  const send = () => remote.call('send_group_msg', { group_id: 20001, message: 'synthetic' });
  beforeSubmit = () => { throw new Error('Synthetic capability failure'); };
  await assert.rejects(send(), { retcode: 1503, outcome: 'not_started' });
  beforeSubmit = () => binding.replaceBridge(next);
  await assert.rejects(send(), { retcode: 1503, outcome: 'not_started' });
  assert.equal(retiredSubmissions, 0);
  await remote.probe();
  assert.deepEqual(await send(), { message_id: 1 });
});

test('bridge replacement leaves the resident subscription active if candidate registration fails', async t => {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.send = (message, callback) => queueMicrotask(() => { to.emit('message', message); callback?.(); });
  }
  const identity = { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-replacement' };
  const previous = Object.assign(new OfflineBridge(), {
    probe: async () => identity, capabilities: () => ['get_msg'], async call() { return { source: 'previous' }; },
  });
  const next = Object.assign(new OfflineBridge(), {
    probe: async () => identity, capabilities: () => ['get_msg'], async call() { return { source: 'next' }; },
  });
  const on = next.on.bind(next);
  let fail = true;
  next.on = (name, callback) => {
    if (fail && name === 'bridge-ready') {
      next.emit('event', { source: 'uncommitted' });
      throw new Error('Synthetic registration failure');
    }
    return on(name, callback);
  };
  const binding = serveBridgeIPC(parent, previous);
  const remote = new IPCBridge(child);
  t.after(() => { remote.close(); binding.close(); });
  await remote.probe();
  const frames = [];
  remote.on('event', event => frames.push(event));
  let offlineCount = 0;
  remote.on('offline', () => offlineCount++);
  assert.throws(() => binding.replaceBridge(next), /Synthetic registration failure/);
  for (const event of ['event', 'offline', 'bridge-ready']) {
    assert.equal(previous.listenerCount(event), 1);
    assert.equal(next.listenerCount(event), 0);
  }
  previous.emit('event', { source: 'previous' });
  assert.deepEqual(await remote.call('get_msg', { message_id: 1 }), { source: 'previous' });
  assert.deepEqual(frames, [{ source: 'previous' }]);
  assert.equal(offlineCount, 0);
  fail = false;
  binding.replaceBridge(next);
  await remote.probe();
  assert.deepEqual(await remote.call('get_msg', { message_id: 1 }), { source: 'next' });
  assert.equal(previous.listenerCount('event'), 0);
  assert.equal(offlineCount, 1);
});

test('bridge replacement invalidates an in-flight proof and ignores the retired bridge', async t => {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [source, target] of [[parent, child], [child, parent]]) {
    source.connected = true;
    source.send = (message, callback) => {
      queueMicrotask(() => { target.emit('message', message); callback?.(); });
      return true;
    };
  }
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const identity = { user_id: Number(BOT_UIN), online: true, sessionId: 'resident-replacement' };
  const previous = Object.assign(new EventEmitter(), {
    probe() { entered.resolve(); return release.promise; },
    capabilities: () => ['send_group_msg'],
    call() { assert.fail('Retired bridge was called'); },
  });
  const next = Object.assign(new OfflineBridge(), { probe: async () => identity });
  const binding = serveBridgeIPC(parent, previous);
  const remote = new IPCBridge(child);
  t.after(() => { remote.close(); binding.close(); });
  const pending = assert.rejects(remote.probe(), { outcome: 'not_started' });
  await entered.promise;
  binding.replaceBridge(next);
  release.resolve(identity);
  await pending;
  assert.deepEqual(await remote.probe(), identity);
  const received = [];
  remote.on('event', event => received.push(event));
  previous.emit('event', { source: 'previous' });
  previous.emit('offline');
  next.emit('event', { source: 'next' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [{ source: 'next' }]);
  assert.deepEqual(remote.capabilities(), []);
});

test('callbacks already in dispatch lose authority when a bridge is replaced and attached again', async t => {
  const parent = new EventEmitter(), child = new EventEmitter();
  const frames = [];
  for (const [source, target] of [[parent, child], [child, parent]]) {
    source.connected = true;
    source.send = (message, callback) => {
      if (source === parent) frames.push(message);
      queueMicrotask(() => { target.emit('message', message); callback?.(); });
    };
  }
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-qq-session' };
  const previous = Object.assign(new OfflineBridge(), { probe: async () => proof });
  const next = Object.assign(new OfflineBridge(), { probe: async () => proof });
  const binding = serveBridgeIPC(parent, previous);
  const remote = new IPCBridge(child);
  t.after(() => { remote.close(); binding.close(); });
  await remote.probe();
  const replaceAndReturn = () => { binding.replaceBridge(next); binding.replaceBridge(previous); };
  previous.prependOnceListener('event', replaceAndReturn);
  previous.emit('event', { source: 'retired-event' });
  assert.equal(frames.some(message => message.type === 'event'), false);
  await remote.probe();
  previous.prependOnceListener('offline', replaceAndReturn);
  const start = frames.length;
  previous.emit('offline');
  assert.deepEqual(frames.slice(start).map(({ type }) => type), ['offline', 'bridge-replaced', 'offline', 'bridge-replaced']);
  await remote.probe();
  const delivered = once(remote, 'event');
  previous.emit('event', { source: 'new-subscription' });
  assert.deepEqual(await delivered, [{ source: 'new-subscription' }]);
});

test('a replacement can verify and serve reads while the retired bridge has sixteen stalled reads', async t => {
  const parent = new EventEmitter(), child = new EventEmitter();
  for (const [source, target] of [[parent, child], [child, parent]]) {
    source.connected = true;
    source.send = (message, callback) => {
      queueMicrotask(() => { target.emit('message', message); callback?.(); });
    };
  }
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const signals = [];
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-qq-session' };
  const capabilities = () => ['get_group_info'];
  const old = Object.assign(new EventEmitter(), {
    probe: async () => proof, capabilities,
    call(_action, _params, { signal }) {
      signals.push(signal);
      if (signals.length === 16) entered.resolve();
      return release.promise;
    },
  });
  const next = Object.assign(new EventEmitter(), {
    probe: async () => proof, capabilities,
    call() { return { group_id: 20001, group_name: 'Replacement' }; },
  });
  const binding = serveBridgeIPC(parent, old);
  const remote = new IPCBridge(child);
  t.after(() => { release.resolve(null); remote.close(); binding.close(); });
  await remote.probe();
  const read = () => remote.call('get_group_info', { group_id: 20001 });
  const cancelled = Array.from({ length: 16 }, () => assert.rejects(read(), { outcome: 'not_started' }));
  await entered.promise;
  binding.replaceBridge(next);
  await Promise.all(cancelled);
  assert(signals.every(signal => signal.aborted));
  assert.deepEqual(await remote.probe(), proof);
  assert.deepEqual(await read(), { group_id: 20001, group_name: 'Replacement' });
  binding.replaceBridge(old);
  await assert.rejects(remote.probe(), { outcome: 'not_started' });
  release.resolve({ group_id: 20001, group_name: 'Retired data' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await remote.probe(), proof);
});

test('an already delivered proof cannot republish capabilities after an offline frame', async t => {
  const channel = new EventEmitter();
  channel.connected = true;
  const replacement = Promise.withResolvers();
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-ipc-transition' };
  channel.send = (request, callback) => {
    const finish = (type, data) => channel.emit('message', { protocol: request.protocol, type, ...data });
    callback?.();
    assert.equal(request.type, 'probe');
    if (request.id === 1) {
      finish('result', { id: request.id, value: { proof, actions: ['send_group_msg'], generation: 0 } });
      finish('offline', { generation: 1 });
      finish('bridge-replaced', { generation: 1 });
    } else {
      finish('result', { id: request.id, value: { proof, actions: ['get_group_info'], generation: 1 } });
    }
  };
  const remote = new IPCBridge(channel);
  t.after(() => remote.close());
  remote.once('bridge-replaced', replacement.resolve);
  await assert.rejects(remote.probe(), { outcome: 'not_started' });
  await replacement.promise;
  assert.deepEqual(remote.capabilities(), []);
  assert.deepEqual(await remote.probe(), proof);
  assert.deepEqual(remote.capabilities(), ['get_group_info']);
});

test('IPC reports reattachment as unavailable until verified capabilities return', async t => {
  const channel = new EventEmitter();
  channel.connected = true;
  const protocol = 'whale-qq-bridge-v1';
  const emit = message => channel.emit('message', { protocol, ...message });
  const calls = [];
  let proof = { user_id: Number(BOT_UIN), online: false, sessionId: 'synthetic-reattachment' };
  channel.send = (request, callback) => {
    calls.push(request);
    if (request.type === 'probe') emit({ type: 'result', id: request.id, value: {
      generation: 1, proof, actions: ['get_group_info'],
    } });
    if (request.type === 'call') emit({ type: 'result', id: request.id, value: { group_id: 20001 } });
    callback?.();
  };
  const bridge = new IPCBridge(channel);
  const core = new OneBotCore({ bridge });
  t.after(() => { core.close(); bridge.close(); });
  const params = { group_id: 20001 };
  emit({ type: 'offline', generation: 1 });
  emit({ type: 'bridge-ready', generation: 0 });
  assert.equal((await core.dispatch({ action: 'get_group_info', params })).retcode, 1404);
  emit({ type: 'bridge-ready', generation: 1 });
  for (const action of ['get_group_info', 'get_group_info_async', 'get_group_info_rate_limited']) {
    const response = await core.dispatch({ action, params, echo: action });
    assert.equal(response.retcode, 1503);
    assert.equal(response.echo, action);
  }
  assert.deepEqual(calls, []);
  for (const badProof of [proof, { ...proof, user_id: Number(OWNER_UIN), online: true }, { ...proof, online: true, sessionId: '' }]) {
    proof = badProof;
    assert.notEqual((await core.dispatch({ action: 'get_login_info' })).retcode, 0);
    assert.deepEqual(core.status(), { online: false, good: false });
    assert.deepEqual(bridge.capabilities(), []);
    assert.equal((await core.dispatch({ action: 'get_group_info', params })).retcode, 1503);
  }
  assert(calls.every(call => call.type === 'probe'));
  proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-reattachment' };
  assert.equal((await core.dispatch({ action: 'get_login_info' })).retcode, 0);
  emit({ type: 'bridge-ready', generation: 1 });
  assert.equal((await core.dispatch({ action: 'get_group_list' })).retcode, 1404);
  assert.deepEqual((await core.dispatch({ action: 'get_group_info', params })).data, { group_id: 20001 });
  assert.equal(calls.filter(call => call.type === 'call').length, 1);
});

test('IPC revokes events and actions if an active generation reports a different native session', async t => {
  const channel = new EventEmitter();
  channel.connected = true;
  const protocol = 'whale-qq-bridge-v1';
  const emit = message => channel.emit('message', { protocol, ...message });
  let generation = 0, sessionId = 'session-A', offlineEvents = 0, nativeCalls = 0;
  const events = [];
  channel.send = (request, done) => {
    if (request.type === 'probe') emit({ type: 'result', id: request.id, value: { generation,
      proof: { online: true, user_id: Number(BOT_UIN), sessionId }, actions: ['get_group_info'] } });
    if (request.type === 'call') { nativeCalls++; emit({ type: 'result', id: request.id, value: { group_id: 20001 } }); }
    done?.();
  };
  const bridge = new IPCBridge(channel);
  const core = new OneBotCore({ bridge });
  t.after(() => { core.close(); bridge.close(); });
  bridge.on('offline', () => { offlineEvents++; });
  bridge.on('event', event => events.push(event));
  const login = () => core.dispatch({ action: 'get_login_info' });
  const read = () => core.dispatch({ action: 'get_group_info', params: { group_id: 20001 } });
  assert.equal((await login()).retcode, 0);
  emit({ type: 'event', generation, event: 'verified-A' });
  sessionId = 'session-B';
  assert.notEqual((await login()).retcode, 0);
  assert.notEqual((await login()).retcode, 0);
  assert.equal(offlineEvents, 1);
  assert.deepEqual(core.status(), { online: false, good: false });
  assert.equal((await read()).retcode, 1503);
  assert.equal(nativeCalls, 0);
  emit({ type: 'event', generation, event: 'unverified-B' });
  emit({ type: 'offline', generation: ++generation });
  emit({ type: 'bridge-ready', generation });
  assert.equal((await login()).retcode, 0);
  emit({ type: 'event', generation, event: 'verified-B' });
  emit({ type: 'event', generation: 0, event: 'late-A' });
  assert.deepEqual(events, ['verified-A', 'verified-B']);
  assert.deepEqual((await read()).data, { group_id: 20001 });
  assert.equal(nativeCalls, 1);
});

test('out-of-order IPC probes cannot overwrite the newest capability list', async t => {
  const channel = new EventEmitter();
  channel.connected = true;
  const requests = [];
  channel.send = (request, callback) => { requests.push(request); callback?.(); };
  const remote = new IPCBridge(channel);
  t.after(() => remote.close());
  const previous = assert.rejects(remote.probe(), { outcome: 'not_started' });
  const latest = remote.probe();
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-qq-session' };
  const respond = ({ protocol, id }, actions) => channel.emit('message', {
    protocol, type: 'result', id, value: { proof, actions, generation: 0 },
  });
  respond(requests[1], ['get_group_info']);
  assert.deepEqual(await latest, proof);
  respond(requests[0], ['send_group_msg']);
  await previous;
  assert.deepEqual(remote.capabilities(), ['get_group_info']);
  await assert.rejects(remote.call('send_group_msg', {}), { outcome: 'not_started' });
  assert.equal(requests.length, 2);
});

test('mute-list timeout stays scoped to its group and action across a OneBot process restart', async t => {
  let listener, controller;
  const queried = [];
  let withhold = false;
  const group = {
    addKernelGroupListener(value) { listener = value; return 1; },
    removeKernelGroupListener() {},
    getGroupShutUpMemberList(code) {
      queried.push(code);
      if (!withhold) listener.onShutUpMemberListChanged(code, []);
      return { result: 0 };
    },
    getGroupDetailInfo(code) {
      listener.onGroupDetailInfoChange({ groupCode: code, groupName: 'Fixture', memberNum: 1, maxMemberNum: 100 });
      return { result: 0 };
    },
  };
  const bridge = new NativeBridge({ timeoutMs: 100,
    session: { getMsgService: () => ({ addKernelMsgListener: () => 1, removeKernelMsgListener() {} }),
      getGroupService: () => group },
    identityProbe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-mute-list' }),
  });
  await bridge.attach();
  const projectRoot = root(t, async () => {
    try { await controller?.close(); }
    finally { bridge.detach(); }
  });
  const token = 'synthetic-mute-list-token';
  controller = manageOneBotProcess(bridge, { projectRoot, token, port: 0, timeoutMs: 1500 });
  const first = await controller.start();
  const call = async (action, groupId) => {
    const response = await fetch('http://127.0.0.1:' + first.port + '/' + action + '?group_id=' + groupId, {
      headers: { Authorization: 'Bearer ' + token, Connection: 'close' }, signal: AbortSignal.timeout(3000),
    });
    return response.json();
  };
  assert.deepEqual(await call('get_group_shut_list', 20001), { status: 'ok', retcode: 0, data: [] });
  withhold = true;
  assert.equal((await call('get_group_shut_list', 20001)).retcode, 1502);
  const next = await controller.restart();
  assert.equal(next.port, first.port);
  assert.notEqual(next.instance, first.instance);
  listener.onShutUpMemberListChanged('20001', []);
  assert.equal((await call('get_group_shut_list', 20001)).retcode, 1502);
  assert.equal((await call('get_group_info', 20001)).data.group_id, 20001);
  withhold = false;
  assert.equal((await call('get_group_shut_list', 20002)).retcode, 0);
  assert.deepEqual(queried, ['20001', '20001', '20002']);
  assert.equal(fs.existsSync(path.join(projectRoot, 'runtime', 'outcomes', 'pending.json')), false);
});

test('composed reverse WebSocket dispatches actions, delivers events and uses its configured reconnect budget', async t=>{
  const receiver=new WebSocketServer({host:'127.0.0.1',port:0});
  let app, listener, connections=0;
  t.after(async()=>{
    await app?.close();
    for(const socket of receiver.clients)socket.terminate();
    await new Promise(resolve=>receiver.close(resolve));
  });
  await once(receiver,'listening');
  const frames=[];
  receiver.on('connection',socket=>{
    connections++;
    socket.on('message',payload=>frames.push(JSON.parse(payload.toString())));
  });
  const token='synthetic-inbound-token', reverseToken='synthetic-outbound-token';
  const connected=once(receiver,'connection',{signal:AbortSignal.timeout(3000)});
  app=await createSessionService({projectRoot:root(t,()=>app?.close()),port:0,token,
    reverseWebSocket:{url:'ws://127.0.0.1:'+receiver.address().port,token:reverseToken,role:'Universal',
      maxAttempts:1,baseDelayMs:10,maxDelayMs:20,stableConnectionMs:5000,heartbeatMs:25},
    session:{getMsgService:()=>({
      addKernelMsgListener(value){listener=value;return 1;},
      removeKernelMsgListener(){},
    })},
    identityProbe:async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'synthetic-reverse'})});
  const [socket,request]=await connected;
  assert.equal(request.headers.authorization,'Bearer '+reverseToken);
  assert.equal(request.headers['x-self-id'],BOT_UIN);
  assert.equal(request.headers['x-client-role'],'Universal');
  socket.send(JSON.stringify({action:'get_login_info',echo:'reverse'}));
  for(let i=0;i<100&&!frames.some(frame=>frame.echo==='reverse');i++)await delay(10);
  assert.equal(frames.find(frame=>frame.echo==='reverse')?.data.user_id,Number(BOT_UIN));
  listener.onRecvMsg([{msgId:'90071992547409931',msgTime:'1700000000',chatType:2,peerUid:'20001',
    senderUin:'10001',elements:[{elementType:1,textElement:{content:'Synthetic reverse event'}}]}]);
  for(let i=0;i<100&&!frames.some(frame=>frame.post_type==='message');i++)await delay(10);
  assert.equal(frames.find(frame=>frame.post_type==='message')?.raw_message,'Synthetic reverse event');
  assert.equal(frames.find(frame=>frame.meta_event_type==='lifecycle')?.self_id,Number(BOT_UIN));
  for(let i=0;i<100&&!frames.some(frame=>frame.meta_event_type==='heartbeat');i++)await delay(10);
  assert.equal(frames.find(frame=>frame.meta_event_type==='heartbeat')?.interval,25);
  const disconnected=once(socket,'close',{signal:AbortSignal.timeout(3000)});
  socket.terminate();
  await disconnected;
  await delay(550);
  assert.equal(connections,1);
  await app.close();
});

test('one reverse WebSocket survives bridge replacement and rejects retired work', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const entered = Promise.withResolvers(), oldResult = Promise.withResolvers();
  let controller;
  const projectRoot = root(t, () => controller?.close());
  t.after(async () => {
    oldResult.resolve(null);
    for (const socket of receiver.clients) socket.terminate();
    await new Promise(resolve => receiver.close(resolve));
  });
  const signal = AbortSignal.timeout(5000);
  await once(receiver, 'listening', { signal });
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-synthetic-qq-session' };
  const capabilities = () => ['get_group_info'];
  const old = Object.assign(new EventEmitter(), { probe: async () => proof, capabilities,
    call() { entered.resolve(); return oldResult.promise; } });
  const next = Object.assign(new EventEmitter(), { probe: async () => proof, capabilities,
    call: async () => ({ group_id: 20001, group_name: 'Replacement' }) });
  const frames = [];
  let connections = 0;
  receiver.on('connection', socket => {
    connections++;
    socket.on('message', payload => frames.push(JSON.parse(payload.toString())));
  });
  const connected = once(receiver, 'connection', { signal });
  controller = manageOneBotProcess(old, { projectRoot, port: 0, wsPort: 0, token: 'synthetic-local-token',
    reverseWebSocket: { url: `ws://127.0.0.1:${receiver.address().port}`, token: 'synthetic-reverse-token', heartbeatMs: 0 } });
  const child = await controller.start();
  const [socket] = await connected;
  const request = (action, echo) => socket.send(JSON.stringify({ action, params: { group_id: 20001 }, echo }));
  const response = async echo => {
    while (!frames.some(frame => frame.echo === echo)) await delay(10, undefined, { signal });
    return frames.find(frame => frame.echo === echo);
  };
  request('get_group_info', 'retired-read');
  await Promise.race([entered.promise, delay(4000, undefined, { signal, ref: false }).then(() => assert.fail('Old bridge was not called'))]);
  await controller.replaceBridge(next);
  assert.equal((await response('retired-read')).retcode, 1503);
  oldResult.resolve({ group_id: 20001, group_name: 'Retired' });
  request('get_login_info', 'current-identity');
  assert.equal((await response('current-identity')).data?.user_id, proof.user_id);
  const message = (message_id, raw_message) => ({ self_id: proof.user_id, post_type: 'message', message_type: 'group',
    group_id: 20001, message_id, raw_message });
  old.emit('event', message(1, 'Retired'));
  next.emit('event', message(2, 'Current'));
  request('get_group_info', 'current-read');
  assert.deepEqual((await response('current-read')).data, { group_id: 20001, group_name: 'Replacement' });
  assert.deepEqual(frames.filter(frame => frame.post_type === 'message').map(frame => frame.raw_message), ['Current']);
  assert.equal(frames.filter(frame => frame.echo === 'retired-read').length, 1);
  assert.equal(connections, 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(await controller.start(), child);
});

test('bridge replacement cancels queued writes from both WebSocket directions', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let controller, forward;
  const projectRoot = root(t, () => controller?.close());
  t.after(async () => {
    forward?.terminate();
    for (const socket of receiver.clients) socket.terminate();
    await new Promise(resolve => receiver.close(resolve));
  });
  const signal = AbortSignal.timeout(8000);
  await once(receiver, 'listening', { signal });
  const proof = { user_id: Number(BOT_UIN), online: true, sessionId: 'same-resident-queue-session' };
  const calls = [];
  const makeBridge = name => Object.assign(new EventEmitter(), {
    probe: async () => proof,
    capabilities: () => ['send_group_msg'],
    call(action, params) {
      assert.equal(action, 'send_group_msg');
      calls.push([name, params.message[0].data.text]);
      return { message_id: calls.length };
    },
  });
  const token = 'synthetic-resident-queue-token';
  const reverseConnection = once(receiver, 'connection', { signal });
  controller = manageOneBotProcess(makeBridge('previous'), { projectRoot, token, port: 0, wsPort: 0, minimumWriteIntervalMs: 1500,
    reverseWebSocket: { url: 'ws://127.0.0.1:' + receiver.address().port, role: 'API', token: 'synthetic-outbound-token' } });
  const child = await controller.start();
  const [reverse] = await reverseConnection;
  forward = new WebSocket('ws://127.0.0.1:' + child.wsPort + '/api', { headers: { Authorization: 'Bearer ' + token } });
  await once(forward, 'open', { signal });
  const call = async (socket, action, echo, params = {}) => {
    const response = once(socket, 'message', { signal });
    socket.send(JSON.stringify({ action, params, echo }));
    const result = JSON.parse((await response)[0].toString());
    assert.equal(result.echo, echo);
    return result;
  };
  const send = (socket, text, queued = false) => call(socket,
    queued ? 'send_group_msg_rate_limited' : 'send_group_msg', text, { group_id: 20001, message: text });
  assert.equal((await send(forward, 'Initial')).retcode, 0);
  for (const [socket, text] of [[forward, 'Queued forward'], [reverse, 'Queued reverse']]) {
    assert.deepEqual(await send(socket, text, true), { status: 'async', retcode: 1, data: null, echo: text });
  }
  assert.deepEqual(calls, [['previous', 'Initial']]);
  await controller.replaceBridge(makeBridge('current'));
  assert.equal((await call(forward, 'get_login_info', 'identity')).data.user_id, proof.user_id);
  await delay(2100, undefined, { signal });
  assert.deepEqual(calls, [['previous', 'Initial']]);
  assert.equal((await send(reverse, 'Current')).retcode, 0);
  assert.deepEqual(calls, [['previous', 'Initial'], ['current', 'Current']]);
  assert.equal(await controller.start(), child);
  assert.equal(forward.readyState, WebSocket.OPEN);
  assert.equal(reverse.readyState, WebSocket.OPEN);
  assert(!fs.existsSync(path.join(projectRoot, 'runtime', 'outcomes', 'pending.json')));
});

// 2026-11-19 · P4：原用例 'reverse API reconnect lets later writes through instead of freezing on an
// unconfirmed one' 已删除。它验证的是「一次发送未确认 → 该会话被闩锁 → 换桥/重启后才恢复」这条旧链路，
// 而 P4 之后那条闩锁根本不产生（协议端回成功+null id），用同一套夹具再验只会测到已消失的状态。
// 对应的新契约由 core.test「side effect timeout is recorded but no longer latches later sends」与
// rate-limited「an unknown send outcome never latches later sends (P4)」覆盖。


test('reverse WebSocket preserves the Agent Plus forward-reader response', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let app;
  t.after(async () => {
    await app?.close();
    for (const socket of receiver.clients) socket.terminate();
    await new Promise(resolve => receiver.close(resolve));
  });
  await once(receiver, 'listening');
  const bridge = Object.assign(new EventEmitter(), {
    probe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-reverse-forward' }),
    capabilities: () => ['get_forward_msg'],
    call: async () => ({ message: [{ type: 'node', data: { user_id: '10001', nickname: 'Fixture',
      content: [{ type: 'text', data: { text: 'Forward content' } }] } }] }),
  });
  const signal = AbortSignal.timeout(3000);
  const connected = once(receiver, 'connection', { signal });
  app = await createOneBotService({ bridge, projectRoot: root(t, () => app?.close()),
    token: 'synthetic-inbound-token', port: 0, agentPlusCompatibility: true,
    reverseWebSocket: { url: 'ws://127.0.0.1:' + receiver.address().port,
      token: 'synthetic-outbound-token', role: 'API' } });
  const [socket, request] = await connected;
  assert.equal(request.headers['x-client-role'], 'API');
  const reply = once(socket, 'message', { signal });
  socket.send(JSON.stringify({ action: 'get_forward_msg', params: { id: 'fixture' }, echo: 'reverse-forward' }));
  const [payload] = await reply;
  const result = JSON.parse(payload.toString());
  assert.equal(result.echo, 'reverse-forward');
  assert.equal(result.retcode, 0);
  assert.deepEqual(result.data.messages[0].message, result.data.message[0].data.content);
  const queued = once(socket, 'message', { signal });
  socket.send(JSON.stringify({ action: 'get_forward_msg_rate_limited', params: { id: 'fixture' }, echo: 'reverse-queued' }));
  assert.deepEqual(JSON.parse((await queued)[0].toString()), { status: 'async', retcode: 1, data: null, echo: 'reverse-queued' });
});

test('read-only OneBot child keeps reads and blocks writes across HTTP and both WebSocket directions', async t => {
  const reverse = await openRoundtripReverseReceiver();
  let controller, forward;
  t.after(async () => {
    forward?.terminate();
    try { await controller?.close(); } finally { await reverse.close(); }
  });
  const token = 'synthetic-read-only-token';
  const actions = [];
  const bridge = Object.assign(new EventEmitter(), {
    probe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'read-only-fixture' }),
    capabilities: () => ['get_group_info', 'get_friend_list', 'send_group_msg'],
    call: async action => { actions.push(action); return { group_id: 20001 }; },
  });
  controller = manageOneBotProcess(bridge, { projectRoot: root(t, () => controller.close()), token,
    port: 0, wsPort: 0, readOnly: true, readOnlyGroup: 20001, reverseWebSocket: reverse.options });
  const child = await controller.start();
  const signal = AbortSignal.timeout(3000);
  while (!reverse.current()) await delay(10, undefined, { signal });
  forward = new WebSocket(`ws://127.0.0.1:${child.wsPort}/api`, { headers: { Authorization: `Bearer ${token}` } });
  forward.on('error', () => {});
  await once(forward, 'open', { signal });
  async function http(action, params = {}) {
    const response = await fetch(`http://127.0.0.1:${child.port}/${action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal,
    });
    return response.json();
  }
  let seq = 0;
  async function socketCall(socket, action, params) {
    const echo = ++seq;
    const result = new Promise((resolve, reject) => {
      const onMessage = bytes => {
        const response = JSON.parse(bytes.toString());
        if (response.echo !== echo) return;
        cleanup();
        resolve(response);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      function cleanup() { socket.off('message', onMessage); signal.removeEventListener('abort', abort); }
      socket.on('message', onMessage);
      signal.addEventListener('abort', abort, { once: true });
    });
    socket.send(JSON.stringify({ action, params, echo }));
    return result;
  }
  const supported = (await http('get_supported_actions')).data;
  assert(supported.includes('get_group_info'));
  assert(!supported.includes('send_group_msg'));
  assert(!supported.includes('get_friend_list'));
  for (const call of [http, socketCall.bind(null, forward), socketCall.bind(null, reverse.current())]) {
    assert.equal((await call('get_group_info', { group_id: 20001 })).retcode, 0);
    assert.equal((await call('get_friend_list', {})).retcode, 1403);
    assert.equal((await call('get_group_info', { group_id: 20002 })).retcode, 1403);
    assert.equal((await call('get_group_info_async', { group_id: 20002 })).retcode, 1403);
    for (const suffix of ['', '_async', '_rate_limited'])
      assert.equal((await call('send_group_msg' + suffix, { group_id: 20001, message: 'Blocked lab reply' })).retcode, 1403);
  }
  assert.deepEqual(actions, ['get_group_info', 'get_group_info', 'get_group_info']);
  const readonlyCore = new OneBotCore({ bridge, readOnly: true });
  t.after(() => readonlyCore.close());
  await readonlyCore.refreshIdentity(new AbortController().signal);
  const event = once(readonlyCore, 'event', { signal });
  bridge.emit('event', { self_id: Number(BOT_UIN), post_type: 'message', message_type: 'group',
    group_id: 20001, user_id: 10001, message_id: 1, message: [] });
  const [incoming] = await event;
  const quick = readonlyCore.prepareQuickOperation(incoming);
  assert.deepEqual(quick({ reply: 'Blocked webhook reply', at_sender: false }),
    { accepted: false, reason: 'read_only', queued: 0 });
  assert.equal(readonlyCore.metrics.rateAccepted, 0);
  const scoped = new OneBotCore({ bridge, readOnly: true, readOnlyGroup: '20001' });
  t.after(() => scoped.close());
  await scoped.refreshIdentity(new AbortController().signal);
  const received = [];
  scoped.on('event', item => received.push(item.message_id));
  const baseEvent = { self_id: Number(BOT_UIN), post_type: 'message', message_type: 'group',
    group_id: 20001, user_id: 10001, message: [] };
  for (const fields of [{ message_id: 2, group_id: 20002 }, { message_id: 3, message_type: 'private' },
    { message_id: 4, user_id: Number(OWNER_UIN) }, { message_id: 5 }]) bridge.emit('event', { ...baseEvent, ...fields });
  assert.deepEqual(received, [5]);
});

test('composed reverse WebSocket serves simultaneous API and Event roles on distinct paths', async t => {
  const receiver = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let app;
  t.after(async () => {
    await app?.close();
    for (const socket of receiver.clients) socket.terminate();
    await new Promise(resolve => receiver.close(resolve));
  });
  await once(receiver, 'listening');
  const sockets = new Map();
  receiver.on('connection', (socket, request) => {
    const frames = [];
    socket.on('message', payload => frames.push(JSON.parse(payload.toString())));
    sockets.set(request.url, { socket, request, frames });
  });
  const bridge = Object.assign(new EventEmitter(), {
    probe: async () => ({ user_id: Number(BOT_UIN), online: true, sessionId: 'synthetic-split-reverse' }),
    capabilities: () => ['get_group_info'],
    call: async () => ({ group_id: 20001 }),
  });
  const base = 'ws://127.0.0.1:' + receiver.address().port;
  app = await createOneBotService({ bridge, projectRoot: root(t, () => app?.close()), port: 0,
    token: 'synthetic-inbound-token', reverseWebSocket: [
      { url: base + '/actions', role: 'API', token: 'synthetic-api-token' },
      { url: base + '/events', role: 'Event', token: 'synthetic-event-token', heartbeatMs: 0 },
    ] });
  const signal = AbortSignal.timeout(3000);
  while (sockets.size < 2) await delay(10, undefined, { signal });
  const api = sockets.get('/actions'), event = sockets.get('/events');
  assert.equal(api.request.headers['x-client-role'], 'API');
  assert.equal(event.request.headers['x-client-role'], 'Event');
  assert.equal(api.request.headers.authorization, 'Bearer synthetic-api-token');
  assert.equal(event.request.headers.authorization, 'Bearer synthetic-event-token');
  const request = { action: 'get_group_info', params: { group_id: 20001 }, echo: 'reverse-split' };
  api.socket.send(JSON.stringify(request));
  event.socket.send(JSON.stringify(request));
  while (!event.frames.some(frame => frame.meta_event_type === 'lifecycle')) await delay(10, undefined, { signal });
  bridge.emit('event', { self_id: Number(BOT_UIN), post_type: 'message', message_type: 'group',
    group_id: 20001, message_id: 1, raw_message: 'Split event' });
  while (!api.frames.some(frame => frame.echo === request.echo) || !event.frames.some(frame => frame.post_type === 'message'))
    await delay(10, undefined, { signal });
  assert.deepEqual(api.frames.map(frame => frame.data), [{ group_id: 20001 }]);
  assert.deepEqual(event.frames.map(frame => frame.meta_event_type ?? frame.raw_message), ['lifecycle', 'Split event']);
  await app.close();
});

test('invalid reverse endpoint releases the composed instance lock', async t=>{
  const projectRoot=root(t);
  const receiver = createServer();
  receiver.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => receiver.close(resolve)));
  await once(receiver, 'listening', { signal: AbortSignal.timeout(3000) });
  let connections = 0;
  receiver.on('connection', socket => { connections++; socket.destroy(); });
  let removed=0;
  await assert.rejects(createSessionService({projectRoot,port:0,token:'synthetic-inbound-token',
    reverseWebSocket:[{url:`ws://127.0.0.1:${receiver.address().port}`, token:'synthetic-outbound-token'},
      {url:'ws://example.invalid',token:'synthetic-outbound-token'}],
    session:{getMsgService:()=>({addKernelMsgListener:()=>1,removeKernelMsgListener:()=>removed++})},
    identityProbe:async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'synthetic-reverse'})}),/loopback/);
  assert.equal(removed,1);
  assert.equal(fs.existsSync(path.join(projectRoot,'runtime/outcomes/owner.lock')),false);
  await delay(50);
  assert.equal(connections, 0);
});

test('composed webhook signs the delivered event and submits its quick reply once', async t=>{
  const webhookToken='synthetic-webhook-token', secret='synthetic-signing-secret';
  let app, listener, submitted=0;
  const deliveries=[];
  const receiver=createServer(async (request,response)=>{
    const chunks=[];
    for await(const chunk of request)chunks.push(chunk);
    const body=Buffer.concat(chunks);
    deliveries.push({headers:request.headers,body});
    if(JSON.parse(body).post_type!=='message'){
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify({reply:'Synthetic quick reply',at_sender:false}));
  });
  receiver.listen(0,'127.0.0.1');
  t.after(async()=>{
    await app?.close();
    await new Promise(resolve=>{receiver.close(resolve);receiver.closeAllConnections();});
  });
  await once(receiver,'listening');
  const peer={chatType:2,peerUid:'20001'};
  let confirm;
  const completed=new Promise(resolve=>{confirm=resolve;});
  app=await createSessionService({projectRoot:root(t,()=>app?.close()),port:0,token:'synthetic-inbound-token',
    webhook:{url:'http://127.0.0.1:'+receiver.address().port,token:webhookToken,secret},
    session:{getMsgService:()=>({
      addKernelMsgListener(value){listener=value;return 1;},
      removeKernelMsgListener(){},
      generateMsgUniqueId(){return '90071992547409935';},
      sendMsg(first,target,elements){
        submitted++;
        confirm({first,target,elements});
        listener.onMsgInfoListUpdate([{...target,msgId:'90071992547409936',msgTime:'1700000000',
          senderUin:BOT_UIN,sendStatus:2,elements}]);
        return {result:0};
      },
    })},
    identityProbe:async()=>({user_id:Number(BOT_UIN),online:true,sessionId:'synthetic-webhook'})});
  listener.onRecvMsg([{...peer,msgId:'90071992547409931',msgTime:'1700000000',
    senderUin:'10001',elements:[{elementType:1,textElement:{content:'Synthetic webhook event'}}]}]);
  const {first,target,elements}=await Promise.race([completed,delay(3000,null,{ref:false})])??{};
  assert.equal(first,'0');
  assert.equal(target.peerUid,peer.peerUid);
  assert.equal(elements[0].textElement.content,'Synthetic quick reply');
  const firstDelivery=deliveries[0];
  assert.equal(firstDelivery.headers.authorization,'Bearer '+webhookToken);
  assert.equal(firstDelivery.headers['x-signature'],'sha1='+createHmac('sha1',secret).update(firstDelivery.body).digest('hex'));
  assert.equal(JSON.parse(firstDelivery.body).raw_message,'Synthetic webhook event');
  for(let i=0;i<100&&app.core.metrics.rateCompleted===0;i++)await delay(10);
  assert.equal(app.core.metrics.rateCompleted,1);
  await app.close();
  listener.onRecvMsg([{...peer,msgId:'90071992547409937',msgTime:'1700000000',senderUin:'10001',elements:[]}]);
  await delay(50);
  assert.equal(deliveries.filter(({body})=>JSON.parse(body).post_type==='message').length,1);
  assert.equal(submitted,1);
});
test('failed identity cleans lock and never starts a server',async t=>{
  const projectRoot=root(t);await assert.rejects(createSessionService({projectRoot,token:'synthetic-token-0123456789',port:0,session:{},identityProbe:async()=>({user_id:Number(OWNER_UIN),online:true,sessionId:'fixture'})}));
  assert.equal(fs.existsSync(path.join(projectRoot,'runtime/outcomes/owner.lock')),false);
});
test('absent token rejects before any native session access or file creation',async t=>{
  const projectRoot=root(t);let calls=0;await assert.rejects(createSessionService({projectRoot,session:{getMsgService(){calls++;}},identityProbe:async()=>{calls++;}}));
  assert.equal(calls,0);assert.equal(fs.existsSync(path.join(projectRoot,'runtime')),false);
});
