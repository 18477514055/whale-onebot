import fs from 'node:fs';
import path from 'node:path';
import {requireBindingEndpoints} from '../../core/platform-endpoints.js';

export function standaloneInstance(env) {
  const marker = '.whale-bili-instance';
  const dir = env.QQ_AGENT_DATA_DIR;
  requireBindingEndpoints(env);
  const selfId = env.WHALE_BILI_SELF_ID;
  if (!/^[1-9]\d*$/.test(selfId || '') || !Number.isSafeInteger(Number(selfId))) throw new Error('Invalid Bilibili UID');
  const port = Number(env.WHALE_BILI_CONSOLE_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3210 ||
      [env.WHALE_ONEBOT_HTTP_URL, env.WHALE_ONEBOT_WS_URL].some(url => +new URL(url).port === port)) throw new Error('Dedicated Bilibili console port required');
  if (!dir || !path.isAbsolute(dir) || path.basename(dir) !== `bilibili-${selfId}`) throw new Error('Dedicated absolute bilibili-<UID> data directory required');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (path.relative(fs.realpathSync(dir), path.resolve(dir)) !== '') throw new Error('Bilibili data directory must not be redirected');
  const file = path.join(dir, marker);
  if (!fs.existsSync(file)) {
    if (fs.readdirSync(dir).length) throw new Error('Refusing existing unmarked Bilibili data directory');
    fs.writeFileSync(file, selfId, { flag: 'wx', mode: 0o600 });
  } else if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== selfId) throw new Error('Bilibili data identity mismatch');
  return Object.freeze({ selfId, port });
}
