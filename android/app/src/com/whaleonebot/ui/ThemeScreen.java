package com.whaleonebot.ui;

import android.graphics.Typeface;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 主题页：六套渐变，点一下立刻应用到最底层背景（不重建背景层），并写进 SharedPreferences。
 * 另外可以把本地图片转存成背景 —— 图片之上仍叠加主题色的压暗层，文字永远读得清。
 */
final class ThemeScreen extends Screen {

    private TextView stateText;
    private TextView reset;

    ThemeScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("主题"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 注意：addView 不传 LayoutParams，否则会把标签自带的上下外边距覆盖掉
        col.addView(sectionLabel("渐变主题"));

        for (int i = 0; i < Theme.ALL.length; i++) {
            Theme item = Theme.ALL[i];
            boolean selected = item.id.equals(t.id);
            LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
            if (i > 0) lp.topMargin = dp(Theme.S2);
            col.addView(themeRow(item, selected), lp);
        }

        col.addView(sectionLabel("自定义背景"));

        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

        TextView pick = Ui.button(activity, t, "选择本地图片作为背景", false);
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pickImage();
            }
        });
        box.addView(pick, Ui.llp(MATCH_PARENT, dp(Theme.TOUCH)));

        reset = Ui.button(activity, t, "恢复默认渐变", false);
        reset.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.clearCustomBg();
                host().toast("已恢复渐变背景");
            }
        });
        LinearLayout.LayoutParams rlp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        rlp.topMargin = dp(Theme.S2);
        box.addView(reset, rlp);

        stateText = Ui.text(activity, "", Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams stlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        stlp.topMargin = dp(Theme.S3);
        box.addView(stateText, stlp);

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        col.addView(card, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView note = Ui.text(activity,
                "图片会复制到应用私有目录，之后不再依赖相册里的原件。",
                Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams nlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        nlp.topMargin = dp(Theme.S2);
        col.addView(note, nlp);

        refresh();
    }

    private TextView sectionLabel(String text) {
        TextView label = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(Theme.S4);
        lp.bottomMargin = dp(Theme.S2);
        label.setLayoutParams(lp);
        return label;
    }

    /** 一行主题：色卡 + 名字/描述 + 选中勾。选中态靠底色与勾，不靠切描边。 */
    private View themeRow(final Theme item, boolean selected) {
        int fill = selected ? Ui.alpha(t.accent, 0.14f) : t.cardFill;

        FrameLayout card = new FrameLayout(activity);
        card.setBackground(Drawables.round(fill, t.cardStroke, dp(1), dp(Theme.R_PANEL)));
        Ui.elevate(card, selected ? 3f : 1f, t);

        LinearLayout row = Ui.row(activity);
        row.setPadding(dp(Theme.S2), dp(Theme.S2), dp(Theme.S2 + 4), dp(Theme.S2));
        card.addView(row, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        GradientSwatch swatch = new GradientSwatch(activity, item, dp(Theme.R_TILE));
        row.addView(swatch, Ui.llp(dp(64), dp(48)));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = Ui.llp(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.leftMargin = dp(Theme.S3);
        blp.rightMargin = dp(Theme.S2);
        box.addView(Ui.strong(activity, item.name, Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView desc = Ui.text(activity, item.desc, Theme.T_CAP, t.textSecondary);
        LinearLayout.LayoutParams dlp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        dlp.topMargin = dp(4);
        box.addView(desc, dlp);
        row.addView(box, blp);

        IconView check = new IconView(activity, IconView.CHECK, selected ? t.accent : 0x00000000);
        check.setVisibility(selected ? View.VISIBLE : View.INVISIBLE);
        row.addView(check, Ui.llp(dp(22), dp(22)));

        card.setClickable(true);
        card.setFocusable(true);
        Ui.press(card, 0.985f);
        card.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!item.id.equals(shell.theme.id)) shell.useTheme(item.id);
            }
        });
        return card;
    }

    @Override
    void refresh() {
        boolean custom = shell.store.hasCustomBg();
        if (stateText != null) {
            String s = custom
                    ? "当前：本地图片，叠加「" + shell.theme.name + "」主题色"
                    : "当前：「" + shell.theme.name + "」渐变";
            if (!s.equals(stateText.getText().toString())) stateText.setText(s);
        }
        if (reset != null) Ui.enabled(reset, custom);
    }
}
