import {socialActions} from './actions/social.mjs';
import {communityActions} from './actions/community.mjs';
import {publishActions} from './actions/publish.mjs';
import {liveActions} from './actions/live.mjs';
import {browserActions} from './actions/browser.mjs';
import {replyActions} from './actions/reply.mjs';

// No URL passthrough. A wire action can only select one of these product contracts.
// ★ `bili_send_comment` 有两份实现：浏览器版（首选，能过设备指纹）与纯 Node 版（无浏览器时的回退）。
//   两份**同名**，所以不能同时进这张表 —— 建表时浏览器版先占位，纯 Node 版单独放着，运行时按
//   有没有 browser 决定用哪份（见 createAccountActions 里的 resolve()）。
export const accountActions = new Map();
for (const group of [socialActions,communityActions,publishActions,liveActions,browserActions]) {
  for (const [name, spec] of Object.entries(group)) {
    if (!/^bili_[a-z0-9_]+$/.test(name) || accountActions.has(name) || typeof spec.write !== 'boolean' || typeof spec.run !== 'function')
      throw new Error('Invalid or duplicate Bilibili action: ' + name);
    accountActions.set(name,spec);
  }
}
const nodeFallbacks = new Map(Object.entries(replyActions));

export function createAccountActions({client,browser,selfId,peerId,deviceId,allowWrites,emit,onClose}) {
  if (typeof client.request !== 'function' || typeof allowWrites !== 'boolean') throw new TypeError('Account actions require a web client');
  const ctx = Object.freeze({selfId:String(selfId),peerId:peerId == null ? null : String(peerId),deviceId,browser,
    request:options=>client.request(options),emit,onClose});
  // 同名时：有浏览器走浏览器版；没浏览器走纯 Node 版（否则这个动作在手机上永远是 1404）。
  const resolve = (name) => {
    const primary = accountActions.get(name);
    if (primary && (!primary.browser || browser)) return primary;
    const fallback = nodeFallbacks.get(name);
    if (fallback) return fallback;
    return primary;
  };
  const available = spec => !!spec && (!spec.browser || !!browser) && (!spec.peer || !!ctx.peerId);
  const names = () => {
    const out = new Set();
    for (const name of [...accountActions.keys(), ...nodeFallbacks.keys()]) {
      const spec = resolve(name);
      if (available(spec) && (!spec.write || allowWrites)) out.add(name);
    }
    return [...out];
  };
  return {
    names,
    get:name=>{const s=resolve(name);return s && available(s) ? s : undefined;},
    allowWrites, run:(spec,params)=>{
      if(spec.params && Object.keys(params).some(k=>!spec.params.includes(k))) throw new TypeError('Unknown action parameter');
      return spec.run(ctx,params);
    }
  };
}
