# Whale OneBot 1.2.14

> 版本：`versionCode 12015` / `versionName 1.2.14`（上一版 `12014 / 1.2.13`）  
> 发布类型：正式版（按 P11 新口径不再区分预发布，下方如实列明已验证与未验证项）  
> 改动层级：`[layer: shell-android]` + `[layer: environment]`（内置核心 `bot-core-1.2.10.zip` 与索引结构未变，复用 `v1.2.13` 同字节 `release-index.json`）

---

## 一、本版核心解决的问题：彻底治理 QQ 频繁下线与上线难题

### 1) 零误杀看门狗 & 单进程彻底合一
- **废弃并发抢库的双进程登录**：`container-login.mjs` 退化为瘦指令转发代理，QQ 登录与运行彻底收归单进程 `container-bot.mjs` 统一状态机管理，消除双进程同时打开 `global/nt_db/login.db` 导致的锁库与互覆二维码。
- **看门狗绝不盲杀重启**：修复 `1.2.10` 看门狗在探活失败 4 次后直接 `process.exit(1)` 把在线会话踢进扫码态的反噬问题（默认 `allowRestart = false`；重启前必查本地快登票据是否可用，不可用时仅做进程内温和唤醒 `wakeSession()` + 进入离线告警态）。
- **彻底告别后台循环刷码**：移除二维码过期后每 2 分钟自动连续请求 50 张码的逻辑，改为**严格按需出码**（掉线或快登失败后停在 `waiting-manual-login` 并推送告警，仅在人工点击时按需出 1 张码）。
- **原生全信号监听**：接入 `onMSFStatusChange` / `onMSFSsoError` / `onRegisterProxyOnlineResp` / `onKickedOffLine` / `onPasswordLoginFailed` / `onLoginSuccess` / `onUserLoggedIn`，准确区分「网络抖动(`1006514`)」「被风控或异地踢下线(`1006501`)」「快登令牌过期(`140022015`)」「需滑块验证(`verify-required`)」。

### 2) 固化全链路设备指纹 + Android 网络恢复温和唤醒 + 高优先级离线通知
- 统一主容器与子命令 `proot` 内核版本为 **`6.1.0-28-arm64`**（消除此前主容器 `6.2.1-perf` 漂移），同步透传每机稳定派生的 `machineId` 与动态读取的客户端 `clientVer`。
- `ContainerService` 注册 `ConnectivityManager.NetworkCallback`，在 Wi-Fi ↔ 流量切换或夜间重拨恢复后自动防抖下发温和 `wake_session` 唤醒（绝不杀进程）。
- 新增高优先级通知通道 `whale-qq-alert`：本机或已配对远端设备一旦掉线/被踢/令牌过期/需滑块验证，立刻在本机与主力机同步弹系统通知，点击直达 QQ 上线页。

### 3) 免截图多通道上线 + 被控机 Keystore 加密记住密码 + 远程滑块闭环
- **一键拉起手机 QQ 授权（免截图）**：通过 68 字节 `qr.url`（`https://txz.qq.com/p?k=...`）直接构造 `mqqapi://` 唤起手机 QQ 确认登录，并经加密 P2P 毫秒级同步到远端主力机，绕开腾讯常拒接的相册截图扫码。
- **原生账密登录 + 滑块 WebView 闭环**：接入 `wrapper.node` 原生 `passwordLogin`（按真机符号表对齐精确字段 `proofWaterRand` / `proofWaterUrl` / `newDeviceLoginSig` / `unusualDeviceCheckSig` / `registerSucceedSig`），支持可选「记住密码」（Android Keystore AES-256-GCM 仅加密存被控机本地 `0600` 文件，绝不自动偷偷重登）；若触发滑块/新设备 `verifyUrl`，自动推送至本机或主力机内置 `FLAG_SECURE` WebView 完成验证并回传票据。
- **彻底重做 QQ 启动上线页（`BoundStartScreen`）与首页红标**：顶部「连接健康与掉线原因卡」+「安全下线 / 切换账号 / 强制重新登录」三分立操作（保留聊天/记忆/知识库，严守禁登主号红线）；中部「多通道上线卡」（在线自动折叠）；底部改读真实 `bot.log`；首页 QQ 卡片实时展示掉线红标。

---

## 二、怎么装

- **普通用户**：直接下载 `whale-onebot-1.2.14.apk` 覆盖安装即可，保留全部聊天记录、记忆库、知识库与配置。
- **测试机（Redmi Note 12 Turbo / `marble`，P12）**：仅使用 `whale-onebot-debug-1.2.14.apk`（`pm install -r`）或 `whale-onebot-beta-1.2.14.apk`，切勿装 release 签名的 `com.whaleonebot`。

---

## 三、验证清单（如实写明）

**已验证（本机全量单测 + 真机 `marble` 连续 80+ 分钟实跑）：**
- Android 全量 **158 个 Java 文件 `javac --release 8` 0 错误**，UTF-8 无 BOM 0 命中，原生 `AlertDialog` 0 命中；
- `test/container-watchdog.test.mjs` **7/7 PASS**；主机侧纯 Java 逻辑回归 **14 套全绿**（含 `QqAuthStateTest` 20/20、`ComponentIndexTest` 26/26、`MirrorAndDouyinTest` 31/31、`RemoteP2pAndQrTest` 64/64）；QQ 协议核心测试 **110/110 PASS**；
- 真机实测 `1.2.14` 覆盖安装 0 崩溃、固化设备指纹（`3.2.35-54395` / `deb-arm64-*` / `6.1.0-28-arm64` / `mid`）生效、首页离线红标生效、零后台循环刷码生效、按需出码 9 秒登录并 `+28s` 控制台就绪、OneBot 116 项协议能力全开、Keystore 密码库 `0600` 落盘、`wake_session` 8ms 无感唤醒、连续稳定运行无假死。

**尚未实机闭环 / 已知边界（如实标注）：**
- 修正精确字段后的原生 `passwordLogin` 与 `QqVerifyWebView` 滑块票据回传尚未在实网下二次触发验证（腾讯对 Linux 桌面端账密登录风控策略较严，如被腾讯拦截，建议优先使用「一键拉起手机 QQ / 远程亮码」）；
- 远程主力机跨网离线弹窗推送与 `mqqapi://` 一键拉起手机 QQ 授权待双机实际体验反馈；
- 干净新机从零到群聊端到端流程仍未实跑。
