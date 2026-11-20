// One logical bot; one stock server.js/guarded OneBot client per account.
// No platform SDK, login material, or external-runtime command is accepted here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadPlatformModule } from './core/platform-modules.js';
import { randomUUID } from 'node:crypto';
import { slug, validateAccount, checkEndpoint } from './core/managed-binding.js';
import { acquireInstanceLock } from './core/instance-lock.js';

export function loadBot(file, env = process.env) {
  const root = path.dirname(path.resolve(file));
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 262144) throw Error('Expected a regular binding manifest');
  let m; try { m = JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw Error('Invalid binding manifest JSON'); }
  if (m?.version !== 1 || !slug(m.botId) || !Array.isArray(m.bindings) || m.bindings.length > 128 || !['builtin','custom'].includes(m.runtimeKind ?? 'builtin')) throw Error('Invalid binding manifest');
  const ids = new Set(), accounts = new Set(), tokenNames = new Set(), consoles = new Set(), endpoints = new Set();
  const config = env.QQ_AGENT_BOT_CONFIG || path.join(root,'config.json');
  if (!path.isAbsolute(config) || path.basename(config) !== 'config.json' || (env.QQ_AGENT_BOT_CONFIG && !fs.lstatSync(config).isFile())) throw Error('Invalid shared config path');
  const companion = env.QQ_AGENT_LEGACY_COMPANION === '1';
  if (companion) throw Error('Private legacy enrollment is not available in this distribution');
  const rows = m.bindings.map(b => {
    if (!b || !slug(b.id) || ids.has(b.id.toLowerCase()) || !['qq','bilibili'].includes(b.platform) || (b.enabled !== undefined && typeof b.enabled !== 'boolean') || (b.isolated !== undefined && typeof b.isolated !== 'boolean') || ['token','tokenFile','accessToken','cookie'].some(k=>Object.hasOwn(b,k))) throw Error('Invalid/duplicate binding or inline credential');
    ids.add(b.id.toLowerCase());
    const {id,platform,selfId} = b;
    if (selfId !== undefined && typeof selfId !== 'string') throw Error('Invalid binding account');
    const row = { id,platform,selfId:selfId ?? '',consolePort:Number.isInteger(b.consolePort) ? b.consolePort : null,state:'starting' };
    if (b.enabled === false) { if (selfId) validateAccount(platform,selfId); return {row:{...row,state:'disabled'}}; }
    validateAccount(platform,selfId);
    const account = `${platform}:${selfId}`;
    if (accounts.has(account)) throw Error('Duplicate platform account'); accounts.add(account);
    const ports = [checkEndpoint(b.httpUrl,'http:'),checkEndpoint(b.wsUrl,'ws:')].map(u=>+u.port);
    const {consolePort,tokenEnv} = b;
    if (!Number.isInteger(consolePort) || consolePort < 1024 || consolePort > 65535 || consolePort === 3210 || consoles.has(consolePort)) throw Error('Invalid/duplicate worker console port');
    consoles.add(consolePort);
    for (const port of new Set(ports)) { if (endpoints.has(port)) throw Error('Multiple bindings use the same listener'); endpoints.add(port); }
    if (typeof tokenEnv !== 'string' || !/^WHALE_BINDING_TOKEN_[A-Z0-9_]{1,128}$/.test(tokenEnv) || tokenNames.has(tokenEnv)) throw Error('Invalid/duplicate token reference');
    tokenNames.add(tokenEnv);
    if (m.runtimeKind === 'custom') return {row:{...row,state:'external'}};
    const adapter = loadPlatformModule(platform); // preflight all builtin bindings before any spawn; external runtimes don't depend on adapters
    const token = env[tokenEnv];
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw Error('Missing or invalid binding credential');
    const worker = path.join(root,'workers',id,`${platform}-${selfId}`);
    const instance=env.QQ_AGENT_INSTANCE_ROOT;
    if(instance!==undefined&&(companion||!path.isAbsolute(instance)||path.resolve(instance)!==instance||path.join(instance,'channels',id,m.botId)!==root||m.bindings.length!==1||config!==path.join(instance,'config.json')||fs.realpathSync(instance)!==instance))throw Error('Invalid installed instance layout');
    // Do not pass the supervisor's other bearers, platform sessions or ambient API keys to any worker.
    const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => /^(?:PATH|HOME|USER|USERPROFILE|SystemRoot|WINDIR|ComSpec|TMP|TEMP|TMPDIR|APPDATA|LOCALAPPDATA|LD_LIBRARY_PATH|LANG|LC_ALL|TZ|NODE_OPTIONS|QQ_AGENT_SKIP_NETWORK_PROBES|QQ_AGENT_SKIP_INDEX_WARM)$/i.test(k)));
    Object.assign(childEnv,{ QQ_AGENT_BINDING_ID:id, QQ_AGENT_ROBOT_ID:m.botId, QQ_AGENT_BOT_CONFIG:config, QQ_AGENT_DATA_DIR:worker,
      QQ_AGENT_DURABLE_DIR:b.isolated ? path.join(worker,'durable') : instance ? path.join(instance,'durable') : path.join(root,'durable',m.botId), QQ_AGENT_MEMORY_SCOPE:b.isolated?'binding':'robot',
      WHALE_AGENT_PLATFORM:platform, WHALE_BINDING_SELF_ID:selfId, WHALE_BINDING_CONSOLE_PORT:String(consolePort),
      WHALE_ONEBOT_HTTP_URL:b.httpUrl, WHALE_ONEBOT_WS_URL:b.wsUrl, WHALE_ONEBOT_TOKEN:token });
    if (companion) {
      if (platform !== 'bilibili') throw Error('A primary companion may only launch Bilibili workers');
      const peer = b.peerId === undefined ? '' : b.peerId;
      if (peer !== '') validateAccount('bilibili',peer);
      if (peer === selfId) throw Error('Companion peer must differ from account');
      Object.assign(childEnv,{QQ_AGENT_LEGACY_COMPANION:'1', WHALE_BINDING_PEER_ID:peer});
    }
    if (Object.hasOwn(b,'biliTools') || Object.hasOwn(b,'biliWrites')) {
      if (platform !== 'bilibili' || b.biliTools == null || typeof (b.biliWrites ?? false) !== 'boolean') throw Error('Invalid Bilibili runtime grant');
      const policy=JSON.stringify(b.biliTools);
      try { adapter.parseToolGrants(policy); } catch { throw Error('Invalid Bilibili runtime grant schema'); }
      childEnv.WHALE_BILI_AGENT_TOOLS = policy;
      if (b.biliWrites === true) childEnv.WHALE_BILI_AGENT_WRITES = '1';
    }
    return {row,env:childEnv};
  });
  if ([...consoles].some(p=>endpoints.has(p))) throw Error('Worker console collides with protocol listener');
  return {botId:m.botId,root,rows};
}

// On Windows a short-lived reader/AV handle can prevent replacement. Keep the previous
// complete snapshot until the rename succeeds; permanent permission failures still surface.
export function publishStatus(temp, target, rename = fs.renameSync) {
  for (let attempt = 0; ; attempt++) {
    try { rename(temp,target); return; } catch (e) {
      if (!['EPERM','EACCES','EBUSY'].includes(e.code) || attempt >= 12) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(50,4*(attempt+1)));
    }
  }
}
export function startSupervisor(file, env = process.env) {
  const {root,botId,rows} = loadBot(file,env);
  const lock = acquireInstanceLock(root), children = new Set();
  const status = path.join(root,'binding-status.json');
  const run = /^[a-f0-9]{32}$/.test(env.WHALE_BINDING_RUN_ID ?? '') ? {runId:env.WHALE_BINDING_RUN_ID} : {};
  const persist = () => {
    const temp = `${status}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp,JSON.stringify({version:1,botId,...run,updatedAt:Date.now(),bindings:rows.map(r=>r.row)}),{mode:0o600,flag:'wx'});
    publishStatus(temp,status);
  };
  let stopping = false, heartbeat;
  let resolve; const done = new Promise(r=>{resolve=r;});
  const finish = () => { if (children.size) return; clearInterval(heartbeat); lock.release(); resolve(rows.some(r=>r.row.state==='failed') ? 1 : 0); };
  const stop = () => {
    if (stopping) return; stopping = true;
    for (const child of children) { child.kill('SIGTERM'); const deadline = setTimeout(()=>{ if (children.has(child)) child.kill('SIGKILL'); },26000); deadline.unref(); }
    finish();
  };
  try {
    persist();
    for (const item of rows) {
      if (!item.env) continue;
      const child = spawn(process.execPath,[path.join(import.meta.dirname,'server.js'),'--whale-binding-worker'],{cwd:path.dirname(import.meta.dirname),env:item.env,stdio:['ignore','inherit','inherit','ipc']});
      children.add(child);
      let last = Date.now();
      item.check = () => { if (item.row.state === 'verified' && Date.now()-last > 15000) item.row.state='disconnected'; };
      child.on('message',msg=>{ if (!stopping && children.has(child) && ['verified','disconnected'].includes(msg?.bindingState)) { last=Date.now(); if(item.row.state!==msg.bindingState) { item.row.state=msg.bindingState; persist(); } } });
      child.once('error',()=>{ item.row.state='failed'; persist(); });
      child.once('close',()=>{ children.delete(child); item.row.state=stopping && item.row.state!=='failed'?'stopped':'failed'; persist(); finish(); });
    }
    heartbeat=setInterval(()=>{for(const r of rows) r.check?.();persist();},5000); heartbeat.unref();
    finish();
  } catch(error) { stop(); throw error; }
  return {stop,done};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(process.argv.length!==3) throw Error('Usage: node src/binding-supervisor.mjs <manifest.json>');
    const bot=startSupervisor(process.argv[2]); process.once('SIGINT',bot.stop); process.once('SIGTERM',bot.stop);
    process.exitCode=await bot.done;
  } catch(e) { console.error('Binding supervisor refused startup:',e.message); process.exitCode=1; }
}
