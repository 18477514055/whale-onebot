# Android 内置核心下载与版本管理（D282）

入口：`com.whaleonebot.install.CoreInstaller`。除 `checkAuto(Context)` 外，网络、读档和校验 API 由宿主在后台线程调用。没有下载钩子、npm install、Shell 命令、设备操作或登录调用。

## 已实装的信任链

APK 资产 `core-release-pin.json` 给出**独立可信**的 `{url,sha256}`，而不是使用下载服务器旁边的裸哈希。索引 → 各版本目录 SHA-256 → 模块 ZIP 长度、SHA-256、manifest SHA-256 → 逐文件哈希，以及公共环境 USTAR 压缩包的长度与 SHA-256。初始网络地址只允许 `https://github.com/18477514055/whale-onebot/releases/download/<tag>/<asset>`；仅允许跳转到同仓 Release 链接和 GitHub 正式资产 CDN。禁用自动重定向、镜像、HTTP、本地 URL 和用户指定下载地址；连接/读取有超时，流式计长、求摘要，验证后原子改名。缓存命中也复核哈希。源 ZIP 只接受发布器范围内的普通文件，检查中央目录模式、重复/大小写冲突、路径和插件归属、条目集合及解压上限。

固定 pin **不会发现 APK 发布以后才出现的新索引**。若需独立于 APK 的后续更新，发布者可在可信 APK 资产另放 `channelPublicKey`（Base64 的 X.509/SPKI RSA 公钥，至少 3072 位）及 `minSequence`。固定位置 `releases/download/core-channel-v1/channel.json` 的结构为 `{payload,signature}`，两个字段均为标准 Base64；`payload` 解码后是精确 UTF-8 JSON `{sequence,expires,url,sha256}`，`expires` 为 Unix 秒。专用发布密钥对 payload 原字节做 SHA256withRSA 签名，不使用 APK 签名密钥。程序验证签名、到期、序号不倒退、同序号目标不变，并缓存已验证指针。没有获批的生产公钥时不启用该通道。本次不生成、保存生产私钥，亦不发布通道。

## 文件契约与异常

以下路径均在应用**规范化私有 filesDir** 下。

| 路径 | 用途 |
|---|---|
| `core-release-cache/<sha256>` | 可共享的已校验下载字节。实例维护不删除此缓存。 |
| `core-environments/<sha256>/rootfs` | 按环境版本共享的已校验公共环境。旧版 `filesDir/rootfs` 不接管、不覆盖；多个环境版本可并存。 |
| `core-instances/<id>/active.json` | UUID 槽位 `current`、可选 `previous` 和 `pending`。 |
| `core-instances/<id>/generations/<uuid>/generation.json` | 发行版本、ABI、数据格式、环境摘要和该实例实际安装的平台。 |
| `…/generations/<uuid>/agent-app/` | 独立的主体与所选插件文件；不含用户资料。核心 `.bot-module.json` 和插件 `src/platform-modules/<id>/.bot-module.json` 是实际安装回执。 |

`downloadBytes` 只计算当前确实缺少的下载，数量三份也不乘三。首次创建/增装返回 `平台 → 原因`，主体或环境失败则抛异常，不登记可用实例。相同版本重试在独立临时目录验证、只改名挂入缺少的插件，不重装已有主体或兄弟插件。更新已正常使用的平台如果失败，不用不完整更新替换原树。`pluginVersions/stagePlugin` 可在同 ABI 下独立挑选插件版本。版本切换不替换正在运行的目录。

全局自动更新默认关闭。启用后由 `checkAuto` 在后台取得受信的 `current` 版本并准备 `pending`。`active()` 不切换；**只有全部实例工作进程停止后、正常启动前**由服务调用 `onNormalStart`，复核包括环境回执和模块清单后原子切换。`environmentForApp(files, app)` 从该进程实际持有的 generation 决定 rootfs，而不是猜最新环境。回退同样只预备，拒绝不兼容 ABI/资料格式或平台集合。旧 `whale-1` 不进入本安装器。

`removePlatform`/`reset` 按实例加锁，先准备新文件、写维护日记，再切换指针并提交宿主的绑定/占用事务。回调失败恢复旧指针。若中途进程死亡，宿主从实际注册表判断提交是否成立，调用 `recoverReset`；未恢复前不能新启动或继续写该实例。重置后仅清理本实例旧代，公共环境和缓存保留。`acceptsPortableV1` 验证实际活动核心回执和数据 ABI，供跨兼容版本恢复使用。可写资料隔离、用户备份过滤、运行中停止和占用判断属于宿主事务，不是安装器模拟的行为。

## 可复现验收

仓库根目录：`python -B test/test_android_core_installer.py`。不访问 GitHub；临时环回 HTTP 托管真实模块构建器生成的两组 ZIP、独立签名指针测试及合成的极小 USTAR。运行实际 Java 缓存/模块/公共环境解包/版本切换，验证部分失败、缓存重开、三实例、版本/回退、保留旧环境、文件篡改与恢复。仅 Context 和 Android 日志使用 JVM shim。

另有 `python -B test/test_android_core_installer.py --candidate <本地发布目录>`：按当前 APK pin 验证该候选的**真实**环境、主体与两个插件。此项不验证 ARM 程序运行、系统 TLS、GitHub CDN 或 Android 进程生命周期。生产候选须通过独立来源与隐私审计；干净设备的真实 HTTPS 发布下载仍是一道单独的、需授权的验收。
