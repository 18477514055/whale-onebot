// Owned protocol child: inherited app-private pipes only. Stdout is a framed parent
// protocol, NOT a log/status stream. Java intercepts persist_session before projection.
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
const uid=x=>typeof x==='string'&&/^[1-9]\d*$/.test(x)&&Number.isSafeInteger(+x);
function installationId(selfId){const dir='/opt/whale/bili-protocol/device-ids';fs.mkdirSync(dir,{recursive:true,mode:0o700});const target=path.join(dir,selfId+'.uuid');if(!fs.existsSync(target))fs.writeFileSync(target,randomUUID(),{flag:'wx',mode:0o600});return fs.readFileSync(target,'utf8');}
export async function startOwnedProtocol({selfId,peerId,token,savedCookie,refreshMeta,interactive=false,allowAccountWrites=false},{openClient,startService,signal,onQr,onPersist,onRefreshMeta,deviceId}={}){
 if(!uid(selfId)||peerId!=null&&(!uid(peerId)||peerId===selfId)||!/^[-_A-Za-z0-9]{40,128}$/.test(token||'')||typeof interactive!=='boolean')throw Error('invalid_configuration');
 if(savedCookie===undefined&&!interactive)throw Error('reauth_required');
 if(!openClient){({openOwnedBiliClient:openClient}=await import('/opt/whale/bili-protocol/src/platforms/bilibili/authorized-client.mjs'));deviceId??=installationId(selfId);}
 const client=await openClient({selfId,peerId,deviceId,onQr,onPersist,onRefreshMeta,refreshMeta,signal,savedCookie,interactive});if(!client||signal?.aborted)throw Error('authorization_required');
 try{
  if(!startService)({startBiliService:startService}=await import('/opt/whale/bili-protocol/src/platforms/bilibili/service.mjs'));
  // Bridge.start validates this client's one-shot freshly checked identity before serving.
  // ★ 写动作（bili_send_comment 这类）是否注册，由 App 的 input.allowAccountWrites 决定，默认 false：
  //   默认不注册时调用会得到 1404（动作不存在）—— 这是实测踩过的坑（2026-11-22，设备上 approved 一条草稿发不出去）。
  //   只有用户真的打开了「评论」才随 input 传 true，避免装完就具备公开写能力。
  const service=await startService({client,selfId,peerId,deviceId,token,port:0,allowSend:!!peerId,accountActions:true,allowAccountWrites:allowAccountWrites===true});
  return {service,client,close:async()=>{try{await service.close();}finally{await client.close?.();}},async checkSession(){
   try{const live=await client.identity();if(live?.user_id===selfId)return 'verified';if(uid(live?.user_id))return 'reauth_required';}
   catch(e){if(['BILI_API_-101','BILI_IDENTITY_MISMATCH'].includes(e?.code))return 'reauth_required';}
   return 'disconnected'; // Not evidence of takeover. Preserve credentials; never generate a QR.
  },async maintainSession(){
   if(typeof client.maintainSession==='function')return client.maintainSession();
   return {refreshed:false,reason:'unsupported'};
  }};
 }catch(e){await client.close?.();throw e;}
}
// First login has no configured identity yet. Enroll only: no listener, OneBot token,
// message peer or worker until the parent commits the verified account to its slot.
export async function enrollOwnedAccount(input,{openClient,signal,onQr,onEnrolled,onRefreshMeta}={}){
 if(!input||input.enroll!==true||input.interactive!==true||Object.keys(input).some(k=>!['enroll','interactive'].includes(k))||typeof onEnrolled!=='function'||signal?.aborted)throw Error('invalid_configuration');
 if(!openClient)({openOwnedBiliClient:openClient}=await import('/opt/whale/bili-protocol/src/platforms/bilibili/authorized-client.mjs'));
 let cookie,claimed,meta,client;try{
  client=await openClient({enroll:true,interactive:true,signal,onQr,onRefreshMeta:m=>{meta=m;},onPersist:(c,id)=>{if(cookie!==undefined||typeof c!=='string'||!uid(id))throw Error('authorization_failed');cookie=c;claimed=id;}});
  if(!client||!cookie||signal?.aborted)throw Error('authorization_failed');
  const identity=await client.identity();if(identity?.user_id!==claimed||signal?.aborted)throw Error('identity_mismatch');
  await onEnrolled(claimed,cookie,meta);
  if(meta&&typeof onRefreshMeta==='function')await onRefreshMeta(meta,claimed);
 }finally{cookie=undefined;meta=undefined;await client?.close?.();}
}
// Installed Android guest has no system DNS. Only this dedicated process uses the
// Android app's local resolver for platform names; TLS and request handling stay in Node.
export async function installAndroidLookup(name){
 if(typeof name!=='string'||!/^whale-bili-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name))throw Error('invalid_configuration');
 const {default:dns}=await import('node:dns'),{default:net}=await import('node:net'),original=dns.lookup;
 dns.lookup=function(host,options,callback){
  if(typeof host!=='string'||!/^([a-z0-9-]+\.)+(bilibili\.com|bilivideo\.com)$/i.test(host))return original.apply(this,arguments);
  if(typeof options==='function'){callback=options;options={};}
  const family=typeof options==='number'?options:options?.family;
  const s=net.connect('\0'+name);let data='',done=false;
  const finish=(rows=[])=>{if(done)return;done=true;s.destroy();if(!rows.length)return callback(Object.assign(Error('platform lookup failed'),{code:'EAI_AGAIN'}));if(options?.all)return callback(null,rows);callback(null,rows[0].address,rows[0].family);};
  s.setTimeout(8000,()=>finish());s.setEncoding('ascii');s.once('connect',()=>s.write(host.toLowerCase()+'\n'));s.on('data',chunk=>{data+=chunk;if(data.length>4096)finish();});s.once('error',()=>finish());s.once('end',()=>finish(data.trim().split('\n').map(address=>({address,family:net.isIP(address)})).filter(r=>r.family&&(!family||family===r.family))));return s;
 };
 return ()=>{dns.lookup=original;};
}
// One tick at a time per account. A terminal frame can never be followed by an online heartbeat.
export function sessionHeartbeat({check,report,yieldSession,signal}){
 let ticks=0,checking=false,ended=false;
 return async()=>{if(ended||checking||signal.aborted)return;if(++ticks%12!==0){report();return;}
  checking=true;try{let state;try{state=await check();}catch{state='disconnected';}
   if(signal.aborted)return;if(state==='verified'){report();return;}
   ended=true;await yieldSession(state==='reauth_required'?state:'session_unconfirmed');
  }finally{checking=false;}
 };
}
function isPipe(fd){const s=fs.fstatSync(fd);return s.isFIFO()||s.isSocket();}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');const ac=new AbortController();let current,timer;
 const stop=async()=>{ac.abort();clearInterval(timer);await current?.close();};for(const sig of ['SIGINT','SIGTERM'])process.once(sig,stop);
 try{
  if(process.argv.length!==2||!isPipe(0)||!isPipe(1))throw Error('invalid_configuration');
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>8192)throw Error('invalid_configuration');}
  const input=JSON.parse(text);text='';const selfId=input.selfId;
   if(!input.enroll&&Object.hasOwn(input,'androidResolver')){await installAndroidLookup(input.androidResolver);delete input.androidResolver;}
  if(input.enroll===true){await enrollOwnedAccount(input,{signal:ac.signal,onQr:({url,expiresAt})=>emit({state:'awaiting_confirmation',url,expiresAt}),onEnrolled:(selfId,cookie,meta)=>emit({type:'enrolled_session',selfId,cookie,...(meta?{meta}:{})})});}else{
   const pending=startOwnedProtocol(input,{signal:ac.signal,onQr:({url,expiresAt})=>emit({state:'awaiting_confirmation',url,expiresAt}),
   onPersist:cookie=>emit({type:'persist_session',selfId,cookie}),
   onRefreshMeta:meta=>emit({type:'refresh_meta',selfId,meta})});delete input.savedCookie;delete input.refreshMeta;
  current=await pending;if(ac.signal.aborted)await stop();else{
   let received=0,lastReceived=0,maintainTicks=0;current.service.bridge.on('event',e=>{if(e.post_type==='message'&&e.message_type==='private'){received++;lastReceived=Date.now();}});
   const report=()=>{const {service}=current;const s=service.bridge.status();emit(s.online&&s.good?{state:'verified',selfId,port:service.address.port,received,lastReceived}:{state:'disconnected'});};report();
   setTimeout(()=>{if(!ac.signal.aborted)void current.maintainSession?.().catch(()=>{});},15000).unref?.();
   timer=setInterval(async()=>{await sessionHeartbeat({check:current.checkSession,report,signal:ac.signal,yieldSession:async state=>{emit({state});await stop();}})();if(!ac.signal.aborted&&++maintainTicks%720===0){void current.maintainSession?.().catch(()=>{});}},5000);}}
 }catch(e){const end=({'Bilibili authorization expired':'expired','Bilibili authorization failed':'authorization_failed','Bilibili authorization cancelled':'stopped'})[e?.message];emit({state:end||(['authorization_required','reauth_required','authorization_failed','identity_mismatch','invalid_configuration'].includes(e?.message)?e.message:'failed')});process.exitCode=1;}
}
