package com.whaleonebot.ui;

import android.content.Intent;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import com.whaleonebot.douyin.mobile.Desk;
import com.whaleonebot.douyin.mobile.MobileHost;
import com.whaleonebot.douyin.mobile.OwnerActivity;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 抖音（测试版）平台专属管理页。
 *
 * <p>严格对齐 2026-11-26 需求问答报告 Q11 / Q12：
 * <ul>
 *   <li>顶部明确标示「抖音 · 测试版」与实验性通道边界说明，不虚构未验证的实网个人号收发；</li>
 *   <li>提供内置实验性 WebView 网页登录抓 Cookie（仅私有目录 0600 存储，绝不回显明文）；</li>
 *   <li>6 项写操作（评论/点赞/收藏/关注/发图文/改资料）全部默认「需要授权」，可逐项切为「自主进行」；</li>
 *   <li>内置定时浏览周期与每日预算设置、本机审批台入口与公开作品链接候选队列管理。</li>
 * </ul>
 */
final class DouyinPlatformScreen extends Screen {

    private final BotRegistry.Bot bot;
    private final String tab;
    private LinearLayout content;

    DouyinPlatformScreen(AppShell shell, BotRegistry.Bot bot, String tab) {
        super(shell);
        this.bot = bot;
        this.tab = tab == null ? "start" : tab;
    }

    @Override
    void build() {
        root.removeAllViews();

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        content = Ui.column(activity);
        int p = dp(Theme.S4);
        content.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(content, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        render();
    }

    private void render() {
        content.removeAllViews();
        final String botId = bot == null ? "default" : bot.id;
        final String botName = bot == null || bot.name == null || bot.name.isEmpty() ? "抖音机器人" : bot.name;

        content.addView(header(botName + " · 抖音"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------------- 顶部测试版声明卡 ----------------
        LinearLayout betaCard = Ui.addCard(content, activity, t, Theme.S3);
        LinearLayout betaHead = Ui.row(activity);
        betaHead.addView(Ui.strong(activity, "抖音平台接口", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        betaHead.addView(Ui.pill(activity, t, "测试版 · 实验通道", Ui.TONE_WARN));
        betaCard.addView(betaHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        betaCard.addView(Ui.text(activity,
                "已合入抖音转接层、媒体理解、公开作品读取、机器人插件与本机审批台（Desk）。"
                        + "当前网页凭证登录属于实验性功能，实网风控下不保证个人号长期在线；所有写操作默认「需要主人授权」。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S2)));

        // ---------------- 1. 账号与实验性网页登录 ----------------
        content.addView(sectionLabel("账号登录（实验性 WebView）"));
        LinearLayout loginCard = Ui.addCard(content, activity, t, Theme.S1);
        DouyinSettings.SessionSummary sum = DouyinSettings.sessionSummary(activity.getFilesDir(), botId);

        LinearLayout loginHead = Ui.row(activity);
        loginHead.addView(Ui.strong(activity, "本机实验凭证状态", Theme.T_BODY, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        loginHead.addView(Ui.pill(activity, t,
                sum.saved ? (sum.hasSessionId ? "已保存登录态" : "已保存基础 Cookie") : "未登录",
                sum.saved ? Ui.TONE_OK : Ui.TONE_NEUTRAL));
        loginCard.addView(loginHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (sum.saved) {
            String when = new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(new Date(sum.savedAt));
            loginCard.addView(Ui.text(activity,
                    "已落盘于应用私有加密目录（共 " + sum.cookieFieldCount + " 项字段，更新于 " + when + "；明文永不打印）。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
        } else {
            loginCard.addView(Ui.text(activity,
                    "点击下方按钮打开内置浏览器登录抖音网页端，登录完成后点「我已登录，保存凭证」。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
        }

        LinearLayout loginBtns = Ui.row(activity);
        TextView webBtn = Ui.button(activity, t, sum.saved ? "重新网页登录" : "打开内置网页登录", true);
        webBtn.setOnClickListener(v -> {
            if (RemoteBridge.isRemote()) {
                host().toast("网页登录需在被控机本机完成（凭证仅保留在被控机私有存储）");
                return;
            }
            DouyinWebLogin.open(activity, botId, (saved, summary) -> {
                host().toast(summary);
                render();
            });
        });
        loginBtns.addView(webBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        if (sum.saved) {
            TextView forgetBtn = Ui.button(activity, t, "清除凭证", false);
            forgetBtn.setOnClickListener(v -> PromptSheet.showConfirm(
                    activity, "清除本机抖音实验凭证？",
                    "将立即删除应用私有目录中的抖音 Cookie 文件，不影响机器人记忆库。",
                    "清除", () -> {
                        DouyinSettings.forgetWebSession(activity.getFilesDir(), botId);
                        host().toast("已清除本地抖音凭证");
                        render();
                    }, "取消"));
            LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
            flp.leftMargin = dp(Theme.S2);
            loginBtns.addView(forgetBtn, flp);
        }
        loginCard.addView(loginBtns, topMargin(dp(Theme.S3)));

        // 打开官方客户端手动核验（复用到 OwnerActivity）
        TextView openOfficial = Ui.button(activity, t, "打开本机审批台 / 官方抖音 App", false);
        openOfficial.setOnClickListener(v -> openOwnerDesk(botId));
        loginCard.addView(openOfficial, topMargin(dp(Theme.S2)));

        // ---------------- 2. 写操作分级权限（默认全部需要授权） ----------------
        content.addView(sectionLabel("写操作权限策略（安全默认：全部需要授权）"));
        LinearLayout permCard = Ui.addCard(content, activity, t, Theme.S1);
        final DouyinSettings.Config cfg = DouyinSettings.loadConfig(activity.getFilesDir(), botId);
        permCard.addView(Ui.text(activity,
                "开启开关 = 允许机器人自主执行该操作；关闭（默认）= 每次执行前必须经你在手机端明确授权。",
                Theme.T_CAP, t.textSecondary));

        for (int i = 0; i < DouyinSettings.WRITE_ACTIONS.length; i++) {
            permCard.addView(Ui.divider(activity, t));
            final String actionKey = DouyinSettings.WRITE_ACTIONS[i][0];
            final String actionLabel = DouyinSettings.WRITE_ACTIONS[i][1];
            boolean autonomous = DouyinSettings.MODE_AUTONOMOUS.equals(cfg.actions.get(actionKey));

            LinearLayout row = Ui.row(activity);
            LinearLayout textCol = Ui.column(activity);
            textCol.addView(Ui.strong(activity, actionLabel, Theme.T_BODY, t.textPrimary));
            final TextView stateHint = Ui.text(activity,
                    autonomous ? "当前：自主进行（无需每次弹窗确认）" : "当前：需要授权（默认安全策略）",
                    Theme.T_CAP, autonomous ? t.toneStrong : t.textSecondary);
            textCol.addView(stateHint, topMargin(dp(2)));
            row.addView(textCol, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));

            Switch sw = new Switch(activity);
            sw.setChecked(autonomous);
            sw.setOnCheckedChangeListener((btn, checked) -> {
                cfg.actions.put(actionKey, checked ? DouyinSettings.MODE_AUTONOMOUS : DouyinSettings.MODE_APPROVAL);
                DouyinSettings.saveConfig(activity.getFilesDir(), botId, cfg);
                stateHint.setText(checked ? "当前：自主进行（无需每次弹窗确认）" : "当前：需要授权（默认安全策略）");
                stateHint.setTextColor(checked ? t.toneStrong : t.textSecondary);
                host().toast(actionLabel + "：" + (checked ? "已切为自主进行" : "已恢复为需要授权"));
            });
            row.addView(sw, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
            permCard.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        // ---------------- 3. 定时浏览与预算 ----------------
        content.addView(sectionLabel("定时浏览与配额"));
        LinearLayout browseCard = Ui.addCard(content, activity, t, Theme.S1);
        LinearLayout browseRow = Ui.row(activity);
        LinearLayout browseText = Ui.column(activity);
        browseText.addView(Ui.strong(activity, "启用定时浏览计划", Theme.T_BODY, t.textPrimary));
        browseText.addView(Ui.text(activity,
                "周期 " + cfg.browseIntervalMin + " 分钟 · 每日浏览上限 " + cfg.dailyBrowseBudget
                        + " 条 · 写操作上限 " + cfg.dailyWriteBudget + " 次",
                Theme.T_CAP, t.textSecondary), topMargin(dp(2)));
        browseRow.addView(browseText, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        Switch browseSw = new Switch(activity);
        browseSw.setChecked(cfg.browseEnabled);
        browseSw.setOnCheckedChangeListener((btn, checked) -> {
            cfg.browseEnabled = checked;
            DouyinSettings.saveConfig(activity.getFilesDir(), botId, cfg);
            host().toast(checked ? "已开启定时浏览计划（仅在存在有效通道时生效）" : "已暂停定时浏览");
        });
        browseRow.addView(browseSw, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        browseCard.addView(browseRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView editQuota = Ui.button(activity, t, "调整浏览周期与每日预算", false);
        editQuota.setOnClickListener(v -> showQuotaEditor(botId, cfg));
        browseCard.addView(editQuota, topMargin(dp(Theme.S3)));

        // ---------------- 4. 公开作品链接候选队列（支持系统分享直达） ----------------
        content.addView(sectionLabel("公开作品链接候选队列"));
        LinearLayout queueCard = Ui.addCard(content, activity, t, Theme.S1);
        List<String> candidates = DouyinSettings.listCandidates(activity.getFilesDir(), botId);
        queueCard.addView(Ui.text(activity,
                "在抖音 App 点「分享 → 更多 → 接收抖音作品链接」，或在下方粘贴公开 HTTPS 作品链接提交给本机器人。",
                Theme.T_CAP, t.textSecondary));

        final EditText linkInput = new EditText(activity);
        linkInput.setHint("https://v.douyin.com/... 或 https://www.douyin.com/video/...");
        linkInput.setHintTextColor(t.textTertiary);
        linkInput.setTextColor(t.textPrimary);
        linkInput.setTextSize(Theme.T_BODY);
        linkInput.setSingleLine(true);
        linkInput.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        linkInput.setPadding(dp(12), dp(10), dp(12), dp(10));
        queueCard.addView(linkInput, topMargin(dp(Theme.S2)));

        LinearLayout qBtns = Ui.row(activity);
        TextView addLinkBtn = Ui.button(activity, t, "校验并加入候选队列", true);
        addLinkBtn.setOnClickListener(v -> {
            String raw = linkInput.getText() == null ? "" : linkInput.getText().toString().trim();
            String valid = Desk.candidate(raw);
            if (valid == null) {
                host().toast("仅支持单条公开抖音 HTTPS 链接（www.douyin.com/video/... 或 v.douyin.com/...）");
                return;
            }
            DouyinSettings.enqueueCandidate(activity.getFilesDir(), botId, valid);
            host().toast("已加入候选队列");
            render();
        });
        qBtns.addView(addLinkBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        if (!candidates.isEmpty()) {
            TextView clearBtn = Ui.button(activity, t, "清空 (" + candidates.size() + ")", false);
            clearBtn.setOnClickListener(v -> {
                DouyinSettings.clearCandidates(activity.getFilesDir(), botId);
                host().toast("已清空候选队列");
                render();
            });
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(WRAP_CONTENT, dp(Theme.TOUCH));
            clp.leftMargin = dp(Theme.S2);
            qBtns.addView(clearBtn, clp);
        }
        queueCard.addView(qBtns, topMargin(dp(Theme.S2)));

        if (candidates.isEmpty()) {
            queueCard.addView(Ui.text(activity, "当前队列为空", Theme.T_CAP, t.textTertiary), topMargin(dp(Theme.S2)));
        } else {
            int show = Math.min(5, candidates.size());
            for (int i = 0; i < show; i++) {
                queueCard.addView(Ui.divider(activity, t));
                queueCard.addView(Ui.text(activity, (i + 1) + ". " + candidates.get(i),
                        Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
            }
            if (candidates.size() > show) {
                queueCard.addView(Ui.text(activity, "… 共 " + candidates.size() + " 条链接待处理",
                        Theme.T_CAP, t.textTertiary), topMargin(dp(6)));
            }
        }
    }

    private void openOwnerDesk(String botId) {
        try {
            if (activity.getApplication() instanceof MobileHost) {
                Desk desk = ((MobileHost) activity.getApplication()).douyinDesk();
                if (desk != null && desk.get(botId) == null) {
                    desk.bind(botId, "local-" + botId.replaceAll("[^A-Za-z0-9_.-]", "_"));
                }
            }
            Intent i = new Intent(activity, OwnerActivity.class);
            i.putExtra(OwnerActivity.BOT, botId);
            activity.startActivity(i);
        } catch (Throwable ex) {
            host().toast("打开本机审批台失败：" + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
        }
    }

    private void showQuotaEditor(final String botId, final DouyinSettings.Config cfg) {
        LinearLayout box = Ui.column(activity);
        box.addView(Ui.text(activity, "浏览周期（分钟，15~1440）", Theme.T_CAP, t.textSecondary));
        final EditText etInterval = numInput(String.valueOf(cfg.browseIntervalMin));
        box.addView(etInterval, topMargin(dp(4)));

        box.addView(Ui.text(activity, "每日浏览上限（条，1~200）", Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S2)));
        final EditText etBrowse = numInput(String.valueOf(cfg.dailyBrowseBudget));
        box.addView(etBrowse, topMargin(dp(4)));

        box.addView(Ui.text(activity, "每日写操作上限（次，0~100）", Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S2)));
        final EditText etWrite = numInput(String.valueOf(cfg.dailyWriteBudget));
        box.addView(etWrite, topMargin(dp(4)));

        PromptSheet.custom(activity, t, "浏览周期与每日预算", box,
                "保存", (d, btn) -> {
                    try {
                        cfg.browseIntervalMin = Math.max(15, Math.min(1440, Integer.parseInt(etInterval.getText().toString().trim())));
                        cfg.dailyBrowseBudget = Math.max(1, Math.min(200, Integer.parseInt(etBrowse.getText().toString().trim())));
                        cfg.dailyWriteBudget = Math.max(0, Math.min(100, Integer.parseInt(etWrite.getText().toString().trim())));
                        DouyinSettings.saveConfig(activity.getFilesDir(), botId, cfg);
                        d.dismiss();
                        host().toast("已保存抖音预算设置");
                        render();
                    } catch (Throwable ex) {
                        host().toast("请填写有效整数");
                    }
                }, null, null, "取消", (d, btn) -> d.dismiss(), false, false, null, null);
    }

    private EditText numInput(String initial) {
        EditText et = new EditText(activity);
        et.setText(initial);
        et.setSingleLine(true);
        et.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        et.setTextSize(Theme.T_BODY);
        et.setTextColor(t.textPrimary);
        et.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        et.setPadding(dp(12), dp(8), dp(12), dp(8));
        return et;
    }

    private TextView sectionLabel(String text) {
        TextView label = Ui.strong(activity, text, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S4);
        lp.bottomMargin = dp(Theme.S1);
        label.setLayoutParams(lp);
        return label;
    }

    private LinearLayout.LayoutParams topMargin(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
