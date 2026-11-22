import { createTransport } from '../../transport/server.mjs';
import { BiliBridge } from './bridge.mjs';
import { BiliClient } from './client.mjs';

/** Dedicated account and transport. Never inherits QQ's core, token, or port. */
export async function startBiliService({selfId, peerId, cookie, deviceId, client, token, port=13810, allowSend=false, pollMs=15000,
  accountActions=false, allowAccountWrites=false, browserOptions, browser}={}) {
  if (typeof token !== 'string' || token.length < 16 || /[\r\n]/.test(token)) throw Error('BILI_ONEBOT_TOKEN must be at least 16 characters');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('Invalid BILI_PORT');
  if (typeof accountActions !== 'boolean' || typeof allowAccountWrites !== 'boolean' || (!accountActions && (allowAccountWrites || browserOptions || browser))) throw Error('Invalid Bilibili account action options');
  client ??= new BiliClient({selfId,peerId,cookie,deviceId});
  let accountFactory;
  if(accountActions){
    const {createAccountActions} = await import('./account-actions.mjs');
    const {recommendActions} = await import('./actions/community.mjs');
    // 私信：以前 publish-dm.mjs 只是躺在包里、没进动作表 ⇒ 手机上 bili_dm_sessions/history
    // 一律 1404，运行端根本没法收私信。这里把它挂上（读动作永远可用；发/撤回仍受 allowWrites 管）。
    const {dmActions} = await import('./actions/publish-dm.mjs');
    // 读动作永远给（收私信靠它）；写动作（ack / 撤回 / 发图）只在放开写权限时出现 ——
    // 与「只读模式下 catalog 里不该有 write 动作」的既有契约一致。
    const dmVisible = allowAccountWrites
      ? dmActions
      : Object.fromEntries(Object.entries(dmActions).filter(([, spec]) => !spec.write));
    if(browserOptions) {
      const {createBiliBrowser} = await import('./actions/browser.mjs');
      browser ??= createBiliBrowser({...browserOptions,selfId,cookie});
    }
    accountFactory=hooks=>{
      if(browser) hooks.onClose(()=>browser.close());
      const base=createAccountActions({client,browser,selfId,peerId,deviceId,allowWrites:allowAccountWrites,...hooks});
      return {
        ...base,
        names:()=>[...base.names(),...Object.keys(recommendActions),...Object.keys(dmVisible)],
        get:name=>base.get(name) ?? recommendActions[name] ?? dmVisible[name],
      };
    };
  }
  const bridge = new BiliBridge({selfId,peerId,client,allowSend,pollMs,accountFactory});
  const transport = await createTransport({events:bridge, dispatch:r=>bridge.dispatch(r), status:()=>bridge.status(), selfId:Number(selfId), platform:'bilibili', token, port, closeWsOnUnknownOutcome:true});
  const close = async () => { try { await bridge.close(); } finally { await transport.close(); } };
  try { await bridge.start(); } catch (e) { await close(); throw e; }
  return {bridge, address:transport.address, wsAddress:transport.wsAddress, close};
}
