# B站文本私信：独立运行与验收

当前入口面向**一个已授权测试账号及一个双方同意的对端**。不发现或读取整个收件箱，不改 QQ 账号、端口、历史或 App 配置。HTTP/WS 与 QQ 共用同一套 OneBot 传输实现，但账号校验、动作与会话游标属于 B站实例。这不是 Android 安装包的功能。

## 接入方式与限制

[官方开放平台](https://openhome.bilibili.com/doc)列出的账号授权、稿件、数据和直播能力中，未找到普通账号任意一对一私信的公开授权 scope；不能拿一个 OAuth token 当私信权限。当前实现使用[社区记录的网页版私信契约](https://github.com/SocialSisterYi/bilibili-API-collect/blob/917a90a/docs/message/private_msg.md)，不是官方承诺稳定的 API。只在平台规则以及所获许可允许的范围内使用；持有账号不等于获得平台对自动化的许可。不切换身份绕过限制，不代过验证码。没有额外浏览器依赖或客户端注入。

## 第一次：有人值守的一问一答

**推荐：自己在官方网页登录，不复制 Cookie。** 在项目根目录运行以下命令；第一条只安装可选浏览器驱动，不改根项目依赖。需本机已有 Chrome/Edge（Linux 可设置 `BILI_BROWSER` 为 Chromium 路径）。

```powershell
npm.cmd install --prefix .tmp/bili-browser-tools --no-save --no-audit --no-fund --ignore-scripts playwright-core@1.56.1
node scripts/bili-browser-smoke.mjs
```

只在弹出的独立窗口登录小号。终端按 Enter 验证后，输入同意测试的另一个 UID，输入 `REPLY`，由对端发送 `READY` 后显示的随机挑战。程序取得发送回执后退出，浏览器会话关闭；只将非秘密设备 UUID 留在本项目忽略的 `runtime/`。也可选择 `READ` 仅收，或在对端 UID 处直接回车，仅验登录。**本次实测走的就是这个入口：服务报告入站验证和正回执，操作者另行确认看到了回显。**

已有测试 Cookie 的 Windows 替代路径：在自己控制的 PowerShell 窗口执行 `powershell -NoProfile -ExecutionPolicy Bypass -File D:\qq-onebot\scripts\bili-attended.ps1 -Reply`。按提示输入两个 UID 和测试会话 Cookie（隐藏输入）；省略 `-Reply` 就只验接收。不要在聊天中发送这些凭据。

手动方式：要求 Node 24+，先在项目根执行 `npm ci`（已安装依赖则跳过）。在**自己的 PowerShell 窗口**准备环境，不把任何 Cookie 放在命令行、配置文件或聊天里。下面的 `Read-Host -AsSecureString` 隐藏输入；进程环境中仍会有明文，仅在自己的测试机器使用。Cookie 只输入该测试会话必需的 `SESSDATA=…; bili_jct=…`（只收可省略 `bili_jct`）。不要提供主账号或其他网站的 Cookie。

```powershell
Set-Location D:\qq-onebot
$env:BILI_SELF_ID = Read-Host '授权测试机器人的 B站 UID'
$env:BILI_PEER_ID = Read-Host '同意测试的另一个 B站 UID'
$secret = Read-Host '测试号 Cookie（不回显）' -AsSecureString
$env:BILI_COOKIE = [Net.NetworkCredential]::new('', $secret).Password
$secret.Dispose()
```

- **只收：** `npm.cmd run smoke:bili`。等就绪后，从指定对端发终端显示的随机挑战，不发给陌生人。
- **收发：** 写测试还需给本安装指定一个固定 UUIDv4（非密码，可用 `[guid]::NewGuid().ToString()` **一次生成，以后复用**）并放入 `BILI_DEVICE_ID`。执行 `npm.cmd run smoke:bili -- --reply`。每次使用新挑战，只匹配当前挑战并回复一次。接口返回 `msg_key` 证明受理；对端亲眼看到回复才记送达。发送可能把会话标成已读。
- 测完执行 `Remove-Item Env:BILI_COOKIE` 并关闭专用窗口。不要把消息内容、令牌或请求头复制到工单中。终端断开、超时或返回未知结果时先到会话核对，不重复发同一句。

## 常驻协议服务

同一窗口设置独立、高熵的 `BILI_ONEBOT_TOKEN`（至少 16 字符，不复用 QQ token）。`npm.cmd run start:bili` 默认只读；显式 `npm.cmd run start:bili -- --allow-send` 才允许向 **BILI_PEER_ID** 发文本。默认 `127.0.0.1:13810`，可通过 `BILI_PORT` 修改。启动先核对账号身份并采样会话尾部，不补发历史。Ctrl+C 停止。登录失效时由操作者在 B站重新登录并重新注入环境；不抓个人浏览器档案、不在磁盘保存 Cookie、不自动重登。

自定义机器人连 `ws://127.0.0.1:13810/` 接收 OneBot 11 `post_type=message, message_type=private, platform=bilibili` 事件，向 `http://127.0.0.1:13810/` POST JSON `{ "action":"send_private_msg", "params":{ "user_id":"<对端 UID>", "message":"回复文本" } }`。两者均使用 `Authorization: Bearer <独立令牌>`。不要把这些地址设进正在运行的 QQ 机器人。事件与回复的会话键、记忆和模型配置要与 QQ 隔离。

## 单绑定调试运行端（不动现有 QQ 实例）

以下是私信调试或独立部署的方法，不是要求每个平台新建一个机器人。要让现有机器人同时负责 QQ 和 B站、共享记忆与知识，请使用[逻辑机器人及多绑定运行方式](logical-robot.md)。

启动上面的协议服务后，在**另一个专用窗口**给运行端配置以下环境。它只需要 OneBot 令牌，不需要 B站 Cookie。先按 `input/agent-app/package.json` 安装其自身的运行依赖。请使用新数据目录；同一数字在 QQ 和 B站上不是同一个身份，不能复制 QQ 记忆库或直接替换 QQ 控制台的地址。

```powershell
$env:WHALE_AGENT_PLATFORM = 'bilibili'
$env:WHALE_BILI_SELF_ID = Read-Host '与协议端相同的 B站测试号 UID'
$env:QQ_AGENT_DATA_DIR = "D:\qq-onebot\runtime\bilibili-$($env:WHALE_BILI_SELF_ID)"
$env:WHALE_BILI_CONSOLE_PORT = '13210'
$env:WHALE_ONEBOT_HTTP_URL = 'http://127.0.0.1:13810'
$env:WHALE_ONEBOT_WS_URL = 'ws://127.0.0.1:13810/'
$secret = Read-Host '本次协议服务的独立 OneBot 令牌（不是 Cookie）' -AsSecureString
$env:WHALE_ONEBOT_TOKEN = [Net.NetworkCredential]::new('', $secret).Password
$secret.Dispose()
node input/agent-app/src/server.js
```

单独在该实例中配置模型和私信回复策略；握手成功并不等于模型已配置或每条信息都会触发回复。首次联调推荐先用上面的随机挑战，它不需要模型，也不改机器人行为策略。

## 本阶段不支持

默认文本私信模式不包含群聊、任意陌生人私信、图片发送、评论或直播弹幕。图片与其他账号动作是另外授权的[账号动作模式](bilibili-account-actions.md)，不能用 `--allow-send` 解锁。只传启动后轮询观察到的文本，不是离线收件箱同步；协议 WS 断开期间没有持久投递或重放保证。认证、限流、平台风控导致会话不可用时，应人工检查状态而非尝试更换参数规避限制。
