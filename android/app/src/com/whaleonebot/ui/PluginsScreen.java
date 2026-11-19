package com.whaleonebot.ui;

import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板 ·「插件」：三个面 —— 已装（{@code api/plugins}）/ 目录（{@code api/plugins/index}）/
 * 待处理（{@code api/plugins/pending-count} + {@code api/plugins/pending}）。
 *
 * <p><b>纯只读</b>：本页不发任何写请求，安装 / 卸载 / 启停 / 重载全部不做。
 *
 * <p><b>实测形状</b>（2026-11-19 本机 127.0.0.1:41907，GET 只读）：
 * <ul>
 *   <li>{@code /api/plugins} → {@code {isolation, enabled, requireIsolation, plugins[6], indexUrl,
 *       indexUrls, lazy, idleMinutes, publishers, revoked}}；单条键
 *       {@code id, installed, enabled, revoked, lazy, backups, install, manifest, error, status}。
 *       ★ <b>中文名只在 {@code manifest.name}</b>，{@code status} 是嵌套对象（{@code status.state}=idle），
 *       {@code description} 也只在 {@code manifest} 里 —— 所以标题 / 详情各多看一层。
 *   <li>{@code /api/plugins/index} → {@code {ok, plugins[17], skipped, sources}}；单条键
 *       {@code id, name, version, description, author, tags[], compatible, reason, ...}。
 *       ★ 冷启动要现拉远端索引（实测 >25s 才回来），热了 5.1s。
 *   <li>{@code /api/plugins/pending-count} → {@code {ok, count}}（21 字节）。
 *   <li>{@code /api/plugins/pending} → {@code {ok, pending[]}}；单条键
 *       {@code id, pluginId, pluginName, action, label, target, preview, previewLength,
 *       createdAt, expiresAt, notify}。
 * </ul>
 *
 * <p><b>「找数组」兜底</b>：结构不认识时按 {@link #ARRAY_KEYS} 的顺序试第一个是数组的字段，
 * 本层没有就退一层嵌套；对不上只是少行，不崩。
 */
final class PluginsScreen extends Screen {

    private static final int F_INSTALLED = 0;
    private static final int F_CATALOG = 1;
    private static final int F_PENDING = 2;

    /** 行数组的候选字段名（按顺序取第一个是数组的；pending 是本页实测补的）。 */
    private static final String[] ARRAY_KEYS = {"plugins", "items", "list", "data", "rows", "pending"};

    /**
     * 串进副标题只会变成噪音的字段：目录条目里它们是 markdown 正文 / 链接 / 摘要，
     * 16 字的格子里既读不通也排不上（内容是详情浮层的事）。均据实测形状。
     */
    private static final String[] NOISY_KEYS = {
            "readme", "readmeUrl", "changelog", "changelogUrl", "homepage", "icon",
            "screenshots", "signature", "sha256", "url", "mirrors"};

    private static final int RIGHT_ENABLED = 0;
    private static final int RIGHT_COMPAT = 1;

    /** 已装面的最小自动刷新间隔。 */
    private static final long REFRESH_MS = 30000;

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    private int facet = F_INSTALLED;

    /** 三个面各自的树 / 错误 / 在途标记 / 取数时刻（互不影响）。 */
    private final Object[] trees = new Object[3];
    private final String[] errors = new String[3];
    private final boolean[] loading = new boolean[3];
    private final long[] loadedAt = new long[3];

    /** {@code pending-count} 的顶层标量（与 pending 列表分开成卡）。 */
    private Object pendingCount;

    PluginsScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        host = new FrameLayout(activity);
        host.setClipChildren(false);
        host.setClipToPadding(false);
        root.addView(host, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        render();
        load(F_INSTALLED);
    }

    @Override
    void onAttach() {
        if (trees[F_INSTALLED] == null && !loading[F_INSTALLED]) load(F_INSTALLED);
    }

    @Override
    void refresh() {
        if (facet != F_INSTALLED || loading[F_INSTALLED]) return;
        // 只按时间限流：失败也等满 30 秒，不做重试风暴。
        if (System.currentTimeMillis() - loadedAt[F_INSTALLED] < REFRESH_MS) return;
        load(F_INSTALLED);
    }

    // ---------------------------------------------------------------- 取数

    private void load(final int which) {
        if (loading[which]) return;
        loading[which] = true;
        loadedAt[which] = System.currentTimeMillis();
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                String path;
                int timeout;
                if (which == F_CATALOG) {
                    path = "api/plugins/index";
                    timeout = 20000;
                } else if (which == F_PENDING) {
                    path = "api/plugins/pending";
                    timeout = 15000;
                } else {
                    path = "api/plugins";
                    timeout = 20000;
                }
                final Object tree = DashApi.json(activity, path, timeout);
                final Object count = which == F_PENDING
                        ? DashApi.json(activity, "api/plugins/pending-count", 8000) : null;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading[which] = false;
                        if (which == F_PENDING) pendingCount = count;
                        if (tree == null) {
                            errors[which] = "读不到数据";
                        } else {
                            trees[which] = tree;
                            errors[which] = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-plugins").start();
    }

    // ---------------------------------------------------------------- 渲染

    private void render() {
        if (host == null) return;
        int keep = scrollView == null ? scrollY : scrollView.getScrollY();
        scrollY = keep;
        host.removeAllViews();
        ScrollView v = page();
        scrollView = v;
        host.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        if (keep > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    if (scrollView != null) scrollView.scrollTo(0, keep);
                }
            });
        }
    }

    private void pick(int index) {
        if (index == facet) {
            // 再点当前面：上次失败时给一次**手动**重试（不是自动轮询）
            if (trees[index] == null && !loading[index]) load(index);
            return;
        }
        facet = index;
        // 换面回到顶部：先把 scrollView 置空，免得 render() 读到旧页的滚动位置。
        scrollY = 0;
        scrollView = null;
        if (trees[index] == null) load(index);
        else render();
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("插件"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        col.addView(DashKit.facets(activity, t,
                new String[]{"已装", "目录", "待处理"}, facet, new DashKit.OnFacet() {
                    @Override
                    public void onFacet(int index) {
                        pick(index);
                    }
                }), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (facet == F_CATALOG) {
            col.addView(catalogFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        } else if (facet == F_PENDING) {
            col.addView(pendingFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        } else {
            col.addView(installedFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    // ---------------------------------------------------------------- ① 已装

    private View installedFacet() {
        LinearLayout col = Ui.column(activity);
        List<Map<String, Object>> list = rowsOf(trees[F_INSTALLED]);

        int on = 0;
        for (int i = 0; i < list.size(); i++) {
            if (ModelsScreen.U.truthy(BotConfigJson.get(list.get(i), "enabled"))) on++;
        }
        col.addView(status(trees[F_INSTALLED] == null
                ? loadingOrError(F_INSTALLED)
                : list.size() + " 个插件 · 已启用 " + on), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 数据还没到（读取中 / 读不到）就不建空卡，状态行已经说明
        if (trees[F_INSTALLED] != null) {
            DashKit.Card c = DashKit.card(activity, t, "已装", String.valueOf(list.size()));
            if (list.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "没有插件");
            else addRows(c.body, list, RIGHT_ENABLED);
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return col;
    }

    // ---------------------------------------------------------------- ② 目录

    private View catalogFacet() {
        LinearLayout col = Ui.column(activity);
        List<Map<String, Object>> list = rowsOf(trees[F_CATALOG]);

        col.addView(status(trees[F_CATALOG] == null
                ? loadingOrError(F_CATALOG)
                : list.size() + " 个可装"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (trees[F_CATALOG] != null) {
            DashKit.Card c = DashKit.card(activity, t, "目录", String.valueOf(list.size()));
            if (list.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "没有条目");
            else addRows(c.body, list, RIGHT_COMPAT);
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return col;
    }

    // ---------------------------------------------------------------- ③ 待处理

    private View pendingFacet() {
        LinearLayout col = Ui.column(activity);

        // 计数卡：pending-count 的顶层标量逐条 kv
        DashKit.Card cnt = DashKit.card(activity, t, "计数", null);
        Map<String, Object> counters = BotConfigJson.asObject(pendingCount);
        if (counters == null) {
            DashKit.kv(activity, t, cnt.body, "状态", loadingOrError(F_PENDING));
        } else {
            int n = 0;
            for (Map.Entry<String, Object> e : counters.entrySet()) {
                Object v = e.getValue();
                if (v instanceof Map || v instanceof List) continue;
                String val = DashApi.str(counters, e.getKey());
                if (val.length() == 0) continue;
                DashKit.kv(activity, t, cnt.body, e.getKey(), DashKit.cut(val, 24));
                if (++n >= 6) break;
            }
            if (n == 0) DashKit.kv(activity, t, cnt.body, "状态", "—");
        }
        col.addView(cnt.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 列表卡
        List<Map<String, Object>> list = rowsOf(trees[F_PENDING]);
        DashKit.Card c = DashKit.card(activity, t, "待处理", String.valueOf(list.size()));
        if (list.isEmpty()) {
            String empty;
            if (trees[F_PENDING] != null) empty = "暂无待处理";
            else empty = loadingOrError(F_PENDING);
            DashKit.kv(activity, t, c.body, "状态", empty);
        } else {
            addRows(c.body, list, RIGHT_ENABLED);
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    // ---------------------------------------------------------------- 行 / 浮层

    private TextView status(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }

    private String loadingOrError(int which) {
        if (loading[which]) return "读取中…";
        return errors[which] == null ? "—" : errors[which];
    }

    private void addRows(LinearLayout parent, List<Map<String, Object>> list, int rightMode) {
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, parent);
            final Map<String, Object> m = list.get(i);
            DashKit.row(activity, t, parent, titleOf(m), subOf(m),
                    rightOf(m, rightMode), true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showDetail(m);
                        }
                    });
        }
    }

    /** 点一行：全部标量 {@code 键=值} 逐行（含退一层的嵌套对象）+ description 全文。 */
    private void showDetail(Map<String, Object> m) {
        StringBuilder sb = new StringBuilder();
        appendScalars(sb, m, "");
        for (Map.Entry<String, Object> e : m.entrySet()) {
            Map<String, Object> sub = BotConfigJson.asObject(e.getValue());
            if (sub == null) continue;
            appendScalars(sb, sub, e.getKey() + ".");
        }
        // 实测：目录条目的 description 在顶层，已装条目的只在 manifest 里
        String desc = DashApi.str(m, "description");
        if (desc.length() == 0) desc = DashApi.str(m, "manifest.description");
        if (desc.length() > 0) {
            if (sb.length() > 0) sb.append("\n\n");
            sb.append(desc);
        }
        ModelsScreen.W.infoDialog(activity, t, titleOf(m), sb.toString());
    }

    // ---------------------------------------------------------------- 通用小函数

    /** 标题：name → displayName → manifest.name（实测已装条目只有这层有中文名）→ pluginName → id。 */
    private static String titleOf(Map<String, Object> m) {
        String[] keys = {"name", "displayName", "manifest.name", "pluginName", "id"};
        for (int i = 0; i < keys.length; i++) {
            String v = DashApi.str(m, keys[i]);
            if (v.length() > 0) return v;
        }
        return "未命名";
    }

    /** 副标题：「v版本」+ 通用标量串联（实测版本号在已装条目里也只在 manifest 下）。 */
    private static String subOf(Map<String, Object> m) {
        String ver = DashApi.str(m, "version");
        if (ver.length() == 0) ver = DashApi.str(m, "manifest.version");
        String rest = scalarsOf(m, 6);
        if (ver.length() == 0) return rest;
        String head = "v" + DashKit.cut(ver, 12);
        return rest.length() == 0 ? head : head + " · " + rest;
    }

    /**
     * 副标题：跳过 id 与 version，前 6 个有值标量用 {@code · } 串起来（每个裁到 16 字）。
     *
     * <p>实测这几处不过滤，副标题就没有可读性：<b>布尔值</b>（{@code true · true · true}，而启用状态
     * 已经在行右侧）、<b>http(s) 链接</b>与 {@link #NOISY_KEYS} 里那批长文本/链接字段、<b>与标题相同
     * 的值</b>（目录条目的 name 就是标题），以及已被 {@link #subOf} 提前的 <b>version</b>。
     */
    private static String scalarsOf(Map<String, Object> m, int max) {
        StringBuilder sb = new StringBuilder();
        String title = titleOf(m);
        int n = 0;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            String key = e.getKey();
            if ("id".equals(key) || "version".equals(key) || noisy(key)) continue;
            Object v = e.getValue();
            if (v instanceof Boolean) continue;
            if (v instanceof Map || v instanceof List) continue;
            String s = DashApi.str(m, key);
            if (s.length() == 0 || s.equals(title)) continue;
            // ★ 有些布尔是**字符串**下发的（"true"/"false"），上面那句 instanceof Boolean 拦不住，
            //   漏过去就会变成「true · true · true」这种副标题 —— 这里补一道。
            if ("true".equals(s) || "false".equals(s)) continue;
            if (s.startsWith("http://") || s.startsWith("https://")) continue;
            if (n >= max) break;
            n++;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(DashKit.cut(s, 16));
        }
        return sb.toString();
    }

    private static boolean noisy(String key) {
        for (int i = 0; i < NOISY_KEYS.length; i++) {
            if (NOISY_KEYS[i].equals(key)) return true;
        }
        return false;
    }

    /** 行右侧：已装看 enabled，目录看 compatible（只标「不可装」，省掉满屏「可装」）。 */
    private static String rightOf(Map<String, Object> m, int mode) {
        if (mode == RIGHT_ENABLED) {
            if (!BotConfigJson.has(m, "enabled")) return "";
            return ModelsScreen.U.truthy(BotConfigJson.get(m, "enabled")) ? "已启用" : "未启用";
        }
        if (mode == RIGHT_COMPAT) {
            if (!BotConfigJson.has(m, "compatible")) return "";
            return ModelsScreen.U.truthy(BotConfigJson.get(m, "compatible")) ? "" : "不可装";
        }
        return "";
    }

    /** 一层的标量捡进正文（description 单独整段放最后，这里跳过）。 */
    private static void appendScalars(StringBuilder sb, Map<String, Object> m, String prefix) {
        for (Map.Entry<String, Object> e : m.entrySet()) {
            Object v = e.getValue();
            if (v instanceof Map || v instanceof List) continue;
            if ("description".equals(e.getKey())) continue;
            String val = DashApi.str(m, e.getKey());
            if (val.length() == 0) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append(prefix).append(e.getKey()).append('=').append(val);
        }
    }

    /** 本层先按 {@link #ARRAY_KEYS} 找数组；节点自己就是数组也收。 */
    private static List<Object> firstArray(Object node) {
        Map<String, Object> m = BotConfigJson.asObject(node);
        if (m == null) return BotConfigJson.asArray(node);
        for (int i = 0; i < ARRAY_KEYS.length; i++) {
            List<Object> hit = BotConfigJson.asArray(m.get(ARRAY_KEYS[i]));
            if (hit != null) return hit;
        }
        return null;
    }

    /** 找一棵树里的行数组：本层没有就退一层嵌套（逐个字段试，值本身是数组也收）。 */
    private static List<Map<String, Object>> rowsOf(Object tree) {
        List<Object> arr = firstArray(tree);
        if (arr == null) {
            Map<String, Object> m = BotConfigJson.asObject(tree);
            if (m != null) {
                for (Map.Entry<String, Object> e : m.entrySet()) {
                    arr = firstArray(e.getValue());
                    if (arr != null) break;
                }
            }
        }
        return DashApi.objects(arr);
    }
}
