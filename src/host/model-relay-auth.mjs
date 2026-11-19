import { randomBytes } from 'node:crypto';

const boundServers = new WeakSet();

// Authentication only. Do not inherit the trial helper's four-connection limit.
export function protectOriginalModelRelay(broker) {
  const server = broker?.server;
  if (!server || typeof server.listeners !== 'function') throw new TypeError('MODEL_RELAY_SERVER_REQUIRED');
  const listeners = server.listeners('request');
  if (listeners.length !== 1 || boundServers.has(server)) throw new TypeError('MODEL_RELAY_AUTH_ALREADY_BOUND');
  boundServers.add(server);
  const token = randomBytes(24).toString('hex');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.headers['x-whale-model-relay'] !== token) {
      res.writeHead(401, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"error":{"code":"LOCAL_AUTH_REQUIRED"}}');
      req.resume();
      return;
    }
    listeners[0].call(server, req, res);
  });
  return { token, headers: { 'x-whale-model-relay': token } };
}
