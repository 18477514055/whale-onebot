const MAX_U64 = 18446744073709551615n;
export function invalid(field) { throw new TypeError(`Invalid ${field}`); }
export function fields(value, allowed) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(k => !allowed.includes(k))) invalid('parameters');
  return value;
}
export function id(value, field) {
  if ((!Number.isSafeInteger(value) && typeof value !== 'string') || !/^[1-9]\d{0,19}$/.test(String(value)) || BigInt(value) > MAX_U64) invalid(field);
  return String(value);
}
export function int(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
}
export function text(value, max, field, empty = false) {
  if (typeof value !== 'string' || value.length > max * 2 || [...value].length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(field);
  return value;
}
export function bfs(value) {
  // Metadata only. Legacy upload receipts sometimes use http; normalize to https.
  if (typeof value !== 'string' || value.length > 512 || !/^https?:\/\/(?:i[012]\.hdslb\.com|(?:i[012]|message)\.biliimg\.com)\/bfs\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.(?:png|gif|jpe?g|webp)$/i.test(value)) invalid('BFS image URL');
  return value.replace(/^http:/i,'https:');
}
export function image(value) {
  const limit = 2 * 1024 * 1024;
  if (typeof value !== 'string' || value.length > 32 + Math.ceil(limit / 3) * 4) invalid('image');
  const m = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) invalid('image');
  const bytes = Buffer.from(m[2], 'base64');
  const prefix = bytes.subarray(0,8).toString('hex');
  if (bytes.length > limit || bytes.toString('base64') !== m[2] || !(m[1] === 'png' ? prefix === '89504e470d0a1a0a' : m[1] === 'jpeg' ? prefix.startsWith('ffd8ff') : /^47494638(?:37|39)61/.test(prefix))) invalid('image content');
  return {bytes, type:m[1]};
}
export function action(keys, write, fn, peer = false) {
  const params = Object.freeze(keys.split(' ').filter(Boolean));
  return Object.freeze({write, params, ...(peer && {peer:true}), async run(ctx,p = {}) {
    fields(p,params);
    if (peer && id(ctx.selfId,'self') === id(ctx.peerId,'authorized peer')) invalid('authorized peer');
    return fn(ctx,p);
  }});
}
