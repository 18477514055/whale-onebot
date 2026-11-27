# Whale OneBot 1.2.16

> 版本：`versionCode 12017` / `versionName 1.2.16`（紧接 `1.2.14` 正式版，合并并完善 `1.2.15` 全部去 Web 化与自有市场能力）  
> 交付阶段：本地核心包 + 三端 APK 构建验签完成、已推送测试机 `marble` 实测、公开仓库源码与文档同步完成（**已于 2026-11-27 发布 GitHub Release `v1.2.16`，含 APK / 核心包 / 索引 / 校验**）  
> 改动层级：`[layer: core-bot]` + `[layer: shell-android]` + `[layer: environment]` + `[layer: protocol]` + `[layer: docs]`

---

## 一、核心升级亮点（包含 1.2.15 + 1.2.16 全部重构）

### 1) QQ 与主运行端 / B 站彻底解耦 + 双级重启 + 防掉线硬化
- **QQ 下线不再拖垮 B 站与主运行端**：`container-bot.mjs` 启动后 1.5s 即独立拉起 `bili-behavior/worker.mjs` 与 `agent-app`（无 QQ 登录态时以 `qq-detached` 模式正常运行）；`safe_logout` / `switch_account` / `force_relogin` 仅退出 QQ 会话，不再误杀 Agent 或 B 站进程。
- **修复 B 站静默不动作的两处真因**：`BiliRuntime.dataDirs()` 补扫受管绑定目录 `rootfs/opt/whale/bindings/<botId>/workers/*`；`bili-behavior/scheduler.mjs` 改用忽略 `updatedAt` 的语义指纹判断配置变化，消除 45 分钟巡看定时器被反复归零的死循环。
- **双级重启与多号隔离准备**：`BoundStartScreen` 新增「重启 QQ 通道」（仅重启 QQ 进程，零中断 B 站与主容器）与「整容器全链路重启（关闭 QQ → 关闭容器 → 开启容器 → 开启 QQ）」二级操作（带多平台影响提示，并同步支持远端主力机 RPC）；`container-bot.mjs` 支持 `--slot=<botId>` 状态目录隔离；新增 120 行防掉线黑匣子 `blackbox.log`、网络出口诊断（Wi-Fi/流量/VPN/IPv6），消除 `completeReady()` 2ms 双重 `bridge attached` 竞态，并将非必要的 `rkey` 探测默认关闭以消除 `result:145` 异常包。
- **移除不可通行的拉起手 Q 路径**：经真机实测 `mqqapi` 拉起手 Q 会在内置浏览器跳转下载页导致登录失败，已从上线页彻底移除，聚焦「按需扫码」与「账密登录 + 滑块验证」。

### 2) 彻底去上游 Web 化 & 自有生态市场
- 彻底删除上游 Web 控制台（`input/agent-app/ui/` 62 文件 / 3.08 MB、`ui-build.js`、`poke-auto.js` 与相关路由），运行端回归纯粹 Headless JSON API（`webUi: false`）。
- 建立本仓自有 `market/{plugins,skills,mcp}` 与 `market/prices.json`，全部上游默认地址迁回本仓并支持多镜像回退。
- 新增 `McpHttpClient`（手机适配远程 Streamable HTTP / SSE MCP 客户端），以及 4 合 1 原生高级管理页（技能市场 / MCP 管理 / 内容运营 / 长期语义记忆）。

### 3) 模型库 / 模型分配双页解耦 + OpenCode 专属请求头 + 独立高质联网搜索
- **模型库（`ModelLibraryScreen`）**：集中管理全部 OpenAI 兼容服务商（内置 46 家预设，兼容 Alkaid 预设清单）与 API Key；OpenCode 渠道自动注入固定会话头 `x-opencode-session`。
- **模型分配与自动路由（`ModelsScreen` + `auto-router.js`）**：聊天主模型、记忆整理、识图、语音均直接从模型库点选并独立设置思考强度；新增一键「记忆整理复用聊天主模型并关闭思考」；新增自动路由（快模型 / 强模型场景分流 + 有序故障降级池，候选模型全部从模型库选择）。
- **独立联网搜索页（`WebSearchScreen`）**：彻底移除低质网页抓取源（百度 / 必应）及未实现默认项，仅保留博查、秘塔、智谱、Tavily、豆包、DeepSeek、多源聚合与自定义 API，配置独立搜索 Key 并支持页内直测。

### 4) 10 段结构化人设、单群独立子页、记忆库一级化与压缩包导入
- **人设管理（`PersonaEditScreen` + `PersonaTemplatesScreen`）**：新增独立「创建 / 编辑人设」页面，支持 10 段结构化编辑与整文 Markdown 互转，内置管理员附加规则与 9 款经典内置人设（一键应用或复制二创）。
- **单群独立设置子页与非 Hook 群名（`PerGroupScreen` + `WhitelistPicker`）**：移除弹窗浮层，改为点击群进入独立单群配置页（回复概率、被 `@`/戳一戳冷却、专属人设覆盖、独立记忆隔离）；修复 `get_chat_names` 双重 JSON 包装 Bug、延长非 Hook Web CGI 拉取超时至 15s、新增本地持久化群名缓存与手动群备注 + 一键刷新全部群名。
- **锁定完整生命周期 & 4 区块克制专业重构**：配置页收拢为「核心配置 / 资料与记忆 / 聊天行为与日常玩法 / 高级与底层参数」四大清晰分区，移除大白话标题、上游省钱档位、旧版对话模式切换器与重复看板跳转；「启动与上线 / 机器人配置 / 运行看板 / 扩展中心」四入口边界清晰零重叠。
- **记忆库升格一级 + 纯 Java 压缩包导入 + 人工搜索（`ArchiveImporter` + `file-import.js` + `MemoryScreen` + `KnowledgeScreen`）**：记忆库与知识库均支持直接多选 `.zip` / `.tar.gz` / `.tgz` / `.tar` 及 `.md` / `.txt` / `.json` / `.csv`（含防 Zip Slip 路径穿越与解压炸弹保护），并双双新增给「人」用的顶部关键词搜索栏（分别接入 `POST /api/local/memory/search` 与 `POST /api/local/knowledge/search`）；导入记忆库的背景文档自动提交记忆整理模型提炼并写入向量库。
- **模型在线拉取、全 App 群名/昵称同步、心情来源标群与界面精简**：
  - `ProviderEditScreen` 新增「拉取模型列表」按钮（带关键词过滤与多选确认弹窗），后端 `POST /api/providers/fetch-models` 支持按 `providerId` 复用已存 Key 并兼容 OpenCode 路径；
  - 新增全 App 统一名称目录 `NameDirectory` 并接入 `DashKit.chatLabel()`，自动合并手动备注、协议端群/好友列表与运行端会话/人物目录；全 App 自动同步显示「群名（群号）」，未拉取到群名的群清晰保留「群 `<群号>`」；
  - 修复 `mood-capture.js` / `mood-engine.js` 将来源 `chatKey` 写入 `mood_log.scope`，心情变化记录同步标明来源群与触发者；
  - 修复 `WebSearchScreen` 连通性测试路径（`/api/web-search/test`）及 `NativeManageScreen` 长期语义记忆跨活跃群自动召回测试与归档/录入协议；
  - 全局精简多余提示文案与实现细节说明（移除「自动会话头」等冗余文字）。
- **全页保存不回顶**：配置页、模型库、渠道编辑、模型分配、联网搜索、按群设置、人设管理、记忆库、知识库与 B 站设置页在保存/刷新后均保持当前滚动位置。

---

## 二、验证清单（如实写明）

### 已验证
- **全量编译与静态扫描**：Android 全部 **161 个 `.java` 文件 `javac --release 8` 0 错误**，UTF-8 BOM **0 命中**，原生 `AlertDialog` **0 命中**；全部改动 `.mjs`/`.js` `node --check` 0 错误。
- **主机侧自动化测试全绿**：
  - `node scripts/run-java-logic-tests.mjs`：**15 套纯 Java 逻辑测试全通过**（含新增 `V1216RefactorTest` 11 项断言：`.zip` / `.tar.gz` 流式解包、Zip Slip `../` 与盘符拒绝、非文本过滤）；
  - `node test/core-deweb-and-market.test.mjs`：**8/8 PASS**（去 Web 化、自有市场哈希校验、McpHttpClient、自动路由、去百度必应、记忆导入调用 `memoryChat` 提炼）；
  - `node test/container-watchdog.test.mjs`：**8/8 PASS**（含 MSF `-10004/-10003` 受控自愈）；
  - `node --test --import ./test/preload.mjs test/notice-events.test.mjs test/bridge.test.mjs`：**110/110 PASS**。
- **三端 APK 与核心包验签**：
  - `bot-core-1.2.16.zip`（296 文件，**1,851,975 B**，sha256 `adfe4a0eb6347b4ce15e37ea092aac214eba59f524faaf8eec3383b5865f3397`）
  - `whale-onebot-1.2.16.apk`（release 正式签名 `4e2e2ef3…`，无 debuggable，**109,950,596 B**，sha256 `7ecd5caa9637573ddb4476d3986bfd9258c48d5062d67ce78dbebfa3e6ed4a15`）
  - `whale-onebot-debug-1.2.16.apk`（debug 签名，debuggable，**109,991,749 B**）
  - `whale-onebot-beta-1.2.16.apk`（`com.whaleonebot.beta`，release 正式签名 `4e2e2ef3…`，**109,950,596 B**）
- **测试机 `marble` 实机覆盖安装与多接口实测**：
  - MD5 校验通过后覆盖安装 `whale-onebot-debug-1.2.16.apk`（`12017 / 1.2.16`）并覆盖无 Web 新核；
  - 实测在 QQ 未登录（`waiting-manual-login`）状态下，`bili-protocol-host.mjs`、`bili-behavior/worker.mjs`、主 `agent-app`（`mode=qq-detached`）与 `binding-supervisor` 全部独立拉起运行，且 `127.0.0.1:41907/` 实返回 `HTTP 200 {"ok":true,"service":"whale-agent-api","webUi":false}`；原有知识库 124,448 段与 660 条记忆印象 100% 完好保留；
  - QQ 登录后实测免扫码快登自动恢复在线（`phase=agent-running`），并实机验证 `POST /api/web-search/test`（`200`, `668ms`, 6 条）、`POST /api/living-memory/recall-test`（免填 `chatKey` 跨 8 群聚合命中真实长期记忆）、`POST /api/local/memory/search`（命中真实成员印象）与 `POST /api/local/knowledge/search`（命中群星知识库片段）全部通畅。

### 尚未实机逐项闭环（如实标注）
- 测试机当前停在 `waiting-manual-login` 等待用户手动重新扫码/账密登录 QQ，因此新版非 Hook 群名冷启动实网拉取、QQ 在线后长时保活稳定性以及自动路由真实上游 API 调用待用户登录后实机观察；
- 压缩包导入 UI 与 10 段人设编辑页的交互链路已在主机单测与静态编译全量通过，待真机屏幕手点验收。
