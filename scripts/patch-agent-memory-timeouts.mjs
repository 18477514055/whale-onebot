#!/usr/bin/env node
/**
 * 给原作者 agent 的 `src/memory/memory-vec.js` 放宽两个超时（幂等）。
 *
 * 为什么：`fetchJson` 的默认超时是 **5000ms**，embed 与 rerank 各用一次。手机网络抖动时
 * （实测 TLS 握手/排队会到 5~10 秒）就会 abort，`searchForPerson` 静默返回空数组 ——
 * 表现是「作者原本的记忆功能还在，但召回时好时坏」。
 *
 * 改动（只动这两个数字，逻辑一行不改）：
 *   embed  → 5000 → 12000
 *   rerank → 5000 → 20000
 *
 * 用法：
 *   node scripts/patch-agent-memory-timeouts.mjs <agent-app-dir>
 *   node scripts/patch-agent-memory-timeouts.mjs /input/agent-app      # 容器里
 *   node scripts/patch-agent-memory-timeouts.mjs <dir> --check          # 只检查，退出码 1 = 未打
 *
 * 退出码：0 成功（或已打过）；1 目标文件/锚点不对；2 参数不对。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dir = argv.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('用法: node scripts/patch-agent-memory-timeouts.mjs <agent-app-dir> [--check]');
  process.exit(2);
}

const target = path.join(dir, 'src/memory/memory-vec.js');
if (!fs.existsSync(target)) {
  console.error('✗ 找不到 ' + target);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
const EDITS = [
  {
    name: 'embed',
    from: 'const json = await fetchJson(`${cfg.base}/embeddings`, body, cfg.key, 5000);',
    to: 'const json = await fetchJson(`${cfg.base}/embeddings`, body, cfg.key, 12000);',
  },
  {
    name: 'rerank',
    from: '}, cfg.rerankKey, 5000);',
    to: '}, cfg.rerankKey, 20000);',
  },
];

let changed = 0;
const missing = [];
for (const e of EDITS) {
  const hits = src.split(e.from).length - 1;
  if (hits === 1) {
    if (!checkOnly) src = src.split(e.from).join(e.to);
    changed++;
    continue;
  }
  if (hits === 0) {
    // 已经打过了 ⇒ 目标串存在即视为 OK
    if (src.includes(e.to)) {
      console.log('· ' + e.name + ' 已是放宽后的值');
      continue;
    }
    missing.push(e.name);
    continue;
  }
  missing.push(e.name + '（锚点出现 ' + hits + ' 次，拒绝改）');
}

if (missing.length) {
  console.error('✗ 锚点不对：' + missing.join('；'));
  process.exit(1);
}
if (changed === 0) {
  console.log('已是最新，无需改动：' + target);
  process.exit(0);
}
if (checkOnly) {
  console.log('未打补丁（需要改 ' + changed + ' 处）：' + target);
  process.exit(1);
}
fs.writeFileSync(target, src, 'utf8');
console.log('已改 ' + changed + ' 处超时：' + target);
