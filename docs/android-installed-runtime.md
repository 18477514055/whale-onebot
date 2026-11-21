# 已安装核心在 Android 上如何运行（D282）

**安装不是登录。** APK 的公共启动器只负责把宿主的绑定投影给运行端；内置机器人代码与平台适配器来自本实例当前安装的发行代，而不是全局 `/input/agent-app`。缺包、未配置账号、协议端未就绪、缺少本次授权和连接失败分别显示状态，不因同机器人另一平台已上线而报在线。

- 元数据来源：私有 `bots.json` 的 `coreInstanceId`、`coreInstances` 及唯一分配者。首次正常启动通过 `CoreInstaller.onNormalStart` 校验并切换待启用的发行代。仅为已在运行的机器人添加绑定时读取当前发行代，不为升级而停止兄弟工作进程。
- 代码：`files/core-instances/<coreId>/generations/<uuid>/agent-app` 精确挂载到该 proot 的 `/opt/whale/instance-app`。启动该挂载下的 `src/binding-supervisor.mjs`；它从同一挂载的 `src/platform-modules/<platform>/index.mjs` 加载本平台插件，实际工作进程是同目录树的 `src/server.js`。缺失接收回执或入口不会退回旧全局代码。
- 状态：`files/rootfs/opt/whale/instance-data/<coreId>/config.json`、`home`、`tmp`；共享知识/记忆位于 `durable`。每条绑定独立 `channels/<bindingId>/<botId>`，含 supervisor 描述、工作目录、状态与锁。独立记忆模式使用该工作的私有 `durable`。授权传入独立工作进程，不写在核心包或清单里。
- 控制：显式启动重新协调已配置绑定；一条待安装/待账号/待授权的绑定不会阻止其他已就绪的绑定启动。只有当前运行句柄、代际随机标识、账号/平台、30 秒内状态心跳全部匹配才显示 `verified`。停止某条已安装绑定不停止其他绑定，更不会注销协议账号。备份/释放要求先显式停止本机器人；维护锁拒绝仍有启动请求或运行者，不代用户停机。已有 `legacy-<botId>` 登记沿用旧路径；自定义核心不经过此启动器。
- 首次安装由安装器核对签名渠道、目录和环境摘要并调用 `ManagedEnvironment.prepare`。干净环境使用 ARM64 `/bin/bash`、`/usr/bin/env`、Node >=22.19（含 `node:sqlite`）、相应 ELF 加载器/共享库以及 `/opt/whale/node_modules` 中运行端依赖和许可证；仅“Node 在 PATH”不代表可运行。启动服务不预建空 rootfs，不在干净环境中启动旧原生 QQ。没有将任何旧工作手机镜像、QQ 客户端、专有 wrapper/loader 或账号打进安装包。新 QQ 插件可连接独立 OneBot 服务，不等于手机已经有一个合法、已登录的原生 QQ 协议端。
- 限制：新环境按发行摘要并置在 `files/core-environments/<sha>/rootfs`；每次启动依据该安装代的环境回执指定 proot `-r`，不覆盖或使用已有旧 rootfs。私有状态目录只挂到本次 guest `/opt/whale/instance-state`。实际 ARM64/真机并置仍需验收。proot 运行者属于同一 Android UID，此设计隔离实例路径、代际与控制，不是宿主上任意不可信代码的安全沙箱。托管 Bili 协议本身亦需单独供应；安装 Bili *运行端插件* 不提供或证明其上游登录。公开渠道、设备 ABI 和真机首次下载验收另计。

本地命令：

```text
node --test test/android-installed-host.test.mjs test/android-binding-host.test.mjs test/android-bili-host.test.mjs test/android-verified-attach.test.mjs test/binding-supervisor.test.mjs
node scripts/verify-multi-platform-bot.mjs <.tmp 中已有的运行端 node_modules> qq installed-host
node scripts/verify-multi-platform-bot.mjs <同一依赖目录> bilibili installed-host
```

前两种单平台整链验收实际构建并单独安装 core+选定平台，通过 Android 启动器定位真实已安装代码，在受限本机夹具上验证身份并产生一次得到确认的回复。三实例隔离测试另用极小的响应进程验证代码选择、删除私有目录和兄弟存活；不是三台真实设备或三个真实账号，也不是整套 Android UI/设备验收。
