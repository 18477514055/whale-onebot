// 运行端包的许可盖章逻辑（纯函数 + 一个写盘动作），供 CLI 与测试共用。
//
// 为什么这一步存在：我们分发的运行端包内含**改造后的上游源码**（qq-agent-plus 的衍生作品），
// 按 MIT 必须随包保留版权声明与许可全文。原件在 `third-party/qq-agent-plus/LICENSE`。
import fs from 'node:fs';
import path from 'node:path';

/** 上游许可里的版权行 —— 盖章时必须原样出现，否则拒绝。 */
export const UPSTREAM_COPYRIGHT = 'Copyright (c) 2026 Kondius';

/** 要写进运行端包 `app/` 的文件：仓库内原件 → 包内相对路径 + 唯一性校验串。 */
export const STAMP_FILES = [
  { from: 'third-party/qq-agent-plus/LICENSE', to: 'LICENSE', mustContain: UPSTREAM_COPYRIGHT },
  { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md', mustContain: 'qq-agent-plus' },
];

/**
 * 算出「该写什么」，不写盘。
 * @param {string} runtimeDir 运行端包根目录（含 app/ data/ home/ logs/ 那一层）
 * @param {{root:string}} options root = 仓库根
 * @returns {{target:string, appDir:string, entries:Array, errors:string[]}}
 */
export function planStamp(runtimeDir, { root }) {
  const target = path.resolve(runtimeDir);
  const appDir = path.join(target, 'app');
  const errors = [];
  const entries = [];
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    return { target, appDir, entries, errors: ['不是运行端包根目录（找不到 app/）: ' + target] };
  }
  for (const spec of STAMP_FILES) {
    const from = path.join(root, spec.from);
    if (!fs.existsSync(from)) { errors.push('缺原件: ' + spec.from); continue; }
    const body = fs.readFileSync(from, 'utf8');
    if (!body.includes(spec.mustContain)) {
      errors.push('原件里没有「' + spec.mustContain + '」，拒绝盖章: ' + spec.from);
      continue;
    }
    const dest = path.join(appDir, spec.to);
    const same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === body;
    entries.push({ to: spec.to, dest, body, state: same ? 'same' : 'pending' });
  }
  return { target, appDir, entries, errors };
}

/**
 * 真正写盘（只写 state === 'pending' 的）。
 * @returns {string[]} 写了的包内相对路径
 */
export function applyStamp(plan) {
  const written = [];
  for (const e of plan.entries) {
    if (e.state !== 'pending') continue;
    fs.writeFileSync(e.dest, e.body, 'utf8');
    e.state = 'same';
    written.push(e.to);
  }
  return written;
}

/** 是否已满足发版条件（原件都在、包里都是最新的）。 */
export function isStamped(plan) {
  return plan.errors.length === 0 && plan.entries.every(e => e.state === 'same');
}
