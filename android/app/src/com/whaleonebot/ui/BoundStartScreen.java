package com.whaleonebot.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.QqCredentialVault;

import org.json.JSONArray;
import org.json.JSONObject;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] QQ 启动与多通道上线页（2026-11-27 全面重做，对齐问答报告 Q6/Q7/Q10/Q11/Q12）：
 * <ol>
 *   <li>顶部「连接健康与掉线原因卡」：容器 / QQ 原生连接 / 运行端三态 + 人话掉线原因 + 设备指纹简报 +
 *       「温和唤醒重连」与「安全下线 / 切换账号 / 强制重新登录」三分立操作；</li>
 *   <li>中部「多通道上线卡」（离线自动展开、在线自动折叠）：
 *       - 触发滑块/新设备 verifyUrl 时高亮弹出「打开内置安全验证页」（支持远程主力机滑完回传票据）；
 *       - 通道 A：一键拉起手机 QQ 授权（免截图）+ 远程/本地实时高清按需扫码（绝不后台循环刷码）；
 *       - 通道 B：账密登录（wrapper.node 原生 passwordLogin + 被控机 Keystore 加密可选记住密码 + 一键重登）；</li>
 *   <li>底部「实时运行诊断日志卡」：直接展示真实 bot.log + container.log。</li>
 * </ol>
 */
final class BoundStartScreen extends Screen {

    private final BotRegistry.Bot bot;
    private final boolean dashboard;

    // 顶部健康卡引用
    private TextView healthPill;
    private TextView healthDetail;
    private TextView healthMeta;
    private TextView status;
    private TextView startBtn;
    private TextView stopBtn;
    private TextView restartQqBtn;
    private TextView wakeBtn;
    private String previous;

    // 多通道上线卡
    private LinearLayout loginCard;
    private TextView loginFoldBtn;
    private LinearLayout loginBody;
    private LinearLayout verifyBanner;
    private TextView verifyBtn;
    private TextView tabQrBtn;
    private TextView tabPwdBtn;
    private LinearLayout qrChannelPane;
    private LinearLayout pwdChannelPane;
    private TextView reqQrBtn;
    private TextView copyQrUrlBtn;
    private TextView saveBtn;
    private QrPanel qr;

    // 账密通道引用
    private LinearLayout savedCredBox;
    private TextView savedCredLabel;
    private TextView savedLoginBtn;
    private EditText etUin;
    private EditText etPwd;
    private CheckBox cbRemember;

    // 实时日志
    private TextView logText;
    private ScrollView logScroll;
    private String lastLog;

    private int activeTab = 0; // 0 = 一键拉起 QQ / 按需扫码, 1 = 账密登录
    private boolean manualExpandWhenOnline = false;
    private String lastVerifyUrlPrompted = "";
    private String lastHealthSig = "";

    BoundStartScreen(AppShell shell, BotRegistry.Bot bot, boolean dashboard) {
        super(shell);
        this.bot = bot;
        this.dashboard = dashboard;
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll);

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col);
        col.addView(header(bot == null ? "找不到机器人" : bot.name + (dashboard ? " · QQ 看板" : " · QQ")));
        if (bot == null) return;

        // ---------------- 1. 顶部连接健康与掉线原因卡 ----------------
        LinearLayout healthCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout hRow = Ui.row(activity);
        hRow.addView(Ui.strong(activity, "QQ 连接健康", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        healthPill = Ui.pill(activity, t, "检测中…", Ui.TONE_NEUTRAL);
        hRow.addView(healthPill, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        healthCard.addView(hRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        healthDetail = Ui.text(activity, "正在读取容器与 QQ 原生状态…", Theme.T_BODY, t.textSecondary);
        healthCard.addView(healthDetail, topMargin(dp(Theme.S2)));

        healthMeta = Ui.text(activity, "", Theme.T_CAP, t.textTertiary);
        healthCard.addView(healthMeta, topMargin(dp(4)));

        healthCard.addView(Ui.divider(activity, t));
        status = Ui.text(activity, "读取绑定状态…", Theme.T_CAP, t.textSecondary);
        healthCard.addView(status, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (dashboard) {
            refresh();
            return;
        }

        // 容器启停 + 双级重启 + 温和重连 + 会话管理菜单
        LinearLayout ctrlRow = Ui.row(activity);
        startBtn = Ui.button(activity, t, "启动容器", false);
        startBtn.setOnClickListener(v -> {
            host().startContainer();
            host().toast("正在启动容器");
        });
        stopBtn = Ui.button(activity, t, "停止容器", false);
        stopBtn.setOnClickListener(v -> {
            host().stopContainer();
            host().toast("正在停止容器");
        });
        restartQqBtn = Ui.button(activity, t, "热重连 QQ", true);
        restartQqBtn.setOnClickListener(v -> confirmProxyIfHijacked(() -> {
            RemoteBridge.hotReconnectQq(activity);
            host().toast("正在进程内热重连 QQ（不断容器、不影响 B 站与 Agent）");
        }));
        ctrlRow.addView(startBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        sLp.leftMargin = dp(Theme.S1);
        ctrlRow.addView(stopBtn, sLp);
        LinearLayout.LayoutParams rLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        rLp.leftMargin = dp(Theme.S1);
        ctrlRow.addView(restartQqBtn, rLp);
        healthCard.addView(ctrlRow, topMargin(dp(Theme.S3)));

        LinearLayout sessRow = Ui.row(activity);
        wakeBtn = Ui.button(activity, t, "仅重启 QQ 进程", false);
        wakeBtn.setOnClickListener(v -> confirmProxyIfHijacked(() -> host().restartQqOnly()));
        TextView manageSessBtn = Ui.button(activity, t, "下线 / 换号 / 健康中心", false);
        manageSessBtn.setOnClickListener(v -> openSessionActionsSheet());
        sessRow.addView(wakeBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams mLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        mLp.leftMargin = dp(Theme.S2);
        sessRow.addView(manageSessBtn, mLp);
        healthCard.addView(sessRow, topMargin(dp(Theme.S2)));

        // ---------------- 2. 登录通道 ----------------
        col.addView(sectionLabel("QQ 登录"), sectionLp());
        loginCard = Ui.addCard(col, activity, t, 0);

        loginFoldBtn = Ui.button(activity, t, "当前已在线 · 展开重新登录选项", false);
        loginFoldBtn.setOnClickListener(v -> {
            manualExpandWhenOnline = !manualExpandWhenOnline;
            syncOnlineCollapse(host().qqAuthState());
        });
        loginFoldBtn.setVisibility(View.GONE);
        loginCard.addView(loginFoldBtn, Ui.llp(MATCH_PARENT, dp(Theme.TOUCH)));

        loginBody = Ui.column(activity);
        loginCard.addView(loginBody, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 滑块 / 新设备验证高亮区（仅 verify-required 时显示）
        verifyBanner = Ui.column(activity);
        verifyBanner.setBackground(Drawables.round(
                Ui.alpha(t.accent, t.dark ? 0.22f : 0.12f), t.accent, dp(1.2f), dp(Theme.R_BTN)));
        verifyBanner.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S3), dp(Theme.S2));
        verifyBanner.addView(Ui.strong(activity, "需要完成腾讯安全滑块 / 新设备验证", Theme.T_BODY, t.toneStrong));
        verifyBanner.addView(Ui.text(activity,
                "将在当前手机（含远程主力机）弹出官方验证页，完成后自动回传票据继续登录。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        verifyBtn = Ui.button(activity, t, "立即打开安全验证页", true);
        verifyBtn.setOnClickListener(v -> openVerifyWebView(host().qqAuthState().verifyUrl));
        verifyBanner.addView(verifyBtn, topMargin(dp(Theme.S2)));
        verifyBanner.setVisibility(View.GONE);
        loginBody.addView(verifyBanner, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 分段切换按钮：通道 A（按需扫码） vs 通道 B（账密登录）
        LinearLayout tabs = Ui.row(activity);
        tabQrBtn = tabChip("扫码登录", activeTab == 0);
        tabQrBtn.setOnClickListener(v -> {
            activeTab = 0;
            syncTabs();
        });
        tabPwdBtn = tabChip("账密登录（免扫码）", activeTab == 1);
        tabPwdBtn.setOnClickListener(v -> {
            activeTab = 1;
            syncTabs();
        });
        tabs.addView(tabQrBtn, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams t2Lp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        t2Lp.leftMargin = dp(Theme.S2);
        tabs.addView(tabPwdBtn, t2Lp);
        loginBody.addView(tabs, topMargin(dp(Theme.S2)));

        // ---- 通道 A：按需扫码 ----
        qrChannelPane = Ui.column(activity);

        reqQrBtn = Ui.button(activity, t, "获取二维码", true);
        reqQrBtn.setOnClickListener(v -> {
            if (RemoteBridge.qqClientVersion(activity) == null) {
                host().toast("容器里还没有 QQ：先去「环境配置」装 QQ 安装包，回来再登录");
                shell.pushEnv();
                return;
            }
            confirmProxyIfHijacked(() -> shell.requestQr());
        });
        qrChannelPane.addView(reqQrBtn, topMargin(dp(Theme.S2)));

        LinearLayout qrAux = Ui.row(activity);
        copyQrUrlBtn = Ui.button(activity, t, "复制授权链接", false);
        copyQrUrlBtn.setOnClickListener(v -> copyQrUrl());
        Ui.enabled(copyQrUrlBtn, false);
        saveBtn = Ui.button(activity, t, "保存二维码到相册", false);
        saveBtn.setOnClickListener(v -> host().saveQrToAlbum());
        Ui.enabled(saveBtn, false);
        qrAux.addView(copyQrUrlBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams svLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        svLp.leftMargin = dp(Theme.S2);
        qrAux.addView(saveBtn, svLp);
        qrChannelPane.addView(qrAux, topMargin(dp(Theme.S2)));

        qr = new QrPanel(shell);
        qrChannelPane.addView(qr, topMargin(dp(Theme.S3)));
        loginBody.addView(qrChannelPane, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---- 通道 B：账密登录 + 被控机加密记住密码 + 一键重登 ----
        pwdChannelPane = Ui.column(activity);
        savedCredBox = Ui.column(activity);
        savedCredBox.setBackground(Drawables.round(t.ghostFill, t.accent, dp(1), dp(Theme.R_BTN)));
        savedCredBox.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S3), dp(Theme.S2));
        savedCredLabel = Ui.strong(activity, "", Theme.T_BODY, t.textPrimary);
        savedCredBox.addView(savedCredLabel, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        savedCredBox.addView(Ui.text(activity,
                "密码仅以 Android Keystore AES-GCM 加密保存在运行机器人的设备本地，绝不自动偷偷重登。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        LinearLayout savedBtns = Ui.row(activity);
        savedLoginBtn = Ui.button(activity, t, "一键账密重登", true);
        savedLoginBtn.setOnClickListener(v -> host().quickSavedPasswordLogin());
        TextView forgetBtn = Ui.button(activity, t, "清除记住的密码", false);
        forgetBtn.setOnClickListener(v -> PromptSheet.showConfirm(
                activity, "清除记住的加密密码？",
                "仅删除被控机 Keystore 加密保存的 QQ 密码，不影响机器人数据与当前在线态。",
                "清除", () -> host().forgetSavedPassword(), "取消"));
        savedBtns.addView(savedLoginBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1.2f));
        LinearLayout.LayoutParams fgLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        fgLp.leftMargin = dp(Theme.S2);
        savedBtns.addView(forgetBtn, fgLp);
        savedCredBox.addView(savedBtns, topMargin(dp(Theme.S2)));
        savedCredBox.setVisibility(View.GONE);
        pwdChannelPane.addView(savedCredBox, topMargin(dp(Theme.S2)));

        pwdChannelPane.addView(Ui.strong(activity, "机器人 QQ 号（严禁填写主号）", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S3)));
        etUin = new EditText(activity);
        etUin.setSingleLine(true);
        etUin.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        etUin.setHint("输入机器人小号 QQ 号");
        Ui.styleInput(etUin, activity, t);
        pwdChannelPane.addView(etUin, topMargin(dp(Theme.S1)));

        pwdChannelPane.addView(Ui.strong(activity, "QQ 密码", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S2)));
        etPwd = new EditText(activity);
        etPwd.setSingleLine(true);
        etPwd.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        etPwd.setHint("仅加密提交给本机/远端容器，绝不打印日志");
        Ui.styleInput(etPwd, activity, t);
        pwdChannelPane.addView(etPwd, topMargin(dp(Theme.S1)));

        cbRemember = new CheckBox(activity);
        cbRemember.setText("在运行机本地加密记住密码（仅用于手动点击「一键重登」）");
        cbRemember.setTextColor(t.textSecondary);
        cbRemember.setTextSize(Theme.T_CAP);
        pwdChannelPane.addView(cbRemember, topMargin(dp(Theme.S2)));

        TextView submitPwdBtn = Ui.button(activity, t, "提交账密登录", true);
        submitPwdBtn.setOnClickListener(v -> {
            final String u = etUin.getText() == null ? "" : etUin.getText().toString().trim();
            final String p = etPwd.getText() == null ? "" : etPwd.getText().toString();
            if (!u.matches("[1-9][0-9]{4,15}") || p.isEmpty()) {
                host().toast("请输入有效的机器人 QQ 号和密码");
                return;
            }
            confirmProxyIfHijacked(() -> {
                host().passwordLogin(u, p, cbRemember.isChecked());
                etPwd.setText(""); // 提交后立即清空输入框内存回显
            });
        });
        pwdChannelPane.addView(submitPwdBtn, topMargin(dp(Theme.S2)));
        loginBody.addView(pwdChannelPane, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        syncTabs();

        // ---------------- 3. 机器人业务与绑定控制 ----------------
        buildBotBlock(col);
        add(col, "管理账号绑定", false, v -> shell.pushBot(bot.id));

        // ---------------- 4. 实时运行诊断日志（改读真实 bot.log） ----------------
        buildLogArea(col);

        TextView note = Ui.text(activity, "已验证连接并不授权回复。允许联系的人或群由该账号的运行端白名单单独控制。",
                Theme.T_CAP, t.textTertiary);
        note.setPadding(0, dp(Theme.S3), 0, 0);
        col.addView(note);
        refresh();
    }

    private void syncTabs() {
        applyTabStyle(tabQrBtn, activeTab == 0);
        applyTabStyle(tabPwdBtn, activeTab == 1);
        if (qrChannelPane != null) qrChannelPane.setVisibility(activeTab == 0 ? View.VISIBLE : View.GONE);
        if (pwdChannelPane != null) pwdChannelPane.setVisibility(activeTab == 1 ? View.VISIBLE : View.GONE);
    }

    private void applyTabStyle(TextView tv, boolean on) {
        if (tv == null) return;
        tv.setBackground(Drawables.round(on ? t.accent : t.ghostFill,
                on ? 0 : t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        tv.setTextColor(on ? t.onAccent : t.textPrimary);
    }

    private TextView tabChip(String text, boolean on) {
        TextView tv = Ui.strong(activity, text, Theme.T_CAP, on ? t.onAccent : t.textPrimary);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(10), dp(10), dp(10), dp(10));
        tv.setClickable(true);
        applyTabStyle(tv, on);
        return tv;
    }

    private void syncOnlineCollapse(QqAuthState st) {
        boolean online = st != null && st.isOnline();
        if (loginFoldBtn != null) {
            loginFoldBtn.setVisibility(online ? View.VISIBLE : View.GONE);
            loginFoldBtn.setText(manualExpandWhenOnline
                    ? "收起重新登录面板"
                    : ("QQ 已在线（" + st.uin + "）· 展开多通道登录面板"));
        }
        if (loginBody != null) {
            loginBody.setVisibility((!online || manualExpandWhenOnline) ? View.VISIBLE : View.GONE);
        }
    }

    private void openSessionActionsSheet() {
        String[] options = {
                "打开登录健康与网络保活自检中心",
                "安全下线（仅退 QQ 会话，B 站与主运行端继续运行）",
                "切换账号（清除旧号登录态与快登，准备登新机器人号）",
                "强制重新登录（释放旧连接并立即按需出 1 张新码）",
                "整容器全链路重启（关闭 QQ → 重启容器 → 启动 QQ）"
        };
        PromptSheet.choose(activity, t, "QQ 会话与重启控制", options, idx -> {
            if (idx == 0) {
                shell.pushLoginHealth();
            } else if (idx == 1) {
                PromptSheet.showConfirm(activity, "确认安全下线？",
                        "将优雅退出当前 QQ 会话并落盘保护数据库，B 站运行端、聊天记录、记忆库与知识库完整保留。",
                        "安全下线", () -> host().qqSessionAction("safe_logout", false, ""), "取消");
            } else if (idx == 2) {
                PromptSheet.showConfirm(activity, "确认切换机器人账号？",
                        "将清除旧 QQ 号登录态与已记住的加密密码（保留聊天与记忆数据），之后可登录新机器人小号（仍禁止登录主号）。",
                        "切换账号", () -> {
                            manualExpandWhenOnline = true;
                            host().qqSessionAction("switch_account", true, "");
                        }, "取消");
            } else if (idx == 3) {
                PromptSheet.showConfirm(activity, "确认强制重新登录？",
                        "将释放当前会话并立即按需请求 1 张新二维码，不会影响聊天与记忆数据。",
                        "强制重登", () -> {
                            manualExpandWhenOnline = true;
                            activeTab = 0;
                            syncTabs();
                            host().qqSessionAction("force_relogin", false, "qr");
                        }, "取消");
            } else if (idx == 4) {
                PromptSheet.showConfirm(activity, "确认执行整容器全链路重启？",
                        "将依次关闭 QQ、关闭容器、重启容器并自动拉起 QQ。注意：同容器内的 B 站或其他多开机器人也会短暂中断并随容器重启。",
                        "确认全链路重启", () -> host().restartFullContainer(), "取消");
            }
        }, null, null);
    }

    private void confirmProxyIfHijacked(final Runnable proceed) {
        boolean hijack;
        if (RemoteBridge.isRemote()) {
            com.whaleonebot.remote.RemoteControlManager rm = RemoteBridge.mgr();
            hijack = rm != null && rm.activeSnapshot().netProxyHijack;
        } else {
            hijack = NetworkRiskDetector.inspect(activity).proxyHijack;
        }
        if (!hijack) {
            proceed.run();
            return;
        }
        PromptSheet.showConfirm(
                activity,
                "检测到全局代理（TUN）正在劫持流量",
                "当前手机开启了全局代理（如 sing-box/Clash），此时连接 QQ 极易导致 MSF -10003 掉线或被腾讯安全中心风控。\n\n建议前往「登录健康中心」复制绕行规则后再上线。",
                "继续执行", proceed,
                "先不执行");
    }

    private void openVerifyWebView(String url) {
        if (!QqAuthState.isSafeHttpsTencentUrl(url)) {
            host().toast("暂无可用的安全验证链接");
            return;
        }
        QqVerifyWebView.open(activity, url, new QqVerifyWebView.Callback() {
            @Override
            public void onVerified(String ticket, String randStr, String sid) {
                host().submitCaptcha(ticket, randStr, sid);
            }

            @Override
            public void onExtendedVerified(String ticket, String randStr, String sid,
                                           String newDeviceLoginSig, String unusualDeviceCheckSig) {
                host().submitCaptcha(ticket, randStr, sid, newDeviceLoginSig, unusualDeviceCheckSig);
            }

            @Override
            public void onCancelled() {
                host().toast("已取消安全验证");
            }
        });
    }

    private void copyQrUrl() {
        String url = host().qrUrl();
        if (!QqAuthState.isSafeHttpsTencentUrl(url)) {
            host().toast("当前没有有效的授权链接");
            return;
        }
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("QQ登录授权链接", url));
            host().toast("授权链接已复制（可发给手机 QQ 直接点开确认，免截图）");
        } catch (Throwable ex) {
            host().toast("复制失败");
        }
    }

    private void buildBotBlock(LinearLayout col) {
        CoreInventory.Instance core = BotRegistry.coreForBot(bot.id);
        boolean managed = core != null && CoreManagerScreen.managed(core);
        if (managed) {
            col.addView(sectionLabel("这个机器人"), sectionLp());
            add(col, "连接 QQ", true, v -> {
                if (!BotRegistry.platformEnabled(bot.id, BotRegistry.P_QQ)) {
                    BotRegistry.setPlatformEnabled(bot.id, BotRegistry.P_QQ, true);
                    host().toast("已为本机器人打开 QQ");
                }
                new Thread(() -> {
                    RemoteBridge.startBot(activity);
                    try {
                        RemoteBridge.startInstalledPlatform(activity, bot.id, BotRegistry.P_QQ);
                    } catch (Exception e) {
                        activity.runOnUiThread(() -> host().toast("QQ 启动未完成：" + (e.getMessage() == null ? "未知原因" : e.getMessage())));
                    }
                }, "connect-qq").start();
            });
        } else if (BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            col.addView(sectionLabel("这个机器人"), sectionLp());
            if (!host().containerRunning()) {
                add(col, "准备容器", false, v -> {
                    host().startContainer();
                    host().toast("正在准备容器");
                });
            }
            add(col, "启动本机器人", true, v -> {
                RemoteBridge.startBoundBot(activity, bot.id);
                refresh();
            });
            add(col, "停止本机器人", false, v -> {
                RemoteBridge.stopBoundBot(bot.id);
                refresh();
            });
        }
    }

    private void add(LinearLayout col, String label, boolean primary, View.OnClickListener action) {
        TextView btn = Ui.button(activity, t, label, primary);
        btn.setMinimumHeight(dp(Theme.TOUCH));
        btn.setOnClickListener(action);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S2);
        col.addView(btn, lp);
    }

    @Override
    void refresh() {
        if (bot == null || status == null) return;

        boolean running = host().containerRunning();
        QqAuthState auth = host().qqAuthState();
        String uin = host().loginUin();
        boolean logged = auth.isOnline() || (uin != null && uin.length() > 0);
        int level = auth.healthLevel(running);

        // 1. 刷新顶部健康卡
        String sig = running + "|" + auth.phase + "|" + auth.uin + "|" + auth.offlineReason + "|" + auth.offlineMessage + "|" + auth.verifyUrl;
        if (!sig.equals(lastHealthSig)) {
            lastHealthSig = sig;
            int tone = level == QqAuthState.LEVEL_ONLINE ? Ui.TONE_OK
                    : (level == QqAuthState.LEVEL_OFFLINE_ACTION || level == QqAuthState.LEVEL_DEGRADED ? Ui.TONE_WARN : Ui.TONE_NEUTRAL);
            if (healthPill != null) {
                healthPill.setText(auth.shortBadge(running));
                healthPill.setBackground(Drawables.round(
                        tone == Ui.TONE_OK ? Ui.alpha(t.accent, 0.16f)
                                : (tone == Ui.TONE_WARN ? 0x26D9534F : t.ghostFill),
                        tone == Ui.TONE_WARN ? 0x99D9534F : t.ghostStroke,
                        dp(1), dp(Theme.R_PILL)));
                healthPill.setTextColor(tone == Ui.TONE_WARN ? (t.dark ? 0xFFFF8A80 : 0xFFC62828)
                        : (tone == Ui.TONE_OK ? t.toneStrong : t.textSecondary));
            }
            if (healthDetail != null) healthDetail.setText(auth.detailMessage(running));
            if (healthMeta != null) {
                StringBuilder meta = new StringBuilder();
                if (!auth.clientVer.isEmpty()) meta.append("QQ ").append(auth.clientVer);
                if (!auth.hostname.isEmpty()) meta.append(meta.length() > 0 ? " · " : "").append("设备 ").append(auth.hostname);
                if (!auth.kernelRelease.isEmpty()) meta.append(meta.length() > 0 ? " · " : "").append(auth.kernelRelease);
                if (running) meta.append(meta.length() > 0 ? " · " : "").append("快登票据：").append(auth.canQuickLogin ? "可用" : "需重新登录");
                String netDiag = host().networkDiagnosticSummary();
                if (netDiag != null && !netDiag.isEmpty()) meta.append(meta.length() > 0 ? "\n网络出口：" : "网络出口：").append(netDiag);
                healthMeta.setText(meta.toString());
            }
            syncOnlineCollapse(auth);
        }

        // 2. 滑块/新设备验证横幅
        if (verifyBanner != null) {
            boolean hasVerify = auth.hasVerifyChallenge();
            verifyBanner.setVisibility(hasVerify ? View.VISIBLE : View.GONE);
            if (hasVerify && !auth.verifyUrl.equals(lastVerifyUrlPrompted)) {
                lastVerifyUrlPrompted = auth.verifyUrl;
                host().toast("QQ 登录需要安全滑块验证，请点击顶部高亮按钮完成");
            }
        }

        // 3. 按钮与授权码状态
        Ui.enabled(startBtn, !running);
        Ui.enabled(stopBtn, running);
        if (wakeBtn != null) Ui.enabled(wakeBtn, running && logged);

        boolean qrLive = host().qrLive();
        String qrUrl = host().qrUrl();
        boolean hasQrUrl = QqAuthState.isSafeHttpsTencentUrl(qrUrl);
        if (copyQrUrlBtn != null) Ui.enabled(copyQrUrlBtn, hasQrUrl);
        if (saveBtn != null) Ui.enabled(saveBtn, qrLive);
        if (qr != null) qr.refresh();

        // 4. 记住密码快捷卡片
        QqCredentialVault.Summary cred = host().savedCredSummary();
        if (savedCredBox != null) {
            savedCredBox.setVisibility(cred != null && cred.hasSaved ? View.VISIBLE : View.GONE);
            if (cred != null && cred.hasSaved && savedCredLabel != null) {
                savedCredLabel.setText("已加密记住账号：" + cred.uin);
            }
        }

        // 5. 绑定与运行端三态明细
        JSONObject result = RemoteBridge.bindingStatus(activity, bot.id);
        String state = result == null ? "" : result.optString("state");
        int obPort = result == null ? 0 : result.optInt("onebotPort", 0);
        int agPid = result == null ? 0 : result.optInt("agentPid", 0);
        String runtimeDetail = summary(state);
        if ("running".equals(state) && (obPort > 0 || agPid > 0)) {
            runtimeDetail = "运行中（OneBot " + (obPort > 0 ? obPort : 13800)
                    + (agPid > 0 ? " · PID " + agPid : "") + "）";
        }
        StringBuilder sb = dashboard ? new StringBuilder()
                : new StringBuilder("容器：").append(running ? "运行中" : "已停止")
                .append("  ·  运行端：").append(runtimeDetail);
        JSONArray rows = result == null ? null : result.optJSONArray("bindings");
        for (BotRegistry.Binding v : bot.bindings) {
            if (!BotRegistry.P_QQ.equals(v.platform)) continue;
            boolean verified = false;
            if (rows != null) for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row != null && BindingPresentation.connected(v, state, row.optString("id"),
                        row.optString("platform"), row.optString("accountId"), row.optString("state"))) {
                    verified = true;
                }
            }
            if (sb.length() > 0) sb.append("\n");
            String bindState = verified ? "已验证连接"
                    : (v.localQQ() && logged ? ("本机在线 " + (auth.isOnline() ? auth.uin : uin))
                    : (auth.isOfflineAlert() ? auth.shortBadge(running) : (v.accountId.isEmpty() ? "待登录" : "未验证连接")));
            sb.append(v.label()).append("：").append(bindState);
        }
        if (dashboard && sb.length() == 0) sb.append("尚未添加 QQ 账号");
        String s = sb.toString();
        if (!s.equals(previous)) {
            status.setText(s);
            previous = s;
        }

        // 6. 实时运行日志（bot.log + container.log）
        if (logText != null) {
            String logs = buildLogs();
            if (!logs.equals(lastLog)) {
                lastLog = logs;
                logText.setText(logs);
                if (logScroll != null) logScroll.post(() -> {
                    if (logScroll.getChildCount() > 0) logScroll.fullScroll(View.FOCUS_DOWN);
                });
            }
        }
    }

    private String buildLogs() {
        return "— QQ 实时日志 (bot.log) —\n" + tail(host().loginLog(40))
                + "\n— 容器日志 —\n" + tail(host().containerLog(15));
    }

    private static String tail(String s) {
        if (s == null) return "（暂无日志）";
        String v = s.trim();
        return v.length() == 0 ? "（暂无日志）" : v;
    }

    private void buildLogArea(LinearLayout col) {
        FrameLayout logCard = new FrameLayout(activity);
        logCard.setBackground(Drawables.round(t.logFill, t.logStroke, dp(1), dp(Theme.R_PANEL)));
        Ui.elevate(logCard, 2f, t);
        logCard.setClipToOutline(true);
        LinearLayout lbox = Ui.column(activity);
        lbox.setPadding(dp(Theme.S2 + 2), dp(Theme.S2), dp(Theme.S2 + 2), dp(Theme.S2));
        LinearLayout lhead = Ui.row(activity);
        lhead.addView(sectionLabel("实时诊断日志"), new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        TextView bbBtn = Ui.text(activity, "防掉线黑匣子", Theme.T_CAP, t.accent);
        bbBtn.setPadding(dp(8), dp(4), dp(4), dp(4));
        bbBtn.setClickable(true);
        bbBtn.setOnClickListener(v -> ModelsScreen.W.infoDialog(activity, t,
                "防掉线黑匣子记录（blackbox.log）", host().blackboxLog(120)));
        lhead.addView(bbBtn, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        lbox.addView(lhead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        logScroll = new ScrollView(activity);
        logScroll.setVerticalScrollBarEnabled(false);
        logText = Ui.mono(activity, Theme.T_MONO, t.logText);
        logText.setTextSize(11f);
        logText.setLineSpacing(dp(2), 1f);
        logScroll.addView(logText, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        lbox.addView(logScroll, Ui.llp(MATCH_PARENT, dp(180)));
        logCard.addView(lbox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S3);
        col.addView(logCard, lp);
    }

    private TextView sectionLabel(String text) {
        TextView tv = Ui.strong(activity, text, Theme.T_CAP, t.textSecondary);
        return tv;
    }

    private LinearLayout.LayoutParams sectionLp() {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S4);
        lp.bottomMargin = dp(Theme.S1);
        return lp;
    }

    private LinearLayout.LayoutParams topMargin(int px) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = px;
        return lp;
    }

    static String summary(String state) {
        if ("running".equals(state)) return "运行中";
        if ("starting".equals(state)) return "启动中";
        if ("stopping".equals(state)) return "停止中";
        if ("failed".equals(state)) return "异常退出";
        if ("unknown".equals(state)) return "状态未知";
        return "已停止";
    }
}
