# 协议端接口文档（OneBot 11）

> 写给**要把自己的机器人接进来的人**。看完这篇你应该能：连上它、发一条消息、收到消息、
> 知道哪些动作能用、失败时拿到什么结果。想看产品怎么用，回 [README](../README.md)。

## 1. 它是什么

一个 **OneBot 11 服务端**：你的机器人是**客户端**，通过 HTTP 或 WebSocket 调它、从它收事件。
它自己不管人格、不管记忆、不管该不该回复 —— 那些是你机器人的事。

## 2. 连接

| 项 | 值 |
|---|---|
| 监听地址 | 默认 `127.0.0.1:13800`（`WHALE_ONEBOT_PORT` 可改） |
| 鉴权 | 所有请求带 `Authorization: Bearer <令牌>`；令牌由 `WHALE_ONEBOT_TOKEN` 给，长度至少 16 |
| HTTP 动作 | `POST /{action}`，body 是参数对象；或 `POST /`，body 是 `{action, params, echo}` |
| 正向 WS | `/` 通用、`/api` 只发动作、`/event` 只收事件（前缀可用 `WHALE_ONEBOT_WS_PATH` 改） |
| 反向 WS | 见下节 |

**必读的一条**：动作请用 `POST`。用路径式 GET 调写类动作会得到 `1400`，别把"路径里写了 action 名"当成调通了。

## 3. 响应格式

```json
{ "status": "ok", "retcode": 0, "data": { "message_id": 795087261 }, "echo": "你传的 echo" }
```

| retcode | HTTP | 含义 |
|---:|---:|---|
| `0` | 200 | 成功 |
| `1400` | 400 | 参数不对 / 请求形状不对 |
| `1403` | 403 | 没有权限（只读模式、非管理者动作等） |
| `1404` | 404 | 数据取不到 / 桥接不可用 |
| `1429` | 429 | 触发了限流，稍后再试 |
| `1500` | 500 | 原生拒绝 |
| `1502` | 502 | 原生查询没完成（读类动作） |
| `1503` | 503 | **动作没有被提交**：可以安全重试 |
| `1504` | 504 | 结果未知：**不要自动重试**（可能已经生效） |

`1503` / `1504` 的区别很重要：前者确定没发生，后者不确定。发送类动作要特别注意 —— 见第 6 节。

## 4. 收事件

标准 OneBot 11 事件，`post_type` 分四类：

| post_type | 说明 |
|---|---|
| `message` | 收到消息；`message_type` 为 `group` / `private` / `discuss` |
| `message_sent` | **自己发出的**消息回显（用来对账） |
| `notice` | 群成员变动、撤回、戳一戳、禁言等 |
| `meta_event` | 生命周期与心跳 |

`message` 里的消息段与标准一致：`text` / `at` / `reply` / `image` / `record` / `video` / `file` /
`face` / `json` / `forward`，另有本实现的两个扩展段：

- `qq_graytip`：群里的灰条（只透出 `busi_id`，不带正文）；
- `qq_unknown`：暂时解析不了的元素，带 `element_type`（看到它就说明有元素没映射，值得提 issue）。

## 5. 支持哪些动作

`get_supported_actions` 返回当前实例的真实清单。按用途分组：

| 组 | 动作 |
|---|---|
| 元信息 | `get_login_info` `get_status` `get_version_info` `get_supported_actions` |
| 发消息 | `send_msg` `send_private_msg` `send_group_msg` `send_group_forward_msg` `send_private_forward_msg` `send_forward_msg` |
| 消息操作 | `delete_msg` `get_msg` `get_forward_msg` `mark_msg_as_read` `set_msg_emoji_like` `get_msg_emoji_likes` |
| 历史 | `get_group_msg_history` `get_friend_msg_history` |
| 好友/群信息 | `get_friend_list` `get_group_list` `get_group_info` `get_group_member_list` `get_group_member_info` `get_stranger_info` `get_group_honor_info` |
| 群管理 | `set_group_kick` `set_group_ban` `set_group_admin` `set_group_card` `set_group_name` `set_group_whole_ban` `set_group_leave` |
| 群文件 | `get_group_root_files` `get_group_files_by_folder` `upload_group_file` `delete_group_file` `move_group_file` |
| 请求处理 | `set_friend_add_request` `set_group_add_request` |
| 媒体 | `get_image` `get_record` `fetch_ptt_text` `upload_private_file` |
| 其他 | `send_like` `set_qq_profile` `set_self_longnick` `clean_cache` `set_restart` |

**关于群名**：部分 QQ 版本上原生回调不触发，`get_group_list` / `get_group_info` 可能返回空或 `1502`。
这不是你的接入姿势错了，是原生侧拿不到；请自行维护群号↔群名映射。

## 6. 发送语义（接自己的机器人时最该看的一节）

- **动作提交与结果确认是两件事**：原生接受就代表"发出去了"，QQ 侧回执只是补充。
- 拿不到回执时，本实现**可能**返回 `0` 且 `message_id` 为 `null`（取决于是否开启「按已接受处理」）。
  看到 `message_id: null` 不代表失败，只代表"没有回执可引用"。
- 需要**严格语义**（宁可不发，也不要不确定）时，关掉该模式：这样未确认的发送会得到 `1504`，
  你自己决定要不要重试。
- **不要因为一次发送没回执就停掉整个会话**：这是本实现在真实群聊里踩过的最贵的坑。

## 7. 部署（三行）

```bash
npm ci --ignore-scripts --include=optional
export WHALE_ONEBOT_TOKEN=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
node src/cli.mjs
```

环境变量：

| 变量 | 作用 |
|---|---|
| `WHALE_ONEBOT_TOKEN` | 必填，Bearer 令牌（≥16 字符） |
| `WHALE_ONEBOT_PORT` | HTTP 端口，默认 13800 |
| `WHALE_ONEBOT_WS_PATH` | WS 路径前缀 |
| `WHALE_DEBUG_ELEMENTS` | 设 `1` 时打印元素形状（排查 @/引用/未知元素用，默认关） |

## 8. 兼容性与边界

- **接入方式**：调用 QQ 官方原生模块的公开接口（service / listener 契约），**不注入、不 Hook、不改内存、
  不自己造协议包**。这也是它长期在线、没被平台踢下线的原因；代价是"公开接口拿不到的能力就是拿不到"。
- 面向 **OneBot 11**；没有实现 OneBot 12 的差异部分。
- 动作是否真的生效取决于底层原生能力：群里拿不到的数据就是拿不到，会返回 `1404` / `1502`，不会编造。
- 只在本机回环上通信；要跨机接入，请自己在前面加反向代理并确保令牌不泄漏。
