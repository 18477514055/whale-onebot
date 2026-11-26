# 可选的抖音公开作品读取器

**线上未验证。** 本次只用合成 HTML、注入 fetch 在本地测试，未访问抖音。此实现能发真实请求，不是成功率承诺，也不保证抖音当前返回可接受的静态页面。拒绝表示“未取得充分证据”，并不表示作品一定私密或不存在。

Node ESM（本机 Node 24），无外部包；导入不会联网，也未接入或修改任何宿主服务。若明确选择启用，可注入命名导出 `resolvePublicWork`。接口：

```js
import { resolvePublicWork } from './index.mjs';
// 仅在调用时才发起请求；work_id 必须是字符串而不是 Number 或 URL。
const result = await resolvePublicWork({ work_id });
// { work_id, visibility: 'public', evidence: 'anonymous', title }
```

每次最多对 `https://www.douyin.com/video/<十进制ID>` 发一次匿名 GET；不接受外部 URL、短链或跳转，不重试，不接收自定义请求头。不使用 Cookie、账号、私有 API、签名、浏览器、JS 执行或反爬规避。不开媒体和子资源。以通常的、未被覆写的 Node 内置 fetch 为运行前提；`createPublicReader({fetch})` 的注入点仅供可信离线测试，不能注入带凭据或自动重定向的客户端。

判定：HTTP 200、UTF-8 HTML、无重定向或验证响应头；head 中至少一个 canonical 或 og:url，且所有声明精确等于本次请求；非空标题（title 或 og:title）与正文 h1 一致；正文含静态 video 且不含无法解释的额外文字。只识别有限静态标签及属性。登录/验证提示、脚本壳、复杂样式、依赖 JS 的视频、未识别标记一律拒绝。真实公开页面也可能因此被拒绝。5 秒请求超时，解码前流式限制为 512 KiB（按 fetch 输出的已解压字节）。结果不包含视频地址，不能作为播放权限或将来可访问性的证明。

拒绝以 rejected Promise 表达，`error.code` 区分如 `invalid_work_id`、`unexpected_response`、`unsupported_markup`、`unconfirmed_identity`、`unconfirmed_title`、`unconfirmed_body`、`restricted_page` 等，不回传页面内容。调用方不能把这些拒绝降级为匿名成功。

本地复验（不监听端口、不访问任何网站）：`node --test index.test.mjs`。用例检查精确 URL、请求选项与返回字段；对冲突的作品身份、仅预览、登录/验证标记、跳转、异常状态、超限或非 HTML 响应验证拒绝。