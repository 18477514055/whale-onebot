#!/usr/bin/env node
// 发布前脱敏自检：扫描仓库里不该公开的串（QQ 号 / uid / 昵称 / 内网地址 / 密钥 / 本机用户名）。
//
// 用法：
//   node scripts/check-secrets.mjs            # 只报告
//   node scripts/check-secrets.mjs --strict   # 命中 BLOCK 级就退出码 1（CI / pre-push 用）
//   node scripts/check-secrets.mjs --json     # 机器可读
//
// 设计原则：
//   · **默认不打印命中的原文**（只给文件:行号 + 掩码），避免这个脚本本身变成泄露源；
//   · 排除运行时/数据/记忆目录（那些本来就不该进仓库，见 .gitignore）；
//   · BLOCK = 一旦公开就会泄露账号/凭据/内网；WARN = 只是本机痕迹，发布前最好也换掉。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// 账号标识从 src/config/account.mjs 读当前值来判定：这样规则永远跟着配置走，不会误报自造的测试 id。
let account = {};
try {
  account = await import(new URL('file://' + path.join(ROOT, 'src', 'config', 'account.mjs').replace(/\\/g, '/')).href);
} catch { account = {}; }
const accountValues = Object.entries(account)
  .filter(([, v]) => typeof v === 'string' && v.length >= 6)
  .map(([k, v]) => ({ key: k, value: v }));

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.tmp', 'runtime', 'backups', 'evidence', 'archive',
  'qq-onebot-ledger-memory', '_stash', 'dist', 'out', 'out-ui', '.build',
  // 第三方 SDK / 本机工具链（不是本项目代码，且体积巨大）—— .gitignore 已排除
  '.tools', 'assets', 'keys',
]);

const RULES = [
  { id: 'account-value', level: 'BLOCK', dynamic: true, why: 'src/config/account.mjs 里配置的真实账号标识' },
  { id: 'tailnet', level: 'BLOCK', re: /tail[0-9a-f]{6,}\.ts\.net/, why: 'Tailscale 内网域名' },
  { id: 'lan-ip', level: 'WARN', re: /\b(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/, why: '内网 / Tailscale IP' },
  { id: 'win-user', level: 'WARN', re: /C:\\\\?Users\\\\?[A-Za-z0-9_.-]+/, why: '本机 Windows 用户名路径' },
  { id: 'api-key', level: 'BLOCK', re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/, why: '疑似 API Key / Token' },
  { id: 'bearer', level: 'WARN', re: /Bearer\s+[A-Za-z0-9._~+/-]{24,}/, why: '硬编码 Bearer Token（确认是假 token 后可忽略）' },
  { id: 'adb-pair', level: 'WARN', re: /\badb\s+pair\s+\S+:\d{4,5}/, why: 'adb 配对命令（带端口/IP）' },
];

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const JSON_OUT = args.has('--json');

const mask = s => (s.length <= 8 ? '*'.repeat(s.length) : s.slice(0, 3) + '*'.repeat(Math.min(12, s.length - 6)) + s.slice(-3));

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.build-')) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out); continue; }
    if (!e.isFile()) continue;
    if (/\.(png|jpg|jpeg|webp|gif|ico|zip|gz|tgz|apk|so|node|bin|p12|jks|db|sqlite)$/i.test(e.name)) continue;
    let size = 0;
    try { size = fs.statSync(full).size; } catch { continue; }
    if (size > 2 * 1024 * 1024) continue;
    out.push(full);
  }
  return out;
}

const hits = [];
for (const file of walk(ROOT)) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;
  const lines = text.split('\n');
  const localRules = [];
  for (const rule of RULES) {
    if (rule.dynamic) {
      for (const { key, value } of accountValues) {
        localRules.push({ id: rule.id + ':' + key, level: rule.level, why: rule.why,
          re: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') });
      }
    } else localRules.push(rule);
  }
  for (const rule of localRules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g');
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        hits.push({ rule: rule.id, level: rule.level, why: rule.why,
          file: path.relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, sample: mask(m[0]) });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    });
  }
}

const byRule = new Map();
for (const h of hits) byRule.set(h.rule, (byRule.get(h.rule) || 0) + 1);
const blocking = hits.filter(h => h.level === 'BLOCK');

if (JSON_OUT) {
  console.log(JSON.stringify({ total: hits.length, blocking: blocking.length,
    byRule: Object.fromEntries(byRule), hits }, null, 2));
} else {
  console.log(`扫描目录：${ROOT}`);
  console.log(`命中：${hits.length} 处${blocking.length ? `（其中 BLOCK 级 ${blocking.length} 处）` : '（无 BLOCK 级）'}`);
  if (byRule.size) {
    console.log('\n按规则：');
    for (const [id, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
      const rule = RULES.find(r => r.id === id) || RULES.find(r => id.startsWith(r.id + ':')) || { level: 'WARN', why: id };
      console.log(`  ${rule.level.padEnd(5)} ${id.padEnd(22)} ${String(n).padStart(5)}  ${rule.why}`);
    }
  }
  const files = new Map();
  for (const h of hits) files.set(h.file, (files.get(h.file) || 0) + 1);
  if (files.size) {
    console.log('\n按文件（前 30）：');
    for (const [f, n] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(n).padStart(5)}  ${f}`);
  }
  if (blocking.length) {
    console.log('\nBLOCK 级明细（原文已掩码，前 40 条）：');
    for (const h of blocking.slice(0, 40)) console.log(`  ${h.file}:${h.line}  [${h.rule}] ${h.sample}  —— ${h.why}`);
  }
  console.log('\n提示：本脚本只报告，不改文件。发布前把 BLOCK 级逐条处理掉（账号标识进环境变量、Key 不入库）。');
}

if (STRICT && blocking.length > 0) process.exitCode = 1;
