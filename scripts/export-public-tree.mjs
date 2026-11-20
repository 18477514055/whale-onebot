// 把「要公开的那部分」导出到 <out>，并在导出副本上做脱敏替换。
// 只读源树、不改源树；重复跑会覆盖导出目录。
//
// 用法：node scripts/export-public-tree.mjs [--out .tmp/public-export]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(value('out', path.join(root, '.tmp/public-export')));

// 公开仓带哪些东西（明确列举，不靠排除法 —— 排除法迟早漏东西）
const INCLUDE_DIRS = [
  'src',
  'test',
  'scripts/lib',
  'android/app/src',
  'android/app/res',
  'android/app/icons',
  'docs',
  'runtime-index',
  'third-party',
];
const INCLUDE_FILES = [
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.gitignore',
  'android/build.ps1', 'android/app/AndroidManifest.xml', 'android/container-bot.mjs',
  'android/container-login.mjs', 'android/agent-preload.mjs',
  'scripts/check.mjs', 'scripts/run-java-logic-tests.mjs', 'scripts/make-app-icons.mjs',
  'scripts/build-runtime-index.mjs', 'scripts/build-runtime-package.mjs',
  'scripts/stamp-runtime-licenses.mjs', 'scripts/check-secrets.mjs',
];
// docs 里属于「维护者/内部」的，公开仓不带
const SKIP_PATHS = new Set([
  'docs/build-and-signing.md',
  'docs/conversation-settings-audit.md',
  'docs/outbound-archive.md',
  'docs/public-repo-spec.md',
  'docs/update-and-models-spec.md',
]);
const SKIP_NAMES = new Set(['.git', 'node_modules', '.build-', 'keys', 'out', 'out-ui', 'out-config']);

// 脱敏映射（真实值 → 占位）
const MAP = [
  ['3752609028', '100000001'], ['2423936413', '100000002'],
  ['991516986', '200000001'], ['529433409', '200000002'], ['597813964', '200000003'],
  ['780739184', '200000004'], ['953479664', '200000005'], ['871721981', '200000006'],
  ['113088233', '200000007'], ['559715541', '200000008'], ['1106470947', '200000009'],
  ['893106553', '200000010'], ['1013806041', '200000011'], ['1054041195', '200000012'],
  ['100.75.35.64', '192.0.2.10'], ['100.75.', '192.0.2.'],
  ['C:\\Users\\24239', '%USERPROFILE%'], ['C:/Users/24239', '%USERPROFILE%'],
  ['D:\\qq-onebot', '<repo>'], ['D:/qq-onebot', '<repo>'],
];
const TEXT_EXT = /\.(java|mjs|js|json|md|ps1|xml|gradle|txt|yml|yaml|properties|sh|mjs)$/i;

const stats = { files: 0, bytes: 0, rewritten: 0, skipped: [] };

function sanitize(rel, text) {
  let out = text;
  for (const [from, to] of MAP) out = out.split(from).join(to);
  if (out !== text) stats.rewritten++;
  return out;
}

function copyFile(srcFull, rel) {
  if (SKIP_PATHS.has(rel)) { stats.skipped.push(rel); return; }
  const destFull = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  const buf = fs.readFileSync(srcFull);
  if (TEXT_EXT.test(rel)) {
    fs.writeFileSync(destFull, sanitize(rel, buf.toString('utf8')), 'utf8');
  } else {
    fs.writeFileSync(destFull, buf);
  }
  stats.files++;
  stats.bytes += buf.length;
}

function walk(srcDir, relBase) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(e.name) || e.name.startsWith('.build-')) continue;
    const full = path.join(srcDir, e.name);
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(full, rel); continue; }
    if (!e.isFile()) continue;
    copyFile(full, rel);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const d of INCLUDE_DIRS) {
  const full = path.join(root, d);
  if (!fs.existsSync(full)) { console.warn('缺目录，跳过: ' + d); continue; }
  walk(full, d);
}
for (const f of INCLUDE_FILES) {
  const full = path.join(root, f);
  if (!fs.existsSync(full)) { console.warn('缺文件，跳过: ' + f); continue; }
  copyFile(full, f);
}

console.log('导出到 ' + outDir);
console.log('文件 ' + stats.files + ' 个，原始合计 ' + (stats.bytes / 1024 / 1024).toFixed(1) + ' MB，被脱敏改写 ' + stats.rewritten + ' 个');
if (stats.skipped.length) console.log('按规则跳过 ' + stats.skipped.length + ' 个（维护者/内部文档）');
