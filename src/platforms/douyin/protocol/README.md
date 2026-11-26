# 独立账号 OneBot 服务（抖音扩展）

本目录交付的是**本机传输和可信 provider 分发层**，不是能登录抖音的客户端。不需要安装内置机器人或主 App。裸服务可以独立启动；没有 provider 时，身份只代表配置绑定，`online:false`，可用动作和事件都是空数组。不要用「端口已通」判定「账号已在线」。这是 OneBot 风格的明确子集，不宣称兼容整个 OneBot 标准。

## 启动、关闭与复验

需要 Node **20.19 或更高**、`ws` **8.18.3**。独立复制本目录后按 `package.json` 提供依赖（如从离线包准备 `node_modules/ws`）；本轮直接使用工作区已有依赖，未安装或修改主仓。宿主为每个机器人/账号分别分配不可复用的随机令牌与进程，传入以下**进程环境**，不写凭据文件、不放命令行参数：

| 变量 | 意义 |
|---|---|
| `DOUYIN_BOT_ID`、`DOUYIN_ACCOUNT_ID` | 各自稳定的不透明字符串，不是登录凭据 |
| `DOUYIN_ONEBOT_TOKEN` | 加密安全随机值，建议 32 随机字节转 hex；字符集 `[A-Za-z0-9._~+-]`，32–256 字符 |
| `DOUYIN_PORT` | 缺省 `0` 由 OS 分配；始终绑定 `127.0.0.1` |

```sh
node server.cjs       # 就绪后 stdout 一行 {port,httpUrl,wsUrl}，没有令牌；SIGINT/SIGTERM 关闭
node --test test.cjs  # 有界回环、自生成随机令牌、无抖音请求；不需要填上面的变量
```

## 调用者契约

- HTTP：`POST /` 或 `/action`，JSON `{action,params,echo?}`；兼容 `POST /<action>` 直接传 `params` 对象。使用 `Content-Type: application/json`、`Authorization: Bearer <token>`。HTTP 不接受 token 查询参数。
- WebSocket：`/ws` 或 `/`，同样的 JSON 请求/回执，事件无 echo；推荐 Bearer 头。为现有原生 OneBot 客户端兼容 WS 握手的 `?access_token=`；头和参数同时存在时**两者都须匹配**。任何带浏览器 `Origin` 的请求均不接受。不得把带令牌的 URL 写入诊断记录或代理日志。
- `echo` 为字符串、安全整数或 null；响应 `{status:'ok'|'failed',retcode,data,message,echo?,platform:'douyin',bot_id,account_id,simulation,online}`。`get_login_info`、`get_status`、`get_capabilities` 参数 `{}`，其 `data` 都再提供同一身份五字段；另分别提供 `{user_id,nickname}`（绑定 ID）、`{good}`、`{actions,events}`（仅当前可用）。客户端核对**两项 ID**，线上模式拒绝 simulation；不要把 `get_login_info` 单独用作上线证明。
- `1400` 输入不合约，`1403` 能力不可用或审批未同意，`1404` 未支持，`1409` 本实例已见写请求 ID，`1429` 忙，`1503` provider 未提供可验证结果/审批超时。**`1502 outcome_unknown` 表示写动作已经交给 provider 但结果不明，请人工核对，绝不自动重发。** 信封 API 的业务失败仍返回 HTTP 200；`POST /<action>` 的 1502 特用 HTTP 502，以免宿主将不确定结果错误归为「确定未投递」。传输错误（断联等）也不能证明未执行。
- 请求帧或 HTTP body 至多 64 KiB；单实例 64 条连接、16 个并发业务请求，WS 不压缩。没有 HTTP 事件注入、鉴权跳过开关、外部 provider 模块路径、动态代码或 URL 下载入口。

### 动作参数 → 成功 data

写参数**一律另加** `request_id`；不认识的参数（包括 `approved`、`account_id`、路径）拒绝。ID 是不透明字符串，字符 `[A-Za-z0-9_:.@-]`，长度 1–128。消息是 1–16 段数组：`{type:'text',data:{text}}`、`image/media_id`、`share/work_id`、`at/user_id`，媒体 ID 不是本地路径。不包含 CQ 转义字符串协议。

| action | params（不含 request_id） | 成功 data |
|---|---|---|
| `send_private_msg` / `send_group_msg` | `{user_id,message}` / `{group_id,message}` | 写回执 |
| `reply_comment` / `post_comment` | `{work_id,comment_id,text}` / `{work_id,text}` | 写回执；回复不能缺原评论 ID |
| `set_like` / `set_favorite` / `set_follow` | `{work_id,enabled}` / `{work_id,enabled}` / `{user_id,enabled}` | 写回执；`enabled:false` 表示撤销 |
| `publish_images` / `update_profile` | `{media_ids,text}` / `{nickname?,bio?}`（至少一项） | 写回执，不等于发布界面可见 |
| `get_recent_context` | `{user_id 或 group_id,limit}` | `{messages:[{user_id,message}]}`。上下文不是待应答事件 |
| `get_feed` | `{source,limit,value?}` | `{items:[{work_id,tags:string[]}]}`。source 为 recommended/following 时不带 value，author/topic/search 时必带 |
| `get_work_media` | `{work_id}` | 下述有限视听包，作品 ID 必须匹配 |
| `resolve_public_work` | `{work_id}`，绝不接收任意 URL | `{work_id,visibility:'public',evidence:'anonymous',title,public_clip?}` |

写回执只投影 `{accepted:true,message_id?,work_id?,comment_id?}`。provider 未明确接受就不返回成功；accepted 不保证公开送达。`limit` 为 1–32，图文至多九个素材 ID。视听包 `{work_id,frames:[{ms,width,height,rgb24}],audio:{rate,pcm16le}}`：1–4 帧，每帧至多 160×160 且必须等于 `width*height*3` 字节；单声道小端 PCM16，8–48 kHz，至多 5 秒。两者都是规范 Base64，无临时文件路径或媒体 URL。该包证明有样本，**不证明样本看懂了整部作品**。

`resolve_public_work` 的实现必须与登录态读取隔离；可信 provider 要使用实际无登录视角验证公开性，关联相同作品并提供证明标记。协议层只能校验标记、作品 ID 与字段，不能独立验证外部世界；不满足条件返回失败，绝不回退绑定账号权限。可选 `public_clip` 只接受**同一次匿名公开返回**中可验证的相同 ID 有限视听包；没有时仅能引用公开标题，不得说已经观看。外层未知字段不会转发。

## 宿主/provider 契约

```js
const {createService} = require('./server.cjs');
const svc = createService({
  botId, accountId, token,
  provider,       // 由宿主在进程内构造；不是从请求、磁盘路径、网络或 CLI 动态加载
  grants,         // string[]，缺省 []；动作名和事件 kind 分别逐项列入
  authorizeWrite, // ({platform,bot_id,account_id,simulation,online,action,params,signal}) => true | Promise<boolean>
  timeoutMs: 30000
});
const endpoint = await svc.start(0);
// 可信事件源调用 svc.publish(raw)。停止监听并取消待处理审批：await svc.close();
```

`provider={botId,accountId,simulation:boolean,online:boolean,actions:{[action]:(params,ctx)=>data|Promise<data>},events:string[]}`。**只能信任宿主审核过的进程内代码**；`online` 必须来自 provider 实际验证的身份和会话状态，不能从请求读取，不能把配置 ID 当登录证明。每次检查账号+机器人绑定、在线状态、固定模拟标记、动作/事件白名单、进程内 grant 与 provider 声明，取交集。下线/撤销时先置 `online=false` 或移除对应 handler；更换绑定/授予列表时关闭旧实例、轮换令牌。仅写 `grants:['send_private_msg']` 不会使裸服务拥有该能力。

非模拟写需额外提供 `authorizeWrite`，缺少连能力都不公布。该回调以不可变参数、目标、账号、动作、request_id 作快照；自主模式也须匹配主人逐项规则，需确认的模式仅以同一快照的一次确认返回 `true`。超时、断联、停服、回调抛错或非 `true` 不分发。模拟 provider 仅供隔离夹具，可用显式 grant；如果同时配置回调也必须经过回调。`simulation:true` 的 provider **不得产生真实副作用**。真实 provider 自身也必须复核会话、绑定及授权，遵守 `ctx.signal`，不能用绕过用户界面的替代措施。协议不执行登录，不自行证明这段受信代码诚实。一个实例没有权力批准另一个实例的动作。

**防重边界：**服务在审批/分发前先占用 `request_id`，未结束的请求单独占位，不会被历史窗口挤出；对最近结束的 `requestWindow` 个请求按完成顺序滚动去重（默认 65,536，可由可信宿主设为 1–65,536）。成功、拒绝、超时、结果未知都占用一个历史位置；满后只淘汰最早结束者，新的独立动作不需重启。过窗或重启后内存层无法辨认旧 ID，**不是补发许可**：调用者禁止对未知结果自动重发或更换 ID，宿主/provider 必须持久化意图、去重键和未知状态，交由人工核对。`timeoutMs` 为单次审批+执行共享总时限；已经进入外部服务的写入无法撤销，迟到结果不会二次下发。

### 事件

`svc.publish({bot_id,account_id,kind,event_id,message_id?,time?,user_id,message,is_history,...route})`，没有 provider 能力返回 `false`，事件不合约抛错；返回 `true` 只代表接纳并尝试广播，不代表被客户端消费。kind 与所需字段：

| kind | 额外输入 | 输出判别及路由 |
|---|---|---|
| `private` | 无 | `post_type:message, message_type:private, user_id` |
| `group` | `group_id,mentioned:boolean` | `post_type:message, message_type:group,group_id,mentioned` |
| `comment` | `work_id,comment_id` | `post_type:notice, notice_type:douyin_comment,work_id,comment_id` |

`is_history` 必显式提供；缺失拒绝，而不是默认「新消息」。使用服务绑定生成 `self_id` 和身份五字段，`sender.user_id`、`message`、仅合并文本段的 `raw_message`，去除未知字段；`time` 为 Unix 秒。事件只发本实例已鉴权 WS 连接，无历史缓冲或自动重放。插件仍须丢弃历史/自己/重复事件，按配置处理群提及，并严格回复原会话或评论串；协议不会把业务策略隐藏在推送链路内。

## 证明范围和交接

本机 `node --test test.cjs` 验证独立 CLI 子进程、两个账号隔离、HTTP/WS 鉴权、三类事件、全部动作的合成 provider 分发、一次写入、审批超时、公开视听投影和未知结果处理。本地无真实账号、网络平台动作、设备或浏览器。本目录不带真实平台 provider，不能证明私信收发、推荐流、匿名公开性、互动送达、锁屏或 Android 进程保活。合法接入、本人授权、具体账号可用能力、幂等持久化、撤销授权及系统回收后的恢复应在合并后由主人逐项验证；不满足项必须继续留在能力清单外。
