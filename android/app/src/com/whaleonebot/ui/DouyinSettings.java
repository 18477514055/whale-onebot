package com.whaleonebot.ui;

import android.content.Context;

import com.whaleonebot.DouyinSessionStore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * [layer: shell-android] 抖音每机器人独立配置、硬件加密凭证桥接与本地候选队列存储。
 *
 * <p>安全与隐私约束：
 * <ul>
 *   <li>所有写操作（评论 / 点赞 / 收藏 / 关注 / 发图文 / 改资料）默认均为 {@link #MODE_APPROVAL}（需要主人审批）；</li>
 *   <li>网页 Cookie 全面托管给 {@link DouyinSessionStore} 使用 Android Keystore AES-256-GCM 硬件加密存储，
 *       并兼容自动迁移与擦除旧明文 JSON，绝不打印或回显明文。</li>
 * </ul>
 */
public final class DouyinSettings {

    public static final String MODE_APPROVAL = "require_approval";
    public static final String MODE_AUTONOMOUS = "autonomous";

    /** 六大写操作键名与中文展示标签（全部默认「需要授权」）。 */
    public static final String[][] WRITE_ACTIONS = {
            {"comment", "发表评论 / 回复评论"},
            {"like", "点赞作品或评论"},
            {"favorite", "收藏作品"},
            {"follow", "关注 / 取关作者"},
            {"publishPost", "发布图文 / 视频动态"},
            {"editProfile", "修改账号资料"},
    };

    public static final class Config {
        public final Map<String, String> actions = new LinkedHashMap<>();
        public boolean browseEnabled = false;
        public int browseIntervalMin = 60;
        public int dailyBrowseBudget = 20;
        public int dailyWriteBudget = 5;

        Config() {
            for (String[] row : WRITE_ACTIONS) {
                actions.put(row[0], MODE_APPROVAL);
            }
        }

        public JSONObject toJson() {
            JSONObject obj = new JSONObject();
            try {
                JSONObject acts = new JSONObject();
                for (String[] row : WRITE_ACTIONS) {
                    String v = actions.get(row[0]);
                    acts.put(row[0], MODE_AUTONOMOUS.equals(v) ? MODE_AUTONOMOUS : MODE_APPROVAL);
                }
                obj.put("actions", acts);
                obj.put("browseEnabled", browseEnabled);
                obj.put("browseIntervalMin", Math.max(15, Math.min(1440, browseIntervalMin)));
                obj.put("dailyBrowseBudget", Math.max(1, Math.min(200, dailyBrowseBudget)));
                obj.put("dailyWriteBudget", Math.max(0, Math.min(100, dailyWriteBudget)));
            } catch (Throwable ignored) {}
            return obj;
        }

        public static Config fromJson(JSONObject obj) {
            Config c = new Config();
            if (obj == null) return c;
            JSONObject acts = obj.optJSONObject("actions");
            if (acts != null) {
                for (String[] row : WRITE_ACTIONS) {
                    String v = acts.optString(row[0], MODE_APPROVAL);
                    c.actions.put(row[0], MODE_AUTONOMOUS.equals(v) ? MODE_AUTONOMOUS : MODE_APPROVAL);
                }
            }
            c.browseEnabled = obj.optBoolean("browseEnabled", false);
            c.browseIntervalMin = Math.max(15, Math.min(1440, obj.optInt("browseIntervalMin", 60)));
            c.dailyBrowseBudget = Math.max(1, Math.min(200, obj.optInt("dailyBrowseBudget", 20)));
            c.dailyWriteBudget = Math.max(0, Math.min(100, obj.optInt("dailyWriteBudget", 5)));
            return c;
        }
    }

    public static final class SessionSummary {
        public final boolean saved;
        public final boolean verified;
        public final long savedAt;
        public final long lastCheckAt;
        public final int cookieFieldCount;
        public final boolean hasSessionId;
        public final String uid;
        public final String nickname;
        public final String state;
        public final String lastError;

        SessionSummary(boolean saved, boolean verified, long savedAt, long lastCheckAt,
                       int cookieFieldCount, boolean hasSessionId, String uid, String nickname,
                       String state, String lastError) {
            this.saved = saved;
            this.verified = verified;
            this.savedAt = savedAt;
            this.lastCheckAt = lastCheckAt;
            this.cookieFieldCount = cookieFieldCount;
            this.hasSessionId = hasSessionId;
            this.uid = uid == null ? "" : uid;
            this.nickname = nickname == null ? "" : nickname;
            this.state = state == null ? "stopped" : state;
            this.lastError = lastError == null ? "" : lastError;
        }

        public JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("saved", saved);
                o.put("verified", verified);
                o.put("savedAt", savedAt);
                o.put("lastCheckAt", lastCheckAt);
                o.put("cookieFieldCount", cookieFieldCount);
                o.put("hasSessionId", hasSessionId);
                o.put("uid", uid);
                o.put("nickname", nickname);
                o.put("state", state);
                o.put("lastError", lastError);
            } catch (Throwable ignored) {}
            return o;
        }

        public static SessionSummary fromJson(JSONObject o) {
            if (o == null) return new SessionSummary(false, false, 0L, 0L, 0, false, "", "", "stopped", "");
            return new SessionSummary(
                    o.optBoolean("saved", false),
                    o.optBoolean("verified", false),
                    o.optLong("savedAt", 0L),
                    o.optLong("lastCheckAt", 0L),
                    o.optInt("cookieFieldCount", 0),
                    o.optBoolean("hasSessionId", false),
                    o.optString("uid", ""),
                    o.optString("nickname", ""),
                    o.optString("state", "stopped"),
                    o.optString("lastError", "")
            );
        }
    }

    private DouyinSettings() {
    }

    private static String safeId(String botId) {
        if (botId == null) return "default";
        String cleaned = botId.replaceAll("[^A-Za-z0-9_.-]", "_");
        return cleaned.isEmpty() ? "default" : cleaned;
    }

    private static File cfgFile(File filesDir, String botId) {
        return new File(new File(filesDir, "douyin-config"), safeId(botId) + ".json");
    }

    private static File queueFile(File filesDir, String botId) {
        return new File(new File(filesDir, "douyin-candidates"), safeId(botId) + ".json");
    }

    public static Config loadConfig(File filesDir, String botId) {
        if (filesDir == null) return new Config();
        File f = cfgFile(filesDir, botId);
        if (!f.isFile()) return new Config();
        try {
            return Config.fromJson(new JSONObject(readUtf8(f)));
        } catch (Throwable ignored) {
            return new Config();
        }
    }

    public static boolean saveConfig(File filesDir, String botId, Config c) {
        if (filesDir == null || c == null) return false;
        try {
            return writePrivateUtf8(cfgFile(filesDir, botId), c.toJson().toString(2));
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 兼容旧签名入口：如传入有效 Context 则走硬件 Keystore 加密存储。 */
    public static boolean saveWebSession(Context ctx, String botId, String rawCookie) {
        if (ctx == null) return false;
        return DouyinSessionStore.save(ctx, botId, rawCookie, false, "", "", "saved", "");
    }

    public static SessionSummary sessionSummary(Context ctx, String botId) {
        DouyinSessionStore.Summary s = DouyinSessionStore.summary(ctx, botId);
        return new SessionSummary(s.saved, s.verified, s.savedAt, s.lastCheckAt,
                s.cookieFieldCount, s.hasSessionId, s.uid, s.nickname, s.state, s.lastError);
    }

    public static SessionSummary sessionSummary(File filesDir, String botId) {
        // 兼容无 Context 旧调用（仅在无法拿到 Context 时读 meta 文件）
        if (filesDir == null) return SessionSummary.fromJson(null);
        File mf = new File(new File(filesDir, "douyin-meta"), safeId(botId) + ".json");
        if (mf.isFile()) {
            try {
                JSONObject o = new JSONObject(readUtf8(mf));
                return new SessionSummary(
                        true,
                        o.optBoolean("verified", false),
                        o.optLong("savedAt", mf.lastModified()),
                        o.optLong("lastCheckAt", 0L),
                        o.optInt("fieldCount", 0),
                        o.optBoolean("hasSessionId", false),
                        o.optString("uid", ""),
                        o.optString("nickname", ""),
                        o.optString("state", "saved"),
                        o.optString("lastError", "")
                );
            } catch (Throwable ignored) {}
        }
        return SessionSummary.fromJson(null);
    }

    public static boolean forgetWebSession(Context ctx, String botId) {
        return DouyinSessionStore.forget(ctx, botId);
    }

    public static boolean forgetWebSession(File filesDir, String botId) {
        if (filesDir == null) return false;
        File leg = new File(new File(filesDir, "douyin-sessions"), safeId(botId) + ".json");
        File mf = new File(new File(filesDir, "douyin-meta"), safeId(botId) + ".json");
        boolean ok = true;
        if (leg.exists()) ok &= leg.delete();
        if (mf.exists()) ok &= mf.delete();
        return ok;
    }

    public static synchronized boolean enqueueCandidate(File filesDir, String botId, String url) {
        if (filesDir == null || url == null || url.trim().isEmpty()) return false;
        try {
            List<String> list = listCandidates(filesDir, botId);
            list.remove(url.trim());
            list.add(0, url.trim());
            while (list.size() > 50) list.remove(list.size() - 1);
            JSONArray arr = new JSONArray();
            for (String s : list) arr.put(s);
            return writePrivateUtf8(queueFile(filesDir, botId), arr.toString(2));
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static synchronized List<String> listCandidates(File filesDir, String botId) {
        List<String> out = new ArrayList<>();
        if (filesDir == null) return out;
        File f = queueFile(filesDir, botId);
        if (!f.isFile()) return out;
        try {
            JSONArray arr = new JSONArray(readUtf8(f));
            for (int i = 0; i < arr.length(); i++) {
                String v = arr.optString(i, "").trim();
                if (!v.isEmpty()) out.add(v);
            }
        } catch (Throwable ignored) {}
        return out;
    }

    public static synchronized boolean clearCandidates(File filesDir, String botId) {
        if (filesDir == null) return false;
        File f = queueFile(filesDir, botId);
        return !f.exists() || f.delete();
    }

    private static String readUtf8(File f) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static boolean writePrivateUtf8(File target, String content) {
        try {
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
            File tmp = new File(parent, target.getName() + ".tmp");
            try (FileOutputStream os = new FileOutputStream(tmp)) {
                os.write(content.getBytes(StandardCharsets.UTF_8));
                os.getFD().sync();
            }
            tmp.setReadable(false, false);
            tmp.setReadable(true, true);
            tmp.setWritable(false, false);
            tmp.setWritable(true, true);
            if (target.exists()) target.delete();
            if (!tmp.renameTo(target)) {
                tmp.delete();
                return false;
            }
            target.setReadable(false, false);
            target.setReadable(true, true);
            target.setWritable(false, false);
            target.setWritable(true, true);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }
}
