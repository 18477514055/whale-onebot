package com.whaleonebot.remote;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;

import java.io.IOException;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * [layer: shell-android] 运行在原生 Android {@code ContainerService} 内的远程被控宿主。
 *
 * <p>独立于 proot 容器生命周期：即使容器/机器人已停止，仍可通过局域网 mDNS、IPv6、
 * 或公共 STUN + 多节点加密 Nostr 信令打洞连接并远程拉起容器与修复环境。
 */
public final class RemoteHostServer {

    private static final String TAG = "WhaleRemoteHost";
    public static final String MDNS_TYPE = "_whaleonebot._tcp.";
    public static final int PREFERRED_PORT = 41988;

    private final Context ctx;
    private final RemoteStore store;
    private volatile RemoteTransport.RpcHandler rpcHandler;
    private volatile RemoteTransport.StreamReceiver streamReceiver;

    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile ServerSocket tcpServer;
    private volatile DatagramSocket udpSocket;
    private volatile int listenPort = 0;
    private volatile StunClient.Endpoint cachedStun;

    private NsdManager nsdManager;
    private NsdManager.RegistrationListener nsdListener;
    private final Map<String, RemoteTransport.Session> activeSessions = new ConcurrentHashMap<String, RemoteTransport.Session>();
    private final Map<String, NostrSignaling.Subscription> signalSubs = new ConcurrentHashMap<String, NostrSignaling.Subscription>();
    private volatile NostrSignaling.Subscription pairingSub;
    private final Map<String, byte[]> activeRelayReadySecrets = new ConcurrentHashMap<String, byte[]>();
    private Thread beaconThread;

    public RemoteHostServer(Context ctx, RemoteStore store) {
        this.ctx = ctx.getApplicationContext();
        this.store = store;
        NostrSignaling.logSink = (level, msg) -> {
            if ("W".equals(level)) Log.w("WhaleRemoteSig", msg);
            else Log.i("WhaleRemoteSig", msg);
        };
    }

    /** 返回当前临时配对信令通道已连上的公共节点数（供配对页实时展示跨网就绪状态）。 */
    public int pairingSignalOnlineCount() {
        NostrSignaling.Subscription sub = pairingSub;
        return sub == null ? 0 : sub.connectedCount();
    }

    public int pairingSignalTotalCount() {
        NostrSignaling.Subscription sub = pairingSub;
        return sub == null ? store.effectiveRelays().size() : sub.totalPoolSize();
    }

    public void setHandlers(RemoteTransport.RpcHandler rpc, RemoteTransport.StreamReceiver stream) {
        this.rpcHandler = rpc;
        this.streamReceiver = stream;
    }

    public boolean isRunning() {
        return running.get();
    }

    public int listenPort() {
        return listenPort;
    }

    public List<String> connectedClientIds() {
        List<String> out = new ArrayList<String>();
        for (Map.Entry<String, RemoteTransport.Session> e : activeSessions.entrySet()) {
            if (e.getValue() != null && e.getValue().isOpen()) out.add(e.getKey());
        }
        return out;
    }

    public boolean isClientOnline(String clientId) {
        RemoteTransport.Session s = activeSessions.get(clientId);
        return s != null && s.isOpen();
    }

    public synchronized void start() {
        if (running.get()) return;
        try {
            ServerSocket ss = new ServerSocket();
            ss.setReuseAddress(true);
            try {
                ss.bind(new InetSocketAddress(PREFERRED_PORT), 16);
            } catch (IOException busy) {
                ss.bind(new InetSocketAddress(0), 16);
            }
            tcpServer = ss;
            listenPort = ss.getLocalPort();
            udpSocket = new DatagramSocket(0);
            running.set(true);

            Thread acceptThread = new Thread(this::acceptLoop, "remote-tcp-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();

            registerMdns(listenPort);
            startSignalingLoop();
            Log.i(TAG, "remote host started tcp=" + listenPort + " udp=" + udpSocket.getLocalPort());
        } catch (Throwable t) {
            Log.e(TAG, "remote host start failed", t);
            stop();
        }
    }

    public synchronized void stop() {
        running.set(false);
        unregisterMdns();
        if (pairingSub != null) {
            pairingSub.close();
            pairingSub = null;
        }
        for (NostrSignaling.Subscription sub : signalSubs.values()) sub.close();
        signalSubs.clear();
        for (RemoteTransport.Session s : activeSessions.values()) s.close();
        activeSessions.clear();
        try {
            if (tcpServer != null) tcpServer.close();
        } catch (Throwable ignored) {
        }
        tcpServer = null;
        try {
            if (udpSocket != null) udpSocket.close();
        } catch (Throwable ignored) {
        }
        udpSocket = null;
        listenPort = 0;
        if (beaconThread != null) {
            beaconThread.interrupt();
            beaconThread = null;
        }
    }

    /** 立即踢下线某个控制端（不吊销，允许其重连）。 */
    public void kickClient(String clientId) {
        RemoteTransport.Session s = activeSessions.remove(clientId);
        if (s != null) s.close();
    }

    /** 永久吊销并立即踢下线某个控制端，同时停止其专属信令订阅。 */
    public void revokeClient(String clientId) {
        store.revokeClient(clientId);
        kickClient(clientId);
        NostrSignaling.Subscription sub = signalSubs.remove(clientId);
        if (sub != null) sub.close();
    }

    /** 生成 60 秒有效、单次消耗的配对载荷并立即广播密文信标（供二维码与异地截图口令使用）。 */
    public RemoteCrypto.PairPayload createPairingPayload() {
        if (!store.identity().hostEnabled) {
            store.setHostEnabled(true);
        }
        if (!running.get()) start();
        final RemoteStore.PairingTicket ticket = store.issuePairingTicket();
        refreshStunAsync();

        String lanEp = buildIpv4Endpoints(listenPort);
        String v6 = localGlobalIpv6();
        StunClient.Endpoint stun = cachedStun;
        String v6Ep = (v6 != null && listenPort > 0) ? ("[" + v6 + "]:" + listenPort) : "";
        String stunEp = stun == null ? "" : stun.toHostPort();
        List<String> relays = store.effectiveRelays();

        // 开启 180 秒单次临时配对信令通道（同时支持国内免代理 MQTT-TLS 与 Nostr 加密中继/打洞）
        if (pairingSub != null) pairingSub.close();
        final NostrSignaling.Subscription[] holder = new NostrSignaling.Subscription[1];
        NostrSignaling.Subscription sub = NostrSignaling.subscribe(relays, ticket.secret, (json, relay) -> {
            if (ticket.isActive(System.currentTimeMillis())) {
                handleIncomingControlBeacon(json, ticket.secret, holder[0]);
            }
        });
        holder[0] = sub;
        pairingSub = sub;
        publishBeaconAsync(relays, ticket.secret);

        RemoteStore.LocalIdentity id = store.identity();
        return new RemoteCrypto.PairPayload(
                id.deviceId, id.deviceName, id.publicKeyB64, ticket.secretB64,
                lanEp, v6Ep, stunEp, relays, ticket.expiresAt
        );
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                ServerSocket ss = tcpServer;
                if (ss == null) break;
                final Socket s = ss.accept();
                Thread t = new Thread(() -> handleChannel(new TcpHolder(s)), "remote-conn");
                t.setDaemon(true);
                t.start();
            } catch (Throwable t) {
                if (!running.get()) break;
            }
        }
    }

    private static final class TcpHolder {
        final Socket socket;
        TcpHolder(Socket s) { this.socket = s; }
    }

    private void handleChannel(TcpHolder holder) {
        try {
            holder.socket.setSoTimeout(0);
            handleFrameChannel(new RemoteTransport.TcpChannel(holder.socket));
        } catch (Throwable t) {
            try { holder.socket.close(); } catch (Throwable ignored) {}
        }
    }

    private void handleFrameChannel(RemoteTransport.FrameChannel channel) {
        try {
            RemoteStore.LocalIdentity id = store.identity();
            final RemoteTransport.RpcHandler wrappedRpc = (method, paramsJson, session) -> {
                if ("remote.transport.probe".equals(method)) {
                    return handleTransportProbeRpc(paramsJson);
                }
                RemoteTransport.RpcHandler h = rpcHandler;
                if (h == null) throw new UnsupportedOperationException("no rpc handler");
                return h.handleRpc(method, paramsJson, session);
            };
            RemoteTransport.HandshakeResult hr = RemoteTransport.handshakeAsServer(
                    channel,
                    id.deviceId, id.deviceName, id.privateKey(), id.publicKeyBytes(),
                    (cliId, cliName, cliPub, transcript, sig, pairHmac) ->
                            store.authenticateClient(cliId, cliName, cliPub, transcript, pairHmac, System.currentTimeMillis()),
                    wrappedRpc,
                    streamReceiver,
                    (sess, reason) -> activeSessions.remove(sess.peerDeviceId, sess)
            );
            RemoteTransport.Session old = activeSessions.put(hr.peerDeviceId, hr.session);
            if (old != null && old != hr.session) {
                // 延迟 400ms 排空旧通道在途响应（配合控制端带内热升级零丢包切换）
                final RemoteTransport.Session toDrain = old;
                Thread drain = new Thread(() -> {
                    try { Thread.sleep(400L); } catch (InterruptedException ignored) {}
                    toDrain.close();
                }, "host-drain-old");
                drain.setDaemon(true);
                drain.start();
            }
            // 若是新配对客户，立即为其补齐信令订阅以便后续跨网重连
            ensureClientSignalingSubscriptions();
            Log.i(TAG, "client connected: " + hr.peerDeviceId.substring(0, 8) + " via " + channel.remoteLabel());
        } catch (Throwable t) {
            Log.w(TAG, "handshake rejected: " + t.getMessage());
            channel.close();
        }
    }

    /**
     * 响应控制端在已连通加密中继会话内发起的带内直连/P2P 升级探测（借鉴 ds-harness-remote TransportUpgradeHost）。
     * 返回最新局域网/Tailscale/IPv6 地址，并在对端提供 ctrlStun 时同步开启精准 UDP 打洞监听。
     */
    private String handleTransportProbeRpc(String paramsJson) {
        String lanEps = buildIpv4Endpoints(listenPort);
        String v6 = localGlobalIpv6();
        String v6Ep = (v6 != null && listenPort > 0) ? ("[" + v6 + "]:" + listenPort) : "";
        String ctrlStun = paramsJson == null ? null : NostrSignaling.extractJsonString(paramsJson, "ctrlStun");
        String punchStun = "";

        InetSocketAddress peerUdp = parseHostPort(ctrlStun);
        if (peerUdp != null) {
            DatagramSocket ds = null;
            try {
                ds = new DatagramSocket(0);
                StunClient.Endpoint myEp = StunClient.discover(ds, 1100);
                if (myEp != null) {
                    punchStun = myEp.toHostPort();
                    final DatagramSocket punchSock = ds;
                    final InetSocketAddress target = peerUdp;
                    ds = null; // 所有权移交给后台打洞线程
                    Thread t = new Thread(() -> {
                        try {
                            RemoteTransport.UdpReliableChannel udpCh =
                                    new RemoteTransport.UdpReliableChannel(punchSock, target, true);
                            udpCh.sendPunchBurst(10, 100);
                            handleFrameChannel(udpCh);
                        } catch (Throwable ignored) {
                            try { punchSock.close(); } catch (Throwable ignored2) {}
                        }
                    }, "host-inband-udp-upgrade");
                    t.setDaemon(true);
                    t.start();
                }
            } catch (Throwable ignored) {
            } finally {
                if (ds != null) {
                    try { ds.close(); } catch (Throwable ignored) {}
                }
            }
        }
        return "{\"lan\":" + NostrSignaling.jsonStr(lanEps)
                + ",\"v6\":" + NostrSignaling.jsonStr(v6Ep)
                + ",\"punchStun\":" + NostrSignaling.jsonStr(punchStun) + "}";
    }

    private void startSignalingLoop() {
        ensureClientSignalingSubscriptions();
        beaconThread = new Thread(() -> {
            while (running.get()) {
                try {
                    refreshStunBlocking();
                    ensureClientSignalingSubscriptions();
                    List<String> relays = store.effectiveRelays();
                    for (RemoteStore.AuthorizedClient c : store.listAuthorizedClients()) {
                        if (c.revoked) continue;
                        publishBeaconBlocking(relays, c.sharedSecretBytes());
                    }
                    RemoteStore.PairingTicket tk = store.activeTicket();
                    if (tk != null && tk.isActive(System.currentTimeMillis())) {
                        publishBeaconBlocking(relays, tk.secret);
                    } else if (pairingSub != null) {
                        // 配对票据已过期或已单次消耗：自动关闭临时配对订阅，避免常驻泄漏 6 条重连线程
                        pairingSub.close();
                        pairingSub = null;
                    }
                } catch (Throwable ignored) {
                }
                try {
                    Thread.sleep(45_000L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }, "remote-beacon");
        beaconThread.setDaemon(true);
        beaconThread.start();
    }

    private void ensureClientSignalingSubscriptions() {
        if (!running.get()) return;
        List<String> relays = store.effectiveRelays();
        for (final RemoteStore.AuthorizedClient c : store.listAuthorizedClients()) {
            if (c.revoked) {
                NostrSignaling.Subscription old = signalSubs.remove(c.deviceId);
                if (old != null) old.close();
                continue;
            }
            if (!signalSubs.containsKey(c.deviceId)) {
                final byte[] sec = c.sharedSecretBytes();
                final NostrSignaling.Subscription[] holder = new NostrSignaling.Subscription[1];
                NostrSignaling.Subscription sub = NostrSignaling.subscribe(relays, sec,
                        (json, relay) -> handleIncomingControlBeacon(json, sec, holder[0]));
                holder[0] = sub;
                signalSubs.put(c.deviceId, sub);
            }
        }
    }

    private final Map<String, Long> seenSignalNonces = new ConcurrentHashMap<String, Long>();

    private void handleIncomingControlBeacon(String json, byte[] secret, final NostrSignaling.Subscription sourceSub) {
        if (json == null || !running.get()) return;
        String role = NostrSignaling.extractJsonString(json, "role");
        String sid = NostrSignaling.extractJsonString(json, "sid");
        if ("ctrl_relay".equals(role) && sid != null && !sid.isEmpty()) {
            final String sessionId = sid;
            final String readyJson = "{\"role\":\"host_relay_ready\",\"sid\":" + NostrSignaling.jsonStr(sessionId) + "}";
            // 若是控制端针对同一 sid 的重发请求，直接补发 host_relay_ready（避免首包丢失后卡死）
            if (activeRelayReadySecrets.putIfAbsent(sessionId, secret) != null) {
                Log.i(TAG, "re-sending host_relay_ready for sid=" + sessionId);
                broadcastControlSignal(sourceSub, secret, readyJson);
                return;
            }
            if (activeRelayReadySecrets.size() > 64) activeRelayReadySecrets.clear();
            Log.i(TAG, "accepting encrypted relay session sid=" + sessionId);
            Thread relayAccept = new Thread(() -> {
                NostrRelayChannel ch = new NostrRelayChannel(store.effectiveRelays(), sessionId, "h", secret);
                boolean ready = ch.awaitReady(3200);
                Log.i(TAG, "host relay channel sid=" + sessionId + " ready=" + ready + " nodes=" + ch.connectedRelayCount());
                // 通知控制端：被控端中继通道已订阅就绪，可立刻发首包握手（双路径投递确保必达）
                broadcastControlSignal(sourceSub, secret, readyJson);
                try {
                    handleFrameChannel(ch);
                } finally {
                    activeRelayReadySecrets.remove(sessionId);
                }
            }, "host-relay-" + sessionId);
            relayAccept.setDaemon(true);
            relayAccept.start();
            return;
        }
        if (sid != null && !sid.isEmpty()) {
            if (seenSignalNonces.putIfAbsent(role + ":" + sid, System.currentTimeMillis()) != null) return;
            if (seenSignalNonces.size() > 256) seenSignalNonces.clear();
        }
        if (!"ctrl_punch".equals(role)) return;
        String peerStun = NostrSignaling.extractJsonString(json, "stun");
        if (peerStun == null || peerStun.isEmpty()) return;

        // 立刻回发一次我方最新地址，并同时用匹配的 sid 与精确新端口发起 UDP 打洞
        publishBeaconAsync(store.effectiveRelays(), secret);
        InetSocketAddress addr = parseHostPort(peerStun);
        if (addr == null) return;
        final String punchSid = sid == null ? "" : sid;
        Thread punch = new Thread(() -> {
            DatagramSocket ds = null;
            try {
                ds = new DatagramSocket(0);
                StunClient.Endpoint myEp = StunClient.discover(ds, 1800);
                if (myEp != null) {
                    String ack = "{\"role\":\"host_punch\",\"sid\":" + NostrSignaling.jsonStr(punchSid)
                            + ",\"stun\":" + NostrSignaling.jsonStr(myEp.toHostPort())
                            + ",\"ts\":" + System.currentTimeMillis() + "}";
                    NostrSignaling.publish(store.effectiveRelays(), secret, ack, 3500);
                }
                RemoteTransport.UdpReliableChannel udpCh = new RemoteTransport.UdpReliableChannel(ds, addr, true);
                udpCh.sendPunchBurst(10, 120);
                handleFrameChannel(udpCh);
            } catch (Throwable t) {
                if (ds != null) {
                    try { ds.close(); } catch (Throwable ignored) {}
                }
            }
        }, "host-udp-punch");
        punch.setDaemon(true);
        punch.start();
    }

    private void broadcastControlSignal(final NostrSignaling.Subscription sourceSub,
                                        final byte[] secret, final String payloadJson) {
        int sent = sourceSub == null ? 0 : sourceSub.broadcastPayload(payloadJson);
        if (sent < 2) {
            Thread t = new Thread(() -> NostrSignaling.publish(store.effectiveRelays(), secret, payloadJson, 3000),
                    "host-sig-reply");
            t.setDaemon(true);
            t.start();
        }
    }

    private void refreshStunAsync() {
        Thread t = new Thread(this::refreshStunBlocking, "host-stun");
        t.setDaemon(true);
        t.start();
    }

    private void refreshStunBlocking() {
        DatagramSocket ds = udpSocket;
        if (ds == null || ds.isClosed()) return;
        StunClient.Endpoint ep = StunClient.discover(ds, 1500);
        if (ep != null) cachedStun = ep;
    }

    private void publishBeaconAsync(final List<String> relays, final byte[] secret) {
        Thread t = new Thread(() -> publishBeaconBlocking(relays, secret), "host-beacon-once");
        t.setDaemon(true);
        t.start();
    }

    private void publishBeaconBlocking(List<String> relays, byte[] secret) {
        if (!running.get() || listenPort <= 0) return;
        String lanEps = buildIpv4Endpoints(listenPort);
        String v6 = localGlobalIpv6();
        StunClient.Endpoint stun = cachedStun;
        String payload = "{\"role\":\"host\",\"id\":" + NostrSignaling.jsonStr(store.identity().deviceId)
                + ",\"lan\":" + NostrSignaling.jsonStr(lanEps)
                + ",\"v6\":" + NostrSignaling.jsonStr(v6 == null ? "" : "[" + v6 + "]:" + listenPort)
                + ",\"stun\":" + NostrSignaling.jsonStr(stun == null ? "" : stun.toHostPort())
                + ",\"ts\":" + System.currentTimeMillis() + "}";
        NostrSignaling.publish(relays, secret, payload, 3500);
    }

    private void registerMdns(int port) {
        try {
            nsdManager = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
            if (nsdManager == null) return;
            NsdServiceInfo info = new NsdServiceInfo();
            String id = store.identity().deviceId;
            String shortId = id.length() > 12 ? id.substring(0, 12) : id;
            info.setServiceName("Whale-" + shortId);
            info.setServiceType(MDNS_TYPE);
            info.setPort(port);
            nsdListener = new NsdManager.RegistrationListener() {
                @Override public void onServiceRegistered(NsdServiceInfo i) {}
                @Override public void onRegistrationFailed(NsdServiceInfo i, int code) {}
                @Override public void onServiceUnregistered(NsdServiceInfo i) {}
                @Override public void onUnregistrationFailed(NsdServiceInfo i, int code) {}
            };
            nsdManager.registerService(info, NsdManager.PROTOCOL_DNS_SD, nsdListener);
        } catch (Throwable ignored) {
        }
    }

    private void unregisterMdns() {
        try {
            if (nsdManager != null && nsdListener != null) {
                nsdManager.unregisterService(nsdListener);
            }
        } catch (Throwable ignored) {
        }
        nsdListener = null;
    }

    // ------------------------------------------------------------------ 本机网络地址工具

    /** 收集本机可用局域网 IPv4 及 Tailscale/VPN（100.64.0.0/10）直连端点，逗号分隔。 */
    public static String buildIpv4Endpoints(int port) {
        if (port <= 0) return "";
        List<String> ips = new ArrayList<String>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis != null) {
                for (NetworkInterface ni : Collections.list(nis)) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                        if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) continue;
                        String host = addr.getHostAddress();
                        if (host == null || host.startsWith("169.254.")) continue;
                        if (addr.isSiteLocalAddress() || isTailscaleCgnat(addr.getAddress())) {
                            if (!ips.contains(host)) ips.add(host);
                        }
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < ips.size() && i < 3; i++) {
            if (i > 0) sb.append(',');
            sb.append(ips.get(i)).append(':').append(port);
        }
        return sb.toString();
    }

    private static boolean isTailscaleCgnat(byte[] b) {
        return b != null && b.length == 4 && (b[0] & 0xFF) == 100 && ((b[1] & 0xC0) == 64);
    }

    public static String localIpv4() {
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis == null) return null;
            for (NetworkInterface ni : Collections.list(nis)) {
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue;
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress() && addr.isSiteLocalAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    public static String localGlobalIpv6() {
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            if (nis == null) return null;
            for (NetworkInterface ni : Collections.list(nis)) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (addr instanceof Inet6Address && !addr.isLoopbackAddress()
                            && !addr.isLinkLocalAddress() && !addr.isSiteLocalAddress()) {
                        String host = addr.getHostAddress();
                        int pct = host.indexOf('%');
                        if (pct > 0) host = host.substring(0, pct);
                        if (!host.startsWith("fe80") && !host.startsWith("fc") && !host.startsWith("fd")) {
                            return host;
                        }
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    public static InetSocketAddress parseHostPort(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        try {
            if (s.startsWith("[")) {
                int rb = s.indexOf(']');
                if (rb < 0 || rb + 2 >= s.length() || s.charAt(rb + 1) != ':') return null;
                String host = s.substring(1, rb);
                int port = Integer.parseInt(s.substring(rb + 2));
                return new InetSocketAddress(host, port);
            }
            int colon = s.lastIndexOf(':');
            if (colon <= 0) return null;
            String host = s.substring(0, colon);
            int port = Integer.parseInt(s.substring(colon + 1));
            if (port <= 0 || port > 65535) return null;
            return new InetSocketAddress(host, port);
        } catch (Throwable t) {
            return null;
        }
    }
}
