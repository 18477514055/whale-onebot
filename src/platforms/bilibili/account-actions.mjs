import {socialActions} from './actions/social.mjs';
import {communityActions} from './actions/community.mjs';
import {publishActions} from './actions/publish.mjs';
import {liveActions} from './actions/live.mjs';
import {browserActions} from './actions/browser.mjs';

// No URL passthrough. A wire action can only select one of these product contracts.
export const accountActions = new Map();
for (const group of [socialActions,communityActions,publishActions,liveActions,browserActions]) {
  for (const [name, spec] of Object.entries(group)) {
    if (!/^bili_[a-z0-9_]+$/.test(name) || accountActions.has(name) || typeof spec.write !== 'boolean' || typeof spec.run !== 'function')
      throw new Error('Invalid or duplicate Bilibili action: ' + name);
    accountActions.set(name,spec);
  }
}

export function createAccountActions({client,browser,selfId,peerId,deviceId,allowWrites,emit,onClose}) {
  if (typeof client.request !== 'function' || typeof allowWrites !== 'boolean') throw new TypeError('Account actions require a web client');
  const ctx = Object.freeze({selfId:String(selfId),peerId:peerId == null ? null : String(peerId),deviceId,browser,
    request:options=>client.request(options),emit,onClose});
  const available = spec => (!spec.browser || !!browser) && (!spec.peer || !!ctx.peerId);
  return {
    names:() => [...accountActions].filter(([,s])=>available(s) && (!s.write || allowWrites)).map(([n])=>n),
    get:name=>{const s=accountActions.get(name);return s && available(s) ? s : undefined;},
    allowWrites, run:(spec,params)=>{
      if(spec.params && Object.keys(params).some(k=>!spec.params.includes(k))) throw new TypeError('Unknown action parameter');
      return spec.run(ctx,params);
    }
  };
}
