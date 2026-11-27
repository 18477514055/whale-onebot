package com.whaleonebot.ui;

import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板子页：「机器人与协议端 / 控制」那一面 —— <b>纯只读</b>。
 *
 * <p>对应作者控制台 {@code pages/status.js} 的观测能力，数据全部走 {@link DashApi}：
 * <ul>
 *   <li>{@code api/status} —— 15 s。协议端连通/心跳/最后事件、暂停、编排器（模式/运行中/活跃/并发上限/模型）、版本。
 *       实测 5.2 s、6 KB，是本页唯一"慢"的接口。</li>
 *   <li>{@code api/host} —— 8 s。主机名/平台/CPU/运行时长（顶层标量；{@code mem}、{@code disk}、
 *       {@code process}、{@code loadavg} 是对象/数组，按契约跳过）。</li>
 *   <li>{@code api/auto-update/status} —— 8 s。<b>顶层标量逐条显示</b>，不硬编码键名
 *       （自更新的键集在不同运行端版本上并不稳定）。</li>
 *   <li>{@code api/time-control/status} —— 8 s。顶层标量（时区/现在）+ {@code global} 里的标量。</li>
 *   <li>{@code api/humanize/state} —— 8 s。标量逐条（布尔显示 是/否）。</li>
 *   <li>{@code api/health} —— 8 s。顶层标量 + {@code health} 里的标量。</li>
 * </ul>
 *
 * <p><b>线程</b>：六个请求在同一个后台线程里依次发，回来只做<b>一次</b>
 * {@code activity.runOnUiThread} 回填 —— UI 线程一次网络都不发，也不会六个线程抢着重建页面。
 *
 * <p><b>刷新</b>：{@link #refresh()} 由宿主每秒调；只有距上次取数 ≥15 s 且这一次读到了数据时
 * 才重新取（读不到就<b>只重画、不自动重试</b>，避免对着停掉的运行端每 15 秒敲一次）。
 *
 * <p><b>滚动位置</b>：整页重建前记下 {@code ScrollView.getScrollY()}，重建后 {@code post} 回去，
 * 否则每 15 秒的自动刷新都会把用户弹回顶部。
 */
final class ControlScreen extends Screen {

    /** api/status 实测 5.2 s，给足余量。 */
    private static final int T_STATUS = 15000;
    /** 其余都是几十毫秒的接口。 */
    private static final int T_PLAIN = 8000;
    /** refresh() 的限流（宿主每秒调一次）。 */
    private static final int MIN_INTERVAL_MS = 15000;

    /** 键名 → 中文标签；表里没有的键原样显示（不硬编码不存在的键）。 */
    private static final Map<String, String> LABELS = new HashMap<String, String>();
    /** 值本来就是会话键（{@code group:xxx}）的字段。 */
    private static final String[] CHAT_KEYS = {"chatKey", "scopeKey", "scope"};
    /** 值是毫秒时间戳的字段（后缀 {@code At} 的一并算）。 */
    private static final String[] TIME_KEYS = {"at", "now", "ts", "time"};

    static {
        LABELS.put("ok", "状态");
        LABELS.put("at", "时间");
        LABELS.put("now", "现在");
        LABELS.put("ts", "时间");
        LABELS.put("timeZone", "时区");
        LABELS.put("hostname", "主机名");
        LABELS.put("platform", "平台");
        LABELS.put("cpuCount", "CPU 核");
        LABELS.put("cpuModel", "CPU 型号");
        LABELS.put("uptimeSec", "运行时长");
        LABELS.put("host", "主机");
        LABELS.put("mem", "内存");
        LABELS.put("disk", "磁盘");
        LABELS.put("process", "进程");
        LABELS.put("enabled", "启用");
        LABELS.put("active", "生效");
        LABELS.put("injected", "已注入");
        LABELS.put("cardFirst", "卡片优先");
        LABELS.put("respectPersonaCard", "尊重人设卡");
        LABELS.put("personaStateEnabled", "人设状态");
        LABELS.put("key", "键");
        LABELS.put("persona", "人设");
        LABELS.put("chatKey", "会话");
        LABELS.put("healthy", "健康");
        LABELS.put("lastRunAt", "最近一次");
        LABELS.put("lastResults", "最近结果");
        LABELS.put("streaks", "连续记录");
        LABELS.put("source", "来源");
        LABELS.put("nextChangeAt", "下次切换");
        LABELS.put("nextActiveAt", "下次生效");
        LABELS.put("global", "全局");
        LABELS.put("chats", "会话");
        LABELS.put("paused", "暂停");
        LABELS.put("pauseReason", "暂停原因");
        LABELS.put("mode", "模式");
        LABELS.put("error", "错误");
        LABELS.put("available", "有更新");
        LABELS.put("running", "运行中");
        LABELS.put("phase", "阶段");
        LABELS.put("progress", "进度");
        LABELS.put("version", "版本");
        LABELS.put("build", "构建");
        LABELS.put("checkedAt", "检查于");
        LABELS.put("installedVersion", "已装版本");
        LABELS.put("latestVersion", "最新版本");
        LABELS.put("currentVersion", "当前版本");
        LABELS.put("auto", "自动");
        LABELS.put("intervalMin", "间隔(分)");
        LABELS.put("lastResult", "最近结果");
    }

    private FrameLayout host;
    private ScrollView scrollView;
    private int scrollY;

    private Object statusTree;
    private Object hostTree;
    private Object updateTree;
    private Object timeTree;
    private Object humanizeTree;
    private Object healthTree;

    private boolean fetching;
    private long fetchedAt;
    private long lastLoadAt;

    ControlScreen(AppShell shell) {
        super(shell);
    }

    // ================================================================ 骨架

    @Override
    void build() {
        root.removeAllViews();
        host = new FrameLayout(activity);
        host.setClipChildren(false);
        host.setClipToPadding(false);
        root.addView(host, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        render();
        loadAll();
    }

    @Override
    void onAttach() {
        if (statusTree == null && !fetching) loadAll();
    }

    /** 宿主每秒调一次：≥15 s 才重取；上一次读不到就只重画，不自动重试。 */
    @Override
    void refresh() {
        if (host == null || fetching) return;
        if (System.currentTimeMillis() - lastLoadAt < MIN_INTERVAL_MS) return;
        if (statusTree == null) {
            render();
            return;
        }
        loadAll();
    }

    // ================================================================ 取数（后台线程）

    private void loadAll() {
        if (fetching) return;
        fetching = true;
        lastLoadAt = System.currentTimeMillis();
        render();
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                // 六个接口在**同一个**后台线程里顺次取：不并发轰控制台，回来也只重建一次页面。
                final Object st = DashApi.json(activity, "api/status", T_STATUS);
                final Object ho = DashApi.json(activity, "api/host", T_PLAIN);
                final Object au = DashApi.json(activity, "api/auto-update/status", T_PLAIN);
                final Object tc = DashApi.json(activity, "api/time-control/status", T_PLAIN);
                final Object hu = DashApi.json(activity, "api/humanize/state", T_PLAIN);
                final Object he = DashApi.json(activity, "api/health", T_PLAIN);
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        fetching = false;
                        if (host == null) return;
                        // 失败就保留上一次的值：卡片自己显示「读不到数据」，不整页清空。
                        if (st != null) {
                            statusTree = st;
                            fetchedAt = System.currentTimeMillis();
                        }
                        if (ho != null) hostTree = ho;
                        if (au != null) updateTree = au;
                        if (tc != null) timeTree = tc;
                        if (hu != null) humanizeTree = hu;
                        if (he != null) healthTree = he;
                        render();
                    }
                });
            }
        }, "dm-control");
        th.setDaemon(true);
        th.start();
    }

    // ================================================================ 渲染

    private void render() {
        if (host == null) return;
        final int keepY = scrollView != null ? scrollView.getScrollY() : scrollY;
        scrollY = keepY;
        host.removeAllViews();
        ScrollView v = page();
        scrollView = v;
        host.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        if (keepY > 0) {
            v.post(new Runnable() {
                @Override
                public void run() {
                    if (scrollView != null) scrollView.scrollTo(0, keepY);
                }
            });
        }
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("控制"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity,
                statusTree == null ? (fetching ? "读取中…" : "读不到数据")
                        : "更新于 " + DashApi.ago(fetchedAt),
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        col.addView(statusCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(scalarCard("主机", hostTree, hostRight(), null),
                mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(scalarCard("自更新", updateTree, null, null),
                mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(scalarCard("时间控制", timeTree, timeRight(), "global"),
                mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(scalarCard("人类化", humanizeTree, null, null),
                mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(scalarCard("健康", healthTree, null, "health"),
                mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (statusTree == null && !fetching) {
            TextView retry = Ui.button(activity, t, "重新读取", false);
            retry.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (!fetching) loadAll();
                }
            });
            col.addView(retry, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }

        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        return DashKit.scroll(activity, col);
    }

    // ---------------------------------------------------------------- 卡 1：运行状态

    private View statusCard() {
        boolean connected = ModelsScreen.U.truthy(BotConfigJson.get(statusTree, "onebot.connected"));
        boolean contRun = host().containerRunning();
        QqAuthState qqAuth = host().qqAuthState();
        boolean qqUpstreamDown = contRun && (qqAuth.isMsfDisconnected()
                || "degraded".equals(qqAuth.phase)
                || qqAuth.isOfflineAlert());
        boolean trulyOnline = connected && !qqUpstreamDown;
        String cardBadge = statusTree == null ? null
                : (trulyOnline ? "在线" : (connected && qqUpstreamDown ? "上游断开" : "离线"));
        DashKit.Card c = DashKit.card(activity, t, "运行状态", cardBadge);
        if (statusTree == null) {
            c.body.addView(tip(fetching ? "读取中…" : "读不到数据"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return c.view;
        }

        Object ob = BotConfigJson.get(statusTree, "onebot");
        Object or = BotConfigJson.get(statusTree, "orchestrator");
        boolean paused = ModelsScreen.U.truthy(BotConfigJson.get(statusTree, "paused"));
        String pauseReason = DashApi.str(statusTree, "pauseReason");
        String obError = DashApi.str(ob, "error");

        DashKit.kv(activity, t, c.body, "协议端",
                trulyOnline ? "在线" : (connected && qqUpstreamDown ? "上游断开（本机 WS 已连）" : "离线"));
        if (contRun) {
            DashKit.kv(activity, t, c.body, "QQ 通道", qqAuth.shortBadge(true));
        }
        DashKit.kv(activity, t, c.body, "心跳", DashApi.ago((long) DashApi.num(ob, "lastHeartbeatAt")));
        DashKit.kv(activity, t, c.body, "最后事件", DashApi.ago((long) DashApi.num(ob, "lastEventAt")));
        DashKit.kv(activity, t, c.body, "协议错误", obError.length() == 0 ? "无" : DashKit.cut(obError, 40));
        DashKit.kv(activity, t, c.body, "暂停", paused ? "是" : "否");
        if (paused || pauseReason.length() > 0) {
            DashKit.kv(activity, t, c.body, "暂停原因",
                    pauseReason.length() == 0 ? "—" : DashKit.cut(pauseReason, 40));
        }
        String mode = DashApi.str(or, "mode");
        DashKit.kv(activity, t, c.body, "编排", mode.length() == 0 ? "—" : mode);
        DashKit.kv(activity, t, c.body, "运行中", countText(BotConfigJson.get(or, "running")));
        DashKit.kv(activity, t, c.body, "活跃会话", countText(BotConfigJson.get(or, "activeSessions")));
        DashKit.kv(activity, t, c.body, "并发上限", numText(DashApi.num(or, "maxConcurrentRuns")));
        String model = DashApi.str(or, "model");
        DashKit.kv(activity, t, c.body, "模型", model.length() == 0 ? "—" : model);
        String version = DashApi.str(statusTree, "version");
        DashKit.kv(activity, t, c.body, "版本", version.length() == 0 ? "—" : version);
        return c.view;
    }

    /** 「主机」卡的右侧小字：主机名（太长就截断）。 */
    private String hostRight() {
        String hn = DashApi.str(hostTree, "hostname");
        return hn.length() == 0 ? null : DashKit.cut(hn, 12);
    }

    /** 时间控制：卡片右侧显示时区（比「时区」那一行更显眼）。 */
    private String timeRight() {
        String tz = DashApi.str(timeTree, "timeZone");
        return tz.length() == 0 ? null : tz;
    }

    // ---------------------------------------------------------------- 卡 2~6：通用标量

    /**
     * 一张「对象里的标量逐条 kv」的卡，供主机 / 自更新 / 时间控制 / 人类化 / 健康复用。
     *
     * @param wrapper 非空时，把该子对象（如 {@code global}、{@code health}）里的标量也展开成行
     */
    private View scalarCard(String title, Object tree, String right, String wrapper) {
        DashKit.Card c = DashKit.card(activity, t, title, tree == null ? null : right);
        if (tree == null) {
            c.body.addView(tip(fetching ? "读取中…" : "读不到数据"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            return c.view;
        }
        scalars(c.body, tree);
        if (wrapper != null) {
            Object inner = BotConfigJson.get(tree, wrapper);
            if (BotConfigJson.asObject(inner) != null) {
                DashKit.divider(activity, t, c.body);
                scalars(c.body, inner);
            }
        }
        return c.view;
    }

    /** 对象里的标量字段逐条 kv；对象/数组跳过（契约口径）。键名不认识就原样显示。 */
    private void scalars(LinearLayout parent, Object tree) {
        Map<String, Object> m = BotConfigJson.asObject(tree);
        if (m == null) return;
        int shown = 0;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            String k = e.getKey();
            if (k == null) continue;
            Object v = e.getValue();
            if (v instanceof Map || v instanceof List) continue;
            String label = LABELS.get(k);
            DashKit.kv(activity, t, parent, label == null ? k : label, valueText(k, v));
            shown++;
        }
        if (shown == 0) DashKit.kv(activity, t, parent, "字段", "没有可显示的标量");
    }

    /**
     * 标量值 → 短文本：布尔写 是/否，时间戳写本地时间，{@code …Sec} 写时长，
     * {@code …Percent} 写百分数，过大的数用 k/M 缩写，其余照原样（截断）。
     */
    private static String valueText(String key, Object v) {
        if (v instanceof Boolean) return ((Boolean) v).booleanValue() ? "是" : "否";
        String raw = ModelsScreen.U.s(v).trim();
        if (raw.length() == 0) return "—";
        if (isChatKey(key)) return DashKit.chatLabel(raw);

        double d = BotConfigJson.numOf(v);
        if (!Double.isNaN(d)) {
            if (isTimeKey(key)) {
                if (d <= 0) return "—";
                if (d > 1e11) return DashApi.when((long) d);
                return raw;
            }
            if (key.endsWith("Sec")) return duration((long) d);
            if (key.endsWith("Percent") || key.endsWith("Pct")) {
                return String.format(Locale.US, "%.1f%%", d);
            }
            if (Math.abs(d) >= 100000) return DashKit.km(d);
        }
        return DashKit.cut(raw, 40);
    }

    private static boolean isChatKey(String k) {
        for (int i = 0; i < CHAT_KEYS.length; i++) {
            if (CHAT_KEYS[i].equals(k)) return true;
        }
        return false;
    }

    private static boolean isTimeKey(String k) {
        for (int i = 0; i < TIME_KEYS.length; i++) {
            if (TIME_KEYS[i].equals(k)) return true;
        }
        return k.endsWith("At");
    }

    // ================================================================ 小工具

    /** 数组 → 条数；布尔 → 是/否；其余照原样。 */
    private static String countText(Object v) {
        List<Object> list = BotConfigJson.asArray(v);
        if (list != null) return String.valueOf(list.size());
        if (v instanceof Boolean) return ((Boolean) v).booleanValue() ? "是" : "否";
        String s = ModelsScreen.U.s(v).trim();
        return s.length() == 0 ? "—" : s;
    }

    /** 数字 → 文本：整数不带小数点。 */
    private static String numText(double d) {
        if (Double.isNaN(d)) return "—";
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return String.valueOf((long) d);
        return String.format(Locale.US, "%.1f", d);
    }

    /** 秒 → 「1 天 2 小时」这类短时长。 */
    private static String duration(long sec) {
        if (sec <= 0) return "—";
        long d = sec / 86400;
        long h = (sec % 86400) / 3600;
        long m = (sec % 3600) / 60;
        if (d > 0) return d + " 天 " + h + " 小时";
        if (h > 0) return h + " 小时 " + m + " 分";
        return m + " 分钟";
    }

    private TextView tip(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setLineSpacing(dp(3), 1f);
        return v;
    }

    private static LinearLayout.LayoutParams mt(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }
}
