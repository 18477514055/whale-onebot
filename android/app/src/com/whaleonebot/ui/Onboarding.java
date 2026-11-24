package com.whaleonebot.ui;

import android.content.Context;

/**
 * 新手指引的「只出现一次」状态。
 *
 * <p>2026-11-23 第一个使用者的反馈：拿到 APK 之后不知道该先做什么（没有引导）。
 * 做法是在首页顶部放一张三步卡，点过「知道了」就永久收起 —— 用独立 SharedPreferences，
 * 不去碰既有设置文件，避免升级时把用户的配置读坏。
 */
final class Onboarding {

    private static final String FILE = "onboarding";
    private static final String KEY_SEEN = "guideSeen";

    private Onboarding() {
    }

    static boolean seen(Context context) {
        try {
            return context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(KEY_SEEN, false);
        } catch (Throwable e) {
            // 读不到就当「已经看过」：宁可少打扰，也不要每次启动都弹一遍。
            return true;
        }
    }

    static void markSeen(Context context) {
        try {
            context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_SEEN, true).apply();
        } catch (Throwable ignored) {
            // 存不下最多下次再出现一次，不影响使用。
        }
    }

    static void reset(Context context) {
        try {
            context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
                    .edit().remove(KEY_SEEN).apply();
        } catch (Throwable ignored) {
        }
    }
}
