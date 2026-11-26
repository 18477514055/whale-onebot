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

        col.addView(header("看板"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "运行端只读观测", Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        DashKit.Card c = DashKit.card(activity, t, "看板", null);
        entry(c.body, "总览", "连接 · 心情 · 用量 · 存储",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushDashboard();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "会话", "每个群/私聊的活跃度与最近调用",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushChatMonitor();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "调用", "单次调用的注入与推理",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushCallLog();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "记忆", "群印象管理 · 最近的事 · 人物近况与转折",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushMemory();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "运维", "观测 · 异常 · 用量 · 技能",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushOps();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "亲密度与心情", "熟人榜 · 单人事件补记 · 心情精力调节",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushIntimacy();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "好友", "机器人认识的人与好友申请",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushPeople();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "控制", "协议端 · 主机 · 自更新 · 健康",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushControl();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "插件", "已装 · 目录 · 待处理",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushPlugins();
                    }
                });
        DashKit.divider(activity, t, c.body);
        entry(c.body, "待对账", "发送待确认 / 失败 · 解锁与重试",
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        shell.pushReconcile();
                    }
                });

        col.addView(c.view, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        TextView note = Ui.text(activity, "支持在「记忆」「亲密度与心情」「待对账」里进行快捷纠偏与微调，其余页面只读。",
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        col.addView(note, DashKit.mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
    }

    private void entry(LinearLayout parent, String title, String sub, View.OnClickListener click) {
        DashKit.row(activity, t, parent, title, sub, "", true, click);
    }
}
