# 自定义核心：登记一份实例

Whale 把下面的 JSON 当作描述数据，不下载机器人程序，不执行脚本，也不把第三方页面嵌入 WebView。每个 `id` 代表作者准备好的一份独立实例，而不是可分配多次的核心类型。导入同一个 ID 两次会报错，不会覆盖旧登记或转移占用。

```json
{
  "schemaVersion": 1,
  "id": "custom-example-01",
  "version": "1.0.0",
  "platforms": ["qq", "bilibili"],
  "pages": [
    {"platform":"qq", "label":"机器人设置", "url":"https://bots.example.org/settings"},
    {"platform":"bilibili", "label":"控制台", "url":"https://bots.example.org/console"}
  ]
}
```

文件或链接导入与本机 API 使用相同格式，UTF-8 最多 16 KiB；不能附加其他字段。`id` 为 `custom-` 加最多 56 个小写字母、数字或连字符，后缀的首字符须为字母或数字。`version` 最多 64 个字母、数字或 `._+-`（开头须为字母或数字）。`platforms` 当前支持 `qq` 与 `bilibili`，不可为空或重复。`pages` 可以为空，至多 16 项；页面必须属于已声明的平台，使用 HTTPS 域名，不可包含账号密码、查询参数、端口、片段或本机地址。`label` 不超过 40 字符。

## 本机接口（默认关闭）

由用户在设置页显式开启临时登记窗口。用窗口提供的端口和一次性密钥，通过程序在**同一台手机**发起请求；不要将密钥放在命令行历史、文件、日志或 URL 中。请求格式：

```http
POST /v1/core-instances HTTP/1.1
Host: 127.0.0.1:<窗口显示的端口>
Authorization: Bearer <窗口内显示的临时密钥>
Content-Type: application/json
Content-Length: <描述文件的 UTF-8 字节数>

<描述 JSON>
```

只接受 IPv4 回环连接，不接受浏览器跨域请求、分块正文、压缩正文或转发；不支持列出机器人、读取凭据、运行命令或启动核心。成功返回 `201` 且窗口停止接收；取消窗口、开启新的窗口或两分钟超时也会关闭原窗口。凭据或来源不符返回 `403`，格式不符或 ID 冲突返回 `400`。登记只将实例加入空闲列表，用户仍须明确选择该实例来创建机器人。自定义核心的提供者自行管理设置、插件与数据，Whale 的内置清空/恢复流程不向自定义目录写入。
