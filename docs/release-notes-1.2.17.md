# Whale OneBot 1.2.17

> 版本：`versionCode 12018` / `versionName 1.2.17`（紧接 `1.2.16` 源码加固版，固化全部运行脚本进 APK 资产以防容器重启覆盖）  
> 交付阶段：本地核心包 + 三端 APK 构建验签完成、已推送测试机 `marble` 覆盖安装、公开仓库源码与文档同步完成（本批暂未发布 GitHub Release）  
> 改动层级：`[layer: core-bot]` + `[layer: environment]` + `[layer: shell-android]` + `[layer: docs]`

---

## 一、本版核心修复

### 1) 根治 QQ 晚于解耦 Agent 上线时的 `401` 失联
- **现场根因**：`1.2.16` 解耦启动会在 QQ 尚未登录时先以 `qq-detached` 模式提前启动 `agent-app`（无 OneBot token）；当用户随后登录 QQ 并由新 OneBot 生成随机 Bearer token 时，旧 `startAgent()` 因 `agentInFlight === true` 直接跳过，导致 `agent-app` 持续以旧/空 token 连 `13801` 报 `401 Unauthorized`（协议端已收消息但机器人 0 回复）。
- **修复**：[`android/container-bot.mjs`](../android/container-bot.mjs) 跟踪 `agentAttachedToken`，当 QQ 晚于 Agent 登录或换发新 token 时，自动平滑重启 `agentProc` 注入新 `WHALE_ONEBOT_TOKEN` 与端口（不影响 QQ 与 B 站进程）；同时将提前解耦拉起延迟由 1.5s 放宽至 5s，正常快登直接一步到位 `mode=qq-attached`。

### 2) 消除启动瞬间 `[catchup]` 并发补收风暴触发 `-10003`
- **现场根因**：Agent 连上 OneBot 仅 3 秒即零间隔循环拉取全部白名单群与私聊各 100 条历史，瞬间引发数百张图片元数据解析及连续 `retcode=1500 Native query rejected`，将刚建立的 MSF 连接打成 `-10003 / status=2`。
- **修复**：[`input/agent-app/src/console/app.js`](../input/agent-app/src/console/app.js) 将 `scheduleCatchUp()` 调整为**延迟 10 秒缓启动 + 2 分钟节流 + 每会话 1.2 秒串行错峰 + 单会话柔和上限 40 条 + 连续 3 次原生拒绝/超时自动熔断**，保护刚建立的 QQ 长连接。

### 3) 收紧看门狗保护与黑匣子重启前落盘
- [`android/container-watchdog.mjs`](../android/container-watchdog.mjs)：将 `allowQuickLoginRestart` 严格限定为**仅在明确收到 `-10004 / -10003`（`msfTicketInvalid === true`）且具备可用快登票据时**触发 `quick_restart`；遇到普通 `1502` 或网络半开（`msfTicketInvalid === false`）绝不贸然杀进程重启，转为高优告警 + 进程内温和唤醒。
- [`android/container-bot.mjs`](../android/container-bot.mjs)：触发 `quick_restart` 或 `notify_offline` 前强制调用 `dumpBlackbox()` 将旧进程最近 120 条诊断上下文落盘进 `blackbox.log`；删除重复的 `bridge attached` 日志打印。

---

## 二、验证清单（如实写明）

### 已验证
- `node --check` 全部改动 `.js`/`.mjs` 0 错误；Android 全部 **162 个 `.java` 文件 `javac --release 8` 0 错误**（0 BOM / 0 `AlertDialog`）；
- `test/container-watchdog.test.mjs`：**9/9 PASS**（新增第 9 项回归：普通 `1502`/网络半开 `msfTicketInvalid=false` 绝不触发 `quick_restart`）；
- `test/core-deweb-and-market.test.mjs`：**8/8 PASS**；`scripts/run-java-logic-tests.mjs`：**15 套全绿**；
- 三端 APK 与无 Web 核心包全部验签通过（`versionCode=12018 / 1.2.17`）：
  - `bot-core-1.2.17.zip`（296 文件，`1,852,202 B`，sha256 `24c52662…`）
  - `whale-onebot-1.2.17.apk`（release 正式签名 `4e2e2ef3…`，无 debuggable，`109,954,692 B`）
  - `whale-onebot-debug-1.2.17.apk`（debug 签名，debuggable，`109,995,845 B`）
  - `whale-onebot-beta-1.2.17.apk`（`com.whaleonebot.beta`，release 正式签名 `4e2e2ef3…`，`109,954,692 B`）
- 测试机 `marble`（`192.168.1.15:37517`）覆盖安装 `whale-onebot-debug-1.2.17.apk` + `bot-core-1.2.17.zip` 成功：5s 解耦延迟、`waiting-manual-login` 独立拉起 Agent 与 B 站、124,448 段知识库与 660 条印象完好保留；前一轮热推同版脚本已实证 `mode=qq-attached` 与 `onebot.connected === true`（消除 401）。

### 尚未实机闭环（如实标注）
- 因当前测试机停在 `waiting-manual-login` 等待用户手动重新扫码登录 QQ，登录后的「10 秒缓启动 + 1.2 秒错峰 `catchup` 长时零 `-10003`」及「从 `qq-detached` 态扫码后触发 `AGENT_REATTACH_ON_QQ_LOGIN`」待用户本次扫码后实机观察验证。
