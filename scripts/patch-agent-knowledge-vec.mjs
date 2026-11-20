// 把运行端 knowledge-lib.js 的「向量检索开关」补上（幂等，可重复执行）。
//
// 背景（2026-11-18 实测）：
//   容器里没装 npm 的 `sqlite-vec` 包，而 knowledge-lib.js 里加载扩展的那两处都写成
//   `if (vec) { db.loadExtension(...) }` —— `vec` 是 npm 模块的 import 结果，没有包就恒为 null，
//   于是**永远不会尝试**加载 `<data>/native/vec0.so`，语义检索被静默降级成纯关键词
//   （实测 stats.vector=false、keywordHits=124448、vecHits=0）。
//   而索引里其实已经有 96,411 条向量（docs_vec），只是从没被用上。
//
// 改法：把那两处 `if (vec) { … }` 的**条件门去掉**，保留外面已有的 try/catch。
//   resolveVecPath() 本来就有「QQ_SQLITE_VEC_PATH → <data>/native/vec0.so → npm 包」的优先顺序，
//   没有可加载的扩展时它会抛错、被外层 catch 接住，行为与原来完全一致。
//
// 用法：
//   node scripts/patch-agent-knowledge-vec.mjs <knowledge-lib.js>          # 干跑，只报命中数
//   node scripts/patch-agent-knowledge-vec.mjs <knowledge-lib.js> --write  # 真写
import fs from 'node:fs';

const file = process.argv[2];
const write = process.argv.includes('--write');
if (!file) {
  console.error('用法: node scripts/patch-agent-knowledge-vec.mjs <knowledge-lib.js> [--write]');
  process.exit(2);
}

const src = fs.readFileSync(file, 'utf8');
const from = 'if (vec) { db.loadExtension(resolveVecPath(vec, dataDir)); hasVec = true; }';
const to = 'db.loadExtension(resolveVecPath(vec, dataDir)); hasVec = true;';
const hits = src.split(from).length - 1;

console.log('目标文件 ' + file);
console.log('命中 ' + hits + ' 处（应为 2：buildIndex 与 search 各一处）');
if (hits === 0) {
  console.log('已经补过或源码结构变了 —— 不写。');
  process.exit(0);
}
const out = src.split(from).join(to);
if (!write) {
  console.log('干跑结束：加 --write 才写盘。');
  process.exit(0);
}
fs.writeFileSync(file, out, 'utf8');
const after = out.split(from).length - 1;
console.log('已写回：' + file + '（残留旧写法 ' + after + ' 处）');
