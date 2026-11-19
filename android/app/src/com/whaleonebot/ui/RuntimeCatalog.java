package com.whaleonebot.ui;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.util.Locale;

/**
 * 内置机器人运行端的清单 —— 全项目<b>唯一</b>的下载来源。
 *
 * <p><b>为什么要有这个类</b>：「内置机器人」不是装好就有的，运行端要现下（产品规格 §3 ②）。
 * 下载地址、期望字节数、sha256 必须能换，但只能在一处换 —— 就是本文件顶部那四个常量。
 * 别的地方（页面、下载器）一律只读 {@link Entry}，不许再出现第二个地址。
 *
 * <p><b>两级来源，偏好项优先</b>：
 * <ol>
 *   <li>{@link #PREFS} 里的 {@code source_url / source_bytes / source_sha256 / source_version}
 *       —— 用来把下载源临时指到测试机上的 HTTP 服务：不改代码、不重新打包就能把下载进度真跑一遍；</li>
 *   <li>本类顶部的 {@code BUILTIN_*} 常量 —— 正式仓库地址，偏好项没写时用它。</li>
 * </ol>
 * 注意：Android 的 {@link SharedPreferences} 在进程内有内存缓存，用 adb 改过 prefs 之后
 * 要<b>重启 App</b>（force-stop 再打开）才会读到新值。
 *
 * <p><b>绝不假装</b>：地址为空时 {@link Entry#hasSource()} 为假，页面显示「下载源未配置」并把按钮置灰，
 * 不产生任何假百分比。这是刻意的 —— 假进度比没有进度更糟。
 */
final class RuntimeCatalog {

    // ---------------------------------------------------------------- 偏好项（测试/临时改址）

    /** SharedPreferences 文件名。 */
    static final String PREFS = "runtime";
    /** 下载地址；支持 http:// 与 https://。 */
    static final String K_URL = "source_url";
    /** 期望字节数；没有就留空，下载器退化为只核对 Content-Length。 */
    static final String K_BYTES = "source_bytes";
    /** 期望的 sha256（64 位十六进制，可带 "sha256:" 前缀）；留空 = 不校验哈希。 */
    static final String K_SHA256 = "source_sha256";
    /** 版本号，同时是落盘目录名 runtimes/&lt;version&gt;/。 */
    static final String K_VERSION = "source_version";

    // ---------------------------------------------------------------- 正式仓库地址（★只改这里）

    /**
     * ★★★ 内置运行端的正式地址 —— 全项目唯一一处 ★★★
     *
     * <p>以后换成真仓库地址<b>只改下面这四个常量</b>，页面与下载器一行都不用动。
     * 也可以在设备上写同一组偏好项（见上面的 K_*），效果相同。
     *
     * <p>留空 = 尚未配置：下载页显示「下载源未配置」、按钮置灰，不发任何请求 ——
     * 不会去访问一个编出来的地址，也不会有假的百分比。
     */
    private static final String BUILTIN_URL = "";
    /** 期望字节数；0 = 未声明（下载时以服务器 Content-Length 为准）。 */
    private static final long BUILTIN_BYTES = 0L;
    /** 期望 sha256；空 = 不校验哈希（字节数仍然校验）。 */
    private static final String BUILTIN_SHA256 = "";
    /** 版本号，同时是落盘目录名。 */
    private static final String BUILTIN_VERSION = "1.0.0";

    /**
     * 索引地址（我们维护的那份 {@code runtime/index.json}，随主仓库一起提交）。
     *
     * <p>有它就不用为了发新运行端重发 APK：App 启动时/打开下载页时拉一次索引，缓存到
     * {@code filesDir/runtimes/runtime-index.json}，之后按索引里的最新条目下载。
     * 留空 = 不拉索引，只用上面四个常量（当前状态；仓库发布后填成 raw 地址）。
     *
     * <p>设备上可用 {@code SharedPreferences "runtime" → index_url} 临时改址（测试用）。
     */
    static final String BUILTIN_INDEX_URL =
            "https://raw.githubusercontent.com/18477514055/whale-onebot/main/runtime-index/index.json";

    private RuntimeCatalog() {
    }

    // ---------------------------------------------------------------- 查询

    /** 内置运行端清单。V1 只有一条（产品规格 §3 ② 的「内置机器人」）。 */
    static Entry[] entries(Context c) {
        return new Entry[]{resolve(c)};
    }

    /** 默认要下载的那一条。页面只用这个。 */
    static Entry latest(Context c) {
        return resolve(c);
    }

    /**
     * 偏好项优先、常量兜底。任何读取异常都退回常量 —— 清单读不出来不该让整页崩。
     */
    private static Entry resolve(Context c) {
        String version = BUILTIN_VERSION;
        String url = BUILTIN_URL;
        long bytes = BUILTIN_BYTES;
        String sha = BUILTIN_SHA256;
        boolean fromPrefs = false;
        try {
            SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String purl = readString(sp, K_URL, null);
            if (purl != null && purl.trim().length() > 0) {
                fromPrefs = true;
                url = purl.trim();
                bytes = readLong(sp, K_BYTES, 0L);
                String psha = readString(sp, K_SHA256, "");
                if (psha != null) sha = psha;
                String pver = readString(sp, K_VERSION, null);
                if (pver != null && pver.trim().length() > 0) version = pver.trim();
            }
        } catch (Throwable ignored) {
            // prefs 读不出来：退回常量，页面按「未配置」或正式地址显示
        }
        if (!fromPrefs) {
            // ② 索引缓存优先于常量：这样发新运行端不必重发 APK（见 RuntimeIndex）
            Entry idx = RuntimeIndex.cachedEntry(c);
            if (idx != null) return idx;
        }
        return new Entry(version, url, bytes, sha, fromPrefs);
    }

    /**
     * 宽容地读一个字符串形式的偏好项：adb 直接改 XML 时可能写成 &lt;long&gt;，两种都认。
     */
    private static String readString(SharedPreferences sp, String key, String def) {
        try {
            return sp.getString(key, def);
        } catch (Throwable ignored) {
            // 类型不是 String，往下试 long
        }
        try {
            long v = sp.getLong(key, Long.MIN_VALUE);
            if (v != Long.MIN_VALUE) return Long.toString(v);
        } catch (Throwable ignored) {
            // 也不是 long，交给 def
        }
        return def;
    }

    /**
     * 宽容地读一个数字形式的偏好项：可能被写成字符串（"1048576"），也认。
     */
    private static long readLong(SharedPreferences sp, String key, long def) {
        try {
            return sp.getLong(key, def);
        } catch (Throwable ignored) {
            // 类型不是 long，往下试字符串
        }
        try {
            String s = sp.getString(key, null);
            if (s != null && s.trim().length() > 0) return Long.parseLong(s.trim());
        } catch (Throwable ignored) {
            // 解析不了就用 def
        }
        return def;
    }

    // ---------------------------------------------------------------- 落盘位置

    /** 全部运行端的根目录：getFilesDir()/runtimes/。 */
    static File rootDir(Context c) {
        return new File(c.getFilesDir(), "runtimes");
    }

    /** 某个版本的目录：getFilesDir()/runtimes/&lt;version&gt;/。 */
    static File dirFor(Context c, Entry e) {
        return new File(rootDir(c), e.dirName());
    }

    /** 字节数的人类可读形式（清单与下载页共用一份实现，免得两处格式不一致）。 */
    static String formatBytes(long v) {
        if (v < 0) return "未知";
        if (v < 1024L) return v + " B";
        double kb = v / 1024.0;
        if (kb < 1024.0) return String.format(Locale.US, "%.1f KB", kb);
        double mb = kb / 1024.0;
        if (mb < 1024.0) return String.format(Locale.US, "%.1f MB", mb);
        return String.format(Locale.US, "%.2f GB", mb / 1024.0);
    }

    // ---------------------------------------------------------------- 一条清单

    /** 一个运行端版本：版本号 + 地址 + 体积 + 可选哈希。字段只读。 */
    static final class Entry {

        /** 版本号，同时决定落盘目录名。 */
        final String version;
        /** 下载地址（http/https）。空 = 未配置。 */
        final String url;
        /** 期望字节数；<= 0 表示未声明。 */
        final long bytes;
        /** 期望 sha256；空 = 不校验。 */
        final String sha256;
        /** 这条是设备上的临时偏好项给的，还是内置常量给的 —— 页面上会显示，便于核实。 */
        final boolean fromPrefs;
        /** 这条来自**索引**（{@link RuntimeIndex}）而不是本机临时指定/内置常量。 */
        final boolean fromIndex;

        Entry(String version, String url, long bytes, String sha256, boolean fromPrefs) {
            this(version, url, bytes, sha256, fromPrefs, false);
        }

        Entry(String version, String url, long bytes, String sha256, boolean fromPrefs,
              boolean fromIndex) {
            this.version = version == null || version.trim().length() == 0 ? "未命名" : version.trim();
            this.url = url == null ? "" : url.trim();
            this.bytes = bytes;
            this.sha256 = sha256 == null ? "" : sha256.trim();
            this.fromPrefs = fromPrefs;
            this.fromIndex = fromIndex;
        }

        /** 「这条清单从哪来」的一句话，页面直接显示。 */
        String sourceText() {
            if (fromPrefs) return "本机临时指定";
            if (fromIndex) return "索引";
            return "内置清单";
        }

        /** 只有真的写了 http(s) 地址才算「配好了」；空串、占位符一律视为未配置。 */
        boolean hasSource() {
            String u = url.toLowerCase(Locale.US);
            return u.startsWith("http://") || u.startsWith("https://");
        }

        /** 清单里声明了字节数（下载器会拿它做硬校验）。 */
        boolean hasBytes() {
            return bytes > 0;
        }

        /** 清单里给了合法 sha256（下载器会边下边算再比对）。 */
        boolean hasSha256() {
            return normalizeSha256(sha256).length() == 64;
        }

        /** "128.0 MB" / "体积未声明"。 */
        String sizeText() {
            return hasBytes() ? formatBytes(bytes) : "体积未声明";
        }

        /** 校验方式的短描述，给页面展示用。 */
        String verifyText() {
            String sha = normalizeSha256(sha256);
            if (sha.length() == 64) return "字节数 + sha256 " + sha.substring(0, 12) + "…";
            if (hasBytes()) return "字节数";
            return "仅核对服务器返回的长度";
        }

        /**
         * 落盘目录名：只保留安全字符，防止版本号里带了 "/" 或 ".." 把文件写到别处。
         */
        String dirName() {
            StringBuilder sb = new StringBuilder(version.length());
            for (int i = 0; i < version.length(); i++) {
                char ch = version.charAt(i);
                boolean safe = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z')
                        || (ch >= 'A' && ch <= 'Z') || ch == '.' || ch == '_' || ch == '-';
                sb.append(safe ? ch : '_');
            }
            String s = sb.toString();
            // 开头的点会让 "." / ".." 变成当前目录 / 上级目录
            while (s.length() > 0 && s.charAt(0) == '.') s = s.substring(1);
            return s.length() == 0 ? "unknown" : s;
        }

        /**
         * 归一化 sha256：去空白、转小写、去掉可选的 "sha256:" 前缀。
         * 不合法（不是 64 位十六进制）时返回空串 —— 调用方据此决定要不要校验。
         */
        static String normalizeSha256(String s) {
            if (s == null) return "";
            String v = s.trim().toLowerCase(Locale.US).replaceAll("\\s+", "");
            if (v.startsWith("sha256:")) v = v.substring(7);
            if (v.length() != 64) return "";
            for (int i = 0; i < v.length(); i++) {
                char ch = v.charAt(i);
                boolean hex = (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
                if (!hex) return "";
            }
            return v;
        }
    }
}
