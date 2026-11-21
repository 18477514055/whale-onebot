package com.whaleonebot.ui;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * B 站动作流水（append-only），落盘在 files/bili-actions.log。
 * 每行一条 JSON：{"t":epochMs,"kind":"browse|comment|like|coin|follow|dm|error","title":"...","result":"ok|fail","detail":"..."}
 */
public final class BiliActionLog {

    private static final String FILE_NAME = "bili-actions.log";
    public static final int DEFAULT_PAGE_SIZE = 10;

    private BiliActionLog() {
    }

    private static File logFile(Context ctx) {
        return new File(ctx.getFilesDir(), FILE_NAME);
    }

    /** 追加一条动作记录。 */
    public static synchronized void append(Context ctx, String botId, JSONObject entry) {
        if (ctx == null || entry == null) return;
        FileOutputStream fos = null;
        OutputStreamWriter writer = null;
        try {
            JSONObject row = new JSONObject(entry.toString());
            if (!row.has("t") || row.optLong("t", 0L) <= 0L) {
                row.put("t", System.currentTimeMillis());
            }
            if (botId != null && !botId.isEmpty() && !row.has("botId")) {
                row.put("botId", botId);
            }
            File f = logFile(ctx);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            fos = new FileOutputStream(f, true);
            writer = new OutputStreamWriter(fos, "UTF-8");
            writer.write(row.toString());
            writer.write('\n');
            writer.flush();
        } catch (Exception ignored) {
        } finally {
            try {
                if (writer != null) writer.close();
                else if (fos != null) fos.close();
            } catch (Exception ignored) {
            }
        }
    }

    /** 读取指定机器人的全部记录（按文件顺序，旧的在前）。 */
    private static synchronized List<JSONObject> readAll(Context ctx, String botId) {
        List<JSONObject> list = new ArrayList<JSONObject>();
        if (ctx == null) return list;
        File f = logFile(ctx);
        if (!f.isFile()) return list;
        BufferedReader reader = null;
        try {
            reader = new BufferedReader(new InputStreamReader(new FileInputStream(f), "UTF-8"));
            String line;
            while ((line = reader.readLine()) != null) {
                String trimmed = line.trim();
                if (trimmed.isEmpty()) continue;
                try {
                    JSONObject obj = new JSONObject(trimmed);
                    String rowBot = obj.optString("botId", "");
                    if (botId != null && !botId.isEmpty() && !rowBot.isEmpty() && !botId.equals(rowBot)) {
                        continue;
                    }
                    list.add(obj);
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        } finally {
            try {
                if (reader != null) reader.close();
            } catch (Exception ignored) {
            }
        }
        return list;
    }

    /** 分页读取最近记录（新的在前，page 从 0 开始，默认每页 10 条）。 */
    public static List<JSONObject> page(Context ctx, String botId, int page, int pageSize) {
        int size = pageSize <= 0 ? DEFAULT_PAGE_SIZE : pageSize;
        int p = page < 0 ? 0 : page;
        List<JSONObject> all = readMerged(ctx, botId);
        List<JSONObject> out = new ArrayList<JSONObject>();
        int total = all.size();
        int startFromEnd = total - 1 - p * size;
        if (startFromEnd < 0) return out;
        int endFromEnd = Math.max(0, startFromEnd - size + 1);
        for (int i = startFromEnd; i >= endFromEnd; i--) {
            out.add(all.get(i));
        }
        return out;
    }

    /**
     * App 侧自己记的 + 运行端（容器里行为层）写的，按时间合成一条时间线。
     * 运行端那份是真实发生过的动作 —— 看板空着基本都是因为它没接上，不是「没动作」。
     */
    private static List<JSONObject> readMerged(Context ctx, String botId) {
        List<JSONObject> all = readAll(ctx, botId);
        try {
            all.addAll(BiliRuntime.actionRecords(ctx, botId));
        } catch (Exception ignored) {
        }
        if (all.size() > 1) {
            Collections.sort(all, new Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    long x = a.optLong("t", 0L);
                    long y = b.optLong("t", 0L);
                    return x < y ? -1 : (x > y ? 1 : 0);
                }
            });
        }
        return all;
    }

    /** 统计该机器人的流水总条数。 */
    public static int count(Context ctx, String botId) {
        return readMerged(ctx, botId).size();
    }

    /** 按本地当天日期统计各类成功动作次数。 */
    public static Map<String, Integer> todayCounts(Context ctx, String botId) {
        Map<String, Integer> counts = new HashMap<String, Integer>();
        List<JSONObject> all = readMerged(ctx, botId);
        if (all.isEmpty()) return counts;

        Calendar now = Calendar.getInstance();
        int todayYear = now.get(Calendar.YEAR);
        int todayDay = now.get(Calendar.DAY_OF_YEAR);
        Calendar cal = Calendar.getInstance();

        for (int i = 0; i < all.size(); i++) {
            JSONObject obj = all.get(i);
            long t = obj.optLong("t", 0L);
            if (t <= 0L) continue;
            cal.setTimeInMillis(t);
            if (cal.get(Calendar.YEAR) != todayYear || cal.get(Calendar.DAY_OF_YEAR) != todayDay) {
                continue;
            }
            if ("fail".equals(obj.optString("result", ""))) continue;
            String kind = obj.optString("kind", "");
            if (kind.isEmpty()) continue;
            Integer prev = counts.get(kind);
            counts.put(kind, prev == null ? 1 : prev + 1);
        }
        return counts;
    }

    public static int countOf(Map<String, Integer> map, String kind) {
        if (map == null) return 0;
        Integer v = map.get(kind);
        return v == null ? 0 : v;
    }

    /** 跳过/拦截的原因文案（运行端写的是英文键名）。认不出来的返回空串，不硬塞一个说法。 */
    public static String reasonLabel(String detail) {
        if (detail == null) return "";
        if ("skip-percent".equals(detail)) return "按比例随机跳过";
        if ("daily_browse_limit".equals(detail)) return "已达今日巡看上限";
        if ("no-generator".equals(detail) || "no_generator".equals(detail)) return "没有评论生成器";
        if ("outside-window".equals(detail)) return "不在作息时段";
        if ("backoff".equals(detail)) return "风控退避中";
        if ("rate_limited".equals(detail)) return "触到每小上限";
        return "";
    }

    /**
     * 结果文案：ok 成功 / skip 跳过 / fail 失败。
     */
    public static String resultLabel(String result) {
        if ("fail".equals(result)) return "失败";
        if ("skip".equals(result)) return "跳过";
        return "成功";
    }

    public static String formatTime(long epochMs) {
        if (epochMs <= 0L) return "--:--";
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(epochMs));
    }

    public static String kindLabel(String kind) {
        if ("browse".equals(kind)) return "巡看";
        if ("comment".equals(kind)) return "评论";
        if ("comment_error".equals(kind)) return "评论失败";
        if ("like".equals(kind)) return "点赞";
        if ("coin".equals(kind)) return "投币";
        if ("follow".equals(kind)) return "关注";
        if ("dm".equals(kind)) return "私信";
        if ("error".equals(kind)) return "异常";
        // 运行端（容器里那层）自己的事件名：直接透出来是英文，用户看不懂在干什么。
        if ("comment_skipped".equals(kind)) return "未评论";
        if ("comment_sent".equals(kind) || "pending_approved".equals(kind)) return "评论";
        if ("tick".equals(kind)) return "巡看一轮";
        if ("watch".equals(kind)) return "观看";
        if ("blocked".equals(kind)) return "被限流";
        if ("loop_error".equals(kind)) return "异常";
        if ("worker".equals(kind)) return "运行端";
        if ("worker_error".equals(kind)) return "运行端异常";
        if ("maintenance".equals(kind)) return "资料库维护";
        return kind == null || kind.isEmpty() ? "动作" : kind;
    }
}
