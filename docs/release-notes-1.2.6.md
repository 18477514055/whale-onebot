# Whale OneBot 1.2.6

> 版本：`versionCode 12007` / `versionName 1.2.6`（上一版 `12006 / 1.2.5`）
> 发布类型：stable（`prerelease=false`）
> 本版只改了一个部件：**外壳（shell-android）**。环境包、核心、插件、后端一个字节没动。

---

## 一、为什么发这一版

2026-11-26 上午 08:30，QQ 安全中心给机器人号发了一条通知：

```
已登录设备风险提醒
风险类型：设备存在外挂或其他软件影响 QQ 正常使用
设备名称：localhost
登录应用：QQ桌面版-Linux
平台已对风险设备进行下线处理
```

不是被踢下线、不是网络问题——**是腾讯按设备指纹判定风险，主动把设备下线了**。

而 `设备名称：localhost` 这一行就是最明显的破绽：那是 Android 内核的默认 hostname，真实 Linux 桌面绝不会叫这个名字。

追查下来，容器暴露给 QQ 的设备特征是这样的：

| 字段 | 之前的值 | 问题 |
|---|---|---|
| `hostname` | `localhost` | ★★★ 直接显示在安全中心里 |
| `uname` 内核串 | `Linux localhost 6.2.1-perf #1 SMP PREEMPT Wed Aug 28 22:16:09 UTC 2024` | ★★ 内核版本是伪造串、日期也不对 |
| `/etc/machine-id` | **不存在** | ★★ 正常 Linux 一定有 |
| 根分区 | `/dev/block/dm-9 erofs` | ★ Android 专有（本版未处理，见「未做」） |

> 顺带纠正一个我先前的误判：`/sys/class/dmi` 在整个目录都不存在——这**不是破绽**。ARM64 Linux（树莓派、Oracle Ampere、AWS Graviton、各类 ARM VPS）本来就没有 DMI，只有 x86 才有。`/proc/cpuinfo` 那几个 `CPU implementer 0x41 / part 0xd46` 也是标准的 ARM64 格式，不用改。

---

## 二、这一版做了什么

### 1) 设备身份伪造 shim（`src/native/device-identity.c` → `libwhale-device.so`）

一个 66 KB 的 AArch64 动态库，用 `LD_PRELOAD` 挂到启动 QQ 的那条 node 命令上，拦截两个调用：

- `gethostname()` —— 返回派生的设备名，不再返回 `localhost`
- `uname()` —— 同时改 `nodename` / `release` / `version`

效果（真机容器内实测，用的就是 ContainerService 的真实启动参数）：

```
改前：host= localhost        release= 6.2.1-perf
改后：host= deb-arm64-2f8eba92  release= 6.1.0-28-arm64

改前 uname -a：Linux localhost 6.2.1-perf #1 SMP PREEMPT Wed Aug 28 22:16:09 UTC 2024 aarch64
改后 uname -a：Linux deb-arm64-2f8eba92 6.1.0-28-arm64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.119-1 (2024-11-22) aarch64
```

**为什么不用假内核参数就够了**：`proot --kernel-release` 只改 `uname.release`，**不改 nodename**；而 `gethostname()` 是 syscall，改 `/etc/hostname` 完全无效（`/proc/sys/kernel/hostname` 还被 SELinux 挡住读不了）。所以只能在这一层拦。

### 2) 每台机器派生自己的设备身份

新增 `ContainerService.ensureDeviceIdentity()`：

- 种子优先取 `Settings.Secure.ANDROID_ID`，拿不到就退回 `Build.FINGERPRINT + Build.SERIAL + 数据目录`
- 用 `SHA-256(salt|seed)` 派生两个值：
  - **设备名** → `deb-arm64-2f8eba92` 这样的 8 位 hex
  - **machine-id** → 32 位 hex，同时写进 `rootfs/etc/machine-id`（程序实际读的路径）
- **同一台手机每次算出来都一样**（否则每次登录都像新设备，更容易被风控）；**不同手机互不相同**（否则多台机器共用一个指纹会被关联）

真机实测落地结果：

```
files/rootfs/opt/whale/device/hostname   → deb-arm64-2f8eba92
files/rootfs/opt/whale/device/machine-id → c2e15916b8cd71eeadeef1a3be9d0d25
files/rootfs/etc/machine-id              → c2e15916b8cd71eeadeef1a3be9d0d25
files/rootfs/opt/whale/native/libwhale-device.so → 67936 B, 0755
```

### 3) 挂载点

- shim 由 `ContainerService` **无条件释放**（放在 `container-login.mjs` 那一组，不在 `if(managedImage)` 里——测试机是 legacy 环境，放受管分支里等于永远不生效）
- 两条启动命令（登录与起机器人）都改成：
  ```
  WHALE_FAKE_HOSTNAME=<派生值> LD_PRELOAD=/opt/whale/native/libwhale-device.so:/usr/lib/aarch64-linux-gnu/libgnutls.so.30
  ```
  shim 排在 gnutls 前面，保证符号优先命中

---

## 三、故意**没做**的两件事

**① 不伪装成安卓手机。** 安全中心写的 `登录应用：QQ桌面版-Linux` 是 **QQ 客户端自己上报**的字段，跟系统指纹无关。把系统指纹做成 Android 手机而客户端仍报 Linux 桌面版，等于亲手制造一处新矛盾——腾讯比对的正是「多通道是否指向同一台设备」。我们跑的是 Linux QQ 的二进制，协议层也改不成安卓客户端。

**② 没处理根分区名。** 实测 `proot -b 假文件:/proc/mounts` **不生效**（procfs 是内核特例，bind 被绕过，读到的仍是 `/dev/block/dm-9 erofs`）。而 QQ 是即时通讯，不枚举磁盘，这个字段优先级最低。真需要的话得上改内核参数或改 proot 源码那个量级，先记为未做。

---

## 四、验证到哪一步

**已验证（真机 `192.168.1.15:37339`）：**
- `src/native/device-identity.c` 交叉编译出 AArch64 `libwhale-device.so`（67 936 B），`readelf` 确认 `Machine: AArch64 / Type: DYN`
- 容器内用**与 ContainerService 完全相同的参数**跑 `node`：`os.hostname()` = `deb-arm64-2f8eba92`、`os.release()` = `6.1.0-28-arm64`；`hostname` / `uname -a` 同步变化
- 装 1.2.6 后重启 App：`device/hostname`、`device/machine-id`、`rootfs/etc/machine-id` 三个文件**都已正确生成**，shim 已释放到 `/opt/whale/native/libwhale-device.so`
- 143 个 Java 文件 `javac --release 8` 零错误

**未验证（需要你扫码那次才能确认）：**
1. **真正的 `container-bot.mjs` / `container-login.mjs` 进程里 shim 是否真的挂上了** —— 目前机器人在 `qr-ready` 等扫码，机器人进程还没起来，所以这一环只能在你扫码启动时才能看到。你扫码后我可以立刻从进程环境变量里核实。
2. **腾讯那边的判定是否因此变化** —— 这要等登录后观察一段时间（会不会再收到风险提醒、会不会再被下线）。**这一版是"降低可疑度"，不是"保证不被判"**。

---

## 五、怎么装

- 已有用户：直接覆盖安装，**不用重下 QQ**（除非你要重扫码）。登录态、知识库、记忆库都在 `files/`，覆盖安装不动它。
- 测试机（Redmi Note 12 Turbo / `marble`）：只装 `whale-onebot-debug-*.apk` 或 `whale-onebot-beta-*.apk`。**release 签名 + `com.whaleonebot` 那一份永远不装这台机器**。
- 本版 `versionCode 12007`，可直接覆盖 1.2.5。

---

## 六、部件版本（P14）

| 部件 | 版本 | 本版是否变化 |
|---|---|---|
| 外壳 App（本 APK） | **1.2.6** | **变** |
| 运行环境（`whale-environment-arm64`） | 1.1.8 | **未变**（改动全在外壳：shim + 派生 + proot 参数，不需要重打 51 MB 环境包） |
| 内置核心 | 1.2.5 | 未变 |
| 协议端胶水（`src/bridge/`） | 1.2.5 | 未变 |
| 插件·QQ / 插件·B站 | 1.1.8 | 未变 |
| 后端·QQ / 后端·B站 / 桌面协议端 | 1.2.0-beta.1 | 未变 |

> P8「每版齐五类」的同一处有意偏离：本版只发 APK，环境包与核心沿用 `v1.2.5` / `v1.2.0` 那两个 Release 里的产物。

---

## 七、回填模板

```
1. 扫码登录后，安全中心里「设备名称」显示什么（应该不再是 localhost）：
2. 有没有再收到「已登录设备风险提醒」：
3. 会不会又被下线（多久一次）：
4. 机器人正常收发有没有受影响：
5. 有报错就贴原文：
```

---

## 八、回滚

本版所有改动都可以整块回退：删掉 `rootfs/opt/whale/device/`、`rootfs/etc/machine-id`、`rootfs/opt/whale/native/libwhale-device.so`，并把两条启动命令的 `WHALE_FAKE_HOSTNAME=... LD_PRELOAD=...` 前缀去掉，就回到 1.2.5 的行为。**不动登录态，不动 QQ 数据。**
