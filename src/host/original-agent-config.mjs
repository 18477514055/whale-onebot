import { isDeepStrictEqual } from 'node:util';

// D12: these are environment connections/authentication, not robot policy.
export const RUNTIME_MODEL_AUTH_MARKER = '__whale_runtime_auth__';
const CONNECTIONS = Object.freeze({
  onebotWsUrl: ['onebot', 'wsUrl'],
  onebotHttpUrl: ['onebot', 'httpUrl'],
  modelAuthMarker: ['api', 'apiKey'],
  consoleHost: ['server', 'host'],
  consolePort: ['server', 'port'],
});
const SECRET_CONNECTIONS = [['onebot', 'accessToken'], ['onebot', 'httpAccessToken'], ['api', 'apiKey'], ['server', 'token']];
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => new TypeError(code);

function eraseConnection(target, [section, field]) {
  if (!object(target[section])) return;
  delete target[section][field];
  if (Object.keys(target[section]).length === 0) delete target[section];
}

export function originalBusinessSettingsMatch(original, candidate) {
  const left = clone(original), right = clone(candidate);
  for (const connection of [...Object.values(CONNECTIONS), ...SECRET_CONNECTIONS]) {
    eraseConnection(left, connection); eraseConnection(right, connection);
  }
  return isDeepStrictEqual(left, right);
}

function validateConnection(key, value) {
  if (key === 'modelAuthMarker') {
    if (value !== RUNTIME_MODEL_AUTH_MARKER) throw failure('ORIGINAL_CONFIG_AUTH_MARKER_ONLY');
    return;
  }
  if (key === 'consoleHost') {
    if (value !== '127.0.0.1') throw failure('ORIGINAL_CONFIG_LOOPBACK_REQUIRED');
    return;
  }
  if (key === 'consolePort') {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw failure('ORIGINAL_CONFIG_PORT_INVALID');
    return;
  }
  if (typeof value !== 'string') throw failure('ORIGINAL_CONFIG_URL_INVALID');
  let url;
  try { url = new URL(value); } catch { throw failure('ORIGINAL_CONFIG_URL_INVALID'); }
  const protocol = key === 'onebotWsUrl' ? 'ws:' : 'http:';
  if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash ||
      !['', '/'].includes(url.pathname))
    throw failure('ORIGINAL_CONFIG_LOOPBACK_REQUIRED');
}

/** Pure: preserve every original business setting; never print config values. */
export function createOriginalAgentConfig(original, connections = {}) {
  if (!object(original) || !object(connections)) throw failure('ORIGINAL_CONFIG_OBJECT_REQUIRED');
  const result = clone(original);
  for (const [key, value] of Object.entries(connections)) {
    const destination = Object.hasOwn(CONNECTIONS, key) ? CONNECTIONS[key] : null;
    if (!destination) throw failure('ORIGINAL_CONFIG_BUSINESS_PATCH_FORBIDDEN');
    validateConnection(key, value);
    const [section, field] = destination;
    if (!object(result[section])) result[section] = {};
    result[section][field] = value;
  }
  // The export deliberately omitted credentials. Authentication is injected into
  // the runtime, not restored from a production file or persisted in this copy.
  for (const [section, field] of SECRET_CONNECTIONS) {
    const value = result[section]?.[field];
    const marker = section === 'api' && field === 'apiKey' && value === RUNTIME_MODEL_AUTH_MARKER;
    if (value !== undefined && value !== '' && !marker) throw failure('ORIGINAL_CONFIG_SOURCE_NOT_SANITIZED');
  }
  if (!originalBusinessSettingsMatch(original, result)) throw failure('ORIGINAL_CONFIG_BUSINESS_CHANGED');
  return result;
}
