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
 * 看板 ·「会话监控」：运行端 {@code /api/chats} 的会话列表 → 点进去看该会话最近的调用时间线。
 *
 * <p>数据只读；两级同页切换（不占栈），返回列表用页内按钮。
 */
final class ChatMonitorScreen extends Screen {

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    /** 当前进入的会话 key；null = 列表级。 */
    private String openKey;

    private Object chatsTree;
    private Object sessionsTree;
    private String error;
    private boolean loading;
    private long lastFetchAt;

    ChatMonitorScreen(AppShell shell) {
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
        loadChats();
    }

    @Override
    void onAttach() {
        if (chatsTree == null && !loading) loadChats();
    }

    @Override
    void refresh() {
        if (openKey != null || loading) return;               // 详情页不自动刷新
        if (System.currentTimeMillis() - lastFetchAt < 10000) return;
        loadChats();
    }

    // ---------------------------------------------------------------- 取数

    private void loadChats() {
        if (loading) return;
        loading = true;
        lastFetchAt = System.currentTimeMillis();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/chats", 12000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            chatsTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-chats").start();
    }

    private void loadSessions(final String key) {
        loading = true;
        sessionsTree = null;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity,
                        "api/sessions?limit=20&chatKey=" + key, 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            sessionsTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-chat-sessions").start();
    }

    // ---------------------------------------------------------------- 渲染

    private void render() {
        if (host == null) return;
        int keep = scrollView == null ? scrollY : scrollView.getScrollY();
        scrollY = keep;
        host.removeAllViews();
        ScrollView v = openKey == null ? listPage() : detailPage();
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
        col.addView(header("会话监控"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        List<Map<String, Object>> chats = DashApi.objects(BotConfigJson.get(chatsTree, "chats"));
        int unread = 0;
        for (int i = 0; i < chats.size(); i++) unread += (int) DashApi.num(chats.get(i), "unread");

        TextView sub = Ui.text(activity,
                chats.isEmpty() ? (error == null ? "还没有会话" : error)
                        : chats.size() + " 个会话 · 未读 " + unread,
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        DashKit.Card c = DashKit.card(activity, t, "会话", null);
        for (int i = 0; i < chats.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = chats.get(i);
            final String key = DashApi.str(m, "key").length() > 0
                    ? DashApi.str(m, "key") : DashApi.str(m, "chatKey");
            String name = DashApi.str(m, "chatName");
            String title = name.length() > 0 ? name : DashKit.chatLabel(key);
            long total = (long) DashApi.num(m, "total");
            long un = (long) DashApi.num(m, "unread");
            long failed = (long) DashApi.num(m, "failed");
            String last = DashApi.str(m, "lastText");
            StringBuilder sb = new StringBuilder();
            sb.append("共 ").append(total).append(" 条");
            if (un > 0) sb.append(" · 未读 ").append(un);
            if (failed > 0) sb.append(" · 失败 ").append(failed);
            if (last.length() > 0) sb.append(" · ").append(DashKit.cut(last, 24));
            final long lastTs = (long) DashApi.num(m, "lastTs");
            DashKit.row(activity, t, c.body, title, sb.toString(), DashApi.ago(lastTs), true,
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            openKey = key;
                            loadSessions(key);
                        }
                    });
        }
        if (chats.isEmpty()) {
            DashKit.kv(activity, t, c.body, "状态", error == null ? "空" : error);
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        TextView again = Ui.button(activity, t, "刷新", false);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                lastFetchAt = 0;
                loadChats();
            }
        });
        col.addView(again, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    private ScrollView detailPage() {
        LinearLayout col = Ui.column(activity);

        String label = nameOf(openKey);
        col.addView(header(label), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView back = Ui.button(activity, t, "返回列表", false);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openKey = null;
                sessionsTree = null;
                scrollY = 0;
                render();
            }
        });
        col.addView(back, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        List<Map<String, Object>> list = DashApi.objects(BotConfigJson.get(sessionsTree, "sessions"));
        DashKit.Card c = DashKit.card(activity, t, "最近调用",
                list.isEmpty() ? null : list.size() + " 条");
        if (sessionsTree == null) {
            DashKit.kv(activity, t, c.body, "状态", loading ? "读取中…" : (error == null ? "—" : error));
        } else if (list.isEmpty()) {
            DashKit.kv(activity, t, c.body, "状态", "这个会话还没有调用记录");
        }
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            Map<String, Object> s = list.get(i);
            String status = DashApi.str(s, "status");
            long rounds = (long) DashApi.num(s, "rounds");
            String model = DashApi.str(s, "model");
            String trigger = DashApi.str(s, "trigger");
            String outcome = DashApi.str(s, "outcome");
            long started = (long) DashApi.num(s, "startedAt");

            String[] head = status.split("\\.");
            DashKit.row(activity, t, c.body,
                    head.length > 0 && head[0].length() > 0 ? head[0] : "—",
                    DashKit.cut(trigger, 60) + (outcome.length() > 0 ? "  →  " + DashKit.cut(outcome, 20) : ""),
                    DashApi.when(started) + " · " + rounds + " 轮"
                            + (model.length() > 0 ? " · " + model : ""),
                    false, null);
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    /** 从会话列表里找回这个 key 的显示名（群名或号码）。 */
    private String nameOf(String key) {
        List<Map<String, Object>> chats = DashApi.objects(BotConfigJson.get(chatsTree, "chats"));
        for (int i = 0; i < chats.size(); i++) {
            Map<String, Object> m = chats.get(i);
            String k = DashApi.str(m, "key").length() > 0 ? DashApi.str(m, "key") : DashApi.str(m, "chatKey");
            if (k.equals(key)) {
                String n = DashApi.str(m, "chatName");
                return n.length() > 0 ? n : DashKit.chatLabel(key);
            }
        }
        return DashKit.chatLabel(key);
    }
}
