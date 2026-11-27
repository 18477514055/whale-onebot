// [layer: shell-android] 登录与运行已于 2026-11-27 彻底合一进 container-bot.mjs（问答报告 Q8）：
// 本脚本不再单独加载 wrapper.node 打开 login.db（彻底消灭双进程锁库与互覆二维码），
// 若有旧入口误调用本文件，仅向 container-bot.mjs 发送一次按需出码命令 cmd.json 后安全退出。
import fs from 'node:fs';
import path from 'node:path';

const STATE = '/opt/whale/qq-state';
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
const tmp = path.join(STATE, 'cmd.json.next');
const dst = path.join(STATE, 'cmd.json');
fs.writeFileSync(tmp, JSON.stringify({ action: 'request_qr', at: Date.now(), from: 'legacy-login-shim' }), { mode: 0o600 });
fs.renameSync(tmp, dst);
fs.appendFileSync(path.join(STATE, 'bot.log'), `[${new Date().toISOString()}] container-login.mjs 已转发按需出码指令到单进程 container-bot.mjs\n`);
process.exit(0);
