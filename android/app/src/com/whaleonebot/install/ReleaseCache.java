package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;

/** Immutable private content-addressed cache. Never trusts a hash obtained beside the index. */
final class ReleaseCache {
  static final String ORIGIN = "https://github.com/18477514055/whale-onebot/releases/download/";
  private final File cache;

  interface Transport {
    HttpURLConnection open(URL url) throws IOException;
  }

  private final Transport transport;

  ReleaseCache(File files, Transport transport) throws IOException {
    this.cache = child(files, "core-release-cache");
    this.transport = transport;
  }

  static URL origin(String value) throws IOException {
    require(
        value.matches(
            "https://github\\.com/18477514055/whale-onebot/releases/download/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,150}"),
        "Not an official versioned GitHub release URL");
    return new URL(value);
  }

  static URL redirect(URL from, String location) throws IOException {
    require(location != null, "Missing redirect");
    URL u = new URL(from, location);
    String host = u.getHost();
    if (host.equals("github.com")) return origin(u.toExternalForm());
    require(
        u.getProtocol().equals("https")
            && u.getPort() == -1
            && u.getUserInfo() == null
            && u.getRef() == null
            && (host.equals("release-assets.githubusercontent.com")
                || host.equals("objects.githubusercontent.com")),
        "Untrusted release redirect");
    return u;
  }

  File slot(String pin) throws IOException {
    return child(cache, sha(pin));
  }

  boolean valid(String pin, long bytes) throws IOException {
    File f = slot(pin);
    return f.isFile()
        && (bytes < 0 || f.length() == bytes)
        && (bytes >= 0 || f.length() <= META_LIMIT)
        && hash(f).equals(pin);
  }

  File get(
      String name, String url, String pin, long bytes, long limit, CoreInstaller.Progress progress)
      throws IOException {
    URL u = origin(url);
    require(bytes == -1 || bytes > 0 && bytes <= limit, "Invalid download size");
    synchronized (ReleaseCache.class) {
      if (valid(pin, bytes)) return slot(pin);
      mkdir(cache);
      File tmp = File.createTempFile(".fetch-", ".part", cache);
      try {
        for (int i = 0; i < 6; i++) {
          HttpURLConnection c = transport.open(u);
          try {
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(12000);
            c.setReadTimeout(30000);
            c.setUseCaches(false);
            c.setRequestProperty("Accept-Encoding", "identity");
            int status = c.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
              u = redirect(u, c.getHeaderField("Location"));
              continue;
            }
            require(status == 200, "Download failed: HTTP " + status);
            long len = c.getContentLengthLong();
            require(
                len < 0 || len <= limit && (bytes < 0 || len == bytes), "Download length mismatch");
            MessageDigest md = digest();
            long count = 0, last = 0;
            try (InputStream in = c.getInputStream();
                FileOutputStream out = new FileOutputStream(tmp)) {
              byte[] b = new byte[65536];
              int n;
              while ((n = in.read(b)) != -1) {
                count += n;
                require(
                    count <= limit && (bytes < 0 || count <= bytes), "Download exceeded its limit");
                md.update(b, 0, n);
                out.write(b, 0, n);
                long now = System.nanoTime();
                if (progress != null && now - last > 150000000L) {
                  progress.update(name, count, bytes);
                  last = now;
                }
              }
              out.getFD().sync();
            }
            require(
                (bytes < 0 || count == bytes) && hash(md).equals(pin),
                "Download SHA-256/length mismatch: " + name);
            move(tmp, slot(pin));
            if (progress != null) progress.update(name, count, count);
            return slot(pin);
          } finally {
            c.disconnect();
          }
        }
        throw new IOException("Too many release redirects");
      } finally {
        tmp.delete();
      }
    }
  }
}
