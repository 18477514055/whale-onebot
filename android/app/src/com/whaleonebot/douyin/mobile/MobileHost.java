package com.whaleonebot.douyin.mobile;

/** Implement on the host Application, in the same process as the two activities. */
public interface MobileHost {
    Desk douyinDesk(); // singleton for process lifetime, Android SystemClock::elapsedRealtime
    boolean ownerSessionUnlocked(); // host authentication, not just a device unlock check
    /** Main thread. Only enqueue a local unverified candidate; never fetch, approve or send here. */
    boolean enqueueCandidate(Desk.Slot slot, String candidate);
}
