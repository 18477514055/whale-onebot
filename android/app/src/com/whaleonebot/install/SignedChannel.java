package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import java.io.*;
import java.net.*;
import java.security.*;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.*;

/** Optional independently signed moving pointer. Never substitutes an unsigned network pin. */
final class SignedChannel {
  static final String CHANNEL = ReleaseCache.ORIGIN + "core-channel-v1/channel.json";
  private static final int LIMIT = 16 * 1024;

  static Map<String, Object> verify(byte[] envelope, String publicKey) throws Exception {
    Map<String, Object> object = parse(envelope);
    byte[] payload = Base64.getDecoder().decode(str(object, "payload"));
    byte[] signature = Base64.getDecoder().decode(str(object, "signature"));
    RSAPublicKey key =
        (RSAPublicKey)
            KeyFactory.getInstance("RSA")
                .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(publicKey)));
    require(key.getModulus().bitLength() >= 3072, "Weak release channel public key");
    Signature verifier = Signature.getInstance("SHA256withRSA");
    verifier.initVerify(key);
    verifier.update(payload);
    require(verifier.verify(signature), "Release channel signature mismatch");
    Map<String, Object> target = parse(payload);
    ReleaseCache.origin(str(target, "url"));
    require(
        str(target, "url").endsWith("/release-index.json") && num(target, "sequence") > 0,
        "Invalid release channel pointer");
    sha(str(target, "sha256"));
    num(target, "expires");
    return target;
  }

  private static byte[] fetch(ReleaseCache.Transport transport) throws IOException {
    URL url = ReleaseCache.origin(CHANNEL);
    for (int i = 0; i < 6; i++) {
      HttpURLConnection c = transport.open(url);
      try {
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setUseCaches(false);
        int status = c.getResponseCode();
        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
          url = ReleaseCache.redirect(url, c.getHeaderField("Location"));
          continue;
        }
        require(status == 200, "Signed channel unavailable: HTTP " + status);
        try (InputStream in = c.getInputStream()) {
          return read(in, LIMIT);
        }
      } finally {
        c.disconnect();
      }
    }
    throw new IOException("Too many channel redirects");
  }

  static synchronized Map<String, Object> resolve(
      File files, Map<String, Object> bootstrap, ReleaseCache.Transport transport)
      throws Exception {
    if (!bootstrap.containsKey("channelPublicKey")) return bootstrap;
    String key = str(bootstrap, "channelPublicKey");
    long floor = bootstrap.containsKey("minSequence") ? num(bootstrap, "minSequence") : 1;
    File saved = child(files.getCanonicalFile(), "core-release-cache/channel.json");
    Map<String, Object> old = null;
    long now = System.currentTimeMillis() / 1000L;
    if (saved.isFile()) {
      try (InputStream in = new FileInputStream(saved)) {
        old = verify(read(in, LIMIT), key);
      }
      floor = Math.max(floor, num(old, "sequence"));
      if (num(old, "sequence") >= floor
          && num(old, "expires") > now
          && saved.lastModified() <= now * 1000L
          && now * 1000L - saved.lastModified() < 3600000L) return old;
    }
    byte[] bytes;
    try {
      bytes = fetch(transport);
    } catch (IOException unavailable) {
      if (old == null)
        return bootstrap; // Only the exact APK-bundled bootstrap, never a network-supplied pin.
      require(
          num(old, "sequence") >= floor && num(old, "expires") > now,
          "Signed release pointer expired or superseded; cannot refresh");
      return old;
    }
    Map<String, Object> next = verify(bytes, key);
    require(
        num(next, "sequence") >= floor && num(next, "expires") > now,
        "Expired/replayed release pointer");
    if (old != null && num(old, "sequence") == num(next, "sequence")) {
      require(
          str(old, "sha256").equals(str(next, "sha256"))
              && str(old, "url").equals(str(next, "url")),
          "Conflicting release pointer");
    }
    atomic(saved, bytes);
    return next;
  }
}
