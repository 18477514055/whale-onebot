package com.whaleonebot.ui;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 索引的**纯逻辑**：解析 + 挑一条。刻意不 import 任何 Android 类型 —— 这样它能在 PC 上
 * 用 `javac`/`java` 直接跑断言（`RuntimeIndex` 只负责网络与缓存）。
 *
 * <p>挑条目的规则（`docs/runtime-index.md` 有同样的表述）：
 * <ol>
 *   <li>丢掉 `url` 不是 http(s) 或 `version` 为空的条目；</li>
 *   <li>丢掉 `minApp > appVersionCode` 的条目（比当前 App 新的那一版可能跑不动）；</li>
 *   <li>剩下的里取**版本号最大**的一条；</li>
 *   <li>一个合格条目都没有 ⇒ 返回 {@code null}（调用方据此退回内置常量）。</li>
 * </ol>
 */
final class RuntimeIndexLogic {

    /** 解析出来的一条（`RuntimeIndex` 再包成 `RuntimeCatalog.Entry`）。 */
    static final class Item {
        final String version;
        final String url;
        final long bytes;
        final String sha256;

        Item(String version, String url, long bytes, String sha256) {
            this.version = version == null ? "" : version.trim();
            this.url = url == null ? "" : url.trim();
            this.bytes = bytes;
            this.sha256 = sha256 == null ? "" : sha256.trim();
        }
    }

    private RuntimeIndexLogic() {
    }

    /** 解析索引 JSON 并挑一条；没有任何合格条目返回 null。 */
    static Item select(String json, int appVersionCode) {
        if (json == null || json.length() == 0) return null;
        Object root;
        try {
            root = BotConfigJson.parse(json);
        } catch (Throwable t) {
            return null;
        }
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "entries"));
        if (arr == null || arr.isEmpty()) return null;

        List<Item> ok = new ArrayList<Item>();
        for (int i = 0; i < arr.size(); i++) {
            Map<String, Object> m = BotConfigJson.asObject(arr.get(i));
            if (m == null) continue;
            String url = str(m, "url");
            if (!isHttp(url)) continue;
            String version = str(m, "version");
            if (version.length() == 0) continue;
            double minApp = BotConfigJson.numOf(BotConfigJson.get(m, "minApp"));
            if (!Double.isNaN(minApp) && appVersionCode > 0 && minApp > appVersionCode) continue;
            long bytes = (long) BotConfigJson.numOf(BotConfigJson.get(m, "bytes"));
            ok.add(new Item(version, url, bytes, str(m, "sha256")));
        }
        if (ok.isEmpty()) return null;

        Item best = ok.get(ok.size() - 1);
        for (int i = 0; i < ok.size(); i++) {
            if (compareVersion(ok.get(i).version, best.version) > 0) best = ok.get(i);
        }
        return best;
    }

    /** 朴素版本比较：按点分段比数字；段数不同时缺的按 0 算。返回 &gt;0 表示 a 更新。 */
    static int compareVersion(String a, String b) {
        String[] pa = String.valueOf(a == null ? "" : a).trim().split("[.\\-+_ ]");
        String[] pb = String.valueOf(b == null ? "" : b).trim().split("[.\\-+_ ]");
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            long va = i < pa.length ? numPrefix(pa[i]) : 0L;
            long vb = i < pb.length ? numPrefix(pb[i]) : 0L;
            if (va != vb) return va > vb ? 1 : -1;
        }
        return 0;
    }

    private static long numPrefix(String s) {
        long v = 0;
        int i = 0;
        while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') {
            v = v * 10 + (s.charAt(i) - '0');
            i++;
            if (v > 1000000000L) break;
        }
        return v;
    }

    static boolean isHttp(String url) {
        if (url == null) return false;
        String u = url.trim().toLowerCase(Locale.US);
        return u.startsWith("http://") || u.startsWith("https://");
    }

    private static String str(Map<String, Object> m, String key) {
        Object v = m == null ? null : m.get(key);
        if (v == null || BotConfigJson.isObject(v) || BotConfigJson.isArray(v)) return "";
        return String.valueOf(v).trim();
    }
}
