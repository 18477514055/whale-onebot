package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 平台页（QQ）：<b>启动 + 配置</b>二分（产品规格 §5）。
 *
 * <p>两种形态，只按「这个平台上有没有机器人」二选一：
 * <ul>
 *   <li><b>有 QQ 机器人</b> ⇒ 状态卡 → <b>启动区</b>（启停容器 / QQ 登录 / 换一张码 /
 *       保存到相册 / 二维码）→ <b>配置区</b>（一行「配置」，点进该机器人的详情页）→ 运行日志；</li>
 *   <li><b>没有 QQ 机器人</b> ⇒ 空态：一句引导「还没有机器人，请先去 设置 → 机器人 → 新建机器人」
 *       + 主按钮「去新建机器人」→ {@link AppShell#pushBotList()}。</li>
 * </ul>
 *
 * <p><b>本页不再罗列机器人列表</b>（列表归「设置 → 机器人」）。这里只服务「这个平台上的
 * 那一个机器人」：多机器人共存时取该平台上的第一个（{@code forPlatform(qq).get(0)}）。
 *
 * <p>本页不写入场动画 —— 整页过渡只在 {@link AppShell#showScreen} 里发生。
 */
final class QqScreen extends Screen {

    private TextView statusText;
    private IconView statusDot;
    private TextView uinValue;
    private TextView startBtn;
    private TextView stopBtn;
    private TextView saveBtn;
    private QrPanel qr;

    private TextView logText;
    private ScrollView logScroll;

    /** 本页服务的机器人 id（没有 QQ 机器人时为 null）。 */
    private String qqBotId;

    private String lastStatus;
    private String lastUin;
    private String lastLog;

    QqScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        // 本页只负责「启动」：状态 / 启停 / 二维码 / 日志。
        // 层级（用户 2026-11-18 定）：主页 → QQ → 机器人名字 → 启动 / 配置 → 本页 / 配置页。
        // 配置不再混在这一页上 —— 以前那样看上去像「配置是启动的子项」，层级是错的。
        final BotRegistry.Bot bot = BotRegistry.get(shell.currentBotId());
        qqBotId = bot == null ? null : bot.id;
        final String name = (bot == null || bot.name == null || bot.name.length() == 0)
                ? "未命名机器人" : bot.name;
        final String title = bot == null ? "QQ 机器人" : name;

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header(title), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView crumb = Ui.text(activity, "主页 / QQ / " + (qqBotId == null ? "启动" : name + " / 启动"),
                Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S1);
        col.addView(crumb, clp);

        if (bot == null) {
            buildEmpty(col);
        } else {
            buildRootfsHint(col);
            buildStatusCard(col);
            buildStartArea(col);
            buildLogArea(col);
        }

        // 先把真实状态填一遍：否则状态区会先用默认文案显示一帧（最多 1 秒）才被 tick 刷新。
        refresh();
    }


    /**
     * 容器骨架缺了就直接说：读运行端写的 rootfs-state.json，只有 ready=false 时才显示一张卡。
     * 三种情况都不显示：文件不存在（老版本运行端）、ready=true、读取失败 —— 宁可不显示，也不误报。
     */
    private void buildRootfsHint(LinearLayout col) {
        java.io.File f = new java.io.File(activity.getFilesDir(), "rootfs-state.json");
        if (!f.isFile()) return;
        String text;
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            try (java.io.InputStream in = new java.io.FileInputStream(f)) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            }
            text = new String(bos.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return;
        }
        if (!text.contains("\"ready\":false")) return;
        String reason = "";
        int i = text.indexOf("\"reason\":\"");
        if (i >= 0) {
            int from = i + "\"reason\":\"".length();
            int to = text.indexOf('"', from);
            if (to > from) reason = text.substring(from, to);
        }

        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S3));
        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        box.addView(Ui.strong(activity, "容器骨架未就绪", Theme.T_CARD, t.textPrimary),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView body = Ui.text(activity, reason.length() > 0 ? reason : "缺少 rootfs.tar.gz",
                Theme.T_CAP, t.textSecondary);
        body.setLineSpacing(dp(3), 1f);
        box.addView(body, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        col.addView(card, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
    }

    // ---------------------------------------------------------------- 空态

    /**
     * 空态引导（规格 §2 / §5）：一句话说明该去哪儿，一个主按钮直接带过去。
     * 文案与产品规格逐字一致，别改词 —— 验收就是按这句看的。
     */
    private void buildEmpty(LinearLayout col) {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S4), dp(Theme.S4), dp(Theme.S4), dp(Theme.S4));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, IconView.CHAT, t.accent),
                new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER));
        box.addView(tile, Ui.llp(dp(52), dp(52)));

        TextView guide = Ui.text(activity,
                "还没有机器人，请先去 设置 → 机器人 → 新建机器人",
                Theme.T_BODY, t.textPrimary);
        guide.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams glp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        glp.topMargin = dp(Theme.S3);
        box.addView(guide, glp);

        TextView go = Ui.button(activity, t, "去新建机器人", true);
        go.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushBotList();
            }
        });
        LinearLayout.LayoutParams blp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        blp.topMargin = dp(Theme.S3);
        box.addView(go, blp);

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S4);
        col.addView(card, clp);
    }

    // ---------------------------------------------------------------- 状态卡

    /** 容器 / 登录两行事实。多机器人时这里是「这个平台当前那一个机器人」的状态。 */
    private void buildStatusCard(LinearLayout col) {
        FrameLayout statusCard = Ui.card(activity, t);
        LinearLayout sbox = Ui.column(activity);
        sbox.setPadding(dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2), dp(Theme.S3 + 2));

        LinearLayout line1 = Ui.row(activity);
        statusDot = new IconView(activity, IconView.DOT, t.textTertiary);
        line1.addView(statusDot, Ui.llp(dp(10), dp(10)));
        statusText = Ui.strong(activity, "读取中…", Theme.T_CARD, t.textPrimary);
        LinearLayout.LayoutParams stlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        stlp.leftMargin = dp(Theme.S1);
        line1.addView(statusText, stlp);
        sbox.addView(line1, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout line2 = Ui.row(activity);
        TextView label = Ui.text(activity, "登录账号", Theme.T_CAP, t.textSecondary);
        line2.addView(label, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        uinValue = Ui.mono(activity, Theme.T_BODY, t.textPrimary);
        uinValue.setText("—");
        LinearLayout.LayoutParams ulp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        ulp.leftMargin = dp(Theme.S2);
        line2.addView(uinValue, ulp);
        LinearLayout.LayoutParams l2lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        l2lp.topMargin = dp(Theme.S2);
        sbox.addView(line2, l2lp);

        statusCard.addView(sbox, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams sc = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        sc.topMargin = dp(Theme.S4);
        col.addView(statusCard, sc);
    }

    // ---------------------------------------------------------------- 启动区

    /** 启动区：启停容器 → 登录/换码 → 保存到相册 → 二维码。顺序就是用户实际操作的顺序。 */
    private void buildStartArea(LinearLayout col) {
        col.addView(sectionLabel("启动"), sectionLp());

        // 启停
        LinearLayout row1 = Ui.row(activity);
        startBtn = Ui.button(activity, t, "启动容器", false);
        startBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                host().startContainer();
                host().toast("正在启动容器");
            }
        });
        stopBtn = Ui.button(activity, t, "停止容器", false);
        stopBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                host().stopContainer();
                host().toast("正在停止容器");
            }
        });
        LinearLayout.LayoutParams s1 = Ui.llp(0, dp(Theme.TOUCH));
        s1.weight = 1f;
        row1.addView(startBtn, s1);
        LinearLayout.LayoutParams s2 = Ui.llp(0, dp(Theme.TOUCH));
        s2.weight = 1f;
        s2.leftMargin = dp(Theme.S2);
        row1.addView(stopBtn, s2);
        col.addView(row1, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 登录 / 换码
        LinearLayout row2 = Ui.row(activity);
        TextView loginBtn = Ui.button(activity, t, "QQ 登录", true);
        loginBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.requestQr();
                host().toast("已请求新二维码");
            }
        });
        TextView againBtn = Ui.button(activity, t, "换一张码", false);
        againBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.requestQr();
            }
        });
        LinearLayout.LayoutParams l1 = Ui.llp(0, dp(Theme.TOUCH));
        l1.weight = 1f;
        row2.addView(loginBtn, l1);
        LinearLayout.LayoutParams l2 = Ui.llp(0, dp(Theme.TOUCH));
        l2.weight = 1f;
        l2.leftMargin = dp(Theme.S2);
        row2.addView(againBtn, l2);
        LinearLayout.LayoutParams r2lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        r2lp.topMargin = dp(Theme.S2);
        col.addView(row2, r2lp);

        // 保存到相册
        saveBtn = Ui.button(activity, t, "保存到相册", false);
        saveBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                host().saveQrToAlbum();
            }
        });
        Ui.enabled(saveBtn, false);
        LinearLayout.LayoutParams svlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        svlp.topMargin = dp(Theme.S2);
        col.addView(saveBtn, svlp);

        // 二维码
        qr = new QrPanel(shell);
        LinearLayout.LayoutParams qlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        qlp.topMargin = dp(Theme.S4);
        col.addView(qr, qlp);
    }

    // ---------------------------------------------------------------- 配置入口（已移走）

    /*
     * 「配置」不再挂在这一页上：用户 2026-11-18 明确指出层级应为
     *   主页 → QQ 平台 → 机器人名字 → 启动 / 配置 → 启动页 / 配置页
     * 启动页里再出现「配置」会让人以为配置是启动的子项，所以入口统一收在上层
     * （{@link PlatformBotScreen}），这一页只留状态、启停、二维码、日志。
     */

    // ---------------------------------------------------------------- 日志

    /** 运行日志：诊断用，保持在页面最底部，不参与「启动 / 配置」的二分。 */
    private void buildLogArea(LinearLayout col) {
        FrameLayout logCard = new FrameLayout(activity);
        logCard.setBackground(Drawables.round(t.logFill, t.logStroke, dp(1), dp(Theme.R_PANEL)));
        Ui.elevate(logCard, 2f, t);
        logCard.setClipToOutline(true);

        LinearLayout lbox = Ui.column(activity);
        lbox.setPadding(dp(Theme.S2 + 2), dp(Theme.S2), dp(Theme.S2 + 2), dp(Theme.S2));

        LinearLayout lhead = Ui.row(activity);
        TextView ltitle = Ui.text(activity, "运行日志", Theme.T_CAP, Ui.alpha(t.logText, 0.75f));
        LinearLayout.LayoutParams lhw = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        lhead.addView(ltitle, lhw);
        TextView lcount = Ui.text(activity, "登录 30 · 容器 15", Theme.T_CAP,
                Ui.alpha(t.logText, 0.45f));
        lhead.addView(lcount, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        lbox.addView(lhead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        logScroll = new ScrollView(activity);
        logScroll.setVerticalScrollBarEnabled(false);
        logScroll.setClipChildren(false);
        logText = Ui.mono(activity, Theme.T_MONO, t.logText);
        logText.setText("（等待日志）");
        logScroll.addView(logText, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams lslp = Ui.llp(MATCH_PARENT, dp(150));
        lslp.topMargin = dp(Theme.S2);
        lbox.addView(logScroll, lslp);

        logCard.addView(lbox, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams lclp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lclp.topMargin = dp(Theme.S4);
        col.addView(logCard, lclp);
    }

    // ---------------------------------------------------------------- 小工具

    /** 分区标签：字距 + 加粗，与首页「平台」、详情页「配置」保持一致。 */
    private TextView sectionLabel(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setLetterSpacing(0.08f);
        return v;
    }

    private LinearLayout.LayoutParams sectionLp() {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S4);
        lp.bottomMargin = dp(Theme.S2);
        return lp;
    }

    // ---------------------------------------------------------------- 刷新

    @Override
    void refresh() {
        boolean running = host().containerRunning();
        String uin = host().loginUin();
        boolean logged = uin != null && uin.length() > 0;
        boolean live = host().qrLive();

        // 真实状态先喂给注册表：机器人层（详情页、列表页）都只读它。
        BotRegistry.report(BotRegistry.P_QQ, running, logged ? uin : null);

        // 空态：没有 QQ 机器人时本页只有引导卡，没有可刷新的控件。
        if (statusText == null) return;

        String status = running ? "容器运行中" : "容器已停止";
        if (!status.equals(lastStatus)) {
            statusText.setText(status);
            lastStatus = status;
        }
        int dotColor = !running ? t.textTertiary : (live ? t.accent : t.textSecondary);
        statusDot.setColor(dotColor);

        String u = logged ? uin : "未登录";
        if (!u.equals(lastUin)) {
            uinValue.setText(u);
            lastUin = u;
        }

        Ui.enabled(startBtn, !running);
        Ui.enabled(stopBtn, running);
        Ui.enabled(saveBtn, live);

        if (qr != null) qr.refresh();

        String logs = buildLogs();
        if (!logs.equals(lastLog)) {
            lastLog = logs;
            logText.setText(logs);
            if (logScroll != null) {
                logScroll.post(new Runnable() {
                    @Override
                    public void run() {
                        if (logScroll.getChildCount() > 0) {
                            logScroll.fullScroll(View.FOCUS_DOWN);
                        }
                    }
                });
            }
        }
    }

    private String buildLogs() {
        StringBuilder sb = new StringBuilder();
        sb.append("— 登录 —\n").append(tail(host().loginLog(30)));
        sb.append("\n— 容器 —\n").append(tail(host().containerLog(15)));
        return sb.toString();
    }

    private static String tail(String s) {
        if (s == null) return "（暂无日志）";
        String v = s.trim();
        return v.length() == 0 ? "（暂无日志）" : v;
    }
}
