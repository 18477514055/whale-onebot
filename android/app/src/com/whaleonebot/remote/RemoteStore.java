package com.whaleonebot.remote;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * [layer: shell-android] 远程设备身份、已配对被控设备、已授权控制端与 60 秒单次配对票据存储（纯 Java，零 Android 依赖）。
 *
 * <p>落盘目录：{@code <filesDir>/remote/}（原子写入，不碰业务 {@code bots.json} 或核心数据）。
 * 严禁把私钥、共享密钥或配对密钥打印到日志。
 */
public final class RemoteStore {

    public static final String PERM_FULL = "full";
    public static final String PERM_OPERATE = "operate";
    public static final String PERM_READONLY = "readonly";
    /** 单次配对码有效期 180 秒（成功一次即原子作废，避免跨网扫码与跨机时钟偏差误过期）。 */
    public static final long PAIR_TTL_MS = 180_000L;

    /** 本机身份与远程被控开关配置。 */
    public static final class LocalIdentity {
        public final String deviceId;
        public String deviceName;
        public final String privateKeyB64;
        public final String publicKeyB64;
        public boolean hostEnabled;
        public final List<String> customRelays = new ArrayList<String>();

        LocalIdentity(String deviceId, String deviceName, String privateKeyB64, String publicKeyB64, boolean hostEnabled) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.privateKeyB64 = privateKeyB64;
            this.publicKeyB64 = publicKeyB64;
            this.hostEnabled = hostEnabled;
        }

        public PrivateKey privateKey() {
            return RemoteCrypto.decodePrivateKey(RemoteCrypto.b64UrlDecode(privateKeyB64));
        }

        public byte[] publicKeyBytes() {
            return RemoteCrypto.b64UrlDecode(publicKeyB64);
        }

        public PublicKey publicKey() {
            return RemoteCrypto.decodePublicKey(publicKeyBytes());
        }
    }

    /** 我方（控制端）已配对的远端被控设备。 */
    public static final class PairedPeer {
        public final String deviceId;
        public String name;
        public String alias;
        public final String publicKeyB64;
        public final String sharedSecretB64;
        public String permission;
        public String lastLan;
        public String lastV6;
        public String lastStun;
        public String customDirect;
        public final List<String> relays = new ArrayList<String>();
        public long pairedAt;
        public long lastSeenAt;

        public PairedPeer(String deviceId, String name, String alias, String publicKeyB64,
                          String sharedSecretB64, String permission) {
            this.deviceId = deviceId;
            this.name = name == null ? "远端设备" : name;
            this.alias = alias == null ? "" : alias;
            this.publicKeyB64 = publicKeyB64;
            this.sharedSecretB64 = sharedSecretB64;
            this.permission = (permission == null || permission.isEmpty()) ? PERM_FULL : permission;
            this.lastLan = "";
            this.lastV6 = "";
            this.lastStun = "";
            this.customDirect = "";
            this.pairedAt = System.currentTimeMillis();
        }

        public String displayName() {
            if (alias != null && !alias.trim().isEmpty()) return alias.trim();
            if (name != null && !name.trim().isEmpty()) return name.trim();
            return deviceId.length() > 8 ? deviceId.substring(0, 8) : deviceId;
        }

        public byte[] publicKeyBytes() {
            return RemoteCrypto.b64UrlDecode(publicKeyB64);
        }

        public byte[] sharedSecretBytes() {
            return RemoteCrypto.b64UrlDecode(sharedSecretB64);
        }
    }

    /** 已获准控制本机的远端控制端（预留细粒度权限字段，默认 full，支持随时吊销）。 */
    public static final class AuthorizedClient {
        public final String deviceId;
        public String name;
        public final String publicKeyB64;
        public final String sharedSecretB64;
        public String permission;
        public long pairedAt;
        public long lastSeenAt;
        public boolean revoked;

        public AuthorizedClient(String deviceId, String name, String publicKeyB64,
                                String sharedSecretB64, String permission) {
            this.deviceId = deviceId;
            this.name = name == null ? "控制端" : name;
            this.publicKeyB64 = publicKeyB64;
            this.sharedSecretB64 = sharedSecretB64;
            this.permission = (permission == null || permission.isEmpty()) ? PERM_FULL : permission;
            this.pairedAt = System.currentTimeMillis();
            this.lastSeenAt = this.pairedAt;
            this.revoked = false;
        }

        public byte[] publicKeyBytes() {
            return RemoteCrypto.b64UrlDecode(publicKeyB64);
        }

        public byte[] sharedSecretBytes() {
            return RemoteCrypto.b64UrlDecode(sharedSecretB64);
        }
    }

    /** 60 秒有效、单次消耗的内存配对票据（绝不落盘）。 */
    public static final class PairingTicket {
        public final byte[] secret;
        public final String secretB64;
        public final long createdAt;
        public final long expiresAt;
        private boolean consumed;

        PairingTicket(long nowMs) {
            this.secret = RemoteCrypto.randomBytes(32);
            this.secretB64 = RemoteCrypto.b64UrlEncode(secret);
            this.createdAt = nowMs;
            this.expiresAt = nowMs + PAIR_TTL_MS;
        }

        public synchronized boolean isActive(long nowMs) {
            return !consumed && nowMs <= expiresAt;
        }

        public synchronized long leftSeconds(long nowMs) {
            if (consumed || nowMs >= expiresAt) return 0;
            return Math.max(1L, (expiresAt - nowMs + 999L) / 1000L);
        }

        /** 原子核验并一次性消耗配对密钥：成功即销毁，防止同一张二维码截图被二次盗用。 */
        public synchronized boolean verifyAndConsume(byte[] transcript, byte[] providedHmac, long nowMs) {
            if (consumed || nowMs > expiresAt || providedHmac == null) return false;
            byte[] expected = RemoteCrypto.hmacSha256(secret, transcript);
            if (!RemoteCrypto.equalsConstTime(expected, providedHmac)) return false;
            consumed = true;
            return true;
        }

        public synchronized void cancel() {
            consumed = true;
        }
    }

    private final File dir;
    private LocalIdentity identity;
    private final Map<String, PairedPeer> peers = new LinkedHashMap<String, PairedPeer>();
    private final Map<String, AuthorizedClient> clients = new LinkedHashMap<String, AuthorizedClient>();
    private volatile PairingTicket activeTicket;

    public RemoteStore(File filesDir, String defaultDeviceName) {
        this.dir = new File(filesDir, "remote");
        this.dir.mkdirs();
        loadIdentity(defaultDeviceName);
        loadPeers();
        loadClients();
    }

    public synchronized LocalIdentity identity() {
        return identity;
    }

    public synchronized void setDeviceName(String name) {
        String clean = sanitizeName(name, identity.deviceName);
        identity.deviceName = clean;
        saveIdentity();
    }

    public synchronized void setHostEnabled(boolean enabled) {
        identity.hostEnabled = enabled;
        saveIdentity();
    }

    public synchronized List<String> effectiveRelays() {
        if (!identity.customRelays.isEmpty()) return new ArrayList<String>(identity.customRelays);
        return new ArrayList<String>(NostrSignaling.DEFAULT_RELAYS);
    }

    public synchronized void setCustomRelays(List<String> urls) {
        identity.customRelays.clear();
        if (urls != null) {
            for (String u : urls) {
                if (u != null && NostrSignaling.isSupportedRelayUrl(u.trim())) {
                    identity.customRelays.add(u.trim());
                }
            }
        }
        saveIdentity();
    }

    // ------------------------------------------------------------------ 配对票据（60s 单次）

    public synchronized PairingTicket issuePairingTicket() {
        return issuePairingTicket(System.currentTimeMillis());
    }

    public synchronized PairingTicket issuePairingTicket(long nowMs) {
        if (activeTicket != null) activeTicket.cancel();
        activeTicket = new PairingTicket(nowMs);
        return activeTicket;
    }

    public PairingTicket activeTicket() {
        return activeTicket;
    }

    public synchronized void cancelPairingTicket() {
        if (activeTicket != null) {
            activeTicket.cancel();
            activeTicket = null;
        }
    }

    // ------------------------------------------------------------------ 已配对远端设备（控制端视角）

    public synchronized List<PairedPeer> listPeers() {
        return new ArrayList<PairedPeer>(peers.values());
    }

    public synchronized PairedPeer getPeer(String deviceId) {
        return deviceId == null ? null : peers.get(deviceId);
    }

    public synchronized void upsertPeer(PairedPeer peer) {
        if (peer == null || peer.deviceId == null || peer.deviceId.isEmpty()) return;
        peers.put(peer.deviceId, peer);
        savePeers();
    }

    public synchronized void removePeer(String deviceId) {
        if (peers.remove(deviceId) != null) savePeers();
    }

    public synchronized void renamePeer(String deviceId, String alias) {
        PairedPeer p = peers.get(deviceId);
        if (p == null) return;
        p.alias = alias == null ? "" : alias.trim();
        savePeers();
    }

    public synchronized void setPeerCustomDirect(String deviceId, String addr) {
        PairedPeer p = peers.get(deviceId);
        if (p == null) return;
        p.customDirect = addr == null ? "" : addr.trim();
        savePeers();
    }

    public synchronized void updatePeerEndpoints(String deviceId, String lan, String v6, String stun) {
        PairedPeer p = peers.get(deviceId);
        if (p == null) return;
        boolean changed = false;
        if (lan != null && !lan.isEmpty() && !lan.equals(p.lastLan)) { p.lastLan = lan; changed = true; }
        if (v6 != null && !v6.isEmpty() && !v6.equals(p.lastV6)) { p.lastV6 = v6; changed = true; }
        if (stun != null && !stun.isEmpty() && !stun.equals(p.lastStun)) { p.lastStun = stun; changed = true; }
        p.lastSeenAt = System.currentTimeMillis();
        if (changed) savePeers();
    }

    // ------------------------------------------------------------------ 已授权控制端（被控端视角）

    public synchronized List<AuthorizedClient> listAuthorizedClients() {
        return new ArrayList<AuthorizedClient>(clients.values());
    }

    public synchronized AuthorizedClient getAuthorizedClient(String deviceId) {
        return deviceId == null ? null : clients.get(deviceId);
    }

    public synchronized void upsertAuthorizedClient(AuthorizedClient client) {
        if (client == null || client.deviceId == null || client.deviceId.isEmpty()) return;
        clients.put(client.deviceId, client);
        saveClients();
    }

    public synchronized boolean revokeClient(String deviceId) {
        AuthorizedClient c = clients.get(deviceId);
        if (c == null) return false;
        c.revoked = true;
        saveClients();
        return true;
    }

    public synchronized boolean removeClient(String deviceId) {
        if (clients.remove(deviceId) != null) {
            saveClients();
            return true;
        }
        return false;
    }

    /** 服务端握手鉴权入口（支持 60s 单次密钥自动配对 + 已有未吊销控制端重连）。 */
    public synchronized RemoteTransport.AuthDecision authenticateClient(
            String cliId, String cliName, byte[] cliPubX509, byte[] transcript, byte[] pairHmac, long nowMs) {
        AuthorizedClient existing = clients.get(cliId);
        if (pairHmac != null && pairHmac.length > 0) {
            PairingTicket ticket = activeTicket;
            if (ticket != null && ticket.verifyAndConsume(transcript, pairHmac, nowMs)) {
                byte[] shared = RemoteCrypto.hkdfSha256(
                        RemoteCrypto.ecdh(identity.privateKey(), RemoteCrypto.decodePublicKey(cliPubX509)),
                        null, "whale-pair-shared-v1".getBytes(StandardCharsets.UTF_8), 32);
                AuthorizedClient fresh = new AuthorizedClient(
                        cliId, sanitizeName(cliName, "控制端"),
                        RemoteCrypto.b64UrlEncode(cliPubX509),
                        RemoteCrypto.b64UrlEncode(shared),
                        PERM_FULL
                );
                clients.put(cliId, fresh);
                saveClients();
                return RemoteTransport.AuthDecision.allow(fresh.permission, true);
            }
            return RemoteTransport.AuthDecision.deny("配对码已过期或已被使用，请重新生成");
        }
        if (existing == null) {
            return RemoteTransport.AuthDecision.deny("本设备尚未授权此控制端，请重新扫码配对");
        }
        if (existing.revoked) {
            return RemoteTransport.AuthDecision.deny("此控制端的远程授权已被被控端吊销");
        }
        if (!RemoteCrypto.equalsConstTime(existing.publicKeyBytes(), cliPubX509)) {
            return RemoteTransport.AuthDecision.deny("控制端公钥指纹不匹配");
        }
        existing.lastSeenAt = nowMs;
        if (cliName != null && !cliName.trim().isEmpty()) existing.name = sanitizeName(cliName, existing.name);
        saveClients();
        return RemoteTransport.AuthDecision.allow(existing.permission, false);
    }

    // ------------------------------------------------------------------ 持久化（轻量 KV 行格式，零外部 JSON 依赖）

    private void loadIdentity(String defaultName) {
        File f = new File(dir, "identity.dat");
        Map<String, String> m = readKv(f);
        String pk = m.get("pk");
        String sk = m.get("sk");
        if (pk != null && sk != null && !pk.isEmpty() && !sk.isEmpty()) {
            try {
                byte[] pkBytes = RemoteCrypto.b64UrlDecode(pk);
                RemoteCrypto.decodePublicKey(pkBytes);
                RemoteCrypto.decodePrivateKey(RemoteCrypto.b64UrlDecode(sk));
                String id = RemoteCrypto.deviceIdOf(pkBytes);
                String name = sanitizeName(m.get("name"), sanitizeName(defaultName, "Android 设备"));
                boolean host = "1".equals(m.get("host"));
                identity = new LocalIdentity(id, name, sk, pk, host);
                String relays = m.get("relays");
                if (relays != null && !relays.isEmpty()) {
                    for (String r : relays.split(",")) {
                        if (!r.trim().isEmpty()) identity.customRelays.add(r.trim());
                    }
                }
                return;
            } catch (Throwable ignored) {
            }
        }
        KeyPair kp = RemoteCrypto.generateEcKeyPair();
        byte[] pkBytes = kp.getPublic().getEncoded();
        byte[] skBytes = kp.getPrivate().getEncoded();
        identity = new LocalIdentity(
                RemoteCrypto.deviceIdOf(pkBytes),
                sanitizeName(defaultName, "Android 设备"),
                RemoteCrypto.b64UrlEncode(skBytes),
                RemoteCrypto.b64UrlEncode(pkBytes),
                false
        );
        saveIdentity();
    }

    private void saveIdentity() {
        Map<String, String> m = new LinkedHashMap<String, String>();
        m.put("id", identity.deviceId);
        m.put("name", identity.deviceName);
        m.put("pk", identity.publicKeyB64);
        m.put("sk", identity.privateKeyB64);
        m.put("host", identity.hostEnabled ? "1" : "0");
        StringBuilder rs = new StringBuilder();
        for (int i = 0; i < identity.customRelays.size(); i++) {
            if (i > 0) rs.append(',');
            rs.append(identity.customRelays.get(i));
        }
        m.put("relays", rs.toString());
        writeKv(new File(dir, "identity.dat"), m);
    }

    private void loadPeers() {
        peers.clear();
        for (Map<String, String> m : readRecords(new File(dir, "paired-peers.dat"))) {
            String id = m.get("id"), pk = m.get("pk"), sec = m.get("sec");
            if (id == null || pk == null || sec == null) continue;
            PairedPeer p = new PairedPeer(id, m.get("name"), m.get("alias"), pk, sec, m.get("perm"));
            p.lastLan = nz(m.get("lan"));
            p.lastV6 = nz(m.get("v6"));
            p.lastStun = nz(m.get("stun"));
            p.customDirect = nz(m.get("direct"));
            p.pairedAt = parseLong(m.get("pairedAt"), System.currentTimeMillis());
            p.lastSeenAt = parseLong(m.get("lastSeenAt"), 0L);
            String relays = m.get("relays");
            if (relays != null && !relays.isEmpty()) {
                for (String r : relays.split(",")) if (!r.trim().isEmpty()) p.relays.add(r.trim());
            }
            peers.put(id, p);
        }
    }

    private void savePeers() {
        List<Map<String, String>> list = new ArrayList<Map<String, String>>();
        for (PairedPeer p : peers.values()) {
            Map<String, String> m = new LinkedHashMap<String, String>();
            m.put("id", p.deviceId);
            m.put("name", p.name);
            m.put("alias", p.alias);
            m.put("pk", p.publicKeyB64);
            m.put("sec", p.sharedSecretB64);
            m.put("perm", p.permission);
            m.put("lan", p.lastLan);
            m.put("v6", p.lastV6);
            m.put("stun", p.lastStun);
            m.put("direct", p.customDirect);
            m.put("pairedAt", String.valueOf(p.pairedAt));
            m.put("lastSeenAt", String.valueOf(p.lastSeenAt));
            StringBuilder rs = new StringBuilder();
            for (int i = 0; i < p.relays.size(); i++) {
                if (i > 0) rs.append(',');
                rs.append(p.relays.get(i));
            }
            m.put("relays", rs.toString());
            list.add(m);
        }
        writeRecords(new File(dir, "paired-peers.dat"), list);
    }

    private void loadClients() {
        clients.clear();
        for (Map<String, String> m : readRecords(new File(dir, "authorized-clients.dat"))) {
            String id = m.get("id"), pk = m.get("pk"), sec = m.get("sec");
            if (id == null || pk == null || sec == null) continue;
            AuthorizedClient c = new AuthorizedClient(id, m.get("name"), pk, sec, m.get("perm"));
            c.pairedAt = parseLong(m.get("pairedAt"), System.currentTimeMillis());
            c.lastSeenAt = parseLong(m.get("lastSeenAt"), c.pairedAt);
            c.revoked = "1".equals(m.get("revoked"));
            clients.put(id, c);
        }
    }

    private void saveClients() {
        List<Map<String, String>> list = new ArrayList<Map<String, String>>();
        for (AuthorizedClient c : clients.values()) {
            Map<String, String> m = new LinkedHashMap<String, String>();
            m.put("id", c.deviceId);
            m.put("name", c.name);
            m.put("pk", c.publicKeyB64);
            m.put("sec", c.sharedSecretB64);
            m.put("perm", c.permission);
            m.put("pairedAt", String.valueOf(c.pairedAt));
            m.put("lastSeenAt", String.valueOf(c.lastSeenAt));
            m.put("revoked", c.revoked ? "1" : "0");
            list.add(m);
        }
        writeRecords(new File(dir, "authorized-clients.dat"), list);
    }

    private static String sanitizeName(String raw, String fallback) {
        if (raw == null) return fallback;
        String s = raw.replace('\n', ' ').replace('\r', ' ').trim();
        if (s.isEmpty()) return fallback;
        return s.length() > 40 ? s.substring(0, 40) : s;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static long parseLong(String s, long def) {
        try {
            return s == null || s.isEmpty() ? def : Long.parseLong(s);
        } catch (Exception e) {
            return def;
        }
    }

    private static Map<String, String> readKv(File f) {
        Map<String, String> out = new LinkedHashMap<String, String>();
        String text = readFileUtf8(f);
        if (text == null) return out;
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq <= 0) continue;
            out.put(line.substring(0, eq), unescape(line.substring(eq + 1)));
        }
        return out;
    }

    private static void writeKv(File f, Map<String, String> m) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : m.entrySet()) {
            sb.append(e.getKey()).append('=').append(escape(e.getValue())).append('\n');
        }
        writeAtomicUtf8(f, sb.toString());
    }

    private static List<Map<String, String>> readRecords(File f) {
        List<Map<String, String>> out = new ArrayList<Map<String, String>>();
        String text = readFileUtf8(f);
        if (text == null) return out;
        Map<String, String> cur = new LinkedHashMap<String, String>();
        for (String line : text.split("\n")) {
            if ("---".equals(line)) {
                if (!cur.isEmpty()) {
                    out.add(cur);
                    cur = new LinkedHashMap<String, String>();
                }
                continue;
            }
            int eq = line.indexOf('=');
            if (eq > 0) cur.put(line.substring(0, eq), unescape(line.substring(eq + 1)));
        }
        if (!cur.isEmpty()) out.add(cur);
        return out;
    }

    private static void writeRecords(File f, List<Map<String, String>> list) {
        StringBuilder sb = new StringBuilder();
        for (Map<String, String> m : list) {
            for (Map.Entry<String, String> e : m.entrySet()) {
                sb.append(e.getKey()).append('=').append(escape(e.getValue())).append('\n');
            }
            sb.append("---\n");
        }
        writeAtomicUtf8(f, sb.toString());
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "");
    }

    private static String unescape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                sb.append(n == 'n' ? '\n' : n);
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String readFileUtf8(File f) {
        if (f == null || !f.isFile()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    private static void writeAtomicUtf8(File f, String content) {
        try {
            File tmp = new File(f.getParentFile(), f.getName() + ".next");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(f)) {
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(content.getBytes(StandardCharsets.UTF_8));
                }
                tmp.delete();
            }
        } catch (Throwable ignored) {
        }
    }
}
