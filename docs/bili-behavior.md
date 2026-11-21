# B 站行为层（`agent/bili-behavior`）

纯 Node（20+，ESM，零第三方依赖）的 B 站机器人行为层模块。遵循「协议端只提供动作，行为归运行端」的职责划分：何时巡看、看多久、读多少评论、是否写评论、配额记账、失败退避、验证码止损、作息窗与本地资料库均由本模块负责。

## 文件结构

- `index.mjs`：对外入口 `createBehavior({ config, call, clock, paths, ... })`
- `engine.mjs`：主循环与策略执行（作息窗、抖动间隔、多源拉取、观看推进、评论读写、待审队列、风控退避与 `stopOnVerify`）
- `library.mjs`：JSONL 资料库（`videos.jsonl` / `comments.jsonl` / `replies.jsonl` / `digest.jsonl` / `pending.jsonl`），全写盘均采用「先写临时文件再 `rename`」防止半行损坏
- `quota.mjs`：按「账号 + 本地日期」记账（`comment`/`like`/`coin`/`follow`/`dm`/`browse`）与 1 小时滑动窗口动作上限（`risk.maxPerHour`）

## 协议端动作名对照与「假设动作名」清单

本模块通过注入的 `call(action, params)` 调用协议端。经核查现有协议端源码（`src/platforms/bilibili/actions/social-reads.mjs`、`browser.mjs`、`community.mjs` 等），以下列出本模块使用的 7 个约定动作名与协议端现状的对照：

| 行为层约定动作名 | 参数契约 | 返回契约 | 协议端现状（`src/platforms/bilibili/`） | 是否属于假设/需适配 |
| --- | --- | --- | --- | --- |
| `bili_recommend` | `{ partition, count }` | `{ videos: [{ bvid, title, author, authorId, durationSec, desc }] }` | 协议端暂无对应动作 | **假设动作名**（协议端尚未实现推荐流） |
| `bili_follow_feed` | `{ count }` | `{ videos: [...] }` | 协议端仅有 `bili_dynamic_feed`（参数 `{ offset, host_mid }`，返回动态原始结构） | **假设动作名**（需适配器映射到 `bili_dynamic_feed`） |
| `bili_search` | `{ keyword, count }` | `{ videos: [...] }` | 协议端已有同名 `bili_search`，但参数为 `{ keyword, page }` 且返回原始搜索响应 | **同名但需适配参数与返回结构** |
| `bili_favorites` | `{ count }` | `{ videos: [...] }` | 协议端拆分为 `bili_favorite_folders` + `bili_favorite_items` | **假设动作名**（需适配器组合调用） |
| `bili_comments` | `{ bvid, count, order }` | `{ comments: [{ rpid, text, author, authorId, likes, isHot, ctime, parentRpid }] }` | 协议端已有同名 `bili_comments`，但参数为 `{ aid, mode, offset }` | **同名但需适配 `bvid→aid` 与排序/分页** |
| `bili_comment_send` | `{ bvid, text, rootRpid?, parentRpid? }` | `{ ok: true, rpid }` | 协议端在 `browser.mjs` 中名为 `bili_send_comment`（参数 `{ oid, message, root, parent }`） | **假设动作名**（需适配器映射到 `bili_send_comment`） |
| `bili_reply_list` | `{ bvid, rootRpid, count }` | `{ replies: [...] }` | 协议端在 `social-reads.mjs` 中名为 `bili_comment_replies`（参数 `{ aid, root, pn, ps }`） | **假设动作名**（需适配器映射到 `bili_comment_replies`） |

## 离线测试

```bash
node --test test/bili-behavior.test.mjs
```
