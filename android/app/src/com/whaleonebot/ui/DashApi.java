package com.whaleonebot.ui;

import android.app.Activity;
import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * 看板系列页面共用的取数通道：把「运行端控制台在哪个端口」「怎么带鉴权头」「怎么解析」
 * 这三件事收敛到一处，各子页只写 {@code DashApi.json("api/chats")} 这一句。
 *
 * <p><b>写通道只有一处</b>：{@link #post}，仅供对账页做「解锁 / 重试失败」；其余页面只读。
 *
 * <p><b>鉴权口径</b>：控制台无令牌时 {@code authorize()} 只放行「远端是回环 + {@code Host: 127.0.0.1:<port>}」，
 * 所以每个请求都显式写 Host 头（与 {@code MainActivity.requestAgentConfigReload} 同口径）。
 *
 * <p><b>线程约定</b>：所有方法都<b>同步阻塞</b>，调用方必须在后台线程里调；本类不碰任何 View。
 */
final class DashApi {

    /** 默认端口（容器里 {@code server.port} 的既定值）。 */
    private static final int DEFAULT_PORT = 41907;

    private static final class RemoteDashCacheEntry {
        final String body;
        final long fetchedAt;
        RemoteDashCacheEntry(String body, long fetchedAt) {
            this.body = body;
            this.fetchedAt = fetchedAt;
        }
    }

    private static final java.util.concurrent.ConcurrentHashMap<String, RemoteDashCacheEntry> REMOTE_CACHE =
            new java.util.concurrent.ConcurrentHashMap<String, RemoteDashCacheEntry>();
    private static final java.util.Set<String> REMOTE_IN_FLIGHT =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<String, Boolean>());

    static void clearRemoteCache() {
        REMOTE_CACHE.clear();
        REMOTE_IN_FLIGHT.clear();
    }

    private DashApi() {
    }

    /** 容器内运行端配置（App 私有目录里的那份）。 */
    static File configFile(Context c) {
        return new File(c.getFilesDir(), "rootfs/agent/data/config.json");
    }

    /** 控制台端口：读 {@code server.port}，读不到退回 41907。 */
    static int port(Context c) {
        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        if (rm != null && rm.isRemote()) return DEFAULT_PORT;
        return localPort(c);
    }

    static int localPort(Context c) {
        String text = readText(configFile(c));
        if (text == null) return DEFAULT_PORT;
        int p = ModelsScreen.U.consolePortOf(text);
        return p > 0 ? p : DEFAULT_PORT;
    }

    /**
     * GET 一个控制台接口并解析成 JSON 树。
     *
     * @return 解析好的对象树；连不上 / 非 200 / 不是 JSON 都返回 {@code null}
     */
    static Object json(Context c, String path) {
        return json(c, path, 8000);
    }

    static Object json(Context c, String path, int timeoutMs) {
        String body = text(c, path, timeoutMs);
        if (body == null) return null;
        try {
            Object v = BotConfigJson.parse(body);
            return BotConfigJson.asObject(v) == null ? null : v;
        } catch (Throwable th) {
            return null;
        }
    }

    /** GET 原始文本（JSON 原文）；失败返回 null。 */
    static String text(Context c, String path, int timeoutMs) {
        int port = port(c);
        return get(port, path, timeoutMs);
    }

    /** 指定端口的 GET（远程模式下自动经 P2P 加密隧道代理到远端回环控制台，带自适应 SWR 本地缓存实现 0ms 秒开）。 */
    static String get(int port, final String path, final int timeoutMs) {
        final com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        if (rm != null && rm.isRemote()) {
            final String peerId = rm.activePeerId();
            final String cacheKey = (peerId == null ? "" : peerId) + "|" + path;
            final RemoteDashCacheEntry hit = REMOTE_CACHE.get(cacheKey);
            final long now = System.currentTimeMillis();
            final long freshTtl = rm.isCurrentChannelFast() ? 3000L : 12_000L;
            if (hit != null && now - hit.fetchedAt < freshTtl) {
                return hit.body;
            }
            if (hit != null && now - hit.fetchedAt < 120_000L) {
                // 缓存略旧但仍可用：0ms 立即返回旧数据，同时后台静默单飞刷新
                if (REMOTE_IN_FLIGHT.add(cacheKey)) {
                    Thread t = new Thread(() -> {
                        try {
                            String body = fetchRemoteDashRaw(rm, path, timeoutMs);
                            if (body != null && peerId != null && peerId.equals(rm.activePeerId())) {
                                putRemoteCache(cacheKey, body);
                            }
                        } finally {
                            REMOTE_IN_FLIGHT.remove(cacheKey);
                        }
                    }, "dash-swr");
                    t.setDaemon(true);
                    t.start();
                }
                return hit.body;
            }
            String body = fetchRemoteDashRaw(rm, path, timeoutMs);
            if (body != null) {
                putRemoteCache(cacheKey, body);
                return body;
            }
            return hit == null ? null : hit.body;
        }
        return getLocal(port, path, timeoutMs);
    }

    private static void putRemoteCache(String key, String body) {
        if (REMOTE_CACHE.size() > 64) REMOTE_CACHE.clear();
        REMOTE_CACHE.put(key, new RemoteDashCacheEntry(body, System.currentTimeMillis()));
    }

    private static String fetchRemoteDashRaw(com.whaleonebot.remote.RemoteControlManager rm, String path, int timeoutMs) {
        try {
            org.json.JSONObject req = new org.json.JSONObject()
                    .put("path", path)
                    .put("timeoutMs", timeoutMs);
            org.json.JSONObject res = rm.callActiveRpc("dash.get", req, Math.max(8000, timeoutMs + 3000));
            return res.optBoolean("ok", false) ? res.optString("body", null) : null;
        } catch (Throwable th) {
            return null;
        }
    }

    static String getLocal(int port, String path, int timeoutMs) {
        if (port <= 0) return null;
        HttpURLConnection c = null;
        try {
            URL url = new URL("http://127.0.0.1:" + port
                    + (path.startsWith("/") ? path : "/" + path));
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setRequestProperty("Accept", "application/json");
            try {
                c.setRequestProperty("Host", "127.0.0.1:" + port);
            } catch (Throwable ignored) {
                // Host 是受保护头：个别实现会拒绝，拒了就用默认值（本来就是它）
            }
            int code = c.getResponseCode();
            if (code != 200) {
                closeQuietly(c.getErrorStream());
                return null;
            }
            return readAll(c.getInputStream());
        } catch (Throwable th) {
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

    // ---------------------------------------------------------------- 写通道（仅对账用）

    /** 一次写请求的结果：HTTP 码 + 响应正文（非 200 时正文来自 errorStream，用来显示原因）。 */
    static final class Resp {
        final int code;
        final String body;

        Resp(int code, String body) {
            this.code = code;
            this.body = body == null ? "" : body;
        }

        boolean ok() {
            return code == 200;
        }

        /** 从 {@code {"error":"..."}} 里取原因，取不到就给一句短的。 */
        String reason() {
            if (ok()) return "";
            if (body.length() > 0) {
                try {
                    Object v = BotConfigJson.parse(body);
                    String e = ModelsScreen.U.s(BotConfigJson.get(v, "error")).trim();
                    if (e.length() > 0) return e;
                } catch (Throwable ignored) {
                    // 不是 JSON：退回原始正文
                }
                return body.length() > 120 ? body.substring(0, 120) : body;
            }
            return code <= 0 ? "连不上运行端" : ("HTTP " + code);
        }
    }

    /**
     * POST 一个 JSON 到控制台（**唯一**的写入口，只给对账页用：解锁 / 重试失败）。
     *
     * <p>鉴权口径与 {@link #get} 相同（回环 + {@code Host: 127.0.0.1:<port>} 头）；
     * 非 200 也会把错因读回来，方便页面如实显示「409 需要确认」这类话。
     */
    static Resp post(int port, String path, String jsonBody, int timeoutMs) {
        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        if (rm != null && rm.isRemote()) {
            try {
                org.json.JSONObject req = new org.json.JSONObject()
                        .put("path", path)
                        .put("body", jsonBody == null ? "{}" : jsonBody)
                        .put("timeoutMs", timeoutMs);
                org.json.JSONObject res = rm.callActiveRpc("dash.post", req, Math.max(8000, timeoutMs + 3000));
                REMOTE_CACHE.clear();
                return new Resp(res.optInt("code", -1), res.optString("body", ""));
            } catch (Throwable th) {
                return new Resp(-1, String.valueOf(th.getMessage()));
            }
        }
        return postLocal(port, path, jsonBody, timeoutMs);
    }

    static Resp postLocal(int port, String path, String jsonBody, int timeoutMs) {
        if (port <= 0) return new Resp(-1, "");
        HttpURLConnection c = null;
        try {
            URL url = new URL("http://127.0.0.1:" + port
                    + (path.startsWith("/") ? path : "/" + path));
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            c.setDoOutput(true);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try {
                c.setRequestProperty("Host", "127.0.0.1:" + port);
            } catch (Throwable ignored) {
                // 受保护头，个别实现会拒绝；拒了就用默认值（本来就是它）
            }
            byte[] data = (jsonBody == null ? "{}" : jsonBody).getBytes("UTF-8");
            java.io.OutputStream out = c.getOutputStream();
            try {
                out.write(data);
                out.flush();
            } finally {
                try {
                    out.close();
                } catch (Throwable ignored) {
                    // 已写完
                }
            }
            int code = c.getResponseCode();
            if (code == 200) return new Resp(code, readAll(c.getInputStream()));
            return new Resp(code, readAll(c.getErrorStream()));
        } catch (Throwable th) {
            return new Resp(-1, String.valueOf(th.getMessage()));
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

    // ---------------------------------------------------------------- 小工具

    /** 把相对时间（毫秒时间戳）写成「3 分钟前」这类短文本。 */
    static String ago(long ms) {
        if (ms <= 0) return "—";
        long d = System.currentTimeMillis() - ms;
        if (d < 0) d = 0;
        long s = d / 1000;
        if (s < 60) return s + " 秒前";
        long m = s / 60;
        if (m < 60) return m + " 分钟前";
        long h = m / 60;
        if (h < 24) return h + " 小时前";
        return (h / 24) + " 天前";
    }

    /** 时间戳 → 本地「MM-dd HH:mm」。 */
    static String when(long ms) {
        if (ms <= 0) return "—";
        return new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US)
                .format(new java.util.Date(ms));
    }

    /** 数组字段长度（不是数组按 0 算）。 */
    static int size(Object arr) {
        java.util.List<Object> list = BotConfigJson.asArray(arr);
        return list == null ? 0 : list.size();
    }

    /**
     * 对象里某个字段的字符串值（缺省空串）。
     *
     * <p><b>顺手反转义</b>：控制台把昵称/群名当成 HTML 片段下发（网页端直接塞 innerHTML），
     * 于是手机端会看到 {@code &#128997;&#128999;} 这种数字实体 —— 这里统一解回真字符，
     * 免得每个页面各写一遍。
     */
    static String str(Object root, String path) {
        return unescape(ModelsScreen.U.s(BotConfigJson.get(root, path)).trim());
    }

    /** 解 HTML 数字/命名实体（`&#128997;` `&#x1F995;` `&amp;` `&lt;` `&gt;` `&quot;` `&#39;`）。 */
    static String unescape(String s) {
        if (s == null || s.indexOf('&') < 0) return s == null ? "" : s;
        String cur = s;
        // ★ 控制台有**双重转义**的昵称（`&amp;#128997;`）：解一次会剩下 `&#128997;` 文本，
        //   所以最多连解 3 轮，直到不再出现 `&#` / `&amp;` 为止。
        for (int round = 0; round < 3 && cur.indexOf('&') >= 0; round++) {
            String next = unescapeOnce(cur);
            if (next.equals(cur)) break;
            cur = next;
            if (cur.indexOf("&#") < 0 && cur.indexOf("&amp;") < 0) break;
        }
        return cur;
    }

    private static String unescapeOnce(String s) {
        StringBuilder out = new StringBuilder(s.length());
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != '&') {
                out.append(c);
                i++;
                continue;
            }
            int semi = s.indexOf(';', i + 1);
            if (semi < 0 || semi - i > 10) {
                out.append(c);
                i++;
                continue;
            }
            String body = s.substring(i + 1, semi);
            String rep = null;
            try {
                if (body.startsWith("#x") || body.startsWith("#X")) {
                    rep = new String(Character.toChars(Integer.parseInt(body.substring(2), 16)));
                } else if (body.startsWith("#")) {
                    rep = new String(Character.toChars(Integer.parseInt(body.substring(1), 10)));
                } else if ("amp".equals(body)) {
                    rep = "&";
                } else if ("lt".equals(body)) {
                    rep = "<";
                } else if ("gt".equals(body)) {
                    rep = ">";
                } else if ("quot".equals(body)) {
                    rep = "\"";
                } else if ("apos".equals(body) || "#39".equals(body)) {
                    rep = "'";
                } else if ("nbsp".equals(body)) {
                    rep = " ";
                }
            } catch (Throwable ignored) {
                rep = null;
            }
            if (rep == null) {
                out.append(c);
                i++;
            } else {
                out.append(rep);
                i = semi + 1;
            }
        }
        return out.toString();
    }

    /** 对象里某个字段的数字（缺省 NaN）。 */
    static double num(Object root, String path) {
        return BotConfigJson.numOf(BotConfigJson.get(root, path));
    }

    /** 对象数组 → {@code List<Map>}（元素不是对象的丢掉）。 */
    static java.util.List<Map<String, Object>> objects(Object arr) {
        java.util.ArrayList<Map<String, Object>> out = new java.util.ArrayList<Map<String, Object>>();
        java.util.List<Object> list = BotConfigJson.asArray(arr);
        if (list == null) return out;
        for (int i = 0; i < list.size(); i++) {
            Map<String, Object> m = BotConfigJson.asObject(list.get(i));
            if (m != null) out.add(m);
        }
        return out;
    }

    static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            String s = new String(out.toByteArray(), "UTF-8");
            return s.length() > 0 && s.charAt(0) == '\uFEFF' ? s.substring(1) : s;
        } catch (Throwable th) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 关不掉不影响已读到的内容
                }
            }
        }
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return null;
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > 8 * 1024 * 1024) break;
            }
            return new String(bos.toByteArray(), "UTF-8");
        } finally {
            closeQuietly(in);
        }
    }

    private static void closeQuietly(InputStream in) {
        if (in == null) return;
        try {
            in.close();
        } catch (Throwable ignored) {
            // 连接马上回收
        }
    }

    /** 供子页在自己的 {@code build()} 里取宿主（拿 filesDir / 跑 UI 线程）。 */
    static Activity activityOf(Screen screen) {
        return screen == null ? null : screen.activity;
    }
}
