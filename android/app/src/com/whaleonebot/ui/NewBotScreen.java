package com.whaleonebot.ui;

import android.content.Context;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 新建机器人向导：<b>一页滚动，四段</b>（对应规格 §3 的四步）。
 *
 * <pre>
 *   ① 基本信息   名字（必填）/ 人设（多行，可空）
 *   ② 运行端     内置机器人 / 自定义机器人（选自定义才出现仓库地址框，且不可为空）
 *   ③ 接入平台   PlatformPicker（V1 只有 QQ 可选，其余置灰 + 敬请期待）
 *   ④ 保存       BotRegistry.create(...) → toast「已创建 · 名字」→ 回机器人列表
 * </pre>
 *
 * <p>为什么是一页而不是分步向导：字段只有三个，分步会把「填完要返回上一页改」的成本放大；
 * 一页滚动里四段用编号标题分隔，既看得出顺序，也能随时回退改。
 *
 * <p><b>平台专属的字段一律不在这里</b>（QQ 号、token、白名单、模型 Key…）：
 * 那些属于平台运行端配置，等用户回首页点平台之后再配 —— 否则「一个机器人管两个平台」时字段会互相污染。
 *
 * <p>校验顺序与用户填写顺序一致：名字 → （自定义时）仓库地址 → 平台。任一不通过只 toast，不保存。
 *
 * <p>动效：本页不写入场动画（整页过渡只由 {@link Motion} 在 AppShell 里执行）。
 */
final class NewBotScreen extends Screen {

    /** 与注册表约定的运行端取值，别自创。 */
    private static final String KIND_BUILTIN = "builtin";
    private static final String KIND_CUSTOM = "custom";

    private static final int NAME_MAX = 24;
    private static final int PERSONA_MAX = 2000;
    private static final int REPO_MAX = 200;

    // ① 基本信息
    private EditText nameInput;
    private EditText personaInput;

    // ② 运行端
    private LinearLayout builtinCard;
    private LinearLayout customCard;
    private TextView builtinTitle;
    private TextView builtinDesc;
    private TextView customTitle;
    private TextView customDesc;
    private IconView builtinCheck;
    private IconView customCheck;
    private LinearLayout repoBox;
    private EditText repoInput;

    // ③ 接入平台
    private PlatformPicker picker;

    /** 保存按钮：滚动容器要认得它，才能保证「按在它身上的手势不被翻译成滚动」。 */
    private TextView saveButton;

    /** 当前选中的运行端，默认「内置机器人」（官方那条最省事的路径先摆在前面）。 */
    private String runtimeKind = KIND_BUILTIN;

    /** 防连点：保存成功后立刻换页，避免一次点击建出两个机器人。 */
    private boolean saving;

    NewBotScreen(AppShell shell) {
        super(shell);
    }

    @Override
    void build() {
        // 滚动容器不是裸 ScrollView：输入框一保持焦点，ScrollView 就会在后续布局里把页面滚回
        // 那个输入框（requestChildRectangleOnScreen），并把同一次按下翻译成滚动 ——
        // 子 View（保存按钮）于是收到 CANCEL，click 就没了。三个覆写各管一段，见各自注释。
        final ScrollView scroll = new ScrollView(activity) {

            /** 这次按下是否收掉了输入框焦点（决定抬手后要不要收键盘）。 */
            private boolean releaseImeOnUp;

            /** 这一次手势是不是从「保存」上开始的。 */
            private boolean gestureOnSave;

            /** 手势期间的锁定滚动位置（-1 = 不锁）。 */
            private int pinnedY = -1;

            /** 防重入：scrollTo 会再次触发 onScrollChanged，靠它保证只回拉一次。 */
            private boolean repin;

            @Override
            public boolean dispatchTouchEvent(MotionEvent ev) {
                final int action = ev.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    // 关键：在框架自己派发这次按下**之前**先收掉输入框焦点。
                    // 只改状态、不消费事件 —— 紧接着照常 super.dispatchTouchEvent，
                    // 按钮该收到什么还是收到什么，所以这一次触摸不会被吃掉。
                    releaseImeOnUp = releaseInputFocus(this, ev.getX(), ev.getY());
                }
                final boolean handled = super.dispatchTouchEvent(ev);
                if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                    // 收键盘放到这里：此时 click 已经派发完，窗口不会在手势中途改变尺寸
                    // （adjustResize 一旦缩放，手指底下的按钮就跑了）。
                    final boolean hide = releaseImeOnUp;
                    releaseImeOnUp = false;
                    if (hide) hideInputMethod();
                }
                return handled;
            }

            @Override
            public boolean onInterceptTouchEvent(MotionEvent ev) {
                final int action = ev.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    gestureOnSave = touchOnSaveButton(this, ev.getX(), ev.getY());
                    pinnedY = gestureOnSave ? getScrollY() : -1;
                }
                if (gestureOnSave) {
                    // 这一段手势整段归「保存」，不交给滚动逻辑：否则 ScrollView 会把它当成
                    // 一次滚动（onInterceptTouchEvent 返回 true），按钮收到 CANCEL。
                    // 即使上一帧还有没停的滚动（例如「滚回输入框」），也不会把这次按下吃掉。
                    if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                        gestureOnSave = false;
                        pinnedY = -1;
                    }
                    return false;
                }
                return super.onInterceptTouchEvent(ev);
            }

            @Override
            protected void onScrollChanged(int l, int t, int oldl, int oldt) {
                // 按住「保存」的这段时间，任何滚动都不许把按钮从手指底下带走：
                // 否则 UP 会落在按钮外，click 同样丢失。只锁这一小段手势。
                if (gestureOnSave && pinnedY >= 0 && t != pinnedY && !repin) {
                    repin = true;
                    scrollTo(getScrollX(), pinnedY);
                    repin = false;
                    return;
                }
                super.onScrollChanged(l, t, oldl, oldt);
            }
        };
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));

        LinearLayout col = Ui.column(activity);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header("新建机器人"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView crumb = Ui.text(activity, "设置 / 机器人 / 新建", Theme.T_CAP, t.textTertiary);
        LinearLayout.LayoutParams clp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        clp.topMargin = dp(Theme.S1);
        col.addView(crumb, clp);

        // ---------- ① 基本信息 ----------
        col.addView(sectionLabel("① 基本信息"), labelLp(Theme.S3));
        col.addView(basicCard(), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- ② 运行端 ----------
        col.addView(sectionLabel("② 运行端"), labelLp(Theme.S4));
        col.addView(runtimeCard(), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- ③ 接入平台 ----------
        col.addView(sectionLabel("③ 接入平台"), labelLp(Theme.S4));
        col.addView(platformCard(), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // ---------- ④ 保存 ----------
        saveButton = Ui.button(activity, t, "保存", true);
        saveButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                save();
            }
        });
        LinearLayout.LayoutParams slp = Ui.llp(MATCH_PARENT, dp(Theme.TOUCH));
        slp.topMargin = dp(Theme.S4);
        col.addView(saveButton, slp);

        TextView note = Ui.text(activity,
                "保存后它会出现在「设置 → 机器人」里。平台专属的设置（白名单、登录、模型…）"
                        + "等回到首页点那个平台之后再配。",
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams nlp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        nlp.topMargin = dp(Theme.S3);
        col.addView(note, nlp);
    }

    // ------------------------------------------------------------------ ① 基本信息

    private View basicCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

        box.addView(fieldLabel("名字"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        nameInput = input("给它起个名字，例如 小鲸", false);
        nameInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(NAME_MAX)});
        box.addView(nameInput, marginTop(Theme.S1));

        LinearLayout.LayoutParams plp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        plp.topMargin = dp(Theme.S3);
        box.addView(fieldLabel("人设"), plp);
        personaInput = input("它说话像谁：身份、语气、口头禅、忌讳…（可留空）", true);
        personaInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(PERSONA_MAX)});
        box.addView(personaInput, marginTop(Theme.S1));

        TextView hint = Ui.text(activity, "所有平台共用同一套人设；这里不填平台专属的任何东西。",
                Theme.T_CAP, t.textTertiary);
        hint.setLineSpacing(dp(3), 1f);
        box.addView(hint, marginTop(Theme.S2));

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    // ------------------------------------------------------------------ ② 运行端

    private View runtimeCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

        box.addView(optionRow(true), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        box.addView(optionRow(false), marginTop(Theme.S1));

        repoBox = repoBlock();
        repoBox.setVisibility(View.GONE);
        box.addView(repoBox, marginTop(Theme.S2));

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        applyRuntime();
        return card;
    }

    /** 一张可选卡：标题 + 一句解释 + 勾。整行可点。 */
    private View optionRow(final boolean builtin) {
        final String kind = builtin ? KIND_BUILTIN : KIND_CUSTOM;

        LinearLayout row = Ui.row(activity);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(dp(Theme.S3), dp(Theme.S2 + 2), dp(Theme.S3), dp(Theme.S2 + 2));

        LinearLayout box = Ui.column(activity);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        blp.weight = 1f;
        blp.rightMargin = dp(Theme.S2);
        TextView title = Ui.strong(activity, builtin ? "内置机器人" : "自定义机器人",
                Theme.T_BODY, t.textPrimary);
        TextView desc = Ui.text(activity,
                builtin ? "官方运行端，保存后下载" : "自己的或别人的运行端，填仓库地址",
                Theme.T_CAP, t.textTertiary);
        desc.setLineSpacing(dp(2), 1f);
        box.addView(title, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        box.addView(desc, marginTopWrap(2));
        row.addView(box, blp);

        IconView check = new IconView(activity, IconView.CHECK, t.accent);
        row.addView(check, new LinearLayout.LayoutParams(dp(20), dp(20)));

        row.setClickable(true);
        row.setFocusable(true);
        Ui.press(row, 0.985f);
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                selectRuntime(kind);
            }
        });

        if (builtin) {
            builtinCard = row;
            builtinTitle = title;
            builtinDesc = desc;
            builtinCheck = check;
        } else {
            customCard = row;
            customTitle = title;
            customDesc = desc;
            customCheck = check;
        }
        return row;
    }

    /** 自定义运行端才展开的仓库地址框。 */
    private LinearLayout repoBlock() {
        LinearLayout col = Ui.column(activity);
        col.addView(fieldLabel("仓库地址"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        repoInput = input("https://github.com/作者/运行端", false);
        repoInput.setFilters(new InputFilter[]{new InputFilter.LengthFilter(REPO_MAX)});
        col.addView(repoInput, marginTop(Theme.S1));

        TextView hint = Ui.text(activity,
                "V1 只留位：保存后不会自动下载，由作者自行适配协议端接口。",
                Theme.T_CAP, t.textTertiary);
        hint.setLineSpacing(dp(3), 1f);
        col.addView(hint, marginTop(Theme.S2));
        return col;
    }

    private void selectRuntime(String kind) {
        if (kind == null || kind.equals(runtimeKind)) return;
        runtimeKind = kind;
        applyRuntime();
    }

    /** 把选中态画出来：实心淡色 + 信号色描边 + 勾；未选是描边。仓库框跟着显隐。 */
    private void applyRuntime() {
        boolean builtin = KIND_BUILTIN.equals(runtimeKind);
        styleOption(builtinCard, builtinTitle, builtinDesc, builtinCheck, builtin);
        styleOption(customCard, customTitle, customDesc, customCheck, !builtin);
        if (repoBox != null) repoBox.setVisibility(builtin ? View.GONE : View.VISIBLE);
    }

    private void styleOption(LinearLayout card, TextView title, TextView desc,
                             IconView check, boolean on) {
        if (card == null) return;
        card.setBackground(on
                ? Drawables.round(Ui.alpha(t.accent, 0.16f), Ui.alpha(t.accent, 0.55f),
                dp(1), dp(Theme.R_BTN))
                : Drawables.round(t.ghostFill, t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        if (title != null) title.setTextColor(on ? t.textPrimary : t.textSecondary);
        if (desc != null) desc.setTextColor(on ? t.textSecondary : t.textTertiary);
        if (check != null) check.setVisibility(on ? View.VISIBLE : View.INVISIBLE);
    }

    // ------------------------------------------------------------------ ③ 接入平台

    private View platformCard() {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = Ui.column(activity);
        box.setPadding(dp(Theme.S3), dp(Theme.S3), dp(Theme.S3), dp(Theme.S3));

        picker = new PlatformPicker(activity, t, defaultSelection(), new PlatformPicker.Listener() {
            @Override
            public void onSelectionChanged(List<String> selected) {
                // 选中集合由控件自己持有，保存时再取；这里不需要额外动作。
            }

            @Override
            public void onUnavailable(String platformId) {
                host().toast(BotRegistry.PLATFORM_LABEL(platformId) + " · 敬请期待");
            }
        });
        box.addView(picker, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView hint = Ui.text(activity,
                "可以多选。V1 只有 QQ 已接通，其余平台显示但不可选，接通后会直接变成可勾。",
                Theme.T_CAP, t.textTertiary);
        hint.setLineSpacing(dp(3), 1f);
        box.addView(hint, marginTop(Theme.S2));

        card.addView(box, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return card;
    }

    /** 默认勾上「已经接通」的平台（V1 = 只有 QQ）：少一次点击，也不影响取消。 */
    private static List<String> defaultSelection() {
        List<String> out = new ArrayList<String>();
        for (String id : BotRegistry.PLATFORMS) {
            if (BotRegistry.PLATFORM_SUPPORTED(id)) out.add(id);
        }
        return out;
    }

    // ------------------------------------------------------------------ ④ 保存

    /**
     * 保存：先按用户填写顺序校验，任一不通过只 toast 且<b>不落库</b>；
     * 通过后 {@code BotRegistry.create(...)} 落盘，toast「已创建 · 名字」，再换页。
     *
     * <p>换页顺序：先回机器人列表（新机器人立刻出现在同层列表里），
     * 选的是内置运行端就再叠一层下载页 —— 返回时正好落在列表上，不会回到这张已提交的表单。
     */
    private void save() {
        if (saving) return;
        // 防御：万一焦点还挂在输入框上（例如从无障碍、外接键盘触发的点击），先收干净再落库，
        // 免得保存成功后整页还在为「让光标可见」而自己滚动。
        closeInputs();

        String name = textOf(nameInput);
        if (name.length() == 0) {
            host().toast("名字不能为空");
            if (nameInput != null) nameInput.requestFocus();
            return;
        }

        boolean builtin = !KIND_CUSTOM.equals(runtimeKind);
        String repo = textOf(repoInput);
        if (!builtin && repo.length() == 0) {
            host().toast("请填写运行端仓库地址");
            if (repoInput != null) repoInput.requestFocus();
            return;
        }
        if (!builtin) {
            // 中文输入法会把网址打成全角（实测 adb 输入得到 "https：//github。com/…"），
            // 粘贴进来的是半角。这里统一归一 + 形态校验，别把坏地址静默存进注册表。
            String normalized = normalizeRepo(repo);
            if (normalized == null) {
                host().toast("仓库地址要像 https://github.com/作者/项目");
                if (repoInput != null) repoInput.requestFocus();
                return;
            }
            repo = normalized;
            if (repoInput != null) repoInput.setText(repo);
        }

        List<String> platforms = picker == null ? new ArrayList<String>() : picker.selected();
        if (platforms.isEmpty()) {
            host().toast("至少选一个平台");
            return;
        }

        String persona = textOf(personaInput);
        String ref = builtin ? "" : repo;

        BotRegistry.Bot created;
        try {
            created = BotRegistry.create(name, persona, runtimeKind, ref, platforms);
        } catch (Throwable t) {
            // 注册表写盘失败也要让用户看见，不许静默失败。
            String m = t.getMessage();
            host().toast("创建失败" + (m == null || m.length() == 0 ? "" : "：" + m));
            return;
        }
        if (created == null || created.id == null || created.id.length() == 0) {
            host().toast("创建失败，请重试");
            return;
        }

        saving = true;
        host().toast("已创建 · " + name);
        // popTo 而不是 pushBotList：向导提交后这一页就该消失。
        // 用 push 会得到 [BotList, NewBot, BotList, RuntimeDL]，用户返回时会落到一张已提交的空表单上。
        shell.popTo(AppShell.P_BOTLIST);
        if (builtin) shell.pushRuntimeDownload(created.id);
    }

    /**
     * 仓库地址归一 + 校验：全角字符转半角，去掉空白，必须是 http(s)://主机/… 形态。
     *
     * <p>为什么需要：真机实测用中文输入法打出来的地址是 {@code https：//github。com/a－b}
     * （全角冒号/句号/连字符），直接存进注册表就是个坏地址。粘贴通常是半角，所以这里
     * **只归一不猜测**：转不成就报错让用户改，不擅自补 http://。
     *
     * @return 归一后的地址；形态不合法返回 null（调用方负责 toast，不保存）
     */
    private static String normalizeRepo(String raw) {
        if (raw == null) return null;
        StringBuilder sb = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            switch (c) {
                case '\uFF1A': sb.append(':'); break;      // ：
                case '\uFF0F': sb.append('/'); break;      // ／
                case '\uFF0E': sb.append('.'); break;      // ．
                case '\u3002': sb.append('.'); break;      // 。
                case '\uFF0D': sb.append('-'); break;      // －
                case '\uFF3F': sb.append('_'); break;      // ＿
                case '\uFF0B': sb.append('+'); break;      // ＋
                case '\uFF20': sb.append('@'); break;      // ＠
                case ' ': case '\t': case '\n': case '\r': break;
                default: sb.append(c); break;
            }
        }
        String s = sb.toString();
        if (!s.matches("^https?://[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%\\-]+$")) return null;
        String rest = s.substring(s.indexOf("://") + 3);
        int slash = rest.indexOf('/');
        String host = slash >= 0 ? rest.substring(0, slash) : rest;
        return host.length() < 3 || host.indexOf('.') < 0 ? null : s;
    }

    // ------------------------------------------------------------------ 焦点 / 输入法
    //
    // 这一节合起来修一个真机必修 bug：
    //   输入框保持焦点时，ScrollView 会在后续布局里执行 requestChildRectangleOnScreen，
    //   把页面滚回那个输入框（本页 = 滚回顶部）；这一滚发生在同一次手势里，
    //   ScrollView 于是把按下当成滚动、给子 View 发 CANCEL —— 表现就是
    //   「点保存没反应，页面自己弹回顶部，光标还在输入框里」。
    //   解法：手指落在输入框以外的地方时，先把它俩的「焦点关系」拆掉。

    /**
     * 按下时收掉「还停在输入框里的焦点」。
     *
     * @return true 表示这次按下确实收掉了输入框焦点（抬手后顺带收键盘）
     */
    private boolean releaseInputFocus(ViewGroup container, float x, float y) {
        EditText focused = focusedInput();
        if (focused == null) return false;
        // 落点就在输入框上 = 「继续编辑」，不动焦点（否则点一下自己的输入框会被踢出编辑态）
        if (inputHit(container, x, y)) return false;
        focused.clearFocus();
        return true;
    }

    /**
     * 真正持有焦点的输入框。
     *
     * <p>为什么自己递归找：{@link ViewGroup#findFocus()} 只返回到这棵子树里<b>那一层</b>持有焦点的
     * 直接子 View（本页是内容 LinearLayout），拿它做 {@code instanceof EditText} 永远不成立 ——
     * 那样这段修复会静默失效。这里沿 child 链一直找到底，结果与框架的层级语义无关。
     */
    private EditText focusedInput() {
        return findFocusedInput(root);
    }

    private static EditText findFocusedInput(View v) {
        if (v == null) return null;
        if (v instanceof EditText && v.isFocused()) return (EditText) v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                EditText found = findFocusedInput(g.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    private boolean inputHit(ViewGroup container, float x, float y) {
        return hits(container, nameInput, x, y)
                || hits(container, personaInput, x, y)
                || hits(container, repoInput, x, y);
    }

    /** 按下点是否落在「保存」上（坐标已换算到滚动容器自己的坐标系）。 */
    private boolean touchOnSaveButton(ViewGroup container, float x, float y) {
        return hits(container, saveButton, x, y);
    }

    /**
     * (x,y) 是否落在 v 的矩形内。坐标由 {@link ViewGroup#offsetDescendantRectToMyCoords}
     * 换算 —— 它会把中间几层容器的偏移和滚动一起算进去，比手工累加 left/top 可靠。
     */
    private static boolean hits(ViewGroup container, View v, float x, float y) {
        if (container == null || v == null) return false;
        if (v.getVisibility() != View.VISIBLE || v.getWidth() <= 0 || v.getHeight() <= 0) return false;
        Rect r = new Rect(0, 0, v.getWidth(), v.getHeight());
        try {
            container.offsetDescendantRectToMyCoords(v, r);
        } catch (Throwable t) {
            return false; // 不是后代 / 还没挂上：宁可不动焦点，也不猜坐标
        }
        return r.contains((int) x, (int) y);
    }

    /** 收起输入法。只在手势结束（UP）之后调用，避免窗口尺寸在手势中途变化把按钮挪走。 */
    private void hideInputMethod() {
        try {
            InputMethodManager imm = (InputMethodManager)
                    activity.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm == null) return;
            // 收键盘是「按窗口」的操作，本页自己的 window token 就够，不必依赖当前焦点在那一个 View 上。
            View anchor = root;
            if (anchor == null || anchor.getWindowToken() == null) anchor = activity.getCurrentFocus();
            if (anchor == null || anchor.getWindowToken() == null) return;
            imm.hideSoftInputFromWindow(anchor.getWindowToken(), 0);
        } catch (Throwable ignored) {
            // 收键盘失败不影响任何功能
        }
    }

    /** 保存前把输入状态收干净：清焦点 + 收键盘。 */
    private void closeInputs() {
        EditText focused = focusedInput();
        if (focused != null) focused.clearFocus();
        hideInputMethod();
    }

    // ------------------------------------------------------------------ 小工具

    private TextView sectionLabel(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        v.setLetterSpacing(0.08f);
        return v;
    }

    private LinearLayout.LayoutParams labelLp(int topMargin) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(topMargin);
        lp.bottomMargin = dp(Theme.S2);
        return lp;
    }

    private TextView fieldLabel(String text) {
        TextView v = Ui.text(activity, text, Theme.T_CAP, t.textSecondary);
        v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    /** 输入框：与运行端配置面板同一套视觉（淡底 + 极淡描边 + 圆角 R_BTN）。 */
    private EditText input(String hint, boolean multiline) {
        EditText e = new EditText(activity);
        e.setTextSize(Theme.T_BODY);
        e.setTextColor(t.textPrimary);
        e.setHintTextColor(Ui.alpha(t.textSecondary, 0.75f));
        e.setBackground(Drawables.round(Ui.alpha(t.textPrimary, t.dark ? 0.08f : 0.05f),
                t.ghostStroke, dp(1), dp(Theme.R_BTN)));
        e.setPadding(dp(Theme.S2), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        e.setSelectAllOnFocus(false);
        e.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI);

        if (multiline) {
            e.setSingleLine(false);
            e.setMinLines(4);
            e.setMaxLines(10);
            e.setGravity(Gravity.TOP | Gravity.START);
            e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                    | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            e.setLineSpacing(dp(2), 1f);
        } else {
            e.setSingleLine(true);
            e.setInputType(InputType.TYPE_CLASS_TEXT);
        }
        e.setHint(hint);
        return e;
    }

    private static String textOf(EditText e) {
        if (e == null || e.getText() == null) return "";
        return e.getText().toString().trim();
    }

    private LinearLayout.LayoutParams marginTop(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = dp(top);
        return lp;
    }

    private LinearLayout.LayoutParams marginTopWrap(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        lp.topMargin = dp(top);
        return lp;
    }
}
