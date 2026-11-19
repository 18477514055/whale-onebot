package com.whaleonebot.ui;

import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 渠道编辑页：改一个 provider（{@code providers[]} 里的一条），或新建一条。
 *
 * <p><b>只写自己名下的路径</b>（合同 v1.3 §0.1 / §3）：
 * <ul>
 *   <li>{@code providers[]} —— 新增 / 就地改一条（只动 displayName / baseURL / api / models / modelNames）</li>
 *   <li>{@code providerKeys[渠道 id]} —— 只有当用户<b>这次填了新 Key</b> 时才写</li>
 * </ul>
 * 别的键（包括同一条 provider 记录里我们不认识的字段，例如 {@code thinkingProbe}）一个都不碰：
 * 改既有渠道时是在原对象上 set 那几个字段，不是整个对象重建。
 *
 * <p><b>Key 是写入式的</b>：页面从不读 {@code providerKeys} 的值，只读「有没有」。
 * 用户输入的 Key 只活在 {@link #keyInput} 这个字段里，保存时写进 JSON，离开页面即随实例丢弃；
 * 编辑框用 {@link InputType#TYPE_TEXT_VARIATION_PASSWORD}，界面上连后四位都不显示。
 *
 * <p>构造函数有两个重载（合同 §4 要求）：
 * <pre>
 *   ProviderEditScreen(shell, providerId)                 // 编辑既有 / 新建空白
 *   ProviderEditScreen(shell, providerId, presetId)       // 从预置新建时带上预置 id 预填
 * </pre>
 * {@code providerId} 为 null / 空 = 新建；{@code presetId} 只用于预填，<b>不写进配置</b>
 * （运行端按 baseURL 主机名自己认渠道形状，见 {@code currentServiceId()}）。
 *
 * <p>页底还有一个「测试这个渠道」按钮：它<b>只发一次请求</b>（运行端
 * {@code POST /api/providers/test-one}），不写任何配置、不打印 Key，结果只 toast 连通 / 失败。
 */
final class ProviderEditScreen extends Screen {

    /** 运行端控制台端口：与 MainActivity 的 /api/config/reload 同一个写死值。 */
    private static final int TEST_PORT = 41907;

    private final String wantId;
    private final String presetId;

    private BotConfigHost cfg;
    private Object data;
    private boolean loaded;
    private String loadError;
    private boolean built;

    /** 真正在编辑的渠道 id；新建时为空，保存时才生成。 */
    private String providerId = "";
    private boolean isNew = true;
    /** 导航带来的渠道 id 在配置里找不到（多半被别处删了）：这一页按新建处理，但要把话说明白。 */
    private String missingNote;

    // ---- 表单状态（只在内存；点保存才落进 draft） ----
    private String displayName = "";
    private String baseUrl = "";
    private String api = "openai";
    private final ArrayList<String> models = new ArrayList<String>();
    /** 用户这次填的新 Key；null = 这次没填（保存时不动 providerKeys）。 */
    private String keyInput;

    ProviderEditScreen(AppShell shell, String providerId) {
        this(shell, providerId, null);
    }

    ProviderEditScreen(AppShell shell, String providerId, String presetId) {
        super(shell);
        this.wantId = providerId;
        this.presetId = presetId;
    }

    // ================================================================ 骨架

    @Override
    void build() {
        if (built) root.removeAllViews();
        built = true;
        cfg = (shell.activity instanceof BotConfigHost) ? (BotConfigHost) shell.activity : null;
        ensureLoaded();
        renderPage();
    }

    private void ensureLoaded() {
        if (loaded || loadError != null) return;
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

        // 既有渠道：把表单填成它的现状（Key 不读）。
        Map<String, Object> p = ModelsScreen.U.providerById(data, wantId);
        if (p != null) {
            isNew = false;
            providerId = ModelsScreen.U.s(p.get("id")).trim();
            displayName = ModelsScreen.U.s(p.get("displayName")).trim();
            baseUrl = ModelsScreen.U.providerBaseUrl(p);
            String a = ModelsScreen.U.s(p.get("api")).trim().toLowerCase(Locale.US);
            api = "anthropic".equals(a) ? "anthropic" : "openai";
            models.clear();
            models.addAll(ModelsScreen.U.providerModels(p));
        } else {
            isNew = true;
            providerId = "";
            if (wantId != null && wantId.trim().length() > 0) {
                missingNote = "配置里已经没有渠道 id「" + wantId.trim()
                        + "」不在了，这一页按新建处理。";
            }
            applyPreset();
        }
        loaded = true;
    }

    /** 从预置预填（只在新建时；预置 id 由导航带进来）。 */
    private void applyPreset() {
        ModelPresets.Provider p = ModelPresets.providerById(presetId);
        if (p == null) return;
        displayName = p.label == null ? "" : p.label.trim();
        baseUrl = ModelsScreen.U.recommendedEndpoint(p);
        api = "openai";
        models.clear();
        if (p.commonModels != null) {
            for (int i = 0; i < p.commonModels.length; i++) {
                String m = p.commonModels[i] == null ? "" : p.commonModels[i].trim();
                if (m.length() > 0 && !models.contains(m)) models.add(m);
            }
        }
    }

    private static String describe(Throwable th) {
        String m = th.getMessage();
        return th.getClass().getSimpleName() + (m == null || m.length() == 0 ? "" : ("：" + m));
    }

    // ================================================================ 渲染

    private void renderPage() {
        root.removeAllViews();
        if (!loaded) {
            root.addView(errorPage(loadError == null ? "配置尚未载入" : loadError),
                    new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
            return;
        }

        LinearLayout col = Ui.column(activity);
        col.addView(header(isNew ? "新建渠道" : "编辑渠道"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity,
                isNew ? "填地址和 Key 后保存"
                        : "只改这一条渠道；没动过的字段原样保留。",
                Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        if (missingNote != null) {
            TextView missing = Ui.text(activity, missingNote, Theme.T_CAP, t.toneStrong);
            missing.setLineSpacing(dp(3), 1f);
            col.addView(missing, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        }

        col.addView(basicCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(keyCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(modelsCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(testCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        if (!isNew) col.addView(dangerCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 先挂正文、后挂保存栏：保存栏是浮层，必须在最上层，否则会被 ScrollView 盖住点不到。
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(150));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        root.addView(scroll, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        root.addView(saveBar(), barLp());
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
        LinearLayout box = ModelsScreen.W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary), Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        if (subtitle != null && subtitle.length() > 0) {
            TextView s = Ui.text(activity, subtitle, Theme.T_CAP, t.textSecondary);
            s.setLineSpacing(dp(2), 1f);
            box.addView(s, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));
        }
        LinearLayout holder = Ui.column(activity);
        box.addView(holder, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return new Card(card, holder);
    }

    // ---------------------------------------------------------------- 基本信息

    private View basicCard() {
        Card c = cardShell("基本信息", null);
        LinearLayout holder = c.body;

        holder.addView(ModelsScreen.W.row(activity, t, "显示名",
                displayName.length() == 0 ? "未填（保存时按地址主机名补）" : displayName, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ModelsScreen.W.textDialog(activity, t, "渠道显示名",
                                "留空按域名自动填",
                                displayName, InputType.TYPE_CLASS_TEXT, false, null,
                                new ModelsScreen.W.TextCb() {
                                    @Override
                                    public void onText(String text) {
                                        displayName = text;
                                        renderPage();
                                    }
                                });
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        holder.addView(ModelsScreen.W.row(activity, t, "接口类型",
                "anthropic".equals(api) ? "anthropic（/messages）" : "openai（/chat/completions）", true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ModelsScreen.W.chooseDialog(activity, t, "接口类型",
                                "不确定就用 openai 兼容",
                                new String[]{"openai 兼容（/chat/completions）", "anthropic（/messages）"},
                                new String[]{"openai", "anthropic"}, api,
                                new ModelsScreen.W.TextCb() {
                                    @Override
                                    public void onText(String text) {
                                        api = "anthropic".equals(text) ? "anthropic" : "openai";
                                        renderPage();
                                    }
                                });
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        holder.addView(ModelsScreen.W.row(activity, t, "服务地址",
                baseUrl.length() == 0 ? "未填（必填）" : baseUrl, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        ModelsScreen.W.textDialog(activity, t, "服务地址",
                                "填到 /v1 那一层"
                                        + "",
                                baseUrl, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, false,
                                new ModelsScreen.W.Check() {
                                    @Override
                                    public String check(String text) {
                                        if (text == null || text.trim().length() == 0) return "服务地址不能为空";
                                        if (ModelsScreen.U.hostOf(text).length() == 0) return "看不懂这个地址：" + text;
                                        return null;
                                    }
                                },
                                new ModelsScreen.W.TextCb() {
                                    @Override
                                    public void onText(String text) {
                                        baseUrl = text;
                                        renderPage();
                                    }
                                });
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        holder.addView(ModelsScreen.W.row(activity, t, "渠道 id",
                isNew ? "保存后自动生成（custom_…）" : providerId, false, null),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        ModelPresets.Service svc = ModelPresets.serviceForBaseUrl(baseUrl);
        TextView note = Ui.text(activity,
                "OpenCode 的会话头会自动带上，不用配。"
                        + ""
                        + (svc == null
                        ? "这家没有档位预设"
                        : "当前地址命中预置服务「" + svc.label + "」，思考强度按它给档位。"),
                Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        holder.addView(note, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ModelPresets.Provider preset = ModelPresets.providerById(presetId);
        if (preset != null && preset.note != null && preset.note.length() > 0) {
            TextView pn = Ui.text(activity, "预置说明：" + preset.note, Theme.T_CAP, t.textTertiary);
            pn.setLineSpacing(dp(3), 1f);
            holder.addView(pn, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        }
        return c.view;
    }

    // ---------------------------------------------------------------- Key

    private View keyCard() {
        Card c = cardShell("API Key",
                "只显示有没有，不显示内容");
        LinearLayout holder = c.body;

        final boolean has = !isNew && ModelsScreen.U.providerKeyPresent(data, providerId);
        holder.addView(ModelsScreen.W.row(activity, t, "渠道 Key",
                has ? "已配置（点这里替换）" : "未配置（点这里填写）", true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        askKey();
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView tip = Ui.text(activity,
                "保存时写入，离开本页就丢。"
                        + ""
                        + (isNew ? "" : ""),
                Theme.T_CAP, t.textTertiary);
        tip.setLineSpacing(dp(3), 1f);
        holder.addView(tip, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        if (keyInput != null) {
            TextView pending = Ui.text(activity, "✓ 已输入新 Key（保存后写入，内容不回显）",
                    Theme.T_CAP, t.toneStrong);
            pending.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            holder.addView(pending, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        }
        return c.view;
    }

    // ---------------------------------------------------------------- 模型

    private View modelsCard() {
        Card c = cardShell("模型（" + models.size() + "）",
                "这里只列可选模型");
        LinearLayout holder = c.body;

        if (models.isEmpty()) {
            TextView empty = Ui.text(activity,
                    "还没有模型",
                    Theme.T_CAP, t.textTertiary);
            empty.setLineSpacing(dp(3), 1f);
            holder.addView(empty, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }
        for (int i = 0; i < models.size(); i++) {
            if (i > 0) holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
            holder.addView(modelRow(models.get(i)), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        TextView add = Ui.button(activity, t, "＋ 添加模型", false);
        add.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askModel();
            }
        });
        holder.addView(add, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        TextView tip = Ui.text(activity,
                "手机端不联网拉取，请手输。",
                Theme.T_CAP, t.textTertiary);
        tip.setLineSpacing(dp(3), 1f);
        holder.addView(tip, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        return c.view;
    }

    private View modelRow(final String id) {
        LinearLayout row = Ui.row(activity);
        row.setMinimumHeight(dp(Theme.TOUCH));
        row.setPadding(0, dp(8), 0, dp(8));

        TextView name = Ui.mono(activity, Theme.T_BODY, t.textPrimary);
        name.setText(id);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        LinearLayout.LayoutParams nlp = Ui.llp(0, WRAP_CONTENT);
        nlp.weight = 1f;
        nlp.rightMargin = dp(Theme.S2);
        row.addView(name, nlp);

        TextView del = Ui.text(activity, "×", Theme.T_CARD, t.textSecondary);
        del.setGravity(Gravity.CENTER);
        del.setBackground(Drawables.circle(t.ghostFill, t.ghostStroke, dp(1)));
        del.setClickable(true);
        del.setFocusable(true);
        del.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                models.remove(id);
                renderPage();
            }
        });
        Ui.press(del, 0.9f);
        row.addView(del, Ui.llp(dp(34), dp(34)));
        return row;
    }

    // ---------------------------------------------------------------- 连通性测试

    /**
     * 「测试这个渠道」：让运行端拿这条渠道的地址（+ 刚填的 Key）真发一次最小请求。
     *
     * <p>运行端无令牌时它的 authorize() 只放行「远端是回环 + Host 头是 127.0.0.1/localhost」，
     * 所以这里手写 Host 头 —— 与控制台 <code>POST /api/config/reload</code> 同款写法。
     * 结果只 toast「连通 / 失败」，<b>不打印 Key</b>；线程里任何异常都吞掉，绝不让面板崩。
     */
    private View testCard() {
        Card c = cardShell("连通性", null);
        LinearLayout holder = c.body;

        final TextView btn = Ui.button(activity, t, "测试这个渠道", false);
        btn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Ui.enabled(btn, false);
                btn.setText("测试中…");
                testChannel(btn);
            }
        });
        holder.addView(btn, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView tip = Ui.text(activity, "走运行端发一次最小请求，3 秒超时。",
                Theme.T_CAP, t.textTertiary);
        tip.setLineSpacing(dp(3), 1f);
        holder.addView(tip, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    private void testChannel(final TextView btn) {
        final String base = baseUrl == null ? "" : baseUrl.trim();
        if (base.length() == 0) {
            restoreTestButton(btn);
            ModelsScreen.W.toast(activity, "先填服务地址");
            return;
        }
        if (ModelsScreen.U.hostOf(base).length() == 0) {
            restoreTestButton(btn);
            ModelsScreen.W.toast(activity, "服务地址不是合法 URL");
            return;
        }
        final String key = keyInput == null ? "" : keyInput;
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean ok = false;
                HttpURLConnection c = null;
                try {
                    URL url = new URL("http://127.0.0.1:" + TEST_PORT + "/api/providers/test-one");
                    c = (HttpURLConnection) url.openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(3000);
                    c.setReadTimeout(3000);
                    c.setDoOutput(true);
                    c.setRequestProperty("Host", "127.0.0.1:" + TEST_PORT);
                    c.setRequestProperty("Content-Type", "application/json");
                    byte[] body = testBody(base, key).getBytes("UTF-8");
                    c.setFixedLengthStreamingMode(body.length);
                    OutputStream out = c.getOutputStream();
                    try {
                        out.write(body);
                    } finally {
                        out.close();
                    }
                    int code = c.getResponseCode();
                    ok = code >= 200 && code < 300;
                    // body 必须读掉，否则连接不一定归还
                    drain(code >= 400 ? c.getErrorStream() : c.getInputStream());
                } catch (Throwable ignored) {
                    ok = false;
                } finally {
                    if (c != null) {
                        try {
                            c.disconnect();
                        } catch (Throwable ignored) {
                            // 断不开也无所谓
                        }
                    }
                }
                final boolean result = ok;
                try {
                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            restoreTestButton(btn);
                            ModelsScreen.W.toast(activity, result ? "连通" : "失败");
                        }
                    });
                } catch (Throwable ignored) {
                    // 页面已经没了：不弹就是了
                }
            }
        }, "prov-test").start();
    }

    private void restoreTestButton(TextView btn) {
        if (btn == null) return;
        btn.setText("测试这个渠道");
        Ui.enabled(btn, true);
    }

    /** 请求体：{@code {"baseUrl":"…"}}，Key 非空才带 {@code "apiKey"}。 */
    private static String testBody(String base, String key) {
        StringBuilder sb = new StringBuilder(200);
        sb.append("{\"baseUrl\":").append(jsonString(base));
        if (key != null && key.length() > 0) sb.append(",\"apiKey\":").append(jsonString(key));
        sb.append('}');
        return sb.toString();
    }

    /** 只做 JSON 字符串转义（不引 JSON 库：这里就两个字段）。 */
    private static String jsonString(String s) {
        String v = s == null ? "" : s;
        StringBuilder sb = new StringBuilder(v.length() + 2);
        sb.append('"');
        for (int i = 0; i < v.length(); i++) {
            char ch = v.charAt(i);
            switch (ch) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (ch < 0x20) {
                        String hex = Integer.toHexString(ch);
                        sb.append("\\u");
                        for (int k = hex.length(); k < 4; k++) sb.append('0');
                        sb.append(hex);
                    } else {
                        sb.append(ch);
                    }
                    break;
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static void drain(InputStream in) {
        if (in == null) return;
        try {
            byte[] buf = new byte[2048];
            int total = 0;
            int n;
            while ((n = in.read(buf)) > 0 && total < 65536) total += n;
        } catch (Throwable ignored) {
            // 读不完就算了
        } finally {
            try {
                in.close();
            } catch (Throwable ignored) {
                // 关不掉也无所谓
            }
        }
    }

    // ---------------------------------------------------------------- 删除

    private View dangerCard() {
        Card c = cardShell("删除渠道", "删掉这条渠道和它的 Key");
        LinearLayout holder = c.body;

        TextView del = Ui.button(activity, t, "删除这条渠道", false);
        del.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askDelete();
            }
        });
        holder.addView(del, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView tip = Ui.text(activity,
                "聊天主模型正用着它的话会被清空。"
                        + ""
                        + "",
                Theme.T_CAP, t.textTertiary);
        tip.setLineSpacing(dp(3), 1f);
        holder.addView(tip, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        return c.view;
    }

    // ---------------------------------------------------------------- 保存栏

    private FrameLayout saveBar() {
        final FrameLayout bar = Ui.card(activity, t);
        LinearLayout inner = Ui.row(activity);
        inner.setPadding(dp(Theme.S3), dp(Theme.S2), dp(Theme.S2), dp(Theme.S2));
        bar.addView(inner, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        TextView status = Ui.text(activity,
                keyInput != null ? "Key 已输入，保存后生效" : "点保存才写回 config.json",
                Theme.T_CAP, keyInput != null ? t.toneStrong : t.textSecondary);
        LinearLayout.LayoutParams slp = Ui.llp(0, WRAP_CONTENT);
        slp.weight = 1f;
        slp.rightMargin = dp(Theme.S1);
        inner.addView(status, slp);

        TextView cancel = Ui.button(activity, t, "取消", false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.handleBack();
            }
        });
        inner.addView(cancel, Ui.llp(WRAP_CONTENT, WRAP_CONTENT));

        TextView save = Ui.button(activity, t, "保存", true);
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                doSave();
            }
        });
        LinearLayout.LayoutParams saveLp = Ui.llp(WRAP_CONTENT, WRAP_CONTENT);
        saveLp.leftMargin = dp(Theme.S1);
        inner.addView(save, saveLp);
        return bar;
    }

    private FrameLayout.LayoutParams barLp() {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lp.leftMargin = dp(Theme.S3);
        lp.rightMargin = dp(Theme.S3);
        lp.bottomMargin = dp(Theme.S3);
        return lp;
    }

    // ================================================================ 输入浮层

    private void askKey() {
        ModelsScreen.W.textDialog(activity, t, "填写渠道 API Key",
                "保存后写入，内容不回显"
                        + "页面关闭即丢弃；本页永远不显示已存的 Key。",
                "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.length() == 0) return "Key 不能为空（不想改就点取消）";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        keyInput = text;
                        renderPage();
                    }
                });
    }

    private void askModel() {
        ModelsScreen.W.textDialog(activity, t, "添加模型", "一行一个模型 id；重复的会自动跳过。",
                "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE, true,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.trim().length() == 0) return "至少要填一个模型 id";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        String[] lines = text.split("\\r?\\n");
                        for (int i = 0; i < lines.length; i++) {
                            String m = lines[i].trim();
                            if (m.length() > 0 && !models.contains(m)) models.add(m);
                        }
                        renderPage();
                    }
                });
    }

    private void askDelete() {
        ModelsScreen.W.confirmDialog(activity, t, "删除渠道「" + shownName() + "」？",
                "会删掉这条渠道和它的 Key。",
                "删除", new Runnable() {
                    @Override
                    public void run() {
                        doDelete();
                    }
                });
    }

    // ================================================================ 保存 / 删除

    private String shownName() {
        if (displayName.length() > 0) return displayName;
        if (isNew) return "新建渠道";
        return providerId;
    }

    private void doSave() {
        String base = baseUrl == null ? "" : baseUrl.trim();
        if (base.length() == 0) {
            ModelsScreen.W.toast(activity, "服务地址不能为空");
            return;
        }
        String host = ModelsScreen.U.hostOf(base);
        if (host.length() == 0) {
            ModelsScreen.W.toast(activity, "服务地址不是合法 URL：" + base);
            return;
        }

        Object working = BotConfigJson.deepCopy(data);
        Map<String, Object> provider;
        if (isNew) {
            providerId = newProviderId(working);
            provider = new LinkedHashMap<String, Object>();
            // 字段形状与运行端 upsertProvider 建出来的记录一致（合同 §0.1）
            provider.put("id", providerId);
            provider.put("displayName", displayName.length() == 0 ? host : displayName);
            provider.put("api", "anthropic".equals(api) ? "anthropic" : "openai");
            provider.put("anthropicOrigin", Boolean.FALSE);
            provider.put("baseURL", base);
            provider.put("apiKey", "");
            provider.put("apiKeyFrom", keyInput != null ? "manual" : "");
            provider.put("needsBaseUrl", Boolean.FALSE);
            provider.put("models", stringList(models));
            provider.put("modelNames", nameMap(models));
            if (!appendProvider(working, provider)) {
                ModelsScreen.W.toast(activity, "providers[] 不是数组，没法新增渠道");
                return;
            }
        } else {
            provider = ModelsScreen.U.providerById(working, providerId);
            if (provider == null) {
                ModelsScreen.W.toast(activity, "这条渠道已经不在了");
                return;
            }
            // 只 set 自己名下的字段：别的（thinkingProbe 之类）原样保留
            provider.put("displayName", displayName.length() == 0 ? host : displayName);
            provider.put("baseURL", base);
            provider.put("api", "anthropic".equals(api) ? "anthropic" : "openai");
            provider.put("models", stringList(models));
            provider.put("modelNames", mergeNames(provider.get("modelNames"), models));
        }

        boolean wroteKey = keyInput != null && keyInput.length() > 0;
        if (wroteKey) {
            ModelsScreen.U.setProviderKey(working, providerId, keyInput);
            provider.put("apiKeyFrom", "manual");
        }

        String json;
        try {
            json = BotConfigJson.write(working);
        } catch (Throwable th) {
            ModelsScreen.W.toast(activity, "序列化失败：" + describe(th));
            return;
        }
        boolean ok;
        try {
            ok = cfg.saveConfigJson(json);
        } catch (Throwable th) {
            ok = false;
        }
        if (!ok) {
            ModelsScreen.W.toast(activity, "保存失败，改动还在");
            return;
        }

        data = working;
        boolean wasNew = isNew;
        keyInput = null;
        ModelsScreen.W.toast(activity, wasNew
                ? ("已保存：新渠道已建立" + (wroteKey ? "（含 Key）" : "（未填 Key）"))
                : ("已保存" + (wroteKey ? "（Key 已更新）" : "")));
        shell.handleBack();
    }

    private void doDelete() {
        Object working = BotConfigJson.deepCopy(data);
        if (!removeProvider(working, providerId)) {
            ModelsScreen.W.toast(activity, "providers[] 不是数组，没法删除");
            return;
        }
        ModelsScreen.U.mapRemove(working, "providerKeys", providerId);

        // 聊天主模型正指着它 → 清空，别让运行端拿着一个已不存在的渠道 id
        String cur = ModelsScreen.U.s(BotConfigJson.get(working, "api.provider")).trim();
        if (providerId.equals(cur)) {
            BotConfigJson.set(working, "api.provider", "");
            BotConfigJson.set(working, "api.model", "");
            String apiBase = ModelsScreen.U.s(BotConfigJson.get(working, "api.baseUrl")).trim();
            if (apiBase.length() == 0
                    || ModelsScreen.U.hostOf(apiBase).equals(ModelsScreen.U.hostOf(baseUrl))) {
                BotConfigJson.set(working, "api.baseUrl", "");
            }
        }

        String json;
        try {
            json = BotConfigJson.write(working);
        } catch (Throwable th) {
            ModelsScreen.W.toast(activity, "序列化失败：" + describe(th));
            return;
        }
        boolean ok;
        try {
            ok = cfg.saveConfigJson(json);
        } catch (Throwable th) {
            ok = false;
        }
        if (!ok) {
            ModelsScreen.W.toast(activity, "删除失败：config.json 没有写成功");
            return;
        }
        ModelsScreen.W.toast(activity, "已删除渠道");
        shell.handleBack();
    }

    // ================================================================ 数组工具

    private static List<Object> stringList(List<String> src) {
        ArrayList<Object> out = new ArrayList<Object>();
        for (int i = 0; i < src.size(); i++) out.add(src.get(i));
        return out;
    }

    private static Map<String, Object> nameMap(List<String> src) {
        LinkedHashMap<String, Object> out = new LinkedHashMap<String, Object>();
        for (int i = 0; i < src.size(); i++) out.put(src.get(i), src.get(i));
        return out;
    }

    /** 保留已有 modelNames 的顺序与内容，只补上新增的模型、剔掉已删的（别的键不动）。 */
    private static Map<String, Object> mergeNames(Object old, List<String> models) {
        LinkedHashMap<String, Object> out = new LinkedHashMap<String, Object>();
        Map<String, Object> prev = BotConfigJson.asObject(old);
        if (prev != null) {
            for (Map.Entry<String, Object> e : prev.entrySet()) {
                if (models.contains(e.getKey())) out.put(e.getKey(), e.getValue());
            }
        }
        for (int i = 0; i < models.size(); i++) {
            String id = models.get(i);
            if (!out.containsKey(id)) out.put(id, id);
        }
        return out;
    }

    private static boolean appendProvider(Object root, Map<String, Object> provider) {
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "providers"));
        if (arr == null) {
            Object cur = BotConfigJson.get(root, "providers");
            if (cur != BotConfigJson.MISSING && cur != BotConfigJson.NULL) return false; // 有但不是数组
            arr = new ArrayList<Object>();
            BotConfigJson.set(root, "providers", arr);
        }
        arr.add(provider);
        return true;
    }

    private static boolean removeProvider(Object root, String id) {
        List<Object> arr = BotConfigJson.asArray(BotConfigJson.get(root, "providers"));
        if (arr == null) return false;
        for (int i = arr.size() - 1; i >= 0; i--) {
            Map<String, Object> p = BotConfigJson.asObject(arr.get(i));
            if (p != null && id != null && id.equals(ModelsScreen.U.s(p.get("id")).trim())) {
                arr.remove(i);
            }
        }
        return true;
    }

    /** 新渠道 id：与运行端同款形状（custom_ + 36 进制的毫秒时间 + 4 位随机）。 */
    private static String newProviderId(Object root) {
        String base = "custom_" + Long.toString(System.currentTimeMillis(), 36);
        String id = base;
        int guard = 0;
        while (ModelsScreen.U.providerById(root, id) != null && guard < 100) {
            id = base + Integer.toString(16 + (int) (Math.random() * 0xE0), 36);
            guard++;
        }
        return id;
    }

    // ================================================================ 错误页 / 杂项

    private View errorPage(String msg) {
        LinearLayout col = Ui.column(activity);
        col.addView(header("渠道"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = ModelsScreen.W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        box.addView(Ui.strong(activity, "打不开这一页", Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        TextView body = Ui.text(activity, msg, Theme.T_CAP, t.textSecondary);
        body.setLineSpacing(dp(4), 1f);
        box.addView(body, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        TextView back = Ui.button(activity, t, "返回", true);
        back.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                shell.handleBack();
            }
        });
        box.addView(back, mt(Ui.llp(WRAP_CONTENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(card, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    private static LinearLayout.LayoutParams mt(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }
}
