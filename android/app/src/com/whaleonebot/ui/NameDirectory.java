package com.whaleonebot.ui;

import android.app.Activity;
import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 全 App 统一群名与 QQ 昵称目录：
 * <ul>
 *   <li>本地持久化合并「手动群备注 > 协议端 Web CGI 群名缓存 > 运行端会话/人物昵称」；</li>
 *   <li>所有出现群号/QQ 号的页面经 {@link DashKit#chatLabel(String)} 自动同步展示「名称（号码）」；</li>
 *   <li>未拉取到群名的群始终清晰展示「群 &lt;群号&gt;」，绝不丢失或隐藏群号。</li>
 * </ul>
 */
final class NameDirectory {

    private static final String GROUP_CACHE_FILE = "group-names-cache.json";
    private static final String GROUP_REMARK_FILE = "group-remarks.json";
    private static final String USER_CACHE_FILE = "user-names-cache.json";

    private static final ConcurrentHashMap<String, String> GROUP_NAMES = new ConcurrentHashMap<String, String>();
    private static final ConcurrentHashMap<String, String> GROUP_REMARKS = new ConcurrentHashMap<String, String>();
    private static final ConcurrentHashMap<String, String> USER_NAMES = new ConcurrentHashMap<String, String>();

    private static volatile boolean initialized = false;
    private static volatile long lastSyncAt = 0L;

    private NameDirectory() {}

    static void init(Context ctx) {
        if (ctx == null) return;
        File dir = ctx.getFilesDir();
        loadMapInto(new File(dir, GROUP_CACHE_FILE), GROUP_NAMES);
        loadMapInto(new File(dir, GROUP_REMARK_FILE), GROUP_REMARKS);
        loadMapInto(new File(dir, USER_CACHE_FILE), USER_NAMES);
        initialized = true;
    }

    static String groupName(String groupId) {
        if (groupId == null) return "";
        String id = groupId.trim();
        if (id.isEmpty()) return "";
        String r = GROUP_REMARKS.get(id);
        if (r != null && !r.isEmpty()) return r;
        String n = GROUP_NAMES.get(id);
        return n == null ? "" : n;
    }

    static String userName(String uin) {
        if (uin == null) return "";
        String id = uin.trim();
        if (id.isEmpty()) return "";
        String n = USER_NAMES.get(id);
        return n == null ? "" : n;
    }

    static String formatGroup(String groupId) {
        String id = groupId == null ? "" : groupId.trim();
        if (id.isEmpty()) return "—";
        String n = groupName(id);
        return n.isEmpty() ? ("群 " + id) : (n + "（" + id + "）");
    }

    static String formatUser(String uin) {
        String id = uin == null ? "" : uin.trim();
        if (id.isEmpty()) return "—";
        String n = userName(id);
        return n.isEmpty() ? id : (n + "（" + id + "）");
    }

    static String formatChat(String key) {
        if (key == null) return "—";
        String k = key.trim();
        if (k.isEmpty()) return "—";
        int i = k.indexOf(':');
        if (i < 0) return k;
        String kind = k.substring(0, i);
        String id = k.substring(i + 1).trim();
        if ("group".equals(kind)) {
            return formatGroup(id);
        }
        if ("private".equals(kind)) {
            String n = userName(id);
            return n.isEmpty() ? ("私聊 " + id) : ("私聊 " + n + "（" + id + "）");
        }
        return k;
    }

    static void putGroupRemark(Context ctx, String groupId, String remark) {
        if (groupId == null || groupId.trim().isEmpty()) return;
        String id = groupId.trim();
        String clean = remark == null ? "" : remark.trim();
        if (clean.isEmpty()) GROUP_REMARKS.remove(id);
        else GROUP_REMARKS.put(id, clean);
        if (ctx != null) saveMap(new File(ctx.getFilesDir(), GROUP_REMARK_FILE), GROUP_REMARKS);
    }

    static void putGroupNames(Context ctx, Map<String, String> fresh) {
        if (fresh == null || fresh.isEmpty()) return;
        boolean changed = false;
        for (Map.Entry<String, String> e : fresh.entrySet()) {
            String k = e.getKey() == null ? "" : e.getKey().trim();
            String v = e.getValue() == null ? "" : e.getValue().trim();
            if (k.isEmpty() || v.isEmpty() || v.equals(k)) continue;
            if (!v.equals(GROUP_NAMES.get(k))) {
                GROUP_NAMES.put(k, v);
                changed = true;
            }
        }
        if (changed && ctx != null) saveMap(new File(ctx.getFilesDir(), GROUP_CACHE_FILE), GROUP_NAMES);
    }

    static void putUserNames(Context ctx, Map<String, String> fresh) {
        if (fresh == null || fresh.isEmpty()) return;
        boolean changed = false;
        for (Map.Entry<String, String> e : fresh.entrySet()) {
            String k = e.getKey() == null ? "" : e.getKey().trim();
            String v = e.getValue() == null ? "" : e.getValue().trim();
            if (k.isEmpty() || v.isEmpty() || v.equals(k)) continue;
            if (!v.equals(USER_NAMES.get(k))) {
                USER_NAMES.put(k, v);
                changed = true;
            }
        }
        if (changed && ctx != null) saveMap(new File(ctx.getFilesDir(), USER_CACHE_FILE), USER_NAMES);
    }

    /** 后台静默同步全 App 群名与昵称（60 秒节流，多源汇聚，失败静默跳过）。 */
    static void syncAsync(final Activity activity, final boolean force, final Runnable onDone) {
        if (activity == null) return;
        if (!initialized) init(activity);
        long now = System.currentTimeMillis();
        if (!force && now - lastSyncAt < 60_000L) return;
        lastSyncAt = now;
        final Context appCtx = activity.getApplicationContext();
        Thread th = new Thread(new Runnable() {
            @Override
            public void run() {
                Map<String, String> gFresh = new LinkedHashMap<String, String>();
                Map<String, String> uFresh = new LinkedHashMap<String, String>();
                try {
                    // 1) 运行端 /api/chats（带 chatName）
                    Object chatsTree = DashApi.json(activity, "api/chats", 8000);
                    List<Map<String, Object>> chats = DashApi.objects(BotConfigJson.get(chatsTree, "chats"));
                    for (Map<String, Object> c : chats) {
                        String key = DashApi.str(c, "key");
                        String name = DashApi.str(c, "chatName").trim();
                        if (key.startsWith("group:") && !name.isEmpty()) {
                            gFresh.put(key.substring(6), name);
                        } else if (key.startsWith("private:") && !name.isEmpty()) {
                            uFresh.put(key.substring(8), name);
                        }
                    }
                } catch (Throwable ignored) {}

                try {
                    // 2) 运行端熟人目录 /api/identity-pilot/people
                    Object peopleTree = DashApi.json(activity, "api/identity-pilot/people?limit=200", 8000);
                    List<Map<String, Object>> people = DashApi.objects(BotConfigJson.get(peopleTree, "people"));
                    for (Map<String, Object> p : people) {
                        String uid = DashApi.str(p, "userId").trim();
                        String pname = DashApi.str(p, "primaryName").trim();
                        if (!uid.isEmpty() && !pname.isEmpty()) uFresh.put(uid, pname);
                    }
                } catch (Throwable ignored) {}

                try {
                    // 3) 协议端非 Hook 群列表 + 好友列表
                    String groupsRaw = WhitelistPicker.queryProtocol(activity, "get_group_list", "{}", 15000);
                    if (groupsRaw != null) {
                        List<WhitelistModel.Chat> gl = WhitelistModel.parseGroups(groupsRaw);
                        if (gl != null) {
                            for (WhitelistModel.Chat ch : gl) {
                                if (ch != null && ch.id != null && ch.name != null && !ch.name.trim().isEmpty()) {
                                    gFresh.put(ch.id.trim(), ch.name.trim());
                                }
                            }
                        }
                    }
                    String friendsRaw = WhitelistPicker.queryProtocol(activity, "get_friend_list", "{}", 5000);
                    if (friendsRaw != null) {
                        List<WhitelistModel.Chat> fl = WhitelistModel.parseFriends(friendsRaw);
                        if (fl != null) {
                            for (WhitelistModel.Chat ch : fl) {
                                if (ch != null && ch.id != null && ch.name != null && !ch.name.trim().isEmpty()) {
                                    uFresh.put(ch.id.trim(), ch.name.trim());
                                }
                            }
                        }
                    }
                } catch (Throwable ignored) {}

                putGroupNames(appCtx, gFresh);
                putUserNames(appCtx, uFresh);
                if (onDone != null) {
                    try { activity.runOnUiThread(onDone); } catch (Throwable ignored) {}
                }
            }
        }, "whale-name-dir-sync");
        th.setDaemon(true);
        th.start();
    }

    private static void loadMapInto(File f, ConcurrentHashMap<String, String> dst) {
        if (f == null || !f.isFile()) return;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                if (bos.size() > 1024 * 1024) break;
            }
            Object parsed = BotConfigJson.parse(new String(bos.toByteArray(), "UTF-8"));
            Map<String, Object> obj = BotConfigJson.asObject(parsed);
            if (obj == null) return;
            for (Map.Entry<String, Object> e : obj.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                String k = e.getKey().trim();
                String v = String.valueOf(e.getValue()).trim();
                if (!k.isEmpty() && !v.isEmpty()) dst.put(k, v);
            }
        } catch (Throwable ignored) {}
    }

    private static void saveMap(File f, Map<String, String> src) {
        if (f == null || src == null) return;
        try {
            Map<String, Object> obj = new LinkedHashMap<String, Object>();
            for (Map.Entry<String, String> e : src.entrySet()) {
                if (e.getKey() != null && e.getValue() != null) obj.put(e.getKey(), e.getValue());
            }
            File p = f.getParentFile();
            if (p != null && !p.isDirectory()) p.mkdirs();
            File tmp = new File(p, f.getName() + ".next");
            try (FileOutputStream os = new FileOutputStream(tmp)) {
                os.write(BotConfigJson.write(obj).getBytes("UTF-8"));
                os.getFD().sync();
            }
            if (!tmp.renameTo(f)) {
                f.delete();
                tmp.renameTo(f);
            }
        } catch (Throwable ignored) {}
    }
}
