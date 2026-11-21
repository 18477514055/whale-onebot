package com.whaleonebot.ui;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Pure-Java registry codec. Bots and instances commit in a single atomic snapshot.
 * Invalid, ambiguous or newer snapshots are never repaired or overwritten implicitly. */
final class BotStore {

    static final String FILE_NAME = "bots.json";

    static final int SCHEMA_VERSION = 3;

    /** 单个文件最多读 1MB：机器人列表不该长成这样，超了就当损坏。 */
    private static final int MAX_BYTES = 1024 * 1024;

    private BotStore() {
    }

    // ================================================================ 读

    static void load(File file,List<BotRegistry.Bot> bots,Map<String,CoreInventory.Instance> cores) throws Exception {
        Object rawRoot=new Json(readText(file)).parse();CoreInventory.require(rawRoot instanceof Map);
        Map<?,?> root=(Map<?,?>)rawRoot;
        CoreInventory.require(!root.containsKey("schemaVersion") || root.get("schemaVersion") instanceof Long);
        long version=num(root.get("schemaVersion"),1L);
        CoreInventory.require(version>=1 && version<=SCHEMA_VERSION && root.get("bots") instanceof List);
        java.util.Set<String> ids=new java.util.HashSet<>();
        for(Object item:(List<?>)root.get("bots")) {
            BotRegistry.Bot bot=toBot(item,version<3);CoreInventory.require(bot!=null && ids.add(bot.id));bots.add(bot);
        }
        if(version<3){
            CoreInventory.require(!root.containsKey("coreInstances"));
            for(BotRegistry.Bot bot:bots){CoreInventory.Instance c=CoreInventory.migrated(bot);cores.put(c.id,c);}
            return;
        }
        CoreInventory.require(root.get("coreInstances") instanceof List);
        for(Object item:(List<?>)root.get("coreInstances")){
            CoreInventory.require(item instanceof Map);CoreInventory.Instance c=CoreInventory.fromRecord((Map<?,?>)item,bots);
            CoreInventory.require(cores.put(c.id,c.owned(""))==null);
        }
        for(BotRegistry.Bot bot:bots){CoreInventory.Instance c=cores.get(bot.coreInstanceId);
            CoreInventory.require(c!=null && c.ownerId.isEmpty() && c.kind.equals(bot.runtimeKind));cores.put(c.id,c.owned(bot.id));}
    }

    /** 一条 JSON 对象 → Bot。缺 id 的条目视为无效（返回 null）。 */
    private static BotRegistry.Bot toBot(Object o, boolean migrate) {
        if (!(o instanceof Map)) return null;
        Map<?, ?> m = (Map<?, ?>) o;

        String id = str(m.get("id"));
        if (id == null || !id.matches("[a-z][a-z0-9-]{0,63}")) return null;

        BotRegistry.Bot b = new BotRegistry.Bot(migrate ? "legacy-"+id.trim() : CoreInventory.str(m,"coreInstanceId"));
        b.id = id.trim();
        String name = str(m.get("name"));
        b.name = (name == null || name.trim().length() == 0) ? b.id : name.trim();
        String persona = str(m.get("persona"));
        b.persona = persona == null ? "" : persona;
        b.platforms = platforms(m.get("platforms"));

        Object rawBindings = m.get("bindings");
        if (rawBindings instanceof List) {
            b.platforms.clear();
            for (Object raw : (List<?>) rawBindings) {
                if (!(raw instanceof Map)) continue;
                Map<?,?> v = (Map<?,?>) raw;
                String key = str(v.get("id")), platform = str(v.get("platform"));
                if (key == null || platform == null) continue;
                b.bindings.add(new BotRegistry.Binding(key, platform, text(v,"accountId"),
                    "isolated".equals(v.get("memoryMode")) ? "isolated" : "shared", text(v,"httpUrl"), text(v,"wsUrl"),text(v,"peerId")));
                if (!b.platforms.contains(platform)) b.platforms.add(platform);
            }
        } else BotRegistry.syncPlatforms(b);

        // Missing in older snapshots: preserve their already configured platform policy.
        b.activePlatforms.addAll(m.containsKey("activePlatforms") ? platforms(m.get("activePlatforms")) : b.platforms);
        b.activePlatforms.retainAll(b.platforms);
        if (m.get("runtimeUi") instanceof List) for(Object item:(List<?>)m.get("runtimeUi")) {
            if (!(item instanceof Map) || b.runtimeUi.size()>=16) continue;
            Map<?,?> link=(Map<?,?>)item;
            RuntimeUiLink parsed=RuntimeUiLink.parse(text(link,"platform"),text(link,"label"),text(link,"url"));
            if(parsed!=null)b.runtimeUi.add(parsed);
        }
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

    private static String text(Map<?,?> m, String key) {
        return m.get(key) instanceof String ? (String)m.get(key) : "";
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

    static Map<?,?> readMetadata(File file) {
        try { if(!file.isFile() || file.length()>65536) return null; Object value=new Json(readText(file)).parse();return value instanceof Map?(Map<?,?>)value:null; }catch(Exception ex){return null;}
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

    /** Commit or fail: never delete or truncate the prior file on rename failure. */
    static boolean save(File file, List<BotRegistry.Bot> bots, java.util.Collection<CoreInventory.Instance> cores) {
        if (file == null) return false;

        File dir = file.getAbsoluteFile().getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) return false;

        String json = toJson(bots,cores);
        byte[] bytes;
        try {
            bytes = json.getBytes("UTF-8");
        } catch (Throwable t) {
            return false;
        }

        if(bytes.length>MAX_BYTES)return false;
        File tmp=null;
        try {
            tmp=File.createTempFile("bots-", ".tmp",dir);
            try(FileOutputStream out=new FileOutputStream(tmp)){out.write(bytes);out.getFD().sync();}
            java.nio.file.Files.move(tmp.toPath(),file.toPath(),java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch(Exception ex){return false;} finally{if(tmp!=null && tmp.exists())tmp.delete();}
    }

    private static String toJson(List<BotRegistry.Bot> bots,java.util.Collection<CoreInventory.Instance> cores) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\n");
        sb.append("  \"schemaVersion\": ").append(SCHEMA_VERSION).append(",\n");
        sb.append("  \"coreInstances\": [");boolean first=true;
        for(CoreInventory.Instance c:cores){if(!first)sb.append(',');first=false;CoreInventory.write(sb,c);}sb.append("],\n");
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
        sb.append("      \"coreInstanceId\": ").append(quote(b.coreInstanceId)).append(",\n");
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
        sb.append("      \"activePlatforms\": [");boolean firstPlatform=true;
        for(String p:b.platforms)if(b.activePlatforms.contains(p)){if(!firstPlatform)sb.append(',');sb.append(quote(p));firstPlatform=false;}
        sb.append("],\n");
        sb.append("      \"bindings\": [");
        for (int i=0; i<b.bindings.size(); i++) {
            BotRegistry.Binding v = b.bindings.get(i);
            if (i != 0) sb.append(",");
            sb.append("{\"id\":").append(quote(v.id)).append(",\"platform\":").append(quote(v.platform))
              .append(",\"enabled\":").append(b.activePlatforms.contains(v.platform))
              .append(",\"accountId\":").append(quote(v.accountId)).append(",\"memoryMode\":").append(quote(v.memoryMode))
              .append(",\"peerId\":").append(quote(v.peerId)).append(",\"httpUrl\":").append(quote(v.httpUrl)).append(",\"wsUrl\":").append(quote(v.wsUrl)).append("}");
        }
        sb.append("],\n");
        sb.append("      \"runtimeUi\": [");
        for(int i=0;i<b.runtimeUi.size();i++) { RuntimeUiLink l=b.runtimeUi.get(i);if(i>0)sb.append(",");sb.append("{\"platform\":").append(quote(l.platform)).append(",\"label\":").append(quote(l.label)).append(",\"url\":").append(quote(l.url)).append("}"); }
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
    static String quote(String s) {
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
    static final class Json {

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
                CoreInventory.require(!m.containsKey(k));
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
                    CoreInventory.require(c >= 32);
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
            CoreInventory.require(t.matches("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"));
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
