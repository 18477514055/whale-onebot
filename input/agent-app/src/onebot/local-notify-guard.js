// [LOCAL-ONLY] Fixed-account protection for the separate HTTP owner-notification fallback.
// This path has no WS connection (ops/approval notices), so it MUST authenticate itself.
import { readJsonBounded } from '../core/http-body.js';
import { EXPECTED_ACCOUNT_ID } from './local-account-guard.js';

const failed = (detail, code = 'LOCAL_ACCOUNT_GUARD', outcome = 'failed') => ({ ok: false, detail, code, outcome });
function validBody(body) {
  const zero = body?.retcode === 0 || body?.retcode === '0';
  return body && typeof body === 'object' && !Array.isArray(body)
    && (body.status == null || body.status === 'ok')
    && (body.retcode == null || zero)
    && (body.status === 'ok' || zero);
}
function validMessageId(value) {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value !== 0
    : typeof value === 'string' && /^-?[1-9]\d*$/.test(value);
}

export async function sendGuardedOwnerText({ httpPort = 3390, httpUrl = '', token = '', ownerUin, text, fetchImpl = globalThis.fetch } = {}) {
  if (process.env.QQ_AGENT_BINDING_ID) return failed('Legacy standalone QQ notification route disabled for managed bindings');
  if (process.env.WHALE_AGENT_PLATFORM === 'bilibili') return failed('QQ owner notifications disabled for Bilibili');
  const owner = String(ownerUin || '').trim();
  if (!/^\d{5,15}$/.test(owner)) return failed('未配置有效的全局管理员 QQ');
  if (typeof fetchImpl !== 'function') return failed('运行环境没有 fetch');
  let base;
  try {
    const url = new URL(String(httpUrl || '').trim().replace(/\/+$/, '') || `http://127.0.0.1:${httpPort}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/+$/, '');
  } catch { return failed('通知协议端地址无效'); }
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${String(token)}` } : {}) };
  // Freeze caller-controlled payload before authentication. No getters/toJSON run after the probe.
  let body;
  try { body = JSON.stringify({ user_id: Number(owner), message: text }); }
  catch { return failed('通知正文不可序列化'); }
  let identity;
  try {
    const response = await fetchImpl(`${base}/get_login_info`, {
      method: 'POST', headers, body: '{}', redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return failed('通知账号验身失败');
    const reply = await readJsonBounded(response, 256 * 1024);
    if (!validBody(reply) || (reply.data?.platform !== undefined && reply.data.platform !== 'qq')) return failed('通知账号验身失败');
    identity = reply.data?.user_id;
  } catch { return failed('通知账号验身失败'); }
  if (EXPECTED_ACCOUNT_ID === null || (identity !== EXPECTED_ACCOUNT_ID && identity !== Number(EXPECTED_ACCOUNT_ID))) return failed('通知账号不是固定允许的机器人账号');
  try {
    const response = await fetchImpl(`${base}/send_private_msg`, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return failed('通知协议端拒绝或投递状态未知', 'LOCAL_NOTIFY_PROTOCOL', response.status >= 400 && response.status < 500 ? 'failed' : 'unknown');
    const reply = await readJsonBounded(response, 256 * 1024);
    if (!validBody(reply) || !validMessageId(reply.data?.message_id)) return failed('通知协议端未确认成功', 'LOCAL_NOTIFY_PROTOCOL', 'unknown');
    return { ok: true, detail: '' };
  } catch {
    // No automatic retry: a timeout or rejected redirect may follow a processed write.
    return failed('通知投递未确认；未自动重试', 'LOCAL_NOTIFY_PROTOCOL', 'unknown');
  }
}
