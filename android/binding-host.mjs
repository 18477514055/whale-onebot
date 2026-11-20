// Protocol-independent host adapter. No QQ native imports, upstream client, or plugin.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const slug = /^[a-zA-Z0-9_-]{1,64}$/;
function requireValue(ok) { if (!ok) throw new Error('INVALID_BINDING_CONFIGURATION'); }
function endpoint(value, scheme) {
  requireValue(typeof value === 'string' && new RegExp('^'+scheme+'://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/?$').test(value));
  const u = new URL(value); requireValue(+value.split(':')[2].replace('/','') <= 65535); return value.replace(/\/$/,'');
}
export function projectManifest(registry, botId, { ports = [] } = {}) {
  requireValue(slug.test(botId) && Array.isArray(registry?.bots));
  const rows = registry.bots.filter(row => row?.id === botId); requireValue(rows.length === 1);
  const bot = rows[0]; requireValue(bot.enabled !== false && ['builtin','custom'].includes(bot.runtimeKind));
  requireValue(Array.isArray(bot.bindings) && bot.bindings.length > 0 && bot.bindings.length <= 32);
  const ids = new Set(), accounts = new Set(), usedPorts = new Set();
  const bindings = bot.bindings.map((b,i) => {
    requireValue(typeof b.id === 'string' && slug.test(b.id) && !ids.has(b.id)); ids.add(b.id);
    requireValue(['qq','bilibili'].includes(b.platform) && typeof b.accountId === 'string' && /^[1-9]\d{0,19}$/.test(b.accountId));
    requireValue(['shared','isolated'].includes(b.memoryMode));
    const account = `${b.platform}:${b.accountId}`; requireValue(!accounts.has(account)); accounts.add(account);
    const consolePort = ports[i]; requireValue(Number.isInteger(consolePort) && consolePort >= 1024 && consolePort <= 65535 && !usedPorts.has(consolePort)); usedPorts.add(consolePort);
    return {id:b.id,platform:b.platform,selfId:b.accountId,httpUrl:endpoint(b.httpUrl,'http'),wsUrl:endpoint(b.wsUrl,'ws'),
      ...(b.peerId ? {peerId:b.peerId} : {}),consolePort,enabled:true,isolated:b.memoryMode==='isolated',tokenEnv:'WHALE_BINDING_TOKEN_'+Buffer.from(b.id).toString('hex').toUpperCase()};
  });
  return {version:1,botId,runtimeKind:bot.runtimeKind,bindings};
}
export async function launchBoundHost({bot,tokens,runId,companion=false,installedCoreId}, {root='/opt/whale/bindings',entry='/input/agent-app/src/binding-supervisor.mjs',data='/agent/data/bots',mountedApp='/opt/whale/instance-app',stateBase='/opt/whale/instance-data',fixedState=false,spawnSupervisor=spawn}={}) {
  let instance;
  if(installedCoreId!==undefined){
    requireValue(typeof installedCoreId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(installedCoreId)&&!companion&&bot?.bindings?.length===1);
    const b=bot.bindings[0];requireValue(typeof b.id==='string'&&slug.test(b.id)&&['bilibili','qq'].includes(b.platform));
    const receipt=async folder=>JSON.parse(await fs.readFile(path.join(folder,'.bot-module.json'),'utf8'));
    const plugin=path.join(mountedApp,'src/platform-modules',b.platform);requireValue((await receipt(mountedApp)).id==='core'&&(await receipt(plugin)).id===b.platform);
    await fs.access(path.join(plugin,'index.mjs'));entry=path.join(mountedApp,'src/binding-supervisor.mjs');
    instance=fixedState?stateBase:path.join(stateBase,installedCoreId);root=path.join(instance,'channels',b.id);
  }
  const reservations=[];
  try {
    requireValue(bot?.runtimeKind === 'builtin' && Array.isArray(bot.bindings) && bot.bindings.length <= 32);
    for(const _ of bot.bindings){ const server=net.createServer(); await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve)); reservations.push(server); }
    const m=projectManifest({bots:[bot]},bot.id,{ports:reservations.map(s=>s.address().port)});
    const dir=path.join(root,m.botId), file=path.join(dir,'manifest.json');
    const env={PATH:process.env.PATH,HOME:process.env.HOME||'/root',TZ:process.env.TZ||'Asia/Shanghai'};
    if(runId!==undefined){requireValue(/^[a-f0-9]{32}$/.test(runId));env.WHALE_BINDING_RUN_ID=runId;}
    for(const b of m.bindings){ const value=Object.hasOwn(tokens||{},b.id) && tokens[b.id]; requireValue(typeof value==='string' && /^[!-~]{1,4096}$/.test(value) && !/[;=].*(?:SESSDATA|bili_jct)|(?:SESSDATA|bili_jct|DedeUserID)=/i.test(value)); env[b.tokenEnv]=value; }
    if(instance){await fs.mkdir(instance,{recursive:true,mode:0o700});env.HOME=path.join(instance,'home');env.TMPDIR=path.join(instance,'tmp');await Promise.all([env.HOME,env.TMPDIR].map(d=>fs.mkdir(d,{recursive:true,mode:0o700})));env.QQ_AGENT_INSTANCE_ROOT=instance;}
    const cfg=instance?path.join(instance,'config.json'):companion?path.join(path.dirname(data),'config.json'):path.join(data,m.botId,'config.json');
    if(instance){try{await fs.writeFile(cfg,'{}\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
    if(companion){requireValue(companion===true&&m.botId==='whale-1'&&m.bindings.every(b=>b.platform==='bilibili'));env.QQ_AGENT_LEGACY_COMPANION='1';}
    try {await fs.access(cfg); env.QQ_AGENT_BOT_CONFIG=cfg;} catch(e){if(companion||e.code!=='ENOENT') throw e;}
    await fs.access(entry); await fs.mkdir(dir,{mode:0o700,recursive:true});
    const tmp=file+'.'+process.pid+'.tmp'; await fs.writeFile(tmp,JSON.stringify(m),{mode:0o600,flag:'wx'}); await fs.rename(tmp,file);
    for(const s of reservations.splice(0)) await new Promise(resolve=>s.close(resolve));
    // Do not forward untrusted runtime output to an Android log/status endpoint.
    return spawnSupervisor(process.execPath,[entry,file],{env,stdio:'ignore',cwd:path.dirname(path.dirname(entry))});
  } finally { for(const s of reservations) s.close(); }
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try { let input=''; for await(const chunk of process.stdin){input+=chunk;requireValue(input.length<=524288);}
    const payload=JSON.parse(input);const child=await launchBoundHost(payload,payload.installedCoreId===undefined?{}:{stateBase:'/opt/whale/instance-state',fixedState:true}); input='';
    for(const sig of ['SIGINT','SIGTERM']) process.on(sig,()=>child.kill(sig));
    child.once('error',()=>{process.exitCode=1;});child.once('exit',(code)=>{process.exitCode=code??1;});
  } catch { process.exitCode=1; }
}
