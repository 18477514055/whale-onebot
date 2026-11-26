package com.whaleonebot.ui;

import android.view.View;
import android.widget.*;
import static android.view.ViewGroup.LayoutParams.*;

/** [layer: shell-android] 编辑机器人名下的账号与核心入口（全面卡片化，消除裸按钮与裸输入框）。 */
final class BotDetailScreen extends Screen {
    private final BotRegistry.Bot bot;
    private final String editorId;

    BotDetailScreen(AppShell shell, BotRegistry.Bot bot) { this(shell, bot, null); }
    BotDetailScreen(AppShell shell, BotRegistry.Bot bot, String editorId) {
        super(shell);
        this.bot = bot;
        this.editorId = editorId;
    }

    @Override
    void build() {
        root.removeAllViews();
        if (editorId != null && bot != null) {
            BotRegistry.Binding match = null;
            for (BotRegistry.Binding b : bot.bindings) if (b.id.equals(editorId)) match = b;
            if (editorId.isEmpty() || match != null) {
                new BindingEditor(this, bot, match).show();
                return;
            }
            root.addView(header("账号已移除"));
            return;
        }

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        col.addView(header(bot == null ? "找不到机器人" : bot.name));
        if (bot == null) return;

        // 卡 1：名称与归属核心摘要
        LinearLayout idCard = Ui.addCard(col, activity, t, Theme.S3);
        CoreInventory.Instance core = BotRegistry.coreForBot(bot.id);
        LinearLayout head = Ui.row(activity);
        head.addView(Ui.strong(activity, bot.name, Theme.T_CARD, t.textPrimary),
                new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        head.addView(Ui.pill(activity, t,
                BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind) ? "内置运行端" : "自定义运行端",
                Ui.TONE_OK));
        idCard.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        if (core != null) {
            idCard.addView(Ui.text(activity, Ui.coreMetaLine(core), Theme.T_CAP, t.textSecondary), topMargin(Theme.S1));
        }

        EditText name = new EditText(activity);
        name.setSingleLine(true);
        name.setContentDescription("机器人名称");
        Ui.styleInput(name, activity, t);
        name.setVisibility(View.GONE);
        idCard.addView(name, topMargin(Theme.S2));
        cardButton(idCard, "修改名称", false, v -> {
            if (name.getVisibility() != View.VISIBLE) {
                name.setText(bot.name);
                name.setVisibility(View.VISIBLE);
                name.requestFocus();
                name.selectAll();
                ((TextView) v).setText("保存名称");
                return;
            }
            String problem = BotRegistry.rename(bot.id, name.getText().toString());
            if (problem != null) { name.setError(problem); return; }
            build();
        });

        // 卡 2：账号绑定列表
        col.addView(sectionLabel("账号绑定"));
        LinearLayout bindCard = Ui.addCard(col, activity, t, Theme.S1);
        for (int i = 0; i < bot.bindings.size(); i++) {
            if (i > 0) bindCard.addView(Ui.divider(activity, t));
            final BotRegistry.Binding binding = bot.bindings.get(i);
            LinearLayout row = Ui.row(activity);
            row.setMinimumHeight(dp(Theme.TOUCH));
            row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));

            LinearLayout info = Ui.column(activity);
            info.addView(Ui.strong(activity, binding.label(), Theme.T_BODY, t.textPrimary));
            info.addView(Ui.text(activity, binding.detail() + (binding.localQQ() ? " · 查看状态" : " · 编辑"),
                    Theme.T_CAP, t.textSecondary), topMargin(4));
            row.addView(info, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
            row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
            row.setClickable(true);
            row.setFocusable(true);
            Ui.press(row, 0.985f);
            row.setOnClickListener(v -> {
                if (binding.localQQ()) shell.pushBotStart(bot.id);
                else if (binding.hostedBili()) shell.pushBiliAccounts(bot.id, "config");
                else edit(binding);
            });
            bindCard.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        bindCard.addView(Ui.divider(activity, t));
        cardButton(bindCard, "高级接入 · 外部 OneBot 服务", false, v -> edit(null));

        // 卡 3：配置与部件维护
        col.addView(sectionLabel("配置与部件维护"));
        LinearLayout ctrlCard = Ui.addCard(col, activity, t, Theme.S1);
        if (!BotRegistry.KIND_BUILTIN.equals(bot.runtimeKind)) {
            cardButton(ctrlCard, "管理外部网页入口", false, v -> new RuntimeUiEditor(this, bot).show());
        } else {
            cardButton(ctrlCard, "机器人行为与模型配置", true, v -> shell.pushBotConfig(bot.id));
            if (core != null && CoreManagerScreen.managed(core)) {
                for (String platform : core.platforms) {
                    if (!bot.platforms.contains(platform) && BotRegistry.PLATFORM_SUPPORTED(platform)) {
                        offerPlatform(ctrlCard, core, platform);
                    }
                }
                cardButton(ctrlCard, "核心与平台插件维护", false, v -> shell.corePage("instance", core.id));
            }
        }
    }

    private void offerPlatform(LinearLayout box, CoreInventory.Instance core, String platform) {
        final String label = BotRegistry.PLATFORM_LABEL(platform);
        cardButton(box, "添加 " + label + " 平台", false, v -> {
            TextView action = (TextView) v;
            Ui.enabled(action, false);
            action.setText("正在计算下载量…");
            new Thread(() -> {
                try {
                    com.whaleonebot.install.CoreInstaller ci = com.whaleonebot.install.CoreInstaller.open(activity);
                    String version = com.whaleonebot.install.CoreInstaller.release(activity.getFilesDir(), core.id);
                    long bytes = ci.addPlatformBytes(core.id, version, platform);
                    activity.runOnUiThread(() -> {
                        action.setText("保存并安装 " + label + " · " + Ui.formatBytes(bytes));
                        Ui.enabled(action, true);
                        action.setOnClickListener(w -> {
                            if (!BotRegistry.addPlatform(bot.id, core.id, platform)) {
                                host().toast("平台配置已变化，请返回重试");
                                return;
                            }
                            Ui.enabled(action, false);
                            action.setText("正在安装 " + label + "…");
                            new Thread(() -> {
                                boolean ok = false;
                                String err = "";
                                try {
                                    ok = ci.installAttachedPlatform(core.id, bot.id, version, platform, null);
                                } catch (Exception ex) {
                                    android.util.Log.w("WhaleEnv", "安装平台插件失败: " + platform, ex);
                                    err = CoreManagerScreen.safe(ex);
                                }
                                final boolean installed = ok;
                                final String reason = err;
                                activity.runOnUiThread(() -> {
                                    host().toast(installed ? "已安装 " + label
                                            : ("平台已保存，插件待重试：" + (reason.isEmpty() ? "请在平台插件中重试" : reason)));
                                    build();
                                });
                            }, "install-attached-platform").start();
                        });
                    });
                } catch (Exception e) {
                    activity.runOnUiThread(() -> {
                        action.setText("添加 " + label + " 平台");
                        Ui.enabled(action, true);
                        host().toast(CoreManagerScreen.safe(e));
                    });
                }
            }, "quote-platform").start();
        });
    }

    private void edit(BotRegistry.Binding v) { shell.externalAccount(bot.id, v == null ? null : v.id); }

    private TextView sectionLabel(String text) {
        TextView label = Ui.strong(activity, text, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S4);
        lp.bottomMargin = dp(Theme.S1);
        label.setLayoutParams(lp);
        return label;
    }

    private LinearLayout.LayoutParams topMargin(int dpVal) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(dpVal);
        return lp;
    }

    private void cardButton(LinearLayout box, String label, boolean primary, View.OnClickListener click) {
        TextView button = Ui.button(activity, t, label, primary);
        button.setMinimumHeight(dp(Theme.TOUCH));
        button.setOnClickListener(click);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S2);
        box.addView(button, lp);
    }
}
