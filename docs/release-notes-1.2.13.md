# Whale OneBot v1.2.13 更新说明

> **版本**：`1.2.13`（`versionCode 12014`）｜**内置核心本版无改动**，仍为 `bot-core-1.2.10.zip`
> **这一版只修一个卡死点**：1.2.12 的一键部署向导在真机上仍然失败 —— `核心下载未完成：Missing field: file`。

---

## 一、现象（真机实测）

测试机（Mi MIX 2S）装 `1.2.12 / 12013`，进「一键部署向导」第 2 步点「一键下载推荐核心」：

```
核心下载未完成：Missing field: file
```

⇒ 1.2.12 修掉了 `Unsupported release index`（v2 索引能读了），但**下载这一步**紧接着又炸。

## 二、根因：`components.environment[]` 少了 `file` 字段

索引里环境包那一条只有 `url` / `sha256` / `bytes` / `format` / `version`，**没有 `file`**；而 `CoreInstaller.env()` 里是硬取：

```java
Map<String, Object> e = obj(r.get("environment"));
String url = str(e, "url"), file = str(e, "file");   // ← 这里抛 Missing field: file
```

`str()` 对缺失字段直接 `require(v instanceof String, "Missing field: " + k)` ⇒ 还没开始下载就抛了。

另外 `ComponentIndex.addAll()` 对缺省 `file` 填空串，会让 `ComponentFetcher.target()` 指向**目录本身**而不是文件 —— 同一个缺失字段在两个地方各自炸一次。

**为什么 1.2.10 时代没炸**：那时走的是 `releases[].environment`（那里有 `file`）；1.2.12 起改成优先读 `components.environment[]`（那里没有），于是把生成器的疏漏暴露出来。

## 三、修法（两侧都补）

| 文件 | 改了什么 |
|---|---|
| `scripts/component-index.mjs` | 生成 `components.environment[]` 时**补 `file`**（取 `e.file`，缺失则从 `url` 末段推导），不再输出缺字段的条目 |
| `install/CoreInstaller.java` | `env()` 在 `file == null` 时按**已通过 `ReleaseCache.origin(url)` 校验的** URL 末段推导文件名；`file` 显式存在但不是字符串仍然报错。原有的 `url.endsWith("/" + file)` 与 `whale-environment-arm64-*.tar.gz` 正则校验一条不减 |
| `install/ComponentIndex.java` | 新增 `deriveFileName()`：缺 `file` 时从 URL 安全推导（剥 `?query` / `#fragment`，拒绝 `.` / `..` / 含反斜杠），避免 `ComponentFetcher` 把目录当文件 |
| `test/java/ComponentIndexTest.java` | 26 checks（补「v2 无 `environment.file` 时能推导出正确文件名」） |
| `android/tests/CoreInstallerTest.java` / `test/test_android_core_installer.py` | 补 v2 无 `environment.file` 的回环回归；夹具模块列表收敛为 `core/qq/bilibili`；`CoreInstallerTest` 传 `MirrorFetch` 并兼容镜像回退前缀 |

**索引侧**：本版 `components.environment[]` 的 **8 条全部补齐 `file`**（`whale-environment-arm64-*.tar.gz`），索引从 13 981 B 变 14 476 B。`releases[]` 一个字节没动（旧 App 兼容，`component-index.mjs check` 通过）。

## 四、验证

**本地**
- `node --check scripts/component-index.mjs` 0 错；`node scripts/component-index.mjs check --file <本版索引> --v1 <上一版>` → **通过（`releases[]` 与旧索引深相等）**；
- `node scripts/run-java-logic-tests.mjs` → **exit=0，13 套全绿**，`ComponentIndexTest: 26 checks PASS`；
- `python test/test_android_core_installer.py` → **PASS**：v1 与 v2 索引都能完成「pin 校验 → 下载 → 解包 → 三实例隔离 → 缓存重开 → 回滚 → 插件单独升级 → 篡改拒绝」全链；
- `javac --release 8`（`android/app/src` 155 文件）**exit=0**；
- 三包 badging 正确；APK 内 `assets/qq-protocol/` 51 文件、`assets/bridge/` 5 文件、pin 指本版索引。

**校验链**：pin 无 BOM → url 指本版 → `pin.sha256 == 索引字节` → `current == components.core[0]` → `releases[]` 与 1.2.12 深相等 → `components{}` 除 `environment[].file` 外无变化 → core 字节/sha 一致 → `manifest.sha256` 一致 → manifest 内 **350 个文件哈希全对** → SHA256SUMS 全对 → 滚动指针 `sequence = 6`。

## 五、产物与校验

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `whale-onebot-1.2.13.apk`（`com.whaleonebot`，12014/1.2.13） | 109 885 060 | `183bd99c273239df87dbd988cfc35907253e8fbec89db10650c1060c063eed31` |
| `release-index.json` | 14 476 | `75e59971b4fd4f64ffc2a0986ad0c6156567b7b1e14bff2175c11e35e5970cd7` |
| `SHA256SUMS` | — | 上面两项的校验和 |

本机三包（未上传）：debug `95e59791…` · beta `c9520def…`。

## 六、没验证什么（如实）

- **1.2.13 整包没有装机**：本版修的正是真机上暴露的问题，但装包/点向导这一轮没做（上一轮 1.2.12 的真机验收是另一个会话做的，机器是 Mi MIX 2S，不是那台只许 debug 的 Note 12 Turbo）；
- 「一键下载推荐核心」**在真机上仍然没有一次完整成功过** —— 回环层面（v1/v2 两套索引）已跑通下载与安装全链，真机 UI 侧待验；
- 干净机端到端（首次装 → 起容器 → 装 QQ → 扫码 → 进群）仍未跑通；（★ 2026-11-27 已由作者在全新手机上跑通，此条结案）
- 语音/视频、抖音平台本版未回归。
