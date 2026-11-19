package com.whaleonebot.ui;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code bots.json} 的读写 —— 机器人注册表的持久层。
 *
 * <p><b>为什么手写 JSON 而不引库</b>：本工程没有 Gradle、没有依赖管理，连 org.json 之外的
 * 东西都拿不到；而 schema 只有一层，手写一个几百行的读写器反而最好控制
 * （键序稳定、数字字面量原样、中文不转义成 \\uXXXX）。
 *
 * <p><b>原子写</b>：先写 {@code bots.json.tmp}、{@code fd.sync()}，再 rename 覆盖
 * —— 中途断电 / 进程被杀时，要么是旧文件、要么是新文件，不会出现半截 JSON。
 *
 * <p><b>读失败不崩</b>：任何异常（文件缺失、IO、JSON 语法错、字段类型不对）
 * 都返回 {@code null}，由 {@link BotRegistry#init(File)} 决定回退策略，
 * 本类<b>从不</b>向外抛异常、也从不打印凭据类内容。
 *
 * <p>本类同样<b>不依赖 Android</b>（没有 import android.*），可以在桌面 JVM 上直接测。
 */
final class BotStore {

    static final String FILE_NAME = "bots.json";

    /** 文件格式版本。字段只增不改；读到未来的版本也能尽力读。 */
    static final int SCHEMA_VERSION = 1;

    /** 单个文件最多读 1MB：机器人列表不该长成这样，超了就当损坏。 */
    private static final int MAX_BYTES = 1024 * 1024;

    private BotStore() {
    }

    // ================================================================ 读

    /**
     * 读文件。
     *
     * @return 机器人列表（可能是空列表 = 文件有效但用户把机器人删光了）；
     *         {@code null} = 文件不存在 / 读不出 / JSON 坏了（调用方回退默认机器人）
     */
    static List<BotRegistry.Bot> load(File file) {
        if (file == null || !file.isFile()) return null;

        String text;
        try {
            text = readText(file);
        } catch (Throwable t) {
            return null;
        }

        Object root;
        try {
            root = new Json(text).parse();
        } catch (Throwable t) {
            return null;
        }
        if (!(root instanceof Map)) return null;

        Object raw = ((Map<?, ?>) root).get("bots");
        if (!(raw instanceof List)) return null;

        List<?> arr = (List<?>) raw;
        List<BotRegistry.Bot> out = new ArrayList<BotRegistry.Bot>();
        for (int i = 0; i < arr.size(); i++) {
            BotRegistry.Bot b = toBot(arr.get(i));
            if (b != null) out.add(b); // 单条目坏了就跳过这一条，不牵连整个文件
        }
        // 空的 bots 数组 = 用户真的把机器人删光了（合法的空态，要保留）；
        // 但「数组非空、却一条都读不出来」= 文件内容坏了，按解析失败处理（回退默认机器人）。
        if (out.isEmpty() && !arr.isEmpty()) return null;
        return out;
    }

    /** 一条 JSON 对象 → Bot。缺 id 的条目视为无效（返回 null）。 */
    private static BotRegistry.Bot toBot(Object o) {
        if (!(o instanceof Map)) return null;
        Map<?, ?> m = (Map<?, ?>) o;

        String id = str(m.get("id"));
        if (id == null || id.trim().length() == 0) return null;

        BotRegistry.Bot b = new BotRegistry.Bot();
        b.id = id.trim();
        String name = str(m.get("name"));
        b.name = (name == null || name.trim().length() == 0) ? b.id : name.trim();
        String persona = str(m.get("persona"));
        b.persona = persona == null ? "" : persona;
        b.platforms = platforms(m.get("platforms"));

        String kind = str(m.get("runtimeKind"));
        b.runtimeKind = BotRegistry.KIND_CUSTOM.equals(kind)
                ? BotRegistry.KIND_CUSTOM : BotRegistry.KIND_BUILTIN;
        String ref = str(m.get("runtimeRef"));
        b.runtimeRef = ref == null ? "" : ref;
        b.enabled = bool(m.get("enabled"), true);
        b.createdAt = num(m.get("createdAt"), 0L);
        b.updatedAt = num(m.get("updatedAt"), b.createdAt);
        return b;
    }

    private static List<String> platforms(Object o) {
        List<String> out = new ArrayList<String>();
        if (!(o instanceof List)) return out;
        List<?> arr = (List<?>) o;
        for (int i = 0; i < arr.size(); i++) {
            Object v = arr.get(i);
            if (!(v instanceof String)) continue;
            String p = (String) v;
            if (p.length() == 0 || out.contains(p)) continue;
            // 不认识的平台 id 也保留：可能是更高版本写的，丢掉就是数据丢失
            out.add(p);
        }
        return out;
    }

    private static String str(Object o) {
        return o instanceof String ? (String) o : null;
    }

    private static boolean bool(Object o, boolean def) {
        if (o instanceof Boolean) return ((Boolean) o).booleanValue();
        if (o instanceof String) return "true".equalsIgnoreCase((String) o);
        return def;
    }

    private static long num(Object o, long def) {
        if (o instanceof Long) return ((Long) o).longValue();
        if (o instanceof Double) return (long) ((Double) o).doubleValue();
        if (o instanceof String) {
            try {
                return Long.parseLong(((String) o).trim());
            } catch (NumberFormatException e) {
                return def;
            }
        }
        return def;
    }

    private static String readText(File file) throws Exception {
        FileInputStream in = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) throw new IllegalStateException("文件过大");
            }
            String s = new String(out.toByteArray(), "UTF-8");
            // 去掉 BOM：带着它会让我们自己的 JSON 解析器在第一字节就失败
            if (s.length() > 0 && s.charAt(0) == '\uFEFF') s = s.substring(1);
            return s;
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
                // 关不掉也不影响已读到的内容
            }
        }
    }

    // ================================================================ 写

    /**
     * 原子写文件。返回 false 表示没写成（调用方只用它判断，不据此报错给用户）。
     *
     * <p>顺序：建目录 → 序列化 → 写 .tmp → sync → rename；rename 失败再兜底
     * （先删目标再 rename，最后直接覆盖写），保证「要么旧、要么新」。
     */
    static boolean save(File file, List<BotRegistry.Bot> bots) {
        if (file == null) return false;

        File dir = file.getAbsoluteFile().getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return false;

        String json = toJson(bots);
        byte[] bytes;
        try {
            bytes = json.getBytes("UTF-8");
        } catch (Throwable t) {
            return false;
        }

        File tmp = new File(file.getAbsolutePath() + ".tmp");
        try {
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(bytes);
                out.flush();
                try {
                    out.getFD().sync(); // 先落盘再 rename，断电也不会留下半截文件
                } catch (Throwable ignored) {
                    // 某些文件系统不支持 sync，忽略即可（内容已经写进去了）
                }
            } finally {
                try {
                    out.close();
                } catch (Throwable ignored) {
                }
            }

            if (tmp.renameTo(file)) return true;

            // rename 到已存在的文件在部分平台上会失败：删掉目标再试一次
            if (file.isFile() && file.delete() && tmp.renameTo(file)) return true;

            // 最后的兜底：直接覆盖写（不再是原子的，但至少把数据写进去）
            FileOutputStream out2 = new FileOutputStream(file);
            try {
                out2.write(bytes);
                out2.flush();
            } finally {
                try {
                    out2.close();
                } catch (Throwable ignored) {
                }
            }
            tmp.delete();
            return true;
        } catch (Throwable t) {
            tmp.delete();
            return false;
        }
    }

    private static String toJson(List<BotRegistry.Bot> bots) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\n");
        sb.append("  \"schemaVersion\": ").append(SCHEMA_VERSION).append(",\n");
        sb.append("  \"bots\": [");

        int written = 0;
        if (bots != null) {
            for (int i = 0; i < bots.size(); i++) {
                BotRegistry.Bot b = bots.get(i);
                if (b == null || b.id == null) continue;
                sb.append(written == 0 ? "\n" : ",\n");
                writeBot(sb, b);
                written++;
            }
        }
        sb.append(written == 0 ? "]\n" : "\n  ]\n");
        sb.append("}\n");
        return sb.toString();
    }

    private static void writeBot(StringBuilder sb, BotRegistry.Bot b) {
        sb.append("    {\n");
        sb.append("      \"id\": ").append(quote(b.id)).append(",\n");
        sb.append("      \"name\": ").append(quote(b.name == null ? "" : b.name)).append(",\n");
        sb.append("      \"persona\": ").append(quote(b.persona == null ? "" : b.persona)).append(",\n");
        sb.append("      \"platforms\": [");
        List<String> ps = b.platforms;
        if (ps != null) {
            for (int i = 0; i < ps.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(quote(ps.get(i)));
            }
        }
        sb.append("],\n");
        sb.append("      \"runtimeKind\": ").append(quote(b.runtimeKind == null
                ? BotRegistry.KIND_BUILTIN : b.runtimeKind)).append(",\n");
        sb.append("      \"runtimeRef\": ").append(quote(b.runtimeRef == null ? "" : b.runtimeRef)).append(",\n");
        sb.append("      \"enabled\": ").append(b.enabled).append(",\n");
        sb.append("      \"createdAt\": ").append(b.createdAt).append(",\n");
        sb.append("      \"updatedAt\": ").append(b.updatedAt).append("\n");
        sb.append("    }");
    }

    /** JSON 字符串字面量：转义引号 / 反斜杠 / 控制字符；中文原样输出（JSON 合法且人类可读）。 */
    private static String quote(String s) {
        StringBuilder sb = new StringBuilder(s == null ? 2 : s.length() + 2);
        sb.append('"');
        for (int i = 0; i < (s == null ? 0 : s.length()); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
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
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", Integer.valueOf(c)));
                    } else {
                        sb.append(c);
                    }
                    break;
            }
        }
        sb.append('"');
        return sb.toString();
    }

    // ================================================================ 极简 JSON 解析

    /**
     * 只解析 JSON 的那点语法（对象 / 数组 / 字符串 / 数字 / true / false / null）。
     * 任何语法问题都抛 RuntimeException，由 {@link #load(File)} 统一吞掉。
     */
    private static final class Json {

        /** 嵌套深度上限：防止畸形文件用几千层括号把栈撑爆。 */
        private static final int MAX_DEPTH = 64;

        private final String s;
        private int i;
        private int depth;

        Json(String s) {
            this.s = s == null ? "" : s;
        }

        Object parse() {
            Object v = value();
            ws();
            if (i < s.length()) throw new IllegalArgumentException("末尾有多余内容 @" + i);
            return v;
        }

        private Object value() {
            ws();
            char c = peek();
            switch (c) {
                case '{':
                    return object();
                case '[':
                    return array();
                case '"':
                    return string();
                case 't':
                    literal("true");
                    return Boolean.TRUE;
                case 'f':
                    literal("false");
                    return Boolean.FALSE;
                case 'n':
                    literal("null");
                    return null;
                default:
                    return number();
            }
        }

        private Map<String, Object> object() {
            enter();
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            i++; // '{'
            ws();
            if (peek() == '}') {
                i++;
                leave();
                return m;
            }
            while (true) {
                ws();
                if (peek() != '"') throw new IllegalArgumentException("键必须是字符串 @" + i);
                String k = string();
                ws();
                if (peek() != ':') throw new IllegalArgumentException("缺少冒号 @" + i);
                i++;
                m.put(k, value());
                ws();
                char c = peek();
                i++;
                if (c == '}') {
                    leave();
                    return m;
                }
                if (c != ',') throw new IllegalArgumentException("缺少逗号 @" + i);
            }
        }

        private List<Object> array() {
            enter();
            List<Object> l = new ArrayList<Object>();
            i++; // '['
            ws();
            if (peek() == ']') {
                i++;
                leave();
                return l;
            }
            while (true) {
                l.add(value());
                ws();
                char c = peek();
                i++;
                if (c == ']') {
                    leave();
                    return l;
                }
                if (c != ',') throw new IllegalArgumentException("缺少逗号 @" + i);
            }
        }

        private String string() {
            i++; // 开头的引号
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw new IllegalArgumentException("字符串没有闭合");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                if (i >= s.length()) throw new IllegalArgumentException("转义没有闭合");
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
                        if (i + 4 > s.length()) throw new IllegalArgumentException("\\u 不完整");
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default:
                        throw new IllegalArgumentException("未知转义 \\" + e);
                }
            }
        }

        private Object number() {
            int start = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == '-' || c == '+' || c == '.' || (c >= '0' && c <= '9')
                        || c == 'e' || c == 'E') {
                    i++;
                } else {
                    break;
                }
            }
            if (i == start) throw new IllegalArgumentException("无法解析的值 @" + start);
            String t = s.substring(start, i);
            if (t.indexOf('.') >= 0 || t.indexOf('e') >= 0 || t.indexOf('E') >= 0) {
                return Double.valueOf(t);
            }
            return Long.valueOf(t);
        }

        private void literal(String lit) {
            if (!s.startsWith(lit, i)) throw new IllegalArgumentException("期望 " + lit + " @" + i);
            i += lit.length();
        }

        private char peek() {
            if (i >= s.length()) throw new IllegalArgumentException("意外的结尾");
            return s.charAt(i);
        }

        private void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    i++;
                } else {
                    return;
                }
            }
        }

        private void enter() {
            if (++depth > MAX_DEPTH) throw new IllegalArgumentException("嵌套过深");
        }

        private void leave() {
            depth--;
        }
    }
}
