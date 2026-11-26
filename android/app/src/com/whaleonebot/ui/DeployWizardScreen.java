package com.whaleonebot.ui;

import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.install.CoreInstaller;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 全流程一键部署向导（设置主页顶置入口）。
 *
 * <p>对齐 2026-11-26 需求问答报告 Q3 / Q4：
 * <ol>
 *   <li>第 1 步：选择部署方式（新建机器人 / 给已有机器人追加平台）并多选目标平台（QQ / bilibili / 抖音测试版）；</li>
 *   <li>第 2 步：自动体检底层环境、QQ 客户端（仅选了 QQ 时检查）与空闲核心，已就绪项自动绿勾，缺失项页内一键铺开或走国内镜像下载；</li>
 *   <li>第 3 步：填写机器人名称与人设并自动绑定空闲核心（已有机器人则直接挂载所选平台）；</li>
 *   <li>第 4 步：快捷配置大模型渠道与 API Key（支持一键套用国内常用预设，也支持「已有配置，跳过」）；</li>
 *   <li>第 5 步：逐个所选平台登录绑定与启动（QQ 扫码 / B 站网页 / 抖音测试版网页），点「完成部署」自动退回设置主页。</li>
 * </ol>
 *
 * <p>同时兼容本机与远程模式（底层动作走 {@link RemoteBridge}），且每次新增机器人均可重复进入。
 */
final class DeployWizardScreen extends Screen {

    private static final int TOTAL_STEPS = 5;

    private static final String[][] LLM_PRESETS = {
            {"DeepSeek 官方", "https://api.deepseek.com/v1", "deepseek-chat"},
            {"硅基流动（国内直连）", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"},
            {"Kimi 月之暗面", "https://api.moonshot.cn/v1", "moonshot-v1-auto"},
            {"通义千问（百炼）", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"},
            {"智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4-plus"},
            {"自定义 OpenAI 兼容地址", "", ""},
    };

    private int step = 1;
    private boolean addToExisting = false;
    private String existingBotId = "";
    private final Set<String> selectedPlatforms = new LinkedHashSet<>();

    // Step 2 实时状态
    private volatile boolean busyAction;
    private String busyMessage = "";

    // Step 3 建档表单缓存
    private String draftName = "";
    private String draftPersona = "";
    private String createdBotId = "";

    // Step 4 模型表单缓存
    private int presetIdx = 0;
    private String draftBaseUrl = LLM_PRESETS[0][1];
    private String draftModel = LLM_PRESETS[0][2];
    private String draftApiKey = "";
    private boolean modelSaved = false;

    private LinearLayout stepHost;
    private TextView stepBadge;
    private TextView stepTitleView;
    private ProgressBar stepBar;
    private TextView prevBtn;
    private TextView skipBtn;
    private TextView nextBtn;

    DeployWizardScreen(AppShell shell) {
        super(shell);
        selectedPlatforms.add(BotRegistry.P_QQ);
    }

    @Override
    void build() {
        root.removeAllViews();

        FrameLayout page = new FrameLayout(activity);
        root.addView(page, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        page.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, dp(Theme.TOUCH + Theme.S4 * 2));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("一键部署向导"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 顶部步骤进度卡
        LinearLayout progCard = Ui.addCard(col, activity, t, Theme.S2);
        LinearLayout pHead = Ui.row(activity);
        stepTitleView = Ui.strong(activity, "", Theme.T_CARD, t.textPrimary);
        pHead.addView(stepTitleView, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        stepBadge = Ui.pill(activity, t, "1 / " + TOTAL_STEPS, Ui.TONE_OK);
        pHead.addView(stepBadge, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        progCard.addView(pHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (RemoteBridge.isRemote()) {
            com.whaleonebot.remote.RemoteStore.PairedPeer peer = RemoteBridge.mgr().activePeer();
            String peerName = peer == null ? "远端设备" : peer.displayName();
            progCard.addView(Ui.text(activity, "当前目标：远端设备「" + peerName + "」",
                    Theme.T_CAP, t.toneStrong), topMargin(dp(4)));
        }

        stepBar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        stepBar.setMax(TOTAL_STEPS);
        progCard.addView(stepBar, topMargin(dp(Theme.S2)));

        stepHost = Ui.column(activity);
        col.addView(stepHost, topMargin(dp(Theme.S3)));

        // 底部固定导航栏
        FrameLayout footer = Ui.card(activity, t);
        LinearLayout bar = Ui.row(activity);
        bar.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S3), dp(Theme.S2));
        prevBtn = Ui.button(activity, t, "上一步", false);
        prevBtn.setOnClickListener(v -> onPrev());
        skipBtn = Ui.button(activity, t, "跳过", false);
        skipBtn.setOnClickListener(v -> onSkip());
        nextBtn = Ui.button(activity, t, "下一步", true);
        nextBtn.setOnClickListener(v -> onNext());

        bar.addView(prevBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f));
        LinearLayout.LayoutParams skLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 0.9f);
        skLp.leftMargin = dp(Theme.S1);
        bar.addView(skipBtn, skLp);
        LinearLayout.LayoutParams nxLp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1.3f);
        nxLp.leftMargin = dp(Theme.S1);
        bar.addView(nextBtn, nxLp);
        footer.addView(bar, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
        flp.gravity = Gravity.BOTTOM;
        flp.leftMargin = dp(Theme.S4);
        flp.rightMargin = dp(Theme.S4);
        flp.bottomMargin = dp(Theme.S3);
        page.addView(footer, flp);

        renderStep();
    }

    @Override
    boolean handleBack() {
        if (step > 1) {
            step--;
            renderStep();
            return true;
        }
        return false;
    }

    private void renderStep() {
        stepHost.removeAllViews();
        stepBadge.setText("第 " + step + " / " + TOTAL_STEPS + " 步");
        stepBar.setProgress(step);

        switch (step) {
            case 1:
                stepTitleView.setText("选择部署目标与平台");
                renderStep1();
                prevBtn.setVisibility(View.GONE);
                skipBtn.setVisibility(View.GONE);
                nextBtn.setText("下一步：环境与核心体检");
                nextBtn.setEnabled(!selectedPlatforms.isEmpty());
                break;
            case 2:
                stepTitleView.setText("底层环境与核心就绪");
                renderStep2();
                prevBtn.setVisibility(View.VISIBLE);
                skipBtn.setVisibility(View.VISIBLE);
                skipBtn.setText("稍后处理");
                nextBtn.setText("下一步：机器人建档");
                nextBtn.setEnabled(!busyAction);
                break;
            case 3:
                stepTitleView.setText(addToExisting ? "挂载平台到已有机器人" : "填写机器人档案");
                renderStep3();
                prevBtn.setVisibility(View.VISIBLE);
                skipBtn.setVisibility(View.GONE);
                nextBtn.setText(createdBotId.isEmpty() ? "确认并进入下一步" : "下一步：大模型配置");
                nextBtn.setEnabled(true);
                break;
            case 4:
                stepTitleView.setText("配置大模型与 API Key");
                renderStep4();
                prevBtn.setVisibility(View.VISIBLE);
                skipBtn.setVisibility(View.VISIBLE);
                skipBtn.setText("已有配置，跳过");
                nextBtn.setText("保存并进入登录启动");
                nextBtn.setEnabled(true);
                break;
            case 5:
            default:
                stepTitleView.setText("平台登录与启动");
                renderStep5();
                prevBtn.setVisibility(View.VISIBLE);
                skipBtn.setVisibility(View.GONE);
                nextBtn.setText("完成部署，返回设置");
                nextBtn.setEnabled(true);
                break;
        }
    }

    // ------------------------------------------------------------------ Step 1

    private void renderStep1() {
        List<BotRegistry.Bot> existing = BotRegistry.list();
        if (existing != null && !existing.isEmpty()) {
            LinearLayout modeCard = Ui.addCard(stepHost, activity, t, 0);
            modeCard.addView(Ui.strong(activity, "部署方式", Theme.T_BODY, t.textPrimary));
            LinearLayout chips = Ui.row(activity);
            TextView newChip = modeChip("新建一台机器人", !addToExisting);
            newChip.setOnClickListener(v -> {
                addToExisting = false;
                renderStep();
            });
            TextView addChip = modeChip("给已有机器人加平台", addToExisting);
            addChip.setOnClickListener(v -> {
                addToExisting = true;
                if (existingBotId.isEmpty()) existingBotId = existing.get(0).id;
                renderStep();
            });
            chips.addView(newChip, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
            alp.leftMargin = dp(Theme.S2);
            chips.addView(addChip, alp);
            modeCard.addView(chips, topMargin(dp(Theme.S2)));

            if (addToExisting) {
                modeCard.addView(Ui.divider(activity, t));
                modeCard.addView(Ui.text(activity, "选择要追加平台的机器人：", Theme.T_CAP, t.textSecondary));
                for (final BotRegistry.Bot b : existing) {
                    boolean picked = b.id.equals(existingBotId);
                    LinearLayout r = Ui.row(activity);
                    r.setPadding(dp(Theme.S2), dp(8), dp(Theme.S2), dp(8));
                    r.setBackground(Drawables.round(
                            picked ? Ui.alpha(t.accent, 0.14f) : t.ghostFill,
                            picked ? t.accent : t.ghostStroke, dp(1), dp(Theme.R_BTN)));
                    r.addView(Ui.strong(activity, b.name + "（" + b.platformSummary() + "）",
                            Theme.T_BODY, t.textPrimary), new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                    if (picked) r.addView(Ui.pill(activity, t, "已选", Ui.TONE_OK));
                    r.setOnClickListener(v -> {
                        existingBotId = b.id;
                        renderStep();
                    });
                    modeCard.addView(r, topMargin(dp(Theme.S1)));
                }
            }
        }

        LinearLayout platCard = Ui.addCard(stepHost, activity, t, Theme.S2);
        platCard.addView(Ui.strong(activity, "选择要部署的平台（可多选）", Theme.T_BODY, t.textPrimary));
        platCard.addView(Ui.text(activity, "接下来向导只会带你完成所选平台必需的步骤，已就绪的项自动打勾跳过。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        addPlatformCheck(platCard, BotRegistry.P_QQ, "QQ", "支持群聊 / 私聊 / 看图看视频 / 戳一戳与 @ 冷却", false);
        addPlatformCheck(platCard, BotRegistry.P_BILIBILI, "bilibili", "支持 B 站评论、私信、定时浏览与配额管理", false);
        addPlatformCheck(platCard, BotRegistry.P_DOUYIN, "抖音", "实验性网页登录、写操作默认需主人审批与公开作品队列", true);
    }

    private void addPlatformCheck(LinearLayout parent, final String pid, String title, String desc, boolean beta) {
        parent.addView(Ui.divider(activity, t));
        LinearLayout row = Ui.row(activity);
        CheckBox cb = new CheckBox(activity);
        cb.setChecked(selectedPlatforms.contains(pid));
        cb.setOnCheckedChangeListener((b, on) -> {
            if (on) selectedPlatforms.add(pid);
            else selectedPlatforms.remove(pid);
            nextBtn.setEnabled(!selectedPlatforms.isEmpty());
        });
        row.addView(cb, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        LinearLayout txt = Ui.column(activity);
        LinearLayout titleLine = Ui.row(activity);
        titleLine.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
        if (beta) {
            LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(6);
            titleLine.addView(Ui.pill(activity, t, "测试版", Ui.TONE_WARN), plp);
        }
        txt.addView(titleLine, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        txt.addView(Ui.text(activity, desc, Theme.T_CAP, t.textSecondary), topMargin(dp(2)));
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        tlp.leftMargin = dp(Theme.S1);
        row.addView(txt, tlp);
        row.setOnClickListener(v -> cb.setChecked(!cb.isChecked()));
        parent.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    // ------------------------------------------------------------------ Step 2

    private void renderStep2() {
        boolean needQq = selectedPlatforms.contains(BotRegistry.P_QQ);
        boolean envReady = checkEnvReady();
        boolean qqReady = !needQq || checkQqReady();
        int freeCores = countFreeCores();
        boolean coreReady = addToExisting || freeCores > 0;

        LinearLayout card = Ui.addCard(stepHost, activity, t, 0);
        boolean allOk = envReady && qqReady && coreReady;
        card.addView(Ui.strong(activity,
                allOk ? "全部底层项已就绪，直接点「下一步」即可" : "请先点下方按钮补齐标黄的缺失项",
                Theme.T_BODY, allOk ? t.toneStrong : t.textPrimary));

        if (busyAction && !busyMessage.isEmpty()) {
            card.addView(Ui.text(activity, "正在执行：" + busyMessage, Theme.T_CAP, t.accent), topMargin(dp(Theme.S2)));
        }

        // 检查项 1：底层运行环境
        card.addView(Ui.divider(activity, t));
        addCheckRow(card, "1. 底层运行环境（bash / node）",
                envReady ? "已就绪，无需重复铺开" : "APK 已自带完整环境包，免联网一键铺开",
                envReady, "一键铺开环境", () -> runDeployEnv());

        // 检查项 2：Linux QQ 客户端（仅勾选 QQ 时显示）
        if (needQq) {
            card.addView(Ui.divider(activity, t));
            addCheckRow(card, "2. Linux QQ 客户端（ARM64）",
                    qqReady ? "已安装，可直接扫码登录" : "未检测到 QQ 客户端，可一键拉取安装或去环境页手动导入",
                    qqReady, "一键拉取并安装 QQ", () -> runFetchQq());
        }

        // 检查项 3：空闲核心（新建机器人时才需要）
        if (!addToExisting) {
            card.addView(Ui.divider(activity, t));
            addCheckRow(card, (needQq ? "3" : "2") + ". 空闲机器人核心",
                    coreReady ? ("已有 " + freeCores + " 份空闲核心可直接绑定")
                            : "当前没有空闲核心，将通过国内镜像自动下载最新推荐核心",
                    coreReady, "一键下载推荐核心", () -> runDownloadCore());
        }
    }

    private void addCheckRow(LinearLayout parent, String title, String sub, boolean ready,
                             String actionLabel, Runnable action) {
        LinearLayout box = Ui.column(activity);
        LinearLayout head = Ui.row(activity);
        head.addView(Ui.strong(activity, (ready ? "✓ " : "○ ") + title, Theme.T_BODY, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        head.addView(Ui.pill(activity, t, ready ? "已就绪" : "待处理", ready ? Ui.TONE_OK : Ui.TONE_WARN));
        box.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(Ui.text(activity, sub, Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        if (!ready) {
            TextView btn = Ui.button(activity, t, busyAction ? "处理中…" : actionLabel, true);
            btn.setEnabled(!busyAction);
            btn.setOnClickListener(v -> action.run());
            box.addView(btn, topMargin(dp(Theme.S2)));
        }
        parent.addView(box, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    private void runDeployEnv() {
        if (busyAction) return;
        busyAction = true;
        busyMessage = "铺开内置运行环境（约 30–60 秒）…";
        renderStep();
        new Thread(() -> {
            boolean ok;
            if (RemoteBridge.isRemote()) {
                org.json.JSONObject r = RemoteBridge.rpcSync("env.ensureBundled", null, 120000);
                ok = r != null && r.optBoolean("ok", false);
                if (RemoteBridge.mgr() != null) RemoteBridge.mgr().triggerSnapshotRefresh();
            } else {
                ok = BundledEnvironment.ensure(activity);
            }
            activity.runOnUiThread(() -> {
                busyAction = false;
                busyMessage = "";
                host().toast(ok ? "运行环境已就绪" : "铺开未完成，可重试或前往「环境配置」查看详情");
                renderStep();
            });
        }, "wizard-env").start();
    }

    private void runFetchQq() {
        if (busyAction) return;
        if (RemoteBridge.isRemote()) {
            host().toast("远端 QQ 客户端请前往「环境配置」一键拉取或本机推送 .deb");
            shell.pushEnv();
            return;
        }
        busyAction = true;
        busyMessage = "经国内镜像探测并拉取 Linux QQ 安装包…";
        renderStep();
        new Thread(() -> {
            File dlDir = new File(activity.getCacheDir(), "qq-wizard-dl");
            dlDir.mkdirs();
            QqDebFetch.Result r = QqDebFetch.download(dlDir, (stage, done, total) -> {
                final String msg = total > 0 ? (stage + " " + Ui.formatProgress(done, total)) : stage;
                activity.runOnUiThread(() -> {
                    busyMessage = msg;
                    if (step == 2) renderStep();
                });
            });
            boolean installed = false;
            String err = r.error;
            if (r.file != null && r.file.isFile()) {
                try {
                    QqClientInstaller.Result ir = QqClientInstaller.install(
                            activity.getFilesDir(), r.file, stage -> activity.runOnUiThread(() -> {
                                busyMessage = stage;
                                if (step == 2) renderStep();
                            }));
                    installed = ir != null && ir.ok;
                    if (!installed && ir != null && ir.detail != null && !ir.detail.isEmpty()) err = ir.detail;
                } catch (Throwable ex) {
                    err = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
                }
            }
            final boolean ok = installed;
            final String finalErr = err;
            activity.runOnUiThread(() -> {
                busyAction = false;
                busyMessage = "";
                host().toast(ok ? "QQ 客户端已安装就绪" : ("拉取/安装未完成：" + (finalErr == null ? "请重试" : finalErr)));
                renderStep();
            });
        }, "wizard-qq").start();
    }

    private void runDownloadCore() {
        if (busyAction) return;
        busyAction = true;
        busyMessage = "经国内镜像拉取推荐内置核心…";
        renderStep();
        new Thread(() -> {
            String err = null;
            try {
                if (RemoteBridge.isRemote()) {
                    org.json.JSONObject r = RemoteBridge.mgr().callActiveRpc(
                            "cores.download", new org.json.JSONObject().put("version", "").put("count", 1), 15000);
                    if (r == null || !r.optBoolean("ok", true)) err = "远端核心下载启动失败";
                    RemoteBridge.mgr().triggerSnapshotRefresh();
                } else {
                    CoreInstaller ci = CoreInstaller.open(activity);
                    String ver = ci.current();
                    if (ver == null || ver.isEmpty()) {
                        List<String> vs = ci.versions(true);
                        if (!vs.isEmpty()) ver = vs.get(0);
                    }
                    if (ver == null || ver.isEmpty()) throw new Exception("未读到可用核心版本");
                    CoreManagerScreen.createCores(ci, ver, 1);
                    // 等待本次核心下载完成（最多 120 秒）
                    long deadline = System.currentTimeMillis() + 120_000L;
                    while (System.currentTimeMillis() < deadline) {
                        CoreManagerScreen.Download d = CoreManagerScreen.currentDownload();
                        if (d == null || !d.running) break;
                        final String label = d.total > 0
                                ? (d.label + " " + Ui.formatProgress(d.bytes, d.total))
                                : d.label;
                        activity.runOnUiThread(() -> {
                            busyMessage = label;
                            if (step == 2) renderStep();
                        });
                        Thread.sleep(600L);
                    }
                }
            } catch (Throwable ex) {
                err = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            }
            final String finalErr = err;
            activity.runOnUiThread(() -> {
                busyAction = false;
                busyMessage = "";
                host().toast(finalErr == null ? "核心已准备就绪" : ("核心下载未完成：" + finalErr));
                renderStep();
            });
        }, "wizard-core").start();
    }

    // ------------------------------------------------------------------ Step 3

    private EditText etName;
    private EditText etPersona;

    private void renderStep3() {
        LinearLayout card = Ui.addCard(stepHost, activity, t, 0);
        if (addToExisting) {
            BotRegistry.Bot target = BotRegistry.get(existingBotId);
            if (target == null) {
                card.addView(Ui.text(activity, "未找到选中的已有机器人，请退回第 1 步重新选择。", Theme.T_BODY, t.textPrimary));
                return;
            }
            card.addView(Ui.strong(activity, "目标机器人：" + target.name, Theme.T_CARD, t.textPrimary));
            card.addView(Ui.text(activity, "当前已绑定平台：" + target.platformSummary()
                    + "\n将自动挂载所选的新平台：" + joinLabels(selectedPlatforms),
                    Theme.T_BODY, t.textSecondary), topMargin(dp(Theme.S2)));
            createdBotId = target.id;
            return;
        }

        if (!createdBotId.isEmpty() && BotRegistry.get(createdBotId) != null) {
            BotRegistry.Bot b = BotRegistry.get(createdBotId);
            card.addView(Ui.strong(activity, "✓ 机器人已创建：" + b.name, Theme.T_CARD, t.toneStrong));
            card.addView(Ui.text(activity, "已绑定平台：" + b.platformSummary() + "\n点下方「下一步」继续配置大模型与登录。",
                    Theme.T_BODY, t.textSecondary), topMargin(dp(Theme.S2)));
            return;
        }

        card.addView(Ui.strong(activity, "给新机器人起名并设定性格", Theme.T_BODY, t.textPrimary));
        card.addView(Ui.text(activity, "将绑定平台：" + joinLabels(selectedPlatforms),
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        card.addView(Ui.strong(activity, "机器人名称", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S3)));
        etName = new EditText(activity);
        etName.setHint("例如：小鲸鱼、群聊助手");
        etName.setSingleLine(true);
        etName.setText(draftName);
        Ui.styleInput(etName, activity, t);
        card.addView(etName, topMargin(dp(Theme.S1)));

        card.addView(Ui.strong(activity, "人设提示词（选填，随时可改）", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S3)));
        etPersona = new EditText(activity);
        etPersona.setHint("例如：你是一个说话轻松幽默、简洁自然的朋友…");
        etPersona.setMinLines(3);
        etPersona.setText(draftPersona);
        Ui.styleInput(etPersona, activity, t);
        card.addView(etPersona, topMargin(dp(Theme.S1)));
    }

    // ------------------------------------------------------------------ Step 4

    private EditText etBaseUrl;
    private EditText etModel;
    private EditText etApiKey;

    private void renderStep4() {
        LinearLayout card = Ui.addCard(stepHost, activity, t, 0);
        card.addView(Ui.strong(activity, "选择大模型渠道并填写 API Key", Theme.T_BODY, t.textPrimary));
        card.addView(Ui.text(activity, "只需选一个常见国内渠道并贴入 Key 就能开口对话；若之前配过可点下方「已有配置，跳过」。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        // 预设快选（2 列）
        for (int row = 0; row < LLM_PRESETS.length; row += 2) {
            LinearLayout line = Ui.row(activity);
            for (int col = 0; col < 2 && row + col < LLM_PRESETS.length; col++) {
                final int idx = row + col;
                TextView chip = modeChip(LLM_PRESETS[idx][0], presetIdx == idx);
                chip.setOnClickListener(v -> {
                    presetIdx = idx;
                    if (!LLM_PRESETS[idx][1].isEmpty()) draftBaseUrl = LLM_PRESETS[idx][1];
                    if (!LLM_PRESETS[idx][2].isEmpty()) draftModel = LLM_PRESETS[idx][2];
                    if (etBaseUrl != null) etBaseUrl.setText(draftBaseUrl);
                    if (etModel != null) etModel.setText(draftModel);
                    renderStep();
                });
                LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
                if (col > 0) clp.leftMargin = dp(Theme.S1);
                line.addView(chip, clp);
            }
            card.addView(line, topMargin(dp(Theme.S2)));
        }

        card.addView(Ui.strong(activity, "接口地址（Base URL）", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S3)));
        etBaseUrl = new EditText(activity);
        etBaseUrl.setSingleLine(true);
        etBaseUrl.setHint("https://api.deepseek.com/v1");
        etBaseUrl.setText(draftBaseUrl);
        Ui.styleInput(etBaseUrl, activity, t);
        card.addView(etBaseUrl, topMargin(dp(Theme.S1)));

        card.addView(Ui.strong(activity, "模型名（Model）", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S2)));
        etModel = new EditText(activity);
        etModel.setSingleLine(true);
        etModel.setHint("例如 deepseek-chat / qwen-plus");
        etModel.setText(draftModel);
        Ui.styleInput(etModel, activity, t);
        card.addView(etModel, topMargin(dp(Theme.S1)));

        card.addView(Ui.strong(activity, "API Key（仅存本机/远端私有配置，绝不外传）", Theme.T_BODY, t.textPrimary), topMargin(dp(Theme.S2)));
        etApiKey = new EditText(activity);
        etApiKey.setSingleLine(true);
        etApiKey.setHint("sk-...");
        etApiKey.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        etApiKey.setText(draftApiKey);
        Ui.styleInput(etApiKey, activity, t);
        card.addView(etApiKey, topMargin(dp(Theme.S1)));

        if (modelSaved) {
            card.addView(Ui.text(activity, "✓ 大模型配置已写入 config.json", Theme.T_CAP, t.toneStrong), topMargin(dp(Theme.S2)));
        }
    }

    // ------------------------------------------------------------------ Step 5

    private void renderStep5() {
        BotRegistry.Bot b = BotRegistry.get(createdBotId);
        if (b == null) b = BotRegistry.primary();
        final BotRegistry.Bot bot = b;

        LinearLayout card = Ui.addCard(stepHost, activity, t, 0);
        card.addView(Ui.strong(activity, "最后一步：逐个完成所选平台登录", Theme.T_CARD, t.textPrimary));
        card.addView(Ui.text(activity,
                "点下方对应平台按钮完成登录与启动即可；全部处理完后点底部「完成部署，返回设置」自动回到设置主页。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        for (final String pid : selectedPlatforms) {
            card.addView(Ui.divider(activity, t));
            LinearLayout row = Ui.column(activity);
            String title = BotRegistry.PLATFORM_LABEL(pid) + (BotRegistry.P_DOUYIN.equals(pid) ? "（测试版）" : "");
            row.addView(Ui.strong(activity, title, Theme.T_BODY, t.textPrimary));
            String desc;
            String btnText;
            if (BotRegistry.P_QQ.equals(pid)) {
                desc = "进入 QQ 启动页启动容器并扫码登录，之后即可在群聊/私聊对话。";
                btnText = "去 QQ 启动与扫码登录";
            } else if (BotRegistry.P_BILIBILI.equals(pid)) {
                desc = "进入 B 站平台页打开官方网页登录并启用服务。";
                btnText = "去 bilibili 登录与启动";
            } else {
                desc = "进入抖音测试版页完成实验性网页登录并确认写操作授权策略。";
                btnText = "去抖音（测试版）配置与登录";
            }
            row.addView(Ui.text(activity, desc, Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
            TextView go = Ui.button(activity, t, btnText, false);
            go.setOnClickListener(v -> {
                if (bot == null) {
                    host().toast("请先完成上一步机器人建档");
                    return;
                }
                if (BotRegistry.P_QQ.equals(pid)) shell.pushBotStart(bot.id);
                else if (BotRegistry.P_BILIBILI.equals(pid)) shell.pushBiliAccounts(bot.id, "start");
                else if (BotRegistry.P_DOUYIN.equals(pid)) shell.pushDouyinPlatform(bot.id, "start");
            });
            row.addView(go, topMargin(dp(Theme.S2)));
            card.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
    }

    // ------------------------------------------------------------------ 导航按钮逻辑

    private void onPrev() {
        if (step > 1) {
            step--;
            renderStep();
        }
    }

    private void onSkip() {
        if (step < TOTAL_STEPS) {
            step++;
            renderStep();
        }
    }

    private void onNext() {
        if (step == 1) {
            if (selectedPlatforms.isEmpty()) {
                host().toast("请至少勾选一个平台");
                return;
            }
            step = 2;
            renderStep();
            return;
        }
        if (step == 2) {
            step = 3;
            renderStep();
            return;
        }
        if (step == 3) {
            if (!commitStep3()) return;
            step = 4;
            renderStep();
            return;
        }
        if (step == 4) {
            commitStep4();
            step = 5;
            renderStep();
            return;
        }
        // Step 5 完成：按用户要求自动退回设置主页
        host().toast("部署流程已完成");
        shell.popTo(AppShell.P_SETTINGS);
    }

    private boolean commitStep3() {
        if (addToExisting) {
            BotRegistry.Bot target = BotRegistry.get(existingBotId);
            if (target == null) {
                host().toast("未找到选中的机器人");
                return false;
            }
            CoreInventory.Instance core = BotRegistry.coreForBot(target.id);
            for (String p : selectedPlatforms) {
                if (!target.platforms.contains(p) && core != null) {
                    BotRegistry.addPlatform(target.id, core.id, p);
                }
            }
            createdBotId = target.id;
            return true;
        }
        if (!createdBotId.isEmpty() && BotRegistry.get(createdBotId) != null) return true;
        draftName = etName == null ? "" : etName.getText().toString().trim();
        draftPersona = etPersona == null ? "" : etPersona.getText().toString().trim();
        String problem = BotRegistry.nameProblem(draftName, null);
        if (problem != null) {
            host().toast(problem);
            return false;
        }
        CoreInventory.Instance free = firstFreeCore();
        if (free == null) {
            host().toast("当前没有空闲核心，请先返回第 2 步下载核心");
            return false;
        }
        BotRegistry.Bot bot = BotRegistry.createOnCore(free.id, draftName, draftPersona, new ArrayList<>(selectedPlatforms));
        if (bot == null) {
            host().toast("创建机器人失败，请确认核心空闲且支持所选平台");
            return false;
        }
        createdBotId = bot.id;
        host().toast("已创建机器人「" + bot.name + "」");
        return true;
    }

    private void commitStep4() {
        if (etBaseUrl != null) draftBaseUrl = etBaseUrl.getText().toString().trim();
        if (etModel != null) draftModel = etModel.getText().toString().trim();
        if (etApiKey != null) draftApiKey = etApiKey.getText().toString().trim();
        if (draftBaseUrl.isEmpty() && draftModel.isEmpty() && draftApiKey.isEmpty()) {
            return;
        }
        try {
            BotConfigHost cfgHost = (activity instanceof BotConfigHost) ? (BotConfigHost) activity : null;
            if (cfgHost == null) return;
            String raw = cfgHost.loadConfigJson();
            Object doc = (raw != null && !raw.trim().isEmpty())
                    ? BotConfigJson.parse(raw)
                    : new java.util.LinkedHashMap<String, Object>();
            if (!draftBaseUrl.isEmpty()) BotConfigJson.set(doc, "api.baseUrl", draftBaseUrl);
            if (!draftModel.isEmpty()) BotConfigJson.set(doc, "api.model", draftModel);
            if (!draftApiKey.isEmpty()) BotConfigJson.set(doc, "api.apiKey", draftApiKey);
            if (cfgHost.saveConfigJson(BotConfigJson.write(doc))) {
                modelSaved = true;
                host().toast("大模型配置已保存");
            } else {
                host().toast("大模型配置未保存，稍后可在机器人配置中修改");
            }
        } catch (Throwable ex) {
            host().toast("保存大模型配置失败，可稍后在机器人配置中填写");
        }
    }

    // ------------------------------------------------------------------ 辅助方法

    private boolean checkEnvReady() {
        if (RemoteBridge.isRemote()) {
            org.json.JSONObject st = RemoteBridge.rpcSwr("env.status", null, 3000L, 5000);
            if (st != null) return st.optBoolean("envReady", false);
            return RemoteBridge.mgr().activeSnapshot().setupEnv;
        }
        return QqClientInstaller.usable(new File(activity.getFilesDir(), "rootfs"));
    }

    private boolean checkQqReady() {
        if (RemoteBridge.isRemote()) {
            return RemoteBridge.qqClientVersion(activity) != null || RemoteBridge.mgr().activeSnapshot().setupQq;
        }
        return QqClientInstaller.clientVersion(activity.getFilesDir()) != null;
    }

    private int countFreeCores() {
        int n = 0;
        for (CoreInventory.Instance c : BotRegistry.cores()) {
            if (c.ownerId == null || c.ownerId.isEmpty()) n++;
        }
        return n;
    }

    private CoreInventory.Instance firstFreeCore() {
        for (CoreInventory.Instance c : BotRegistry.cores()) {
            if (c.ownerId == null || c.ownerId.isEmpty()) return c;
        }
        return null;
    }

    private TextView modeChip(String label, boolean active) {
        TextView tv = Ui.text(activity, label, Theme.T_CAP, active ? t.onAccent : t.textPrimary);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(10), dp(10), dp(10), dp(10));
        tv.setBackground(Drawables.round(
                active ? t.accent : t.ghostFill,
                active ? 0 : t.ghostStroke,
                dp(1), dp(Theme.R_BTN)));
        tv.setClickable(true);
        return tv;
    }

    private static String joinLabels(Set<String> ps) {
        StringBuilder sb = new StringBuilder();
        for (String p : ps) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(BotRegistry.PLATFORM_LABEL(p));
            if (BotRegistry.P_DOUYIN.equals(p)) sb.append("(测试版)");
        }
        return sb.toString();
    }

    private LinearLayout.LayoutParams topMargin(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
