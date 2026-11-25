## 这一版是什么（1.1.8 · 预览）

**这是给愿意帮我们踩坑的用户试的预览版**：`prerelease`，`versionCode 11800`。
装之前请确认手机上没有把机器人数据放在别的 App 里 —— 覆盖安装会保留数据，卸载则会清空。

## 这一版修了什么

### 1. 修「点启动容器什么都不发生」（1.1.7 的致命回归）

在一台装过内置核心的机器上，1.1.7 **起不来容器**，日志只有一句：

```
proot error: '/bin/bash' not found (root = .../files/rootfs, cwd = /, $PATH=(null))
LOGIN: exit rc=1
```

根因是**两套判据**：准备环境那段判断「环境是否就绪」时会去扫 `files/core-environments/*/rootfs`，
而起容器的代码**只认 `files/rootfs`**。装过核心的机器上前者存在、后者是空的，于是上层说"已就绪"、下面找不到 `bash`。

现在两边统一只认 `files/rootfs`；若该目录存在但不可用（空骨架、上次铺到一半被打断），
会先挪成 `rootfs.broken-<时间戳>` 留证再重新铺。

### 2. 环境铺好之后会把内置核心也装上

上一版把环境铺好了，但**没有把机器人本体装进去** —— 客户端能扫码登录，启动页却写
「缺少支持多绑定的内置运行端」，进群也没人回。现在铺完环境会检查
`rootfs/input/agent-app/src/binding-supervisor.mjs`，缺就从 APK 内置的 `core.zip` 释放源码
（**跳过 `data/` 与 `config.json`**，不动用户数据）。

### 3. 换环境不再要你重装 QQ

以前每次更新环境都得重新下载/安装 QQ：客户端装在**环境目录里面**（`<rootfs>/opt/QQ`），环境一换它就跟着没。
现在换环境前会把 `opt/QQ` 挪到临时位置（同分区移动，不复制那 1.2 GB），铺完再挪回来。

### 4. 首页「点知道了」不再文字叠印

指引卡收起时整页重建，但旧的那一列没被移除，两层界面叠着画。现在重建前会先清空。

### 5. 启动页不再自相矛盾

本机 QQ 已登录时，绑定卡片不再显示「待登录」。

### 6. 技术债根治（看不见但影响稳定性）

- **`loader.node` 去掉硬编码绝对路径**：以前它把编译机的 `/mnt/d/qq-onebot/...` 写进 `DT_NEEDED`，
  靠"在容器里伪造一个同名目录"绕过去（违反 P3）。现在用 `dladdr` 从自身同目录加载，且支持 `WHALE_NODE_HOST_LIB` 覆盖；
  APK 里也不再创建那个伪造目录。
- **原生黑框弹窗清零**：大批系统 `AlertDialog` 换成 App 自己的主题底部面板（窄屏不溢出、跟随深浅色）。
- **核心与环境换新 pin**：`core-release-pin.json` → 本 Release 的 `release-index.json`（`169c1e3f…`），
  环境包与核心都是这一批同步产出的。

## 资产（14 个）

| 类别 | 文件 |
|---|---|
| 软件本体 | `whale-onebot-1.1.8.apk`（release 签名、无 `debuggable`、`11800`） |
| 环境包 | `whale-environment-arm64-1.1.8.tar.gz` |
| 核心与插件 | `bot-core-1.1.8.zip`、`bot-qq-1.1.8.zip`、`bot-bilibili-1.1.8.zip` |
| 索引与校验 | `release-index.json`、`catalog.json`、`core-release-pin.json`、`SHA256SUMS` |
| 合规材料 | `debian-arm64-corresponding-source.tar`、`aosp-libsepol.tar.gz`、`apk-native-source-materials.tar.gz`、`apk-native-historical-build-sources.tar.gz`、`apk-native-build-tool-notices-and-patches.tar.gz` |

QQ 客户端（arm64 `linuxqq` deb）**不随包分发**，请自行取得后放进手机「下载」目录，
在「设置 → 环境配置 → 第 3 步」扫描安装。

## 已验证范围（据实）

- ✅ 主力机（Redmi K70 Ultra，**装过内置核心**那台）：覆盖安装后**点「启动容器」跑通**，环境自动铺开、容器起得来 —— 这是 1.1.7 完全做不到的机器。
- ✅ 首页排版：修复后真机截图为证，四张平台卡片正常、指引卡收起、无文字压印。
- ✅ 构建自检：`aapt` 读出的包名/版本 = `com.whaleonebot` / `11800` / `1.1.8`，无 `debuggable`；`SHA256SUMS` 与本目录 14 个资产**逐一校验通过**。
- ✅ `loader.node`：二进制内已搜不到 `/mnt/` 字样。

## 已知未验（请重点帮我们试这些）

1. **彻底干净的手机**：首次安装 → 点启动容器 → 装 QQ → 扫码 → 进群聊天，还没端到端走完一遍。
2. **换环境时把 QQ 挪回原位**：只在代码层成立，没走过"旧环境里已有 QQ → 铺新环境 → 放回"的完整场景。
3. **受管核心点「连接 QQ」拉起本机协议端**：只做过逻辑测试与前台服务验证，未与运行端完整联调。
4. **多账号 / 多机器人隔离**、异机顶替未验。
5. 包体仍约 104 MB（525 个图形库整套带上，未按依赖闭包裁剪）。

## 反馈请带上这些

- 手机型号 + 系统版本 + `versionCode`（设置里能看到 11800）；
- 卡住的**那一步**（启动容器 / 装 QQ / 扫码 / 连接 QQ / 进群不回话）；
- 能用电脑连手机的话：`adb logcat -s WhaleLog WhaleEnv` 的最后 30 行 —— 这是最有用的信息。

## 升级提示

- 从 1.1.7 / 1.1.6 覆盖升级：数据、记忆与知识库都保留，**不需要重装 QQ**。
- debug 包与 release 包签名不同，不能互相覆盖；装过 debug 的机器要先卸载再装正式包。
- 装完若显示「容器已停止」，点一次「启动容器」—— 首次约 1~2 分钟，之后是秒级。
