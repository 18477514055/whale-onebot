package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import com.whaleonebot.net.MirrorFetch;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Immutable private content-addressed cache. Never trusts a hash obtained beside the index.
 *
 * <p>下载源说明：官方 {@link #ORIGIN} 仍为唯一名义地址；由于用户手机默认没有梯子、直连 github.com
 * 往往失败，传输层统一复用 {@link MirrorFetch} 维护的国内镜像池（含自定义镜像与自动记住最快源）。
 * <b>镜像只作传输层，信任仍由 APK 内置 pin + 流式长度 + SHA-256 决定（这条不可放宽）</b>。
 */
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

  /** 校验官方名义地址：所有清单/索引/通道里声明的资产地址必须是官方版本化 Release URL。 */
  static URL origin(String value) throws IOException {
    require(
        value.matches(
            "https://github\\.com/18477514055/whale-onebot/releases/download/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,150}"),
        "Not an official versioned GitHub release URL");
    return new URL(value);
  }

  /**
   * 白名单前缀检查（官方前缀 + {@link MirrorFetch#mirrorPrefixes()} 白名单）。
   * 剥离镜像前缀后仍必须严格满足 {@link #origin(String)}。
   */
  static URL allowedDownloadUrl(String value) throws IOException {
    require(value != null, "Missing download URL");
    if (value.startsWith(ORIGIN)) {
      return origin(value);
    }
    String[] prefixes = MirrorFetch.mirrorPrefixes();
    for (int i = 0; i < prefixes.length; i++) {
      String prefix = prefixes[i];
      if (value.startsWith(prefix)) {
        origin(value.substring(prefix.length()));
        return new URL(value);
      }
    }
    throw new IOException("URL not in official or mirror whitelist");
  }

  /** 返回按 MirrorFetch 智能排序（含最快源与官方退避）的实际下载候选列表。 */
  static List<URL> candidateUrls(String officialUrl) throws IOException {
    origin(officialUrl);
    List<String> prefixes = MirrorFetch.orderedPrefixes();
    List<URL> out = new ArrayList<URL>(prefixes.size());
    for (int i = 0; i < prefixes.size(); i++) {
      out.add(allowedDownloadUrl(prefixes.get(i) + officialUrl));
    }
    return out;
  }

  private static boolean isMirrorHost(String host) {
    return MirrorFetch.isMirrorHost(host);
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
        boolean isOfficial = "github.com".equals(startUrl.getHost());
        try {
          File got = fetchOne(name, startUrl, pin, bytes, limit, progress, isOfficial);
          if (isOfficial) MirrorFetch.recordSuccessPrefix("");
          else MirrorFetch.recordSuccessPrefix(MirrorFetch.sourcePrefixOf(startUrl.toExternalForm(), url));
          return got;
        } catch (IOException ex) {
          if (isOfficial) MirrorFetch.markOfficialFailed();
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
      String name, URL startUrl, String pin, long bytes, long limit, CoreInstaller.Progress progress,
      boolean isOfficial)
      throws IOException {
    URL u = startUrl;
    File tmp = File.createTempFile(".fetch-", ".part", cache);
    try {
      for (int i = 0; i < 6; i++) {
        HttpURLConnection c = transport.open(u);
        try {
          c.setInstanceFollowRedirects(false);
          c.setConnectTimeout(isOfficial
              ? MirrorFetch.OFFICIAL_CONNECT_TIMEOUT_MS
              : MirrorFetch.MIRROR_CONNECT_TIMEOUT_MS);
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
