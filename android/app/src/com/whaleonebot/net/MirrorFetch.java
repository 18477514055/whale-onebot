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
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;

/**
 * [layer: shell-android] 全应用统一 GitHub 无 VPN 多源路由与国内镜像容灾引擎。
 *
 * <p>核心设计原则：
 * <ul>
 *   <li>假定绝大多数用户手机没有梯子，默认内置 2026-11-26 实测可用的国内镜像池（7 节点）+ jsDelivr CDN（专供 raw 文件）；</li>
 *   <li>官方直连采用极短连接超时（2.5s），一旦超时或不可达自动退避（10 分钟内直接优先走最快可用国内镜像，避免每次点击白等）；</li>
 *   <li>记住最近一次成功且最快的镜像源，支持用户在设置中追加自定义镜像前缀并执行一键全节点测速；</li>
 *   <li>应用版本列表优先走静态 {@code app-releases.json}（通过 jsDelivr + 国内镜像池直拉），彻底规避 {@code api.github.com} 封锁与 60 次/小时限流；</li>
 *   <li><b>安全边界</b>：镜像仅作传输层，所有核心/环境/部件的真实性仍由调用方按 APK 内置 pin + SHA-256 严格校验。</li>
 * </ul>
 *
 * <p>本类保持纯 Java 实现（不直接依赖 Android SDK），持久化通过 {@link Store} 注入，便于桌面端直接跑单测。
 */
public final class MirrorFetch {

    private static final String API_ORIGIN = "https://api.github.com";
    private static final String GITHUB_ORIGIN = "https://github.com/";
    private static final String RAW_ORIGIN = "https://raw.githubusercontent.com/";

    /** 静态 App 发布列表（托管在主仓库，可通过 jsDelivr 与国内镜像免 VPN 拉取）。 */
    public static final String APP_RELEASES_RAW_URL =
            "https://raw.githubusercontent.com/18477514055/whale-onebot/main/runtime-index/app-releases.json";

    /** 测速探测目标：优先用轻量静态文件，既不消耗 API 额度也能真实验证镜像通路。 */
    private static final String PROBE_TARGET_GITHUB =
            "https://github.com/18477514055/whale-onebot/raw/main/runtime-index/app-releases.json";
    private static final String PROBE_TARGET_FALLBACK =
            "https://github.com/18477514055/whale-onebot/releases/download/v1.2.6/SHA256SUMS";

    /**
     * 2026-11-26 实测可用的国内 GitHub 镜像前缀池（空串代表官方直连）。
     * 已移除实测超时的 ghproxy.net 与 gh.llkk.cc。
     */
    private static final String[] DEFAULT_MIRRORS = {
            "https://gh-proxy.com/",
            "https://gh-proxy.org/",
            "https://ghfast.top/",
            "https://hk.gh-proxy.com/",
            "https://cdn.gh-proxy.com/",
            "https://ghfile.geekertao.top/",
            "https://gh.ddlc.top/",
    };

    /** 专用于 raw.githubusercontent.com 的公共 CDN 节点（2026-11-26 实测均 200 OK ~1.1s）。 */
    private static final String[] JSDELIVR_BASES = {
            "https://cdn.jsdelivr.net/gh/",
            "https://fastly.jsdelivr.net/gh/",
    };

    private static final String K_PREFERRED = "preferred_mirror";
    private static final String K_CUSTOM = "custom_mirrors";
    private static final String K_MIRROR_FIRST = "mirror_first";

    /** 官方直连极短超时（2.5 秒），无 VPN 时不让用户干等。 */
    public static final int OFFICIAL_CONNECT_TIMEOUT_MS = 2500;
    public static final int MIRROR_CONNECT_TIMEOUT_MS = 6000;
    private static final int READ_TIMEOUT_MS = 12000;
    private static final int MAX_REDIRECTS = 6;
    /** 官方直连失败后的自动退避窗口（10 分钟内先走最快国内镜像，官方放末尾兜底）。 */
    private static final long OFFICIAL_BACKOFF_MS = 10L * 60L * 1000L;

    /** 轻量键值持久化接口（由 Android 侧 SharedPreferences 或单测内存实现注入）。 */
    public interface Store {
        String read(String key, String def);
        void write(String key, String value);
    }

    /** 单个镜像节点的实时测速结果。 */
    public static final class ProbeResult {
        public final String prefix;
        public final String label;
        public final boolean official;
        public final boolean custom;
        public final boolean ok;
        public final long latencyMs;
        public final String detail;

        public ProbeResult(String prefix, String label, boolean official, boolean custom,
                           boolean ok, long latencyMs, String detail) {
            this.prefix = prefix;
            this.label = label;
            this.official = official;
            this.custom = custom;
            this.ok = ok;
            this.latencyMs = latencyMs;
            this.detail = detail == null ? "" : detail;
        }
    }

    private static volatile Store store;
    private static volatile String preferredMirror = "";
    private static volatile List<String> customMirrorList = Collections.emptyList();
    private static volatile boolean preferMirrorFirst = false;
    private static volatile long officialBackoffUntil = 0L;

    private static volatile String lastErr = "";
    private static volatile String lastSource = "未知";

    private MirrorFetch() {
    }

    /** 挂载持久化存储并恢复上次最快源与自定义镜像列表。 */
    public static synchronized void attachStore(Store s) {
        store = s;
        if (s == null) return;
        String pref = normalizePrefix(s.read(K_PREFERRED, ""));
        preferredMirror = pref;
        customMirrorList = parseCustomList(s.read(K_CUSTOM, ""));
        preferMirrorFirst = "1".equals(s.read(K_MIRROR_FIRST, "0"));
    }

    /** 重置运行时状态（仅供单测使用）。 */
    public static synchronized void resetForTest() {
        store = null;
        preferredMirror = "";
        customMirrorList = Collections.emptyList();
        preferMirrorFirst = false;
        officialBackoffUntil = 0L;
        lastErr = "";
        lastSource = "未知";
    }

    /** 是否开启「始终国内镜像优先」（不先探官方 2.5s）。 */
    public static boolean isMirrorFirst() {
        return preferMirrorFirst;
    }

    public static synchronized void setMirrorFirst(boolean enabled) {
        preferMirrorFirst = enabled;
        Store s = store;
        if (s != null) s.write(K_MIRROR_FIRST, enabled ? "1" : "0");
    }

    /** 当前记住的最快国内镜像前缀（空串表示尚未测定）。 */
    public static String preferredPrefix() {
        return preferredMirror == null ? "" : preferredMirror;
    }

    /** 记录最近成功/最快的镜像前缀（空串代表官方直连）。 */
    public static synchronized void recordSuccessPrefix(String prefix) {
        String norm = normalizePrefix(prefix);
        if (norm.length() == 0) {
            // 官方通畅，解除退避
            officialBackoffUntil = 0L;
            return;
        }
        preferredMirror = norm;
        Store s = store;
        if (s != null) s.write(K_PREFERRED, norm);
    }

    /** 标记官方直连刚失败，进入 10 分钟国内优先退避窗口。 */
    public static void markOfficialFailed() {
        officialBackoffUntil = System.currentTimeMillis() + OFFICIAL_BACKOFF_MS;
    }

    /** 当前是否处于官方退避状态。 */
    public static boolean isOfficialBackedOff() {
        return preferMirrorFirst || System.currentTimeMillis() < officialBackoffUntil;
    }

    /** 读取用户自定义镜像前缀列表（每个均以 https:// 或 http:// 开头并以 / 结尾）。 */
    public static List<String> customPrefixes() {
        return new ArrayList<String>(customMirrorList);
    }

    /** 保存用户自定义镜像前缀列表（支持换行或逗号分隔输入）。 */
    public static synchronized List<String> setCustomPrefixesFromText(String raw) {
        List<String> parsed = parseCustomList(raw);
        customMirrorList = parsed;
        Store s = store;
        if (s != null) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < parsed.size(); i++) {
                if (i > 0) sb.append('\n');
                sb.append(parsed.get(i));
            }
            s.write(K_CUSTOM, sb.toString());
        }
        return new ArrayList<String>(parsed);
    }

    /**
     * 返回全部纯国内镜像前缀（自定义优先 → 最近最快源 → 默认实测池），去重、不含官方空串。
     */
    public static String[] mirrorPrefixes() {
        LinkedHashSet<String> set = new LinkedHashSet<String>();
        for (String c : customMirrorList) {
            if (c != null && c.length() > 0) set.add(c);
        }
        String pref = preferredMirror;
        if (pref != null && pref.length() > 0) {
            set.add(pref);
        }
        for (String d : DEFAULT_MIRRORS) {
            set.add(d);
        }
        return set.toArray(new String[set.size()]);
    }

    /** 判断某主机是否属于已配置镜像域名（默认池 + 用户自定义 + jsDelivr），供安全重定向校验复用。 */
    public static boolean isMirrorHost(String host) {
        if (host == null || host.length() == 0) return false;
        String low = host.toLowerCase(Locale.ROOT);
        if ("cdn.jsdelivr.net".equals(low) || "fastly.jsdelivr.net".equals(low)) return true;
        String[] prefixes = mirrorPrefixes();
        for (int i = 0; i < prefixes.length; i++) {
            String h = hostOf(prefixes[i]);
            if (h.length() > 0 && h.equals(low)) return true;
        }
        return false;
    }

    /**
     * 返回带官方直连的有序前缀清单（空串表示官方直连）：
     * - 正常态：官方直连（短超时 2.5s）→ 自定义镜像 → 最近最快镜像 → 默认镜像池；
     * - 镜像优先/官方退避态：自定义镜像 → 最近最快镜像 → 默认镜像池 → 官方直连（兜底）。
     */
    public static List<String> orderedPrefixes() {
        String[] mirrors = mirrorPrefixes();
        List<String> out = new ArrayList<String>(mirrors.length + 1);
        if (!isOfficialBackedOff()) {
            out.add("");
            for (String m : mirrors) out.add(m);
        } else {
            for (String m : mirrors) out.add(m);
            out.add("");
        }
        return out;
    }

    /**
     * 把 {@code https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>} 转为 jsDelivr CDN 地址列表。
     * 不符合 raw 格式则返回空列表。
     */
    public static List<String> rawToJsDelivrUrls(String rawUrl) {
        List<String> out = new ArrayList<String>();
        if (rawUrl == null || !rawUrl.startsWith(RAW_ORIGIN)) return out;
        String rest = rawUrl.substring(RAW_ORIGIN.length());
        // <owner>/<repo>/<ref>/<path...>
        int s1 = rest.indexOf('/');
        if (s1 <= 0) return out;
        int s2 = rest.indexOf('/', s1 + 1);
        if (s2 <= s1 + 1) return out;
        int s3 = rest.indexOf('/', s2 + 1);
        if (s3 <= s2 + 1 || s3 >= rest.length() - 1) return out;
        String owner = rest.substring(0, s1);
        String repo = rest.substring(s1 + 1, s2);
        String ref = rest.substring(s2 + 1, s3);
        String filePath = rest.substring(s3 + 1);
        // 兼容 refs/heads/main 写法
        if (ref.equals("refs") && filePath.startsWith("heads/")) {
            int next = filePath.indexOf('/', 6);
            if (next > 6 && next < filePath.length() - 1) {
                ref = filePath.substring(6, next);
                filePath = filePath.substring(next + 1);
            }
        }
        String suffix = owner + "/" + repo + "@" + ref + "/" + filePath;
        for (String base : JSDELIVR_BASES) {
            out.add(base + suffix);
        }
        return out;
    }

    /**
     * 针对任意 GitHub URL 生成完整的无 VPN 候选路由清单：
     * - {@code https://github.com/...} → 按 {@link #orderedPrefixes()} 拼接镜像与官方；
     * - {@code https://raw.githubusercontent.com/...} → 融合 jsDelivr CDN + 通用镜像前缀 + 官方；
     * - 其他 URL（含 {@code api.github.com}）→ 原样返回。
     */
    public static List<String> candidateUrls(String officialUrl) {
        List<String> out = new ArrayList<String>();
        if (officialUrl == null) return out;
        String trimmed = officialUrl.trim();
        if (trimmed.length() == 0) return out;
        Set<String> seen = new LinkedHashSet<String>();

        if (trimmed.startsWith(GITHUB_ORIGIN)) {
            List<String> prefixes = orderedPrefixes();
            for (String p : prefixes) {
                seen.add(p + trimmed);
            }
        } else if (trimmed.startsWith(RAW_ORIGIN)) {
            List<String> cdnUrls = rawToJsDelivrUrls(trimmed);
            String[] mirrors = mirrorPrefixes();
            if (!isOfficialBackedOff()) {
                seen.add(trimmed);
                for (String u : cdnUrls) seen.add(u);
                for (String m : mirrors) seen.add(m + trimmed);
            } else {
                for (String u : cdnUrls) seen.add(u);
                for (String m : mirrors) seen.add(m + trimmed);
                seen.add(trimmed);
            }
        } else {
            seen.add(trimmed);
        }
        out.addAll(seen);
        return out;
    }

    /**
     * 判断一个候选 URL 对应的源前缀（空串 = 官方直连，否则返回镜像前缀或 jsDelivr 主机标识）。
     */
    public static String sourcePrefixOf(String candidateUrl, String officialUrl) {
        if (candidateUrl == null) return "";
        if (candidateUrl.equals(officialUrl)) return "";
        String[] mirrors = mirrorPrefixes();
        for (String m : mirrors) {
            if (candidateUrl.startsWith(m)) return m;
        }
        return "";
    }

    /** 友好来源名（供界面显示，如「官方直连」「镜像 gh-proxy.com」「CDN jsDelivr」）。 */
    public static String describeCandidate(String candidateUrl, String officialUrl) {
        if (candidateUrl == null || candidateUrl.equals(officialUrl)) return "官方直连";
        String host = hostOf(candidateUrl);
        if (host.contains("jsdelivr.net")) return "CDN " + host;
        return host.length() > 0 ? ("镜像 " + host) : "国内镜像";
    }

    /**
     * 拉取 App 发布列表 JSON（兼容 GitHub Releases JSON 数组格式）：
     * 1) 优先拉取托管在仓库里的静态 {@link #APP_RELEASES_RAW_URL}（走 jsDelivr + 国内镜像，免 VPN、无限流）；
     * 2) 全部失败后回退到官方 {@code api.github.com/repos/18477514055/whale-onebot/releases?per_page=30}。
     */
    public static String getAppReleasesJson(String fallbackApiPath) throws IOException {
        String staticErr = "";
        try {
            String body = getText(APP_RELEASES_RAW_URL, READ_TIMEOUT_MS);
            if (body != null && body.trim().startsWith("[")) {
                return body;
            }
            staticErr = "静态索引格式无效";
        } catch (IOException e) {
            staticErr = e.getMessage() == null ? "静态索引不可达" : e.getMessage();
        }
        try {
            return getJson(fallbackApiPath);
        } catch (IOException e) {
            String apiErr = e.getMessage() == null ? "API 失败" : e.getMessage();
            lastErr = "镜像索引(" + staticErr + ")；官方API(" + apiErr + ")";
            throw new IOException(lastErr);
        }
    }

    /**
     * 读取 GitHub API JSON（如 {@code /repos/18477514055/whale-onebot/releases?per_page=30}）。
     */
    public static String getJson(String path) throws IOException {
        String p = path == null ? "" : path.trim();
        if (!p.startsWith("/")) p = "/" + p;
        String officialUrl = API_ORIGIN + p;
        HttpURLConnection conn = null;
        try {
            conn = connectFollowingRedirects(officialUrl, true, OFFICIAL_CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS);
            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                String body = readUtf8(conn.getInputStream());
                lastErr = "";
                lastSource = "官方 API";
                return body;
            }
            lastSource = "未知";
            lastErr = "官方API: HTTP " + code;
            throw new IOException(lastErr);
        } catch (IOException e) {
            lastSource = "未知";
            lastErr = "官方API: " + shortReason(e);
            throw e;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * 读取文本内容（支持 GitHub / raw.githubusercontent.com 自动镜像与 jsDelivr 容灾）。
     */
    public static String getText(String officialUrl, int readTimeoutMs) throws IOException {
        List<String> urls = candidateUrls(officialUrl);
        if (urls.isEmpty()) {
            lastSource = "未知";
            lastErr = "空地址";
            throw new IOException(lastErr);
        }
        StringBuilder errs = new StringBuilder();
        for (int i = 0; i < urls.size(); i++) {
            String candidate = urls.get(i);
            boolean isOfficial = candidate.equals(officialUrl);
            int connectMs = isOfficial ? OFFICIAL_CONNECT_TIMEOUT_MS : MIRROR_CONNECT_TIMEOUT_MS;
            HttpURLConnection conn = null;
            try {
                conn = connectFollowingRedirects(candidate, false, connectMs, readTimeoutMs);
                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    String body = readUtf8(conn.getInputStream());
                    lastErr = "";
                    lastSource = describeCandidate(candidate, officialUrl);
                    String prefix = sourcePrefixOf(candidate, officialUrl);
                    if (isOfficial) recordSuccessPrefix("");
                    else if (prefix.length() > 0) recordSuccessPrefix(prefix);
                    return body;
                }
                if (isOfficial) markOfficialFailed();
                appendError(errs, i + 1, describeCandidate(candidate, officialUrl) + " HTTP " + code);
            } catch (Throwable e) {
                if (isOfficial) markOfficialFailed();
                appendError(errs, i + 1, describeCandidate(candidate, officialUrl) + " " + shortReason(e));
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        lastSource = "未知";
        lastErr = errs.toString();
        throw new IOException(lastErr.length() > 0 ? lastErr : "所有源均失败");
    }

    /**
     * 打开官方 GitHub 资产地址的输入流（自动走国内镜像与官方容灾）。
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
            boolean isOfficial = candidate.equals(officialUrl);
            int connectMs = isOfficial ? OFFICIAL_CONNECT_TIMEOUT_MS : MIRROR_CONNECT_TIMEOUT_MS;
            HttpURLConnection conn = null;
            boolean handedOff = false;
            try {
                conn = connectFollowingRedirects(candidate, false, connectMs, READ_TIMEOUT_MS);
                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    InputStream raw = conn.getInputStream();
                    final HttpURLConnection owned = conn;
                    handedOff = true;
                    lastErr = "";
                    lastSource = describeCandidate(candidate, officialUrl);
                    String prefix = sourcePrefixOf(candidate, officialUrl);
                    if (isOfficial) recordSuccessPrefix("");
                    else if (prefix.length() > 0) recordSuccessPrefix(prefix);
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
                if (isOfficial) markOfficialFailed();
                appendError(errs, i + 1, describeCandidate(candidate, officialUrl) + " HTTP " + code);
            } catch (Throwable e) {
                if (isOfficial) markOfficialFailed();
                appendError(errs, i + 1, describeCandidate(candidate, officialUrl) + " " + shortReason(e));
            } finally {
                if (!handedOff && conn != null) conn.disconnect();
            }
        }

        lastSource = "未知";
        lastErr = errs.toString();
        throw new IOException(lastErr.length() > 0 ? lastErr : "所有源均失败");
    }

    /**
     * 为系统 {@code DownloadManager}（APK 下载等）探测并返回一个当前网络实际可连通的下载地址。
     * 会按 {@link #candidateUrls(String)} 依次做轻量 Range(0-63) 探测，首个返回 200/206 的源立刻返回。
     * 若所有探测均失败，返回首个国内镜像候选（或原 URL），不抛异常阻塞调用方。
     */
    public static String resolveDownloadUrl(String officialUrl) {
        List<String> urls = candidateUrls(officialUrl);
        if (urls.isEmpty()) return officialUrl == null ? "" : officialUrl;
        for (int i = 0; i < urls.size(); i++) {
            String candidate = urls.get(i);
            boolean isOfficial = candidate.equals(officialUrl);
            int connectMs = isOfficial ? OFFICIAL_CONNECT_TIMEOUT_MS : MIRROR_CONNECT_TIMEOUT_MS;
            HttpURLConnection conn = null;
            try {
                conn = connectRangeProbe(candidate, connectMs, 5000);
                int code = conn.getResponseCode();
                if (code == 200 || code == 206) {
                    lastSource = describeCandidate(candidate, officialUrl);
                    String prefix = sourcePrefixOf(candidate, officialUrl);
                    if (isOfficial) recordSuccessPrefix("");
                    else if (prefix.length() > 0) recordSuccessPrefix(prefix);
                    return candidate;
                }
                if (isOfficial) markOfficialFailed();
            } catch (Throwable ignored) {
                if (isOfficial) markOfficialFailed();
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        // 全探测失败时仍优先返回国内镜像而非裸 github.com
        String[] mirrors = mirrorPrefixes();
        if (officialUrl != null && officialUrl.startsWith(GITHUB_ORIGIN) && mirrors.length > 0) {
            return mirrors[0] + officialUrl;
        }
        return officialUrl;
    }

    /**
     * 并行测速所有候选节点（自定义镜像 + 默认国内镜像 + 官方直连），自动将最快可用国内镜像设为首选。
     * 建议在后台线程调用。
     */
    public static List<ProbeResult> probeAllMirrors() {
        List<String> custom = customPrefixes();
        Set<String> customSet = new LinkedHashSet<String>(custom);
        List<String> targets = new ArrayList<String>();
        targets.add(""); // 官方直连
        for (String c : custom) {
            if (!targets.contains(c)) targets.add(c);
        }
        for (String d : DEFAULT_MIRRORS) {
            if (!targets.contains(d)) targets.add(d);
        }

        final ProbeResult[] slots = new ProbeResult[targets.size()];
        final CountDownLatch latch = new CountDownLatch(targets.size());
        for (int i = 0; i < targets.size(); i++) {
            final int idx = i;
            final String prefix = targets.get(i);
            final boolean isOff = prefix.length() == 0;
            final boolean isCust = customSet.contains(prefix);
            final String label = isOff ? "GitHub 官方直连" : hostOf(prefix);
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        slots[idx] = probeSingle(prefix, label, isOff, isCust);
                    } finally {
                        latch.countDown();
                    }
                }
            }, "mirror-probe-" + idx);
            t.setDaemon(true);
            t.start();
        }
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        List<ProbeResult> results = new ArrayList<ProbeResult>(slots.length);
        ProbeResult fastestMirror = null;
        boolean officialOk = false;
        for (ProbeResult r : slots) {
            if (r == null) continue;
            results.add(r);
            if (r.official) {
                officialOk = r.ok;
            } else if (r.ok && (fastestMirror == null || r.latencyMs < fastestMirror.latencyMs)) {
                fastestMirror = r;
            }
        }
        if (fastestMirror != null) {
            recordSuccessPrefix(fastestMirror.prefix);
        }
        if (officialOk) {
            officialBackoffUntil = 0L;
        } else {
            markOfficialFailed();
        }
        return results;
    }

    private static ProbeResult probeSingle(String prefix, String label, boolean official, boolean custom) {
        long start = System.currentTimeMillis();
        String[] probeUrls = { PROBE_TARGET_GITHUB, PROBE_TARGET_FALLBACK };
        String lastDetail = "不可达";
        int connectMs = official ? OFFICIAL_CONNECT_TIMEOUT_MS : 5000;
        for (String target : probeUrls) {
            String url = prefix + target;
            HttpURLConnection conn = null;
            try {
                conn = connectRangeProbe(url, connectMs, 5000);
                int code = conn.getResponseCode();
                long cost = Math.max(1L, System.currentTimeMillis() - start);
                if (code == 200 || code == 206) {
                    return new ProbeResult(prefix, label, official, custom, true, cost, "HTTP " + code);
                }
                lastDetail = "HTTP " + code;
            } catch (Throwable e) {
                lastDetail = shortReason(e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        long cost = Math.max(1L, System.currentTimeMillis() - start);
        return new ProbeResult(prefix, label, official, custom, false, cost, lastDetail);
    }

    /** 最近一次全部源失败时的汇总错误信息。 */
    public static String lastError() {
        return lastErr == null ? "" : lastErr;
    }

    /** 最近一次成功请求所走的来源标签。 */
    public static String lastSourceLabel() {
        return lastSource == null ? "未知" : lastSource;
    }

    private static HttpURLConnection connectRangeProbe(String target, int connectMs, int readMs) throws IOException {
        URL cur = new URL(target);
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) cur.openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(connectMs);
            conn.setReadTimeout(readMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("User-Agent", "WhaleOneBot-Android");
            conn.setRequestProperty("Range", "bytes=0-63");
            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null || loc.trim().length() == 0) throw new IOException("redirect-empty");
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

    private static HttpURLConnection connectFollowingRedirects(
            String target, boolean json, int connectMs, int readMs) throws IOException {
        URL cur = new URL(target);
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection conn = (HttpURLConnection) cur.openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(connectMs);
            conn.setReadTimeout(readMs);
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

    /** 规范化镜像前缀：仅接受 https:// 或 http://，自动补齐末尾斜杠。 */
    public static String normalizePrefix(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.length() == 0) return "";
        String low = s.toLowerCase(Locale.ROOT);
        if (!low.startsWith("https://") && !low.startsWith("http://")) return "";
        if (!s.endsWith("/")) s = s + "/";
        try {
            URL u = new URL(s);
            if (u.getHost() == null || u.getHost().length() == 0) return "";
        } catch (Throwable e) {
            return "";
        }
        return s;
    }

    private static List<String> parseCustomList(String raw) {
        List<String> out = new ArrayList<String>();
        if (raw == null || raw.trim().length() == 0) return out;
        String[] parts = raw.split("[\\r\\n,;\\s]+");
        Set<String> seen = new LinkedHashSet<String>();
        for (String p : parts) {
            String norm = normalizePrefix(p);
            if (norm.length() > 0 && seen.add(norm)) out.add(norm);
        }
        return out;
    }

    private static String hostOf(String url) {
        if (url == null || url.length() == 0) return "";
        try {
            String h = new URL(url).getHost();
            return h == null ? "" : h.toLowerCase(Locale.ROOT);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static void appendError(StringBuilder sb, int index, String reason) {
        if (sb.length() > 0) sb.append("; ");
        sb.append("源").append(index).append(": ").append(reason);
    }

    private static String shortReason(Throwable e) {
        if (e instanceof SocketTimeoutException) return "timeout";
        String m = e == null ? null : e.getMessage();
        if (m != null) {
            String low = m.toLowerCase(Locale.ROOT);
            if (low.indexOf("timed out") >= 0 || low.indexOf("timeout") >= 0) {
                return "timeout";
            }
            if (m.length() > 0 && m.length() <= 40) return m;
        }
        return e == null ? "error" : e.getClass().getSimpleName();
    }
}
