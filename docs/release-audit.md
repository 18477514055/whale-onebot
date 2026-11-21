# v1.0.1 公共 rootfs：禁止作为新版公共环境复用

**结论（2026-11-20）：必须从干净上游重建。** 命中 QQ 安装树与原生 wrapper；当前未证实有再分发授权。旧包既不能成为公共下载目录的候选，也不应当作母盘删减后发布。本结论针对 rootfs，不涵盖同版 APK。

## 锁定的发布物

[GitHub 官方 release API](https://api.github.com/repos/18477514055/whale-onebot/releases/tags/v1.0.1)：`rootfs.tar.gz`，asset ID `768332216`，大小 **1,236,176,468** 字节；API `digest` 与本机同尺寸副本的 `Get-FileHash -Algorithm SHA256` 均为 `2df2ccb1a844b265f6e382266459b677a7ea3cf346bf6e339fe2db61cebd67f4`。这是字节身份匹配，不是许可或安全签名。

## 静态证据

从匹配的本地文件用 Python `tarfile` 流式遍历 23,106 个外层成员，其中 18,965 个普通文件；未解包到文件系统、未执行任何载荷。以下为非空普通文件的类别命中，大小写不敏感；类别可重叠。未访问手机备份或桌面密钥，未打印账户、配置值、文件正文或消息，未更改远端。

| 类别 | 观察 | 对决策的意义 |
|---|---:|---|
| QQ 安装目录 / 原生 wrapper | `opt/QQ/` 下 1,536 个；整个包内 `wrapper.node` 1 个 | [同 tag 第三方声明](https://github.com/18477514055/whale-onebot/blob/v1.0.1/THIRD_PARTY_NOTICES.md) 将官方 Linux 样本与 wrapper 描述为实验用、不作分发。源码 MIT 不授予厂商二进制许可。 |
| Linux/Node | dpkg status 1、发行版包 copyright 333、`bin/node` 1 | 许可证文件存在不等于已履约；未找到标准 `.dsc` 或 SBOM 文件名，未建立整套二进制→源码版本→履约材料映射。另行托管的源码或非标准命名不在此结论内。 |
| 状态与日志 | 系统日志 7（其中包管理/安装类 6）；非空 root 家目录文件 2；挂载区文件 1；数据库扩展名文件 1 | 不推断为私信或凭证；不需要读取这些正文即可判定它不是经过白名单筛选的公共基线。 |
| 凭据常见位置 | 未命中非空常见 SSH 私钥名、浏览器 cookie 库、`.env`、私钥容器扩展名、标准 QQ 消息库名、`nt_data`/`nt_db` 数据树或 `/agent/data/` 文件；系统 shadow 存在，定向布尔检查未见密码校验值 | **未证实泄露，也未证明没有敏感信息。** 检查不是全内容密钥扫描；不打开消息或用户数据库。外层有 344 个归档/包扩展名文件，未递归审计。 |

## 处置

1. 当前下载入口若仍公开，由有权维护者单独决定是否暂停、撤回、纠正声明或联系权利人；本次仅报告，未下架、未发布或上传任何东西。若后续在授权的私密排查中确认有可复用凭据，再按类别撤销/轮换，勿在公开报告中列值。
2. 新公共环境从固定版本、可核验的上游 Linux ARM64 与 Node 输入构建；排除 QQ 客户端、wrapper、账号目录、日志、开发者家目录及缓存。需要 QQ 的平台功能与公共环境分别获取、分别审查。不得把旧资产换名或仅补免责声明。
3. 新资产上线前独立校验散列、清单、每个依赖的许可证/对应源码提供方式，检查数据卫生并做隔离启动验证。环境基线通过不等于平台登录、插件或手机端验收通过。

## 新候选实建（与旧包无字节继承关系）

本地已从 Debian bookworm 12.15 的 ARM64 官方发行包重新组合**最小 Debian 层**，不是对旧 rootfs 的清理。以 Debian archive keyring 使用 `sqv --cleartext` 验证 InRelease（3 个有效签名；SHA-256 `77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa`），再按签名 Release 校验压缩的二进制索引 `2ddb1737692e8c45c53e8d57c0ce4cd21c78c5703b830c3226b1423566a06c00` 和源码索引 `92d11a035571df011f06f28c61cb9825130ef1d92abb2f2e0525e8674dc44af8`。从索引钉住 9 个 deb 的路径、架构、版本与 SHA-256；只选普通文件字节，不运行包管理脚本。46 个结果文件包括 bash、env、sleep、ARM64 动态链接器和共享库、Mozilla 公共 CA、版权文本和出处。未引入用户数据、手机镜像或 QQ 专有组件。

- 输出树 `.tmp/clean-env-candidate/tree/`；树外清单 `.tmp/clean-env-candidate/manifest.json` SHA-256 `a0018f84fea05e5c77161061efc9ae21341b695d1746fed71800afdd3ae85fd2`。清单逐文件，包含源包版本和相应源码散列。
- 本地对应源码包 `.tmp/clean-env-candidate/debian-12.15-arm64-corresponding-source.tar`，147,456,000 字节，SHA-256 `265c294bee19e047b5d23e13738f0e927ba57b26495a35d3cc04f99264451048`。含已验证的 20 个 Debian 源码材料（含 `.dsc`、上游包和 Debian 修订）、索引、签名、清单及构建脚本；上线时应与二进制同等可达。仅覆盖 Debian 层，不替代 Node 或 npm 组件的源与许可材料。
- 使用宿主 QEMU user-mode、`-L` 指向新树，实际运行新 bash、env（GNU coreutils 9.1）、sleep 0、独立官方 ARM64 Node（v24.20.0），均成功退出。**没有运行旧包里的任何内容。** 此为基础 ABI 冒烟，不是 chroot、Android PRoot、插件、账号登录或真机部署验收。
- 新 Debian 层可用于后续受控合包；最终 USTAR、Node/npm/应用依赖、产物散列、手机安装及发布操作各须另外验收。本工作没有发布远端资产，也没有把新的候选标作已公开可下载。
