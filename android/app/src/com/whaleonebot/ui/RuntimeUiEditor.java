package com.whaleonebot.ui;

import android.widget.*;

/** [layer: shell-android] 自定义运行端外部网页入口编辑器（全量改用 PromptSheet 统一主题样式）。 */
final class RuntimeUiEditor {
    final Screen page;
    final BotRegistry.Bot bot;

    RuntimeUiEditor(Screen page, BotRegistry.Bot bot) {
        this.page = page;
        this.bot = bot;
    }

    void show() {
        String[] items = new String[bot.runtimeUi.size() + 1];
        items[0] = "添加网页入口";
        for (int i = 1; i < items.length; i++) {
            RuntimeUiLink l = bot.runtimeUi.get(i - 1);
            items[i] = BotRegistry.PLATFORM_LABEL(l.platform) + " / " + l.label;
        }
        PromptSheet.choose(page.activity, page.t, "外部入口", items,
                i -> edit(i == 0 ? null : bot.runtimeUi.get(i - 1)),
                null, null, "关闭");
    }

    private EditText field(LinearLayout col, String label, String value) {
        TextView l = Ui.text(page.activity, label, Theme.T_CAP, page.t.textSecondary);
        LinearLayout.LayoutParams llp = Ui.llp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        llp.topMargin = page.dp(Theme.S2);
        col.addView(l, llp);

        EditText e = new EditText(page.activity);
        e.setId(android.view.View.generateViewId());
        l.setLabelFor(e.getId());
        e.setSingleLine(true);
        e.setTextColor(page.t.textPrimary);
        e.setHintTextColor(page.t.textTertiary);
        e.setBackground(Drawables.round(page.t.cardFill, page.t.cardStroke, page.dp(1), page.dp(Theme.R_BTN)));
        int hp = page.dp(Theme.S2);
        e.setPadding(hp, hp, hp, hp);
        e.setText(value);
        LinearLayout.LayoutParams elp = Ui.llp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        elp.topMargin = page.dp(Theme.S1);
        col.addView(e, elp);
        return e;
    }

    private void edit(RuntimeUiLink old) {
        LinearLayout col = Ui.column(page.activity);
        Spinner platform = new Spinner(page.activity);
        platform.setContentDescription("平台");
        platform.setAdapter(new ArrayAdapter<>(page.activity,
                android.R.layout.simple_spinner_dropdown_item, new String[]{"QQ", "B 站"}));
        platform.setSelection(old != null && "bilibili".equals(old.platform) ? 1 : 0);
        col.addView(platform);

        EditText name = field(col, "入口名称", old == null ? "" : old.label);
        EditText url = field(col, "HTTPS 网页地址", old == null ? "" : old.url);

        PromptSheet.custom(
                page.activity, page.t, "外部网页", col,
                "保存", (d, btn) -> {
                    RuntimeUiLink l = RuntimeUiLink.parse(
                            platform.getSelectedItemPosition() == 0 ? "qq" : "bilibili",
                            name.getText().toString().trim(),
                            url.getText().toString().trim());
                    if (l == null) {
                        url.setError("请输入名称和公开 HTTPS 地址，不含查询参数、端口或凭据");
                        return;
                    }
                    if (!BotRegistry.changeLink(bot, old, l)) {
                        page.host().toast("保存失败或入口已满");
                        return;
                    }
                    d.dismiss();
                    page.host().toast("入口已保存");
                },
                old == null ? null : "移除…",
                old == null ? null : (d, btn) -> {
                    d.dismiss();
                    PromptSheet.confirm(
                            page.activity, page.t, "移除此入口？", old.label + "\n" + old.url,
                            "移除", () -> page.host().toast(BotRegistry.changeLink(bot, old, null) ? "已移除" : "保存失败"),
                            null, null, "取消");
                },
                "取消", (d, btn) -> d.dismiss(),
                false, false, null, null);
    }
}
