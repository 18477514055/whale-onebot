package com.whaleonebot.ui;

import android.app.Dialog;
import android.text.InputType;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.ContainerService;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/** Three Bilibili surfaces for the selected robot; no global QQ status/config API. */
final class BiliPlatformScreen extends Screen {
    final BotRegistry.Bot bot;
    private String tab;
    private Dialog challengeDialog;
    private String challengeBinding;
    private final Map<BotRegistry.Binding, TextView> statuses = new LinkedHashMap<BotRegistry.Binding, TextView>();
    private final Map<BotRegistry.Binding, TextView> verifyLines = new LinkedHashMap<BotRegistry.Binding, TextView>();
    private final Map<BotRegistry.Binding, TextView> titles = new LinkedHashMap<BotRegistry.Binding, TextView>();
    private final Map<BotRegistry.Binding, TextView> links = new LinkedHashMap<BotRegistry.Binding, TextView>();
    private final Map<BotRegistry.Binding, TextView> starts = new LinkedHashMap<BotRegistry.Binding, TextView>();
    private final Map<String, String> loginFeedback = new HashMap<String, String>();

    private TextView connectBtn;
    private TextView connectStatus;
    private ScrollView pageScroll;
    private int savedScrollY = 0;

    // 看板动作流水翻页状态
    private int logPage = 0;
    private LinearLayout logListBox;
    private TextView logOlderBtn;
    private TextView logLatestBtn;

    BiliPlatformScreen(AppShell shell, BotRegistry.Bot bot, String tab) {
        super(shell);
        this.bot = bot;
        this.tab = tab == null ? "start" : tab;
    }

    void build() {
        if (pageScroll != null) savedScrollY = pageScroll.getScrollY();
        root.removeAllViews();
        statuses.clear();
        verifyLines.clear();
        titles.clear();
        links.clear();
        starts.clear();
        connectBtn = null;
        connectStatus = null;
        logListBox = null;
        logOlderBtn = null;
        logLatestBtn = null;

        pageScroll = new ScrollView(activity);
        root.addView(pageScroll);
        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3), dp(Theme.S4), dp(Theme.S4));
        pageScroll.addView(col);
        final int keepY = savedScrollY;
        if (keepY > 0) pageScroll.post(() -> { if (pageScroll != null) pageScroll.scrollTo(0, keepY); });

        if (tab.startsWith("edit:")) {
            col.addView(header("B 站账号设置"));
            if (bot != null) {
                for (BotRegistry.Binding row : bot.bindings) {
                    if (row.id.equals(tab.substring(5)) && row.hostedBili()) {
                        edit(col, row);
                        return;
                    }
                }
            }
            note(col, "找不到此账号，请返回平台页。");
            return;
        }

        boolean config = "config".equals(tab);
        boolean dashboard = "dashboard".equals(tab);
        col.addView(header(bot == null ? "找不到机器人" : bot.name + " · " + (config ? "配置" : dashboard ? "看板" : "启动")));
        if (bot == null) return;

        String primaryBindingId = "default";
        int count = 0;
        for (BotRegistry.Binding row : bot.bindings) {
            if (!BotRegistry.P_BILIBILI.equals(row.platform)) continue;
            if (count == 0) primaryBindingId = row.id;
            count++;

            FrameLayout card = Ui.card(activity, t);
            LinearLayout box = Ui.column(activity);
            int p = dp(Theme.S3);
            box.setPadding(p, p, p, p);
            card.addView(box);
            col.addView(card, pad());

            JSONObject snap = row.hostedBili() ? RemoteBridge.biliStatus(bot.id, row.id) : null;
            TextView titleView = Ui.strong(activity, accountTitle(row, snap), Theme.T_CARD, t.textPrimary);
            box.addView(titleView);
            titles.put(row, titleView);

            boolean saved = row.hostedBili() && RemoteBridge.hasBiliSession(activity, bot.id, row.id);
            String refSummary = row.hostedBili() && snap != null ? snap.optString("refreshSummary", "") : "";
            box.addView(Ui.text(activity,
                    (saved ? "已保存登录（仅本机 Keystore）" : "未保存登录")
                            + (refSummary.isEmpty() ? "" : " · " + refSummary),
                    Theme.T_CAP, t.textSecondary), padTight());
            String verifyText = row.hostedBili()
                    ? BiliPlatformState.label(snap == null ? "" : snap.optString("state"), row.accountId, snap == null ? "" : snap.optString("selfId"))
                    : (row.accountId.isEmpty() ? "尚未登录" : "外部协议端");
            TextView verifyView = Ui.text(activity, "最近核验：" + verifyText, Theme.T_CAP, t.textTertiary);
            box.addView(verifyView, padTight());
            verifyLines.put(row, verifyView);

            if (dashboard) {
                box.addView(Ui.text(activity, "登录态只在本机有效，换设备需要重新授权。", Theme.T_CAP, t.textTertiary), padTight());
                TextView line = note(box, "");
                statuses.put(row, line);
            } else if (config) {                note(box, "私信对端：" + (row.peerId.isEmpty() ? "未设置" : row.peerId));
                note(box, "记忆与知识库：" + ("isolated".equals(row.memoryMode) ? "独立" : "共享"));
                if (row.hostedBili()) {
                    button(box, "账号操作", false, () -> PromptSheet.choose(
                            activity, t, "账号操作",
                            new String[]{"退出账号 / 清除登录态"},
                            i -> forget(row), null, null));
                    button(box, "编辑账号配置", false, () -> shell.pushBiliAccounts(bot.id, "edit:" + row.id));
                } else if (row.accountId.isEmpty()) {
                    note(box, "在启动页登录后，可设置私信对端与记忆范围。");
                } else {
                    button(box, "编辑外部协议地址", false, () -> shell.pushBot(bot.id));
                }
            } else {
                TextView line = note(box, "");
                statuses.put(row, line);
                if (row.hostedBili()) {
                    starts.put(row, button(box, saved ? "快速登录 / 重连" : "授权登录", true, () -> start(row)));
                    TextView link = button(box, "查看本次授权二维码", false, () -> open(row));
                    link.setVisibility(View.GONE);
                    links.put(row, link);
                    LinearLayout biliActRow = Ui.row(activity);
                    TextView reauthMenuBtn = Ui.button(activity, t, "多通道重登 / 导入", false);
                    reauthMenuBtn.setOnClickListener(v -> showReauthChannels(row));
                    TextView restartBiliBtn = Ui.button(activity, t, "独立热重启", false);
                    restartBiliBtn.setOnClickListener(v -> {
                        loginFeedback.remove(row.id);
                        setRowFeedback(row, "正在独立热重启 B 站协议端…");
                        RemoteBridge.restartBili(activity, bot.id, row.id, row.peerId);
                        refresh();
                    });
                    biliActRow.addView(reauthMenuBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1.15f));
                    LinearLayout.LayoutParams rbLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
                    rbLp.leftMargin = dp(Theme.S2);
                    biliActRow.addView(restartBiliBtn, rbLp);
                    box.addView(biliActRow, pad());
                    button(box, "停止此账号", false, () -> {
                        loginFeedback.remove(row.id);
                        RemoteBridge.stopBili(bot.id, row.id);
                        new Thread(() -> {
                            try {
                                if (RemoteBridge.isRemote()) {
                                    RemoteBridge.rpcSync("bots.stopBinding",
                                            new org.json.JSONObject().put("botId", bot.id).put("bindingId", row.id), 8000);
                                } else {
                                    ContainerService.stopInstalledBinding(bot.id, row.id);
                                }
                                activity.runOnUiThread(this::refresh);
                            } catch (Exception ex) {
                                activity.runOnUiThread(() -> host().toast("未能停止此账号的工作进程"));
                            }
                        }, "stop-bili-binding").start();
                    });
                } else if (row.accountId.isEmpty()) {
                    button(box, "登录 B 站", true, () -> shell.pushBiliAccounts(bot.id, "slot:" + row.id));
                }
            }
        }

        // 每次进这个页都把「当前配置 + 平台开关」同步给容器里的行为层。
        // 只在保存按钮上写是不够的：用户可能从没点过保存，容器里就永远是空的。
        if (count > 0) {
            try {
                BiliRuntime.publish(activity, bot.id, primaryBindingId);
            } catch (Exception ignored) {
            }
        }

        if (dashboard) {
            if (count == 0) {
                FrameLayout emptyCard = Ui.card(activity, t);
                LinearLayout emptyBox = Ui.column(activity);
                int p = dp(Theme.S3);
                emptyBox.setPadding(p, p, p, p);
                emptyCard.addView(emptyBox);
                emptyBox.addView(Ui.strong(activity, "账号档案", Theme.T_CARD, t.textPrimary));
                note(emptyBox, "这台机器人还没有 B 站账号。");
                emptyBox.addView(Ui.text(activity, "登录态只在本机有效，换设备需要重新授权。", Theme.T_CAP, t.textTertiary), padTight());
                col.addView(emptyCard, pad());
            }
            buildDashboardCards(col, primaryBindingId);
        }

        if ("start".equals(tab) && count > 0 && BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            connectBtn = button(col, "连接机器人", false, this::connectRobot);
            connectStatus = Ui.text(activity, "", Theme.T_CAP, t.textSecondary);
            connectStatus.setVisibility(View.GONE);
            col.addView(connectStatus, padTight());
        }

        if (!dashboard && count == 0) {
            note(col, "这台机器人还没有 B 站账号。");
        }

        if ("start".equals(tab) && BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)
                && bot.bindings.stream().noneMatch(b -> BotRegistry.P_BILIBILI.equals(b.platform) && b.accountId.isEmpty())) {
            button(col, "添加另一个 B 站账号", false, () -> shell.pushBiliAccounts(bot.id, "new:b-" + UUID.randomUUID()));
        } else if (config) {
            buildBehaviorSettings(col, primaryBindingId);
            button(col, "管理账号绑定", false, () -> shell.pushBot(bot.id));
        }

        if (config && RuntimeSurfaces.builtin(bot)) {
            CoreInventory.Instance c = BotRegistry.coreForBot(bot.id);
            if (c != null && CoreManagerScreen.managed(c)) {
                button(col, "平台插件", false, () -> shell.corePage("plugins", c.id));
            }
        }

        refresh();
    }

    private String accountTitle(BotRegistry.Binding row, JSONObject status) {
        if (row.accountId == null || row.accountId.isEmpty()) return "尚未登录";
        String nick = "";
        if (status != null) {
            nick = status.optString("nickname", "").trim();
            if (nick.isEmpty()) nick = status.optString("uname", "").trim();
            if (nick.isEmpty()) nick = status.optString("name", "").trim();
        }
        return nick.isEmpty() ? ("UID " + row.accountId) : ("UID " + row.accountId + " · " + nick);
    }

    private void connectRobot() {
        if (connectStatus != null) {
            connectStatus.setVisibility(View.VISIBLE);
            connectStatus.setText("正在启动…");
        }
        if (connectBtn != null) {
            Ui.enabled(connectBtn, false);
        }

        CoreInventory.Instance core = BotRegistry.coreForBot(bot.id);
        if (core != null && CoreManagerScreen.managed(core)) {
            if (!BotRegistry.platformEnabled(bot.id, BotRegistry.P_BILIBILI)) {
                boolean enabledOk = BotRegistry.setPlatformEnabled(bot.id, BotRegistry.P_BILIBILI, true);
                if (!enabledOk) {
                    onConnectResult(false, "无法开启此机器人的 B 站平台");
                    return;
                }
                // 平台一开，行为层就该能读到「已启用」—— 否则用户点了连接，容器里那份配置还写着 enabled=false。
                String bindingId = "default";
                for (BotRegistry.Binding row : bot.bindings) {
                    if (BotRegistry.P_BILIBILI.equals(row.platform)) { bindingId = row.id; break; }
                }
                BiliRuntime.publish(activity, bot.id, bindingId);
            }
            new Thread(() -> {
                try {
                    RemoteBridge.startInstalledPlatform(activity, bot.id, BotRegistry.P_BILIBILI);
                    activity.runOnUiThread(() -> onConnectResult(true, null));
                } catch (Exception e) {
                    String reason = e.getMessage();
                    if (reason == null || reason.trim().isEmpty()) reason = e.getClass().getSimpleName();
                    final String msg = reason;
                    activity.runOnUiThread(() -> onConnectResult(false, msg));
                }
            }, "connect-bili").start();
        } else {
            new Thread(() -> {
                try {
                    RemoteBridge.startBoundBot(activity, bot.id);
                    activity.runOnUiThread(() -> onConnectResult(true, null));
                } catch (Exception e) {
                    String reason = e.getMessage();
                    if (reason == null || reason.trim().isEmpty()) reason = e.getClass().getSimpleName();
                    final String msg = reason;
                    activity.runOnUiThread(() -> onConnectResult(false, msg));
                }
            }, "connect-bili-bound").start();
        }
    }

    private void onConnectResult(boolean ok, String error) {
        if (connectBtn != null) {
            Ui.enabled(connectBtn, true);
            connectBtn.setText(ok ? "连接机器人" : "重试连接机器人");
        }
        if (connectStatus != null) {
            connectStatus.setVisibility(View.VISIBLE);
            connectStatus.setText(ok ? "已启动" : "启动失败：" + (error == null ? "未知错误" : error));
        }
        refresh();
    }

    // ---------------------------------------------------------------- 看板卡片

    private void buildDashboardCards(LinearLayout col, String bindingId) {
        Map<String, Integer> today = BiliActionLog.todayCounts(activity, bot.id);
        JSONObject cfg = RemoteBridge.getBiliSettings(activity, bot.id, bindingId);

        // 2) 今日统计卡
        LinearLayout statsBox = addSectionCard(col, "今日统计");
        int browseCount = BiliActionLog.countOf(today, "browse");
        int commentCount = BiliActionLog.countOf(today, "comment");
        int likeCount = BiliActionLog.countOf(today, "like");
        note(statsBox, "浏览视频：" + browseCount + "  ·  发出评论：" + commentCount + "  ·  点赞：" + likeCount);

        // 3) 配额卡
        LinearLayout quotaBox = addSectionCard(col, "今日配额");
        int coinCount = BiliActionLog.countOf(today, "coin");
        int followCount = BiliActionLog.countOf(today, "follow");
        int maxComment = BiliSettings.getInt(cfg, "write.commentPerDay", 10);
        int maxLike = BiliSettings.getInt(cfg, "write.likePerDay", 50);
        int maxCoin = BiliSettings.getInt(cfg, "write.coinPerDay", 10);
        int maxFollow = BiliSettings.getInt(cfg, "write.followPerDay", 5);
        note(quotaBox, "评论 " + commentCount + "/" + maxComment
                + "  ·  点赞 " + likeCount + "/" + maxLike
                + "\n投币 " + coinCount + "/" + maxCoin
                + "  ·  关注 " + followCount + "/" + maxFollow);

        // 3.5) 待审评论卡：只要有草稿就显示（草稿只会在「发送前先审」下产生），
        //      这样即使用户事后把这个开关关了，已经排队的草稿仍然能处理，不会变成谁也看不见的悬案。
        boolean reviewBeforeSend = BiliSettings.getBool(cfg, "write.reviewBeforeSend", false);
        java.util.List<org.json.JSONObject> pendingRows = BiliRuntime.pendingComments(activity, bot.id);
        if (!pendingRows.isEmpty()) {
            LinearLayout pendingBox = addSectionCard(col, "待审评论 · " + pendingRows.size() + " 条");
            note(pendingBox, "点「通过」才会真的发出去；「不通过」只丢弃草稿。");
            int shown = 0;
            for (final org.json.JSONObject row : pendingRows) {
                if (shown++ >= 5) break;
                String text = row.optString("text", "").trim();
                String bvid = row.optString("bvid", "");
                TextView tv = Ui.text(activity, text, Theme.T_BODY, t.textPrimary);
                LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
                if (shown > 1) lp.topMargin = dp(Theme.S2);
                pendingBox.addView(tv, lp);
                pendingBox.addView(Ui.text(activity, bvid + "  ·  " + text.length() + " 字", Theme.T_CAP, t.textTertiary), padTight());
                LinearLayout row2 = Ui.row(activity);
                final String pendingId = row.optString("id", "");
                TextView approveBtn = Ui.button(activity, t, "通过", true);
                approveBtn.setOnClickListener(v -> decidePending(bot.id, "approve", pendingId));
                LinearLayout.LayoutParams lpA = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
                lpA.rightMargin = dp(Theme.S1);
                row2.addView(approveBtn, lpA);

                TextView rejectBtn = Ui.button(activity, t, "不通过", false);
                rejectBtn.setOnClickListener(v -> decidePending(bot.id, "reject", pendingId));
                LinearLayout.LayoutParams lpR = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
                lpR.leftMargin = dp(Theme.S1);
                row2.addView(rejectBtn, lpR);
                pendingBox.addView(row2, padTight());
            }
            if (pendingRows.size() > 5) {
                note(pendingBox, "还有 " + (pendingRows.size() - 5) + " 条，处理完再刷新。");
            }
        } else if (!reviewBeforeSend) {
            // 自动发送模式下给一句状态，免得用户找不到"我的评论去哪了"。
            note(addSectionCard(col, "待审评论"), "未开启「发送前先审」。生成后直接发。");
        }

        // 4) 动作流水卡 + B 站诊断黑匣子入口
        LinearLayout logBox = addSectionCard(col, "动作流水");
        logListBox = Ui.column(activity);
        logBox.addView(logListBox, pad());
        logOlderBtn = button(logBox, "更早", false, () -> {
            logPage++;
            renderLogPage();
        });
        logLatestBtn = button(logBox, "回到最新", false, () -> {
            logPage = 0;
            renderLogPage();
        });
        button(logBox, "查看 B 站诊断黑匣子", false, () ->
                ModelsScreen.W.infoDialog(activity, t, "B 站连接与续期黑匣子", RemoteBridge.biliBlackbox(80)));
        renderLogPage();
    }

    private void renderLogPage() {
        if (logListBox == null) return;
        logListBox.removeAllViews();
        List<JSONObject> rows = RemoteBridge.biliActionLogPage(activity, bot.id, logPage, BiliActionLog.DEFAULT_PAGE_SIZE);
        int total = RemoteBridge.isRemote() ? ((logPage + 1) * BiliActionLog.DEFAULT_PAGE_SIZE + (rows.size() == BiliActionLog.DEFAULT_PAGE_SIZE ? 1 : 0)) : BiliActionLog.count(activity, bot.id);
        if (rows.isEmpty()) {
            logListBox.addView(Ui.text(activity, "还没有动作记录", Theme.T_BODY, t.textSecondary));
        } else {
            for (int i = 0; i < rows.size(); i++) {
                JSONObject item = rows.get(i);
                String time = BiliActionLog.formatTime(item.optLong("t", 0L));
                String kind = BiliActionLog.kindLabel(item.optString("kind", ""));
                String res = BiliActionLog.resultLabel(item.optString("result", ""));
                String title = item.optString("title", "").trim();
                if (title.isEmpty()) title = BiliActionLog.reasonLabel(item.optString("detail", ""));
                String line = time + "  " + kind + " · " + res + (title.isEmpty() ? "" : "  " + title);
                TextView tv = Ui.text(activity, line, Theme.T_CAP, t.textPrimary);
                LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
                if (i > 0) lp.topMargin = dp(Theme.S1);
                logListBox.addView(tv, lp);
            }
        }
        boolean hasOlder = (logPage + 1) * BiliActionLog.DEFAULT_PAGE_SIZE < total;
        if (logOlderBtn != null) Ui.enabled(logOlderBtn, hasOlder);
        if (logLatestBtn != null) Ui.enabled(logLatestBtn, logPage > 0);
    }

    // ---------------------------------------------------------------- B 站行为配置卡片

    private void buildBehaviorSettings(LinearLayout col, final String bindingId) {
        JSONObject cfg = RemoteBridge.getBiliSettings(activity, bot.id, bindingId);

        col.addView(Ui.strong(activity, "B 站常用行为开关", Theme.T_CARD, t.textPrimary), padSection());

        // 一级常用卡：只放新手最关心的核心开关与中文选项（安全默认：仅浏览，写操作与私信默认关）
        LinearLayout basicBox = addSectionCard(col, "基础开关与安全护栏");
        final EditText adminUid = textInput(basicBox, "管理员 UID（可留空）", BiliSettings.getString(cfg, "admin.uid", ""));
        final CheckBox browseEnabled = check(basicBox, "启用定时巡看视频", BiliSettings.getBool(cfg, "browse.enabled", true));
        final CheckBox browseFree = check(basicBox, "自由巡看（不限分区）", BiliSettings.getBool(cfg, "browse.freeBrowse", true));
        final List<String> chosenZones = new ArrayList<String>(BiliSettings.getStringList(cfg, "browse.partitions"));
        final TextView[] zoneBtn = new TextView[1];
        zoneBtn[0] = button(basicBox, zoneLabel(chosenZones), false, () -> pickZones(chosenZones, zoneBtn[0]));
        final TextView browseZones = zoneBtn[0];
        browseZones.setEnabled(!browseFree.isChecked());
        browseFree.setOnCheckedChangeListener((view, checked) -> browseZones.setEnabled(!checked));

        final CheckBox readEnabled = check(basicBox, "启用评论区读取", BiliSettings.getBool(cfg, "read.enabled", true));
        final CheckBox writeEnabled = check(basicBox, "启用评论/点赞/投币等写操作（默认关）", BiliSettings.getBool(cfg, "write.enabled", false));
        final CheckBox writeReview = check(basicBox, "发评论前先由我审核（推荐开启）", BiliSettings.getBool(cfg, "write.reviewBeforeSend", true));
        final CheckBox dmEnabled = check(basicBox, "启用私信自动回复（默认关）", BiliSettings.getBool(cfg, "dm.enabled", false));
        final CheckBox liveEnabled = check(basicBox, "启用直播间互动（默认关）", BiliSettings.getBool(cfg, "live.enabled", false));
        final CheckBox riskStopVerify = check(basicBox, "遇到验证码或风控立即停止（推荐开启）", BiliSettings.getBool(cfg, "risk.stopOnVerify", true));

        // 折叠的高级频率、配额与资料库参数
        final LinearLayout advWrap = Ui.column(activity);
        advWrap.setVisibility(View.GONE);
        final TextView[] advToggle = new TextView[1];
        advToggle[0] = button(col, "展开进阶频率、配额与风控细调 ▾", false, () -> {
            boolean show = advWrap.getVisibility() != View.VISIBLE;
            advWrap.setVisibility(show ? View.VISIBLE : View.GONE);
            advToggle[0].setText(show ? "收起进阶频率、配额与风控细调 ▴" : "展开进阶频率、配额与风控细调 ▾");
        });
        col.addView(advWrap, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 进阶：巡看细调（用中文选项按钮取代英文手填）
        LinearLayout browseBox = addSectionCard(advWrap, "巡看来源与节奏");
        final String[] curSourceVal = new String[] { BiliSettings.joinCsv(BiliSettings.getStringList(cfg, "browse.sources")) };
        if (curSourceVal[0].isEmpty()) curSourceVal[0] = "recommend,follow";
        final EditText browseSources = textInput(browseBox, "来源列表（可点下方快捷切换）", curSourceVal[0]);
        LinearLayout srcRow = Ui.row(activity);
        TextView srcBoth = Ui.button(activity, t, "推荐+关注", false);
        srcBoth.setOnClickListener(v -> browseSources.setText("recommend,follow"));
        TextView srcRec = Ui.button(activity, t, "仅推荐", false);
        srcRec.setOnClickListener(v -> browseSources.setText("recommend"));
        TextView srcFol = Ui.button(activity, t, "仅关注", false);
        srcFol.setOnClickListener(v -> browseSources.setText("follow"));
        LinearLayout.LayoutParams sLp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        srcRow.addView(srcBoth, sLp);
        LinearLayout.LayoutParams sLp2 = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        sLp2.leftMargin = dp(Theme.S1);
        srcRow.addView(srcRec, sLp2);
        LinearLayout.LayoutParams sLp3 = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        sLp3.leftMargin = dp(Theme.S1);
        srcRow.addView(srcFol, sLp3);
        browseBox.addView(srcRow, padTight());

        final EditText browseKeywords = textInput(browseBox, "兴趣关键词（逗号分隔）", BiliSettings.joinCsv(BiliSettings.getStringList(cfg, "browse.keywords")));
        final EditText browseMaxPerRun = numInput(browseBox, "单次最多看几个视频（1-10）", BiliSettings.getInt(cfg, "browse.maxPerRun", 3));
        final EditText browseMaxPerDay = numInput(browseBox, "每日最多看几个视频（1-200）", BiliSettings.getInt(cfg, "browse.maxPerDay", 20));
        final EditText browseMaxMin = numInput(browseBox, "单视频最长分钟（1-30）", BiliSettings.getInt(cfg, "browse.maxMinutesPerVideo", 3));
        final EditText browseGapMin = numInput(browseBox, "两次巡看间隔分钟（10-360）", BiliSettings.getInt(cfg, "browse.gapMinutes", 45));
        final EditText browseJitter = numInput(browseBox, "时间随机抖动 %（0-90）", BiliSettings.getInt(cfg, "browse.jitterPercent", 40));
        final EditText browseWindows = textInput(browseBox, "活跃时段（手机时间，逗号分隔）", BiliSettings.joinCsv(BiliSettings.getStringList(cfg, "browse.windows")));
        final EditText browseSkip = numInput(browseBox, "随机跳过概率 %（0-100）", BiliSettings.getInt(cfg, "browse.skipPercent", 70));

        // 进阶：评论读取
        LinearLayout readBox = addSectionCard(advWrap, "评论读取细调");
        final EditText readMaxPerVideo = numInput(readBox, "单视频读取条数（0-50）", BiliSettings.getInt(cfg, "read.maxPerVideo", 20));
        final EditText readOrder = textInput(readBox, "排序方式（hot=按热度 / time=按时间）", BiliSettings.getString(cfg, "read.order", "hot"));
        LinearLayout ordRow = Ui.row(activity);
        TextView ordHot = Ui.button(activity, t, "按热度", false);
        ordHot.setOnClickListener(v -> readOrder.setText("hot"));
        TextView ordTime = Ui.button(activity, t, "按时间", false);
        ordTime.setOnClickListener(v -> readOrder.setText("time"));
        ordRow.addView(ordHot, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams oLp2 = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        oLp2.leftMargin = dp(Theme.S1);
        ordRow.addView(ordTime, oLp2);
        readBox.addView(ordRow, padTight());
        final CheckBox readStore = check(readBox, "将评论摘要存入资料库", BiliSettings.getBool(cfg, "read.storeToLibrary", true));

        // 进阶：评论与互动配额
        LinearLayout writeBox = addSectionCard(advWrap, "评论与互动每日配额");
        final EditText writeCommentPerDay = numInput(writeBox, "每日评论上限（0-50）", BiliSettings.getInt(cfg, "write.commentPerDay", 10));
        final EditText writeCommentPerVideo = numInput(writeBox, "单视频评论上限（0-10）", BiliSettings.getInt(cfg, "write.commentPerVideo", 1));
        final EditText writeLikePerDay = numInput(writeBox, "每日点赞上限（0-300）", BiliSettings.getInt(cfg, "write.likePerDay", 50));
        final EditText writeCoinPerDay = numInput(writeBox, "每日投币上限（0-100）", BiliSettings.getInt(cfg, "write.coinPerDay", 10));
        final EditText writeFollowPerDay = numInput(writeBox, "每日关注上限（0-20）", BiliSettings.getInt(cfg, "write.followPerDay", 5));
        final CheckBox writeReplyOnly = check(writeBox, "仅回复他人评论（不主动发一级评论）", BiliSettings.getBool(cfg, "write.replyOnly", true));
        final EditText writeMinChars = numInput(writeBox, "最少字数", BiliSettings.getInt(cfg, "write.minChars", 15));
        final EditText writeMaxChars = numInput(writeBox, "最多字数", BiliSettings.getInt(cfg, "write.maxChars", 80));

        // 进阶：私信与直播
        LinearLayout dmBox = addSectionCard(advWrap, "私信与直播细调");
        final EditText dmMaxPerDay = numInput(dmBox, "每日私信上限（0-100）", BiliSettings.getInt(cfg, "dm.maxPerDay", 20));
        final EditText dmPollSeconds = numInput(dmBox, "私信轮询间隔秒（5-120）", BiliSettings.getInt(cfg, "dm.pollSeconds", 15));
        final EditText liveRooms = textInput(dmBox, "直播房间号（逗号分隔）", BiliSettings.joinCsv(BiliSettings.getStringList(cfg, "live.rooms")));
        final EditText liveDanmaku = numInput(dmBox, "每小时弹幕上限（0-120）", BiliSettings.getInt(cfg, "live.danmakuPerHour", 20));

        // 进阶：资料库与风控
        LinearLayout libBox = addSectionCard(advWrap, "资料库与风控阈值");
        final EditText libRetention = numInput(libBox, "保留天数（0-365）", BiliSettings.getInt(cfg, "lib.retentionDays", 30));
        final CheckBox libCondense = check(libBox, "启用浓缩整理", BiliSettings.getBool(cfg, "lib.condenseEnabled", true));
        final EditText libCondenseDays = numInput(libBox, "几天后浓缩（1-90）", BiliSettings.getInt(cfg, "lib.condenseAfterDays", 7));
        final EditText libCondenseModel = textInput(libBox, "浓缩模型（留空用默认）", BiliSettings.getString(cfg, "lib.condenseModel", ""));
        final EditText riskMaxPerHour = numInput(libBox, "每小时操作上限（5-120）", BiliSettings.getInt(cfg, "risk.maxPerHour", 30));
        final EditText riskBackoff = numInput(libBox, "触发风控后退避分钟（1-240）", BiliSettings.getInt(cfg, "risk.backoffMinutes", 15));

        button(col, "保存行为设置", true, () -> {
            Integer vMaxPerRun = parseRange(browseMaxPerRun, 1, 10);
            if (vMaxPerRun == null) return;
            Integer vMaxPerDay = parseRange(browseMaxPerDay, 1, 200);
            if (vMaxPerDay == null) return;
            Integer vMaxMin = parseRange(browseMaxMin, 1, 30);
            if (vMaxMin == null) return;
            Integer vGapMin = parseRange(browseGapMin, 10, 360);
            if (vGapMin == null) return;
            Integer vJitter = parseRange(browseJitter, 0, 90);
            if (vJitter == null) return;
            Integer vSkip = parseRange(browseSkip, 0, 100);
            if (vSkip == null) return;

            Integer vReadMax = parseRange(readMaxPerVideo, 0, 50);
            if (vReadMax == null) return;

            Integer vCommentDay = parseRange(writeCommentPerDay, 0, 50);
            if (vCommentDay == null) return;
            Integer vCommentVideo = parseRange(writeCommentPerVideo, 0, 10);
            if (vCommentVideo == null) return;
            Integer vLikeDay = parseRange(writeLikePerDay, 0, 300);
            if (vLikeDay == null) return;
            Integer vCoinDay = parseRange(writeCoinPerDay, 0, 100);
            if (vCoinDay == null) return;
            Integer vFollowDay = parseRange(writeFollowPerDay, 0, 20);
            if (vFollowDay == null) return;
            Integer vMinChars = parseRange(writeMinChars, 0, 500);
            if (vMinChars == null) return;
            Integer vMaxChars = parseRange(writeMaxChars, 1, 1000);
            if (vMaxChars == null) return;
            if (vMinChars > vMaxChars) {
                writeMaxChars.setError("最多字数不能小于最少字数");
                writeMaxChars.requestFocus();
                return;
            }

            Integer vDmDay = parseRange(dmMaxPerDay, 0, 100);
            if (vDmDay == null) return;
            Integer vPollSec = parseRange(dmPollSeconds, 5, 120);
            if (vPollSec == null) return;

            Integer vDanmaku = parseRange(liveDanmaku, 0, 120);
            if (vDanmaku == null) return;

            Integer vRetention = parseRange(libRetention, 0, 365);
            if (vRetention == null) return;
            Integer vCondenseDays = parseRange(libCondenseDays, 1, 90);
            if (vCondenseDays == null) return;

            Integer vRiskHour = parseRange(riskMaxPerHour, 5, 120);
            if (vRiskHour == null) return;
            Integer vBackoff = parseRange(riskBackoff, 1, 240);
            if (vBackoff == null) return;

            JSONObject next = BiliSettings.defaults();
            try {
                next.put("browse.enabled", browseEnabled.isChecked());
                next.put("browse.sources", BiliSettings.toJsonArray(BiliSettings.splitCsv(browseSources.getText().toString())));
                next.put("admin.uid", adminUid.getText().toString().trim());
                next.put("browse.freeBrowse", browseFree.isChecked());
                next.put("browse.partitions", BiliSettings.toJsonArray(browseFree.isChecked() ? new ArrayList<String>() : chosenZones));
                next.put("browse.keywords", BiliSettings.toJsonArray(BiliSettings.splitCsv(browseKeywords.getText().toString())));
                next.put("browse.maxPerRun", vMaxPerRun.intValue());
                next.put("browse.maxPerDay", vMaxPerDay.intValue());
                next.put("browse.maxMinutesPerVideo", vMaxMin.intValue());
                next.put("browse.gapMinutes", vGapMin.intValue());
                next.put("browse.jitterPercent", vJitter.intValue());
                next.put("browse.windows", BiliSettings.toJsonArray(BiliSettings.splitCsv(browseWindows.getText().toString())));
                next.put("browse.skipPercent", vSkip.intValue());

                next.put("read.enabled", readEnabled.isChecked());
                next.put("read.maxPerVideo", vReadMax.intValue());
                String orderVal = readOrder.getText().toString().trim();
                next.put("read.order", orderVal.isEmpty() ? "hot" : orderVal);
                next.put("read.storeToLibrary", readStore.isChecked());

                next.put("write.enabled", writeEnabled.isChecked());
                next.put("write.commentPerDay", vCommentDay.intValue());
                next.put("write.commentPerVideo", vCommentVideo.intValue());
                next.put("write.likePerDay", vLikeDay.intValue());
                next.put("write.coinPerDay", vCoinDay.intValue());
                next.put("write.followPerDay", vFollowDay.intValue());
                next.put("write.replyOnly", writeReplyOnly.isChecked());
                next.put("write.minChars", vMinChars.intValue());
                next.put("write.maxChars", vMaxChars.intValue());
                next.put("write.reviewBeforeSend", writeReview.isChecked());

                next.put("dm.enabled", dmEnabled.isChecked());
                next.put("dm.maxPerDay", vDmDay.intValue());
                next.put("dm.pollSeconds", vPollSec.intValue());

                next.put("live.enabled", liveEnabled.isChecked());
                next.put("live.rooms", BiliSettings.toJsonArray(BiliSettings.splitCsv(liveRooms.getText().toString())));
                next.put("live.danmakuPerHour", vDanmaku.intValue());

                next.put("lib.retentionDays", vRetention.intValue());
                next.put("lib.condenseEnabled", libCondense.isChecked());
                next.put("lib.condenseAfterDays", vCondenseDays.intValue());
                next.put("lib.condenseModel", libCondenseModel.getText().toString().trim());

                next.put("risk.maxPerHour", vRiskHour.intValue());
                next.put("risk.backoffMinutes", vBackoff.intValue());
                next.put("risk.stopOnVerify", riskStopVerify.isChecked());
            } catch (JSONException ignored) {
            }

            RemoteBridge.putBiliSettings(activity, bot.id, bindingId, next);
            host().toast("行为设置已保存");
        });
    }

    /** 「选择分区」按钮上的文字：告诉用户现在到底按什么范围巡看。 */
    private String zoneLabel(List<String> chosen) {
        if (chosen == null || chosen.isEmpty()) return "分区：未选（自由巡看时不用选）";
        return "分区：已选 " + chosen.size() + " 个";
    }

    /** 分区多选：名字来自线上分区表，用户不用猜某个分区叫什么。 */
    private void pickZones(final List<String> chosen, final TextView label) {
        final List<BiliRegions.Zone> cached = BiliRegions.cached(activity);
        if (!cached.isEmpty()) {
            showZoneDialog(cached, chosen, label);
            return;
        }
        host().toast("正在取分区表…");
        BiliRegions.load(activity, (zones, error) -> {
            if (zones == null || zones.isEmpty()) {
                host().toast("取分区表失败：" + (error == null ? "未知原因" : error));
                return;
            }
            showZoneDialog(zones, chosen, label);
        });
    }

    private void showZoneDialog(List<BiliRegions.Zone> zones, final List<String> chosen, final TextView label) {
        final List<BiliRegions.Zone> flat = new ArrayList<BiliRegions.Zone>();
        final List<String> names = new ArrayList<String>();
        for (BiliRegions.Zone z : zones) {
            flat.add(z);
            names.add(z.name);
            if (z.subs != null) {
                for (BiliRegions.Zone s : z.subs) {
                    flat.add(s);
                    names.add("　└ " + s.name);
                }
            }
        }
        final boolean[] checked = new boolean[flat.size()];
        for (int i = 0; i < flat.size(); i++) {
            checked[i] = chosen.contains(String.valueOf(flat.get(i).tid));
        }
        PromptSheet.multiChoice(
                activity, t, "按分区巡看",
                names.toArray(new String[0]), checked,
                picked -> {
                    chosen.clear();
                    for (int i = 0; i < flat.size(); i++) {
                        if (picked[i]) chosen.add(String.valueOf(flat.get(i).tid));
                    }
                    if (label != null) label.setText(zoneLabel(chosen));
                });
    }

    private LinearLayout addSectionCard(LinearLayout col, String title) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        int p = dp(Theme.S3);
        box.setPadding(p, p, p, p);
        card.addView(box);
        box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary));
        col.addView(card, pad());
        return box;
    }

    private CheckBox check(LinearLayout box, String label, boolean checked) {
        CheckBox cb = new CheckBox(activity);
        cb.setText(label);
        cb.setTextColor(t.textPrimary);
        cb.setMinimumHeight(dp(Theme.TOUCH));
        cb.setChecked(checked);
        box.addView(cb, padTight());
        return cb;
    }

    private EditText numInput(LinearLayout box, String label, int value) {
        EditText e = textInput(box, label, String.valueOf(value));
        e.setInputType(InputType.TYPE_CLASS_NUMBER);
        return e;
    }

    private EditText textInput(LinearLayout box, String label, String value) {
        TextView l = Ui.text(activity, label, Theme.T_CAP, t.textSecondary);
        box.addView(l, padTight());
        EditText e = new EditText(activity);
        e.setId(View.generateViewId());
        l.setLabelFor(e.getId());
        e.setSingleLine(true);
        e.setTextColor(t.textPrimary);
        e.setHintTextColor(t.textTertiary);
        e.setText(value == null ? "" : value);
        box.addView(e, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        return e;
    }

    private Integer parseRange(EditText field, int min, int max) {
        String raw = field.getText().toString().trim();
        try {
            int val = Integer.parseInt(raw);
            if (val < min || val > max) {
                field.setError("请输入 " + min + " - " + max + " 之间的整数");
                field.requestFocus();
                return null;
            }
            field.setError(null);
            return Integer.valueOf(val);
        } catch (NumberFormatException ex) {
            field.setError("请输入 " + min + " - " + max + " 之间的整数");
            field.requestFocus();
            return null;
        }
    }

    // ---------------------------------------------------------------- 基础控件与登录逻辑

    private LinearLayout.LayoutParams pad() {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S2);
        return lp;
    }

    private LinearLayout.LayoutParams padTight() {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S1);
        return lp;
    }

    private LinearLayout.LayoutParams padSection() {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S3);
        return lp;
    }

    private TextView note(LinearLayout box, String val) {
        TextView v = Ui.text(activity, val, Theme.T_BODY, t.textSecondary);
        box.addView(v, pad());
        return v;
    }

    private TextView button(LinearLayout box, String label, boolean primary, Runnable task) {
        TextView v = Ui.button(activity, t, label, primary);
        v.setMinimumHeight(dp(Theme.TOUCH));
        v.setOnClickListener(w -> task.run());
        box.addView(v, pad());
        return v;
    }

    /** 把「通过/不通过」写成一条命令交给运行端；发送动作必须由运行端做（它有协议端令牌）。 */
    private void decidePending(String botId, String action, String id) {
        if (id == null || id.isEmpty()) return;
        boolean ok = BiliRuntime.commandPending(activity, botId, action, id);
        if (!ok) {
            host().toast("没能把命令交给运行端，请稍后重试");
            return;
        }
        host().toast("approve".equals(action) ? "已交给运行端发送，稍后看流水" : "已丢弃这条草稿");
        build();
    }

    private void forget(BotRegistry.Binding row) {
        PromptSheet.confirm(
                activity, t,
                "退出 UID " + row.accountId + "？",
                "停止此账号并清除本机保存的登录。下次启动需重新授权。",
                "退出并清除", () -> {
                    loginFeedback.remove(row.id);
                    boolean ok = RemoteBridge.forgetBili(activity, bot.id, row.id);
                    host().toast(ok ? "已退出此账号" : "未能清除登录，请重试");
                    build();
                },
                null, null, "取消");
    }

    private void setRowFeedback(BotRegistry.Binding row, String message) {
        if (message == null || message.isEmpty()) loginFeedback.remove(row.id);
        else loginFeedback.put(row.id, message);
        TextView tv = statuses.get(row);
        if (tv != null && message != null) {
            tv.setText(message);
        }
    }

    private void start(BotRegistry.Binding row) {
        JSONObject record = RemoteBridge.biliStatus(bot.id, row.id);
        String state = record == null ? "" : record.optString("state");
        if (BiliPlatformState.useSaved(RemoteBridge.hasBiliSession(activity, bot.id, row.id), state)) {
            setRowFeedback(row, "正在准备登录…");
            RemoteBridge.startBili(activity, bot.id, row.id, row.peerId);
            setRowFeedback(row, "已发起，等待协议端起…");
            refresh();
            return;
        }
        setRowFeedback(row, "需要授权，已弹出授权窗");
        String authMsg = (row.peerId.isEmpty() ? "未授权任何私信对端。" : "仅允许配置的私信对端 UID：" + row.peerId)
                + "\n\n登录成功后保存到目标设备，下次可快速登录。";
        PromptSheet.confirm(
                activity, t,
                "授权 UID " + row.accountId,
                authMsg,
                "开始授权", () -> {
                    setRowFeedback(row, "正在准备登录…");
                    RemoteBridge.reauthBili(activity, bot.id, row.id, row.peerId);
                    setRowFeedback(row, "已发起，等待协议端起…");
                    refresh();
                },
                null, null, "取消");
    }

    private void showReauthChannels(final BotRegistry.Binding row) {
        String[] choices = new String[]{
                "官网网页登录（账密 / 手机短信，自动提取续期凭证）",
                "按需扫码重新授权",
                "手动粘贴导入 Cookie（SESSDATA + bili_jct）"
        };
        PromptSheet.choose(activity, t, "B 站多通道重新上线 · UID " + row.accountId, choices, idx -> {
            if (idx == 0) {
                BiliWebLogin.openForSession(activity, row.accountId, new BiliWebLogin.SessionCallback() {
                    @Override public void onSessionCaptured(String rawCookie, String acTimeValue) {
                        submitBiliCookieImport(row, rawCookie, acTimeValue);
                    }
                    @Override public void onCancelled() {
                        host().toast("已取消 B 站官网登录");
                    }
                });
            } else if (idx == 1) {
                setRowFeedback(row, "正在准备扫码授权…");
                RemoteBridge.reauthBili(activity, bot.id, row.id, row.peerId);
                refresh();
            } else if (idx == 2) {
                LinearLayout box = Ui.column(activity);
                box.addView(Ui.text(activity, "粘贴完整 Cookie（含 SESSDATA=...; bili_jct=...；如附带 ac_time_value 可开启无感续期）。", Theme.T_CAP, t.textSecondary));
                final EditText et = new EditText(activity);
                et.setHint("SESSDATA=...; bili_jct=...; ac_time_value=...");
                et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
                et.setMinLines(3);
                Ui.styleInput(et, activity, t);
                box.addView(et, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
                PromptSheet.custom(activity, t, "导入 B 站 Cookie · UID " + row.accountId, box,
                        "核验并保存", (d, b) -> {
                            String raw = et.getText() == null ? "" : et.getText().toString().trim();
                            if (raw.isEmpty()) { host().toast("请输入 Cookie"); return; }
                            d.dismiss();
                            submitBiliCookieImport(row, raw, "");
                        }, null, null, "取消", (d, b) -> d.dismiss(), true, false, null, null);
            }
        }, null, null);
    }

    private void submitBiliCookieImport(final BotRegistry.Binding row, final String rawCookie, final String acTimeValue) {
        setRowFeedback(row, "正在联网校验 UID 并补全指纹…");
        new Thread(() -> {
            JSONObject r = RemoteBridge.importBiliCookie(activity, bot.id, row.id, row.accountId, false, rawCookie, acTimeValue);
            activity.runOnUiThread(() -> {
                if (r != null && r.optBoolean("ok", false)) {
                    setRowFeedback(row, "导入并验真成功（" + r.optString("uname", "") + "），正在启动…");
                    RemoteBridge.startBili(activity, bot.id, row.id, row.peerId);
                    host().toast("B 站登录已更新" + (r.optBoolean("hasRefresh", false) ? "（支持自动续期）" : ""));
                } else {
                    String err = r == null ? "导入失败" : r.optString("error", "导入失败");
                    setRowFeedback(row, "导入失败：" + err);
                    host().toast(err);
                }
                refresh();
            });
        }, "bili-cookie-import").start();
    }

    private void open(BotRegistry.Binding row) {
        String url = RemoteBridge.biliAuthLink(bot.id, row.id);
        challengeBinding = row.id;
        challengeDialog = (url == null || url.isEmpty()) ? null : BiliAuthorizationDialog.show(activity, url, row.accountId, () -> RemoteBridge.stopBili(bot.id, row.id));
        if (challengeDialog == null) host().toast("本次授权码不可用或已过期");
    }

    private EditText input(LinearLayout form, String label, String value) {
        TextView l = new TextView(activity);
        l.setText(label);
        form.addView(l);
        EditText e = new EditText(activity);
        e.setId(View.generateViewId());
        l.setLabelFor(e.getId());
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_NUMBER);
        e.setText(value);
        form.addView(e);
        return e;
    }

    private static boolean validUid(String s) {
        return s != null && s.matches("[1-9][0-9]{0,15}") && Long.parseLong(s) <= 9007199254740991L;
    }

    private void edit(LinearLayout form, BotRegistry.Binding selected) {
        form.addView(Ui.strong(activity, bot.name, Theme.T_CARD, t.textPrimary));
        note(form, "B 站账号 UID：" + selected.accountId);
        EditText peer = input(form, "允许私信的对端 UID（选填）", selected.peerId);
        note(form, "留空不启用私信，仅填写已同意的对端。");
        CheckBox isolate = new CheckBox(activity);
        isolate.setText("此账号单独使用记忆和知识库");
        isolate.setTextColor(t.textPrimary);
        isolate.setMinimumHeight(dp(Theme.TOUCH));
        isolate.setChecked("isolated".equals(selected.memoryMode));
        form.addView(isolate);
        note(form, "默认与这台机器人的其他账号共享。更改后需重新连接。");
        button(form, "保存设置", true, () -> {
            String target = peer.getText().toString().trim();
            if (!target.isEmpty() && (!validUid(target) || target.equals(selected.accountId))) {
                peer.setError("请输入其他账号的有效 UID，或留空。");
                return;
            }
            String mode = isolate.isChecked() ? "isolated" : "shared";
            if (mode.equals(selected.memoryMode) && target.equals(selected.peerId)) {
                shell.handleBack();
                return;
            }
            BotRegistry.Binding next = new BotRegistry.Binding(selected.id, "bilibili", selected.accountId, mode, "", "", target);
            String problem = BotRegistry.changeBinding(bot, selected, next);
            if (problem != null) {
                peer.setError(problem);
                return;
            }
            RemoteBridge.stopBili(bot.id, selected.id);
            host().toast("B 站账号设置已保存");
            shell.handleBack();
        });
        if (bot.bindings.size() > 1) {
            button(form, "移除此账号…", false, () -> CoreBindingOps.remove(this, bot, selected, () -> shell.handleBack()));
        }
    }

    void refresh() {
        super.refresh();
        if (bot == null) return;
        JSONObject workers = statuses.isEmpty() ? null : RemoteBridge.bindingStatus(activity, bot.id);

        for (Map.Entry<BotRegistry.Binding, TextView> entry : verifyLines.entrySet()) {
            BotRegistry.Binding row = entry.getKey();
            if (!row.hostedBili()) continue;
            JSONObject s = RemoteBridge.biliStatus(bot.id, row.id);
            String state = s == null ? "" : s.optString("state");
            String verify = "最近核验：" + BiliPlatformState.label(state, row.accountId, s == null ? "" : s.optString("selfId"));
            if (!verify.contentEquals(entry.getValue().getText())) {
                entry.getValue().setText(verify);
            }
            TextView titleView = titles.get(row);
            if (titleView != null) {
                String titleText = accountTitle(row, s);
                if (!titleText.contentEquals(titleView.getText())) {
                    titleView.setText(titleText);
                }
            }
        }

        for (Map.Entry<BotRegistry.Binding, TextView> entry : statuses.entrySet()) {
            BotRegistry.Binding row = entry.getKey();
            TextView label = entry.getValue();
            String out;
            if (row.accountId.isEmpty()) {
                out = "尚未登录；请在启动页登录 B 站。";
            } else if (!row.hostedBili()) {
                out = "外部协议端：此页不代其登录。";
            } else {
                JSONObject s = RemoteBridge.biliStatus(bot.id, row.id);
                String state = s == null ? "" : s.optString("state");
                String fb = loginFeedback.get(row.id);
                boolean activeState = !state.isEmpty() && !"stopped".equals(state);
                if (activeState && fb != null && !"需要授权，已弹出授权窗".equals(fb)) {
                    loginFeedback.remove(row.id);
                    fb = null;
                }
                out = BiliPlatformState.label(state, row.accountId, s == null ? "" : s.optString("selfId"));
                if (fb != null) {
                    out = fb + "\n" + out;
                }
                if ("dashboard".equals(tab) && s != null && s.has("received")) {
                    long at = s.optLong("lastReceived");
                    out += "\n收信数：" + s.optInt("received")
                            + "  ·  上次收信：" + (at > 0 ? DateFormat.getDateTimeInstance().format(new Date(at)) : "暂无记录");
                }
                boolean pending = "waiting".equals(state) || "scanned".equals(state) || "awaiting_confirmation".equals(state);
                if (!pending && row.id.equals(challengeBinding) && challengeDialog != null) {
                    challengeDialog.dismiss();
                    challengeDialog = null;
                    challengeBinding = null;
                }
                TextView link = links.get(row);
                if (link != null) link.setVisibility(pending ? View.VISIBLE : View.GONE);
            }

            boolean verified = false;
            if (workers != null) {
                JSONArray rows = workers.optJSONArray("bindings");
                if (rows != null) {
                    for (int i = 0; i < rows.length(); i++) {
                        JSONObject r = rows.optJSONObject(i);
                        if (r != null && BindingPresentation.connected(row, workers.optString("state"),
                                r.optString("id"), r.optString("platform"), r.optString("accountId"), r.optString("state"))) {
                            verified = true;
                        }
                    }
                }
            }
            out += "\n机器人连接：" + (verified ? "已验证" : "未验证");
            if ("dashboard".equals(tab)) {
                out += "\n私信对端：" + (row.peerId.isEmpty() ? "未授权" : row.peerId);
            }
            if (!out.contentEquals(label.getText())) {
                label.setText(out);
            }
        }
    }
}
