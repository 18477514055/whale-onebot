# 授权本地作品 → 有界视听证据 → 已配置模型

入口 `understand.mjs`。两个可单独使用的适配器；不安装软件、不读取已有账号或模型配置、不启动服务、不自动下载、不自建模型客户端。不要把原片路径送进协议或模型。

| 信任边界 | 接口与结果 |
| --- | --- |
| 手机端/外部协议端 | `createFfmpegExtractor({ffmpegPath,resolveAuthorizedFile,timeoutMs:10000})` 返回 `extract({work_id},{signal})`。在已鉴权且授予 `get_work_media` 的宿主动作中调用。成功得到 `{work_id,frames:[{ms:1000,width:96,height:96,rgb24}],audio:{rate:16000,pcm16le}}`，两种样本均为规范 base64。没有源文件/URI、容器标签、字幕、他人资料或凭据。 |
| 机器人端/模型桥 | `createConfiguredModelAnalyzer({client,model,inputUnitsUpperBound,timeoutMs:8000})` 返回插件所需的 `analyze({frames,audio},{signal,maxUnits})`。只构造 1 张 PNG + 2 秒（64044 字节 WAV）+ 固定指令；不会把 `work_id`、帧时间、feed 标签、用户提示、会话上下文、工具、音视频容器或上游错误放进模型请求。 |
| 无协议的本地编排 | `understandWork({work,extract,analyze,publicOnly:true,maxUnits,signal,timeoutMs:15000})` 另外核对作品 ID 与公开标识；答复需同时含视觉和听觉证据。它本身不执行点赞、评论、消息等副作用。 |

```js
import {createFfmpegExtractor,createConfiguredModelAnalyzer} from './understand.mjs';
// 每个实例只属于一个已认证账号；注册表由宿主维护，不是来自协议请求中的任意路径。
const getWorkMedia = createFfmpegExtractor({
  ffmpegPath: trustedExecutableAbsolutePath,
  resolveAuthorizedFile: ({work_id}, {signal}) =>
    grants.resolveImmutableLocalFileForApprovedModel(work_id, {signal}) // 找不到或无许可 => null
});
// 在协议 get_work_media handler：return getWorkMedia({work_id}, {signal});
// 在插件策略依赖注入：{ analyze }。
const analyze = createConfiguredModelAnalyzer({
  client: dedicatedExistingClient, model: approvedMultimodalModel,
  inputUnitsUpperBound: auditedWorstCaseInputTokensForThisModel
});
```

**授权不是文件存在性。** `resolveAuthorizedFile` 必须核验当前账号/作品、当前操作、该段内容及其是否允许送往特定模型；应只返回私有、不可被其他写者更换的本地常规文件。不要把请求路径、SAF URI、用户 profile 或其他账号的文件直接返回；无逐作品授权就拒绝。敏感画面/语音本身也可能含身份或秘密，二进制重编码无法匿名化：没有该段披露许可时不要配置模型传出。含隐私素材应另行人工脱敏或仅用获准的本地模型。

**依赖与上限。** Node ESM，建议 Node 22 LTS 新补丁或 24（需要 `zlib.crc32`、AbortController 和 child_process）。手机端方案是已有 Node/Termux 或等效可运行 Node 的外部宿主，提供可信、已许可且适配 ABI 的 FFmpeg 绝对路径（不附带二进制）。要求支持 `fd:` 可 seek 的标准输入、`mov` demuxer、源作品编解码、`scale,pad,aresample,atrim,asetpts`、RGB24 和 PCM s16le 输出。传入子进程的环境不含宿主密钥或 LD_LIBRARY_PATH；目标二进制及库必须能在精简环境启动。只支持可 seek 的本地 MOV/MP4 家族，不支持 URL/播放列表；`fd` 是唯一许可输入协议，禁用外部轨道引用。跳过第一秒，输出一帧和随后两秒单声道音频；不足两秒、缺轨、近静音、错误解码、超时、取消一律拒绝，无补零、无全片回退。最大源文件 256 MiB，单次 FFmpeg 分配/像素/输出分别有限制，但这些不是进程总内存隔离；对不受信任的媒体，宿主还应限制并发、以最小权限隔离解码器并保持更新。

模型客户端必须支持 OpenAI 兼容 `chat.completions.create` 同请求的 `image_url` + `input_audio`、`max_completion_tokens`、`store:false`、关闭重试和 AbortSignal。不要注入带自动追踪、请求体日志、插件工具或历史上下文的客户端。`store:false` 不等于供应商零保留；必须由宿主核验端点、隐私协议和授权。输入上界是该模型及通道对固定提示+最多 160×160 单图+2 秒音频的**已审计最坏输入 token 数**，不是猜测的平均数；只有 `maxUnits` 是同单位的 token 硬预算且后端遵守输出硬限额，才可注入上界。无此保证不配置，上界缺失/剩余预算不足会拒绝。输出至多 256 tokens；不自动重试。模型应分别报告视觉、听觉证据，不确定即拒绝。格式验证不是模型准确率证明；常见联系方式/凭据形式会被拦截，但不能证明任意文本均无隐私，最终评论还须走宿主权限与审核。

整体时限和提取、模型时限均可缩短（1..30000 ms）。到期/取消会停止等待、杀死正在运行的 FFmpeg，向模型 SDK 传递 abort 并丢弃迟到结果。已发请求不能撤回，远端计算是否终止取决于端点；不代表退费。传输/解码错误只对外给固定原因，不回显错误文本、stderr、路径或凭据。不持久化样本；JS 字符串无法保证即时物理擦除。

**离线复验（仓库根目录，PowerShell）**：

```powershell
$env:TEST_FFMPEG = (Get-Command ffmpeg).Source
node --test _notes/douyin-delivery/media/media.test.mjs
```

不设 `TEST_FFMPEG` 会明确跳过实际解码测试。测试在本目录自建、清除合成 MP4：首秒蓝色静音，随后红色+440Hz，断言抽得红像素、两秒约 880 次正向过零；另外测试静音/未授权拒绝、包体最小化、预算、证据空缺、取消和超时。**已验证**：Windows Node v24.20.0 / FFmpeg 9.0.2，真实解码；模型请求通过进程内替身观察，不联网。**未验证**：Android/Termux 可执行文件装载与权限、Linux/其他 FFmpeg 构建、真实设备/账号/授权源、真实供应商组合模态/账单/输出质量和保留策略。测试不构成这些目标环境验收。
