# Whale OneBot 1.2.5

> 版本：`versionCode 12006` / `versionName 1.2.5`（上一版 `12005 / 1.2.4`）
> 发布类型：stable（`prerelease=false`）
> 本版跨三个部件：`shell-android`（外壳）+ `core`（内置核心）+ `protocol`（协议端胶水）。按 P14 三者各自有版本号，下面分开写。

---

## 一、先说这一版在修什么

1.2.4 之前，你（和别的用户）撞到的是同一类现象：**界面上说"运行端已停止"，其实机器人一直在跑**、**明明有 QQ 登录态，重启容器还是刷出一张码**、**聊天里发图/发视频时灵时不灵、戳一戳完全收不到**。这一版把这四类一次性拆掉了。

### 1) `[layer: shell-android]` 「运行端已停止」是假状态 —— 改成活体探针 + 三态分栏

**真因（代码级，不是猜）**：启动页那句话来自 `ContainerService.bindingStatus()` → 对 legacy 机器人（`coreInstanceId = legacy-<botId>`）走 `BindingControl.status()`，而它的状态是**进程内静态 Map**：App 一重启、或者没走过 `queue()+launch()`，`runs.get(bot)` 就是 null ⇒ 恒返回 `stopped`。**这个字段从头到尾没看过真实进程、端口或 `bot.json`。**

真机实测的反证（12:00，`192.168.1.15`）：

```json
{"action":"get_login_info"} → {"status":"ok","retcode":0,"data":{"user_id":3752609028}}
{"action":"get_status"}     → online:true  good:true  service_ready:true
                              session_authorized:true  write_ready:true
```

同时 `bot.json` 是 `phase:"agent-running"`、`13800/13801/41907` 三个端口全在 LISTEN、`agent.pid` 在 `/proc` 里活着 —— 界面却在说"已停止"。

**改法**：新增 `ContainerService.probeLiveRuntime()`（800ms 缓存、零阻塞），核验三件事——`bot.json` 的阶段、`/proc/<agent.pid>` 是否存活、`/proc/net/tcp{,6}` 里 OneBot 端口是否 LISTEN；启动页**拆成三行独立状态**：`容器` / `QQ 登录` / `运行端`。哪一层停了一目了然，不再用一个"已停止"糊住全部。

### 2) `[layer: shell-android]` 有登录态，重启容器却刷一张码 —— 快登优先，迟到二维码忽略

**真因**：二维码回调在**快速登录成功之前**就把码画进 `qr.png` 了；快登成功后没有撤回这张图，于是"有登录态也刷出一张码"。这次真机上 `login.log` 最后一条停在 **11-16**，说明 11:55 那次重启走的是 `container-bot.mjs` 的登录路径，过程中那张码纯属抢跑产物。

**改法**：`container-bot.mjs` / `container-login.mjs` 启动前与登录成功即清理 `qr.png` / `qr.url`；有 `identity.json` 时若 `getLoginList` 返回空**重试一次**（1.5s）；**已登录后忽略迟到的二维码回调**。

### 3) `[layer: protocol]` 看图/看视频时灵时不灵、戳一戳完全收不到（`src/bridge/native-bridge.mjs`）

真机 `bot.json` 实锤：`inlineAttempts: 32, inlineSucceeded: 1, inlineFailed: 31`、`grayTipsSeen: 9, grayTipKinds: {}`。

- **看图**：`inlinePictureData` 里 `completions.delete(key)` 错写在 `await downloadRichMedia(...)` **之后**，下载快完成时把自己抹掉（31/32 失败）⇒ 改成**先清旧键再调下载**，优先读本地 `sourcePath`/`thumbPath`（0ms 命中），并支持 `msgId:` 兜底匹配。
- **看视频**：`getMessageVideos` 超时只给 10s 且只试 `downloadType=1` ⇒ 优先读本地 `videoElement.filePath`，按 `downloadType=2 → 1` 降级，下载窗口扩到 40s。
- **戳一戳**：`scanGrayTips` 只读 `jsonGrayTipElement`（那 9 条灰条全是空 `{}`）⇒ 完整支持 `xmlElement`（`busiId` `1061`/`1068`/`2401` 或 `拍了拍/戳了戳` 匹配，提取 `uin/jp/uid`）与 `jsonGrayTipElement` 多字段形态，并把命中的种类记进 `grayTipKinds`。

### 4) `[layer: core]` 纯视频必败 / `base64://` 被丢 / 戳一戳当 @（60s 防刷屏）/ 健康检查误报

- `retryMediaViaProtocol`：纯视频调 `get_message_images` 报 1404 时不再提前 `return`（放行到 `get_message_videos`），并正确接纳 `base64://` 内联图片。
- 新增 `ingestPoke` + `isPokeAtBot`：**同一会话 60 秒窗口内**，只有第一个"戳机器人"的事件被标为 `mentionsSelf:true` 去唤醒模型，60 秒内的重复戳记 `pokeThrottled:true`（留档不唤醒）——防刷屏。
- `freshnessTimer`：报「半开连接」之前先主动调一次 `get_status` 核验，在线就刷新 `lastEventAt`，消除夜间/静默期误报。

### 5) `[layer: shell-android]` `WhaleRemoteSig` 把 logcat 冲爆 —— 已限流

上一版诊断时发现：最近 4000 行 logcat 几乎全是 `WhaleRemoteSig`（6 个信令节点每 1–3 秒重连，**≥30 个线程**在刷），`grep WhaleLog` 在最近 20000 行里**一条都搜不到** —— 容器启动日志被自己的信令冲没了，诊断能力等于被毁。现在**只在状态变化或每 60 秒**记一次失败，后台退避从 4s 扩到上限 60s，票据过期后自动关闭配对订阅。

### 6) `[layer: shell-android]` 远程控制不再卡：0ms 本地缓存 + 增量快照 + GZIP + 4 路并发

- `RemoteBridge` / `DashApi` / `MainActivity` / `AppShell`：按远端设备隔离的 **0ms SWR 缓存**（先给旧值、后台单飞去重刷新），消掉 `bindingStatus` / `biliStatus` / `loadConfigJson` / `dash.get` 阻塞主线程；写操作自动让缓存失效，切设备自动清空防串台。
- `RemoteHostDispatcher` / `RemoteControlManager`：`system.snapshot` 改**哈希增量**（`botsHash`/`loginLogHash`/`containerLogHash`/`qrMtime` 一致就跳过重复传大块 JSON）——无变化时包体从 ~40KB 降到 ~350B；按通道自适应同步间隔（直连 2s / 加密中继 7s）。
- `RemoteTransport` / `NostrRelayChannel`：用 `T_RPC_REQ` 保留位协商 **GZIP**（≥512B 自动压 5–8 倍，旧版自动降级不兼容风险为 0）；中继通道升级为 **4 路滑动窗口并发 + 48KB 单片**（严格 FIFO，消除单车道堵车）。

### 7) `[layer: shell-android]` 补上一个一直没有的分发通路：`src/bridge/*.mjs` 随 APK 释放

这是做本版时**顺手挖出来、必须一起修**的：

`container-bot.mjs` 会 `import /qq-onebot/src/bridge/native-bridge.mjs`（上面第 3 条改的就是它），但这棵 `src/` 树**从来不在任何发布产物里**——`core.zip` 只有 `payload/src`（核心层），APK assets 只有扁平的 `container-*.mjs`。真机上那份 `native-bridge.mjs` 是 **11-23 手工塞进 rootfs 的**（290848 B，mtime 11-23 05:34）。

于是后果很直接：**改了 native-bridge 也发不出去，用户装新包还是旧桥。** 这一版起，四个文件（`error.mjs` / `native-bridge.mjs` / `qq-profile.mjs` / `rkey.mjs`）作为 APK asset 无条件释放到 `<rootfs>/qq-onebot/src/bridge/`，跟着版本走。

---

## 二、怎么装

- **已有用户**：直接覆盖安装，**不用重下 QQ、不用重新扫码**（登录态与知识库/记忆库都在 `files/`，覆盖安装不动它）。
- **测试机（Redmi Note 12 Turbo / `marble`）**：只装 `whale-onebot-debug-*.apk`（`com.whaleonebot`，debug 签名）或 `whale-onebot-beta-*.apk`（`com.whaleonebot.beta`）。**release 签名 + `com.whaleonebot` 那一份永远不装这台机器**（会触发卸载重装，`files/bots.json`、rootfs、QQ 登录态、知识库全没）。
- 本版 `versionCode 12006`，可直接覆盖 1.2.4。

---

## 三、验证到哪一步（如实写）

**已验证：**
- Android 全量 **143 个 Java 文件 `javac --release 8` 零错误**。
- `node --check` 通过：`console/app.js`、`core/orchestrator.js`、`tools/tools-core.js`、`src/bridge/native-bridge.mjs`、`container-bot.mjs`、`container-login.mjs`。
- Java 逻辑测试全绿：`RemoteP2pAndQrTest` **64 checks PASS**（含 >8KB GZIP RPC 往返与 4 路并发流水线实测）、`ComponentIndexTest` 21、`BindingRegistryTest` 61、`CoreInventoryTest` 44、`RootfsLayoutTest` 16、`RuntimeIndexTest` 16、`RuntimeArchivePickTest` 12、`SetupState` 14、`ThemeContrast`、`QqOfficialRelease`、`QqDebArchive` 全过。
- `src/bridge/*.mjs` 进包前后 sha256 与仓库逐一对齐（4/4 一致）。

**未验证（请重点回填）：**
1. **"运行端已停止"这一处只在代码层证明改对了**，没有在装了本版的真机上再看一眼三行状态长什么样 —— 装上后请确认它是否与"机器人到底在不在跑"一致。
2. **快登不闪码**：这一版是"先快登、清码、忽略迟到回调"，但真机上还得走一次**停止容器 → 启动容器**，看它是否还会闪出一张码。
3. **看图/看视频/戳一戳**：全部是**代码级修因 + 合成回归**，没有在真实群聊里验过。请发一张图、一个视频、戳一下机器人，然后回填结果。
4. **远程控制方案 A**：SWR 缓存与增量快照只有单测与本地往返证据，**没有跨两台真机/两个网络压过**。
5. 60 秒防刷屏的"戳一戳当 @"是**按你在 11-26 明确的口径**改的（原实现是自动反拍、吞事件），如果觉得吵或觉得该回拍，请直接说，改回去很快。

---

## 四、部件版本（P14）

| 部件 | 版本 | 本版是否变化 |
|---|---|---|
| 外壳 App（本 APK） | **1.2.5** | 变 |
| 内置核心（`input/agent-app`，含唯一那份 OneBot 11 契约层） | **1.2.5** | **变**（`console/app.js` / `core/orchestrator.js` / `tools/tools-core.js`） |
| 协议端胶水（`src/bridge/`） | **1.2.5** | 变（本版起随 APK 分发） |
| 运行环境（`whale-environment-arm64`） | 1.1.8 | 未变 |
| 插件·QQ / 插件·B站 | 1.1.8 | 未变 |
| 后端·QQ / 后端·B站 / 桌面协议端 | 1.2.0-beta.1 | 未变 |

> 按 P8「每版齐五类」：本版发布 APK + 更新后的 `bot-core-1.2.5.zip` + `release-index.json` + `SHA256SUMS`；环境包与插件未变，继续留在 `v1.2.0` 那个 Release 里（`releases[]` 一个字节没动，旧版 App 不受影响）。

---

## 五、回填模板

装上之后，麻烦回这几条（有哪条回哪条就行）：

```
1. 启动页三行状态（容器 / QQ 登录 / 运行端）分别显示什么：
2. 停止容器→启动容器，还会不会闪一张码：
3. 发图 / 发视频 / 戳一戳 各试一次的结果：
4. 远程控制切页面还卡不卡：
5. 有没有出现新的报错（有就把原文贴过来）：
```
