package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Immutable private content-addressed cache. Never trusts a hash obtained beside the index.
 *
 * <p>下载源说明：官方 {@link #ORIGIN} 仍为唯一名义地址；由于用户手机默认没有梯子、直连 github.com
 * 往往失败，传输层允许按固定顺序回退到 {@link #MIRROR_PREFIXES} 里的镜像前缀。
 * <b>镜像只作传输层，信任仍由 APK 内置 pin + 流式长度 + SHA-256 决定（这条不可放宽）</b>。
 */
final class ReleaseCache {
  static final String ORIGIN = "https://github.com/18477514055/whale-onebot/releases/download/";

  /**
   * 镜像前缀白名单（原因：用户没有梯子，直连 GitHub 资产经常超时）。
   * 顺序固定：官方直连之后依次尝试 gh-proxy.com → ghproxy.net → hub.gitmirror.com → mirror.ghproxy.com。
   * 镜像只作传输层，不放宽任何 SHA-256 / 长度 / pin 校验。
   */
  static final String[] MIRROR_PREFIXES = {
    "https://gh-proxy.com/",
    "https://ghproxy.net/",
    "https://hub.gitmirror.com/",
    "https://mirror.ghproxy.com/",
  };

  private static final String[] MIRROR_HOSTS = {
    "gh-proxy.com",
    "ghproxy.net",
    "hub.gitmirror.com",
    "mirror.ghproxy.com",
  };

  private final File cache;

  interface Transport {
    HttpURLConnection open(URL url) throws IOException;
  }

  private final Transport transport;

  ReleaseCache(File files, Transport transport) throws IOException {
    this.cache = child(files, "core-release-cache");
    this.transport = transport;
  }

  /** 校验官方名义地址：所有清单/索引/通道里声明的资产地址必须是官方版本化 Release URL。 */
  static URL origin(String value) throws IOException {
    require(
        value.matches(
            "https://github\\.com/18477514055/whale-onebot/releases/download/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,150}"),
        "Not an official versioned GitHub release URL");
    return new URL(value);
  }

  /**
   * 白名单前缀检查（官方前缀 + 镜像前缀白名单）。
   * 改动原因：用户没有梯子，允许通过白名单镜像前缀传输官方 Release 资产；剥离镜像前缀后仍必须严格满足 {@link #origin(String)}。
   */
  static URL allowedDownloadUrl(String value) throws IOException {
    require(value != null, "Missing download URL");
    if (value.startsWith(ORIGIN)) {
      return origin(value);
    }
    for (int i = 0; i < MIRROR_PREFIXES.length; i++) {
      String prefix = MIRROR_PREFIXES[i];
      if (value.startsWith(prefix)) {
        origin(value.substring(prefix.length()));
        return new URL(value);
      }
    }
    throw new IOException("URL not in official or mirror whitelist");
  }

  /** 按固定顺序返回实际下载候选：官方 → gh-proxy.com → ghproxy.net → hub.gitmirror.com → mirror.ghproxy.com。 */
  static List<URL> candidateUrls(String officialUrl) throws IOException {
    URL official = origin(officialUrl);
    List<URL> out = new ArrayList<URL>(1 + MIRROR_PREFIXES.length);
    out.add(official);
    for (int i = 0; i < MIRROR_PREFIXES.length; i++) {
      out.add(allowedDownloadUrl(MIRROR_PREFIXES[i] + officialUrl));
    }
    return out;
  }

  private static boolean isMirrorHost(String host) {
    if (host == null) return false;
    for (int i = 0; i < MIRROR_HOSTS.length; i++) {
      if (MIRROR_HOSTS[i].equals(host)) return true;
    }
    return false;
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
                || host.equals("objects.githubusercontent.com")
                || isMirrorHost(host)),
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
    // 先校验官方名义地址；实际传输按 官方 -> 4 个镜像前缀 顺序重试。
    List<URL> candidates = candidateUrls(url);
    require(bytes == -1 || bytes > 0 && bytes <= limit, "Invalid download size");
    synchronized (ReleaseCache.class) {
      if (valid(pin, bytes)) return slot(pin);
      mkdir(cache);
      StringBuilder failures = new StringBuilder();
      for (int idx = 0; idx < candidates.size(); idx++) {
        URL startUrl = allowedDownloadUrl(candidates.get(idx).toExternalForm());
        try {
          return fetchOne(name, startUrl, pin, bytes, limit, progress);
        } catch (IOException ex) {
          if (failures.length() > 0) failures.append("; ");
          failures.append("源").append(idx + 1).append(": ")
              .append(ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage());
        }
      }
      throw new IOException("All download sources failed (" + name + "): " + failures);
    }
  }

  /**
   * 从单个候选源下载到临时文件，严格做流式长度上限 + 精确长度 + SHA-256 校验；
   * 校验不过立即删除临时文件并抛异常，绝不把未校验字节落盘或原子改名。
   */
  private File fetchOne(
      String name, URL startUrl, String pin, long bytes, long limit, CoreInstaller.Progress progress)
      throws IOException {
    URL u = startUrl;
    File tmp = File.createTempFile(".fetch-", ".part", cache);
    try {
      for (int i = 0; i < 6; i++) {
        HttpURLConnection c = transport.open(u);
        try {
          c.setInstanceFollowRedirects(false);
          c.setConnectTimeout(6000);
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
