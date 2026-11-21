package com.whaleonebot.net;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * GitHub API 与 Release 资产下载的多源 fallback 工具。
 *
 * <p>背景：用户手机默认没有梯子，直连 github.com / api.github.com 经常超时或不可达。
 * 本类按固定顺序依次尝试「官方直连 + 国内镜像前缀」，前一个源失败（超时、网络异常、403/404 等）
 * 自动切换下一个，全部失败才报错。
 *
 * <p><b>信任边界</b>：镜像只作传输层，不参与核心信任链校验；下载资产的完整性与真实性仍由调用方按
 * SHA-256（及内置 pin）严格校验。
 */
public final class MirrorFetch {

    private static final String API_ORIGIN = "https://api.github.com";
    private static final String GITHUB_ORIGIN = "https://github.com/";

    /** 固定顺序的镜像前缀（空串代表官方直连）。 */
    private static final String[] PREFIXES = {
            "",
            "https://gh-proxy.com/",
            "https://ghproxy.net/",
            "https://hub.gitmirror.com/",
            "https://mirror.ghproxy.com/",
    };

    private static final int CONNECT_TIMEOUT_MS = 6000;
    private static final int READ_TIMEOUT_MS = 10000;
    private static final int MAX_REDIRECTS = 5;

    private static volatile String lastErr = "";
    private static volatile String lastSource = "未知";

    private MirrorFetch() {
    }

    /**
     * 返回纯镜像前缀列表（不含官方直连），供传输层白名单复用。
     */
    public static String[] mirrorPrefixes() {
        String[] out = new String[PREFIXES.length - 1];
        System.arraycopy(PREFIXES, 1, out, 0, out.length);
        return out;
    }

    /**
     * 针对官方 GitHub URL 生成按固定顺序排列的候选地址列表：
     * - GitHub 资产地址（https://github.com/...）：官方直连 → gh-proxy.com → ghproxy.net → hub.gitmirror.com → mirror.ghproxy.com；
     * - GitHub API 地址（https://api.github.com/...）：实测公共镜像均返回 403 或不可达，仅走官方直连。
     */
    public static List<String> candidateUrls(String officialUrl) {
        List<String> out = new ArrayList<String>();
        if (officialUrl == null) return out;
        String trimmed = officialUrl.trim();
        if (trimmed.length() == 0) return out;
        if (trimmed.startsWith(GITHUB_ORIGIN)) {
            for (int i = 0; i < PREFIXES.length; i++) {
                out.add(PREFIXES[i] + trimmed);
            }
        } else {
            out.add(trimmed);
        }
        return out;
    }

    /**
     * 读取 GitHub API JSON（如 {@code /repos/18477514055/whale-onebot/releases?per_page=30}）。
     * 仅走官方直连（公共镜像对 api.github.com 返回 403/不可达），失败时更新 {@link #lastError()} 并抛出 {@link IOException}。
     */
    public static String getJson(String path) throws IOException {
        String p = path == null ? "" : path.trim();
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        String officialUrl = API_ORIGIN + p;
        List<String> urls = candidateUrls(officialUrl);
        StringBuilder errs = new StringBuilder();

        for (int i = 0; i < urls.size(); i++) {
            String candidate = urls.get(i);
            HttpURLConnection conn = null;
            try {
                conn = connectFollowingRedirects(candidate, true);
                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    String body = readUtf8(conn.getInputStream());
                    lastErr = "";
                    lastSource = (i == 0) ? "官方" : "镜像";
                    return body;
                }
                appendError(errs, i + 1, String.valueOf(code));
            } catch (Throwable e) {
                appendError(errs, i + 1, shortReason(e));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        lastSource = "未知";
        lastErr = errs.toString();
        throw new IOException(lastErr.length() > 0 ? lastErr : "所有源均失败");
    }

    /**
     * 打开官方 GitHub 资产地址的输入流（自动按顺序尝试官方与镜像源）。
     * 调用方关闭返回的 {@link InputStream} 时会自动断开底层连接。
     * 注意：本方法不做内容校验，调用方必须自行校验 SHA-256。
     */
    public static InputStream open(String officialUrl) throws IOException {
        List<String> urls = candidateUrls(officialUrl);
        if (urls.isEmpty()) {
            lastSource = "未知";
            lastErr = "空地址";
            throw new IOException(lastErr);
        }
        StringBuilder errs = new StringBuilder();

        for (int i = 0; i < urls.size(); i++) {
            String candidate = urls.get(i);
            HttpURLConnection conn = null;
            boolean handedOff = false;
            try {
                conn = connectFollowingRedirects(candidate, false);
                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    InputStream raw = conn.getInputStream();
                    final HttpURLConnection owned = conn;
                    handedOff = true;
                    lastErr = "";
                    lastSource = (i == 0) ? "官方" : "镜像";
                    return new FilterInputStream(raw) {
                        @Override
                        public void close() throws IOException {
                            try {
                                super.close();
                            } finally {
                                owned.disconnect();
                            }
                        }
                    };
                }
                appendError(errs, i + 1, String.valueOf(code));
            } catch (Throwable e) {
                appendError(errs, i + 1, shortReason(e));
            } finally {
                if (!handedOff && conn != null) conn.disconnect();
            }
        }

        lastSource = "未知";
        lastErr = errs.toString();
        throw new IOException(lastErr.length() > 0 ? lastErr : "所有源均失败");
    }

    /** 最近一次全部源失败时的汇总错误信息（形如 {@code 源1: timeout; 源2: 404; ...}）。 */
    public static String lastError() {
        return lastErr == null ? "" : lastErr;
    }

    /** 最近一次成功请求所走的来源标签：{@code 官方}、{@code 镜像} 或 {@code 未知}。 */
    public static String lastSourceLabel() {
        return lastSource == null ? "未知" : lastSource;
    }

    private static HttpURLConnection connectFollowingRedirects(String target, boolean json)
            throws IOException {
        URL cur = new URL(target);
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) cur.openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setRequestProperty("User-Agent", "WhaleOneBot-Android");
            if (json) {
                conn.setRequestProperty("Accept", "application/vnd.github+json");
            } else {
                conn.setRequestProperty("Accept-Encoding", "identity");
            }
            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null || loc.trim().length() == 0) {
                    throw new IOException("redirect-empty");
                }
                URL next = new URL(cur, loc);
                String proto = next.getProtocol();
                if (!"https".equalsIgnoreCase(proto) && !"http".equalsIgnoreCase(proto)) {
                    throw new IOException("redirect-proto");
                }
                cur = next;
                continue;
            }
            return conn;
        }
        throw new IOException("too-many-redirects");
    }

    private static String readUtf8(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void appendError(StringBuilder sb, int index, String reason) {
        if (sb.length() > 0) sb.append("; ");
        sb.append("源").append(index).append(": ").append(reason);
    }

    private static String shortReason(Throwable e) {
        if (e instanceof SocketTimeoutException) return "timeout";
        String m = e == null ? null : e.getMessage();
        if (m != null) {
            String low = m.toLowerCase(java.util.Locale.ROOT);
            if (low.indexOf("timed out") >= 0 || low.indexOf("timeout") >= 0) {
                return "timeout";
            }
            if (m.length() > 0 && m.length() <= 40) return m;
        }
        return e == null ? "error" : e.getClass().getSimpleName();
    }
}
