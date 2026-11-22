package com.whaleonebot.ui;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * B 站分区表：给「按分区巡看」提供真实名称，用户不用去猜某个分区叫什么。
 * 首次从公开分区接口取一次并缓存（不需要登录态），之后直接用缓存。
 */
public final class BiliRegions {

    private static final String PREF = "bili_settings";
    private static final String KEY = "regions.v1";
    private static final String URL = "https://api.bilibili.com/x/web-interface/archive/regions";

    private BiliRegions() {
    }

    /** 一个分区（父分区带子分区）。 */
    public static final class Zone {
        public final int tid;
        public final String name;
        public final List<Zone> subs;

        Zone(int tid, String name, List<Zone> subs) {
            this.tid = tid;
            this.name = name;
            this.subs = subs;
        }
    }

    public interface Callback {
        /** 主线程回调；失败时 zones 为空、error 为原因。 */
        void done(List<Zone> zones, String error);
    }

    /** 读缓存；没有就返回空表（不联网）。 */
    public static List<Zone> cached(Context ctx) {
        if (ctx == null) return new ArrayList<Zone>();
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        String raw = sp.getString(KEY, "");
        if (raw == null || raw.isEmpty()) return new ArrayList<Zone>();
        try {
            return parse(new JSONArray(raw));
        } catch (Exception e) {
            return new ArrayList<Zone>();
        }
    }

    /** 有缓存立刻回调；否则后台取一次再回调（回调保证在主线程）。 */
    public static void load(final Activity activity, final Callback cb) {
        final List<Zone> cache = cached(activity);
        if (!cache.isEmpty()) {
            cb.done(cache, null);
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                List<Zone> zones = null;
                String error = null;
                try {
                    zones = fetch();
                    if (zones.isEmpty()) {
                        error = "分区列表为空";
                    } else {
                        JSONArray arr = new JSONArray();
                        for (Zone z : zones) arr.put(toJson(z));
                        activity.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                                .edit().putString(KEY, arr.toString()).apply();
                    }
                } catch (Exception e) {
                    error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                }
                final List<Zone> out = zones == null ? new ArrayList<Zone>() : zones;
                final String err = error;
                activity.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        cb.done(out, err);
                    }
                });
            }
        }, "bili-regions").start();
    }

    private static List<Zone> fetch() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(URL).openConnection();
        try {
            c.setConnectTimeout(6000);
            c.setReadTimeout(10000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) WhaleOneBot");
            c.setRequestProperty("Referer", "https://www.bilibili.com/");
            int code = c.getResponseCode();
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            JSONObject root = new JSONObject(buf.toString("UTF-8"));
            if (root.optInt("code", -1) != 0) throw new IllegalStateException("code " + root.optInt("code", -1));
            return parse(root.optJSONArray("data"));
        } finally {
            c.disconnect();
        }
    }

    private static List<Zone> parse(JSONArray data) {
        List<Zone> out = new ArrayList<Zone>();
        if (data == null) return out;
        for (int i = 0; i < data.length(); i++) {
            JSONObject row = data.optJSONObject(i);
            if (row == null) continue;
            int tid = row.optInt("tid", 0);
            String name = row.optString("name", "").trim();
            if (tid <= 0 || name.isEmpty()) continue;
            List<Zone> subs = new ArrayList<Zone>();
            JSONArray raw = row.optJSONArray("sub");
            if (raw != null) {
                for (int j = 0; j < raw.length(); j++) {
                    JSONObject s = raw.optJSONObject(j);
                    if (s == null) continue;
                    int stid = s.optInt("tid", 0);
                    String sname = s.optString("name", "").trim();
                    if (stid > 0 && !sname.isEmpty()) subs.add(new Zone(stid, sname, new ArrayList<Zone>()));
                }
            }
            out.add(new Zone(tid, name, subs));
        }
        return out;
    }

    private static JSONObject toJson(Zone z) throws Exception {
        JSONObject o = new JSONObject();
        o.put("tid", z.tid);
        o.put("name", z.name);
        JSONArray subs = new JSONArray();
        for (Zone s : z.subs) {
            JSONObject so = new JSONObject();
            so.put("tid", s.tid);
            so.put("name", s.name);
            subs.put(so);
        }
        o.put("sub", subs);
        return o;
    }

    /** 只取父分区（点父分区就覆盖其下全部子分区）。 */
    public static List<Zone> parents(List<Zone> zones) {
        List<Zone> out = new ArrayList<Zone>();
        if (zones != null) {
            for (Zone z : zones) {
                if (z.subs == null || z.subs.isEmpty()) out.add(z);
                else out.add(z);
            }
        }
        return out;
    }
}
