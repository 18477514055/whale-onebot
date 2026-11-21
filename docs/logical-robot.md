# 一个机器人，多个平台账号

Whale 中的“机器人”是有稳定 `botId`、人设和运行端选择的主体。`(平台, selfId)` 是它负责的账号通道，不是机器人本身。一个人设可以连接多个账号；同一个平台也能由多个不同机器人分别负责不同账号。不要按账号数字合并身份：B站 UID 与 QQ 号就算数值相同，也不是同一个人。

```text
机器人 A ── QQ / 账号 1  ── OneBot HTTP＋WS ── QQ 转接层
         └─ B站 / 账号 2 ── OneBot HTTP＋WS ── B站转接层
机器人 B ── B站 / 账号 3 ── OneBot HTTP＋WS ── 另一账号的 B站转接层
```

**协议端不拥有机器人的记忆。** 每个通道独立完成身份校验、接收事件、发送动作和回执。不要把两个平台的凭据塞进同一个动作、用 QQ 号伪装 B站 UID，或把私信会话 ID 当作全球唯一 ID。运行端把一次回复送回该事件所属通道；平台专属动作只交给对应账号的协议端。

## 内置运行端与第三方的边界

- 内置运行端可以为一个机器人管理多个通道工作进程；进程隔离是为了避免回错账号，不代表创建多个人设。长期记忆和知识默认选择机器人范围；可将单个绑定改为独立范围。会话、发送队列、登录凭据、运行授权不是共享内容。不同机器人的范围不同。
- 独立 B站转接层无需内置运行端或其 B站插件。内置机器人的公开内容订阅/生活功能也不是私信或账号动作的传输层。模型需要操作 B站时按[工具授权说明](bili-runtime-tools.md)通过 OneBot 调用对应服务，不直接连接 B站网页。
- 第三方运行端可把多个 OneBot 客户端挂到同一机器人，也可完全分开。协议服务不要求安装我们的机器人、不要求使用我们的 SQLite，不会将任一账号的原始对话历史推给另一账号。

## 平台插件与自定义核心

协议端的转接层实现平台连接；运行端的平台插件通过 OneBot 使用该连接。二者独立发布。选用内置机器人时，每个机器人实例选择自己的核心与平台插件，新增平台只需增加对应插件。自带核心时不要求下载这些包。

手机上的自定义核心只保留通用的机器人和账号绑定管理。没有声明扩展时，不显示内置「启动 / 配置 / 看板」。第三方可以提供自己的入口；页面归该运行端维护，平台协议不规定页面结构。

## 第三方可用的绑定描述

对一个机器人使用单独的绑定清单。`version:1`，`botId` 稳定；`bindings[]` 的每个元素使用独立 `id`、`platform`、`selfId`（十进制字符串）、`httpUrl`、`wsUrl`、`enabled`、`isolated`，内置主管还使用每绑定的 `consolePort` 和 `tokenEnv`。示例为虚构账号和端口：

```json
{"version":1,"botId":"whale-a","bindings":[
  {"id":"qq-work","platform":"qq","selfId":"10001","httpUrl":"http://127.0.0.1:13800","wsUrl":"ws://127.0.0.1:13800/","consolePort":14201,"tokenEnv":"WHALE_BINDING_TOKEN_QQ_WORK","enabled":true},
  {"id":"bili-work","platform":"bilibili","selfId":"10002","httpUrl":"http://127.0.0.1:13810","wsUrl":"ws://127.0.0.1:13810/","consolePort":14202,"tokenEnv":"WHALE_BINDING_TOKEN_BILI_WORK","isolated":false,"enabled":true}
]}
```

```
node scripts/whale-bot-describe.mjs <bindings.json>
```

输出 `whale.bot-bindings/v1`：`botId` 及每条绑定的 `bindingId / platform / selfId / protocol / httpUrl / wsUrl / enabled / memoryScope / knowledgeScope`。示例中两个范围均为 `whale-a/shared`；若 `bili-work` 设为 `isolated:true`，其范围改为 `whale-a/bindings/bili-work`。范围是给自定义运行端的**逻辑键**，不是数据库路径，也不是读取其他账号的授权。描述器不读取 token、不连接端点、不把“已配置”报告为“在线”。第三方用自己取得的授权令牌分别建立连接，核实身份后再报在线。

## 内置主管的运行口径

内置主管按清单启动真正的运行端，按绑定分别做 HTTP/WS 身份核对。运行示例：`node input/agent-app/src/binding-supervisor.mjs <清单绝对路径>`。每条启用绑定的 `WHALE_BINDING_TOKEN_*` 环境变量须在启动前由操作者提供；不要在清单中写真实令牌。清单目录以机器人为单位，不可让两个机器人共用同一工作目录。进程退出或验证过期不算在线。

共享人设、知识或记忆不意味着复制对端的聊天权限。显式受管绑定按 `bindingAccess["平台:自身账号"]` 设置本绑定的私信/群白名单；未授权则不回复，即便连接已核验。换号要重新核对权限，不能把 QQ 管理员身份按数字搬到 B站。单绑定的旧 QQ 模式独立保留。配置字段见[运行端清单与权限](logical-bot-runtime.md)，共享和隔离的数据范围见[持久记忆与知识契约](robot-durable-memory.md)，实际覆盖的场景见[多平台整链验收](multi-platform-acceptance.md)。

## 手机上的配置与状态

首页以平台为入口，“设置 → 机器人”以机器人为入口；多个入口指向同一个机器人记录，不按平台复制记录。配置了平台、启动了工作进程、连接到了预期账号是三个不同状态。独立转接层需先提供可达的 OneBot 回环端点；内置主管不是 QQ 或 B站登录客户端。详见[手机绑定宿主](android-binding-host.md)和[本地整链验收](multi-platform-acceptance.md)。
