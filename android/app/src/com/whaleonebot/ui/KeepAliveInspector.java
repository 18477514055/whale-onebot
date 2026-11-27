package com.whaleonebot.ui;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.whaleonebot.ContainerService;
import com.whaleonebot.Watchdog;

import java.util.ArrayList;
import java.util.List;

/**
 * [layer: shell-android] 系统保活自检仪：逐项检测 Android 后台长期存活关键条件并提供一键跳转修复。
 */
public final class KeepAliveInspector {

    public static final int ACTION_NONE = 0;
    public static final int ACTION_BATTERY_WHITELIST = 1;
    public static final int ACTION_EXACT_ALARM = 2;
    public static final int ACTION_NOTIFICATION = 3;
    public static final int ACTION_APP_DETAILS = 4;
    public static final int ACTION_ENABLE_WATCHDOG = 5;
    public static final int ACTION_BYPASS_PROXY = 6;

    public static final class CheckItem {
        public final String key;
        public final String title;
        public final boolean ok;
        public final String detail;
        public final String fixLabel;
        public final int action;
        public final int weight;

        public CheckItem(String key, String title, boolean ok, String detail,
                         String fixLabel, int action, int weight) {
            this.key = key;
            this.title = title;
            this.ok = ok;
            this.detail = detail;
            this.fixLabel = fixLabel;
            this.action = action;
            this.weight = weight;
        }
    }

    public static final class Summary {
        public final int score;
        public final int passedCount;
        public final int totalCount;
        public final String badge;
        public final NetworkRiskLogic.Report netReport;
        public final List<CheckItem> items;

        public Summary(int score, int passedCount, int totalCount, String badge,
                       NetworkRiskLogic.Report netReport, List<CheckItem> items) {
            this.score = score;
            this.passedCount = passedCount;
            this.totalCount = totalCount;
            this.badge = badge;
            this.netReport = netReport;
            this.items = items;
        }
    }

    private KeepAliveInspector() {
    }

    public static Summary inspect(Context ctx) {
        List<CheckItem> items = new ArrayList<CheckItem>();
        if (ctx == null) {
            return new Summary(0, 0, 0, "未检测", NetworkRiskDetector.inspect(null), items);
        }

        // 1. 忽略电池优化（权重 25）
        boolean batteryOk = false;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            batteryOk = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (Throwable ignored) {}
        items.add(new CheckItem(
                "battery",
                "电池优化白名单（不限制后台）",
                batteryOk,
                batteryOk ? "已加入系统「不受电池限制」白名单" : "未加入白名单：国产 ROM 息屏约 10 分钟可能强杀进程",
                "去放行",
                ACTION_BATTERY_WHITELIST,
                25
        ));

        // 2. 进程防杀重启看门狗（权重 20）
        boolean wdOk = Watchdog.isEnabled(ctx);
        items.add(new CheckItem(
                "watchdog",
                "系统闹钟保活（Watchdog）",
                wdOk,
                wdOk ? "已开启：即使被系统强杀也可自动爬起恢复在线" : "已关闭：被系统杀掉后不会自动重启恢复",
                "立即开启",
                ACTION_ENABLE_WATCHDOG,
                20
        ));

        // 3. 精确闹钟权限（权重 15）
        boolean exactAlarmOk = true;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
                exactAlarmOk = am != null && am.canScheduleExactAlarms();
            } catch (Throwable ignored) {}
        }
        items.add(new CheckItem(
                "exact_alarm",
                "精确闹钟调度权限",
                exactAlarmOk,
                exactAlarmOk ? "允许 Doze 模式下准时唤醒看门狗" : "受限：系统休眠后保活闹钟可能被延迟数十分钟",
                "去授权",
                ACTION_EXACT_ALARM,
                15
        ));

        // 4. 高优通知通道与掉线提醒权限（权重 15）
        boolean notifyOk = true;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) notifyOk = false;
                if (notifyOk && Build.VERSION.SDK_INT >= 26) {
                    NotificationChannel ch = nm.getNotificationChannel("whale-qq-alert");
                    if (ch != null && ch.getImportance() == NotificationManager.IMPORTANCE_NONE) {
                        notifyOk = false;
                    }
                }
            }
        } catch (Throwable ignored) {}
        items.add(new CheckItem(
                "notify",
                "前台保活与掉线高优通知",
                notifyOk,
                notifyOk ? "通知权限正常，三端掉线与过期可即时弹窗提醒" : "通知被禁止或已静音，发生掉线/被踢将无法及时获知",
                "去开启",
                ACTION_NOTIFICATION,
                15
        ));

        // 5. 网络出口与代理劫持健康（权重 15）
        NetworkRiskLogic.Report net = NetworkRiskDetector.inspect(ctx);
        boolean netOk = !net.isWarn();
        items.add(new CheckItem(
                "network",
                "网络出口直连健康度",
                netOk,
                net.summary,
                net.proxyHijack ? "看绕行规则" : "去检查",
                net.proxyHijack ? ACTION_BYPASS_PROXY : ACTION_NONE,
                15
        ));

        // 6. 厂商自启动与后台锁定引导（权重 10；因 Android 无官方查询自启权限 API，以运行中容器+自启标记评估）
        boolean containerUp = ContainerService.isRunning();
        items.add(new CheckItem(
                "autostart",
                "厂商自启动 / 多任务后台加锁",
                containerUp,
                "请在系统「应用信息 → 权限/省电」开启自启动，并在最近任务中给本应用下拉加锁（厂商无查询接口）",
                "打开应用设置",
                ACTION_APP_DETAILS,
                10
        ));

        int score = 0;
        int passed = 0;
        for (CheckItem item : items) {
            if (item.ok) {
                score += item.weight;
                passed++;
            }
        }
        String badge = score >= 90 ? "优秀" : (score >= 70 ? "良好" : (score >= 45 ? "一般" : "高风险"));
        return new Summary(score, passed, items.size(), badge, net, items);
    }

    /** 根据检查项执行系统设置跳转或一键修复。 */
    public static void executeFix(Activity activity, CheckItem item, Runnable onFixed) {
        if (activity == null || item == null) return;
        switch (item.action) {
            case ACTION_ENABLE_WATCHDOG:
                Watchdog.setEnabled(activity, true);
                if (!ContainerService.isRunning()) ContainerService.start(activity);
                if (onFixed != null) onFixed.run();
                break;
            case ACTION_BATTERY_WHITELIST:
                try {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + activity.getPackageName()));
                    activity.startActivity(i);
                } catch (Throwable ignored) {
                    openAppDetails(activity);
                }
                break;
            case ACTION_EXACT_ALARM:
                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                        i.setData(Uri.parse("package:" + activity.getPackageName()));
                        activity.startActivity(i);
                        break;
                    } catch (Throwable ignored) {}
                }
                openAppDetails(activity);
                break;
            case ACTION_NOTIFICATION:
                try {
                    Intent i = new Intent();
                    if (Build.VERSION.SDK_INT >= 26) {
                        i.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                        i.putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
                    } else {
                        i.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.parse("package:" + activity.getPackageName()));
                    }
                    activity.startActivity(i);
                } catch (Throwable ignored) {
                    openAppDetails(activity);
                }
                break;
            case ACTION_APP_DETAILS:
                openAppDetails(activity);
                break;
            default:
                break;
        }
    }

    private static void openAppDetails(Activity activity) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(i);
        } catch (Throwable ignored) {}
    }
}
