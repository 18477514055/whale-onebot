package com.whaleonebot.ui;

import android.content.Intent;
import android.text.InputType;
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
 * [layer: shell-android] 抖音平台专属管理页（完整可用闭环：硬件 Keystore 加密存储 + 自动识别真实 UID/昵称 +
 * 低频只读保活 + 独立探活与黑匣子 + 全量双机远程控制）。
 */
final class DouyinPlatformScreen extends Screen {

    private final BotRegistry.Bot bot;
    private final String tab;
    private LinearLayout content;
    private ScrollView pageScroll;
    private int savedScrollY = 0;

    DouyinPlatformScreen(AppShell shell, BotRegistry.Bot bot, String tab) {
        super(shell);
        this.bot = bot;
        this.tab = tab == null ? "start" : tab;
    }

    @Override
    void build() {
        root.removeAllViews();

        pageScroll = new ScrollView(activity);
        pageScroll.setFillViewport(true);
        pageScroll.setClipChildren(false);
        root.addView(pageScroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        content = Ui.column(activity);
        int p = dp(Theme.S4);
        content.setPadding(p, dp(Theme.S3 + 4), p, p);
        pageScroll.addView(content, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        render();
    }

    private void render() {
        if (pageScroll != null) savedScrollY = pageScroll.getScrollY();
        content.removeAllViews();
        final String botId = bot == null ? "default" : bot.id;
        final String botName = bot == null || bot.name == null || bot.name.isEmpty() ? "抖音机器人" : bot.name;
        final boolean remote = RemoteBridge.isRemote();

        content.addView(header(botName + " · 抖音" + (remote ? "（远程）" : "")), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------------- 1. 账号登录与实时健康卡（本机 & 远程统一） ----------------
        content.addView(sectionLabel("抖音账号登录与保活状态"));
        LinearLayout loginCard = Ui.addCard(content, activity, t, Theme.S1);
        final DouyinSettings.SessionSummary sum = RemoteBridge.douyinSummary(activity, botId);

        LinearLayout loginHead = Ui.row(activity);
        String headTitle = "未登录";
        if (sum.saved) {
            if (!sum.nickname.isEmpty()) headTitle = sum.nickname + (sum.uid.isEmpty() ? "" : " (" + sum.uid + ")");
            else if (!sum.uid.isEmpty()) headTitle = "UID " + sum.uid;
            else headTitle = "已保存加密凭证";
        }
        loginHead.addView(Ui.strong(activity, headTitle, Theme.T_BODY, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        String pillText = "未登录";
        int pillTone = Ui.TONE_NEUTRAL;
        if (sum.saved) {
            if ("verified".equals(sum.state) || sum.verified) {
                pillText = "已验真在线";
                pillTone = Ui.TONE_OK;
            } else if ("expired".equals(sum.state)) {
                pillText = "已失效需重登";
                pillTone = Ui.TONE_WARN;
            } else if ("network_error".equals(sum.state)) {
                pillText = "网络波动";
                pillTone = Ui.TONE_WARN;
            } else {
                pillText = sum.hasSessionId ? "已存待核验" : "凭证不完整";
                pillTone = sum.hasSessionId ? Ui.TONE_OK : Ui.TONE_WARN;
            }
        }
        loginHead.addView(Ui.pill(activity, t, pillText, pillTone));
        loginCard.addView(loginHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (sum.saved) {
            SimpleDateFormat fmt = new SimpleDateFormat("MM-dd HH:mm", Locale.CHINA);
            String savedStr = sum.savedAt > 0 ? fmt.format(new Date(sum.savedAt)) : "未知";
            String checkStr = sum.lastCheckAt > 0 ? fmt.format(new Date(sum.lastCheckAt)) : "未探活";
            String detail = "Keystore 硬件加密存储（" + sum.cookieFieldCount + " 项字段，更新 " + savedStr + " · 上次只读探活 " + checkStr + " · 每 45 分钟低频保活）";
            if (!sum.lastError.isEmpty()) detail += "\n状态说明：" + sum.lastError;
            loginCard.addView(Ui.text(activity, detail, Theme.T_CAP,
                    "expired".equals(sum.state) ? (t.dark ? 0xFFFF8A80 : 0xFFC62828) : t.textSecondary), topMargin(dp(Theme.S1)));
        } else {
            loginCard.addView(Ui.text(activity,
                    "支持桌面扫码/短信网页自动捕获（防跳转拦截）或粘贴 Cookie 导入；"
                            + (remote ? "在主力机网页登录后将通过端到端加密自动回传给被控机加密保存。" : "校验通过后自动加入 45 分钟低频保活。"),
                    Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
        }

        LinearLayout loginBtns = Ui.row(activity);
        TextView webBtn = Ui.button(activity, t, sum.saved ? "重新网页登录" : "内置网页登录（扫码/短信）", true);
        webBtn.setOnClickListener(v -> DouyinWebLogin.open(activity, botId, rawCookie -> submitCookie(botId, rawCookie)));
        loginBtns.addView(webBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1.3f));

        TextView importBtn = Ui.button(activity, t, "导入 Cookie", false);
        importBtn.setOnClickListener(v -> showImportCookieDialog(botId));
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 0.9f);
        ilp.leftMargin = dp(Theme.S2);
        loginBtns.addView(importBtn, ilp);
        loginCard.addView(loginBtns, topMargin(dp(Theme.S3)));

        LinearLayout opsRow = Ui.row(activity);
        TextView probeBtn = Ui.button(activity, t, sum.saved ? "立即核验 / 热重启" : "查看诊断黑匣子", false);
        probeBtn.setOnClickListener(v -> {
            if (!sum.saved) {
                ModelsScreen.W.infoDialog(activity, t, "抖音探活黑匣子", RemoteBridge.douyinBlackbox(60));
                return;
            }
            host().toast("正在只读核验抖音登录态…");
            new Thread(() -> {
                RemoteBridge.probeDouyin(activity, botId);
                activity.runOnUiThread(this::render);
            }, "dy-probe").start();
        });
        opsRow.addView(probeBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));

        if (sum.saved) {
            TextView bbBtn = Ui.button(activity, t, "黑匣子", false);
            bbBtn.setOnClickListener(v -> ModelsScreen.W.infoDialog(activity, t, "抖音探活黑匣子", RemoteBridge.douyinBlackbox(60)));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 0.7f);
            blp.leftMargin = dp(Theme.S2);
            opsRow.addView(bbBtn, blp);

            TextView forgetBtn = Ui.button(activity, t, "清除凭证", false);
            forgetBtn.setOnClickListener(v -> PromptSheet.showConfirm(
                    activity, "清除抖音加密凭证？",
                    "将立即销毁硬件加密仓中的抖音 Cookie，不影响机器人记忆库与行为策略。",
                    "清除", () -> {
                        new Thread(() -> {
                            RemoteBridge.forgetDouyin(activity, botId);
                            activity.runOnUiThread(() -> {
                                host().toast("已清除抖音凭证");
                                render();
                            });
                        }, "dy-forget").start();
                    }, "取消"));
            LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 0.8f);
            flp.leftMargin = dp(Theme.S2);
            opsRow.addView(forgetBtn, flp);
        }
        loginCard.addView(opsRow, topMargin(dp(Theme.S2)));

        if (!remote) {
            TextView openOfficial = Ui.button(activity, t, "打开本机审批台 / 官方抖音 App", false);
            openOfficial.setOnClickListener(v -> openOwnerDesk(botId));
            loginCard.addView(openOfficial, topMargin(dp(Theme.S2)));
        }

        // ---------------- 2. 写操作分级权限（默认全部需要授权） ----------------
        content.addView(sectionLabel("写操作权限策略（安全默认：全部需要授权）"));
        LinearLayout permCard = Ui.addCard(content, activity, t, Theme.S1);
        final DouyinSettings.Config cfg = RemoteBridge.loadDouyinConfig(activity, botId);
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
                RemoteBridge.saveDouyinConfig(activity, botId, cfg);
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
            RemoteBridge.saveDouyinConfig(activity, botId, cfg);
            host().toast(checked ? "已开启定时浏览计划" : "已暂停定时浏览");
        });
        browseRow.addView(browseSw, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        browseCard.addView(browseRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView editQuota = Ui.button(activity, t, "调整浏览周期与每日预算", false);
        editQuota.setOnClickListener(v -> showQuotaEditor(botId, cfg));
        browseCard.addView(editQuota, topMargin(dp(Theme.S3)));

        // ---------------- 4. 公开作品链接候选队列 ----------------
        content.addView(sectionLabel("公开作品链接候选队列"));
        LinearLayout queueCard = Ui.addCard(content, activity, t, Theme.S1);
        List<String> candidates = RemoteBridge.listDouyinCandidates(activity, botId);
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
            RemoteBridge.enqueueDouyinCandidate(activity, botId, valid);
            host().toast("已加入候选队列");
            render();
        });
        qBtns.addView(addLinkBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        if (!candidates.isEmpty()) {
            TextView clearBtn = Ui.button(activity, t, "清空 (" + candidates.size() + ")", false);
            clearBtn.setOnClickListener(v -> {
                RemoteBridge.clearDouyinCandidates(activity, botId);
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

        final int keepY = savedScrollY;
        if (keepY > 0 && pageScroll != null) {
            pageScroll.post(() -> { if (pageScroll != null) pageScroll.scrollTo(0, keepY); });
        }
    }

    private void submitCookie(final String botId, final String rawCookie) {
        host().toast("正在联网校验抖音账号并硬件加密保存…");
        new Thread(() -> {
            DouyinSettings.SessionSummary res = RemoteBridge.saveDouyinSession(activity, botId, rawCookie);
            activity.runOnUiThread(() -> {
                if (res != null && res.saved) {
                    String who = !res.nickname.isEmpty() ? res.nickname : (!res.uid.isEmpty() ? res.uid : "已保存");
                    host().toast("抖音凭证保存成功：" + who);
                } else {
                    host().toast(res != null && !res.lastError.isEmpty() ? res.lastError : "保存失败，请确认已完成账号登录");
                }
                render();
            });
        }, "dy-save-cookie").start();
    }

    private void showImportCookieDialog(final String botId) {
        LinearLayout box = Ui.column(activity);
        box.addView(Ui.text(activity, "粘贴含 sessionid=... 或 sid_tt=... 的抖音网页 Cookie（仅以 Keystore 密文存运行机，不接受纯游客 Cookie）。",
                Theme.T_CAP, t.textSecondary));
        final EditText et = new EditText(activity);
        et.setHint("sessionid=...; sid_tt=...; uid_tt=...");
        et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        et.setMinLines(3);
        Ui.styleInput(et, activity, t);
        box.addView(et, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        PromptSheet.custom(activity, t, "导入抖音 Cookie", box,
                "核验并保存", (d, b) -> {
                    String raw = et.getText() == null ? "" : et.getText().toString().trim();
                    if (raw.isEmpty()) { host().toast("请先粘贴 Cookie"); return; }
                    d.dismiss();
                    submitCookie(botId, raw);
                }, null, null, "取消", (d, b) -> d.dismiss(), true, false, null, null);
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
                        RemoteBridge.saveDouyinConfig(activity, botId, cfg);
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
