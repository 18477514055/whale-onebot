package com.whaleonebot.ui;

import android.app.Activity;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 「看板」第一页：**总览**（实时状态 / 心情精力 / 今日用量 / 存储）。
 *
 * <p>数据全部来自运行端自带控制台（容器内 {@code 127.0.0.1:<server.port>}，默认 41907）的**只读**接口，
 * 不经过我们协议端、不改任何配置：
 * <ul>
 *   <li>{@code GET /api/status} —— 连接、编排器、今日用量、预算、缓存命中、存储（一次拿全，几十 KB）</li>
 *   <li>{@code GET /api/local/mood/overview} —— 心情 / 精力（全局 + 分群局部偏移）</li>
 *   <li>{@code GET /api/local/intimacy/list} —— 亲密度榜（**很慢，实测 56.7 秒**，所以只在用户点「算一次」时请求）</li>
 * </ul>
 *
 * <p><b>鉴权</b>：控制台无令牌时 {@code authorize()} 只放行「远端是回环 + Host 头是 127.0.0.1」，
 * 所以每个请求都显式写 {@code Host: 127.0.0.1:<port>}（与 {@code MainActivity.requestAgentConfigReload} 同口径）。
 *
 * <p><b>刷新</b>：{@link #refresh()} 由宿主每秒调一次；本页自己限流到 {@link #MIN_INTERVAL_MS}，
 * 且请求全在后台线程，UI 线程只做渲染，绝不阻塞。
 */
final class DashboardScreen extends Screen {

    /** 自动刷新间隔（毫秒）。控制台无令牌时是轮询，太频繁会占 CPU。 */
    private static final int MIN_INTERVAL_MS = 5000;
    /** 单次请求超时。 */
    private static final int HTTP_TIMEOUT_MS = 6000;
    /** 亲密度榜单要扫 messages.sqlite，实测 56.7 s ⇒ 单独给 90 s。 */
    private static final int INTIMACY_TIMEOUT_MS = 90000;

    private FrameLayout body;

    /** 当前那次渲染的滚动容器与位置：自动刷新会整页重建，必须把用户滚动到的位置还原。 */
    private ScrollView scrollView;
    private int scrollY;

    private int consolePort;
    private String portError;

    /** 最近一次成功拿到的树；null = 还没拿到。 */
    private Object status;
    private Object mood;
    /** 全部失败时的原因（连着上一条成功数据时不清空，避免闪回空白）。 */
    private String error;

    private long lastFetchAt;
    private boolean fetching;

    private long fetchedAt;

    /** 亲密度榜：null = 没算过；空树 = 算过但没结果。 */
    private Object intimacy;
    private boolean intimacyLoading;
    private String intimacyError;

    DashboardScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        body = new FrameLayout(activity);
        body.setClipChildren(false);
        body.setClipToPadding(false);
        root.addView(body, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        consolePort = resolveConsolePort();
        render();
        fetch();
    }

    @Override
    void onAttach() {
        if (consolePort == 0) consolePort = resolveConsolePort();
        if (status == null && !fetching) fetch();
        else if (System.currentTimeMillis() - lastFetchAt > MIN_INTERVAL_MS && !fetching) fetch();
    }

    /** 宿主每秒调一次；这里只做限流 + 触发后台刷新。 */
    @Override
    void refresh() {
        if (fetching) return;
        if (System.currentTimeMillis() - lastFetchAt < MIN_INTERVAL_MS) return;
        fetch();
    }

    // ================================================================ 取数

    /** 控制台端口：读容器里的 config.json 的 {@code server.port}；读不到就用 41907。 */
    private int resolveConsolePort() {
        portError = null;
        String text = readText(agentConfigFile());
        if (text == null) {
            portError = "读不到运行端配置（容器没起过？）";
            return 41907;
        }
        int p = ModelsScreen.U.consolePortOf(text);
        if (p <= 0) {
            portError = "配置里没有 server.port";
            return 41907;
        }
        return p;
    }

    private File agentConfigFile() {
        return new File(activity.getFilesDir(), "rootfs/agent/data/config.json");
    }

    private void fetch() {
        if (fetching) return;
        fetching = true;
        lastFetchAt = System.currentTimeMillis();
        final int port = consolePort;
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                String s1 = Api.get(port, "/api/status", HTTP_TIMEOUT_MS);
                String s2 = Api.get(port, "/api/local/mood/overview", HTTP_TIMEOUT_MS);
                final Object st = parseOrNull(s1);
                final Object md = parseOrNull(s2);
                final String err = st == null
                        ? (s1 == null ? "连不上运行端控制台（机器人没在跑？）" : "控制台返回的不是 JSON")
                        : null;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        fetching = false;
                        if (st != null) {
                            status = st;
                            fetchedAt = System.currentTimeMillis();
                        }
                        if (md != null) mood = md;
                        error = err;
                        render();
                    }
                });
            }
        }, "dashboard");
        th.setDaemon(true);
        th.start();
    }

    /** 亲密度榜：只在用户点的时候算，结果留在本页。 */
    private void loadIntimacy() {
        if (intimacyLoading) return;
        intimacyLoading = true;
        intimacyError = null;
        render();
        final int port = consolePort;
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                String s = Api.get(port, "/api/local/intimacy/list?limit=10", INTIMACY_TIMEOUT_MS);
                final Object tree = parseOrNull(s);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        intimacyLoading = false;
                        if (tree == null) {
                            intimacyError = s == null
                                    ? "算不出来（超时或机器人没在跑）" : "控制台返回的不是 JSON";
                        } else {
                            intimacy = tree;
                        }
                        render();
                    }
                });
            }
        }, "dashboard-intimacy");
        th.setDaemon(true);
        th.start();
    }

    private static Object parseOrNull(String json) {
        if (json == null) return null;
        try {
            Object v = BotConfigJson.parse(json);
            return BotConfigJson.asObject(v) == null ? null : v;
        } catch (Throwable th) {
            return null;
        }
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
            // 重建后立刻把位置还原：否则每 5 秒自动刷新都会把用户弹回顶部。
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
        col.addView(header("看板"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "运行端只读状态", Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        if (status == null) {
            col.addView(stateCard(error == null ? "读取中…" : error),
                    marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        } else {
            col.addView(liveCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
            col.addView(moodCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            col.addView(usageCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            col.addView(storageCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
            col.addView(intimacyCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        col.addView(footCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    private static final class Card {
        final FrameLayout view;
        final LinearLayout body;

        Card(FrameLayout view, LinearLayout body) {
            this.view = view;
            this.body = body;
        }
    }

    private Card card(String title, String right) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = ModelsScreen.W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout head = Ui.row(activity);
        TextView titleView = Ui.strong(activity, title, Theme.T_CARD, t.textPrimary);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        tlp.weight = 1f;
        head.addView(titleView, tlp);
        if (right != null && right.length() > 0) {
            TextView r = Ui.text(activity, right, Theme.T_CAP, t.textSecondary);
            r.setSingleLine(true);
            head.addView(r, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        }
        box.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout holder = Ui.column(activity);
        box.addView(holder, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return new Card(card, holder);
    }

    private static LinearLayout.LayoutParams marginTop(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    private View stateCard(String text) {
        Card c = card("状态", null);
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        c.body.addView(v, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        return c.view;
    }

    // ---------------------------------------------------------------- 实时

    private View liveCard() {
        Object onebot = BotConfigJson.get(status, "onebot");
        boolean connected = ModelsScreen.U.truthy(BotConfigJson.get(onebot, "connected"));
        long lastEvent = (long) BotConfigJson.numOf(BotConfigJson.get(onebot, "lastEventAt"));
        long lastBeat = (long) BotConfigJson.numOf(BotConfigJson.get(onebot, "lastHeartbeatAt"));
        String onebotError = ModelsScreen.U.s(BotConfigJson.get(onebot, "error")).trim();
        boolean paused = ModelsScreen.U.truthy(BotConfigJson.get(status, "paused"));
        String mode = ModelsScreen.U.s(BotConfigJson.get(status, "orchestrator.mode")).trim();
        String model = ModelsScreen.U.s(BotConfigJson.get(status, "orchestrator.model")).trim();
        int sessions = sizeOf(BotConfigJson.get(status, "orchestrator.activeSessions"));
        int running = sizeOf(BotConfigJson.get(status, "orchestrator.running"));

        Card c = card("实时", connected ? "在线" : "离线");
        addRow(c.body, "连接", connected ? "在线" : (onebotError.length() > 0 ? onebotError : "离线"));
        addRow(c.body, "心跳", ago(lastBeat));
        addRow(c.body, "最后事件", ago(lastEvent));
        addRow(c.body, "模型", model.length() == 0 ? "未设置" : model);
        addRow(c.body, "会话", "进行中 " + running + " · 活跃 " + sessions);
        addRow(c.body, "编排", paused ? "已暂停" : (mode.length() == 0 ? "运行中" : mode));
        return c.view;
    }

    // ---------------------------------------------------------------- 心情 / 精力

    private View moodCard() {
        Card c = card("心情 / 精力", null);
        double moodV = BotConfigJson.numOf(BotConfigJson.get(mood, "global.mood"));
        double energyV = BotConfigJson.numOf(BotConfigJson.get(mood, "global.energy"));
        boolean sleeping = ModelsScreen.U.truthy(BotConfigJson.get(mood, "global.sleeping"));

        if (Double.isNaN(moodV)) {
            TextView v = Ui.text(activity, "拿不到心情数据", Theme.T_CAP, t.textSecondary);
            c.body.addView(v, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return c.view;
        }

        c.body.addView(bar("心情", moodV, sleeping ? "睡觉中" : tierOf(moodV)),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        c.body.addView(bar("精力", energyV, ""),
                marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 分群偏移：只有 local 真的偏离 0 才值得列（本机实测各群都是 0 ⇒ 与全局一致）
        List<Object> scopes = BotConfigJson.asArray(BotConfigJson.get(mood, "scopes"));
        int deviated = 0;
        StringBuilder sb = new StringBuilder();
        if (scopes != null) {
            for (int i = 0; i < scopes.size(); i++) {
                Map<String, Object> s = BotConfigJson.asObject(scopes.get(i));
                if (s == null) continue;
                double lm = BotConfigJson.numOf(BotConfigJson.get(s, "local.mood"));
                double le = BotConfigJson.numOf(BotConfigJson.get(s, "local.energy"));
                if ((Double.isNaN(lm) || Math.abs(lm) < 0.05) && (Double.isNaN(le) || Math.abs(le) < 0.05)) {
                    continue;
                }
                if (deviated > 0) sb.append('\n');
                String key = ModelsScreen.U.s(s.get("scope"));
                sb.append(shortChat(key)).append("  ")
                        .append(sign(lm)).append(" 心情 / ").append(sign(le)).append(" 精力");
                deviated++;
            }
        }
        TextView note = Ui.text(activity,
                deviated > 0 ? sb.toString() : "各群与全局一致", Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        c.body.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    /** 一行进度条：左边名字、右边值 + 说明，下面一条细条（0~100）。 */
    private View bar(String label, double value, String tail) {
        LinearLayout col = Ui.column(activity);

        LinearLayout head = Ui.row(activity);
        TextView name = Ui.text(activity, label, Theme.T_BODY, t.textPrimary);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        nlp.weight = 1f;
        head.addView(name, nlp);
        String text = String.format(java.util.Locale.US, "%.0f", value)
                + (tail == null || tail.length() == 0 ? "" : " · " + tail);
        head.addView(Ui.text(activity, text, Theme.T_CAP, t.textSecondary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        col.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        double pct = Math.max(0, Math.min(100, value));
        LinearLayout track = Ui.row(activity);
        track.setBackground(Drawables.round(Ui.alpha(t.textPrimary, 0.10f), 0, 0, dp(3)));
        LinearLayout.LayoutParams trackLp = Ui.llp(MATCH_PARENT, dp(6));
        trackLp.topMargin = dp(Theme.S1);

        LinearLayout fill = Ui.row(activity);
        fill.setBackground(Drawables.round(pct >= 60 ? t.accent : Ui.alpha(t.accent, 0.75f),
                0, 0, dp(3)));
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(0, MATCH_PARENT);
        flp.weight = (float) Math.max(0.02, pct / 100f);
        track.addView(fill, flp);
        LinearLayout.LayoutParams restLp = new LinearLayout.LayoutParams(0, MATCH_PARENT);
        restLp.weight = (float) Math.max(0.0001, 1 - pct / 100f);
        track.addView(new View(activity), restLp);

        col.addView(track, trackLp);
        return col;
    }

    private static String tierOf(double mood) {
        if (mood >= 70) return "很好";
        if (mood >= 58) return "不错";
        if (mood >= 43) return "一般";
        if (mood >= 32) return "偏低";
        return "很差";
    }

    private static String sign(double v) {
        if (Double.isNaN(v)) return "0";
        return (v > 0 ? "+" : "") + String.format(java.util.Locale.US, "%.0f", v);
    }

    // ---------------------------------------------------------------- 用量

    private View usageCard() {
        Card c = card("今日用量", ModelsScreen.U.s(BotConfigJson.get(status, "usage.dayKey")));
        long total = (long) BotConfigJson.numOf(BotConfigJson.get(status, "usage.totalTokens"));
        long cached = (long) BotConfigJson.numOf(BotConfigJson.get(status, "usage.cachedTokens"));
        long prompt = (long) BotConfigJson.numOf(BotConfigJson.get(status, "usage.promptTokens"));
        long completion = (long) BotConfigJson.numOf(BotConfigJson.get(status, "usage.completionTokens"));
        long runs = (long) BotConfigJson.numOf(BotConfigJson.get(status, "usage.runs"));
        double yuan = BotConfigJson.numOf(BotConfigJson.get(status, "usage.estimatedYuan"));
        double hit = BotConfigJson.numOf(BotConfigJson.get(status, "cacheHitRate"));
        boolean budgetOn = ModelsScreen.U.truthy(BotConfigJson.get(status, "budget.enabled"));
        double limit = BotConfigJson.numOf(BotConfigJson.get(status, "budget.limitYuan"));

        addRow(c.body, "总额", humanTokens(total)
                + "（上行 " + humanTokens(prompt) + " / 下行 " + humanTokens(completion) + "）");
        addRow(c.body, "缓存命中", Double.isNaN(hit) ? "—" : String.format(java.util.Locale.US, "%.0f%%", hit * 100)
                + " · 复用 " + humanTokens(cached));
        addRow(c.body, "调用", runs + " 次");
        addRow(c.body, "花费", Double.isNaN(yuan) ? "—" : "¥" + String.format(java.util.Locale.US, "%.2f", yuan)
                + (budgetOn ? " / 预算 ¥" + String.format(java.util.Locale.US, "%.0f", limit) : "（未设预算）"));
        return c.view;
    }

    // ---------------------------------------------------------------- 存储

    private View storageCard() {
        Card c = card("存储", null);
        long files = (long) BotConfigJson.numOf(BotConfigJson.get(status, "storage.files"));
        long bytes = (long) BotConfigJson.numOf(BotConfigJson.get(status, "storage.bytes"));
        long maxBytes = (long) BotConfigJson.numOf(BotConfigJson.get(status, "storage.maxTotalBytes"));
        String version = ModelsScreen.U.s(BotConfigJson.get(status, "version")).trim();
        addRow(c.body, "数据", humanBytes(bytes) + " · " + files + " 个文件");
        addRow(c.body, "上限", maxBytes > 0 ? humanBytes(maxBytes) : "未设");
        addRow(c.body, "运行端", version.length() == 0 ? "未知" : version);
        return c.view;
    }

    // ---------------------------------------------------------------- 亲密度

    private View intimacyCard() {
        Card c = card("亲密度", intimacyLoading ? "计算中…" : null);

        if (intimacy == null && intimacyError == null) {
            TextView tip = Ui.text(activity, "要点一次才算：会扫全部消息，约 1 分钟", Theme.T_CAP, t.textSecondary);
            tip.setLineSpacing(dp(3), 1f);
            c.body.addView(tip, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else if (intimacyError != null) {
            TextView tip = Ui.text(activity, intimacyError, Theme.T_CAP, t.textSecondary);
            tip.setLineSpacing(dp(3), 1f);
            c.body.addView(tip, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            List<Object> rows = BotConfigJson.asArray(BotConfigJson.get(intimacy, "rows"));
            int n = rows == null ? 0 : Math.min(rows.size(), 10);
            if (n == 0) {
                TextView tip = Ui.text(activity, "还没有够门槛的互动对象", Theme.T_CAP, t.textSecondary);
                c.body.addView(tip, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
            for (int i = 0; i < n; i++) {
                Map<String, Object> r = BotConfigJson.asObject(rows.get(i));
                if (r == null) continue;
                if (i > 0) c.body.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
                String uin = ModelsScreen.U.s(r.get("uin")).trim();
                double score = BotConfigJson.numOf(r.get("score"));
                String tier = ModelsScreen.U.s(r.get("tier")).trim();
                long msgs = (long) BotConfigJson.numOf(r.get("messageCount"));
                addRow(c.body, uin, Math.round(score) + " 分 · " + tier + " · " + msgs + " 句");
            }
        }

        TextView action = Ui.button(activity, t,
                intimacyLoading ? "正在算…" : (intimacy == null ? "算一次" : "重新算"), false);
        action.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!intimacyLoading) loadIntimacy();
            }
        });
        c.body.addView(action, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    // ---------------------------------------------------------------- 页脚

    private View footCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = ModelsScreen.W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout row = Ui.row(activity);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        tlp.weight = 1f;
        row.addView(Ui.text(activity,
                fetchedAt == 0 ? "还没更新" : "更新于 " + ago(fetchedAt),
                Theme.T_CAP, t.textTertiary), tlp);

        TextView again = Ui.button(activity, t, "刷新", false);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!fetching) {
                    lastFetchAt = 0;
                    fetch();
                }
            }
        });
        row.addView(again, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        box.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    // ---------------------------------------------------------------- 小件

    private void addRow(LinearLayout parent, String title, String value) {
        LinearLayout row = Ui.row(activity);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));

        LinearLayout txt = Ui.column(activity);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        tlp.weight = 1f;
        tlp.rightMargin = dp(Theme.S2);
        txt.addView(Ui.text(activity, title, Theme.T_CAP, t.textSecondary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView v = Ui.text(activity, value == null ? "—" : value, Theme.T_BODY, t.textPrimary);
        v.setSingleLine(true);
        v.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams vlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        vlp.topMargin = dp(2);
        txt.addView(v, vlp);
        row.addView(txt, tlp);
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private static int sizeOf(Object v) {
        List<Object> list = BotConfigJson.asArray(v);
        return list == null ? 0 : list.size();
    }

    private static String shortChat(String key) {
        String k = key == null ? "" : key.trim();
        int i = k.indexOf(':');
        return i >= 0 ? k.substring(i + 1) : k;
    }

    private static String humanTokens(long n) {
        if (n < 1000) return String.valueOf(n);
        if (n < 1000000) return String.format(java.util.Locale.US, "%.1fk", n / 1000.0);
        return String.format(java.util.Locale.US, "%.2fM", n / 1000000.0);
    }

    private static String humanBytes(long n) {
        if (n < 1024) return n + " B";
        double kb = n / 1024.0;
        if (kb < 1024) return String.format(java.util.Locale.US, "%.0f KB", kb);
        double mb = kb / 1024.0;
        if (mb < 1024) return String.format(java.util.Locale.US, "%.1f MB", mb);
        return String.format(java.util.Locale.US, "%.2f GB", mb / 1024.0);
    }

    private static String ago(long ms) {
        if (ms <= 0) return "—";
        long d = System.currentTimeMillis() - ms;
        if (d < 0) d = 0;
        long s = d / 1000;
        if (s < 60) return s + " 秒前";
        long m = s / 60;
        if (m < 60) return m + " 分钟前";
        long h = m / 60;
        if (h < 24) return h + " 小时前";
        return (h / 24) + " 天前";
    }

    private static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            String s = new String(out.toByteArray(), "UTF-8");
            return s.length() > 0 && s.charAt(0) == '\uFEFF' ? s.substring(1) : s;
        } catch (Throwable th) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 关不掉不影响已读到的内容
                }
            }
        }
    }

    // ================================================================ HTTP（只读）

    /**
     * 控制台只读 GET。以后「会话监控 / 注入与推理 / 记忆」这些页也用这一个入口 ——
     * 鉴权口径（Host 头）只在这里写一次，别在各页各写一份。
     */
    static final class Api {

        private Api() {
        }

        /** @return 响应正文；连不上 / 非 200 / 超时都返回 null（调用方自己决定怎么提示）。 */
        static String get(int port, String path, int timeoutMs) {
            if (port <= 0) return null;
            HttpURLConnection c = null;
            try {
                URL url = new URL("http://127.0.0.1:" + port + path);
                c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod("GET");
                c.setConnectTimeout(timeoutMs);
                c.setReadTimeout(timeoutMs);
                c.setUseCaches(false);
                c.setRequestProperty("Accept", "application/json");
                try {
                    c.setRequestProperty("Host", "127.0.0.1:" + port);
                } catch (Throwable ignored) {
                    // Host 是受保护头：个别实现会拒绝，拒了就用默认值（本来就是它）
                }
                int code = c.getResponseCode();
                if (code != 200) {
                    closeQuietly(c.getErrorStream());
                    return null;
                }
                return readAll(c.getInputStream());
            } catch (Throwable th) {
                return null;
            } finally {
                if (c != null) {
                    try {
                        c.disconnect();
                    } catch (Throwable ignored) {
                        // 同上
                    }
                }
            }
        }

        private static String readAll(InputStream in) throws Exception {
            if (in == null) return null;
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    bos.write(buf, 0, n);
                    if (bos.size() > 4 * 1024 * 1024) break;
                }
                return new String(bos.toByteArray(), "UTF-8");
            } finally {
                closeQuietly(in);
            }
        }

        private static void closeQuietly(InputStream in) {
            if (in == null) return;
            try {
                in.close();
            } catch (Throwable ignored) {
                // 连接马上回收
            }
        }
    }
}
