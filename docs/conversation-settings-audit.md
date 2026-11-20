# 现在有哪些东西在影响"对话"（2026-11-19 21:3x 全量盘点）

> 用户担心：「我们是不是又改了一大堆奇奇怪怪的设置，会不会导致奇奇怪怪的 bug」。
> 这份文档把**所有会影响「机器人说什么、什么时候说、说不说得出去」的东西**摊开：
> 作者的运行端配置（live 值）、我们改过的代码与补丁、以及我认为该盯的地方。
> ★ 所有值都是**从设备上现读的**，不是凭记忆写的。复核命令见最后一节。

## 1. 链路

```
QQ ← 原生层 ← 我们的协议端(/qq-onebot: OneBot 11 server + 桥)
                    ↑ OneBot(ws/http)
              运行端(作者的 qq-agent-plus, /input/agent-app)  ← 它决定「说不说、说什么」
```
**一句话**：说不说、说什么由运行端决定；**能不能发出去**由我们的协议端决定（PRINCIPLES P4）。

## 2. 运行端（作者）里影响对话的 live 值

### 放行与触发
| 项 | 当前值 | 说明 |
|---|---|---|
| `allow.groups` | 11 个群 | 只在白名单里说话 |
| `allow.private` | 6 个号 | |
| `allowAllWhenEmpty` | **true** | ★ 白名单一旦清空 = 谁都能触发 |
| 触发概率 | **代码默认 10%**（不在配置里） | session 里就叫「随机命中（概率 10%）」 |
| `pacing.enabled` | false | 节奏控制关着 |
| `pacing.instantOnMention` | true | 被 @ 立刻唤醒（仍要等下面的 wakeDelay） |
| `wakeDelayMs` / `min` / `max` | 10000 / 8000 / 12000 | ★ 被唤醒后**故意等 8–12 秒**再开始（作者的人味设计） |
| `directWakeDelayMs` | 300 | 私聊只等 0.3 秒 |
| `maxBatchWaitMs` / `drainDelayMs` | 20000 / 10000 | 攒批与排空 |

### 一次 run 的预算
| 项 | 当前值 | 说明 |
|---|---|---|
| `api.runTimeoutMs` | **180000（3 分钟）** | ★ 超了就是 `Run deadline exceeded`，整批消息被 ack 但没人回（今天 13 条） |
| `api.timeoutMs` | 60000 | 单次模型请求 |
| `maxConcurrentRuns` | **2** | 全机同时只跑 2 个 run，其余排队 |
| `send.maxPerMinute` | **6**（作者默认 80，我们改的） | 每会话每分钟最多 6 条 |
| `send.hardSplitAt` | 4000 | 单条消息硬切长度 |
| `humanize.replyDelay` | 500–1800ms，按字 12ms，上限 8000 | ★ 再故意拖 0.5–8 秒（"像人在打字"） |

### 会话（记忆上下文）生命周期
| 项 | 当前值 | 说明 |
|---|---|---|
| `conversation.mode` | `lifecycle` | |
| `conversation.silentIdleMs` | 5 分钟 | 安静这么久就断开线索 |
| `conversation.activeIdleMs` | 20 分钟 | |
| `conversation.hardLifetimeMs` | 30 分钟 | 强制换新线程 |
| `conversation.continuationWindowMs` | 150 秒 | 据说"接着上说"的窗口 |
| `conversation.replyGuardEnabled` | true | 防重复回复 |
| `conversation.pokeReplyEnabled` | true | 被拍会反拍 |

### 主动行为（会「自己开口」）
| 项 | 当前值 |
|---|---|
| `proactive.enabled` / `probability` | true / 0.2 |
| `proactive.followUpEnabled` / `selfWakeEnabled` | true / true |
| `proactive.checkIntervalMin/Max` | 30 / 90 分钟 |
| `lifeFeed.enabled` / `forageIntervalMinutes` | true / 360 |
| `groupGame.enabled` / `dailyLimitPerChat` | true / 6 |
| `reminders.enabled` | true |
| `humanize.actions.maxPerRun` | 10（戳/表情/贴纸/语音，各有冷却 30–600s） |

### OneBot 连接（它与我们协议端之间的约定）
| 项 | 当前值 | 谁的 |
|---|---|---|
| `onebot.wsUrl` / `httpUrl` | 127.0.0.1:13801 / 13800 | 端口由我们每次随机选 |
| `onebot.wsHeartbeat` | auto | |
| `onebot.catchupReplyWindowMs` | **1800000（30 分钟）** | ★ 重启后会把 30 分钟内**被 @/引用过**的旧消息补处理 —— 可能"突然回复很久以前的话"，这是正常设计 |
| `onebot.catchupHistoryCount` | 100 | |
| `onebot.textTimeoutMs` | 未写进 config；**容器启动时按 120000 注入** | ★ 我们改的（作者写死 15 秒） |

## 3. 我们改过的（都在仓库里，可审）

| 位置 | 改了什么 | 为什么 |
|---|---|---|
| `android/container-bot.mjs` | 每次启动强制 `catchupReplyWindowMs=1800000`；传 `WHALE_ONEBOT_TEXT_TIMEOUT_MS`；清 `.server.lock`、杀残留 agent、每 60s 杀更早实例、agent 重试上限 6 | 作者默认被我们曾误设 0 → 启动期消息永久丢 |
| 内嵌 preload | ①强制注入 OneBot 地址/token ②把 `TEXT_TIMEOUT_MS` 从 15000 改成 120000（面板可调） | 地址不靠 config（会被业务重写）；15 秒太短会误判未知 → held |
| `src/protocol/core.mjs` (P4) | 发送类动作拿不到回执时回「成功 + `message_id:null`」；只有真没提交才回 1503；严格模式只对非发送类关闸 | 防 held 锁死整条会话 |
| `src/bridge/native-bridge.mjs` | 回执窗口 5000ms；`message_id` 用开机秒数做种子；@ 认 nt-uid；元素诊断默认关（`WHALE_DEBUG_ELEMENTS=1` 才开） | 回执窗口 <核心 10s；避免重启后 id 复用被静默去重；@ 通路 |
| `src/service.mjs` | 传 `minimumWriteIntervalMs: 0`（关掉我们这边的写间隔）；新增发送归档 | 限流交给运行端；归档见 `docs/outbound-archive.md` |
| `src/archive/outbound-archive.mjs` | 每次成功发送落一行 | 用户要求「所有发送都落库」 |
| `scripts/patch-agent-knowledge-vec.mjs` | 去掉 `if (vec)` 门 —— **已确认打在设备上** | 让知识库真的用 `vec0.so` 做语义检索 |
| `scripts/patch-agent-memory-timeouts.mjs` | embed 5000→12000、rerank 5000→20000 —— **已确认打在设备上** | 手机网络抖动时记忆召回不再静默返回空 |

## 4. 我认为该盯的地方（按「会不会被当成 bug」排序）

| # | 现象 | 根因（正常还是异常） | 建议 |
|---|---|---|---|
| 1 | 「明明在聊，它突然回一句很久以前的话」 | **正常**：`catchupReplyWindowMs` 30 分钟，重启/重连后补处理 | 若要更"当下"，可降到 5–10 分钟 |
| 2 | 「@ 了要等十几秒才回」 | **部分正常**：wakeDelay 8–12s + humanize 0.5–8s + 排队 | 想快就调小 `wakeDelayMin/Max`（面板有） |
| 3 | 「回得很晚，甚至几分钟」 | **异常为主**：`runTimeoutMs` 3 分钟 + `maxConcurrentRuns` 2 + `send.maxPerMinute` 6 三者叠加，前面 run 不结束后面就排 | 先把 `maxPerMinute` 调回 20–80 试；再看并发 |
| 4 | 「整批消息没人回」 | **异常**：`Run deadline exceeded`（一次 run 超 3 分钟，整批作废） | 见待办：查是什么把 run 拖过 3 分钟 |
| 5 | 「发成功了但我看不到」 | **待定**：P4 把"没回执"当成功；也可能 QQ 侧被吞 | 归档上线后可用它对照（有文本无显示 = 真被吞） |
| 6 | `allowAllWhenEmpty=true` | **隐患**：白名单一旦被清空 = 全放行 | 建议改 false；面板加提示 |
| 7 | `onebot.textTimeoutMs=120s` | **我们改的**：好处是不再误判 held；坏处是真卡住时要等 2 分钟，期间该会话 run 被占 | 若延迟变差，可回 60s 试 |

## 5. 归属原则：哪些**不该**待在协议端（2026-11-19 用户定的线，见决策卡 D273）

协议端要允许别人接自己的机器人，甚至有人只下协议端、不装我们的 App。
所以「机器人该怎么表现」的策略不能写死在协议端：

| 能力 | 归属 | 现状 |
|---|---|---|
| 传输/鉴权/动作契约/原生桥接 | 协议端 | ✅ 已在协议端 |
| 「拿不到回执就按已接受回成功」（P4） | **应改成可选模式** | ⚠ 现在是默认行为，会影响所有接入者 |
| 发送失败后的补发、引用哪条、重试几次 | **运行端** | ⚠ 方案待落地（不放协议端） |
| 原话归档 + 模型摘要 | **产品层/运行端** | ⚠ 现在在协议端（`src/archive/`），需迁移或降级为默认关闭的通用动作日志 |
| 延迟/限流口味、wakeDelay 等 | 运行端配置 | ✅ 本来就在运行端 |

代价：把行为层搬到运行端，意味着我们对 agent 的 overlay **必须进仓库**（现在只在设备上），
否则别人拿到的是残缺产品。这条在 v1 发布前必须解决。

## 6. 怎么自己复核

```powershell
# 运行端 live 配置（不打印凭据）
adb exec-out run-as com.whaleonebot cat files/rootfs/agent/data/config.json > .tmp/agent-config.json
node .tmp/cfg-audit2.mjs      # 节奏/超时类
node .tmp/cfg-audit3.mjs      # conversation 子树 + reply 类

# 我们协议端的状态
adb shell run-as com.whaleonebot tail -n 40 files/rootfs/opt/whale/qq-state/bot.log

# 发送归档（每次成功发送一行）
adb shell run-as com.whaleonebot tail -n 5 files/rootfs/qq-onebot/runtime/outbound-archive.jsonl
```
