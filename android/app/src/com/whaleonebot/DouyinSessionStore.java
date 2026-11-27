package com.whaleonebot;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.Key;
import java.security.KeyStore;
import java.security.KeyStoreException;
import java.security.MessageDigest;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * [layer: shell-android] 抖音账号凭证硬件加密保险箱（Android Keystore AES-256-GCM）。
 *
 * <p>对齐 2026-11-28 问答 Q20：
 * <ul>
 *   <li>将原本普通私有 JSON 存储的抖音 Cookie 升级为不可导出的 Android Keystore AES-256-GCM 密文；</li>
 *   <li>AAD 绑定 {@code botId}，支持从旧明文 {@code douyin-sessions/<botId>.json} 自动平滑迁移并安全覆写擦除旧文件；</li>
 *   <li>绝不向 UI 或日志暴露明文 Cookie，仅对外提供脱敏摘要与账号校验元数据。</li>
 * </ul>
 */
public final class DouyinSessionStore {

    private static final int VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BYTES = 16;
    private static final int MAX_PLAIN = 16 * 1024;
    private static final String PROVIDER = "AndroidKeyStore";

    public static final class Summary {
        public final boolean saved;
        public final boolean verified;
        public final boolean hasSessionId;
        public final String uid;
        public final String nickname;
        public final String state;
        public final String lastError;
        public final long savedAt;
        public final long lastCheckAt;
        public final int cookieFieldCount;

        public Summary(boolean saved, boolean verified, boolean hasSessionId,
                       String uid, String nickname, String state, String lastError,
                       long savedAt, long lastCheckAt, int cookieFieldCount) {
            this.saved = saved;
            this.verified = verified;
            this.hasSessionId = hasSessionId;
            this.uid = uid == null ? "" : uid;
            this.nickname = nickname == null ? "" : nickname;
            this.state = state == null ? "stopped" : state;
            this.lastError = lastError == null ? "" : lastError;
            this.savedAt = savedAt;
            this.lastCheckAt = lastCheckAt;
            this.cookieFieldCount = cookieFieldCount;
        }
    }

    private DouyinSessionStore() {
    }

    private static String safeId(String botId) {
        if (botId == null) return "default";
        String cleaned = botId.replaceAll("[^A-Za-z0-9_.-]", "_");
        return cleaned.isEmpty() ? "default" : cleaned;
    }

    private static File vaultDir(Context ctx) {
        File root = ctx.getNoBackupFilesDir();
        if (root == null) root = ctx.getFilesDir();
        return new File(root, "douyin-vault-v1");
    }

    private static File metaFile(Context ctx, String botId) {
        return new File(new File(ctx.getFilesDir(), "douyin-meta"), safeId(botId) + ".json");
    }

    private static File legacyPlainFile(Context ctx, String botId) {
        return new File(new File(ctx.getFilesDir(), "douyin-sessions"), safeId(botId) + ".json");
    }

    private static String alias(String botId) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256")
                .digest(("whale.douyin.v1\u0000" + safeId(botId)).getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder("whale.dy.v1.");
        for (byte b : d) {
            sb.append(Character.forDigit((b & 255) >>> 4, 16)).append(Character.forDigit(b & 15, 16));
        }
        return sb.toString();
    }

    private static byte[] aad(String botId) {
        return ("whale.douyin.session.v1\u0000" + safeId(botId)).getBytes(StandardCharsets.UTF_8);
    }

    private static SecretKey key(String alias, boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance(PROVIDER);
        ks.load(null);
        Key k = ks.getKey(alias, null);
        if (k != null) return (SecretKey) k;
        if (!create) throw new KeyStoreException();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        gen.init(new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    /** 判定 Cookie 字符串是否包含真实登录会话键（严拒仅有游客态 ttwid）。 */
    public static boolean hasRealSessionCookie(String rawCookie) {
        if (rawCookie == null || rawCookie.trim().isEmpty()) return false;
        for (String part : rawCookie.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String k = part.substring(0, eq).trim().toLowerCase();
            String v = part.substring(eq + 1).trim();
            if (v.isEmpty()) continue;
            if ("sessionid".equals(k) || "sessionid_ss".equals(k)
                    || "sid_tt".equals(k) || "uid_tt".equals(k) || "sid_guard".equals(k)) {
                return true;
            }
        }
        return false;
    }

    public static int countCookieFields(String rawCookie) {
        if (rawCookie == null || rawCookie.trim().isEmpty()) return 0;
        int n = 0;
        for (String part : rawCookie.split(";")) {
            int eq = part.indexOf('=');
            if (eq > 0 && !part.substring(eq + 1).trim().isEmpty()) n++;
        }
        return n;
    }

    public static synchronized boolean save(
            Context ctx, String botId, String rawCookie,
            boolean verified, String uid, String nickname, String state, String lastError
    ) {
        if (ctx == null || rawCookie == null || rawCookie.trim().isEmpty()) return false;
        String cookie = rawCookie.trim();
        byte[] plain = cookie.getBytes(StandardCharsets.UTF_8);
        if (plain.length == 0 || plain.length > MAX_PLAIN) return false;
        try {
            String al = alias(botId);
            File dir = vaultDir(ctx);
            Files.createDirectories(dir.toPath());
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(al, true));
            cipher.updateAAD(aad(botId));
            byte[] iv = cipher.getIV();
            byte[] ct;
            try {
                ct = cipher.doFinal(plain);
            } finally {
                Arrays.fill(plain, (byte) 0);
            }
            File tmp = new File(dir, al + ".new");
            File target = new File(dir, al);
            try {
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(VERSION);
                    out.write(iv);
                    out.write(ct);
                    out.getFD().sync();
                }
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally {
                Files.deleteIfExists(tmp.toPath());
            }

            long now = System.currentTimeMillis();
            JSONObject meta = new JSONObject();
            meta.put("savedAt", now);
            meta.put("lastCheckAt", now);
            meta.put("verified", verified);
            meta.put("hasSessionId", hasRealSessionCookie(cookie));
            meta.put("fieldCount", countCookieFields(cookie));
            meta.put("uid", uid == null ? "" : uid);
            meta.put("nickname", nickname == null ? "" : nickname);
            meta.put("state", state == null ? (verified ? "verified" : "unverified") : state);
            meta.put("lastError", lastError == null ? "" : lastError);
            writePrivateUtf8(metaFile(ctx, botId), meta.toString(2));
            shredLegacyPlainIfExists(ctx, botId);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static synchronized String loadCookie(Context ctx, String botId) {
        if (ctx == null) return null;
        migrateLegacyIfNeeded(ctx, botId);
        try {
            String al = alias(botId);
            File file = new File(vaultDir(ctx), al);
            if (!file.isFile()) return null;
            int header = 1 + IV_BYTES;
            long len = file.length();
            if (len <= header + TAG_BYTES || len > header + TAG_BYTES + MAX_PLAIN) return null;
            byte[] data = new byte[(int) len];
            try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
                in.readFully(data);
                if (in.read() != -1 || data[0] != VERSION) return null;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(al, false), new GCMParameterSpec(8 * TAG_BYTES, data, 1, IV_BYTES));
            cipher.updateAAD(aad(botId));
            byte[] plain = cipher.doFinal(data, header, data.length - header);
            try {
                return new String(plain, StandardCharsets.UTF_8);
            } finally {
                Arrays.fill(plain, (byte) 0);
            }
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static synchronized void updateHealth(
            Context ctx, String botId, boolean verified, String uid, String nickname, String state, String lastError
    ) {
        if (ctx == null) return;
        try {
            File mf = metaFile(ctx, botId);
            JSONObject meta = mf.isFile() ? new JSONObject(readUtf8(mf)) : new JSONObject();
            meta.put("lastCheckAt", System.currentTimeMillis());
            meta.put("verified", verified);
            if (uid != null && !uid.isEmpty()) meta.put("uid", uid);
            if (nickname != null && !nickname.isEmpty()) meta.put("nickname", nickname);
            if (state != null) meta.put("state", state);
            meta.put("lastError", lastError == null ? "" : lastError);
            writePrivateUtf8(mf, meta.toString(2));
        } catch (Throwable ignored) {}
    }

    public static synchronized Summary summary(Context ctx, String botId) {
        if (ctx == null) return new Summary(false, false, false, "", "", "stopped", "", 0L, 0L, 0);
        migrateLegacyIfNeeded(ctx, botId);
        try {
            String al = alias(botId);
            File vault = new File(vaultDir(ctx), al);
            if (!vault.isFile()) return new Summary(false, false, false, "", "", "stopped", "", 0L, 0L, 0);
            File mf = metaFile(ctx, botId);
            JSONObject meta = mf.isFile() ? new JSONObject(readUtf8(mf)) : new JSONObject();
            return new Summary(
                    true,
                    meta.optBoolean("verified", false),
                    meta.optBoolean("hasSessionId", false),
                    meta.optString("uid", ""),
                    meta.optString("nickname", ""),
                    meta.optString("state", "saved"),
                    meta.optString("lastError", ""),
                    meta.optLong("savedAt", vault.lastModified()),
                    meta.optLong("lastCheckAt", 0L),
                    meta.optInt("fieldCount", 0)
            );
        } catch (Throwable ignored) {
            return new Summary(false, false, false, "", "", "stopped", "", 0L, 0L, 0);
        }
    }

    public static synchronized boolean forget(Context ctx, String botId) {
        if (ctx == null) return false;
        try {
            String al = alias(botId);
            try {
                KeyStore ks = KeyStore.getInstance(PROVIDER);
                ks.load(null);
                if (ks.containsAlias(al)) ks.deleteEntry(al);
            } catch (Throwable ignored) {}
            Files.deleteIfExists(new File(vaultDir(ctx), al).toPath());
            Files.deleteIfExists(new File(vaultDir(ctx), al + ".new").toPath());
            Files.deleteIfExists(metaFile(ctx, botId).toPath());
            shredLegacyPlainIfExists(ctx, botId);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 自动将旧版明文 douyin-sessions/<botId>.json 迁移进硬件加密仓并擦除明文文件。 */
    private static void migrateLegacyIfNeeded(Context ctx, String botId) {
        try {
            File leg = legacyPlainFile(ctx, botId);
            if (!leg.isFile()) return;
            String al = alias(botId);
            File vault = new File(vaultDir(ctx), al);
            if (!vault.isFile()) {
                JSONObject obj = new JSONObject(readUtf8(leg));
                String c = obj.optString("cookie", "").trim();
                if (!c.isEmpty() && hasRealSessionCookie(c)) {
                    save(ctx, botId, c, false, "", "", "migrated", "");
                }
            }
            shredLegacyPlainIfExists(ctx, botId);
        } catch (Throwable ignored) {}
    }

    private static void shredLegacyPlainIfExists(Context ctx, String botId) {
        File leg = legacyPlainFile(ctx, botId);
        if (!leg.isFile()) return;
        try {
            long len = leg.length();
            if (len > 0 && len < 65536) {
                byte[] zeros = new byte[(int) len];
                try (FileOutputStream os = new FileOutputStream(leg)) {
                    os.write(zeros);
                    os.getFD().sync();
                }
            }
        } catch (Throwable ignored) {}
        //noinspection ResultOfMethodCallIgnored
        leg.delete();
    }

    private static String readUtf8(File f) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void writePrivateUtf8(File target, String content) throws Exception {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        File tmp = new File(parent, target.getName() + ".tmp");
        try (FileOutputStream os = new FileOutputStream(tmp)) {
            os.write(content.getBytes(StandardCharsets.UTF_8));
            os.getFD().sync();
        }
        tmp.setReadable(false, false);
        tmp.setReadable(true, true);
        tmp.setWritable(false, false);
        tmp.setWritable(true, true);
        if (target.exists()) target.delete();
        if (!tmp.renameTo(target)) tmp.delete();
        target.setReadable(false, false);
        target.setReadable(true, true);
    }
}
