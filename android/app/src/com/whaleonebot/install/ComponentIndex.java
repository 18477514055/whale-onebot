package com.whaleonebot.install;

import com.whaleonebot.ui.InstallerJson;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * [layer: shell-android] v2 索引（按部件）的读取器。刻意**不 import Android**，这样它能进纯逻辑测试。
 *
 * <p>为什么要它：P14 之后每个内置部件有独立版本号，{@code release-index.json} 的 {@code components{}}
 * 才是真相；但**已装的旧 App 只认 {@code releases[]}**，所以这里同时支持两种形状 ——
 * v2 读 {@code components}，没有该字段时退回 v1 的 {@code releases[].environment}。
 *
 * <p>只解析、不下载、不落盘：下载在 {@link ComponentFetcher}，落盘位置由调用方决定。
 */
public final class ComponentIndex {

  /** 部件分组。顺序 = 界面上的展示顺序。 */
  public static final String GROUP_ENVIRONMENT = "environment";
  public static final String GROUP_CORE = "core";
  public static final String GROUP_PLUGIN = "plugin";
  public static final String GROUP_BACKEND = "backend";
  public static final String GROUP_DESKTOP = "desktop-protocol";

  public static final class Entry {
    public final String group;
    public final String id; // plugin/backend 才有；environment/core/desktop-protocol 为空串
    public final String version;
    public final String file;
    public final String url; // 空串 = 尚未发布，没有下载地址
    public final String sha256;
    public final long bytes;

    Entry(String group, String id, String version, String file, String url, String sha256, long bytes) {
      this.group = group;
      this.id = id;
      this.version = version;
      this.file = file;
      this.url = url;
      this.sha256 = sha256;
      this.bytes = bytes;
    }

    /** 界面上用的短名，例如「平台后端 · QQ」。 */
    public String title() {
      if (GROUP_ENVIRONMENT.equals(group)) return "运行环境";
      if (GROUP_CORE.equals(group)) return "内置核心";
      if (GROUP_PLUGIN.equals(group)) return "平台插件 · " + id;
      if (GROUP_BACKEND.equals(group)) return "平台后端 · " + id;
      if (GROUP_DESKTOP.equals(group)) return "桌面协议端";
      return group;
    }

    public boolean published() {
      return url != null && url.length() > 0;
    }
  }

  private final List<Entry> entries;
  private final int schemaVersion;

  private ComponentIndex(List<Entry> entries, int schemaVersion) {
    this.entries = Collections.unmodifiableList(entries);
    this.schemaVersion = schemaVersion;
  }

  public int schemaVersion() {
    return schemaVersion;
  }

  public List<Entry> all() {
    return entries;
  }

  public List<Entry> group(String group) {
    List<Entry> out = new ArrayList<Entry>();
    for (Entry e : entries) if (e.group.equals(group)) out.add(e);
    return out;
  }

  /** 取某组（+可选 id）的最新版本；指定 version 时精确取。找不到返回 null。 */
  public Entry pick(String group, String id, String version) {
    Entry best = null;
    for (Entry e : entries) {
      if (!e.group.equals(group)) continue;
      if (id != null && id.length() > 0 && !id.equals(e.id)) continue;
      if (version != null && version.length() > 0) {
        if (version.equals(e.version)) return e;
        continue;
      }
      if (best == null || compare(e.version, best.version) > 0) best = e;
    }
    return best;
  }

  public static ComponentIndex of(byte[] raw) throws IOException {
    return of(new String(raw, StandardCharsets.UTF_8));
  }

  public static ComponentIndex of(String text) throws IOException {
    Object tree = InstallerJson.parse(text);
    Map<String, Object> root = obj(tree);
    int schema = (int) num(root, "schemaVersion", 0);
    List<Entry> out = new ArrayList<Entry>();
    Object componentsRaw = root.get("components");
    boolean v2 = schema >= 2 && componentsRaw instanceof Map;
    if (v2) {
      Map<String, Object> c = obj(componentsRaw);
      addAll(out, GROUP_ENVIRONMENT, "", listOf(c, "environment"));
      addAll(out, GROUP_CORE, "", listOf(c, "core"));
      Object plugins = c.get("plugins");
      if (plugins instanceof Map) {
        Map<String, Object> p = obj(plugins);
        for (String id : p.keySet()) addAll(out, GROUP_PLUGIN, id, listOf(p, id));
      }
      Object backends = c.get("backends");
      if (backends instanceof Map) {
        Map<String, Object> b = obj(backends);
        for (String id : b.keySet()) addAll(out, GROUP_BACKEND, id, listOf(b, id));
      }
      addAll(out, GROUP_DESKTOP, "", listOf(c, "desktopProtocol"));
    } else {
      // v1 兼容：只有 releases[].environment 能被认出带部件，其余仍在 catalog 里，不在这里编造
      List<?> releases = listOf(root, "releases");
      for (Object row : releases) {
        Map<String, Object> r = obj(row);
        Object env = r.get("environment");
        if (env instanceof Map) addAll(out, GROUP_ENVIRONMENT, "", Collections.singletonList(env));
      }
    }
    return new ComponentIndex(out, schema);
  }

  private static void addAll(List<Entry> out, String group, String id, List<?> rows) throws IOException {
    for (Object row : rows) {
      Map<String, Object> m = obj(row);
      String version = str(m, "version");
      if (version == null || version.length() == 0) continue;
      String sha = str(m, "sha256");
      if (sha == null || !sha.matches("[0-9a-f]{64}")) continue;
      out.add(new Entry(group, id, version, nz(str(m, "file")), nz(str(m, "url")), sha, (long) num(m, "bytes", -1)));
    }
  }

  /**
   * 版本比较：`1.2.0` &gt; `1.2.0-beta.1` &gt; `1.1.8`。
   * 段内按数字比，带预发布后缀的一律小于不带后缀的；后缀按字符比（beta.1 &lt; beta.2）。
   */
  public static int compare(String a, String b) {
    if (a == null) return b == null ? 0 : -1;
    if (b == null) return 1;
    String[] sa = a.split("-", 2), sb = b.split("-", 2);
    int c = compareNumeric(sa[0], sb[0]);
    if (c != 0) return c;
    boolean pa = sa.length > 1, pb = sb.length > 1;
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    if (!pa) return 0;
    return sa[1].compareTo(sb[1]);
  }

  private static int compareNumeric(String a, String b) {
    String[] x = a.split("\\."), y = b.split("\\.");
    int n = Math.max(x.length, y.length);
    for (int i = 0; i < n; i++) {
      long xi = i < x.length ? parseLong(x[i]) : 0L;
      long yi = i < y.length ? parseLong(y[i]) : 0L;
      if (xi != yi) return xi < yi ? -1 : 1;
    }
    return 0;
  }

  private static long parseLong(String s) {
    try {
      return Long.parseLong(s.trim());
    } catch (RuntimeException e) {
      return 0L;
    }
  }

  private static String nz(String s) {
    return s == null ? "" : s;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> obj(Object o) throws IOException {
    if (!(o instanceof Map)) throw new IOException("不是对象");
    return (Map<String, Object>) o;
  }

  private static List<?> listOf(Map<String, Object> m, String key) {
    Object v = m.get(key);
    return v instanceof List ? (List<?>) v : new ArrayList<Object>();
  }

  private static String str(Map<String, Object> m, String key) {
    Object v = m.get(key);
    return v instanceof String ? (String) v : null;
  }

  private static double num(Map<String, Object> m, String key, double fallback) {
    Object v = m.get(key);
    if (v == null) return fallback;
    // InstallerJson 的数字不一定是 java.lang.Number（它保留原始文本），所以按字符串解析，
    // 与 InstallFiles.num 同一套口径。
    try {
      return Double.parseDouble(String.valueOf(v).trim());
    } catch (RuntimeException ex) {
      return fallback;
    }
  }

  /** 界面上按组汇总用；保证顺序稳定。 */
  public Map<String, List<Entry>> byGroup() {
    Map<String, List<Entry>> out = new LinkedHashMap<String, List<Entry>>();
    for (String g : new String[] {GROUP_ENVIRONMENT, GROUP_CORE, GROUP_PLUGIN, GROUP_BACKEND, GROUP_DESKTOP}) {
      List<Entry> list = group(g);
      if (!list.isEmpty()) out.put(g, list);
    }
    return out;
  }

  /**
   * 默认版本解析（纯逻辑，刻意不 import Android，便于进纯逻辑测试）。
   *
   * <p>为什么要它：v2 索引的 {@code current} 历史上有两种写法 —— 早期各版与核心同号，后来被写成 App 版本号。
   * 一律优先用「声明值」；只有当它<b>不在</b>可用版本里时，才回退到 {@code components.core[]} 的第一条
   * （最新核心），再退到可用版本的第一条。v1 索引语义不变：声明值缺失即视为坏索引。
   */
  public static String defaultRelease(
      String declared, java.util.Collection<String> available, List<String> coreOrder)
      throws IOException {
    String want = declared == null ? "" : declared.trim();
    boolean v2 = coreOrder != null && !coreOrder.isEmpty();
    if (!want.isEmpty() && available != null && available.contains(want)) return want;
    if (v2) {
      for (String v : coreOrder) {
        if (v != null && available != null && available.contains(v)) return v;
      }
      if (available != null) {
        for (String v : available) {
          if (v != null && !v.isEmpty()) return v;
        }
      }
    }
    throw new IOException("Unknown default release");
  }
}
