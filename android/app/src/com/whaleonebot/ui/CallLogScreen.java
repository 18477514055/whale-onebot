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
 * 看板 ·「调用记录」：运行端 {@code /api/sessions} 的分页列表 → 单条详情。
 *
 * <p>详情是本页重点：把「模型看到了什么」（注入：promptLayout / persona / triggerKind / contextTier /
 * promptChars）与「它怎么跑的」（推理：rounds / activity / usage / outcome / sessionMetrics）分开摊开，
 * 再原样显示触发它的那条消息。
 */
final class CallLogScreen extends Screen {

    private static final int PAGE = 20;

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    private int offset;
    private int nextOffset;
    private boolean hasMore;
    private Object listTree;
    private Object openSession;
    private String error;
    private boolean loading;
    private long lastFetchAt;

    CallLogScreen(AppShell shell) {
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
        loadPage(0);
    }

    @Override
    void onAttach() {
        if (listTree == null && !loading) loadPage(offset);
    }

    @Override
    void refresh() {
        if (openSession != null || loading) return;
        if (System.currentTimeMillis() - lastFetchAt < 10000) return;
        loadPage(offset);
    }

    // ---------------------------------------------------------------- 取数

    private void loadPage(final int from) {
        if (loading) return;
        loading = true;
        error = null;
        lastFetchAt = System.currentTimeMillis();
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity,
                        "api/sessions?limit=" + PAGE + "&offset=" + from, 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) {
                            error = "读不到数据";
                        } else {
                            listTree = tree;
                            offset = (int) DashApi.num(tree, "offset");
                            nextOffset = (int) DashApi.num(tree, "nextOffset");
                            hasMore = ModelsScreen.U.truthy(BotConfigJson.get(tree, "hasMore"));
                        }
                        render();
                    }
                });
            }
        }, "dm-calls").start();
    }

    // ---------------------------------------------------------------- 渲染

    private void render() {
        if (host == null) return;
        int keep = scrollView == null ? scrollY : scrollView.getScrollY();
        scrollY = keep;
        host.removeAllViews();
        ScrollView v = openSession == null ? listPage() : detailPage();
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

    private ScrollView listPage() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("调用记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        List<Map<String, Object>> list = DashApi.objects(BotConfigJson.get(listTree, "sessions"));
        TextView sub = Ui.text(activity,
                loading ? "读取中…" : (listTree == null ? (error == null ? "—" : error)
                        : "第 " + (offset / PAGE + 1) + " 页 · 本页 " + list.size() + " 条"),
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        DashKit.Card c = DashKit.card(activity, t, "调用", null);
        if (list.isEmpty()) {
            DashKit.kv(activity, t, c.body, "状态", error == null ? "没有记录" : error);
        }
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> s = list.get(i);
            String status = DashApi.str(s, "status");
            long rounds = (long) DashApi.num(s, "rounds");
            String model = DashApi.str(s, "model");
            String trigger = DashApi.str(s, "trigger");
            final long started = (long) DashApi.num(s, "startedAt");
            DashKit.row(activity, t, c.body,
                    (status.length() == 0 ? "—" : status) + " · " + DashKit.chatLabel(DashApi.str(s, "chatKey")),
                    DashKit.cut(trigger, 50),
                    DashApi.when(started) + " · " + rounds + " 轮"
                            + (model.length() > 0 ? " · " + model : ""),
                    true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            openSession = s;
                            scrollY = 0;
                            render();
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        LinearLayout pager = DashKit.pager(activity, t,
                (offset / PAGE + 1) + "", offset > 0, hasMore,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        loadPage(Math.max(0, offset - PAGE));
                    }
                },
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        loadPage(nextOffset);
                    }
                });
        col.addView(pager, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(Ui.text(activity, "", Theme.T_CAP, t.textTertiary), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    private ScrollView detailPage() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("调用详情"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView back = Ui.button(activity, t, "返回列表", false);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openSession = null;
                scrollY = 0;
                render();
            }
        });
        col.addView(back, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        Map<String, Object> s = BotConfigJson.asObject(openSession);
        if (s == null) s = new java.util.LinkedHashMap<String, Object>();
        long started = (long) DashApi.num(s, "startedAt");
        long ended = (long) DashApi.num(s, "endedAt");

        // 概览
        DashKit.Card head = DashKit.card(activity, t, "概览", null);
        DashKit.kv(activity, t, head.body, "会话", DashKit.chatLabel(DashApi.str(s, "chatKey")));
        DashKit.kv(activity, t, head.body, "状态", DashApi.str(s, "status"));
        DashKit.kv(activity, t, head.body, "时间", DashApi.when(started)
                + (ended > 0 ? " → " + DashApi.when(ended) : ""));
        DashKit.kv(activity, t, head.body, "模型", DashApi.str(s, "model")
                + (DashApi.str(s, "vendor").length() > 0 ? " · " + DashApi.str(s, "vendor") : ""));
        col.addView(head.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        // 注入（模型看到了什么）
        DashKit.Card inj = DashKit.card(activity, t, "注入", null);
        DashKit.kv(activity, t, inj.body, "人格", DashApi.str(s, "persona"));
        DashKit.kv(activity, t, inj.body, "触发类型", DashApi.str(s, "triggerKind"));
        DashKit.kv(activity, t, inj.body, "触发原因", DashKit.cut(DashApi.str(s, "triggerReason"), 40));
        DashKit.kv(activity, t, inj.body, "上下文档", DashApi.str(s, "contextTier"));
        DashKit.kv(activity, t, inj.body, "提示字数", DashKit.km(DashApi.num(s, "promptChars")));
        DashKit.kv(activity, t, inj.body, "对话模式", DashApi.str(s, "conversationMode"));
        Object layout = BotConfigJson.get(s, "promptLayout");
        if (DashKit.textOf(layout).length() > 0) {
            DashKit.divider(activity, t, inj.body);
            DashKit.kv(activity, t, inj.body, "提示分段", "");
            DashKit.block(activity, t, inj.body, DashKit.textOf(layout));
        }
        col.addView(inj.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 推理（怎么跑的）
        DashKit.Card run = DashKit.card(activity, t, "推理", null);
        DashKit.kv(activity, t, run.body, "轮次", String.valueOf((long) DashApi.num(s, "rounds")));
        DashKit.kv(activity, t, run.body, "活动", DashApi.str(s, "activity"));
        DashKit.kv(activity, t, run.body, "联网次数", String.valueOf((long) DashApi.num(s, "webSearchCount")));
        DashKit.kv(activity, t, run.body, "结果", DashApi.str(s, "outcome"));
        appendObject(activity, t, run.body, BotConfigJson.get(s, "sessionMetrics"), "指标");
        appendObject(activity, t, run.body, BotConfigJson.get(s, "lifecycle"), "生命周期");
        col.addView(run.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 用量
        DashKit.Card use = DashKit.card(activity, t, "用量", null);
        Object usage = BotConfigJson.get(s, "usage");
        if (BotConfigJson.asObject(usage) == null) {
            DashKit.kv(activity, t, use.body, "用量", DashKit.textOf(usage));
        } else {
            appendScalars(activity, t, use.body, usage);
        }
        Object call = BotConfigJson.get(s, "callUsage");
        if (BotConfigJson.asObject(call) != null) {
            DashKit.divider(activity, t, use.body);
            DashKit.kv(activity, t, use.body, "", "");
            appendScalars(activity, t, use.body, call);
        }
        col.addView(use.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 触发内容
        String trigger = DashApi.str(s, "trigger");
        DashKit.Card trg = DashKit.card(activity, t, "触发内容", null);
        DashKit.block(activity, t, trg.body, trigger.length() == 0 ? "—" : trigger);
        col.addView(trg.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    /** 对象字段：标量逐条列。 */
    private void appendScalars(android.content.Context c, Theme th, LinearLayout parent, Object obj) {
        Map<String, Object> m = BotConfigJson.asObject(obj);
        if (m == null) return;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            Object v = e.getValue();
            if (v instanceof Map || v instanceof java.util.List) continue;
            DashKit.kv(c, th, parent, e.getKey(), String.valueOf(v));
        }
    }

    /** 对象字段：先列标量，再有嵌套就整体显示（避免漏信息）。 */
    private void appendObject(android.content.Context c, Theme th, LinearLayout parent,
                              Object obj, String label) {
        Map<String, Object> m = BotConfigJson.asObject(obj);
        if (m == null) {
            String t = DashKit.textOf(obj);
            if (t.length() > 0) DashKit.kv(c, th, parent, label, t);
            return;
        }
        appendScalars(c, th, parent, obj);
    }
}
