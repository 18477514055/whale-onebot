# Whale OneBot v1.2.12 更新说明

> **版本**：`1.2.12`（`versionCode 12013`）｜**内置核心本版无改动**，仍为 `bot-core-1.2.10.zip`
> **这一版修两件事**：① 索引里 `current` 的语义被写歪，让「一键部署」拿不到默认核心；② App 只认 `schemaVersion 1`，读我们自己的 v2 索引就报 `Unsupported release index`。

---

## 一、症状：版本管理 / 一键部署向导必报 `Unsupported release index`

进「版本管理 → 内置部件」或「一键部署向导」，只要去读索引就失败，界面上什么核心都选不到。

## 二、两个根因（都在壳这一层，跟核心无关）

### 1. `CoreInstaller` 只认 v1 索引，而我们发的一直是 v2

`release-index.json` 从 v1.2.0 起就是 `schemaVersion: 2`（按 P14 改成按部件索引，多了 `components{}`）。但 `CoreInstaller.open()` 里写着：

```java
require(num(index, "schemaVersion") == 1 && num(index, "abi") == 1, "Unsupported release index");
```

⇒ 我们自己的 App 读我们自己的索引，**永远**在这里抛错。

### 2. `current` 的语义被写歪了：它应该是「最新核心版本」，不是 App 版本

`current` 在代码里就是**默认版本** —— `DeployWizardScreen` 拿它去 `install(..., ci.current(), ...)`，`VersionScreen` 拿它显示当前项。它必须能在核心版本表里找到对应条目。

而 1.2.10 / 1.2.11 两轮里，我把它按「App 版本」在推（`current: 1.2.11`）。1.2.10 那次恰好没事，因为那版核心也叫 1.2.10；**1.2.11 只发 App 不发核心**，于是 `current=1.2.11` 在核心表里查不到 ⇒ 就算支持了 v2，也会抛 `Unknown default release`。

## 三、修法

| 文件 | 改了什么 |
|---|---|
| `install/CoreInstaller.java` | 兼容 `schemaVersion 1` 与 `2`（v1 才要求顶层 `abi`）；v2 时解析 `components.environment / core / plugins`，为每个核心版本构造**内联目录**（`inlineCatalogs`）并同步进 `releases`；`catalog()` 优先用内联目录，缺失才回落 `catalogUrl + file`；下载单个资产时**优先用部件自带的 `url`**（仍是完整 SHA-256 校验 + 镜像回退） |
| `install/ComponentIndex.java` | 新增纯静态 `defaultRelease(declared, available, coreOrder)`：声明值可用就用它，**否则回退到 `components.core[]` 的第一条**（最新核心），再退到可用版本第一条；v1 语义不变（声明值缺失即坏索引）。刻意**不 import Android**，所以能进纯逻辑测试 |
| `ui/DeployWizardScreen.java` | 下载等待结束后核验 `CoreManagerScreen.currentDownload().label`，避免子线程报错时向导误报「核心已准备就绪」 |
| `test/java/ComponentIndexTest.java` | 21 → **25 checks**：声明命中 / App 版本回退最新核心 / 未知核心序回退首条 / v1 空序拒绝未知 `current` |
| `release-index.json` | 本版 `current` 钉成 **`1.2.10`**（= `components.core[0].version`），不再写 App 版本 |

**为什么不再把 `current` 写成 App 版本**：App 版本本来就不由这份索引表达（它走 GitHub Releases API 与静态 `runtime-index/app-releases.json`）。索引里 `current` 只服务「默认装配哪个核心/环境」。1.2.11 已经按旧写法发出去（`current: 1.2.11`），它那份索引留着不动（P7：资产只增不换）；本版起按正确语义写，并有兜底解析兜住历史错值。

## 四、验证

**本地**
- `node scripts/run-java-logic-tests.mjs` → **exit=0**，13 套全绿，`ComponentIndexTest: 25 checks PASS`；
- `javac --release 8`（`android/app/src` 155 文件）**exit=0**；
- 三包 badging 正确：release `com.whaleonebot` 12013 无 `debuggable`、beta `com.whaleonebot.beta` 12013、debug `com.whaleonebot` 12013 有 `debuggable`；
- APK 内 `assets/qq-protocol/` 51 文件、`assets/bridge/` 5 文件、pin 指向本版索引。

**校验链 16/16**：pin 无 BOM → url 指本版 → `pin.sha256 == 索引字节` → `current == components.core[0]` → `releases[]` 与 1.2.11 深相等 → `components{}` 与 1.2.11 深相等 → `current` 可解析 → core 字节/sha 一致 → `manifest.sha256` 一致 → manifest 内 **350 个文件哈希全对** → SHA256SUMS 全对 → 滚动指针 `sequence = 5`。

## 五、产物与校验

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `whale-onebot-1.2.12.apk`（`com.whaleonebot`，12013/1.2.12） | 109 885 060 | `d3a3a793506885828048dca7570aa8c4a831da853cda77071696eb3e1283ef6d` |
| `release-index.json` | 13 981 | `5f3a298646aaf17b4c2894e89395740d2db6d88d253986436544e03cf598336e` |
| `SHA256SUMS` | — | 上面两项的校验和 |

本机三包（未上传）：debug `f98433a8…` 109 926 213 · beta `934fdf22…` 109 885 060。

> 索引字节哈希与 v1.2.10 那份**完全一致** —— 因为内容本来就该是那样（同一份 `components{}`、同一份 `releases[]`、同一个 `current 1.2.10`）。1.2.11 那份 `current: 1.2.11` 才是异常值。

## 六、本版发布口径的变化（P11 改写）

用户 2026-11-27 定：「以后没有预发布之说」。⇒ 从本版起**不再发 prerelease**，`v1.2.12` 是正式 Release；**但「没验什么」照实写**（见下一节），不靠预发布标签免责。

## 七、没验证什么（如实）

- **1.2.12 这个整包没有装机**：设备用的是热修后的容器脚本 + 已覆盖的核心 1.2.10，用户明确说不用再往手机更新；
- 「一键部署向导端到端下载安装」**没有在真机上点过**（本版修的就是这条链路；VM/回环层面已验证 `schemaVersion 2` 索引能被解析与安装，真机 UI 未验）；
- 干净机端到端（首次装 → 起容器 → 装 QQ → 扫码 → 进群）仍未跑通；
- 语音/视频、抖音平台本版未回归。
