package com.whaleonebot;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 看门狗闹钟的接收者：进程被杀后由系统唤醒，把容器服务重新拉起来。
 *
 * <p>见 {@link Watchdog} 的注释：这是补偿层，掩盖的根因是「厂商省电无视白名单杀进程」，
 * 删除条件是「白名单后连续 30 天不再被杀」。
 */
public class WatchdogReceiver extends BroadcastReceiver {
    private static final String TAG = "WhaleOneBot";

    @Override public void onReceive(Context context, Intent intent) {
        // 用户在设置里关掉了就什么都不做（也不重排）。
        if (!Watchdog.isEnabled(context)) return;
        // 先把下一次排上：即使下面拉起失败，闹钟也不能断。
        Watchdog.schedule(context);
        try {
            if (ContainerService.isRunning()) return;
            Log.i(TAG, "watchdog: 容器服务没在跑，重新拉起");
            ContainerService.start(context);
        } catch (Throwable t) {
            Log.e(TAG, "watchdog: 拉起失败", t);
        }
    }
}
