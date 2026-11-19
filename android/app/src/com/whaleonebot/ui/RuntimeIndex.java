package com.whaleonebot.ui;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 内置运行端的**索引**（我们维护的那份 JSON）—— 让「发新运行端」不需要重发 APK。
 *
 * <p>契约（与仓库里的 {@code runtime/index.json} 一致）：
 * <pre>
 * {
 *   "schemaVersion": 1,
 *   "entries": [
 *     { "version": "1.0.1", "url": "https://…/runtime-1.0.1.zip",
 *       "bytes": 12345678, "sha256": "…64 位…", "minApp": 1, "notes": "" }
 *   ]
 * }
 * </pre>
 * {@code minApp} 是 {@code versionCode} 下限：比当前 App 新的条目本轮跳过（不至于下到跑不动的包）。
 *
 * <p><b>线程</b>：{@link #cachedEntry} 只读磁盘缓存，可在 UI 线程调；{@link #refresh} 会发网络请求，
 * <b>必须在后台线程</b>调，成功后缓存到 {@code filesDir/runtimes/runtime-index.json}，
 * 下次打开页面就能立刻用到新条目。
 *
 * <p><b>怎么临时改址</b>：{@code SharedPreferences "runtime"} 的 {@code index_url}（支持 http/https），
 * 用来把索引指到测试机上的本地服务；改完要重启 App 才读到（SharedPreferences 有内存缓存）。
 */
public final class RuntimeIndex {

    /** 索引地址的偏好项键（测试/临时改址用）。 */
    static final String K_INDEX_URL = "index_url";

    /** 缓存文件名，落在 {@code filesDir/runtimes/} 下。 */
    private static final String CACHE_NAME = "runtime-index.json";

    private RuntimeIndex() {
    }

    // ---------------------------------------------------------------- 读（UI 线程安全）

    /**
     * 用磁盘缓存里的索引解析出一条可用条目；没有缓存 / 缓存不合法 / 没有匹配版本时返回 {@code null}。
     *
     * <p>注意：这里<b>不</b>发网络请求 —— 页面打开就应该有内容，网不网是后台的事。
     */
    static RuntimeCatalog.Entry cachedEntry(Context c) {
        String json = readText(cacheFile(c));
        if (json == null) return null;
        return parse(json, appVersionCode(c));
    }

    /** 索引文件（缓存）位置。 */
    static File cacheFile(Context c) {
        return new File(RuntimeCatalog.rootDir(c), CACHE_NAME);
    }

    /** 当前生效的索引地址：偏好项优先，其次 {@link RuntimeCatalog#BUILTIN_INDEX_URL}。 */
    static String indexUrl(Context c) {
        try {
            SharedPreferences sp = c.getSharedPreferences(RuntimeCatalog.PREFS, Context.MODE_PRIVATE);
            String v = readString(sp, K_INDEX_URL);
            if (v != null && isHttp(v)) return v.trim();
        } catch (Throwable ignored) {
            // prefs 读不出来就退回内置常量
        }
        String builtin = RuntimeCatalog.BUILTIN_INDEX_URL;
        return isHttp(builtin) ? builtin.trim() : "";
    }

    // ---------------------------------------------------------------- 刷新（后台线程）

    /**
     * 拉一次索引并写进缓存。
     *
     * @return true = 拿到了新索引（页面可以重画）；false = 没配地址 / 网络失败 / 解析失败（缓存保持不变）
     */
    public static boolean refresh(Context c, int timeoutMs) {
        String url = indexUrl(c);
        if (url.length() == 0) return false;
        String body = httpGet(url, timeoutMs);
        if (body == null) return false;
        // 只有解析得出条目才覆盖缓存 —— 一个坏索引不该把能用的旧缓存清掉
        if (parse(body, appVersionCode(c)) == null) return false;
        File f = cacheFile(c);
        File dir = f.getParentFile();
        try {
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
            File tmp = new File(dir, f.getName() + ".next");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(body.getBytes("UTF-8"));
                out.getFD().sync();
            }
            if (!tmp.renameTo(f)) {
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(body.getBytes("UTF-8"));
                }
                tmp.delete();
            }
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    // ---------------------------------------------------------------- 解析

    /**
     * 从索引 JSON 里挑一条：先按 {@code minApp <= appVersionCode} 过滤，再挑版本号最大的。
     *
     * <p>版本号比较按「数字段逐个比」的朴素语义（1.0.10 &gt; 1.0.9）。比不出来（含非数字）时
     * 退回「取最后一条合法条目」，至少有得下，不至于因为一个畸形版本号就整页不可用。
     */
    static RuntimeCatalog.Entry parse(String json, int appVersionCode) {
        RuntimeIndexLogic.Item it = RuntimeIndexLogic.select(json, appVersionCode);
        if (it == null) return null;
        return new RuntimeCatalog.Entry(it.version, it.url, it.bytes, it.sha256, false, true);
    }

    // ---------------------------------------------------------------- 小工具

    private static boolean isHttp(String url) {
        if (url == null) return false;
        String u = url.trim().toLowerCase(Locale.US);
        return u.startsWith("http://") || u.startsWith("https://");
    }

    private static String str(Map<String, Object> m, String key) {
        Object v = m == null ? null : m.get(key);
        if (v == null || BotConfigJson.isObject(v) || BotConfigJson.isArray(v)) return "";
        return String.valueOf(v).trim();
    }

    /** 当前 App 的 versionCode；读不到返回 0（= 不做 minApp 过滤）。 */
    static int appVersionCode(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionCode;
        } catch (Throwable t) {
            return 0;
        }
    }

    private static String readString(SharedPreferences sp, String key) {
        try {
            return sp.getString(key, null);
        } catch (Throwable ignored) {
            // 类型不是 String：当作没配
        }
        return null;
    }

    private static String httpGet(String url, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setRequestProperty("Accept", "application/json");
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > 1024 * 1024) break; // 索引不该有 1MB
                }
                return new String(out.toByteArray(), "UTF-8");
            } finally {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 读完就关
                }
            }
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                    // 连接马上回收
                }
            }
        }
    }

    private static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 1024 * 1024) break;
            }
            return new String(out.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }
}
