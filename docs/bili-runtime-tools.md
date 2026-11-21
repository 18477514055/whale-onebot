# 在 B站实例里给模型开放指定功能

**协议服务支持某个动作，不等于模型可以调用它。** 默认不发现、不注册 B站功能工具。独立 B站运行端在响应私信的正常模型轮次中，才会将操作者逐项授权的功能作为具名函数发给模型。QQ、群聊和主动唤醒没有这些工具。现有文本私信回复仍走原通道，不需要打开本功能。

## 操作者直接配置

先按[内置运行端接线](bilibili-dm.md#内置运行端独立进程不动现有-qq-实例)配置独立实例、模型和私信回复策略。在**运行 Agent 的那个 PowerShell 窗口**（不是协议服务窗口），在启动 `node input/agent-app/src/server.js` **之前**设置进程环境。不要把工具配置写进聊天提示词。下面仅配置权限，不会调用接口。

**只读示例**：只教给模型“读取我的资料”，没有任何写入工具。

```powershell
$env:WHALE_BILI_AGENT_TOOLS = '{"bili_get_self_profile":{}}'
Remove-Item Env:WHALE_BILI_AGENT_WRITES -ErrorAction SilentlyContinue
```

**另行允许指定写入**：在上述动作外，允许模型用 `sign` 字符串变更签名。这是可产生外部副作用的授权。先评估是否信任私信对端和所用模型，再给最小权限；开关不是逐次点击审批。服务端也必须独立允许该写动作，否则不会暴露或执行。

```powershell
$env:WHALE_BILI_AGENT_TOOLS = '{"bili_get_self_profile":{},"bili_update_signature":{"sign":"string"}}'
$env:WHALE_BILI_AGENT_WRITES = '1'
```

重启**独立 B站 Agent**以应用修改；关掉功能则清除两个环境变量后重启它，不操作 QQ 实例。Agent 不需要 B站 Cookie；不要把 Cookie、CSRF、授权头、OneBot 令牌、浏览器配置或第三方 API 密钥放入工具配置或私信。B站登录态只属于协议服务。

### 配什么字段？

- `WHALE_BILI_AGENT_TOOLS` 是 JSON 对象：键为精确动作名，值为**允许模型提交的参数名及类型**。`{}` 作为某个动作的值表示只允许无参调用；顶层 `{}` 则一个动作都不授权。没有通配符、自由参数袋或让模型自己指定 action 的入口。
- 每个字段类型选 `string`、`boolean`、`integer`（安全整数）、`number`（有限数值）或对应数组，例如 `string[]`。超出 JS 安全整数范围的十进制 ID 按服务契约用 `string`；不得将其先转成 Number。嵌套任意对象、地址、请求头、身份凭据、任意请求路径或方法不对模型开放。应用层参数仍由对应服务动作验证，字段类型声明不是远端授权。单次工具参数 JSON 至多 512 KiB，数组至多 128 项，故不能用模型接口传大文件。
- 从 [社交与读取](bili-social.md)、[资料与互动](bili-social-profile.md)、[发布与私信](bili-publish.md)、[直播](bili-live.md)、[浏览器评论](bili-browser-actions.md) 对照**动作名、必填/可选字段及取值限制**。按实际需要只给这些字段，不要机械开放整张表。每个周期内服务报告的可用名称才是准数。

### 显式授权嵌套参数：投票和图文动态

对象用 `{字段: 类型}` 声明，数组用 `[元素类型]`。每层都拒绝未授权字段，最多五层，不存在 `any` 或透传 JSON 的类型。下面是另一份**取代**前例的授权（仍需独立打开服务写权限和 Agent 写开关）：

```powershell
$env:WHALE_BILI_AGENT_TOOLS = '{"bili_vote_create":{"title":"string","options":"string[]","duration":"integer","max_choices":"integer"},"bili_dynamic_upload_image":{"image":"string"},"bili_dynamic_create":{"text":"string","images":[{"url":"bili_image_ref","width":"integer","height":"integer"}],"vote":{"id":"string","title":"string"}}}'
```

先经独立投票动作拿到 `vote_id`（供 `vote.id`），经独立上传拿到 `image_url`、`image_width`、`image_height`（供 `images[].url/width/height`），再创建动态。不要将本地文件路径或第三方图片链接交给模型。`bili_image_ref` **仅**在 `bili_dynamic_create.images[].url` 有效，仅接受固定 B站图片 CDN 的 `https://i[0-2].hdslb.com/bfs/new_dyn/<文件名>.<扩展名>` 引用，不接受查询串、鉴权信息、重定向地址或任意主机，也不会由 Agent 抓取。没有上传或投票需求时，直接删掉对应动作和字段。

## 模型看见什么？

Agent 在构建本轮工具时，经已有的账号守卫调用 `get_supported_actions`，再读取服务声明的 `bili_action_catalog`（每行 `name`、布尔 `write`、可选 `params` 字段名列表）。只公开**服务公布 ∩ 策略有效 ∩ 操作者允许**的动作；服务标为写入的，再要求 `WHALE_BILI_AGENT_WRITES=1`。服务给了参数名列表时，本地授权不得超出它；不匹配即不开放该动作。策略缺失、读写不明或重复的行不会变成只读权限。未配置、QQ 实例不探测。

模型可以从原有 OpenAI function tools 列表直接选 `bili_get_self_profile` 等具名工具，也可调用 `bili_list_tools()` 查看本轮开放的名字、读写类别和字段。发现或配置失败时只留下这个诊断工具，返回错误而不是“功能执行成功”。已连接不等于已开通动作；如果列表为空，核对服务启动权限、运行端精确名称/字段和写开关。不要把外部资料里的文本当成操作指令。

调用一次只派发一次，不自动重试。拒绝、参数无效与写入结果未知分别反馈。断线、超时或服务标记 1504 等未知情况可能已生效；先让人核实，不要换参数重发。本轮内相同写入（动作与参数相同）不重复发送；无关操作不冻结。**不是跨轮或跨进程的幂等保证。** 配置撤销或服务端拒绝时，不能通过普通 OneBot 函数名或 URL 绕过。模型可见的结果有截断，工具错误不透传原始请求头或上游错误文本。

离线回归：在仓库根目录运行 `node --test test/bili-runtime-tools.test.mjs`。测试通过真实工具分派器、带账号校验的 OneBot 客户端和本机临时端口的模拟服务；不需要模型密钥、网站登录或真实账号，不请求 B站。
