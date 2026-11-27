package com.whaleonebot.ui;

import android.content.Context;

import com.whaleonebot.ContainerService;
import com.whaleonebot.remote.RemoteControlManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * [layer: shell-android] 统一本地/远程调用桥接层（方案 A：0ms 本地 SWR 缓存瞬开 + 零主线程阻塞 + 自适应后台刷新）。
 *
 * <p>使全部 36 个界面（容器、机器人绑定、B 站登录/配置/流水、知识库、核心/插件/备份/环境/版本）
 * 无需重复写本地/远程两套分支：本机模式直调本地 API，远程模式读取 0ms SWR 缓存并在后台异步刷新，
 * 彻底消除跨网点击任何页面的主线程卡顿。
 */
final class RemoteBridge {

    private static final class CacheEntry {
        final JSONObject value;
        final long fetchedAt;

        CacheEntry(JSONObject value, long fetchedAt) {
            this.value = value;
            this.fetchedAt = fetchedAt;
        }
    }

    private static final Map<String, CacheEntry> SWR_CACHE = new ConcurrentHashMap<String, CacheEntry>();
    private static final Set<String> IN_FLIGHT = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private RemoteBridge() {
    }

    static void clearCache() {
        SWR_CACHE.clear();
        IN_FLIGHT.clear();
    }

    private static void invalidateByMethod(String methodPrefix) {
        for (String key : SWR_CACHE.keySet()) {
            if (key.contains("|" + methodPrefix)) SWR_CACHE.remove(key);
        }
    }

    static boolean isRemote() {
        RemoteControlManager rm = RemoteControlManager.peek();
        return rm != null && rm.isRemote();
    }

    static RemoteControlManager mgr() {
        return RemoteControlManager.peek();
    }

    /**
     * 0ms 非阻塞 SWR（Stale-While-Revalidate）读取：
     * 永远不阻塞 UI 主线程！命中缓存立刻返回旧值，过期或首次未命中时在后台单飞刷新（去重防风暴），
     * 按当前传输通道（直连 vs 跨网加密中继）自适应调整缓存保鲜周期。
     */
    static JSONObject rpcSwr(final String method, final JSONObject params, final long fastTtlMs, final int timeoutMs) {
        final RemoteControlManager rm = mgr();
        if (rm == null || !rm.isRemote()) return null;
        final String peerId = rm.activePeerId();
        if (peerId == null) return null;
        final String pStr = params == null ? "{}" : params.toString();
        final String key = peerId + "|" + method + "|" + pStr;
        final CacheEntry cached = SWR_CACHE.get(key);
        final long now = System.currentTimeMillis();
        final long ttl = rm.isCurrentChannelFast() ? fastTtlMs : Math.max(fastTtlMs * 3L, 8000L);

        if (cached == null || now - cached.fetchedAt >= ttl) {
            if (IN_FLIGHT.add(key)) {
                Thread t = new Thread(() -> {
                    try {
                        JSONObject fresh = rm.callActiveRpc(method, params, timeoutMs);
                        if (fresh != null && peerId.equals(rm.activePeerId())) {
                            SWR_CACHE.put(key, new CacheEntry(fresh, System.currentTimeMillis()));
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        IN_FLIGHT.remove(key);
                    }
                }, "rb-swr-" + method);
                t.setDaemon(true);
                t.start();
            }
        }
        return cached == null ? null : cached.value;
    }

    /** 同步执行一次轻量 RPC（仅用于明确的写动作确认，不在常规页面刷新里调用）。 */
    static JSONObject rpcSync(final String method, final JSONObject params, final int timeoutMs) {
        final RemoteControlManager rm = mgr();
        if (rm == null || !rm.isRemote()) return null;
        final JSONObject[] out = new JSONObject[1];
        final CountDownLatch latch = new CountDownLatch(1);
        Thread t = new Thread(() -> {
            try {
                out[0] = rm.callActiveRpc(method, params, timeoutMs);
            } catch (Throwable ignored) {
                out[0] = null;
            } finally {
                latch.countDown();
            }
        }, "rb-sync-" + method);
        t.setDaemon(true);
        t.start();
        try {
            latch.await(timeoutMs + 800L, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return out[0];
    }

    static void rpcAsync(final String method, final JSONObject params, final int timeoutMs) {
        final RemoteControlManager rm = mgr();
        if (rm == null || !rm.isRemote()) return;
        Thread t = new Thread(() -> {
            try {
                rm.callActiveRpc(method, params, timeoutMs);
                rm.triggerSnapshotRefresh();
            } catch (Throwable ignored) {
            }
        }, "rb-async-" + method);
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------------ 机器人启停与绑定状态

    static JSONObject bindingStatus(Context ctx, String botId) {
        if (!isRemote()) return ContainerService.bindingStatus(ctx, botId);
        try {
            JSONObject r = rpcSwr("bots.bindingStatus", new JSONObject().put("botId", botId), 2500L, 5000);
            if (r != null) return r;
            // 首次冷启动缓存未到位时，直接借用活跃快照的 botRunning 兜底，避免闪烁成“已停止”
            RemoteControlManager rm = mgr();
            if (rm != null && rm.activeSnapshot().botRunning) {
                return new JSONObject().put("state", "running");
            }
        } catch (Throwable ignored) {
        }
        return new JSONObject();
    }

    static void startBot(Context ctx) {
        if (!isRemote()) { ContainerService.startBot(ctx); return; }
        invalidateByMethod("bots.");
        rpcAsync("bots.startBot", null, 8000);
    }

    static void startBoundBot(Context ctx, String botId) {
        if (!isRemote()) { ContainerService.startBoundBot(ctx, botId); return; }
        invalidateByMethod("bots.");
        try { rpcAsync("bots.start", new JSONObject().put("botId", botId), 8000); } catch (Throwable ignored) {}
    }

    static void stopBoundBot(String botId) {
        if (!isRemote()) { ContainerService.stopBoundBot(botId); return; }
        invalidateByMethod("bots.");
        try { rpcAsync("bots.stop", new JSONObject().put("botId", botId), 8000); } catch (Throwable ignored) {}
    }

    static void startInstalledPlatform(Context ctx, String botId, String platform) throws Exception {
        if (!isRemote()) { ContainerService.startInstalledPlatform(ctx, botId, platform); return; }
        RemoteControlManager rm = mgr();
        if (rm == null) throw new IllegalStateException("远程会话不可用");
        invalidateByMethod("bots.");
        rm.callActiveRpc("bots.startPlatform", new JSONObject().put("botId", botId).put("platform", platform), 12000);
        rm.triggerSnapshotRefresh();
    }

    static void stopInstalledPlatform(Context ctx, String botId, String platform) throws Exception {
        if (!isRemote()) { ContainerService.stopInstalledPlatform(ctx, botId, platform); return; }
        RemoteControlManager rm = mgr();
        if (rm == null) throw new IllegalStateException("远程会话不可用");
        invalidateByMethod("bots.");
        rm.callActiveRpc("bots.stopPlatform", new JSONObject().put("botId", botId).put("platform", platform), 12000);
        rm.triggerSnapshotRefresh();
    }

    static void setBindingToken(Context ctx, String botId, String bindingId, String token) {
        if (!isRemote()) { ContainerService.setBindingToken(ctx, botId, bindingId, token); return; }
        invalidateByMethod("bots.");
        try {
            rpcAsync("bots.setBindingToken",
                    new JSONObject().put("botId", botId).put("bindingId", bindingId).put("token", token), 8000);
        } catch (Throwable ignored) {}
    }

    // ------------------------------------------------------------------ B 站远程协议与配置

    static JSONObject biliStatus(String botId, String bindingId) {
        if (!isRemote()) return ContainerService.biliProtocolStatus(botId, bindingId);
        try {
            JSONObject r = rpcSwr("bili.status", new JSONObject().put("botId", botId).put("bindingId", bindingId), 2500L, 5000);
            if (r != null) return r;
        } catch (Throwable ignored) {}
        return new JSONObject();
    }

    static String biliAuthLink(String botId, String bindingId) {
        if (!isRemote()) return ContainerService.biliAuthorizationLink(botId, bindingId);
        return biliStatus(botId, bindingId).optString("authLink", "");
    }

    static boolean hasBiliSession(Context ctx, String botId, String bindingId) {
        if (!isRemote()) return ContainerService.hasBiliSession(ctx, botId, bindingId);
        return biliStatus(botId, bindingId).optBoolean("hasSaved", false);
    }

    static Runnable enrollBili(Context ctx, String botId, String slot, boolean fresh) {
        if (!isRemote()) return ContainerService.enrollBiliAccount(ctx, botId, slot, fresh);
        invalidateByMethod("bili.");
        try {
            JSONObject r = rpcSync("bili.enroll",
                    new JSONObject().put("botId", botId).put("slot", slot).put("fresh", fresh), 8000);
            if (r == null || !r.optBoolean("ok", false)) return null;
            return () -> {
                invalidateByMethod("bili.");
                try {
                    rpcAsync("bili.enrollCancel", new JSONObject().put("botId", botId).put("slot", slot), 5000);
                } catch (Throwable ignored) {}
            };
        } catch (Throwable t) {
            return null;
        }
    }

    static void startBili(Context ctx, String botId, String bindingId, String peer) {
        if (!isRemote()) { ContainerService.startBiliProtocol(ctx, botId, bindingId, peer); return; }
        invalidateByMethod("bili.");
        try {
            rpcAsync("bili.start", new JSONObject().put("botId", botId).put("bindingId", bindingId).put("peer", peer), 8000);
        } catch (Throwable ignored) {}
    }

    static void stopBili(String botId, String bindingId) {
        if (!isRemote()) { ContainerService.stopBiliProtocol(botId, bindingId); return; }
        invalidateByMethod("bili.");
        try {
            rpcAsync("bili.stop", new JSONObject().put("botId", botId).put("bindingId", bindingId), 8000);
        } catch (Throwable ignored) {}
    }

    static void reauthBili(Context ctx, String botId, String bindingId, String peer) {
        if (!isRemote()) { ContainerService.reauthorizeBiliProtocol(ctx, botId, bindingId, peer); return; }
        invalidateByMethod("bili.");
        try {
            rpcAsync("bili.reauthorize", new JSONObject().put("botId", botId).put("bindingId", bindingId).put("peer", peer), 8000);
        } catch (Throwable ignored) {}
    }

    static boolean forgetBili(Context ctx, String botId, String bindingId) {
        if (!isRemote()) return ContainerService.forgetBiliSession(ctx, botId, bindingId);
        invalidateByMethod("bili.");
        try {
            JSONObject r = rpcSync("bili.forget", new JSONObject().put("botId", botId).put("bindingId", bindingId), 6000);
            return r != null && r.optBoolean("ok", false);
        } catch (Throwable t) {
            return false;
        }
    }

    static JSONObject getBiliSettings(Context ctx, String botId, String bindingId) {
        if (!isRemote()) return BiliSettings.get(ctx, botId, bindingId);
        try {
            JSONObject r = rpcSwr("bili.settingsGet", new JSONObject().put("botId", botId).put("bindingId", bindingId), 5000L, 6000);
            if (r != null) return r;
        } catch (Throwable ignored) {}
        return BiliSettings.defaults();
    }

    static void putBiliSettings(Context ctx, String botId, String bindingId, JSONObject val) {
        if (!isRemote()) { BiliSettings.put(ctx, botId, bindingId, val); return; }
        invalidateByMethod("bili.settingsGet");
        try {
            rpcAsync("bili.settingsSet", new JSONObject().put("botId", botId).put("bindingId", bindingId)
                    .put("json", val.toString()), 8000);
        } catch (Throwable ignored) {}
    }

    static List<JSONObject> biliActionLogPage(Context ctx, String botId, int page, int size) {
        if (!isRemote()) return BiliActionLog.page(ctx, botId, page, size);
        List<JSONObject> out = new ArrayList<JSONObject>();
        try {
            JSONObject r = rpcSwr("bili.actionLog",
                    new JSONObject().put("botId", botId).put("page", page).put("size", size), 4000L, 6000);
            if (r != null) {
                JSONArray arr = r.optJSONArray("rows");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject item = arr.optJSONObject(i);
                        if (item != null) out.add(item);
                    }
                }
            }
        } catch (Throwable ignored) {}
        return out;
    }

    static String qqClientVersion(Context ctx) {
        if (!isRemote()) return QqClientInstaller.clientVersion(ctx.getFilesDir());
        RemoteControlManager rm = mgr();
        return rm == null ? null : rm.activeSnapshot().qqClientVersion;
    }

    // ------------------------------------------------------------------ 核心/插件/备份远端辅助（供 CoreManagerScreen 解耦）

    interface ProgressText { void onStatus(String text); }

    static void stageRemotePlugin(String coreId, String platform, String version) throws Exception {
        mgr().callActiveRpc("cores.pluginStage",
                new JSONObject().put("coreId", coreId).put("platform", platform).put("version", version), 60000);
    }

    static void downloadRemoteCores(String version, int count) throws Exception {
        mgr().callActiveRpc("cores.download",
                new JSONObject().put("version", version).put("count", count), 15000);
    }

    static void releaseRemoteCore(String coreId, String botId) throws Exception {
        mgr().callActiveRpc("backup.releaseCore",
                new JSONObject().put("coreId", coreId).put("botId", botId), 30000);
        mgr().triggerSnapshotRefresh();
    }

    static void remoteBackupTransfer(android.app.Activity activity, String type, String coreId, String botId,
                                     android.net.Uri uri, ProgressText progress) throws Exception {
        if ("restore".equals(type)) {
            long total = -1L;
            try (android.content.res.AssetFileDescriptor afd = activity.getContentResolver().openAssetFileDescriptor(uri, "r")) {
                if (afd != null) total = afd.getLength();
            } catch (Throwable ignored) {}
            try (java.io.InputStream in = activity.getContentResolver().openInputStream(uri)) {
                if (in == null) throw new java.io.IOException("无法读取选中的备份文件");
                String meta = new JSONObject().put("kind", "backup_restore").put("coreId", coreId).toString();
                mgr().uploadToActive(meta, in, total, (sent, tot) -> {
                    if (progress != null) progress.onStatus("正在经 P2P 推送备份到远端：" + Ui.formatProgress(sent, tot));
                });
            }
            mgr().triggerSnapshotRefresh();
            return;
        }
        boolean rel = "backupRelease".equals(type);
        String meta = new JSONObject().put("kind", "backup_export").put("coreId", coreId)
                .put("botId", botId).put("release", rel).toString();
        try (java.io.OutputStream out = activity.getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("无法写入控制机目标文件");
            mgr().downloadFromActive(meta, out, -1L, 120000, (got, tot) -> {
                if (progress != null) progress.onStatus("正在经 P2P 拉取远端备份：" + Ui.formatBytes(got));
            });
        }
        mgr().triggerSnapshotRefresh();
    }
}
