# 容器内原生组件（运行时依赖，不是本工程原创）

## `vec0-linux-arm64-0.1.9.so`

- 来源：npm 包 `sqlite-vec-linux-arm64@0.1.9` 里的 `vec0.so`（元数据见同目录的 `package.sqlite-vec-linux-arm64.json`，许可 `MIT OR Apache`）。
- 用途：容器（Debian aarch64 / glibc）里 `node:sqlite` 加载它之后，`knowledge-lib` 的 `docs_vec` 才能做 KNN 语义检索。
- 部署位置：容器内 `/agent/data/native/vec0.so`（App 侧 `files/rootfs/agent/data/native/vec0.so`）。

### ★ 三个必须记住的点（都实测过）

1. **文件名必须叫 `vec0.so`**。SQLite 的 `load_extension` 在没有显式入口名时按**文件名**推导符号
   （`vec0.so` → `sqlite3_vec0_init`）。改成 `vec0-linux.so` 会报 `undefined symbol: sqlite3_vec0linux_init`。
2. **Android 那份不能用**。仓库早先那份是 Termux（bionic）构建，`dlopen` 时报
   `libm.so: cannot open shared object file`（bionic 是 `libm.so`，glibc 是 `libm.so.6`）。
   手机上的旧文件已改名 `vec0.so.android-bak` 留证。
3. **还要配上 `scripts/patch-agent-knowledge-vec.mjs`**：运行端 `knowledge-lib.js` 里那两处
   `if (vec) { db.loadExtension(...) }` 以「npm 包是否装上」为前置条件，容器里没装这个 npm 包，
   于是根本不会尝试加载本地 `.so`（这就是「向量检索从部署起一直静默退化成纯关键词」的根因）。

### 新装 / 换机 / 重新打包 rootfs 时必须做

把本文件按上面的名字放进 rootfs 的 `agent/data/native/`，并对 `input/agent-app/src/features/knowledge-lib.js`
跑一次 `node scripts/patch-agent-knowledge-vec.mjs <文件> --write`；然后重启机器人。
（当前手机已完成这两步，实测 `vec_version()=v0.1.9`、检索 `vector=true / vecHits=24`。）
