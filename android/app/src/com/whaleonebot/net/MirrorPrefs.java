package com.whaleonebot.net;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * [layer: shell-android] 把 Android SharedPreferences 挂载给纯 Java 的 {@link MirrorFetch}，
 * 持久化保存最快国内镜像、镜像优先策略及用户自定义镜像列表。
 */
public final class MirrorPrefs {

    private static final String PREFS_NAME = "whale_mirrors";
    private static volatile boolean attached;

    private MirrorPrefs() {
    }

    public static synchronized void attach(Context ctx) {
        if (ctx == null || attached) return;
        final Context app = ctx.getApplicationContext();
        final SharedPreferences sp = app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        MirrorFetch.attachStore(new MirrorFetch.Store() {
            @Override
            public String read(String key, String def) {
                try {
                    String v = sp.getString(key, def);
                    return v == null ? def : v;
                } catch (Throwable ignored) {
                    return def;
                }
            }

            @Override
            public void write(String key, String value) {
                try {
                    sp.edit().putString(key, value == null ? "" : value).apply();
                } catch (Throwable ignored) {
                }
            }
        });
        attached = true;
    }
}
