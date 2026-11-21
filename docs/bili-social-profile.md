# B 站：账号资料（W24）与互动弹幕组件（W4）

这些是当前已授权账号的动作，不接受目标 UID、Cookie、CSRF、请求头、URL、文件路径或自由格式的请求体。除查询资料外均须启用账号写操作。所有示例均为参数说明，不代表已在真实账号执行。

| 动作 | 参数 | 行为 |
|---|---|---|
| `bili_get_self_profile` | `{}` | 读取当前账号的 `uname`、`sex`、`birthday`、`sign`，不返回整个账号对象。 |
| `bili_update_profile` | `uname?`、`confirm_rename?`、`sex?`、`birthday?` | 至少指定一项资料。`sex` 为 `男`、`女` 或 `保密`；生日须为有效的非未来 `YYYY-MM-DD`。指定昵称（至多 32 字符）时必须明确传 `confirm_rename:true`：改名可能扣硬币。 |
| `bili_update_signature` | `sign` | 使用专用签名接口，不提交其他资料。最多 70 个 Unicode 字符，可用空字符串清空；可能需要审核。 |
| `bili_update_avatar` | `image_base64` | 仅接受直接编码的 PNG/JPEG 字节（标准、有必要填充的 Base64；不是 data URI），解码后最多 2 MiB。根据文件标记判断类型，并设置固定上传文件名。不会访问本机文件或下载远程图片；标记检查不等同于完整图像解码。 |
| `bili_create_command_danmaku` | `aid`、`cid`、`type`、`progress?`，及下表参数 | 向一个分 P 提交一条互动弹幕；`progress` 为出现时间，毫秒整数，默认 0，最大 2147483647。 |
| `bili_delete_command_danmaku` | `cid`、`dmid` | 用分 P 的 CID 和组件 ID 删除单条互动弹幕，不调用普通弹幕撤回、批量删除或预约取消接口。 |

`bili_update_profile` 会先读当前资料，确认原值可安全用于整表提交；若昵称发生变化，还要确认改名资格。资料缺失或资格不明确则不提交。平台没有在这些接口中提供条件更新；请勿同时在网页或另一客户端编辑同一份资料。除资料读取外，动作返回传输层提取的上游 `data`（可能为空）；改签名、换头像、改资料也会检查嵌套的业务错误码。提交超时请先核实结果，不要自动重发。

### 互动弹幕类型

| `type`（数字） | 专用字段 | 约束 |
|---|---|---|
| 1 UP 主头像弹幕 | `msg` | 非空，最多 99 字符 |
| 2 关联视频 | `msg`, `bvid` | 同上；`bvid` 是关联稿件的 BV 号，而非 URL |
| 5 关注按钮 | `duration`, `posX`, `posY` | 整数；本站桥限制持续时间 5000–60000 毫秒，X 范围 118–549，Y 范围 82–293 |
| 9 投票 | `question`, `options` | 问题最多 12 字符；2–4 个不同的非空选项，各最多 6 字符且不含 `;`。不联动发动态，不添加自定义选项。 |
| 11 评分 | `title`, `skin` | 标题最多 12 字符；皮肤为整数 1（星）、2（心）、3（柠檬）。 |

示例：`{"aid":"101","cid":"202","type":2,"msg":"参考视频","bvid":"BV1kz4y1X7XP","progress":5000}`。创建成功后，优先使用返回的精确字符串 `idStr` 作为 `dmid`，例如 `{"cid":"202","dmid":"39053842117558279"}`。ID 接受正的十进制字符串（不超过有符号 64 位整数）或 JS 安全正整数。创建和删除均要求平台授予当前账号相应的稿件权限；不会尝试替换身份或绕过权限。此接口不创建、取消预约，也不对其他业务做级联删除。

### 接口依据与验证范围

- [catbus PR #21](https://github.com/cv-cat/catbus/pull/21/files)：核对了 `member/web/account`、`member/uname/update/message`、`member/web/update`、`member/web/sign/update`、`member/web/face/update` 的请求。头像为 `multipart/form-data`，包含 `dopost=save`、`DisplayRank=10000`、`face`；请求的 CSRF 由传输层按该固定端点放入查询串，动作不接触凭据。其他表单的 CSRF 在请求体。该 PR 标注资料接口未做实网对拍，不能据此保证当前线上行为。
- [quanlook 的文档索引](https://github.com/quanlook/bilibili-API-collect/blob/master/docs/danmaku/action.md)可检索到，GitHub REST 读取该仓库返回 404；实际核对了[可读的固定上游版本](https://github.com/SocialSisterYi/bilibili-API-collect/blob/ab2762aeaa0aad65603478ca704cd4cbc3b9c425/docs/danmaku/action.md)：`/x/v2/dm/command/post` 的 1/2/5 类型、表单与类型专用 JSON 字段。
- [bili-cli 固定实现](https://github.com/kukemc/bili-cli/blob/bfc568f169f50b11f743a8dad7c1d7c0ba3a84e0/src/bili_cli/commands/danmaku.py)：核对 9/11 类型和表单 `POST /x/v2/dm/command/del` 的 `oid`（即 CID）、`dmid`。删除用的是互动组件专用接口，不是普通弹幕的 `/x/v2/dm/edit/state`。
- 本地运行 `node --test test/bili-social-profile.test.mjs`。测试以记录请求的假传输验证动作、字段、精度、错误和拒绝路径，不访问 B 站，不证明真实账号能通过审核或平台风控。
