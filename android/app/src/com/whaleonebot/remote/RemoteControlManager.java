package com.whaleonebot.remote;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * [layer: shell-android] 远程控制总控管理器：管理本机被控宿主 + 全部已配对设备的后台心跳连接池 + 当前控制目标切换。
 *
 * <p>严格对齐问答拍板：
 * <ul>
 *   <li>Q2：四级零自建服务器 P2P 择优连接（局域网 mDNS → 自定义直连/Tailscale → IPv6 直连 → 公共 STUN 打洞 + 多节点 Nostr 密文信令）；</li>
 *   <li>Q16：切网/弱网指数退避静默重连，保留最后一次拉取状态不强制踢回本机；</li>
 *   <li>Q20：对全部已配对设备持续保持后台心跳，点开面板即时看到在线状态、传输通道与延迟毫秒数。</li>
 * </ul>
 */
public final class RemoteControlManager {

    private static final String TAG = "WhaleRemoteMgr";

    public enum ConnState {
        OFFLINE, CONNECTING, CONNECTED, RECONNECTING
    }

    public static final class PeerStatus {
        public final String deviceId;
        public volatile ConnState state = ConnState.OFFLINE;
        public volatile String channelLabel = "";
        public volatile long rttMs = -1;
        public volatile String lastError = "";
        public volatile long lastOkAt = 0;

        PeerStatus(String deviceId) {
            this.deviceId = deviceId;
        }

        public String summaryText() {
            if (state == ConnState.CONNECTED) {
                String ch = channelLabel.isEmpty() ? "P2P" : channelLabel;
                return rttMs > 0 ? (ch + " · " + rttMs + "ms") : ch;
            }
            if (state == ConnState.CONNECTING) return "连接中…";
            if (state == ConnState.RECONNECTING) return "已断开 · 重连中…";
            return lastError.isEmpty() ? "离线" : ("离线 · " + lastError);
        }
    }

    /** 活跃远端设备的最新状态快照（供主线程 UI 每秒无阻塞渲染）。 */
    public static final class RemoteSnapshot {
        public volatile boolean containerRunning;
        public volatile boolean botRunning;
        public volatile String loginUin;
        public volatile boolean qrLive;
        public volatile long qrLeftSeconds;
        public volatile long qrMtime;
        public volatile Bitmap qrBitmap;
        public volatile byte[] qrPngBytes;
        public volatile String qrUrl = "";
        public volatile String botStateJson = "";
        public volatile boolean hasSavedCred = false;
        public volatile String savedCredUin = "";
        public volatile boolean setupEnv;
        public volatile boolean setupQq;
        public volatile boolean setupBot;
        public volatile boolean watchdogEnabled;
        public volatile String qqClientVersion;
        public volatile String appVersionName = "";
        public volatile int appVersionCode = 0;
        public volatile String loginLog = "";
        public volatile String containerLog = "";
        public volatile String botsHash = "";
        public volatile String loginLogHash = "";
        public volatile String containerLogHash = "";
        public volatile long updatedAt = 0;
    }

    public interface TargetChangeListener {
        void onRemoteSnapshotUpdated(String peerId, String botsJson, String coresJson);
    }

    public interface PairingProgressListener {
        void onProgress(String statusMessage);
    }

    private static volatile RemoteControlManager INSTANCE;

    private final Context ctx;
    private final RemoteStore store;
    private final RemoteHostServer hostServer;
    private final Map<String, PeerStatus> statuses = new ConcurrentHashMap<String, PeerStatus>();
    private final Map<String, RemoteTransport.Session> sessions = new ConcurrentHashMap<String, RemoteTransport.Session>();
    private final Map<String, String> mdnsLanEndpoints = new ConcurrentHashMap<String, String>();
    private final Map<String, String> beaconHints = new ConcurrentHashMap<String, String>();
    private final Map<String, NostrSignaling.Subscription> peerSignalSubs = new ConcurrentHashMap<String, NostrSignaling.Subscription>();

    /** null 表示当前控制本机；非 null 表示正在远程控制该 deviceId。 */
    private volatile String activePeerId = null;
    private volatile RemoteSnapshot activeSnapshot = new RemoteSnapshot();
    private volatile TargetChangeListener snapshotListener;
    private final Object snapWakeLock = new Object();
    private volatile long lastInBandUpgradeAttemptAt = 0L;
    private final Map<String, String> lastPeerOfflineAlert = new ConcurrentHashMap<String, String>();

    private final AtomicBoolean poolRunning = new AtomicBoolean(false);
    private NsdManager nsdManager;
    private NsdManager.DiscoveryListener discoveryListener;

    private RemoteControlManager(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        NostrSignaling.logSink = (level, msg) -> {
            if ("W".equals(level)) Log.w("WhaleRemoteSig", msg);
            else Log.i("WhaleRemoteSig", msg);
        };
        String defaultName = (Build.MODEL == null || Build.MODEL.trim().isEmpty()) ? "Android 设备" : Build.MODEL.trim();
        this.store = new RemoteStore(this.ctx.getFilesDir(), defaultName);
        this.hostServer = new RemoteHostServer(this.ctx, this.store);
    }

    public static RemoteControlManager get(Context ctx) {
        if (INSTANCE == null) {
            synchronized (RemoteControlManager.class) {
                if (INSTANCE == null) {
                    INSTANCE = new RemoteControlManager(ctx);
                }
            }
        }
        return INSTANCE;
    }

    public static RemoteControlManager peek() {
        return INSTANCE;
    }

    public RemoteStore store() {
        return store;
    }

    public RemoteHostServer host() {
        return hostServer;
    }

    public void setSnapshotListener(TargetChangeListener l) {
        this.snapshotListener = l;
    }

    /** 由 ContainerService / MainActivity 启动时调用：拉起被控宿主（若总开关已开）和全设备心跳池。 */
    public synchronized void startServices(RemoteTransport.RpcHandler hostRpc, RemoteTransport.StreamReceiver hostStream) {
        if (hostRpc != null || hostStream != null) {
            hostServer.setHandlers(hostRpc, hostStream);
        }
        if (store.identity().hostEnabled && !hostServer.isRunning()) {
            hostServer.start();
        }
        if (poolRunning.compareAndSet(false, true)) {
            startMdnsDiscovery();
            registerNetworkCallback();
            Thread hb = new Thread(this::heartbeatLoop, "remote-peer-pool");
            hb.setDaemon(true);
            hb.start();
            Thread snap = new Thread(this::activeSnapshotLoop, "remote-active-snap");
            snap.setDaemon(true);
            snap.start();
        }
    }

    // ------------------------------------------------------------------ 当前控制目标切换

    public boolean isRemote() {
        return activePeerId != null && !activePeerId.isEmpty();
    }

    public String activePeerId() {
        return activePeerId;
    }

    public RemoteStore.PairedPeer activePeer() {
        String id = activePeerId;
        return id == null ? null : store.getPeer(id);
    }

    public RemoteSnapshot activeSnapshot() {
        return activeSnapshot;
    }

    public PeerStatus statusOf(String deviceId) {
        if (deviceId == null) return null;
        return statuses.computeIfAbsent(deviceId, PeerStatus::new);
    }

    public void selectLocal() {
        activePeerId = null;
        activeSnapshot = new RemoteSnapshot();
    }

    public void selectRemote(String deviceId) {
        if (deviceId == null || store.getPeer(deviceId) == null) {
            selectLocal();
            return;
        }
        activePeerId = deviceId;
        activeSnapshot = new RemoteSnapshot();
        reconnectNow(deviceId);
        refreshActiveSnapshotAsync();
    }

    /** 当前活跃远端是否处于低延迟直连通道（局域网 / 组网 / IPv6 / 自定义公网 / P2P直连），用于自适应同步频率与缓存 TTL。 */
    public boolean isCurrentChannelFast() {
        String id = activePeerId;
        if (id == null) return true;
        PeerStatus st = statuses.get(id);
        if (st == null || st.state != ConnState.CONNECTED) return false;
        return !"加密中继".equals(st.channelLabel);
    }

    public void triggerSnapshotRefresh() {
        if (!isRemote()) return;
        synchronized (snapWakeLock) {
            snapWakeLock.notifyAll();
        }
        refreshActiveSnapshotAsync();
    }

    // ------------------------------------------------------------------ 扫码/口令配对

    /**
     * 使用配对二维码 URI 或口令完成端到端配对（支持 180 秒单次密钥自动通过，无需被控端二次确认）。
     * 必须在后台线程调用。
     */
    public RemoteStore.PairedPeer pairWithUri(String rawUri) throws IOException {
        return pairWithUri(rawUri, null);
    }

    public RemoteStore.PairedPeer pairWithUri(String rawUri, PairingProgressListener progress) throws IOException {
        RemoteCrypto.PairPayload payload = RemoteCrypto.PairPayload.parse(rawUri);
        if (payload.deviceId.equals(store.identity().deviceId)) {
            throw new IOException("不能配对本机自己");
        }
        // 放宽本机时钟容差（10 分钟内交由被控端权威时钟核验 180 秒票据，避免两台手机时钟偏差误拒）
        if (payload.expiresAt > 0 && System.currentTimeMillis() - payload.expiresAt > 600_000L) {
            throw new IOException("该配对码已过期，请在被控设备刷新配对码");
        }
        byte[] peerPub = RemoteCrypto.b64UrlDecode(payload.pubKeyB64);
        byte[] pairSec = RemoteCrypto.b64UrlDecode(payload.pairSecretB64);
        List<String> relays = payload.relays.isEmpty() ? store.effectiveRelays() : payload.relays;

        Log.i(TAG, "pairWithUri target=" + shortPrefix(payload.deviceId)
                + " lan=" + payload.lanEndpoint + " v6=" + payload.ipv6Endpoint
                + " relays=" + relays.size());
        ConnectOutcome out = connectLayered(
                payload.deviceId, peerPub, pairSec, pairSec,
                payload.lanEndpoint, payload.ipv6Endpoint, payload.stunEndpoint, "", relays, progress
        );

        RemoteStore.PairedPeer peer = new RemoteStore.PairedPeer(
                out.handshake.peerDeviceId,
                out.handshake.peerName,
                "",
                out.handshake.peerPubKeyB64,
                RemoteCrypto.b64UrlEncode(out.handshake.sharedSecret),
                out.handshake.permission
        );
        peer.lastLan = payload.lanEndpoint;
        peer.lastV6 = payload.ipv6Endpoint;
        peer.lastStun = payload.stunEndpoint;
        peer.relays.addAll(relays);
        peer.lastSeenAt = System.currentTimeMillis();
        store.upsertPeer(peer);

        attachSession(peer.deviceId, out.handshake.session, out.channelLabel);
        ensurePeerSignalingSub(peer);
        if ("加密中继".equals(out.channelLabel)) {
            tryInBandUpgradeAsync(peer.deviceId, out.handshake.session);
        }
        return peer;
    }

    public void removePeer(String deviceId) {
        if (deviceId == null) return;
        if (deviceId.equals(activePeerId)) selectLocal();
        RemoteTransport.Session s = sessions.remove(deviceId);
        if (s != null) s.close();
        NostrSignaling.Subscription sub = peerSignalSubs.remove(deviceId);
        if (sub != null) sub.close();
        statuses.remove(deviceId);
        store.removePeer(deviceId);
    }

    public void reconnectNow(final String deviceId) {
        if (deviceId == null) return;
        Thread t = new Thread(() -> ensurePeerConnected(deviceId, true), "remote-reconn");
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------------ RPC 与流式传输代理

    public RemoteTransport.Session activeSession() {
        String id = activePeerId;
        if (id == null) return null;
        RemoteTransport.Session s = sessions.get(id);
        return (s != null && s.isOpen()) ? s : null;
    }

    public JSONObject callActiveRpc(String method, JSONObject params, int timeoutMs) throws IOException {
        RemoteTransport.Session s = activeSession();
        if (s == null) {
            String id = activePeerId;
            if (id != null) {
                ensurePeerConnected(id, true);
                s = activeSession();
            }
        }
        if (s == null) throw new IOException("远端设备当前离线，正在重连…");
        String resp = s.callRpc(method, params == null ? "{}" : params.toString(), timeoutMs);
        try {
            return new JSONObject(resp == null || resp.isEmpty() ? "{}" : resp);
        } catch (Exception e) {
            throw new IOException("远端返回格式异常", e);
        }
    }

    public JSONObject callActiveRpcQuiet(String method, JSONObject params, int timeoutMs) {
        try {
            return callActiveRpc(method, params, timeoutMs);
        } catch (Throwable t) {
            return null;
        }
    }

    public String uploadToActive(String metaJson, InputStream data, long totalBytes,
                                 RemoteTransport.ProgressCallback cb) throws IOException {
        RemoteTransport.Session s = activeSession();
        if (s == null) throw new IOException("远端设备当前离线");
        return s.uploadStream(metaJson, data, totalBytes, cb);
    }

    public String downloadFromActive(String metaJson, OutputStream dest, long expectedBytes,
                                     int timeoutMs, RemoteTransport.ProgressCallback cb) throws IOException {
        RemoteTransport.Session s = activeSession();
        if (s == null) throw new IOException("远端设备当前离线");
        return s.downloadStream(metaJson, dest, expectedBytes, timeoutMs, cb);
    }

    // ------------------------------------------------------------------ 后台全设备心跳与快照轮询

    private void heartbeatLoop() {
        Map<String, Long> nextRetryAt = new ConcurrentHashMap<String, Long>();
        Map<String, Long> backoffMs = new ConcurrentHashMap<String, Long>();
        while (poolRunning.get()) {
            try {
                List<RemoteStore.PairedPeer> list = store.listPeers();
                long now = System.currentTimeMillis();
                for (RemoteStore.PairedPeer peer : list) {
                    ensurePeerSignalingSub(peer);
                    RemoteTransport.Session s = sessions.get(peer.deviceId);
                    PeerStatus st = statusOf(peer.deviceId);
                    if (s != null && s.isOpen()) {
                        long rtt = s.ping(3500);
                        if (rtt > 0) {
                            st.state = ConnState.CONNECTED;
                            st.rttMs = rtt;
                            st.lastOkAt = System.currentTimeMillis();
                            st.lastError = "";
                            backoffMs.remove(peer.deviceId);
                        } else {
                            s.close();
                            sessions.remove(peer.deviceId, s);
                            st.state = ConnState.RECONNECTING;
                            st.rttMs = -1;
                        }
                    } else {
                        long due = nextRetryAt.containsKey(peer.deviceId) ? nextRetryAt.get(peer.deviceId) : 0L;
                        if (now >= due) {
                            boolean ok = ensurePeerConnected(peer.deviceId, false);
                            if (ok) {
                                backoffMs.remove(peer.deviceId);
                                nextRetryAt.remove(peer.deviceId);
                            } else {
                                long cur = backoffMs.containsKey(peer.deviceId) ? backoffMs.get(peer.deviceId) : 1000L;
                                long next = Math.min(15_000L, cur * 2L);
                                backoffMs.put(peer.deviceId, next);
                                nextRetryAt.put(peer.deviceId, System.currentTimeMillis() + cur);
                            }
                        }
                    }
                }
            } catch (Throwable ignored) {
            }
            try {
                Thread.sleep(6000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    private void activeSnapshotLoop() {
        while (poolRunning.get()) {
            try {
                if (isRemote()) {
                    RemoteTransport.Session s = activeSession();
                    if (s != null) {
                        refreshActiveSnapshotBlocking();
                        // 若当前仍走加密中继，每 90 秒后台静默尝试一次带内热升级到直连/P2P
                        if (!isCurrentChannelFast()) {
                            long now = System.currentTimeMillis();
                            if (now - lastInBandUpgradeAttemptAt >= 90_000L) {
                                lastInBandUpgradeAttemptAt = now;
                                tryInBandUpgradeAsync(activePeerId, s);
                            }
                        }
                    }
                }
            } catch (Throwable ignored) {
            }
            // 方案 A 按网速自适应同步间隔：局域网/公网直连 2s 高频实时，跨网中继 7s 省流保流畅（操作后立即唤醒）
            long waitMs = isCurrentChannelFast() ? 2000L : 7000L;
            synchronized (snapWakeLock) {
                try {
                    snapWakeLock.wait(waitMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
    }

    private void refreshActiveSnapshotAsync() {
        Thread t = new Thread(this::refreshActiveSnapshotBlocking, "remote-snap-once");
        t.setDaemon(true);
        t.start();
    }

    private void refreshActiveSnapshotBlocking() {
        String id = activePeerId;
        if (id == null) return;
        RemoteTransport.Session s = sessions.get(id);
        if (s == null || !s.isOpen()) return;
        try {
            RemoteSnapshot snap = activeSnapshot;
            JSONObject req = new JSONObject();
            if (!snap.botsHash.isEmpty()) req.put("botsHash", snap.botsHash);
            if (!snap.loginLogHash.isEmpty()) req.put("loginLogHash", snap.loginLogHash);
            if (!snap.containerLogHash.isEmpty()) req.put("containerLogHash", snap.containerLogHash);
            if (snap.qrLive && snap.qrBitmap != null && snap.qrMtime > 0) req.put("qrMtime", snap.qrMtime);

            String raw = s.callRpc("system.snapshot", req.toString(), 6000);
            if (raw == null || raw.isEmpty()) return;
            JSONObject o = new JSONObject(raw);
            if (!id.equals(activePeerId)) return;
            snap.containerRunning = o.optBoolean("containerRunning", false);
            snap.botRunning = o.optBoolean("botRunning", false);
            String uin = o.optString("loginUin", "");
            snap.loginUin = uin.isEmpty() ? null : uin;
            snap.qrLive = o.optBoolean("qrLive", false);
            snap.qrLeftSeconds = o.optLong("qrLeftSeconds", 0);
            snap.qrUrl = snap.qrLive ? o.optString("qrUrl", "") : "";
            snap.botStateJson = o.optString("botStateJson", "");
            snap.hasSavedCred = o.optBoolean("hasSavedCred", false);
            snap.savedCredUin = o.optString("savedCredUin", "");
            long mtime = o.optLong("qrMtime", 0);
            if (snap.qrLive && (snap.qrBitmap == null || mtime != snap.qrMtime)) {
                String qrB64 = o.optString("qrPngB64", "");
                if (!qrB64.isEmpty()) {
                    try {
                        byte[] bytes = RemoteCrypto.b64Decode(qrB64);
                        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                        if (bmp != null) {
                            snap.qrPngBytes = bytes;
                            snap.qrBitmap = bmp;
                            snap.qrMtime = mtime;
                        }
                    } catch (Throwable ignored) {
                    }
                }
            } else if (!snap.qrLive) {
                snap.qrBitmap = null;
                snap.qrPngBytes = null;
                snap.qrMtime = 0;
                snap.qrUrl = "";
            }
            // 主力机实时离线告警：远端一旦跃迁到被踢/票据过期/待滑块/断连需人工态，立刻在主力机弹高优先级通知
            checkRemoteOfflineAlert(id, snap);
            snap.setupEnv = o.optBoolean("setupEnv", false);
            snap.setupQq = o.optBoolean("setupQq", false);
            snap.setupBot = o.optBoolean("setupBot", false);
            snap.watchdogEnabled = o.optBoolean("watchdogEnabled", true);
            String qv = o.optString("qqClientVersion", "");
            snap.qqClientVersion = qv.isEmpty() ? null : qv;
            snap.appVersionName = o.optString("appVersionName", "");
            snap.appVersionCode = o.optInt("appVersionCode", 0);
            if (o.has("loginLog")) snap.loginLog = o.optString("loginLog", "");
            if (o.has("containerLog")) snap.containerLog = o.optString("containerLog", "");
            if (o.has("loginLogHash")) snap.loginLogHash = o.optString("loginLogHash", "");
            if (o.has("containerLogHash")) snap.containerLogHash = o.optString("containerLogHash", "");
            if (o.has("botsHash")) snap.botsHash = o.optString("botsHash", "");
            snap.updatedAt = System.currentTimeMillis();

            TargetChangeListener l = snapshotListener;
            if (l != null && o.has("botsJson")) {
                l.onRemoteSnapshotUpdated(id, o.optString("botsJson", ""), o.optString("coresJson", ""));
            }
        } catch (Throwable ignored) {
        }
    }

    private void checkRemoteOfflineAlert(String peerId, RemoteSnapshot snap) {
        if (peerId == null || snap == null || !snap.containerRunning) return;
        com.whaleonebot.ui.QqAuthState st = com.whaleonebot.ui.QqAuthState.parseBotJson(snap.botStateJson);
        if (st.isOnline()) {
            lastPeerOfflineAlert.remove(peerId);
            return;
        }
        if ("kicked-offline".equals(st.phase)
                || "token-expired".equals(st.phase)
                || "verify-required".equals(st.phase)
                || ("degraded".equals(st.phase) && st.needsManualLogin)) {
            String sig = st.phase + "|" + st.offlineReason + "|" + st.verifyAt;
            String prev = lastPeerOfflineAlert.put(peerId, sig);
            if (!sig.equals(prev)) {
                RemoteStore.PairedPeer peer = store.getPeer(peerId);
                String name = peer == null ? "远端设备" : peer.displayName();
                com.whaleonebot.ContainerService.postOfflineNotification(
                        ctx,
                        "远端「" + name + "」" + st.shortBadge(true),
                        st.detailMessage(true),
                        peerId);
            }
        }
    }

    // ------------------------------------------------------------------ 四级零服务器 P2P 连接器

    private static final class ConnectOutcome {
        final RemoteTransport.HandshakeResult handshake;
        final String channelLabel;

        ConnectOutcome(RemoteTransport.HandshakeResult h, String ch) {
            this.handshake = h;
            this.channelLabel = ch;
        }
    }

    private boolean ensurePeerConnected(String deviceId, boolean force) {
        RemoteStore.PairedPeer peer = store.getPeer(deviceId);
        if (peer == null) return false;
        RemoteTransport.Session cur = sessions.get(deviceId);
        if (!force && cur != null && cur.isOpen()) return true;

        PeerStatus st = statusOf(deviceId);
        st.state = (st.lastOkAt > 0) ? ConnState.RECONNECTING : ConnState.CONNECTING;

        String mdnsLan = mdnsLanEndpoints.get(shortPrefix(deviceId));
        String lan = (mdnsLan != null && !mdnsLan.isEmpty()) ? mdnsLan : peer.lastLan;
        String v6 = peer.lastV6;
        String stun = peer.lastStun;
        String hint = beaconHints.get(deviceId);
        if (hint != null) {
            String hLan = NostrSignaling.extractJsonString(hint, "lan");
            String hV6 = NostrSignaling.extractJsonString(hint, "v6");
            String hStun = NostrSignaling.extractJsonString(hint, "stun");
            if (hLan != null && !hLan.isEmpty() && (mdnsLan == null || mdnsLan.isEmpty())) lan = hLan;
            if (hV6 != null && !hV6.isEmpty()) v6 = hV6;
            if (hStun != null && !hStun.isEmpty()) stun = hStun;
        }
        List<String> relays = peer.relays.isEmpty() ? store.effectiveRelays() : peer.relays;

        try {
            ConnectOutcome out = connectLayered(
                    peer.deviceId, peer.publicKeyBytes(), null, peer.sharedSecretBytes(),
                    lan, v6, stun, peer.customDirect, relays, null
            );
            attachSession(peer.deviceId, out.handshake.session, out.channelLabel);
            store.updatePeerEndpoints(peer.deviceId, lan, v6, stun);
            if ("加密中继".equals(out.channelLabel)) {
                tryInBandUpgradeAsync(peer.deviceId, out.handshake.session);
            }
            return true;
        } catch (Throwable t) {
            st.state = (st.lastOkAt > 0) ? ConnState.RECONNECTING : ConnState.OFFLINE;
            st.rttMs = -1;
            st.lastError = t.getMessage() == null ? "无法连接" : t.getMessage();
            return false;
        }
    }

    private static final class DirectCandidate {
        final String hostPort;
        final int timeoutMs;
        final String label;
        final int priority;

        DirectCandidate(String hostPort, int timeoutMs, String label, int priority) {
            this.hostPort = hostPort;
            this.timeoutMs = timeoutMs;
            this.label = label;
            this.priority = priority;
        }
    }

    private static void emitProgress(PairingProgressListener progress, String msg) {
        if (progress != null && msg != null) {
            try {
                progress.onProgress(msg);
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * 借鉴 ds-harness-remote 的「并发直连竞速 + 预热加密中继秒连 + 带内热升级」连接器：
     * 1) 局域网 / Tailscale / 自定义公网直连（未来 Linux 云主机直连）/ IPv6 全部并发探测（总上限 ~2.2s）；
     * 2) 与此同时后台预热多协议加密中继（国内免代理 MQTT-TLS + Nostr），跨网时零空等直接秒连；
     * 3) 若经中继连上，随后在已打通的加密会话带内协商升级到直连或 UDP 打洞 P2P，全程零断连。
     */
    private ConnectOutcome connectLayered(
            final String peerId, final byte[] peerPub, final byte[] pairSecretOrNull, final byte[] signalSecret,
            String lanEp, String v6Ep, String stunEp, String customDirect, final List<String> relays,
            final PairingProgressListener progress
    ) throws IOException {
        final List<String> errors = java.util.Collections.synchronizedList(new ArrayList<String>());

        // 组装所有直连 TCP 候选（并发竞速，消除旧版 35 秒串行瀑布）
        List<DirectCandidate> directList = new ArrayList<DirectCandidate>();
        if (lanEp != null && !lanEp.isEmpty()) {
            for (String ep : lanEp.split(",")) {
                String cand = ep.trim();
                if (cand.isEmpty()) continue;
                boolean isTs = cand.startsWith("100.");
                directList.add(new DirectCandidate(cand, isTs ? 2000 : 1500, isTs ? "组网直连" : "局域网", isTs ? 2 : 1));
            }
        }
        if (customDirect != null && !customDirect.isEmpty()) {
            directList.add(new DirectCandidate(customDirect.trim(), 2200, "自定义直连", 0));
        }
        if (v6Ep != null && !v6Ep.isEmpty()) {
            directList.add(new DirectCandidate(v6Ep.trim(), 1900, "IPv6直连", 3));
        }

        // 若存在跨网信令密钥，立刻在后台预热中继订阅（与直连竞速并行，跨网零等待）
        final boolean hasSignal = signalSecret != null && signalSecret.length > 0;
        final String preSid = hasSignal ? RemoteCrypto.hex(RemoteCrypto.randomBytes(6)) : null;
        final CountDownLatch preHostReady = hasSignal ? new CountDownLatch(1) : null;
        NostrSignaling.Subscription preCtrlSub = null;
        NostrRelayChannel preRelayCh = null;
        if (hasSignal) {
            preCtrlSub = NostrSignaling.subscribe(relays, signalSecret, (json, r) -> {
                String role = NostrSignaling.extractJsonString(json, "role");
                String rsid = NostrSignaling.extractJsonString(json, "sid");
                if ("host_relay_ready".equals(role) && preSid.equals(rsid)) {
                    preHostReady.countDown();
                }
            });
            preRelayCh = new NostrRelayChannel(relays, preSid, "c", signalSecret);
        }

        boolean keepPreWarm = false;
        try {
            if (!directList.isEmpty()) {
                emitProgress(progress, "正在并发探测局域网 / 直连通道…");
                ConnectOutcome directWinner = raceDirectTcp(peerId, peerPub, pairSecretOrNull, directList, errors);
                if (directWinner != null) {
                    Log.i(TAG, "direct race won: " + directWinner.channelLabel);
                    return directWinner;
                }
            }
            if (hasSignal) {
                keepPreWarm = true;
                try {
                    return connectPrewarmedRelay(peerId, peerPub, pairSecretOrNull, signalSecret, relays,
                            preSid, preCtrlSub, preRelayCh, preHostReady, progress);
                } catch (Throwable t) {
                    errors.add("加密中继:" + t.getMessage());
                    Log.w(TAG, "relay connect failed: " + t.getMessage());
                }
                // 极端情况下（例如自定义中继不支持长连分片），保留一次性 STUN UDP 打洞作为最后兜底
                emitProgress(progress, "加密中继受限，正在尝试 STUN UDP 直连打洞…");
                try {
                    return connectUdpPunch(peerId, peerPub, pairSecretOrNull, signalSecret, relays);
                } catch (Throwable t) {
                    errors.add("UDP打洞:" + t.getMessage());
                }
            }
        } finally {
            if (!keepPreWarm) {
                if (preCtrlSub != null) preCtrlSub.close();
                if (preRelayCh != null) preRelayCh.close();
            }
        }

        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < errors.size(); i++) {
            if (i > 0) sb.append("；");
            sb.append(errors.get(i));
        }
        throw new IOException(sb.length() == 0 ? "未找到可用网络通道" : sb.toString());
    }

    /** 并发竞速所有 TCP 直连候选，首个完成端到端 ECDH 握手的通道立即胜出，其余自动关闭。 */
    private ConnectOutcome raceDirectTcp(
            final String peerId, final byte[] peerPub, final byte[] pairSecretOrNull,
            List<DirectCandidate> candidates, final List<String> errors
    ) {
        final AtomicReference<ConnectOutcome> winner = new AtomicReference<ConnectOutcome>(null);
        final CountDownLatch anyWin = new CountDownLatch(1);
        final CountDownLatch allDone = new CountDownLatch(candidates.size());

        for (final DirectCandidate c : candidates) {
            Thread t = new Thread(() -> {
                try {
                    ConnectOutcome out = connectTcp(peerId, peerPub, pairSecretOrNull, c.hostPort, c.timeoutMs, c.label);
                    if (winner.compareAndSet(null, out)) {
                        anyWin.countDown();
                    } else {
                        out.handshake.session.close();
                    }
                } catch (Throwable e) {
                    errors.add(c.label + ":" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
                } finally {
                    allDone.countDown();
                }
            }, "direct-race-" + c.label);
            t.setDaemon(true);
            t.start();
        }
        long deadline = System.currentTimeMillis() + 2300L;
        while (System.currentTimeMillis() < deadline) {
            if (winner.get() != null) return winner.get();
            if (allDone.getCount() == 0) break;
            try {
                anyWin.await(100, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return winner.get();
    }

    /**
     * Relay-First 跨网端到端加密秒连（已彻底修复旧版 ctrlSub 未等就绪的竞态与单节点失配）：
     * 1) 确保 ctrlSub 与 NostrRelayChannel 均已订阅 ≥2 个在线公共节点（国内免代理 MQTT-TLS + Nostr）；
     * 2) 最多重发 4 次 ctrl_relay（每 1.8s 一次），直到收到 host_relay_ready；
     * 3) 立即在加密中继通道上完成双向 ECDH 握手，返回「加密中继」可用会话。
     */
    private ConnectOutcome connectPrewarmedRelay(
            String peerId, byte[] peerPub, byte[] pairSecretOrNull, byte[] signalSecret, List<String> relays,
            String sid, NostrSignaling.Subscription ctrlSub, NostrRelayChannel ch, CountDownLatch hostReady,
            PairingProgressListener progress
    ) throws IOException {
        try {
            emitProgress(progress, "跨网直连不可达，正在连接加密信令节点…");
            boolean sigReady = ctrlSub.awaitReady(Math.min(2, relays.size()), 3200);
            boolean chReady = ch.awaitReady(2800);
            int sigNodes = ctrlSub.connectedCount();
            int chNodes = ch.connectedRelayCount();
            Log.i(TAG, "relay prewarm sid=" + sid + " sigNodes=" + sigNodes + "/" + ctrlSub.totalPoolSize()
                    + " chNodes=" + chNodes);
            if (!sigReady && !chReady && sigNodes == 0) {
                throw new IOException("公共信令节点 0/" + relays.size() + " 可用，请检查手机网络");
            }

            emitProgress(progress, "已连上 " + Math.max(sigNodes, chNodes) + " 个加密节点，正在呼叫远端设备…");
            String openReq = "{\"role\":\"ctrl_relay\",\"sid\":" + NostrSignaling.jsonStr(sid)
                    + ",\"ts\":" + System.currentTimeMillis() + "}";

            boolean gotReady = false;
            boolean anySent = false;
            for (int attempt = 0; attempt < 4; attempt++) {
                int bcast = ctrlSub.broadcastPayload(openReq);
                if (bcast > 0) anySent = true;
                if (bcast < Math.min(2, relays.size()) || attempt == 0) {
                    if (NostrSignaling.publish(relays, signalSecret, openReq, 2600)) {
                        anySent = true;
                    }
                }
                if (hostReady.await(1900, TimeUnit.MILLISECONDS)) {
                    gotReady = true;
                    break;
                }
                emitProgress(progress, "正在等待远端响应加密握手（第 " + (attempt + 2) + "/4 次）…");
            }
            if (!anySent) {
                throw new IOException("加密信令发送失败（在线节点 " + sigNodes + "/" + relays.size() + "）");
            }
            if (!gotReady) {
                throw new IOException("远端未响应握手（在线节点 " + sigNodes + "/" + relays.size()
                        + "；请确认被控端停留在配对码页面且已联网）");
            }

            emitProgress(progress, "远端已应答，正在完成端到端加密认证…");
            RemoteStore.LocalIdentity me = store.identity();
            RemoteTransport.HandshakeResult hr = RemoteTransport.handshakeAsClient(
                    ch, me.deviceId, me.deviceName, me.privateKey(), me.publicKeyBytes(),
                    peerId, peerPub, pairSecretOrNull,
                    null, null,
                    (sess, reason) -> onPeerDisconnected(peerId, sess, reason)
            );
            Log.i(TAG, "relay handshake OK sid=" + sid + " peer=" + shortPrefix(hr.peerDeviceId));
            return new ConnectOutcome(hr, "加密中继");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            ch.close();
            throw new IOException("配对被中断", e);
        } catch (Throwable t) {
            ch.close();
            if (t instanceof IOException) throw (IOException) t;
            throw new IOException(t.getMessage(), t);
        } finally {
            ctrlSub.close();
        }
    }

    /**
     * 借鉴 ds-harness-remote TransportUpgradeHost：在加密中继已连通后，后台静默通过带内 RPC
     * 交换实时局域网/IPv6 与 STUN 端口，尝试无感升级到局域网直连或 UDP P2P 直连；失败完全不影响当前中继会话。
     */
    private void tryInBandUpgradeAsync(final String peerId, final RemoteTransport.Session relaySess) {
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(1200L);
                if (relaySess == null || !relaySess.isOpen()) return;
                if (sessions.get(peerId) != relaySess) return;
                RemoteStore.PairedPeer peer = store.getPeer(peerId);
                if (peer == null) return;

                DatagramSocket udpSock = null;
                StunClient.Endpoint myStun = null;
                try {
                    udpSock = new DatagramSocket(0);
                    myStun = StunClient.discover(udpSock, 1100);
                } catch (Throwable ignored) {
                    if (udpSock != null) {
                        try { udpSock.close(); } catch (Throwable ignored2) {}
                        udpSock = null;
                    }
                }

                String reqJson = myStun == null ? "{}"
                        : ("{\"ctrlStun\":" + NostrSignaling.jsonStr(myStun.toHostPort()) + "}");
                String probeRaw = relaySess.callRpc("remote.transport.probe", reqJson, 4500);
                if (probeRaw == null || probeRaw.isEmpty()) {
                    if (udpSock != null) try { udpSock.close(); } catch (Throwable ignored) {}
                    return;
                }
                String freshLan = NostrSignaling.extractJsonString(probeRaw, "lan");
                String freshV6 = NostrSignaling.extractJsonString(probeRaw, "v6");
                String punchStun = NostrSignaling.extractJsonString(probeRaw, "punchStun");

                // 1) 优先尝试局域网 / Tailscale / IPv6 直连 TCP
                List<DirectCandidate> direct = new ArrayList<DirectCandidate>();
                if (freshLan != null && !freshLan.isEmpty()) {
                    for (String ep : freshLan.split(",")) {
                        String cand = ep.trim();
                        if (cand.isEmpty()) continue;
                        boolean isTs = cand.startsWith("100.");
                        direct.add(new DirectCandidate(cand, isTs ? 1800 : 1200, isTs ? "组网直连" : "局域网", 1));
                    }
                }
                if (freshV6 != null && !freshV6.isEmpty()) {
                    direct.add(new DirectCandidate(freshV6.trim(), 1600, "IPv6直连", 2));
                }

                ConnectOutcome upgraded = null;
                if (!direct.isEmpty()) {
                    upgraded = raceDirectTcp(peerId, peer.publicKeyBytes(), null, direct, new ArrayList<String>());
                }

                // 2) 若 TCP 直连不通且双方 STUN 均就绪，利用刚在带内精准同步的端口立即 UDP 打洞升级 P2P
                if (upgraded == null && udpSock != null && punchStun != null && !punchStun.isEmpty()) {
                    InetSocketAddress peerUdp = RemoteHostServer.parseHostPort(punchStun);
                    if (peerUdp != null) {
                        try {
                            RemoteTransport.UdpReliableChannel udpCh =
                                    new RemoteTransport.UdpReliableChannel(udpSock, peerUdp, true);
                            udpSock = null; // 所有权转交给 udpCh
                            udpCh.sendPunchBurst(10, 100);
                            RemoteStore.LocalIdentity me = store.identity();
                            RemoteTransport.HandshakeResult hr = RemoteTransport.handshakeAsClient(
                                    udpCh, me.deviceId, me.deviceName, me.privateKey(), me.publicKeyBytes(),
                                    peerId, peer.publicKeyBytes(), null,
                                    null, null,
                                    (sess, reason) -> onPeerDisconnected(peerId, sess, reason)
                            );
                            upgraded = new ConnectOutcome(hr, "P2P直连");
                        } catch (Throwable ignored) {
                        }
                    }
                }
                if (udpSock != null) {
                    try { udpSock.close(); } catch (Throwable ignored) {}
                }

                if (upgraded != null) {
                    long pingMs = upgraded.handshake.session.ping(2500);
                    if (pingMs > 0 && sessions.get(peerId) == relaySess) {
                        sessions.put(peerId, upgraded.handshake.session);
                        PeerStatus st = statusOf(peerId);
                        st.state = ConnState.CONNECTED;
                        st.channelLabel = upgraded.channelLabel;
                        st.rttMs = pingMs;
                        st.lastOkAt = System.currentTimeMillis();
                        st.lastError = "";
                        store.updatePeerEndpoints(peerId, freshLan, freshV6, punchStun);
                        Log.i(TAG, "in-band upgrade succeeded: peer=" + shortPrefix(peerId)
                                + " -> " + upgraded.channelLabel + " (" + pingMs + "ms)");
                        // 排空 500ms 后优雅关闭旧的中继会话，避免打断在途 RPC
                        try { Thread.sleep(500L); } catch (InterruptedException ignored) {}
                        relaySess.close();
                    } else {
                        upgraded.handshake.session.close();
                    }
                }
            } catch (Throwable err) {
                Log.i(TAG, "in-band upgrade skipped/kept relay: " + err.getMessage());
            }
        }, "remote-inband-upgrade");
        t.setDaemon(true);
        t.start();
    }

    private ConnectOutcome connectTcp(String peerId, byte[] peerPub, byte[] pairSecretOrNull,
                                      String hostPort, int timeoutMs, String label) throws IOException {
        InetSocketAddress addr = RemoteHostServer.parseHostPort(hostPort);
        if (addr == null) throw new IOException("地址格式无效");
        Socket sock = new Socket();
        try {
            sock.connect(addr, timeoutMs);
            sock.setSoTimeout(6000);
            RemoteTransport.TcpChannel ch = new RemoteTransport.TcpChannel(sock);
            RemoteStore.LocalIdentity me = store.identity();
            RemoteTransport.HandshakeResult hr = RemoteTransport.handshakeAsClient(
                    ch, me.deviceId, me.deviceName, me.privateKey(), me.publicKeyBytes(),
                    peerId, peerPub, pairSecretOrNull,
                    null, null,
                    (sess, reason) -> onPeerDisconnected(peerId, sess, reason)
            );
            sock.setSoTimeout(0);
            return new ConnectOutcome(hr, label);
        } catch (Throwable t) {
            try { sock.close(); } catch (Throwable ignored) {}
            if (t instanceof IOException) throw (IOException) t;
            throw new IOException(t.getMessage(), t);
        }
    }

    private ConnectOutcome connectUdpPunch(String peerId, byte[] peerPub, byte[] pairSecretOrNull,
                                           byte[] signalSecret, List<String> relays) throws IOException {
        DatagramSocket ds = new DatagramSocket(0);
        NostrSignaling.Subscription sub = null;
        try {
            StunClient.Endpoint myEp = StunClient.discover(ds, 1800);
            if (myEp == null) throw new IOException("STUN 不可达");
            final String punchSid = RemoteCrypto.hex(RemoteCrypto.randomBytes(6));
            final AtomicReference<String> targetStun = new AtomicReference<String>("");
            final CountDownLatch gotHost = new CountDownLatch(1);
            sub = NostrSignaling.subscribe(relays, signalSecret, (json, r) -> {
                String role = NostrSignaling.extractJsonString(json, "role");
                String sid = NostrSignaling.extractJsonString(json, "sid");
                // 只认匹配本次 sid 的 host_punch（严禁错打旧信标的静态端口）
                if ("host_punch".equals(role) && (sid == null || sid.isEmpty() || punchSid.equals(sid))) {
                    String ep = NostrSignaling.extractJsonString(json, "stun");
                    if (ep != null && !ep.isEmpty()) {
                        targetStun.set(ep);
                        gotHost.countDown();
                    }
                }
            });
            sub.awaitReady(Math.min(2, relays.size()), 2200);
            String req = "{\"role\":\"ctrl_punch\",\"sid\":" + NostrSignaling.jsonStr(punchSid)
                    + ",\"stun\":" + NostrSignaling.jsonStr(myEp.toHostPort())
                    + ",\"ts\":" + System.currentTimeMillis() + "}";
            NostrSignaling.publish(relays, signalSecret, req, 3000);
            gotHost.await(4500, TimeUnit.MILLISECONDS);
            InetSocketAddress peerAddr = RemoteHostServer.parseHostPort(targetStun.get());
            if (peerAddr == null) throw new IOException("未收到远端打洞响应");

            RemoteTransport.UdpReliableChannel udp = new RemoteTransport.UdpReliableChannel(ds, peerAddr, true);
            udp.sendPunchBurst(10, 120);
            RemoteStore.LocalIdentity me = store.identity();
            RemoteTransport.HandshakeResult hr = RemoteTransport.handshakeAsClient(
                    udp, me.deviceId, me.deviceName, me.privateKey(), me.publicKeyBytes(),
                    peerId, peerPub, pairSecretOrNull,
                    null, null,
                    (sess, reason) -> onPeerDisconnected(peerId, sess, reason)
            );
            return new ConnectOutcome(hr, "P2P直连");
        } catch (Throwable t) {
            try { ds.close(); } catch (Throwable ignored) {}
            if (t instanceof IOException) throw (IOException) t;
            throw new IOException(t.getMessage(), t);
        } finally {
            if (sub != null) sub.close();
        }
    }

    private void attachSession(String peerId, RemoteTransport.Session sess, String channelLabel) {
        RemoteTransport.Session old = sessions.put(peerId, sess);
        if (old != null && old != sess) old.close();
        PeerStatus st = statusOf(peerId);
        st.state = ConnState.CONNECTED;
        st.channelLabel = channelLabel;
        st.lastOkAt = System.currentTimeMillis();
        st.lastError = "";
        long rtt = sess.ping(2500);
        if (rtt > 0) st.rttMs = rtt;
    }

    private void onPeerDisconnected(String peerId, RemoteTransport.Session sess, String reason) {
        if (sessions.remove(peerId, sess)) {
            PeerStatus st = statusOf(peerId);
            st.state = ConnState.RECONNECTING;
            st.rttMs = -1;
            st.lastError = reason == null ? "连接中断" : reason;
        }
    }

    private void ensurePeerSignalingSub(final RemoteStore.PairedPeer peer) {
        if (peerSignalSubs.containsKey(peer.deviceId)) return;
        List<String> relays = peer.relays.isEmpty() ? store.effectiveRelays() : peer.relays;
        NostrSignaling.Subscription sub = NostrSignaling.subscribe(relays, peer.sharedSecretBytes(), (json, relay) -> {
            String role = NostrSignaling.extractJsonString(json, "role");
            if ("host".equals(role)) {
                beaconHints.put(peer.deviceId, json);
            }
        });
        peerSignalSubs.put(peer.deviceId, sub);
    }

    private void startMdnsDiscovery() {
        try {
            nsdManager = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
            if (nsdManager == null) return;
            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override public void onDiscoveryStarted(String regType) {}
                @Override public void onServiceFound(NsdServiceInfo info) {
                    if (info == null || info.getServiceName() == null) return;
                    if (!info.getServiceName().startsWith("Whale-")) return;
                    try {
                        nsdManager.resolveService(info, new NsdManager.ResolveListener() {
                            @Override public void onResolveFailed(NsdServiceInfo s, int err) {}
                            @Override public void onServiceResolved(NsdServiceInfo s) {
                                if (s.getHost() == null || s.getPort() <= 0) return;
                                String key = s.getServiceName().substring("Whale-".length());
                                mdnsLanEndpoints.put(key, s.getHost().getHostAddress() + ":" + s.getPort());
                            }
                        });
                    } catch (Throwable ignored) {
                    }
                }
                @Override public void onServiceLost(NsdServiceInfo info) {
                    if (info != null && info.getServiceName() != null && info.getServiceName().startsWith("Whale-")) {
                        mdnsLanEndpoints.remove(info.getServiceName().substring("Whale-".length()));
                    }
                }
                @Override public void onDiscoveryStopped(String type) {}
                @Override public void onStartDiscoveryFailed(String type, int err) {}
                @Override public void onStopDiscoveryFailed(String type, int err) {}
            };
            nsdManager.discoverServices(RemoteHostServer.MDNS_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Throwable t) {
            Log.w(TAG, "mDNS discovery unavailable: " + t.getMessage());
        }
    }

    private void registerNetworkCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    // 切网（Wi-Fi ↔ 5G）立即重连当前活跃远端
                    String active = activePeerId;
                    if (active != null && activeSession() == null) {
                        reconnectNow(active);
                    }
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private static String shortPrefix(String deviceId) {
        return deviceId.length() > 12 ? deviceId.substring(0, 12) : deviceId;
    }
}
