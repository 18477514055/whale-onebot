package com.whaleonebot.ui;

import android.text.InputType;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 独立「联网搜索」设置页：彻底移除百度与必应，仅保留高质量 API 搜索服务商与自定义搜索网关。
 * 搜索拥有独立提供商与 API Key，不与 LLM 模型库混用；保存后严格保持当前滚动位置不回顶。
 */
final class WebSearchScreen extends Screen {

    private static final String[] PROVIDER_IDS = {
            "bocha", "metaso", "zhipu", "tavily", "doubao", "deepseek", "aggregate", "custom"
    };
    private static final String[] PROVIDER_LABELS = {
            "博查 Bocha（国内中文优化 API）",
            "秘塔 Metaso（中文 AI 搜索）",
            "智谱 Web Search",
            "Tavily（海外/LLM 专用）",
            "豆包火山搜索",
            "DeepSeek Search API",
            "多源并发聚合（勾选多个引擎）",
            "自定义搜索网关（SearXNG / OpenAI 风格）"
    };
    private static final String[] AGG_CANDIDATES = { "bocha", "metaso", "zhipu", "tavily", "doubao", "deepseek" };

    private final BotConfigHost cfg;
    private ScrollView scrollView;
    private int savedScrollY = 0;
    private Object data;
    private boolean dirty = false;

    WebSearchScreen(AppShell shell, BotConfigHost host) {
        super(shell);
        this.cfg = host;
    }

    @Override
    void build() {
        root.removeAllViews();
        load();
        render();
    }

    @Override
    boolean hasUnsavedChanges() {
        return dirty;
    }

    private void load() {
        try {
            String raw = cfg == null ? null : cfg.loadConfigJson();
            data = (raw != null && !raw.trim().isEmpty()) ? BotConfigJson.parse(raw) : new LinkedHashMap<String, Object>();
        } catch (Throwable ignored) {
            data = new LinkedHashMap<String, Object>();
        }
        dirty = false;
    }

    private void render() {
        if (scrollView != null) savedScrollY = scrollView.getScrollY();
        root.removeAllViews();

        scrollView = new ScrollView(activity);
        scrollView.setFillViewport(true);
        scrollView.setClipChildren(false);
        scrollView.setVerticalScrollBarEnabled(false);
        root.addView(scrollView, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, dp(dirty ? 110 : Theme.S4));
        scrollView.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("联网搜索"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        boolean enabled = boolAt("webSearch.enabled", false);
        String provider = strAt("webSearch.provider", "");
        if ("smart".equalsIgnoreCase(provider) || "bing".equalsIgnoreCase(provider) || "baidu".equalsIgnoreCase(provider)) {
            provider = "";
        }

        LinearLayout mainCard = Ui.addCard(col, activity, t, Theme.S3);
        mainCard.addView(ModelsScreen.W.switchRow(activity, t, "启用联网搜索",
                enabled ? "模型需要查实时信息时自动调用" : "默认关闭，选好服务商并填 Key 后开启",
                enabled, on -> {
                    BotConfigJson.set(data, "webSearch.enabled", Boolean.valueOf(on));
                    dirty = true;
                    render();
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        mainCard.addView(Ui.divider(activity, t));
        final String curP = provider;
        addKvRow(mainCard, "搜索服务商", labelOfProvider(curP), () ->
                ModelsScreen.W.chooseDialog(activity, t, "选择联网搜索服务商", "仅提供高质量结构化 API 搜索",
                        PROVIDER_LABELS, PROVIDER_IDS, curP, val -> {
                            BotConfigJson.set(data, "webSearch.provider", val);
                            dirty = true;
                            render();
                        }));

        mainCard.addView(Ui.divider(activity, t));
        addKvRow(mainCard, "单次最多返回条数", strAt("webSearch.maxResults", "6") + " 条", () ->
                ModelsScreen.W.textDialog(activity, t, "单次返回条数", "推荐 5~8 条（范围 1~20）",
                        strAt("webSearch.maxResults", "6"), InputType.TYPE_CLASS_NUMBER, false,
                        s -> {
                            try {
                                int n = Integer.parseInt(s.trim());
                                return (n < 1 || n > 20) ? "范围 1~20" : null;
                            } catch (Throwable e) { return "请输入整数"; }
                        },
                        val -> {
                            BotConfigJson.set(data, "webSearch.maxResults", new BotConfigJson.Num(val.trim()));
                            dirty = true;
                            render();
                        }));

        // 按所选服务商动态展示独立凭据卡
        if ("aggregate".equals(curP)) {
            LinearLayout aggCard = Ui.addCard(col, activity, t, Theme.S2);
            aggCard.addView(Ui.strong(activity, "多源聚合引擎选择", Theme.T_BODY, t.textPrimary));
            aggCard.addView(Ui.text(activity, "并发请求已勾选的高质量搜索源并自动去重合并（最多 4 个）；请在下方分别为各源填写 API Key。",
                    Theme.T_CAP, t.textSecondary), mt(dp(4)));
            Set<String> selected = currentAggSources();
            for (final String src : AGG_CANDIDATES) {
                aggCard.addView(Ui.divider(activity, t));
                boolean on = selected.contains(src);
                aggCard.addView(ModelsScreen.W.switchRow(activity, t, labelOfProvider(src),
                        hasKey("webSearch." + src + ".apiKey") ? "Key 已配置" : "未填 Key",
                        on, checked -> {
                            Set<String> next = currentAggSources();
                            if (checked) next.add(src); else next.remove(src);
                            List<Object> arr = new ArrayList<Object>(next);
                            BotConfigJson.set(data, "webSearch.aggregate.sources", arr);
                            dirty = true;
                            render();
                        }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
            for (final String src : selected) {
                aggCard.addView(Ui.divider(activity, t));
                addKeyRow(aggCard, src + " API Key", "webSearch." + src + ".apiKey");
            }
        } else if (!curP.isEmpty()) {
            LinearLayout credCard = Ui.addCard(col, activity, t, Theme.S2);
            credCard.addView(Ui.strong(activity, labelOfProvider(curP) + " 凭据配置", Theme.T_BODY, t.textPrimary));
            String prefix = "custom".equals(curP) ? "webSearch.custom" : ("webSearch." + curP);
            credCard.addView(Ui.divider(activity, t));
            addKeyRow(credCard, "搜索 API Key", prefix + ".apiKey");
            credCard.addView(Ui.divider(activity, t));
            addKvRow(credCard, "接口地址（可选覆盖）", strAt(prefix + ".baseUrl", "使用官方默认地址"), () ->
                    ModelsScreen.W.textDialog(activity, t, "接口地址", "留空使用官方默认地址",
                            strAt(prefix + ".baseUrl", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, false,
                            null, val -> {
                                BotConfigJson.set(data, prefix + ".baseUrl", val.trim());
                                dirty = true;
                                render();
                            }));
        }

        LinearLayout opsCard = Ui.addCard(col, activity, t, Theme.S2);
        final TextView testBtn = Ui.button(activity, t, "测试连通性", false);
        testBtn.setOnClickListener(v -> {
            if (dirty) {
                host().toast("请先保存后再测试");
                return;
            }
            Ui.enabled(testBtn, false);
            testBtn.setText("测试中…");
            new Thread(() -> {
                DashApi.Result r = DashApi.post(activity, "/api/web-search/test", "{\"query\":\"今日新闻\"}", 18000);
                String msg;
                if (r != null && r.ok && r.data != null) {
                    Map<String, Object> m = BotConfigJson.asObject(r.data);
                    boolean ok = m != null && Boolean.TRUE.equals(m.get("ok"));
                    if (ok) {
                        int cnt = (int) DashApi.num(m, "count");
                        long ms = (long) DashApi.num(m, "latencyMs");
                        msg = "连通成功（返回 " + cnt + " 条 · " + ms + "ms）";
                    } else {
                        String err = m == null ? "" : DashApi.str(m, "error", "");
                        msg = "搜索失败：" + (err.isEmpty() ? "请检查 Key 或服务商" : err);
                    }
                } else {
                    msg = "搜索失败：" + (r == null || r.error == null ? "请检查 Key 或运行端状态" : r.error);
                }
                final String finalMsg = msg;
                activity.runOnUiThread(() -> {
                    testBtn.setText("测试连通性");
                    Ui.enabled(testBtn, true);
                    host().toast(finalMsg);
                });
            }, "websearch-test").start();
        });
        opsCard.addView(testBtn, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (dirty) {
            TextView saveBtn = Ui.button(activity, t, "保存配置", true);
            saveBtn.setOnClickListener(v -> save());
            opsCard.addView(saveBtn, mt(dp(Theme.S2)));
        }

        final int y = savedScrollY;
        if (y > 0) scrollView.post(() -> { if (scrollView != null) scrollView.scrollTo(0, y); });
    }

    private void save() {
        if (cfg == null) return;
        try {
            if (cfg.saveConfigJson(BotConfigJson.write(data))) {
                dirty = false;
                host().toast("联网搜索配置已保存");
                render();
            } else {
                host().toast("保存失败");
            }
        } catch (Throwable ex) {
            host().toast("保存异常：" + ex.getMessage());
        }
    }

    private void addKeyRow(LinearLayout parent, String title, final String path) {
        addKvRow(parent, title, hasKey(path) ? "已配置（点此替换）" : "未填写（点此输入）", () ->
                ModelsScreen.W.textDialog(activity, t, "填写 " + title, "保存后写入，界面永不回显",
                        "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false,
                        null, val -> {
                            BotConfigJson.set(data, path, val == null ? "" : val.trim());
                            dirty = true;
                            render();
                        }));
    }

    private void addKvRow(LinearLayout parent, String title, String value, final Runnable onClick) {
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, dp(Theme.S1 + 2), 0, dp(Theme.S1 + 2));
        row.setClickable(true);
        row.setOnClickListener(v -> onClick.run());
        LinearLayout txt = Ui.column(activity);
        txt.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
        txt.addView(Ui.text(activity, value, Theme.T_CAP, t.textSecondary), mt(dp(3)));
        row.addView(txt, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private Set<String> currentAggSources() {
        Set<String> out = new LinkedHashSet<String>();
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(data, "webSearch.aggregate.sources"));
        if (arr != null) {
            for (Object o : arr) {
                String s = String.valueOf(o).trim().toLowerCase(java.util.Locale.US);
                if (!s.isEmpty() && !"bing".equals(s) && !"baidu".equals(s)) out.add(s);
            }
        }
        return out;
    }

    private boolean hasKey(String path) {
        String v = strAt(path, "");
        return !v.isEmpty() && !"******".equals(v);
    }

    private boolean boolAt(String path, boolean def) {
        Object v = BotConfigJson.get(data, path);
        if (v == BotConfigJson.MISSING || v == BotConfigJson.NULL) return def;
        return ModelsScreen.U.truthy(v);
    }

    private String strAt(String path, String def) {
        Object v = BotConfigJson.get(data, path);
        if (v == BotConfigJson.MISSING || v == BotConfigJson.NULL || v == null) return def;
        if (v instanceof BotConfigJson.Num) return ((BotConfigJson.Num) v).raw;
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? def : s;
    }

    private static String labelOfProvider(String id) {
        if (id == null || id.isEmpty()) return "未选择（点此配置）";
        for (int i = 0; i < PROVIDER_IDS.length; i++) {
            if (PROVIDER_IDS[i].equals(id)) return PROVIDER_LABELS[i];
        }
        return id;
    }

    private LinearLayout.LayoutParams mt(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
