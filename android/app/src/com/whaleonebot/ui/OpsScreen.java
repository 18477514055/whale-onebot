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
 * 看板 ·「运维」：四个面 —— 观测（素材/黑话/记忆/身份 + 三个 pilot 状态）/ 异常（incidents）/
 * 用量（usage breakdown）/ 技能（skills）。全部只读。
 */
final class OpsScreen extends Screen {

    private static final int F_OBS = 0;
    private static final int F_INCIDENT = 1;
    private static final int F_USAGE = 2;
    private static final int F_SKILL = 3;

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    private int facet = F_OBS;
    private Object overview;
    private Object pilotIdentity;
    private Object pilotSlang;
    private Object pilotIncident;
    private Object incidents;
    private Object usage;
    private Object skills;
    private String error;
    private boolean loading;
    private long lastObsAt;

    OpsScreen(AppShell shell) {
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
        loadObs();
    }

    @Override
    void onAttach() {
        if (overview == null && !loading) loadObs();
    }

    @Override
    void refresh() {
        if (facet != F_OBS || loading) return;
        if (System.currentTimeMillis() - lastObsAt < 30000) return;
        loadObs();
    }

    // ---------------------------------------------------------------- 取数

    private void loadObs() {
        loading = true;
        lastObsAt = System.currentTimeMillis();
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object ov = DashApi.json(activity, "api/assets/overview", 15000);
                final Object id = DashApi.json(activity, "api/identity-pilot/status", 8000);
                final Object sl = DashApi.json(activity, "api/slang-pilot/status", 8000);
                final Object ic = DashApi.json(activity, "api/incident-pilot/status", 8000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (ov == null) error = "读不到数据";
                        else {
                            overview = ov;
                            error = null;
                        }
                        pilotIdentity = id;
                        pilotSlang = sl;
                        pilotIncident = ic;
                        render();
                    }
                });
            }
        }, "dm-ops-obs").start();
    }

    private void loadIncidents() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/incidents", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            incidents = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-ops-inc").start();
    }

    private void loadUsage() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/usage/breakdown?range=7", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            usage = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-ops-use").start();
    }

    private void loadSkills() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/skills", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            skills = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-ops-skill").start();
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

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("运维"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        col.addView(DashKit.facets(activity, t,
                new String[]{"观测", "异常", "用量", "技能"}, facet, new DashKit.OnFacet() {
                    @Override
                    public void onFacet(int index) {
                        if (index == facet) return;
                        facet = index;
                        scrollY = 0;
                        if (index == F_INCIDENT && incidents == null) loadIncidents();
                        else if (index == F_USAGE && usage == null) loadUsage();
                        else if (index == F_SKILL && skills == null) loadSkills();
                        else render();
                    }
                }), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (facet == F_OBS) col.addView(obsFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else if (facet == F_INCIDENT) col.addView(incidentFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else if (facet == F_USAGE) col.addView(usageFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else col.addView(skillFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    // ---------------------------------------------------------------- ① 观测

    private View obsFacet() {
        LinearLayout col = Ui.column(activity);

        TextView sub = Ui.text(activity,
                overview == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : "更新于 " + DashApi.ago((long) DashApi.num(overview, "generatedAt")),
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        Object stickers = BotConfigJson.get(overview, "stickers");
        DashKit.Card s1 = DashKit.card(activity, t, "贴纸", null);
        DashKit.kv(activity, t, s1.body, "启用", flag(stickers, "enabled"));
        DashKit.kv(activity, t, s1.body, "总数", String.valueOf((long) DashApi.num(stickers, "total")));
        DashKit.kv(activity, t, s1.body, "已标注", String.valueOf((long) DashApi.num(stickers, "annotated")));
        DashKit.kv(activity, t, s1.body, "已用", String.valueOf((long) DashApi.num(stickers, "used")));
        col.addView(s1.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        Object slang = BotConfigJson.get(overview, "slang");
        DashKit.Card s2 = DashKit.card(activity, t, "黑话", null);
        DashKit.kv(activity, t, s2.body, "启用", flag(slang, "active"));
        DashKit.kv(activity, t, s2.body, "总数", String.valueOf((long) DashApi.num(slang, "total")));
        DashKit.kv(activity, t, s2.body, "候选", String.valueOf((long) DashApi.num(slang, "counts.candidate")));
        DashKit.kv(activity, t, s2.body, "已确认", String.valueOf((long) DashApi.num(slang, "counts.confirmed")));
        col.addView(s2.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        Object memory = BotConfigJson.get(overview, "memory");
        DashKit.Card s3 = DashKit.card(activity, t, "记忆", null);
        DashKit.kv(activity, t, s3.body, "会话", String.valueOf((long) DashApi.num(memory, "chats")));
        DashKit.kv(activity, t, s3.body, "人物", String.valueOf((long) DashApi.num(memory, "people")));
        DashKit.kv(activity, t, s3.body, "印象", String.valueOf((long) DashApi.num(memory, "impressions")));
        DashKit.kv(activity, t, s3.body, "交接", String.valueOf((long) DashApi.num(memory, "handoffs")));
        col.addView(s3.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        Object identity = BotConfigJson.get(overview, "identity");
        DashKit.Card s4 = DashKit.card(activity, t, "身份", null);
        DashKit.kv(activity, t, s4.body, "启用", flag(identity, "enabled"));
        DashKit.kv(activity, t, s4.body, "活跃", flag(identity, "active"));
        DashKit.kv(activity, t, s4.body, "库", flag(identity, "databaseExists"));
        col.addView(s4.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        DashKit.Card s5 = DashKit.card(activity, t, "试点", null);
        pilotRow(s5.body, "身份", pilotIdentity);
        pilotRow(s5.body, "黑话", pilotSlang);
        pilotRow(s5.body, "异常", pilotIncident);
        col.addView(s5.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void pilotRow(LinearLayout parent, String label, Object tree) {
        if (tree == null) {
            DashKit.kv(activity, t, parent, label, "读不到");
            return;
        }
        Object st = BotConfigJson.get(tree, "status");
        Map<String, Object> m = BotConfigJson.asObject(st);
        if (m == null) {
            DashKit.kv(activity, t, parent, label, DashKit.cut(DashKit.textOf(st), 24));
            return;
        }
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            Object v = e.getValue();
            if (v instanceof Map || v instanceof java.util.List) continue;
            if (n++ >= 3) break;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(e.getKey()).append('=').append(String.valueOf(v));
        }
        DashKit.kv(activity, t, parent, label, sb.length() == 0 ? "—" : sb.toString());
    }

    // ---------------------------------------------------------------- ② 异常

    private View incidentFacet() {
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> list = DashApi.objects(BotConfigJson.get(incidents, "incidents"));
        int open = 0;
        int warn = 0;
        for (int i = 0; i < list.size(); i++) {
            if ("open".equals(DashApi.str(list.get(i), "state"))) open++;
            if ("warning".equals(DashApi.str(list.get(i), "severity"))) warn++;
        }
        TextView sub = Ui.text(activity,
                incidents == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : list.size() + " 条 · open " + open + " · warning " + warn,
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "异常", null);
        if (list.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "没有记录");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = list.get(i);
            String sev = DashApi.str(m, "severity");
            String code = DashApi.str(m, "code");
            String state = DashApi.str(m, "state");
            long count = (long) DashApi.num(m, "count");
            long last = (long) DashApi.num(m, "lastAt");
            DashKit.row(activity, t, c.body,
                    "[" + (sev.length() == 0 ? "?" : sev) + "] " + code + " · " + state,
                    DashKit.cut(DashApi.str(m, "message"), 60) + " · 次数 " + count,
                    DashApi.ago(last), true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showIncident(m);
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void showIncident(Map<String, Object> m) {
        StringBuilder sb = new StringBuilder();
        sb.append(DashApi.str(m, "message")).append("\n\n");
        sb.append("分类：").append(DashApi.str(m, "category")).append('\n');
        sb.append("来源：").append(DashApi.str(m, "source")).append('\n');
        String chat = DashApi.str(m, "chatKey");
        if (chat.length() > 0) sb.append("会话：").append(DashKit.chatLabel(chat)).append('\n');
        sb.append("状态：").append(DashApi.str(m, "state"))
                .append(" · ").append(DashApi.str(m, "severity")).append('\n');
        sb.append("次数：").append((long) DashApi.num(m, "count")).append('\n');
        sb.append("首次：").append(DashApi.when((long) DashApi.num(m, "firstAt"))).append('\n');
        sb.append("最近：").append(DashApi.when((long) DashApi.num(m, "lastAt"))).append('\n');
        String resolution = DashApi.str(m, "resolution");
        if (resolution.length() > 0) sb.append("\n处理：").append(resolution);
        ModelsScreen.W.infoDialog(activity, t, DashApi.str(m, "code"), sb.toString());
    }

    // ---------------------------------------------------------------- ③ 用量

    private View usageFacet() {
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> rows = DashApi.objects(BotConfigJson.get(usage, "rows"));
        double cost = DashApi.num(BotConfigJson.get(usage, "totals"), "cost");
        long runs = 0;
        for (int i = 0; i < rows.size(); i++) runs += (long) DashApi.num(rows.get(i), "runs");

        TextView sub = Ui.text(activity,
                usage == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : "近 7 天 · ¥" + (Double.isNaN(cost) ? "—"
                        : String.format(java.util.Locale.US, "%.2f", cost)) + " · " + runs + " 次",
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "渠道 / 模型", null);
        if (rows.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "没有记录");
        for (int i = 0; i < rows.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            Map<String, Object> m = rows.get(i);
            double rowCost = DashApi.num(m, "cost");
            long rowRuns = (long) DashApi.num(m, "runs");
            double hit = DashApi.num(m, "cacheHitRate");
            String key = DashApi.str(m, "key");
            DashKit.row(activity, t, c.body, key.length() == 0 ? "（未标注）" : key,
                    "¥" + (Double.isNaN(rowCost) ? "—" : String.format(java.util.Locale.US, "%.2f", rowCost))
                            + " · " + rowRuns + " 次 · 命中 "
                            + (Double.isNaN(hit) ? "—" : String.format(java.util.Locale.US, "%.0f%%", hit * 100)),
                    DashKit.km(DashApi.num(m, "totalTokens")), false, null);
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    // ---------------------------------------------------------------- ④ 技能

    private View skillFacet() {
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> list = DashApi.objects(BotConfigJson.get(skills, "skills"));
        int on = 0;
        for (int i = 0; i < list.size(); i++) {
            if (ModelsScreen.U.truthy(BotConfigJson.get(list.get(i), "enabled"))) on++;
        }
        TextView sub = Ui.text(activity,
                skills == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : list.size() + " 个技能 · 已启用 " + on,
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "技能", null);
        if (list.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "没有技能");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = list.get(i);
            boolean enabled = ModelsScreen.U.truthy(BotConfigJson.get(m, "enabled"));
            String id = DashApi.str(m, "id");
            String version = DashApi.str(m, "version");
            String source = DashApi.str(m, "source");
            DashKit.row(activity, t, c.body,
                    DashApi.str(m, "name").length() > 0 ? DashApi.str(m, "name") : id,
                    id + (version.length() > 0 ? " · v" + version : "")
                            + (source.length() > 0 ? " · " + source : ""),
                    enabled ? "已启用" : "未启用", true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showSkill(m);
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void showSkill(Map<String, Object> m) {
        StringBuilder sb = new StringBuilder();
        sb.append(DashApi.str(m, "description")).append("\n\n");
        String tools = DashKit.textOf(BotConfigJson.get(m, "allowedTools"));
        if (tools.length() > 0) sb.append("工具：").append(tools).append("\n\n");
        String triggers = DashKit.textOf(BotConfigJson.get(m, "triggers"));
        if (triggers.length() > 0) sb.append("触发：").append(triggers);
        ModelsScreen.W.infoDialog(activity, t,
                DashApi.str(m, "name").length() > 0 ? DashApi.str(m, "name") : DashApi.str(m, "id"),
                sb.toString());
    }

    private static String flag(Object root, String path) {
        return ModelsScreen.U.truthy(BotConfigJson.get(root, path)) ? "是" : "否";
    }
}
