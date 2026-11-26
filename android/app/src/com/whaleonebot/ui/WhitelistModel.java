package com.whaleonebot.ui;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * 纯 JVM 白名单与协议能力解析模型（不引用任何 Android 类型，供主机侧单测直接覆盖）。
 */
public final class WhitelistModel {

    public static final int KIND_GROUP = 0;
    public static final int KIND_PRIVATE = 1;
    public static final int MAX_NAME_QUERIES = 50;
    public static final int MAX_ROWS = 200;

    public static final class Chat {
        public final String id;
        public final long last;
        public final int count;
        public final String name;

        public Chat(String id, long last, int count) {
            this(id, last, count, null);
        }

        public Chat(String id, long last, int count, String name) {
            this.id = id;
            this.last = last;
            this.count = count;
            this.name = name;
        }
    }

    private WhitelistModel() {
    }

    public static String portOf(String botJson) {
        if (botJson == null) return null;
        try {
            Object root = BotConfigJson.parse(botJson);
            String p = textOf(BotConfigJson.get(root, "onebot.port")).trim();
            if (p.length() == 0) return null;
            for (int i = 0; i < p.length(); i++) {
                if (p.charAt(i) < '0' || p.charAt(i) > '9') return null;
            }
            return p;
        } catch (Throwable th) {
            return null;
        }
    }

    public static String tokenOf(String botJson) {
        if (botJson == null) return null;
        try {
            Object root = BotConfigJson.parse(botJson);
            String t = textOf(BotConfigJson.get(root, "onebot.token")).trim();
            return t.length() == 0 ? null : t;
        } catch (Throwable th) {
            return null;
        }
    }

    public static List<Chat> parse(String json, int kind) {
        if (json == null) return null;
        Object root;
        try {
            root = BotConfigJson.parse(json);
        } catch (Throwable th) {
            return null;
        }
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "data.chats"));
        if (arr == null) return null;

        String want = kind == KIND_GROUP ? "group" : "private";
        LinkedHashMap<String, Chat> uniq = new LinkedHashMap<String, Chat>();
        for (int i = 0; i < arr.size(); i++) {
            Map<String, Object> o = BotConfigJson.asObject(arr.get(i));
            if (o == null) continue;
            if (!want.equals(textOf(o.get("type")))) continue;
            String id = textOf(o.get("id")).trim();
            if (id.length() == 0) continue;
            long last = numOf(o.get("last"));
            int count = (int) numOf(o.get("count"));
            if (count < 0) count = 0;
            Chat old = uniq.get(id);
            if (old == null) {
                uniq.put(id, new Chat(id, last, count));
            } else {
                uniq.put(id, new Chat(id, Math.max(old.last, last), Math.max(old.count, count)));
            }
        }

        ArrayList<Chat> out = new ArrayList<Chat>(uniq.values());
        Collections.sort(out, new Comparator<Chat>() {
            @Override
            public int compare(Chat a, Chat b) {
                if (a.last != b.last) return a.last > b.last ? -1 : 1;
                if (a.count != b.count) return a.count > b.count ? -1 : 1;
                return a.id.compareTo(b.id);
            }
        });
        if (out.size() > MAX_ROWS) {
            return new ArrayList<Chat>(out.subList(0, MAX_ROWS));
        }
        return out;
    }

    /** 解析 {@code get_group_list} 响应（data[] 里每项含 group_id、group_name、member_count）。 */
    public static List<Chat> parseGroups(String json) {
        if (json == null) return null;
        Object root;
        try {
            root = BotConfigJson.parse(json);
        } catch (Throwable th) {
            return null;
        }
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "data"));
        if (arr == null) return null;

        LinkedHashMap<String, Chat> uniq = new LinkedHashMap<String, Chat>();
        for (int i = 0; i < arr.size(); i++) {
            Map<String, Object> o = BotConfigJson.asObject(arr.get(i));
            if (o == null) continue;
            String id = textOf(o.get("group_id")).trim();
            if (id.length() == 0) id = textOf(o.get("groupCode")).trim();
            if (!isGroupCode(id) || uniq.containsKey(id)) continue;
            String name = textOf(o.get("group_name")).trim();
            if (name.length() == 0) name = textOf(o.get("groupName")).trim();
            uniq.put(id, new Chat(id, 0L, 0, name.length() == 0 ? null : name));
        }
        ArrayList<Chat> out = new ArrayList<Chat>(uniq.values());
        if (out.size() > MAX_ROWS) out = new ArrayList<Chat>(out.subList(0, MAX_ROWS));
        return out;
    }

    public static List<Chat> parseFriends(String json) {
        if (json == null) return null;
        Object root;
        try {
            root = BotConfigJson.parse(json);
        } catch (Throwable th) {
            return null;
        }
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "data"));
        if (arr == null) return null;

        LinkedHashMap<String, Chat> uniq = new LinkedHashMap<String, Chat>();
        for (int i = 0; i < arr.size(); i++) {
            Map<String, Object> o = BotConfigJson.asObject(arr.get(i));
            if (o == null) continue;
            String id = textOf(o.get("user_id")).trim();
            if (id.length() == 0) id = textOf(o.get("uin")).trim();
            if (id.length() == 0) continue;
            String remark = textOf(o.get("remark")).trim();
            String nick = textOf(o.get("nickname")).trim();
            String name = remark.length() > 0 ? remark : nick;
            if (uniq.containsKey(id)) continue;
            uniq.put(id, new Chat(id, 0L, 0, name.length() == 0 ? null : name));
        }
        ArrayList<Chat> out = new ArrayList<Chat>(uniq.values());
        if (out.size() > MAX_ROWS) out = new ArrayList<Chat>(out.subList(0, MAX_ROWS));
        return out;
    }

    public static List<Chat> mergeSources(List<Chat> primary, List<Chat> extra) {
        if (primary == null && extra == null) return null;
        LinkedHashMap<String, Chat> byId = new LinkedHashMap<String, Chat>();
        LinkedHashMap<String, Integer> counts = new LinkedHashMap<String, Integer>();
        if (extra != null) {
            for (int i = 0; i < extra.size(); i++) counts.put(extra.get(i).id, extra.get(i).count);
        }
        if (primary != null) {
            for (int i = 0; i < primary.size(); i++) {
                Chat c = primary.get(i);
                Integer n = counts.get(c.id);
                byId.put(c.id, new Chat(c.id, c.last, n == null ? c.count : n.intValue(), c.name));
                counts.remove(c.id);
            }
        }
        if (extra != null) {
            for (int i = 0; i < extra.size(); i++) {
                Chat c = extra.get(i);
                if (byId.containsKey(c.id) || !counts.containsKey(c.id)) continue;
                byId.put(c.id, c);
                counts.remove(c.id);
            }
        }
        ArrayList<Chat> out = new ArrayList<Chat>(byId.values());
        if (out.size() > MAX_ROWS) out = new ArrayList<Chat>(out.subList(0, MAX_ROWS));
        return out;
    }

    public static String groupsRequest(List<Chat> chats) {
        StringBuilder sb = new StringBuilder("{\"action\":\"get_chat_names\",\"params\":{\"groups\":[");
        int n = 0;
        if (chats != null) {
            for (int i = 0; i < chats.size() && n < MAX_NAME_QUERIES; i++) {
                Chat item = chats.get(i);
                if (item.name != null && item.name.length() > 0) continue;
                String id = item.id;
                if (!isGroupCode(id)) continue;
                if (n > 0) sb.append(',');
                sb.append('"').append(id).append('"');
                n++;
            }
        }
        sb.append("]}}");
        return sb.toString();
    }

    public static Map<String, String> parseNames(String json) {
        if (json == null) return null;
        Object root;
        try {
            root = BotConfigJson.parse(json);
        } catch (Throwable th) {
            return null;
        }
        Map<String, Object> names = BotConfigJson.asObject(BotConfigJson.get(root, "data.names"));
        if (names == null) return null;
        LinkedHashMap<String, String> out = new LinkedHashMap<String, String>();
        for (Map.Entry<String, Object> e : names.entrySet()) {
            if (e == null) continue;
            String id = e.getKey() == null ? "" : e.getKey().trim();
            if (!isGroupCode(id)) continue;
            Object v = e.getValue();
            if (!(v instanceof String)) continue;
            String name = ((String) v).trim();
            if (name.length() == 0 || name.length() > 128) continue;
            out.put(id, name);
        }
        return out;
    }

    public static List<Chat> withNames(List<Chat> chats, Map<String, String> names) {
        if (chats == null || names == null || names.isEmpty()) return chats;
        ArrayList<Chat> out = new ArrayList<Chat>(chats.size());
        for (int i = 0; i < chats.size(); i++) {
            Chat c = chats.get(i);
            String name = names.get(c.id);
            if (name != null && name.length() > 0) {
                out.add(new Chat(c.id, c.last, c.count, name));
            } else {
                out.add(c);
            }
        }
        return out;
    }

    static LinkedHashSet<String> preselect(List<String> already) {
        LinkedHashSet<String> out = new LinkedHashSet<String>();
        if (already == null) return out;
        for (int i = 0; i < already.size(); i++) {
            String v = already.get(i) == null ? "" : already.get(i).trim();
            if (v.length() > 0) out.add(v);
        }
        return out;
    }

    static ArrayList<String> merge(List<String> existing, List<String> picked) {
        ArrayList<String> out = new ArrayList<String>();
        LinkedHashSet<String> seen = new LinkedHashSet<String>();
        if (existing != null) {
            for (int i = 0; i < existing.size(); i++) {
                String v = existing.get(i);
                out.add(v == null ? "" : v);
            }
        }
        for (int i = 0; i < out.size(); i++) {
            String v = out.get(i).trim();
            if (v.length() > 0) seen.add(v);
        }
        if (picked != null) {
            for (int i = 0; i < picked.size(); i++) {
                String v = picked.get(i) == null ? "" : picked.get(i).trim();
                if (v.length() == 0 || seen.contains(v)) continue;
                seen.add(v);
                out.add(v);
            }
        }
        return out;
    }

    /** 构造非敏感协议能力就绪度摘要（严禁回显任何 Cookie/p_skey/token 明文）。 */
    public static String formatReadinessSummary(String json) {
        if (json == null || json.trim().length() == 0) return "协议端就绪检测中";
        try {
            Object root = BotConfigJson.parse(json);
            Map<String, Object> data = BotConfigJson.asObject(BotConfigJson.get(root, "data"));
            if (data == null) return "协议端版本较旧（基础可用）";
            int count = (int) numOf(data.get("supportedCount"));
            boolean webAuth = Boolean.TRUE.equals(data.get("webAuthReady"));
            boolean qzone = Boolean.TRUE.equals(data.get("qzoneReady"));
            boolean ocr = Boolean.TRUE.equals(data.get("ocrReady"));
            boolean fileUp = Boolean.TRUE.equals(data.get("fileUploadReady"));
            ArrayList<String> ready = new ArrayList<String>();
            if (webAuth) ready.add("Web鉴权");
            if (qzone) ready.add("说说");
            if (ocr) ready.add("OCR");
            if (fileUp) ready.add("传文件");
            String tags = ready.isEmpty() ? "基础能力就绪" : joinSlash(ready) + "就绪";
            return (count > 0 ? ("可用 " + count + " 项 · ") : "") + tags;
        } catch (Throwable th) {
            return "协议端就绪检测中";
        }
    }

    private static String joinSlash(List<String> items) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append('/');
            sb.append(items.get(i));
        }
        return sb.toString();
    }

    private static boolean isGroupCode(String code) {
        if (code == null) return false;
        int n = code.length();
        if (n < 5 || n > 15) return false;
        for (int i = 0; i < n; i++) {
            char ch = code.charAt(i);
            if (ch < '0' || ch > '9') return false;
        }
        return true;
    }

    private static String textOf(Object v) {
        if (v == null || v == BotConfigJson.NULL) return "";
        if (v instanceof BotConfigJson.Num) return ((BotConfigJson.Num) v).raw;
        if (v instanceof String) return (String) v;
        return String.valueOf(v);
    }

    private static long numOf(Object v) {
        double d = BotConfigJson.numOf(v);
        if (Double.isNaN(d) || Double.isInfinite(d)) return 0L;
        return (long) d;
    }
}
