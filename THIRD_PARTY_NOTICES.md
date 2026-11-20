# 依赖与接口事实来源

本工程实现为原创。没有将 NapCat 实现、私有原生组件、现有账号数据或旧登录态复制进产品。

- 运行时依赖 `ws`，固定版本见 package-lock.json，MIT；安装包内许可证在 node_modules/ws/LICENSE。来源：https://github.com/websockets/ws 。依赖通过 npm 正常安装，未把其实现声称为本工程原创。
- OneBot11公开接口规范固定来源 `botuniverse/onebot-11@d4456ee706f9ada9c2dfde56a2bcfc69752600e4`，用其接口名称和协议契约独立实现，未复制其文档正文作产品文档。https://github.com/botuniverse/onebot-11
- QQ原生service/listener形状参考 `NapukettoDev/NapukettoQQ@f20ed97c136e055cbe13c77545b976bfbd14e6d3` 的公开MIT TypeScript类型及文档。未复制其业务实现。它的原生子模块另属闭源，未复制、下载或执行，不能从主仓MIT推导子模块授权。
- 腾讯 wrapper.node 的Windows既有样本用于静态ABI核查；官方Linux样本另在用户明确授权下进行隔离加载、扫码和会话初始化实验。它们不属于本工程分发物，没有改写或重新打包这些文件。
- Linux测试用Node运行时保存在本机 `.tools`；原始下载URL和校验值记于evidence，不进入源代码交付包。Node许可由其官方发行包提供。
- 本轮对既有QQNT.dll仅静态读取两个导出函数，不复制到产品；函数边界/摘要保存在evidence，原始小范围反汇编只在不分发的.tmp。
- 原创合成原生实验使用TinyCC历史Windows包和Debian TinyCC/libc6-dev包，均仅解压于.tools；Linux链接使用系统已有GNU ld。工具、第三方头文件和生成二进制不进入源码包；许可证随原发行包保留。工具来源与哈希随原发行包保留。
- Linux C++组件使用官方Node固定commit的内部头、GCC14及Linux UAPI头；全部外部源和工具只在.tools，许可文件随依赖保留，源码包仅含本工程原创实现与哈希清单。Node内部接口不是跨版本稳定ABI。
- Linux QQ官方deb作为本地静态分析与已授权的隔离实验样本，未安装至系统；wrapper及所需库已在独立运行目录中使用，QQ主程序未启动。样本均留在.tools并排除分发。未找到动态定义的接口没有被填入空stub。
- 图片解码依赖固定 `sharp@0.35.5`，许可为Apache-2.0，来源：[Sharp固定版本](https://github.com/lovell/sharp/tree/v0.35.5)。它是独立第三方解码依赖，不是本工程原创实现。
- Sharp的预编译可选依赖按package-lock完整性安装：`@img/sharp-linux-x64@0.35.5`为Apache-2.0，`@img/sharp-libvips-linux-x64@1.3.4`为LGPL-3.0-or-later，`@img/sharp-win32-x64@0.35.5`声明Apache-2.0 AND LGPL-3.0-or-later。包内LICENSE/README及上游源码指引保留于node_modules；本源码交付排除node_modules/.tools及全部第三方原生二进制。上游来源：[sharp-libvips](https://github.com/lovell/sharp-libvips)。
- 本共享Windows/WSL工作区额外按锁文件SHA512补齐Linux可选包，避免裁掉Windows安装；记录见evidence/sharp-shared-install.json。普通单平台部署使用npm ci --ignore-scripts --include=optional即可，跨平台安装状态仍须分别实测。
- Windows MSVC/SDK候选工具来自微软官方归档，获取与校验记录留在本机开发环境；不运行安装器、不分发这些工具，也不将STL开源许可扩展为全部工具包的分发授权。

资料中的实验成功与本轮真实验证明确区分，详见docs。本工程源码以 MIT 发布（见根目录 `LICENSE`）；
第三方组件的许可各以其上游文本为准，本文件只做标注，不代替上游许可。

## 运行端（业务程序）：改造自 qq-agent-plus

**关系先说清：这是深度改造后的衍生作品，不是「原样集成」。** 容器里跑的运行端是在上游源码树上
做了大量重写与扩展之后才交付的，改造层与被改造的上游文件一起构成产品的一部分。

### 上游与派生链

| 环节 | 仓库 | 许可 / 版权 |
|---|---|---|
| 直接上游 | [`sakurawwwxh/qq-agent-plus`](https://github.com/sakurawwwxh/qq-agent-plus)，基线 v0.9.13 / commit `4488db7` | **MIT**，`Copyright (c) 2026 Kondius` |
| 其上游 | `carbonbromine/qq-agent` | MIT |
| 更上游 | `K0nd1us/QQ-agent` | MIT，版权人 `Kondius` |

链上每一环都要保留，只写一个名字不满足「保留完整版权链」。

**我们与上游的关系**：内置机器人是**我们自己的产品**（基于上述上游深度改造），
所以**不跟随上游自动升级** —— 基线钉在 `v0.9.13 / 4488db7`，上游的新改动由我们评审后
随产品版本一起发布，不会被自动拉取替换。上游在这里是**来源与许可义务**，不是升级上游。

### 我们改了什么（可审计的量化口径）

> 2026-11-20 起口径更新：原先 33 个磁盘补丁 / 23 个已注册（ESM loader 加载期注入）的改造
> 已**全部折叠为直改源码**（深度改造完成，补丁机制退役）。下表前两行是折叠**前**的历史量化，
> 折叠后它们对应的改动直接住在 `input/agent-app/` 的源文件里，不再有独立补丁层。

| 类别 | 数量 | 体量 |
|---|---:|---|
| overlay 补丁（已折叠进源码） | 23 个注册补丁 / 18 个注入目标 | 3,305 行 |
| 自有模块（上游没有） | 39 个 | 11,653 行 |
| 直接改动上游文件 | 5 个 + 上述折叠 | +427 / −6（另加折叠注入） |
| 本地控制台 API | 14 条 | 326 行 |
| 专项验收脚本 | 19 个 | 3,815 行 |

改造方式（2026-11-20 起）：**深度改造直改源码**——23 个补丁的注入结果与其依赖的自有模块
（心情引擎、本地工具、印象、亲密度等）都直接构成 `input/agent-app/` 的源文件；
上游基线之上的全部行为差异都在源码里可见、可 diff、可审计，不再依赖运行期补丁层。
功能面新增了亲密度、心情、打卡、投喂、跨群身份、可解释记忆、控制台可观测等一整套能力
—— 这些在上游**都不存在**，也不是配置开关。

### MIT 履约

- 上游 `LICENSE` 全文**随运行端包一起分发**（包内路径 `app/LICENSE`），版权行原样保留；
- 本文件随包附带（包内路径 `app/THIRD_PARTY_NOTICES.md`）；
- 我们自己的改造层同样以 **MIT** 发布，版权归本产品作者；
- 保留派生链说明，且**不暗示**上游作者为本产品背书。

> MIT 只要求「保留版权声明与许可文本」。衍生作品可以继续闭源或开源，但上述声明不能删。

### 边界

- 2026-11-20 起深度改造折叠完成后，**深度改造后的运行端源码树进本仓库 `input/agent-app/`**
  （镜像容器内路径 `/input/agent-app`；不含 node_modules、运行数据与已退役的补丁机制目录）。
  上游基线 `v0.9.13 / 4488db7` 的原始树**不在**仓库里；差异即我们的改造。
- 任何「运行端包」发布物仍是再分发，必须带上上面「MIT 履约」里的两个文件
  （`scripts/stamp-runtime-licenses.mjs --check` 会拦住漏盖的情况）。
- 原先注入地址/token/超时的 agent preload 钩子已随折叠**退役**（2026-11-20）：这些注入
  直接写在 `input/agent-app/src/onebot/onebot.js` 源码里，仍只传连接端点，不改业务逻辑、
  不改配置语义、不伪造身份。
- 感谢 **sakurawwwxh** 维护的 qq-agent-plus：它的「协议端与机器人解耦」设计、插件/技能体系与
  安全抓取实现，是本产品运行端的直接基础。也感谢 `carbonbromine` 与 `Kondius` 的上游工作。

### 已与上游沟通

- 2026-11-19：在上游仓库的 Discussions 公开说明本工程是改造衍生作品，并附上我们在真机上撞到的
  5 个运行时问题 —— https://github.com/sakurawwwxh/qq-agent-plus/discussions/116
  （该帖未经作者审阅，不代表作者认可本产品；署名与措辞类意见我们会照改，
  代码行为上的取舍按本工程的实际需要决定。）

## 容器内向量检索扩展（sqlite-vec）

- 容器里的知识库语义检索（docs_vec 虚表）需要 SQLite 的 ec0 扩展。
- 使用的是官方 npm 包 sqlite-vec-linux-arm64@0.1.9 内的预编译 ec0.so（156,520 字节），
  来源：https://www.npmjs.com/package/sqlite-vec-linux-arm64 。许可为 Apache-2.0 / MIT（双许可，以上游 LICENSE 为准）。
- 它只作为**运行时组件**放进容器（/agent/data/native/vec0.so），源码包里不含它的源码，也不声称为本工程原创。
- 之前容器里那份 ec0.so 是 Termux（Android/bionic）版本，在 glibc 容器里无法加载，已保留为 ec0.so.android-bak。

