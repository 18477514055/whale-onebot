package com.whaleonebot.remote;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.List;

/**
 * [layer: shell-android] 纯 Java RFC 5389 STUN 客户端（零自建服务器，用于公网 UDP 端点探测与 NAT 打洞）。
 *
 * <p>复用调用方已绑定的 {@link DatagramSocket} 发送 Binding Request，
 * 因此探测得到的公网 {@code ip:port} 与后续 UDP 打洞共用同一本地端口映射。
 */
public final class StunClient {

    private static final int BINDING_REQUEST = 0x0001;
    private static final int BINDING_RESPONSE = 0x0101;
    private static final int MAGIC_COOKIE = 0x2112A442;
    private static final int ATTR_MAPPED_ADDRESS = 0x0001;
    private static final int ATTR_XOR_MAPPED_ADDRESS = 0x0020;

    /** 默认公共免费 STUN 服务器池（国内优先 + 全球冗余；移除长期超时的 miwifi 避免拖慢探测）。 */
    public static final List<String> DEFAULT_STUN_SERVERS = Arrays.asList(
            "stun.chat.bilibili.com:3478",
            "stun.cloudflare.com:3478",
            "stun.syncthing.net:3478",
            "stun.l.google.com:19302"
    );

    public static final class Endpoint {
        public final String host;
        public final int port;
        public final String serverUsed;

        public Endpoint(String host, int port, String serverUsed) {
            this.host = host;
            this.port = port;
            this.serverUsed = serverUsed;
        }

        public String toHostPort() {
            return host.indexOf(':') >= 0 ? ("[" + host + "]:" + port) : (host + ":" + port);
        }

        @Override
        public String toString() {
            return toHostPort();
        }
    }

    private StunClient() {
    }

    /** 构造 20 字节 RFC 5389 Binding Request。 */
    public static byte[] buildBindingRequest(byte[] txId12) {
        if (txId12 == null || txId12.length != 12) throw new IllegalArgumentException("txId must be 12 bytes");
        ByteBuffer buf = ByteBuffer.allocate(20);
        buf.putShort((short) BINDING_REQUEST);
        buf.putShort((short) 0);
        buf.putInt(MAGIC_COOKIE);
        buf.put(txId12);
        return buf.array();
    }

    /** 解析 RFC 5389 Binding Response，优先读取 XOR-MAPPED-ADDRESS，退回 MAPPED-ADDRESS。 */
    public static Endpoint parseBindingResponse(byte[] data, int len, byte[] expectedTxId12, String serverUsed) {
        if (data == null || len < 20) return null;
        ByteBuffer buf = ByteBuffer.wrap(data, 0, len);
        int msgType = buf.getShort() & 0xFFFF;
        int msgLen = buf.getShort() & 0xFFFF;
        int cookie = buf.getInt();
        if (msgType != BINDING_RESPONSE || cookie != MAGIC_COOKIE) return null;
        byte[] txId = new byte[12];
        buf.get(txId);
        if (expectedTxId12 != null && !Arrays.equals(txId, expectedTxId12)) return null;

        int end = Math.min(len, 20 + msgLen);
        Endpoint fallback = null;
        while (buf.position() + 4 <= end) {
            int attrType = buf.getShort() & 0xFFFF;
            int attrLen = buf.getShort() & 0xFFFF;
            if (buf.position() + attrLen > end) break;
            int valStart = buf.position();
            if (attrType == ATTR_XOR_MAPPED_ADDRESS) {
                Endpoint ep = decodeAddress(data, valStart, attrLen, true, txId, serverUsed);
                if (ep != null) return ep;
            } else if (attrType == ATTR_MAPPED_ADDRESS) {
                fallback = decodeAddress(data, valStart, attrLen, false, txId, serverUsed);
            }
            int padded = (attrLen + 3) & ~3;
            buf.position(Math.min(end, valStart + padded));
        }
        return fallback;
    }

    private static Endpoint decodeAddress(byte[] data, int off, int len, boolean xor, byte[] txId, String server) {
        if (len < 8) return null;
        int family = data[off + 1] & 0xFF;
        int port = ((data[off + 2] & 0xFF) << 8) | (data[off + 3] & 0xFF);
        if (xor) port ^= (MAGIC_COOKIE >>> 16);
        try {
            if (family == 0x01 && len >= 8) {
                byte[] ip = Arrays.copyOfRange(data, off + 4, off + 8);
                if (xor) {
                    ip[0] ^= (byte) ((MAGIC_COOKIE >>> 24) & 0xFF);
                    ip[1] ^= (byte) ((MAGIC_COOKIE >>> 16) & 0xFF);
                    ip[2] ^= (byte) ((MAGIC_COOKIE >>> 8) & 0xFF);
                    ip[3] ^= (byte) (MAGIC_COOKIE & 0xFF);
                }
                return new Endpoint(InetAddress.getByAddress(ip).getHostAddress(), port, server);
            }
            if (family == 0x02 && len >= 20) {
                byte[] ip = Arrays.copyOfRange(data, off + 4, off + 20);
                if (xor) {
                    byte[] mask = new byte[16];
                    mask[0] = (byte) ((MAGIC_COOKIE >>> 24) & 0xFF);
                    mask[1] = (byte) ((MAGIC_COOKIE >>> 16) & 0xFF);
                    mask[2] = (byte) ((MAGIC_COOKIE >>> 8) & 0xFF);
                    mask[3] = (byte) (MAGIC_COOKIE & 0xFF);
                    System.arraycopy(txId, 0, mask, 4, 12);
                    for (int i = 0; i < 16; i++) ip[i] ^= mask[i];
                }
                return new Endpoint(InetAddress.getByAddress(ip).getHostAddress(), port, server);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 依次尝试公共 STUN 节点，返回首个成功的公网映射端点；全部超时返回 null。 */
    public static Endpoint discover(DatagramSocket socket, int perServerTimeoutMs) {
        return discover(socket, DEFAULT_STUN_SERVERS, perServerTimeoutMs);
    }

    public static Endpoint discover(DatagramSocket socket, List<String> servers, int perServerTimeoutMs) {
        if (socket == null || servers == null) return null;
        int prevTimeout = 0;
        try {
            prevTimeout = socket.getSoTimeout();
        } catch (Exception ignored) {
        }
        try {
            socket.setSoTimeout(Math.max(400, perServerTimeoutMs));
            byte[] rx = new byte[512];
            for (String entry : servers) {
                int colon = entry.lastIndexOf(':');
                if (colon <= 0) continue;
                String host = entry.substring(0, colon).trim();
                int port;
                try {
                    port = Integer.parseInt(entry.substring(colon + 1).trim());
                } catch (Exception e) {
                    continue;
                }
                try {
                    InetAddress addr = InetAddress.getByName(host);
                    byte[] txId = RemoteCrypto.randomBytes(12);
                    byte[] req = buildBindingRequest(txId);
                    socket.send(new DatagramPacket(req, req.length, addr, port));
                    DatagramPacket pkt = new DatagramPacket(rx, rx.length);
                    socket.receive(pkt);
                    Endpoint ep = parseBindingResponse(pkt.getData(), pkt.getLength(), txId, entry);
                    if (ep != null) return ep;
                } catch (Exception ignored) {
                    // 单个公共 STUN 节点不可达时自动切换下一个
                }
            }
            return null;
        } catch (Exception ignored) {
            return null;
        } finally {
            try {
                socket.setSoTimeout(prevTimeout);
            } catch (Exception ignored) {
            }
        }
    }

    /** 供单测/构造响应包使用：编码标准 XOR-MAPPED-ADDRESS 响应。 */
    public static byte[] encodeTestResponse(byte[] txId12, byte[] ipv4, int port) {
        ByteBuffer buf = ByteBuffer.allocate(32);
        buf.putShort((short) BINDING_RESPONSE);
        buf.putShort((short) 12);
        buf.putInt(MAGIC_COOKIE);
        buf.put(txId12);
        buf.putShort((short) ATTR_XOR_MAPPED_ADDRESS);
        buf.putShort((short) 8);
        buf.put((byte) 0);
        buf.put((byte) 1);
        buf.putShort((short) (port ^ (MAGIC_COOKIE >>> 16)));
        buf.put((byte) (ipv4[0] ^ ((MAGIC_COOKIE >>> 24) & 0xFF)));
        buf.put((byte) (ipv4[1] ^ ((MAGIC_COOKIE >>> 16) & 0xFF)));
        buf.put((byte) (ipv4[2] ^ ((MAGIC_COOKIE >>> 8) & 0xFF)));
        buf.put((byte) (ipv4[3] ^ (MAGIC_COOKIE & 0xFF)));
        return buf.array();
    }
}
