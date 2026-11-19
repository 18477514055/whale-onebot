import { fork } from 'node:child_process';
import { on } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serveBridgeIPC } from './bridge-ipc.mjs';
import { releaseExitedChildLock } from '../outcome-store.mjs';
import { OfflineBridge } from '../core.mjs';

const exitedOwner = Symbol('exited OneBot owner');

function assertBridge(bridge) {
  if (!['probe', 'capabilities', 'call', 'on', 'off'].every(method => typeof bridge?.[method] === 'function'))
    throw new TypeError('OneBot bridge required');
}

async function releaseOwnerLock(projectRoot, pid, instance) {
  for (let attempt = 0; ; attempt++) {
    try { releaseExitedChildLock(projectRoot, pid, instance); return; }
    catch (error) {
      if (attempt === 4 || !['EBUSY', 'EPERM'].includes(error.code)) throw error;
      await delay(50);
    }
  }
}

export async function startOneBotProcess(bridge, config) {
  assertBridge(bridge);
  config = structuredClone(config);
  const outcomeOwner = randomUUID();
  const child = fork(new URL('./onebot-child.mjs', import.meta.url), [], {
    // stdout/stderr 必须继承下去：子进程启动失败时，原因就写在它自己的 stderr 里。
    // （以前这里是 'ignore'，等于把「OneBot 子进程为什么起不来」的唯一线索丢了。）
    execArgv: [], serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let ipc;
  const exited = new Promise(resolve => {
    child.once('exit', async (code, signal) => {
      ipc?.close();
      try { await releaseOwnerLock(config.projectRoot, child.pid, outcomeOwner); }
      catch { resolve({ code, signal, lockCleanupFailed: true }); return; }
      resolve({ code, signal });
    });
    child.once('error', () => {
      if (child.pid === undefined) resolve({ code: null, signal: null });
    });
  }).finally(() => ipc?.close());
  let closing;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      // A stopped or stalled child cannot service IPC or finish a graceful
      // shutdown. Wait for its actual exit before releasing the owner lock.
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        if (child.connected) {
          try { child.send({ type: 'stop-onebot' }, () => {}); }
          catch { /* An IPC shutdown race still requires waiting for child exit. */ }
        }
        return await exited;
      } finally { clearTimeout(deadline); }
    })();
    return closing;
  };
  try {
    ipc = serveBridgeIPC(child, bridge);
    const messages = on(child, 'message', { signal: AbortSignal.timeout(15000), close: ['exit'] });
    child.send({ type: 'start-onebot', config: { ...config, outcomeOwner } }, error => { if (error) void close(); });
    for await (const [message] of messages) {
      if (message?.type === 'onebot-ready' && Number.isSafeInteger(message.port) && Number.isSafeInteger(message.wsPort))
        return { pid: child.pid, instance: outcomeOwner, port: message.port, wsPort: message.wsPort, close, exited,
          isRunning: () => !closing && child.connected && child.exitCode === null && child.signalCode === null,
          replaceBridge: ipc.replaceBridge };
      if (message?.type === 'onebot-start-failed') {
        const code = ['EADDRINUSE', 'EACCES', 'EEXIST'].includes(message.code) ? message.code : 'ONEBOT_START_FAILED';
        throw Object.assign(new Error('OneBot child could not start: ' + code), { code });
      }
    }
    throw new Error('OneBot child could not start');
  } catch (error) {
    const exit = await close();
    if (exit.lockCleanupFailed) {
      error.lockCleanupFailed = true;
      error[exitedOwner] = { pid: child.pid, instance: outcomeOwner };
    }
    throw error;
  }
}

// The resident host owns this controller and the bridge. Child exits do not
// trigger a restart. Restart is an explicit operation on the protocol service.
export function manageOneBotProcess(bridge, config) {
  const options = structuredClone(config);
  let current;
  let ownerAwaitingCleanup;
  let port = options.port;
  let wsPort = options.wsPort;
  let pending = Promise.resolve();
  let closing;
  const schedule = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const start = async () => {
    if (current) return current;
    if (ownerAwaitingCleanup) {
      const { pid, instance } = ownerAwaitingCleanup;
      await releaseOwnerLock(options.projectRoot, pid, instance);
      ownerAwaitingCleanup = undefined;
    }
    let child;
    try { child = await startOneBotProcess(bridge, { ...options, port, wsPort }); }
    catch (error) {
      if (error[exitedOwner]) ownerAwaitingCleanup = error[exitedOwner];
      throw error;
    }
    current = child;
    port = child.port;
    if (wsPort !== undefined) wsPort = child.wsPort;
    void child.exited.then(result => {
      if (current !== child) return;
      if (result.lockCleanupFailed) ownerAwaitingCleanup = { pid: child.pid, instance: child.instance };
      current = undefined;
    });
    return child;
  };
  const stop = async ({ allowUnexpectedExit = false } = {}) => {
    if (!current) return;
    const child = current;
    const result = await child.close();
    if (result.lockCleanupFailed) ownerAwaitingCleanup = { pid: child.pid, instance: child.instance };
    if (current === child) current = undefined;
    if (result.lockCleanupFailed) throw new Error('OneBot owner lock cleanup failed');
    if (!allowUnexpectedExit && (result.code !== 0 || result.signal !== null))
      throw new Error('OneBot did not stop cleanly');
  };
  const run = operation => closing
    ? Promise.reject(new Error('OneBot process controller is closed'))
    : schedule(operation);
  return {
    start: () => run(start),
    isCurrent: child => current === child && current?.isRunning() === true,
    restart: () => run(async () => { await stop({ allowUnexpectedExit: true }); return start(); }),
    stopOffline: () => run(async () => {
      bridge = new OfflineBridge();
      await stop();
    }),
    replaceBridge: next => run(() => {
      assertBridge(next);
      if (!current) throw new Error('OneBot is not running');
      current.replaceBridge(next);
      bridge = next;
    }),
    close: () => closing ??= schedule(stop),
  };
}
