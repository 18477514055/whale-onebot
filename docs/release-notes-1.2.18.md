# Whale OneBot 1.2.18

> 版本：`versionCode 12019` / `versionName 1.2.18`（全平台登录体验、长期在线保活与四级快速重启架构全面升级）  
> 交付阶段：本机全量单测与 169 个 Java 类编译通过、已构建 `debug` 包并通过 MD5 验签覆盖安装至测试机 `marble` 实机验证（未发布 GitHub Release，未推公开仓）  
> 改动层级：`[layer: shell-android]` + `[layer: protocol]` + `[layer: environment]` + `[layer: docs]`

---

## 一、本版核心升级

### 1) 全平台统一底座：健康中心、代理防劫持与系统保活自检仪
- **三平台登录健康中心（[`LoginHealthScreen.java`](../android/app/src/com/whaleonebot/ui/LoginHealthScreen.java) + [`HomeScreen.java`](../android/app/src/com/whaleonebot/ui/HomeScreen.java) + [`SettingsScreen.java`](../android/app/src/com/whaleonebot/ui/SettingsScreen.java)）**：首页顶部新增「三平台登录健康总览条」，设置页增加入口，一屏直观呈现 QQ / B 站 / 抖音 在线状态、探活时间、网络风险与保活评分，支持一键恢复全部有效会话与四级精细重启（L1 进程内热重连 / L2 单平台热重启 / L3 重载 Agent / L4 整容器重启）。
- **精准网络出口与代理劫持识别（[`NetworkRiskLogic.java`](../android/app/src/com/whaleonebot/ui/NetworkRiskLogic.java) + [`NetworkRiskDetector.java`](../android/app/src/com/whaleonebot/ui/NetworkRiskDetector.java)）**：明确区分安全的 Tailscale 内网组网（`100.64.0.0/10` / `fd7a:115c::`）与会诱发 `-10003` 的全局代理 TUN / Fake-IP DNS（`198.18.x.x`）；劫持时红标告警、提供一键复制 `sing-box`/`Clash` 绕行规则，并在 QQ 上线/重连前弹窗提醒。
- **系统保活自检仪（[`KeepAliveInspector.java`](../android/app/src/com/whaleonebot/ui/KeepAliveInspector.java)）**：逐项检测电池白名单、Watchdog 闹钟保活、精确闹钟权限、通知通道、网络健康与厂商自启动引导，提供 0~100 评分与一键直达系统设置页。
- **三平台统一高优先级通知与远程推送（[`ContainerService.java`](../android/app/src/com/whaleonebot/ContainerService.java) + [`RemoteControlManager.java`](../android/app/src/com/whaleonebot/remote/RemoteControlManager.java)）**：QQ / B 站 / 抖音 任一掉线、过期或需验证均发本地高优通知并推送主力机，点通知直达对应登录页。

### 2) QQ：毫秒级回环控制口、进程内热重连、冷启提速与账密多步闭环
- **毫秒级控制口 & 进程内热重连（[`android/container-bot.mjs`](../android/container-bot.mjs) + [`ContainerService.java`](../android/app/src/com/whaleonebot/ContainerService.java)）**：容器内启动仅监听 `127.0.0.1` 的 Bearer 鉴权控制服务（`.ctl.json`），替代 `500ms` 文件轮询延迟；新增 `hot_reconnect` 在不断 Node/proot、零影响 B 站与 Agent 的前提下执行进程内唤醒或有依据快登重连。
- **退避自愈与无依据零重试铁律（[`android/container-watchdog.mjs`](../android/container-watchdog.mjs)）**：MSF `-10004/-10003` 票据失效在确认有可用快登票据时走 `[2m, 5m, 15m]` 退避恢复（每小时上限 3 次）；一旦无可用登录态或登录态被移除/被踢（`140022015` / `1006501`）立即停手告警，绝不疯狂重连或刷码。
- **冷启与重启提速**：`ContainerService` 对 APK 释放的脚本/`qq-protocol` 增加版本印记 `.whale-assets-stamp` 跳过同版重复拷贝；去除 `ACTION_BOT` 固定两次 `1500ms` 盲等改为精确 PID 轮询；缩减 `ensureSingleInstance()` 盲等耗时。
- **账密与多步验证闭环（[`QqVerifyWebView.java`](../android/app/src/com/whaleonebot/ui/QqVerifyWebView.java)）**：补齐 `proofWaterSig/Rand/Sid`、`newDeviceLoginSig`、`unusualDeviceCheckSig` 与 `step` 递进抽取，WebView 扩展拦截防水墙与安全中心多种回调。

### 3) B 站：多通道登录、无感续期与零删库容错
- **无感自动续期与防风控指纹（[`src/platforms/bilibili/passport.mjs`](../src/platforms/bilibili/passport.mjs) + [`client.mjs`](../src/platforms/bilibili/client.mjs) + [`authorized-client.mjs`](../src/platforms/bilibili/authorized-client.mjs) + [`BiliRefreshStore.java`](../android/app/src/com/whaleonebot/BiliRefreshStore.java)）**：保留 `refresh_token` / `ac_time_value` 并补全 `buvid3`/`buvid4`（`/x/frontend/finger/spi`），独立 Keystore 硬件加密存储并定期通过官方 `cookie/info` + `correspond` + `cookie/refresh` 自动续签。
- **遇 `-101` 不删库 + 退避重连 + 独立热重启（[`BiliProtocolControl.java`](../android/app/src/com/whaleonebot/BiliProtocolControl.java)）**：废除遇到 `reauth_required` 自动删除凭证，完整保留绑定槽位与行为配置并弹通知提醒；非 `-101` 断连走 `[5s, 15s, 30s, 60s]` 指数退避重连；补齐独立热重启与 80 条黑匣子日志；同时通过 `ManagedBiliHost` 与 `ContainerService` 同步更新到受管核心与 legacy 环境。
- **多通道上线（[`BiliWebLogin.java`](../android/app/src/com/whaleonebot/ui/BiliWebLogin.java) + [`BiliPlatformScreen.java`](../android/app/src/com/whaleonebot/ui/BiliPlatformScreen.java) + [`BiliEnrollScreen.java`](../android/app/src/com/whaleonebot/ui/BiliEnrollScreen.java)）**：接通官网网页登录（自动提取 `SESSDATA`/`bili_jct`/`ac_time_value`）、支持手动粘贴安全导入 Cookie（联网 `/nav` 验真 UID）、优化本机 App Links 授权失败引导。

### 4) 抖音：桌面扫码防拦截、硬件加密、低频保活与全量远程化
- **防拦截网页自动监听（[`DouyinWebLogin.java`](../android/app/src/com/whaleonebot/ui/DouyinWebLogin.java)）**：默认采用桌面端 Chrome UA 打开登录页支持桌面/手机切换，阻止跳转第三方 App；自动监听 `sessionid`/`sid_tt` 出现后自动提取校验，拒收纯游客 `ttwid`。
- **Keystore 硬件加密与低频只读保活（[`DouyinSessionStore.java`](../android/app/src/com/whaleonebot/DouyinSessionStore.java) + [`DouyinSessionVerifier.java`](../android/app/src/com/whaleonebot/DouyinSessionVerifier.java)）**：升级为 Keystore `AES-256-GCM` 加密存储（平滑迁移并擦除旧明文）；接入真实账号资料只读校验（提取昵称/UID）与 45 分钟低频只读保活、失效告警及独立黑匣子诊断。
- **全量双机远程控制（[`DouyinPlatformScreen.java`](../android/app/src/com/whaleonebot/ui/DouyinPlatformScreen.java) + [`RemoteHostDispatcher.java`](../android/app/src/com/whaleonebot/ui/RemoteHostDispatcher.java)）**：彻底消除远程模式拦截，主力机可直接查看状态、配置策略、甚至在本地弹出内置 WebView 帮被控机完成登录并经端到端加密回传落盘。

---

## 二、验证清单（如实记录）

### 已验证
- **语法与编译**：全部改造 `.js`/`.mjs` `node --check` 0 错；Android 全量 **169 个 `.java` 文件 `javac --release 8` 0 错**（0 UTF-8 BOM / 0 `AlertDialog` 调用）。
- **自动化测试全绿**：
  - Node 全套测试（带 `--import ./test/preload.mjs`）：**128/128 PASS**（含 `container-watchdog` **10/10**、`bili-passport` **7/7**、`bili-resume` **7/7**、`bili-refresh-and-import` **2/2**、`core-deweb-and-market` **8/8**、`notice-events` + `bridge` 全绿）。
  - Java 纯逻辑测试（`scripts/run-java-logic-tests.mjs`）：**16 套全绿**（含新增 `LoginHealthAndRiskTest` **13/13**、`QqAuthStateTest` **20/20**）。
- **测试机 `marble` 装机与实测**：
  - 产出并验签 `dist/local-test-v1.2.18/whale-onebot-debug-1.2.18.apk`（`com.whaleonebot` / `12019` / `110,045,067 B` / MD5 `90251e55f539c0e0706b24cb87547e13` / SHA-256 `c8295574c52a...`），推送 MD5 校验一致，`pm install -r` 成功。
  - 冷启提速与指纹印记实证：容器 1s 就绪、`BOT: purged stale=0` 零冗余等待即启动、`.whale-assets-stamp` 落盘、`.ctl.json` 毫秒控制端口就绪、QQ 极速免扫码快登在线（`phase=agent-running`、`mode=qq-attached`、`CONSOLE_READY +32s`）、Agent `/api/chats` HTTP 200、B 站新版协议核心已同步进 rootfs、`logcat` 零崩溃。

### 尚未实机人工交互闭环（如实写明）
- QQ 账密触发真机滑块/新设备短信多步验证（当前测试机已完成免扫码快登在线，待人工在需要时切账密/验证体验）；
- B 站官网 WebView 登录提取 `ac_time_value`、手动粘贴 Cookie 导入、与抖音桌面扫码 WebView 在手机端人工 UI 点击流程（本版已完成本地全测与远程/加密链路打通，待你在测试机屏幕亲自点开 B 站/抖音页面实网授权体验）；
- 尚未构建 `release`/`beta` 正式发版三包、未发布 GitHub Release、未推送公开仓。
