# 部件索引与版本来源（`release-index.json`）

> 本文原名「内置运行端索引」，讲的是 1.2.0 之前那种「一个大 runtime 包」的模型。
> **那套已经废弃**：现在是**按部件分别发布、各自独立版本号**（见 README 的「这套东西由四层组成」）。
> 下面写的是现在真正在跑的东西。

## 0. 先分清两个东西

| | 是什么 | 谁读它 |
|---|---|---|
| **`core-release-pin.json`**（信任根） | 174 字节，只有 `{url, sha256}` 两个字段，URL 里的 tag 是**字面量**。随 APK 一起分发 | App 启动时读它，用 `sha256` 校验索引的**原始字节** |
| **`release-index.json`**（目录） | 一份 JSON，列出「有哪些部件、各有哪几个版本、每个版本从哪下、多大、什么哈希」 | 校验通过后由 App 解析 |

**pin 是入口，不是版本锁。** 它指向某一次 Release 的 `release-index.json`；我们发新版本时如果索引内容变了，pin 里的 sha256 就要跟着变（同批生成，不手改）。

## 1. 索引长什么样（schemaVersion 2）

```json
{
  "schemaVersion": 2,
  "current": "1.2.7",
  "releases": [ ... ],
  "components": {
    "environment":  [ { "version": "1.1.8", "file": "...", "bytes": 0, "sha256": "...", "url": "..." } ],
    "core":         [ { "version": "1.2.7", ... }, { "version": "1.2.5", ... } ],
    "plugins":      { "qq": [...], "bilibili": [...], "douyin": [...] },
    "backends":     { "qq": [...], "bilibili": [...], "douyin": [...] },
    "desktopProtocol": [ ... ]
  }
}
```

两个字段各有各的读者，**不要合并**：

- **`releases[]`** —— 给**已装的 1.1.x 旧 App** 看的兼容面。老 App 只认这个数组，里面每条是「那个版本的环境包在哪」。
  我们**从不改它**（新增版本时才追加），所以老 App 永远不会因为索引升级而变砖。
- **`components{}`** —— 给 **1.2.0 及以后**的 App 看的。按部件分组，每组是一个**版本数组**，新的排在前面。

App 端读取器是 `android/app/src/com/whaleonebot/install/ComponentIndex.java`（纯逻辑、不 import Android，所以能在 PC 上跑单测）：
有 `components` 就用它；没有就退回 `releases[].environment`；两者都没有就不编造条目。

## 2. 现在的部件清单（P14，按产物算）

| 部件 | 是什么 | 当前版本 | 更新频率 |
|---|---|---|---|
| **environment** | arm64 Debian 根文件系统（APK 也自带一份，首次启动铺开） | 1.1.8 | 很低 |
| **core** | 内置核心：人格、记忆、知识库、亲密度、对话编排、控制台，**以及唯一那份 OneBot 11 契约层** | 1.2.7 | 随内核功能走，可单独升级 |
| **plugin: qq / bilibili / douyin** | 把核心接到对应平台后端上的适配层 | qq 1.1.8 · bilibili 1.1.8 · douyin 1.2.7 | 与后端配套 |
| **backend: qq / bilibili / douyin** | 平台对接本体。QQ 是胶水 + QQ 自带 native；B站/抖音是我们自己的进程 | qq 1.2.0-beta.1 · bilibili 1.2.0-beta.1 · douyin 1.2.7 | 各平台独立 |
| **desktopProtocol** | 桌面端可单独部署的协议端 | 1.2.0-beta.1 | 独立 |

**契约只有一份，不按平台拆。** 不管你接 QQ 还是 B站，OneBot 11 那套接口都是核心里的同一份实现。

## 3. 校验链（P10：信任根与该 Release 同批生成，禁止手改）

```
APK 内置 pin（{url, sha256}）
   └─▶ 用它校验 release-index.json 的**原始字节** sha256
         └─▶ 解析索引，拿到某部件的 file / bytes / sha256 / url
               └─▶ 下载（校验不过就换镜像，镜像只负责传输）
                     └─▶ 解包后逐文件比对包内 manifest.json 的 sha256
```

下载器是 `install/ComponentFetcher.java`：**只信索引里的哈希**，镜像只是传输层；所有候选都校验不过就明确失败，不会「装上一个坏的」。

落盘位置：`<App 私有目录>/components/<group>[-<id>]/<version>/<file>`，幂等（已存在且哈希对就复用）。

## 4. 为什么不发一个大包了

以前的 `runtime-<版本>.zip` 把核心和协议端打进一个包，结果是「改了核心里一行日志，用户要重下几十 MB」。
现在拆开之后：

- 改了核心 → 只发 `bot-core-<ver>.zip`（约 2.4 MB）
- 改了 B站行为 → 只发 `plugin:bilibili` / `backend:bilibili`
- 环境没变 → 一个字节都不用重发

**部件更新不依赖 App 更新。** 反过来，装新 APK 也不等于换了核心 —— 版本管理页把 App、核心、插件、环境分开列，各自带下载按钮。

## 5. 无梯子怎么下载（1.2.7 起）

`MirrorFetch.java` + `MirrorPrefs.java`：官方地址给 2.5 秒短超时，超了就按候选池切国内镜像（GitHub 代理 / jsDelivr 等 7 个节点，实测剔除了不可用的），**记住最快的那条**，也允许用户自己追加镜像并一键测速。

- 镜像**只负责传输**：任何一份下载回来都按索引里的 `sha256` 校验，不过就换下一个。
- APK 自身走的是静态 `runtime-index/app-releases.json`（20 条版本记录），绕开 `api.github.com` 的封锁与限流；
  下载链接仍由 `resolveDownloadUrl` 拼成 `releases/download/<tag>/<asset>` 形态（P9）。
- 同一个来源连续失败会退避 10 分钟，不会每一屏都去撞。

## 6. 已知缺口（别当成已完成）

- **索引本身没有独立签名**，只有「pin 里写死的 sha256」。防线是 https + 发布者账号安全；要做更强的保证，下一步是给索引加 detached 签名（`SignedChannel` 那条 `core-channel-v1/channel.json` 已经是现成通路）。
- **environment 还没有 semver 版本号**：今天它靠 rootfs 里的 `.whale-public-environment`（64 字节 sha256 回执）判断就绪，索引里的 `version` 只是标签。P14 要求补上真正的语义化版本。
- **抖音的后端/插件都是 1.2.7 首次发布**，还没有跨版本升级的实测样本。
- 解包阶段只有日志（`tar rc=` / `unzip rc=`），界面上仍显示「下载进度」；「解包中」尚未接进 UI。
