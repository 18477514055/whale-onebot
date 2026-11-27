package com.whaleonebot.remote;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * [layer: shell-android] 多协议零自建服务器密文信令总线（MQTT-over-TLS 主通道 + Nostr WebSocket 冗余通道）。
 *
 * <p>设计要点（国内免代理直连 + 零知识端到端加密）：
 * <ul>
 *   <li>主通道采用免费公共 IoT MQTT Broker（{@code mqtts://broker-cn.emqx.io:8883} 等），国内 5G / 普通 Wi-Fi 无需代理即可直连；</li>
 *   <li>冗余通道保留高可用 Nostr 公共中继（移除已 503 不可用的 damus，保留 primal / nos.lol / bitcoiner），并发互补；</li>
 *   <li>频道主题与正文均由双端共享密钥派生并经 AES-256-GCM 加密，任何公共节点都无法读取设备名、账号或业务明文；</li>
 *   <li>内置显式 TLS SNI、WebSocket 分片续传帧（RFC 6455 continuation）与空闲 PING 保活，消除断连与丢包竞态。</li>
 * </ul>
 */
public final class NostrSignaling {

    /** Nostr 临时事件类型（20000–29999 为 NIP-01 ephemeral event，中继不长期落盘）。 */
    public static final int KIND_EPHEMERAL_SIGNAL = 25050;

    /** 默认内置多协议免费公共信令池（MQTT-TLS 国内免代理优先 + 可用 Nostr 节点冗余）。 */
    public static final List<String> DEFAULT_RELAYS = Collections.unmodifiableList(Arrays.asList(
            "mqtts://broker-cn.emqx.io:8883",
            "mqtts://broker.emqx.io:8883",
            "mqtts://broker.hivemq.com:8883",
            "wss://relay.primal.net",
            "wss://nos.lol",
            "wss://nostr.bitcoiner.social"
    ));

    public interface BeaconListener {
        void onBeacon(String decryptedJson, String relayUrl);
    }

    public interface LogSink {
        void log(String level, String message);
    }

    /** 可选日志回调（由 Android 侧挂载到 android.util.Log，保持本类零 Android 依赖）。 */
    public static volatile LogSink logSink;

    private NostrSignaling() {
    }

    public static boolean isMqttUrl(String url) {
        if (url == null) return false;
        String lower = url.trim().toLowerCase(Locale.ROOT);
        return lower.startsWith("mqtts://") || lower.startsWith("mqtt://")
                || lower.startsWith("ssl://") || lower.startsWith("tls://");
    }

    public static boolean isSupportedRelayUrl(String url) {
        if (url == null) return false;
        String lower = url.trim().toLowerCase(Locale.ROOT);
        return lower.startsWith("mqtts://") || lower.startsWith("mqtt://")
                || lower.startsWith("wss://") || lower.startsWith("ws://");
    }

    private static void log(String level, String msg) {
        LogSink sink = logSink;
        if (sink != null) {
            try {
                sink.log(level, msg);
            } catch (Throwable ignored) {
            }
        }
    }

    /** 构造一条标准 NIP-01 + BIP-340 Schnorr 签名的加密信令事件 JSON（纯函数，可直接单测）。 */
    public static String buildSignedEventJson(byte[] secKey32, String topicHex, byte[] sharedSecret,
                                              String plainPayloadJson, long createdAtSec) {
        byte[] pub32 = RemoteCrypto.schnorrPubKey(secKey32);
        String pubHex = RemoteCrypto.hex(pub32);
        String cipherB64 = RemoteCrypto.encryptSignalPayload(sharedSecret, plainPayloadJson);

        String canonical = "[0," + jsonStr(pubHex) + "," + createdAtSec + "," + KIND_EPHEMERAL_SIGNAL
                + ",[[\"t\"," + jsonStr(topicHex) + "]]," + jsonStr(cipherB64) + "]";
        byte[] idBytes = RemoteCrypto.sha256(canonical.getBytes(StandardCharsets.UTF_8));
        String idHex = RemoteCrypto.hex(idBytes);
        byte[] sig = RemoteCrypto.schnorrSign(secKey32, idBytes, RemoteCrypto.randomBytes(32));
        String sigHex = RemoteCrypto.hex(sig);

        return "{\"id\":" + jsonStr(idHex)
                + ",\"pubkey\":" + jsonStr(pubHex)
                + ",\"created_at\":" + createdAtSec
                + ",\"kind\":" + KIND_EPHEMERAL_SIGNAL
                + ",\"tags\":[[\"t\"," + jsonStr(topicHex) + "]]"
                + ",\"content\":" + jsonStr(cipherB64)
                + ",\"sig\":" + jsonStr(sigHex) + "}";
    }

    /** 验证 Nostr 事件签名并尝试用共享密钥解密正文；验证或解密失败返回 null。 */
    public static String verifyAndDecryptEvent(String eventJson, byte[] sharedSecret) {
        if (eventJson == null || sharedSecret == null) return null;
        try {
            String idHex = extractJsonString(eventJson, "id");
            String pubHex = extractJsonString(eventJson, "pubkey");
            String sigHex = extractJsonString(eventJson, "sig");
            String content = extractJsonString(eventJson, "content");
            if (idHex == null || pubHex == null || sigHex == null || content == null) return null;
            byte[] idBytes = RemoteCrypto.unhex(idHex);
            byte[] pubBytes = RemoteCrypto.unhex(pubHex);
            byte[] sigBytes = RemoteCrypto.unhex(sigHex);
            if (!RemoteCrypto.schnorrVerify(pubBytes, idBytes, sigBytes)) return null;
            return RemoteCrypto.decryptSignalPayload(sharedSecret, content);
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * 并发向多协议信令池发布一条密文信标；只要至少 1 个节点确认接收即返回 true，
     * 且达到 2 个节点确认时立即提前返回（不被死节点拖慢 4 秒）。
     */
    public static boolean publish(List<String> relays, byte[] sharedSecret, String plainPayloadJson, int timeoutMs) {
        List<String> pool = (relays == null || relays.isEmpty()) ? DEFAULT_RELAYS : relays;
        final String topic = RemoteCrypto.deriveSignalTopic(sharedSecret);
        final String mqttTopic = MqttSignaling.topicFor(topic);
        final byte[] mqttPayload = RemoteCrypto.encryptSignalPayload(sharedSecret, plainPayloadJson)
                .getBytes(StandardCharsets.UTF_8);

        // 仅当池中存在 Nostr 节点时才构造 Schnorr 签名事件，避免纯 MQTT 时浪费 CPU
        String nostrFrameTmp = null;
        for (String r : pool) {
            if (!isMqttUrl(r)) {
                byte[] ephSec = RemoteCrypto.randomBytes(32);
                String ev = buildSignedEventJson(ephSec, topic, sharedSecret, plainPayloadJson,
                        System.currentTimeMillis() / 1000L);
                nostrFrameTmp = "[\"EVENT\"," + ev + "]";
                break;
            }
        }
        final String nostrFrame = nostrFrameTmp;
        final int targetAcks = Math.min(2, pool.size());
        final AtomicInteger okCount = new AtomicInteger(0);
        final CountDownLatch earlyLatch = new CountDownLatch(targetAcks);
        final CountDownLatch allLatch = new CountDownLatch(pool.size());

        for (final String relayUrl : pool) {
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    if (isMqttUrl(relayUrl)) {
                        MqttSignaling.Client mc = null;
                        try {
                            mc = MqttSignaling.Client.connect(relayUrl, Math.min(timeoutMs, 3800));
                            mc.publish(mqttTopic, mqttPayload, 1);
                            boolean ack = mc.awaitPubAck(2000);
                            if (ack) {
                                okCount.incrementAndGet();
                                earlyLatch.countDown();
                            } else {
                                log("W", "mqtt publish no puback: " + relayUrl);
                            }
                        } catch (Throwable e) {
                            log("W", "mqtt publish fail " + relayUrl + ": " + e.getMessage());
                        } finally {
                            if (mc != null) mc.closeQuietly();
                            allLatch.countDown();
                        }
                    } else {
                        MiniWebSocket ws = null;
                        try {
                            ws = MiniWebSocket.connect(relayUrl, Math.min(timeoutMs, 3800));
                            ws.sendText(nostrFrame);
                            String reply = ws.readText(2200);
                            if (reply != null && reply.contains("\"OK\"") && reply.contains("true")) {
                                okCount.incrementAndGet();
                                earlyLatch.countDown();
                            } else if (reply == null) {
                                // 部分中继对 ephemeral event 不回 OK，发送无报错亦视作投递
                                okCount.incrementAndGet();
                                earlyLatch.countDown();
                            } else {
                                log("W", "nostr publish rejected " + relayUrl + ": " + reply);
                            }
                        } catch (Throwable e) {
                            log("W", "nostr publish fail " + relayUrl + ": " + e.getMessage());
                        } finally {
                            if (ws != null) ws.closeQuietly();
                            allLatch.countDown();
                        }
                    }
                }
            }, "sig-pub");
            t.setDaemon(true);
            t.start();
        }
        try {
            long waitMs = Math.max(1200, timeoutMs);
            if (!earlyLatch.await(waitMs, TimeUnit.MILLISECONDS)) {
                allLatch.await(200, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return okCount.get() > 0;
    }

    /** 订阅多协议公共信令池上的密文信标（MQTT-TLS + Nostr 并发长连，自动保活与去重）。 */
    public static Subscription subscribe(List<String> relays, final byte[] sharedSecret,
                                         final BeaconListener listener) {
        List<String> pool = (relays == null || relays.isEmpty()) ? DEFAULT_RELAYS : relays;
        final String topic = RemoteCrypto.deriveSignalTopic(sharedSecret);
        final String mqttTopic = MqttSignaling.topicFor(topic);
        final Subscription sub = new Subscription(topic, sharedSecret, pool.size());
        final Set<String> seenFingerprints = Collections.synchronizedSet(new LinkedHashSet<String>());

        for (final String relayUrl : pool) {
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    if (isMqttUrl(relayUrl)) {
                        runMqttSubLoop(relayUrl, mqttTopic, sharedSecret, sub, seenFingerprints, listener);
                    } else {
                        runNostrSubLoop(relayUrl, topic, sharedSecret, sub, seenFingerprints, listener);
                    }
                }
            }, isMqttUrl(relayUrl) ? "mqtt-sub" : "nostr-sub");
            t.setDaemon(true);
            t.start();
        }
        return sub;
    }

    private static void runMqttSubLoop(String relayUrl, String mqttTopic, byte[] sharedSecret,
                                       Subscription sub, Set<String> seen, BeaconListener listener) {
        long backoff = 4000L;
        boolean wasConnected = false;
        long lastFailLogAt = 0L;
        while (!sub.closed.get()) {
            MqttSignaling.Client mc = null;
            try {
                mc = MqttSignaling.Client.connect(relayUrl, 5000);
                mc.subscribe(mqttTopic);
                sub.addMqttClient(mc);
                if (!wasConnected) {
                    log("I", "mqtt connected & subscribed: " + relayUrl);
                    wasConnected = true;
                }
                backoff = 4000L;
                while (!sub.closed.get()) {
                    MqttSignaling.PublishedMessage pm = mc.readNextPublish(18_000);
                    if (pm == null) break;
                    String cipher = new String(pm.payload, StandardCharsets.UTF_8);
                    String decrypted = null;
                    try {
                        decrypted = RemoteCrypto.decryptSignalPayload(sharedSecret, cipher);
                    } catch (Throwable ignored) {
                    }
                    if (decrypted != null && deliverDedup(seen, decrypted)) {
                        if (listener != null) listener.onBeacon(decrypted, relayUrl);
                    }
                }
            } catch (Throwable e) {
                if (!sub.closed.get()) {
                    long now = System.currentTimeMillis();
                    // 仅在状态变化或每 60s 记一次失败，避免把 logcat 环形缓冲冲爆（第 230 轮诊断缺陷）
                    if (wasConnected || now - lastFailLogAt >= 60_000L) {
                        log("W", "mqtt sub disconnected " + relayUrl + ": " + e.getMessage());
                        lastFailLogAt = now;
                    }
                    wasConnected = false;
                }
            } finally {
                if (mc != null) {
                    sub.removeMqttClient(mc);
                    mc.closeQuietly();
                }
            }
            if (sub.closed.get()) break;
            if (!sleepBackoff(backoff)) break;
            backoff = Math.min(60_000L, backoff * 2L);
        }
    }

    private static void runNostrSubLoop(String relayUrl, String topic, byte[] sharedSecret,
                                        Subscription sub, Set<String> seen, BeaconListener listener) {
        long backoff = 5000L;
        boolean wasConnected = false;
        long lastFailLogAt = 0L;
        while (!sub.closed.get()) {
            MiniWebSocket ws = null;
            try {
                ws = MiniWebSocket.connect(relayUrl, 5000);
                long since = (System.currentTimeMillis() / 1000L) - 180L;
                String subId = "w" + RemoteCrypto.hex(RemoteCrypto.randomBytes(4));
                String req = "[\"REQ\"," + jsonStr(subId) + ",{\"kinds\":[" + KIND_EPHEMERAL_SIGNAL
                        + "],\"#t\":[" + jsonStr(topic) + "],\"since\":" + since + "}]";
                ws.sendText(req);
                sub.addNostrSocket(ws);
                if (!wasConnected) {
                    log("I", "nostr connected & subscribed: " + relayUrl);
                    wasConnected = true;
                }
                backoff = 5000L;
                while (!sub.closed.get()) {
                    String msg = ws.readTextKeepAlive(25_000);
                    if (msg == null) break;
                    if (!msg.contains("\"EVENT\"")) continue;
                    int objStart = msg.indexOf('{');
                    int objEnd = msg.lastIndexOf('}');
                    if (objStart < 0 || objEnd <= objStart) continue;
                    String ev = msg.substring(objStart, objEnd + 1);
                    String decrypted = verifyAndDecryptEvent(ev, sharedSecret);
                    if (decrypted != null && deliverDedup(seen, decrypted)) {
                        if (listener != null) listener.onBeacon(decrypted, relayUrl);
                    }
                }
            } catch (Throwable e) {
                if (!sub.closed.get()) {
                    long now = System.currentTimeMillis();
                    if (wasConnected || now - lastFailLogAt >= 60_000L) {
                        log("W", "nostr sub disconnected " + relayUrl + ": " + e.getMessage());
                        lastFailLogAt = now;
                    }
                    wasConnected = false;
                }
            } finally {
                if (ws != null) {
                    sub.removeNostrSocket(ws);
                    ws.closeQuietly();
                }
            }
            if (sub.closed.get()) break;
            if (!sleepBackoff(backoff)) break;
            backoff = Math.min(60_000L, backoff * 2L);
        }
    }

    private static boolean deliverDedup(Set<String> seen, String decryptedJson) {
        String fp = RemoteCrypto.hex(RemoteCrypto.sha256(decryptedJson.getBytes(StandardCharsets.UTF_8)));
        synchronized (seen) {
            if (!seen.add(fp)) return false;
            if (seen.size() > 512) seen.clear();
            return true;
        }
    }

    private static boolean sleepBackoff(long ms) {
        try {
            Thread.sleep(ms);
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public static final class Subscription {
        final AtomicBoolean closed = new AtomicBoolean(false);
        private final String topicHex;
        private final String mqttTopic;
        private final byte[] sharedSecret;
        private final byte[] ephNostrSec = RemoteCrypto.randomBytes(32);
        private final int totalPool;
        private final List<MqttSignaling.Client> mqttClients = Collections.synchronizedList(new ArrayList<MqttSignaling.Client>());
        private final List<MiniWebSocket> nostrSockets = Collections.synchronizedList(new ArrayList<MiniWebSocket>());
        private final Object readyLock = new Object();

        Subscription(String topicHex, byte[] sharedSecret, int totalPool) {
            this.topicHex = topicHex;
            this.mqttTopic = MqttSignaling.topicFor(topicHex);
            this.sharedSecret = sharedSecret;
            this.totalPool = Math.max(1, totalPool);
        }

        void addMqttClient(MqttSignaling.Client c) {
            if (closed.get()) {
                c.closeQuietly();
                return;
            }
            mqttClients.add(c);
            notifyReady();
        }

        void removeMqttClient(MqttSignaling.Client c) {
            mqttClients.remove(c);
        }

        void addNostrSocket(MiniWebSocket ws) {
            if (closed.get()) {
                ws.closeQuietly();
                return;
            }
            nostrSockets.add(ws);
            notifyReady();
        }

        void removeNostrSocket(MiniWebSocket ws) {
            nostrSockets.remove(ws);
        }

        private void notifyReady() {
            synchronized (readyLock) {
                readyLock.notifyAll();
            }
        }

        /** 当前已成功建立并完成订阅的在线信令节点数。 */
        public int connectedCount() {
            return mqttClients.size() + nostrSockets.size();
        }

        public int totalPoolSize() {
            return totalPool;
        }

        /** 等待至少 1 个公共信令节点完成订阅，兼容旧调用。 */
        public boolean awaitSubscribed(int timeoutMs) {
            return awaitReady(1, timeoutMs);
        }

        /**
         * 等待至少 {@code minNodes} 个节点完成订阅（保证双端节点有交集）；
         * 若超过半程仍只有 ≥1 个节点在线则提前放行，避免被慢节点卡死。
         */
        public boolean awaitReady(int minNodes, int timeoutMs) {
            int want = Math.max(1, Math.min(minNodes, totalPool));
            long start = System.currentTimeMillis();
            long deadline = start + Math.max(200, timeoutMs);
            long halfDeadline = start + Math.max(300, timeoutMs / 2);
            synchronized (readyLock) {
                while (!closed.get()) {
                    int cur = connectedCount();
                    if (cur >= want) return true;
                    long now = System.currentTimeMillis();
                    if (cur >= 1 && now >= halfDeadline) return true;
                    if (now >= deadline) return cur > 0;
                    long wait = Math.min(deadline - now, Math.max(80L, halfDeadline - now));
                    try {
                        readyLock.wait(wait);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return connectedCount() > 0;
                    }
                }
            }
            return false;
        }

        /**
         * 复用所有当前已连上的长连接（MQTT + Nostr）并发广播一条密文载荷，返回成功写入的节点数。
         */
        public int broadcastPayload(String plainPayloadJson) {
            if (closed.get() || plainPayloadJson == null) return 0;
            int sent = 0;

            List<MqttSignaling.Client> mCopy;
            synchronized (mqttClients) {
                mCopy = new ArrayList<MqttSignaling.Client>(mqttClients);
            }
            if (!mCopy.isEmpty()) {
                byte[] payload = RemoteCrypto.encryptSignalPayload(sharedSecret, plainPayloadJson)
                        .getBytes(StandardCharsets.UTF_8);
                for (MqttSignaling.Client c : mCopy) {
                    try {
                        c.publish(mqttTopic, payload, 1);
                        sent++;
                    } catch (Throwable ignored) {
                    }
                }
            }

            List<MiniWebSocket> nCopy;
            synchronized (nostrSockets) {
                nCopy = new ArrayList<MiniWebSocket>(nostrSockets);
            }
            if (!nCopy.isEmpty()) {
                String ev = buildSignedEventJson(ephNostrSec, topicHex, sharedSecret, plainPayloadJson,
                        System.currentTimeMillis() / 1000L);
                String frame = "[\"EVENT\"," + ev + "]";
                for (MiniWebSocket ws : nCopy) {
                    try {
                        ws.sendText(frame);
                        sent++;
                    } catch (Throwable ignored) {
                    }
                }
            }
            return sent;
        }

        /** 兼容旧调用：向所有已连上的 Nostr 长连接发送原始事件帧。 */
        public boolean broadcastFrame(String frameJson) {
            boolean sent = false;
            List<MiniWebSocket> copy;
            synchronized (nostrSockets) {
                copy = new ArrayList<MiniWebSocket>(nostrSockets);
            }
            for (MiniWebSocket ws : copy) {
                try {
                    ws.sendText(frameJson);
                    sent = true;
                } catch (Throwable ignored) {
                }
            }
            return sent;
        }

        public void close() {
            if (!closed.compareAndSet(false, true)) return;
            notifyReady();
            synchronized (mqttClients) {
                for (MqttSignaling.Client c : mqttClients) c.closeQuietly();
                mqttClients.clear();
            }
            synchronized (nostrSockets) {
                for (MiniWebSocket ws : nostrSockets) ws.closeQuietly();
                nostrSockets.clear();
            }
        }
    }

    // ------------------------------------------------------------------ RFC 6455 WebSocket 客户端（含 SNI / 分片续传 / PING 保活）

    static final class MiniWebSocket {
        private final Socket sock;
        private final InputStream in;
        private final OutputStream out;

        private MiniWebSocket(Socket sock, InputStream in, OutputStream out) {
            this.sock = sock;
            this.in = in;
            this.out = out;
        }

        static MiniWebSocket connect(String url, int timeoutMs) throws IOException {
            URI uri = URI.create(url.trim());
            String scheme = uri.getScheme();
            boolean tls = "wss".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) throw new IOException("invalid WS host: " + url);
            int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
            String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty()) ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty()) path += "?" + uri.getRawQuery();

            Socket s;
            if (tls) {
                SSLSocket ssl = (SSLSocket) SSLSocketFactory.getDefault().createSocket();
                try {
                    SSLParameters params = ssl.getSSLParameters();
                    params.setServerNames(Collections.singletonList(new SNIHostName(host)));
                    ssl.setSSLParameters(params);
                } catch (Throwable ignored) {
                }
                ssl.connect(new InetSocketAddress(host, port), timeoutMs);
                ssl.setSoTimeout(timeoutMs);
                ssl.startHandshake();
                s = ssl;
            } else {
                s = new Socket();
                s.connect(new InetSocketAddress(host, port), timeoutMs);
                s.setSoTimeout(timeoutMs);
            }
            s.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(s.getInputStream(), 32768);
            OutputStream out = s.getOutputStream();
            String wsKey = RemoteCrypto.b64Encode(RemoteCrypto.randomBytes(16));
            String req = "GET " + path + " HTTP/1.1\r\n"
                    + "Host: " + host + (port == (tls ? 443 : 80) ? "" : (":" + port)) + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + wsKey + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n\r\n";
            out.write(req.getBytes(StandardCharsets.UTF_8));
            out.flush();

            String status = readHttpLine(in);
            if (status == null || !status.contains(" 101 ")) {
                s.close();
                throw new IOException("WS handshake rejected: " + status);
            }
            while (true) {
                String line = readHttpLine(in);
                if (line == null || line.isEmpty()) break;
            }
            return new MiniWebSocket(s, in, out);
        }

        synchronized void sendText(String text) throws IOException {
            sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
        }

        synchronized void sendPing() throws IOException {
            sendFrame(0x9, new byte[0]);
        }

        private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream(payload.length + 14);
            buf.write(0x80 | (opcode & 0x0F));
            int len = payload.length;
            if (len < 126) {
                buf.write(0x80 | len);
            } else if (len < 65536) {
                buf.write(0x80 | 126);
                buf.write((len >>> 8) & 0xFF);
                buf.write(len & 0xFF);
            } else {
                buf.write(0x80 | 127);
                for (int i = 7; i >= 0; i--) buf.write((int) ((len >>> (i * 8)) & 0xFF));
            }
            byte[] mask = RemoteCrypto.randomBytes(4);
            buf.write(mask);
            for (int i = 0; i < len; i++) {
                buf.write((payload[i] ^ mask[i & 3]) & 0xFF);
            }
            out.write(buf.toByteArray());
            out.flush();
        }

        /** 读取一条完整文本消息（支持分片续传帧），超时时抛 SocketTimeoutException。 */
        String readText(int timeoutMs) throws IOException {
            sock.setSoTimeout(timeoutMs);
            ByteArrayOutputStream fragBuf = null;
            while (true) {
                int b0 = in.read();
                if (b0 < 0) return null;
                int b1 = in.read();
                if (b1 < 0) throw new EOFException();
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) {
                    len = ((readByte() & 0xFF) << 8) | (readByte() & 0xFF);
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | (readByte() & 0xFF);
                }
                if (len > 4 * 1024 * 1024) throw new IOException("WS frame too large");
                byte[] mask = masked ? readFully(4) : null;
                byte[] body = readFully((int) len);
                if (mask != null) {
                    for (int i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
                }
                if (opcode == 0x8) return null; // Close
                if (opcode == 0x9) { // Ping -> Pong
                    sendFrame(0xA, body);
                    continue;
                }
                if (opcode == 0xA) continue; // Pong
                if (opcode == 0x1) {
                    if (fin && fragBuf == null) {
                        return new String(body, StandardCharsets.UTF_8);
                    }
                    fragBuf = new ByteArrayOutputStream();
                    fragBuf.write(body);
                    if (fin) return new String(fragBuf.toByteArray(), StandardCharsets.UTF_8);
                } else if (opcode == 0x0 && fragBuf != null) {
                    fragBuf.write(body);
                    if (fragBuf.size() > 4 * 1024 * 1024) throw new IOException("WS fragmented msg too large");
                    if (fin) return new String(fragBuf.toByteArray(), StandardCharsets.UTF_8);
                }
            }
        }

        /** 长连保活读取：空闲超时发送 PING 而不是主动断开重连。 */
        String readTextKeepAlive(int idlePingMs) throws IOException {
            boolean awaitingPong = false;
            while (true) {
                try {
                    String s = readText(idlePingMs);
                    awaitingPong = false;
                    return s;
                } catch (SocketTimeoutException timeout) {
                    if (awaitingPong) throw new IOException("WS keepalive timeout");
                    sendPing();
                    awaitingPong = true;
                }
            }
        }

        private int readByte() throws IOException {
            int b = in.read();
            if (b < 0) throw new EOFException();
            return b;
        }

        private byte[] readFully(int n) throws IOException {
            byte[] b = new byte[n];
            int pos = 0;
            while (pos < n) {
                int r = in.read(b, pos, n - pos);
                if (r < 0) throw new EOFException();
                pos += r;
            }
            return b;
        }

        void closeQuietly() {
            try {
                sock.close();
            } catch (Throwable ignored) {
            }
        }

        private static String readHttpLine(InputStream in) throws IOException {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            int prev = -1;
            while (true) {
                int b = in.read();
                if (b < 0) return bos.size() == 0 ? null : new String(bos.toByteArray(), StandardCharsets.UTF_8);
                if (b == '\n') {
                    byte[] arr = bos.toByteArray();
                    int len = (prev == '\r' && arr.length > 0) ? arr.length - 1 : arr.length;
                    return new String(arr, 0, len, StandardCharsets.UTF_8);
                }
                bos.write(b);
                prev = b;
            }
        }
    }

    // ------------------------------------------------------------------ 轻量 JSON 辅助（零依赖）

    static String jsonStr(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 4);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    static String extractJsonString(String json, String key) {
        String pat = "\"" + key + "\"";
        int i = json.indexOf(pat);
        if (i < 0) return null;
        int colon = json.indexOf(':', i + pat.length());
        if (colon < 0) return null;
        int q1 = json.indexOf('"', colon + 1);
        if (q1 < 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int p = q1 + 1; p < json.length(); p++) {
            char c = json.charAt(p);
            if (c == '\\' && p + 1 < json.length()) {
                char n = json.charAt(++p);
                switch (n) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    default: sb.append(n); break;
                }
            } else if (c == '"') {
                return sb.toString();
            } else {
                sb.append(c);
            }
        }
        return null;
    }
}
