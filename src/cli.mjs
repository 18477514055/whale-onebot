#!/usr/bin/env node
import { BOT_UIN } from './config/account.mjs';
import { OneBotCore } from './core.mjs';
import { createTransport } from './transport/index.mjs';
import { prepareReverseWebSocket } from './transport/outbound.mjs';
import { formatAgentPlusActions } from './transport/server.mjs';
import { pathToFileURL } from 'node:url';

function reverseEndpoints(env) {
  const prefix = 'WHALE_ONEBOT_REVERSE_WS';
  const endpoints = [];
  for (const [suffix, role] of [['', env[`${prefix}_ROLE`]], ['_API', 'API'], ['_EVENT', 'Event']]) {
    const urlKey = `${prefix}${suffix}_URL`;
    const tokenKey = `${prefix}${suffix}_TOKEN`;
    const url = env[urlKey], token = env[tokenKey];
    if (url === undefined && token === undefined && (suffix || role === undefined)) continue;
    if (!url || !token) throw new Error(`Set both ${urlKey} and ${tokenKey}`);
    endpoints.push({ url, token, role });
  }
  return endpoints;
}

export async function main({env=process.env,log=console.log}={}) {
  const token=env.WHALE_ONEBOT_TOKEN;
  if(typeof token!=='string'||token.length<16) throw new Error('Set WHALE_ONEBOT_TOKEN to at least 16 characters');
  const port=Number(env.WHALE_ONEBOT_PORT??13800);
  if(!Number.isInteger(port)||port<0||port>65535) throw new Error('Invalid WHALE_ONEBOT_PORT');
  const endpoints = reverseEndpoints(env);
  const agentPlusCompatibility = env.WHALE_ONEBOT_AGENT_PLUS_COMPAT === '1';
  // Default is truly offline: never infer credentials, import plugins or launch a client.
  const core=new OneBotCore();
  const reverse = [];
  let server, closing;
  const close = () => closing ??= Promise.resolve().then(async () => {
    core.close();
    await Promise.all([server?.close(), ...reverse.map(connection => connection.close())]);
  });
  try {
    const selfId=Number(BOT_UIN);
    const reverseDispatch = agentPlusCompatibility ? formatAgentPlusActions(core.dispatch) : core.dispatch;
    const startReverse = endpoints.map(endpoint => prepareReverseWebSocket({ ...endpoint, dispatch: reverseDispatch,
      events: core, status: core.status, selfId, closeWsOnUnknownOutcome: agentPlusCompatibility }));
    server = await createTransport({dispatch:core.dispatch,events:core,status:core.status,selfId,token,port,
      wsPath:env.WHALE_ONEBOT_WS_PATH,wsPort:env.WHALE_ONEBOT_WS_PORT===undefined?undefined:Number(env.WHALE_ONEBOT_WS_PORT),
      agentPlusCompatibility});
    for (const start of startReverse) reverse.push(start());
    const ports = server.address.port === server.wsAddress.port ? String(server.address.port) :
      `${server.address.port} (HTTP), ${server.wsAddress.port} (WebSocket)`;
    log(`Whale OneBot listening on loopback port ${ports}; QQ bridge OFFLINE`);
    return {core,server,close};
  } catch (error) { await close(); throw error; }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const app=await main();let stopping=false;
    const stop=()=>{if(stopping)return;stopping=true;void app.close().catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }catch{console.error('Startup failed. Check tokens, loopback transport settings and installed dependencies.');process.exitCode=1;}
}
