# Whale OneBot

**在手机上跑一个 QQ 机器人，不用服务器、不用公网 IP，数据全在你自己手机里。**

一个 Android App 管住整个机器人（登录、配置、看板），一个可以单独部署的 OneBot 11 协议端负责通信。
你可以只用 App 开箱即用，也可以只拿协议端，把你自己的机器人接进来。

## 能做什么

- **手机就是服务器**：QQ 与机器人跑在 App 的隔离容器里，只走本机回环，不经过任何中转。
- **开箱即用的内置 QQ 机器人**：人格、记忆、知识库、群游戏、主动发言，装完扫码就能聊。
- **什么都能改**：运行端 22 组配置面板、按群设置对话模式与回复概率、模型与 Key 按用途分开配。
- **看得见**：总览、会话、调用（含注入与推理过程）、记忆、运维、亲密度、好友、插件、待对账。
- **可拆开用**：协议端单独部署，接你自己的机器人。
- **不注入、不 Hook**：走 QQ 官方原生模块的公开接口，不往 QQ 进程里塞东西 ——
  这才是它到现在**没被腾讯踢下线过**的原因。功能面却不比常见协议端少多少。

## 协议端的特点

| | |
|---|---|
| 标准 | OneBot 11；HTTP + 正向/反向 WebSocket |
| 动作 | 发送、历史、群管理、群文件、请求处理、媒体下载，`get_supported_actions` 给真实清单 |
| 消息段 | text / at / reply / image / record / video / file / face / json / forward，另有两个扩展段 |
| 鉴权 | Bearer 令牌；只监听回环 |
| 失败语义 | **区分「确定没发生」和「不确定」**：`1503` 可安全重试，`1504` 不要自动重试 |
| 连续性问题 | 一次发送拿不到回执**不会**把会话锁死（多数实现会） |

接口细节、动作清单、结果码、事件格式全在 **[协议端接口文档](https://github.com/18477514055/whale-onebot/blob/main/docs/protocol-api.md)**。

## 和常见协议端比

| | 本协议端 | 常见桥接类协议端 |
|---|---|---|
| 接入方式 | **调用 QQ 官方原生模块的公开接口**（不注入、不 Hook、不改内存、不自己造包） | 常见有 Hook 注入、内存补丁或自实现协议包 |
| 封号风险 | **低**：不往 QQ 里塞东西，账号行为跟正常客户端一致 | 取决于注入深度，普遍更高 |
| 功能面 | 消息/媒体/群管理/群文件/历史/请求处理都有 | 视实现而定，花样更多 |
| 部署形态 | 手机 App 内的容器 / 也可单独起进程 | 多为 PC 或服务器进程 |
| 账号数据 | 留在手机本地 | 常常要一台常开的机器 |
| 失败语义 | 明确区分「未提交」与「结果未知」 | 很多只有一个笼统失败 |
| 发送与会话 | 发送异常不阻塞后续发言 | 容易出现「一次异常整个群哑掉」 |
| 消息段完整性 | 不支持的段整条失败，不发半条 | 有实现会静默截断 |
| 群名 | ⚠ 部分 QQ 版本拿不到，需自备映射 | 视实现而定 |
| 生态 | 新项目，插件/适配器少 | 成熟项目生态更大 |

**优点**：不注入所以**稳**、装完就能用、数据不出设备、失败语义清楚、不会被一次发送异常拖死。
**缺陷**：生态还小、群名可能缺失、目前只支持 QQ、必须用手机跑容器（约 1.2 GB 骨架）。

## 快速开始（用 App）

1. 从 [Releases](https://github.com/18477514055/whale-onebot/releases) 下载 `whale-onebot-release.apk` 安装。
2. 首次启动需要一份容器骨架（Debian rootfs，约 1.2 GB）：放到手机 `Download/whale/rootfs.tar.gz`。
3. 设置 → 机器人 → 新建机器人 → 运行端选「内置运行端」（就是内置 QQ 机器人）→ 平台选 QQ → 保存。
4. 首页点 QQ → 选中这个机器人 → 启动 → 扫码登录。
5. 进「配置」填模型与 Key（Key 写入后不再回显）。

## 单独部署协议端

```bash
npm ci --ignore-scripts --include=optional
export WHALE_ONEBOT_TOKEN=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
node src/cli.mjs
```

默认监听 `127.0.0.1:13800`；请求带 `Authorization: Bearer <令牌>`。
把你的机器人当客户端接上去即可，接口见 **[协议端接口文档](docs/protocol-api.md)**。

## 文档

- [协议端接口文档](docs/protocol-api.md) —— 接自己的机器人看这篇
- [知识库怎么用](https://github.com/18477514055/whale-onebot/blob/main/docs/knowledge-base-user-guide.md)
- [内置 QQ 机器人是什么、怎么更新](https://github.com/18477514055/whale-onebot/blob/main/docs/runtime-index.md)

## 已知限制

- 内置 QQ 机器人**下载后不会自动安装**进容器：这一版还要手动放 rootfs（见快速开始第 2 步）。
- 群名补全依赖 QQ 原生回调，部分版本不触发，群列表只能显示「说过话的群」，名字退回号码。
- 记忆与知识库的向量检索依赖外部 embedding 服务；不可用时降级为关键词检索，不会崩。
- 目前只支持 QQ 平台。

## 许可与致谢

本项目以 **MIT** 发布（见 [LICENSE](https://github.com/18477514055/whale-onebot/blob/main/LICENSE)）。**内置 QQ 机器人**是在开源项目
**qq-agent-plus** 基础上深度改造的衍生版本，其 MIT 版权与派生链见
[THIRD_PARTY_NOTICES.md](https://github.com/18477514055/whale-onebot/blob/main/THIRD_PARTY_NOTICES.md)。与上游作者无隶属或背书关系。

> 说明：「内置 QQ 机器人」只是当前这一台的叫法。以后接别的平台时，那是另一套内置机器人，
> 不一定来自同一个上游。
