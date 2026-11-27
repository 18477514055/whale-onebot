package com.whaleonebot.ui;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 一个够用就好的 JSON 树：自己写的解析 + 序列化，只服务本面板。
 *
 * <p><b>为什么不用 org.json</b>：Android 的 {@code JSONObject} 不保证键顺序，数字一律落成
 * Double/Long 再写出来 —— 把一份 144 KB 的 config.json 过一遍 {@code JSONObject}，
 * 键序可能被重排、{@code 1794058396525} 这种整数可能变成科学计数法、{@code 0.2} 可能变
 * {@code 0.2} 或 {@code 0.20000000000000001}。本面板的硬要求是「只写回改动过的字段，
 * 其余原样保留」，所以这里做了两件事：
 *
 * <ul>
 *   <li>对象一律 {@link LinkedHashMap}，<b>插入顺序即键序</b>，写回时逐字照抄；</li>
 *   <li>数字存成 {@link Num}（原始字面量），没改过的数字<b>一个字符都不变</b>。</li>
 * </ul>
 *
 * <p>输出风格与 {@code JSON.stringify(x, null, 2)} 逐字符一致（2 空格缩进、空对象 {@code {}}
 * 与空数组 {@code []} 内联、非 ASCII 不转义）。所以「解析→不改→序列化」得到的文本与原文件
 * 相同，这正是「不动的地方不要动」的验证方式。
 */
final class BotConfigJson {

    private BotConfigJson() {
    }

    /** JSON 的 null。用哨兵表示，好跟「这个键根本不存在」区分开。 */
    static final Object NULL = new Object() {
        @Override
        public String toString() {
            return "null";
        }
    };

    /** 路径查不到时的返回值。 */
    static final Object MISSING = new Object() {
        @Override
        public String toString() {
            return "<missing>";
        }
    };

    /**
     * 数字：保留原始字面量。
     *
     * <p>没改过的数字直接照抄 {@link #raw}；改过的数字由 {@link #numberText(double)} 生成，
     * 保证 {@code 0.75} 不会写成 {@code 0.75000000000000001}。
     */
    static final class Num {
        final String raw;

        Num(String raw) {
            this.raw = raw;
        }

        double asDouble() {
            try {
                return Double.parseDouble(raw);
            } catch (NumberFormatException e) {
                return 0d;
            }
        }

        long asLong() {
            return Math.round(asDouble());
        }

        @Override
        public String toString() {
            return raw;
        }
    }

    // ---------------------------------------------------------------- 类型判断

    static boolean isObject(Object v) {
        return v instanceof Map;
    }

    static boolean isArray(Object v) {
        return v instanceof List;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asObject(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    static List<Object> asArray(Object v) {
        return v instanceof List ? (List<Object>) v : null;
    }

    /** 数字或数字字符串都收，返回 double；别的返回 NaN。 */
    static double numOf(Object v) {
        if (v instanceof Num) return ((Num) v).asDouble();
        if (v instanceof Number) return ((Number) v).doubleValue();
        if (v instanceof String) {
            try {
                return Double.parseDouble(((String) v).trim());
            } catch (NumberFormatException e) {
                return Double.NaN;
            }
        }
        return Double.NaN;
    }

    // ---------------------------------------------------------------- 路径读写

    /** 按 {@code a.b.c} 取；取不到返回 {@link #MISSING}。 */
    static Object get(Object root, String path) {
        Object cur = root;
        int i = 0;
        while (true) {
            int dot = path.indexOf('.', i);
            String seg = dot < 0 ? path.substring(i) : path.substring(i, dot);
            if (!(cur instanceof Map)) return MISSING;
            Map<?, ?> m = (Map<?, ?>) cur;
            if (!m.containsKey(seg)) return MISSING;
            cur = m.get(seg);
            if (dot < 0) return cur;
            i = dot + 1;
        }
    }

    static boolean has(Object root, String path) {
        return get(root, path) != MISSING;
    }

    /** 按 {@code a.b.c} 写；中间层不存在就补一个空对象（补在末尾，不影响已有键序）。 */
    static void set(Object root, String path, Object value) {
        Map<String, Object> cur = asObject(root);
        if (cur == null) throw new IllegalArgumentException("JSON 根节点不是对象，无法写入");
        int i = 0;
        while (true) {
            int dot = path.indexOf('.', i);
            if (dot < 0) {
                cur.put(path.substring(i), value);
                return;
            }
            String seg = path.substring(i, dot);
            Map<String, Object> next = asObject(cur.get(seg));
            if (next == null) {
                next = new LinkedHashMap<String, Object>();
                cur.put(seg, next);
            }
            cur = next;
            i = dot + 1;
        }
    }

    /**
     * 安全字段判定：任何一段命中下面这些词就<b>整项不显示、不可编辑</b>。
     *
     * <p>这是面板的最后一道闸 —— 就算 schema 里误加了一条密钥字段，也到不了界面上。
     */
    static boolean isSecret(String path) {
        if (path == null || path.length() == 0) return true;
        // 非密钥白名单：路径字面含 "token" 但属于普通数值/省费策略配置，不能误吞。
        if ("tokenSaver.mode".equals(path)
                || "conversation.lifecycleRolloverInputTokens".equals(path)
                || "api.maxRunTokens".equals(path)
                || "api.contextWindowTokens".equals(path)) {
            return false;
        }
        String[] seg = path.split("\\.");
        for (int i = 0; i < seg.length; i++) {
            String k = seg[i].toLowerCase(Locale.US);
            if (k.indexOf("apikey") >= 0
                    || k.indexOf("token") >= 0
                    || k.indexOf("secret") >= 0
                    || k.indexOf("password") >= 0
                    || k.indexOf("passwd") >= 0
                    || k.indexOf("credential") >= 0
                    || k.indexOf("providerkeys") >= 0) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 深拷贝

    static Object deepCopy(Object v) {
        if (v instanceof Map) {
            LinkedHashMap<String, Object> out = new LinkedHashMap<String, Object>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                out.put(String.valueOf(e.getKey()), deepCopy(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            ArrayList<Object> out = new ArrayList<Object>();
            List<?> l = (List<?>) v;
            for (int i = 0; i < l.size(); i++) out.add(deepCopy(l.get(i)));
            return out;
        }
        // String / Boolean / Num / NULL 都不可变，直接共享
        return v;
    }

    // ---------------------------------------------------------------- 解析

    static Object parse(String text) {
        if (text == null) throw new IllegalArgumentException("配置文本是空的");
        String s = text;
        if (s.length() > 0 && s.charAt(0) == '\uFEFF') s = s.substring(1); // 去掉 BOM
        Reader r = new Reader(s);
        Object v = r.readValue();
        r.skipWs();
        if (r.i != s.length()) throw r.error("JSON 结束后还有多余内容");
        return v;
    }

    private static final class Reader {
        private final String s;
        private int i;

        Reader(String s) {
            this.s = s;
        }

        IllegalArgumentException error(String msg) {
            int line = 1;
            int col = 1;
            int end = Math.min(i, s.length());
            for (int k = 0; k < end; k++) {
                if (s.charAt(k) == '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
            }
            return new IllegalArgumentException(msg + "（第 " + line + " 行第 " + col + " 列）");
        }

        void skipWs() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    i++;
                } else {
                    break;
                }
            }
        }

        Object readValue() {
            skipWs();
            if (i >= s.length()) throw error("JSON 意外结束");
            char c = s.charAt(i);
            switch (c) {
                case '{':
                    return readObject();
                case '[':
                    return readArray();
                case '"':
                    return readString();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return NULL;
                default:
                    return readNumber();
            }
        }

        private Map<String, Object> readObject() {
            LinkedHashMap<String, Object> out = new LinkedHashMap<String, Object>();
            i++; // {
            skipWs();
            if (i < s.length() && s.charAt(i) == '}') {
                i++;
                return out;
            }
            while (true) {
                skipWs();
                if (i >= s.length() || s.charAt(i) != '"') throw error("对象的键必须是带引号的字符串");
                String key = readString();
                skipWs();
                if (i >= s.length() || s.charAt(i) != ':') throw error("键后面缺少冒号");
                i++;
                out.put(key, readValue());
                skipWs();
                if (i >= s.length()) throw error("对象没有闭合");
                char c = s.charAt(i);
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    return out;
                }
                throw error("对象里只允许出现 , 或 }");
            }
        }

        private List<Object> readArray() {
            ArrayList<Object> out = new ArrayList<Object>();
            i++; // [
            skipWs();
            if (i < s.length() && s.charAt(i) == ']') {
                i++;
                return out;
            }
            while (true) {
                out.add(readValue());
                skipWs();
                if (i >= s.length()) throw error("数组没有闭合");
                char c = s.charAt(i);
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    return out;
                }
                throw error("数组里只允许出现 , 或 ]");
            }
        }

        private String readString() {
            StringBuilder sb = new StringBuilder();
            i++; // 开头的引号
            while (true) {
                if (i >= s.length()) throw error("字符串没有闭合");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (i >= s.length()) throw error("转义不完整");
                char e = s.charAt(i++);
                switch (e) {
                    case '"':
                        sb.append('"');
                        break;
                    case '\\':
                        sb.append('\\');
                        break;
                    case '/':
                        sb.append('/');
                        break;
                    case 'b':
                        sb.append('\b');
                        break;
                    case 'f':
                        sb.append('\f');
                        break;
                    case 'n':
                        sb.append('\n');
                        break;
                    case 'r':
                        sb.append('\r');
                        break;
                    case 't':
                        sb.append('\t');
                        break;
                    case 'u':
                        if (i + 4 > s.length()) throw error("\\u 转义不完整");
                        try {
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        } catch (NumberFormatException nfe) {
                            throw error("\\u 后面不是四位十六进制");
                        }
                        i += 4;
                        break;
                    default:
                        throw error("不认识的转义 \\" + e);
                }
            }
        }

        private Object readNumber() {
            int start = i;
            if (i < s.length() && (s.charAt(i) == '-' || s.charAt(i) == '+')) i++;
            boolean digit = false;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c >= '0' && c <= '9') {
                    digit = true;
                    i++;
                } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                    i++;
                } else {
                    break;
                }
            }
            if (!digit) throw error("这里应该是一个数字");
            return new Num(s.substring(start, i));
        }

        private void expect(String word) {
            if (!s.startsWith(word, i)) throw error("这里应该是 " + word);
            i += word.length();
        }
    }

    // ---------------------------------------------------------------- 序列化

    static String write(Object v) {
        StringBuilder sb = new StringBuilder(1 << 18);
        writeValue(sb, v, 0);
        return sb.toString();
    }

    private static void indent(StringBuilder sb, int depth) {
        for (int i = 0; i < depth; i++) sb.append("  ");
    }

    private static void writeValue(StringBuilder sb, Object v, int depth) {
        if (v == null || v == NULL) {
            sb.append("null");
            return;
        }
        if (v instanceof String) {
            writeString(sb, (String) v);
            return;
        }
        if (v instanceof Boolean) {
            sb.append(((Boolean) v).booleanValue() ? "true" : "false");
            return;
        }
        if (v instanceof Num) {
            sb.append(((Num) v).raw);
            return;
        }
        if (v instanceof Number) {
            sb.append(numberText(((Number) v).doubleValue()));
            return;
        }
        if (v instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) v;
            if (m.isEmpty()) {
                sb.append("{}");
                return;
            }
            sb.append("{\n");
            int n = 0;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                indent(sb, depth + 1);
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(": ");
                writeValue(sb, e.getValue(), depth + 1);
                n++;
                if (n < m.size()) sb.append(',');
                sb.append('\n');
            }
            indent(sb, depth);
            sb.append('}');
            return;
        }
        if (v instanceof List) {
            List<?> l = (List<?>) v;
            if (l.isEmpty()) {
                sb.append("[]");
                return;
            }
            sb.append("[\n");
            for (int k = 0; k < l.size(); k++) {
                indent(sb, depth + 1);
                writeValue(sb, l.get(k), depth + 1);
                if (k + 1 < l.size()) sb.append(',');
                sb.append('\n');
            }
            indent(sb, depth);
            sb.append(']');
            return;
        }
        // 兜底：理论上到不了这里
        writeString(sb, String.valueOf(v));
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        String hex = Integer.toHexString(c);
                        sb.append("\\u");
                        for (int k = hex.length(); k < 4; k++) sb.append('0');
                        sb.append(hex);
                    } else {
                        sb.append(c);
                    }
                    break;
            }
        }
        sb.append('"');
    }

    /** 数字 → 文本：整数值不加 .0，小数用最短的十进制写法（不走科学计数法）。 */
    static String numberText(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return "0";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
        String s = Double.toString(d);
        if (s.indexOf('E') >= 0 || s.indexOf('e') >= 0) {
            s = BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
        }
        return s;
    }

    /** 显示用：最多 {@code maxDecimals} 位小数，去掉尾部多余的 0。 */
    static String pretty(double v, int maxDecimals) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "0";
        BigDecimal bd = BigDecimal.valueOf(v).setScale(maxDecimals, RoundingMode.HALF_UP);
        return bd.stripTrailingZeros().toPlainString();
    }
}
