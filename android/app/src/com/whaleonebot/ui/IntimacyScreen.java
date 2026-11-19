package com.whaleonebot.ui;

import android.text.InputType;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板子页：**亲密度**（三个面，页内切）。
 *
 * <p>数据全部走 {@link DashApi}（只读；不回写、不改配置）：
 * <ul>
 *   <li>榜单：{@code api/local/intimacy/list?limit=20} —— <b>实测 56.7 s</b>（全表扫 messages.sqlite），
 *       所以<b>进页面绝不自动请求</b>，必须用户点一次「算一次」，超时给到 90 s。</li>
 *   <li>单查：{@code api/local/intimacy/person?uin=…} —— 60 s。</li>
 *   <li>心情流水：{@code api/local/mood/log?limit=30} —— 12 s（实测 279 ms，切到这一面时才取）。</li>
 * </ul>
 *
 * <p><b>线程</b>：所有请求都在 {@code new Thread(...)} 里跑，回来 {@code activity.runOnUiThread} 填 View；
 * UI 线程一次网络都不发。取数失败一律 {@code null} → 渲染成「读不到数据」，不重试、不弹循环 Toast。
 *
 * <p><b>刷新</b>：{@link #refresh()} 由宿主每秒调；本页只在「榜单」面、并且距上次刷新 ≥10 s 时，
 * 把卡片右上角那句「算于 x 分钟前」重算一次 —— <b>不发任何请求</b>（榜单是 56 s 的慢接口，自动重算等于烧 CPU）。
 *
 * <p><b>滚动位置</b>：整页重建前记下 {@code ScrollView.getScrollY()}，重建后 {@code post} 回去，
 * 否则点一次「算一次」回来就被弹到顶部。
 */
final class IntimacyScreen extends Screen {

    private static final int FACET_LIST = 0;
    private static final int FACET_PERSON = 1;
    private static final int FACET_MOOD = 2;

    private static final String[] FACETS = {"榜单", "单查", "心情流水"};

    /** 榜单：全表扫 messages.sqlite，实测 56.7 s。 */
    private static final int LIST_TIMEOUT_MS = 90000;
    /** 单查：单个人，实测数秒级。 */
    private static final int PERSON_TIMEOUT_MS = 60000;
    /** 心情流水：实测 279 ms，给足余量。 */
    private static final int MOOD_TIMEOUT_MS = 12000;
    /** refresh() 的限流（宿主每秒调一次）。 */
    private static final int MIN_TICK_MS = 10000;

    private FrameLayout body;

    private ScrollView scrollView;
    private int scrollY;

    private int facet = FACET_LIST;

    // ---- 榜单 ----
    private Object listTree;
    private boolean listLoading;
    private String listError;
    private long listAt;

    // ---- 单查 ----
    private String personUin = "";
    private Object personTree;
    private boolean personLoading;
    private String personError;

    // ---- 心情流水 ----
    private Object moodTree;
    private boolean moodLoading;
    private String moodError;

    private long lastTickAt;

    IntimacyScreen(AppShell shell) {
        super(shell);
    }

    // ================================================================ 骨架

    @Override
    void build() {
        root.removeAllViews();
        body = new FrameLayout(activity);
        body.setClipChildren(false);
        body.setClipToPadding(false);
        root.addView(body, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        // 注意：这里**故意不取数**。榜单是 56 秒的接口，必须用户点一次；单查要等用户输入；
        // 心情流水等切到那一面再取（见 switchFacet）。
        render();
    }

    /** 宿主每秒调一次：只更新「算于 x 分钟前」这行小字，不发请求（限流 10 s，且只在榜单面）。 */
    @Override
    void refresh() {
        if (body == null || facet != FACET_LIST) return;
        if (listTree == null) return;
        long now = System.currentTimeMillis();
        if (now - lastTickAt < MIN_TICK_MS) return;
        lastTickAt = now;
        render();
    }

    // ================================================================ 取数（后台线程）

    /** 榜单：只有用户点按钮才会走到这里。 */
    private void loadList() {
        if (listLoading) return;
        listLoading = true;
        listError = null;
        render();
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/local/intimacy/list?limit=20",
                        LIST_TIMEOUT_MS);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        listLoading = false;
                        if (tree == null) {
                            listError = "读不到数据";
                        } else {
                            listTree = tree;
                            listAt = System.currentTimeMillis();
                        }
                        render();
                    }
                });
            }
        }, "intimacy-list");
        th.start();
    }

    /** 单查：uin 已经过 5~15 位数字校验。 */
    private void loadPerson(final String uin) {
        if (personLoading) return;
        personLoading = true;
        personError = null;
        personUin = uin;
        personTree = null;
        render();
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/local/intimacy/person?uin=" + uin,
                        PERSON_TIMEOUT_MS);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        personLoading = false;
                        if (tree == null) {
                            personError = "读不到数据";
                        } else if (!truthyOk(tree)) {
                            personError = "这个人没有互动记录";
                        } else {
                            personTree = tree;
                        }
                        render();
                    }
                });
            }
        }, "intimacy-person");
        th.start();
    }

    /** 心情流水：切到这一面且还没取过时取一次。 */
    private void loadMood() {
        if (moodLoading) return;
        moodLoading = true;
        moodError = null;
        render();
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                final Object tree = DashApi.json(activity, "api/local/mood/log?limit=30", MOOD_TIMEOUT_MS);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        moodLoading = false;
                        if (tree == null) {
                            moodError = "读不到数据";
                        } else {
                            moodTree = tree;
                        }
                        render();
                    }
                });
            }
        }, "intimacy-mood");
        th.start();
    }

    /** {@code ok} 缺省算成功（有的实现不回 ok）；明确 false 才算「没有这个人」。 */
    private static boolean truthyOk(Object tree) {
        Object ok = BotConfigJson.get(tree, "ok");
        if (ok == BotConfigJson.MISSING || ok == BotConfigJson.NULL) return true;
        return ModelsScreen.U.truthy(ok);
    }

    // ================================================================ 渲染

    private void render() {
        if (body == null) return;
        final int keepY = scrollView != null ? scrollView.getScrollY() : scrollY;
        scrollY = keepY;
        body.removeAllViews();
        ScrollView v = page();
        scrollView = v;
        body.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        if (keepY > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    v.scrollTo(0, keepY);
                }
            });
        }
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("亲密度"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "只读 · 运行端本地数据", Theme.T_CAP, t.textSecondary);
        col.addView(sub, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        LinearLayout bar = DashKit.facets(activity, t, FACETS, facet, new DashKit.OnFacet() {
            @Override
            public void onFacet(int index) {
                switchFacet(index);
            }
        });
        col.addView(bar, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        if (facet == FACET_LIST) {
            col.addView(listCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        } else if (facet == FACET_PERSON) {
            col.addView(personCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        } else {
            col.addView(moodCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    private void switchFacet(int index) {
        if (index == facet) return;
        facet = index;
        render();
        // 心情流水便宜（279 ms）且没有「点一次」的约定，切过来就取；失败也只显示一次「读不到数据」。
        if (facet == FACET_MOOD && moodTree == null && moodError == null && !moodLoading) {
            loadMood();
        }
    }

    // ---------------------------------------------------------------- 面 1：榜单

    private View listCard() {
        int n = listTree == null ? 0 : DashApi.size(BotConfigJson.get(listTree, "rows"));
        String right;
        if (listLoading) right = "计算中…";
        else if (listTree != null) right = (n + " 人上榜");
        else right = null;

        DashKit.Card c = DashKit.card(activity, t, "亲密度榜", right);

        if (listLoading) {
            c.body.addView(tipLine("正在扫全部消息，约 1 分钟…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (listError != null) {
            c.body.addView(tipLine(listError), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (listTree == null) {
            c.body.addView(tipLine("要点一次才算：约 1 分钟"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            List<Object> rows = BotConfigJson.asArray(BotConfigJson.get(listTree, "rows"));
            if (rows == null || rows.isEmpty()) {
                c.body.addView(tipLine("还没有够门槛的互动对象"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            } else {
                TextView at = tipLine("算于 " + DashApi.ago(listAt));
                c.body.addView(at, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
                int shown = Math.min(rows.size(), 20);
                for (int i = 0; i < shown; i++) {
                    Map<String, Object> r = BotConfigJson.asObject(rows.get(i));
                    if (r == null) continue;
                    if (i > 0) DashKit.divider(activity, t, c.body);
                    addRowOf(c.body, r);
                }
            }
        }

        TextView action = Ui.button(activity, t,
                listLoading ? "正在算…" : (listTree == null ? "算一次" : "重新算"), false);
        Ui.enabled(action, !listLoading);
        action.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!listLoading) loadList();
            }
        });
        c.body.addView(action, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    /** 一行：uin 当标题；副标题「score 分 · tier · 说 N 句 · 活跃 N 天」；右侧 rank。 */
    private void addRowOf(LinearLayout parent, Map<String, Object> r) {
        String uin = ModelsScreen.U.s(r.get("uin")).trim();
        String tier = ModelsScreen.U.s(r.get("tier")).trim();
        String score = numText(BotConfigJson.numOf(r.get("score")));
        String msgs = numText(BotConfigJson.numOf(r.get("messageCount")));
        String days = numText(BotConfigJson.numOf(r.get("activeDays")));
        String rank = numText(BotConfigJson.numOf(r.get("rank")));

        StringBuilder sub = new StringBuilder();
        sub.append(score).append(" 分");
        if (tier.length() > 0) sub.append(" · ").append(tier);
        sub.append(" · 说 ").append(msgs).append(" 句");
        sub.append(" · 活跃 ").append(days).append(" 天");

        DashKit.row(activity, t, parent, uin.length() == 0 ? "—" : uin, sub.toString(),
                "—".equals(rank) ? null : rank, false, null);
    }

    // ---------------------------------------------------------------- 面 2：单查

    private View personCard() {
        DashKit.Card c = DashKit.card(activity, t, "查一个人", personUin.length() == 0 ? null : personUin);

        DashKit.row(activity, t, c.body, "QQ 号",
                personUin.length() == 0 ? "点这里输入" : personUin, null, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        askUin();
                    }
                });

        if (personLoading) {
            c.body.addView(tipLine("读取中…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (personError != null) {
            c.body.addView(tipLine(personError), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (personTree != null) {
            Object info = BotConfigJson.get(personTree, "info");
            if (BotConfigJson.asObject(info) == null) info = personTree;
            DashKit.divider(activity, t, c.body);
            kv(c.body, "score", numText(BotConfigJson.numOf(BotConfigJson.get(info, "score"))));
            kv(c.body, "baseScore", numText(BotConfigJson.numOf(BotConfigJson.get(info, "baseScore"))));
            kv(c.body, "eventScore", numText(BotConfigJson.numOf(BotConfigJson.get(info, "eventScore"))));
            kv(c.body, "tier", ModelsScreen.U.s(BotConfigJson.get(info, "tier")).trim());
            String rank = numText(BotConfigJson.numOf(BotConfigJson.get(info, "rank")));
            String total = numText(BotConfigJson.numOf(BotConfigJson.get(info, "total")));
            kv(c.body, "rank", "—".equals(total) ? rank : (rank + " / " + total));
            kv(c.body, "total", total);
            kv(c.body, "messageCount",
                    numText(BotConfigJson.numOf(BotConfigJson.get(info, "messageCount"))));
        } else {
            c.body.addView(tipLine("输入 QQ 号查这一人的亲密度"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        return c.view;
    }

    /** 输入 QQ 号：数字键盘 + 5~15 位数字校验；通过后才在后台线程请求。 */
    private void askUin() {
        ModelsScreen.W.textDialog(activity, t, "查亲密度",
                "QQ 号 5~15 位数字", personUin, InputType.TYPE_CLASS_NUMBER, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.length() == 0) return "QQ 号不能为空";
                        if (text.length() < 5 || text.length() > 15) return "5~15 位数字";
                        for (int i = 0; i < text.length(); i++) {
                            char ch = text.charAt(i);
                            if (ch < '0' || ch > '9') return "只能填数字";
                        }
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        loadPerson(text.trim());
                    }
                });
    }

    // ---------------------------------------------------------------- 面 3：心情流水

    private View moodCard() {
        int n = moodTree == null ? 0 : DashApi.size(BotConfigJson.get(moodTree, "rows"));
        DashKit.Card c = DashKit.card(activity, t, "心情流水",
                moodLoading ? "读取中…" : (moodTree == null ? null : (n + " 条")));

        if (moodLoading) {
            c.body.addView(tipLine("读取中…"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (moodError != null) {
            c.body.addView(tipLine(moodError), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (moodTree == null) {
            c.body.addView(tipLine("还没有记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            List<Object> rows = BotConfigJson.asArray(BotConfigJson.get(moodTree, "rows"));
            if (rows == null || rows.isEmpty()) {
                c.body.addView(tipLine("还没有记录"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            } else {
                int shown = Math.min(rows.size(), 30);
                for (int i = 0; i < shown; i++) {
                    Map<String, Object> r = BotConfigJson.asObject(rows.get(i));
                    if (r == null) continue;
                    if (i > 0) DashKit.divider(activity, t, c.body);
                    DashKit.row(activity, t, c.body, moodTitle(r), moodSub(r), null, false, null);
                }
            }
        }

        if (moodError != null || moodTree != null) {
            TextView again = Ui.button(activity, t, "重新读取", false);
            Ui.enabled(again, !moodLoading);
            again.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (!moodLoading) loadMood();
                }
            });
            c.body.addView(again, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return c.view;
    }

    /** 标题：会话标签（群 123 / 私聊 456）；没有 scope/chatKey 时显示「全局」。 */
    private String moodTitle(Map<String, Object> r) {
        String key = ModelsScreen.U.s(r.get("scope")).trim();
        if (key.length() == 0) key = ModelsScreen.U.s(r.get("scopeKey")).trim();
        if (key.length() == 0) key = ModelsScreen.U.s(r.get("chatKey")).trim();
        if (key.length() == 0) return "全局";
        return DashKit.chatLabel(key);
    }

    /** 副标题：时间 + 最多 4 个标量字段（k=v）。总长压到 12 字以内的观感。 */
    private String moodSub(Map<String, Object> r) {
        StringBuilder sb = new StringBuilder();
        long ms = timeOf(r);
        if (ms > 0) sb.append(DashApi.when(ms));

        int used = 0;
        for (Map.Entry<String, Object> e : r.entrySet()) {
            if (used >= 4) break;
            String k = e.getKey();
            if (k == null || isMetaKey(k)) continue;
            Object v = e.getValue();
            if (v instanceof Map || v instanceof List) continue;
            if (v == BotConfigJson.NULL || v == BotConfigJson.MISSING) continue;
            String sv = DashKit.textOf(v);
            if (sv.length() == 0) continue;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(k).append('=').append(DashKit.cut(sv, 12));
            used++;
        }
        return sb.toString();
    }

    /** 时间戳字段在不同实现里叫法不一，按顺序取第一个能解析的。 */
    private static long timeOf(Map<String, Object> r) {
        String[] keys = {"ts", "at", "time", "createdAt", "updatedAt", "lastAt", "timestamp"};
        for (int i = 0; i < keys.length; i++) {
            double d = BotConfigJson.numOf(r.get(keys[i]));
            if (!Double.isNaN(d) && d > 0) return (long) d;
        }
        return 0;
    }

    /** 已经从时间 / 会话标签里用掉的键，不要再重复进「标量字段」。 */
    private static boolean isMetaKey(String k) {
        return "ts".equals(k) || "at".equals(k) || "time".equals(k) || "timestamp".equals(k)
                || "createdAt".equals(k) || "updatedAt".equals(k) || "lastAt".equals(k)
                || "scope".equals(k) || "scopeKey".equals(k) || "chatKey".equals(k)
                || "id".equals(k);
    }

    // ================================================================ 小工具

    private TextView tipLine(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }

    private void kv(LinearLayout parent, String k, String v) {
        DashKit.kv(activity, t, parent, k, v);
    }

    /** 数字 → 文本：整数不带小数点，小数留一位（分数可能是 72.5 这种）。 */
    private static String numText(double d) {
        if (Double.isNaN(d)) return "—";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return String.valueOf((long) d);
        return String.format(Locale.US, "%.1f", d);
    }

    private static LinearLayout.LayoutParams mt(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }
}
