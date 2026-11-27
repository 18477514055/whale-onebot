// [layer: tooling] P14 第二步：把「一版全家桶」的 release-index.json 升成 v2（按部件索引），
// 并且**必须双写旧的 releases[]** —— 已装的 1.1.x App 只认那个字段，删了它们就读不到核心索引。
//
// 用法：
//   node scripts/component-index.mjs build --v1 <旧 index> --catalog <本版 catalog.json> --out <新文件>
//   node scripts/component-index.mjs check --file <v2 index> [--v1 <旧 index>]
//
// 设计要点（为什么这么做）：
//   1. `releases[]` **原样保留**（深比较校验），旧 App 走它照旧能装核心；
//   2. 新增 `components{}` 按部件索引：environment / core / plugins{qq,bilibili} /
//      backends{qq,bilibili} / desktopProtocol —— P14 那 7 个部件里能独立发布的那几个；
//   3. 旧版本里没有 catalog 明细的插件/后端信息**不猜**：推不出的就留空数组，
//      等真正按部件发布时再填；
//   4. `check` 保住两条不变式：① `releases[]` 与旧索引深相等；② sha256 形状合法、版本不重复。

import fs from 'node:fs';

const SHA = /^[0-9a-f]{64}$/;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  }
  return v;
}

function deepEqual(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function requireSha(value, where) {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${where}: 不是 64 位小写 hex`);
}

function build({ v1, catalog, extra }) {
  if (v1.schemaVersion !== 1) throw new Error('输入不是 v1 索引（schemaVersion 必须为 1）');
  if (v1.abi !== 1) throw new Error('只支持 abi=1');
  if (!Array.isArray(v1.releases) || !v1.releases.length) throw new Error('v1 索引没有 releases');
  if (!v1.releases.some((r) => r.version === v1.current)) throw new Error('current 不在 releases 里');

  const environment = v1.releases.map((r) => {
    const e = r.environment;
    if (!e) throw new Error(`release ${r.version} 缺 environment`);
    requireSha(e.sha256, `environment ${r.version}.sha256`);
    const url = String(e.url || '');
    const file = e.file || (url.includes('/') ? url.slice(url.lastIndexOf('/') + 1) : '');
    return {
      version: e.version,
      ...(file ? { file } : {}),
      url: e.url,
      sha256: e.sha256,
      bytes: e.bytes,
      format: e.format,
    };
  });

  const artifacts = Array.isArray(catalog && catalog.artifacts) ? catalog.artifacts : null;
  if (!artifacts) throw new Error('catalog 缺 artifacts，无法建立部件索引');

  // 本版 catalog 属于 current 那个 Release ⇒ 用它的 catalogUrl 推出同目录的产物下载地址
  const cur = v1.releases.find((r) => r.version === v1.current);
  const catalogUrl = String(cur.catalogUrl || '');
  const slash = catalogUrl.lastIndexOf('/');
  if (slash < 0) throw new Error('current release 的 catalogUrl 形状不对');
  const baseUrl = catalogUrl.slice(0, slash + 1);
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/$/.test(baseUrl)) {
    throw new Error('catalogUrl 不在 github releases/download 之下：' + baseUrl);
  }

  const ofKind = (kind, id) =>
    artifacts
      .filter((a) => a.kind === kind && (id === undefined || a.id === id))
      .map((a) => {
        requireSha(a.sha256, `${kind}:${a.id}.sha256`);
        requireSha(a.manifestSha256, `${kind}:${a.id}.manifestSha256`);
        return {
          version: a.version,
          file: a.file,
          url: baseUrl + a.file,
          sha256: a.sha256,
          manifestSha256: a.manifestSha256,
          bytes: a.bytes,
          abi: a.abi,
          requiresCoreAbi: a.requiresCoreAbi === null ? null : a.requiresCoreAbi,
        };
      });

  const core = ofKind('core');
  if (!core.length) throw new Error('catalog 里没有 kind=core 的条目');

  return {
    schemaVersion: 2,
    abi: 1,
    current: v1.current,
    // ★ 旧 App 只读这一段，必须与 v1 逐字相同
    releases: v1.releases,
    // ★ 新 App 读这一段：按部件索引，各自独立版本号（P14）
    components: {
      environment,
      core,
      plugins: { qq: ofKind('platform-plugin', 'qq'), bilibili: ofKind('platform-plugin', 'bilibili') },
      // 这两类今天**还没有独立产物**（backend 寄生在 APK 与环境包里、桌面协议端只在旧路径用），
      // 所以留空数组而不是编造条目；真正拆出去发布时再填。
      // 若调用方给了 --extra（stage_components.py 打包出独立产物后会传），就用真实条目覆盖。
      backends: {
        qq: (extra && extra.backends && extra.backends.qq) || [],
        bilibili: (extra && extra.backends && extra.backends.bilibili) || [],
      },
      desktopProtocol: (extra && extra.desktopProtocol) || [],
    },
    note:
      'releases[] 为兼容已装 1.1.x App 保留；components{} 为按部件索引（P14）。' +
      'backends / desktopProtocol 为空表示尚未独立发布。',
  };
}

function check({ v2, v1 }) {
  const problems = [];
  if (v2.schemaVersion !== 2) problems.push('schemaVersion 不是 2');
  if (!Array.isArray(v2.releases) || !v2.releases.length) problems.push('缺 releases[]（旧 App 会读不到）');
  if (v1 && !deepEqual(v2.releases, v1.releases)) problems.push('releases[] 与旧索引不深相等（旧 App 兼容性被破坏）');

  const c = v2.components || {};
  const lists = [
    ['environment', c.environment],
    ['core', c.core],
    ['plugins.qq', c.plugins && c.plugins.qq],
    ['plugins.bilibili', c.plugins && c.plugins.bilibili],
    ['backends.qq', c.backends && c.backends.qq],
    ['backends.bilibili', c.backends && c.backends.bilibili],
    ['desktopProtocol', c.desktopProtocol],
  ];
  for (const [name, list] of lists) {
    if (!Array.isArray(list)) {
      problems.push(`components.${name} 不是数组`);
      continue;
    }
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item.version !== 'string' || !item.version) {
        problems.push(`components.${name} 有缺 version 的条目`);
        continue;
      }
      if (seen.has(item.version)) problems.push(`components.${name} 版本重复：${item.version}`);
      seen.add(item.version);
      if (!SHA.test(String(item.sha256 || ''))) problems.push(`components.${name} 的 ${item.version} sha256 不合法`);
    }
  }

  const releaseVersions = new Set((v2.releases || []).map((r) => r.version));
  for (const e of c.environment || []) {
    if (!releaseVersions.has(e.version)) problems.push(`components.environment 的 ${e.version} 不在 releases[] 里`);
  }

  return problems;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];

if (cmd === 'build') {
  const v1Path = arg('v1');
  const catalogPath = arg('catalog');
  const outPath = arg('out');
  if (!v1Path || !catalogPath || !outPath) {
    console.error('用法：build --v1 <旧 index> --catalog <catalog.json> --out <新文件>');
    process.exit(2);
  }
  const v1 = readJson(v1Path);
  const extraPath = arg('extra');
  const extra = extraPath ? readJson(extraPath) : null;
  const v2 = build({ v1, catalog: readJson(catalogPath), extra });
  const problems = check({ v2, v1 });
  if (problems.length) {
    console.error('自检未通过：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  fs.writeFileSync(outPath, JSON.stringify(v2, null, 2) + '\n');
  const c = v2.components;
  console.log(`已生成 v2 索引：${outPath}`);
  console.log(`  releases[] 保留 ${v2.releases.length} 条（旧 App 兼容）`);
  console.log(`  components.environment ${c.environment.length} 条 · core ${c.core.length} 条`);
  console.log(`  components.plugins qq ${c.plugins.qq.length} · bilibili ${c.plugins.bilibili.length}`);
  console.log(`  components.backends qq ${c.backends.qq.length} · bilibili ${c.backends.bilibili.length}`);
  console.log(`  components.desktopProtocol ${c.desktopProtocol.length}`);
} else if (cmd === 'check') {
  const file = arg('file');
  if (!file) {
    console.error('用法：check --file <v2 index> [--v1 <旧 index>]');
    process.exit(2);
  }
  const v1Path = arg('v1');
  const problems = check({ v2: readJson(file), v1: v1Path ? readJson(v1Path) : null });
  if (problems.length) {
    console.error('未通过：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log(`通过：${file}${v1Path ? '（releases[] 与旧索引深相等）' : ''}`);
} else {
  console.error('用法：component-index.mjs build|check ...');
  process.exit(2);
}
