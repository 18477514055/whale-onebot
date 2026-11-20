// Local action params are JSON. Never forward a raw params object or an override.
export function invalid(field) { throw new TypeError(`Invalid Bilibili parameter: ${field}`); }
export function params(value, allowed) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(k => !allowed.includes(k) || value[k] == null)) invalid('params');
  return Object.assign(Object.create(null), value);
}
export function id(v, name) {
  if (typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,18}$/.test(v) || BigInt(v) > 9223372036854775807n) invalid(name);
  return v;
}
export function num(v, name, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) invalid(name);
  return v;
}
export function choice(v, name, options) { if (!options.includes(v)) invalid(name); return v; }
export function text(v, name, max, empty = false) {
  if (typeof v !== 'string' || (!empty && !v.trim()) || [...v].length > max || /[\x00-\x1f\x7f]/.test(v)) invalid(name);
  return v;
}
export function video(p, aidKey = 'aid') {
  if (p.aid !== undefined && p.bvid === undefined) return {[aidKey]:id(p.aid,'aid')};
  if (p.aid === undefined && typeof p.bvid === 'string' && /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(p.bvid)) return {bvid:p.bvid};
  invalid('aid/bvid');
}
export const pagination = (p, max = 20, fallback = 20) => ({pn:num(p.pn === undefined ? 1 : p.pn,'pn',1,100000),ps:num(p.ps === undefined ? fallback : p.ps,'ps',1,max)});
export const optional = (value, key, parser) => value === undefined ? {} : {[key]:parser(value,key)};
export function make(write, keys, url, build = () => ({}), options = {}) {
  const allowed = keys.split(' ').filter(Boolean);
  return Object.freeze({write, params:Object.freeze(allowed), async run(ctx, input = {}) {
    const p = params(input, allowed);
    const payload = build(p, ctx);
    return ctx.request({url, ...options, ...(write ? {method:'POST',form:payload} : {query:payload})});
  }});
}
