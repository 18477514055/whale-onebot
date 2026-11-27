package com.whaleonebot.ui;

import android.app.Activity;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 「模型库」独立页面：集中管理全部 OpenAI 兼容服务商、端点地址、API Key 与模型列表。
 * 配置完毕后，在「模型分配」页即可直接从本库为聊天、记忆整理、自动路由与备用池点选模型。
 */
final class ModelLibraryScreen extends Screen {

    private final BotConfigHost cfg;
    private ScrollView scrollView;
    private int savedScrollY = 0;
    private Object data;

    ModelLibraryScreen(AppShell shell, BotConfigHost host) {
        super(shell);
        this.cfg = host;
    }

    @Override
    void build() {
        root.removeAllViews();
        load();
        render();
    }

    @Override
    void onAttach() {
        super.onAttach();
        load();
        render();
    }

    private void load() {
        try {
            String raw = cfg == null ? null : cfg.loadConfigJson();
            data = (raw != null && !raw.trim().isEmpty()) ? BotConfigJson.parse(raw) : new LinkedHashMap<String, Object>();
        } catch (Throwable ignored) {
            data = new LinkedHashMap<String, Object>();
        }
    }

    private void render() {
        if (scrollView != null) savedScrollY = scrollView.getScrollY();
        root.removeAllViews();

        scrollView = new ScrollView(activity);
        scrollView.setFillViewport(true);
        scrollView.setClipChildren(false);
        scrollView.setVerticalScrollBarEnabled(false);
        root.addView(scrollView, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        int p = dp(Theme.S4);
        col.setPadding(p, dp(Theme.S3 + 4), p, p);
        scrollView.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("模型库"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        col.addView(Ui.text(activity,
                "集中管理模型服务商与 API Key（目前支持 OpenAI 兼容接口；OpenCode 渠道自动注入固定会话头）。",
                Theme.T_CAP, t.textSecondary), mt(dp(Theme.S1)));

        // 操作栏：从预设添加 / 新建自定义 / 前往模型分配
        LinearLayout actCard = Ui.addCard(col, activity, t, Theme.S3);
        TextView addPreset = Ui.button(activity, t, "＋ 从预设添加服务商（" + ModelPresets.all().length + " 家）", true);
        addPreset.setOnClickListener(v -> showPresetPicker());
        actCard.addView(addPreset, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout row2 = Ui.row(activity);
        TextView addCustom = Ui.button(activity, t, "＋ 自定义服务商", false);
        addCustom.setOnClickListener(v -> shell.pushProvider(null, null));
        TextView toAssign = Ui.button(activity, t, "前往模型分配 →", false);
        toAssign.setOnClickListener(v -> shell.pushModels());
        row2.addView(addCustom, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f);
        lp2.leftMargin = dp(Theme.S1);
        row2.addView(toAssign, lp2);
        actCard.addView(row2, mt(dp(Theme.S2)));

        // 已添加服务商列表
        List<Object> providers = BotConfigJson.asArray(BotConfigJson.get(data, "providers"));
        LinearLayout listCard = Ui.addCard(col, activity, t, Theme.S3);
        listCard.addView(Ui.strong(activity, "已配置服务商（" + (providers == null ? 0 : providers.size()) + "）",
                Theme.T_CARD, t.textPrimary));

        if (providers == null || providers.isEmpty()) {
            listCard.addView(Ui.text(activity, "模型库为空。点上方「从预设添加服务商」快速接入 DeepSeek、通义千问、智谱、Kimi、硅基流动或 OpenCode。",
                    Theme.T_CAP, t.textTertiary), mt(dp(Theme.S2)));
        } else {
            for (int i = 0; i < providers.size(); i++) {
                Map<String, Object> pv = BotConfigJson.asObject(providers.get(i));
                if (pv == null) continue;
                listCard.addView(Ui.divider(activity, t));
                final String pid = ModelsScreen.U.s(pv.get("id")).trim();
                String pname = ModelsScreen.U.s(pv.get("displayName")).trim();
                if (pname.isEmpty()) pname = ModelsScreen.U.s(pv.get("name")).trim();
                if (pname.isEmpty()) pname = pid;
                String baseUrl = ModelsScreen.U.providerBaseUrl(pv);
                List<Object> models = BotConfigJson.asArray(pv.get("models"));
                int mCount = models == null ? 0 : models.size();
                boolean hasKey = ModelsScreen.U.providerKeyPresent(data, pid);
                boolean isOpenCode = baseUrl.toLowerCase(java.util.Locale.US).contains("opencode.ai")
                        || pid.toLowerCase(java.util.Locale.US).contains("opencode");

                LinearLayout row = Ui.row(activity);
                row.setPadding(0, dp(Theme.S1), 0, dp(Theme.S1));
                row.setClickable(true);
                row.setOnClickListener(v -> shell.pushProvider(pid, null));

                LinearLayout txt = Ui.column(activity);
                LinearLayout head = Ui.row(activity);
                head.addView(Ui.strong(activity, pname, Theme.T_BODY, t.textPrimary), Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
                TextView pill = Ui.pill(activity, t, hasKey ? "Key 已配" : "未填 Key",
                        hasKey ? Ui.TONE_OK : Ui.TONE_WARN);
                LinearLayout.LayoutParams plp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
                plp.leftMargin = dp(8);
                head.addView(pill, plp);
                txt.addView(head, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

                String meta = ModelsScreen.U.hostOf(baseUrl) + " · " + mCount + " 个模型"
                        + (isOpenCode ? " · 自动会话头" : "");
                txt.addView(Ui.text(activity, meta, Theme.T_CAP, t.textSecondary), mt(dp(4)));
                row.addView(txt, new LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f));
                row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(18), dp(18)));
                listCard.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
        }

        final int y = savedScrollY;
        if (y > 0) scrollView.post(() -> { if (scrollView != null) scrollView.scrollTo(0, y); });
    }

    private void showPresetPicker() {
        ModelPresets.Provider[] all = ModelPresets.all();
        String[] labels = new String[all.length];
        String[] ids = new String[all.length];
        for (int i = 0; i < all.length; i++) {
            String note = (all[i].note != null && !all[i].note.isEmpty()) ? (" · " + all[i].note) : "";
            labels[i] = all[i].label + note;
            ids[i] = all[i].id;
        }
        ModelsScreen.W.chooseDialog(activity, t, "选择服务商预设", "选择后自动预填地址与常用模型，只需填 API Key",
                labels, ids, "", value -> {
                    if (value != null && !value.trim().isEmpty()) {
                        shell.pushProvider(null, value.trim());
                    }
                });
    }

    private LinearLayout.LayoutParams mt(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
