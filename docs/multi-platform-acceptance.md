# 一个机器人、两个协议：离线整链验收

本次检验的是**两个真正的内置机器人 worker**，不是把两条消息直接交给内存路由函数。输入从手机注册表形状的 `bots.json` 开始，输出同时在 OneBot 监听器、B 站模拟上游和两个 worker 的聊天 SQLite 里核对。模型是本机固定应答 HTTP 服务；不需要模型账号。

## 复跑

在项目根目录运行（已验证 Windows、Node v24.20.0）：

```powershell
node scripts/verify-multi-platform-bot.mjs .tmp/full-app-66dcb237aac34daf8dd7aeb934a6f12b/node_modules
```

脚本后的第一个参数是本机已有的、按内置应用声明安装的依赖目录，不是机器人工作目录。换机器时指向项目 `.tmp` 下自己的隔离安装。缺失即失败；脚本不自动安装，不搜索线上渠道或旧账号。仓库本身的 `ws` 依赖也需已安装。每次创建新的 `.tmp/multi-bot-*`，不复用前一轮的数据。终端给出实际目录；仅在整链断言通过后产生 `result.json`，失败则返回非零退出码。`stdout.log`、`stderr.log` 保留该轮 supervisor / worker 诊断。

## 验收依据

| 问题 | 如何判定通过 |
|---|---|
| 手机上的绑定真的能驱动内置运行端吗？ | 将两条平台绑定写入注册表夹具，再读回交给正式 `android/binding-host.mjs` 的 `projectManifest`；独立进程运行正式 `src/binding-supervisor.mjs`，由它启动两个 `server.js`。只有状态文件中 QQ `900111` 与 Bilibili `900101` 同时 `verified` 才投递。 |
| 回复有没有串平台、串账号？ | 两边使用**相同**的私聊对端 `900102`，但使用不同随机挑战和令牌。两个监听器分别拒绝对方的令牌（403）。在 QQ socket 投入错误平台、错误 self ID 的帧；两个库都不得有这些文本。有效消息只出现在本绑定的库中，且状态须为 `acked` 或 `read`。QQ 监听器必须恰好收到一条给指定对端的对应回复；正式 `BiliService` 的模拟 `sendText` 也必须恰好收到一条对应回复。 |
| 同一个机器人的记忆是否真在两个进程之间共享？ | 先从 Bili 控制台读到人设状态 `lastInteractionAt=0`，仅给 QQ 投递消息。QQ 回复后、Bili 尚未收到任何私信时，从 Bili 控制台读到非零时间戳，并与 QQ 控制台结果精确相等。检验的是共享人设状态，不是把相同数字的 QQ 与 B 站用户当成一个人。 |
| 知识库是同目录猜测，还是运行时真的查到内容？ | Bili 控制台初始文档为空；从 QQ 控制台写入含独立随机值的文档，Bili 无需重启即可列出。Bili 收到私信后，确定性模型第一轮要求调用 `knowledge_search`；第二轮**必须收到真实工具结果里的随机原文**才准回复。查到了文件名或共享了路径都不够。 |

2026-11-20 最终实跑：`.tmp/multi-bot-endDyb/result.json`。两种身份均 `verified`，两条入站均 `acked`，模型轮数 QQ **1**、Bili **2**；QQ 回复 **1**、Bili 模拟上游写入 **1**，错误帧落库 **0**。共享人设、跨 worker 知识检索都通过。启动期可能出现未完成验证前的好友目录读取被守卫拒绝、夹具不支持历史补齐等诊断；这些不是已验证功能，不能据此声称历史同步成功。

## 只装一种平台：从两个独立安装包启动

命令末尾加 `qq` 或 `bilibili`，另需 PATH 上已有 Python 3.12+。这两个模式各自调用正式 `bot-modules.py build` 只构建核心和所选平台的 ZIP，再使用本次 catalog 的 SHA-256 调用正式 `install`。复制已安装的运行依赖后，从新的安装目录运行 supervisor。启动前断言 `src/platform-modules` 仅有选中项；测试不创建另一平台的监听器，也不会因少装模块改从开发树启动。

```powershell
$deps='.tmp/full-app-66dcb237aac34daf8dd7aeb934a6f12b/node_modules'
node scripts/verify-multi-platform-bot.mjs $deps qq
node scripts/verify-multi-platform-bot.mjs $deps bilibili
```

| 安装与证据（2026-11-20） | 守卫身份 | 实际处理结果 |
|---|---|---|
| `core` + `qq`：`.tmp/multi-bot-6HQlgk/result.json` | `qq:900111` verified | 入站 acked，模型调用 1 次，QQ 端回复 1 条，Bili 写入 0 |
| `core` + `bilibili`：`.tmp/multi-bot-uedFul/result.json` | `bilibili:900101` verified | 入站 acked，模型调用 1 次，Bili 模拟上游写入 1 条，QQ 回复 0 |
| 双 worker 回归：`.tmp/multi-bot-mlMncS/result.json` | 两者均 verified | 两条入站均 acked；两平台各回复 1 条，共享人设与跨 worker 知识查询通过 |

单平台实验验证安装与收发，不将不存在的第二个 worker 计作共享数据测试。上述 ZIP 是运行源码模块，不含 Node 引擎或宿主 npm 依赖；不代表 Android 安装包已经发布。

## 隔离和未覆盖范围

- 只复制应用源码、角色、模式定义、价格表及明确提供的依赖（不跟随符号链接），只新建合成配置和数据，不复制 `input/agent-app/data`。注册表和 manifest 只携带令牌引用，两个 OneBot 令牌在本次进程内随机生成。禁用网络探测和模型 fallback，提供全新的 HOME/TEMP 和按绑定私聊授权，不继承用户的模型环境变量。
- QQ 侧使用正式 OneBot HTTP/WS transport 和合成 action 实现；Bili 侧使用正式 BiliService/bridge，仅替换它的上游 client。两个监听器、模型、控制台均绑定 `127.0.0.1` 临时端口。子进程 preload 拒绝非夹具 TCP、fetch、DNS 和 UDP；worker 同时启用 Node 文件权限，将读写限制为本轮目录并禁止派生子进程。Supervisor 只准启动本轮复制的正式 worker。Node 24 会在文件权限模式下禁用 `fsyncSync(fd)`，因此**仅生产实例锁的临时文件**交给验证父进程打开并实际 fsync 后再原子发布；其他文件权限不放宽。此隔离用于所列已知代码和依赖，不是运行任意不可信程序的操作系统级沙箱。
- **不是** Android 设备/UI 启动、实际 QQ 登录、B 站私信 API 送达、外部 LLM 智力或第三方插件验收。这里也不证明断电恢复、多人长期记忆语义或所有不同机器人/隔离绑定组合；它们不能由两次模型对话推出。无需且不得把真实设备、凭据或生产数据交给本脚本。
