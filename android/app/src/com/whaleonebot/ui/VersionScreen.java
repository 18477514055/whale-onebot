package com.whaleonebot.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
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
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * [layer: shell-android] 版本管理页：App 版本、内置核心版本、平台插件版本的唯一就地管理入口。
 *
 * <p>按 2026-11-25 问答报告（Q1–Q6/Q8/Q14）重构：
 * 1) 顶部状态总览卡 + 内置自动更新开关（彻底消灭跳进同名 CoreManagerScreen("versions") 裸页的套娃）；
 * 2) App 版本默认只展示最新正式版/预发布版 + 当前版本（最多 3 条），历史版本折叠；点开突出 APK，其他资产折叠；
 * 3) 内置核心与平台插件支持页内直接选择版本、下载/切换，并用人类可读 MB + 百分比进度展示。
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
    private LinearLayout mirrorBox;
    private LinearLayout installedCoresBox;
    private LinearLayout coreVersionsBox;
    private LinearLayout componentBox;
    private String componentBusy;
    private TextView appUpdateBtn;
    private TextView appUpdateHint;
    private ReleaseItem selectedRelease;
    private long updateDownloadId = -1L;
    private android.content.BroadcastReceiver updateReceiver;
    private LinearLayout pluginListBox;
    private TextView coreProgressText;
    private ProgressBar coreProgressBar;

    private boolean loadingApp;
    private boolean loadingCore;
    private boolean probingMirrors;
    private boolean showAllReleases;
    private boolean componentsExpanded;
    private List<ReleaseItem> cachedReleases;
    private List<MirrorFetch.ProbeResult> lastProbeResults;
    private String cachedSource = "未知";
    private String cachedErr;
    private CoreManagerScreen.Download lastShownDownload;

    VersionScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();
        readAppVersion();

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("版本与国内镜像"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------------- 顶部状态总览卡 ----------------
        LinearLayout summaryCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout topRow = Ui.row(activity);
        topRow.addView(Ui.strong(activity, "当前状态总览", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        topRow.addView(Ui.pill(activity, t, "v" + normalizeVersion(currentVersionName), Ui.TONE_OK));
        summaryCard.addView(topRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        List<CoreInventory.Instance> managed = managedCores();
        int freeCount = 0;
        for (CoreInventory.Instance c : managed) {
            if (c.ownerId == null || c.ownerId.isEmpty()) freeCount++;
        }
        LinearLayout pillRow = Ui.row(activity);
        pillRow.addView(Ui.pill(activity, t, "内部版本 " + currentVersionCode, Ui.TONE_NEUTRAL));
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
        gap.leftMargin = dp(Theme.S1);
        pillRow.addView(Ui.pill(activity, t,
                "内置核心 " + managed.size() + " 份（空闲 " + freeCount + "）",
                managed.isEmpty() ? Ui.TONE_WARN : Ui.TONE_OK), gap);
        summaryCard.addView(pillRow, topMargin(dp(Theme.S2)));

        summaryCard.addView(Ui.divider(activity, t));

        LinearLayout autoRow = Ui.row(activity);
        LinearLayout autoText = Ui.column(activity);
        autoText.addView(Ui.strong(activity, "自动准备核心更新", Theme.T_BODY, t.textPrimary));
        autoText.addView(Ui.text(activity, "开启后后台下载新核心，下次正常启动时切换（默认仅提醒）",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
        autoRow.addView(autoText, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        Switch autoSw = new Switch(activity);
        boolean autoOn;
        if (RemoteBridge.isRemote()) {
            org.json.JSONObject vs = RemoteBridge.rpcSync("version.status", null, 5000);
            autoOn = vs != null && vs.optBoolean("autoCore", false);
        } else {
            autoOn = CoreInstaller.auto(activity.getFilesDir());
        }
        autoSw.setChecked(autoOn);
        autoSw.setOnCheckedChangeListener((btn, on) -> {
            if (RemoteBridge.isRemote()) {
                new Thread(() -> {
                    try {
                        RemoteBridge.mgr().callActiveRpc("version.setAuto", new org.json.JSONObject().put("enabled", on), 8000);
                        activity.runOnUiThread(() -> host().toast(on ? "已开启远端自动准备核心更新" : "已关闭远端自动更新"));
                    } catch (Throwable ex) {
                        activity.runOnUiThread(() -> host().toast("远端自动更新设置失败"));
                    }
                }, "remote-auto-core").start();
                return;
            }
            try {
                CoreInstaller.setAuto(activity.getFilesDir(), on);
                host().toast(on ? "已开启自动下载核心更新" : "已关闭自动下载，改为手动更新");
            } catch (Exception ex) {
                host().toast("无法更改自动更新设置");
            }
        });
        autoRow.addView(autoSw, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        summaryCard.addView(autoRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------------- A. App 版本 ----------------
        col.addView(sectionLabel("App 版本"));
        LinearLayout appCard = Ui.addCard(col, activity, t, Theme.S1);
        appListBox = Ui.column(activity);
        appCard.addView(appListBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ★ 版本列表底部的唯一动作：选中版本 → 下载 → 拉起安装（用户要求，别再弹资产清单）
        appUpdateHint = Ui.text(activity, "", Theme.T_CAP, t.textSecondary);
        appCard.addView(appUpdateHint, topMargin(dp(Theme.S3)));
        appUpdateBtn = Ui.button(activity, t, "先点一下上面的版本", true);
        appUpdateBtn.setEnabled(false);
        appUpdateBtn.setOnClickListener(v -> startAppUpdate());
        appCard.addView(appUpdateBtn, topMargin(dp(Theme.S2)));

        // ---------------- A2. 国内镜像源与一键测速 ----------------
        col.addView(sectionLabel("国内镜像源与网络测速（免 VPN）"));
        LinearLayout mirrorCard = Ui.addCard(col, activity, t, Theme.S1);
        mirrorBox = Ui.column(activity);
        mirrorCard.addView(mirrorBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        renderMirrorPanel();

        // ---------------- B. 内置核心版本 ----------------
        col.addView(sectionLabel("内置核心版本"));
        LinearLayout coreCard = Ui.addCard(col, activity, t, Theme.S1);
        installedCoresBox = Ui.column(activity);
        coreCard.addView(installedCoresBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        renderInstalledCores();

        coreProgressText = Ui.text(activity, "", Theme.T_CAP, t.textSecondary);
        coreProgressText.setVisibility(View.GONE);
        coreCard.addView(coreProgressText, topMargin(dp(Theme.S2)));
        coreProgressBar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        coreProgressBar.setVisibility(View.GONE);
        coreCard.addView(coreProgressBar, topMargin(dp(Theme.S1)));

        coreCard.addView(Ui.divider(activity, t));
        coreVersionsBox = Ui.column(activity);
        coreCard.addView(coreVersionsBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView downloadCore = Ui.button(activity, t, "下载并创建新核心", true);
        downloadCore.setOnClickListener(v -> shell.corePage("download", null));
        coreCard.addView(downloadCore, topMargin(dp(Theme.S3)));

        // ---------------- C. 平台插件版本 ----------------
        col.addView(sectionLabel("平台插件版本"));
        LinearLayout pluginCard = Ui.addCard(col, activity, t, Theme.S1);
        pluginListBox = Ui.column(activity);
        pluginCard.addView(pluginListBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------------- D. 内置部件（P14：各自独立版本号） ----------------
        col.addView(sectionLabel("内置部件（各自独立版本）"));
        LinearLayout componentCard = Ui.addCard(col, activity, t, Theme.S1);
        componentBox = Ui.column(activity);
        componentCard.addView(componentBox, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        loadAppReleases();
        loadCoreVersions();
        loadPluginVersions();
        loadComponents();
        refresh();
    }

    @Override
    void refresh() {
        CoreManagerScreen.Download d = CoreManagerScreen.currentDownload();
        if (coreProgressText == null || coreProgressBar == null || d == null || d == lastShownDownload) return;
        lastShownDownload = d;
        coreProgressText.setVisibility(View.VISIBLE);
        coreProgressBar.setVisibility(d.running ? View.VISIBLE : View.GONE);
        coreProgressBar.setIndeterminate(d.total <= 0);
        if (d.total > 0) {
            coreProgressBar.setProgress((int) Math.min(100, (d.bytes * 100L) / d.total));
            coreProgressText.setText(d.label + "：" + Ui.formatProgress(d.bytes, d.total));
        } else {
            coreProgressText.setText(d.label);
        }
        if (!d.running) {
            renderInstalledCores();
            loadPluginVersions();
        }
    }

    // ------------------------------------------------------------------ A. App 版本

    private void readAppVersion() {
        if (RemoteBridge.isRemote()) {
            com.whaleonebot.remote.RemoteControlManager.RemoteSnapshot snap = RemoteBridge.mgr().activeSnapshot();
            if (snap.appVersionName != null && !snap.appVersionName.isEmpty()) {
                currentVersionName = snap.appVersionName;
                currentVersionCode = snap.appVersionCode;
                return;
            }
            org.json.JSONObject vs = RemoteBridge.rpcSync("version.status", null, 5000);
            if (vs != null && !vs.optString("versionName", "").isEmpty()) {
                currentVersionName = vs.optString("versionName");
                currentVersionCode = vs.optInt("versionCode", 0);
                return;
            }
        }
        try {
            PackageInfo pi = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            if (pi != null) {
                if (pi.versionName != null && pi.versionName.length() > 0) currentVersionName = pi.versionName;
                currentVersionCode = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
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

        new Thread(() -> {
            List<ReleaseItem> items = null;
            String source = "未知";
            String err = null;
            String apiErr = null;
            try {
                String body = MirrorFetch.getAppReleasesJson(RELEASES_PATH);
                String apiSource = MirrorFetch.lastSourceLabel();
                if (apiSource == null || apiSource.length() == 0) apiSource = "国内镜像";
                List<ReleaseItem> parsed = parseApiReleases(body, apiSource);
                if (!parsed.isEmpty()) {
                    items = parsed;
                    source = apiSource;
                } else {
                    apiErr = "在线版本列表为空";
                }
            } catch (Throwable e) {
                String last = MirrorFetch.lastError();
                if (last != null && last.length() > 0) apiErr = last;
                else {
                    String m = e.getMessage();
                    apiErr = (m == null || m.length() == 0) ? e.getClass().getSimpleName() : m;
                }
            }

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
                    err = combineErrors(apiErr, "内置索引失败(" + ((m == null || m.length() == 0) ? e.getClass().getSimpleName() : m) + ")");
                }
            }

            final List<ReleaseItem> finalItems = items;
            final String finalSource = source;
            final String finalErr = err;
            activity.runOnUiThread(() -> {
                loadingApp = false;
                cachedReleases = finalItems;
                cachedSource = finalSource;
                cachedErr = finalErr;
                renderAppReleases();
            });
        }, "app-releases-fetch").start();
    }

    private static List<ReleaseItem> parseApiReleases(String body, String sourceLabel) throws Exception {
        JSONArray arr = new JSONArray(body);
        List<ReleaseItem> items = new ArrayList<>();
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
                    if (j == 0) firstSize = sz;
                    if (apkSize < 0L && name.toLowerCase(Locale.ROOT).endsWith(".apk")) apkSize = sz;
                    String dl = a.optString("browser_download_url", "");
                    if (dl.length() > 0) {
                        AssetItem ai = new AssetItem();
                        ai.name = name;
                        ai.url = dl;
                        ai.size = sz;
                        item.assets.add(ai);
                    }
                }
                item.displayAssetSize = apkSize >= 0L ? apkSize : firstSize;
            }
            items.add(item);
        }
        return items;
    }

    private byte[] loadIndexBytes() throws Exception {
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
            if (indexUrl.length() == 0) throw new Exception("pin 缺少 url");
            indexBytes = readStreamBytes(MirrorFetch.open(indexUrl));
        }
        if (expectedSha.length() > 0 && !expectedSha.equals(sha256Hex(indexBytes))) {
            throw new Exception("release-index 校验不匹配");
        }
        return indexBytes;
    }

    /**
     * [layer: shell-android] 列出内置部件并支持按部件下载（P14）。
     * 只读索引里的 components{}；没有该字段（旧索引）时 ComponentIndex 会退回 releases[].environment。
     */
    private void loadComponents() {
        if (componentBox == null) return;
        componentBox.removeAllViews();
        componentBox.addView(Ui.text(activity, "正在读取部件索引…", Theme.T_CAP, t.textSecondary));
        new Thread(() -> {
            com.whaleonebot.install.ComponentIndex index = null;
            String err = null;
            try {
                index = com.whaleonebot.install.ComponentIndex.of(loadIndexBytes());
            } catch (Throwable ex) {
                err = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            }
            final com.whaleonebot.install.ComponentIndex got = index;
            final String failure = err;
            activity.runOnUiThread(() -> renderComponents(got, failure));
        }, "component-index").start();
    }

    private void renderComponents(com.whaleonebot.install.ComponentIndex index, String failure) {
        if (componentBox == null) return;
        componentBox.removeAllViews();
        if (index == null) {
            componentBox.addView(Ui.text(activity, "读取部件索引失败：" + failure, Theme.T_CAP, t.textSecondary));
            return;
        }
        if (index.schemaVersion() < 2) {
            componentBox.addView(Ui.text(activity,
                    "索引还是 v1（只有环境包带部件信息）。升级到带 components 的索引后，这里会列出核心、插件与各平台后端。",
                    Theme.T_CAP, t.textSecondary));
        }
        java.util.List<com.whaleonebot.install.ComponentIndex.Entry> all = index.all();
        if (all.isEmpty()) {
            componentBox.addView(Ui.text(activity, "没有可显示的部件", Theme.T_CAP, t.textSecondary));
            return;
        }
        for (int i = 0; i < all.size(); i++) {
            com.whaleonebot.install.ComponentIndex.Entry e = all.get(i);
            if (i > 0) componentBox.addView(Ui.divider(activity, t));
            LinearLayout row = Ui.column(activity);
            row.addView(Ui.strong(activity, e.title() + "  " + e.version, Theme.T_BODY, t.textPrimary));
            String status = com.whaleonebot.install.ComponentFetcher.status(activity.getFilesDir(), e);
            String size = e.bytes > 0 ? com.whaleonebot.install.ComponentFetcher.mb(e.bytes) : "体积未知";
            row.addView(Ui.text(activity, size + " · " + status, Theme.T_CAP, t.textSecondary),
                    topMargin(dp(Theme.S1)));
            if (e.published() && !"已就绪".equals(status)) {
                boolean busy = (e.group + "/" + e.id + "/" + e.version).equals(componentBusy);
                TextView get = Ui.button(activity, t, busy ? "正在下载…" : "下载", true);
                get.setEnabled(!busy);
                get.setOnClickListener(v -> startComponentDownload(e));
                row.addView(get, topMargin(dp(Theme.S2)));
            }
            componentBox.addView(row, topMargin(dp(Theme.S2)));
        }
    }

    private void startComponentDownload(com.whaleonebot.install.ComponentIndex.Entry e) {
        componentBusy = e.group + "/" + e.id + "/" + e.version;
        host().toast("开始下载 " + e.title() + " " + e.version);
        new Thread(() -> {
            String err = null;
            File out = null;
            try {
                out = com.whaleonebot.install.ComponentFetcher.download(
                        activity.getFilesDir(), e, new com.whaleonebot.install.ComponentFetcher.Listener() {
                            @Override
                            public void progress(long bytes, long total) {
                            }

                            @Override
                            public void done(File file, String error) {
                            }
                        });
            } catch (Throwable ex) {
                err = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
            }
            final String failure = err;
            final File file = out;
            activity.runOnUiThread(() -> {
                componentBusy = null;
                host().toast(failure == null
                        ? ("已下载 " + e.title() + " " + e.version + (file == null ? "" : " → " + file.getParentFile().getName()))
                        : ("下载失败：" + failure));
                loadComponents();
            });
        }, "component-fetch").start();
    }

    private List<ReleaseItem> loadBuiltInReleaseIndex() throws Exception {
        byte[] indexBytes = loadIndexBytes();

        JSONObject rootObj = new JSONObject(new String(indexBytes, StandardCharsets.UTF_8));
        JSONArray releases = rootObj.optJSONArray("releases");
        List<ReleaseItem> items = new ArrayList<>();
        if (releases == null) return items;
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
                    if (slash > 0) envUrl = catalogUrl.substring(0, slash + 1) + envFile;
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

    private void renderAppReleases() {
        appListBox.removeAllViews();
        if (cachedErr != null || cachedReleases == null) {
            appListBox.addView(Ui.text(activity, "读取失败：" + (cachedErr == null ? "未知错误" : cachedErr),
                    Theme.T_BODY, t.textPrimary));
            TextView retry = Ui.button(activity, t, "重试读取", false);
            retry.setOnClickListener(v -> loadAppReleases());
            appListBox.addView(retry, topMargin(dp(Theme.S2)));

            TextView openBrowser = Ui.button(activity, t, "在浏览器打开 Releases 页", false);
            openBrowser.setOnClickListener(v -> openUrl(RELEASES_PAGE_URL));
            appListBox.addView(openBrowser, topMargin(dp(Theme.S2)));
            return;
        }
        if (cachedReleases.isEmpty()) {
            appListBox.addView(Ui.text(activity, "暂无发布记录", Theme.T_CAP, t.textSecondary));
            return;
        }

        String curNorm = normalizeVersion(currentVersionName);
        List<ReleaseItem> visible;
        if (showAllReleases || cachedReleases.size() <= 3) {
            visible = cachedReleases;
        } else {
            // 默认只展示最新正式版 + 最新预发布版 + 当前版本（最多 3 条），避免 30 条记录占满首屏（问答报告 Q5）
            visible = new ArrayList<>();
            ReleaseItem latestStable = null;
            ReleaseItem latestPre = null;
            ReleaseItem currentItem = null;
            for (ReleaseItem r : cachedReleases) {
                if (latestStable == null && !r.prerelease) latestStable = r;
                if (latestPre == null && r.prerelease) latestPre = r;
                if (currentItem == null && curNorm.length() > 0 && curNorm.equals(normalizeVersion(r.tag))) currentItem = r;
            }
            if (latestStable != null) visible.add(latestStable);
            if (latestPre != null && !visible.contains(latestPre)) visible.add(latestPre);
            if (currentItem != null && !visible.contains(currentItem)) visible.add(currentItem);
            for (ReleaseItem r : cachedReleases) {
                if (visible.size() >= 3) break;
                if (!visible.contains(r)) visible.add(r);
            }
        }

        LinearLayout headRow = Ui.row(activity);
        headRow.addView(Ui.text(activity, "共 " + cachedReleases.size() + " 个版本 · 来源：" + cachedSource,
                Theme.T_CAP, t.textSecondary), new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        appListBox.addView(headRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        for (int i = 0; i < visible.size(); i++) {
            final ReleaseItem item = visible.get(i);
            boolean isCurrent = curNorm.length() > 0 && curNorm.equals(normalizeVersion(item.tag));
            boolean isSelected = selectedRelease != null && selectedRelease.tag.equals(item.tag);

            LinearLayout row = Ui.row(activity);
            row.setPadding(dp(Theme.S2 + 2), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
            if (isCurrent || isSelected) {
                row.setBackground(Drawables.round(Ui.alpha(t.accent, t.dark ? 0.18f : 0.10f),
                        t.accent, dp(1), dp(Theme.R_BTN)));
            } else {
                row.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
            }

            LinearLayout left = Ui.column(activity);
            LinearLayout titleRow = Ui.row(activity);
            titleRow.addView(Ui.strong(activity, item.tag, Theme.T_BODY, isCurrent ? t.toneStrong : t.textPrimary));
            LinearLayout.LayoutParams badgeLp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
            badgeLp.leftMargin = dp(Theme.S1);
            if (isCurrent) {
                titleRow.addView(Ui.pill(activity, t, "当前", Ui.TONE_OK), badgeLp);
            }
            LinearLayout.LayoutParams typeLp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
            typeLp.leftMargin = dp(6);
            titleRow.addView(Ui.pill(activity, t, item.prerelease ? "预发布" : "正式版",
                    item.prerelease ? Ui.TONE_WARN : Ui.TONE_NEUTRAL), typeLp);
            left.addView(titleRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

            StringBuilder meta = new StringBuilder();
            if (item.date.length() > 0) meta.append(item.date);
            if (item.displayAssetSize >= 0L) {
                if (meta.length() > 0) meta.append(" · ");
                meta.append("安装包 ").append(Ui.formatBytes(item.displayAssetSize));
            }
            left.addView(Ui.text(activity, meta.toString(), Theme.T_CAP, t.textSecondary), topMargin(dp(4)));
            row.addView(left, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));

            row.setClickable(true);
            row.setFocusable(true);
            Ui.press(row, 0.985f);
            row.setOnClickListener(v -> selectRelease(item));
            appListBox.addView(row, topMargin(dp(Theme.S2)));
        }

        syncAppUpdate();

        if (cachedReleases.size() > 3) {
            String toggleLabel = showAllReleases
                    ? "收起历史版本"
                    : "查看全部历史版本（共 " + cachedReleases.size() + " 个）";
            TextView toggle = Ui.button(activity, t, toggleLabel, false);
            toggle.setOnClickListener(v -> {
                showAllReleases = !showAllReleases;
                renderAppReleases();
            });
            appListBox.addView(toggle, topMargin(dp(Theme.S2)));
        }
    }

    /**
     * 点一下版本 = 选中它；真正的动作是列表底部的「下载并更新」按钮。
     *
     * <p>★ 改动原因（P2，原值·为何改·改成多少）：原来点一行会弹一个把**全部发行资产逐条列出**的弹层
     * （环境包/核心/插件/合规源码各带完整 URL），那个弹层只能看不能点，等于把用户堵死；
     * 用户明确要求「点某个版本 → 点底部更新 → 下载完就更新」。现在把弹层整个去掉，改成选中 + 底部按钮。
     */
    private void selectRelease(ReleaseItem item) {
        selectedRelease = item;
        renderAppReleases();
    }

    private void syncAppUpdate() {
        if (appUpdateBtn == null) return;
        String cur = normalizeVersion(currentVersionName);
        if (selectedRelease == null) {
            appUpdateBtn.setText("先点一下上面的版本");
            appUpdateBtn.setEnabled(false);
            if (appUpdateHint != null) appUpdateHint.setText("选中一个版本后，这里会变成「下载并更新」");
            return;
        }
        AssetItem apk = apkOf(selectedRelease);
        boolean isCurrent = cur.length() > 0 && cur.equals(normalizeVersion(selectedRelease.tag));
        if (isCurrent) {
            appUpdateBtn.setText("已是最新（" + selectedRelease.tag + "）");
            appUpdateBtn.setEnabled(false);
            if (appUpdateHint != null) appUpdateHint.setText("当前装的就是这个版本");
            return;
        }
        if (apk == null || apk.url == null || apk.url.length() == 0) {
            appUpdateBtn.setText("该版本没有 APK 安装包");
            appUpdateBtn.setEnabled(false);
            if (appUpdateHint != null) appUpdateHint.setText("只能在发布页查看说明");
            return;
        }
        appUpdateBtn.setText("下载并更新到 " + selectedRelease.tag);
        appUpdateBtn.setEnabled(activeUpdateDownloadId < 0);
        if (appUpdateHint != null) {
            String size = apk.size > 0 ? " · " + Ui.formatBytes(apk.size) : "";
            appUpdateHint.setText(activeUpdateDownloadId >= 0
                    ? (activeUpdateProgressText.isEmpty() ? ("正在下载 " + activeUpdateFileName + "…（完成后会自动拉起安装）") : activeUpdateProgressText)
                    : apk.name + size + "（下载完成后自动拉起安装器）");
        }
    }

    private AssetItem apkOf(ReleaseItem item) {
        if (item == null) return null;
        for (AssetItem a : item.assets) {
            if (a.name != null && a.name.toLowerCase(Locale.ROOT).endsWith(".apk")) return a;
        }
        return null;
    }

    /** 跨页面重建保持下载状态：防止离开版本管理页后丢失自动拉起安装回调。 */
    private static volatile long activeUpdateDownloadId = -1L;
    private static volatile String activeUpdateFileName = "";
    private static volatile String activeUpdateProgressText = "";
    private static volatile android.content.BroadcastReceiver activeUpdateReceiver = null;
    private static final java.util.concurrent.atomic.AtomicBoolean activeUpdateInstalled =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private static volatile android.app.Activity lastForegroundActivity = null;

    /** 经 MirrorFetch 自动解析当前网络可连通的国内镜像 APK 地址后再交由系统 DownloadManager，下载完成自动拉起安装器。 */
    private void startAppUpdate() {
        final AssetItem apk = apkOf(selectedRelease);
        final ReleaseItem rel = selectedRelease;
        if (apk == null || apk.url == null || apk.url.length() == 0 || rel == null) return;

        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            host().toast("请先允许本应用安装未知来源应用，再回来点更新");
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()));
                activity.startActivity(i);
            } catch (Throwable ignored) {
            }
            return;
        }

        lastForegroundActivity = activity;
        activeUpdateFileName = apk.name;
        activeUpdateProgressText = "正在为 " + apk.name + " 优选国内镜像源…";
        syncAppUpdate();
        host().toast("正在探测最快国内镜像源…");

        final Context appCtx = activity.getApplicationContext();
        new Thread(() -> {
            final String resolvedUrl = MirrorFetch.resolveDownloadUrl(apk.url);
            final String sourceLabel = MirrorFetch.lastSourceLabel();
            activity.runOnUiThread(() -> {
                try {
                    android.app.DownloadManager dm =
                            (android.app.DownloadManager) appCtx.getSystemService(Context.DOWNLOAD_SERVICE);
                    android.app.DownloadManager.Request req = new android.app.DownloadManager.Request(Uri.parse(resolvedUrl));
                    req.setTitle(apk.name);
                    req.setDescription(rel.tag + " · " + sourceLabel);
                    req.setMimeType("application/vnd.android.package-archive");
                    req.setNotificationVisibility(
                            android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, apk.name);
                    long id = dm.enqueue(req);
                    activeUpdateDownloadId = id;
                    activeUpdateFileName = apk.name;
                    activeUpdateProgressText = "正在经「" + sourceLabel + "」下载 " + apk.name + "…（完成后自动安装）";
                    activeUpdateInstalled.set(false);
                    updateDownloadId = id;
                    watchUpdateDownload(appCtx, id);
                    startUpdateProgressPoller(appCtx, id);
                    host().toast("已通过「" + sourceLabel + "」开始下载 " + apk.name);
                    renderMirrorPanel();
                } catch (Throwable ex) {
                    host().toast("无法开始下载：" + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
                    activeUpdateDownloadId = -1L;
                    updateDownloadId = -1L;
                }
                syncAppUpdate();
            });
        }, "apk-mirror-resolve").start();
    }

    /** 渲染「国内镜像源与网络测速」卡片（支持记住最快源、国内优先开关、一键全节点测速、自定义镜像前缀）。 */
    private void renderMirrorPanel() {
        if (mirrorBox == null) return;
        mirrorBox.removeAllViews();

        String pref = MirrorFetch.preferredPrefix();
        LinearLayout head = Ui.row(activity);
        head.addView(Ui.strong(activity, "当前优选下载源", Theme.T_BODY, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        head.addView(Ui.pill(activity, t,
                pref.isEmpty() ? "自动故障转移" : MirrorFetch.describeCandidate(pref + "https://github.com/x", "https://github.com/x"),
                pref.isEmpty() ? Ui.TONE_NEUTRAL : Ui.TONE_OK));
        mirrorBox.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        mirrorBox.addView(Ui.text(activity,
                "App 更新、核心、插件、部件与 QQ 社区包统一走国内多节点镜像池；镜像只作传输层，资产仍做严格 SHA-256 校验。",
                Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

        mirrorBox.addView(Ui.divider(activity, t));
        LinearLayout firstRow = Ui.row(activity);
        LinearLayout firstText = Ui.column(activity);
        firstText.addView(Ui.strong(activity, "始终国内镜像优先（推荐无 VPN）", Theme.T_BODY, t.textPrimary));
        firstText.addView(Ui.text(activity, "开启后直接走国内最快镜像，不再先等官方 2.5 秒超时",
                Theme.T_CAP, t.textSecondary), topMargin(dp(2)));
        firstRow.addView(firstText, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        Switch firstSw = new Switch(activity);
        firstSw.setChecked(MirrorFetch.isMirrorFirst());
        firstSw.setOnCheckedChangeListener((b, on) -> {
            MirrorFetch.setMirrorFirst(on);
            host().toast(on ? "已开启国内镜像优先" : "已切回官方 2.5s 探测 + 自动镜像回退");
        });
        firstRow.addView(firstSw, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        mirrorBox.addView(firstRow, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout btnRow = Ui.row(activity);
        TextView probeBtn = Ui.button(activity, t, probingMirrors ? "测速中…" : "一键测速并选最快源", true);
        probeBtn.setEnabled(!probingMirrors);
        probeBtn.setOnClickListener(v -> runMirrorProbe());
        TextView customBtn = Ui.button(activity, t,
                "自定义镜像 (" + MirrorFetch.customPrefixes().size() + ")", false);
        customBtn.setOnClickListener(v -> openCustomMirrorEditor());
        btnRow.addView(probeBtn, new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1.15f));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, dp(Theme.TOUCH), 1f);
        clp.leftMargin = dp(Theme.S2);
        btnRow.addView(customBtn, clp);
        mirrorBox.addView(btnRow, topMargin(dp(Theme.S3)));

        if (lastProbeResults != null && !lastProbeResults.isEmpty()) {
            mirrorBox.addView(Ui.divider(activity, t));
            for (MirrorFetch.ProbeResult r : lastProbeResults) {
                LinearLayout line = Ui.row(activity);
                line.setPadding(0, dp(4), 0, dp(4));
                String tag = r.custom ? "（自定义）" : "";
                line.addView(Ui.text(activity, r.label + tag, Theme.T_CAP, t.textPrimary),
                        new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                line.addView(Ui.pill(activity, t,
                        r.ok ? (r.latencyMs + " ms") : ("不可达 · " + r.detail),
                        r.ok ? Ui.TONE_OK : Ui.TONE_WARN));
                mirrorBox.addView(line, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
        }
    }

    private void runMirrorProbe() {
        if (probingMirrors) return;
        probingMirrors = true;
        renderMirrorPanel();
        host().toast("正在并行测速全部国内镜像节点…");
        new Thread(() -> {
            final List<MirrorFetch.ProbeResult> res = MirrorFetch.probeAllMirrors();
            activity.runOnUiThread(() -> {
                probingMirrors = false;
                lastProbeResults = res;
                String best = MirrorFetch.preferredPrefix();
                host().toast(best.isEmpty() ? "测速完成" : ("测速完成，已优选 " + best));
                renderMirrorPanel();
            });
        }, "mirror-probe-all").start();
    }

    private void openCustomMirrorEditor() {
        LinearLayout box = Ui.column(activity);
        box.addView(Ui.text(activity,
                "每行填写一个镜像前缀（以 https:// 开头，例如 https://my-proxy.example.com/），自定义源排在最前优先尝试。",
                Theme.T_CAP, t.textSecondary));
        final android.widget.EditText et = new android.widget.EditText(activity);
        StringBuilder sb = new StringBuilder();
        for (String p : MirrorFetch.customPrefixes()) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(p);
        }
        et.setText(sb.toString());
        et.setMinLines(3);
        et.setHint("https://gh-proxy.com/");
        Ui.styleInput(et, activity, t);
        box.addView(et, topMargin(dp(Theme.S2)));

        PromptSheet.custom(activity, t, "自定义国内镜像前缀", box,
                "保存", (d, btn) -> {
                    List<String> saved = MirrorFetch.setCustomPrefixesFromText(
                            et.getText() == null ? "" : et.getText().toString());
                    d.dismiss();
                    host().toast(saved.isEmpty() ? "已清空自定义镜像" : ("已保存 " + saved.size() + " 条自定义镜像"));
                    renderMirrorPanel();
                }, null, null, "取消", (d, btn) -> d.dismiss(), false, false, null, null);
    }

    /** 在 ApplicationContext 上注册下载完成广播（离开当前页也不失效，触发一次即自注销）。 */
    private void watchUpdateDownload(final Context appCtx, final long targetId) {
        if (activeUpdateReceiver != null) {
            try { appCtx.unregisterReceiver(activeUpdateReceiver); } catch (Throwable ignored) {}
            activeUpdateReceiver = null;
        }
        activeUpdateReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(android.app.DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != targetId) return;
                onUpdateDownloadFinished(appCtx, id);
            }
        };
        IntentFilter filter = new IntentFilter(android.app.DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            appCtx.registerReceiver(activeUpdateReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            appCtx.registerReceiver(activeUpdateReceiver, filter);
        }
    }

    /** 1 秒轮询 DownloadManager 进度与完成状态：实时显示 MB/百分比，并在广播被 MIUI 延迟/丢弃时照样秒拉安装器。 */
    private void startUpdateProgressPoller(final Context appCtx, final long targetId) {
        Thread t = new Thread(() -> {
            android.app.DownloadManager dm =
                    (android.app.DownloadManager) appCtx.getSystemService(Context.DOWNLOAD_SERVICE);
            while (activeUpdateDownloadId == targetId) {
                try {
                    android.app.DownloadManager.Query q = new android.app.DownloadManager.Query().setFilterById(targetId);
                    android.database.Cursor c = dm.query(q);
                    if (c != null) {
                        try {
                            if (c.moveToFirst()) {
                                int st = c.getInt(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS));
                                long done = c.getLong(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                                long total = c.getLong(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                                if (st == android.app.DownloadManager.STATUS_SUCCESSFUL) {
                                    onUpdateDownloadFinished(appCtx, targetId);
                                    return;
                                }
                                if (st == android.app.DownloadManager.STATUS_FAILED) {
                                    int reason = c.getInt(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_REASON));
                                    cleanupUpdateWatch(appCtx);
                                    activeUpdateProgressText = "下载失败（错误码 " + reason + "），可重试";
                                    notifyUpdateUi();
                                    return;
                                }
                                activeUpdateProgressText = "正在下载 " + activeUpdateFileName + "："
                                        + Ui.formatProgress(done, total) + "（完成后自动安装）";
                                notifyUpdateUi();
                            } else {
                                cleanupUpdateWatch(appCtx);
                                return;
                            }
                        } finally {
                            c.close();
                        }
                    }
                    Thread.sleep(1000L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                } catch (Throwable ignored) {
                    return;
                }
            }
        }, "apk-dl-poll");
        t.setDaemon(true);
        t.start();
    }

    private void onUpdateDownloadFinished(final Context appCtx, final long id) {
        if (!activeUpdateInstalled.compareAndSet(false, true)) return;
        cleanupUpdateWatch(appCtx);
        activeUpdateProgressText = "下载完成，正在拉起系统安装器…";
        notifyUpdateUi();
        android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
        main.post(() -> installDownloaded(appCtx, id));
    }

    private static void cleanupUpdateWatch(Context appCtx) {
        activeUpdateDownloadId = -1L;
        android.content.BroadcastReceiver r = activeUpdateReceiver;
        activeUpdateReceiver = null;
        if (r != null) {
            try { appCtx.unregisterReceiver(r); } catch (Throwable ignored) {}
        }
    }

    private void notifyUpdateUi() {
        try {
            activity.runOnUiThread(() -> {
                updateDownloadId = activeUpdateDownloadId;
                syncAppUpdate();
            });
        } catch (Throwable ignored) {
        }
    }

    private void installDownloaded(Context appCtx, long id) {
        try {
            android.app.DownloadManager dm =
                    (android.app.DownloadManager) appCtx.getSystemService(Context.DOWNLOAD_SERVICE);
            Uri uri = dm.getUriForDownloadedFile(id);
            if (uri == null) {
                host().toast("下载未完成或文件已被移除");
                return;
            }
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            android.app.Activity fg = lastForegroundActivity;
            if (fg != null && !fg.isFinishing() && !fg.isDestroyed()) {
                fg.startActivity(i);
            } else {
                appCtx.startActivity(i);
            }
        } catch (Throwable ex) {
            host().toast("无法自动拉起安装器：" + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
        }
    }

    private void showOtherAssetsSheet(ReleaseItem item, List<AssetItem> others) {
        String[] labels = new String[others.size() + (item.htmlUrl.length() > 0 ? 1 : 0)];
        for (int i = 0; i < others.size(); i++) {
            AssetItem a = others.get(i);
            labels[i] = a.name + (a.size >= 0L ? " · " + Ui.formatBytes(a.size) : "");
        }
        if (item.htmlUrl.length() > 0) labels[others.size()] = "在浏览器打开完整发布页";
        PromptSheet.choose(activity, t, item.tag + " · 其他发行资产", labels, idx -> {
            if (idx < others.size()) copyLink(others.get(idx).url);
            else openUrl(item.htmlUrl);
        }, null, null, "返回");
    }

    // ------------------------------------------------------------------ B. 内置核心版本

    private void renderInstalledCores() {
        if (installedCoresBox == null) return;
        installedCoresBox.removeAllViews();
        List<CoreInventory.Instance> managed = managedCores();
        installedCoresBox.addView(Ui.strong(activity, "已安装的核心（" + managed.size() + " 份）",
                Theme.T_BODY, t.textPrimary));
        if (managed.isEmpty()) {
            installedCoresBox.addView(Ui.text(activity, "还没有已安装的内置核心，可在下方直接挑选版本创建。",
                    Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
            return;
        }
        for (int i = 0; i < managed.size(); i++) {
            if (i > 0) installedCoresBox.addView(Ui.divider(activity, t));
            final CoreInventory.Instance c = managed.get(i);
            boolean free = c.ownerId == null || c.ownerId.isEmpty();

            LinearLayout row = Ui.row(activity);
            row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));
            row.setMinimumHeight(dp(Theme.TOUCH));

            LinearLayout left = Ui.column(activity);
            LinearLayout titleLine = Ui.row(activity);
            titleLine.addView(Ui.strong(activity, Ui.coreDisplayTitle(c), Theme.T_BODY, t.textPrimary));
            LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
            plp.leftMargin = dp(Theme.S1);
            titleLine.addView(Ui.pill(activity, t, free ? "空闲" : "使用中", free ? Ui.TONE_NEUTRAL : Ui.TONE_OK), plp);
            left.addView(titleLine, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            left.addView(Ui.text(activity, Ui.coreMetaLine(c), Theme.T_CAP, t.textSecondary), topMargin(dp(4)));

            row.addView(left, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
            row.setClickable(true);
            row.setFocusable(true);
            Ui.press(row, 0.985f);
            row.setOnClickListener(v -> shell.corePage("instance", c.id));
            installedCoresBox.addView(row, topMargin(dp(Theme.S1)));
        }
    }

    private void loadCoreVersions() {
        if (loadingCore) return;
        loadingCore = true;
        coreVersionsBox.removeAllViews();
        coreVersionsBox.addView(Ui.text(activity, "正在读取可用核心版本…", Theme.T_CAP, t.textSecondary));

        new Thread(() -> {
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
            activity.runOnUiThread(() -> {
                loadingCore = false;
                renderCoreVersions(finalVersions, finalCurrent, finalErr);
            });
        }, "core-versions-fetch").start();
    }

    private void renderCoreVersions(List<String> versions, String current, String err) {
        coreVersionsBox.removeAllViews();
        if (err != null || versions == null) {
            coreVersionsBox.addView(Ui.text(activity, "可用版本读取失败：" + (err == null ? "未知错误" : err),
                    Theme.T_BODY, t.textPrimary));
            TextView retry = Ui.button(activity, t, "重试读取", false);
            retry.setOnClickListener(v -> loadCoreVersions());
            coreVersionsBox.addView(retry, topMargin(dp(Theme.S2)));
            return;
        }
        if (versions.isEmpty()) {
            coreVersionsBox.addView(Ui.text(activity, "暂无可下载核心版本", Theme.T_CAP, t.textSecondary));
            return;
        }
        coreVersionsBox.addView(Ui.strong(activity, "可下载的核心版本（点击直接创建）", Theme.T_BODY, t.textPrimary));
        int showCount = Math.min(versions.size(), 4);
        for (int i = 0; i < showCount; i++) {
            final String v = versions.get(i);
            boolean isDefault = v.equals(current);

            LinearLayout row = Ui.row(activity);
            row.setPadding(dp(Theme.S2 + 2), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
            row.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
            row.addView(Ui.strong(activity, "内置核心 " + v, Theme.T_BODY, t.textPrimary),
                    new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            if (isDefault) {
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
                blp.rightMargin = dp(Theme.S1);
                row.addView(Ui.pill(activity, t, "推荐", Ui.TONE_OK), blp);
            }
            row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
            row.setClickable(true);
            row.setFocusable(true);
            Ui.press(row, 0.985f);
            // 就地选择份数并开始创建，彻底不再跳同名裸页（问答报告 Q6）
            row.setOnClickListener(view -> promptCreateCore(v));
            coreVersionsBox.addView(row, topMargin(dp(Theme.S2)));
        }
    }

    private void promptCreateCore(final String version) {
        String[] counts = { "创建 1 份", "创建 2 份", "创建 3 份", "创建 4 份", "创建 5 份" };
        PromptSheet.choose(activity, t, "下载内置核心 " + version, counts, idx -> {
            final int count = idx + 1;
            new Thread(() -> {
                try {
                    CoreInstaller ci = CoreInstaller.open(activity);
                    long size = ci.downloadBytes(version, java.util.Collections.emptyList());
                    activity.runOnUiThread(() -> PromptSheet.confirm(
                            activity, t,
                            "确认下载并创建 " + count + " 份核心？",
                            "核心版本：" + version + "\n预计下载量：" + Ui.formatBytes(size) + "（已缓存资产自动免流量跳过）",
                            "开始下载", () -> {
                                if (RemoteBridge.isRemote()) {
                                    new Thread(() -> {
                                        try {
                                            RemoteBridge.mgr().callActiveRpc("cores.download",
                                                    new org.json.JSONObject().put("version", version).put("count", count), 15000);
                                            activity.runOnUiThread(() -> host().toast("已通知远端开始下载 " + count + " 份核心（" + version + "）"));
                                        } catch (Throwable ex) {
                                            activity.runOnUiThread(() -> host().toast("远端核心下载启动失败：" + ex.getMessage()));
                                        }
                                    }, "remote-core-dl").start();
                                } else {
                                    CoreManagerScreen.createCores(ci, version, count);
                                    refresh();
                                }
                            },
                            null, null, "取消"));
                } catch (Exception ex) {
                    activity.runOnUiThread(() -> host().toast("无法计算下载量：" + CoreManagerScreen.safe(ex)));
                }
            }, "version-core-quote").start();
        }, null, null);
    }

    // ------------------------------------------------------------------ C. 平台插件版本

    private void loadPluginVersions() {
        if (pluginListBox == null) return;
        pluginListBox.removeAllViews();
        final List<CoreInventory.Instance> managed = managedCores();
        if (managed.isEmpty()) {
            pluginListBox.addView(Ui.text(activity, "尚未安装内置核心，装好核心并创建机器人后会在这里展示各平台插件。",
                    Theme.T_CAP, t.textSecondary));
            return;
        }
        pluginListBox.addView(Ui.text(activity, "正在读取已装插件…", Theme.T_CAP, t.textSecondary));

        new Thread(() -> {
            final List<CorePluginGroup> groups = new ArrayList<>();
            File filesDir = activity.getFilesDir();
            for (CoreInventory.Instance c : managed) {
                CorePluginGroup g = new CorePluginGroup();
                g.core = c;
                g.title = Ui.coreDisplayTitle(c);
                g.meta = Ui.coreMetaLine(c);
                List<String> ps = CoreManagerScreen.platforms(c);
                File active = null;
                try {
                    active = CoreInstaller.active(filesDir, c.id);
                } catch (Throwable ignored) {
                    active = null;
                }
                for (String p : ps) {
                    PluginRow pr = new PluginRow();
                    pr.platform = p;
                    pr.state = readPluginVersion(active, p);
                    pr.installed = !"待安装".equals(pr.state);
                    g.rows.add(pr);
                }
                groups.add(g);
            }
            activity.runOnUiThread(() -> renderPluginGroups(groups));
        }, "plugin-versions-read").start();
    }

    private void renderPluginGroups(List<CorePluginGroup> groups) {
        pluginListBox.removeAllViews();
        for (int i = 0; i < groups.size(); i++) {
            if (i > 0) pluginListBox.addView(Ui.divider(activity, t));
            final CorePluginGroup g = groups.get(i);

            LinearLayout head = Ui.row(activity);
            head.addView(Ui.strong(activity, g.title, Theme.T_BODY, t.textPrimary),
                    new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            head.addView(Ui.pill(activity, t, g.core.version, Ui.TONE_NEUTRAL));
            pluginListBox.addView(head, topMargin(i == 0 ? 0 : dp(Theme.S1)));
            pluginListBox.addView(Ui.text(activity, g.meta, Theme.T_CAP, t.textTertiary), topMargin(dp(2)));

            if (g.rows.isEmpty()) {
                pluginListBox.addView(Ui.text(activity, "尚未绑定平台（分配给机器人并勾选平台后会显示插件）",
                        Theme.T_CAP, t.textSecondary), topMargin(dp(Theme.S1)));
            } else {
                for (final PluginRow pr : g.rows) {
                    LinearLayout prow = Ui.row(activity);
                    prow.setPadding(dp(Theme.S2), dp(Theme.S1 + 2), dp(Theme.S2), dp(Theme.S1 + 2));
                    prow.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
                    prow.addView(Ui.strong(activity, BotRegistry.PLATFORM_LABEL(pr.platform), Theme.T_BODY, t.textPrimary),
                            new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                    LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT);
                    slp.rightMargin = dp(Theme.S1);
                    prow.addView(Ui.pill(activity, t, pr.installed ? ("已装 " + pr.state) : "待安装",
                            pr.installed ? Ui.TONE_OK : Ui.TONE_WARN), slp);
                    prow.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
                    prow.setClickable(true);
                    prow.setFocusable(true);
                    Ui.press(prow, 0.985f);
                    // 就地弹出该平台版本切换/安装面板（问答报告 Q6）
                    prow.setOnClickListener(v -> promptPluginAction(g.core, pr.platform, true));
                    pluginListBox.addView(prow, topMargin(dp(Theme.S1 + 2)));
                }
            }
        }
    }

    private void promptPluginAction(final CoreInventory.Instance c, final String platform, final boolean compatible) {
        host().toast("正在读取 " + BotRegistry.PLATFORM_LABEL(platform) + " 插件版本…");
        new Thread(() -> {
            try {
                CoreInstaller ci = CoreInstaller.open(activity);
                Map<String, String> versions = ci.pluginVersions(platform, compatible);
                if (versions.isEmpty()) {
                    activity.runOnUiThread(() -> host().toast("暂无可用插件版本"));
                    return;
                }
                List<String> keys = new ArrayList<>(versions.keySet());
                String[] labels = new String[keys.size()];
                for (int i = 0; i < keys.size(); i++) labels[i] = versions.get(keys.get(i));
                activity.runOnUiThread(() -> PromptSheet.choose(
                        activity, t,
                        BotRegistry.PLATFORM_LABEL(platform) + (compatible ? " · 兼容插件版本" : " · 全部插件版本"),
                        labels,
                        idx -> PromptSheet.confirm(
                                activity, t,
                                "切换 " + BotRegistry.PLATFORM_LABEL(platform) + " 插件版本？",
                                labels[idx] + "\n将在下次正常启动核心时生效。",
                                "确认切换", () -> new Thread(() -> {
                                    try {
                                        if (RemoteBridge.isRemote()) {
                                            RemoteBridge.mgr().callActiveRpc("cores.pluginStage",
                                                    new org.json.JSONObject().put("coreId", c.id).put("platform", platform).put("version", keys.get(idx)), 60000);
                                        } else {
                                            ci.stagePlugin(c.id, platform, keys.get(idx), (item, done, total) ->
                                                    activity.runOnUiThread(() -> {
                                                        if (coreProgressText != null) {
                                                            coreProgressText.setVisibility(View.VISIBLE);
                                                            coreProgressText.setText("下载插件：" + Ui.formatProgress(done, total));
                                                        }
                                                    }));
                                        }
                                        activity.runOnUiThread(() -> {
                                            host().toast("已安排插件更新（下次启动生效）");
                                            loadPluginVersions();
                                        });
                                    } catch (Exception ex) {
                                        activity.runOnUiThread(() -> host().toast("插件切换未完成：" + CoreManagerScreen.safe(ex)));
                                    }
                                }, "version-stage-plugin").start(),
                                null, null, "取消"),
                        compatible ? "查看全部版本" : null,
                        compatible ? () -> promptPluginAction(c, platform, false) : null));
            } catch (Exception ex) {
                activity.runOnUiThread(() -> host().toast("读取插件版本失败：" + CoreManagerScreen.safe(ex)));
            }
        }, "version-plugin-list").start();
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

    private void copyLink(String url) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("下载地址", url));
            host().toast("链接已复制");
        } catch (Throwable e) {
            android.util.Log.w("WhaleUI", "复制下载链接失败", e);
            host().toast("复制失败");
        }
    }

    private void openUrl(String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Throwable e) {
            host().toast("无法打开浏览器");
        }
    }

    private List<CoreInventory.Instance> managedCores() {
        List<CoreInventory.Instance> out = new ArrayList<>();
        List<CoreInventory.Instance> all = BotRegistry.cores();
        if (all == null) return out;
        for (CoreInventory.Instance c : all) {
            if (CoreManagerScreen.managed(c)) out.add(c);
        }
        return out;
    }

    private static String combineErrors(String first, String second) {
        boolean hasFirst = first != null && first.length() > 0;
        boolean hasSecond = second != null && second.length() > 0;
        if (hasFirst && hasSecond) return first + "；" + second;
        if (hasFirst) return first;
        if (hasSecond) return second;
        return "未知错误";
    }

    private static byte[] readStreamBytes(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
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
        for (byte b : digest) {
            int v = b & 0xff;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    private static String normalizeVersion(String v) {
        if (v == null) return "";
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        return s;
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
        final List<AssetItem> assets = new ArrayList<>();
    }

    private static final class AssetItem {
        String name = "";
        String url = "";
        long size = -1L;
    }

    private static final class PluginRow {
        String platform = "";
        String state = "";
        boolean installed;
    }

    private static final class CorePluginGroup {
        CoreInventory.Instance core;
        String title = "";
        String meta = "";
        final List<PluginRow> rows = new ArrayList<>();
    }
}
