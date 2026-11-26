package com.whaleonebot.install;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;

/**
 * [layer: shell-android] 按部件下载：把 {@link ComponentIndex.Entry} 指向的产物取回、校验、落到
 * {@code <files>/components/<group>[-<id>]/<version>/<file>}。
 *
 * <p>信任边界与核心下载一致（P10）：**只信索引里写的 sha256 与长度**，不信服务器。
 * 传输层允许按 {@link ReleaseCache#candidateUrls} 的固定顺序回退到镜像前缀，但那只是传输，
 * 校验不过就换下一个候选，全不过就明确失败 —— 不冒充成功。
 *
 * <p>幂等：目标文件已存在且哈希正确就直接返回，不重复下载。
 */
public final class ComponentFetcher {

  /** 单部件上限 200 MB（当前最大是 51 MB 的环境包）。 */
  private static final long LIMIT = 200L << 20;

  public interface Listener {
    void progress(long bytes, long total);

    /** 成功时 file 非空、error 为空；失败反之。总在后台线程回调。 */
    void done(File file, String error);
  }

  private ComponentFetcher() {}

  /** 该部件在私有目录里的落点（目录 + 文件名）。 */
  public static File target(File files, ComponentIndex.Entry e) throws IOException {
    String slot = e.id == null || e.id.length() == 0 ? e.group : e.group + "-" + e.id;
    File dir = new File(new File(new File(files, "components"), slot), e.version);
    InstallFiles.mkdir(dir);
    return new File(dir, e.file);
  }

  /** 已下载且哈希正确。 */
  public static boolean ready(File files, ComponentIndex.Entry e) {
    try {
      File f = target(files, e);
      if (!f.isFile()) return false;
      if (e.bytes > 0 && f.length() != e.bytes) return false;
      return e.sha256.equals(InstallFiles.hash(f));
    } catch (IOException ex) {
      return false;
    }
  }

  /** 同步下载。调用方负责放到后台线程。 */
  public static File download(File files, ComponentIndex.Entry e, Listener listener) throws IOException {
    if (!e.published()) throw new IOException("该部件还没有发布，没有下载地址");
    File dst = target(files, e);
    if (ready(files, e)) {
      if (listener != null) listener.done(dst, null);
      return dst;
    }

    File tmp = new File(dst.getParentFile(), e.file + ".part");
    List<URL> candidates = ReleaseCache.candidateUrls(e.url);
    String last = "没有可用下载地址";
    for (int i = 0; i < candidates.size(); i++) {
      URL url = candidates.get(i);
      boolean isOfficial = "github.com".equals(url.getHost());
      try {
        fetch(url, tmp, e, listener, isOfficial);
        InstallFiles.move(tmp, dst);
        if (isOfficial) com.whaleonebot.net.MirrorFetch.recordSuccessPrefix("");
        else com.whaleonebot.net.MirrorFetch.recordSuccessPrefix(
            com.whaleonebot.net.MirrorFetch.sourcePrefixOf(url.toExternalForm(), e.url));
        if (listener != null) listener.done(dst, null);
        return dst;
      } catch (Exception ex) {
        if (isOfficial) com.whaleonebot.net.MirrorFetch.markOfficialFailed();
        last = describe(url, ex);
        InstallFiles.erase(tmp);
      }
    }
    if (listener != null) listener.done(null, last);
    throw new IOException(last);
  }

  private static void fetch(
      URL startUrl, File tmp, ComponentIndex.Entry e, Listener listener, boolean isOfficial)
      throws Exception {
    URL url = startUrl;
    HttpURLConnection c = null;
    for (int hop = 0; hop < 6; hop++) {
      c = (HttpURLConnection) url.openConnection();
      c.setConnectTimeout(isOfficial
          ? com.whaleonebot.net.MirrorFetch.OFFICIAL_CONNECT_TIMEOUT_MS
          : com.whaleonebot.net.MirrorFetch.MIRROR_CONNECT_TIMEOUT_MS);
      c.setReadTimeout(60000);
      c.setInstanceFollowRedirects(false);
      c.setUseCaches(false);
      c.setRequestProperty("Accept", "application/octet-stream");
      c.setRequestProperty("Accept-Encoding", "identity");
      int code = c.getResponseCode();
      if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
        String loc = c.getHeaderField("Location");
        c.disconnect();
        c = null;
        url = ReleaseCache.redirect(url, loc);
        continue;
      }
      if (code != 200) {
        c.disconnect();
        throw new IOException("HTTP " + code);
      }
      break;
    }
    if (c == null) throw new IOException("重定向次数过多");

    long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : e.bytes;
    MessageDigest digest = InstallFiles.digest();
    long got = 0L;
    try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
      byte[] buf = new byte[65536];
      int n;
      long lastReport = 0L;
      while ((n = in.read(buf)) > 0) {
        got += n;
        if (got > LIMIT) throw new IOException("超过部件大小上限");
        digest.update(buf, 0, n);
        out.write(buf, 0, n);
        long now = System.currentTimeMillis();
        if (listener != null && (now - lastReport > 200 || got == total)) {
          lastReport = now;
          listener.progress(got, total);
        }
      }
    } finally {
      c.disconnect();
    }
    String sha = InstallFiles.hash(digest);
    if (!e.sha256.equals(sha)) throw new IOException("sha256 不符（期望 " + brief(e.sha256) + "，实际 " + brief(sha) + "）");
    if (e.bytes > 0 && got != e.bytes) throw new IOException("长度不符（期望 " + e.bytes + "，实际 " + got + "）");
  }

  private static String describe(URL url, Exception ex) {
    String msg = ex.getMessage();
    return "下载失败：" + url.getHost() + " — " + (msg == null ? ex.getClass().getSimpleName() : msg);
  }

  private static String brief(String sha) {
    return sha == null || sha.length() < 12 ? String.valueOf(sha) : sha.substring(0, 12) + "…";
  }

  /** 给界面用的一句话状态，避免各处各写一套。 */
  public static String status(File files, ComponentIndex.Entry e) {
    if (!e.published()) return "未发布";
    return ready(files, e) ? "已就绪" : "未下载";
  }

  /** 便于日志：把字节数按 MB 打出来。 */
  public static String mb(long bytes) {
    return String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0);
  }
}
