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

    /** 允许安装的 QQ 包：白名单而不是「任意 deb」。加新版本时在这里追加一行。 */
    private static final String[][] QQ_ALLOWED = {
            // 版本, 精确字节数, SHA-256（小写）
            {"3.2.35", "208717176", "5f93ea62347dd772c7be4115413c95d2a60d189f3dd81bc194834bd4d7343cf2"},
    };

    /** 用户在电脑上打开这个链接，下载对应版本后放进手机的「下载」目录。 */
    private static final String QQ_LINK =
            "https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json";

    private TextView qqState;
    private TextView qqDetail;
    private TextView installButton;
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
                "这里放两件装机必需的东西：容器（机器人跑在里面）和 QQ 安装包。",
                Theme.T_BODY, t.textSecondary));

        // ---------------- 容器 ----------------
        col.addView(sectionLabel("容器"));
        LinearLayout c1 = card(col);
        c1.addView(Ui.strong(activity, "下载内置核心", Theme.T_CARD, t.textPrimary));
        c1.addView(Ui.text(activity,
                "容器就是机器人运行环境。同一版本只下载一次，之后新建机器人直接复用。",
                Theme.T_CAP, t.textSecondary));
        TextView open = Ui.button(activity, t, "打开核心下载", true);
        open.setOnClickListener(v -> shell.corePage("download", null));
        LinearLayout.LayoutParams olp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        olp.topMargin = dp(Theme.S2);
        c1.addView(open, olp);

        // ---------------- QQ ----------------
        col.addView(sectionLabel("QQ 安装包"));
        LinearLayout c2 = card(col);

        c2.addView(Ui.strong(activity, "第 1 步：在电脑上下载指定版本", Theme.T_CARD, t.textPrimary));
        c2.addView(Ui.text(activity,
                "把下面这条链接复制到电脑浏览器打开，下载 Linux QQ 的 arm64 deb 包（版本 "
                        + QQ_ALLOWED[0][0] + "，" + mb(QQ_ALLOWED[0][1]) + "）。",
                Theme.T_CAP, t.textSecondary));

        TextView link = Ui.text(activity, QQ_LINK, Theme.T_MONO, t.textSecondary);
        link.setTextIsSelectable(true);
        LinearLayout.LayoutParams llp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        llp.topMargin = dp(Theme.S2);
        c2.addView(link, llp);

        TextView copy = Ui.button(activity, t, "复制链接", false);
        copy.setOnClickListener(v -> {
            try {
                ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("QQ 下载地址", QQ_LINK));
                host().toast("链接已复制");
            } catch (Throwable e) {
                host().toast("复制失败，请手动选中上面的链接");
            }
        });
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        clp.topMargin = dp(Theme.S2);
        c2.addView(copy, clp);

        c2.addView(Ui.strong(activity, "第 2 步：放进手机「下载」目录", Theme.T_CARD, t.textPrimary));
        c2.addView(Ui.text(activity,
                "用数据线、微信/QQ 传文件、网盘都可以，放到 Download 目录（子目录也行）。",
                Theme.T_CAP, t.textSecondary));

        c2.addView(Ui.strong(activity, "第 3 步：回来安装", Theme.T_CARD, t.textPrimary));
        qqState = Ui.text(activity, "尚未扫描", Theme.T_BODY, t.textPrimary);
        qqDetail = Ui.text(activity, "点下面的按钮扫描手机的下载目录。", Theme.T_CAP, t.textSecondary);
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
                "校验通过才会安装：文件长度、SHA-256、包内 control 与主程序架构都会核对；不符合就明确告诉你原因，不会装一个坏包。",
                Theme.T_CAP, t.textTertiary), topMargin(dp(Theme.S3)));
    }

    // ------------------------------------------------------------------ 扫描

    private void scan() {
        if (scanning) return;
        scanning = true;
        qqState.setText("正在扫描下载目录…");
        qqDetail.setText("大文件读摘要需要几秒，别退出这个页面。");
        new Thread(() -> {
            String result;
            File hit = null;
            try {
                List<File> candidates = new ArrayList<>();
                File dl = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                collect(dl, candidates, 0);
                File legacy = new File("/sdcard/Download");
                if (!legacy.getAbsolutePath().equals(dl.getAbsolutePath())) collect(legacy, candidates, 0);
                long want = Long.parseLong(QQ_ALLOWED[0][1]);
                StringBuilder seen = new StringBuilder();
                for (File f : candidates) {
                    if (!f.getName().toLowerCase(Locale.ROOT).endsWith(".deb")) continue;
                    if (f.length() != want) {
                        if (seen.length() < 120) seen.append(seen.length() == 0 ? "" : "、").append(f.getName());
                        continue;
                    }
                    if (QQ_ALLOWED[0][2].equals(sha256(f))) { hit = f; break; }
                }
                if (hit != null) result = "FOUND";
                else if (seen.length() > 0) result = "SIZE:" + seen;
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
                    qqDetail.setText(sizeText(h.length()) + " · 摘要匹配白名单，可以安装。");
                    Ui.enabled(installButton, true);
                } else if (r.startsWith("SIZE:")) {
                    qqState.setText("找到了 deb，但不是指定版本");
                    qqDetail.setText("不符白名单（大小不对）：" + r.substring(5));
                    Ui.enabled(installButton, false);
                } else if (r.startsWith("ERR:")) {
                    qqState.setText("扫描失败");
                    qqDetail.setText("读不到下载目录（" + r.substring(4) + "）。请确认已给过存储权限。");
                    Ui.enabled(installButton, false);
                } else {
                    qqState.setText("还没找到安装包");
                    qqDetail.setText("下载目录里没有符合白名单的 deb。按上面三步再放一次，然后重新扫描。");
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
                File staged = QqDebArchive.stage(dir, in, src.length(), QQ_ALLOWED[0][2]);
                // stage() 返回的是 qq-client-<ts>.part 这种临时名：功能上已经校验通过，
                // 但名字看着像"没装完"。这里改成规范名，UI 与后续读取都用它。
                File finalFile = new File(dir, "qq-" + QQ_ALLOWED[0][0] + "-arm64.deb");
                if (finalFile.exists()) finalFile.delete();
                if (!staged.renameTo(finalFile)) throw new java.io.IOException("无法重命名暂存文件");
                msg = "OK:" + finalFile.getName();
            } catch (Throwable e) {
                msg = "FAIL:" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            }
            final String m = msg;
            activity.runOnUiThread(() -> {
                if (m.startsWith("OK:")) {
                    qqState.setText("已安装：" + m.substring(3));
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
}
