package com.whaleonebot.ui;

import android.os.Environment;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.ui.QqDebArchive;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 环境配置：用户拿到 APK 之后，第一件要做的事都在这一页。
 *
 * <p>两块：<b>容器</b>（下载内置核心；原来藏在「设置 → 机器人 → 下载内置核心」，新用户找不到）
 * 与 <b>QQ 安装包</b>（给一条链接，让用户在电脑上下载指定版本、放进手机的下载目录，
 * 回到这里自动扫到并安装）。
 *
 * <p>为什么用「链接 + 下载目录」而不是替用户下：官方当前的 arm64 deb 在 CDN 上取不到
 * （2026-11-21 实测同域 Windows 包 206、Linux 3.2.35 arm64 403），而我们又不分发客户端二进制。
 * 所以把「取包」留给用户，「校验 + 装配」由我们负责 —— 白名单里的版本与摘要不对就不装。
 */
final class EnvConfigScreen extends Screen {

    /**
     * ★ 2026-11-23（用户口径）：**不再设版本白名单**。
     *
     * 之前这里只有一行「3.2.35 / 208717176 / 5f93ea…」，结果是：官方直链在很多人网络上 403，
     * 用户拿别的版本一律被拒，QQ 平台对新用户等于不可用（第一个使用者就是这么卡住的）。
     * 而我们本来也保证不了「哪个版本一定能登录」——所以改成「任何结构完整的 deb 都收」：
     * 只校验它确实是一个 Debian 包（ar 头 + control/data 成员），不再比对某个固定版本的摘要。
     * 兼容性由使用者自己判断、出问题反馈给我们。
     */
    private static final String KNOWN_VERSION = "3.2.35";

    /**
     * 第 1 步给用户的链接。
     *
     * <p>旧版这里给的是 pcConfig.json —— 那是一个 <b>JSON 配置文件</b>，用户在电脑上打开只看到一坨
     * JSON，根本下不到 deb（第一个使用者就卡在这一步）。现在改成两层：
     * 「官方下载页」（人点得动）与「deb 直链」（复制得走，页面对不上时兜底）。
     */
    private static final String QQ_PAGE = "https://im.qq.com/linuxqq/index.shtml";

    /** 官方 CDN 上该版本的稳定地址；腾讯网关会校验来源，直连被 403 时以官方页面为准。 */
    private static final String QQ_DEB_URL =
            "https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_arm64_01.deb";

    private TextView qqState;
    private TextView qqDetail;
    private TextView installButton;
    private TextView envState;
    private TextView envButton;
    private volatile boolean envBusy;
    private File found;
    private boolean scanning;

    EnvConfigScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll, new android.widget.FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("环境配置"));
        col.addView(Ui.text(activity,
                "新机先备好运行环境与 QQ 安装包。",
                Theme.T_BODY, t.textSecondary));

        // ---------------- 公共运行环境（环境包） ----------------
        // 用户反馈（2026-11-23）：「环境配置页怎么没有下载环境包的选项」。环境包原先
        // 只跟着内置核心一起下、页面上看不见；这里把它做成独立卡片：本地状态 + 只下它的按钮。
        // 三层关系（用户问的就是这个）：环境包 = 系统层（bash/node/证书/协议端），
        // 核心 = 程序层（我们的运行端与平台插件），容器 = 把这两样跑起来的方式（proot）。
        // 原来把「下载内置核心」挂在「容器」栏下，等于把程序当成容器，已改。
        col.addView(sectionLabel("运行环境（系统层）"));
        LinearLayout c0 = card(col);
        c0.addView(Ui.strong(activity, "环境包", Theme.T_CARD, t.textPrimary));
        envState = Ui.text(activity, "读取环境状态…", Theme.T_CAP, t.textSecondary);
        c0.addView(envState);
        envButton = Ui.button(activity, t, "只下载环境包（修复用）", false);
        envButton.setOnClickListener(v -> ensureEnvironment());
        LinearLayout.LayoutParams elp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        elp.topMargin = dp(Theme.S2);
        c0.addView(envButton, elp);
        c0.addView(Ui.text(activity,
                "这是一套 Debian arm64 系统层：bash、node、证书、平台协议端。容器靠它起来，但它自己不是容器。\n"
                        + "装内置核心时会把还没下的环境包一并下好，所以这一步通常不用单独点。\n"
                        + "同一版本只存一份（按内容哈希分目录，用来回退与并存），下过就不重复下。",
                Theme.T_CAP, t.textSecondary));
        loadEnvironmentState();

        // ---------------- 容器 ----------------
        col.addView(sectionLabel("机器人核心（程序层）"));
                LinearLayout c1 = card(col);
                c1.addView(Ui.strong(activity, "核心在「版本管理」里下载与切换", Theme.T_CARD, t.textPrimary));
                c1.addView(Ui.text(activity,
                        "程序本体：机器人运行端与平台插件。下载、升级、回退都收在版本管理页的「内置核心版本」一节。",
                        Theme.T_CAP, t.textSecondary));
                TextView open = Ui.button(activity, t, "去版本管理下载核心", false);
                open.setOnClickListener(v -> shell.pushVersion());
                LinearLayout.LayoutParams olp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
                olp.topMargin = dp(Theme.S2);
                c1.addView(open, olp);

        // ---------------- QQ ----------------
        col.addView(sectionLabel("QQ 安装包"));
        LinearLayout c2 = card(col);

        c2.addView(Ui.strong(activity, "第 1 步：在电脑上取安装包", Theme.T_CARD, t.textPrimary));
        c2.addView(Ui.text(activity,
                "电脑浏览器打开官方下载页，点「ARM 版下载」，拿 Linux QQ 的 arm64 deb（官方最新是 "
                        + KNOWN_VERSION + "）。",
                Theme.T_CAP, t.textSecondary));

        TextView link = Ui.text(activity, QQ_PAGE, Theme.T_MONO, t.textSecondary);
        link.setTextIsSelectable(true);
        LinearLayout.LayoutParams llp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        llp.topMargin = dp(Theme.S2);
        c2.addView(link, llp);

        TextView copy = Ui.button(activity, t, "复制下载页链接", true);
        copy.setOnClickListener(v -> copyText(QQ_PAGE, "下载页链接已复制，到电脑浏览器打开"));
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        clp.topMargin = dp(Theme.S2);
        c2.addView(copy, clp);

        // 直链兜底：官方页面点不出下载时，可以把这行地址直接粘到电脑浏览器地址栏。
        c2.addView(Ui.text(activity, "下不到时用直链（电脑浏览器地址栏直接粘）：", Theme.T_CAP, t.textSecondary),
                topMargin(dp(Theme.S2)));
        TextView direct = Ui.text(activity, QQ_DEB_URL, Theme.T_MONO, t.textTertiary);
        direct.setTextIsSelectable(true);
        c2.addView(direct, topMargin(dp(Theme.S1)));
        TextView copyDeb = Ui.button(activity, t, "复制 deb 直链", false);
        copyDeb.setOnClickListener(v -> copyText(QQ_DEB_URL, "deb 直链已复制"));
        LinearLayout.LayoutParams dlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        dlp.topMargin = dp(Theme.S2);
        c2.addView(copyDeb, dlp);

        // ★ 2026-11-23（用户提议）：既然不再限定版本，就让 App 自己按「官方最新 → 3.2.35 → 社区 3.2.32」
        //   依次试，谁先回 200/206 用谁；三个都不行再让用户复制上面的链接。
        TextView fetch = Ui.button(activity, t, "让 App 直接下载（自动换源）", true);
        fetch.setOnClickListener(v -> fetchDeb(fetch));
        LinearLayout.LayoutParams flp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        flp.topMargin = dp(Theme.S2);
        c2.addView(fetch, flp);

        c2.addView(Ui.strong(activity, "第 2 步：放进手机「下载」目录", Theme.T_CARD, t.textPrimary),
                topMargin(dp(Theme.S3)));
        c2.addView(Ui.text(activity,
                "放入手机 Download 目录（子目录也可）。",
                Theme.T_CAP, t.textSecondary));

        c2.addView(Ui.strong(activity, "第 3 步：回来安装", Theme.T_CARD, t.textPrimary),
                topMargin(dp(Theme.S3)));
        qqState = Ui.text(activity, "尚未扫描", Theme.T_BODY, t.textPrimary);
        qqDetail = Ui.text(activity, "点击下方按钮扫描下载目录。", Theme.T_CAP, t.textSecondary);
        c2.addView(qqState, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        c2.addView(qqDetail, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView scan = Ui.button(activity, t, "扫描下载目录", false);
        scan.setOnClickListener(v -> scan());
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        slp.topMargin = dp(Theme.S2);
        c2.addView(scan, slp);

        installButton = Ui.button(activity, t, "安装 QQ", true);
        installButton.setEnabled(false);
        installButton.setOnClickListener(v -> install());
        LinearLayout.LayoutParams ilp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        ilp.topMargin = dp(Theme.S2);
        c2.addView(installButton, ilp);
        Ui.enabled(installButton, false);

        col.addView(Ui.text(activity,
                "不再限定版本：任何 arm64 的 QQ linuxqq deb 都能装。哪一版真能登录我们没法保证，装完登录不上就把版本号反馈给我们。",
                Theme.T_CAP, t.textTertiary), topMargin(dp(Theme.S3)));
    }

    // ------------------------------------------------------------------ 扫描

    /** 让 App 自己把 deb 拉下来：官方最新 → 已知 3.2.35 → 社区 3.2.32，谁先能用用谁。 */
    private void fetchDeb(TextView button) {
        if (scanning) return;
        scanning = true;
        button.setEnabled(false);
        qqState.setText("正在找可用的下载源…");
        qqDetail.setText("依次尝试官方最新、3.2.35、社区 3.2.32。");
        new Thread(() -> {
            QqDebFetch.Result result;
            try {
                File dir = new File(activity.getFilesDir(), "qq-packages");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("无法创建下载目录");
                result = QqDebFetch.download(dir, (stage, done, total) -> activity.runOnUiThread(() -> {
                    if (qqState == null) return;
                    if (done < 0) { qqDetail.setText(stage); return; }
                    qqState.setText(stage);
                    qqDetail.setText(total > 0
                            ? sizeText(done) + " / " + sizeText(total)
                            : sizeText(done));
                }));
            } catch (Throwable e) {
                result = new QqDebFetch.Result();
                result.error = String.valueOf(e.getMessage());
            }
            final QqDebFetch.Result r = result;
            activity.runOnUiThread(() -> {
                scanning = false;
                button.setEnabled(true);
                if (r.file != null) {
                    found = r.file;
                    qqState.setText("已下载：" + r.file.getName());
                    qqDetail.setText(sizeText(r.file.length()) + " · 结构完整，可以安装（不再限定版本）。");
                    Ui.enabled(installButton, true);
                } else {
                    found = null;
                    qqState.setText("三个源都没取到");
                    qqDetail.setText(r.error == null ? "网络不允许下载，请用上面的链接手动取包。" : r.error + "；可用上面的链接手动下载。");
                    Ui.enabled(installButton, false);
                }
            });
        }, "qq-deb-fetch").start();
    }

    /**
     * 首次使用：APK 里自带一份运行环境（assets/bundled/environment.tar），
     * 找不到可用 rootfs 时直接铺出来 —— 不联网、不用先"下载核心"。
     * 已就绪则什么都不做（绝不覆盖现有容器）。
     */
    /** 铺内置环境包（实现搬到 {@link BundledEnvironment}，启动容器与装 QQ 共用同一份逻辑）。 */
    private boolean ensureBundledEnvironment() {
        return BundledEnvironment.ensure(activity);
    }

    private void scan() {
        if (scanning) return;
        scanning = true;
        qqState.setText("正在扫描下载目录…");
        qqDetail.setText("正在校验摘要，请勿离开。");
        new Thread(() -> {
            String result;
            File hit = null;
            try {
                List<File> candidates = new ArrayList<>();
                File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                collect(dl, candidates, 0);
                File legacy = new File("/sdcard/Download");
                if (!legacy.getAbsolutePath().equals(dl.getAbsolutePath())) collect(legacy, candidates, 0);
                // 按最后修改时间倒序排列，优先命中最新下载的 deb
                candidates.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                StringBuilder bad = new StringBuilder();
                int debCount = 0;
                for (File f : candidates) {
                    if (!f.getName().toLowerCase(Locale.ROOT).endsWith(".deb")) continue;
                    debCount += 1;
                    // 只问一句「这是不是一个结构完整的 Debian 包」，不问版本、不比摘要。
                    try (java.io.InputStream in = new java.io.BufferedInputStream(new java.io.FileInputStream(f))) {
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
                    qqDetail.setText(sizeText(h.length()) + " · 结构完整，可以安装（不再限定版本）。");
                    Ui.enabled(installButton, true);
                } else if (r.startsWith("BAD:")) {
                    qqState.setText("下载目录里有 deb，但不是完整的安装包");
                    qqDetail.setText("这几份读不出 Debian 结构（可能没下完/被改过）：" + r.substring(4));
                    Ui.enabled(installButton, false);
                } else if (r.startsWith("ERR:")) {
                    qqState.setText("扫描失败");
                    qqDetail.setText("读不到下载目录（" + r.substring(4) + "）。请确认已给过存储权限。");
                    Ui.enabled(installButton, false);
                } else {
                    qqState.setText("还没找到安装包");
                    qqDetail.setText("下载目录里没有 deb。按上面三步放进来，再点一次扫描。");
                    Ui.enabled(installButton, false);
                }
            });
        }, "qq-deb-scan").start();
    }

    private void install() {
        if (found == null) { host().toast("先扫描到安装包"); return; }
        final File src = found;
        qqState.setText("正在安装…");
        Ui.enabled(installButton, false);
        new Thread(() -> {
            String msg;
            try (FileInputStream in = new FileInputStream(src)) {
                // stage() 要求 privateDir 已经存在（它只接受 isDirectory 且不替你创建），
                // 首次安装时目录还不存在，必须先建 —— 否则会被判成「不支持的包」。
                File dir = new File(activity.getFilesDir(), "qq-packages");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("无法创建私有目录：" + dir.getAbsolutePath());
                File staged = QqDebArchive.stageUnverified(dir, in, src.length());
                // stage() 返回的是 qq-client-<ts>.part 这种临时名：功能上已经校验通过，
                // 但名字看着像"没装完"。这里改成规范名，UI 与后续读取都用它。
                File finalFile = new File(dir, "qq-" + src.getName().replaceAll("(?i)\\.deb$", ""));
                if (finalFile.exists()) finalFile.delete();
                if (!staged.renameTo(finalFile)) throw new java.io.IOException("无法重命名暂存文件");
                // ★ 2026-11-24（用户反馈）：只暂存 deb 不算装好 —— 必须真解包进容器的 /opt/QQ，
                //   否则退出再进来三步卡第 2 步永远打不了勾，用户以为"装了又被卸了"。
                // 先确保有 rootfs：APK 自带一份环境包，缺失时直接铺出来（用户要求"APP 内置好环境"）。
                if (!ensureBundledEnvironment() && QqClientInstaller.resolveRootfs(activity.getFilesDir()) == null) {
                    throw new java.io.IOException("运行环境尚未铺开成功：请先在上方点击「只下载环境包」或在启动页启动一次容器");
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
                if (m.startsWith("OK:")) {
                    qqState.setText(m.substring(3));
                    qqDetail.setText("回到「QQ」平台页即可继续登录。");
                } else {
                    qqState.setText("安装失败");
                    qqDetail.setText(m.substring(5));
                    Ui.enabled(installButton, true);
                }
            });
        }, "qq-deb-install").start();
    }

    // ------------------------------------------------------------------ 工具

    private static void collect(File dir, List<File> out, int depth) {
        if (dir == null || depth > 3 || out.size() > 200) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (f.isDirectory()) collect(f, out, depth + 1);
            else out.add(f);
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[1 << 16];
        try (FileInputStream in = new FileInputStream(f)) {
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    /** 复制到剪贴板；失败也不静默（旧版只说「复制失败，请手动选中」）。 */
    private void copyText(String text, String okMessage) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("QQ 下载地址", text));
            host().toast(okMessage);
        } catch (Throwable e) {
            host().toast("复制失败，请长按上面的地址手动复制");
        }
    }

    private static String mb(String bytes) {
        try { return String.format(Locale.ROOT, "%.0f MB", Long.parseLong(bytes) / 1024.0 / 1024.0); }
        catch (Throwable e) { return bytes + " 字节"; }
    }

    private static String sizeText(long n) {
        return String.format(Locale.ROOT, "%.1f MB", n / 1024.0 / 1024.0);
    }

    private LinearLayout card(LinearLayout col) {
        android.widget.FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));
        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S2);
        col.addView(card, lp);
        return box;
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

    // ---------------- 公共运行环境（环境包） ----------------

    /**
     * 只看**本地**有没有装好运行环境 —— 不联网。
     *
     * 第一版这里直接去读发行索引，没网时状态行永远停在「读取环境状态…」，最后还甩出
     * 一句英文原文（All download sources failed (release-index)）。「我装没装」是本地事实，
     * 不该依赖网络；判据与 ContainerService 一致：rootfs 里有 bin/bash 与 usr/bin/node。
     */
    private void loadEnvironmentState() {
        if (envState == null) return;
        String text;
        try {
            File rootfs = new File(activity.getFilesDir(), "rootfs");
            // 真机实测：node 落地的实际位置是 usr/local/node/bin/node，usr/bin/node 只在部分布局里有；
            // 两者取其一即算有 node（否则明明能跑容器，界面却报「未就绪」）。
            boolean hasNode = new File(rootfs, "usr/local/node/bin/node").isFile()
                    || new File(rootfs, "usr/bin/node").isFile();
            boolean ready = new File(rootfs, "bin/bash").isFile() && hasNode;
            // 容器与环境包是两件事：容器（rootfs）在跑，不代表环境包已经下过 ——
            // 反过来下过环境包也不代表这台机在用（ManagedEnvironment.prepare 从不覆盖现有 rootfs）。
            int packs = SetupState.environmentPackCount(activity.getFilesDir());
            String pack = packs > 0 ? "已下载 " + packs + " 套" : "未下载";
            String container = ready ? "已就绪（能启动）"
                    : (packs > 0 ? "尚未铺开：回启动页点「启动容器」或直接点下方安装 QQ 会自动建好运行环境"
                                 : "尚未铺开：APK 已内置环境包，点「启动容器」或「安装 QQ」会自动铺好");
            text = "环境包：" + pack + "\n容器：" + container;
        } catch (Throwable e) {
            text = "读取不到本地状态";
        }
        envState.setText(text);
    }

    /** 只下 / 只修环境包，不装核心、不动任何实例。 */
    private void ensureEnvironment() {
        if (envBusy) { host().toast("正在处理，请稍候"); return; }
        envBusy = true;
        envButton.setEnabled(false);
        envState.setText("检查中…");
        new Thread(() -> {
            String message;
            try {
                com.whaleonebot.install.CoreInstaller ci = com.whaleonebot.install.CoreInstaller.open(activity);
                ci.ensureEnvironment(ci.current(), (item, bytes, total) ->
                        activity.runOnUiThread(() -> {
                            if (envState == null) return;
                            envState.setText(total > 0
                                    ? item + "：" + sizeText(bytes) + " / " + sizeText(total)
                                    : item);
                        }));
                message = "运行环境已就绪";
            } catch (Throwable e) {
                // 原始报错（含镜像名与英文）不进界面，只给人话；但必须留在 logcat 里 ——
                // 否则「下载没成功」既没法自查、也没法让人反馈（2026-11-23 真机实测被卡住一次）。
                android.util.Log.w("WhaleEnv", "环境包下载/解压失败", e);
                message = "环境包没下成（现有容器不受影响）：检查网络后重试";
            }
            final String value = message;
            activity.runOnUiThread(() -> {
                envBusy = false;
                if (envButton != null) envButton.setEnabled(true);
                host().toast(value);
                loadEnvironmentState();
            });
        }, "env-ensure").start();
    }
}
