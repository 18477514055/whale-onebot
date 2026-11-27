package com.whaleonebot.remote;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * [layer: shell-android] 端到端加密远程控制会话与传输层（支持 TCP 直连 + UDP 打洞可靠通道）。
 *
 * <p>帧格式（加密后）：
 * <pre>
 *   [4B length][1B frameType][8B seq][AES-256-GCM(payload) + 16B tag]
 * </pre>
 * 支持多路复用 RPC、毫秒级 RTT 心跳、以及 64 KB 分块 SHA-256 校验的双向流式文件传输（备份与 .deb 互传）。
 */
public final class RemoteTransport {

    public static final byte T_HELLO = 1;
    public static final byte T_AUTH = 2;
    public static final byte T_PING = 3;
    public static final byte T_PONG = 4;
    public static final byte T_RPC_REQ = 5;
    public static final byte T_RPC_RES = 6;
    public static final byte T_EVENT = 7;
    public static final byte T_STREAM_OPEN = 8;
    public static final byte T_STREAM_CHUNK = 9;
    public static final byte T_STREAM_END = 10;
    public static final byte T_STREAM_ERR = 11;
    public static final byte T_CLOSE = 12;

    public static final int MAX_FRAME_BYTES = 2 * 1024 * 1024;
    public static final int STREAM_CHUNK_SIZE = 65536;

    private RemoteTransport() {
    }

    /** 底层有序字节包通道（TCP 或 UDP 打洞可靠层均可实现）。 */
    public interface FrameChannel {
        void writePacket(byte[] packet) throws IOException;
        byte[] readPacket() throws IOException;
        void close();
        String remoteLabel();
    }

    /** TCP 通道实现（局域网 / IPv6 / 自定义直连 / Tailscale）。 */
    public static final class TcpChannel implements FrameChannel {
        private final Socket sock;
        private final DataInputStream in;
        private final DataOutputStream out;

        public TcpChannel(Socket sock) throws IOException {
            this.sock = sock;
            this.sock.setTcpNoDelay(true);
            this.in = new DataInputStream(new BufferedInputStream(sock.getInputStream(), 65536));
            this.out = new DataOutputStream(sock.getOutputStream());
        }

        @Override
        public synchronized void writePacket(byte[] packet) throws IOException {
            out.writeInt(packet.length);
            out.write(packet);
            out.flush();
        }

        @Override
        public byte[] readPacket() throws IOException {
            int len = in.readInt();
            if (len <= 0 || len > MAX_FRAME_BYTES) throw new IOException("bad frame len: " + len);
            byte[] buf = new byte[len];
            in.readFully(buf);
            return buf;
        }

        @Override
        public void close() {
            try {
                sock.close();
            } catch (Throwable ignored) {
            }
        }

        @Override
        public String remoteLabel() {
            return String.valueOf(sock.getRemoteSocketAddress());
        }
    }

    /**
     * 基于 UDP 打洞的轻量可靠有序通道（用于 STUN 穿透后的直连加密通信）。
     *
     * <p>包格式：{@code [4B magic "WUDP"][1B kind: 1=DATA 2=ACK 3=PUNCH][4B msgSeq][2B fragIdx][2B fragCount][payload]}
     */
    public static final class UdpReliableChannel implements FrameChannel {
        private static final int MAGIC = 0x57554450; // "WUDP"
        private static final byte K_DATA = 1;
        private static final byte K_ACK = 2;
        private static final byte K_PUNCH = 3;
        private static final int FRAG_MTU = 1100;

        private final DatagramSocket socket;
        private final InetSocketAddress peer;
        private final boolean ownsSocket;
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private final AtomicLong txSeq = new AtomicLong(1);
        private final ConcurrentHashMap<Integer, CountDownLatch> acks = new ConcurrentHashMap<Integer, CountDownLatch>();
        private final BlockingQueue<byte[]> rxQueue = new LinkedBlockingQueue<byte[]>();
        private final ConcurrentHashMap<Integer, byte[][]> reassembly = new ConcurrentHashMap<Integer, byte[][]>();
        private final ConcurrentHashMap<Integer, Integer> reassemblyCount = new ConcurrentHashMap<Integer, Integer>();
        private volatile int nextExpectedSeq = 1;
        private final ConcurrentHashMap<Integer, byte[]> outOfOrder = new ConcurrentHashMap<Integer, byte[]>();

        public UdpReliableChannel(DatagramSocket socket, InetSocketAddress peer, boolean ownsSocket) {
            this.socket = socket;
            this.peer = peer;
            this.ownsSocket = ownsSocket;
            Thread rx = new Thread(this::rxLoop, "udp-rel-rx");
            rx.setDaemon(true);
            rx.start();
        }

        /** 向对端连续发送 UDP 打洞包，打开双方 NAT 映射表项。 */
        public void sendPunchBurst(int count, int intervalMs) {
            ByteBuffer bb = ByteBuffer.allocate(13);
            bb.putInt(MAGIC).put(K_PUNCH).putInt(0).putShort((short) 0).putShort((short) 0);
            byte[] p = bb.array();
            for (int i = 0; i < count && !closed.get(); i++) {
                try {
                    socket.send(new DatagramPacket(p, p.length, peer));
                    if (i + 1 < count) Thread.sleep(intervalMs);
                } catch (Throwable ignored) {
                    break;
                }
            }
        }

        @Override
        public synchronized void writePacket(byte[] packet) throws IOException {
            if (closed.get()) throw new IOException("udp channel closed");
            int seq = (int) txSeq.getAndIncrement();
            int frags = Math.max(1, (packet.length + FRAG_MTU - 1) / FRAG_MTU);
            CountDownLatch ack = new CountDownLatch(1);
            acks.put(seq, ack);
            try {
                for (int attempt = 0; attempt < 10 && !closed.get(); attempt++) {
                    for (int idx = 0; idx < frags; idx++) {
                        int off = idx * FRAG_MTU;
                        int len = Math.min(FRAG_MTU, packet.length - off);
                        ByteBuffer bb = ByteBuffer.allocate(13 + len);
                        bb.putInt(MAGIC).put(K_DATA).putInt(seq).putShort((short) idx).putShort((short) frags);
                        bb.put(packet, off, len);
                        byte[] raw = bb.array();
                        socket.send(new DatagramPacket(raw, raw.length, peer));
                    }
                    if (ack.await(350L + attempt * 150L, TimeUnit.MILLISECONDS)) {
                        return;
                    }
                }
                throw new IOException("UDP send timeout seq=" + seq);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("interrupted", e);
            } finally {
                acks.remove(seq);
            }
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
            throw new EOFException("udp channel closed");
        }

        private void rxLoop() {
            byte[] buf = new byte[2048];
            while (!closed.get()) {
                try {
                    DatagramPacket dp = new DatagramPacket(buf, buf.length);
                    socket.receive(dp);
                    if (dp.getLength() < 13) continue;
                    ByteBuffer bb = ByteBuffer.wrap(dp.getData(), 0, dp.getLength());
                    if (bb.getInt() != MAGIC) continue;
                    byte kind = bb.get();
                    int seq = bb.getInt();
                    int idx = bb.getShort() & 0xFFFF;
                    int count = bb.getShort() & 0xFFFF;
                    if (kind == K_PUNCH) continue;
                    if (kind == K_ACK) {
                        CountDownLatch l = acks.get(seq);
                        if (l != null) l.countDown();
                        continue;
                    }
                    if (kind == K_DATA && count > 0 && idx < count && count <= 2048) {
                        if (seq < nextExpectedSeq) {
                            sendAck(seq);
                            continue;
                        }
                        byte[] payload = new byte[dp.getLength() - 13];
                        bb.get(payload);
                        byte[][] slots = reassembly.computeIfAbsent(seq, k -> new byte[count][]);
                        if (slots.length == count && slots[idx] == null) {
                            slots[idx] = payload;
                            int got = reassemblyCount.merge(seq, 1, (a, b) -> a + b);
                            if (got == count) {
                                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                                for (byte[] part : slots) bos.write(part);
                                reassembly.remove(seq);
                                reassemblyCount.remove(seq);
                                sendAck(seq);
                                deliverOrdered(seq, bos.toByteArray());
                            }
                        }
                    }
                } catch (Throwable t) {
                    if (closed.get()) break;
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
            try {
                ByteBuffer bb = ByteBuffer.allocate(13);
                bb.putInt(MAGIC).put(K_ACK).putInt(seq).putShort((short) 0).putShort((short) 0);
                byte[] p = bb.array();
                socket.send(new DatagramPacket(p, p.length, peer));
            } catch (Throwable ignored) {
            }
        }

        @Override
        public void close() {
            closed.set(true);
            if (ownsSocket) {
                try {
                    socket.close();
                } catch (Throwable ignored) {
                }
            }
        }

        @Override
        public String remoteLabel() {
            return "udp://" + peer.getAddress().getHostAddress() + ":" + peer.getPort();
        }
    }

    // ------------------------------------------------------------------ 加密多路复用会话

    public interface RpcHandler {
        /** 处理远端 RPC 请求，返回 JSON 字符串响应体。 */
        String handleRpc(String method, String paramsJson, Session session) throws Exception;
    }

    public interface StreamReceiver {
        /** 处理远端发来的上传流（例如推送备份文件或 QQ .deb 到被控端）。 */
        void onUploadStream(String streamId, String metaJson, InputStream data, Session session) throws Exception;
        /** 处理远端请求的下载流（例如流式导出备份到控制端）。 */
        void onDownloadStream(String streamId, String metaJson, OutputStream out, Session session) throws Exception;
    }

    public interface SessionListener {
        void onDisconnected(Session session, String reason);
    }

    public interface ProgressCallback {
        void onProgress(long transferredBytes, long totalBytes);
    }

    public interface ServerAuthenticator {
        /**
         * 校验客户端握手身份：
         * 若客户端携带配对证明（60 秒单次密钥），自动入库并消耗配对票据；
         * 否则校验该客户端是否在未吊销的已授权列表内。
         */
        AuthDecision authenticate(String clientDeviceId, String clientName, byte[] clientPubKeyX509,
                                  byte[] transcript, byte[] clientSig, byte[] pairHmac);
    }

    public static final class AuthDecision {
        public final boolean allowed;
        public final String permission;
        public final String error;
        public final boolean newlyPaired;

        private AuthDecision(boolean allowed, String permission, String error, boolean newlyPaired) {
            this.allowed = allowed;
            this.permission = permission;
            this.error = error;
            this.newlyPaired = newlyPaired;
        }

        public static AuthDecision allow(String permission, boolean newlyPaired) {
            return new AuthDecision(true, permission == null ? "full" : permission, "", newlyPaired);
        }

        public static AuthDecision deny(String error) {
            return new AuthDecision(false, "", error == null ? "未授权" : error, false);
        }
    }

    public static final class HandshakeResult {
        public final Session session;
        public final String peerDeviceId;
        public final String peerName;
        public final String peerPubKeyB64;
        public final String permission;
        public final byte[] sharedSecret;

        HandshakeResult(Session session, String peerDeviceId, String peerName, String peerPubKeyB64,
                        String permission, byte[] sharedSecret) {
            this.session = session;
            this.peerDeviceId = peerDeviceId;
            this.peerName = peerName;
            this.peerPubKeyB64 = peerPubKeyB64;
            this.permission = permission;
            this.sharedSecret = sharedSecret;
        }
    }

    /** 客户端发起端到端双向认证握手（支持首次 60 秒配对密钥，或已配对重连）。 */
    public static HandshakeResult handshakeAsClient(
            FrameChannel channel,
            String myDeviceId, String myDeviceName, PrivateKey myPriv, byte[] myPubX509,
            String expectedPeerDeviceId, byte[] expectedPeerPubX509,
            byte[] pairSecretOrNull,
            RpcHandler rpcHandler, StreamReceiver streamReceiver, SessionListener listener
    ) throws IOException {
        KeyPair eph = RemoteCrypto.generateEcKeyPair();
        byte[] ephPub = eph.getPublic().getEncoded();
        byte[] clientNonce = RemoteCrypto.randomBytes(16);

        byte[] transcript = RemoteCrypto.sha256(
                "whale-hs-v1".getBytes(StandardCharsets.UTF_8),
                myPubX509, expectedPeerPubX509, ephPub, clientNonce
        );
        byte[] sig = RemoteCrypto.signEcdsa(myPriv, transcript);
        String pairHmacB64 = pairSecretOrNull == null ? ""
                : RemoteCrypto.b64UrlEncode(RemoteCrypto.hmacSha256(pairSecretOrNull, transcript));

        String helloJson = "{\"id\":" + NostrSignaling.jsonStr(myDeviceId)
                + ",\"name\":" + NostrSignaling.jsonStr(myDeviceName)
                + ",\"pk\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(myPubX509))
                + ",\"eph\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(ephPub))
                + ",\"nonce\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(clientNonce))
                + ",\"sig\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(sig))
                + ",\"pair\":" + NostrSignaling.jsonStr(pairHmacB64) + "}";

        channel.writePacket(wrapPlain(T_HELLO, helloJson.getBytes(StandardCharsets.UTF_8)));

        byte[] respRaw = channel.readPacket();
        if (respRaw.length < 2 || respRaw[0] != T_AUTH) {
            throw new IOException("远端握手响应格式错误");
        }
        String authJson = new String(respRaw, 1, respRaw.length - 1, StandardCharsets.UTF_8);
        String okStr = NostrSignaling.extractJsonString(authJson, "ok");
        if (!"1".equals(okStr)) {
            String err = NostrSignaling.extractJsonString(authJson, "err");
            throw new IOException("远端拒绝连接：" + (err == null ? "未授权" : err));
        }
        String srvId = NostrSignaling.extractJsonString(authJson, "id");
        String srvName = NostrSignaling.extractJsonString(authJson, "name");
        String srvPkB64 = NostrSignaling.extractJsonString(authJson, "pk");
        String srvEphB64 = NostrSignaling.extractJsonString(authJson, "eph");
        String srvNonceB64 = NostrSignaling.extractJsonString(authJson, "nonce");
        String srvSigB64 = NostrSignaling.extractJsonString(authJson, "sig");
        String perm = NostrSignaling.extractJsonString(authJson, "perm");
        if (srvId == null || srvPkB64 == null || srvEphB64 == null || srvNonceB64 == null || srvSigB64 == null) {
            throw new IOException("远端握手字段不完整");
        }
        byte[] srvPub = RemoteCrypto.b64UrlDecode(srvPkB64);
        if (!expectedPeerDeviceId.equals(srvId) || !Arrays.equals(expectedPeerPubX509, srvPub)) {
            throw new SecurityException("远端公钥与已配对记录不匹配（已拦截）");
        }
        byte[] srvEph = RemoteCrypto.b64UrlDecode(srvEphB64);
        byte[] srvNonce = RemoteCrypto.b64UrlDecode(srvNonceB64);
        byte[] srvSig = RemoteCrypto.b64UrlDecode(srvSigB64);

        byte[] fullTranscript = RemoteCrypto.sha256(transcript, srvEph, srvNonce);
        if (!RemoteCrypto.verifyEcdsa(RemoteCrypto.decodePublicKey(srvPub), fullTranscript, srvSig)) {
            throw new SecurityException("远端身份签名验证失败");
        }

        byte[] ecdhSecret = RemoteCrypto.ecdh(eph.getPrivate(), RemoteCrypto.decodePublicKey(srvEph));
        byte[] master = RemoteCrypto.hkdfSha256(ecdhSecret, fullTranscript,
                "whale-session-v1".getBytes(StandardCharsets.UTF_8), 72);
        byte[] c2sKey = Arrays.copyOfRange(master, 0, 32);
        byte[] s2cKey = Arrays.copyOfRange(master, 32, 64);
        byte[] c2sSalt = Arrays.copyOfRange(master, 64, 68);
        byte[] s2cSalt = Arrays.copyOfRange(master, 68, 72);
        byte[] persistentSecret = RemoteCrypto.hkdfSha256(
                RemoteCrypto.ecdh(myPriv, RemoteCrypto.decodePublicKey(srvPub)),
                null, "whale-pair-shared-v1".getBytes(StandardCharsets.UTF_8), 32);

        Session session = new Session(channel, srvId, srvName == null ? srvId : srvName,
                perm == null ? "full" : perm, c2sKey, c2sSalt, s2cKey, s2cSalt,
                rpcHandler, streamReceiver, listener);
        session.startReader();
        return new HandshakeResult(session, srvId, srvName == null ? srvId : srvName, srvPkB64,
                perm == null ? "full" : perm, persistentSecret);
    }

    /** 服务端（被控端）接受端到端双向认证握手。 */
    public static HandshakeResult handshakeAsServer(
            FrameChannel channel,
            String myDeviceId, String myDeviceName, PrivateKey myPriv, byte[] myPubX509,
            ServerAuthenticator authenticator,
            RpcHandler rpcHandler, StreamReceiver streamReceiver, SessionListener listener
    ) throws IOException {
        byte[] helloRaw = channel.readPacket();
        if (helloRaw.length < 2 || helloRaw[0] != T_HELLO) {
            throw new IOException("客户端握手包格式错误");
        }
        String helloJson = new String(helloRaw, 1, helloRaw.length - 1, StandardCharsets.UTF_8);
        String cliId = NostrSignaling.extractJsonString(helloJson, "id");
        String cliName = NostrSignaling.extractJsonString(helloJson, "name");
        String cliPkB64 = NostrSignaling.extractJsonString(helloJson, "pk");
        String cliEphB64 = NostrSignaling.extractJsonString(helloJson, "eph");
        String cliNonceB64 = NostrSignaling.extractJsonString(helloJson, "nonce");
        String cliSigB64 = NostrSignaling.extractJsonString(helloJson, "sig");
        String pairB64 = NostrSignaling.extractJsonString(helloJson, "pair");
        if (cliId == null || cliPkB64 == null || cliEphB64 == null || cliNonceB64 == null || cliSigB64 == null) {
            sendAuthError(channel, "握手字段不完整");
            throw new IOException("missing hello fields");
        }
        byte[] cliPub = RemoteCrypto.b64UrlDecode(cliPkB64);
        if (!cliId.equals(RemoteCrypto.deviceIdOf(cliPub))) {
            sendAuthError(channel, "设备指纹与公钥不匹配");
            throw new SecurityException("bad client deviceId");
        }
        byte[] cliEph = RemoteCrypto.b64UrlDecode(cliEphB64);
        byte[] cliNonce = RemoteCrypto.b64UrlDecode(cliNonceB64);
        byte[] cliSig = RemoteCrypto.b64UrlDecode(cliSigB64);
        byte[] pairHmac = (pairB64 == null || pairB64.isEmpty()) ? null : RemoteCrypto.b64UrlDecode(pairB64);

        byte[] transcript = RemoteCrypto.sha256(
                "whale-hs-v1".getBytes(StandardCharsets.UTF_8),
                cliPub, myPubX509, cliEph, cliNonce
        );
        if (!RemoteCrypto.verifyEcdsa(RemoteCrypto.decodePublicKey(cliPub), transcript, cliSig)) {
            sendAuthError(channel, "客户端签名验证失败");
            throw new SecurityException("bad client signature");
        }

        AuthDecision decision = authenticator.authenticate(cliId, cliName == null ? "控制端" : cliName,
                cliPub, transcript, cliSig, pairHmac);
        if (decision == null || !decision.allowed) {
            sendAuthError(channel, decision == null ? "未授权" : decision.error);
            throw new SecurityException("client denied: " + (decision == null ? "null" : decision.error));
        }

        KeyPair srvEph = RemoteCrypto.generateEcKeyPair();
        byte[] srvEphPub = srvEph.getPublic().getEncoded();
        byte[] srvNonce = RemoteCrypto.randomBytes(16);
        byte[] fullTranscript = RemoteCrypto.sha256(transcript, srvEphPub, srvNonce);
        byte[] srvSig = RemoteCrypto.signEcdsa(myPriv, fullTranscript);

        String authJson = "{\"ok\":\"1\",\"id\":" + NostrSignaling.jsonStr(myDeviceId)
                + ",\"name\":" + NostrSignaling.jsonStr(myDeviceName)
                + ",\"pk\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(myPubX509))
                + ",\"eph\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(srvEphPub))
                + ",\"nonce\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(srvNonce))
                + ",\"sig\":" + NostrSignaling.jsonStr(RemoteCrypto.b64UrlEncode(srvSig))
                + ",\"perm\":" + NostrSignaling.jsonStr(decision.permission) + "}";
        channel.writePacket(wrapPlain(T_AUTH, authJson.getBytes(StandardCharsets.UTF_8)));

        byte[] ecdhSecret = RemoteCrypto.ecdh(srvEph.getPrivate(), RemoteCrypto.decodePublicKey(cliEph));
        byte[] master = RemoteCrypto.hkdfSha256(ecdhSecret, fullTranscript,
                "whale-session-v1".getBytes(StandardCharsets.UTF_8), 72);
        byte[] c2sKey = Arrays.copyOfRange(master, 0, 32);
        byte[] s2cKey = Arrays.copyOfRange(master, 32, 64);
        byte[] c2sSalt = Arrays.copyOfRange(master, 64, 68);
        byte[] s2cSalt = Arrays.copyOfRange(master, 68, 72);
        byte[] persistentSecret = RemoteCrypto.hkdfSha256(
                RemoteCrypto.ecdh(myPriv, RemoteCrypto.decodePublicKey(cliPub)),
                null, "whale-pair-shared-v1".getBytes(StandardCharsets.UTF_8), 32);

        // 服务端发送用 s2c，接收用 c2s
        Session session = new Session(channel, cliId, cliName == null ? cliId : cliName,
                decision.permission, s2cKey, s2cSalt, c2sKey, c2sSalt,
                rpcHandler, streamReceiver, listener);
        session.startReader();
        return new HandshakeResult(session, cliId, cliName == null ? cliId : cliName, cliPkB64,
                decision.permission, persistentSecret);
    }

    private static void sendAuthError(FrameChannel channel, String reason) {
        try {
            String err = "{\"ok\":\"0\",\"err\":" + NostrSignaling.jsonStr(reason) + "}";
            channel.writePacket(wrapPlain(T_AUTH, err.getBytes(StandardCharsets.UTF_8)));
        } catch (Throwable ignored) {
        }
    }

    private static byte[] wrapPlain(byte type, byte[] payload) {
        byte[] out = new byte[1 + payload.length];
        out[0] = type;
        System.arraycopy(payload, 0, out, 1, payload.length);
        return out;
    }

    // ------------------------------------------------------------------ 加密会话实例

    public static final class Session {
        private final FrameChannel channel;
        public final String peerDeviceId;
        public final String peerName;
        public final String permission;
        private final byte[] txKey, txSalt, rxKey, rxSalt;
        private final RpcHandler rpcHandler;
        private final StreamReceiver streamReceiver;
        private final SessionListener listener;

        private final AtomicLong txSeq = new AtomicLong(1);
        private final AtomicLong lastRxSeq = new AtomicLong(0);
        private final AtomicLong nextReqId = new AtomicLong(1);
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private volatile long lastActivityAt = System.currentTimeMillis();

        private final Map<String, PendingRpc> pendingRpcs = new ConcurrentHashMap<String, PendingRpc>();
        private final Map<String, PendingPing> pendingPings = new ConcurrentHashMap<String, PendingPing>();
        private final Map<String, IncomingStream> incomingStreams = new ConcurrentHashMap<String, IncomingStream>();

        Session(FrameChannel channel, String peerDeviceId, String peerName, String permission,
                byte[] txKey, byte[] txSalt, byte[] rxKey, byte[] rxSalt,
                RpcHandler rpcHandler, StreamReceiver streamReceiver, SessionListener listener) {
            this.channel = channel;
            this.peerDeviceId = peerDeviceId;
            this.peerName = peerName;
            this.permission = permission;
            this.txKey = txKey;
            this.txSalt = txSalt;
            this.rxKey = rxKey;
            this.rxSalt = rxSalt;
            this.rpcHandler = rpcHandler;
            this.streamReceiver = streamReceiver;
            this.listener = listener;
        }

        public boolean isOpen() {
            return !closed.get();
        }

        public long lastActivityAt() {
            return lastActivityAt;
        }

        public String remoteLabel() {
            return channel.remoteLabel();
        }

        void startReader() {
            Thread t = new Thread(this::readLoop, "remote-sess-" + peerDeviceId.substring(0, Math.min(6, peerDeviceId.length())));
            t.setDaemon(true);
            t.start();
        }

        private synchronized void sendEncrypted(byte type, byte[] plain) throws IOException {
            if (closed.get()) throw new IOException("session closed");
            long seq = txSeq.getAndIncrement();
            byte[] iv = RemoteCrypto.makeNonce(txSalt, seq);
            byte[] aad = ByteBuffer.allocate(9).put(type).putLong(seq).array();
            byte[] ct = RemoteCrypto.aesGcmEncrypt(txKey, iv, aad, plain);
            ByteBuffer bb = ByteBuffer.allocate(9 + ct.length);
            bb.put(type).putLong(seq).put(ct);
            channel.writePacket(bb.array());
            lastActivityAt = System.currentTimeMillis();
        }

        /** 发送心跳并返回往返延迟（毫秒）；超时或断开返回 -1。 */
        public long ping(int timeoutMs) {
            if (closed.get()) return -1;
            String id = "p" + nextReqId.getAndIncrement();
            PendingPing pp = new PendingPing(System.currentTimeMillis());
            pendingPings.put(id, pp);
            try {
                sendEncrypted(T_PING, id.getBytes(StandardCharsets.UTF_8));
                if (pp.latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                    return Math.max(1L, pp.doneAt - pp.sentAt);
                }
                return -1;
            } catch (Throwable t) {
                return -1;
            } finally {
                pendingPings.remove(id);
            }
        }

        /** 调用远端 RPC 并等待 JSON 结果。 */
        public String callRpc(String method, String paramsJson, int timeoutMs) throws IOException {
            if (closed.get()) throw new IOException("远程连接已断开");
            String reqId = "r" + nextReqId.getAndIncrement();
            PendingRpc pending = new PendingRpc();
            pendingRpcs.put(reqId, pending);
            try {
                byte[] mBytes = method.getBytes(StandardCharsets.UTF_8);
                byte[] idBytes = reqId.getBytes(StandardCharsets.UTF_8);
                byte[] pBytes = (paramsJson == null ? "{}" : paramsJson).getBytes(StandardCharsets.UTF_8);
                ByteBuffer bb = ByteBuffer.allocate(6 + idBytes.length + mBytes.length + pBytes.length);
                bb.putShort((short) idBytes.length).put(idBytes);
                bb.putShort((short) mBytes.length).put(mBytes);
                bb.putShort((short) 1); // bit0=1: 声明客户端支持 GZIP 压缩 RPC 响应（向下兼容旧版）
                bb.put(pBytes);
                sendEncrypted(T_RPC_REQ, bb.array());
                if (!pending.latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                    throw new IOException("远端响应超时（" + method + "）");
                }
                if (!pending.ok) {
                    throw new IOException(pending.error == null ? "远端执行失败" : pending.error);
                }
                return pending.result;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("等待远端响应被中断", e);
            } finally {
                pendingRpcs.remove(reqId);
            }
        }

        /** 主动向远端上传二进制流（如从控制机推 QQ .deb 或备份包到被控端），返回 SHA-256 十六进制摘要。 */
        public String uploadStream(String metaJson, InputStream data, long totalBytes, ProgressCallback cb) throws IOException {
            String streamId = "u" + nextReqId.getAndIncrement();
            byte[] idBytes = streamId.getBytes(StandardCharsets.UTF_8);
            byte[] metaBytes = (metaJson == null ? "{}" : metaJson).getBytes(StandardCharsets.UTF_8);
            // dir=1 表示发送方主动上传
            ByteBuffer open = ByteBuffer.allocate(3 + idBytes.length + metaBytes.length);
            open.put((byte) 1).putShort((short) idBytes.length).put(idBytes).put(metaBytes);
            sendEncrypted(T_STREAM_OPEN, open.array());

            MessageDigest md;
            try {
                md = MessageDigest.getInstance("SHA-256");
            } catch (Exception e) {
                throw new IOException(e);
            }
            byte[] buf = new byte[STREAM_CHUNK_SIZE];
            long sent = 0;
            int n;
            while ((n = data.read(buf)) > 0) {
                md.update(buf, 0, n);
                ByteBuffer ch = ByteBuffer.allocate(2 + idBytes.length + n);
                ch.putShort((short) idBytes.length).put(idBytes).put(buf, 0, n);
                sendEncrypted(T_STREAM_CHUNK, ch.array());
                sent += n;
                if (cb != null) cb.onProgress(sent, totalBytes);
            }
            String sha = RemoteCrypto.hex(md.digest());
            byte[] shaBytes = sha.getBytes(StandardCharsets.UTF_8);
            ByteBuffer end = ByteBuffer.allocate(2 + idBytes.length + shaBytes.length);
            end.putShort((short) idBytes.length).put(idBytes).put(shaBytes);
            sendEncrypted(T_STREAM_END, end.array());
            return sha;
        }

        /** 从远端拉取二进制流（如流式导出备份到控制机本地存储），自动校验 SHA-256 完整性。 */
        public String downloadStream(String metaJson, OutputStream dest, long expectedBytes,
                                     int timeoutMs, ProgressCallback cb) throws IOException {
            String streamId = "d" + nextReqId.getAndIncrement();
            IncomingStream inc = new IncomingStream();
            incomingStreams.put(streamId, inc);
            try {
                byte[] idBytes = streamId.getBytes(StandardCharsets.UTF_8);
                byte[] metaBytes = (metaJson == null ? "{}" : metaJson).getBytes(StandardCharsets.UTF_8);
                // dir=2 表示请求对端回推下载流
                ByteBuffer open = ByteBuffer.allocate(3 + idBytes.length + metaBytes.length);
                open.put((byte) 2).putShort((short) idBytes.length).put(idBytes).put(metaBytes);
                sendEncrypted(T_STREAM_OPEN, open.array());

                MessageDigest md;
                try {
                    md = MessageDigest.getInstance("SHA-256");
                } catch (Exception e) {
                    throw new IOException(e);
                }
                long got = 0;
                while (true) {
                    byte[] chunk = inc.chunks.poll(timeoutMs, TimeUnit.MILLISECONDS);
                    if (chunk == null) throw new IOException("流式传输超时");
                    if (chunk == IncomingStream.EOF) break;
                    if (chunk == IncomingStream.ERR) {
                        throw new IOException(inc.error == null ? "远端流式传输失败" : inc.error);
                    }
                    md.update(chunk);
                    dest.write(chunk);
                    got += chunk.length;
                    if (cb != null) cb.onProgress(got, expectedBytes);
                }
                dest.flush();
                String actualSha = RemoteCrypto.hex(md.digest());
                if (inc.expectedSha != null && !inc.expectedSha.isEmpty()
                        && !inc.expectedSha.equalsIgnoreCase(actualSha)) {
                    throw new IOException("文件完整性校验失败（SHA-256 不一致）");
                }
                return actualSha;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("下载流被中断", e);
            } finally {
                incomingStreams.remove(streamId);
            }
        }

        private void readLoop() {
            String closeReason = "连接关闭";
            try {
                while (!closed.get()) {
                    byte[] raw = channel.readPacket();
                    if (raw.length < 9 + 16) throw new IOException("encrypted frame too short");
                    ByteBuffer bb = ByteBuffer.wrap(raw);
                    byte type = bb.get();
                    long seq = bb.getLong();
                    if (seq <= lastRxSeq.get()) throw new SecurityException("replay frame seq=" + seq);
                    lastRxSeq.set(seq);
                    byte[] ct = new byte[raw.length - 9];
                    bb.get(ct);
                    byte[] iv = RemoteCrypto.makeNonce(rxSalt, seq);
                    byte[] aad = ByteBuffer.allocate(9).put(type).putLong(seq).array();
                    byte[] plain = RemoteCrypto.aesGcmDecrypt(rxKey, iv, aad, ct);
                    lastActivityAt = System.currentTimeMillis();
                    dispatch(type, plain);
                }
            } catch (Throwable t) {
                closeReason = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
            } finally {
                closeInternal(closeReason);
            }
        }

        private void dispatch(byte type, byte[] plain) throws IOException {
            switch (type) {
                case T_PING:
                    sendEncrypted(T_PONG, plain);
                    break;
                case T_PONG: {
                    String id = new String(plain, StandardCharsets.UTF_8);
                    PendingPing pp = pendingPings.get(id);
                    if (pp != null) {
                        pp.doneAt = System.currentTimeMillis();
                        pp.latch.countDown();
                    }
                    break;
                }
                case T_RPC_REQ:
                    handleIncomingRpc(plain);
                    break;
                case T_RPC_RES:
                    handleIncomingRpcRes(plain);
                    break;
                case T_STREAM_OPEN:
                    handleStreamOpen(plain);
                    break;
                case T_STREAM_CHUNK:
                    handleStreamChunk(plain);
                    break;
                case T_STREAM_END:
                    handleStreamEnd(plain);
                    break;
                case T_STREAM_ERR:
                    handleStreamErr(plain);
                    break;
                case T_CLOSE:
                    closeInternal("对端主动断开");
                    break;
                default:
                    break;
            }
        }

        private void handleIncomingRpc(byte[] plain) {
            ByteBuffer bb = ByteBuffer.wrap(plain);
            int idLen = bb.getShort() & 0xFFFF;
            byte[] idBytes = new byte[idLen];
            bb.get(idBytes);
            int mLen = bb.getShort() & 0xFFFF;
            byte[] mBytes = new byte[mLen];
            bb.get(mBytes);
            final int flags = bb.getShort() & 0xFFFF;
            final boolean acceptGzip = (flags & 1) != 0;
            byte[] pBytes = new byte[bb.remaining()];
            bb.get(pBytes);
            final String reqId = new String(idBytes, StandardCharsets.UTF_8);
            final String method = new String(mBytes, StandardCharsets.UTF_8);
            final String params = new String(pBytes, StandardCharsets.UTF_8);

            Thread worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    boolean ok = false;
                    String body;
                    try {
                        if (rpcHandler == null) throw new UnsupportedOperationException("no rpc handler");
                        body = rpcHandler.handleRpc(method, params, Session.this);
                        if (body == null) body = "{}";
                        ok = true;
                    } catch (Throwable t) {
                        body = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                    }
                    try {
                        byte[] rb = body.getBytes(StandardCharsets.UTF_8);
                        byte status = (byte) (ok ? 1 : 0);
                        if (ok && acceptGzip && rb.length >= 512) {
                            byte[] gz = gzipBytes(rb);
                            if (gz != null && gz.length < rb.length) {
                                rb = gz;
                                status = 2; // 2 = ok + GZIP 压缩体
                            }
                        }
                        ByteBuffer out = ByteBuffer.allocate(3 + idBytes.length + rb.length);
                        out.put(status).putShort((short) idBytes.length).put(idBytes).put(rb);
                        sendEncrypted(T_RPC_RES, out.array());
                    } catch (Throwable ignored) {
                    }
                }
            }, "rpc-" + method);
            worker.setDaemon(true);
            worker.start();
        }

        private void handleIncomingRpcRes(byte[] plain) {
            ByteBuffer bb = ByteBuffer.wrap(plain);
            byte status = bb.get();
            boolean ok = (status == 1 || status == 2);
            int idLen = bb.getShort() & 0xFFFF;
            byte[] idBytes = new byte[idLen];
            bb.get(idBytes);
            byte[] bodyBytes = new byte[bb.remaining()];
            bb.get(bodyBytes);
            if (status == 2) {
                byte[] unzipped = gunzipBytes(bodyBytes);
                if (unzipped != null) bodyBytes = unzipped;
                else ok = false;
            }
            String reqId = new String(idBytes, StandardCharsets.UTF_8);
            String body = new String(bodyBytes, StandardCharsets.UTF_8);
            PendingRpc p = pendingRpcs.get(reqId);
            if (p != null) {
                p.ok = ok;
                if (ok) p.result = body; else p.error = ok ? null : (body.isEmpty() ? "响应解压失败" : body);
                p.latch.countDown();
            }
        }

        private static byte[] gzipBytes(byte[] raw) {
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(128, raw.length / 3));
                try (GZIPOutputStream gz = new GZIPOutputStream(bos)) {
                    gz.write(raw);
                }
                return bos.toByteArray();
            } catch (Throwable ignored) {
                return null;
            }
        }

        private static byte[] gunzipBytes(byte[] gz) {
            try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(gz))) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(256, gz.length * 3));
                byte[] buf = new byte[8192];
                int n;
                int total = 0;
                while ((n = gis.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_FRAME_BYTES * 4) return null;
                    bos.write(buf, 0, n);
                }
                return bos.toByteArray();
            } catch (Throwable ignored) {
                return null;
            }
        }

        private void handleStreamOpen(byte[] plain) {
            ByteBuffer bb = ByteBuffer.wrap(plain);
            byte dir = bb.get();
            int idLen = bb.getShort() & 0xFFFF;
            byte[] idBytes = new byte[idLen];
            bb.get(idBytes);
            byte[] metaBytes = new byte[bb.remaining()];
            bb.get(metaBytes);
            final String streamId = new String(idBytes, StandardCharsets.UTF_8);
            final String metaJson = new String(metaBytes, StandardCharsets.UTF_8);
            if (streamReceiver == null) return;

            if (dir == 1) {
                // 对端上传给我
                final IncomingStream inc = new IncomingStream();
                incomingStreams.put(streamId, inc);
                Thread t = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            streamReceiver.onUploadStream(streamId, metaJson, inc.asInputStream(), Session.this);
                        } catch (Throwable e) {
                            sendStreamErr(streamId, e.getMessage());
                        } finally {
                            incomingStreams.remove(streamId);
                        }
                    }
                }, "stream-up-" + streamId);
                t.setDaemon(true);
                t.start();
            } else if (dir == 2) {
                // 对端请求从我下载
                Thread t = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            final MessageDigest md = MessageDigest.getInstance("SHA-256");
                            OutputStream out = new OutputStream() {
                                @Override
                                public void write(int b) throws IOException {
                                    write(new byte[]{(byte) b}, 0, 1);
                                }

                                @Override
                                public void write(byte[] b, int off, int len) throws IOException {
                                    int pos = off;
                                    int left = len;
                                    while (left > 0) {
                                        int take = Math.min(STREAM_CHUNK_SIZE, left);
                                        md.update(b, pos, take);
                                        ByteBuffer ch = ByteBuffer.allocate(2 + idBytes.length + take);
                                        ch.putShort((short) idBytes.length).put(idBytes).put(b, pos, take);
                                        sendEncrypted(T_STREAM_CHUNK, ch.array());
                                        pos += take;
                                        left -= take;
                                    }
                                }
                            };
                            streamReceiver.onDownloadStream(streamId, metaJson, out, Session.this);
                            byte[] shaBytes = RemoteCrypto.hex(md.digest()).getBytes(StandardCharsets.UTF_8);
                            ByteBuffer end = ByteBuffer.allocate(2 + idBytes.length + shaBytes.length);
                            end.putShort((short) idBytes.length).put(idBytes).put(shaBytes);
                            sendEncrypted(T_STREAM_END, end.array());
                        } catch (Throwable e) {
                            sendStreamErr(streamId, e.getMessage());
                        }
                    }
                }, "stream-dn-" + streamId);
                t.setDaemon(true);
                t.start();
            }
        }

        private void handleStreamChunk(byte[] plain) {
            ByteBuffer bb = ByteBuffer.wrap(plain);
            int idLen = bb.getShort() & 0xFFFF;
            byte[] idBytes = new byte[idLen];
            bb.get(idBytes);
            byte[] data = new byte[bb.remaining()];
            bb.get(data);
            IncomingStream inc = incomingStreams.get(new String(idBytes, StandardCharsets.UTF_8));
            if (inc != null) inc.chunks.offer(data);
        }

        private void handleStreamEnd(byte[] plain) {
            ByteBuffer bb = ByteBuffer.wrap(plain);
            int idLen = bb.getShort() & 0xFFFF;
            byte[] idBytes = new byte[idLen];
            bb.get(idBytes);
            byte[] shaBytes = new byte[bb.remaining()];
            bb.get(shaBytes);
            IncomingStream inc = incomingStreams.get(new String(idBytes, StandardCharsets.UTF_8));
            if (inc != null) {
                inc.expectedSha = new String(shaBytes, StandardCharsets.UTF_8);
                inc.chunks.offer(IncomingStream.EOF);
            }
        }

        private void handleStreamErr(byte[] plain) {
            ByteBuffer bb = ByteBuffer.wrap(plain);
            int idLen = bb.getShort() & 0xFFFF;
            byte[] idBytes = new byte[idLen];
            bb.get(idBytes);
            byte[] errBytes = new byte[bb.remaining()];
            bb.get(errBytes);
            IncomingStream inc = incomingStreams.get(new String(idBytes, StandardCharsets.UTF_8));
            if (inc != null) {
                inc.error = new String(errBytes, StandardCharsets.UTF_8);
                inc.chunks.offer(IncomingStream.ERR);
            }
        }

        private void sendStreamErr(String streamId, String err) {
            try {
                byte[] idBytes = streamId.getBytes(StandardCharsets.UTF_8);
                byte[] errBytes = (err == null ? "stream error" : err).getBytes(StandardCharsets.UTF_8);
                ByteBuffer bb = ByteBuffer.allocate(2 + idBytes.length + errBytes.length);
                bb.putShort((short) idBytes.length).put(idBytes).put(errBytes);
                sendEncrypted(T_STREAM_ERR, bb.array());
            } catch (Throwable ignored) {
            }
        }

        public void close() {
            try {
                if (!closed.get()) sendEncrypted(T_CLOSE, new byte[0]);
            } catch (Throwable ignored) {
            }
            closeInternal("本地关闭");
        }

        private void closeInternal(String reason) {
            if (!closed.compareAndSet(false, true)) return;
            channel.close();
            for (PendingRpc p : pendingRpcs.values()) {
                p.ok = false;
                p.error = "连接已断开：" + reason;
                p.latch.countDown();
            }
            pendingRpcs.clear();
            for (PendingPing p : pendingPings.values()) p.latch.countDown();
            pendingPings.clear();
            for (IncomingStream inc : incomingStreams.values()) {
                inc.error = "连接已断开：" + reason;
                inc.chunks.offer(IncomingStream.ERR);
            }
            incomingStreams.clear();
            if (listener != null) {
                try {
                    listener.onDisconnected(this, reason);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static final class PendingRpc {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile boolean ok;
        volatile String result;
        volatile String error;
    }

    private static final class PendingPing {
        final long sentAt;
        volatile long doneAt;
        final CountDownLatch latch = new CountDownLatch(1);
        PendingPing(long sentAt) { this.sentAt = sentAt; }
    }

    private static final class IncomingStream {
        static final byte[] EOF = new byte[0];
        static final byte[] ERR = new byte[0];
        final BlockingQueue<byte[]> chunks = new LinkedBlockingQueue<byte[]>();
        volatile String expectedSha;
        volatile String error;

        InputStream asInputStream() {
            return new InputStream() {
                private byte[] cur;
                private int pos;
                private boolean eof;

                @Override
                public int read() throws IOException {
                    byte[] one = new byte[1];
                    int r = read(one, 0, 1);
                    return r < 0 ? -1 : (one[0] & 0xFF);
                }

                @Override
                public int read(byte[] b, int off, int len) throws IOException {
                    if (eof) return -1;
                    while (cur == null || pos >= cur.length) {
                        try {
                            byte[] next = chunks.poll(60, TimeUnit.SECONDS);
                            if (next == null) throw new IOException("上传流接收超时");
                            if (next == EOF) {
                                eof = true;
                                return -1;
                            }
                            if (next == ERR) throw new IOException(error == null ? "上传流异常终止" : error);
                            cur = next;
                            pos = 0;
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            throw new IOException("interrupted", e);
                        }
                    }
                    int take = Math.min(len, cur.length - pos);
                    System.arraycopy(cur, pos, b, off, take);
                    pos += take;
                    return take;
                }
            };
        }
    }
}
