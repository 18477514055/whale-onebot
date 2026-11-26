#!/usr/bin/env node
/**
 * [layer: tooling] 从 GitHub Releases 生成静态 runtime-index/app-releases.json，
 * 让无 VPN 的 Android 端可通过 jsDelivr / 国内镜像直接拉取 App 发布列表，
 * 完全避开 api.github.com 封锁与 60 次/小时限流。
 *
 * 用法：
 *   node scripts/gen-app-releases.mjs [--out runtime-index/app-releases.json] [--extra-json path.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = '18477514055/whale-onebot';
const args = process.argv.slice(2);
let outPath = path.resolve('runtime-index/app-releases.json');
let extraJsonPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outPath = path.resolve(args[++i]);
  else if (args[i] === '--extra-json' && args[i + 1]) extraJsonPath = path.resolve(args[++i]);
}

function slimRelease(r) {
  const assets = Array.isArray(r.assets)
    ? r.assets
        .filter((a) => a && a.name && a.browser_download_url)
        .map((a) => ({
          name: String(a.name),
          size: Number(a.size || 0),
          browser_download_url: String(a.browser_download_url),
        }))
    : [];
  return {
    tag_name: String(r.tag_name || ''),
    name: String(r.name || r.tag_name || ''),
    prerelease: Boolean(r.prerelease),
    published_at: String(r.published_at || ''),
    html_url: String(r.html_url || `https://github.com/${REPO}/releases/tag/${r.tag_name}`),
    assets,
  };
}

let raw;
try {
  raw = execFileSync(
    'gh',
    ['api', `/repos/${REPO}/releases?per_page=30`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
} catch (err) {
  console.error('[gen-app-releases] 调用 gh api 失败:', err.message);
  process.exit(1);
}

const parsed = JSON.parse(raw);
if (!Array.isArray(parsed)) {
  console.error('[gen-app-releases] 返回不是数组');
  process.exit(1);
}

let list = parsed.filter((r) => !r.draft).map(slimRelease);

if (extraJsonPath && fs.existsSync(extraJsonPath)) {
  const extra = JSON.parse(fs.readFileSync(extraJsonPath, 'utf8'));
  const extras = Array.isArray(extra) ? extra : [extra];
  for (const item of extras) {
    const slim = slimRelease(item);
    if (!slim.tag_name) continue;
    list = list.filter((x) => x.tag_name !== slim.tag_name);
    list.unshift(slim);
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(list, null, 2) + '\n', 'utf8');
console.log(`[gen-app-releases] 已写入 ${list.length} 条版本记录 → ${outPath}`);
