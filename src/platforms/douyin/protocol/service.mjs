import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {actions,kinds,writes,check,obj,id,only,paramsFor,eventFor,resultFor} from './contract.mjs';

const MAX=65536, meta=['get_login_info','get_status','get_capabilities'];
const hash=v=>createHash('sha256').update(v).digest();
function waitBounded(job,signal){
 return new Promise((res,rej)=>{const abort=()=>rej(Error('stopped'));if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{signal.throwIfAborted();return job();}).then(res,rej).finally(()=>signal.removeEventListener('abort',abort));});
}
function deepFreeze(o){if(o&&typeof o==='object'){for(const x of Object.values(o))deepFreeze(x);Object.freeze(o);}return o;}
export function createService({accountId,botId,token,provider=null,grants=[],authorizeWrite,timeoutMs=30000,requestWindow=65536}){
 id(accountId);id(botId);check(typeof token==='string'&&/^[A-Za-z0-9._~+-]{32,256}$/.test(token));
 check(Number.isSafeInteger(requestWindow)&&requestWindow>=1&&requestWindow<=65536);
 check(Number.isSafeInteger(timeoutMs)&&timeoutMs>=20&&timeoutMs<=120000);
 const secret=hash(token), allowed=new Set(grants), simulation=provider?.simulation===true;
 const shutdown=new AbortController(), spent=new Set(), pending=new Set();let busy=0,started=false;
 const active=()=>!shutdown.signal.aborted&&provider?.botId===botId&&provider?.accountId===accountId&&provider?.simulation===simulation&&provider?.online===true;
 const identity=()=>({platform:'douyin',bot_id:botId,account_id:accountId,simulation,online:active()});
 const can=a=>active()&&actions.includes(a)&&allowed.has(a)&&Object.hasOwn(provider.actions??{},a)&&typeof provider.actions[a]==='function'&&(!writes.includes(a)||simulation||typeof authorizeWrite==='function');
 const hears=k=>active()&&kinds.includes(k)&&allowed.has(k)&&Array.isArray(provider.events)&&provider.events.includes(k);
 async function dispatch(req,clientGone){
  const base={...identity()};if(req&&Object.hasOwn(req,'echo')&&(req.echo===null||typeof req.echo==='string'||Number.isSafeInteger(req.echo)))base.echo=req.echo;
  const fail=(retcode,message)=>({...base,status:'failed',retcode,message,data:null});
  const ok=data=>({...base,status:'ok',retcode:0,message:'',data});
  try{only(req,['action','params','echo']);check(typeof req.action==='string');if('echo'in req)check('echo'in base);}catch{return fail(1400,'bad_request');}
  const a=req.action,p=req.params===undefined?{}:req.params;
  if(meta.includes(a)){try{only(p,[]);}catch{return fail(1400,'invalid_params');}const i=identity();return ok({...i,...(a==='get_login_info'?{user_id:accountId,nickname:accountId}:a==='get_status'?{good:i.online}:{actions:actions.filter(can),events:kinds.filter(hears)})});}
  if(!actions.includes(a))return fail(1404,'unsupported_action');if(!can(a))return fail(1403,'capability_unavailable');
  try{paramsFor(a,p);deepFreeze(p);}catch{return fail(1400,'invalid_params');}
  if(busy>=16)return fail(1429,'busy');const write=writes.includes(a);
  if(write){if(pending.has(p.request_id)||spent.has(p.request_id))return fail(1409,'duplicate_request');pending.add(p.request_id);}
  const signal=AbortSignal.any([shutdown.signal,clientGone,AbortSignal.timeout(timeoutMs)]), ctx=Object.freeze({...identity(),action:a,signal});
  busy++;let invoked=false;
  try{
   if(write&&authorizeWrite&&await waitBounded(()=>authorizeWrite(Object.freeze({...ctx,params:p})),signal)!==true)return fail(1403,'authorization_denied');
   if(!can(a)||signal.aborted)return fail(1403,'capability_unavailable');
   const result=await waitBounded(()=>{check(can(a));invoked=true;return provider.actions[a](p,ctx);},signal);
   if(!can(a))return fail(write?1502:1403,write?'outcome_unknown':'capability_unavailable');
   return ok(resultFor(a,p,result));
  }catch{return fail(invoked&&write?1502:1503,invoked&&write?'outcome_unknown':'provider_unavailable');}finally{
   if(write){pending.delete(p.request_id);if(spent.size>=requestWindow)spent.delete(spent.values().next().value);spent.add(p.request_id);}
   busy--;
  }
 }
 const ws=new WebSocketServer({noServer:true,maxPayload:MAX,perMessageDeflate:false});
 function auth(req,upgrade=false){
  try{const u=new URL(req.url,'http://127.0.0.1');if(req.headers.origin||u.origin!=='http://127.0.0.1'||!req.url.startsWith('/'))return false;
   const header=req.headers.authorization,qs=u.searchParams.getAll('access_token');
   if([...u.searchParams.keys()].some(k=>k!=='access_token')||qs.length>1||(!upgrade&&u.search))return false;
   const supplied=header?.startsWith('Bearer ')?header.slice(7):undefined;if(header!==undefined&&!supplied)return false;
   const candidates=[supplied,...qs].filter(v=>v!==undefined);return candidates.length>0&&candidates.every(v=>timingSafeEqual(hash(v),secret));
  }catch{return false;}
 }
 const server=http.createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:8192},async(req,res)=>{
  const end=(status,data)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));}};
  if(!auth(req))return end(401,{error:'unauthorized'});if(req.method!=='POST')return end(405,{error:'post_required'});
  const path=req.url.slice(1),envelope=path===''||path==='action';if(!envelope&&![...actions,...meta].includes(path))return end(404,{error:'not_found'});
  if((req.headers['content-type']||'').split(';')[0].trim()!=='application/json')return end(415,{error:'json_required'});
  const gone=new AbortController();res.once('close',()=>gone.abort());
  try{let size=0;const parts=[];for await(const c of req){size+=c.length;if(size>MAX)return end(413,{error:'payload_limit'});parts.push(c);}const body=JSON.parse(Buffer.concat(parts).toString('utf8'));const reply=await dispatch(envelope?body:{action:path,params:body},gone.signal);end(!envelope&&reply.retcode===1502?502:200,reply);}catch{end(400,{error:'invalid_json'});}
 });
 server.maxConnections=64;
 server.on('upgrade',(req,socket,head)=>{
  socket.on('error',()=>socket.destroy());const path=req.url.split('?')[0];if(!auth(req,true)||!['/','/ws'].includes(path))return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  ws.handleUpgrade(req,socket,head,client=>{const gone=new AbortController();client.once('close',()=>gone.abort());client.on('error',()=>client.terminate());client.on('message',async(data,binary)=>{if(binary)return client.close(1003);let msg;try{msg=JSON.parse(data.toString());}catch{return client.close(1007);}const reply=await dispatch(msg,gone.signal);send(client,reply);});});
 });
 function send(client,o){if(client.readyState!==WebSocket.OPEN)return;if(client.bufferedAmount>2*1024*1024)return client.terminate();client.send(JSON.stringify(o),e=>{if(e)client.terminate();});}
 return {
  async start(port=0){check(!started&&!shutdown.signal.aborted&&Number.isInteger(port)&&port>=0&&port<=65535);started=true;await new Promise((res,rej)=>{server.once('error',rej);server.listen(port,'127.0.0.1',()=>{server.off('error',rej);res();});});port=server.address().port;return {port,httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}/ws`};},
  publish(raw){if(!hears(raw?.kind))return false;const event=eventFor(raw,identity());for(const c of ws.clients)send(c,event);return true;},
  async close(){shutdown.abort();for(const c of ws.clients)c.terminate();ws.close();if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
 };
}
