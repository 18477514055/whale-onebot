package com.whaleonebot.ui;

import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板 ·「记忆」：三个面 —— 会话记忆（{@code api/memory-files}）/ 人物（{@code identity-pilot/people}）/
 * 长期记忆（{@code living-memory/memories}，必须带 scopeKey）。
 *
 * <p>只读。长期记忆的 scopeKey 从「会话记忆」里挑，点会话那一行会直接带过去。
 */
final class MemoryScreen extends Screen {

    private static final int F_SESSION = 0;
    private static final int F_PEOPLE = 1;
    private static final int F_LONG = 2;

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    private int facet = F_SESSION;
    private Object filesTree;
    private Object peopleTree;
    private Object longTree;
    private String scopeKey;
    private String error;
    private boolean loading;
    private long lastFetchAt;

    MemoryScreen(AppShell shell) {
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
        loadFiles();
    }

    @Override
    void onAttach() {
        if (filesTree == null && !loading) loadFiles();
    }

    @Override
    void refresh() {
        if (facet != F_SESSION || loading) return;
        if (System.currentTimeMillis() - lastFetchAt < 15000) return;
        loadFiles();
    }

    // ---------------------------------------------------------------- 取数

    private void loadFiles() {
        loading = true;
        lastFetchAt = System.currentTimeMillis();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/memory-files", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            filesTree = tree;
                            error = null;
                            if (scopeKey == null || scopeKey.length() == 0) {
                                List<Map<String, Object>> files =
                                        DashApi.objects(BotConfigJson.get(tree, "files"));
                                if (!files.isEmpty()) scopeKey = DashApi.str(files.get(0), "chatKey");
                            }
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-files").start();
    }

    private void loadPeople() {
        loading = true;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity,
                        "api/identity-pilot/people?limit=50", 20000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            peopleTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-people").start();
    }

    private void loadLong() {
        if (scopeKey == null || scopeKey.length() == 0) {
            render();
            return;
        }
        loading = true;
        longTree = null;
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity,
                        "api/living-memory/memories?scopeKey=" + scopeKey + "&limit=20", 15000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loading = false;
                        if (tree == null) error = "读不到数据";
                        else {
                            longTree = tree;
                            error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-mem-long").start();
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
        col.addView(header("记忆"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        col.addView(DashKit.facets(activity, t,
                new String[]{"会话", "人物", "长期"}, facet, new DashKit.OnFacet() {
                    @Override
                    public void onFacet(int index) {
                        if (index == facet) return;
                        facet = index;
                        scrollY = 0;
                        if (index == F_PEOPLE && peopleTree == null) loadPeople();
                        else if (index == F_LONG && longTree == null) loadLong();
                        else render();
                    }
                }), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (facet == F_SESSION) col.addView(sessionFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else if (facet == F_PEOPLE) col.addView(peopleFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        else col.addView(longFacet(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    // ---------------------------------------------------------------- ① 会话记忆

    private View sessionFacet() {
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> files = DashApi.objects(BotConfigJson.get(filesTree, "files"));
        Object stats = BotConfigJson.get(filesTree, "stats");
        long entries = (long) DashApi.num(stats, "entries");
        long people = (long) DashApi.num(stats, "people");

        TextView sub = Ui.text(activity,
                filesTree == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : files.size() + " 个会话 · " + entries + " 条印象 · " + people + " 人",
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "会话记忆", null);
        if (files.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "还没有记录");
        for (int i = 0; i < files.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = files.get(i);
            final String key = DashApi.str(m, "chatKey");
            long imp = (long) DashApi.num(m, "impressionCount");
            long mem = (long) DashApi.num(m, "memberCount");
            long upd = (long) DashApi.num(m, "updatedAt");
            boolean busy = ModelsScreen.U.truthy(BotConfigJson.get(m, "consolidating"));
            DashKit.row(activity, t, c.body, DashKit.chatLabel(key),
                    "印象 " + imp + " · 成员 " + mem + " · 更新 " + DashApi.ago(upd),
                    busy ? "整理中" : "", true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            scopeKey = key;
                            longTree = null;
                            facet = F_LONG;
                            scrollY = 0;
                            loadLong();
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    // ---------------------------------------------------------------- ② 人物

    private View peopleFacet() {
        LinearLayout col = Ui.column(activity);

        List<Map<String, Object>> people = DashApi.objects(BotConfigJson.get(peopleTree, "people"));
        int friends = 0;
        for (int i = 0; i < people.size(); i++) {
            if (ModelsScreen.U.truthy(BotConfigJson.get(people.get(i), "isFriend"))) friends++;
        }

        TextView sub = Ui.text(activity,
                peopleTree == null ? (loading ? "读取中…" : (error == null ? "—" : error))
                        : people.size() + " 人 · 好友 " + friends,
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        DashKit.Card c = DashKit.card(activity, t, "人物", null);
        if (people.isEmpty()) DashKit.kv(activity, t, c.body, "状态", "还没有记录");
        for (int i = 0; i < people.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Map<String, Object> m = people.get(i);
            String name = DashApi.str(m, "primaryName");
            String uid = DashApi.str(m, "userId");
            long msgs = (long) DashApi.num(m, "messageCount");
            long chats = (long) DashApi.num(m, "chatCount");
            boolean isFriend = ModelsScreen.U.truthy(BotConfigJson.get(m, "isFriend"));
            long last = (long) DashApi.num(m, "lastSeenAt");
            DashKit.row(activity, t, c.body, name.length() > 0 ? name : uid,
                    uid + " · 消息 " + msgs + " · 群 " + chats + (isFriend ? " · 好友" : ""),
                    DashApi.ago(last), true, new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showPerson(m);
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return col;
    }

    private void showPerson(Map<String, Object> m) {
        StringBuilder sb = new StringBuilder();
        String uid = DashApi.str(m, "userId");
        sb.append("QQ ").append(uid).append('\n');

        List<Map<String, Object>> aliases = DashApi.objects(BotConfigJson.get(m, "aliases"));
        if (!aliases.isEmpty()) {
            StringBuilder al = new StringBuilder();
            for (int i = 0; i < aliases.size(); i++) {
                String a = DashApi.str(aliases.get(i), "alias");
                if (a.length() == 0) continue;
                if (al.length() > 0) al.append("、");
                al.append(a);
            }
            if (al.length() > 0) sb.append("别名：").append(al).append('\n');
        }
        sb.append("记忆：全库 ").append((long) DashApi.num(m, "globalMemoryCount"))
                .append(" · 本会话 ").append((long) DashApi.num(m, "currentMemoryCount"))
                .append(" · 其它 ").append((long) DashApi.num(m, "otherContextMemoryCount")).append('\n');
        sb.append("旧印象：").append((long) DashApi.num(m, "legacyMemoryCount")).append('\n');
        sb.append("首次：").append(DashApi.when((long) DashApi.num(m, "firstSeenAt"))).append('\n');
        sb.append("最近：").append(DashApi.when((long) DashApi.num(m, "lastSeenAt"))).append('\n');
        sb.append("来源：").append(DashKit.chatLabel(DashApi.str(m, "sourceChatKey"))).append('\n');

        String profile = DashKit.textOf(BotConfigJson.get(m, "safeProfile"));
        if (profile.length() > 0) sb.append('\n').append(profile);

        ModelsScreen.W.infoDialog(activity, t,
                DashApi.str(m, "primaryName").length() > 0 ? DashApi.str(m, "primaryName") : uid,
                sb.toString());
    }

    // ---------------------------------------------------------------- ③ 长期记忆

    private View longFacet() {
        LinearLayout col = Ui.column(activity);

        LinearLayout bar = Ui.row(activity);
        TextView scope = Ui.text(activity,
                scopeKey == null || scopeKey.length() == 0 ? "先选一个范围"
                        : "范围：" + DashKit.chatLabel(scopeKey) + " · 共 "
                        + (long) DashApi.num(longTree, "total") + " 条",
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        slp.weight = 1f;
        bar.addView(scope, slp);

        TextView pick = Ui.button(activity, t, "换范围", false);
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                chooseScope();
            }
        });
        bar.addView(pick, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        col.addView(bar, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        List<Map<String, Object>> entries = DashApi.objects(BotConfigJson.get(longTree, "entries"));
        if (entries.isEmpty()) {
            DashKit.Card c = DashKit.card(activity, t, "长期记忆", null);
            DashKit.kv(activity, t, c.body, "状态",
                    loading ? "读取中…" : (longTree == null
                            ? (scopeKey == null ? "先选一个范围" : (error == null ? "—" : error))
                            : "这个范围还没有长期记忆"));
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            return col;
        }

        for (int i = 0; i < entries.size(); i++) {
            Map<String, Object> e = entries.get(i);
            String type = typeLabel(DashApi.str(e, "type"));
            double importance = DashApi.num(e, "importance");
            long created = (long) DashApi.num(e, "createdAt");
            DashKit.Card c = DashKit.card(activity, t, type,
                    DashApi.when(created) + (Double.isNaN(importance) ? ""
                            : " · 重要度 " + String.format(java.util.Locale.US, "%.1f", importance)));
            String summary = DashApi.str(e, "summary");
            if (summary.length() > 0) DashKit.block(activity, t, c.body, summary);
            String content = DashApi.str(e, "content");
            if (content.length() > 0) DashKit.block(activity, t, c.body, DashKit.cut(content, 120));
            col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return col;
    }

    private void chooseScope() {
        List<Map<String, Object>> files = DashApi.objects(BotConfigJson.get(filesTree, "files"));
        final List<String> keys = new ArrayList<String>();
        List<String> labels = new ArrayList<String>();
        for (int i = 0; i < files.size(); i++) {
            String k = DashApi.str(files.get(i), "chatKey");
            if (k.length() == 0) continue;
            keys.add(k);
            labels.add(DashKit.chatLabel(k) + " · " + (long) DashApi.num(files.get(i), "impressionCount") + " 条");
        }
        if (keys.isEmpty()) {
            ModelsScreen.W.toast(activity, "会话记忆还没加载");
            return;
        }
        ModelsScreen.W.chooseDialog(activity, t, "选一个范围", null,
                labels.toArray(new String[0]), keys.toArray(new String[0]), scopeKey,
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String value) {
                        scopeKey = value;
                        longTree = null;
                        scrollY = 0;
                        loadLong();
                    }
                });
    }

    private static String typeLabel(String type) {
        if ("episode".equals(type)) return "事件";
        if ("fact".equals(type)) return "事实";
        if ("profile".equals(type)) return "画像";
        if ("preference".equals(type)) return "偏好";
        if ("commitment".equals(type)) return "约定";
        if ("project".equals(type)) return "项目";
        if ("rule".equals(type)) return "规则";
        return type == null || type.length() == 0 ? "记忆" : type;
    }
}
