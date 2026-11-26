# Whale OneBot v1.2.10 更新说明

> **版本**：`1.2.10`（`versionCode 12011`）｜**内置核心独立部件**：`bot-core-1.2.10.zip`
> **这一版主要是"止血"**：修掉一个会把机器人拖到假死的体积问题，并补上掉线自愈与协议端能力扩展。

---

## 一、最重要的一件事：表情包把 `stickers.json` 撑到 293 MB，导致假死

**现象**：机器人跑一段时间后"静默下线"——进程还在、`phase` 仍是 `agent-running`、登录态也没掉，但控制台完全无响应、群消息不再回复。本次实测：`agent/data/stickers.json` **293 179 778 B（293 MB）**，同目录 `sticker-assets/` 另有 777 MB；agent 进程 RSS 冲到 **1.39 GB**，启动日志 `CONSOLE_READY after=+484s`（正常是 +14s）。

**根因**：表情包收集时把图片写成了 `base64://` 内联串**同时**存进 `stickers.json`，于是每次保存都要解析并重写一份近 300 MB 的 JSON，主线程被长时间占住。

**修法**：
- 落盘后**不再把 `base64://` 写回 `stickers.json`**，只在条目里留本地路径；
- 启动时做一次**无损迁出**：把已有的内联 base64 解出来写进 `sticker-assets/`，再清掉条目里的内联串 —— **不丢任何一个表情**；
- 文件元数据签名缓存，避免每次保存都整库重解析。

首次启动会把这 293 MB 迁走，之后 `stickers.json` 应该回到几百 KB 量级。

## 二、掉线/假死不再干等，补上自愈（新增 `container-watchdog.mjs`）

- **原生通道分级自愈**：应用层探活连续 2 次失败 → Level 1 进程内 `wakeSession`（**不重登**）；连续 4 次失败 → Level 2 限频安全退出重启。
- **`qr-ready` / `qr-polling` / `scanned` 一律不自动重启** —— 专门防止 `140022015` 那种"越重启越刷码"的死循环。
- **重启有闸门**：10 分钟冷却、每小时上限、时间戳落盘并按 1 小时窗口裁剪。
- **agent 控制台看门狗**：`/api/chats` 连续 3 次无响应只重启 `agentProc`，**保住 QQ 登录态与 OneBot 进程**（这次的假死正是这类）。
- 登录成功后一并清理 `qr.png`（此前只清 `qr.url`，废码会留在界面上）。
- 容器生命周期对称持放 `PARTIAL_WAKE_LOCK` + `WIFI_MODE_FULL_HIGH_PERF`，减少息屏后长连接被挂起。

## 三、协议端能力扩展（零二进制 Hook）

新增 `src/bridge/web-cgi.mjs`，并在 `actions.mjs` / `native-bridge.mjs` / `original-chat-bridge.mjs` 接上：

- `get_cookies` / `get_credentials` / `get_csrf_token`（**限定合法 `qq.com` 域、零日志落盘**）
- `get_group_list`（Web CGI + 60s 缓存 + 原生回调兜底）
- 文件上传与直链（`upload_*_file` / `send_*_file` / `get_group_file_url`）
- 加群审批（`set_group_add_request`）、群精华、`ocr_image`、本地消息搜索、高清头像、AI 音色目录、Qzone 与群相册
- 能力诊断 `get_protocol_readiness`

**没有非 Hook 通路的动作诚实保持 `1404`**（如 `set_group_sign` / `set_group_todo` / `set_group_special_title` / `send_group_ai_record`）；本轮**跳过**合并转发 `get_forward_msg`。

## 四、协议层源码随 APK 分发（补一个老缺口）

`build.ps1` 现在把整棵 `src/`（**51 个 `.mjs`**）同步进 `assets/qq-protocol/`，容器启动时释放到 `/qq-onebot/src/`。这解决了长期存在的「容器里的 `src/` 与仓库漂移、改了也发不出去」问题。

## 五、界面

- 新增 `WhitelistModel`：白名单选择器合并 `get_group_list`（真群名）与 `get_known_chats`（说过的会话）
- `QqScreen` 状态卡异步展示协议端能力与通行证状态
- `BotConfigSchema` 校对

---

## 六、产物与校验

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `whale-onebot-1.2.10.apk`（`com.whaleonebot`，12011/1.2.10） | 109 880 964 | `c39f270592c661ed3bbca90ae8b6c5bde5d8633fd84c3b778d5a8abc2c8e9876` |
| `bot-core-1.2.10.zip` | 2 434 559 | `37c02975f9513f0a197d66cdfe49ee03e3d6b9cbb43bd6c30f2c4a85407f3a73` |
| `release-index.json` | 13 981 | `5f3a298646aaf17b4c2894e89395740d2db6d88d253986436544e03cf598336e` |
| `SHA256SUMS` | — | 上面三个的校验和 |

本机三包（未上传）：debug `1db7e09d…` 109 922 117 · beta `695cbe4b…` 109 880 964。

**校验链自检 17/17 通过**：pin 无 BOM → url 指本版 → pin.sha == 索引字节哈希 → `current: 1.2.10` → `releases[]` 与 1.2.9 深相等（旧 App 不受影响）→ core 字节/sha 一致 → `manifest.sha256` 一致 → manifest 内 **350 个文件哈希全对** → SHA256SUMS 全对 → 滚动指针 `sequence = 3` 指向本版。另核对 APK 内 `assets/qq-protocol/` **51 个文件**、`assets/bridge/` 5 个（含 `web-cgi.mjs`）、`assets/container-watchdog.mjs` 均在包内。

## 七、验证了什么 / 没验证什么

**已验证（PC 侧）**：
- 8 个改动 JS/MJS `node --check` 全过；
- `test/sticker-migration.test.mjs` **3/3**、`test/container-watchdog.test.mjs` **4/4**、`test/web-cgi-and-actions.test.mjs` **3/3**；
- `run-java-logic-tests.mjs` **13 套全绿**（含新增 `WhitelistModelTest`）；
- 三包验签、包名 / debuggable、pin 内容、资产清单均核对；core.zip 内关键文件与源码逐字节一致。

**未验证（如实）**：
- **真机上有没有真的把 293 MB 迁走、启动耗时是否回到十几秒、RSS 是否回落** —— 要装上真机首次启动才知道；
- 新协议端接口（Cookie / 群列表 / 文件 / 加群审批 / Qzone / 群相册）只在合成用例里验过，真机行为未验；
- watchdog 的真实触发路径（原生探活失败、控制台无响应）没在真机上制造过。
