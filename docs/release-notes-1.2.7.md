# Whale OneBot 1.2.7

> 版本：`versionCode 12008` / `versionName 1.2.7`（上一版 `12007 / 1.2.6`）
> 发布类型：stable（`prerelease=false`）
> 本版跨四层：`shell-android`（外壳）+ `core`（内置核心 `bot-core-1.2.7.zip`）+ `plugin`（抖音插件 `bot-douyin-1.2.7.zip`）+ `protocol`（抖音后端 `platform-douyin-1.2.7.zip`）。

---

## 一、本版核心更新

### 1) `[layer: shell-android]` + `[layer: tooling]` 全应用统一免 VPN 国内镜像路由
- **实测 7 节点国内镜像池**：统一收口 `MirrorFetch` / `ReleaseCache` / `ComponentFetcher` / `QqDebFetch` / `RuntimeIndex` / `RuntimeDownloader` / `VersionScreen` 到同一套国内镜像路由（`gh-proxy.com` / `gh-proxy.org` / `ghfast.top` / `hk.gh-proxy.com` / `cdn.gh-proxy.com` / `ghfile.geekertao.top` / `gh.ddlc.top`，移除已失效的 `ghproxy.net`）；`raw.githubusercontent.com` 自动重写至 `cdn.jsdelivr.net` / `fastly.jsdelivr.net` + 镜像池。
- **官方短超时 + 自动记忆最快源**：官方直连仅探测 2.5 秒，超时自动退避 10 分钟并优先走最近最快国内镜像；可在「设置 → 版本与国内镜像」中开启「始终国内镜像优先」、执行**一键全节点并行测速**、添加自定义镜像前缀。
- **静态 `app-releases.json` 绕开 API 限流**：App 版本列表优先通过 jsDelivr + 国内镜像拉取静态 `runtime-index/app-releases.json`，无 VPN 秒开且不受 `api.github.com` 60 次/小时限流影响（保留 `api.github.com` 兜底）；APK 点击更新前先经 `MirrorFetch.resolveDownloadUrl()` 探测可用国内镜像再交给系统 `DownloadManager` 并自动拉起安装器。
- **顺手修复 `ComponentFetcher` 302 重定向 Bug**：独立部件下载现已正确跟随安全 HTTPS 重定向（最多 6 跳，仍严守 P10 `origin` + pin + SHA-256 校验）。

### 2) `[layer: shell-android]` 全流程「一键部署向导」
- 在设置主页顶置 **「一键部署向导」**（支持每次新建机器人或给已有机器人追加平台，兼容本机与远程模式）：
  1. 选择部署方式与目标平台（可多选 `QQ` / `bilibili` / `抖音测试版`）；
  2. 自动体检底层运行环境、Linux QQ 与空闲核心（已就绪项自动绿勾，缺失项页内一键铺开或走国内镜像下载）；
  3. 机器人建档并自动绑定空闲核心；
  4. 快捷配置大模型渠道与 API Key（内置 DeepSeek / 硅基流动 / Kimi / 通义千问 / 智谱 GLM 预设，也可点「已有配置，跳过」）；
  5. 逐平台登录与启动，完成后自动退回设置主页。

### 3) `[layer: core]` + `[layer: shell-android]` 群聊「被 @」与「戳一戳」双独立冷却 + 全量入库留痕
- 拆分为两个完全独立的配置项（仅对**群聊**生效，**私聊不限制**，按群独立计时，默认均为 **60 秒**，`0` = 关闭）：
  - `conversation.mentionCooldownSec`（群聊被 `@` 最小回复间隔）
  - `conversation.pokeCooldownSec`（群聊被戳一戳最小回复间隔）
- 冷却窗口内：只有第 1 次 `@`（或第 1 次戳一戳）触发机器人回复；后续所有 `@` / 戳一戳**照常完整入库**（保留真实发件人、正文与 `@` 标记），机器人下次醒来读历史记录能清楚知道期间谁 `@` 过它，但不额外回复、也不在冷却结束后补回刷屏。
- 已在「机器人配置 → 回复与发送 → 回复行为」暴露全局项，并在「按群设置」中支持逐群覆盖（留空 = 跟随全局）。

### 4) `[layer: shell-android]` 设置主页及核心子页全面重做
- 重构 `SettingsScreen`：远程控制时顶部高亮远端作用域横幅；顶置「一键部署向导」主推卡；三大分组白底卡片（① 机器人与部署 · ② 更新与数据 · ③ 外观与保活），全面替换原重复推子图标为 6 款专属矢量图标。
- 重构 `VersionScreen`（新增「国内镜像源与网络测速」分组卡）与 `BotListScreen`（机器人置顶为主角，核心库存可紧凑折叠）。

### 5) `[layer: protocol]` + `[layer: plugin]` + `[layer: core]` + `[layer: shell-android]` 合入抖音平台并开放 APK「抖音（测试版）」
- 从交付目录显式合入经审计源码至 `src/platforms/douyin/`（转接层、媒体理解、公开作品读取）、`input/agent-app/src/platform-modules/douyin/`（ABI 1 机器人插件）及 `android/app/src/com/whaleonebot/douyin/mobile/`（本机审批台 `Desk` / `OwnerActivity` / `ShareActivity`）。
- 首页「抖音」卡片解除禁用并标明 **`测试版`** 胶囊，开放专属 `DouyinPlatformScreen`：
  - 内置实验性 WebView 网页登录抓 Cookie（仅私有目录 `0600` 存储，绝不打印日志）；
  - 6 项写操作（评论 / 点赞 / 收藏 / 关注 / 发图文 / 改资料）**安全默认全部「需要授权」**，可逐项切为「自主进行」；
  - 定时浏览周期/每日预算配置、本机审批台入口、以及系统分享直达的公开作品链接候选队列。

---

## 二、怎么装

- **普通用户**：下载 `whale-onebot-1.2.7.apk` 直接覆盖安装即可，保留全部机器人配置、QQ 登录态、记忆库与知识库。
- **测试机（Redmi Note 12 Turbo / `marble`）**：仅安装 debug 包 `whale-onebot-debug-1.2.7.apk` 或 `com.whaleonebot.beta` 包，**不要**安装 release 签名的 `com.whaleonebot`（P12）。

---

## 三、验证清单（如实写）

**已验证：**
- Android 全量 **154 个 Java 文件 `javac --release 8` 零错误**，UTF-8 无 BOM 检查 0 命中，原生 `AlertDialog` 0 命中。
- 主机侧纯 Java 逻辑回归全绿（12 个测试套件）：`MirrorAndDouyinTest` 31/31、`RemoteP2pAndQrTest` 64/64、`ComponentIndexTest` 21/21、`BindingRegistryTest` 61/61、`CoreInventoryTest` 44/44、`RootfsLayoutTest` 16/16、`RuntimeIndexTest` 16/16、`SetupStateTest` 14/14、`RuntimeArchivePickTest` 12/12、`ThemeContrastTest` / `QqOfficialReleaseTest` / `QqDebArchiveTest` 全过。
- 群聊双独立冷却单测 `test/group-cooldown.test.mjs` **4/4 全过**。
- 抖音转接层/媒体/公开读取/插件加载测试：`protocol/test.cjs` **9/9**、`media.test.mjs` + `public-reader/index.test.mjs` **22/22**（1 项因本机未设 `TEST_FFMPEG` 跳过）、`platform-modules.js` 加载 `douyin (abi=1)` 通过。
- QQ 协议层核心测试（`notice-events.test.mjs` + `bridge.test.mjs`）**110/110 全过**。
- 2026-11-26 实测国内镜像直连可用性（`gh-proxy.com` / `gh-proxy.org` / `ghfast.top` / `hk.gh-proxy.com` / `cdn.gh-proxy.com` / `ghfile.geekertao.top` / `cdn.jsdelivr.net` / `fastly.jsdelivr.net`）。

**尚未真机实测 / 已知边界（诚实标注）：**
- 抖音测试版目前未接入官方认证的个人号长连接通道：内置 WebView 网页登录仅作实验性本地凭证留存，实网风控下不承诺个人号实时私信/发评；
- 设置新主页、一键部署向导与群聊 `@`/戳一戳双冷却的真实群聊长跑效果，待升级真机后由用户实测验收。
