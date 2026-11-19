const UPSTREAM = 'https://opencode.ai/inference/go/openai/v1/chat/completions';

/** Route authentication in memory; keep original service URL/config semantics. */
export function createOriginalModelFetch(originalFetch, { relayBase, relayToken } = {}) {
  if (typeof originalFetch !== 'function' || typeof relayBase !== 'string' ||
      typeof relayToken !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(relayToken))
    throw new TypeError('ORIGINAL_MODEL_RELAY_INVALID');
  let relay;
  try { relay = new URL(relayBase); } catch { throw new TypeError('ORIGINAL_MODEL_RELAY_INVALID'); }
  if (relay.protocol !== 'http:' || relay.hostname !== '127.0.0.1' || !relay.port ||
      relay.pathname !== '/v1' || relay.username || relay.password || relay.search || relay.hash)
    throw new TypeError('ORIGINAL_MODEL_RELAY_INVALID');
  const local = relay.href + '/chat/completions';
  return (input, init = {}) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let url;
    try { url = new URL(value); } catch { return originalFetch(input, init); }
    if (url.href !== UPSTREAM || url.username || url.password) return originalFetch(input, init);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.set('x-whale-model-relay', relayToken);
    const routed = new Request(local, request);
    return originalFetch(routed, { headers });
  };
}
