package com.whaleonebot.ui;

import android.content.Intent;
import android.net.Uri;
import android.widget.*;
import static android.view.ViewGroup.LayoutParams.*;

/**
 * [layer: shell-android] 自定义运行端平台页（卡片化重构）。
 * A named HTTPS link is a browser handoff, not an in-app extension or a runtime command.
 */
final class CustomRuntimeScreen extends Screen {
    private final BotRegistry.Bot bot;
    private final String platform;

    CustomRuntimeScreen(AppShell shell, BotRegistry.Bot bot, String platform) {
        super(shell);
        this.bot = bot;
        this.platform = platform;
    }

    @Override
    void build() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        col.addView(header(bot.name), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 卡 1：绑定账号概览
        LinearLayout infoCard = Ui.addCard(col, activity, t, Theme.S3);
        LinearLayout head = Ui.row(activity);
        head.addView(Ui.strong(activity, BotRegistry.PLATFORM_LABEL(platform) + " 账号", Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        head.addView(Ui.pill(activity, t, "自定义运行端", Ui.TONE_NEUTRAL));
        infoCard.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        int count = 0;
        for (BotRegistry.Binding v : bot.bindings) {
            if (!v.platform.equals(platform)) continue;
            if (count > 0) infoCard.addView(Ui.divider(activity, t));
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = dp(Theme.S2);
            infoCard.addView(Ui.strong(activity, v.label(), Theme.T_BODY, t.textPrimary), lp);
            infoCard.addView(Ui.text(activity, v.detail(), Theme.T_CAP, t.textSecondary));
            count++;
        }
        if (count == 0) {
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            lp.topMargin = dp(Theme.S2);
            infoCard.addView(Ui.text(activity, "尚未配置该平台账号。", Theme.T_BODY, t.textSecondary), lp);
        }

        // 卡 2：外部网页入口与管理
        LinearLayout linksCard = Ui.addCard(col, activity, t, Theme.S3);
        linksCard.addView(Ui.strong(activity, "外部控制入口", Theme.T_CARD, t.textPrimary));
        int linkCount = 0;
        for (RuntimeUiLink l : bot.runtimeUi) {
            if (!l.platform.equals(platform)) continue;
            TextView go = Ui.button(activity, t, l.label, true);
            go.setMinimumHeight(dp(Theme.TOUCH));
            LinearLayout.LayoutParams glp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            glp.topMargin = dp(Theme.S2);
            linksCard.addView(go, glp);
            go.setOnClickListener(v -> PromptSheet.confirm(
                    activity, t, "在浏览器中打开？", l.url,
                    "打开", () -> {
                        try {
                            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(l.url))
                                    .addCategory(Intent.CATEGORY_BROWSABLE));
                        } catch (android.content.ActivityNotFoundException ex) {
                            host().toast("没有可用的浏览器");
                        }
                    },
                    null, null, "取消"));
            linkCount++;
        }
        if (linkCount == 0) {
            LinearLayout.LayoutParams nlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            nlp.topMargin = dp(Theme.S2);
            linksCard.addView(Ui.text(activity, "尚未配置外部网页入口，可在机器人详情页中添加。", Theme.T_CAP, t.textSecondary), nlp);
        }

        linksCard.addView(Ui.divider(activity, t));
        TextView bindings = Ui.button(activity, t, "管理账号绑定与入口", false);
        bindings.setMinimumHeight(dp(Theme.TOUCH));
        bindings.setOnClickListener(v -> shell.pushBot(bot.id));
        linksCard.addView(bindings, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }
}
