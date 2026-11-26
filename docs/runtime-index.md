# 内置运行端索引（`runtime-index/index.json`）

> 这是「内置机器人」下载运行端时读的清单。**App 通过它决定下载哪一版**，所以我们发新运行端
> 不必重发 APK —— 这正是用户 2026-11-19 说的「我们维护一个索引，和软件主仓库一起提交」。

## 0. 运行包是什么（和 1.2 GB 骨架分开）

| 物 | 内容 | 大小 | 什么时候装 |
|---|---|---|---|
| **Debian 骨架** `rootfs.tar.gz` | 整个容器根文件系统 | ~1.2 GB | 装一次，很少变 |
| **运行包** `runtime-<版本>.zip` | 只含 `input/agent-app/**`（运行端）+ `qq-onebot/src/**`（协议端）+ LICENSE/致谢 + `runtime-package.json` | 几 MB～几十 MB | 每次更新内置机器人 |

运行包**解包到 rootfs 根目录**即可覆盖对应路径。这样「检查更新 → 下载 → 覆盖 → 重启机器人」是几十 MB 的事，
不用让用户每次重下 1.2 GB。

生成：`node scripts/build-runtime-package.mjs --agent <运行端根目录> --version 1.0.1`
（脚本用自写的 store zip 写入器，**条目名一律正斜杠** —— `Compress-Archive` 的反斜杠会让 rootfs 永远不就绪。）

## 1. 契约

索引是纯 JSON，随主仓库一起提交（不做成 release 资产，改一行就能改版本）：

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "version": "1.0.1",
      "url": "https://github.com/<owner>/<repo>/releases/download/v1.0.1/runtime-1.0.1.zip",
      "bytes": 12345678,
      "sha256": "<64 位十六进制>",
      "minApp": 1,
      "notes": "可选，一行"
    }
  ]
}
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `version` | ✅ | 同时是落盘目录名 `files/runtimes/<version>/`（只允许字母数字 `. _ -`） |
| `url` | ✅ | 必须是 http(s)；下载器只认这两种 |
| `bytes` | ✅ | 期望字节数，下载器边下边核对（**不要手抄**，用脚本生成） |
| `sha256` | ✅ | 期望哈希，下完比对；不一致即判失败 |
| `minApp` | ⬜ | App 的 `versionCode` 下限；比它老的 App 跳过这条（默认 1） |
| `notes` | ⬜ | 给人看的一行说明 |

App 端行为（`android/app/src/com/whaleonebot/ui/RuntimeIndex.java`）：

1. 优先级：**设备偏好项 `source_url`**（本机临时指定，测试用） &gt; **索引** &gt; 源码常量；
2. 索引地址：偏好项 `index_url` 优先，其次 `RuntimeCatalog.BUILTIN_INDEX_URL`（发布时填成 raw 地址）；
3. 启动时后台拉一次索引 → 只更新磁盘缓存 `files/runtimes/runtime-index.json`；
   **拉失败不动缓存**（一个坏索引不该让能用的旧缓存失效）；
4. 挑条目：先按 `minApp <= versionCode` 过滤，再取版本号最大的那条；
5. 索引为空/没配地址时退回源码常量 `BUILTIN_URL`；两者都没有 ⇒ 下载页显示「下载源未配置」并且按钮置灰
   （**绝不产生假进度**）。

## 2. 怎么生成 / 更新一条

```powershell
# 算好 bytes + sha256 再写进索引（不会手抄错）
node scripts/build-runtime-index.mjs `
  --file  D:/build/runtime-1.0.1.zip `
  --version 1.0.1 `
  --url   https://github.com/<owner>/<repo>/releases/download/v1.0.1/runtime-1.0.1.zip `
  --min-app 101
```

- 同一个 `version` 再跑一次 = **覆盖**它（幂等）；
- 新 `version` = 追加；
- 写完按版本号倒序（只影响可读性，App 端自己挑最大版本）；
- `--dry-run` 只打印不写文件。

## 3. 发布流程（每次发运行端）

1. 打出运行端包（`.zip`，解包后就是 `files/rootfs` 那一份骨架，**不含任何用户数据/知识库/数据库**）；
2. **盖章**：包内含改造后的上游源码 ⇒ 属再分发，MIT 要求随包保留版权声明与许可全文：

   ```powershell
   node scripts/stamp-runtime-licenses.mjs <运行端包根目录> --check   # 缺了退出码 1
   node scripts/stamp-runtime-licenses.mjs <运行端包根目录> --write   # 写 app/LICENSE + app/THIRD_PARTY_NOTICES.md
   ```

   原件在 `third-party/qq-agent-plus/LICENSE`（上游逐字副本，版权行 `Copyright (c) 2026 Kondius`）。
   脚本会把缺版权行的情况直接判失败，**不要**手工补这几行；
3. 传到 release 资产里（文件名建议 `runtime-<version>.zip`）；
4. 用上面的命令更新 `runtime-index/index.json`；
5. 提交索引（它跟源码同一个仓库，评审可见 diff）；
6. 用户下次打开「内置机器人运行端」页就能看到新版本 —— **不用发新版 App**。

## 4. 现状与已知缺口（别当成已完成）

- ✅ 机制齐了：索引文件、生成脚本、App 端拉取/缓存/挑选逻辑、来源显示（`来源：索引`）。
- ✅ 索引地址已填：`RuntimeCatalog.BUILTIN_INDEX_URL` =
  `https://raw.githubusercontent.com/18477514055/whale-onebot/main/runtime-index/index.json`。
  ⚠ **仓库目前是 private ⇒ 该 raw 地址匿名访问返回 404**（已实测），App 会走「拉不到就不动缓存 +
  退回源码常量」的兜底，所以现在等于没配；把它改成 public（或换成你自己的托管地址）后立即生效。
- ✅ **「下载 → 装进容器」已接上**：`ContainerService.unpackRootfs()` 按顺序找
  ①`files/runtimes/<版本>/` 里下载好的包（`rootfs.tar.gz` / `runtime.tar.gz` / `rootfs.tar` / `runtime.zip`）
  ②`/sdcard/Download/whale/rootfs.tar.gz` ③都没有才报错。
  - **先解到 `rootfs.new`，确认可用（bash / debian_version / 动态加载器 / node 四样齐全）才换上去**：
    旧的改成 `rootfs.old-<时间戳>` 保留一份，换的过程只有两次 rename，中途没有「新坏旧也没了」的窗口。
    只有最近一份旧副本会被保留，更旧的自动清掉。
  - 格式**按文件头判**（`PK` = zip，否则当 tar）：下载器统一存成 `runtime.zip`，但索引里的资产
    完全可能是 `rootfs.tar.gz`，用错解包器会把包解废。
  - zip 走 App 自带 busybox 的 `unzip`（已实测该 applet 存在且能解包）。
  - ⚠ **打包必须用正斜杠**：用 Windows 的 `Compress-Archive` 打出来的 zip，条目名里是反斜杠，
    解包会得到一个叫 `usr\bin\x` 的怪文件而不是目录层级 ⇒ 骨架永远不就绪。
    解包失败时会明确打一行「包内路径用了反斜杠…」。发版请在 Linux 下 `zip -r`，或直接发 `.tar.gz`。
- ⚠ 索引本身不校验来源（没有签名）。要防中间人，只能靠 https + 发布者账号安全；
  真要更强保证，下一步给索引加一个 detached 签名。
- ⚠ 解包阶段只有日志（`tar rc=` / `unzip rc=`），界面上还是「下载进度」；下一版可以把「解包中」也接进界面。

