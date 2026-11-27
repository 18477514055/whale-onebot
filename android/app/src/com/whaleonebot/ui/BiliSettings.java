package com.whaleonebot.ui;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;

/**
 * B 站行为参数配置读写类：按 botId + bindingId 持久化到 SharedPreferences("bili_settings")。
 */
public final class BiliSettings {

    private static final String PREF_NAME = "bili_settings";

    private BiliSettings() {
    }

    /** 返回包含全部默认键值的配置对象。 */
    public static JSONObject defaults() {
        JSONObject o = new JSONObject();
        try {
            // B 站侧的全局管理员 UID（和 QQ 那边一个意思）：填了就认这个人，空着就等于没设。
            o.put("admin.uid", "");
            o.put("browse.enabled", true);
            o.put("browse.sources", toJsonArray(Arrays.asList("recommend", "follow")));
            // 自由巡看是默认：不限分区走综合推荐流。要从分区取流才把 freeBrowse 关掉、再去 picker 里选。
            o.put("browse.freeBrowse", true);
            o.put("browse.partitions", new JSONArray());
            o.put("browse.keywords", new JSONArray());
            o.put("browse.maxPerRun", 3);
            o.put("browse.maxPerDay", 20);
            o.put("browse.maxMinutesPerVideo", 3);
            o.put("browse.gapMinutes", 45);
            o.put("browse.jitterPercent", 40);
            o.put("browse.windows", toJsonArray(Arrays.asList("09:00-12:00", "14:00-23:00")));
            o.put("browse.skipPercent", 70);

            o.put("read.enabled", true);
            o.put("read.maxPerVideo", 20);
            o.put("read.order", "hot");
            o.put("read.storeToLibrary", true);

            o.put("write.enabled", false);
            o.put("write.commentPerDay", 10);
            o.put("write.commentPerVideo", 1);
            o.put("write.likePerDay", 50);
            o.put("write.coinPerDay", 10);
            o.put("write.followPerDay", 5);
            o.put("write.replyOnly", true);
            o.put("write.minChars", 15);
            o.put("write.maxChars", 80);
            o.put("write.reviewBeforeSend", true);

            o.put("dm.enabled", false);
            o.put("dm.maxPerDay", 20);
            o.put("dm.pollSeconds", 15);

            o.put("live.enabled", false);
            o.put("live.rooms", new JSONArray());
            o.put("live.danmakuPerHour", 20);

            o.put("lib.retentionDays", 30);
            o.put("lib.condenseEnabled", true);
            o.put("lib.condenseAfterDays", 7);
            o.put("lib.condenseModel", "");

            o.put("risk.maxPerHour", 30);
            o.put("risk.backoffMinutes", 15);
            o.put("risk.stopOnVerify", true);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private static String prefKey(String botId, String bindingId) {
        String b = botId == null ? "" : botId;
        String k = bindingId == null ? "" : bindingId;
        return b + "::" + k;
    }

    /** 读取指定机器人与绑定的配置；缺省键自动补齐默认值。 */
    public static JSONObject get(Context ctx, String botId, String bindingId) {
        JSONObject out = defaults();
        if (ctx == null) return out;
        SharedPreferences sp = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        String raw = sp.getString(prefKey(botId, bindingId), null);
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONObject saved = new JSONObject(raw);
            Iterator<String> keys = saved.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                out.put(k, saved.get(k));
            }
        } catch (JSONException ignored) {
        }
        return out;
    }

    /** 保存配置对象到 SharedPreferences。 */
    public static void put(Context ctx, String botId, String bindingId, JSONObject value) {
        if (ctx == null || value == null) return;
        SharedPreferences sp = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        sp.edit().putString(prefKey(botId, bindingId), value.toString()).apply();
        // 配置只在 App 里，行为层在容器里 —— 每次保存顺手把它写进两边共用的数据目录，
        // 否则用户改了半天参数，运行端读到的还是上一份（或者一份都没有）。
        try {
            BiliRuntime.publish(ctx, botId, bindingId);
        } catch (Exception ignored) {
        }
    }

    public static int getInt(JSONObject obj, String key, int fallback) {
        if (obj == null || !obj.has(key)) return fallback;
        return obj.optInt(key, fallback);
    }

    public static int getInt(Context ctx, String botId, String bindingId, String key, int fallback) {
        return getInt(get(ctx, botId, bindingId), key, fallback);
    }

    public static boolean getBool(JSONObject obj, String key, boolean fallback) {
        if (obj == null || !obj.has(key)) return fallback;
        return obj.optBoolean(key, fallback);
    }

    public static boolean getBool(Context ctx, String botId, String bindingId, String key, boolean fallback) {
        return getBool(get(ctx, botId, bindingId), key, fallback);
    }

    public static String getString(JSONObject obj, String key, String fallback) {
        if (obj == null || !obj.has(key)) return fallback;
        return obj.optString(key, fallback);
    }

    public static List<String> getStringList(JSONObject obj, String key) {
        List<String> list = new ArrayList<String>();
        if (obj == null) return list;
        JSONArray arr = obj.optJSONArray(key);
        if (arr == null) return list;
        for (int i = 0; i < arr.length(); i++) {
            String item = arr.optString(i, "").trim();
            if (!item.isEmpty()) list.add(item);
        }
        return list;
    }

    public static List<String> getStringList(Context ctx, String botId, String bindingId, String key) {
        return getStringList(get(ctx, botId, bindingId), key);
    }

    public static JSONArray toJsonArray(List<String> items) {
        JSONArray arr = new JSONArray();
        if (items != null) {
            for (int i = 0; i < items.size(); i++) {
                String s = items.get(i);
                if (s != null && !s.trim().isEmpty()) {
                    arr.put(s.trim());
                }
            }
        }
        return arr;
    }

    public static List<String> splitCsv(String text) {
        List<String> out = new ArrayList<String>();
        if (text == null || text.trim().isEmpty()) return out;
        String[] parts = text.split("[,，]");
        for (int i = 0; i < parts.length; i++) {
            String s = parts[i].trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    public static String joinCsv(List<String> items) {
        if (items == null || items.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(items.get(i));
        }
        return sb.toString();
    }
}
