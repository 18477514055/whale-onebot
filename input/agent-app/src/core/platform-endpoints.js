import { checkEndpoint } from './managed-binding.js';
export function requireBindingEndpoints(env = process.env) {
  checkEndpoint(env.WHALE_ONEBOT_HTTP_URL,'http:');checkEndpoint(env.WHALE_ONEBOT_WS_URL,'ws:');
  if (!env.WHALE_ONEBOT_TOKEN?.trim()) throw Error('Dedicated OneBot token required');
}
