package com.whaleonebot;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * [layer: shell-android] 被控机本地 QQ 账密安全保险箱（Android Keystore AES-256-GCM）。
 *
 * <p>严格对齐 2026-11-27 问答报告 Q7 / Q11：
 * <ul>
 *   <li>仅在用户显式勾选「记住密码」时，使用本机硬件/系统 Android Keystore 密钥 AES-256-GCM 加密后写入
 *       应用私有目录 {@code files/qq-vault/saved-cred.json}（权限 0600）；</li>
 *   <li>绝不打印明文密码或密文到任何日志，绝不跨机落盘到主力机；</li>
 *   <li>只响应用户手动点击「一键账密重登」，绝不被看门狗或后台服务自动调用。</li>
 * </ul>
 */
public final class QqCredentialVault {

    private static final String KEY_ALIAS = "whale_qq_cred_aes_v1";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    public static final class SavedCredential {
        public final String uin;
        public final String password;
        public final long savedAt;

        public SavedCredential(String uin, String password, long savedAt) {
            this.uin = uin;
            this.password = password;
            this.savedAt = savedAt;
        }
    }

    public static final class Summary {
        public final boolean hasSaved;
        public final String uin;
        public final long savedAt;

        public Summary(boolean hasSaved, String uin, long savedAt) {
            this.hasSaved = hasSaved;
            this.uin = uin == null ? "" : uin;
            this.savedAt = savedAt;
        }
    }

    private QqCredentialVault() {
    }

    private static File vaultFile(Context ctx) {
        return new File(new File(ctx.getFilesDir(), "qq-vault"), "saved-cred.json");
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    public static synchronized boolean save(Context ctx, String uin, String password) {
        if (ctx == null || uin == null || password == null) return false;
        String cleanUin = uin.trim();
        if (!cleanUin.matches("[1-9][0-9]{4,15}") || password.isEmpty()) return false;
        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] enc = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
            JSONObject obj = new JSONObject();
            obj.put("v", 1);
            obj.put("uin", cleanUin);
            obj.put("savedAt", System.currentTimeMillis());
            obj.put("iv", Base64.getEncoder().encodeToString(iv));
            obj.put("ct", Base64.getEncoder().encodeToString(enc));

            File dst = vaultFile(ctx);
            File dir = dst.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
            File tmp = new File(dir, dst.getName() + ".tmp");
            try (FileOutputStream os = new FileOutputStream(tmp)) {
                os.write(obj.toString().getBytes(StandardCharsets.UTF_8));
                os.getFD().sync();
            }
            lockPrivate(tmp);
            if (dst.exists()) dst.delete();
            if (!tmp.renameTo(dst)) {
                tmp.delete();
                return false;
            }
            lockPrivate(dst);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 只读摘要（仅返回是否已保存与脱敏/QQ 号，绝不返回密码）。 */
    public static synchronized Summary summary(Context ctx) {
        if (ctx == null) return new Summary(false, "", 0L);
        File f = vaultFile(ctx);
        if (!f.isFile()) return new Summary(false, "", 0L);
        try {
            JSONObject obj = new JSONObject(readUtf8(f));
            String uin = obj.optString("uin", "").trim();
            String ct = obj.optString("ct", "").trim();
            if (uin.isEmpty() || ct.isEmpty()) return new Summary(false, "", 0L);
            return new Summary(true, uin, obj.optLong("savedAt", f.lastModified()));
        } catch (Throwable ignored) {
            return new Summary(false, "", 0L);
        }
    }

    /** 解密读取已存凭据（仅在用户显式点击「一键账密重登」时在被控机本地内存调用）。 */
    public static synchronized SavedCredential load(Context ctx) {
        if (ctx == null) return null;
        File f = vaultFile(ctx);
        if (!f.isFile()) return null;
        try {
            JSONObject obj = new JSONObject(readUtf8(f));
            String uin = obj.optString("uin", "").trim();
            String ivB64 = obj.optString("iv", "");
            String ctB64 = obj.optString("ct", "");
            if (uin.isEmpty() || ivB64.isEmpty() || ctB64.isEmpty()) return null;
            byte[] iv = Base64.getDecoder().decode(ivB64);
            byte[] ct = Base64.getDecoder().decode(ctB64);
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            byte[] plain = cipher.doFinal(ct);
            return new SavedCredential(uin, new String(plain, StandardCharsets.UTF_8), obj.optLong("savedAt", 0L));
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static synchronized boolean clear(Context ctx) {
        if (ctx == null) return false;
        File f = vaultFile(ctx);
        return !f.exists() || f.delete();
    }

    private static void lockPrivate(File f) {
        f.setReadable(false, false);
        f.setReadable(true, true);
        f.setWritable(false, false);
        f.setWritable(true, true);
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
}
