// 打「内置机器人」运行包：**只含运行端与协议端源码**，不含 1.2 GB 的 rootfs 骨架。
//
// 为什么这么切：
//   骨架（Debian rootfs）是一次性的大件，用户装一次就够了；真正会变的是两样东西 ——
//   运行端（/input/agent-app）与协议端（/qq-onebot/src）。把它们单独打成 `runtime-<ver>.zip`，
//   「检查更新 → 下载 → 覆盖进 rootfs → 重启机器人」就变成了几十 MB 的操作，
//   而不是每次都让用户重下 1.2 GB。
//
// 包内布局（解包到 rootfs 根目录，路径全部正斜杠）：
//   input/agent-app/**           运行端（含 LICENSE 与致谢，MIT 要求随包分发）
//   qq-onebot/src/**             协议端源码
//   qq-onebot/package.json       协议端依赖声明（不含 node_modules）
//   runtime-package.json         本包清单（版本、构建时间、条目数、来源）
//
// 用法：
//   node scripts/build-runtime-package.mjs --agent <运行端目录> --version 1.0.1 [--out dist] [--dry-run]
//   ★ --agent 指向**运行端根目录**（里面应有 package.json、src/、roles/…），
//     本机的示例：.tmp/phone-agent-runtime-6g9XJC/app
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZipWriter } from './lib/zip-store.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = name => args.includes('--' + name);

const root = path.resolve(import.meta.dirname, '..');
const agentDir = path.resolve(value('agent', ''));
const version = value('version', '');
const outDir = path.resolve(value('out', path.join(root, 'dist')));
const dryRun = flag('dry-run');

if (!version || !/^[0-9A-Za-z._-]+$/.test(version)) {
  console.error('用法: node scripts/build-runtime-package.mjs --agent <运行端目录> --version <版本> [--out dist] [--dry-run]');
  process.exit(2);
}
if (!agentDir || !fs.existsSync(path.join(agentDir, 'package.json'))) {
  console.error('--agent 必须指向运行端根目录（里面要有 package.json）：' + agentDir);
  process.exit(2);
}

// 这些是**运行时数据/缓存**，属于用户，不属于发布物。
const EXCLUDE_DIRS = new Set(['.git', 'node_modules/.cache', 'sessions', 'logs', 'data', 'home']);
const EXCLUDE_SUFFIX = ['.log', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.tmp'];

const files = [];
function walk(dir, rel) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const relPath = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) continue;                       // 不打包链接：解包端未必支持
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(full, relPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_SUFFIX.some(s => entry.name.endsWith(s))) continue;
    files.push({ full, relPath });
  }
}
walk(agentDir, '');

if (!files.length) {
  console.error('运行端目录里没找到可打包的文件：' + agentDir);
  process.exit(2);
}
const agentPkg = JSON.parse(fs.readFileSync(path.join(agentDir, 'package.json'), 'utf8'));

const zip = new ZipWriter();
let bytes = 0;

// ① 运行端（含许可原件；MIT 要求随包保留）
for (const f of files) {
  const data = fs.readFileSync(f.full);
  bytes += data.length;
  zip.add('input/agent-app/' + f.relPath, data, { deflate: !/\.(png|jpg|jpeg|gif|webp|zip|gz|node|so)$/i.test(f.relPath) });
}
const upstreamLicense = path.join(root, 'third-party/qq-agent-plus/LICENSE');
if (!fs.existsSync(upstreamLicense)) {
  console.error('缺上游许可原件：' + upstreamLicense + '（MIT 要求随包分发，不能跳过）');
  process.exit(1);
}
// 运行端目录里可能已经有 LICENSE / 致谢（例如本机已跑过 stamp-runtime-licenses）：
// 有就以它为准，但**必须**含版权行，否则照样拒绝打包。
const packed = new Set(files.map(f => f.relPath));
const upstreamText = fs.readFileSync(upstreamLicense, 'utf8');
const COPYRIGHT = 'Copyright (c) 2026 Kondius';
if (packed.has('LICENSE')) {
  const mine = fs.readFileSync(path.join(agentDir, 'LICENSE'), 'utf8');
  if (!mine.includes(COPYRIGHT)) {
    console.error('运行端自带的 LICENSE 里没有「' + COPYRIGHT + '」，拒绝打包');
    process.exit(1);
  }
  console.log('运行端自带 LICENSE（已含版权行），不再注入');
} else {
  zip.add('input/agent-app/LICENSE', upstreamText);
}
if (packed.has('THIRD_PARTY_NOTICES.md')) console.log('运行端自带致谢文件，不再注入');
else zip.add('input/agent-app/THIRD_PARTY_NOTICES.md', fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md')));

// ② 协议端源码（不含 node_modules：容器里自己 npm ci）
function addTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(from, entry.name);
    const rel = to + '/' + entry.name;
    if (entry.isDirectory()) { addTree(full, rel); continue; }
    if (!entry.isFile()) continue;
    const data = fs.readFileSync(full);
    bytes += data.length;
    zip.add(rel, data);
  }
}
addTree(path.join(root, 'src'), 'qq-onebot/src');
zip.add('qq-onebot/package.json', fs.readFileSync(path.join(root, 'package.json')));
zip.add('qq-onebot/LICENSE', fs.readFileSync(path.join(root, 'LICENSE')));

// ③ 清单
const manifest = {
  schemaVersion: 1,
  kind: 'whale-onebot-runtime',
  version,
  builtAt: new Date().toISOString(),
  agent: { name: agentPkg.name ?? null, version: agentPkg.version ?? null, files: files.length },
  protocol: { path: 'qq-onebot/src' },
  entries: zip.size,
  note: '解包到 rootfs 根目录；不含 Debian 骨架与用户数据。',
};
zip.add('runtime-package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

const archive = zip.finish();
const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
const fileName = 'runtime-' + version + '.zip';
console.log('包内条目 ' + zip.size + ' 个，原始文件合计 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB');
console.log('归档大小 ' + (archive.length / 1024 / 1024).toFixed(1) + ' MB');
console.log('sha256 ' + sha256);
if (dryRun) {
  console.log('干跑结束：加 --out 并去掉 --dry-run 才会写盘。');
  process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, fileName);
fs.writeFileSync(target, archive);
console.log('已写出 ' + target);
console.log('\n接着把它登记进索引：');
console.log('  node scripts/build-runtime-index.mjs --file "' + target + '" --version ' + version +
  ' --url https://github.com/18477514055/whale-onebot/releases/download/v' + version + '/' + fileName + ' --min-app 101');
