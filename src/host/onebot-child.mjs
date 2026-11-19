import { once } from 'node:events';
import { IPCBridge } from './bridge-ipc.mjs';
import { createOneBotService } from '../service.mjs';

if (!process.connected) throw new Error('A resident QQ host is required');
const [options] = await once(process, 'message', { signal: AbortSignal.timeout(5000) });
if (options?.type !== 'start-onebot') throw new Error('Missing OneBot start options');

// Only the inherited private parent channel supplies this constructor policy.
// It is never selected by a public action or by a bridge proof's own fields.
const bridge = new IPCBridge(process, { requireIdentityCommit: true,
  authorizationPolicy: options.config?.authorizationPolicy ?? 'online-proof',
  conversationPolicy: options.config?.conversationPolicy ?? 'protected' });
let service;
let stopping = false;
let shutdownDeadline;
const armShutdownDeadline = () => {
  // A disconnected child no longer has a parent to enforce the deadline.
  shutdownDeadline ??= setTimeout(() => process.exit(1), 5000).unref();
};
const stop = async () => {
  if (stopping) return;
  stopping = true;
  armShutdownDeadline();
  try { await service?.close(); }
  finally {
    bridge.close();
    if (process.connected) process.disconnect();
  }
};
process.once('disconnect', () => { armShutdownDeadline(); void stop(); });
process.on('message', message => {
  if (message?.type === 'stop-onebot') void stop();
});
try {
  service = await createOneBotService({ ...options.config, bridge });
  if (stopping) await service.close();
  else process.send({ type: 'onebot-ready', port: service.address.port, wsPort: service.wsAddress.port });
} catch (error) {
  const code = ['EADDRINUSE', 'EACCES', 'EEXIST'].includes(error?.code) ? error.code : 'ONEBOT_START_FAILED';
  if (process.connected) process.send({ type: 'onebot-start-failed', code }, () => {});
  process.exitCode = 1;
  await stop();
}
