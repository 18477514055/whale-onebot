const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function escapeCQ(value, parameter = false) {
  let text = String(value).replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
  return parameter ? text.replaceAll(',', '&#44;') : text;
}
function unescapeCQ(value, parameter = false) {
  let text = value.replaceAll('&#91;', '[').replaceAll('&#93;', ']');
  if (parameter) text = text.replaceAll('&#44;', ',');
  return text.replaceAll('&amp;', '&');
}
export function normalizeMessage(message, autoEscape = false) {
  return normalizeInner(message, autoEscape, {segments:0,characters:0}, 0);
}
function normalizeInner(message, autoEscape, budget, depth) {
  if(depth>16) throw new TypeError('Message nesting too deep');
  const count = (characters=0) => {
    budget.segments++;budget.characters+=characters;
    if(budget.segments>1000||budget.characters>8*1024*1024) throw new TypeError('Message budget exceeded');
  };
  if (typeof message === 'string') {
    budget.characters+=message.length;
    if(budget.characters>8*1024*1024) throw new TypeError('Message budget exceeded');
    if (autoEscape) {count();return [{type: 'text', data: {text: message}}];}
    const result = [];
    const pattern = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\[\]]*)?)\]/g;
    let start = 0;
    for (const match of message.matchAll(pattern)) {
      if (match.index > start) {count();result.push({type: 'text', data: {text: unescapeCQ(message.slice(start, match.index))}});}
      count();
      const data = Object.create(null);
      if (match[2]) for (const pair of match[2].slice(1).split(',')) {
        const index = pair.indexOf('=');
        if (index < 1) throw new TypeError('Malformed CQ parameter');
        const key = pair.slice(0, index);
        if (!/^[a-zA-Z0-9_]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(data, key)) throw new TypeError('Invalid CQ parameter');
        data[key] = unescapeCQ(pair.slice(index + 1), true);
      }
      result.push({type: match[1], data});
      start = match.index + match[0].length;
    }
    if (start < message.length) {count();result.push({type: 'text', data: {text: unescapeCQ(message.slice(start))}});}
    return result;
  }
  const segments = Array.isArray(message) ? message : [message];
  if (segments.length > 1000) throw new TypeError('Too many message segments');
  return segments.map(segment => {
    count();
    if (!record(segment) || typeof segment.type !== 'string' || !/^[a-zA-Z0-9_]+$/.test(segment.type) || !record(segment.data)) throw new TypeError('Invalid message segment');
    const data = Object.create(null);
    for (const [key, value] of Object.entries(segment.data)) {
      if (!/^[a-zA-Z0-9_]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid segment field');
      if (key === 'content' && segment.type === 'node') data[key] = normalizeInner(value, false, budget, depth+1);
      else if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        budget.characters+=String(value).length;
        if(budget.characters>8*1024*1024) throw new TypeError('Message budget exceeded');
        data[key] = value;
      }
      else throw new TypeError('Invalid segment value');
    }
    if (segment.type === 'text' && typeof data.text !== 'string') throw new TypeError('Text segment requires text');
    return {type: segment.type, data};
  });
}
export function toCQ(message) {
  return normalizeMessage(message).map(({type, data}) => type === 'text' ? escapeCQ(data.text) : `[CQ:${type}${Object.entries(data).map(([key,value]) => {
    if (typeof value === 'object') throw new TypeError('Nested forward nodes require array messages');
    // An inlined picture arrives as a base64 data URL. Putting megabytes of it
    // into raw_message buys nothing (readers use the message array) and bloats
    // every stored copy, so the CQ form keeps the short file identifier only.
    if (key === 'url' && typeof value === 'string' && value.startsWith('base64://')) return '';
    return `,${key}=${escapeCQ(value, true)}`;
  }).join('')}]`).join('');
}
