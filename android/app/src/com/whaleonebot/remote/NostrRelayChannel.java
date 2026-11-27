package com.whaleonebot.remote;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * [layer: shell-android] 零自建服务器端到端加密公共中继通道（实现 {@link RemoteTransport.FrameChannel}）。
 *
 * <p>同时承载于多协议公共信令池（国内免代理直连 MQTT-TLS + 全球 Nostr WebSocket），
 * 支持 4 路滑动窗口并发发送（消除单车道停等阻塞）与 48KB 单片容量，
 * 双端通过 {@code channelSecret} 做外层 AES-256-GCM 加密，内层再由 {@link RemoteTransport.Session}
 * 做双向 ECDH 会话加密；任何公共节点看不到任何明文、设备名或业务数据。
 */
public final class NostrRelayChannel implements RemoteTransport.FrameChannel {

    private static final int CHUNK_BYTES = 48 * 1024;
    /** 滑动窗口上限：允许最多 4 个逻辑包同时在途，不让快照/心跳堵住点击页面的 RPC。 */
    private static final int MAX_IN_FLIGHT = 4;

    private final List<String> relays;
    private final String sessionId;
    private final String myRole;
    private final byte[] channelSecret;
    private final NostrSignaling.Subscription sub;

    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicInteger txSeq = new AtomicInteger(1);
    private final Semaphore inFlightWindow = new Semaphore(MAX_IN_FLIGHT);
    private final ConcurrentHashMap<Integer, CountDownLatch> acks = new ConcurrentHashMap<Integer, CountDownLatch>();
    private final BlockingQueue<byte[]> rxQueue = new LinkedBlockingQueue<byte[]>();
    private final ConcurrentHashMap<Integer, byte[][]> reassembly = new ConcurrentHashMap<Integer, byte[][]>();
    private final ConcurrentHashMap<Integer, Integer> reassemblyCount = new ConcurrentHashMap<Integer, Integer>();
    private volatile int nextExpectedSeq = 1;
    private final ConcurrentHashMap<Integer, byte[]> outOfOrder = new ConcurrentHashMap<Integer, byte[]>();

    public NostrRelayChannel(List<String> relays, String sessionId, String myRole, byte[] baseSecret) {
        this.relays = (relays == null || relays.isEmpty()) ? NostrSignaling.DEFAULT_RELAYS : relays;
        this.sessionId = sessionId;
        this.myRole = myRole;
        this.channelSecret = RemoteCrypto.hkdfSha256(
                baseSecret,
                ("whale-relay-ch-" + sessionId).getBytes(StandardCharsets.UTF_8),
                "whale-relay-v1".getBytes(StandardCharsets.UTF_8),
                32
        );
        this.sub = NostrSignaling.subscribe(this.relays, this.channelSecret, (json, relay) -> onSignal(json));
    }

    /** 等待足够多节点完成订阅（优先 ≥2 个交集，半程退化 ≥1 个），彻底消除首包丢包与单节点失配。 */
    public boolean awaitReady(int timeoutMs) {
        return sub.awaitReady(Math.min(2, relays.size()), timeoutMs);
    }

    public int connectedRelayCount() {
        return sub.connectedCount();
    }

    /** 通过所有已就绪长连接并发广播密文分片；若在线节点不足 2 个，同步补发短连覆盖全池防单节点失配。 */
    private void publishJson(final String payloadJson) {
        int sent = sub.broadcastPayload(payloadJson);
        if (sent < Math.min(2, relays.size())) {
            Thread fallback = new Thread(() -> NostrSignaling.publish(relays, channelSecret, payloadJson, 3000),
                    "relay-pub-fb");
            fallback.setDaemon(true);
            fallback.start();
        }
    }

    @Override
    public synchronized void writePacket(final byte[] packet) throws IOException {
        if (closed.get()) throw new IOException("relay channel closed");
        try {
            if (!inFlightWindow.tryAcquire(12_000L, TimeUnit.MILLISECONDS)) {
                throw new IOException("加密中继发送窗口繁忙");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted", e);
        }
        final int seq = txSeq.getAndIncrement();
        final int frags = Math.max(1, (packet.length + CHUNK_BYTES - 1) / CHUNK_BYTES);
        final CountDownLatch ack = new CountDownLatch(1);
        acks.put(seq, ack);
        // 首帧立即发送（保持严格 FIFO 顺序），ACK 等待与重传交由后台线程执行，释放调用方实现 4 路并发流水线
        final String[] frames = new String[frags];
        for (int idx = 0; idx < frags; idx++) {
            int off = idx * CHUNK_BYTES;
            int len = Math.min(CHUNK_BYTES, packet.length - off);
            byte[] slice = new byte[len];
            System.arraycopy(packet, off, slice, 0, len);
            frames[idx] = "{\"t\":\"d\",\"r\":" + NostrSignaling.jsonStr(myRole)
                    + ",\"q\":\"" + seq + "\",\"i\":\"" + idx + "\",\"n\":\"" + frags
                    + "\",\"b\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(slice)) + "}";
            publishJson(frames[idx]);
        }
        Thread ackWatcher = new Thread(() -> {
            try {
                for (int attempt = 0; attempt < 7 && !closed.get(); attempt++) {
                    if (attempt > 0) {
                        for (String f : frames) publishJson(f);
                    }
                    if (ack.await(1100L + attempt * 550L, TimeUnit.MILLISECONDS)) {
                        return;
                    }
                }
                if (!closed.get()) {
                    close();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                acks.remove(seq);
                inFlightWindow.release();
            }
        }, "relay-ack-" + seq);
        ackWatcher.setDaemon(true);
        ackWatcher.start();
    }

    @Override
    public byte[] readPacket() throws IOException {
        try {
            while (!closed.get()) {
                byte[] p = rxQueue.poll(1000, TimeUnit.MILLISECONDS);
                if (p != null) return p;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        throw new EOFException("relay channel closed");
    }

    private void onSignal(String json) {
        if (json == null || closed.get()) return;
        String role = NostrSignaling.extractJsonString(json, "r");
        if (myRole.equals(role)) return; // 忽略自己回环收到的消息
        String type = NostrSignaling.extractJsonString(json, "t");
        int seq = parseInt(NostrSignaling.extractJsonString(json, "q"), -1);
        if (seq <= 0) return;

        if ("a".equals(type)) {
            CountDownLatch l = acks.get(seq);
            if (l != null) l.countDown();
            return;
        }
        if (!"d".equals(type)) return;
        int idx = parseInt(NostrSignaling.extractJsonString(json, "i"), -1);
        int cnt = parseInt(NostrSignaling.extractJsonString(json, "n"), -1);
        String b64 = NostrSignaling.extractJsonString(json, "b");
        if (idx < 0 || cnt <= 0 || idx >= cnt || cnt > 256 || b64 == null) return;

        if (seq < nextExpectedSeq) {
            sendAck(seq);
            return;
        }
        byte[] part;
        try {
            part = RemoteCrypto.b64UrlDecode(b64);
        } catch (Throwable ignored) {
            return;
        }
        byte[][] slots = reassembly.computeIfAbsent(seq, k -> new byte[cnt][]);
        if (slots.length == cnt && slots[idx] == null) {
            slots[idx] = part;
            int got = reassemblyCount.merge(seq, 1, (a, b) -> a + b);
            if (got == cnt) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                for (byte[] s : slots) {
                    try { bos.write(s); } catch (IOException ignored) {}
                }
                reassembly.remove(seq);
                reassemblyCount.remove(seq);
                sendAck(seq);
                deliverOrdered(seq, bos.toByteArray());
            }
        }
    }

    private synchronized void deliverOrdered(int seq, byte[] msg) {
        if (seq == nextExpectedSeq) {
            rxQueue.offer(msg);
            nextExpectedSeq++;
            while (outOfOrder.containsKey(nextExpectedSeq)) {
                rxQueue.offer(outOfOrder.remove(nextExpectedSeq));
                nextExpectedSeq++;
            }
        } else if (seq > nextExpectedSeq) {
            outOfOrder.putIfAbsent(seq, msg);
        }
    }

    private void sendAck(int seq) {
        String json = "{\"t\":\"a\",\"r\":" + NostrSignaling.jsonStr(myRole) + ",\"q\":\"" + seq + "\"}";
        publishJson(json);
    }

    private static int parseInt(String s, int def) {
        try {
            return s == null ? def : Integer.parseInt(s);
        } catch (Exception e) {
            return def;
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) return;
        sub.close();
    }

    @Override
    public String remoteLabel() {
        return "encrypted-relay://" + sessionId;
    }
}
