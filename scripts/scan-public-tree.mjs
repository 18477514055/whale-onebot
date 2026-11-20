// 公开仓发布前的脱敏扫描：把「不该出现在公开仓里的东西」找出来。
// 只读，不改文件。命中就打印 文件:行 + 类型 + 脱敏后的片段（**不打印真实值全貌**）。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));

// 不该出现在公开仓里的目录
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tools', '.tmp', 'evidence', 'backups', 'dist',
  'runtime', 'logs', 'data', '_notes', '_stash', 'archive', 'qq-onebot-ledger-memory', 'android/out',
  'android/.build-']);

const RULES = [
  ['真实 BOT 账号', /3752609028/g],
  ['真实 OWNER 账号', /2423936413/g],
  ['真实群号', /\b(991516986|529433409|597813964|780739184|953479664|871721981|113088233|559715541|1106470947|893106553|1013806041|1054041195)\b/g],
  ['内网/设备 IP', /\b(100\.75\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)\b/g],
  ['真实姓名', /陈黛华/g],
  ['可能的密钥', /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{24,})/g],
  ['本机绝对路径', /[A-Za-z]:\\\\?Users\\\\?24239|[A-Za-z]:\/Users\/24239/g],
];

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.build-')) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).replaceAll('\\', '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(rel)) continue;
      walk(full);
      continue;
    }
    if (!e.isFile()) continue;
    if (!/\.(java|mjs|js|json|md|ps1|xml|gradle|txt|yml|yaml|properties|sh)$/i.test(e.name)) continue;
    if (e.size > 2 * 1024 * 1024) continue;
    files.push({ full, rel });
  }
}
walk(root);

const hits = new Map();
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f.full, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [kind, re] of RULES) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) continue;
      const v = m[0];
      const masked = v.length <= 6 ? v.slice(0, 2) + '***' : v.slice(0, 2) + '***' + v.slice(-2);
      if (!hits.has(kind)) hits.set(kind, []);
      hits.get(kind).push(f.rel + ':' + (i + 1) + '  ' + masked);
    }
  });
}

console.log('扫描文件数:', files.length);
if (!hits.size) {
  console.log('✅ 没发现需要脱敏的内容');
} else {
  for (const [kind, list] of hits) {
    console.log('\n== ' + kind + '（' + list.length + ' 处）==');
    for (const h of list.slice(0, 12)) console.log('  ' + h);
    if (list.length > 12) console.log('  …还有 ' + (list.length - 12) + ' 处');
  }
}
