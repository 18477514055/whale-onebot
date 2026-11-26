# Whale OneBot 1.2.4

1.2.3 的跨网配对思路对，但**默认那批海外 Nostr 节点在国内手机上根本连不上**，所以「识别到码、连不上」依旧。这一版换掉信令底座。

## 一、为什么 1.2.3 还是不行（4 项实测根因）

1. **默认 4 个海外 Nostr 节点里 `relay.damus.io` 实测 503**，且国内无代理的手机会被整体阻断 → 信令层直接废掉。
2. **`ctrlSub.awaitSubscribed` 没等**：中继订阅还没确认就去发 `host_relay_ready`，这个临时事件直接丢了。
3. **串行瀑布试错太慢**：局域网 → UDP 打洞 → 中继逐个试，耗到 33 秒以上，把 60 秒的配对票据耗光；其中 `stun.miwifi.com` 单次就超时 1.8 秒。
4. **中继只等第一个就绪**：`NostrRelayChannel` 一有单节点就跳过其余，双端很容易落到**不同中继**上，而且异常被吞掉、什么都不报。

## 二、这一版怎么改的

**信令底座换成「国内免代理 + 多协议」：**

- 新增 **`MqttSignaling.java`** —— 纯 Java 的 MQTT 3.1.1 over TLS（8883），显式 SNI、18 秒 PINGREQ 保活、QoS1 带 PUBACK。**国内直连、不需要代理、不需要自建服务器**。
- **`NostrSignaling` 升级为多协议密文总线**：默认 6 个节点 —— `mqtts://broker-cn.emqx.io:8883`、`broker.emqx.io`、`broker.hivemq.com` + `wss://relay.primal.net`、`nos.lol`、`nostr.bitcoiner.social`，**剔除 503 的 damus**；补了 WebSocket 分片续传与 PING 保活；**≥2 个节点就绪才算好**，跨协议去重广播。
- **STUN 换成国内低延迟**：`stun.miwifi.com` 移出超时列表，优先 `stun.chat.bilibili.com:3478`。
- **配对票据从 60 秒放宽到 180 秒**，并免疫双机时钟偏差（`RemoteStore.PAIR_TTL_MS`）。
- **并发竞速 + 带内热升级**：所有直连候选**同时**试（约 2.2 秒上限），同时**预热加密中继**；跨网时 2–4 秒内先连上「加密中继」，然后在已建立的会话里调 `remote.transport.probe` 后台静默升级到局域网 / Tailscale / IPv6 / STUN UDP P2P，**切换过程零丢包**。
- **界面可见性**：二维码下方实时显示「跨网加密信令就绪（X/6 节点在线）」；扫码全过程有阶段状态与 `WhaleRemoteSig` 诊断日志，不再是一句「连接失败」。

## 三、验证

- Android 全量 **143 个 Java 文件 `javac` exit 0**；`BAD_UTF8: []` / `REAL_ALERTDIALOGS: []`。
- `RemoteP2pAndQrTest` **59/59 PASS**（含 MQTT 24 KB 编解码、Mock Broker 上的端到端加密握手与 RPC）。
- **真实公网 6 节点端到端握手 + Ping + RPC 通过**：`LIVE_E2E_PASS total=3373ms ping=515ms`。
- **跨设备实测**：真机（Android，6 节点）↔ PC（只留 EMQX 单节点，模拟国内无代理 5G）握手成功，`rtt=1973ms`。

## 四、安装

- 版本 `12005` / `1.2.4`，release 签名，无 `debuggable`；覆盖安装，数据与登录态保留。
- 内置部件未变（环境/核心/插件仍是原版本），索引同一份，所以只发 APK。

## 五、未验证

- 上面「跨设备实测」是**一台手机 + 一台 PC**，不是你手上两台手机的真实组合；两台都在国内 5G、都不挂代理的场景**还没跑过**。
- 带内热升级（中继 → P2P）在真实网络抖动下的切换**没有长时间压测**。
- 请你回填：① 扫码后多久连上（应该在 2–4 秒）；② 二维码下面显示几个节点在线；③ 连上之后有没有掉线或卡顿。
