# 内置机器人模块：构建、挑选和本地安装（ABI 1）

给机器人绑定一个平台，需要分清两边：**机器人侧**由 `core` + 所选平台插件组成；**协议侧**另行提供 OneBot 服务。`qq`、`bilibili`、`douyin` 是平级的机器人侧插件，不包含协议服务、账号授权、平台二进制或登录材料。装 B 站不装 QQ。使用自定义机器人运行端时，这几个内置包都不是前置条件。

## 本地试用（PowerShell；Python 3.12+）

在仓库根目录执行。输出目录必须尚不存在。使用一次性、仅当前用户可写的目录；不要指向已有运行端或手机目录。

```powershell
$work = Join-Path .tmp ([guid]::NewGuid().ToString())
$build = python -B scripts/bot-modules.py build --version 1.0.0 --module-version bilibili=1.1.0 --out "$work/cache" | ConvertFrom-Json
$common = @('--store', "$work/bots", '--catalog', $build.catalog, '--pin', $build.pin)
python -B scripts/bot-modules.py install @common --bot a                       # 只装主体
python -B scripts/bot-modules.py plan    @common --bot a --platform qq         # 只缺 QQ；返回文件、字节数、sha256
python -B scripts/bot-modules.py install @common --bot a --platform qq
python -B scripts/bot-modules.py install @common --bot b --platform bilibili   # B 有主体和 B 站、没有 QQ
python -B scripts/bot-modules.py install @common --bot a --platform qq --platform bilibili  # A 只增装 B 站
python -B scripts/bot-modules.py plan --store "$work/bots" --bot c --runtime custom --platform qq
```

`build --module core` 可以只构建主体；`--module` 可重复，默认构建三个独立 ZIP，不是一个合包。`--module-version id=version` 允许一个可信目录给主体和两个插件指定不同版本。主体与插件的兼容条件为 ABI（本版为 1），不是三个版本号相等。`plan` 不创建目录也不执行代码；`downloads` 列出需获取的精确文件，`downloadBytes` 给出总大小。`install` 从本地缓存取包，**不联网**，没有安装钩子、shell 或 npm 生命周期。已装模块会复核本机内容，不需要重新下载原 ZIP。

## 目录、信任与失败行为

- 构建缓存：`catalog.json` 和 `bot-{core,qq,bilibili,douyin}-VERSION.zip`。SHA-256 信任链：**独立可信的 catalog 字节摘要** → 模块 id/版本/种类/ABI/文件名/字节数/ZIP 摘要及 manifest 摘要 → manifest 内每一个文件的 SHA-256。示例中信任刚刚本地构建的结果；真正分发时从随宿主发布的固定摘要或经签名验证的元数据取得 `--pin`，**不能信任同一下载源发来的裸摘要**。无内置远端 URL、公钥、发布或版本自动更新。
- ZIP 结构只有 `manifest.json` 和 `payload/<相对 agent-app 路径>`；清单和 ZIP 文件集合必须完全匹配，禁用路径逃逸、重复条目、连接、跨插件路径、二进制及超限解包。`core` 不打包 `src/platform-modules/`；插件只拥有 `src/platform-modules/<id>/`。不包含 rootfs、Node、node_modules、图片二进制、用户数据/配置、源仓库工具或独立协议适配器。保留上游 MIT 和致谢文本。引擎/UI/角色/技能是既有产品源码，不是新造的示例机器人；历史 QQ 命名及部分内嵌功能仍在共用引擎，不能将本次平台入口分离误读为全部历史代码已平台无关。
- 安装位置：`STORE/<botId>/agent-app/`，每个机器人有独立可见的插件目录。主体回执为其根目录的 `.bot-module.json`，插件为 `src/platform-modules/<id>/.bot-module.json`；同目录 `.bot-manifest.json` 保存复核文件清单。回执是 catalog 的对应条目，不是独立信任根，更不证明服务已登录。一个只需要只读展示的 Android 页面可查私有 `module-downloads/catalog.json` 及 `bot-runtimes/<botId>/agent-app` 回执；这不是可执行的下载 API。
- 先验证全部缺少的包，再在同一文件系统的临时目录写文件。首次安装整体目录重命名；增装按插件目录逐个重命名，不替换主体或其他插件。增装期间若中断，可重新执行 plan/install：已完成的目录会重新验证。调用方应串行操作同一 bot，且存储目录不能由不可信其他进程写入。不会在原位置覆盖不同版本、修补被改动的文件、接管旧安装或删除未选择的插件；升级/回退应准备独立版本目录并由宿主确认后切换，本工具不切换正在运行的版本。

## 验证范围

`python -B test/test_bot_modules.py` 使用临时目录和实际 Node 导入器验证：只打 core；core-only 确实不能加载任何平台；机器人 A 装 QQ、B 单独装 B 站；拿走缓存里的主体与 QQ 压缩包后为 A 增装 B 站；校验既有文件字节和修改时间、B 的模块集、自定义运行端零安装、拒绝损坏或不受信任的内容。Node 需要支持 `require(ESM)`（上游要求 Node ≥22.19）。

这是**源码分发和本地选择**，不代替已有 Node 依赖、外部配置、帐号凭据、协议服务或手机运行管理。测试不连手机、不重新安装 APK、不下载、不推送、不登录真实帐号。历史整包脚本仍用于旧版维护，不应作为新的按需插件安装器。
