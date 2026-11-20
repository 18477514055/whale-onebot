import fs from 'node:fs';
import path from 'node:path';

export function slug(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value); }
export function checkEndpoint(raw, protocol) {
  let url; try { url = new URL(raw); } catch { throw Error('Invalid binding endpoint'); }
  if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw Error('Explicit loopback OneBot endpoint required');
  return url;
}
export function validateAccount(platform, selfId) {
  if (!['qq', 'bilibili'].includes(platform) || typeof selfId !== 'string' || !/^[1-9]\d*$/.test(selfId) || !Number.isSafeInteger(Number(selfId))) throw Error('Invalid explicit binding identity');
}
export function managedInstance(env) {
  const { QQ_AGENT_BINDING_ID: id, QQ_AGENT_ROBOT_ID: botId, WHALE_AGENT_PLATFORM: platform, WHALE_BINDING_SELF_ID: selfId, QQ_AGENT_DATA_DIR: dir } = env;
  if (!slug(id) || !slug(botId)) throw Error('Invalid managed binding');
  validateAccount(platform, selfId);
  const ports = [checkEndpoint(env.WHALE_ONEBOT_HTTP_URL,'http:'),checkEndpoint(env.WHALE_ONEBOT_WS_URL,'ws:')].map(url => +url.port);
  const port = Number(env.WHALE_BINDING_CONSOLE_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3210 || ports.includes(port) || !env.WHALE_ONEBOT_TOKEN?.trim()) throw Error('Invalid managed binding transport');
  if (!dir || !path.isAbsolute(dir) || path.basename(dir) !== `${platform}-${selfId}` || path.basename(path.dirname(dir)) !== id) throw Error('Dedicated worker directory required');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if (path.relative(fs.realpathSync(dir),path.resolve(dir))) throw Error('Redirected worker directory');
  const file = path.join(dir,'.whale-binding'), identity = JSON.stringify([botId,id,platform,selfId]);
  if (!fs.existsSync(file)) {
    if (fs.readdirSync(dir).length) throw Error('Refusing unmarked worker data');
    fs.writeFileSync(file,identity,{flag:'wx',mode:0o600});
  } else if (!fs.lstatSync(file).isFile() || fs.readFileSync(file,'utf8') !== identity) throw Error('Worker directory ownership mismatch');
  return Object.freeze({id,botId,platform,selfId,port});
}
