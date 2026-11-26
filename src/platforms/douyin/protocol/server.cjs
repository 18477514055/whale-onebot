'use strict';
// Node >=20.19 supports require(ESM) without flags. No provider is loaded from env or wire.
const {createService}=require('./service.mjs');
module.exports={createService};
if(require.main===module){
 (async()=>{const {DOUYIN_BOT_ID:botId,DOUYIN_ACCOUNT_ID:accountId,DOUYIN_ONEBOT_TOKEN:token,DOUYIN_PORT:raw='0'}=process.env;
  if(!/^\d{1,5}$/.test(raw))throw Error();const s=createService({botId,accountId,token});const ready=await s.start(Number(raw));console.log(JSON.stringify(ready));
  let closing=false;const stop=()=>{if(!closing){closing=true;s.close().catch(()=>{process.exitCode=1;});}};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 })().catch(()=>{console.error('Douyin OneBot startup failed: check binding, port and credentials.');process.exitCode=1;});
}
