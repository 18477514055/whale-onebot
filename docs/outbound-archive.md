# 机器人原话归档（`runtime/outbound-archive.jsonl`）

> 用户 2026-11-19 的要求：**机器人所有发送都落库**，过一段时间用大模型整理，整理完删掉原话，
> 只保留浓缩内容 + 时间 + 群聊名称之类关键信息。这样"它到底说了什么"能查，也不会无限涨。

## 1. 为什么要放在协议端，而不是运行端

| 来源 | 记的是什么 | 能不能当真相 |
|---|---|---|
| 运行端 `messages` 表 | **它认为**发出了什么 | ❌ 同一条会记两行（我们的发送记录 + QQ 回显事件），实测 `mid=795087227` 与 `mid=7784075801087434961` 是同一条 |
| 协议端归档 | 我们**确实回了「成功」**的那些发送 | ✅ 发送权威在协议端（PRINCIPLES P4） |

## 2. 一行长什么样

```json
{"at":"2026-11-19T12:32:17.000Z","at_ms":1795091537000,"action":"send_group_msg",
 "chat":"group:871721981","message_id":795087261,"accepted_without_receipt":false,
 "text":"我这边就是自带那套 没装别的","segments":[{"type":"text","data":{"text":"…"}}]}
```

| 字段 | 含义 |
|---|---|
| `at` / `at_ms` | ISO 时间与毫秒（后者给整理脚本排序用） |
| `action` | 只归档会进 outbox 的发送动作：`send_msg` / `send_*_msg` / 转发 |
| `chat` | `group:<群号>` 或 `private:<QQ号>` |
| `message_id` | 拿到回执就有真实 id；拿不到为 `null` |
| `accepted_without_receipt` | `true` = 已提交给原生且被接受，但 QQ 侧没给确认（P4 语义） |
| `text` | 消息段摊成的人话（`[图片]`、`[表情212]`、`[@123]`、`[回复:45]`） |
| `segments` | 原始消息段；超过 4 KB 时只留 `segments_truncated: true` |

**只记成功的发送**。失败/未提交的不进这个文件 —— 那些属于 outbox 与日志。

## 3. 整理（摘要）流程

```powershell
node scripts/compact-outbound-archive.mjs                        # 干跑：报会整理哪些
node scripts/compact-outbound-archive.mjs --apply --keep-days 7   # 真跑
```

- 只整理**够老**的（默认保留最近 3 天）、且**每组 ≥ 40 条**的，避免几句话也去调模型；
- 分组键是 `会话 + 日期`；每组交给模型压缩成 1–6 条要点；
- 结果写 `runtime/outbound-digest.jsonl`（含 `chat` / `chat_name` / `day` / `from` / `to` / `count` / `points`）；
- **写完读回校验通过才删原话**，删除前另存 `<归档>.before-compact-<时间>`；
- 任何一组摘要失败 ⇒ **整批不删**。

模型凭据只从环境变量读，不落盘、不打印：

```powershell
$env:WHALE_SUMMARY_ENDPOINT = 'https://api.deepseek.com/v1'
$env:WHALE_SUMMARY_MODEL    = 'deepseek-chat'
$env:WHALE_SUMMARY_KEY      = '<key>'
```

## 4. 群名怎么办（老实说：拿不到）

本机 `get_group_info` / `get_group_list` 恒 `1502`，所以**协议端无法自己取群名**。
想在上报里显示群名，就在 `runtime/chat-names.json` 里手工补一份映射：

```json
{"group:871721981":"那个聊肥鱼的群","group:780739184":"墨风他们那个群"}
```

整理脚本会读它：有名字就写进 `chat_name`，没有就只写群号（**不编造**）。

## 5. 已知边界

- 归档是**追加写**，单文件到 8 MB 滚成 `.1`（只留一代），不会无限长；
- 归档失败**不影响发送**（`maybeRecord` 吞掉所有异常）—— 与 P4 同一条道理；
- 面板/App 里还没有读它的界面（下一步）；目前用 `readArchive()` 或直接看文件。
