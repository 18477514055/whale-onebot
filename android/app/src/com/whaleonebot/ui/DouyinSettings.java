package com.whaleonebot.ui;

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
 * [layer: shell-android] 抖音（测试版）每机器人独立配置、实验性网页凭证与本地候选队列存储。
 *
 * <p>安全与隐私约束：
 * <ul>
 *   <li>所有写操作（评论 / 点赞 / 收藏 / 关注 / 发图文 / 改资料）默认均为 {@link #MODE_APPROVAL}（需要主人审批）；</li>
 *   <li>实验性 WebView 抓取的 Cookie 仅落盘于应用私有目录 {@code douyin-sessions/<botId>.json}，权限 {@code 0600}，
 *       绝不打印到日志、绝不回显明文；</li>
 *   <li>当前为实验性测试版接口，本类诚实反映本地配置与凭证状态，不虚构未验证的实网收发状态。</li>
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
    }

    public static final class SessionSummary {
        public final boolean saved;
        public final long savedAt;
        public final int cookieFieldCount;
        public final boolean hasSessionId;

        SessionSummary(boolean saved, long savedAt, int cookieFieldCount, boolean hasSessionId) {
            this.saved = saved;
            this.savedAt = savedAt;
            this.cookieFieldCount = cookieFieldCount;
            this.hasSessionId = hasSessionId;
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

    private static File sessionFile(File filesDir, String botId) {
        return new File(new File(filesDir, "douyin-sessions"), safeId(botId) + ".json");
    }

    private static File queueFile(File filesDir, String botId) {
        return new File(new File(filesDir, "douyin-candidates"), safeId(botId) + ".json");
    }

    public static Config loadConfig(File filesDir, String botId) {
        Config c = new Config();
        if (filesDir == null) return c;
        File f = cfgFile(filesDir, botId);
        if (!f.isFile()) return c;
        try {
            JSONObject obj = new JSONObject(readUtf8(f));
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
        } catch (Throwable ignored) {
        }
        return c;
    }

    public static boolean saveConfig(File filesDir, String botId, Config c) {
        if (filesDir == null || c == null) return false;
        try {
            JSONObject obj = new JSONObject();
            JSONObject acts = new JSONObject();
            for (String[] row : WRITE_ACTIONS) {
                String v = c.actions.get(row[0]);
                acts.put(row[0], MODE_AUTONOMOUS.equals(v) ? MODE_AUTONOMOUS : MODE_APPROVAL);
            }
            obj.put("actions", acts);
            obj.put("browseEnabled", c.browseEnabled);
            obj.put("browseIntervalMin", Math.max(15, Math.min(1440, c.browseIntervalMin)));
            obj.put("dailyBrowseBudget", Math.max(1, Math.min(200, c.dailyBrowseBudget)));
            obj.put("dailyWriteBudget", Math.max(0, Math.min(100, c.dailyWriteBudget)));
            return writePrivateUtf8(cfgFile(filesDir, botId), obj.toString(2));
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 保存实验性网页登录抓到的 Cookie（只存私有目录 0600，绝不打日志）。 */
    public static boolean saveWebSession(File filesDir, String botId, String rawCookie) {
        if (filesDir == null || rawCookie == null || rawCookie.trim().isEmpty()) return false;
        String cookie = rawCookie.trim();
        int fields = 0;
        boolean hasSid = false;
        for (String part : cookie.split(";")) {
            String p = part.trim();
            if (p.contains("=")) {
                fields++;
                String k = p.substring(0, p.indexOf('=')).trim().toLowerCase(java.util.Locale.ROOT);
                if (k.contains("sessionid") || k.equals("sid_tt") || k.equals("passport_csrf_token") || k.equals("ttwid")) {
                    hasSid = true;
                }
            }
        }
        try {
            JSONObject obj = new JSONObject();
            obj.put("savedAt", System.currentTimeMillis());
            obj.put("fieldCount", fields);
            obj.put("hasSessionId", hasSid);
            obj.put("cookie", cookie);
            return writePrivateUtf8(sessionFile(filesDir, botId), obj.toString());
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 读取凭证摘要（绝不向 UI 暴露明文 Cookie）。 */
    public static SessionSummary sessionSummary(File filesDir, String botId) {
        if (filesDir == null) return new SessionSummary(false, 0L, 0, false);
        File f = sessionFile(filesDir, botId);
        if (!f.isFile()) return new SessionSummary(false, 0L, 0, false);
        try {
            JSONObject obj = new JSONObject(readUtf8(f));
            String c = obj.optString("cookie", "");
            if (c.trim().isEmpty()) return new SessionSummary(false, 0L, 0, false);
            return new SessionSummary(true, obj.optLong("savedAt", f.lastModified()),
                    obj.optInt("fieldCount", 0), obj.optBoolean("hasSessionId", false));
        } catch (Throwable ignored) {
            return new SessionSummary(false, 0L, 0, false);
        }
    }

    public static boolean forgetWebSession(File filesDir, String botId) {
        if (filesDir == null) return false;
        File f = sessionFile(filesDir, botId);
        return !f.exists() || f.delete();
    }

    /** 追加一条由系统分享页或用户手动提交的公开作品链接候选（最多保留最近 50 条）。 */
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
        } catch (Throwable ignored) {
        }
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
