package com.whaleonebot.ui;

import android.view.Gravity;
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
 * 看板 ·「待对账」：把发送侧**需要人拍板**的会话摊开，并给两个动作。
 *
 * <pre>
 *   待确认（held）→ 解锁：标为已发送，**不重发**（运行端 store.resolveHeld）
 *   发送失败（failed）→ 重试失败：**真的补发**（运行端 store.retryFailed，会补发旧消息）
 * </pre>
 *
 * <p>为什么需要这一页：运行端 {@code orchestrator} 有一道闸门 —— 会话里只要还有
 * {@code held>0}，该会话就**不再回话**（reason「该会话存在发送结果待确认」）。
 * 协议端已改成 12s 等回执 + 认不出就回 {@code message_id:null}，并且 App 侧每 30 秒
 * 自动巡检解锁（看门狗），所以正常情况这里是空的；历史遗留或人工阻断时才需要来这里。
 *
 * <p>数据：{@code GET /api/chats}（只读）。动作：{@code POST /api/chats/<group|private>_<id>/<动作>}，
 * body 必须带 {@code {"confirm":true}}（不带会 409）。
 */
final class ReconcileScreen extends Screen {

    /** 一次要处理的会话（从 api/chats 挑出 held/failed 不为 0 的）。 */
    private static final class Item {
        final String key;
        final String chatKey;
        final String name;
        final long held;
        final long failed;
        final long total;
        final String last;
        final long lastTs;

        Item(String key, String chatKey, String name, long held, long failed, long total,
             String last, long lastTs) {
            this.key = key;
            this.chatKey = chatKey;
            this.name = name;
            this.held = held;
            this.failed = failed;
            this.total = total;
            this.last = last;
            this.lastTs = lastTs;
        }
    }

    private FrameLayout page;
    private FrameLayout overlay;
    private ScrollView scrollView;
    private int scrollY;

    private Object chatsTree;
    private String error;
    /** 页内一行结果提示（「已解锁 8 条」这类），null = 不显示。 */
    private String note;
    private boolean loading;
    private long lastFetchAt;

    ReconcileScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        page = new FrameLayout(activity);
        page.setClipChildren(false);
        page.setClipToPadding(false);
        root.addView(page, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        overlay = new FrameLayout(activity);
        overlay.setVisibility(View.GONE);
        overlay.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        page.addView(overlay, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        render();
        load();
    }

    @Override
    void onAttach() {
        if (chatsTree == null && !loading) load();
    }

    @Override
    void refresh() {
        if (loading || overlay.getVisibility() == View.VISIBLE) return;
        if (System.currentTimeMillis() - lastFetchAt < 15000) return;
        load();
    }

    @Override
    boolean handleBack() {
        if (overlay.getVisibility() == View.VISIBLE) {
            closeOverlay();
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- 取数

    private void load() {
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
        }, "dm-reconcile").start();
    }

    /** 发一个动作（resolve-held / retry-failed），成功后重新取数。 */
    private void act(final Item it, final String action) {
        final String label = "retry-failed".equals(action) ? "重试" : "解锁";
        closeOverlay();
        note = label + "中…";
        render();
        new Thread(new Runnable() {
            @Override
            public void run() {
                final DashApi.Resp r = DashApi.post(port(), actionPath(it, action),
                        "{\"confirm\":true}", 30000);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (r.ok()) {
                            int n = count(r.body);
                            note = label + "完成：" + n + " 条";
                        } else {
                            note = label + "失败：" + r.reason();
                        }
                        lastFetchAt = 0;
                        load();
                    }
                });
            }
        }, "dm-reconcile-act").start();
    }

    private static String actionPath(Item it, String action) {
        String k = it.chatKey;
        int i = k.indexOf(':');
        String kind = i > 0 ? k.substring(0, i) : "group";
        String id = i > 0 ? k.substring(i + 1) : k;
        return "api/chats/" + kind + "_" + id + "/" + action;
    }

    private static int count(String body) {
        try {
            Object v = BotConfigJson.parse(body);
            double n = DashApi.num(v, "count");
            return Double.isNaN(n) ? 0 : (int) n;
        } catch (Throwable th) {
            return 0;
        }
    }

    private int port() {
        return DashApi.port(activity);
    }

    // ---------------------------------------------------------------- 渲染

    private void render() {
        if (page == null) return;
        int keep = scrollView == null ? scrollY : scrollView.getScrollY();
        scrollY = keep;

        if (scrollView != null) page.removeView(scrollView);
        ScrollView v = content();
        scrollView = v;
        page.addView(v, 0, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        // overlay 必须压在内容之上
        if (overlay != null && overlay.getParent() == page) {
            page.removeView(overlay);
            page.addView(overlay, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        }
        if (keep > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    if (scrollView != null) scrollView.scrollTo(0, keep);
                }
            });
        }
    }

    private ScrollView content() {
        List<Item> items = items();

        long heldSum = 0;
        long failedSum = 0;
        for (int i = 0; i < items.size(); i++) {
            heldSum += items.get(i).held;
            failedSum += items.get(i).failed;
        }

        LinearLayout col = Ui.column(activity);
        col.addView(header("待对账"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        String summary;
        if (chatsTree == null) summary = loading ? "读取中…" : (error == null ? "—" : error);
        else if (items.isEmpty()) summary = "没有待对账的会话";
        else summary = "待确认 " + heldSum + " 条 · 失败 " + failedSum + " 条 · " + items.size() + " 个会话";
        TextView sub = Ui.text(activity, summary, Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        if (note != null) {
            TextView n = Ui.text(activity, note, Theme.T_CAP, t.textSecondary);
            n.setLineSpacing(dp(3), 1f);
            col.addView(n, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        }

        DashKit.Card c = DashKit.card(activity, t, "会话", items.isEmpty() ? null : items.size() + " 个");
        if (chatsTree == null) {
            DashKit.kv(activity, t, c.body, "状态", loading ? "读取中…" : (error == null ? "—" : error));
        } else if (items.isEmpty()) {
            DashKit.kv(activity, t, c.body, "状态", "全部干净");
        }
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) DashKit.divider(activity, t, c.body);
            final Item it = items.get(i);
            StringBuilder sb = new StringBuilder();
            if (it.held > 0) sb.append("待确认 ").append(it.held);
            if (it.failed > 0) {
                if (sb.length() > 0) sb.append(" · ");
                sb.append("失败 ").append(it.failed);
            }
            sb.append(" · 共 ").append(it.total).append(" 条");
            if (it.last.length() > 0) sb.append(" · ").append(DashKit.cut(it.last, 20));
            DashKit.row(activity, t, c.body, it.name, sb.toString(), DashApi.ago(it.lastTs), true,
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            openSheet(it);
                        }
                    });
        }
        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        DashKit.Card tip = DashKit.card(activity, t, "说明", null);
        DashKit.kv(activity, t, tip.body, "解锁", "标为已发送，不重发");
        DashKit.kv(activity, t, tip.body, "重试失败", "真的补发，旧的会重发");
        DashKit.kv(activity, t, tip.body, "自动", "每 30 秒解锁一次");
        col.addView(tip.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        TextView again = Ui.button(activity, t, "重新读取", false);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                note = null;
                lastFetchAt = 0;
                load();
            }
        });
        col.addView(again, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    /** 从 {@code api/chats} 里挑出 held / failed 不为 0 的会话，按待处理条数倒序。 */
    private List<Item> items() {
        List<Map<String, Object>> chats = DashApi.objects(BotConfigJson.get(chatsTree, "chats"));
        List<Item> out = new ArrayList<Item>();
        for (int i = 0; i < chats.size(); i++) {
            Map<String, Object> m = chats.get(i);
            long held = (long) DashApi.num(m, "held");
            long failed = (long) DashApi.num(m, "failed");
            if (held <= 0 && failed <= 0) continue;
            String key = DashApi.str(m, "key");
            if (key.length() == 0) key = DashApi.str(m, "chatKey");
            String chatKey = DashApi.str(m, "chatKey");
            if (chatKey.length() == 0) chatKey = key;
            String name = DashApi.str(m, "chatName");
            if (name.length() == 0) name = DashKit.chatLabel(key);
            out.add(new Item(key, chatKey, name, held, failed,
                    (long) DashApi.num(m, "total"), DashApi.str(m, "lastText"),
                    (long) DashApi.num(m, "lastTs")));
        }
        // 待确认优先（它直接挡着会话说话），其次失败多的
        java.util.Collections.sort(out, new java.util.Comparator<Item>() {
            @Override
            public int compare(Item a, Item b) {
                if (a.held != b.held) return a.held > b.held ? -1 : 1;
                if (a.failed != b.failed) return a.failed > b.failed ? -1 : 1;
                return a.lastTs > b.lastTs ? -1 : (a.lastTs == b.lastTs ? 0 : 1);
            }
        });
        return out;
    }

    // ---------------------------------------------------------------- 动作浮层

    private void closeOverlay() {
        if (overlay == null) return;
        overlay.removeAllViews();
        overlay.setVisibility(View.GONE);
    }

    private void openSheet(final Item it) {
        overlay.removeAllViews();
        overlay.setBackgroundColor(0x99000000);
        overlay.setVisibility(View.VISIBLE);

        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S3));
        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        box.addView(Ui.strong(activity, it.name, Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView meta = Ui.text(activity,
                "待确认 " + it.held + " · 失败 " + it.failed + " · 共 " + it.total + " 条",
                Theme.T_CAP, t.textTertiary);
        meta.setLineSpacing(dp(2), 1f);
        box.addView(meta, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        TextView unlock = Ui.button(activity, t, "解锁（不重发）", it.held > 0);
        unlock.setEnabled(it.held > 0);
        unlock.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                act(it, "resolve-held");
            }
        });
        box.addView(unlock, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        TextView retry = Ui.button(activity, t, "重试失败（会补发 " + it.failed + " 条）", false);
        retry.setEnabled(it.failed > 0);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                act(it, "retry-failed");
            }
        });
        box.addView(retry, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView cancel = Ui.text(activity, "取消", Theme.T_CAP, t.textSecondary);
        cancel.setGravity(Gravity.CENTER);
        cancel.setPadding(0, dp(12), 0, dp(4));
        cancel.setClickable(true);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeOverlay();
            }
        });
        box.addView(cancel, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                MATCH_PARENT, WRAP_CONTENT, Gravity.CENTER);
        clp.leftMargin = dp(Theme.S4);
        clp.rightMargin = dp(Theme.S4);
        overlay.addView(card, clp);
    }
}
