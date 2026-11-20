// Owned protocol child: inherited app-private pipes only. Stdout is a framed parent
// protocol, NOT a log/status stream. Java intercepts persist_session before projection.
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
const uid=x=>typeof x==='string'&&/^[1-9]\d*$/.test(x)&&Number.isSafeInteger(+x);
function installationId(selfId){const dir='/opt/whale/bili-protocol/device-ids';fs.mkdirSync(dir,{recursive:true,mode:0o700});const target=path.join(dir,selfId+'.uuid');if(!fs.existsSync(target))fs.writeFileSync(target,randomUUID(),{flag:'wx',mode:0o600});return fs.readFileSync(target,'utf8');}
export async function startOwnedProtocol({selfId,peerId,token,savedCookie,interactive=false},{openClient,startService,signal,onQr,onPersist,deviceId}={}){
 if(!uid(selfId)||peerId!=null&&(!uid(peerId)||peerId===selfId)||!/^[-_A-Za-z0-9]{40,128}$/.test(token||'')||typeof interactive!=='boolean')throw Error('invalid_configuration');
 if(savedCookie===undefined&&!interactive)throw Error('reauth_required');
 if(!openClient){({openOwnedBiliClient:openClient}=await import('/opt/whale/bili-protocol/src/platforms/bilibili/authorized-client.mjs'));deviceId??=installationId(selfId);}
 const client=await openClient({selfId,peerId,deviceId,onQr,onPersist,signal,savedCookie,interactive});if(!client||signal?.aborted)throw Error('authorization_required');
 try{
  if(!startService)({startBiliService:startService}=await import('/opt/whale/bili-protocol/src/platforms/bilibili/service.mjs'));
  // Bridge.start validates this client's one-shot freshly checked identity before serving.
  const service=await startService({client,selfId,peerId,deviceId,token,port:0,allowSend:!!peerId,accountActions:true,allowAccountWrites:false});
  return {service,close:async()=>{try{await service.close();}finally{await client.close?.();}}};
 }catch(e){await client.close?.();throw e;}
}
function isPipe(fd){const s=fs.fstatSync(fd);return s.isFIFO()||s.isSocket();}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');const ac=new AbortController();let current,timer;
 const stop=async()=>{ac.abort();clearInterval(timer);await current?.close();};for(const sig of ['SIGINT','SIGTERM'])process.once(sig,stop);
 try{
  if(process.argv.length!==2||!isPipe(0)||!isPipe(1))throw Error('invalid_configuration');
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>8192)throw Error('invalid_configuration');}
  const input=JSON.parse(text);text='';const selfId=input.selfId;
  const pending=startOwnedProtocol(input,{signal:ac.signal,onQr:({url,expiresAt})=>emit({state:'awaiting_confirmation',url,expiresAt}),
   onPersist:cookie=>emit({type:'persist_session',selfId,cookie})});delete input.savedCookie;
  current=await pending;if(ac.signal.aborted)await stop();else{
   let received=0,lastReceived=0;current.service.bridge.on('event',e=>{if(e.post_type==='message'&&e.message_type==='private'){received++;lastReceived=Date.now();}});
   const report=()=>{const {service}=current;const s=service.bridge.status();emit(s.online&&s.good?{state:'verified',selfId,port:service.address.port,received,lastReceived}:{state:'disconnected'});};report();timer=setInterval(report,5000);}
 }catch(e){const end=({'Bilibili authorization expired':'expired','Bilibili authorization failed':'authorization_failed','Bilibili authorization cancelled':'stopped'})[e?.message];emit({state:end||(['authorization_required','reauth_required','authorization_failed','identity_mismatch','invalid_configuration'].includes(e?.message)?e.message:'failed')});process.exitCode=1;}
}
