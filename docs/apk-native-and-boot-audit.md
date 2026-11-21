# ARM64 洁净候选实跑与 APK 原生组件发布门

**2026-11-20，本地审核。** 新环境 + 单独安装的核心和平台插件已实际启动健康端点；这不等于 APK 可发布。旧公开根文件系统另见 [release-audit.md](./release-audit.md)，本测试未执行旧包。

## 实际启动了什么

输入仅为 `bot-release-v1.1.0-rc.1-reviewed` 的最终审核档。先核验索引 SHA-256 `bad926f27dfc2f81dd1d55ebe41c53936f3ff4280bb3a6b290ee742cea180163`，再核对其 catalog 散列 `80931041c1360a41d91e17fea3354091ae9af340b1cc299fc21e372c1fe24a33` 和 USTAR 环境散列 `94a60323ac4eb085a2c398bf27f7afa3bf15334918f4d7aa2ad64bea44c3156c`；每份模块 ZIP 的 SHA 必须出现在此 catalog。将无冲突的 payload 文件置入 `/opt/whale/instance-app`。本次没有执行安卓下载器或 Java 安装器。

| 组合 | 独立输入与结果 |
|---|---|
| core + QQ，未安装 Bilibili 插件 | 339 个模块文件；全新数据目录。ARM64 `/usr/bin/node /opt/whale/instance-app/src/server.js`，`GET /healthz`（3210）HTTP 200；SIGTERM 后 exit 0。 |
| core + Bilibili，未安装 QQ 插件 | 340 个模块文件；无专属端点的反例启动失败（exit 1）。使用合成 UID、专属空目录、一次性随机测试令牌及不连接平台的 loopback 端点，`GET /healthz`（3221）HTTP 200；SIGTERM 后 exit 0。 |

每次在 WSL Debian 独立 user/mount/PID/network namespace 及新 chroot 内使用 `qemu-aarch64-static`；私有网络中只有 loopback、没有默认路由。未读取宿主配置或账户、未挂载手机文件，未访问真实 QQ/B 站，不输出日志正文或测试令牌。**结果只证明真实 ARM64 服务在空实例中启动并响应，不证明安卓 PRoot、平台连接、登录、私信或插件各项业务。**

## APK 原生组件：来源固定，不等于已履约

直接静态检查本地 `android/out-ui/whale-onebot-debug.apk`（SHA-256 `f6f7a47dee077277cee97aa8d68715be345271b837d317d554834f163f5cfe34`），按 ELF magic 枚举而不只按扩展名；全部 9 个 ELF 与下列 6 个 Termux aarch64 deb 成员逐字节匹配。包内未见路径名含 license/notice 的项目。此 APK 是核对样本，不假定为最终签名包；签名后仍应再检查。

| Termux 包和版本 | APK 内用途 | 再分发材料 |
|---|---|---|
| BusyBox 1.38.0-1 | busybox 启动器及库 | GPLv2；上游源码、Termux 配置、补丁、完整许可与作者名单 |
| PRoot 5.1.107.102 | proot、loader 和 loader32 | GPLv2 配方；Termux 自身的 proot 分支，不能以普通上游 PRoot 版本替代 |
| libtalloc 2.5.0 | libtalloc.so.2 | 包配方声明 GPL-3.0，不能据此推断每个文件都同许可；以上游 LICENSE 及各文件声明为准，保留源码 |
| libandroid-shmem 0.7 / PCRE2 10.49 | 各一份共享库 | BSD 系条件与附加声明见两份上游许可，随二进制保留版权及免责条款 |
| libandroid-selinux 14.0.0.11-1 | libandroid-selinux.so | Android 公共领域标识与上游 LICENSE 一并保留；Termux 自带 Makefile、头及补丁，不可用版本号代替 |

**核验链**：由 [Termux 钥匙库及配方的固定提交](https://github.com/termux/termux-packages/tree/97384dfd9479730d4d6b023295c62a2a8263f4b6/packages)取公开 autobuild key，使用 `sqv` 验证 InRelease 签名 `CC72CF8BA7DBFA0182877D045A897D96E57CF20C`。原始镜像索引因镜像时差与签名不一致，已弃用；重取的 Packages.bz2、Packages.gz 及其解压字节均符合签名内 SHA-256。核验的 aarch64 Packages SHA-256 为 `4a886c8ca9263dae0fef5d8a43c4e2604dbbfd54569a0d9a1824f2037bb69cf0`，包含全部 6 个 deb 的 SHA。5 份上游归档各自通过 recipe 固定 SHA-256；SELinux recipe 不提供归档散列，改以 [AOSP commit 1cbcdf6](https://android.googlesource.com/platform/external/selinux/+/1cbcdf624c248c66cd6153311d3e681ba1f9ff2a/libselinux) 固定并保存 libselinux 子树。190 个构建框架、补丁、配置与 recipe 文件逐个按固定 Git blob 验证。

本地原生源码材料 `.tmp/apk-native-audit/apk-native-source-materials.tar.gz`，**7,324,132 B**，SHA-256 `cbf74227fd5a303efa61829f8231587f71910eceed331f37466864f33f327a86`。含上游材料、版本清单、recipe、构建脚本、签名索引与通知文本；不含 APK、设备文件、账号或签名秘钥。预备随 APK 嵌入的通知见 `.tmp/apk-native-audit/native-notices/`。

**正式发布条件：** 在最终签名 APK 内复核全部原生字节与通知（包括每个组件的有效版权声明、许可、免责条款、源码获取说明），让源码材料与二进制同等可获取；把每个构建版本映射到能证实的历史配方、选项、补丁及所有必要依赖，或自行从这些钉住的来源复建并分发新字节。已证明包签名和版本匹配，但没有历史构建证明把每个旧发行二进制逐个绑定到此次取用的 framework 提交；不声称位级可复建，也不将材料包命名为已经无条件满足全部第三方许可的证明。该材料只覆盖 APK 这 9 个 ELF，不替代 Debian、Node/npm、应用源码或其他资产自己的审查。未改动远端。
