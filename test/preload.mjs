// npm test 的 preload：让「干净克隆」也能直接跑测试。
//
// 做两件事：
// 1) 补合成身份默认值（见 account-defaults.mjs）—— 必须在任何测试文件 import 之前生效；
// 2) 建好仓库内的 `.tmp/` 目录 —— 不少测试用 `mkdtempSync('.tmp/xxx')` 放临时文件，
//    而 `.tmp/` 在 .gitignore 里，克隆下来并不存在，于是整批用例会以 ENOENT 失败。
import fs from 'node:fs';
import path from 'node:path';

await import('./account-defaults.mjs');

// 3) 固定消息 id 种子 = 1。生产环境用「开机秒数」做种子（避免重启后 id 与运行端历史撞车、
//    被当成重复消息丢掉），而大量用例是按 `message_id: 1` 写的，所以测试里钉死成 1。
process.env.WHALE_MESSAGE_ID_SEED = '1';

const repoRoot = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
