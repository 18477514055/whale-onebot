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
import java.util.Collections;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * [layer: shell-android] 纯 Java MQTT 3.1.1 轻量客户端（支持 MQTTS TLS 8883 / TCP 1883，零第三方依赖）。
 *
 * <p>用于国内免代理直连公共 IoT Broker（如 EMQX / HiveMQ）执行零知识端到端加密信令与中继传输：
 * <ul>
 *   <li>主题名固定为 {@code wob/v1/<64位共享密钥派生哈希>}，不暴露设备名、账号或 IP；</li>
 *   <li>载荷全程为 AES-256-GCM 密文，Broker 无法读取任何明文；</li>
 *   <li>内置 {@code PINGREQ/PINGRESP} 保活与显式 TLS SNI，避免空闲断连与安卓 Conscrypt SNI 兼容问题。</li>
 * </ul>
 */
public final class MqttSignaling {

    public static final int PKT_CONNECT = 1;
    public static final int PKT_CONNACK = 2;
    public static final int PKT_PUBLISH = 3;
    public static final int PKT_PUBACK = 4;
    public static final int PKT_SUBSCRIBE = 8;
    public static final int PKT_SUBACK = 9;
    public static final int PKT_PINGREQ = 12;
    public static final int PKT_PINGRESP = 13;
    public static final int PKT_DISCONNECT = 14;

    public static final int MAX_PACKET_BYTES = 2 * 1024 * 1024;
    public static final String TOPIC_PREFIX = "wob/v1/";

    private MqttSignaling() {
    }

    public static String topicFor(String topicHex) {
        return TOPIC_PREFIX + topicHex;
    }

    /** 解析后的单条 MQTT 报文。 */
    public static final class Packet {
        public final int type;
        public final int flags;
        public final byte[] body;

        public Packet(int type, int flags, byte[] body) {
            this.type = type;
            this.flags = flags;
            this.body = body;
        }
    }

    /** 收到一条 PUBLISH 报文解析出的主题与载荷。 */
    public static final class PublishedMessage {
        public final String topic;
        public final int qos;
        public final int packetId;
        public final byte[] payload;

        PublishedMessage(String topic, int qos, int packetId, byte[] payload) {
            this.topic = topic;
            this.qos = qos;
            this.packetId = packetId;
            this.payload = payload;
        }
    }

    // ------------------------------------------------------------------ 纯编解码（可独立单测）

    public static byte[] encodeConnect(String clientId, int keepAliveSec) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        writeUtf8(body, "MQTT");
        body.write(4); // MQTT 3.1.1
        body.write(0x02); // CleanSession = 1
        body.write((keepAliveSec >>> 8) & 0xFF);
        body.write(keepAliveSec & 0xFF);
        writeUtf8(body, clientId);
        return frame(PKT_CONNECT, 0, body.toByteArray());
    }

    public static byte[] encodeSubscribe(int packetId, String topic, int qos) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write((packetId >>> 8) & 0xFF);
        body.write(packetId & 0xFF);
        writeUtf8(body, topic);
        body.write(qos & 0x03);
        return frame(PKT_SUBSCRIBE, 0x02, body.toByteArray());
    }

    public static byte[] encodePublish(String topic, byte[] payload, int qos, int packetId) {
        ByteArrayOutputStream body = new ByteArrayOutputStream(topic.length() + payload.length + 8);
        writeUtf8(body, topic);
        if (qos > 0) {
            body.write((packetId >>> 8) & 0xFF);
            body.write(packetId & 0xFF);
        }
        body.write(payload, 0, payload.length);
        return frame(PKT_PUBLISH, (qos & 0x03) << 1, body.toByteArray());
    }

    public static byte[] encodePubAck(int packetId) {
        return frame(PKT_PUBACK, 0, new byte[]{(byte) ((packetId >>> 8) & 0xFF), (byte) (packetId & 0xFF)});
    }

    public static byte[] encodePingReq() {
        return new byte[]{(byte) (PKT_PINGREQ << 4), 0};
    }

    public static byte[] encodeDisconnect() {
        return new byte[]{(byte) (PKT_DISCONNECT << 4), 0};
    }

    public static byte[] frame(int type, int flags, byte[] body) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(body.length + 6);
        out.write(((type & 0x0F) << 4) | (flags & 0x0F));
        writeRemainingLength(out, body.length);
        out.write(body, 0, body.length);
        return out.toByteArray();
    }

    public static PublishedMessage parsePublish(Packet p) throws IOException {
        if (p == null || p.type != PKT_PUBLISH || p.body.length < 2) {
            throw new IOException("not a valid PUBLISH packet");
        }
        int qos = (p.flags >>> 1) & 0x03;
        int tLen = ((p.body[0] & 0xFF) << 8) | (p.body[1] & 0xFF);
        int pos = 2;
        if (pos + tLen > p.body.length) throw new IOException("truncated PUBLISH topic");
        String topic = new String(p.body, pos, tLen, StandardCharsets.UTF_8);
        pos += tLen;
        int packetId = 0;
        if (qos > 0) {
            if (pos + 2 > p.body.length) throw new IOException("truncated PUBLISH packetId");
            packetId = ((p.body[pos] & 0xFF) << 8) | (p.body[pos + 1] & 0xFF);
            pos += 2;
        }
        byte[] payload = new byte[p.body.length - pos];
        System.arraycopy(p.body, pos, payload, 0, payload.length);
        return new PublishedMessage(topic, qos, packetId, payload);
    }

    public static Packet readPacket(InputStream in) throws IOException {
        int b0 = in.read();
        if (b0 < 0) return null;
        int type = (b0 >>> 4) & 0x0F;
        int flags = b0 & 0x0F;
        int remLen = readRemainingLength(in);
        if (remLen < 0 || remLen > MAX_PACKET_BYTES) {
            throw new IOException("MQTT packet too large: " + remLen);
        }
        byte[] body = new byte[remLen];
        int pos = 0;
        while (pos < remLen) {
            int r = in.read(body, pos, remLen - pos);
            if (r < 0) throw new EOFException("EOF inside MQTT packet");
            pos += r;
        }
        return new Packet(type, flags, body);
    }

    private static void writeUtf8(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        out.write((b.length >>> 8) & 0xFF);
        out.write(b.length & 0xFF);
        out.write(b, 0, b.length);
    }

    private static void writeRemainingLength(ByteArrayOutputStream out, int len) {
        int x = len;
        do {
            int digit = x & 0x7F;
            x >>>= 7;
            if (x > 0) digit |= 0x80;
            out.write(digit);
        } while (x > 0);
    }

    private static int readRemainingLength(InputStream in) throws IOException {
        int mult = 1;
        int val = 0;
        for (int i = 0; i < 4; i++) {
            int b = in.read();
            if (b < 0) throw new EOFException("EOF in MQTT remaining length");
            val += (b & 0x7F) * mult;
            if ((b & 0x80) == 0) return val;
            mult <<= 7;
        }
        throw new IOException("malformed MQTT remaining length");
    }

    // ------------------------------------------------------------------ 实时 MQTT 连接客户端

    public static final class Client {
        private final Socket sock;
        private final InputStream in;
        private final OutputStream out;
        private final AtomicInteger nextPid = new AtomicInteger(1);
        private volatile boolean closed;

        private Client(Socket sock, InputStream in, OutputStream out) {
            this.sock = sock;
            this.in = in;
            this.out = out;
        }

        public static Client connect(String url, int timeoutMs) throws IOException {
            URI uri = URI.create(url.trim());
            String scheme = uri.getScheme();
            boolean tls = "mqtts".equalsIgnoreCase(scheme) || "ssl".equalsIgnoreCase(scheme)
                    || "tls".equalsIgnoreCase(scheme);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) throw new IOException("invalid MQTT host: " + url);
            int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 8883 : 1883);

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

            String cid = "wob_" + RemoteCrypto.hex(RemoteCrypto.randomBytes(6));
            out.write(encodeConnect(cid, 25));
            out.flush();

            Packet connack = readPacket(in);
            if (connack == null || connack.type != PKT_CONNACK || connack.body.length < 2 || connack.body[1] != 0) {
                try { s.close(); } catch (Throwable ignored) {}
                int code = (connack != null && connack.body.length >= 2) ? (connack.body[1] & 0xFF) : -1;
                throw new IOException("MQTT CONNACK rejected code=" + code);
            }
            return new Client(s, in, out);
        }

        public int nextPacketId() {
            int id = nextPid.getAndIncrement() & 0xFFFF;
            return id == 0 ? 1 : id;
        }

        public synchronized void subscribe(String topic) throws IOException {
            int pid = nextPacketId();
            out.write(encodeSubscribe(pid, topic, 1));
            out.flush();
        }

        public synchronized void publish(String topic, byte[] payload, int qos) throws IOException {
            int pid = qos > 0 ? nextPacketId() : 0;
            out.write(encodePublish(topic, payload, qos, pid));
            out.flush();
        }

        public synchronized void sendPubAck(int packetId) throws IOException {
            out.write(encodePubAck(packetId));
            out.flush();
        }

        public synchronized void sendPing() throws IOException {
            out.write(encodePingReq());
            out.flush();
        }

        /** 读取下一条 PUBLISH 消息（自动处理 SUBACK / PUBACK / PINGRESP 并在空闲超时发送 PINGREQ 保活）。 */
        public PublishedMessage readNextPublish(int idlePingMs) throws IOException {
            sock.setSoTimeout(Math.max(3000, idlePingMs));
            boolean awaitingPong = false;
            while (!closed) {
                try {
                    Packet p = readPacket(in);
                    if (p == null) return null;
                    awaitingPong = false;
                    if (p.type == PKT_PUBLISH) {
                        PublishedMessage m = parsePublish(p);
                        if (m.qos == 1) sendPubAck(m.packetId);
                        return m;
                    }
                    if (p.type == PKT_PINGRESP || p.type == PKT_SUBACK || p.type == PKT_PUBACK) {
                        continue;
                    }
                } catch (SocketTimeoutException timeout) {
                    if (awaitingPong) throw new IOException("MQTT keepalive timeout");
                    sendPing();
                    awaitingPong = true;
                }
            }
            return null;
        }

        /** 短连发布后等待一次 PUBACK 确认投递。 */
        public boolean awaitPubAck(int timeoutMs) throws IOException {
            sock.setSoTimeout(Math.max(500, timeoutMs));
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() < deadline) {
                Packet p = readPacket(in);
                if (p == null) return false;
                if (p.type == PKT_PUBACK) return true;
            }
            return false;
        }

        public boolean isClosed() {
            return closed || sock.isClosed();
        }

        public void closeQuietly() {
            closed = true;
            try {
                synchronized (this) {
                    out.write(encodeDisconnect());
                    out.flush();
                }
            } catch (Throwable ignored) {
            }
            try {
                sock.close();
            } catch (Throwable ignored) {
            }
        }
    }
}
