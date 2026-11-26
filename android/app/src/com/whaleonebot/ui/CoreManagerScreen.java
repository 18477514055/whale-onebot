package com.whaleonebot.ui;

import android.content.*;
import android.net.Uri;
import android.view.*;
import android.widget.*;
import com.whaleonebot.backup.CoreBackupSaf;
import com.whaleonebot.install.CoreInstaller;
import java.io.*;
import java.text.SimpleDateFormat;
import java.util.*;
import static android.view.ViewGroup.LayoutParams.*;

/**
 * [layer: shell-android] 核心库存维护、三段式备份中心、平台插件、下载核心与自定义核心接入。
 *
 * <p>按 2026-11-25 问答报告（Q1/Q3/Q7/Q8/Q11/Q13/Q14）全面卡片化：
 * 1) 告别 0 卡片裸页，6 个子模式全部采用标准 Ui.card 白色圆角卡片 + 1dp 分割线 + 状态胶囊；
 * 2) 备份页升级为三段式「备份中心」（包含/不含对比卡 + 每台机器人自动算体积与上次导出时间卡 + 恢复与维护卡）；
 * 3) 核心维护页拆成「概览（自动后台算存储与运行态）/ 平台插件 / 维护与危险区」三张独立卡片；
 * 4) 进度统一格式化为 MB + 百分比，彻底消灭原始字节数与 41 字符 UUID。
 */
final class CoreManagerScreen extends Screen {
    static final int FILE_REQUEST = 0x5728;
    private static final String BACKUP_PREFS = "whaleonebot.backups";

    final String mode, id;
    LinearLayout col;
    TextView status;
    ProgressBar progress;
    LinearLayout statusCardBox;
    boolean busy;
    String op, owner, chosen;

    CoreManagerScreen(AppShell sh, String mode, String id) {
        super(sh);
        this.mode = mode;
        this.id = id;
    }

    static String title(CoreInventory.Instance c) {
        return Ui.coreDisplayTitle(c) + " · " + Ui.coreMetaLine(c);
    }

    static CoreInventory.Instance find(String id) {
        for (CoreInventory.Instance c : BotRegistry.cores()) if (c.id.equals(id)) return c;
        return null;
    }

    static String occupant(CoreInventory.Instance c) {
        BotRegistry.Bot b = BotRegistry.get(c.ownerId);
        return c.ownerId.isEmpty() ? "空闲" : b == null ? c.ownerId : b.name;
    }

    static List<String> platforms(CoreInventory.Instance c) {
        BotRegistry.Bot bot = BotRegistry.get(c.ownerId);
        return bot == null ? Collections.emptyList() : new ArrayList<>(bot.platforms);
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView sv = new ScrollView(activity);
        sv.setFillViewport(true);
        root.addView(sv, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        sv.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        String pageTitle = "download".equals(mode) ? "下载内置核心"
                : "versions".equals(mode) ? "内置核心列表"
                : "backups".equals(mode) ? "备份中心"
                : "custom".equals(mode) ? "接入自定义核心"
                : "plugins".equals(mode) ? "平台插件"
                : "核心维护";
        col.addView(header(pageTitle), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 顶部动态任务状态条卡片（仅在有状态提示或进度时可见）
        statusCardBox = Ui.addCard(col, activity, t, Theme.S2);
        status = Ui.text(activity, "", Theme.T_BODY, t.textPrimary);
        statusCardBox.addView(status, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setVisibility(View.GONE);
        statusCardBox.addView(progress, topMargin(dp(Theme.S1)));
        ((View) statusCardBox.getParent()).setVisibility(View.GONE);

        if ("download".equals(mode)) {
            buildDownloadMode();
        } else if ("versions".equals(mode)) {
            buildVersionsMode();
        } else if ("custom".equals(mode)) {
            buildCustomMode();
        } else if ("backups".equals(mode)) {
            buildBackupsMode();
        } else {
            buildInstanceOrPluginsMode();
        }
    }

    private void setStatusText(String msg) {
        if (status == null || statusCardBox == null) return;
        boolean show = (msg != null && !msg.trim().isEmpty()) || (progress != null && progress.getVisibility() == View.VISIBLE);
        status.setText(msg == null ? "" : msg);
        ((View) statusCardBox.getParent()).setVisibility(show ? View.VISIBLE : View.GONE);
    }

    // ------------------------------------------------------------------ download 模式

    private void buildDownloadMode() {
        LinearLayout infoCard = Ui.addCard(col, activity, t, Theme.S3);
        infoCard.addView(Ui.strong(activity, "创建空闲的内置核心", Theme.T_CARD, t.textPrimary));
        infoCard.addView(Ui.text(activity,
                "每台机器人占用一份独立核心（含记忆、知识库与独立运行数据）。已缓存的 APK 内置核心与环境包会自动免流量复用。",
                Theme.T_BODY, t.textSecondary), topMargin(dp(Theme.S2)));

        LinearLayout actionCard = Ui.addCard(col, activity, t, Theme.S2);
        actionCard.addView(Ui.strong(activity, "选择版本与份数", Theme.T_CARD, t.textPrimary));
        actionCard.addView(Ui.text(activity, "可一次创建 1–5 份空闲核心，建完后回「设置 → 机器人」即可分配给新机器人。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
        downloadButton = cardButton(actionCard, "选择版本与数量", true, () -> versions(true, null, false));
        shownDownload = null;
        refresh();
    }

    // ------------------------------------------------------------------ versions 兼容模式（卡片化）

    private void buildVersionsMode() {
        LinearLayout topCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout swRow = Ui.row(activity);
        LinearLayout swText = Ui.column(activity);
        swText.addView(Ui.strong(activity, "自动准备核心更新", Theme.T_BODY, t.textPrimary));
        swText.addView(Ui.text(activity, "自动下载，下次正常启动应用时切换（默认仅提醒）",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        swRow.addView(swText, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        Switch sw = new Switch(activity);
        sw.setChecked(CoreInstaller.auto(activity.getFilesDir()));
        sw.setOnCheckedChangeListener((btn, on) -> {
            try { CoreInstaller.setAuto(activity.getFilesDir(), on); }
            catch (Exception ex) { setStatusText("无法更改自动更新"); }
        });
        swRow.addView(sw, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        topCard.addView(swRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        cardButton(topCard, "下载并创建新核心", true, () -> versions(true, null, false));

        col.addView(sectionLabel("本机内置核心"));
        LinearLayout listCard = Ui.addCard(col, activity, t, Theme.S1);
        int count = 0;
        for (CoreInventory.Instance c : BotRegistry.cores()) {
            if (!managed(c)) continue;
            if (count > 0) listCard.addView(Ui.divider(activity, t));
            addCoreRow(listCard, c);
            count++;
        }
        if (count == 0) {
            listCard.addView(Ui.text(activity, "暂无已安装的内置核心，请先点上方按钮创建。",
                    Theme.T_BODY, t.textSecondary));
        }
    }

    // ------------------------------------------------------------------ custom 模式（Q13）

    private void buildCustomMode() {
        LinearLayout infoCard = Ui.addCard(col, activity, t, Theme.S3);
        infoCard.addView(Ui.strong(activity, "什么是自定义核心？", Theme.T_CARD, t.textPrimary));
        infoCard.addView(Ui.text(activity,
                "除内置机器人核心外，你也可以通过描述文件接入第三方或自建运行端。自定义核心仅读取描述元数据，不会从描述链接自动安装未知代码。",
                Theme.T_BODY, t.textSecondary), topMargin(dp(Theme.S2)));

        col.addView(sectionLabel("选择接入方式"));
        LinearLayout waysCard = Ui.addCard(col, activity, t, Theme.S1);
        addActionRow(waysCard, IconView.TUNE, "导入本地描述文件", "从本机存储选择 .json 核心描述文件",
                () -> pick("descriptor", null));
        waysCard.addView(Ui.divider(activity, t));
        addActionRow(waysCard, IconView.CHAT, "从 HTTPS 链接导入", "输入公开 HTTPS 描述地址并预览确认",
                () -> CoreImports.link(this));
        waysCard.addView(Ui.divider(activity, t));
        addActionRow(waysCard, IconView.TUNE, "开启本机登记（2 分钟）", "临时监听本机回环端口并生成一次性授权码",
                () -> CoreImports.register(this));
    }

    // ------------------------------------------------------------------ backups 三段式备份中心（Q7）

    private void buildBackupsMode() {
        // 卡 1：包含 / 不含范围对比说明卡
        LinearLayout scopeCard = Ui.addCard(col, activity, t, Theme.S3);
        scopeCard.addView(Ui.strong(activity, "备份范围说明", Theme.T_CARD, t.textPrimary));
        LinearLayout incRow = Ui.row(activity);
        incRow.addView(Ui.pill(activity, t, "✓ 包含", Ui.TONE_OK));
        TextView incText = Ui.text(activity, "记忆库、知识库、人设与运行端配置", Theme.T_BODY, t.textPrimary);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        ilp.leftMargin = dp(Theme.S2);
        incRow.addView(incText, ilp);
        scopeCard.addView(incRow, topMargin(dp(Theme.S2)));

        LinearLayout excRow = Ui.row(activity);
        excRow.addView(Ui.pill(activity, t, "✕ 不含", Ui.TONE_NEUTRAL));
        TextView excText = Ui.text(activity, "QQ / B 站登录态、API Key 与协议令牌（恢复后需重新授权）", Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        elp.leftMargin = dp(Theme.S2);
        excRow.addView(excText, elp);
        scopeCard.addView(excRow, topMargin(dp(Theme.S2)));

        // 卡 2：可备份的机器人列表（每台直接显示名称、实例存储占用、上次导出时间与一键导出）
        List<CoreInventory.Instance> occupied = new ArrayList<>();
        int freeCount = 0;
        for (CoreInventory.Instance c : BotRegistry.cores()) {
            if (!managed(c)) continue;
            if (c.ownerId == null || c.ownerId.isEmpty()) freeCount++;
            else occupied.add(c);
        }

        col.addView(sectionLabel("可备份的机器人（" + occupied.size() + "）"));
        LinearLayout exportCard = Ui.addCard(col, activity, t, Theme.S1);
        if (occupied.isEmpty()) {
            exportCard.addView(Ui.text(activity, "暂无已分配内置核心的机器人可供导出。",
                    Theme.T_BODY, t.textSecondary));
        } else {
            for (int i = 0; i < occupied.size(); i++) {
                if (i > 0) exportCard.addView(Ui.divider(activity, t));
                final CoreInventory.Instance c = occupied.get(i);
                LinearLayout row = Ui.row(activity);
                row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));

                LinearLayout left = Ui.column(activity);
                left.addView(Ui.strong(activity, Ui.coreDisplayTitle(c), Theme.T_BODY, t.textPrimary));
                left.addView(Ui.text(activity, Ui.coreMetaLine(c), Theme.T_CAP, t.textSecondary), topMargin(dp(2)));
                String lastText = lastBackupLabel(c.id);
                final TextView meta = Ui.text(activity, "占用：计算中… · 上次导出：" + lastText,
                        Theme.T_CAP, t.textTertiary);
                left.addView(meta, topMargin(dp(4)));
                loadCoreStorageAsync(c.id, bytes -> meta.setText("占用：" + Ui.formatBytes(bytes) + " · 上次导出：" + lastText));

                row.addView(left, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                TextView expBtn = Ui.button(activity, t, "导出", true);
                expBtn.setPadding(dp(Theme.S3), dp(10), dp(Theme.S3), dp(10));
                expBtn.setOnClickListener(v -> { if (!busy) pick("export", c); });
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
                blp.leftMargin = dp(Theme.S2);
                row.addView(expBtn, blp);
                exportCard.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
        }

        // 卡 3：恢复与维护
        col.addView(sectionLabel("恢复与维护"));
        LinearLayout maintCard = Ui.addCard(col, activity, t, Theme.S1);
        LinearLayout freeRow = Ui.row(activity);
        freeRow.addView(Ui.strong(activity, "从备份文件恢复", Theme.T_BODY, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        freeRow.addView(Ui.pill(activity, t, "空闲核心 " + freeCount + " 份",
                freeCount > 0 ? Ui.TONE_OK : Ui.TONE_WARN));
        maintCard.addView(freeRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        maintCard.addView(Ui.text(activity,
                freeCount > 0
                        ? "选择一个空闲内置核心，再选择本机 .whalebackup 文件即可恢复机器人数据。"
                        : "当前没有空闲内置核心，请先在「版本管理」下载一份核心后再恢复。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
        cardButton(maintCard, "从本地备份恢复到空闲核心", freeCount > 0, () -> selectCore(true, c -> pick("restore", c)));

        maintCard.addView(Ui.divider(activity, t));
        maintCard.addView(Ui.strong(activity, "清理旧备份文件", Theme.T_BODY, t.textPrimary));
        maintCard.addView(Ui.text(activity, "打开系统文件选择器，永久删除不需要的本机 .whalebackup 文件。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        cardButton(maintCard, "删除本地备份文件", false, () -> pick("delete", null));
    }

    // ------------------------------------------------------------------ instance（3 卡）& plugins 模式（Q11/Q13）

    private void buildInstanceOrPluginsMode() {
        CoreInventory.Instance c = find(id);
        if (c == null) {
            LinearLayout miss = Ui.addCard(col, activity, t, Theme.S3);
            miss.addView(Ui.strong(activity, "核心已不存在", Theme.T_CARD, t.textPrimary));
            miss.addView(Ui.text(activity, "该核心可能已被释放或移除，请返回上一页刷新。", Theme.T_BODY, t.textSecondary),
                    topMargin(dp(Theme.S2)));
            return;
        }

        boolean free = c.ownerId == null || c.ownerId.isEmpty();

        // 卡 1：核心概览卡（自动后台计算运行态与实例存储大小，不再需要手动点按钮）
        LinearLayout overviewCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout headRow = Ui.row(activity);
        headRow.addView(Ui.strong(activity, Ui.coreDisplayTitle(c), Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        headRow.addView(Ui.pill(activity, t, free ? "空闲" : "使用中", free ? Ui.TONE_NEUTRAL : Ui.TONE_OK));
        overviewCard.addView(headRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        overviewCard.addView(Ui.text(activity, Ui.coreMetaLine(c), Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        if (managed(c)) {
            final TextView runtimeInfo = Ui.text(activity, "运行态：读取中… · 实例存储：计算中…",
                    Theme.T_BODY, t.textSecondary);
            overviewCard.addView(runtimeInfo, topMargin(dp(Theme.S2)));
            loadCoreOverviewAsync(c, info -> runtimeInfo.setText(info));
        } else {
            overviewCard.addView(Ui.text(activity,
                    c.legacy ? "原地沿用的现有实例；不在此重置或更新。" : "第三方自定义核心，配置由作者提供。",
                    Theme.T_BODY, t.textSecondary), topMargin(dp(Theme.S2)));
            return;
        }

        // 卡 2：平台插件卡
        List<String> ps = platforms(c);
        col.addView(sectionLabel("平台插件"));
        LinearLayout pluginCard = Ui.addCard(col, activity, t, Theme.S1);
        if (ps.isEmpty()) {
            pluginCard.addView(Ui.text(activity, "当前核心尚未绑定平台（分配给机器人并勾选平台后会自动列出）。",
                    Theme.T_BODY, t.textSecondary));
        } else {
            int missingCount = 0;
            for (int i = 0; i < ps.size(); i++) {
                if (i > 0) pluginCard.addView(Ui.divider(activity, t));
                final String plat = ps.get(i);
                String stateText = pluginVersionOrState(c, plat);
                boolean installed = !"待安装".equals(stateText);
                if (!installed) missingCount++;

                LinearLayout prow = Ui.row(activity);
                prow.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));
                prow.setMinimumHeight(dp(Theme.TOUCH));
                prow.addView(Ui.strong(activity, BotRegistry.PLATFORM_LABEL(plat), Theme.T_BODY, t.textPrimary),
                        new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
                slp.rightMargin = dp(Theme.S1);
                prow.addView(Ui.pill(activity, t, installed ? ("已装 " + stateText) : "待安装",
                        installed ? Ui.TONE_OK : Ui.TONE_WARN), slp);
                prow.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
                prow.setClickable(true);
                prow.setFocusable(true);
                Ui.press(prow, 0.985f);
                prow.setOnClickListener(v -> { if (!busy) pluginVersions(c, plat, true); });
                pluginCard.addView(prow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
            if ("plugins".equals(mode) || missingCount > 0) {
                cardButton(pluginCard, missingCount > 0 ? ("一键安装缺失插件（" + missingCount + "）") : "重新校验 / 重试所需插件",
                        true, () -> estimate(c.version, 1, c, false));
            }
        }

        if ("plugins".equals(mode)) {
            return;
        }

        // 卡 3：版本维护与危险操作卡
        col.addView(sectionLabel("版本维护与数据"));
        LinearLayout maintCard = Ui.addCard(col, activity, t, Theme.S1);
        cardButton(maintCard, "升级或选择兼容版本", false, () -> versions(false, c, false));
        cardButton(maintCard, "查看全部历史版本", false, () -> versions(false, c, true));
        cardButton(maintCard, "回退上一版", false, () -> confirm(
                "安排回退？",
                "下次正常启动时切换回上一版本；建议操作前先导出备份。",
                () -> work(() -> {
                    CoreInstaller.rollback(activity.getFilesDir(), c.id);
                    return "已安排回退（下次正常启动生效）";
                })));
        if (!free) {
            cardButton(maintCard, "导出本实例备份", false, () -> pick("export", c));

            // 1dp 分割线隔离危险操作区（问答报告 Q11）
            maintCard.addView(Ui.divider(activity, t));
            LinearLayout dangerHead = Ui.row(activity);
            dangerHead.addView(Ui.strong(activity, "危险操作", Theme.T_BODY, t.textPrimary),
                    new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            dangerHead.addView(Ui.pill(activity, t, "不可撤销", Ui.TONE_DANGER));
            maintCard.addView(dangerHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            maintCard.addView(Ui.text(activity, "释放核心会清除本实例数据、插件与绑定并移除对应机器人（仅能释放已停止的实例）。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
            TextView danger = cardButton(maintCard, "释放核心", false, () -> release(c));
            danger.setTextColor(t.dark ? 0xFFF87171 : 0xFFB91C1C);
        }
    }

    // ------------------------------------------------------------------ 辅助渲染组件

    private void addCoreRow(LinearLayout parent, final CoreInventory.Instance c) {
        boolean free = c.ownerId == null || c.ownerId.isEmpty();
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));
        row.setMinimumHeight(dp(Theme.TOUCH));

        LinearLayout left = Ui.column(activity);
        LinearLayout top = Ui.row(activity);
        top.addView(Ui.strong(activity, Ui.coreDisplayTitle(c), Theme.T_BODY, t.textPrimary));
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
        plp.leftMargin = dp(Theme.S1);
        top.addView(Ui.pill(activity, t, free ? "空闲" : "使用中", free ? Ui.TONE_NEUTRAL : Ui.TONE_OK), plp);
        left.addView(top, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        left.addView(Ui.text(activity, Ui.coreMetaLine(c), Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        row.addView(left, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
        row.setClickable(true);
        row.setFocusable(true);
        Ui.press(row, 0.985f);
        row.setOnClickListener(v -> shell.corePage("instance", c.id));
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private void addActionRow(LinearLayout parent, int icon, String label, String sub, Runnable click) {
        LinearLayout row = Ui.row(activity);
        row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));
        row.setMinimumHeight(dp(Theme.TOUCH));

        FrameLayout tile = new FrameLayout(activity);
        tile.setBackground(Drawables.round(Ui.alpha(t.accent, 0.14f), 0, 0, dp(Theme.R_TILE)));
        tile.addView(new IconView(activity, icon, t.accent),
                new FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER));
        row.addView(tile, Ui.llp(dp(40), dp(40)));

        LinearLayout text = Ui.column(activity);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        tlp.leftMargin = dp(Theme.S2 + 2);
        tlp.rightMargin = dp(Theme.S2);
        text.addView(Ui.strong(activity, label, Theme.T_BODY, t.textPrimary));
        text.addView(Ui.text(activity, sub, Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        row.addView(text, tlp);

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
        row.setClickable(true);
        row.setFocusable(true);
        Ui.press(row, 0.985f);
        row.setOnClickListener(v -> { if (!busy) click.run(); });
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private TextView cardButton(LinearLayout parent, String s, boolean primary, Runnable fn) {
        TextView v = Ui.button(activity, t, s, primary);
        v.setMinimumHeight(dp(Theme.TOUCH));
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S2);
        parent.addView(v, lp);
        v.setOnClickListener(w -> { if (!busy) fn.run(); });
        return v;
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

    // ------------------------------------------------------------------ 后台统计与核心操作逻辑

    private interface LongCallback { void onDone(long value); }
    private interface TextCallback { void onDone(String text); }

    private void loadCoreStorageAsync(final String coreId, final LongCallback cb) {
        new Thread(() -> {
            long total = 0L;
            try {
                File files = activity.getFilesDir();
                total = storage(new File(files, "core-instances/" + coreId))
                        + storage(new File(files, "rootfs/opt/whale/instance-data/" + coreId));
            } catch (Exception ignored) { }
            final long res = total;
            activity.runOnUiThread(() -> cb.onDone(res));
        }, "core-storage-scan").start();
    }

    private void loadCoreOverviewAsync(final CoreInventory.Instance c, final TextCallback cb) {
        new Thread(() -> {
            String runtime = c.ownerId.isEmpty() ? "未分配"
                    : BoundStartScreen.summary(com.whaleonebot.ContainerService.bindingStatus(activity, c.ownerId).optString("state"));
            long bytes = 0L;
            try {
                File files = activity.getFilesDir();
                bytes = storage(new File(files, "core-instances/" + c.id))
                        + storage(new File(files, "rootfs/opt/whale/instance-data/" + c.id));
            } catch (Exception ignored) { }
            final String text = "运行端：" + runtime + "\n实例存储占用：" + Ui.formatBytes(bytes) + "（不含公共环境）";
            activity.runOnUiThread(() -> cb.onDone(text));
        }, "core-overview-scan").start();
    }

    private String lastBackupLabel(String coreId) {
        long at = activity.getSharedPreferences(BACKUP_PREFS, Context.MODE_PRIVATE).getLong("last_" + coreId, 0L);
        if (at <= 0L) return "尚未记录";
        return new SimpleDateFormat("MM-dd HH:mm", Locale.US).format(new Date(at));
    }

    private void recordBackupTime(String coreId) {
        if (coreId == null || coreId.isEmpty()) return;
        activity.getSharedPreferences(BACKUP_PREFS, Context.MODE_PRIVATE)
                .edit().putLong("last_" + coreId, System.currentTimeMillis()).apply();
    }

    private static long storage(File root) throws IOException {
        if (!root.isDirectory()) return 0;
        long total = 0;
        try (java.util.stream.Stream<java.nio.file.Path> walk = java.nio.file.Files.walk(root.toPath())) {
            Iterator<java.nio.file.Path> paths = walk.iterator();
            while (paths.hasNext()) {
                java.nio.file.Path path = paths.next();
                if (java.nio.file.Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    total += java.nio.file.Files.size(path);
                }
            }
        }
        return total;
    }

    static boolean managed(CoreInventory.Instance c) {
        return "builtin".equals(c.kind) && !c.legacy;
    }

    String pluginState(CoreInventory.Instance c, String platform) {
        try {
            File active = CoreInstaller.active(activity.getFilesDir(), c.id);
            return active != null && new File(active, "src/platform-modules/" + platform + "/.bot-module.json").isFile()
                    ? "已安装" : "待安装";
        } catch (Exception ex) {
            return "待安装";
        }
    }

    private String pluginVersionOrState(CoreInventory.Instance c, String platform) {
        try {
            File active = CoreInstaller.active(activity.getFilesDir(), c.id);
            if (active == null) return "待安装";
            File receipt = new File(active, "src/platform-modules/" + platform + "/.bot-module.json");
            if (!receipt.isFile()) return "待安装";
            byte[] raw = java.nio.file.Files.readAllBytes(receipt.toPath());
            org.json.JSONObject obj = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
            String ver = obj.optString("version", "");
            return ver.isEmpty() ? "已安装" : ver;
        } catch (Exception ex) {
            return pluginState(c, platform);
        }
    }

    void confirm(String title, String msg, Runnable fn) {
        PromptSheet.confirm(activity, t, title, msg, "确认", fn, null, null, "取消");
    }

    interface Action { String run() throws Exception; }
    void work(Action a) { work(a, false); }

    void work(Action a, boolean refreshPage) {
        if (busy) return;
        busy = true;
        progress.setIndeterminate(true);
        progress.setVisibility(View.VISIBLE);
        setStatusText("阶段：正在处理中…");
        new Thread(() -> {
            String m;
            try {
                if (id != null) CoreBindingOps.reconcile(activity.getFilesDir(), find(id));
                m = a.run();
            } catch (Exception ex) {
                android.util.Log.w("WhaleEnv", "核心维护操作未完成", ex);
                m = "操作未完成：" + safe(ex);
            }
            final String msg = m;
            activity.runOnUiThread(() -> {
                busy = false;
                if (refreshPage) build();
                progress.setVisibility(View.GONE);
                setStatusText(msg);
            });
        }, "core-maintenance").start();
    }

    static String safe(Exception e) {
        String msg = e.getMessage();
        if ("CORE_UPDATE_PENDING".equals(msg)) return "已有版本等待切换，请在下次正常启动后再安装插件。";
        return msg != null && msg.matches("[A-Z][A-Z0-9_]{1,64}")
                ? msg : "请检查网络或安装源、存储空间、版本兼容性或文件权限后重试。";
    }

    @Override
    boolean handleBack() {
        if (busy) {
            host().toast("请等待当前操作完成");
            return true;
        }
        return false;
    }

    interface Choice { void run(CoreInventory.Instance c); }

    void selectCore(boolean free, Choice action) {
        List<CoreInventory.Instance> list = new ArrayList<>();
        for (CoreInventory.Instance c : BotRegistry.cores()) {
            if (managed(c) && free == c.ownerId.isEmpty()) list.add(c);
        }
        if (list.isEmpty()) {
            setStatusText(free ? "没有空闲内置核心，请先在「版本管理」下载新核心。" : "没有可导出的已分配核心。");
            return;
        }
        String[] names = new String[list.size()];
        for (int i = 0; i < names.length; i++) names[i] = title(list.get(i));
        PromptSheet.choose(activity, t, "选择核心 · 点一行即选择", names, i -> action.run(list.get(i)), null, null);
    }

    void versions(boolean create, CoreInventory.Instance c, boolean all) {
        work(() -> {
            List<String> vs = CoreInstaller.open(activity).versions(!all);
            if (vs.isEmpty()) return "没有可用版本";
            activity.runOnUiThread(() -> PromptSheet.choose(
                    activity, t,
                    (all ? "全部版本" : "兼容版本") + " · 点一行即选择",
                    vs.toArray(new String[0]),
                    i -> {
                        String version = vs.get(i);
                        if (create) {
                            String[] counts = { "1 份", "2 份", "3 份", "4 份", "5 份" };
                            PromptSheet.choose(activity, t, "创建数量 · 点一行即创建", counts,
                                    j -> estimate(version, j + 1, null, false), null, null);
                        } else {
                            estimate(version, 1, c, true);
                        }
                    }, null, null));
            return "已读取版本清单";
        });
    }

    void pluginVersions(CoreInventory.Instance c, String platform, boolean compatible) {
        work(() -> {
            CoreInstaller ci = CoreInstaller.open(activity);
            Map<String, String> versions = ci.pluginVersions(platform, compatible);
            if (versions.isEmpty()) return "没有可用插件版本";
            List<String> keys = new ArrayList<>(versions.keySet());
            String[] labels = new String[keys.size()];
            for (int i = 0; i < labels.length; i++) labels[i] = versions.get(keys.get(i));
            activity.runOnUiThread(() -> PromptSheet.choose(
                    activity, t,
                    BotRegistry.PLATFORM_LABEL(platform) + (compatible ? " · 兼容版本" : " · 全部版本") + " · 点一行即选择",
                    labels,
                    i -> confirm("切换插件版本？", labels[i] + " · 下次正常启动生效", () -> work(() -> {
                        if (RemoteBridge.isRemote()) {
                            RemoteBridge.stageRemotePlugin(c.id, platform, keys.get(i));
                        } else {
                            ci.stagePlugin(c.id, platform, keys.get(i), (item, n, total) ->
                                    activity.runOnUiThread(() -> setStatusText("下载 " + item + "：" + Ui.formatProgress(n, total))));
                        }
                        return "已安排插件更新（下次启动生效）";
                    }, true)),
                    compatible ? "查看全部版本" : null,
                    compatible ? () -> pluginVersions(c, platform, false) : null));
            return "已读取插件清单";
        });
    }

    static final class Download {
        final String label;
        final long bytes, total;
        final boolean running;
        Download(String label, long bytes, long total, boolean running) {
            this.label = label;
            this.bytes = bytes;
            this.total = total;
            this.running = running;
        }
    }

    private static volatile Download download;
    private Download shownDownload;
    private TextView downloadButton;

    static Download currentDownload() { return download; }

    static synchronized void createCores(CoreInstaller ci, String version, int count) {
        if (download != null && download.running) return;
        download = new Download("阶段：准备下载核心 " + version, 0, 0, true);
        new Thread(() -> {
            int created = 0;
            try {
                while (created < count) {
                    String target = "core-" + UUID.randomUUID();
                    ci.install(target, version, Collections.emptyList(), false, new CoreInstaller.Progress() {
                        public void phase(String label) { download = new Download("阶段：" + label, 0, 0, true); }
                        public void update(String item, long n, long total) {
                            String label = "environment".equals(item) ? "下载运行环境"
                                    : "core".equals(item) ? "下载机器人核心" : ("下载 " + item);
                            download = new Download(label, n, total, true);
                        }
                    });
                    BotRegistry.registerBuiltin(target, version);
                    created++;
                }
                download = new Download("已完成：成功创建 " + created + " 份核心（" + version + "）", 0, 0, false);
            } catch (Exception ex) {
                android.util.Log.w("WhaleEnv", "创建内置核心失败", ex);
                download = new Download("已创建 " + created + " / " + count + " 份：" + safe(ex), 0, 0, false);
            }
        }, "core-download").start();
    }

    @Override
    void refresh() {
        Download d = download;
        if (downloadButton == null || d == null || shownDownload == d || busy) return;
        shownDownload = d;
        downloadButton.setVisibility(d.running ? View.GONE : View.VISIBLE);
        progress.setVisibility(d.running ? View.VISIBLE : View.GONE);
        progress.setIndeterminate(d.total <= 0);
        if (d.total > 0) {
            progress.setProgress((int) Math.min(100, (d.bytes * 100L) / d.total));
            setStatusText(d.label + "：" + Ui.formatProgress(d.bytes, d.total));
        } else {
            setStatusText(d.label);
        }
    }

    void estimate(String version, int count, CoreInventory.Instance c, boolean stage) {
        work(() -> {
            List<String> ps = c == null ? Collections.emptyList() : platforms(c);
            CoreInstaller ci = CoreInstaller.open(activity);
            long size = ci.downloadBytes(version, ps);
            activity.runOnUiThread(() -> confirm(
                    c == null ? ("下载并创建 " + count + " 份核心？") : (stage ? "安排版本切换？" : "安装平台插件？"),
                    "版本：" + version + "\n本次下载：" + Ui.formatBytes(size)
                            + (stage ? "\n将在下次正常启动时切换。" : ""),
                    () -> {
                        if (c == null) {
                            if (RemoteBridge.isRemote()) {
                                work(() -> {
                                    RemoteBridge.downloadRemoteCores(version, count);
                                    return "已通知远端开始下载 " + count + " 份核心（" + version + "）";
                                }, false);
                                return;
                            }
                            createCores(ci, version, count);
                            refresh();
                            return;
                        }
                        work(() -> {
                            StringBuilder result = new StringBuilder();
                            for (int i = 0; i < count; i++) {
                                String target = c.id;
                                Map<String, String> failures = ci.install(target, version, ps, stage, (item, n, total) ->
                                        activity.runOnUiThread(() -> {
                                            progress.setIndeterminate(total <= 0);
                                            if (total > 0) progress.setProgress((int) Math.min(100, (n * 100L) / total));
                                            setStatusText("下载 " + item + "：" + Ui.formatProgress(n, total));
                                        }));
                                result.append(Ui.coreDisplayTitle(c))
                                        .append(failures.isEmpty() ? (stage ? "：已安排切换" : "：插件安装完成") : ("：待重试 " + failures.keySet()))
                                        .append("\n");
                            }
                            return result.toString().trim();
                        }, true);
                    }));
            return "已计算下载量：" + Ui.formatBytes(size);
        });
    }

    void release(CoreInventory.Instance c) {
        BotRegistry.Bot bot = BotRegistry.get(c.ownerId);
        StringBuilder accounts = new StringBuilder();
        if (bot != null) for (BotRegistry.Binding binding : bot.bindings) accounts.append("\n· ").append(binding.label());
        String impact = "归属机器人：" + occupant(c) + accounts
                + "\n\n仅能释放已停止的实例。将清除本实例数据、插件与绑定；协议端账号不退出。";
        PromptSheet.confirm(
                activity, t,
                "释放核心 · " + Ui.coreDisplayTitle(c),
                impact,
                "不备份直接释放", () -> confirm("永久清除并释放？", impact, () -> work(() -> {
                    if (RemoteBridge.isRemote()) {
                        RemoteBridge.releaseRemoteCore(c.id, c.ownerId);
                    } else {
                        CoreBackupSaf.release(activity, c.id, c.ownerId);
                    }
                    return "核心已释放";
                }, true)),
                "先备份再释放", () -> confirm("备份成功后释放？", impact, () -> pick("backupRelease", c)),
                "取消");
    }

    Intent backupOpenIntent(Intent open) {
        open.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        int flags = android.content.pm.PackageManager.MATCH_SYSTEM_ONLY | android.content.pm.PackageManager.MATCH_DEFAULT_ONLY;
        for (String pkg : new String[]{"com.google.android.documentsui", "com.android.documentsui"}) {
            Intent candidate = new Intent(open).setPackage(pkg);
            android.content.pm.ResolveInfo r = activity.getPackageManager().resolveActivity(candidate, flags);
            if (r != null && r.activityInfo != null && pkg.equals(r.activityInfo.packageName) && r.activityInfo.exported) {
                return candidate;
            }
        }
        return Intent.createChooser(open, "选择本机备份文件");
    }

    void pick(String operation, CoreInventory.Instance c) {
        op = operation;
        chosen = c == null ? "" : c.id;
        owner = c == null ? "" : c.ownerId;
        boolean create = op.equals("export") || op.equals("backupRelease");
        Intent i = new Intent(create ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(create ? "application/octet-stream" : "*/*");
        if (create) {
            String safeName = c == null ? chosen : Ui.coreDisplayTitle(c).replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
            String day = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date());
            i.putExtra(Intent.EXTRA_TITLE, safeName + "-" + day + ".whalebackup");
            i.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        }
        try {
            if (op.equals("restore") || op.equals("delete")) i = backupOpenIntent(i);
            activity.startActivityForResult(i, FILE_REQUEST);
        } catch (ActivityNotFoundException | SecurityException ex) {
            op = null;
            setStatusText("系统文件选择器不可用");
        }
    }

    void picked(Uri uri) {
        String type = op, c = chosen, b = owner;
        op = chosen = owner = null;
        if (uri == null || type == null) {
            setStatusText("已取消，未更改");
            return;
        }
        if (!"content".equals(uri.getScheme())) {
            setStatusText("请选择系统文档");
            return;
        }
        if (type.equals("descriptor")) {
            CoreImports.document(this, uri);
            return;
        }
        Runnable action = () -> work(() -> {
            if (RemoteBridge.isRemote()) {
                if (type.equals("delete")) {
                    CoreBackupSaf.deleteBackup(activity, uri);
                } else {
                    RemoteBridge.remoteBackupTransfer(activity, type, c, b, uri,
                            txt -> activity.runOnUiThread(() -> setStatusText(txt)));
                    if (!type.equals("restore")) recordBackupTime(c);
                }
            } else {
                if (type.equals("delete")) CoreBackupSaf.deleteBackup(activity, uri);
                else if (type.equals("restore")) CoreBackupSaf.restore(activity, c, uri);
                else if (type.equals("backupRelease")) {
                    CoreBackupSaf.exportAndRelease(activity, c, b, uri);
                    recordBackupTime(c);
                } else {
                    CoreBackupSaf.export(activity, c, b, uri);
                    recordBackupTime(c);
                }
            }
            return type.equals("delete") ? "已删除选中的备份文件"
                    : type.equals("restore") ? "恢复完成，请到对应平台重新授权登录"
                    : type.equals("backupRelease") ? "已备份并释放核心" : "备份导出完成";
        }, "backupRelease".equals(type) || "export".equals(type) || "restore".equals(type));

        if (type.equals("delete")) confirm("永久删除选中的备份？", "此操作不能撤销。", action);
        else if (type.equals("restore")) confirm("恢复到空闲核心？", "仅支持兼容的空闲内置核心；恢复后需重新授权登录。", action);
        else action.run();
    }
}
