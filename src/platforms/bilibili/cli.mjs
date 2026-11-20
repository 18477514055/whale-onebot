import { startBiliService } from './service.mjs';

const env=process.env;
const usage=`Whale OneBot · Bilibili (authenticated loopback only)
Usage: npm run start:bili -- [--account-actions] [--allow-account-writes] [--browser-comments] [--allow-send]
Required: BILI_SELF_ID, BILI_COOKIE, BILI_ONEBOT_TOKEN. BILI_PORT defaults to 13810.
Default: designated DM conversation (BILI_PEER_ID). --allow-send enables ONLY its text sends (BILI_DEVICE_ID required).
--account-actions enables other named account reads; BILI_PEER_ID may then be omitted to disable DM polling.
--allow-account-writes additionally enables account mutations, including public posts and coin spending.
--browser-comments enables optional isolated browser transport (BILI_BROWSER_DRIVER_PATH, BILI_BROWSER_EXECUTABLE_PATH).
No automatic login, historical replay or resend. Ctrl+C to stop.`;
const args=process.argv.slice(2), flags=new Set(args);
if(args.length===1 && flags.has('--help')) console.log(usage);
else if(flags.size!==args.length || args.some(x=>!['--account-actions','--allow-account-writes','--browser-comments','--allow-send'].includes(x)) || (!flags.has('--account-actions')&&(flags.has('--allow-account-writes')||flags.has('--browser-comments')))) {console.error(usage);process.exitCode=2;}
else {
  try {
    const allowSend=flags.has('--allow-send'), accountActions=flags.has('--account-actions'), allowAccountWrites=flags.has('--allow-account-writes');
    if(!env.BILI_SELF_ID || ((!accountActions || allowSend) && !env.BILI_PEER_ID) || !env.BILI_COOKIE || !env.BILI_ONEBOT_TOKEN) throw Error('CONFIG');
    if((allowSend && !env.BILI_DEVICE_ID) || ((allowSend || allowAccountWrites) && !/(?:^|;\s*)bili_jct=[^;\s]+/.test(env.BILI_COOKIE))) throw Error('WRITE_CONFIG');
    const browserOptions=flags.has('--browser-comments') ? {driverPath:env.BILI_BROWSER_DRIVER_PATH,executablePath:env.BILI_BROWSER_EXECUTABLE_PATH} : undefined;
    if(browserOptions && (!allowAccountWrites || !browserOptions.driverPath || !browserOptions.executablePath)) throw Error('CONFIG');
    const service=await startBiliService({selfId:env.BILI_SELF_ID,peerId:env.BILI_PEER_ID,cookie:env.BILI_COOKIE,deviceId:env.BILI_DEVICE_ID,
      token:env.BILI_ONEBOT_TOKEN,port:Number(env.BILI_PORT ?? 13810),allowSend,accountActions,allowAccountWrites,browserOptions});
    console.log(`Bilibili ready at 127.0.0.1:${service.address.port} (DM send: ${allowSend}; account writes: ${allowAccountWrites})`);
    const close=()=>{service.close().catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',close);process.once('SIGTERM',close);
  } catch(e) {
    const reason=e.message==='CONFIG'?'Missing BILI_* settings or incompatible flags (see --help)':e.message==='WRITE_CONFIG'?'Missing write credentials or device UUID':e.code==='EADDRINUSE'?'Port already in use':'Check authorized identity, credentials, configuration and platform availability';
    const code=typeof e.code==='string' && /^BILI_(?:(?:API_-?|HTTP_)\d{1,8}|IDENTITY_MISMATCH|IDENTITY_UNAVAILABLE|HISTORY_BASELINE)$/.test(e.code)?` (${e.code})`:'';
    console.error(`Bilibili startup failed: ${reason}${code}`);process.exitCode=1;
  }
}
