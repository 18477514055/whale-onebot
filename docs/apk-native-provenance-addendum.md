# APK 原生组件：历史构建与再分发审查增量（2026-11-20）

**结论：本地材料已达到可以请维护者确认发布的程度；本次没有发布。** 最终候选 APK SHA-256 `c35095c89bc96946231ea4f5556a2c7d20548fbccaeccc83baf1b974fd692159`，不是中间版 `381a…` 或 `f30d…`。ZIP CRC 全通过；按 ELF 魔数枚举为 9 个，与先前逐字节核验的 6 个官方 Termux aarch64 包全相同。包内共 14 项 `assets/licenses/`；核对了上游文本、额外 GPLv3、libsepol LGPLv2.1、组件归属、库替换/重链与源码获取说明。此处复查资产内容和 SHA，不替代 Android 签名验证或手机运行验收。

## 什么证据证明什么

1. **包身份（6/6）**：Termux autobuild key 指纹 `CC72CF8BA7DBFA0182877D045A897D96E57CF20C` 验证 InRelease，受签名保护的 aarch64 Packages SHA-256 `4a886c8ca9263dae0fef5d8a43c4e2604dbbfd54569a0d9a1824f2037bb69cf0`。内含六个 deb 的完整 SHA；逐 deb 与 APK 对照。不是以文件名或 `--version` 推定。
2. **历史源（6/6）**：按包版本、提交历史、PR、打包脚本和 Git blob ID 核对。与最初材料包固定的配方相比，4 个包整个配方目录一致；另 2 个只有一行后加的 Repology 元数据开关，不改变源地址、编译选项、补丁或安装步骤。本次另附原始历史文件，而非建议用户删除一行。控制档的时间只用于定位，不作为构建证明。
3. **构建直接关联（3/6）**：在官方 push 工作流的 Actions 记录中找到 AArch64 checksum ZIP；核对该 ZIP 的 GitHub digest，再核对内文的 deb 名和 SHA，均与签名 APT 索引吻合。区分 SHA 写在 checksum 内和“ZIP 自己的 digest”。另两个能查成功的同版本 AArch64 构建，不能重取证明输出字节的材料；一个仅有准确历史配方和已合并 PR。按六个 deb SHA 查询 GitHub repo 级、org 级 attestation API 均返回 HTTP 404。此结论是“未取得可访问的 attestation”，不是认定未构建、未签包或侵权。

| 包 / 版本 | 版本变更与官方构建证据 | 核验边界 |
|---|---|---|
| PRoot 5.1.107.102 | [提交 b734bc49](https://github.com/termux/termux-packages/commit/b734bc49dc0eedb2c454e1c5d3c48d35d81d4bc9)；[push 构建 41337890212](https://github.com/termux/termux-packages/actions/runs/41337890212)，checksum artifact `13095468410` | 对应签名 deb SHA 命中；覆盖 proot、loader、loader32。源为 Termux 的 PRoot 分支。 |
| PCRE2 10.49 | [提交 82780ef5](https://github.com/termux/termux-packages/commit/82780ef5c32763e3256ac26d07a4be4c40efb044)；[push 构建 36449727171](https://github.com/termux/termux-packages/actions/runs/36449727171)，checksum `10981798281` | 对应签名 deb SHA 命中。 |
| libtalloc 2.5.0 | [变更 bddd9721](https://github.com/termux/termux-packages/commit/bddd9721910e56bc36412a764b4b4f7bbdbb1eb1)，[PR 32194](https://github.com/termux/termux-packages/pull/32194)，[push 构建 36977433293](https://github.com/termux/termux-packages/actions/runs/36977433293) 的提交 `b8a50994`，checksum `11213599974` | 对应签名 deb SHA 命中。不能按配方的 GPL-3.0 总标签取代库源码的 LGPL-3.0-or-later。 |
| BusyBox 1.38.0-1 | [变更 b68a22c1](https://github.com/termux/termux-packages/commit/b68a22c1019dd675efc9e2fbf0c57769c02f6908)，[PR 30268](https://github.com/termux/termux-packages/pull/30268)，[push 构建 27957350978](https://github.com/termux/termux-packages/actions/runs/27957350978) 的提交 `4d95cc70` | AArch64 job 成功；本次列表返回 0 个 artifact、job 日志不可取得，不能将特定 run 的输出与 deb 作额外字节比对。APK 的启动器和库两者均已对签名包。 |
| libandroid-shmem 0.7 | [PR 28001](https://github.com/termux/termux-packages/pull/28001)，[push 构建 20938155094](https://github.com/termux/termux-packages/actions/runs/20938155094) 的提交 `b25e2572` | AArch64 job 成功；同样未取得可比较的历史产物/日志。 |
| libandroid-selinux 14.0.0.11-1 | [重建 PR 25808](https://github.com/termux/termux-packages/pull/25808)，[合并提交 951b902e](https://github.com/termux/termux-packages/commit/951b902e406cd9b556608ae6fce33de479785500) | 合并可证，无法从本次查询恢复这个提交或 PR head 的工作流/check-run。精确 Android 上游输入与实际打包脚本另已核对。 |

## 这轮补上的两个实际问题

- **libtalloc 通知**：`talloc.c`/`.h` 写明 LGPL v3 或以后，版权人为 Andrew Tridgell（2004/2004–2005）、Stefan Metzmacher（2006）。依 [LGPLv3 §4](https://www.gnu.org/licenses/lgpl-3.0.html) 附两份许可文本：最终 APK 的 LGPLv3 与上游相同，GPLv3 与 Debian 规范文本相同；另附明确 PRoot 使用动态库及替换、重签、新安装方法。没有要求提供原作者签名秘钥。
- **静态链接的输入不能漏**：[历史 SELinux Makefile](https://github.com/termux/termux-packages/blob/951b902e406cd9b556608ae6fce33de479785500/packages/libandroid-selinux/Makefile-android#L70-L81) 不只用 public-domain 的 libselinux，还把同源码父目录下的 `libsepol.a` 作为链接器输入。没有 link map，不能根据符号串推断究竟拉入哪些成员。按保守口径，附全部相关源码、libsepol 上游 LGPLv2.1 许可及重链方法。固定 [AOSP commit](https://android.googlesource.com/platform/external/selinux/+/1cbcdf624c248c66cd6153311d3e681ba1f9ff2a/)；对两个下载树逐文件、按模式重建 Git 树对象，libselinux=`680d5b17a37626d49719ee1f644d566e72ee8393`、libsepol=`97804a969b86f12705646ddae0ce2792a0b2b244`，与 AOSP 根树所指相同。两树放入同级目录即可按历史配方选择替换输入。这里没有实际重建，也未将“有同版本源码”说成“已复建成功”。

## 维护者确认清单

下列是 **APK 原生**部分，同一 release 说明须明确标出并以与 APK 同等可达的方式提供。不要只放通往第三方滚动分支的链接。首次对外发布前后，应从无登录环境验证嵌入网址可下载并对照 SHA，避免只有 APK 可见、源码文件缺失；APK、标签、文件名不可错配。

| 随发布材料 | 字节 | SHA-256 |
|---|---:|---|
| `apk-native-source-materials.tar.gz`：六包上游材料、完整库许可与签名索引 | 7,324,132 | `cbf74227fd5a303efa61829f8231587f71910eceed331f37466864f33f327a86` |
| `apk-native-historical-build-sources.tar.gz`：各历史提交的构建脚本/配方/配置/补丁，394 个不同 Git blob | 1,377,061 | `0192176251a3b82272de84974afbb3269cfc090e59b66336c7f768417c6b44b4` |
| `aosp-libsepol.tar.gz`：同 commit 的完整 libsepol 子树 | 519,794 | `1083aeae8f23d5ff25f0c43f05f7b987dd659c8436070e416c4e3dcc6d4e1c5b` |
| `apk-native-build-tool-notices-and-patches.tar.gz`：六历史快照的 Termux 构建框架许可与 NDK 补丁等，44 个不同 blob | 82,323 | `ca5b3a176ffc205b2dc3c7c7f9f9710275614e45348069f5a188c49b5e1ee51e` |

源码与变更材料应保留为可修改和可重新构建的形式。**不把 bit-identical、CI attestation 或旧日志永久可得误作 GPL 的法定前提。** 对没有可下载历史产物的组件，不声称构建已经逐位重现。若组织另行要求更高供应链保证，应在新的隔离构建机，取对应历史 Termux 工具链、NDK、补丁与显式依赖，分别构建六包，重点验证 PRoot 的两套 loader、BusyBox/库分离、libsepol 静态重链；对新字节重新签名、验 APK 原生 ABI 并重新出所有校验。与本次轻量只读审查不同，该路径需新的多架构编译、工具链存储及后续设备测试，工时未实测。当前建议先让维护者看清保留证据并确认是否上传，而非为了历史 CI 缺档强制换掉已认证的二进制。

本报告不替代独立法律意见，不审查非原生资产或手机行为。没有改动 GitHub、没有上传、没有连接设备。发行套件其它组件仍以各自审查结论为准。
