package com.whaleonebot.ui;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 「模型与 Key」总览页：模型角色 / 渠道（providers）/ 思考强度 / 高级。
 *
 * <p><b>职责边界</b>（合同 v1.3 §2 / §3）：本页只做**展示 + 少量就地编辑**，具体渠道与模型分别交给
 * {@link ProviderEditScreen} 与 {@link ModelPickerScreen}。
 *
 * <p><b>本页唯一会写的路径</b>（别的一律不碰，见合同 §0.2）：
 * <ul>
 *   <li>{@code api.thinking.*} —— 全局思考档位（聊天 / 记忆 / 其它）</li>
 *   <li>{@code api.thinkingByService.<host>.*} —— 按供应商（host）的档位覆盖</li>
 *   <li>{@code api.extraBody} —— 额外请求参数（多行 JSON，保存前校验；空 = 清成 {@code {}}）</li>
 *   <li>{@code api.baseUrl / api.model / api.provider / api.temperature / api.maxRounds /
 *       api.vision / api.timeoutMs / api.budget.enabled} —— 「聊天接口」卡（运行端分组「模型与接口」
 *       里原有一套，与本站重复；用户 2026-11-18 要求并成一页，路径一字不改）</li>
 *   <li>{@code asr.keys[槽].apiKey} / {@code tts.keys[服务id]} —— 「语音」卡的 Key（只写不读）</li>
 * </ul>
 *
 * <p><b>不写盘直到点「保存」</b>：进页面 {@code BotConfigJson.parse(loadConfigJson())} 得到内存 draft，
 * 所有改动只落在 draft 上；点保存才 {@code BotConfigJson.write(draft)} → {@code saveConfigJson(...)}。
 * 保存成功后本页**就地刷新**（不回退），另两页保存后回退。
 *
 * <p><b>为什么不用内嵌输入框</b>：输入框落在页内 {@code ScrollView} 子树里时，
 * 获得焦点会让 {@code ScrollView.requestChildRectangleOnScreen} 在后面某次布局里把页面滚回去
 * （本项目 {@code NewBotScreen} 踩过的「点输入框页面弹回顶部」）。所以本页所有输入都走**浮层**
 * （{@link W#textDialog}），页内一个 EditText 都没有，也就不需要递归找焦点。
 *
 * <p>本文件里还有两个同包共用的小部件（另两页直接引用，省掉三份重复）：
 * {@link U} 是**纯逻辑**（无 Android 依赖，可纯 JVM 探针直接跑），{@link W} 是自绘控件与浮层。
 * 两页的文件里不再各抄一份 JSON 读写与 Dialog 外壳，正是为了「Key 路径只有一种写法」。
 */
final class ModelsScreen extends Screen {

    /** 配置读写通道（宿主实现；MainActivity 就是）。 */
    private BotConfigHost cfg;

    private FrameLayout body;
    private FrameLayout saveBar;
    private TextView saveStatus;
    private TextView saveAction;
    private TextView discardAction;

    /** 内存 draft：整份 config.json 的对象树。 */
    private Object data;
    private boolean loaded;
    private String loadError;

    /** 已改但未保存的项（去重计数，只用于底部保存栏文案）。 */
    private final LinkedHashSet<String> dirty = new LinkedHashSet<String>();

    /** {@code api.extraBody} 的编辑文本；null = 这次没动过它。 */
    private String extraBodyText;

    /** 语音 Key：这次填过就在 draft 里了（值不回显），这两个只用于页面提示。 */
    private boolean asrKeyPending;
    private boolean ttsKeyPending;

    private boolean built;

    ModelsScreen(AppShell shell) {
        super(shell);
    }

    // ================================================================ 骨架

    @Override
    void build() {
        if (built) root.removeAllViews();
        built = true;

        body = new FrameLayout(activity);
        body.setClipChildren(false);
        body.setClipToPadding(false);
        root.addView(body, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        buildSaveBar();
        ensureLoaded();
        renderPage();
    }

    private void buildSaveBar() {
        saveBar = Ui.card(activity, t);
        LinearLayout inner = Ui.row(activity);
        inner.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        saveBar.addView(inner, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        LinearLayout statusBox = Ui.column(activity);
        LinearLayout.LayoutParams sbLp = Ui.llp(0, WRAP_CONTENT);
        sbLp.weight = 1f;
        sbLp.rightMargin = dp(Theme.S1);
        saveStatus = Ui.strong(activity, "没有未保存的改动", Theme.T_CAP, t.textPrimary);
        statusBox.addView(saveStatus, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView hint = Ui.text(activity, "点保存才写回 config.json", Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams hlLp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        hlLp.topMargin = dp(3);
        statusBox.addView(hint, hlLp);
        inner.addView(statusBox, sbLp);

        discardAction = Ui.button(activity, t, "放弃", false);
        discardAction.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (dirty.isEmpty()) return;
                dirty.clear();
                extraBodyText = null;
                reloadFromHost();
                W.toast(activity, "已放弃未保存的改动");
            }
        });
        inner.addView(discardAction, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        saveAction = Ui.button(activity, t, "保存", true);
        saveAction.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                doSave();
            }
        });
        LinearLayout.LayoutParams saveLp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        saveLp.leftMargin = dp(Theme.S1);
        inner.addView(saveAction, saveLp);

        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        barLp.leftMargin = dp(Theme.S3);
        barLp.rightMargin = dp(Theme.S3);
        barLp.bottomMargin = dp(Theme.S3);
        root.addView(saveBar, barLp);
    }

    // ================================================================ 载入

    private void ensureLoaded() {
        if (loaded || loadError != null) return;
        cfg = configHost();
        if (cfg == null) {
            loadError = "拿不到 config.json（宿主没提供通道）";
            return;
        }
        String txt;
        try {
            txt = cfg.loadConfigJson();
        } catch (Throwable th) {
            loadError = "读取配置时抛异常：" + describe(th);
            return;
        }
        if (txt == null || txt.trim().length() == 0) {
            loadError = "读不到 config.json（容器没起？）";
            return;
        }
        try {
            data = BotConfigJson.parse(txt);
        } catch (Throwable th) {
            loadError = "配置不是合法 JSON：" + describe(th);
            return;
        }
        if (BotConfigJson.asObject(data) == null) {
            loadError = "配置根节点不是对象，本面板不敢改它。";
            data = null;
            return;
        }
        loaded = true;
    }

    /** 重新从宿主读一遍（丢弃 draft 与全部未保存改动）。 */
    private void reloadFromHost() {
        loaded = false;
        loadError = null;
        data = null;
        extraBodyText = null;
        asrKeyPending = false;
        ttsKeyPending = false;
        ensureLoaded();
        renderPage();
    }

    /** 注意：不能叫 {@code host()} —— {@link Screen#host()} 是包内可见的方法，同名会「减弱访问权限」。 */
    private BotConfigHost configHost() {
        if (shell.activity instanceof BotConfigHost) return (BotConfigHost) shell.activity;
        return null;
    }

    private static String describe(Throwable th) {
        String m = th.getMessage();
        return th.getClass().getSimpleName() + (m == null || m.length() == 0 ? "" : ("：" + m));
    }

    // ================================================================ 渲染

    private ScrollView activeScroll;
    private int savedScrollY = 0;

    private void renderPage() {
        if (body == null) return;
        if (activeScroll != null) savedScrollY = activeScroll.getScrollY();
        View v = loaded ? page() : errorPage(loadError == null ? "配置尚未载入" : loadError);
        activeScroll = (v instanceof ScrollView) ? (ScrollView) v : null;
        body.removeAllViews();
        body.addView(v, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        refreshSaveBar();
        if (activeScroll != null && savedScrollY > 0) {
            final int y = savedScrollY;
            final ScrollView sv = activeScroll;
            sv.post(new Runnable() {
                @Override
                public void run() {
                    if (sv != null) sv.scrollTo(0, y);
                }
            });
        }
    }

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);

        col.addView(header("模型分配"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "从「模型库」为聊天、记忆整理、自动路由与语音分配模型和思考强度",
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams subLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        subLp.topMargin = dp(Theme.S1);
        col.addView(sub, subLp);

        col.addView(modelLibraryShortcutCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(roleCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(autoRouteCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(thinkingCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(chatApiCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(voiceCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(advancedCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        FrameLayout foot = Ui.card(activity, t);
        LinearLayout footBox = W.box(activity);
        foot.addView(footBox, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        TextView again = Ui.button(activity, t, "重新读取配置", false);
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (!dirty.isEmpty()) {
                    W.toast(activity, "先保存或放弃当前的改动");
                    return;
                }
                reloadFromHost();
            }
        });
        footBox.addView(again, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView footNote = Ui.text(activity,
                "只写改过的项",
                Theme.T_CAP, t.textTertiary);
        footNote.setLineSpacing(dp(3), 1f);
        footBox.addView(footNote, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(foot, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dirty.isEmpty() ? dp(Theme.S4) : dp(120));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    /** 一张「标题 + 说明 + 内容」的玻璃卡：view 进页面，body 往里加行。 */
    private static final class Card {
        final FrameLayout view;
        final LinearLayout body;

        Card(FrameLayout view, LinearLayout body) {
            this.view = view;
            this.body = body;
        }
    }

    private Card cardShell(String title, String subtitle) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary), Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        if (subtitle != null && subtitle.length() > 0) {
            TextView s = Ui.text(activity, subtitle, Theme.T_CAP, t.textSecondary);
            s.setLineSpacing(dp(2), 1f);
            box.addView(s, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));
        }
        LinearLayout holder = Ui.column(activity);
        box.addView(holder, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return new Card(card, holder);
    }

    // ---------------------------------------------------------------- 2.1 模型角色

    private View roleCard() {
        Card c = cardShell("模型角色",
                "点一行改用途的渠道和模型");
        LinearLayout holder = c.body;

        addRow(holder, "聊天主模型", roleValue(U.ROLE_CHAT), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_CHAT);
            }
        });
        holder.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        addRow(holder, "记忆整理", roleValue(U.ROLE_MEMORY), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_MEMORY);
            }
        });
        holder.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        addRow(holder, "图像生成", roleValue(U.ROLE_IMAGE), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_IMAGE);
            }
        });
        holder.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        addRow(holder, "语音识别", roleValue(U.ROLE_ASR), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_ASR);
            }
        });
        holder.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        addRow(holder, "语音合成", roleValue(U.ROLE_TTS), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_TTS);
            }
        });

        TextView note = Ui.text(activity,
                "视频不走模型",
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        holder.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    /** 角色行的「当前值」文案（合同 §2.1 的表格逐行照做）。 */
    private String roleValue(String role) {
        if (U.ROLE_CHAT.equals(role)) {
            String pid = U.s(BotConfigJson.get(data, "api.provider")).trim();
            String model = U.s(BotConfigJson.get(data, "api.model")).trim();
            if (pid.length() == 0 && model.length() == 0) return "未选择（手动模式）";
            return (pid.length() == 0 ? "手动模式" : U.providerName(data, pid))
                    + (model.length() == 0 ? " · 未选模型" : (" · " + model));
        }
        if (U.ROLE_MEMORY.equals(role)) {
            if (U.truthy(BotConfigJson.get(data, "memory.useChatModel"))) return "跟随聊天主模型";
            String pid = U.s(BotConfigJson.get(data, "memory.provider")).trim();
            String model = U.s(BotConfigJson.get(data, "memory.model")).trim();
            if (pid.length() == 0 && model.length() == 0) return "未选择";
            return (pid.length() == 0 ? "未选渠道" : U.providerName(data, pid))
                    + (model.length() == 0 ? " · 未选模型" : (" · " + model));
        }
        if (U.ROLE_IMAGE.equals(role)) {
            if (!U.truthy(BotConfigJson.get(data, "imageGen.enabled"))) return "未启用";
            String base = U.s(BotConfigJson.get(data, "imageGen.baseUrl")).trim();
            String model = U.s(BotConfigJson.get(data, "imageGen.model")).trim();
            String where = base.length() == 0 ? "跟聊天模型同域" : U.hostOf(base);
            return "已启用 · " + (where.length() == 0 ? "未填地址" : where)
                    + (model.length() == 0 ? " · 未选模型" : (" · " + model));
        }
        if (U.ROLE_ASR.equals(role)) {
            if (!U.truthy(BotConfigJson.get(data, "asr.enabled"))) return "未启用";
            String provider = U.s(BotConfigJson.get(data, "asr.provider")).trim();
            String model = U.s(BotConfigJson.get(data, "asr.model")).trim();
            return "已启用 · " + (provider.length() == 0 ? "未选服务" : U.asrLabel(provider))
                    + (model.length() == 0 ? " · 未选模型" : (" · " + model));
        }
        if (U.ROLE_TTS.equals(role)) {
            if (!U.truthy(BotConfigJson.get(data, "tts.enabled"))) return "未启用";
            String provider = U.s(BotConfigJson.get(data, "tts.provider")).trim();
            String model = U.s(BotConfigJson.get(data, "tts.model")).trim();
            return "已启用 · " + (provider.length() == 0 ? "未选服务" : U.ttsLabel(provider))
                    + (model.length() == 0 ? " · 未选模型" : (" · " + model));
        }
        return "未选择";
    }

    // ---------------------------------------------------------------- 2.2 渠道

    private View channelCard() {
        Card c = cardShell("渠道",
                "Key 只显示有没有，不显示内容");
        LinearLayout holder = c.body;

        List<Map<String, Object>> providers = U.providerList(data);
        if (providers.isEmpty()) {
            TextView empty = Ui.text(activity, "还没有渠道",
                    Theme.T_CAP, t.textTertiary);
            empty.setLineSpacing(dp(3), 1f);
            holder.addView(empty, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        String current = U.s(BotConfigJson.get(data, "api.provider")).trim();
        String memProvider = U.s(BotConfigJson.get(data, "memory.provider")).trim();
        for (int i = 0; i < providers.size(); i++) {
            final Map<String, Object> p = providers.get(i);
            final String id = U.s(p.get("id")).trim();
            if (i > 0) holder.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
            holder.addView(providerRow(p, id, current, memProvider), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        TextView fromPreset = Ui.button(activity, t, "＋ 从预置新建渠道", false);
        fromPreset.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showPresetPicker();
            }
        });
        holder.addView(fromPreset, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView blank = Ui.button(activity, t, "＋ 新建空白渠道", false);
        blank.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushProvider(null, null);
            }
        });
        holder.addView(blank, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        TextView note = Ui.text(activity,
                "OpenCode 会话头由运行端自动附加。",
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        holder.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    private View providerRow(Map<String, Object> p, final String id, String current, String memProvider) {
        LinearLayout row = Ui.row(activity);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(0, dp(8), 0, dp(8));
        row.setBackground(Drawables.stateful(
                Drawables.round(0, 0, 0, dp(Theme.R_TILE)),
                Drawables.round(Ui.alpha(t.textPrimary, 0.06f), 0, 0, dp(Theme.R_TILE))));

        LinearLayout txt = Ui.column(activity);
        LinearLayout.LayoutParams tlp = Ui.llp(0, WRAP_CONTENT);
        tlp.weight = 1f;
        row.addView(txt, tlp);

        String name = U.s(p.get("displayName")).trim();
        String detail = (U.hostOf(U.providerBaseUrl(p)).length() == 0
                ? "未填服务地址" : U.hostOf(U.providerBaseUrl(p)))
                + " · " + U.providerModels(p).size() + " 个模型"
                + ("anthropic".equalsIgnoreCase(U.s(p.get("api")).trim()) ? " · anthropic 接口" : "");
        txt.addView(Ui.text(activity, name.length() == 0 ? id : name, Theme.T_BODY, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView line = Ui.text(activity, detail, Theme.T_CAP, t.textSecondary);
        line.setLineSpacing(dp(2), 1f);
        txt.addView(line, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(3)));

        LinearLayout badgeRow = Ui.row(activity);
        if (id.length() > 0 && id.equals(current)) {
            badgeRow.addView(W.pill(activity, t, "使用中", true), Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        } else if (id.length() > 0 && id.equals(memProvider)) {
            badgeRow.addView(W.pill(activity, t, "记忆在用", false), marginLeft(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(6)));
        }
        boolean hasKey = U.providerKeyPresent(data, id);
        badgeRow.addView(W.pill(activity, t, hasKey ? "Key 已配置" : "Key 未配置", hasKey),
                marginLeft(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(6)));
        txt.addView(badgeRow, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(6)));

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushProvider(id, null);
            }
        });
        Ui.press(row, 0.985f);
        return row;
    }

    /** 预置渠道挑选：可搜索，选中直接进「新建渠道」页并预填。 */
    private void showPresetPicker() {
        final Dialog dlg = W.dialog(activity);
        if (dlg == null) return;

        LinearLayout box = W.box(activity);
        box.addView(W.title(activity, t, "从预置新建渠道"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView tip = W.note(activity, t, "选中后预填地址和模型，Key 在下一页填。"
                + "");
        LinearLayout.LayoutParams tipLp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        tipLp.topMargin = dp(6);
        box.addView(tip, tipLp);

        final EditText search = W.input(activity, t, InputType.TYPE_CLASS_TEXT, "搜索预置渠道（名字或 id）", false);
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        slp.topMargin = dp(Theme.S2);
        box.addView(search, slp);

        final ScrollView scroll = new ScrollView(activity);
        scroll.setVerticalScrollBarEnabled(false);
        final LinearLayout list = Ui.column(activity);
        scroll.addView(list, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        int maxH = (int) (activity.getResources().getDisplayMetrics().heightPixels * 0.52f);
        LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(MATCH_PARENT, maxH);
        llp.topMargin = dp(Theme.S2);
        box.addView(scroll, llp);

        final Runnable fill = new Runnable() {
            @Override
            public void run() {
                fillPresetList(list, search.getText() == null ? "" : search.getText().toString().trim(), dlg);
            }
        };
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                fill.run();
            }
        });
        fill.run();

        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
            }
        });
        LinearLayout.LayoutParams blp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        blp.topMargin = dp(Theme.S2);
        box.addView(cancel, blp);

        W.show(dlg, activity, t, box);
    }

    private void fillPresetList(LinearLayout list, String query, final Dialog dlg) {
        list.removeAllViews();
        String q = query == null ? "" : query.toLowerCase(Locale.US);
        ModelPresets.Provider[] all = ModelPresets.providers();
        int shown = 0;
        for (int i = 0; i < all.length; i++) {
            final ModelPresets.Provider p = all[i];
            if (p == null) continue;
            String hay = (p.label == null ? "" : p.label.toLowerCase(Locale.US)) + " "
                    + (p.id == null ? "" : p.id.toLowerCase(Locale.US));
            if (q.length() > 0 && hay.indexOf(q) < 0) continue;
            if (shown > 0) list.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
            list.addView(presetRow(p, dlg), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            shown++;
        }
        if (shown == 0) {
            TextView empty = Ui.text(activity, "没有匹配的预置渠道。", Theme.T_CAP, t.textTertiary);
            empty.setPadding(0, dp(Theme.S2), 0, dp(Theme.S2));
            list.addView(empty, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
    }

    private View presetRow(final ModelPresets.Provider p, final Dialog dlg) {
        LinearLayout row = Ui.row(activity);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(0, dp(8), 0, dp(8));
        row.setBackground(Drawables.stateful(
                Drawables.round(0, 0, 0, dp(Theme.R_TILE)),
                Drawables.round(Ui.alpha(t.textPrimary, 0.06f), 0, 0, dp(Theme.R_TILE))));

        LinearLayout txt = Ui.column(activity);
        LinearLayout.LayoutParams tlp = Ui.llp(0, WRAP_CONTENT);
        tlp.weight = 1f;
        row.addView(txt, tlp);
        txt.addView(Ui.text(activity, p.label == null ? p.id : p.label, Theme.T_BODY, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        String url = U.recommendedEndpoint(p);
        TextView line = Ui.text(activity, (url.length() == 0 ? "（无默认地址，需自己填）" : url)
                        + (p.sessionHeader != null && p.sessionHeader.length() > 0
                        ? " · 特殊头 " + p.sessionHeader + " 已内置" : ""),
                Theme.T_CAP, t.textSecondary);
        line.setLineSpacing(dp(2), 1f);
        txt.addView(line, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(3)));

        row.addView(new IconView(activity, IconView.CHEV_R, t.textTertiary), Ui.llp(dp(20), dp(20)));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
                shell.pushProvider(null, p.id);
            }
        });
        Ui.press(row, 0.985f);
        return row;
    }

    // ---------------------------------------------------------------- 2.3 聊天接口

    /**
     * 聊天主模型那一套「接口 + 采样」参数。
     *
     * <p>运行端分组「模型与接口」里本来就有一份一模一样的字段，用户嫌两处重复，
     * 2026-11-18 要求并到本页；读写路径与那一组逐字相同（{@code api.*}），本页是唯一入口。
     */
    private View chatApiCard() {
        Card c = cardShell("聊天接口", "点一行改一项");
        LinearLayout holder = c.body;

        addRow(holder, "接口地址", textValue("api.baseUrl", "未填"), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                editApiText("api.baseUrl", "接口地址", "OpenAI 兼容地址，通常填到 /v1", true);
            }
        });
        line(holder);
        addRow(holder, "模型 id", textValue("api.model", "未填"), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                editApiText("api.model", "模型 id", "原样发给服务商的 model 字段", false);
            }
        });
        line(holder);
        addRow(holder, "提供商 id", textValue("api.provider", "留空 = 按地址判断"),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        editApiText("api.provider", "提供商 id", "渠道目录里的 id，一般留空", false);
                    }
                });
        line(holder);
        addRow(holder, "随机性", U.numText(data, "api.temperature", "未填"), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                editApiNumber("api.temperature", "随机性", 0d, 2d, false, "0~2，越大越发散");
            }
        });
        line(holder);
        addRow(holder, "一轮最多工具调用", U.numText(data, "api.maxRounds", "未填"),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        editApiNumber("api.maxRounds", "一轮最多工具调用", 1d, 50d, true, "默认 12");
                    }
                });
        line(holder);
        holder.addView(W.switchRow(activity, t, "模型能看图", "默认开", flagValue("api.vision", true),
                new BotConfigToggle.OnChange() {
                    @Override
                    public void onChanged(boolean on) {
                        setFlag("api.vision", on);
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        line(holder);
        addRow(holder, "单次请求超时（毫秒）", U.numText(data, "api.timeoutMs", "未填"),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        editApiNumber("api.timeoutMs", "单次请求超时（毫秒）", 1000d, 600000d, true, "默认 60000");
                    }
                });
        line(holder);
        holder.addView(W.switchRow(activity, t, "预算开关", "防止大群意外超额扣费（推荐开启）",
                flagValue("api.budget.enabled", false), new BotConfigToggle.OnChange() {
                    @Override
                    public void onChanged(boolean on) {
                        setFlag("api.budget.enabled", on);
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        if (flagValue("api.budget.enabled", false)) {
            line(holder);
            addRow(holder, "每日预算上限（元）", U.numText(data, "api.budget.dailyYuan", "未填（默认 10 元）"),
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            editApiNumber("api.budget.dailyYuan", "每日预算上限（元）", 0.1d, 10000d, false,
                                    "当日估算花费达到此金额后触发超预算动作");
                        }
                    });
            line(holder);
            final String exceedCur = textValue("api.budget.onExceed", "pause");
            String exceedLabel = "warn".equals(exceedCur) ? "仅提醒继续聊"
                    : ("fallback".equals(exceedCur) ? "自动切换备用模型" : "暂停回复直到次日");
            addRow(holder, "超出预算后动作", exceedLabel, new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    W.chooseDialog(activity, t, "超出每日预算后做什么？", "达到每日预算上限时的保护策略",
                            new String[] { "暂停回复直到次日（最省钱）", "自动切换备用模型", "仅提醒，继续回复" },
                            new String[] { "pause", "fallback", "warn" },
                            exceedCur,
                            new W.TextCb() {
                                @Override
                                public void onText(String value) {
                                    U.putText(data, "api.budget.onExceed", value);
                                    dirty.add("api.budget.onExceed");
                                    renderPage();
                                }
                            });
                }
            });
        }
        line(holder);
        addRow(holder, "备用模型地址（故障/超预算兜底）", textValue("api.fallback.baseUrl", "未配置（可选）"),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        editApiText("api.fallback.baseUrl", "备用模型接口地址", "主模型出错或超预算时切换的 OpenAI 兼容地址", true);
                    }
                });
        line(holder);
        addRow(holder, "备用模型名", textValue("api.fallback.model", "未配置（可选）"),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        editApiText("api.fallback.model", "备用模型名", "例如 deepseek-chat / qwen-turbo", false);
                    }
                });
        line(holder);
        addRow(holder, "备用模型 Key",
                keyValue(U.s(BotConfigJson.get(data, "api.fallback.apiKey")).trim().length() > 0),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        W.textDialog(activity, t, "填写备用模型 API Key", "保存后写入，永不回显；留空则复用同渠道 Key",
                                "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false,
                                null, new W.TextCb() {
                                    @Override
                                    public void onText(String text) {
                                        U.putText(data, "api.fallback.apiKey", text);
                                        dirty.add("api.fallback.apiKey");
                                        renderPage();
                                    }
                                });
                    }
                });
        return c.view;
    }

    /** 读 {@code api.*} 的短值；空 = 用 empty。 */
    private String textValue(String path, String empty) {
        String v = U.s(BotConfigJson.get(data, path)).trim();
        return v.length() == 0 ? empty : v;
    }

    /** 读开关：键不存在时用 dflt（schema 里的默认值，免得把「默认开」显示成关）。 */
    private boolean flagValue(String path, boolean dflt) {
        Object v = BotConfigJson.get(data, path);
        if (v == BotConfigJson.MISSING || v == BotConfigJson.NULL) return dflt;
        return U.truthy(v);
    }

    private void setFlag(String path, boolean on) {
        U.putFlag(data, path, on);
        dirty.add(path);
        renderPage();
    }

    private void editApiText(final String path, String title, String tip, final boolean url) {
        W.textDialog(activity, t, title, tip, U.s(BotConfigJson.get(data, path)).trim(),
                url ? (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI)
                        : InputType.TYPE_CLASS_TEXT,
                false,
                new W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.length() == 0) return null; // 留空 = 清空
                        if (url && U.hostOf(text).length() == 0) return "看不懂这个地址：" + text;
                        if (!url && text.indexOf(' ') >= 0) return "不能带空格";
                        return null;
                    }
                },
                new W.TextCb() {
                    @Override
                    public void onText(String text) {
                        U.putText(data, path, text);
                        dirty.add(path);
                        renderPage();
                    }
                });
    }

    private void editApiNumber(final String path, String title, final double min, final double max,
                               final boolean integer, String tip) {
        W.textDialog(activity, t, title, tip, U.numText(data, path, ""),
                InputType.TYPE_CLASS_NUMBER | (integer ? 0 : InputType.TYPE_NUMBER_FLAG_DECIMAL),
                false,
                new W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.length() == 0) return "要填数字（不想改就点取消）";
                        double v;
                        try {
                            v = Double.parseDouble(text);
                        } catch (NumberFormatException e) {
                            return "要填数字";
                        }
                        if (Double.isNaN(v) || Double.isInfinite(v)) return "要填数字";
                        if (integer && v != Math.rint(v)) return "要填整数";
                        if (v < min || v > max) {
                            return "范围 " + BotConfigJson.pretty(min, 3)
                                    + " ~ " + BotConfigJson.pretty(max, 3);
                        }
                        return null;
                    }
                },
                new W.TextCb() {
                    @Override
                    public void onText(String text) {
                        double v = Double.parseDouble(text);
                        U.putNumber(data, path, integer ? (double) Math.round(v) : v);
                        dirty.add(path);
                        renderPage();
                    }
                });
    }

    // ---------------------------------------------------------------- 2.4 语音

    /**
     * 语音：识别 / 合成各一行摘要 + 各自的 Key。
     *
     * <p>服务表和槽位口径都在 {@link ModelPickerScreen}（那边有 8 条 ASR / 7 条 TTS 预设），
     * 本页只借它的表算摘要与 Key 落点，<b>不另造一份</b>；两条 Key 的写入仍走
     * {@link U#putAsrKey} / {@link U#putTtsKey}（三种形状的唯一实现）。
     */
    private View voiceCard() {
        Card c = cardShell("语音", "识别与合成分开配");
        LinearLayout holder = c.body;

        final String asrSlot = asrSlot();
        addRow(holder, "语音识别", U.voiceSummary(data, U.ROLE_ASR), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_ASR);
            }
        });
        // 本机 whisper 不要 Key，槽位为空时也没有可写的键 —— 这两种情况都不出这一行。
        if (asrSlot.length() > 0 && !"local".equalsIgnoreCase(asrSlot)) {
            line(holder);
            addRow(holder, "识别 Key", keyValue(U.asrKeyPresent(data, asrSlot)),
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            askVoiceKey(U.ROLE_ASR);
                        }
                    });
        }
        line(holder);
        addRow(holder, "语音合成", U.voiceSummary(data, U.ROLE_TTS), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelPicker(U.ROLE_TTS);
            }
        });
        line(holder);
        addRow(holder, "合成 Key", keyValue(U.ttsKeyPresent(data, ttsServiceId())),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        askVoiceKey(U.ROLE_TTS);
                    }
                });

        boolean pending = asrKeyPending || ttsKeyPending;
        TextView note = Ui.text(activity,
                pending ? "✓ 已输入新 Key（保存后写入，不回显）" : "Key 只写不读。",
                Theme.T_CAP, pending ? t.toneStrong : t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        holder.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    /** 模型库快捷入口卡：服务商与 API Key 独立集中管理，不与分配页混杂。 */
    private View modelLibraryShortcutCard() {
        List<Object> providers = BotConfigJson.asArray(BotConfigJson.get(data, "providers"));
        int pCount = providers == null ? 0 : providers.size();
        Card c = cardShell("模型库（服务商与密钥）", "已配置 " + pCount + " 家服务商 · 先在模型库配好渠道与 Key，再在下方按区域分配");
        LinearLayout holder = c.body;
        addRow(holder, "管理服务商与 API Key", "新增预设（含 OpenCode）/ 编辑 / 连通测试", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.pushModelLibrary();
            }
        });
        line(holder);
        // 一键解决「记忆整理复用聊天主模型并关闭思考」的高频需求
        boolean reuseChat = flagValue("memory.useChatModel", true);
        String memThink = textValue("api.thinking.memory", "未单独设");
        addRow(holder, "记忆整理快捷策略",
                reuseChat ? ("复用聊天主模型 · 思考：" + memThink) : ("使用专用模型（点此一键改为复用主模型并关思考）"),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        U.putFlag(data, "memory.useChatModel", true);
                        U.putText(data, "api.thinking.memory", "off");
                        dirty.add("memory.useChatModel");
                        dirty.add("api.thinking.memory");
                        W.toast(activity, "已设为：记忆整理复用聊天主模型并关闭思考（请点保存生效）");
                        renderPage();
                    }
                });
        return c.view;
    }

    /** 自动路由卡：场景分流（快模型 / 强模型）+ 有序故障降级池，全部直接从模型库点选。 */
    private View autoRouteCard() {
        Card c = cardShell("自动路由与故障降级池", "短聊走快模型，带图/长文/多工具走强模型；遇限流或报错沿备用池自动顺延");
        LinearLayout holder = c.body;

        boolean enabled = flagValue("api.routing.enabled", false);
        holder.addView(W.switchRow(activity, t, "启用自动路由", enabled ? "已开启场景分流与降级池" : "关闭时统一使用聊天主模型",
                enabled, new BotConfigToggle.OnChange() {
                    @Override
                    public void onChanged(boolean on) {
                        setFlag("api.routing.enabled", on);
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (enabled) {
            line(holder);
            addRow(holder, "快速日常模型（短聊/闲聊）", routeSlotSummary("api.routing.fast"),
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            pickModelFromLibrary("选择快速日常模型", "api.routing.fast");
                        }
                    });
            line(holder);
            addRow(holder, "强推理 / 多模态模型（带图/长文/工具）", routeSlotSummary("api.routing.strong"),
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            pickModelFromLibrary("选择强推理/多模态模型", "api.routing.strong");
                        }
                    });
            line(holder);
            List<Object> pool = BotConfigJson.asArray(BotConfigJson.get(data, "api.routing.pool"));
            int poolSize = pool == null ? 0 : pool.size();
            addRow(holder, "有序故障备用池（已选 " + poolSize + " 个）",
                    poolSize == 0 ? "点击从模型库添加备用候选" : summarizePool(pool),
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            manageRoutingPool();
                        }
                    });
        }
        return c.view;
    }

    private String routeSlotSummary(String prefix) {
        String p = textValue(prefix + ".provider", "");
        String m = textValue(prefix + ".model", "");
        String th = textValue(prefix + ".thinking", "");
        if (p.isEmpty() || m.isEmpty()) return "未指定（点击从模型库选择）";
        return p + " / " + m + (th.isEmpty() ? "" : (" · 思考:" + th));
    }

    private String summarizePool(List<Object> pool) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(pool.size(), 3); i++) {
            Map<String, Object> item = BotConfigJson.asObject(pool.get(i));
            if (item == null) continue;
            if (sb.length() > 0) sb.append(" → ");
            sb.append(U.s(item.get("model")));
        }
        if (pool.size() > 3) sb.append(" …共").append(pool.size()).append("个");
        return sb.toString();
    }

    /** 从手机已配置的「模型库」里列出全部 (服务商 / 模型) 供一键点选。 */
    private void pickModelFromLibrary(final String title, final String targetPrefix) {
        final List<String> labels = new ArrayList<String>();
        final List<String> vals = new ArrayList<String>();
        List<Object> providers = BotConfigJson.asArray(BotConfigJson.get(data, "providers"));
        if (providers != null) {
            for (int i = 0; i < providers.size(); i++) {
                Map<String, Object> pv = BotConfigJson.asObject(providers.get(i));
                if (pv == null) continue;
                String pid = U.s(pv.get("id")).trim();
                String pname = U.s(pv.get("displayName")).trim();
                if (pname.isEmpty()) pname = U.s(pv.get("name")).trim();
                if (pname.isEmpty()) pname = pid;
                List<Object> ms = BotConfigJson.asArray(pv.get("models"));
                if (ms == null) continue;
                for (int j = 0; j < ms.size(); j++) {
                    String mid = U.s(ms.get(j)).trim();
                    if (mid.isEmpty()) continue;
                    labels.add(pname + " · " + mid);
                    vals.add(pid + "||" + mid);
                }
            }
        }
        if (labels.isEmpty()) {
            W.toast(activity, "模型库中还没有模型，请先进入「模型库」添加服务商和模型");
            return;
        }
        W.chooseDialog(activity, t, title, "直接从手机「模型库」中选择",
                labels.toArray(new String[0]), vals.toArray(new String[0]), "",
                new W.TextCb() {
                    @Override
                    public void onText(String picked) {
                        if (picked == null || !picked.contains("||")) return;
                        String[] parts = picked.split("\\|\\|", 2);
                        final String pid = parts[0];
                        final String mid = parts[1];
                        W.chooseDialog(activity, t, "该区域思考强度", "可为当前模型单独设定思考强度",
                                new String[] { "跟随默认", "关闭思考 (off)", "低强度 (low)", "中强度 (medium)", "高强度 (high)" },
                                new String[] { "", "off", "low", "medium", "high" }, "",
                                new W.TextCb() {
                                    @Override
                                    public void onText(String th) {
                                        U.putText(data, targetPrefix + ".provider", pid);
                                        U.putText(data, targetPrefix + ".model", mid);
                                        U.putText(data, targetPrefix + ".thinking", th == null ? "" : th);
                                        dirty.add(targetPrefix);
                                        renderPage();
                                    }
                                });
                    }
                });
    }

    @SuppressWarnings("unchecked")
    private void manageRoutingPool() {
        List<Object> pool = BotConfigJson.asArray(BotConfigJson.get(data, "api.routing.pool"));
        final List<String> opts = new ArrayList<String>();
        final List<String> vals = new ArrayList<String>();
        opts.add("＋ 从模型库追加一个备用模型");
        vals.add("__add__");
        if (pool != null) {
            for (int i = 0; i < pool.size(); i++) {
                Map<String, Object> it = BotConfigJson.asObject(pool.get(i));
                if (it == null) continue;
                opts.add("移除 #" + (i + 1) + "：" + U.s(it.get("provider")) + " / " + U.s(it.get("model")));
                vals.add("del:" + i);
            }
        }
        W.chooseDialog(activity, t, "管理故障备用池", "主路由模型限流/超时/报错时按顺序顺延切换",
                opts.toArray(new String[0]), vals.toArray(new String[0]), "",
                new W.TextCb() {
                    @Override
                    public void onText(String act) {
                        if ("__add__".equals(act)) {
                            addModelToRoutingPool();
                        } else if (act != null && act.startsWith("del:")) {
                            int idx = Integer.parseInt(act.substring(4));
                            List<Object> cur = BotConfigJson.asArray(BotConfigJson.get(data, "api.routing.pool"));
                            if (cur != null && idx >= 0 && idx < cur.size()) {
                                cur.remove(idx);
                                dirty.add("api.routing.pool");
                                renderPage();
                            }
                        }
                    }
                });
    }

    @SuppressWarnings("unchecked")
    private void addModelToRoutingPool() {
        final List<String> labels = new ArrayList<String>();
        final List<String> vals = new ArrayList<String>();
        List<Object> providers = BotConfigJson.asArray(BotConfigJson.get(data, "providers"));
        if (providers != null) {
            for (int i = 0; i < providers.size(); i++) {
                Map<String, Object> pv = BotConfigJson.asObject(providers.get(i));
                if (pv == null) continue;
                String pid = U.s(pv.get("id")).trim();
                String pname = U.s(pv.get("displayName")).trim();
                if (pname.isEmpty()) pname = U.s(pv.get("name")).trim();
                if (pname.isEmpty()) pname = pid;
                List<Object> ms = BotConfigJson.asArray(pv.get("models"));
                if (ms == null) continue;
                for (int j = 0; j < ms.size(); j++) {
                    String mid = U.s(ms.get(j)).trim();
                    if (mid.isEmpty()) continue;
                    labels.add(pname + " · " + mid);
                    vals.add(pid + "||" + mid);
                }
            }
        }
        if (labels.isEmpty()) {
            W.toast(activity, "模型库为空，请先在「模型库」添加模型");
            return;
        }
        W.chooseDialog(activity, t, "追加备用模型", "从模型库勾选加入备用降级池末尾",
                labels.toArray(new String[0]), vals.toArray(new String[0]), "",
                new W.TextCb() {
                    @Override
                    public void onText(String picked) {
                        if (picked == null || !picked.contains("||")) return;
                        String[] parts = picked.split("\\|\\|", 2);
                        List<Object> cur = BotConfigJson.asArray(BotConfigJson.get(data, "api.routing.pool"));
                        if (cur == null) {
                            cur = new ArrayList<Object>();
                            BotConfigJson.set(data, "api.routing.pool", cur);
                        }
                        Map<String, Object> entry = new LinkedHashMap<String, Object>();
                        entry.put("provider", parts[0]);
                        entry.put("model", parts[1]);
                        cur.add(entry);
                        dirty.add("api.routing.pool");
                        renderPage();
                    }
                });
    }

    /** 原联网搜索卡已独立至 WebSearchScreen，此处仅保留 hasUnsavedChanges 契约。 */
    @Override
    boolean hasUnsavedChanges() {
        return !dirty.isEmpty() || asrKeyPending || ttsKeyPending;
    }

    /** ASR 凭据槽位（与 {@link ModelPickerScreen} 同一口径，不在这里重写一遍）。 */
    private String asrSlot() {
        return ModelPickerScreen.asrSlotOf(U.s(BotConfigJson.get(data, "asr.provider")).trim(),
                U.s(BotConfigJson.get(data, "asr.baseUrl")).trim());
    }

    /** TTS 的 Key 归属（先按地址认服务，认不出按 provider 回退，最后 custom）。 */
    private String ttsServiceId() {
        return ModelPickerScreen.ttsServiceIdOf(U.s(BotConfigJson.get(data, "tts.provider")).trim(),
                U.s(BotConfigJson.get(data, "tts.baseUrl")).trim());
    }

    private static String keyValue(boolean present) {
        return present ? "已配置（点这里替换）" : "未配置（点这里填写）";
    }

    private void askVoiceKey(final String role) {
        final boolean asr = U.ROLE_ASR.equals(role);
        W.textDialog(activity, t, asr ? "填写识别 Key" : "填写合成 Key",
                "保存后写入，永不回显",
                "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false,
                new W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.length() == 0) return "Key 不能为空（不想改就点取消）";
                        return null;
                    }
                },
                new W.TextCb() {
                    @Override
                    public void onText(String text) {
                        if (asr) {
                            String slot = asrSlot();
                            if (slot.length() == 0) {
                                W.toast(activity, "先选识别服务");
                                return;
                            }
                            U.putAsrKey(data, slot, text);
                            asrKeyPending = true;
                            dirty.add("asr.key");
                        } else {
                            U.putTtsKey(data, ttsServiceId(), text);
                            ttsKeyPending = true;
                            dirty.add("tts.key");
                        }
                        renderPage();
                    }
                });
    }

    // ---------------------------------------------------------------- 2.5 思考强度

    private View thinkingCard() {
        Card c = cardShell("思考强度",
                "点一行改档位");
        LinearLayout holder = c.body;

        String globalText = "聊天:" + U.levelLabel(U.thinkingIntent(data, null, "chat"))
                + " · 记忆:" + U.levelLabel(U.thinkingIntent(data, null, "memory"))
                + " · 其它:" + U.levelLabel(U.thinkingIntent(data, null, "default"));
        addRow(holder, "全局默认", globalText, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showThinkingDialog(null, "全局默认（所有渠道）", null);
            }
        });

        List<Map<String, Object>> providers = U.providerList(data);
        for (int i = 0; i < providers.size(); i++) {
            Map<String, Object> p = providers.get(i);
            String base = U.providerBaseUrl(p);
            final ModelPresets.Service svc = ModelPresets.serviceForBaseUrl(base);
            if (svc == null) continue; // 表外渠道：没有档位预设，不造一行假控件
            final String host = U.hostOf(base);
            if (host.length() == 0) continue;
            String name = U.s(p.get("displayName")).trim();
            String text = "聊天:" + U.levelLabel(U.thinkingIntent(data, host, "chat"))
                    + " · 记忆:" + U.levelLabel(U.thinkingIntent(data, host, "memory"));
            holder.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
            // 标题带上 host：两家渠道可能同一个 host（如 opencode / opencode-go 都是 opencode.ai），
            // 而档位是按 host 存的 —— 不写 host 会让用户以为这是两条互不相干的设置。
            addRow(holder, (name.length() == 0 ? host : name) + "（" + host + "）", text,
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            showThinkingDialog(host, host, svc);
                        }
                    });
        }

        TextView note = Ui.text(activity,
                "档位按渠道 + 用途存",
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        holder.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    /**
     * 档位浮层：一个用途一组胶囊，点一下就地生效（写进 draft），关掉浮层即刷新本页。
     *
     * @param host 空 = 写全局 {@code api.thinking}；非空 = 写 {@code api.thinkingByService[host]}
     */
    private void showThinkingDialog(final String host, String title, ModelPresets.Service svc) {
        final Dialog dlg = W.dialog(activity);
        if (dlg == null) return;

        LinearLayout box = W.box(activity);
        box.addView(W.title(activity, t, "思考强度 · " + title), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView intro = W.note(activity, t, host == null
                ? "所有渠道的默认档"
                : "「不干预」= 不发思考参数");
        LinearLayout.LayoutParams ilp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        ilp.topMargin = dp(6);
        box.addView(intro, ilp);

        String[] levels = levelsFor(svc);
        for (int i = 0; i < U.THINK_PURPOSES.length; i++) {
            box.addView(chipGroup(host, U.THINK_PURPOSES[i], levels),
                    marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        }

        TextView close = Ui.button(activity, t, "完成", true);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
            }
        });
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S3);
        box.addView(close, clp);

        W.show(dlg, activity, t, box);
        W.onDismiss(dlg, new W.After() {
            @Override
            public void run() {
                renderPage();
            }
        });
    }

    /** 一个用途的档位胶囊组（选中态就地重画，不关浮层）。 */
    private View chipGroup(final String host, final String purpose, String[] levels) {
        LinearLayout col = Ui.column(activity);
        TextView label = Ui.strong(activity, U.purposeLabel(purpose), Theme.T_CAP, t.textPrimary);
        col.addView(label, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        final String[] values = new String[levels.length + 1];
        values[0] = "on";
        System.arraycopy(levels, 0, values, 1, levels.length);
        final String cur = U.thinkingIntent(data, host, purpose);

        HorizontalScrollView hs = new HorizontalScrollView(activity);
        hs.setHorizontalScrollBarEnabled(false);
        final LinearLayout row = Ui.row(activity);
        final ArrayList<TextView> chips = new ArrayList<TextView>();
        for (int i = 0; i < values.length; i++) {
            final int at = i;
            TextView chip = Ui.text(activity, U.levelLabel(values[i]), Theme.T_CAP, t.textSecondary);
            chip.setGravity(Gravity.CENTER);
            chip.setMinHeight(dp(34));
            chip.setPadding(dp(Theme.S2), dp(6), dp(Theme.S2), dp(6));
            chips.add(chip);
            LinearLayout.LayoutParams lp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
            if (i > 0) lp.leftMargin = dp(6);
            row.addView(chip, lp);
            chip.setClickable(true);
            chip.setFocusable(true);
            Ui.press(chip, 0.94f);
            chip.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    String picked = values[at];
                    if (host == null || host.length() == 0) {
                        U.writeGlobalThinking(data, purpose, picked);
                    } else {
                        U.writeServiceThinking(data, host, purpose, picked);
                    }
                    dirty.add("think:" + (host == null ? "" : host) + ":" + purpose);
                    for (int k = 0; k < values.length; k++) {
                        W.paintChip(activity, t, chips.get(k), values[k].equals(picked));
                    }
                    refreshSaveBar();
                }
            });
        }
        hs.addView(row, new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
        col.addView(hs, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(6)));
        for (int k = 0; k < values.length; k++) W.paintChip(activity, t, chips.get(k), values[k].equals(cur));
        return col;
    }

    /** 该供应商允许的档位；表外渠道（svc 为空）退回 §0.3 的全局五档。 */
    private static String[] levelsFor(ModelPresets.Service svc) {
        if (svc != null && svc.uiLevels != null && svc.uiLevels.length > 0) return svc.uiLevels;
        return new String[]{"off", "low", "medium", "high", "max"};
    }

    // ---------------------------------------------------------------- 2.6 高级

    private View advancedCard() {
        Card c = cardShell("高级",
                "");
        LinearLayout holder = c.body;

        addRow(holder, "额外请求参数", extraBodySummary(), new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showExtraBodyDialog();
            }
        });
        TextView note1 = Ui.text(activity,
                "优先级最高，会覆盖同名字段。留空 = 清空。",
                Theme.T_CAP, t.textTertiary);
        note1.setLineSpacing(dp(3), 1f);
        holder.addView(note1, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        holder.addView(W.divider(activity, t), marginTop(Ui.llp(MATCH_PARENT, dp(1)), dp(Theme.S2)));
        addRow(holder, "档位映射（只读）", thinkingParamsSummary(),
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        showThinkingParamsDialog();
                    }
                });
        TextView note2 = Ui.text(activity,
                "暂不支持在手机上改",
                Theme.T_CAP, t.textTertiary);
        note2.setLineSpacing(dp(3), 1f);
        holder.addView(note2, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));
        return c.view;
    }

    private String extraBodySummary() {
        if (extraBodyText != null) {
            String t2 = extraBodyText.trim();
            if (t2.length() == 0) return "已改：保存后清成 {}";
            return "已改 · 待保存";
        }
        Map<String, Object> m = BotConfigJson.asObject(BotConfigJson.get(data, "api.extraBody"));
        if (m == null || m.isEmpty()) return "未设置";
        return m.size() + " 个字段";
    }

    private String thinkingParamsSummary() {
        Map<String, Object> m = BotConfigJson.asObject(BotConfigJson.get(data, "api.thinkingParams"));
        if (m == null || m.isEmpty()) return "未设置 · 只读";
        return m.size() + " 个档位 · 只读";
    }

    private void showExtraBodyDialog() {
        Object cur = BotConfigJson.get(data, "api.extraBody");
        String initial;
        if (extraBodyText != null) {
            initial = extraBodyText;
        } else {
            Map<String, Object> curMap = BotConfigJson.asObject(cur);
            initial = (curMap != null && !curMap.isEmpty()) ? BotConfigJson.write(cur) : "{}";
        }

        W.textDialog(activity, t, "额外请求参数",
                "整段 JSON。留空 = 清空；不合法不会保存。",
                initial, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE, true,
                new W.Check() {
                    @Override
                    public String check(String text) {
                        String body = text == null ? "" : text.trim();
                        if (body.length() == 0) return null; // 空 = 清成 {}
                        try {
                            Object v = BotConfigJson.parse(body);
                            if (BotConfigJson.asObject(v) == null) return "这里必须是一个 JSON 对象（以 { 开头）";
                        } catch (Throwable th) {
                            return "JSON 不合法：" + describe(th);
                        }
                        return null;
                    }
                },
                new W.TextCb() {
                    @Override
                    public void onText(String text) {
                        extraBodyText = text == null ? "" : text.trim();
                        dirty.add("extraBody");
                        renderPage();
                    }
                });
    }

    private void showThinkingParamsDialog() {
        Object cur = BotConfigJson.get(data, "api.thinkingParams");
        Map<String, Object> m = BotConfigJson.asObject(cur);
        String body = (m == null || m.isEmpty()) ? "（未设置）" : BotConfigJson.write(cur);
        W.infoDialog(activity, t, "表外渠道档位映射（只读）",
                body + "\n\n将思考档位映射为请求字段；内置预置渠道不受此项影响。");
    }

    // ---------------------------------------------------------------- 行工具

    private void addRow(LinearLayout parent, String title, String value, View.OnClickListener click) {
        parent.addView(W.row(activity, t, title, value, true, click), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
    }

    /** 卡片内的一条极细分隔线（与既有卡片同一写法）。 */
    private void line(LinearLayout parent) {
        parent.addView(W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
    }

    private static LinearLayout.LayoutParams marginTop(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    private static LinearLayout.LayoutParams marginLeft(LinearLayout.LayoutParams lp, int left) {
        lp.leftMargin = left;
        return lp;
    }

    // ================================================================ 保存

    private void doSave() {
        if (!loaded || data == null) {
            W.toast(activity, "配置还没有载入，先点「重新读取配置」");
            return;
        }
        if (dirty.isEmpty()) {
            W.toast(activity, "没有需要保存的改动");
            return;
        }

        // 1) 先在副本上改；extraBody 的 JSON 在这里再校验一次（校验失败绝不写回）。
        Object working = BotConfigJson.deepCopy(data);
        if (extraBodyText != null) {
            String bodyText = extraBodyText.trim();
            if (bodyText.length() == 0) {
                BotConfigJson.set(working, "api.extraBody", new LinkedHashMap<String, Object>());
            } else {
                try {
                    Object v = BotConfigJson.parse(bodyText);
                    if (BotConfigJson.asObject(v) == null) {
                        W.toast(activity, "额外请求参数必须是 JSON 对象，没有保存");
                        return;
                    }
                    BotConfigJson.set(working, "api.extraBody", v);
                } catch (Throwable th) {
                    W.toast(activity, "额外请求参数不是合法 JSON（" + describe(th) + "），没有保存");
                    return;
                }
            }
        }

        String json;
        try {
            json = BotConfigJson.write(working);
        } catch (Throwable th) {
            W.toast(activity, "序列化失败：" + describe(th));
            return;
        }

        boolean ok;
        try {
            ok = cfg.saveConfigJson(json);
        } catch (Throwable th) {
            ok = false;
        }
        if (!ok) {
            W.toast(activity, "保存失败，改动还在");
            return;
        }

        data = working;
        int n = dirty.size();
        dirty.clear();
        extraBodyText = null;
        asrKeyPending = false;
        ttsKeyPending = false;
        W.toast(activity, "已保存" + (n > 0 ? " " + n + " 项" : ""));
        renderPage();
    }

    private void refreshSaveBar() {
        if (saveBar == null) return;
        int n = dirty.size();
        saveBar.setVisibility(n > 0 ? View.VISIBLE : View.GONE);
        if (n == 0) return;
        String text = "有 " + n + " 项未保存";
        if (saveStatus != null && !text.equals(saveStatus.getText().toString())) saveStatus.setText(text);
        Ui.enabled(saveAction, loaded && n > 0);
        Ui.enabled(discardAction, n > 0);
    }

    // ================================================================ 错误页

    private View errorPage(String msg) {
        LinearLayout col = Ui.column(activity);
        col.addView(header("模型与 Key"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        box.addView(Ui.strong(activity, "读不到配置文件", Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView bodyTv = Ui.text(activity, msg, Theme.T_CAP, t.textSecondary);
        bodyTv.setLineSpacing(dp(4), 1f);
        box.addView(bodyTv, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView retry = Ui.button(activity, t, "重新读取", true);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                reloadFromHost();
            }
        });
        box.addView(retry, marginTop(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(Theme.S3)));
        TextView tip = Ui.text(activity,
                "读不到 config.json。"
                        + "",
                Theme.T_CAP, t.textTertiary);
        tip.setLineSpacing(dp(3), 1f);
        box.addView(tip, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(card, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    // ================================================================ 纯逻辑 U

    /**
     * 三个页面共用的<b>纯逻辑</b>：JSON 路径读写 + 「Key 存哪」的唯一写法。
     *
     * <p>为什么单独拎出来：①Key 的落点容易写错（{@code providerKeys} 是顶层、{@code tts.keys} 是字符串、
     * {@code asr.keys} 是对象、{@code imageGen.keys} 按主机名），只有一处实现就不会三页各写一版；
     * ②它<b>不碰任何 Android 类</b>，所以能在纯 JVM 探针里直接跑（见交付说明的自检脚本），
     * 拿真的 config 树验证「写进去的路径对不对、别的键动没动」。
     */
    static final class U {

        static final String ROLE_CHAT = "chat";
        static final String ROLE_MEMORY = "memory";
        static final String ROLE_IMAGE = "image";
        static final String ROLE_ASR = "asr";
        static final String ROLE_TTS = "tts";

        /** 思考强度的三个用途键：chat / memory / default（后者 = 「其它用途」的兜底）。 */
        static final String[] THINK_PURPOSES = {"chat", "memory", "default"};

        private U() {
        }

        // ---------------------------------------------------------- 标量

        /** JSON 标量 → 文本；{@code MISSING}/{@code NULL}/null 一律空串（面板从不把 null 当值）。 */
        static String s(Object v) {
            if (v == null || v == BotConfigJson.MISSING || v == BotConfigJson.NULL) return "";
            if (v instanceof String) return (String) v;
            if (v instanceof Boolean) return ((Boolean) v).booleanValue() ? "true" : "false";
            return String.valueOf(v);
        }

        static boolean truthy(Object v) {
            if (v instanceof Boolean) return ((Boolean) v).booleanValue();
            String t = s(v).trim().toLowerCase(Locale.US);
            return "true".equals(t) || "1".equals(t) || "yes".equals(t) || "on".equals(t);
        }

        static String roleLabel(String role) {
            if (ROLE_CHAT.equals(role)) return "聊天主模型";
            if (ROLE_MEMORY.equals(role)) return "记忆整理";
            if (ROLE_IMAGE.equals(role)) return "图像生成";
            if (ROLE_ASR.equals(role)) return "语音识别";
            if (ROLE_TTS.equals(role)) return "语音合成";
            return role == null ? "" : role;
        }

        static String purposeLabel(String purpose) {
            if ("chat".equals(purpose)) return "聊天";
            if ("memory".equals(purpose)) return "记忆整理";
            return "其它用途（default）";
        }

        static String levelLabel(String level) {
            String v = level == null ? "" : level.trim().toLowerCase(Locale.US);
            if ("on".equals(v)) return "不干预";
            if ("off".equals(v)) return "关闭";
            if ("low".equals(v)) return "低";
            if ("medium".equals(v)) return "中";
            if ("high".equals(v)) return "高";
            if ("xhigh".equals(v)) return "超高";
            if ("max".equals(v)) return "最高";
            return v.length() == 0 ? "不干预" : v;
        }

        // ---------------------------------------------------------- 容器

        static Map<String, Object> map(Object root, String path) {
            return BotConfigJson.asObject(BotConfigJson.get(root, path));
        }

        static List<Object> list(Object root, String path) {
            return BotConfigJson.asArray(BotConfigJson.get(root, path));
        }

        static Map<String, Object> mapCreate(Object root, String path) {
            Map<String, Object> m = map(root, path);
            if (m == null) {
                m = new LinkedHashMap<String, Object>();
                BotConfigJson.set(root, path, m);
            }
            return m;
        }

        static Object mapGet(Object root, String mapPath, String key) {
            Map<String, Object> m = map(root, mapPath);
            if (m == null || key == null || key.length() == 0) return BotConfigJson.MISSING;
            return m.containsKey(key) ? m.get(key) : BotConfigJson.MISSING;
        }

        /**
         * 写映射里的一项。
         *
         * <p><b>为什么不用 {@code BotConfigJson.set(root, "tts.keys." + id)}</b>：映射的键可能是主机名
         * （{@code api.siliconflow.cn}）或 {@code openai|host}，点号会被当成分层级，
         * 把一条 Key 写成嵌套对象。这里按「取映射 → put(键, 值)」走，键里有什么字符都不影响。
         */
        static void mapPut(Object root, String mapPath, String key, Object value) {
            if (key == null || key.length() == 0) return;
            mapCreate(root, mapPath).put(key, value);
        }

        static void mapRemove(Object root, String mapPath, String key) {
            Map<String, Object> m = map(root, mapPath);
            if (m != null && key != null) m.remove(key);
        }

        /** URL → 主机名（小写；去协议 / userinfo / 端口 / 路径 / 查询）。非法输入返回空串。 */
        static String hostOf(String url) {
            String s = url == null ? "" : url.trim();
            if (s.length() == 0) return "";
            int p = s.indexOf("://");
            String rest = p >= 0 ? s.substring(p + 3) : s;
            int slash = rest.indexOf('/');
            if (slash >= 0) rest = rest.substring(0, slash);
            int q = rest.indexOf('?');
            if (q >= 0) rest = rest.substring(0, q);
            int at = rest.lastIndexOf('@');
            if (at >= 0) rest = rest.substring(at + 1);
            int colon = rest.indexOf(':');
            if (colon >= 0) rest = rest.substring(0, colon);
            return rest.toLowerCase(Locale.US);
        }

        // ---------------------------------------------------------- providers[]

        static List<Map<String, Object>> providerList(Object root) {
            ArrayList<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
            List<Object> arr = list(root, "providers");
            if (arr == null) return out;
            for (int i = 0; i < arr.size(); i++) {
                Map<String, Object> p = BotConfigJson.asObject(arr.get(i));
                if (p != null) out.add(p);
            }
            return out;
        }

        static Map<String, Object> providerById(Object root, String id) {
            if (id == null || id.length() == 0) return null;
            List<Map<String, Object>> all = providerList(root);
            for (int i = 0; i < all.size(); i++) {
                if (id.equals(s(all.get(i).get("id")).trim())) return all.get(i);
            }
            return null;
        }

        /**
         * 运行端控制台端口：从 config.json 文本里取 {@code "server"} 之后第一个 {@code "port"}。
         *
         * <p>为什么用正则而不是走解析树：调用方（看板）可能拿到的是**原始文本**，
         * 而 {@code server.port} 在 JSON 里永远是数字字面量，正则足够且不会因为配置里别处的
         * port（wsPort / 端口列表）误命中 —— 先定位 {@code "server"} 再往后找第一个。
         *
         * @return 1~65535 的端口；找不到返回 0（调用方自己退回默认值）
         */
        static int consolePortOf(String json) {
            if (json == null) return 0;
            try {
                int at = json.indexOf("\"server\"");
                if (at < 0) return 0;
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("\"port\"\\s*:\\s*(\\d{1,5})").matcher(json);
                m.region(at, json.length());
                if (!m.find()) return 0;
                int port = Integer.parseInt(m.group(1));
                return (port > 0 && port < 65536) ? port : 0;
            } catch (Throwable ignored) {
                return 0;
            }
        }

        /** 渠道显示名；没有就用 id（不返回 null，也绝不返回 Key）。 */
        static String providerName(Object root, String id) {
            Map<String, Object> p = providerById(root, id);
            if (p == null) return id == null ? "" : id;
            String name = s(p.get("displayName")).trim();
            return name.length() == 0 ? (id == null ? "" : id) : name;
        }

        static String providerBaseUrl(Map<String, Object> p) {
            return p == null ? "" : s(p.get("baseURL")).trim();
        }

        static List<String> providerModels(Map<String, Object> p) {
            ArrayList<String> out = new ArrayList<String>();
            if (p == null) return out;
            List<Object> arr = BotConfigJson.asArray(p.get("models"));
            if (arr == null) return out;
            for (int i = 0; i < arr.size(); i++) {
                String m = s(arr.get(i)).trim();
                if (m.length() > 0) out.add(m);
            }
            return out;
        }

        /**
         * 这个渠道「有没有存过 Key」—— 只回布尔，<b>从不回内容</b>。
         *
         * <p>判定口径与运行端一致：顶层 {@code providerKeys[id]} 优先，其次旧配置内联的
         * {@code providers[].apiKey}（{@code src/llm/llm.js} 的 resolveApiKey 同款顺序）。
         */
        static boolean providerKeyPresent(Object root, String id) {
            if (s(mapGet(root, "providerKeys", id)).trim().length() > 0) return true;
            Map<String, Object> p = providerById(root, id);
            return p != null && s(p.get("apiKey")).trim().length() > 0;
        }

        static String recommendedEndpoint(ModelPresets.Provider p) {
            if (p == null || p.endpoints == null) return "";
            for (int i = 0; i < p.endpoints.length; i++) {
                if (p.endpoints[i] != null && p.endpoints[i].recommended
                        && p.endpoints[i].baseUrl != null && p.endpoints[i].baseUrl.trim().length() > 0) {
                    return p.endpoints[i].baseUrl.trim();
                }
            }
            for (int i = 0; i < p.endpoints.length; i++) {
                if (p.endpoints[i] != null && p.endpoints[i].baseUrl != null
                        && p.endpoints[i].baseUrl.trim().length() > 0) {
                    return p.endpoints[i].baseUrl.trim();
                }
            }
            return "";
        }

        // ---------------------------------------------------------- Key 落点（三种形状，别混）

        /** 渠道 Key：顶层 {@code providerKeys[id]} = 字符串（首选；运行端 resolveApiKey 第一条）。 */
        static void setProviderKey(Object root, String providerId, String key) {
            mapPut(root, "providerKeys", providerId, key == null ? "" : key);
        }

        /** ★ TTS 的 Key 是 {@code tts.keys[服务id]} = <b>字符串</b>（不是对象）。 */
        static void putTtsKey(Object root, String keyId, String key) {
            mapPut(root, "tts.keys", keyId, key == null ? "" : key);
        }

        /**
         * ★ ASR 的 Key 是 {@code asr.keys[槽位]} = <b>对象</b> {@code {apiKey: "..."}}。
         *
         * <p>槽位口径（{@code src/core/config-legacy.js} 的 asrCredentialSlot）：
         * OpenAI 兼容 = {@code openai|主机名}，其它服务 = {@code provider} 名。
         * 写成字符串会被运行端当成「垃圾条目」归一成 {@code {}}（Key 就丢了）。
         */
        static void putAsrKey(Object root, String slot, String key) {
            if (slot == null || slot.length() == 0) return;
            Map<String, Object> old = BotConfigJson.asObject(mapGet(root, "asr.keys", slot));
            LinkedHashMap<String, Object> next = new LinkedHashMap<String, Object>();
            if (old != null) next.putAll(old);
            next.put("apiKey", key == null ? "" : key);
            mapPut(root, "asr.keys", slot, next);
        }

        /** 图片生成的 Key 按<b>主机名</b>存：{@code imageGen.keys[host]} = 字符串。 */
        static void putImageKey(Object root, String host, String key) {
            mapPut(root, "imageGen.keys", host, key == null ? "" : key);
        }

        static boolean ttsKeyPresent(Object root, String keyId) {
            if (s(mapGet(root, "tts.keys", keyId)).trim().length() > 0) return true;
            return s(BotConfigJson.get(root, "tts.apiKey")).trim().length() > 0;
        }

        static boolean asrKeyPresent(Object root, String slot) {
            Map<String, Object> entry = BotConfigJson.asObject(mapGet(root, "asr.keys", slot));
            if (entry != null && s(entry.get("apiKey")).trim().length() > 0) return true;
            return s(BotConfigJson.get(root, "asr.apiKey")).trim().length() > 0;
        }

        static boolean imageKeyPresent(Object root, String host) {
            if (s(mapGet(root, "imageGen.keys", host)).trim().length() > 0) return true;
            return s(BotConfigJson.get(root, "imageGen.apiKey")).trim().length() > 0;
        }

        // ---------------------------------------------------------- 聊天接口标量（原「模型与接口」组）

        /** 写文本：{@code api.baseUrl} 这类；null 写成空串（清空）。 */
        static void putText(Object root, String path, String text) {
            BotConfigJson.set(root, path, text == null ? "" : text);
        }

        /** 写开关：{@code api.vision} / {@code api.budget.enabled}。 */
        static void putFlag(Object root, String path, boolean on) {
            BotConfigJson.set(root, path, Boolean.valueOf(on));
        }

        /**
         * 写数字：整数照整数写、小数用最短十进制（{@code 0.8} 不会变成 {@code 0.8000000000000001}）。
         *
         * <p>存成 {@link BotConfigJson.Num}（原始字面量）而不是 {@code Double}：写回时逐字照抄，
         * 也跟运行端「数字就是数字」的读法一致。
         */
        static void putNumber(Object root, String path, double v) {
            BotConfigJson.set(root, path, new BotConfigJson.Num(BotConfigJson.numberText(v)));
        }

        /** 读数字给人看：整数不带 .0、小数最多三位；缺失用 {@code empty}。 */
        static String numText(Object root, String path, String empty) {
            Object v = BotConfigJson.get(root, path);
            if (v == null || v == BotConfigJson.MISSING || v == BotConfigJson.NULL) return empty;
            double d = BotConfigJson.numOf(v);
            if (Double.isNaN(d)) {
                String raw = s(v).trim();
                return raw.length() == 0 ? empty : raw;
            }
            return BotConfigJson.pretty(d, 3);
        }

        // ---------------------------------------------------------- 语音（ASR / TTS）摘要

        /**
         * 语音一行摘要：{@code 未启用} / {@code 已启用 · 服务 · 模型}。
         *
         * <p>服务名优先按<b>地址主机名</b>认（{@link ModelPickerScreen#ASR_SERVICES} 那两张表，
         * 与选取页同一份），认不出才退回 provider 名 —— 本页不另造服务表。
         */
        static String voiceSummary(Object root, String role) {
            String prefix = ROLE_ASR.equals(role) ? "asr" : "tts";
            if (!truthy(BotConfigJson.get(root, prefix + ".enabled"))) return "未启用";
            String provider = s(BotConfigJson.get(root, prefix + ".provider")).trim();
            String baseUrl = s(BotConfigJson.get(root, prefix + ".baseUrl")).trim();
            String model = s(BotConfigJson.get(root, prefix + ".model")).trim();
            return "已启用 · " + voiceServiceName(role, provider, baseUrl)
                    + (model.length() == 0 ? " · 未选模型" : (" · " + model));
        }

        /** 语音服务短名：先按地址认预置服务，再按 provider 认，最后退回通用名。 */
        static String voiceServiceName(String role, String provider, String baseUrl) {
            String[][] table = ROLE_ASR.equals(role)
                    ? ModelPickerScreen.ASR_SERVICES : ModelPickerScreen.TTS_SERVICES;
            String host = hostOf(baseUrl);
            if (host.length() > 0) {
                String lower = baseUrl == null ? "" : baseUrl.toLowerCase(Locale.US);
                // 火山 v1 与豆包 2.0 同域名，靠路径区分（与 ModelPickerScreen#ttsServiceIdOf 同口径）
                if (ROLE_TTS.equals(role) && "openspeech.bytedance.com".equals(host)) {
                    if (lower.indexOf("/api/v3/tts") >= 0) return "豆包 2.0";
                    if (lower.indexOf("/api/v1/tts") >= 0) return "火山引擎 v1";
                }
                for (int i = 0; i < table.length; i++) {
                    if (table[i][3].length() == 0) continue;
                    if (hostOf(table[i][3]).equals(host)) return shortVoiceName(table[i][1]);
                }
            }
            for (int i = 0; i < table.length; i++) {
                if (table[i][0].equals(provider) && table[i][2].equals(provider)) {
                    return shortVoiceName(table[i][1]);
                }
            }
            return ROLE_ASR.equals(role) ? asrLabel(provider) : ttsLabel(provider);
        }

        /** 预设名的短写法：去掉括号补充说明；有「·」时只留品牌那一段。 */
        private static String shortVoiceName(String label) {
            String x = label == null ? "" : label.trim();
            int cut = x.indexOf('（');
            if (cut > 0) x = x.substring(0, cut).trim();
            int dot = x.indexOf('·');
            if (dot >= 0 && dot + 1 < x.length()) {
                String tail = x.substring(dot + 1).trim();
                if (tail.length() > 0) x = tail;
            }
            return x;
        }

        // ---------------------------------------------------------- 思考强度

        /**
         * 某个（供应商, 用途）当下生效的语义意图 —— 与运行端 {@code effectiveThinkingRaw} 同口径：
         * 先取 {@code api.thinkingByService[host]} 整条，没有才退回全局 {@code api.thinking}；
         * 拿到之后按 {@code normalizeThinkingIntent} 的规则取 {@code [purpose]} / {@code .default}。
         *
         * @param host 空 = 只看全局
         */
        static String thinkingIntent(Object root, String host, String purpose) {
            Object raw = null;
            if (host != null && host.length() > 0) {
                Map<String, Object> byService = map(root, "api.thinkingByService");
                String h = host.trim().toLowerCase(Locale.US);
                if (byService != null && byService.containsKey(h)) raw = byService.get(h);
            }
            if (raw == null) raw = BotConfigJson.get(root, "api.thinking");
            return pickIntent(raw, purpose);
        }

        static String pickIntent(Object raw, String purpose) {
            if (raw == null || raw == BotConfigJson.MISSING || raw == BotConfigJson.NULL) return "on";
            Map<String, Object> m = BotConfigJson.asObject(raw);
            if (m == null) return intentOf(raw);
            Object v = m.get("default");
            if (purpose != null && purpose.length() > 0 && m.containsKey(purpose)) v = m.get(purpose);
            return intentOf(v);
        }

        static String intentOf(Object v) {
            if (v instanceof Boolean) return ((Boolean) v).booleanValue() ? "on" : "off";
            String t = s(v).trim().toLowerCase(Locale.US);
            if ("off".equals(t)) return "off";
            if ("low".equals(t) || "medium".equals(t) || "high".equals(t)
                    || "xhigh".equals(t) || "max".equals(t)) return t;
            return "on";
        }

        /**
         * 写全局档位：{@code api.thinking[purpose] = intent}。
         *
         * <p>老配置里 {@code api.thinking} 可能是裸字符串（{@code "on"}）：这里先把它转成对象并把原值
         * 留在 {@code default}，否则一句 set 会把用户的全局意图整个冲掉。
         */
        static void writeGlobalThinking(Object root, String purpose, String intent) {
            Object cur = BotConfigJson.get(root, "api.thinking");
            Map<String, Object> m = BotConfigJson.asObject(cur);
            if (m == null) {
                LinkedHashMap<String, Object> next = new LinkedHashMap<String, Object>();
                String old = s(cur).trim();
                if (old.length() > 0) next.put("default", old);
                BotConfigJson.set(root, "api.thinking", next);
                m = next;
            }
            m.put(purpose, intent);
        }

        /** 写按供应商覆盖：{@code api.thinkingByService[host][purpose] = intent}（host 小写）。 */
        static void writeServiceThinking(Object root, String host, String purpose, String intent) {
            String h = host == null ? "" : host.trim().toLowerCase(Locale.US);
            if (h.length() == 0) return;
            Map<String, Object> byService = mapCreate(root, "api.thinkingByService");
            Map<String, Object> entry = BotConfigJson.asObject(byService.get(h));
            if (entry == null) {
                entry = new LinkedHashMap<String, Object>();
                byService.put(h, entry);
            }
            entry.put(purpose, intent);
        }

        // ---------------------------------------------------------- 服务名（ASR / TTS 的运行时服务名）

        static String asrLabel(String provider) {
            String p = provider == null ? "" : provider.trim().toLowerCase(Locale.US);
            if ("openai".equals(p)) return "OpenAI 兼容";
            if ("volc".equals(p)) return "火山引擎";
            if ("aliyun".equals(p)) return "阿里百炼";
            if ("baidu".equals(p)) return "百度";
            if ("tencent".equals(p)) return "腾讯云";
            if ("iflytek".equals(p)) return "讯飞";
            if ("local".equals(p)) return "本机 whisper.cpp";
            return p.length() == 0 ? "未选服务" : p;
        }

        static String ttsLabel(String provider) {
            String p = provider == null ? "" : provider.trim().toLowerCase(Locale.US);
            if ("openai".equals(p)) return "OpenAI 兼容";
            if ("volc".equals(p)) return "火山引擎 v1";
            if ("doubao".equals(p)) return "豆包 2.0";
            if ("minimax".equals(p)) return "MiniMax";
            if ("mimo".equals(p)) return "小米 MiMo";
            return p.length() == 0 ? "未选服务" : p;
        }
    }

    // ================================================================ 控件 W

    /**
     * 三个页面共用的自绘控件与浮层。
     *
     * <p>颜色 / 圆角 / 字号<b>只</b>从 {@link Theme} 与 {@link Ui} 取；所有输入框都活在独立窗口里
     * （{@link #textDialog}），页内一律没有 EditText —— 从根上避开「点输入框页面弹回顶部」。
     */
    static final class W {

        private W() {
        }

        /** 浮层关闭后回调。 */
        interface After {
            void run();
        }

        /** 输入校验：返回错误文案（就地显示在浮层里）；null = 通过。 */
        interface Check {
            String check(String text);
        }

        /** 文本确认回调；text 已 trim。 */
        interface TextCb {
            void onText(String text);
        }

        static int dp(Context c, float v) {
            return Ui.dp(c, v);
        }

        static void toast(Activity a, String msg) {
            if (a == null) return;
            try {
                if (a instanceof BotConfigHost) {
                    ((BotConfigHost) a).toast(msg);
                    return;
                }
            } catch (Throwable ignored) {
                // 落到系统 toast
            }
            try {
                android.widget.Toast.makeText(a, msg, android.widget.Toast.LENGTH_SHORT).show();
            } catch (Throwable ignored) {
                // 没有可用窗口：静默（绝不因此崩面板）
            }
        }

        // ---------------------------------------------------------- 卡片里的部件

        /** 卡片内边距列。 */
        static LinearLayout box(Context c) {
            LinearLayout l = Ui.column(c);
            l.setPadding(dp(c, Theme.S3 + 2), dp(c, Theme.S3), dp(c, Theme.S3 + 2), dp(c, Theme.S3 + 2));
            return l;
        }

        static View divider(Context c, Theme t) {
            View v = new View(c);
            v.setBackgroundColor(Ui.alpha(t.textTertiary, 0.14f));
            return v;
        }

        /** 小胶囊：只用于状态词（使用中 / 已配置 / 记忆在用）。 */
        static TextView pill(Context c, Theme t, String text, boolean strong) {
            TextView v = Ui.text(c, text, Theme.T_CAP, strong ? t.toneStrong : t.textSecondary);
            if (strong) v.setTypeface(Typeface.DEFAULT_BOLD);
            v.setBackground(Drawables.round(
                    strong ? Ui.alpha(t.accent, 0.16f) : Ui.alpha(t.textPrimary, 0.08f),
                    strong ? Ui.alpha(t.accent, 0.30f) : 0, dp(c, 1), dp(c, Theme.R_PILL)));
            v.setPadding(dp(c, 8), dp(c, 3), dp(c, 8), dp(c, 3));
            return v;
        }

        /** 档位胶囊的选中/未选中两态。 */
        static void paintChip(Context c, Theme t, TextView chip, boolean selected) {
            if (chip == null) return;
            chip.setTextColor(selected ? t.onAccent : t.textSecondary);
            chip.setTypeface(selected ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            chip.setBackground(Drawables.stateful(
                    Drawables.round(selected ? t.accent : t.ghostFill,
                            selected ? 0 : t.ghostStroke, dp(c, 1), dp(c, Theme.R_PILL)),
                    Drawables.round(selected ? Ui.pressedOf(t, t.accent) : Ui.pressedOf(t, t.ghostFill),
                            selected ? 0 : t.ghostStroke, dp(c, 1), dp(c, Theme.R_PILL))));
        }

        /**
         * 一行可点项：标题 + 当前值（灰字，最多两行）+ 右箭头。
         * 按下反馈按项目口径用 {@code Ui.press(0.985f)}。
         */
        static LinearLayout row(Context c, Theme t, String title, String value, boolean chevron,
                                View.OnClickListener click) {
            LinearLayout row = Ui.row(c);
            row.setMinimumHeight(dp(c, Theme.TOUCH));
            row.setPadding(0, dp(c, 8), 0, dp(c, 8));
            row.setBackground(Drawables.stateful(
                    Drawables.round(0, 0, 0, dp(c, Theme.R_TILE)),
                    Drawables.round(Ui.alpha(t.textPrimary, 0.06f), 0, 0, dp(c, Theme.R_TILE))));

            LinearLayout txt = Ui.column(c);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            tlp.weight = 1f;
            tlp.rightMargin = dp(c, Theme.S2);
            row.addView(txt, tlp);
            txt.addView(Ui.text(c, title, Theme.T_BODY, t.textPrimary),
                    new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
            if (value != null && value.length() > 0) {
                TextView v = Ui.text(c, value, Theme.T_CAP, t.textSecondary);
                v.setLineSpacing(dp(c, 2), 1f);
                v.setMaxLines(2);
                v.setEllipsize(TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
                vlp.topMargin = dp(c, 3);
                txt.addView(v, vlp);
            }
            if (chevron) row.addView(new IconView(c, IconView.CHEV_R, t.textTertiary),
                    Ui.llp(dp(c, 20), dp(c, 20)));

            row.setClickable(true);
            row.setFocusable(true);
            if (click != null) row.setOnClickListener(click);
            Ui.press(row, 0.985f);
            return row;
        }

        /** 开 / 关一行（自绘开关，不内嵌任何输入件）。 */
        static LinearLayout switchRow(Context c, Theme t, String title, String hint,
                                      boolean on, BotConfigToggle.OnChange cb) {
            LinearLayout row = Ui.row(c);
            row.setMinimumHeight(dp(c, Theme.TOUCH));
            row.setPadding(0, dp(c, 8), 0, dp(c, 8));

            LinearLayout txt = Ui.column(c);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            tlp.weight = 1f;
            tlp.rightMargin = dp(c, Theme.S2);
            txt.addView(Ui.text(c, title, Theme.T_BODY, t.textPrimary),
                    new LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT));
            if (hint != null && hint.length() > 0) {
                TextView h = Ui.text(c, hint, Theme.T_CAP, t.textSecondary);
                h.setLineSpacing(dp(c, 2), 1f);
                LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
                hlp.topMargin = dp(c, 3);
                txt.addView(h, hlp);
            }
            row.addView(txt, tlp);
            row.addView(new BotConfigToggle(c, t, on, cb), Ui.llp(dp(c, 46), dp(c, 28)));
            return row;
        }

        // ---------------------------------------------------------- 浮层外壳

        static Dialog dialog(Activity a) {
            if (a == null) return null;
            Dialog d = new Dialog(a);
            try {
                // 主题里若自带标题栏会抛；抛了也只是多一条系统标题栏，不影响功能
                d.requestWindowFeature(Window.FEATURE_NO_TITLE);
            } catch (Throwable ignored) {
                // 忽略
            }
            d.setCanceledOnTouchOutside(true);
            return d;
        }

        /** 浮层外壳：透明窗口 + 自己画的玻璃卡片（系统窗口背景一律抹掉）。 */
        @SuppressWarnings("deprecation")
        static void show(Dialog d, Activity a, Theme t, View content) {
            if (d == null || a == null) return;
            FrameLayout shell = new FrameLayout(a);
            shell.setPadding(dp(a, Theme.S2), dp(a, Theme.S2), dp(a, Theme.S2), dp(a, Theme.S2));
            FrameLayout card = Ui.card(a, t);
            card.addView(content, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            shell.addView(card, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            d.setContentView(shell);

            Window w = d.getWindow();
            if (w != null) {
                w.setBackgroundDrawable(new ColorDrawable(0x00000000));
                w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                w.setDimAmount(0.6f);
                // targetSdk 锁 28：SOFT_INPUT_ADJUST_RESIZE 在这条分支仍然正常生效
                w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
                w.setLayout(MATCH_PARENT, WRAP_CONTENT);
            }
            try {
                d.show();
            } catch (Throwable ignored) {
                // 没有可用窗口：宁可不弹，也不能崩
            }
        }

        /** 浮层关闭后跑一件事（就地刷新页面时用）。 */
        static void onDismiss(Dialog d, final After after) {
            if (d == null) return;
            d.setOnDismissListener(new android.content.DialogInterface.OnDismissListener() {
                @Override
                public void onDismiss(android.content.DialogInterface x) {
                    if (after != null) after.run();
                }
            });
        }

        static TextView title(Context c, Theme t, String text) {
            TextView v = Ui.strong(c, text, Theme.T_CARD, t.textPrimary);
            v.setLineSpacing(dp(c, 2), 1f);
            return v;
        }

        static TextView note(Context c, Theme t, String text) {
            TextView v = Ui.text(c, text, Theme.T_CAP, t.textSecondary);
            v.setLineSpacing(dp(c, 3), 1f);
            return v;
        }

        static EditText input(Context c, Theme t, int inputType, String hint, boolean multiline) {
            EditText e = new EditText(c);
            e.setTextSize(Theme.T_BODY);
            e.setTextColor(t.textPrimary);
            e.setHintTextColor(Ui.alpha(t.textSecondary, 0.75f));
            e.setBackground(Drawables.round(Ui.alpha(t.textPrimary, t.dark ? 0.08f : 0.05f),
                    t.ghostStroke, dp(c, 1), dp(c, Theme.R_BTN)));
            e.setPadding(dp(c, Theme.S2), dp(c, Theme.S2), dp(c, Theme.S2), dp(c, Theme.S2));
            e.setInputType(inputType);
            e.setHint(hint);
            e.setSingleLine(!multiline);
            if (multiline) {
                e.setMinLines(6);
                e.setGravity(Gravity.TOP | Gravity.START);
                e.setHorizontallyScrolling(false);
                e.setTypeface(Typeface.MONOSPACE);
                e.setTextSize(Theme.T_CAP);
            }
            e.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI);
            return e;
        }

        static TextView errPill(Context c, Theme t) {
            TextView v = Ui.text(c, "", Theme.T_CAP, t.toneStrong);
            v.setTypeface(Typeface.DEFAULT_BOLD);
            v.setBackground(Drawables.round(Ui.alpha(t.accent, 0.16f), Ui.alpha(t.accent, 0.30f),
                    dp(c, 1), dp(c, Theme.R_PILL)));
            v.setPadding(dp(c, 10), dp(c, 6), dp(c, 10), dp(c, 6));
            v.setLineSpacing(dp(c, 2), 1f);
            v.setVisibility(View.GONE);
            return v;
        }

        static void showError(TextView pill, String msg) {
            if (pill == null) return;
            pill.setText(msg);
            pill.setVisibility(View.VISIBLE);
        }

        static LinearLayout buttonBar(Dialog d, Theme t, Context c, final Runnable confirm) {
            LinearLayout bar = Ui.row(c);
            TextView cancel = Ui.button(c, t, "取消", false);
            cancel.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    d.dismiss();
                }
            });
            TextView ok = Ui.button(c, t, "确定", true);
            ok.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    if (confirm != null) confirm.run();
                }
            });
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            clp.weight = 1f;
            LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            olp.weight = 1f;
            olp.leftMargin = dp(c, Theme.S1);
            bar.addView(cancel, clp);
            bar.addView(ok, olp);
            return bar;
        }

        static void focusAndShowKeyboard(final Context c, final EditText e) {
            if (e == null) return;
            e.requestFocus();
            try {
                CharSequence s = e.getText();
                e.setSelection(s == null ? 0 : s.length());
            } catch (Throwable ignored) {
                // 个别输入法会临时改 selection
            }
            e.postDelayed(new Runnable() {
                @Override
                public void run() {
                    try {
                        android.view.inputmethod.InputMethodManager imm =
                                (android.view.inputmethod.InputMethodManager)
                                        c.getSystemService(Context.INPUT_METHOD_SERVICE);
                        if (imm != null && e.getWindowToken() != null) {
                            imm.showSoftInput(e, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                        }
                    } catch (Throwable ignored) {
                        // 键盘弹不出来不影响输入
                    }
                }
            }, 150);
        }

        /** 单值文本编辑浮层（含校验）。面板里<b>所有</b>文本输入都走这里。 */
        static void textDialog(Activity a, Theme t, String title, String tip, String initial,
                               int inputType, boolean multiline, final Check check, final TextCb cb) {
            final Dialog dlg = dialog(a);
            if (dlg == null) return;
            LinearLayout box = box(a);
            box.addView(title(a, t, title), new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            if (tip != null && tip.length() > 0) {
                TextView tipView = note(a, t, tip);
                LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
                tlp.topMargin = dp(a, 6);
                box.addView(tipView, tlp);
            }
            final EditText input = input(a, t, inputType, multiline ? "（多行 JSON）" : "（留空 = 清空）", multiline);
            input.setText(initial == null ? "" : initial);
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            ilp.topMargin = dp(a, Theme.S2);
            box.addView(input, ilp);

            final TextView err = errPill(a, t);
            LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            elp.topMargin = dp(a, Theme.S1);
            box.addView(err, elp);

            LinearLayout bar = buttonBar(dlg, t, a, new Runnable() {
                @Override
                public void run() {
                    CharSequence cs = input.getText();
                    String text = cs == null ? "" : cs.toString().trim();
                    String bad = check == null ? null : check.check(text);
                    if (bad != null) {
                        showError(err, bad);
                        return;
                    }
                    dlg.dismiss();
                    if (cb != null) cb.onText(text);
                }
            });
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            blp.topMargin = dp(a, Theme.S2);
            box.addView(bar, blp);

            show(dlg, a, t, box);
            if (!multiline) focusAndShowKeyboard(a, input);
        }

        /** 单选浮层：labels 给人看，values 给代码用（可不同）。 */
        static void chooseDialog(Activity a, Theme t, String title, String tip,
                                 String[] labels, String[] values, String selected, final TextCb cb) {
            final Dialog dlg = dialog(a);
            if (dlg == null) return;
            LinearLayout box = box(a);
            box.addView(title(a, t, title), new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            if (tip != null && tip.length() > 0) {
                TextView tipView = note(a, t, tip);
                LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
                tlp.topMargin = dp(a, 6);
                box.addView(tipView, tlp);
            }

            ScrollView scroll = new ScrollView(a);
            scroll.setVerticalScrollBarEnabled(false);
            LinearLayout list = Ui.column(a);
            scroll.addView(list, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            for (int i = 0; i < labels.length; i++) {
                if (i > 0) list.addView(divider(a, t), Ui.llp(MATCH_PARENT, dp(a, 1)));
                final String value = values[i];
                boolean isSel = value == null ? selected == null : value.equals(selected);
                LinearLayout row = Ui.row(a);
                row.setMinimumHeight(dp(a, Theme.TOUCH));
                row.setPadding(0, dp(a, 8), 0, dp(a, 8));
                row.setBackground(Drawables.stateful(
                        Drawables.round(0, 0, 0, dp(a, Theme.R_TILE)),
                        Drawables.round(Ui.alpha(t.textPrimary, 0.06f), 0, 0, dp(a, Theme.R_TILE))));
                TextView label = Ui.text(a, labels[i], Theme.T_BODY, isSel ? t.textPrimary : t.textSecondary);
                LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
                llp.weight = 1f;
                llp.rightMargin = dp(a, Theme.S2);
                row.addView(label, llp);
                if (isSel) row.addView(new IconView(a, IconView.CHECK, t.accent), Ui.llp(dp(a, 20), dp(a, 20)));
                row.setClickable(true);
                row.setFocusable(true);
                row.setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        dlg.dismiss();
                        if (cb != null) cb.onText(value);
                    }
                });
                Ui.press(row, 0.985f);
                list.addView(row, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
            int maxH = (int) (a.getResources().getDisplayMetrics().heightPixels * 0.55f);
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(MATCH_PARENT, maxH);
            slp.topMargin = dp(a, Theme.S2);
            box.addView(scroll, slp);

            TextView cancel = Ui.button(a, t, "取消", false);
            cancel.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    dlg.dismiss();
                }
            });
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            blp.topMargin = dp(a, Theme.S2);
            box.addView(cancel, blp);

            show(dlg, a, t, box);
        }

        /** 只读长文本浮层（thinkingParams 这类）。 */
        static void infoDialog(Activity a, Theme t, String title, String body) {
            final Dialog dlg = dialog(a);
            if (dlg == null) return;
            LinearLayout box = box(a);
            box.addView(title(a, t, title), new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

            ScrollView scroll = new ScrollView(a);
            scroll.setVerticalScrollBarEnabled(false);
            TextView mono = Ui.mono(a, Theme.T_CAP, t.textSecondary);
            mono.setText(body == null ? "" : body);
            mono.setLineSpacing(dp(a, 3), 1f);
            mono.setTextIsSelectable(true);
            scroll.addView(mono, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            int maxH = (int) (a.getResources().getDisplayMetrics().heightPixels * 0.52f);
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(MATCH_PARENT, maxH);
            slp.topMargin = dp(a, Theme.S2);
            box.addView(scroll, slp);

            TextView close = Ui.button(a, t, "关闭", true);
            close.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    dlg.dismiss();
                }
            });
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            blp.topMargin = dp(a, Theme.S2);
            box.addView(close, blp);
            show(dlg, a, t, box);
        }

        /** 危险动作确认浮层（删除渠道）。 */
        static void confirmDialog(Activity a, Theme t, String title, String body, String okLabel, final Runnable ok) {
            final Dialog dlg = dialog(a);
            if (dlg == null) return;
            LinearLayout box = box(a);
            box.addView(title(a, t, title), new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
            if (body != null && body.length() > 0) {
                TextView bodyView = note(a, t, body);
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
                blp.topMargin = dp(a, 6);
                box.addView(bodyView, blp);
            }
            LinearLayout bar = Ui.row(a);
            TextView cancel = Ui.button(a, t, "取消", false);
            cancel.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    dlg.dismiss();
                }
            });
            TextView danger = Ui.button(a, t, okLabel == null ? "删除" : okLabel, true);
            danger.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    dlg.dismiss();
                    if (ok != null) ok.run();
                }
            });
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            clp.weight = 1f;
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
            dlp.weight = 1f;
            dlp.leftMargin = dp(a, Theme.S1);
            bar.addView(cancel, clp);
            bar.addView(danger, dlp);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT);
            blp.topMargin = dp(a, Theme.S2);
            box.addView(bar, blp);
            show(dlg, a, t, box);
        }
    }
}
