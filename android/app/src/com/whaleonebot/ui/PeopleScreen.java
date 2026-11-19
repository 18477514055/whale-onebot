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
 * 看板 ·「好友」：机器人认识的人 / 好友申请 / 派发机会，三面切换，全部只读。
 *
 * <p>数据来自运行端控制台（容器内 {@code 127.0.0.1:<server.port>}），走 {@link DashApi}：
 * <ul>
 *   <li>① 认识的人 —— {@code api/identity-pilot/people?limit=50}（★ 必须带 limit，默认 100 实测 7.8 秒）</li>
 *   <li>② 好友申请 —— {@code api/identity-pilot/incoming-friend-requests}（数组在 {@code requests}）</li>
 *   <li>③ 派发 —— 先 {@code api/identity-pilot/friend-proposals}（{@code proposals}），
 *       空再 {@code api/identity-pilot/friend-opportunities}（{@code opportunities}）</li>
 * </ul>
 *
 * <p><b>②③ 的数组落点按「找数组」处理</b>：先试已知名（requests / proposals / opportunities），
 * 再试契约里的通用名（data / items / rows），最后退回「任意顶层数组」与一层嵌套 —— 结构变了也不会白屏。
 *
 * <p><b>线程</b>：请求全在后台线程，回来 {@code runOnUiThread} 才碰 View；本页只读，不发任何写请求。
 * <b>失败不自动重试</b>：{@link #refresh()} 只在①面且上一次**成功**过、且距上次 ≥15 秒时才刷。
 */
final class PeopleScreen extends Screen {

    private static final int FACET_PEOPLE = 0;
    private static final int FACET_REQUESTS = 1;
    private static final int FACET_DISPATCH = 2;

    private static final String[] FACET_LABELS = {"认识的人", "好友申请", "派发"};

    /** ① 要 20 秒：人数多时它自己就要好几秒。 */
    private static final int TIMEOUT_PEOPLE = 20000;
    /** ②③ 的列表接口。 */
    private static final int TIMEOUT_LIST = 15000;

    /** 自动刷新下限（宿主每秒调一次 refresh）。 */
    private static final long REFRESH_MIN_MS = 15000;

    private static final int PEOPLE_LIMIT = 50;
    private static final int LIST_LIMIT = 50;

    /** 一面数据的状态：树 / 错误 / 是否在取 / 上次取数时刻。 */
    private static final class Slot {
        Object tree;
        String error;
        boolean loading;
        long at;
    }

    private final Slot peopleSlot = new Slot();
    private final Slot requestSlot = new Slot();
    private final Slot dispatchSlot = new Slot();

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;
    /** 换面时置真：新面从顶部开始（否则会继承上一面的滚动位置）。 */
    private boolean resetScroll;

    private int facet = FACET_PEOPLE;

    PeopleScreen(AppShell shell) {
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
        load(FACET_PEOPLE);
    }

    @Override
    void onAttach() {
        Slot s = slotOf(facet);
        if (s.tree == null && !s.loading) load(facet);
    }

    /** 宿主每秒调一次：只自动刷①面，且只在上次成功之后（失败交给用户点刷新）。 */
    @Override
    void refresh() {
        if (facet != FACET_PEOPLE) return;
        if (peopleSlot.loading) return;
        if (peopleSlot.tree == null) return;
        if (System.currentTimeMillis() - peopleSlot.at < REFRESH_MIN_MS) return;
        load(FACET_PEOPLE);
    }

    // ================================================================ 取数

    private Slot slotOf(int which) {
        if (which == FACET_REQUESTS) return requestSlot;
        if (which == FACET_DISPATCH) return dispatchSlot;
        return peopleSlot;
    }

    private void load(final int which) {
        final Slot s = slotOf(which);
        if (s.loading) return;
        s.loading = true;
        s.error = null;
        s.at = System.currentTimeMillis();
        render();

        new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree;
                if (which == FACET_PEOPLE) {
                    tree = DashApi.json(activity,
                            "api/identity-pilot/people?limit=" + PEOPLE_LIMIT, TIMEOUT_PEOPLE);
                } else if (which == FACET_REQUESTS) {
                    tree = DashApi.json(activity,
                            "api/identity-pilot/incoming-friend-requests?limit=" + LIST_LIMIT,
                            TIMEOUT_LIST);
                } else {
                    tree = loadDispatch();
                }
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        s.loading = false;
                        s.at = System.currentTimeMillis();
                        if (tree == null) {
                            s.error = "读不到数据";
                        } else {
                            s.tree = tree;
                            s.error = null;
                        }
                        render();
                    }
                });
            }
        }, "dm-people").start();
    }

    /**
     * ③ 两张表依次试：候选（proposals）优先，它为空再看机会（opportunities）；
     * 两个都连不上返回 null（= 读不到数据），只要有一个拿到了就算成功（空 = 暂无）。
     */
    private Object loadDispatch() {
        Object proposals = DashApi.json(activity,
                "api/identity-pilot/friend-proposals?limit=" + LIST_LIMIT, TIMEOUT_LIST);
        if (!rowsOf(proposals).isEmpty()) return proposals;
        Object opportunities = DashApi.json(activity,
                "api/identity-pilot/friend-opportunities?limit=" + LIST_LIMIT, TIMEOUT_LIST);
        if (!rowsOf(opportunities).isEmpty()) return opportunities;
        return proposals != null ? proposals : opportunities;
    }

    /**
     * 找一个「行数组」：结构没有公开契约，所以按可信度递减地试 ——
     * 已知名 → 契约通用名 → 任意顶层数组 → 一层嵌套 → 最后退回第一个空数组（区分「空」与「读不到」）。
     */
    private static List<Map<String, Object>> rowsOf(Object tree) {
        return findRows(tree, new String[]{
                "requests", "proposals", "opportunities", "data", "items", "rows"});
    }

    private static List<Map<String, Object>> findRows(Object tree, String[] names) {
        Map<String, Object> root = BotConfigJson.asObject(tree);
        if (root == null) return new ArrayList<Map<String, Object>>();

        for (int i = 0; i < names.length; i++) {
            List<Map<String, Object>> rows = DashApi.objects(root.get(names[i]));
            if (!rows.isEmpty()) return rows;
        }
        for (Map.Entry<String, Object> e : root.entrySet()) {
            List<Map<String, Object>> rows = DashApi.objects(e.getValue());
            if (!rows.isEmpty()) return rows;
        }
        for (Map.Entry<String, Object> e : root.entrySet()) {
            Map<String, Object> nested = BotConfigJson.asObject(e.getValue());
            if (nested == null) continue;
            for (Map.Entry<String, Object> n : nested.entrySet()) {
                List<Map<String, Object>> rows = DashApi.objects(n.getValue());
                if (!rows.isEmpty()) return rows;
            }
        }
        for (int i = 0; i < names.length; i++) {
            List<Object> arr = BotConfigJson.asArray(root.get(names[i]));
            if (arr != null) return DashApi.objects(arr);
        }
        for (Map.Entry<String, Object> e : root.entrySet()) {
            List<Object> arr = BotConfigJson.asArray(e.getValue());
            if (arr != null) return DashApi.objects(arr);
        }
        return new ArrayList<Map<String, Object>>();
    }

    // ================================================================ 渲染

    private void render() {
        if (host == null) return;
        int keep = resetScroll ? 0 : (scrollView == null ? scrollY : scrollView.getScrollY());
        resetScroll = false;
        scrollY = keep;
        host.removeAllViews();
        ScrollView v = page();
        scrollView = v;
        host.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        if (keep > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    if (scrollView != null) scrollView.scrollTo(0, scrollY);
                }
            });
        }
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("好友"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "只读 · 身份库", Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        col.addView(DashKit.facets(activity, t, FACET_LABELS, facet, new DashKit.OnFacet() {
            @Override
            public void onFacet(int index) {
                Slot s = slotOf(index);
                if (index == facet) {
                    // 再点当前面 = 重试（失败后唯一的自动入口就是它和页底刷新）
                    if (!s.loading && s.tree == null) load(index);
                    return;
                }
                facet = index;
                resetScroll = true;
                render();
                if (slotOf(index).tree == null && !slotOf(index).loading) load(index);
            }
        }), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        col.addView(facetCard(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(footCard(), DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    private View facetCard() {
        Slot s = slotOf(facet);
        DashKit.Card c = DashKit.card(activity, t, FACET_LABELS[facet], rightOf(s));
        if (s.tree == null) {
            c.body.addView(note(s.error == null ? "读取中…" : s.error),
                    Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return c.view;
        }
        if (facet == FACET_PEOPLE) fillPeople(c.body, s.tree);
        else fillList(c.body, s.tree, facet);
        return c.view;
    }

    /** 卡片右上角：①「N 人 · 好友 M」，②③「N 条」；空或没到就不显示。 */
    private String rightOf(Slot s) {
        if (s == null || s.tree == null) return null;
        if (facet == FACET_PEOPLE) {
            List<Map<String, Object>> rows = DashApi.objects(BotConfigJson.get(s.tree, "people"));
            if (rows.isEmpty()) return null;
            int friends = 0;
            for (int i = 0; i < rows.size(); i++) {
                if (ModelsScreen.U.truthy(rows.get(i).get("isFriend"))) friends++;
            }
            return rows.size() + " 人 · 好友 " + friends;
        }
        List<Map<String, Object>> rows = rowsOf(s.tree);
        return rows.isEmpty() ? null : rows.size() + " 条";
    }

    // ---------------------------------------------------------------- ① 认识的人

    private void fillPeople(LinearLayout parent, Object tree) {
        List<Map<String, Object>> rows = DashApi.objects(BotConfigJson.get(tree, "people"));
        if (rows.isEmpty()) {
            parent.addView(note("还没有记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return;
        }
        for (int i = 0; i < rows.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, parent);
            final Map<String, Object> m = rows.get(i);
            String uid = DashApi.str(m, "userId");
            String name = DashApi.str(m, "primaryName");
            boolean friend = ModelsScreen.U.truthy(m.get("isFriend"));
            long msgs = (long) DashApi.num(m, "messageCount");
            long chats = (long) DashApi.num(m, "chatCount");
            long last = (long) DashApi.num(m, "lastSeenAt");
            String line = (uid.length() == 0 ? "—" : uid)
                    + " · 消息 " + msgs + " · 群 " + chats + " · " + (friend ? "好友" : "非好友");
            DashKit.row(activity, t, parent,
                    name.length() == 0 ? uid : name, line, DashApi.ago(last), true,
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showPerson(m);
                        }
                    });
        }
    }

    /** 点一个「认识的人」：只读详情浮层（别名 / 记忆计数 / 首末时间 / 来源会话）。 */
    private void showPerson(Map<String, Object> m) {
        String uid = DashApi.str(m, "userId");
        String name = DashApi.str(m, "primaryName");
        long first = (long) DashApi.num(m, "firstSeenAt");
        long last = (long) DashApi.num(m, "lastSeenAt");

        StringBuilder sb = new StringBuilder(320);
        sb.append("用户 ").append(uid.length() == 0 ? "—" : uid);
        if (name.length() > 0) sb.append('\n').append("名字 ").append(DashKit.cut(name, 24));

        String aliases = aliasesOf(m);
        if (aliases.length() > 0) sb.append('\n').append("别名 ").append(aliases);

        sb.append('\n').append("首次 ").append(DashApi.when(first))
                .append("（").append(DashApi.ago(first)).append("）");
        sb.append('\n').append("最近 ").append(DashApi.when(last))
                .append("（").append(DashApi.ago(last)).append("）");
        sb.append('\n').append("消息 ").append((long) DashApi.num(m, "messageCount"))
                .append(" 条 · 群 ").append((long) DashApi.num(m, "chatCount"));
        sb.append('\n').append("好友 ")
                .append(ModelsScreen.U.truthy(m.get("isFriend")) ? "是" : "否")
                .append(ModelsScreen.U.truthy(m.get("manuallyManaged")) ? " · 手动管理" : "");
        sb.append('\n').append("记忆 全局 ").append((long) DashApi.num(m, "globalMemoryCount"))
                .append(" · 本会话 ").append((long) DashApi.num(m, "currentMemoryCount"))
                .append(" · 其它 ").append((long) DashApi.num(m, "otherContextMemoryCount"))
                .append(" · 旧 ").append((long) DashApi.num(m, "legacyMemoryCount"));

        String src = DashApi.str(m, "sourceChatKey");
        if (src.length() > 0) sb.append('\n').append("来源 ").append(DashKit.chatLabel(src));

        ModelsScreen.W.infoDialog(activity, t,
                name.length() == 0 ? (uid.length() == 0 ? "人物" : uid) : name, sb.toString());
    }

    /** 别名最多 5 个；元素可能是字符串，也可能是 {@code {alias,…}} 对象。 */
    private static String aliasesOf(Map<String, Object> m) {
        List<Object> list = BotConfigJson.asArray(m.get("aliases"));
        if (list == null) return "";
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (int i = 0; i < list.size() && n < 5; i++) {
            Object v = list.get(i);
            String one;
            Map<String, Object> obj = BotConfigJson.asObject(v);
            if (obj != null) one = ModelsScreen.U.s(obj.get("alias")).trim();
            else one = ModelsScreen.U.s(v).trim();
            if (one.length() == 0) continue;
            if (sb.length() > 0) sb.append(" / ");
            sb.append(DashKit.cut(one, 12));
            n++;
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- ②③ 申请 / 派发

    private void fillList(LinearLayout parent, Object tree, int which) {
        List<Map<String, Object>> rows = rowsOf(tree);
        if (rows.isEmpty()) {
            parent.addView(note(which == FACET_REQUESTS ? "没有申请" : "暂无"),
                    Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return;
        }
        for (int i = 0; i < rows.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, parent);
            Map<String, Object> m = rows.get(i);
            long at = (long) DashApi.num(m, "createdAt");
            DashKit.row(activity, t, parent, firstTitle(m, i), scalarPairs(m),
                    at > 0 ? DashApi.ago(at) : "", false, null);
        }
    }

    private static String firstTitle(Map<String, Object> m, int index) {
        String name = DashApi.str(m, "primaryName");
        if (name.length() > 0) return DashKit.cut(name, 20);
        String uid = DashApi.str(m, "userId");
        if (uid.length() > 0) return uid;
        String nick = DashApi.str(m, "nickname");
        if (nick.length() > 0) return DashKit.cut(nick, 20);
        return "第 " + (index + 1) + " 条";
    }

    /** 一条记录 = 前 6 个「有值标量」的 k=v，值截断（id 不列，它没有可读性）。 */
    private static String scalarPairs(Map<String, Object> m) {
        StringBuilder sb = new StringBuilder(120);
        int n = 0;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            if (n >= 6) break;
            if ("id".equals(e.getKey())) continue;
            Object v = e.getValue();
            if (v instanceof Map || v instanceof List) continue;
            String text = ModelsScreen.U.s(v).trim();
            if (text.length() == 0) continue;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(e.getKey()).append('=').append(DashKit.cut(text, 16));
            n++;
        }
        return sb.length() == 0 ? "—" : sb.toString();
    }

    // ---------------------------------------------------------------- 页脚

    private View footCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = ModelsScreen.W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout row = Ui.row(activity);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        tlp.weight = 1f;
        long at = slotOf(facet).at;
        row.addView(Ui.text(activity, at == 0 ? "还没更新" : "更新于 " + DashApi.ago(at),
                Theme.T_CAP, t.textTertiary), tlp);

        final boolean loading = slotOf(facet).loading;
        TextView again = Ui.button(activity, t, loading ? "读取中…" : "刷新", false);
        Ui.enabled(again, !loading);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Slot s = slotOf(facet);
                if (!s.loading) load(facet);
            }
        });
        row.addView(again, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        box.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    private TextView note(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }
}
