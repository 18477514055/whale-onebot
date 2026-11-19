package com.whaleonebot;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

/**
 * 「被杀之后自己爬起来」的看门狗。
 *
 * <p><b>为什么需要它（2026-11-19 实机事故）</b>：用户已经把本应用设成**自启动 + 不受电池限制**，
 * 仍然被杀 —— logcat 原文：
 * {@code I/SmartPower: com.whaleonebot/10299(13688): died->invisible(638149ms)}。
 * 进程一死，容器里的 QQ 与协议端一起没了，用户看到的就是「机器人静默、私聊也不回」。
 * 系统级杀进程我们挡不住，只能在**它死后几秒到几分钟内把服务重新拉起来**。
 *
 * <p><b>机制</b>：AlarmManager 的闹钟由**系统**持有，进程死了闹钟还在。
 * 每次响一次就：重新排下一次（单次 + 自排，避免 repeating 在 doze 下被合并到很晚），
 * 然后检查 {@link ContainerService#isRunning()}，没在跑就把它拉起来。
 *
 * <p><b>这属于补偿层</b>（PRINCIPLES P3），所以写明两条：
 * <ul>
 *   <li>掩盖的根因：厂商省电策略无视白名单直接杀进程，Android 侧没有给应用任何"阻止被杀"的官方手段；</li>
 *   <li>删除条件：当实测「进入白名单后不再被杀」（连续 30 天无 {@code died->invisible} 记录）即可停用本看门狗。</li>
 * </ul>
 */
public final class Watchdog {

    static final String ACTION = "com.whaleonebot.WATCHDOG_TICK";
    private static final int REQ = 0x57;
    private static final String PREFS = "whale";
    private static final String KEY_ENABLED = "watchdogEnabled";

    /** 用户是否开启「被杀之后自动重启」。默认开；关掉就一个闹钟都不排。 */
    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true);
    }

    /** 设置页的开关走这里：开 → 立刻排一次；关 → 取消已排的闹钟。 */
    public static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).apply();
        if (enabled) schedule(context); else cancel(context);
    }
    /** 检查间隔：短到用户几乎感觉不到掉线，长到不显著增加耗电。 */
    static final long INTERVAL_MS = 3 * 60 * 1000L;

    private Watchdog() { }

    /** 排（或重排）下一次检查。进程死了闹钟仍在，所以这是"重新爬起来"的关键。 */
    public static void schedule(Context context) {
        if (!isEnabled(context)) return;   // 用户关掉就不排闹钟，一个都不留
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = pending(context);
        long at = SystemClock.elapsedRealtime() + INTERVAL_MS;
        try {
            // API 31+ 对精确闹钟有额外权限；本应用 targetSdk=28，走这一支在旧行为下是允许的。
            if (Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
            }
        } catch (Throwable t) {
            // 没有精确闹钟权限：退回不精确（可能被推迟，但总比没有强）。
            try { am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi); } catch (Throwable ignored) { }
        }
    }

    public static void cancel(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(context));
    }

    private static PendingIntent pending(Context context) {
        Intent i = new Intent(context, WatchdogReceiver.class).setAction(ACTION);
        int flags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getBroadcast(context, REQ, i, flags);
    }
}
