package com.whaleonebot;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.Arrays;
import java.util.regex.Pattern;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

/** App-owned Bili login only. One nonexportable key per binding; never fall back to software key storage. */
final class BiliSessionStore {
    static final int MAX_COOKIE = 3072;
    private static final int VERSION = 1, IV_BYTES = 12, TAG_BYTES = 16;
    private static final String OCTETS = "[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]+";
    private static final Pattern COOKIE = Pattern.compile("SESSDATA=" + OCTETS + "; bili_jct=" + OCTETS);
    private static final String PROVIDER = "AndroidKeyStore";

    interface Keys {
        SecretKey key(String alias, boolean create) throws Exception;
        void forget(String alias) throws Exception;
    }
    private static final Keys ANDROID_KEYS = new Keys() {
        private KeyStore store() throws Exception {
            KeyStore ks = KeyStore.getInstance(PROVIDER); ks.load(null); return ks;
        }
        public SecretKey key(String alias, boolean create) throws Exception {
            KeyStore ks = store();
            Key key = ks.getKey(alias, null);
            if (key != null) return (SecretKey) key;
            if (!create) throw new KeyStoreException();
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
            generator.init(new KeyGenParameterSpec.Builder(alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setKeySize(256).build());
            return generator.generateKey();
        }
        public void forget(String alias) throws Exception {
            KeyStore ks = store(); if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        }
    };
    private final File directory;
    private final Keys keys;
    static BiliSessionStore of(Context c) {
        File root = c.getNoBackupFilesDir();
        if (root == null) throw new IllegalStateException("No private storage");
        return new BiliSessionStore(new File(root, "bili-sessions-v1"), ANDROID_KEYS);
    }
    // Narrow package seam for offline envelope/atomicity tests. Production uses only of(Context).
    BiliSessionStore(File directory, Keys keys) { this.directory = directory; this.keys = keys; }

    static boolean validCookie(String cookie) {
        return cookie != null && cookie.length() <= MAX_COOKIE && COOKIE.matcher(cookie).matches();
    }
    private static String scope(String bot, String binding) {
        if (bot == null || binding == null || !bot.matches("[A-Za-z0-9_-]{1,64}") || !binding.matches("[A-Za-z0-9_-]{1,64}"))
            throw new IllegalArgumentException("Invalid scope");
        return "whale.bili.login.v1\u0000" + bot + "\u0000" + binding;
    }
    private static byte[] aad(String bot, String binding, String self) {
        if (self == null || !self.matches("[1-9][0-9]{0,15}")) throw new IllegalArgumentException("Invalid account");
        return (scope(bot, binding) + "\u0000" + self).getBytes(StandardCharsets.US_ASCII);
    }
    private static String alias(String bot, String binding) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(scope(bot, binding).getBytes(StandardCharsets.US_ASCII));
        StringBuilder hex = new StringBuilder("whale.bili.v1.");
        for (byte b : digest) hex.append(Character.forDigit((b & 255) >>> 4, 16)).append(Character.forDigit(b & 15, 16));
        return hex.toString();
    }
    boolean present(String bot, String binding) throws Exception {
        return new File(directory, alias(bot, binding)).isFile(); // Presence is NOT identity proof.
    }
    String load(String bot, String binding, String self) throws Exception {
        byte[] auth = aad(bot, binding, self);
        String name = alias(bot, binding); File file = new File(directory, name);
        if (Files.notExists(file.toPath())) return null;
        final int header = 1 + IV_BYTES, max = header + TAG_BYTES + MAX_COOKIE;
        byte[] data;
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            long length = file.length();
            if (length <= header + TAG_BYTES || length > max) throw new IOException();
            data = new byte[(int)length]; in.readFully(data);
            if (in.read() != -1 || data[0] != VERSION) throw new IOException();
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, keys.key(name, false), new GCMParameterSpec(8 * TAG_BYTES, data, 1, IV_BYTES));
        cipher.updateAAD(auth);
        byte[] plain = cipher.doFinal(data, header, data.length - header);
        try {
            String cookie = new String(plain, StandardCharsets.US_ASCII);
            if (!validCookie(cookie)) throw new IOException();
            return cookie;
        } finally { Arrays.fill(plain, (byte)0); }
    }
    void save(String bot, String binding, String self, String cookie) throws Exception {
        if (!validCookie(cookie)) throw new IOException();
        byte[] auth = aad(bot, binding, self); String name = alias(bot, binding);
        Files.createDirectories(directory.toPath());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, keys.key(name, true));
        cipher.updateAAD(auth);
        byte[] iv = cipher.getIV(), plain = cookie.getBytes(StandardCharsets.US_ASCII), ciphertext;
        try { ciphertext = cipher.doFinal(plain); } finally { Arrays.fill(plain, (byte)0); }
        if (iv.length != IV_BYTES || ciphertext.length != cookie.length() + TAG_BYTES) throw new IOException();
        File tmp = new File(directory, name + ".new"), target = new File(directory, name);
        try {
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(VERSION); out.write(iv); out.write(ciphertext); out.getFD().sync();
            }
            // Same-directory rename. No nonatomic delete-and-copy fallback, even on failure.
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally { Files.deleteIfExists(tmp.toPath()); }
    }
    void forget(String bot, String binding) throws Exception {
        String name = alias(bot, binding);
        try { keys.forget(name); } finally {
            try { Files.deleteIfExists(new File(directory, name).toPath()); }
            finally { Files.deleteIfExists(new File(directory, name + ".new").toPath()); }
        }
    }
}
