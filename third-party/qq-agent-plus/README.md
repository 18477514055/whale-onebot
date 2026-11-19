# 上游 qq-agent-plus 的许可原件

`LICENSE` 是上游许可的**逐字副本**，不要编辑它。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/sakurawwwxh/qq-agent-plus |
| 基线 | v0.9.13 / commit `4488db7` |
| 许可 | MIT |
| 版权行 | `Copyright (c) 2026 Kondius` |
| 派生链 | `sakurawwwxh/qq-agent-plus` → `carbonbromine/qq-agent` → `K0nd1us/QQ-agent` |
| 取回时间 | 2026-11-19，经 GitHub API `GET /repos/sakurawwwxh/qq-agent-plus/license` |

## 为什么放在仓库里

我们分发的**运行端包**内含改造后的上游源码 ⇒ 属于再分发 ⇒ MIT 要求随包保留版权声明与许可全文。
所以这份原件必须留在版本库里（否则打运行端包时无处可取），并由
`scripts/stamp-runtime-licenses.mjs` 在打包前写进包的 `app/LICENSE`。

上游若更新许可文本，重新取一次并覆盖本目录的 `LICENSE`，同时更新上表的取回时间。

## 关系说明

本工程对运行端的改造是**衍生作品**，不是原样集成；改造范围、四层机制与 MIT 履约方式见仓库根目录
`THIRD_PARTY_NOTICES.md`。我们与上游作者无隶属或背书关系。
