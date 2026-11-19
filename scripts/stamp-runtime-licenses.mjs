// 把上游许可与致谢写进「运行端包」的 app/ 目录（幂等，可重复执行）。
//
// 为什么必须有这一步：
//   我们分发的运行端包内含**改造后的上游源码**（qq-agent-plus 的衍生作品），
//   按 MIT 必须随包保留版权声明与许可全文。仓库里那份原件在
//   `third-party/qq-agent-plus/LICENSE`，没有它就没法打包。
//
// 用法：
//   node scripts/stamp-runtime-licenses.mjs <runtime-dir>            # 干跑：只报会写什么
//   node scripts/stamp-runtime-licenses.mjs <runtime-dir> --write    # 真写
//   node scripts/stamp-runtime-licenses.mjs <runtime-dir> --check    # 只校验，缺了退出码 1
//
// <runtime-dir> 是运行端包的**根**（含 app/ data/ home/ logs/ 那一层）；
// 写进去的是 <runtime-dir>/app/LICENSE 与 <runtime-dir>/app/THIRD_PARTY_NOTICES.md
// —— 容器里的对应路径是 /input/agent-app/app/LICENSE。
import path from 'node:path';
import { planStamp, applyStamp, isStamped } from './lib/stamp-runtime-licenses.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = process.argv[2];
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
if (!dir || dir.startsWith('--')) {
  console.error('用法: node scripts/stamp-runtime-licenses.mjs <runtime-dir> [--write|--check]');
  process.exit(2);
}

const plan = planStamp(dir, { root });
if (plan.errors.length) {
  for (const e of plan.errors) console.error(e);
  process.exit(1);
}

for (const e of plan.entries) {
  console.log((e.state === 'same' ? '已是最新' : check ? '缺失/不一致' : '待写入') + '  ' + path.join('app', e.to));
}

if (check && !isStamped(plan)) {
  console.error('\n不可发版：' + plan.entries.filter(e => e.state !== 'same').length + ' 项未满足');
  process.exit(1);
}
if (!check && !write) {
  const pending = plan.entries.filter(e => e.state !== 'same').length;
  console.log(pending
    ? '\n还差 ' + pending + ' 个文件没写（干跑结束：加 --write 才写盘）。'
    : '\n许可齐了：上游 MIT 全文 + 致谢文件都在 app/ 里。');
  process.exit(0);
}

const written = write ? applyStamp(plan) : [];
if (check) console.log('\n许可齐了：上游 MIT 全文 + 致谢文件都在 app/ 里。');
else console.log(written.length ? '\n已写入 ' + written.length + ' 个文件。' : '\n许可齐了：上游 MIT 全文 + 致谢文件都在 app/ 里。');
