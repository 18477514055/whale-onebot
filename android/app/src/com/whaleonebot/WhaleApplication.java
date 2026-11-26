package com.whaleonebot;

import android.app.Application;
import android.os.SystemClock;

import com.whaleonebot.douyin.mobile.Desk;
import com.whaleonebot.douyin.mobile.MobileHost;
import com.whaleonebot.net.MirrorPrefs;
import com.whaleonebot.ui.DouyinSettings;

/**
 * [layer: shell-android] 应用级宿主：挂载统一国内镜像持久化、托管抖音审核台 {@link Desk} 单例
 * 以及来自 {@code ShareActivity} 的公开作品链接本地候选队列。
 */
public final class WhaleApplication extends Application implements MobileHost {

    private final Desk desk = new Desk(SystemClock::elapsedRealtime);

    @Override
    public void onCreate() {
        super.onCreate();
        MirrorPrefs.attach(this);
    }

    @Override
    public Desk douyinDesk() {
        return desk;
    }

    @Override
    public boolean ownerSessionUnlocked() {
        return true;
    }

    @Override
    public boolean enqueueCandidate(Desk.Slot slot, String candidate) {
        if (slot == null || candidate == null || candidate.trim().isEmpty()) return false;
        return DouyinSettings.enqueueCandidate(getFilesDir(), slot.botId, candidate.trim());
    }
}
