# D282：在本地组装 Android 内置核心的候选发行物

**这是准备资产，不是发布。** 初次候选版本为 `1.1.0-rc.1`；HTTPS 地址是将来由项目所有者发布时使用的不可变 GitHub Release 地址，不证明网上已有文件。不要把工作区、手机、旧 `rootfs.tar.gz` 或本地安装树直接打包。裸 `bot-modules.py build` 面向私有开发验证，不具备公开源码审查门槛，不能直接拿它的结果发布。

## 安装方读取的文件

| 文件 | 用途 | 谁需要下载 |
|---|---|---|
| `core-release-pin.json` | APK 自带固定 `url` 和 `sha256`，校验 release-index 的原始字节；不是从下载源自取的信任根 | 随 APK |
| `release-index.json` | `schemaVersion:1`、`abi:1`、`current`、`releases[]`；每行含版本、catalogUrl/catalogSha256、公共环境 URL/版本/格式/大小/摘要 | 显示与解析版本时 |
| `catalog.json` | 三个独立 ZIP 的版本、ABI/兼容性、文件名、字节、压缩包和 manifest 哈希；ZIP URL 为清单同目录 | 所选发行版本 |
| `whale-environment-arm64-<version>.tar.gz` | `ustar-gzip`，根相对、只有目录和普通文件（可执行位保留），供多实例共用 | 未缓存相同摘要时下载一次 |
| `bot-core-…zip`、`bot-qq-…zip`、`bot-bilibili-…zip` | 同一主体、两个平级的平台插件。根据实例选择；不含协议端/Node/用户数据 | 只下载未缓存的所需包 |
| `debian-arm64-corresponding-source.tar` | 可供接收者取得的 Debian 对应源码、签名元数据与重建说明；不是运行组件 | 与二进制同等可取得，**手机不下载** |
| `SHA256SUMS` | 本地交接/所有者复核；它不是签名 | 人工审查 |

基础地址为 `https://github.com/18477514055/whale-onebot/releases/download/v<VERSION>/`。可选 `--previous <上版 index> --previous-pin <独立已知 SHA256>` 将已核对的不可变历史行附在当前行之后；不允许重复版本、悄悄改旧行、非本项目 URL 或用旧 `v1.0.1` 未审根文件系统冒充历史兼容环境。首版只有一个真实行，不假造旧版。

**签名边界：** 此处产出的是固定摘要，不是数字签名。APK 的发行者签名保护内置 pin。另有可选移动频道协议（安装端如启用）：用独立发行用 RSA 公钥固定在可信 APK，所有者离线签 `channel.json` 的精确 payload，校验序号、时效和固定域名后得到新的不可变 pin。此候选不生成频道密钥、不重用 APK 签名密钥、不签频道、不上传。

## 受控输入与再分发

- 公共环境从 **Debian 12 arm64 受审子集、Node 官方发布 tar.xz、按 SHA-512 固定的 npm tarball、受审独立 B 站协议源码**组装；不导入旧镜像、安装过的 npm 目录、QQ 二进制、设备 ID、cookies、配置或历史账号。Node 24.20.0 arm64 tar.xz 的固定 SHA-256 为 `5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7`。各来源/版本/哈希随公共环境放在 `/usr/share/doc/whale-environment/sources.json`。Debian 子集的 signed release、二进制/源码索引、每个源码成员与包内版权声明分别验证与保留。
- npm 只取明确的 16 个目标包记录，含共享引擎的五个直接依赖及传递依赖、独立 B 站协议的固定 `ws`。`fetch-npm` 是显式准备缓存的步骤，仅访问固定 npm 官方 tarball URL 并核对 SHA512；离线 `build` 不调用 npm、不执行任何包脚本。除 MIT/ISC/BSD 等许可证外，SILK WASM 分别带包装层 MIT、codec BSD 与 Skype SDK 源码头声明；不把版权许可解释为专利授权。boolbase 原始 ISC 说明取自 Git blob `a689aae96e8957e4ab7a3a7449fe5271a6516e4b`；jce tarball 的 package.json 标注 MIT 但缺独立 LICENSE，所以保留作者元数据并附分发方说明。公开发布前仍需所有者作最终许可证审查。
- 公共环境含 `/bin/bash`、`/usr/bin/env`、`/usr/bin/node`、glibc 动态加载器及依赖、CA、`/opt/whale/node_modules/`、`/opt/whale/bili-protocol/`。它不等于 QQ 原生协议端、浏览器分发或用户数据；QQ 可接独立运行的兼容 OneBot 服务；需要 Playwright 浏览器的 B 站功能不因此就绪。APK 的宿主控制脚本另行随宿主交付。
- 公开主体和插件只可从专设已审源树生成；`--app-manifest`、`--bili-manifest` 分别包含逐文件 SHA256，外部审查给出的固定摘要通过 `--app-pin`、`--bili-pin` 指定。打包器只读被批准的清单，拒绝库中私有运行端树作为公开主体来源。**不能把自己刚在私有工作区扫出来的清单当批准。** 分包清单证明完整性，不证明源内容已脱敏或得到发布授权。

## 构建和验收

`python -B scripts/build-bot-release.py build --help` 列出全部必需输入。示意（路径与 pin 由独立审查给出；输出目录须不存在）：

```powershell
python -B scripts/build-bot-release.py build --version 1.1.0-rc.1 --out $out `
  --app $publicApp --app-manifest $publicManifest --app-pin $publicPin `
  --bili-root $publicProtocol --bili-manifest $protocolManifest --bili-pin $protocolPin `
  --node $officialNodeTar --npm-cache $verifiedNpmCache `
  --debian-root $debianTree --debian-manifest $debianManifest --debian-pin $debianPin `
  --source-tar $correspondingSources --source-pin $sourcePin
python -B test/test_bot_release.py --assets $out --pin $indexPin
python -B scripts/verify-bot-release-arm64.py --assets $out --pin $indexPin
```

最后一项在 Linux root 或 Windows + 本地 WSL Debian（qemu-aarch64-static）中构建一次性 chroot，实跑 ARM64 Bash、env、Node、内存 SQLite、五个 npm 导入、两个平台模块、B 站协议入口；运行时不访问手机或公网。它不证明真机安装、扫码、第三方网络、公开 URL 可下载或完整机器人会话。单独的真机下载验收与公开发行均须另行授权。

## 发行物终审（`scripts/audit-release-assets.mjs`）

以前每次「这批资产对不对」都是临场敲命令，还因为 Windows 的 `\r` 误判过一次（见台账第 153 轮的订正）。
现在固化成一个脚本，一条命令复核全部可查项：

```bash
node scripts/audit-release-assets.mjs .tmp/release-1.1.5-assets
```

它查 13 项（每项 PASS/FAIL，退出码即结论）：

| # | 检查 | 判据 |
|---|---|---|
| 1 | SHA256SUMS 覆盖且匹配 | 目录里除 SUMS 外的**每一个**资产都在清单里，且 sha256 逐字节相等 |
| 2 | APK 内置 pin = 本索引 | 从 APK 的 `assets/core-release-pin.json` 读出 sha256，与 `release-index.json` 的 sha256 比较 |
| 3 | pin 指向的 tag 与资产版本一致 | pin.url 里的 tag 必须和资产文件名里的版本对得上 |
| 4-6 | APK 元数据 | versionCode / versionName / **无 debuggable**（P1）/ 签名证书 SHA-256 |
| 7-9 | 核心 zip 内容 | 按**符号出现次数**核 `framesFromLocalVideo` / `get_message_videos` / `retryMediaViaProtocol`（收到视频）与 `readCooldownUntil` / `dm_replied`（B 站私信），不是看文件名 |
| 10-13 | 环境包 | sha/bytes 与索引一致；**不含 QQ 协议端**（对外口径）；`bin/bash` 与 node 都在 |

环境包列条目用 Windows 自带的 `tar -tzf`（bsdtar），不经 python，避免再被 `\r` 带偏。

**1.1.5-beta.1 实测结果（2026-11-23）**：13 项全过 —— SUMS 覆盖 13 个资产、pin `76723270e067`、
APK `11501 / 1.1.5-beta.1` / 无 debuggable / 证书 `4e2e2ef330e52243`、核心包 345 条目带两处修复、
环境包 `b01a65727d55` 51 242 516 B 且 892 条目里 `qq-onebot`/native-bridge 各 0 条（bili-protocol 53 条）。
