# Whale OneBot 1.2.21（versionCode 12022）发布说明

本版本集中根治现网验收暴露的链路阻塞/刷屏问题，并闭环修复用户反馈的 `bot-start-failed/manual_logout` 5 秒退出与诊断日志不可滚/不可复制 Issue。

## 核心修复

1. **彻底收敛群聊微附和，消灭水群刷「嗯/哦」并暴露配置项（`[layer: core-bot]` + `[layer: shell-android]`）**
   - `group-dynamics.js` 新增敷衍单字硬拦截（`嗯/哦/噢/行/好/嗯嗯/哦哦` 等一律降级为静默旁听 `SILENT_ABSORB`），并斩断「微附和 → 激活 120s 粘性 → 继续微附和」的正反馈循环；
   - 新增按群冷却与概率闸门，默认频率较初版大幅降低一半以上，并全部暴露到 `BotConfigSchema.java`「群聊社会动力学与拟人时序」区块可随时调节：
     - `groupDynamics.backchannelChance`（默认 **25%**）与 `backchannelCooldownSec`（默认 **180 秒**）；
     - `groupDynamics.reactionOnlyChance`（默认 **35%**）与 `reactionCooldownSec`（默认 **90 秒**）。

2. **根治整条运行链路的 4 项老毛病与防护项（`[layer: core-bot]` + `[layer: protocol]`）**
   - **消除首轮 3.5 分钟卡顿**：`StickerManager` 新增 `snapshotAndRefresh()`，`orchestrator.js` 聊天主链路立取内存表情快照、后台异步刷新（并设 12s 超时），不再因失效 404 收藏表情卡死首轮回复；
   - **消除运行中查 `/api/sessions/:id` 报 500 `could not be cloned`**：`orchestrator.js` 将打分提交回调移入独立 `scoringGateCommits` Map，保持 `session` 纯可克隆 JSON；
   - **在线态 `wakeSession()` 防误触保护**：`native-bridge.mjs` 检测到 MSF 已在线（`msfBefore === 1` 且未断链）时绝不乱发 `setOnNetworkChanged` / `msf.online`，防止人为诱发腾讯 `-10004`；
   - **老库影子升级温和礼让 CPU**：`knowledge-upgrade.js` 默认 `yieldMs` 调温和至 `120ms`，避免阻塞 Agent 控制台端口。

3. **闭环修复用户 Issue：`bot-start-failed/manual_logout` 5 秒退出、状态卡「启动中…」与日志卡无尾部/无复制（`[layer: protocol]` + `[layer: environment]` + `[layer: shell-android]`）**
   - **动态读取运行时绑定账号**：`src/config/account.mjs` 补齐 `currentBotUin()`，`native-bridge.mjs` 不再把 `BOT_UIN` 冻结在模块加载期，根治干净机首次登录或退出换号后 `IDENTITY_REJECTED` 5 秒 `bot-start-failed`；
   - **杜绝陈旧 `manual_logout` 误导诊断**：`container-bot.mjs` 的 `die()` 自动落盘 `blackbox.log` 并以真实错误覆写 `offlineReason` 与 `offlineMessage`；`ContainerService.java` 对连续 3 次致命启动异常停止 8s 死循环重试并打印真实错误；
   - **状态页诚实报错**：`QqAuthState.java` 解析 `error` 并新增 `isFatalError()`，彻底告别致命崩溃还显示「启动中… / 正在初始化 QQ 原生环境…」；
   - **日志卡片可滚、可选、一键复制**：`BoundStartScreen.java` 将最新 `bot.log` 末尾 80 行置底优先展示，修复嵌套 `ScrollView` 触摸拦截、开启 `setTextIsSelectable(true)`，并新增一键「复制日志」按钮（打包 `bot.json` 摘要 + `bot.log` + `blackbox.log` + `container.log`）。
