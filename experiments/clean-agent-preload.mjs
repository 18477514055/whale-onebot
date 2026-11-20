import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';

export const PINNED_CLIENT_SHA256 = '7df8444ff930d437d37ba621e95e07fa00f6cb3e9fdf4b49efac14816c9a2f6d';
const target = 'file:///app/src/onebot/onebot.js';
const marker = "  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent, heartbeat = 'auto', heartbeatMs = HEARTBEAT_MS }) {";
// This is explicit test instrumentation, not an unmodified upstream application.
// The disk source and config remain unchanged; only constructor-local values change.
export function injectTokenParameters(source) {
  if (typeof source !== 'string' || source.split(marker).length !== 2)
    throw new Error('CLEAN_AGENT_CONSTRUCTOR_MISMATCH');
  return source.replace(marker, marker + '\n    accessToken = process.env.WHALE_ONEBOT_TOKEN;\n    httpToken = process.env.WHALE_ONEBOT_TOKEN;\n    if (!accessToken || !/^[a-f0-9]{48}$/.test(accessToken)) throw new Error("CLEAN_AGENT_TOKEN_REQUIRED");');
}
export function transformPinnedClient(source) {
  const bytes = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source);
  if (createHash('sha256').update(bytes).digest('hex') !== PINNED_CLIENT_SHA256)
    throw new Error('CLEAN_AGENT_SOURCE_MISMATCH');
  return injectTokenParameters(bytes.toString('utf8'));
}
if (process.env.WHALE_CLEAN_AGENT_PRELOAD === '1') {
  if (process.platform !== 'linux' || process.env.QQ_AGENT_DATA_DIR !== '/working')
    throw new Error('CLEAN_AGENT_PRELOAD_CONTEXT');
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== target) return result;
      if (result.format !== 'module') throw new Error('CLEAN_AGENT_MODULE_FORMAT');
      return { ...result, source: transformPinnedClient(result.source) };
    },
  });
}
