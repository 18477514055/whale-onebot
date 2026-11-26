package com.whaleonebot.ui;

import android.app.Activity;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 页面基类。每个页面就是一个 FrameLayout，由 AppShell 挂进 pageHost。
 *
 * <p>注意：{@link #build()} 由 AppShell 在构造之后显式调用，
 * 不在构造函数里调 —— 否则子类的字段初始化会晚于 build()，刚建好的引用会被清掉。
 */
abstract class Screen {

    final AppShell shell;
    final Activity activity;
    final Theme t;
    final FrameLayout root;

    /** 子页标题下的远端设备状态小字（对齐 Q5/Q16：仅远程模式下显示）。 */
    private TextView remoteHeaderLabel;
    private LinearLayout remoteOfflineActions;

    Screen(AppShell shell) {
        this.shell = shell;
        this.activity = shell.activity;
        this.t = shell.theme;
        this.root = new FrameLayout(activity);
        root.setClipChildren(false);
        root.setClipToPadding(false);
    }

    /** 按当前令牌铺满本页内容。换主题后整页重建，颜色自然跟着走。 */
    abstract void build();

    /** 宿主每秒调一次；实现方必须逐项比对，值没变就别碰 View。 */
    void refresh() {
        refreshRemoteHeaderBadge();
    }

    /** 供切设备时拦截未保存表单（对齐 Q8）。 */
    boolean hasUnsavedChanges() {
        return false;
    }

    /** 挂上来时调一次（入场动画等）。 */
    void onAttach() {
    }

    /**
     * 页内返回：true 表示本页已经把这次返回消费掉了（例如运行端配置在「组页」里，
     * 返回应先退回它的列表页），AppShell 就不再出栈。
     *
     * <p>注意：页面<b>不要</b>在这里做整页入场动效 —— 那是 {@link Motion} 的事。
     */
    boolean handleBack() {
        return false;
    }

    AppShell.Host host() {
        return shell.host;
    }

    int dp(float v) {
        return Ui.dp(activity, v);
    }

    /**
     * 子页通用页头：左侧圆形返回钮 + 22sp 标题。
     * 控制远端设备时，在标题下方自动以小字标明当前远端设备名与连接状态（断线时附「立即重连 / 切回本机」快捷按钮）。
     */
    LinearLayout header(String title) {
        LinearLayout wrap = Ui.column(activity);

        LinearLayout row = Ui.row(activity);

        FrameLayout back = new FrameLayout(activity);
        back.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dp(1)));
        back.setClickable(true);
        back.setFocusable(true);
        IconView chev = new IconView(activity, IconView.CHEV_L, t.textPrimary);
        back.addView(chev, new FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER));
        back.setOnClickListener(new android.view.View.OnClickListener() {
            @Override
            public void onClick(android.view.View v) {
                shell.handleBack();
            }
        });
        Ui.press(back, 0.9f);

        LinearLayout.LayoutParams blp = Ui.llp(dp(Theme.TOUCH), dp(Theme.TOUCH));
        row.addView(back, blp);

        LinearLayout titleCol = Ui.column(activity);
        TextView tv = Ui.strong(activity, title, Theme.T_TITLE, t.textPrimary);
        titleCol.addView(tv, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        if (rm != null && rm.isRemote() && !(this instanceof RemoteDevicesScreen) && !(this instanceof QrScanScreen)) {
            remoteHeaderLabel = Ui.text(activity, "", Theme.T_CAP, t.accent);
            LinearLayout.LayoutParams rlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            rlp.topMargin = dp(2);
            titleCol.addView(remoteHeaderLabel, rlp);
        } else {
            remoteHeaderLabel = null;
        }

        LinearLayout.LayoutParams tlp = Ui.llp(0, WRAP_CONTENT);
        tlp.weight = 1f;
        tlp.leftMargin = dp(Theme.S3);
        row.addView(titleCol, tlp);

        wrap.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (remoteHeaderLabel != null) {
            remoteOfflineActions = Ui.row(activity);
            remoteOfflineActions.setPadding(dp(Theme.TOUCH + Theme.S3), dp(6), 0, 0);
            TextView retry = Ui.pill(activity, t, "立即重连", Ui.TONE_OK);
            retry.setClickable(true);
            retry.setOnClickListener(v -> {
                com.whaleonebot.remote.RemoteControlManager m = com.whaleonebot.remote.RemoteControlManager.peek();
                if (m != null && m.isRemote()) {
                    m.reconnectNow(m.activePeerId());
                    host().toast("正在重连远端设备…");
                }
            });
            TextView backLocal = Ui.pill(activity, t, "切回本机", Ui.TONE_NEUTRAL);
            backLocal.setClickable(true);
            backLocal.setOnClickListener(v -> shell.switchTargetDevice(null));
            LinearLayout.LayoutParams bl2 = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            bl2.leftMargin = dp(8);
            remoteOfflineActions.addView(retry, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
            remoteOfflineActions.addView(backLocal, bl2);
            remoteOfflineActions.setVisibility(android.view.View.GONE);
            wrap.addView(remoteOfflineActions, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            refreshRemoteHeaderBadge();
        } else {
            remoteOfflineActions = null;
        }

        wrap.setLayoutParams(new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return wrap;
    }

    final void refreshRemoteHeaderBadge() {
        if (remoteHeaderLabel == null) return;
        com.whaleonebot.remote.RemoteControlManager rm = com.whaleonebot.remote.RemoteControlManager.peek();
        if (rm == null || !rm.isRemote()) return;
        com.whaleonebot.remote.RemoteStore.PairedPeer peer = rm.activePeer();
        com.whaleonebot.remote.RemoteControlManager.PeerStatus st = rm.statusOf(rm.activePeerId());
        String name = peer == null ? "远端设备" : peer.displayName();
        boolean connected = st != null && st.state == com.whaleonebot.remote.RemoteControlManager.ConnState.CONNECTED;
        String txt = "远端：" + name + " · " + (st == null ? "连接中…" : st.summaryText());
        int warnColor = t.dark ? 0xFFF5B762 : 0xFFB45309;
        if (!txt.contentEquals(remoteHeaderLabel.getText())) {
            remoteHeaderLabel.setText(txt);
            remoteHeaderLabel.setTextColor(connected ? t.accent : warnColor);
        }
        if (remoteOfflineActions != null) {
            int want = connected ? android.view.View.GONE : android.view.View.VISIBLE;
            if (remoteOfflineActions.getVisibility() != want) remoteOfflineActions.setVisibility(want);
        }
    }
}
