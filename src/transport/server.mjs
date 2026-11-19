import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { BOT_UIN } from '../config/account.mjs';

const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const failed = (retcode, wording, request) => ({ status: 'failed', retcode, data: null, wording,
  ...(object(request) && own(request, 'echo') ? { echo: request.echo } : {}) });
export function checkOptions({ dispatch, events, token, host = '127.0.0.1' }) {
  if (typeof dispatch !== 'function' || typeof events?.on !== 'function') throw new Error('Dispatcher and event emitter required');
  if (typeof token !== 'string' || token.length < 16 || /[\r\n]/.test(token)) throw new Error('A token of at least 16 characters is required');
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Only explicit loopback binding is supported');
}
export function auth(req, url, token) {
  const header = req.headers.authorization;
  const offered = header === undefined ? url.searchParams.get('access_token') : /^Bearer (.+)$/i.exec(header)?.[1];
  if (!offered) return 401;
  const a = Buffer.from(offered), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? 0 : 403;
}
export async function invoke(dispatch, request) {
  if (!object(request) || typeof request.action !== 'string' || !request.action ||
    (own(request, 'params') && !object(request.params))) return failed(1400, 'Invalid action request', request);
  try {
    const response = await dispatch({ ...request, params: request.params ?? {} });
    if (!object(response)) return failed(1500, 'Invalid dispatcher response', request);
    const result = { ...response };
    delete result.echo;
    if (own(request, 'echo')) result.echo = request.echo;
    return result;
  } catch { return failed(1500, 'Action execution failed; outcome may be unknown', request); }
}
export function sendFrame(ws, value, maxBufferedBytes) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  let serialized;
  try { serialized = JSON.stringify(value); } catch { ws.terminate(); return false; }
  if (ws.bufferedAmount + Buffer.byteLength(serialized) > maxBufferedBytes) { ws.terminate(); return false; }
  ws.send(serialized, error => { if (error) ws.terminate(); });
  return true;
}
export function attachActions(ws, { dispatch, maxBufferedBytes, maxInflight = 16, enabled = true,
  closeWsOnUnknownOutcome = false }) {
  let inflight = 0;
  ws.on('error', () => {});
  ws.on('message', async (bytes, binary) => {
    if (!enabled) return;
    let request;
    try { if (binary) throw new Error(); request = JSON.parse(bytes.toString('utf8')); }
    catch { sendFrame(ws, failed(1400, 'Invalid JSON request'), maxBufferedBytes); return; }
    if (inflight >= maxInflight) { sendFrame(ws, failed(1429, 'Too many pending requests', request), maxBufferedBytes); return; }
    inflight++;
    try {
      const response = await invoke(dispatch, request);
      if (closeWsOnUnknownOutcome && response.retcode === 1504) {
        // Legacy clients classify a lost response as unknown and a failed frame as rejected.
        ws.terminate();
        return;
      }
      sendFrame(ws, response, maxBufferedBytes);
    }
    finally { inflight--; }
  });
}

export function formatAgentPlusActions(dispatch) {
  return async request => {
    const response = await dispatch(request);
    if (response?.retcode !== 0) return response;
    if (request?.action === 'get_group_info' && response.data?.group_all_shut === -1)
      return { ...response, data: { ...response.data, group_all_shut: 1 } };
    if (request?.action !== 'get_forward_msg' || !Array.isArray(response.data?.message)) return response;
    const messages = response.data.message.map(({ data }) => ({
      user_id: data.user_id,
      sender: { user_id: data.user_id, nickname: data.nickname },
      message: data.content,
    }));
    return { ...response, data: { ...response.data, messages } };
  };
}

export async function createTransport({ dispatch, events, status = () => ({ online: false, good: false }), token,
  host = '127.0.0.1', port = 0, selfId = Number(BOT_UIN), heartbeatMs = 15000,
  maxBodyBytes = 8 * 1024 * 1024, maxBufferedBytes = 16 * 1024 * 1024, maxInflight = 16,
  maxConnections = 128, closeWsOnUnknownOutcome = false, agentPlusCompatibility = false, wsPath = '/', wsPort } = {}) {
  checkOptions({ dispatch, events, token, host });
  if (wsPort !== undefined && (!Number.isInteger(wsPort) || wsPort < 0 || wsPort > 65535))
    throw new Error('Invalid WebSocket port');
  if (typeof wsPath !== 'string' || wsPath.length > 128 ||
      (wsPath !== '/' && !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(wsPath)))
    throw new Error('Invalid WebSocket base path');
  const prefix = wsPath === '/' ? '' : wsPath;
  const roles = new Map([[wsPath, 'Universal'], [prefix + '/api', 'API'], [prefix + '/event', 'Event']]);
  const dispatchRequest = agentPlusCompatibility ? formatAgentPlusActions(dispatch) : dispatch;
  for (const n of [maxBodyBytes, maxBufferedBytes, maxInflight, maxConnections]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid transport limit');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) throw new Error('Invalid heartbeat interval');
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes, perMessageDeflate: false });
  let pending = 0, closing = false;
  const reply = (res, code, value) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
    catch { res.destroy(); }
  };
  const serverOptions = { requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 };
  const server = http.createServer(serverOptions, async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { reply(res, 400, failed(1400, 'Invalid URL')); return; }
    const denied = auth(req, url, token);
    if (denied) { reply(res, denied, failed(1000 + denied, 'Authentication required')); req.resume(); return; }
    if (!['GET', 'POST'].includes(req.method)) { reply(res, 405, failed(1405, 'Unsupported method')); req.resume(); return; }
    if (closing || pending >= maxInflight) { reply(res, 503, failed(1503, 'Server busy')); req.resume(); return; }
    pending++;
    try {
      let params = Object.fromEntries(url.searchParams); delete params.access_token;
      if (req.method === 'POST') {
        const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!['application/json', 'application/x-www-form-urlencoded'].includes(type)) { reply(res, 406, failed(1406, 'Unsupported content type')); req.resume(); return; }
        let size = 0, chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBodyBytes) { reply(res, 413, failed(1413, 'Request too large')); req.resume(); return; }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        let decoded;
        try { decoded = type === 'application/json' ? JSON.parse(body || '{}') : Object.fromEntries(new URLSearchParams(body)); }
        catch { reply(res, 400, failed(1400, 'Invalid request body')); return; }
        if (!object(decoded)) { reply(res, 400, failed(1400, 'Object body required')); return; }
        params = { ...params, ...decoded };
      }
      const path = url.pathname.replace(/\/$/, '');
      const request = path === '' ? params : { action: decodeURIComponent(path.slice(1)), params };
      const response = await invoke(dispatchRequest, request);
      const httpCode = response.retcode === 1504 ? 504 :
        [1400, 1404].includes(response.retcode) ? response.retcode - 1000 : 200;
      reply(res, httpCode, response);
    } catch { reply(res, 400, failed(1400, 'Invalid request')); }
    finally { pending--; }
  });
  const wsServer = wsPort === undefined ? server : http.createServer(serverOptions, (req, res) => {
    reply(res, 426, failed(1426, 'WebSocket upgrade required'));
    req.resume();
  });
  const listeners = wsServer === server ? [server] : [server, wsServer];
  for (const listener of listeners) {
    listener.maxConnections = maxConnections;
    listener.on('clientError', (_error, socket) => socket.destroy());
  }
  const meta = type => ({ time: Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'meta_event',
    meta_event_type: type, ...(type === 'lifecycle' ? { sub_type: 'connect' } : { status: status(), interval: heartbeatMs }) });
  if (wsServer !== server) server.on('upgrade', (_req, socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  wsServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const path = url.pathname.replace(/\/$/, '') || '/';
    const role = roles.get(path);
    const denied = auth(req, url, token) || (!role ? 404 : 0) || (closing ? 503 : 0);
    if (denied) { socket.end(`HTTP/1.1 ${denied} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.eventChannel = role !== 'API';
      attachActions(ws, { dispatch: dispatchRequest, maxBufferedBytes, maxInflight, enabled: role !== 'Event',
        closeWsOnUnknownOutcome: closeWsOnUnknownOutcome || agentPlusCompatibility });
      if (ws.eventChannel) sendFrame(ws, meta('lifecycle'), maxBufferedBytes);
    });
  });
  const broadcast = event => {
    if (!object(event)) return;
    const frame = { ...event }; delete frame.echo;
    for (const ws of wss.clients) if (ws.eventChannel) sendFrame(ws, frame, maxBufferedBytes);
  };
  events.on('event', broadcast);
  const heartbeat = heartbeatMs ? setInterval(() => { try { broadcast(meta('heartbeat')); } catch {} }, heartbeatMs) : null;
  heartbeat?.unref();
  const listen = (listener, port) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, () => { listener.off('error', reject); resolve(); });
  });
  const closeServers = () => Promise.all(listeners.filter(listener => listener.listening).map(listener =>
    new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); })));
  try {
    await listen(server, port);
    if (wsServer !== server) await listen(wsServer, wsPort);
  } catch (error) {
    closing = true; clearInterval(heartbeat); events.off('event', broadcast); wss.close();
    await closeServers();
    throw error;
  }
  const address = server.address(), wsAddress = wsServer.address();
  let closePromise;
  return { address, wsAddress, close() {
    if (closePromise) return closePromise;
    closing = true; clearInterval(heartbeat); events.off('event', broadcast);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    closePromise = closeServers().then(() => {});
    return closePromise;
  } };
}
