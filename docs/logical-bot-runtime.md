# 一个机器人，多个 OneBot 账号

宿主负责启动或接入协议服务，提供每个账号**真实独立**的 OneBot v11 HTTP 动作端、正向 WS 事件/RPC 端和鉴权。内置机器人只消费协议，不加载 QQ/Bilibili 登录 SDK 或平台插件。自定义机器人也可以自行连接同样的服务，不依赖本 supervisor。

## 运行入口（已安装依赖的 agent-app）

```sh
node src/binding-supervisor.mjs /opt/whale/bindings/demo/manifest.json
```

下面全是示例端口和合成 ID。`selfId` 是期望值，不是赋予协议服务的身份；运行前必须换成该端点实际登录的账号。Bilibili 的 `get_login_info` 和事件必须返回 `platform:"bilibili"`；QQ 允许未扩展 `platform` 字段的标准 v11，但拒绝其它平台。新显式 QQ 绑定不要求旧 PC 专用 QQ 号；原单实例入口的固定账号守卫不变。

```json
{
  "version": 1,
  "botId": "demo",
  "runtimeKind": "builtin",
  "bindings": [
    {"id":"qq-work","platform":"qq","selfId":"900101","httpUrl":"http://127.0.0.1:25010","wsUrl":"ws://127.0.0.1:25011","consolePort":25012,"tokenEnv":"WHALE_BINDING_TOKEN_QQ_WORK"},
    {"id":"bili-home","platform":"bilibili","selfId":"900201","httpUrl":"http://127.0.0.1:25020","wsUrl":"ws://127.0.0.1:25021","consolePort":25022,"tokenEnv":"WHALE_BINDING_TOKEN_BILI_HOME","isolated":false}
  ]
}
```

- 每个逻辑机器人一个清单目录。`id`/`botId` 是不超过 64 字符的字母/数字/连字符/下划线 slug，首字符须为字母或数字。允许多个同平台账号；同一机器人内，启用的绑定 ID、平台+账号、控制台端口、协议监听端、令牌引用不得与另一绑定冲突。`enabled:false` 的占位不启动；`isolated:true` 单独存储持久记忆和知识库，默认共享。
- `tokenEnv` 只接受 `WHALE_BINDING_TOKEN_` 加 1–128 个大写字母/数字/下划线。由受信任启动器通过进程环境提供实际 bearer；不把值写进清单、命令行、日志或状态，不接受 `tokenFile`。每个 worker 只拿到本绑定的协议令牌，不继承其它账号或平台的登录凭据。
- 协议 URL 需显式 `127.0.0.1` 和端口，路径 `/`，无账号密码、query、fragment。HTTP 和 WS 可位于同一绑定的同一端口。控制台 1024–65535，避开已保留的 3210 和任何协议端口。
- `runtimeKind:"custom"` 不启动内置 worker，不执行清单中的任何命令，不读取 bearer；自定义客户端需自行使用宿主分配的标准端点/凭据。`external` 不代表其已在线。

## 共享人设不等于共享授权

逻辑机器人从同目录 `config.json`（或宿主环境变量 `QQ_AGENT_BOT_CONFIG` 指定的已有绝对 `config.json`）读取模型及人设。绑定 worker 只读同一份配置，不复制模型密钥或竞争写回。修改源配置或清单后重启 supervisor 生效。无模型配置可以完成协议验身，不代表可生成回答。

授权在此配置的 `bindingAccess` 下按 `platform:selfId` 明确指定。例如：

```json
{"bindingAccess":{
  "qq:900101":{"allow":{"groups":["700001"],"private":["800001"]}},
  "bilibili:900201":{"allow":{"private":["800002"]}}
}}
```

没有对应授权时不开放通常的聊天回复；仍可收到、验证协议事件。可配置每绑定 `deny`（优先），`allowAllWhenEmpty:true` 是显式放开空名单，不建议默认开启。仅 QQ 绑定接受**单独配置**的 `ownerUin`；不会将相同数字的 QQ 管理员、群/私聊白名单视为另一绑定的凭据。机器人仍受自身运行模式、暂停、活跃时间等设置约束。

只有 Bilibili 绑定可声明 `biliTools`，其值为 `bili-runtime-tools.md` 所述的**动作名 → 参数类型定义**对象（不是凭据或任意 HTTP/RPC 通道）；可选 `biliWrites:true` 才允许上游已授权的写动作。没有 `biliTools` 则不开启平台扩展，全局 `WHALE_BILI_AGENT_TOOLS` / `WHALE_BILI_AGENT_WRITES` 不跨绑定继承。写动作另受服务端开关/允许名单约束。

## 状态、数据和停机

`binding-status.json` 原子更新，含 `version,botId,updatedAt`（Unix 毫秒）及 `bindings:[{id,platform,selfId,consolePort,state}]`。受信任宿主可给本次启动注入 `WHALE_BINDING_RUN_ID`（32 位小写十六进制），状态只回显合法 `runId`。宿主需同时校验自有进程、启动代号和快照新鲜度；磁盘上旧的 `verified` 不能单独当作在线证据。`starting`、`disconnected`、`verified`、`failed`、`stopped`、`disabled`、`external` 分别表示启动、未验身/断线、当前连接 HTTP+WS 均已验身、退出失败、受控停止、禁用、外部管理。协议断线 worker 会自行重连；worker 崩溃不会重放业务请求，状态标失败，可由操作者修复后重启。单个 worker 崩溃不停止其它绑定。

- 会话、出站队列等绑定局部状态：`workers/<id>/<platform>-<selfId>/`；拒绝接管未标记的已有数据或目录身份不符。不同绑定即使对方 UID 相同，也不会复用会话队列或借用该账号发送回复。
- 默认机器人持久状态：`durable/<botId>/`。隔离绑定使用自身 worker 目录下的 `durable/`。共享记忆不等于共享原始聊天记录。
- supervisor 使用单实例锁；SIGINT/SIGTERM 停止所拥有的 worker。worker 通过 IPC 监视 supervisor 断开，宿主无需按名字清扫无关进程。

## 离线验证

在仓库根运行：`node --test test/binding-supervisor.test.mjs test/bili-agent.test.mjs test/bili-runtime-tools.test.mjs`。使用临时目录和真实回环 HTTP/WS 监听器，不接触生产登录或消息。
