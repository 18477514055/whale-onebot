package com.whaleonebot.ui;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.whaleonebot.install.CoreInstaller;
import com.whaleonebot.net.MirrorFetch;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 版本管理页：App 版本、内置核心版本、平台插件版本的唯一入口。
 */
final class VersionScreen extends Screen {

    private static final String RELEASES_PATH =
            "/repos/18477514055/whale-onebot/releases?per_page=30";
    private static final String RELEASES_PAGE_URL =
            "https://github.com/18477514055/whale-onebot/releases";
    private static final String PIN_ASSET = "core-release-pin.json";
    private static final String INDEX_ASSET = "release-index.json";

    private String currentVersionName = "未知";
    private long currentVersionCode = 0L;

    private LinearLayout appListBox;
    private LinearLayout coreListBox;
    private LinearLayout pluginListBox;

    private boolean loadingApp;
    private boolean loadingCore;

    VersionScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        readAppVersion();

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("版本管理"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------------- A. App 版本 ----------------
        col.addView(sectionLabel("App 版本"));
        LinearLayout appCard = card(col);
        appCard.addView(Ui.strong(activity,
                "当前版本：" + currentVersionName + " (" + currentVersionCode + ")",
                Theme.T_CARD, t.textPrimary));
        appListBox = Ui.column(activity);
        appCard.addView(appListBox, topMargin(dp(Theme.S2)));

        // ---------------- B. 内置核心版本 ----------------
        col.addView(sectionLabel("内置核心版本"));
        LinearLayout coreCard = card(col);
        renderInstalledCores(coreCard);
        coreListBox = Ui.column(activity);
        coreCard.addView(coreListBox, topMargin(dp(Theme.S2)));

        TextView pickCore = Ui.button(activity, t, "点这里选核心版本", true);
        pickCore.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.corePage("versions", null);
            }
        });
        coreCard.addView(pickCore, topMargin(dp(Theme.S2)));

        // ---------------- C. 平台插件版本 ----------------
        col.addView(sectionLabel("平台插件版本"));
        LinearLayout pluginCard = card(col);
        pluginListBox = Ui.column(activity);
        pluginCard.addView(pluginListBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        loadAppReleases();
        loadCoreVersions();
        loadPluginVersions();
    }

    // ------------------------------------------------------------------ A. App 版本

    private void readAppVersion() {
        try {
            PackageInfo pi = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            if (pi != null) {
                if (pi.versionName != null && pi.versionName.length() > 0) {
                    currentVersionName = pi.versionName;
                }
                if (Build.VERSION.SDK_INT >= 28) {
                    currentVersionCode = pi.getLongVersionCode();
                } else {
                    currentVersionCode = pi.versionCode;
                }
            }
        } catch (Throwable ignored) {
            currentVersionName = "未知";
            currentVersionCode = 0L;
        }
    }

    private void loadAppReleases() {
        if (loadingApp) return;
        loadingApp = true;
        appListBox.removeAllViews();
        appListBox.addView(Ui.text(activity, "正在读取版本列表…", Theme.T_CAP, t.textSecondary));

        new Thread(new Runnable() {
            @Override
            public void run() {
                List<ReleaseItem> items = null;
                String source = "未知";
                String err = null;
                String apiErr = null;

                // 第一段：尝试 GitHub API 官方直连
                try {
                    String body = MirrorFetch.getJson(RELEASES_PATH);
                    String apiSource = MirrorFetch.lastSourceLabel();
                    if (apiSource == null || apiSource.length() == 0) {
                        apiSource = "未知";
                    }
                    List<ReleaseItem> parsed = parseApiReleases(body, apiSource);
                    if (!parsed.isEmpty()) {
                        items = parsed;
                        source = apiSource;
                    } else {
                        apiErr = "在线版本列表为空";
                    }
                } catch (Throwable e) {
                    String last = MirrorFetch.lastError();
                    if (last != null && last.length() > 0) {
                        apiErr = last;
                    } else {
                        String m = e.getMessage();
                        apiErr = (m == null || m.length() == 0) ? e.getClass().getSimpleName() : m;
                    }
                }

                // 第二段：第一段失败或空数组时，回退到内置发行索引
                if (items == null || items.isEmpty()) {
                    try {
                        List<ReleaseItem> fallback = loadBuiltInReleaseIndex();
                        if (!fallback.isEmpty()) {
                            items = fallback;
                            source = "内置索引";
                        } else {
                            err = combineErrors(apiErr, "内置索引为空");
                        }
                    } catch (Throwable e) {
                        String m = e.getMessage();
                        String idxErr = (m == null || m.length() == 0)
                                ? e.getClass().getSimpleName() : m;
                        err = combineErrors(apiErr, "内置索引失败(" + idxErr + ")");
                    }
                }

                final List<ReleaseItem> finalItems = items;
                final String finalSource = source;
                final String finalErr = err;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loadingApp = false;
                        renderAppReleases(finalItems, finalSource, finalErr);
                    }
                });
            }
        }, "app-releases-fetch").start();
    }

    private static List<ReleaseItem> parseApiReleases(String body, String sourceLabel) throws Exception {
        JSONArray arr = new JSONArray(body);
        List<ReleaseItem> items = new ArrayList<ReleaseItem>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            ReleaseItem item = new ReleaseItem();
            item.tag = o.optString("tag_name", "");
            String pub = o.optString("published_at", "");
            item.date = pub.length() >= 10 ? pub.substring(0, 10) : pub;
            item.prerelease = o.optBoolean("prerelease", false);
            item.htmlUrl = o.optString("html_url", "");
            item.sourceLabel = sourceLabel;
            JSONArray assets = o.optJSONArray("assets");
            if (assets != null && assets.length() > 0) {
                long firstSize = -1L;
                long apkSize = -1L;
                for (int j = 0; j < assets.length(); j++) {
                    JSONObject a = assets.optJSONObject(j);
                    if (a == null) continue;
                    String name = a.optString("name", "");
                    long sz = a.optLong("size", -1L);
                    if (j == 0) {
                        firstSize = sz;
                    }
                    if (apkSize < 0L && name.toLowerCase(Locale.ROOT).endsWith(".apk")) {
                        apkSize = sz;
                    }
                    String dl = a.optString("browser_download_url", "");
                    if (dl.length() > 0) {
                        AssetItem ai = new AssetItem();
                        ai.name = name;
                        ai.url = dl;
                        ai.size = sz;
                        item.assets.add(ai);
                    }
                }
                // 优先显示 .apk 资产大小；没有 .apk 时再回退到第一个资产。
                item.displayAssetSize = apkSize >= 0L ? apkSize : firstSize;
            }
            items.add(item);
        }
        return items;
    }

    private List<ReleaseItem> loadBuiltInReleaseIndex() throws Exception {
        String pinText = readStreamUtf8(activity.getAssets().open(PIN_ASSET));
        JSONObject pin = new JSONObject(pinText);
        String indexUrl = pin.optString("url", "").trim();
        String expectedSha = pin.optString("sha256", "").trim().toLowerCase(Locale.ROOT);

        byte[] indexBytes = null;
        try {
            indexBytes = readStreamBytes(activity.getAssets().open(INDEX_ASSET));
        } catch (Throwable ignored) {
            indexBytes = null;
        }
        if (indexBytes == null || indexBytes.length == 0) {
            if (indexUrl.length() == 0) {
                throw new Exception("pin 缺少 url");
            }
            // 走资产镜像下载通道（MirrorFetch.open），不走已失效的 API 镜像通道
            indexBytes = readStreamBytes(MirrorFetch.open(indexUrl));
        }
        if (expectedSha.length() > 0) {
            String actualSha = sha256Hex(indexBytes);
            if (!expectedSha.equals(actualSha)) {
                throw new Exception("release-index 校验不匹配");
            }
        }

        JSONObject rootObj = new JSONObject(new String(indexBytes, StandardCharsets.UTF_8));
        JSONArray releases = rootObj.optJSONArray("releases");
        List<ReleaseItem> items = new ArrayList<ReleaseItem>();
        if (releases == null) {
            return items;
        }
        for (int i = 0; i < releases.length(); i++) {
            JSONObject r = releases.optJSONObject(i);
            if (r == null) continue;
            String ver = r.optString("version", "").trim();
            if (ver.length() == 0) continue;

            ReleaseItem item = new ReleaseItem();
            item.tag = (ver.startsWith("v") || ver.startsWith("V")) ? ver : ("v" + ver);
            item.date = "—";
            item.prerelease = ver.indexOf('-') >= 0;
            item.htmlUrl = RELEASES_PAGE_URL + "/tag/" + item.tag;
            item.sourceLabel = "内置索引";

            String catalogUrl = r.optString("catalogUrl", "").trim();
            JSONObject env = r.optJSONObject("environment");
            if (env != null) {
                long envBytes = env.optLong("bytes", -1L);
                String envFile = env.optString("file", "").trim();
                String envUrl = env.optString("url", "").trim();
                if (envUrl.length() == 0 && envFile.length() > 0 && catalogUrl.length() > 0) {
                    int slash = catalogUrl.lastIndexOf('/');
                    if (slash > 0) {
                        envUrl = catalogUrl.substring(0, slash + 1) + envFile;
                    }
                }
                item.displayAssetSize = envBytes;
                if (envUrl.length() > 0) {
                    AssetItem ai = new AssetItem();
                    ai.name = envFile.length() > 0 ? envFile : "environment";
                    ai.url = envUrl;
                    ai.size = envBytes;
                    item.assets.add(ai);
                }
            }
            if (catalogUrl.length() > 0) {
                AssetItem ci = new AssetItem();
                ci.name = "catalog.json";
                ci.url = catalogUrl;
                ci.size = -1L;
                item.assets.add(ci);
            }
            items.add(item);
        }
        return items;
    }

    private static String combineErrors(String first, String second) {
        boolean hasFirst = first != null && first.length() > 0;
        boolean hasSecond = second != null && second.length() > 0;
        if (hasFirst && hasSecond) return first + "；" + second;
        if (hasFirst) return first;
        if (hasSecond) return second;
        return "未知错误";
    }

    private void renderAppReleases(List<ReleaseItem> items, String source, String err) {
        appListBox.removeAllViews();
        if (err != null || items == null) {
            appListBox.addView(Ui.text(activity,
                    "读取失败：" + (err == null ? "未知错误" : err),
                    Theme.T_BODY, t.textPrimary));
            TextView retry = Ui.button(activity, t, "重试", false);
            retry.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    loadAppReleases();
                }
            });
            appListBox.addView(retry, topMargin(dp(Theme.S2)));

            TextView openBrowser = Ui.button(activity, t, "在浏览器打开 Releases 页", false);
            openBrowser.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(RELEASES_PAGE_URL));
                        activity.startActivity(intent);
                    } catch (Throwable e) {
                        host().toast("无法打开浏览器");
                    }
                }
            });
            appListBox.addView(openBrowser, topMargin(dp(Theme.S2)));
            return;
        }
        String srcLabel = (source == null || source.length() == 0) ? "未知" : source;
        appListBox.addView(Ui.text(activity, "来源：" + srcLabel, Theme.T_CAP, t.textSecondary));
        if (items.isEmpty()) {
            appListBox.addView(Ui.text(activity, "暂无发布记录", Theme.T_CAP, t.textSecondary),
                    topMargin(dp(Theme.S1)));
            return;
        }

        String curNorm = normalizeVersion(currentVersionName);
        for (int i = 0; i < items.size(); i++) {
            final ReleaseItem item = items.get(i);
            boolean isCurrent = curNorm.length() > 0 && curNorm.equals(normalizeVersion(item.tag));

            LinearLayout row = Ui.column(activity);
            row.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S3), dp(Theme.S2));
            if (isCurrent) {
                row.setBackground(Drawables.round(
                        Ui.alpha(t.accent, 0.16f), t.accent, dp(1), dp(Theme.R_BTN)));
            } else {
                row.setBackground(Drawables.round(
                        t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
            }

            String titleText = item.tag + (isCurrent ? "  ·  当前版本" : "");
            row.addView(Ui.strong(activity, titleText, Theme.T_BODY,
                    isCurrent ? t.accent : t.textPrimary));

            StringBuilder meta = new StringBuilder();
            if (item.date.length() > 0) meta.append(item.date);
            if (meta.length() > 0) meta.append(" · ");
            meta.append(item.prerelease ? "预发布" : "正式版");
            if (item.displayAssetSize >= 0L) {
                meta.append(" · ").append(formatSize(item.displayAssetSize));
            }
            String rowSrc = (item.sourceLabel != null && item.sourceLabel.length() > 0)
                    ? item.sourceLabel : srcLabel;
            meta.append(" · 来源：").append(rowSrc);
            LinearLayout.LayoutParams mlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            mlp.topMargin = dp(4);
            row.addView(Ui.text(activity, meta.toString(), Theme.T_CAP, t.textSecondary), mlp);

            row.setClickable(true);
            row.setFocusable(true);
            Ui.press(row, 0.985f);
            row.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showReleaseDialog(item);
                }
            });

            LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            rlp.topMargin = dp(Theme.S2);
            appListBox.addView(row, rlp);
        }
    }

    private void showReleaseDialog(final ReleaseItem item) {
        StringBuilder msg = new StringBuilder();
        String primaryUrl = item.htmlUrl;
        if (item.assets.isEmpty()) {
            msg.append("该版本未附带安装包。");
            if (item.htmlUrl.length() > 0) {
                msg.append("\n\n").append(item.htmlUrl);
            }
        } else {
            primaryUrl = item.assets.get(0).url;
            for (int i = 0; i < item.assets.size(); i++) {
                AssetItem a = item.assets.get(i);
                if (a.name.toLowerCase(Locale.ROOT).endsWith(".apk")
                        && !primaryUrl.toLowerCase(Locale.ROOT).endsWith(".apk")) {
                    primaryUrl = a.url;
                }
                if (i > 0) msg.append("\n\n");
                if (a.name.length() > 0) {
                    msg.append(a.name);
                    if (a.size >= 0L) msg.append(" (").append(formatSize(a.size)).append(")");
                    msg.append("\n");
                }
                msg.append(a.url);
            }
        }

        final String copyUrl = primaryUrl;
        AlertDialog.Builder b = new AlertDialog.Builder(activity)
                .setTitle(item.tag.length() > 0 ? item.tag : "下载地址")
                .setMessage(msg.toString())
                .setNegativeButton("关闭", null);
        if (copyUrl != null && copyUrl.length() > 0) {
            b.setPositiveButton("复制链接", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    try {
                        ClipboardManager cm = (ClipboardManager)
                                activity.getSystemService(Context.CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(ClipData.newPlainText("下载地址", copyUrl));
                        host().toast("链接已复制");
                    } catch (Throwable e) {
                        host().toast("复制失败");
                    }
                }
            });
        }
        b.show();
    }

    // ------------------------------------------------------------------ B. 内置核心版本

    private void renderInstalledCores(LinearLayout coreCard) {
        List<CoreInventory.Instance> managed = managedCores();
        if (managed.isEmpty()) {
            coreCard.addView(Ui.text(activity, "尚未安装内置核心", Theme.T_BODY, t.textSecondary));
            return;
        }
        for (int i = 0; i < managed.size(); i++) {
            CoreInventory.Instance c = managed.get(i);
            String line = c.version + " · " + CoreManagerScreen.occupant(c) + " (" + c.id + ")";
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            if (i > 0) lp.topMargin = dp(4);
            coreCard.addView(Ui.strong(activity, line, Theme.T_BODY, t.textPrimary), lp);
        }
    }

    private void loadCoreVersions() {
        if (loadingCore) return;
        loadingCore = true;
        coreListBox.removeAllViews();
        coreListBox.addView(Ui.text(activity, "正在读取可用核心版本…", Theme.T_CAP, t.textSecondary));

        new Thread(new Runnable() {
            @Override
            public void run() {
                List<String> versions = null;
                String current = null;
                String err = null;
                try {
                    CoreInstaller ci = CoreInstaller.open(activity);
                    versions = ci.versions(true);
                    current = ci.current();
                } catch (Throwable e) {
                    String m = e.getMessage();
                    err = (m == null || m.length() == 0) ? e.getClass().getSimpleName() : m;
                }
                final List<String> finalVersions = versions;
                final String finalCurrent = current;
                final String finalErr = err;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        loadingCore = false;
                        renderCoreVersions(finalVersions, finalCurrent, finalErr);
                    }
                });
            }
        }, "core-versions-fetch").start();
    }

    private void renderCoreVersions(List<String> versions, String current, String err) {
        coreListBox.removeAllViews();
        if (err != null || versions == null) {
            coreListBox.addView(Ui.text(activity,
                    "读取失败：" + (err == null ? "未知错误" : err),
                    Theme.T_BODY, t.textPrimary));
            TextView retry = Ui.button(activity, t, "重试", false);
            retry.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    loadCoreVersions();
                }
            });
            coreListBox.addView(retry, topMargin(dp(Theme.S2)));
            return;
        }
        if (versions.isEmpty()) {
            coreListBox.addView(Ui.text(activity, "暂无可用核心版本", Theme.T_CAP, t.textSecondary));
            return;
        }
        coreListBox.addView(Ui.text(activity, "可用核心版本：", Theme.T_CAP, t.textSecondary));
        for (int i = 0; i < versions.size(); i++) {
            String v = versions.get(i);
            boolean isDefault = v.equals(current);
            TextView row = Ui.text(activity,
                    v + (isDefault ? "（推荐）" : ""),
                    Theme.T_BODY, isDefault ? t.accent : t.textPrimary);
            row.setPadding(dp(Theme.S2), dp(Theme.S1 + 2), dp(Theme.S2), dp(Theme.S1 + 2));
            row.setClickable(true);
            row.setFocusable(true);
            row.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    shell.corePage("versions", null);
                }
            });
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = dp(4);
            coreListBox.addView(row, lp);
        }
    }

    // ------------------------------------------------------------------ C. 平台插件版本

    private void loadPluginVersions() {
        pluginListBox.removeAllViews();
        final List<CoreInventory.Instance> managed = managedCores();
        if (managed.isEmpty()) {
            pluginListBox.addView(Ui.text(activity, "暂无已装内置核心", Theme.T_CAP, t.textSecondary));
            return;
        }
        pluginListBox.addView(Ui.text(activity, "正在读取已装插件…", Theme.T_CAP, t.textSecondary));

        new Thread(new Runnable() {
            @Override
            public void run() {
                final List<CorePluginGroup> groups = new ArrayList<CorePluginGroup>();
                File filesDir = activity.getFilesDir();
                for (int i = 0; i < managed.size(); i++) {
                    CoreInventory.Instance c = managed.get(i);
                    CorePluginGroup g = new CorePluginGroup();
                    g.coreId = c.id;
                    g.title = CoreManagerScreen.occupant(c) + " · " + c.version;
                    List<String> ps = CoreManagerScreen.platforms(c);
                    File active = null;
                    try {
                        active = CoreInstaller.active(filesDir, c.id);
                    } catch (Throwable ignored) {
                        active = null;
                    }
                    for (int j = 0; j < ps.size(); j++) {
                        String p = ps.get(j);
                        String state = readPluginVersion(active, p);
                        g.lines.add(BotRegistry.PLATFORM_LABEL(p) + "：" + state);
                    }
                    groups.add(g);
                }
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        renderPluginGroups(groups);
                    }
                });
            }
        }, "plugin-versions-read").start();
    }

    private void renderPluginGroups(List<CorePluginGroup> groups) {
        pluginListBox.removeAllViews();
        for (int i = 0; i < groups.size(); i++) {
            final CorePluginGroup g = groups.get(i);
            LinearLayout.LayoutParams tlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            if (i > 0) tlp.topMargin = dp(Theme.S3);
            pluginListBox.addView(Ui.strong(activity, g.title, Theme.T_BODY, t.textPrimary), tlp);

            if (g.lines.isEmpty()) {
                pluginListBox.addView(Ui.text(activity, "未绑定平台插件", Theme.T_CAP, t.textSecondary),
                        topMargin(dp(4)));
            } else {
                for (int j = 0; j < g.lines.size(); j++) {
                    pluginListBox.addView(Ui.text(activity, g.lines.get(j), Theme.T_CAP, t.textSecondary),
                            topMargin(dp(4)));
                }
            }

            TextView manage = Ui.button(activity, t, "管理插件", false);
            manage.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    shell.corePage("plugins", g.coreId);
                }
            });
            pluginListBox.addView(manage, topMargin(dp(Theme.S2)));
        }
    }

    private static String readPluginVersion(File active, String platform) {
        if (active == null) return "待安装";
        File receipt = new File(active, "src/platform-modules/" + platform + "/.bot-module.json");
        if (!receipt.isFile()) return "待安装";
        try (FileInputStream in = new FileInputStream(receipt)) {
            JSONObject obj = new JSONObject(readStreamUtf8(in));
            String ver = obj.optString("version", "");
            return ver.length() > 0 ? ver : "已安装";
        } catch (Throwable ignored) {
            return "已安装";
        }
    }

    // ------------------------------------------------------------------ 工具

    private List<CoreInventory.Instance> managedCores() {
        List<CoreInventory.Instance> out = new ArrayList<CoreInventory.Instance>();
        List<CoreInventory.Instance> all = BotRegistry.cores();
        if (all == null) return out;
        for (int i = 0; i < all.size(); i++) {
            CoreInventory.Instance c = all.get(i);
            if (CoreManagerScreen.managed(c)) out.add(c);
        }
        return out;
    }

    private static byte[] readStreamBytes(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
        return out.toByteArray();
    }

    private static String readStreamUtf8(InputStream in) throws Exception {
        return new String(readStreamBytes(in), StandardCharsets.UTF_8);
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(data);
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (int i = 0; i < digest.length; i++) {
            int v = digest[i] & 0xff;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    private static String normalizeVersion(String v) {
        if (v == null) return "";
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) {
            s = s.substring(1);
        }
        return s;
    }

    private static String formatSize(long bytes) {
        if (bytes < 0L) return "";
        if (bytes < 1024L) return bytes + " B";
        if (bytes < 1024L * 1024L) {
            return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
        }
        return String.format(Locale.ROOT, "%.1f MB", bytes / 1024.0 / 1024.0);
    }

    private LinearLayout card(LinearLayout col) {
        FrameLayout card = Ui.card(activity, t);
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

    private static final class ReleaseItem {
        String tag = "";
        String date = "";
        boolean prerelease;
        String htmlUrl = "";
        String sourceLabel = "";
        long displayAssetSize = -1L;
        final List<AssetItem> assets = new ArrayList<AssetItem>();
    }

    private static final class AssetItem {
        String name = "";
        String url = "";
        long size = -1L;
    }

    private static final class CorePluginGroup {
        String coreId = "";
        String title = "";
        final List<String> lines = new ArrayList<String>();
    }
}
