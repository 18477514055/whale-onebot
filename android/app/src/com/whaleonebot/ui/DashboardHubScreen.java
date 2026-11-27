package com.whaleonebot.ui;

import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 看板入口页：把运行端控制台里**只读观测**的那些面，做成这里的一列入口。
 *
 * <pre>
 *   主页 → QQ → 机器人 → 看板 → 总览 / 会话 / 调用 / 记忆 / 运维
 * </pre>
 *
 * <p>每个子页各自取数、各自失败；本页本身不发任何请求（打开即有内容，不受运行端状态影响）。
 */
final class DashboardHubScreen extends Screen {

    DashboardHubScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        root.removeAllViews();

        android.widget.ScrollView scroll = new android.widget.ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("运行看板"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 卡 1：实时观测与对账
        DashKit.Card c1 = DashKit.card(activity, t, "运行观测与对账", null);
        entry(c1.body, "总览与体检", "连接状态 · 心情精力 · 今日用量 · 存储占用", v -> shell.pushDashboard());
        DashKit.divider(activity, t, c1.body);
        entry(c1.body, "会话监控", "各群与私聊的活跃度及最近响应", v -> shell.pushChatMonitor());
        DashKit.divider(activity, t, c1.body);
        entry(c1.body, "调用明细", "单次模型推理上下文、耗时与工具调用", v -> shell.pushCallLog());
        DashKit.divider(activity, t, c1.body);
        entry(c1.body, "待对账与纠偏", "发送待确认 / 失败记录与二次确认补发", v -> shell.pushReconcile());
        DashKit.divider(activity, t, c1.body);
        entry(c1.body, "异常与主机状态", "系统异常告警 · 7 天用量趋势 · 运行体检", v -> shell.pushOps());
        col.addView(c1.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        // 卡 2：关系与待审记录
        DashKit.Card c2 = DashKit.card(activity, t, "关系与待审", null);
        entry(c2.body, "亲密度与心情", "熟人排行 · 互动事件记录 · 心情精力状态", v -> shell.pushIntimacy());
        DashKit.divider(activity, t, c2.body);
        entry(c2.body, "好友申请", "被动好友申请审核与处理记录", v -> shell.pushPeople());
        col.addView(c2.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
    }

    private void entry(LinearLayout parent, String title, String sub, View.OnClickListener click) {
        DashKit.row(activity, t, parent, title, sub, "", true, click);
    }
}
