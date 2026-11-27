package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 首页：四张平台卡纵排，只有 QQ 能进。左上角圆形钮进设置。
 *
 * <p>构图不是简单的顶部堆叠 —— 卡片组在页头与页脚之间垂直居中，
 * 配合错峰入场（60ms 间隔），读起来像一块「启动台」而不是一列列表。
 */
final class HomeScreen extends Screen {

    private final ArrayList<View> cards = new ArrayList<View>();

    private LinearLayout col;
    private final java.util.Map<String,TextView> platformCounts = new java.util.LinkedHashMap<>();
    private TextView qqAlertPill;
    private View fab;
    private LinearLayout devicePill;
    private View deviceDot;
    private TextView devicePillText;
    private TextView headerSub;
    private TextView footView;

    HomeScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        android.widget.ScrollView scroll = new android.widget.ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S2), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 界面顶端居中设备切换条形框（仅首页显示，对齐 Q5/Q6/Q7） ----------
        LinearLayout barWrap = Ui.row(activity);
        barWrap.setGravity(Gravity.CENTER);
        devicePill = Ui.row(activity);
        devicePill.setGravity(Gravity.CENTER_VERTICAL);
        devicePill.setPadding(dp(14), dp(7), dp(14), dp(7));
        devicePill.setClickable(true);
        devicePill.setFocusable(true);
        Ui.press(devicePill, 0.96f);

        deviceDot = new View(activity);
        LinearLayout.LayoutParams dotLp = Ui.llp(dp(8), dp(8));
        dotLp.rightMargin = dp(8);
        devicePill.addView(deviceDot, dotLp);

        devicePillText = Ui.strong(activity, "本机 ▾", Theme.T_CAP, t.textPrimary);
        devicePillText.setSingleLine(true);
        devicePillText.setEllipsize(android.text.TextUtils.TruncateAt.END);
        devicePillText.setMaxWidth(dp(260));
        devicePill.addView(devicePillText, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        devicePill.setOnClickListener(v -> showDeviceSwitcher());

        barWrap.addView(devicePill, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        LinearLayout.LayoutParams bwlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        bwlp.bottomMargin = dp(Theme.S2);
        col.addView(barWrap, bwlp);

        // ---------- 页头（左边 80dp 让给 FAB） ----------
        LinearLayout head = Ui.row(activity);
        head.setPadding(dp(80), 0, 0, 0);
        head.setMinimumHeight(dp(64));

        LinearLayout titleBox = Ui.column(activity);
        // 单行 + 自动缩放：系统字体放大 / 厂家字体偏宽时自动缩到放得下，
        // 绝不能出现 "WhaleOneBot" 被截成 "WhaleOneB"。
        TextView title = Ui.strong(activity, "WhaleOneBot", Theme.T_TITLE, t.textPrimary);
        title.setSingleLine(true);
        title.setAutoSizeTextTypeUniformWithConfiguration(
                15, Theme.T_TITLE, 1, TypedValue.COMPLEX_UNIT_SP);
        titleBox.addView(title);
        headerSub = Ui.text(activity, "本地容器 · 机器人控制台", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        slp.topMargin = dp(4);
        titleBox.addView(headerSub, slp);
        // 权重 1：标题块拿到「剩余的全部宽度」，宽度确定后 autosize 才能生效
        LinearLayout.LayoutParams boxLp = Ui.llp(0, WRAP_CONTENT);
        boxLp.weight = 1f;
        head.addView(titleBox, boxLp);
        col.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- 固定间距（不再用顶部弹性留白，卡片组贴着页头往下排） ----------
        col.addView(new View(activity), Ui.llp(MATCH_PARENT, dp(Theme.S3)));

        // ---------- 新手指引（第一次用才出现，点「知道了」或仅遥控模式可收起） ----------
        if (!Onboarding.seen(activity)) addGuide(col);

        // ---------- 分区标签 ----------
        TextView label = Ui.text(activity, "平台", Theme.T_CAP, t.textSecondary);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams labelLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        labelLp.bottomMargin = dp(Theme.S2);
        col.addView(label, labelLp);

        // ---------- 四张卡 ----------
        addCard(IconView.CHAT, BotRegistry.P_QQ, "QQ", null,
                Ui.alpha(t.accent, 0.16f), t.accent, false, null);
        addCard(IconView.MUSIC, BotRegistry.P_DOUYIN, "抖音", "短视频与互动",
                Ui.alpha(t.accent, 0.16f), t.accent, false, "测试版");
        addCard(IconView.TV, BotRegistry.P_BILIBILI, "bilibili", "查看本平台机器人",
                Ui.alpha(t.accent, 0.16f), t.accent, false, null);
        addCard(IconView.BOX, BotRegistry.P_XIAOHEIHE, "小黑盒", "游戏社区与战绩",
                Ui.alpha(t.textPrimary, 0.10f), Ui.alpha(t.textPrimary, 0.85f), true, null);

        // ---------- 余量全部放到卡片组下方，页脚仍然贴在底部 ----------
        col.addView(new View(activity), new LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f));

        footView = Ui.text(activity, "所有数据都留在本机", Theme.T_CAP, t.textTertiary);
        footView.setGravity(Gravity.CENTER);
        col.addView(footView, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- FAB（下移避开顶端居中条形框，与 WhaleOneBot 标题对齐） ----------
        fab = new Fab(activity, t);
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(dp(56), dp(56),
                Gravity.TOP | Gravity.START);
        flp.leftMargin = dp(Theme.S4);
        flp.topMargin = dp(52);
        fab.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.push(AppShell.P_SETTINGS);
            }
        });
        root.addView(fab, flp);
        updateDevicePill();
    }

    /** 一张平台卡：图标块 + 标题/可选角标/副标题 + 尾部（箭头或「敬请期待」角标）。 */
    private void addCard(int icon, final String platformId, String name, String staticSub,
                         int tileFill, int iconTint, boolean soon, String tagPill) {
        FrameLayout card = Ui.card(activity, t);

        LinearLayout row = Ui.row(activity);
        // 纵向 24、横向 24/16：卡片高 112dp，四张在首屏更有分量
        row.setPadding(dp(Theme.S4), dp(Theme.S4), dp(Theme.S3), dp(Theme.S4));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        // 图标块
        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(tileFill, 0, 0, dp(Theme.R_TILE)));
        IconView iv = new IconView(activity, icon, iconTint);
        tile.addView(iv, new FrameLayout.LayoutParams(dp(32), dp(32), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(64), dp(64)));

        // 文字块
        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);

        LinearLayout titleRow = Ui.row(activity);
        TextView title = Ui.strong(activity, name, Theme.T_CARD, t.textPrimary);
        titleRow.addView(title, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        if (tagPill != null && tagPill.length() > 0) {
            TextView pill = Ui.pill(activity, t, tagPill, Ui.TONE_WARN);
            LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(8);
            titleRow.addView(pill, plp);
        } else if (BotRegistry.P_QQ.equals(platformId)) {
            qqAlertPill = Ui.pill(activity, t, "", Ui.TONE_WARN);
            qqAlertPill.setVisibility(View.GONE);
            LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(8);
            titleRow.addView(qqAlertPill, plp);
        }
        box.addView(titleRow, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        LinearLayout subRow = Ui.row(activity);
        IconView dot = new IconView(activity, IconView.DOT,
                soon ? Ui.alpha(t.textTertiary, 0.55f) : t.textTertiary);
        subRow.addView(dot, Ui.llp(dp(8), dp(8)));
        TextView sub = Ui.text(activity, staticSub == null ? "读取中…" : staticSub,
                Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams sublp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        sublp.leftMargin = dp(6);
        subRow.addView(sub, sublp);
        LinearLayout.LayoutParams srlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        srlp.topMargin = dp(4);
        box.addView(subRow, srlp);

        row.addView(box, blp);

        if (soon) {
            TextView badge = Ui.text(activity, "敬请期待", Theme.T_CAP, t.toneStrong);
            badge.setTypeface(Typeface.DEFAULT_BOLD);
            badge.setLetterSpacing(0.02f);
            badge.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f),
                    Ui.alpha(t.accent, 0.30f), dp(1), dp(Theme.R_PILL)));
            badge.setPadding(dp(10), dp(5), dp(10), dp(5));
            row.addView(badge, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        } else {
            IconView chev = new IconView(activity, IconView.CHEV_R, t.textTertiary);
            row.addView(chev, Ui.llp(dp(20), dp(20)));
        }

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        if (soon) {
            card.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    host().toast("此平台尚未开放；可先配置 QQ、bilibili 或抖音（测试版）");
                }
            });
            card.setAlpha(0.62f); // 明确的「不可用」，但文字仍可读
        } else {
            card.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    shell.pushPlatformBots(platformId);
                }
            });
        }

        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        if (!cards.isEmpty()) clp.topMargin = dp(Theme.S2);
        col.addView(card, clp);
        cards.add(card);

        if (!soon) platformCounts.put(platformId, sub);
    }

        /**
     * 三步指引卡。
     *
     * <p>文案刻意只留三步动作、不解释原理 —— 第一个使用者的原话是「不知道该先做什么」。
     * 三步各自的状态来自 {@link SetupState}（只读本地事实）：做完的打勾并变淡，没做的用主色标出来，
     * 按钮直接指向「下一件要做的事」。三步全做完就不再出现 —— 不必让人点「知道了」才能清屏。
     */
    private void addGuide(LinearLayout parent) {
        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        SetupState.Steps st;
        if (rm != null && rm.isRemote()) {
            com.whaleonebot.remote.RemoteControlManager.RemoteSnapshot snap = rm.activeSnapshot();
            st = new SetupState.Steps(snap.setupEnv, snap.setupQq, snap.setupBot);
        } else {
            st = SetupState.read(activity.getFilesDir());
        }
        if (st.all()) return;

        LinearLayout card = Ui.column(activity);
        card.setBackground(Drawables.round(t.cardFill, t.accent, dp(1), dp(Theme.R_CARD)));
        int pad = dp(Theme.S3);
        card.setPadding(pad, pad, pad, pad);

        card.addView(Ui.strong(activity, "第一次用？一键向导 5 步开口说话", Theme.T_CARD, t.textPrimary));
        TextView progress = Ui.text(activity, "当前准备进度 " + st.done() + " / 3 · 全程点「下一步」即可完成",
                Theme.T_CAP, st.done() == 0 ? t.textSecondary : t.accent);
        LinearLayout.LayoutParams plp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        plp.topMargin = dp(Theme.S1);
        card.addView(progress, plp);

        LinearLayout steps = Ui.column(activity);
        LinearLayout.LayoutParams stepsLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        stepsLp.topMargin = dp(Theme.S2);
        card.addView(steps, stepsLp);
        steps.addView(stepLine("1", "自动准备运行环境与内置核心（免折腾底层）", st.env));
        steps.addView(stepLine("2", "自动拉取并安装 QQ 客户端", st.qq));
        steps.addView(stepLine("3", "填模型 Key → 登录账号 → 选首批群聊开口", st.bot));

        LinearLayout actions = Ui.row(activity);
        TextView go = Ui.button(activity, t, "开始一键部署向导", true);
        go.setOnClickListener(v -> shell.pushDeployWizard());
        TextView ok = Ui.button(activity, t, "稍后再说", false);
        ok.setOnClickListener(v -> {
            Onboarding.markSeen(activity);
            root.removeAllViews();
            cards.clear();
            platformCounts.clear();
            build();
        });
        LinearLayout.LayoutParams goLp = Ui.llp(0, dp(Theme.TOUCH));
        goLp.weight = 1f;
        actions.addView(go, goLp);
        LinearLayout.LayoutParams okLp = Ui.llp(0, dp(Theme.TOUCH));
        okLp.weight = 1f;
        okLp.leftMargin = dp(Theme.S2);
        actions.addView(ok, okLp);
        LinearLayout.LayoutParams alp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        alp.topMargin = dp(Theme.S2);
        card.addView(actions, alp);

        // Q3 纯遥控模式：主力机不装本机容器/QQ，一键扫码直连远端备用机
        if (rm == null || !rm.isRemote()) {
            TextView remoteOnly = Ui.button(activity, t, "仅当遥控器 · 扫码控制其他设备", false);
            remoteOnly.setOnClickListener(v -> {
                Onboarding.markSeen(activity);
                shell.pushQrScan();
            });
            LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
            rlp.topMargin = dp(Theme.S2);
            card.addView(remoteOnly, rlp);
        }

        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.bottomMargin = dp(Theme.S3);
        parent.addView(card, lp);
    }

    /** 刷新顶部居中条形框视觉（对齐 Q6：本机绿点白胶囊；远程带主题色细描边高亮防误操作）。 */
    private void updateDevicePill() {
        if (devicePill == null || deviceDot == null || devicePillText == null) return;
        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        if (rm == null || !rm.isRemote()) {
            int okGreen = t.dark ? 0xFF34D399 : 0xFF16A34A;
            devicePill.setBackground(Drawables.round(t.cardFill, t.cardStroke, dp(1), dp(Theme.R_PILL)));
            deviceDot.setBackground(Drawables.circle(okGreen, 0, 0));
            String label = "本机 ▾";
            if (!label.contentEquals(devicePillText.getText())) devicePillText.setText(label);
            devicePillText.setTextColor(t.textPrimary);
            if (headerSub != null) headerSub.setText("本地容器 · 机器人控制台");
            if (footView != null) footView.setText("所有数据都留在本机");
            return;
        }
        com.whaleonebot.remote.RemoteStore.PairedPeer peer = rm.activePeer();
        com.whaleonebot.remote.RemoteControlManager.PeerStatus st = rm.statusOf(rm.activePeerId());
        String name = peer == null ? "远端设备" : peer.displayName();
        boolean connected = st != null && st.state == com.whaleonebot.remote.RemoteControlManager.ConnState.CONNECTED;
        String ch = (st != null && !st.channelLabel.isEmpty()) ? st.channelLabel : "P2P";
        String pillLabel = connected
                ? ("远程：" + name + "（" + ch + "）▾")
                : ("远程：" + name + "（重连中…）▾");
        int warnColor = t.dark ? 0xFFF5B762 : 0xFFB45309;
        int stroke = connected ? t.accent : warnColor;
        devicePill.setBackground(Drawables.round(t.cardFill, stroke, dp(1.5f), dp(Theme.R_PILL)));
        deviceDot.setBackground(Drawables.circle(connected ? t.accent : warnColor, 0, 0));
        if (!pillLabel.contentEquals(devicePillText.getText())) devicePillText.setText(pillLabel);
        devicePillText.setTextColor(connected ? t.toneStrong : warnColor);
        if (headerSub != null) {
            headerSub.setText("远程完全控制 · " + (st == null ? "连接中…" : st.summaryText()));
        }
        if (footView != null) {
            footView.setText("端到端加密连接 · 所有操作将执行在「" + name + "」上");
        }
    }

    /** 点击顶部条形框弹出统一 PromptSheet 设备切换与配对面板（对齐 Q7）。 */
    private void showDeviceSwitcher() {
        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.get(activity);
        final java.util.List<com.whaleonebot.remote.RemoteStore.PairedPeer> peers = rm.store().listPeers();
        String activeId = rm.activePeerId();

        LinearLayout box = Ui.column(activity);

        // 本机项
        boolean localActive = (activeId == null);
        int okGreen = t.dark ? 0xFF34D399 : 0xFF16A34A;
        int warnColor = t.dark ? 0xFFF5B762 : 0xFFB45309;
        LinearLayout localRow = buildDeviceRow(
                "本机（" + rm.store().identity().deviceName + "）",
                "本地容器与数据",
                okGreen,
                localActive,
                null
        );
        box.addView(localRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final android.app.Dialog[] holder = new android.app.Dialog[1];
        localRow.setOnClickListener(v -> {
            if (holder[0] != null) holder[0].dismiss();
            if (!localActive) shell.switchTargetDevice(null);
        });

        for (final com.whaleonebot.remote.RemoteStore.PairedPeer peer : peers) {
            box.addView(Ui.divider(activity, t));
            com.whaleonebot.remote.RemoteControlManager.PeerStatus st = rm.statusOf(peer.deviceId);
            boolean online = st != null && st.state == com.whaleonebot.remote.RemoteControlManager.ConnState.CONNECTED;
            boolean active = peer.deviceId.equals(activeId);
            LinearLayout r = buildDeviceRow(
                    peer.displayName(),
                    st == null ? "探测中…" : st.summaryText(),
                    online ? t.accent : warnColor,
                    active,
                    v -> {
                        if (holder[0] != null) holder[0].dismiss();
                        shell.pushRemoteDevices(false);
                    }
            );
            r.setOnClickListener(v -> {
                if (holder[0] != null) holder[0].dismiss();
                if (!active) shell.switchTargetDevice(peer.deviceId);
                else if (!online) {
                    rm.reconnectNow(peer.deviceId);
                    host().toast("正在重连 " + peer.displayName());
                }
            });
            box.addView(r, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        if (peers.isEmpty()) {
            TextView empty = Ui.text(activity, "尚未配对远端设备，扫另一台手机的配对码即可无服务器直连。",
                    Theme.T_CAP, t.textTertiary);
            LinearLayout.LayoutParams elp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            elp.topMargin = dp(Theme.S2);
            box.addView(empty, elp);
        }

        holder[0] = PromptSheet.custom(
                activity, t, "选择控制设备", box,
                "扫码配对新设备", (d, btn) -> {
                    d.dismiss();
                    shell.pushQrScan();
                },
                "让别的设备控制本机（配对码）", (d, btn) -> {
                    d.dismiss();
                    shell.pushRemoteDevices(true);
                },
                "取消", (d, btn) -> d.dismiss(),
                false, false, null, null
        );
    }

    private LinearLayout buildDeviceRow(String title, String sub, int dotColor, boolean active,
                                        View.OnClickListener manageClick) {
        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S2), dp(10), dp(Theme.S2), dp(10));
        row.setClickable(true);
        row.setFocusable(true);
        if (active) {
            row.setBackground(Drawables.round(Ui.alpha(t.accent, 0.12f), t.accent, dp(1), dp(Theme.R_BTN)));
        }
        View dot = new View(activity);
        dot.setBackground(Drawables.circle(dotColor, 0, 0));
        LinearLayout.LayoutParams dlp = Ui.llp(dp(10), dp(10));
        dlp.rightMargin = dp(10);
        row.addView(dot, dlp);

        LinearLayout textCol = Ui.column(activity);
        textCol.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
        textCol.addView(Ui.text(activity, sub, Theme.T_CAP, t.textSecondary));
        LinearLayout.LayoutParams tclp = Ui.llp(0, WRAP_CONTENT);
        tclp.weight = 1f;
        row.addView(textCol, tclp);

        if (active) {
            row.addView(Ui.pill(activity, t, "当前", Ui.TONE_OK), Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        } else if (manageClick != null) {
            TextView m = Ui.pill(activity, t, "管理", Ui.TONE_NEUTRAL);
            m.setClickable(true);
            m.setOnClickListener(manageClick);
            row.addView(m, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        }
        return row;
    }

    /** 一行分步：做完的打勾并变淡，没做的用正文色 —— 一眼看得出「下一步在哪」。 */
    private TextView stepLine(String no, String text, boolean done) {
        TextView line = Ui.text(activity, (done ? "✓ " : "○ ") + no + ". " + text,
                Theme.T_BODY, done ? t.textTertiary : t.textPrimary);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S1);
        line.setLayoutParams(lp);
        return line;
    }

    @Override
    void onAttach() {
        // 错峰入场：60ms 间隔，320ms 进程，translateY 16dp。
        // 参数集中在 Motion 里 —— 页面的入场动效不再各写一套（见 Motion 的说明）。
        Motion.stagger(cards, 60L, 320L, dp(16));
        Motion.popIn(fab, 40L, 260L, 0.86f);
    }

    @Override
    void refresh() {
        updateDevicePill();
        for (java.util.Map.Entry<String,TextView> entry : platformCounts.entrySet()) {
            String sub = BotRegistry.forPlatform(entry.getKey()).size() + " 台机器人";
            if (!sub.contentEquals(entry.getValue().getText())) entry.getValue().setText(sub);
        }
        if (qqAlertPill != null) {
            boolean contRun = host().containerRunning();
            QqAuthState st = host().qqAuthState();
            boolean showAlert = contRun && (st.isOfflineAlert() || "degraded".equals(st.phase));
            if (showAlert) {
                String badge = st.shortBadge(true);
                if (!badge.contentEquals(qqAlertPill.getText())) qqAlertPill.setText(badge);
                qqAlertPill.setBackground(Drawables.round(0x28D9534F, 0xA8D9534F, dp(1), dp(Theme.R_PILL)));
                qqAlertPill.setTextColor(t.dark ? 0xFFFF8A80 : 0xFFC62828);
                qqAlertPill.setVisibility(View.VISIBLE);
            } else {
                qqAlertPill.setVisibility(View.GONE);
            }
        }
    }
}
