#!/usr/bin/env node
// 把 src/ test/ experiments/ scripts/ 里散落的真实账号标识收敛到 src/config/account.mjs 一个地方。
//
// 为什么：`BOT_UIN` / `OWNER_UIN` / uid 之前硬编码在十几个文件里，发布到 GitHub 就等于公开账号。
// 收敛后，发布前只改 account.mjs 的默认值（或环境变量注入）。
//
// ★ 本脚本**不含任何真实号码**：它从 src/config/account.mjs 读当前值来构造替换规则，
//   所以脚本本身可以安全地进仓库。
// ★ 行为不变：account.mjs 的默认值仍是当前号，测试无需改动即通过。
// ★ 幂等：重复跑不会二次替换。
//
//   node scripts/desensitize-accounts.mjs           # 干跑
//   node scripts/desensitize-accounts.mjs --apply   # 写入

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CONFIG_FILE = path.join(ROOT, 'src', 'config', 'account.mjs');
const APPLY = process.argv.includes('--apply');
const TARGET_DIRS = ['src', 'test', 'experiments', 'scripts'];

if (!fs.existsSync(CONFIG_FILE)) {
  console.error('缺少 src/config/account.mjs —— 请先创建（导出 BOT_UIN / OWNER_UIN / BOT_UID / TEST_GROUP）');
  process.exit(2);
}
const cfg = await import(new URL('file://' + CONFIG_FILE.replace(/\\/g, '/')).href);
const NAMES = ['BOT_UIN', 'OWNER_UIN', 'BOT_UID', 'TEST_GROUP'];
const isNumeric = new Set(['BOT_UIN', 'OWNER_UIN', 'TEST_GROUP']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = TARGET_DIRS.flatMap(d => walk(path.join(ROOT, d))).filter(f => f !== CONFIG_FILE);

let touched = 0, total = 0;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const file of files) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before, count = 0;
  for (const name of NAMES) {
    const value = String(cfg[name] ?? '');
    if (!value) continue;
    after = after.replace(new RegExp(`['"]${esc(value)}['"]`, 'g'), () => { count++; return name; });
    if (isNumeric.has(name)) {
      after = after.replace(new RegExp(`(?<![\\w'"])${esc(value)}(?![\\w'"])`, 'g'), () => { count++; return `Number(${name})`; });
    }
  }
  if (!count) continue;

  const needed = NAMES.filter(n => new RegExp(`\\b${n}\\b`).test(after) &&
    !new RegExp(`import[^;]*\\b${n}\\b[^;]*from`).test(after));
  if (needed.length) {
    let rel = path.relative(path.dirname(file), CONFIG_FILE).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    const line = `import { ${needed.join(', ')} } from '${rel}';`;
    const lines = after.split('\n');
    let lastImport = -1;
    for (let i = 0; i < Math.min(lines.length, 80); i++) if (/^\s*import\s/.test(lines[i])) lastImport = i;
    if (lastImport >= 0) lines.splice(lastImport + 1, 0, line);
    else lines.unshift(line);
    after = lines.join('\n');
  }

  touched++; total += count;
  console.log(`${APPLY ? '写入' : '待改'} ${path.relative(ROOT, file).replace(/\\/g, '/')}  (${count} 处)`);
  if (APPLY) fs.writeFileSync(file, after);
}

console.log(`\n${APPLY ? '已写入' : '干跑'}：${touched} 个文件、${total} 处`);
if (!APPLY) console.log('确认无误后加 --apply，然后跑完整测试套件。');
