package com.whaleonebot.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Environment;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 环境配置页：专注底层「运行环境（系统层）」与「QQ 客户端」两件事。
 *
 * <p>按 2026-11-25 问答报告（Q2/Q4/Q8/Q9/Q10）重构：
 * 1) 彻底删除原「机器人核心 → 去版本管理」过渡卡（核心归版本管理与机器人页，不再概念串台）；
 * 2) 顶部状态总览卡一眼展示运行环境与 QQ 客户端双状态胶囊；
 * 3) 运行环境与 QQ 客户端均按「未就绪 / 已就绪」两态收放：已就绪只显状态与版本，修复/重装/手动取包默认折叠；
 * 4) 保持不直接分发腾讯 QQ 客户端的合规边界，进度统一显示 MB + 百分比。
 */
final class EnvConfigScreen extends Screen {

    static final int REQ_PICK_REMOTE_QQ_DEB = 0x5713;

    private static final String KNOWN_VERSION = "3.2.35";
    private static final String QQ_PAGE = "https://im.qq.com/linuxqq/index.shtml";
    private static final String QQ_DEB_URL =
            "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_arm64_01.deb";

    private TextView envState;
    private TextView envActionBtn;
    private TextView qqState;
    private TextView qqDetail;
    private ProgressBar qqProgress;
    private TextView installButton;

    private volatile boolean envBusy;
    private boolean scanning;
    private boolean envAdvancedExpanded;
    private boolean qqReplaceExpanded;
    private boolean qqManualExpanded;
    private File found;

    EnvConfigScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll, new android.widget.FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("环境配置"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        boolean envReady;
        String qqVer;
        int packs;
        if (RemoteBridge.isRemote()) {
            org.json.JSONObject st = RemoteBridge.rpcSync("env.status", null, 5000);
            envReady = st != null && st.optBoolean("envReady", false);
            String qv = st == null ? "" : st.optString("qqVersion", "");
            qqVer = qv.isEmpty() ? null : qv;
            packs = st == null ? 0 : st.optInt("packs", 0);
        } else {
            File files = activity.getFilesDir();
            envReady = QqClientInstaller.usable(new File(files, "rootfs"));
            qqVer = QqClientInstaller.clientVersion(files);
            packs = SetupState.environmentPackCount(files);
        }
        boolean qqReady = qqVer != null;

        // ---------------- 顶部状态总览卡 ----------------
        LinearLayout summaryCard = Ui.addCard(col, activity, t, Theme.S3);
        summaryCard.addView(Ui.strong(activity, "环境就绪总览", Theme.T_CARD, t.textPrimary));
        LinearLayout pillRow = Ui.row(activity);
        pillRow.addView(Ui.pill(activity, t,
                envReady ? "运行环境：已就绪" : "运行环境：待铺开",
                envReady ? Ui.TONE_OK : Ui.TONE_WARN));
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
        gap.leftMargin = dp(Theme.S1);
        pillRow.addView(Ui.pill(activity, t,
                qqReady ? ("QQ：" + (qqVer.isEmpty() ? "已安装" : qqVer)) : "QQ：未安装",
                qqReady ? Ui.TONE_OK : Ui.TONE_WARN), gap);
        summaryCard.addView(pillRow, topMargin(dp(Theme.S2)));

        String hint = (envReady && qqReady)
                ? "底层环境与 QQ 客户端均已就绪，回到首页即可启动容器并登录。"
                : (!envReady
                ? "APK 已内置运行环境，点下方「立即铺开内置环境」即可完成准备。"
                : "运行环境已就绪，继续在下方安装 QQ 客户端（不随 APK 分发）。");
        summaryCard.addView(Ui.text(activity, hint, Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S2)));

        // ---------------- 一、运行环境（系统层） ----------------
        col.addView(sectionLabel("运行环境（系统层）"));
        LinearLayout envCard = Ui.addCard(col, activity, t, Theme.S1);
        LinearLayout envHead = Ui.row(activity);
        envHead.addView(Ui.strong(activity, "容器运行环境", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        envHead.addView(Ui.pill(activity, t, envReady ? "已就绪" : "待铺开",
                envReady ? Ui.TONE_OK : Ui.TONE_WARN));
        envCard.addView(envHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        String envDesc = envReady
                ? "内置系统层（bash / node / 证书）已铺就，容器可直接启动。"
                : "尚未铺开运行环境（本地环境包缓存：" + packs + " 套）。APK 已自带完整环境包，无需联网即可铺开。";
        envState = Ui.text(activity, envDesc, Theme.T_BODY, t.textSecondary);
        envCard.addView(envState, topMargin(dp(Theme.S2)));

        if (!envReady) {
            envActionBtn = Ui.button(activity, t, "立即铺开内置环境（免联网）", true);
            envActionBtn.setOnClickListener(v -> deployBundledEnvironment());
            envCard.addView(envActionBtn, topMargin(dp(Theme.S2)));
        }

        envCard.addView(Ui.divider(activity, t));
        TextView envFoldBtn = Ui.button(activity, t,
                envAdvancedExpanded ? "收起修复与高级操作" : "修复与高级操作", false);
        envFoldBtn.setOnClickListener(v -> {
            envAdvancedExpanded = !envAdvancedExpanded;
            build();
        });
        envCard.addView(envFoldBtn, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (envAdvancedExpanded) {
            envCard.addView(Ui.text(activity,
                    "正常使用无需手动下载。若怀疑环境损坏，可联网校验并重新下载环境包（不会覆盖现有容器数据）。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S2)));
            TextView redl = Ui.button(activity, t, "从网络下载 / 修复环境包", false);
            redl.setOnClickListener(v -> ensureEnvironmentFromNetwork(redl));
            envCard.addView(redl, topMargin(dp(Theme.S2)));
        }

        // ---------------- 二、QQ 客户端 ----------------
        col.addView(sectionLabel("QQ 客户端"));
        LinearLayout qqCard = Ui.addCard(col, activity, t, Theme.S1);
        LinearLayout qqHead = Ui.row(activity);
        qqHead.addView(Ui.strong(activity, "Linux QQ（ARM64）", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        qqHead.addView(Ui.pill(activity, t,
                qqReady ? "已安装" : "未安装",
                qqReady ? Ui.TONE_OK : Ui.TONE_WARN));
        qqCard.addView(qqHead, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (qqReady && !qqReplaceExpanded) {
            qqCard.addView(Ui.text(activity,
                    "当前已安装版本：" + (qqVer.isEmpty() ? "已就绪" : qqVer)
                            + "\n换版本更新环境时会自动暂存并放回，无需反复重新下载。",
                    Theme.T_BODY, t.textSecondary), topMargin(dp(Theme.S2)));
            qqCard.addView(Ui.divider(activity, t));
            TextView expandReplace = Ui.button(activity, t, "重新下载 / 更换其他版本", false);
            expandReplace.setOnClickListener(v -> {
                qqReplaceExpanded = true;
                build();
            });
            qqCard.addView(expandReplace, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            if (qqReady) {
                qqCard.addView(Ui.text(activity,
                        "当前已装版本：" + (qqVer.isEmpty() ? "已就绪" : qqVer) + "（安装器默认保护已有客户端不被误覆盖）。",
                        Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
            }
            buildQqInstallSection(qqCard, qqReady);
        }
    }

    private void buildQqInstallSection(LinearLayout qqCard, boolean qqReady) {
        qqState = Ui.text(activity,
                found != null ? ("已就绪安装包：" + found.getName()) : "推荐由 App 自动换源下载后直接安装",
                Theme.T_BODY, t.textPrimary);
        qqDetail = Ui.text(activity,
                found != null
                        ? (Ui.formatBytes(found.length()) + " · 结构完整，点击下方按钮即可装入容器。")
                        : "按官方最新 → 3.2.35 → 社区 3.2.32 依次探测下载；不限定客户端版本，任何完整 arm64 linuxqq deb 均可使用。",
                Theme.T_CAP, t.textSecondary);
        qqCard.addView(qqState, topMargin(dp(Theme.S2)));
        qqCard.addView(qqDetail, topMargin(dp(Theme.S1)));

        qqProgress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        qqProgress.setVisibility(View.GONE);
        qqCard.addView(qqProgress, topMargin(dp(Theme.S1)));

        TextView fetch = Ui.button(activity, t,
                RemoteBridge.isRemote() ? "让远端自动下载并安装 QQ" : "让 App 自动下载（多源切换）", true);
        fetch.setOnClickListener(v -> fetchDeb(fetch));
        qqCard.addView(fetch, topMargin(dp(Theme.S2)));

        if (RemoteBridge.isRemote()) {
            TextView pushLocal = Ui.button(activity, t, "从本机选 .deb 经 P2P 推送到远端安装", true);
            pushLocal.setOnClickListener(v -> pickLocalDebForRemote());
            qqCard.addView(pushLocal, topMargin(dp(Theme.S2)));
        }

        installButton = Ui.button(activity, t, "安装 QQ 到容器", true);
        installButton.setOnClickListener(v -> install());
        qqCard.addView(installButton, topMargin(dp(Theme.S2)));
        Ui.enabled(installButton, found != null);

        // 手动导入安装包折叠区（问答报告 Q10）
        qqCard.addView(Ui.divider(activity, t));
        TextView manualToggle = Ui.button(activity, t,
                qqManualExpanded ? "收起手动导入安装包" : "手动导入安装包（复制链接 / 扫描下载目录）", false);
        manualToggle.setOnClickListener(v -> {
            qqManualExpanded = !qqManualExpanded;
            build();
        });
        qqCard.addView(manualToggle, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (qqManualExpanded) {
            qqCard.addView(Ui.strong(activity, "第 1 步：获取 arm64 deb 安装包", Theme.T_BODY, t.textPrimary),
                    topMargin(dp(Theme.S2)));
            qqCard.addView(Ui.text(activity,
                    "在浏览器打开官方下载页选择「ARM 版下载」（参考版本 " + KNOWN_VERSION + "），或直接复制 deb 直链。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

            TextView copyPage = Ui.button(activity, t, "复制官方下载页链接", false);
            copyPage.setOnClickListener(v -> copyText(QQ_PAGE, "官方下载页链接已复制"));
            qqCard.addView(copyPage, topMargin(dp(Theme.S2)));

            TextView copyDeb = Ui.button(activity, t, "复制 deb 直链", false);
            copyDeb.setOnClickListener(v -> copyText(QQ_DEB_URL, "deb 直链已复制"));
            qqCard.addView(copyDeb, topMargin(dp(Theme.S2)));

            qqCard.addView(Ui.strong(activity, "第 2 步：放进手机 Download 目录并扫描", Theme.T_BODY, t.textPrimary),
                    topMargin(dp(Theme.S3)));
            TextView scanBtn = Ui.button(activity, t, "扫描手机下载目录", false);
            scanBtn.setOnClickListener(v -> scan());
            qqCard.addView(scanBtn, topMargin(dp(Theme.S2)));
        }

        if (qqReady) {
            TextView collapse = Ui.button(activity, t, "收起更换面板", false);
            collapse.setOnClickListener(v -> {
                qqReplaceExpanded = false;
                build();
            });
            qqCard.addView(collapse, topMargin(dp(Theme.S2)));
        }
    }

    // ------------------------------------------------------------------ 动作实现

    private void deployBundledEnvironment() {
        if (envBusy) { host().toast("正在处理，请稍候"); return; }
        envBusy = true;
        if (envActionBtn != null) Ui.enabled(envActionBtn, false);
        if (envState != null) envState.setText("阶段：正在铺开内置运行环境（约 30–60 秒）…");
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
                envBusy = false;
                host().toast(ok ? "内置运行环境已铺开就绪" : "内置环境铺开未完成，可展开修复项重试");
                build();
            });
        }, "env-bundled-deploy").start();
    }

    private void pickLocalDebForRemote() {
        android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(android.content.Intent.CATEGORY_OPENABLE)
                .setType("*/*");
        try {
            activity.startActivityForResult(i, REQ_PICK_REMOTE_QQ_DEB);
        } catch (Throwable e) {
            host().toast("无法打开本机文件选择器");
        }
    }

    /** Q17：从控制机本地选择 QQ .deb 文件，经端到端加密 P2P 分块流式推送至远端并自动安装。 */
    void onRemoteDebPicked(final android.net.Uri uri) {
        if (uri == null || !RemoteBridge.isRemote()) return;
        if (qqProgress != null) {
            qqProgress.setVisibility(View.VISIBLE);
            qqProgress.setIndeterminate(false);
            qqProgress.setProgress(0);
        }
        if (qqState != null) qqState.setText("阶段：正在经加密 P2P 推送安装包到远端…");
        new Thread(() -> {
            try {
                long total = -1L;
                try (android.content.res.AssetFileDescriptor afd = activity.getContentResolver().openAssetFileDescriptor(uri, "r")) {
                    if (afd != null) total = afd.getLength();
                } catch (Throwable ignored) {}
                final long finalTotal = total;
                try (java.io.InputStream in = activity.getContentResolver().openInputStream(uri)) {
                    if (in == null) throw new java.io.IOException("无法读取选中的 .deb 文件");
                    RemoteBridge.mgr().uploadToActive("{\"kind\":\"qq_deb\"}", in, finalTotal, (sent, tot) ->
                            activity.runOnUiThread(() -> {
                                if (qqDetail != null) qqDetail.setText("推送进度：" + Ui.formatProgress(sent, tot));
                                if (qqProgress != null && tot > 0) {
                                    qqProgress.setProgress((int) Math.min(100, (sent * 100L) / tot));
                                }
                            }));
                }
                RemoteBridge.mgr().triggerSnapshotRefresh();
                activity.runOnUiThread(() -> {
                    if (qqProgress != null) qqProgress.setVisibility(View.GONE);
                    host().toast("已推送并在远端安装 QQ 客户端");
                    build();
                });
            } catch (Throwable e) {
                activity.runOnUiThread(() -> {
                    if (qqProgress != null) qqProgress.setVisibility(View.GONE);
                    if (qqState != null) qqState.setText("远端推送安装失败");
                    if (qqDetail != null) qqDetail.setText(String.valueOf(e.getMessage()));
                    host().toast("推送安装失败：" + e.getMessage());
                });
            }
        }, "remote-qq-deb-push").start();
    }

    private void ensureEnvironmentFromNetwork(TextView btn) {
        if (envBusy) { host().toast("正在处理，请稍候"); return; }
        envBusy = true;
        Ui.enabled(btn, false);
        if (envState != null) envState.setText("阶段：正在连接发行源校验环境包…");
        new Thread(() -> {
            String message;
            try {
                com.whaleonebot.install.CoreInstaller ci = com.whaleonebot.install.CoreInstaller.open(activity);
                ci.ensureEnvironment(ci.current(), (item, bytes, total) ->
                        activity.runOnUiThread(() -> {
                            if (envState == null) return;
                            envState.setText("下载 " + item + "：" + Ui.formatProgress(bytes, total));
                        }));
                message = "运行环境已校验就绪";
            } catch (Throwable e) {
                android.util.Log.w("WhaleEnv", "环境包下载/解压失败", e);
                message = "环境包未下载成功（现有容器不受影响）：请检查网络后重试";
            }
            final String value = message;
            activity.runOnUiThread(() -> {
                envBusy = false;
                host().toast(value);
                build();
            });
        }, "env-ensure").start();
    }

    private void fetchDeb(TextView button) {
        if (scanning) return;
        if (RemoteBridge.isRemote()) {
            scanning = true;
            Ui.enabled(button, false);
            if (qqState != null) qqState.setText("阶段：正在让远端设备下载并安装 QQ…");
            new Thread(() -> {
                org.json.JSONObject r = RemoteBridge.rpcSync("env.downloadQqOfficial", null, 180000);
                if (RemoteBridge.mgr() != null) RemoteBridge.mgr().triggerSnapshotRefresh();
                activity.runOnUiThread(() -> {
                    scanning = false;
                    Ui.enabled(button, true);
                    boolean ok = r != null && r.optBoolean("ok", false);
                    host().toast(ok ? "远端已下载并安装 QQ 客户端" : ("远端自动下载未完成：" + (r == null ? "连接超时" : r.optString("detail"))));
                    build();
                });
            }, "remote-qq-fetch").start();
            return;
        }
        scanning = true;
        Ui.enabled(button, false);
        if (qqProgress != null) {
            qqProgress.setVisibility(View.VISIBLE);
            qqProgress.setIndeterminate(true);
        }
        qqState.setText("阶段：正在探测可用下载源…");
        qqDetail.setText("依次尝试官方最新、3.2.35、社区 3.2.32。");
        new Thread(() -> {
            QqDebFetch.Result result;
            try {
                File dir = new File(activity.getFilesDir(), "qq-packages");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("无法创建下载目录");
                result = QqDebFetch.download(dir, (stage, done, total) -> activity.runOnUiThread(() -> {
                    if (qqState == null) return;
                    if (done < 0) {
                        qqDetail.setText(stage);
                        return;
                    }
                    qqState.setText(stage);
                    qqDetail.setText(Ui.formatProgress(done, total));
                    if (qqProgress != null) {
                        qqProgress.setIndeterminate(total <= 0);
                        if (total > 0) qqProgress.setProgress((int) Math.min(100, (done * 100L) / total));
                    }
                }));
            } catch (Throwable e) {
                result = new QqDebFetch.Result();
                result.error = String.valueOf(e.getMessage());
            }
            final QqDebFetch.Result r = result;
            activity.runOnUiThread(() -> {
                scanning = false;
                Ui.enabled(button, true);
                if (qqProgress != null) qqProgress.setVisibility(View.GONE);
                if (r.file != null) {
                    found = r.file;
                    qqState.setText("已下载：" + r.file.getName());
                    qqDetail.setText(Ui.formatBytes(r.file.length()) + " · 结构校验通过，可立即安装。");
                    Ui.enabled(installButton, true);
                } else {
                    found = null;
                    qqState.setText("三个源均未取到");
                    qqDetail.setText((r.error == null ? "当前网络无法直连" : r.error) + "；可展开下方「手动导入安装包」。");
                    Ui.enabled(installButton, false);
                }
            });
        }, "qq-deb-fetch").start();
    }

    private void scan() {
        if (scanning) return;
        if (RemoteBridge.isRemote()) {
            scanning = true;
            if (qqState != null) qqState.setText("阶段：正在扫描远端设备的下载目录…");
            new Thread(() -> {
                org.json.JSONObject r = RemoteBridge.rpcSync("env.scanQqDebs", null, 15000);
                org.json.JSONArray arr = r == null ? null : r.optJSONArray("files");
                activity.runOnUiThread(() -> {
                    scanning = false;
                    if (arr == null || arr.length() == 0) {
                        if (qqState != null) qqState.setText("远端 Download 目录未找到 QQ .deb 包");
                        if (qqDetail != null) qqDetail.setText("可直接点上方「从本机选 .deb 经 P2P 推送到远端安装」。");
                        return;
                    }
                    String[] labels = new String[arr.length()];
                    final String[] paths = new String[arr.length()];
                    for (int i = 0; i < arr.length(); i++) {
                        org.json.JSONObject it = arr.optJSONObject(i);
                        labels[i] = it.optString("name") + "（" + Ui.formatBytes(it.optLong("size")) + "）";
                        paths[i] = it.optString("path");
                    }
                    PromptSheet.choose(activity, t, "选择远端下载目录中的 QQ 安装包", labels, idx -> {
                        if (qqState != null) qqState.setText("正在远端安装：" + labels[idx]);
                        new Thread(() -> {
                            try {
                                org.json.JSONObject ir = RemoteBridge.rpcSync("env.installQqDeb",
                                        new org.json.JSONObject().put("path", paths[idx]), 120000);
                                if (RemoteBridge.mgr() != null) RemoteBridge.mgr().triggerSnapshotRefresh();
                                activity.runOnUiThread(() -> {
                                    boolean ok = ir != null && ir.optBoolean("ok", false);
                                    host().toast(ok ? "远端安装 QQ 成功" : ("安装失败：" + (ir == null ? "超时" : ir.optString("detail"))));
                                    build();
                                });
                            } catch (Throwable ignored) {}
                        }, "remote-qq-ins").start();
                    }, null, null);
                });
            }, "remote-qq-scan").start();
            return;
        }
        scanning = true;
        qqState.setText("阶段：正在扫描手机下载目录…");
        qqDetail.setText("优先匹配最新下载且结构完整的 arm64 deb 包。");
        new Thread(() -> {
            String result;
            File hit = null;
            try {
                List<File> candidates = new ArrayList<>();
                File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                collect(dl, candidates, 0);
                File legacy = new File("/sdcard/Download");
                if (!legacy.getAbsolutePath().equals(dl.getAbsolutePath())) collect(legacy, candidates, 0);
                candidates.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                StringBuilder bad = new StringBuilder();
                int debCount = 0;
                for (File f : candidates) {
                    if (!f.getName().toLowerCase(Locale.ROOT).endsWith(".deb")) continue;
                    debCount += 1;
                    try (java.io.InputStream in = new java.io.BufferedInputStream(new FileInputStream(f))) {
                        QqDebArchive.inspect(in, (name, body) -> { });
                        hit = f;
                        break;
                    } catch (Throwable notDeb) {
                        if (bad.length() < 120) bad.append(bad.length() == 0 ? "" : "、").append(f.getName());
                    }
                }
                if (hit != null) result = "FOUND";
                else if (debCount > 0) result = "BAD:" + bad;
                else result = "NONE";
            } catch (Throwable e) {
                result = "ERR:" + e.getClass().getSimpleName();
            }
            final File h = hit;
            final String r = result;
            activity.runOnUiThread(() -> {
                scanning = false;
                found = h;
                if ("FOUND".equals(r)) {
                    qqState.setText("已找到：" + h.getName());
                    qqDetail.setText(Ui.formatBytes(h.length()) + " · 结构完整，点击「安装 QQ 到容器」即可。");
                    Ui.enabled(installButton, true);
                } else if (r.startsWith("BAD:")) {
                    qqState.setText("下载目录里有 deb，但结构不完整");
                    qqDetail.setText("请确认已下载完毕：" + r.substring(4));
                    Ui.enabled(installButton, false);
                } else if (r.startsWith("ERR:")) {
                    qqState.setText("扫描失败（" + r.substring(4) + "）");
                    qqDetail.setText("请确认已授予存储读取权限。");
                    Ui.enabled(installButton, false);
                } else {
                    qqState.setText("尚未找到 deb 安装包");
                    qqDetail.setText("请把 arm64 linuxqq .deb 放进手机 Download 目录后再扫描。");
                    Ui.enabled(installButton, false);
                }
            });
        }, "qq-deb-scan").start();
    }

    private void install() {
        if (found == null) { host().toast("请先下载或扫描到安装包"); return; }
        final File src = found;
        qqState.setText("阶段：正在装入容器…");
        Ui.enabled(installButton, false);
        if (qqProgress != null) {
            qqProgress.setVisibility(View.VISIBLE);
            qqProgress.setIndeterminate(true);
        }
        new Thread(() -> {
            String msg;
            try (FileInputStream in = new FileInputStream(src)) {
                File dir = new File(activity.getFilesDir(), "qq-packages");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("无法创建私有目录");
                File staged = QqDebArchive.stageUnverified(dir, in, src.length());
                File finalFile = new File(dir, "qq-" + src.getName().replaceAll("(?i)\\.deb$", ""));
                if (finalFile.exists()) finalFile.delete();
                if (!staged.renameTo(finalFile)) throw new java.io.IOException("无法重命名暂存文件");
                if (!BundledEnvironment.ensure(activity) && QqClientInstaller.resolveRootfs(activity.getFilesDir()) == null) {
                    throw new java.io.IOException("运行环境尚未铺开成功：请先在上方铺开内置环境");
                }
                QqClientInstaller.ensureBusybox(activity);
                QqClientInstaller.Result ins = QqClientInstaller.install(activity.getFilesDir(), finalFile,
                        step -> activity.runOnUiThread(() -> { if (qqDetail != null) qqDetail.setText(step); }));
                msg = ins.ok ? ("OK:" + ins.detail) : ("FAIL:" + ins.detail);
            } catch (Throwable e) {
                msg = "FAIL:" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
            final String m = msg;
            activity.runOnUiThread(() -> {
                if (qqProgress != null) qqProgress.setVisibility(View.GONE);
                if (m.startsWith("OK:")) {
                    qqReplaceExpanded = false;
                    host().toast(m.substring(3));
                    build();
                } else {
                    qqState.setText("安装未完成");
                    qqDetail.setText(m.substring(5));
                    Ui.enabled(installButton, true);
                }
            });
        }, "qq-deb-install").start();
    }

    private static void collect(File dir, List<File> out, int depth) {
        if (dir == null || depth > 3 || out.size() > 200) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (f.isDirectory()) collect(f, out, depth + 1);
            else out.add(f);
        }
    }

    private void copyText(String text, String okMessage) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("QQ 下载地址", text));
            host().toast(okMessage);
        } catch (Throwable e) {
            host().toast("复制失败，请稍后重试");
        }
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
