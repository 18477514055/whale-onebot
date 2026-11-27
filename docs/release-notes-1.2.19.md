# Whale OneBot 1.2.19（versionCode 12020）发布说明

本版本聚焦彻底根治「QQ MSF 长连接（`onMSFStatusChange 2`）静默断链后无法自愈，且全链路指标仍显示绿灯在线」的两处底层缺陷。

## 核心修复

1. **修复原生唤醒空炮 Bug，接入真实 `wrapper.node` MSF / 网络层 NAPI**
   - 移除 `src/bridge/native-bridge.mjs` 中不存在的 `session.getAppService()` 占位调用，改为直接调用经真机 `wrapper.node` 核对过的真实原生方法：`session.switchToBackGround()`、`session.switchToFront()`、`session.setOnNetworkChanged(status)`、`session.getMSFService().online()` 与 `msg.startMsgSync()`；
   - 修正 `wakeSession()` 仅在原生方法真实存在并成功执行时才计入 `invoked`，并带出 `msfBefore / msfAfter` 诊断值。

2. **MSF 断链事件驱动快速自愈 + 修正 `hot_reconnect` 单例隐患**
   - `android/container-bot.mjs` 收到 `onMSFStatusChange(2)` 后立即落盘 `msfStatus: "2"` 并启动 15 秒防抖：瞬断自愈无感，持续 15 秒未恢复则立刻切 `degraded` 并触发 L1 真实原生传输层重连（零消耗快登票据）；
   - `hotReconnectInProcess()` 依次执行「L1 原生唤醒」与「模拟网络切换 + `msf.online()`」两轮传输层重连；仅在两轮均失败且本地有可用快登票据时，不再原地对已初始化单例 `nt_1` 重复调用 `session.init()`，而是走干净进程级免扫码快登重建；
   - 看门狗新增受限频与退避保护的 `allowMsfDisconnectRecovery`（每小时上限 2 次、退避 2m/10m，无快登票据或命中 `1006501` / `140022015` 绝不重启），并修正告警文案不再误报「自动恢复已达上限」。

3. **四层状态真源对齐，彻底消灭「MSF 已断链但所有面板全绿」**
   - **协议层**（`src/protocol/core.mjs` / `src/host/original-chat-bridge.mjs`）：`get_status` 纳入 `msfDisconnected`，MSF 断开时如实返回 `online: false`、`good: false`、`msf_online: false`、`platform_state: "msf_disconnected"`；
   - **容器层**（`android/container-bot.mjs`）：`heartbeatTimer` 在 MSF 持续断开时禁止把 `phase` 覆写回 `agent-running`；
   - **Android 壳层**（`QqAuthState.java` / `HomeScreen.java` / `LoginHealthScreen.java`）：正式启用 `msfStatus` 判定，`msfStatus="2"` / `"login-disconnected"` 立刻降级为 `LEVEL_DEGRADED` 并点亮告警胶囊；
   - **看板层**（`ControlScreen.java`）：运行状态卡融合 `qqAuthState()`，本机 WS 通着但 QQ 上游断开时明确提示「上游断开（本机 WS 已连）」。
