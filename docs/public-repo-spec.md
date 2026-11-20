# 公开仓库要长什么样（用户 2026-11-19 定）

> 这个仓库（`whale-onebot-private`）长期私有、用作审查仓；真正对外的是**另一个干净的公开仓库**。
> 本文是那个公开仓库的**内容与形态要求**，由用户口述，我按条记录。实现前不要自由发挥。

## 1. 仓库里至少要有

| # | 内容 | 形态 |
|---|---|---|
| 1 | **协议端源码** | 源码，可独立部署 |
| 2 | **协议端 release 压缩包** | **不是 APK**：别人会像下载/部署 NapCat 那样部署它 |
| 3 | **多平台源码** | 手机端、Linux、Windows 端；**当前先放安卓端** |
| 4 | **成品 release** | 当前暂时只有手机端 APK |

## 2. APP 装完之后是什么样

- APP 里**包含成品的协议端**与**多平台桥接层**；
- 别人要做的是：**按文档与接口适配我们的接口**，把他自己的机器人接进来；
- 或者点「下载」，从**我们的仓库**拉取内置机器人（目前**只有 QQ 平台**的内置机器人）。

## 3. 必须**排除**的东西（用户明确点名）

| 项 | 原因 | 处理 |
|---|---|---|
| 我们**在这一版里自定义**的人格（基于「小鲸鱼」模板改出来的那套） | 那是用户自己调出来的口味，不是别人想要的 | 清空实例配置：`persona.botName` / `persona.roleText` / `persona.behaviorProfile` / `persona.participation` / `persona.customRules` / `persona.templateId`，以及 `customPersonas[]` |
| **管理员附加规则** | 同上，是用户自己写的 | **留空**（`admin.ownerUin` 也清空） |

**上游自带的模板全部保留**（`roles/` 下那 9 个：`duzui-sunyou`、`jishu-zhai`、`lezi-ren`、`maoniang`、
`nver`、`sunba`、`wenrou-peiliao`、`xiaojingyu`、`xuexi-dazi`）—— 它们是原作者的作品，也是新用户挑人格的起点。
我们只把自己**改出来**的那一份从配置里摘掉，不动模板本身。

> 判据：**别人的机器人不该带着我的口味和我的规则出生，但应该带着原作者给的选择。**

连同这些一并排除（既有规矩，这里再写一遍）：真实账号/群号、`allow` 名单、API Key、
`chat-names.json`、`messages.sqlite` 等任何用户数据、`_notes/` 与 `evidence/` 等开发记录。

## 4. 与私有仓的关系

- 私有仓 `whale-onebot-private`：审查用，可以带测试性提交与实验代码；
- 公开仓：**只带走源码、文档、许可证**；历史可以压缩或重新首次提交（不是 fork）；
- 两边的**许可义务一样**：MIT 全文 + 上游版权行（`Copyright (c) 2026 Kondius`）+ 派生链，
  且运行端包必须随包附 `app/LICENSE`（`scripts/stamp-runtime-licenses.mjs --check` 会把关）。

## 5. 面板更新入口的指向（已改）

面板保留「运行端更新」入口，但**指向我们自己的仓库**，永远不指上游：
`autoUpdate.repository` 默认 `https://github.com/18477514055/whale-onebot.git`
（公开仓定名前是占位名；容器每次启动会强制写回该地址，改配置也拉不到别处）。
上游专用通道 `autoUpdate.snowluma`（镜像更新）一律关掉。

## 6. 还没定的

- 公开仓的**名字**（决定后要同步：`RuntimeCatalog.BUILTIN_INDEX_URL`、README 的 Release 链接、本文件的第 5 节）；
- 协议端 release 压缩包**怎么打**（当前 rootfs 骨架里没有 `/input/agent-app` 与 `/qq-onebot`，是手工推进去的；
  见台账「运行端包缺口」那条）——这是公开仓能不能让陌生人跑起来的关键。
