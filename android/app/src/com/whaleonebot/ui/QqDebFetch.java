package com.whaleonebot.ui;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * App 自己把 QQ 客户端 deb 拉下来（用户 2026-11-23：「完全可以在 APP 中拉直链了……从最新的版本一路路由到前几个版本，最多三个版本」）。
 *
 * <p>为什么要有这条路：官方 {@code /qqfile/QQNTV2/} 前缀在很多网络上直接 403（第一个使用者实测：家宽/手机流量/IPv6/8 个 CDN IP 全 403，
 * 而同主机老路径 206），可官方页面下发的仍是裸链接 ⇒ 让用户自己去电脑上折腾很难成功。
 *
 * <p>策略（**不设版本白名单之后才成立**）：依次尝试
 * ① 官方元数据当前版本（{@code linuxConfig.js} → {@code armDownloadUrl.deb}）
 * ② 已知的 3.2.35 直链
 * ③ 社区历史镜像里的 3.2.32
 * 谁先回 200/206 就用谁；三个都不行就把状态码如实报给 UI（页面上本来就留着两条链接可复制）。
 *
 * <p>只做下载 + 结构校验（{@link QqDebArchive#inspect}），不做版本判断 —— 兼容性由使用者自己判断。
 */
final class QqDebFetch {

    interface Progress { void onProgress(String stage, long done, long total); }

    private static final String META = "https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js";
    private static final String KNOWN_3_2_35 =
            "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_arm64_01.deb";
    /** GitHub 直连在很多手机网络上解析不了（真机实测 "No address associated with hostname"），
     *  所以社区源先走镜像 —— 与发行物下载是同一批镜像，只是传输层。 */
    private static final String[] MIRRORS = {
            "https://ghproxy.net/", "https://ghfast.top/", "https://gh-proxy.com/"
    };
    private static final String COMMUNITY_3_2_32 =
            "https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260813-1d08f1d4/QQ_3.2.32_260812_arm64_01.deb";

    /** 结果：成功给出文件；失败给出每个候选的状态码（给界面说人话用）。 */
    static final class Result {
        File file;
        String version;      // 从文件名里能看出来的版本（如 3.2.32），拿不到就空串
        final List<String> tried = new ArrayList<>();
        String error;
    }

    private QqDebFetch() { }

    /** 候选列表：官方最新 → 已知 3.2.35 → 社区 3.2.32。官方元数据取不到就只用后两个。 */
    static List<String> candidates(Progress p) {
        List<String> out = new ArrayList<>();
        try {
            String js = getText(META, 16000);
            Matcher m = Pattern.compile("\"armDownloadUrl\"\\s*:\\s*\\{[^}]*\"deb\"\\s*:\\s*\"(https://[^\"]+\\.deb)\"").matcher(js);
            if (m.find()) out.add(m.group(1));
        } catch (Throwable e) {
            if (p != null) p.onProgress("读官方元数据失败：" + shortReason(e), -1, -1);
        }
        out.add(KNOWN_3_2_35);
        // 社区包先走镜像（手机侧 github.com 常常根本解析不了），最后才试直连。
        for (String m : MIRRORS) out.add(m + COMMUNITY_3_2_32);
        out.add(COMMUNITY_3_2_32);
        return out;
    }

    /** 下载到 dir；返回的文件已通过结构校验，可直接交给安装流程。 */
    static Result download(File dir, Progress p) {
        Result r = new Result();
        if (dir == null || !dir.isDirectory()) { r.error = "目录不可用"; return r; }
        List<String> urls = candidates(p);
        for (String url : urls) {
            String name = url.substring(url.lastIndexOf('/') + 1);
            try {
                if (p != null) p.onProgress("探测 " + name, -1, -1);
                long total = probe(url);
                if (total <= 0) { r.tried.add(name + "：拒绝"); continue; }
                File temp = File.createTempFile("qq-dl-", ".part", dir);
                if (p != null) p.onProgress("下载 " + name, 0, total);
                long got = fetch(url, temp, total, name, p);
                try (InputStream in = new BufferedInputStream(new java.io.FileInputStream(temp))) {
                    QqDebArchive.inspect(in, (n, body) -> { });
                }
                File finalFile = new File(dir, name);
                if (finalFile.exists() && !finalFile.delete()) throw new IOException("无法覆盖同名文件");
                if (!temp.renameTo(finalFile)) throw new IOException("无法重命名下载文件");
                r.file = finalFile;
                r.version = versionOf(name);
                return r;
            } catch (Throwable e) {
                r.tried.add(name + "：" + shortReason(e));
                if (p != null) p.onProgress(name + " 没成功：" + shortReason(e), -1, -1);
            }
        }
        r.error = r.tried.isEmpty() ? "没有可用的下载源" : String.join("；", r.tried);
        return r;
    }

    private static String versionOf(String name) {
        Matcher m = Pattern.compile("QQ_([0-9]+\\.[0-9]+\\.[0-9]+)_").matcher(name);
        return m.find() ? m.group(1) : "";
    }

    /** Range 探一下：能拿到 200/206 且真有字节才算可用，返回总长度（未知返回 -1 表示"可用但长度未知"）。 */
    private static long probe(String url) throws IOException {
        HttpURLConnection c = open(url);
        c.setRequestProperty("Range", "bytes=0-1023");
        int code = c.getResponseCode();
        if (code != 200 && code != 206) { c.disconnect(); throw new IOException("HTTP " + code); }
        long len = -1;
        String cr = c.getHeaderField("Content-Range");
        if (cr != null && cr.contains("/")) {
            try { len = Long.parseLong(cr.substring(cr.lastIndexOf('/') + 1).trim()); } catch (Throwable ignored) { }
        }
        if (len < 0) {
            String cl = c.getHeaderField("Content-Length");
            if (cl != null) { try { len = Long.parseLong(cl.trim()); } catch (Throwable ignored) { } }
            if (len >= 0 && code == 206) len = -1;   // 206 的 Content-Length 只是片段长度
        }
        c.disconnect();
        return len == 0 ? -1 : len;
    }

    private static long fetch(String url, File out, long expect, String name, Progress p) throws IOException {
        HttpURLConnection c = open(url);
        int code = c.getResponseCode();
        if (code != 200 && code != 206) { c.disconnect(); throw new IOException("HTTP " + code); }
        long total = expect > 0 ? expect : c.getContentLengthLong();
        long done = 0;
        byte[] buf = new byte[1 << 16];
        try (InputStream in = c.getInputStream(); FileOutputStream os = new FileOutputStream(out)) {
            int n;
            long lastReport = 0;
            while ((n = in.read(buf)) > 0) {
                os.write(buf, 0, n);
                done += n;
                if (p != null && (done - lastReport > (1 << 20) || done == total)) {
                    lastReport = done;
                    p.onProgress(name, done, total);
                }
            }
        } finally {
            c.disconnect();
        }
        if (total > 0 && done != total) throw new IOException("下完 " + done + " / " + total + " 字节");
        return done;
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) WhaleOneBot");
        c.setRequestProperty("Accept", "*/*");
        return c;
    }

    private static String getText(String url, int limit) throws IOException {
        HttpURLConnection c = open(url);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[4096];
                StringBuilder sb = new StringBuilder();
                int n;
                while ((n = in.read(buf)) > 0) {
                    sb.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                    if (sb.length() > limit) break;
                }
                return sb.toString();
            }
        } finally {
            c.disconnect();
        }
    }

    private static String shortReason(Throwable e) {
        String m = e == null ? "" : String.valueOf(e.getMessage());
        return m.length() > 60 ? m.substring(0, 60) : m;
    }
}
