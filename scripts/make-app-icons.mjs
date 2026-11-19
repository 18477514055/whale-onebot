// 由一张 2048×2048 的母图生成 Android 各密度的启动图标（可重复执行）。
//
// 母图：android/app/icons/app-icon-source.jpg（用户 2026-11-19 提供）
// 产物：android/app/res/mipmap-*/ic_launcher.png
// 用法：node scripts/make-app-icons.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'android/app/icons/app-icon-source.jpg');
const resDir = path.join(root, 'android/app/res');

// Android 各密度下 launcher icon 的常规边长
const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

const checkOnly = process.argv.includes('--check');

if (!fs.existsSync(source)) {
  console.error('缺母图：' + source);
  process.exit(2);
}

let stale = 0;
for (const [density, size] of DENSITIES) {
  const dir = path.join(resDir, 'mipmap-' + density);
  const out = path.join(dir, 'ic_launcher.png');
  if (checkOnly) {
    const exists = fs.existsSync(out);
    if (!exists) { console.error('缺 ' + path.relative(root, out)); stale++; }
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  // 圆角由图像本身带（母图已经是圆角方块），这里只缩放，不裁切、不加白边
  await sharp(source).resize(size, size, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile(out);
  console.log('生成 ' + path.relative(root, out) + '  ' + size + '×' + size);
}
if (checkOnly && stale) process.exit(1);
if (!checkOnly) console.log('完成：' + DENSITIES.length + ' 个密度');
