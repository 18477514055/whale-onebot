package com.whaleonebot.remote;

import java.math.BigInteger;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * [layer: shell-android] 远程控制密码学原语与配对 URI 编解码（纯 Java 8 / Android API 28+ 标准 JCA，零外部依赖）。
 *
 * <p>包含：
 * <ul>
 *   <li>EC P-256 长期身份密钥与临时 ECDH 密钥协商；</li>
 *   <li>HKDF-SHA256 派生双向 AES-256-GCM 会话密钥；</li>
 *   <li>ECDSA-SHA256 双向身份认证与 60 秒单次配对密钥 HMAC 校验；</li>
 *   <li>BIP-340 Schnorr (secp256k1) 纯 Java 签名与验签（用于标准 Nostr 公共中继密文信标）；</li>
 *   <li>配对二维码 URI（{@code whale-pair://v1?...}）与紧凑文本口令编解码。</li>
 * </ul>
 */
public final class RemoteCrypto {

    private static final SecureRandom RNG = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private static final char[] B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".toCharArray();

    // secp256k1 曲线参数（用于 BIP-340 Schnorr / Nostr 公共信令签名）
    private static final BigInteger SECP_P = new BigInteger(
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", 16);
    private static final BigInteger SECP_N = new BigInteger(
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16);
    private static final BigInteger SECP_GX = new BigInteger(
            "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16);
    private static final BigInteger SECP_GY = new BigInteger(
            "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", 16);
    private static final BigInteger SECP_SQRT_EXP = SECP_P.add(BigInteger.ONE).shiftRight(2);
    private static final BigInteger THREE = BigInteger.valueOf(3);
    private static final BigInteger SEVEN = BigInteger.valueOf(7);

    private RemoteCrypto() {
    }

    // ------------------------------------------------------------------ 随机与编码

    public static byte[] randomBytes(int len) {
        byte[] out = new byte[len];
        RNG.nextBytes(out);
        return out;
    }

    public static String b64UrlEncode(byte[] data) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(data);
    }

    public static byte[] b64UrlDecode(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    public static String b64Encode(byte[] data) {
        return Base64.getEncoder().encodeToString(data);
    }

    public static byte[] b64Decode(String s) {
        return Base64.getDecoder().decode(s);
    }

    public static String hex(byte[] data) {
        char[] out = new char[data.length * 2];
        for (int i = 0; i < data.length; i++) {
            int v = data[i] & 0xFF;
            out[i * 2] = HEX[v >>> 4];
            out[i * 2 + 1] = HEX[v & 0x0F];
        }
        return new String(out);
    }

    public static byte[] unhex(String s) {
        if (s == null || (s.length() & 1) != 0) throw new IllegalArgumentException("invalid hex");
        int n = s.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            int hi = Character.digit(s.charAt(i * 2), 16);
            int lo = Character.digit(s.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("invalid hex char");
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    public static String base32(byte[] data, int maxChars) {
        StringBuilder sb = new StringBuilder();
        int buffer = 0, bits = 0;
        for (byte b : data) {
            buffer = (buffer << 8) | (b & 0xFF);
            bits += 8;
            while (bits >= 5 && sb.length() < maxChars) {
                bits -= 5;
                sb.append(B32[(buffer >>> bits) & 31]);
            }
            if (sb.length() >= maxChars) break;
        }
        if (bits > 0 && sb.length() < maxChars) {
            sb.append(B32[(buffer << (5 - bits)) & 31]);
        }
        return sb.toString();
    }

    public static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (byte[] p : parts) {
                if (p != null && p.length > 0) md.update(p);
            }
            return md.digest();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public static byte[] hmacSha256(byte[] key, byte[] data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(data);
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }

    public static boolean equalsConstTime(byte[] a, byte[] b) {
        if (a == null || b == null || a.length != b.length) return false;
        int diff = 0;
        for (int i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
        return diff == 0;
    }

    // ------------------------------------------------------------------ EC P-256 身份与 ECDH

    public static KeyPair generateEcKeyPair() {
        try {
            KeyPairGenerator kpg = KeyPairGenerator.getInstance("EC");
            kpg.initialize(new ECGenParameterSpec("secp256r1"), RNG);
            return kpg.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException("EC P-256 keygen failed", e);
        }
    }

    // P-256 (secp256r1) 曲线参数（用于 SEC1 公钥 33 字节压缩，大幅降低配对二维码密度）
    private static final BigInteger P256_P = new BigInteger(
            "FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16);
    private static final BigInteger P256_A = P256_P.subtract(THREE);
    private static final BigInteger P256_B = new BigInteger(
            "5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16);
    private static final BigInteger P256_SQRT_EXP = P256_P.add(BigInteger.ONE).shiftRight(2);
    private static final byte[] P256_SPKI_PREFIX = unhex(
            "3059301306072a8648ce3d020106082a8648ce3d030107034200");

    public static PublicKey decodePublicKey(byte[] x509) {
        try {
            return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(x509));
        } catch (Exception e) {
            throw new IllegalArgumentException("invalid EC public key", e);
        }
    }

    /** 将 91 字节 X.509 P-256 公钥压缩为 33 字节 SEC1 压缩点（0x02/0x03 || X）。 */
    public static byte[] compressP256PublicKey(byte[] x509) {
        if (x509 == null || x509.length != 91 || x509[26] != 0x04) {
            throw new IllegalArgumentException("unexpected P-256 X.509 encoding");
        }
        byte[] out = new byte[33];
        out[0] = (byte) ((x509[90] & 1) == 0 ? 0x02 : 0x03);
        System.arraycopy(x509, 27, out, 1, 32);
        return out;
    }

    /** 将 33 字节 SEC1 压缩点还原为标准 91 字节 X.509 P-256 公钥。 */
    public static byte[] decompressP256PublicKey(byte[] compressed33) {
        if (compressed33 == null || compressed33.length != 33
                || (compressed33[0] != 0x02 && compressed33[0] != 0x03)) {
            throw new IllegalArgumentException("invalid compressed P-256 point");
        }
        byte[] xBytes = Arrays.copyOfRange(compressed33, 1, 33);
        BigInteger x = new BigInteger(1, xBytes);
        if (x.compareTo(P256_P) >= 0) throw new IllegalArgumentException("x out of field");
        BigInteger rhs = x.modPow(THREE, P256_P).add(P256_A.multiply(x)).add(P256_B).mod(P256_P);
        BigInteger y = rhs.modPow(P256_SQRT_EXP, P256_P);
        if (!y.multiply(y).mod(P256_P).equals(rhs)) throw new IllegalArgumentException("point not on P-256");
        boolean wantOdd = compressed33[0] == 0x03;
        if (y.testBit(0) != wantOdd) y = P256_P.subtract(y);
        byte[] yBytes = toBytes32(y);
        byte[] x509 = new byte[91];
        System.arraycopy(P256_SPKI_PREFIX, 0, x509, 0, 26);
        x509[26] = 0x04;
        System.arraycopy(xBytes, 0, x509, 27, 32);
        System.arraycopy(yBytes, 0, x509, 59, 32);
        return x509;
    }

    public static PrivateKey decodePrivateKey(byte[] pkcs8) {
        try {
            return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
        } catch (Exception e) {
            throw new IllegalArgumentException("invalid EC private key", e);
        }
    }

    /** 26 字符稳定设备标识（由公钥 SHA-256 导出，零碰撞）。 */
    public static String deviceIdOf(byte[] pubKeyX509) {
        return base32(sha256(pubKeyX509), 26);
    }

    /** 16 位十六进制公钥指纹（用于短展示与配对核验）。 */
    public static String fingerprintOf(byte[] pubKeyX509) {
        return hex(sha256(pubKeyX509)).substring(0, 16);
    }

    public static byte[] ecdh(PrivateKey priv, PublicKey pub) {
        try {
            KeyAgreement ka = KeyAgreement.getInstance("ECDH");
            ka.init(priv);
            ka.doPhase(pub, true);
            return ka.generateSecret();
        } catch (Exception e) {
            throw new IllegalStateException("ECDH failed", e);
        }
    }

    public static byte[] signEcdsa(PrivateKey priv, byte[] msg) {
        try {
            Signature sig = Signature.getInstance("SHA256withECDSA");
            sig.initSign(priv, RNG);
            sig.update(msg);
            return sig.sign();
        } catch (Exception e) {
            throw new IllegalStateException("ECDSA sign failed", e);
        }
    }

    public static boolean verifyEcdsa(PublicKey pub, byte[] msg, byte[] sigBytes) {
        try {
            Signature sig = Signature.getInstance("SHA256withECDSA");
            sig.initVerify(pub);
            sig.update(msg);
            return sig.verify(sigBytes);
        } catch (Exception e) {
            return false;
        }
    }

    /** RFC 5869 HKDF-SHA256。 */
    public static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info, int len) {
        byte[] actualSalt = (salt == null || salt.length == 0) ? new byte[32] : salt;
        byte[] prk = hmacSha256(actualSalt, ikm);
        byte[] out = new byte[len];
        byte[] prev = new byte[0];
        int pos = 0;
        int counter = 1;
        while (pos < len) {
            byte[] input = new byte[prev.length + (info == null ? 0 : info.length) + 1];
            System.arraycopy(prev, 0, input, 0, prev.length);
            if (info != null) System.arraycopy(info, 0, input, prev.length, info.length);
            input[input.length - 1] = (byte) counter++;
            prev = hmacSha256(prk, input);
            int take = Math.min(prev.length, len - pos);
            System.arraycopy(prev, 0, out, pos, take);
            pos += take;
        }
        return out;
    }

    // ------------------------------------------------------------------ AES-256-GCM 帧加密

    public static byte[] aesGcmEncrypt(byte[] key32, byte[] iv12, byte[] aad, byte[] plain) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key32, "AES"), new GCMParameterSpec(128, iv12));
            if (aad != null && aad.length > 0) c.updateAAD(aad);
            return c.doFinal(plain);
        } catch (Exception e) {
            throw new IllegalStateException("AES-GCM encrypt failed", e);
        }
    }

    public static byte[] aesGcmDecrypt(byte[] key32, byte[] iv12, byte[] aad, byte[] cipherText) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key32, "AES"), new GCMParameterSpec(128, iv12));
            if (aad != null && aad.length > 0) c.updateAAD(aad);
            return c.doFinal(cipherText);
        } catch (Exception e) {
            throw new SecurityException("AES-GCM decrypt failed", e);
        }
    }

    /** 构造确定性 12 字节 IV（4 字节基盐 + 8 字节单调递增序号，永不重用）。 */
    public static byte[] makeNonce(byte[] base4, long seq) {
        byte[] iv = new byte[12];
        System.arraycopy(base4, 0, iv, 0, 4);
        ByteBuffer.wrap(iv, 4, 8).putLong(seq);
        return iv;
    }

    // ------------------------------------------------------------------ 公共信令匿名频道与密文封装

    /** 由配对共享密钥派生的匿名信令频道号（中继无法关联设备名或业务身份）。 */
    public static String deriveSignalTopic(byte[] sharedSecret) {
        return hex(hmacSha256(sharedSecret, "whale-rendezvous-topic-v1".getBytes(StandardCharsets.UTF_8)));
    }

    /** 加密公共信令载荷（仅包含临时候选 IP/端口与打洞握手参数，中继全程不可读）。 */
    public static String encryptSignalPayload(byte[] sharedSecret, String plainJson) {
        byte[] key = hkdfSha256(sharedSecret, null,
                "whale-signal-key-v1".getBytes(StandardCharsets.UTF_8), 32);
        byte[] iv = randomBytes(12);
        byte[] ct = aesGcmEncrypt(key, iv, "whale-sig-v1".getBytes(StandardCharsets.UTF_8),
                plainJson.getBytes(StandardCharsets.UTF_8));
        byte[] pack = new byte[12 + ct.length];
        System.arraycopy(iv, 0, pack, 0, 12);
        System.arraycopy(ct, 0, pack, 12, ct.length);
        return b64UrlEncode(pack);
    }

    public static String decryptSignalPayload(byte[] sharedSecret, String encoded) {
        byte[] pack = b64UrlDecode(encoded);
        if (pack.length <= 28) throw new SecurityException("signal payload too short");
        byte[] iv = Arrays.copyOfRange(pack, 0, 12);
        byte[] ct = Arrays.copyOfRange(pack, 12, pack.length);
        byte[] key = hkdfSha256(sharedSecret, null,
                "whale-signal-key-v1".getBytes(StandardCharsets.UTF_8), 32);
        byte[] pt = aesGcmDecrypt(key, iv, "whale-sig-v1".getBytes(StandardCharsets.UTF_8), ct);
        return new String(pt, StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------ BIP-340 Schnorr (secp256k1)

    private static byte[] taggedHash(String tag, byte[]... parts) {
        byte[] tagHash = sha256(tag.getBytes(StandardCharsets.UTF_8));
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(tagHash);
            md.update(tagHash);
            for (byte[] p : parts) md.update(p);
            return md.digest();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] toBytes32(BigInteger v) {
        byte[] raw = v.toByteArray();
        byte[] out = new byte[32];
        if (raw.length == 32) return raw;
        if (raw.length > 32) {
            System.arraycopy(raw, raw.length - 32, out, 0, 32);
        } else {
            System.arraycopy(raw, 0, out, 32 - raw.length, raw.length);
        }
        return out;
    }

    private static final class SecpPoint {
        final BigInteger x, y;
        final boolean inf;
        static final SecpPoint INF = new SecpPoint(null, null, true);

        SecpPoint(BigInteger x, BigInteger y, boolean inf) {
            this.x = x;
            this.y = y;
            this.inf = inf;
        }
    }

    private static final SecpPoint SECP_G = new SecpPoint(SECP_GX, SECP_GY, false);

    private static SecpPoint secpAdd(SecpPoint p1, SecpPoint p2) {
        if (p1.inf) return p2;
        if (p2.inf) return p1;
        if (p1.x.equals(p2.x)) {
            if (!p1.y.equals(p2.y) || p1.y.signum() == 0) return SecpPoint.INF;
            BigInteger lam = THREE.multiply(p1.x).multiply(p1.x)
                    .multiply(p1.y.shiftLeft(1).modInverse(SECP_P)).mod(SECP_P);
            BigInteger x3 = lam.multiply(lam).subtract(p1.x.shiftLeft(1)).mod(SECP_P);
            BigInteger y3 = lam.multiply(p1.x.subtract(x3)).subtract(p1.y).mod(SECP_P);
            return new SecpPoint(x3, y3, false);
        }
        BigInteger lam = p2.y.subtract(p1.y)
                .multiply(p2.x.subtract(p1.x).mod(SECP_P).modInverse(SECP_P)).mod(SECP_P);
        BigInteger x3 = lam.multiply(lam).subtract(p1.x).subtract(p2.x).mod(SECP_P);
        BigInteger y3 = lam.multiply(p1.x.subtract(x3)).subtract(p1.y).mod(SECP_P);
        return new SecpPoint(x3, y3, false);
    }

    private static SecpPoint secpMul(BigInteger k, SecpPoint pt) {
        BigInteger n = k.mod(SECP_N);
        SecpPoint r = SecpPoint.INF;
        SecpPoint addend = pt;
        for (int i = 0; i < n.bitLength(); i++) {
            if (n.testBit(i)) r = secpAdd(r, addend);
            addend = secpAdd(addend, addend);
        }
        return r;
    }

    private static SecpPoint liftX(byte[] xBytes) {
        BigInteger x = new BigInteger(1, xBytes);
        if (x.compareTo(SECP_P) >= 0) return null;
        BigInteger c = x.modPow(THREE, SECP_P).add(SECP_P).add(SECP_P.subtract(SECP_P)).add(SECP_P);
        c = x.modPow(THREE, SECP_P).add(SEVEN).mod(SECP_P);
        BigInteger y = c.modPow(SECP_SQRT_EXP, SECP_P);
        if (!y.multiply(y).mod(SECP_P).equals(c)) return null;
        if (y.testBit(0)) y = SECP_P.subtract(y);
        return new SecpPoint(x, y, false);
    }

    /** 从 32 字节 secp256k1 私钥派生 32 字节 x-only 公钥（BIP-340 / Nostr pubkey）。 */
    public static byte[] schnorrPubKey(byte[] secKey32) {
        BigInteger d0 = new BigInteger(1, secKey32);
        if (d0.signum() <= 0 || d0.compareTo(SECP_N) >= 0) {
            throw new IllegalArgumentException("invalid secp256k1 secret key");
        }
        SecpPoint P = secpMul(d0, SECP_G);
        return toBytes32(P.x);
    }

    /** BIP-340 Schnorr 签名（64 字节），兼容全部标准 Nostr 公共中继验签。 */
    public static byte[] schnorrSign(byte[] secKey32, byte[] msg32, byte[] auxRand32) {
        BigInteger d0 = new BigInteger(1, secKey32);
        if (d0.signum() <= 0 || d0.compareTo(SECP_N) >= 0) {
            throw new IllegalArgumentException("invalid secp256k1 secret key");
        }
        SecpPoint P = secpMul(d0, SECP_G);
        BigInteger d = P.y.testBit(0) ? SECP_N.subtract(d0) : d0;
        byte[] dBytes = toBytes32(d);
        byte[] pBytes = toBytes32(P.x);
        byte[] auxHash = taggedHash("BIP0340/aux", auxRand32);
        byte[] t = new byte[32];
        for (int i = 0; i < 32; i++) t[i] = (byte) (dBytes[i] ^ auxHash[i]);
        byte[] rand = taggedHash("BIP0340/nonce", t, pBytes, msg32);
        BigInteger k0 = new BigInteger(1, rand).mod(SECP_N);
        if (k0.signum() == 0) throw new IllegalStateException("zero nonce");
        SecpPoint R = secpMul(k0, SECP_G);
        BigInteger k = R.y.testBit(0) ? SECP_N.subtract(k0) : k0;
        byte[] rBytes = toBytes32(R.x);
        byte[] eHash = taggedHash("BIP0340/challenge", rBytes, pBytes, msg32);
        BigInteger e = new BigInteger(1, eHash).mod(SECP_N);
        BigInteger s = k.add(e.multiply(d)).mod(SECP_N);
        byte[] sig = new byte[64];
        System.arraycopy(rBytes, 0, sig, 0, 32);
        System.arraycopy(toBytes32(s), 0, sig, 32, 32);
        return sig;
    }

    /** BIP-340 Schnorr 验签。 */
    public static boolean schnorrVerify(byte[] pubKey32, byte[] msg32, byte[] sig64) {
        if (pubKey32 == null || pubKey32.length != 32 || msg32 == null || msg32.length != 32
                || sig64 == null || sig64.length != 64) return false;
        SecpPoint P = liftX(pubKey32);
        if (P == null) return false;
        byte[] rBytes = Arrays.copyOfRange(sig64, 0, 32);
        BigInteger r = new BigInteger(1, rBytes);
        BigInteger s = new BigInteger(1, Arrays.copyOfRange(sig64, 32, 64));
        if (r.compareTo(SECP_P) >= 0 || s.compareTo(SECP_N) >= 0) return false;
        BigInteger e = new BigInteger(1, taggedHash("BIP0340/challenge", rBytes, pubKey32, msg32)).mod(SECP_N);
        SecpPoint sG = secpMul(s, SECP_G);
        SecpPoint negEP = secpMul(SECP_N.subtract(e).mod(SECP_N), P);
        SecpPoint R = secpAdd(sG, negEP);
        if (R.inf || R.y.testBit(0)) return false;
        return R.x.equals(r);
    }

    // ------------------------------------------------------------------ 配对二维码载荷

    /**
     * 配对二维码与文本口令统一载荷（{@code whale-pair://v1?...}）。
     *
     * <p>含 60 秒有效的一次性配对密钥 {@code pairSecret} 与被控端公钥，
     * 扫码或粘贴口令后可直接完成端到端双向认证并自动入库（单次消耗防复用）。
     */
    public static final class PairPayload {
        public final String deviceId;
        public final String deviceName;
        public final String pubKeyB64;
        public final String pairSecretB64;
        public final String lanEndpoint;
        public final String ipv6Endpoint;
        public final String stunEndpoint;
        public final List<String> relays;
        public final long expiresAt;

        public PairPayload(String deviceId, String deviceName, String pubKeyB64, String pairSecretB64,
                           String lanEndpoint, String ipv6Endpoint, String stunEndpoint,
                           List<String> relays, long expiresAt) {
            this.deviceId = deviceId == null ? "" : deviceId.trim();
            this.deviceName = deviceName == null ? "" : deviceName.trim();
            this.pubKeyB64 = pubKeyB64 == null ? "" : pubKeyB64.trim();
            this.pairSecretB64 = pairSecretB64 == null ? "" : pairSecretB64.trim();
            this.lanEndpoint = lanEndpoint == null ? "" : lanEndpoint.trim();
            this.ipv6Endpoint = ipv6Endpoint == null ? "" : ipv6Endpoint.trim();
            this.stunEndpoint = stunEndpoint == null ? "" : stunEndpoint.trim();
            this.relays = relays == null ? new ArrayList<String>() : new ArrayList<String>(relays);
            this.expiresAt = expiresAt;
        }

        public String toUri() {
            return toCompactQrUri();
        }

        /**
         * 紧凑配对 URI（大幅降低二维码版本：从 Version 17 85×85 降至 Version 6–8 41×41–49×49，显著提升手机互扫识别率）。
         *
         * <ul>
         *   <li>公钥以 33 字节 SEC1 压缩点编码（{@code pkc=}，44 字符代替 122 字符）；</li>
         *   <li>省略可由公钥确定的冗余 {@code id=}；</li>
         *   <li>当信令中继与默认池一致时省略 {@code r=}（省去 ~135 字符）；</li>
         *   <li>{@code e=} 用秒级时间戳；设备名在码内截短至 16 字符（完整名在握手时同步）。</li>
         * </ul>
         */
        public String toCompactQrUri() {
            StringBuilder sb = new StringBuilder("whale-pair://v1?");
            String shortName = deviceName.length() > 16 ? deviceName.substring(0, 16) : deviceName;
            boolean compressedOk = false;
            try {
                byte[] x509 = b64UrlDecode(pubKeyB64);
                byte[] comp = compressP256PublicKey(x509);
                appendParam(sb, "pkc", b64UrlEncode(comp), true);
                compressedOk = true;
            } catch (Throwable ignored) {
            }
            if (!compressedOk) {
                appendParam(sb, "id", deviceId, true);
                appendParam(sb, "pk", pubKeyB64, false);
            }
            appendParam(sb, "s", pairSecretB64, false);
            if (!shortName.isEmpty()) appendParam(sb, "n", shortName, false);
            if (!lanEndpoint.isEmpty()) appendRaw(sb, "lan", lanEndpoint);
            if (!ipv6Endpoint.isEmpty()) appendRaw(sb, "v6", ipv6Endpoint);
            if (!stunEndpoint.isEmpty()) appendRaw(sb, "pub", stunEndpoint);
            if (!relays.isEmpty() && !relays.equals(NostrSignaling.DEFAULT_RELAYS)) {
                StringBuilder rs = new StringBuilder();
                for (int i = 0; i < relays.size(); i++) {
                    if (i > 0) rs.append(',');
                    rs.append(relays.get(i));
                }
                appendParam(sb, "r", rs.toString(), false);
            }
            appendRaw(sb, "e", String.valueOf(expiresAt / 1000L));
            return sb.toString();
        }

        private static void appendRaw(StringBuilder sb, String k, String v) {
            sb.append('&').append(k).append('=').append(v == null ? "" : v);
        }

        private static void appendParam(StringBuilder sb, String k, String v, boolean first) {
            try {
                if (!first) sb.append('&');
                sb.append(k).append('=').append(URLEncoder.encode(v == null ? "" : v, "UTF-8"));
            } catch (Exception ignored) {
            }
        }

        public static PairPayload parse(String raw) {
            if (raw == null) throw new IllegalArgumentException("配对码为空");
            String text = raw.trim();
            int idx = text.indexOf("whale-pair://v1?");
            if (idx < 0) throw new IllegalArgumentException("不是有效的 WhaleOneBot 配对码");
            String query = text.substring(idx + "whale-pair://v1?".length());
            int ws = query.indexOf(' ');
            if (ws > 0) query = query.substring(0, ws);
            int nl = query.indexOf('\n');
            if (nl > 0) query = query.substring(0, nl);

            Map<String, String> kv = new LinkedHashMap<String, String>();
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq <= 0) continue;
                try {
                    kv.put(pair.substring(0, eq), URLDecoder.decode(pair.substring(eq + 1), "UTF-8"));
                } catch (Exception ignored) {
                }
            }
            String pk = kv.get("pk");
            String pkc = kv.get("pkc");
            String sec = kv.get("s");
            if (sec == null || sec.isEmpty()) {
                throw new IllegalArgumentException("配对码缺少必要密钥字段");
            }
            byte[] pkBytes;
            if (pkc != null && !pkc.isEmpty()) {
                pkBytes = decompressP256PublicKey(b64UrlDecode(pkc));
                pk = b64UrlEncode(pkBytes);
            } else if (pk != null && !pk.isEmpty()) {
                pkBytes = b64UrlDecode(pk);
            } else {
                throw new IllegalArgumentException("配对码缺少公钥字段");
            }
            String derivedId = deviceIdOf(pkBytes);
            String id = kv.get("id");
            if (id != null && !id.isEmpty() && !id.equals(derivedId)) {
                throw new IllegalArgumentException("配对码设备指纹与公钥不匹配");
            }
            id = derivedId;

            List<String> relays = new ArrayList<String>();
            String r = kv.get("r");
            if (r != null && !r.isEmpty()) {
                for (String item : r.split(",")) {
                    String u = item.trim();
                    if (!u.isEmpty()) relays.add(u);
                }
            } else {
                relays.addAll(NostrSignaling.DEFAULT_RELAYS);
            }
            long exp = 0L;
            try {
                String eSec = kv.get("e");
                String eMs = kv.get("exp");
                if (eSec != null && !eSec.isEmpty()) exp = Long.parseLong(eSec) * 1000L;
                else if (eMs != null && !eMs.isEmpty()) exp = Long.parseLong(eMs);
            } catch (Exception ignored) {
            }
            return new PairPayload(
                    id,
                    kv.containsKey("n") ? kv.get("n") : "远端设备",
                    pk, sec,
                    kv.get("lan"), kv.get("v6"), kv.get("pub"),
                    relays, exp
            );
        }

        public boolean isExpired(long nowMs) {
            return expiresAt > 0 && nowMs > expiresAt;
        }

        public String shortId() {
            return deviceId.length() > 8 ? deviceId.substring(0, 8).toLowerCase(Locale.US) : deviceId;
        }
    }
}
