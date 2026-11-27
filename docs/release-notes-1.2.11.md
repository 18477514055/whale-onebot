# Whale OneBot v1.2.11 更新说明

> **版本**：`1.2.11`（`versionCode 12012`）｜**内置核心本版无改动**，仍为 `bot-core-1.2.10.zip`
> **这一版只修一件事**：1.2.10 引入的账号身份回归 —— 一重启就刷码、扫码成功后容器 3 秒自杀。

---

## 一、现象：扫码明明成功，QQ 里却看不到「Linux 在线」

真机实测时间线（logcat 与 `bot.log` 对齐）：

```
02:29:12Z  qr-ready bytes=601          出码
02:29:40Z  scanned                     他扫的这张，腾讯侧已收下
10:29:43   BOT: exit rc=1              3 秒后容器进程自己退出
10:29:52   BOT: started                8 秒后自动重启
02:29:53Z  no saved quick-login entry -> qr
           ↑ 重启把这次扫码丢掉了，回到出码态
```

同时 `bot.json` 一直是 `phase=qr-ready / uin=null / uid=null`，`identity.json` 停在旧档 —— **登录从未完成**。

## 二、根因：随包释放的「脱敏占位账号」把真机账号覆盖了

1. 仓库里的 `src/config/account.mjs` 是**脱敏占位版**：
   ```js
   export const BOT_UIN   = process.env.QQ_BOT_UIN   ?? '10000';
   export const OWNER_UIN = process.env.QQ_OWNER_UIN ?? '10001';
   ```
2. 1.2.10 起 `build.ps1` 把整棵 `src/`（51 个 `.mjs`）打进 `assets/qq-protocol/`，`ContainerService` 在容器启动时释放到 `/qq-onebot/src/` —— **包括这份占位 `account.mjs`**，而它**没有传** `QQ_BOT_UIN` / `QQ_OWNER_UIN`。
3. `container-bot.mjs` / `container-login.mjs` 顶层 `await import('/qq-onebot/src/config/account.mjs')`，拿到 `'10000'` 就短路返回（根本没走到 `identity.json` 里的真实号），而且 **ESM 模块缓存被冻结**，后面再想改也改不动。
4. 于是两处一起坏：
   - **快登**：`login list size=1` 里只有一个真实号，拿 `'10000'` 去比 ⇒ 永远不匹配 ⇒ `no saved quick-login entry -> qr`（**每次重启都刷码**）；
   - **扫码**：用户扫的是真实号，`String(value?.uin) !== BOT_UIN` 命中 ⇒ `FATAL phase=unexpected-login-identity` ⇒ `exit rc=1`（**扫了也白扫**）。

## 三、修法（5 个文件）

| 文件 | 改了什么 |
|---|---|
| `android/container-watchdog.mjs` | 新增纯函数 `resolveContainerAccount` / `applyResolvedAccountToEnv` / `pickQuickLoginEntry` / `isAcceptableLoginIdentity`：**用文本解析**读 `account.mjs`（不 import，避免冻结 ESM 缓存），忽略 `'10000'` / `'10001'` / `'u_placeholder'` 占位符，按 **env → 非占位 account.mjs → `identity.json` + `/agent/data/config.json` 的 `admin.ownerUin`** 解析，并在动态 import 协议层模块之前注入 `process.env` |
| `android/container-bot.mjs` | 移除顶层 `import account.mjs`，改用统一解析；快登按解析出的号匹配（首次无绑定号时按「唯一非主号」自动选定并回填）；扫码成功后走 `isAcceptableLoginIdentity` 校验（**任何时刻禁止登录主号**，首次扫码且非主号允许绑定） |
| `android/container-login.mjs` | 同上，复用 `resolveContainerAccount` + `pickQuickLoginEntry` |
| `android/app/src/com/whaleonebot/ContainerService.java` | `extractAssetTree` 遇到**已存在且不含占位符**的 `qq-protocol/config/account.mjs` 时**跳过覆盖** —— 容器里已有的真实账号不会再被包内占位符刷掉 |
| `test/container-watchdog.test.mjs` | 新增第 5 项单测：占位符不屏蔽真实号、主号防误登、首次扫码放行 |

**没有改动内置核心**（P14：各部件独立版本号，本版核心源码零改动，索引里 `components.core` 最新条目仍是 1.2.10）。

## 四、验证

**本地**
- `android/container-{bot,login,watchdog}.mjs` `node --check` 全过；
- `node test/container-watchdog.test.mjs` → **5/5 PASS**（新增第 5 项即本节根因的回归测试）；
- `node scripts/run-java-logic-tests.mjs` → **exit=0，13 套全绿**；
- `javac --release 8` 全量 `exit=0`。

**真机（100.122.52.103:37339，Redmi Note 12 Turbo / marble）**
热修三个容器脚本后 `/botstop` → `/botstart`：
- **免扫码快登一次通过**：`expected=<BOT_UIN>` → `quick-login accepted` → `phase=agent-running`；
- `stickers.json` 启动自动从 **293 MB → 1 644 965 B（≈1.57 MiB）**（1.2.10 的迁出逻辑首次真正跑起来）；
- `CONSOLE_READY after=+40s`（原 `+484s`）；
- `console /api/chats` 200（310 ms）；agent `VmRSS = 132 992 kB`（≈130 MiB，原 1.39 GB）；
- `get_protocol_readiness` 36 ms 返回 `supportedCount: 116`。

## 五、产物与校验

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `whale-onebot-1.2.11.apk`（`com.whaleonebot`，12012/1.2.11） | 109 880 964 | `f28b6f949025093fd9dc8caaa39ef7bfdfee0450ca50fb54a8221a3403c053c0` |
| `release-index.json` | 13 981 | `c98cc8b04b73a0aaac1444c8558cb6646b3fde2da37f8eda3f9b184d1c4c409d` |
| `SHA256SUMS` | — | 上面各项的校验和 |

本机三包（未上传）：debug `47a37a63…` 109 922 117 · beta `397b24f2…` 109 880 964。
**校验链自检**：pin 无 BOM → url 指本版 → `pin.sha256 == 索引字节哈希` → `current: 1.2.11` → `releases[]` 与 1.2.10 深相等（老 App 不受影响）→ core 字节与 sha 一致（仍 1.2.10）→ `manifest.sha256` 一致 → manifest 内 350 个文件哈希全对 → SHA256SUMS 全对 → 滚动指针 `sequence = 4` 指向本版。
另核对 APK 内 `assets/qq-protocol/` 51 个文件、`assets/bridge/` 5 个、`assets/container-watchdog.mjs` 均在包。

## 六、升级注意

- **升级不会丢登录态**：本版修的就是「容器里已有真实账号被占位符覆盖」，升级后 `ContainerService` 不会再用占位符刷掉它。
- 已经装 1.2.10 的设备，升级到 1.2.11 后**第一次启动可能仍需扫码一次**（因为在 1.2.10 上登录态已被这次回归清掉，`identity.json` 仍是旧的）；扫码成功后不会再被 `unexpected-login-identity` 踢。
- 设备上已手工热修过三个容器脚本的，本版内容与热修一致，覆盖无副作用。

## 七、没验证什么（如实）

- 干净机端到端（首次装 → 起容器 → 装 QQ → 扫码 → 进群）仍未跑；
- 「主号防误登」在真机上没有反例可造（只有单号环境），仅单测覆盖；
- 语音/视频、抖音平台在本版未回归。
