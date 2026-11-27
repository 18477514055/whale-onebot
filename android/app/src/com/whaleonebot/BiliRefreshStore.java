package com.whaleonebot;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.Key;
import java.security.KeyStore;
import java.security.KeyStoreException;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * [layer: shell-android] B 站自动续期元数据与防风控指纹（refresh_token / buvid3 / buvid4 / bili_ticket）
 * 硬件加密保险箱（Android Keystore AES-256-GCM，独立于主会话 BiliSessionStore）。
 */
public final class BiliRefreshStore {
    private static final int MAX_META = 4096;
    private static final int VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BYTES = 16;
    private static final String PROVIDER = "AndroidKeyStore";

    private final File directory;

    private BiliRefreshStore(File directory) {
        this.directory = directory;
    }

    public static BiliRefreshStore of(Context c) {
        File root = c.getNoBackupFilesDir();
        if (root == null) throw new IllegalStateException("No private storage");
        return new BiliRefreshStore(new File(root, "bili-refresh-v1"));
    }

    private static SecretKey key(String alias, boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance(PROVIDER);
        ks.load(null);
        Key key = ks.getKey(alias, null);
        if (key != null) return (SecretKey) key;
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

    private static String scope(String bot, String binding) {
        if (bot == null || binding == null || !bot.matches("[A-Za-z0-9_-]{1,64}") || !binding.matches("[A-Za-z0-9_-]{1,64}")) {
            throw new IllegalArgumentException("Invalid scope");
        }
        return "whale.bili.refresh.v1\u0000" + bot + "\u0000" + binding;
    }

    private static byte[] aad(String bot, String binding, String self) {
        if (self == null || !self.matches("[1-9][0-9]{0,15}")) throw new IllegalArgumentException("Invalid account");
        return (scope(bot, binding) + "\u0000" + self).getBytes(StandardCharsets.US_ASCII);
    }

    private static String alias(String bot, String binding) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(scope(bot, binding).getBytes(StandardCharsets.US_ASCII));
        StringBuilder hex = new StringBuilder("whale.bili.ref.v1.");
        for (byte b : digest) {
            hex.append(Character.forDigit((b & 255) >>> 4, 16)).append(Character.forDigit(b & 15, 16));
        }
        return hex.toString();
    }

    public JSONObject load(String bot, String binding, String self) {
        try {
            byte[] auth = aad(bot, binding, self);
            String name = alias(bot, binding);
            File file = new File(directory, name);
            if (!file.isFile()) return null;
            int header = 1 + IV_BYTES;
            int max = header + TAG_BYTES + MAX_META;
            long len = file.length();
            if (len <= header + TAG_BYTES || len > max) return null;
            byte[] data = new byte[(int) len];
            try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
                in.readFully(data);
                if (in.read() != -1 || data[0] != VERSION) return null;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(name, false), new GCMParameterSpec(8 * TAG_BYTES, data, 1, IV_BYTES));
            cipher.updateAAD(auth);
            byte[] plain = cipher.doFinal(data, header, data.length - header);
            try {
                return new JSONObject(new String(plain, StandardCharsets.UTF_8));
            } finally {
                Arrays.fill(plain, (byte) 0);
            }
        } catch (Throwable ignored) {
            return null;
        }
    }

    public void save(String bot, String binding, String self, JSONObject meta) {
        if (meta == null) return;
        try {
            byte[] auth = aad(bot, binding, self);
            String name = alias(bot, binding);
            byte[] plain = meta.toString().getBytes(StandardCharsets.UTF_8);
            if (plain.length > MAX_META) {
                Arrays.fill(plain, (byte) 0);
                return;
            }
            Files.createDirectories(directory.toPath());
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(name, true));
            cipher.updateAAD(auth);
            byte[] iv = cipher.getIV();
            byte[] ciphertext;
            try {
                ciphertext = cipher.doFinal(plain);
            } finally {
                Arrays.fill(plain, (byte) 0);
            }
            File tmp = new File(directory, name + ".new");
            File target = new File(directory, name);
            try {
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(VERSION);
                    out.write(iv);
                    out.write(ciphertext);
                    out.getFD().sync();
                }
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally {
                Files.deleteIfExists(tmp.toPath());
            }
        } catch (Throwable ignored) {
        }
    }

    public void forget(String bot, String binding) {
        try {
            String name = alias(bot, binding);
            try {
                KeyStore ks = KeyStore.getInstance(PROVIDER);
                ks.load(null);
                if (ks.containsAlias(name)) ks.deleteEntry(name);
            } catch (Throwable ignored) {}
            Files.deleteIfExists(new File(directory, name).toPath());
            Files.deleteIfExists(new File(directory, name + ".new").toPath());
        } catch (Throwable ignored) {}
    }

    public static String shortStatus(Context c, String bot, String binding, String self) {
        if (c == null || self == null || self.isEmpty()) return "";
        JSONObject o = of(c).load(bot, binding, self);
        if (o == null) return "未配置续期票据";
        boolean hasRef = !o.optString("refreshToken", "").isEmpty();
        boolean hasBuvid = !o.optString("buvid3", "").isEmpty();
        long refreshedAt = o.optLong("refreshedAt", 0L);
        String base = (hasRef ? "支持无感自动续期" : "无 refresh_token")
                + (hasBuvid ? " · 指纹完整" : "");
        if (refreshedAt > 0L) {
            base += " · 已续签";
        }
        return base;
    }
}
