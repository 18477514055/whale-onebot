#!/usr/bin/env node
/**
 * 生成 / 更新**内置运行端索引**（`runtime-index/index.json`）。
 *
 * 为什么要有这个脚本：索引里必须写准 `bytes` 与 `sha256` —— 下载器会拿它们做硬校验，
 * 手抄一次就可能错一个字符，然后所有人下载都失败。所以让脚本算。
 *
 * 用法（在仓库根跑）：
 *   node scripts/build-runtime-index.mjs \
 *     --file D:/build/runtime-1.0.1.zip \
 *     --version 1.0.1 \
 *     --url https://github.com/<owner>/<repo>/releases/download/v1.0.1/runtime-1.0.1.zip
 *
 * 可选：
 *   --min-app 1        最低 versionCode（比它新的 App 才认这条；默认 1）
 *   --notes "…"        一行说明
 *   --out <path>       索引文件（默认 runtime-index/index.json）
 *   --dry-run          只打印，不写文件
 *
 * 语义：
 *   · 同一个 version 已存在 ⇒ 覆盖它的 url/bytes/sha256/minApp/notes（幂等，可反复跑）；
 *   · 新 version ⇒ 追加；
 *   · 写完按版本号倒序排列，最新在最前（App 端也是挑最大版本，顺序只是给人看）。
 *
 * 退出码：0 成功；2 参数不对；3 文件读不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULTS = { out: path.join(ROOT, 'runtime-index', 'index.json') };

function usage(msg) {
  if (msg) console.error('✗ ' + msg);
  console.error('用法: node scripts/build-runtime-index.mjs --file <zip> --version <x.y.z> --url <https://…>');
  process.exit(2);
}

const argv = process.argv.slice(2);
const opt = { ...DEFAULTS, minApp: 1, notes: '', dryRun: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v == null) usage('缺少 ' + a + ' 的值');
    return v;
  };
  switch (a) {
    case '--file': opt.file = next(); break;
    case '--version': opt.version = next(); break;
    case '--url': opt.url = next(); break;
    case '--min-app': opt.minApp = Number(next()); break;
    case '--notes': opt.notes = next(); break;
    case '--out': opt.out = path.resolve(ROOT, next()); break;
    case '--dry-run': opt.dryRun = true; break;
    case '-h': case '--help': usage(); break;
    default: usage('未知参数 ' + a);
  }
}

if (!opt.file) usage('必须给 --file');
if (!opt.version) usage('必须给 --version');
if (!opt.url) usage('必须给 --url');
if (!/^https?:\/\//i.test(opt.url)) usage('--url 必须是 http(s) 地址');
if (!/^[0-9A-Za-z._-]+$/.test(opt.version)) usage('--version 只能用字母数字与 . _ -');
if (!Number.isFinite(opt.minApp) || opt.minApp < 1) usage('--min-app 必须是 ≥1 的整数');

let bytes;
try {
  const st = fs.statSync(opt.file);
  if (!st.isFile()) usage('--file 不是文件：' + opt.file);
  bytes = st.size;
} catch (e) {
  console.error('✗ 读不到文件：' + opt.file + '（' + e.message + '）');
  process.exit(3);
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(opt.file)).digest('hex');
if (sha256.length !== 64) usage('sha256 计算异常');
if (bytes <= 0) usage('文件是空的：' + opt.file);

// ---- 读现有索引（没有就新建；坏了直接报错，不覆盖用户手里的东西）
let doc = { schemaVersion: 1, entries: [] };
if (fs.existsSync(opt.out)) {
  try {
    doc = JSON.parse(fs.readFileSync(opt.out, 'utf8'));
  } catch (e) {
    console.error('✗ 现有索引不是合法 JSON，先修好再跑：' + opt.out + '（' + e.message + '）');
    process.exit(2);
  }
}
if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = { schemaVersion: 1, entries: [] };
if (!Array.isArray(doc.entries)) doc.entries = [];
doc.schemaVersion = doc.schemaVersion || 1;

const entry = {
  version: opt.version,
  url: opt.url,
  bytes,
  sha256,
  minApp: Math.round(opt.minApp),
};
if (opt.notes) entry.notes = opt.notes;

const at = doc.entries.findIndex((e) => e && String(e.version) === String(entry.version));
const action = at >= 0 ? 'update' : 'add';
if (at >= 0) doc.entries[at] = entry; else doc.entries.push(entry);

// 版本号倒序（给人看；App 端自己挑最大版本，顺序不影响行为）
const parts = (v) => String(v || '').split(/[.\-+_ ]/).map((s) => parseInt(s, 10) || 0);
doc.entries.sort((a, b) => {
  const pa = parts(a.version);
  const pb = parts(b.version);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
});

const text = JSON.stringify(doc, null, 2) + '\n';
console.log('索引: ' + path.relative(ROOT, opt.out));
console.log('动作: ' + action + ' ' + opt.version + '（' + doc.entries.length + ' 条）');
console.log('  体积: ' + bytes + ' B');
console.log('  sha256: ' + sha256);
console.log('  地址: ' + opt.url);
if (opt.dryRun) {
  console.log('（--dry-run，未写文件）');
  process.exit(0);
}
fs.mkdirSync(path.dirname(opt.out), { recursive: true });
fs.writeFileSync(opt.out, text, 'utf8');
console.log('已写入。');
