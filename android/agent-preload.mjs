// 只注入 OneBot 连接信息（地址 + token）：模型凭据仍用业务配置里原有的，不引入任何 relay。
//
// ★ 地址必须由这里强制注入，而不是依赖 /agent/data/config.json：
//   机器人每次重启端口都会变（随机端口，避免和上一代抢 EADDRINUSE），
//   而 config.json 可能被业务程序回收/重写，导致 agent 拿着上一代端口一直「30 秒后重连」。
import { registerHooks } from 'node:module';
if (process.env.WHALE_ORIGINAL_AGENT !== '1') throw Error('ORIGINAL_PRELOAD_NOT_ARMED');

const target = 'file:///input/agent-app/src/onebot/onebot.js';
const constructor = "  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent, heartbeat = 'auto', heartbeatMs = HEARTBEAT_MS }) {";

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    const text = Buffer.from(loaded.source).toString('utf8');
    if (text.split(constructor).length !== 2) throw Error('ONEBOT_SOURCE_CHANGED');
    return {
      ...loaded,
      source: text.replace(constructor, constructor + `
    if (process.env.WHALE_ONEBOT_WS_URL) wsUrl = process.env.WHALE_ONEBOT_WS_URL;
    if (process.env.WHALE_ONEBOT_HTTP_URL) httpUrl = process.env.WHALE_ONEBOT_HTTP_URL;
    accessToken = process.env.WHALE_ONEBOT_TOKEN; httpToken = process.env.WHALE_ONEBOT_TOKEN;`),
    };
  },
});
