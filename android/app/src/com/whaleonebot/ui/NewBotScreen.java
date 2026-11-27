package com.whaleonebot.ui;

import android.view.View;
import android.widget.*;
import java.util.*;
import static android.view.ViewGroup.LayoutParams.*;

/**
 * [layer: shell-android] 新建机器人页（全面卡片化：表单卡 + 核心与平台卡，消除裸布局）。
 * Assignment is a single registry operation; install failures never free the assigned core.
 */
final class NewBotScreen extends Screen {
    NewBotScreen(AppShell shell) { super(shell); }

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
        col.addView(header("新建机器人"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        List<CoreInventory.Instance> free = new ArrayList<>();
        for (CoreInventory.Instance c : BotRegistry.cores()) if (c.ownerId.isEmpty()) free.add(c);
        if (free.isEmpty()) {
            LinearLayout emptyCard = Ui.addCard(col, activity, t, Theme.S3);
            emptyCard.addView(Ui.strong(activity, "当前没有空闲核心", Theme.T_CARD, t.textPrimary));
            emptyCard.addView(Ui.text(activity, "创建机器人需要先分配一份空闲核心。请先下载内置核心或接入自定义核心。",
                    Theme.T_BODY, t.textSecondary), topMargin(Theme.S2));
            TextView dl = Ui.button(activity, t, "去下载内置核心", true);
            dl.setOnClickListener(v -> shell.corePage("download", null));
            emptyCard.addView(dl, topMargin(Theme.S3));
            TextView go = Ui.button(activity, t, "返回本机核心管理", false);
            go.setOnClickListener(v -> shell.popTo(AppShell.P_BOTLIST));
            emptyCard.addView(go, topMargin(Theme.S2));
            return;
        }

        // 卡 1：身份与人设
        LinearLayout idCard = Ui.addCard(col, activity, t, Theme.S3);
        idCard.addView(Ui.strong(activity, "基本信息", Theme.T_CARD, t.textPrimary));
        EditText name = field(idCard, "机器人名称", "给机器人起个唯一名字", true);
        EditText persona = field(idCard, "人设提示词（选填）", "描述说话风格与角色设定，后续随时可改", false);

        // 卡 2：核心与平台
        LinearLayout coreCard = Ui.addCard(col, activity, t, Theme.S3);
        coreCard.addView(Ui.strong(activity, "分配核心与接入平台", Theme.T_CARD, t.textPrimary));
        label(coreCard, "选择空闲核心");
        Spinner cores = new Spinner(activity);
        String[] names = new String[free.size()];
        for (int i = 0; i < names.length; i++) names[i] = coreLabel(free.get(i));
        cores.setAdapter(new TintedAdapter(activity, names, t.textPrimary));
        cores.setContentDescription("空闲核心");
        cores.setBackground(Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        cores.setPadding(dp(Theme.S2), dp(8), dp(Theme.S2), dp(8));
        coreCard.addView(cores, topMargin(Theme.S1));

        coreCard.addView(Ui.divider(activity, t));
        label(coreCard, "勾选接入平台");
        LinearLayout checks = Ui.column(activity);
        coreCard.addView(checks, topMargin(Theme.S1));
        List<String> selected = new ArrayList<>();
        cores.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onNothingSelected(AdapterView<?> a) { }
            public void onItemSelected(AdapterView<?> a, View v, int pos, long id) {
                checks.removeAllViews();
                selected.clear();
                for (String platform : free.get(pos).platforms) {
                    CheckBox cb = new CheckBox(activity);
                    cb.setText(BotRegistry.PLATFORM_LABEL(platform));
                    cb.setTextColor(t.textPrimary);
                    cb.setMinHeight(dp(Theme.TOUCH));
                    cb.setOnCheckedChangeListener((view, on) -> {
                        if (on) selected.add(platform);
                        else selected.remove(platform);
                    });
                    checks.addView(cb);
                }
            }
        });

        TextView save = Ui.button(activity, t, "创建机器人", true);
        save.setMinimumHeight(dp(Theme.TOUCH));
        save.setOnClickListener(v -> {
            String n = name.getText().toString().trim();
            String problem = BotRegistry.nameProblem(n, null);
            if (problem != null) { name.setError(problem); return; }
            if (selected.isEmpty()) { host().toast("至少选择一个平台"); return; }
            CoreInventory.Instance c = free.get(cores.getSelectedItemPosition());
            BotRegistry.Bot bot = BotRegistry.createOnCore(c.id, n, persona.getText().toString(), new ArrayList<>(selected));
            if (bot == null) { host().toast("无法分配此核心，请刷新后重试"); return; }
            shell.setCurrentBotId(bot.id);
            try {
                if (activity instanceof BotConfigHost) {
                    BotConfigHost cfgHost = (BotConfigHost) activity;
                    String raw = cfgHost.loadConfigJson();
                    Object doc = (raw != null && !raw.trim().isEmpty())
                            ? BotConfigJson.parse(raw)
                            : new java.util.LinkedHashMap<String, Object>();
                    BotConfigJson.set(doc, "persona.botName", n);
                    String pText = persona.getText().toString().trim();
                    if (!pText.isEmpty()) BotConfigJson.set(doc, "persona.roleText", pText);
                    cfgHost.saveConfigJson(BotConfigJson.write(doc));
                }
            } catch (Throwable ignored) {}
            save.setEnabled(false);
            shell.popTo(AppShell.P_BOTLIST);
            if (BotRegistry.KIND_BUILTIN.equals(c.kind)) shell.corePage("plugins", c.id);
            else shell.pushBot(bot.id);
        });
        col.addView(save, topMargin(Theme.S3));
    }

    private void label(LinearLayout v, String s) {
        TextView l = Ui.strong(activity, s, Theme.T_BODY, t.textPrimary);
        v.addView(l, topMargin(Theme.S2));
    }

    private EditText field(LinearLayout v, String s, String hint, boolean single) {
        label(v, s);
        EditText e = new EditText(activity);
        e.setContentDescription(s);
        e.setHint(hint);
        e.setSingleLine(single);
        if (!single) e.setMinLines(2);
        Ui.styleInput(e, activity, t);
        v.addView(e, topMargin(Theme.S1));
        return e;
    }

    private LinearLayout.LayoutParams topMargin(int dpVal) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(dpVal);
        return lp;
    }

    private static String coreLabel(CoreInventory.Instance c) {
        return ("builtin".equals(c.kind) ? "内置核心" : "自定义核心") + " " + c.version + " · #" + Ui.coreShortId(c.id);
    }

    private static final class TintedAdapter extends ArrayAdapter<String> {
        private final int color;
        TintedAdapter(android.content.Context c, String[] items, int color) {
            super(c, android.R.layout.simple_spinner_dropdown_item, items);
            this.color = color;
        }
        @Override public View getView(int pos, View convert, android.view.ViewGroup parent) {
            TextView v = (TextView) super.getView(pos, convert, parent);
            v.setTextColor(color);
            return v;
        }
        @Override public View getDropDownView(int pos, View convert, android.view.ViewGroup parent) {
            TextView v = (TextView) super.getDropDownView(pos, convert, parent);
            v.setTextColor(color);
            return v;
        }
    }
}
