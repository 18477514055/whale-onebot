#!/usr/bin/env node
// 把 docs/ 里出现的真实账号标识替换成占位符（幂等，可重复跑）。
//
// ★ 本脚本不含任何真实号码：从 src/config/account.mjs 读当前值来构造替换规则。
// 为什么只动 docs/：源码里的账号常量是业务必需的（要和真实 QQ 号比对），那一部分
// 已经收敛到 src/config/account.mjs（见 scripts/desensitize-accounts.mjs）。
//
// 用法：node scripts/desensitize-docs.mjs           # 干跑，只报告会改哪些行
//       node scripts/desensitize-docs.mjs --apply   # 真正写入

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DOCS = path.join(ROOT, 'docs');
const CONFIG_FILE = path.join(ROOT, 'src', 'config', 'account.mjs');
const APPLY = process.argv.includes('--apply');

const cfg = await import(new URL('file://' + CONFIG_FILE.replace(/\\/g, '/')).href);
const PLACEHOLDER = {
  BOT_UIN: '<BOT_UIN>',
  OWNER_UIN: '<OWNER_UIN>',
  BOT_UID: '<BOT_UID>',
  TEST_GROUP: '<TEST_GROUP>',
};
const MAP = [];
for (const [name, to] of Object.entries(PLACEHOLDER)) {
  const value = String(cfg[name] ?? '');
  if (value) MAP.push([new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to]);
}
MAP.push([/tail[0-9a-f]{6,}\.ts\.net/g, '<TAILNET>.ts.net']);
MAP.push([/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, '<PHONE_IP>']);

function rootDocs() {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isFile() && /\.(md|txt)$/i.test(e.name))
      .map(e => path.join(ROOT, e.name));
  } catch { return []; }
}

let changedFiles = 0;
let changedLines = 0;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && /\.(md|txt)$/i.test(e.name)) out.push(full);
  }
  return out;
}

for (const file of [...walk(DOCS), ...rootDocs()]) {
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of MAP) after = after.replace(re, to);
  if (after === before) continue;
  const lines = before.split('\n');
  const outLines = after.split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i] !== outLines[i]) n++;
  changedFiles++;
  changedLines += n;
  console.log(`${APPLY ? '写入' : '待改'} ${path.relative(ROOT, file).replace(/\\/g, '/')}  (${n} 行)`);
  if (APPLY) fs.writeFileSync(file, after);
}

console.log(`\n${APPLY ? '已写入' : '干跑'}：${changedFiles} 个文件、${changedLines} 行`);
if (!APPLY && changedFiles) console.log('确认无误后加 --apply 真正写入。');
