import { NativeBridge } from './bridge/native-bridge.mjs';
import { OneBotCore } from './core.mjs';
import { OutcomeStore } from './outcome-store.mjs';
import { createTransport, createWebhook } from './transport/index.mjs';
import { prepareReverseWebSocket } from './transport/outbound.mjs';
import { formatAgentPlusActions } from './transport/server.mjs';
import { EXPECTED_ACCOUNT } from './actions.mjs';
import { OutboundArchive } from './archive/outbound-archive.mjs';
import path from 'node:path';

/** Compose OneBot and an owned bridge around a caller-supplied QQ session. */
export function createSessionService({session,identityProbe,...options}={}) {
  return startOneBotService(options, async () => {
    const bridge = new NativeBridge({session,identityProbe,timeoutMs:options.timeoutMs,
      authorizationPolicy:options.authorizationPolicy,conversationPolicy:options.conversationPolicy});
    await bridge.attach();
    return bridge;
  }, true);
}

/** Serve OneBot over a bridge owned by a separate session lifecycle. */
export function createOneBotService({bridge,...options}={}) {
  return startOneBotService(options, () => bridge, false);
}

async function startOneBotService({projectRoot,token,port=13800,wsPath,wsPort,outcomeOwner,
  timeoutMs=10000,proofMaxAgeMs=30000,verifyEveryMs=10000,minimumWriteIntervalMs=750,
  closeWsOnUnknownOutcome=false,agentPlusCompatibility=false,reverseWebSocket,webhook,startOffline=false,readOnly=false,readOnlyGroup,readOnlyChallengeText,
  authorizationPolicy='online-proof',conversationPolicy='protected'},
  openBridge, ownsBridge) {
  if(!['online-proof','native-session'].includes(authorizationPolicy))throw new TypeError('Invalid authorization policy');
  if(!['protected','original'].includes(conversationPolicy)||(conversationPolicy==='original'&&authorizationPolicy!=='native-session'))throw new TypeError('Invalid conversation policy');
  if(typeof readOnly!=='boolean')throw new TypeError('Invalid read-only mode');
  if (typeof startOffline !== 'boolean' || (startOffline && ownsBridge))
    throw new TypeError('Offline startup requires an externally owned bridge');
  if(!Number.isSafeInteger(verifyEveryMs)||verifyEveryMs<1||verifyEveryMs>=proofMaxAgeMs)throw new Error('Verification interval must be shorter than proof expiry');
  // Validate auth before invoking the supplied session at all.
  if(typeof token!=='string'||token.length<16||/[\r\n]/.test(token))throw new Error('Authentication required');
  // adoptForeign=true：重启时把「上个进程留下的未决记录」隔离留证并开闸。
  // 不开它的话，一次崩溃/重装打断在途发送就会让新进程从开机起就被冻结（机器人静默）。
  const store=new OutcomeStore(projectRoot,outcomeOwner,{adoptForeign:true});
  const verification=new AbortController();
  let bridge,core,transport,webhookTransport,timer,closePromise;
  const reverse=[];
  let verifying=false, verificationRequested=false;
  const scheduleVerification=delay=>{
    clearTimeout(timer);
    timer=setTimeout(verify,delay);
    timer.unref();
  };
  const requestVerification=()=>{
    if(closePromise)return;
    if(verifying) verificationRequested=true;
    else scheduleVerification(0);
  };
  const verify=async()=>{
    if(closePromise)return;
    verifying=true;
    const identity=await core.refreshIdentity(verification.signal);
    verifying=false;
    if(closePromise)return;
    if(verificationRequested){
      verificationRequested=false;
      scheduleVerification(0);
      return;
    }
    if(!identity&&ownsBridge&&!(authorizationPolicy==='native-session'?core.status().service_ready:core.status().online)){
      if(bridge.attached)bridge.detach();
      return;
    }
    if(!ownsBridge||bridge.attached)scheduleVerification(verifyEveryMs);
  };
  const close=()=>{
    if(closePromise)return closePromise;
    clearTimeout(timer);
    verification.abort();
    if(!ownsBridge){
      bridge?.off('bridge-replaced',requestVerification);
      bridge?.off('bridge-ready',requestVerification);
    }
    // Publish the completion promise before detaching: native offline
    // listeners may call close again synchronously.
    closePromise=Promise.resolve().then(async()=>{
      try{
        core?.close();
        if(ownsBridge)bridge?.detach();
        await Promise.all([transport?.close(),...reverse.map(connection=>connection.close()),webhookTransport?.close()]);
      }
      finally{store.close();}
    });
    return closePromise;
  };
  try {
    bridge=await openBridge();
    if(!bridge)throw new TypeError('Bridge required');
    core=new OneBotCore({bridge,timeoutMs,proofMaxAgeMs,minimumWriteIntervalMs,outcomeStore:store,
      statusFromBackground:startOffline,readOnly,readOnlyGroup,readOnlyChallengeText,authorizationPolicy,conversationPolicy});
    // 机器人「原话」归档（用户 2026-11-19 要求：所有发送都落库，之后用模型整理成摘要再删原话）。
    // ★ 必须**包在 core 外面**：它要看到运行端真正发起的那个动作（格式化之前的 action 名），
    //   而且归档失败绝不能影响发送 —— maybeRecord 内部吞掉一切异常。
    const outboundArchive = new OutboundArchive(path.join(projectRoot, 'runtime', 'outbound-archive.jsonl'));
    const dispatch = request => {
      let pending;
      try { pending = core.dispatch(request); } catch (error) { throw error; }
      return pending.then(response => { outboundArchive.maybeRecord(request, response); return response; });
    };
    const identity=startOffline ? null : await core.refreshIdentity(verification.signal);
    if(!startOffline&&!identity)throw new Error('Verified session unavailable');
    // Transport metadata uses the configured bot identity. Business status
    // still requires successful proof from the bridge.
    const selfId=identity?.user_id??Number(EXPECTED_ACCOUNT);
    const reverseOptions=reverseWebSocket===undefined?[]:Array.isArray(reverseWebSocket)?reverseWebSocket:[reverseWebSocket];
    if(reverseOptions.length>8)throw new TypeError('At most eight reverse WebSocket connections are supported');
    const reverseDispatch=agentPlusCompatibility?formatAgentPlusActions(dispatch):dispatch;
    const startReverse=reverseOptions.map(options=>{
      const {url,token: reverseToken,role,maxAttempts,baseDelayMs,maxDelayMs,stableConnectionMs,heartbeatMs,
        pingIntervalMs,pongTimeoutMs}=options;
      return prepareReverseWebSocket({url,token:reverseToken,role,maxAttempts,baseDelayMs,maxDelayMs,
        stableConnectionMs,heartbeatMs,pingIntervalMs,pongTimeoutMs,dispatch:reverseDispatch,events:core,
        status:core.status,selfId,closeWsOnUnknownOutcome:closeWsOnUnknownOutcome||agentPlusCompatibility});
    });
    transport=await createTransport({dispatch,events:core,status:core.status,selfId,token,port,wsPath,wsPort,closeWsOnUnknownOutcome,agentPlusCompatibility});
    for(const start of startReverse)reverse.push(start());
    if(webhook!==undefined){
      const {url,token: webhookToken,secret}=webhook;
      webhookTransport=createWebhook({url,token:webhookToken,secret,events:core,selfId});
    }
    if(!ownsBridge){
      bridge.on('bridge-replaced',requestVerification);
      bridge.on('bridge-ready',requestVerification);
    }
    scheduleVerification(startOffline?0:verifyEveryMs);
    return {core,bridge,address:transport.address,wsAddress:transport.wsAddress,close};
  } catch(error){await close();throw error;}
}
