#!/usr/bin/env node
/**
 * 跑**纯 Java 逻辑**的主机侧断言（不需要 Android 设备、不需要 JUnit）。
 *
 * 覆盖的是那些「在 App 里但完全不依赖 Android」的类，例如索引解析与运行端归档挑选：
 * 它们在 node --test 里跑不到，只靠「编译过」又证明不了行为，所以单独走 javac + java。
 *
 * 用法：node scripts/run-java-logic-tests.mjs [--keep]
 * 约定：test/java/*Test.java 里每个类自带 main，退出码即结果。
 * 退出码：0 全过；1 有失败；2 环境/源文件不对。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI = path.join(ROOT, 'android/app/src/com/whaleonebot/ui');
const REMOTE = path.join(ROOT, 'android/app/src/com/whaleonebot/remote');
const QRGEN = path.join(ROOT, 'android/app/src/com/whaleonebot/ui/thirdparty/qrcodegen');
const INSTALL = path.join(ROOT, 'android/app/src/com/whaleonebot/install');
const NET = path.join(ROOT, 'android/app/src/com/whaleonebot/net');
const DOUYIN_MOBILE = path.join(ROOT, 'android/app/src/com/whaleonebot/douyin/mobile');
const TEST_DIR = path.join(ROOT, 'test/java');
const OUT = path.join(ROOT, '.tmp/java-logic-test');

// 被测的纯逻辑类（都刻意不 import Android）
const LOGIC = ['Theme.java', 'BotConfigJson.java', 'WhitelistModel.java', 'RuntimeIndexLogic.java', 'RuntimeArchivePick.java', 'RootfsLayout.java', 'BotRegistry.java', 'BotStore.java', 'CoreInventory.java', 'CoreRegistration.java', 'BindingPresentation.java', 'BiliPlatformState.java','ModulePlan.java','RuntimeSurfaces.java','RuntimeUiLink.java','InstallerJson.java','QqOfficialRelease.java','QqDebArchive.java','QqClientFiles.java','SetupState.java'];
const REMOTE_LOGIC = ['RemoteCrypto.java', 'StunClient.java', 'MqttSignaling.java', 'NostrSignaling.java', 'RemoteTransport.java', 'NostrRelayChannel.java', 'RemoteStore.java', 'QrDecoder.java'];
const QRGEN_LOGIC = ['BitBuffer.java', 'DataTooLongException.java', 'QrCode.java', 'QrSegment.java'];
// P14：v2 部件索引的读取器也刻意不 import Android，所以进纯逻辑测试
const INSTALL_LOGIC = ['ComponentIndex.java'];
const NET_LOGIC = ['MirrorFetch.java'];
const DOUYIN_LOGIC = ['Desk.java'];

const logicSrcs = LOGIC.map((n) => path.join(UI, n));
for (const f of logicSrcs) {
  if (!fs.existsSync(f)) {
    console.error('✗ 缺逻辑类：' + f);
    process.exit(2);
  }
}
if (!fs.existsSync(TEST_DIR)) {
  console.error('✗ 缺测试目录：' + TEST_DIR);
  process.exit(2);
}
const testSrcs = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('Test.java')).map((f) => path.join(TEST_DIR, f));
const registryTests=['BindingRegistryTest','CoreInventoryTest','ThemeContrastTest','QqOfficialReleaseTest','QqDebArchiveTest'];
for(const name of registryTests)testSrcs.push(path.join(ROOT,'android/tests',name+'.java'));
if (testSrcs.length === 0) {
  console.error('✗ test/java 下没有 *Test.java');
  process.exit(2);
}

fs.rmSync(OUT, { recursive: true, force: true });
const stage = path.join(OUT, 'src');
const classes = path.join(OUT, 'classes');
fs.mkdirSync(path.join(stage, 'com/whaleonebot/ui'), { recursive: true });
fs.mkdirSync(path.join(stage, 'com/whaleonebot/remote'), { recursive: true });
fs.mkdirSync(path.join(stage, 'io/nayuki/qrcodegen'), { recursive: true });
fs.mkdirSync(path.join(stage, 'com/whaleonebot/install'), { recursive: true });
fs.mkdirSync(path.join(stage, 'com/whaleonebot/net'), { recursive: true });
fs.mkdirSync(path.join(stage, 'com/whaleonebot/douyin/mobile'), { recursive: true });
fs.mkdirSync(classes, { recursive: true });

for (const n of LOGIC) {
  fs.copyFileSync(path.join(UI, n), path.join(stage, 'com/whaleonebot/ui', n));
}
for (const n of REMOTE_LOGIC) {
  fs.copyFileSync(path.join(REMOTE, n), path.join(stage, 'com/whaleonebot/remote', n));
}
for (const n of QRGEN_LOGIC) {
  fs.copyFileSync(path.join(QRGEN, n), path.join(stage, 'io/nayuki/qrcodegen', n));
}
for (const n of INSTALL_LOGIC) {
  fs.copyFileSync(path.join(INSTALL, n), path.join(stage, 'com/whaleonebot/install', n));
}
for (const n of NET_LOGIC) {
  fs.copyFileSync(path.join(NET, n), path.join(stage, 'com/whaleonebot/net', n));
}
for (const n of DOUYIN_LOGIC) {
  fs.copyFileSync(path.join(DOUYIN_MOBILE, n), path.join(stage, 'com/whaleonebot/douyin/mobile', n));
}
for (const f of testSrcs) {
  fs.copyFileSync(f, path.join(stage, path.basename(f)));
}

const files = [
  ...LOGIC.map((n) => path.join(stage, 'com/whaleonebot/ui', n)),
  ...REMOTE_LOGIC.map((n) => path.join(stage, 'com/whaleonebot/remote', n)),
  ...QRGEN_LOGIC.map((n) => path.join(stage, 'io/nayuki/qrcodegen', n)),
  ...INSTALL_LOGIC.map((n) => path.join(stage, 'com/whaleonebot/install', n)),
  ...NET_LOGIC.map((n) => path.join(stage, 'com/whaleonebot/net', n)),
  ...DOUYIN_LOGIC.map((n) => path.join(stage, 'com/whaleonebot/douyin/mobile', n)),
  ...testSrcs.map((f) => path.join(stage, path.basename(f))),
];

try {
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes, ...files], { stdio: 'inherit', cwd: ROOT });
} catch {
  console.error('✗ javac 失败');
  process.exit(2);
}

let failed = 0;
for (const f of testSrcs) {
  const cls = path.basename(f, '.java');
  console.log('\n=== ' + cls + ' ===');
  try {
    execFileSync('java', ['-cp', classes, registryTests.includes(cls) ? 'com.whaleonebot.ui.'+cls : cls], { stdio: 'inherit', cwd: ROOT });
  } catch {
    failed++;
  }
}

if (!process.argv.includes('--keep') && failed === 0) {
  fs.rmSync(OUT, { recursive: true, force: true });
}
console.log(failed === 0 ? '\n✓ Java 逻辑断言全过' : `\n✗ ${failed} 个测试类失败（保留 ${path.relative(ROOT, OUT)}）`);
process.exit(failed === 0 ? 0 : 1);
