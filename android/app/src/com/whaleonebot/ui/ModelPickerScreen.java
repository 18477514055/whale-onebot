package com.whaleonebot.ui;

import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 用途选择页：给某一个用途（{@code chat|memory|image|asr|tts}）选「渠道 + 模型」。
 *
 * <p><b>写哪些路径</b>（合同 v1.3 §0.2，逐用途照抄，绝不越界）：
 * <ul>
 *   <li>chat：{@code api.provider} / {@code api.model} / {@code api.baseUrl}</li>
 *   <li>memory：{@code memory.useChatModel} / {@code memory.provider} / {@code memory.model}</li>
 *   <li>image：{@code imageGen.enabled} / {@code imageGen.baseUrl} / {@code imageGen.model}
 *       / {@code imageGen.keys[主机]}</li>
 *   <li>asr：{@code asr.enabled} / {@code asr.provider} / {@code asr.baseUrl} / {@code asr.model}
 *       / {@code asr.keys[槽位].apiKey}</li>
 *   <li>tts：{@code tts.enabled} / {@code tts.provider} / {@code tts.baseUrl} / {@code tts.model}
 *       / {@code tts.keys[服务id]}</li>
 * </ul>
 *
 * <p><b>关于 Key</b>：chat / memory 的 Key 属于<b>渠道</b>，在 {@link ProviderEditScreen} 里填
 * （{@code providerKeys[id]}）；这里只管「这个用途用哪个渠道的哪把」。
 * image / asr / tts 三家没有渠道目录，Key 是按用途单独存的（而且三种形状并不一样：
 * {@code tts.keys} 是字符串、{@code asr.keys} 是对象、{@code imageGen.keys} 按主机名），
 * 所以这三行的 Key 编辑放在本页 —— 否则「语音 / 生图的 Key」在手机上根本无处可填。
 * 三条写入都只有一种实现（{@link ModelsScreen.U}），本页也<b>从不读</b> Key 的值，只读「有没有」。
 *
 * <p>所有输入都走浮层（{@link ModelsScreen.W#textDialog}），页内没有 EditText，
 * 从根上避开「点输入框页面弹回顶部」那个坑。
 */
final class ModelPickerScreen extends Screen {

    // ---------------- ASR 服务表（来源：运行端 asr 预设与 core/config.js 的 provider 分支） ----------------
    // 包内可见：ModelsScreen 的语音卡只借这两张表算「服务名 / Key 槽位」，不再另造一份。
    static final String[][] ASR_SERVICES = {
            // id, label, provider, baseUrl, 常用模型
            {"siliconflow", "OpenAI 兼容 · 硅基流动 whisper", "openai", "https://api.siliconflow.cn/v1",
                    "FunAudioLLM/SenseVoiceSmall"},
            {"openai", "OpenAI 官方", "openai", "https://api.openai.com/v1",
                    "whisper-1,gpt-4o-mini-transcribe"},
            {"volc", "火山引擎（Seed-ASR，WebSocket 按量）", "volc", "", ""},
            {"aliyun", "阿里百炼", "aliyun", "", ""},
            {"baidu", "百度语音", "baidu", "", ""},
            {"tencent", "腾讯云", "tencent", "", ""},
            {"iflytek", "讯飞", "iflytek", "", ""},
            {"local", "本机 whisper.cpp（不联网、不要 Key）", "local", "", ""},
    };

    // ---------------- TTS 服务表（来源：src/llm/tts-presets.js 的 TTS_SERVICES） ----------------
    static final String[][] TTS_SERVICES = {
            // id, label, provider, baseUrl, 常用模型
            {"siliconflow", "硅基流动（CosyVoice2，国内可直连）", "openai", "https://api.siliconflow.cn/v1",
                    "FunAudioLLM/CosyVoice2-0.5B"},
            {"openai", "OpenAI 官方", "openai", "https://api.openai.com/v1", "gpt-4o-mini-tts,tts-1"},
            {"volc", "火山引擎 · 语音合成 v1（需 AppID）", "volc",
                    "https://openspeech.bytedance.com/api/v1/tts", ""},
            {"doubao", "火山引擎 · 豆包语音合成 2.0", "doubao",
                    "https://openspeech.bytedance.com/api/v3/tts/unidirectional", ""},
            {"minimax", "MiniMax 语音（T2A v2，需 GroupId）", "minimax", "https://api.minimax.chat",
                    "speech-02-hd,speech-01-turbo"},
            {"mimo", "小米 MiMo（token-plan）", "mimo", "https://token-plan-cn.xiaomimimo.com/v1",
                    "mimo-v2.5-tts"},
            {"custom", "自定义 / 自建（OpenAI 兼容 /audio/speech）", "openai", "", ""},
    };

    private final String role;

    private BotConfigHost cfg;
    private Object data;
    private boolean loaded;
    private String loadError;
    private boolean built;

    // ---- 表单状态 ----
    private String providerId = "";   // chat / memory：目录渠道 id
    private boolean followChat;       // memory：跟随聊天主模型
    private boolean enabled;          // image / asr / tts
    private String provider = "";     // asr / tts：运行时服务名
    private String baseUrl = "";
    private String model = "";
    private boolean baseUrlTouched;   // chat：只有用户真的选/改过地址才写 api.baseUrl
    /** 用户这次填的新 Key；null = 不动。只在内存，保存后丢。 */
    private String keyInput;

    ModelPickerScreen(AppShell shell, String role) {
        super(shell);
        this.role = normalizeRole(role);
    }

    private static String normalizeRole(String role) {
        String r = role == null ? "" : role.trim().toLowerCase(Locale.US);
        if (ModelsScreen.U.ROLE_MEMORY.equals(r)) return ModelsScreen.U.ROLE_MEMORY;
        if (ModelsScreen.U.ROLE_IMAGE.equals(r)) return ModelsScreen.U.ROLE_IMAGE;
        if (ModelsScreen.U.ROLE_ASR.equals(r)) return ModelsScreen.U.ROLE_ASR;
        if (ModelsScreen.U.ROLE_TTS.equals(r)) return ModelsScreen.U.ROLE_TTS;
        return ModelsScreen.U.ROLE_CHAT;
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
            loadError = "宿主没有提供配置读写通道（BotConfigHost），拿不到 config.json。";
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
            loadError = "读不到 config.json（容器没起，或运行端还没落盘）。";
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

        if (ModelsScreen.U.ROLE_CHAT.equals(role)) {
            providerId = ModelsScreen.U.s(BotConfigJson.get(data, "api.provider")).trim();
            model = ModelsScreen.U.s(BotConfigJson.get(data, "api.model")).trim();
            baseUrl = ModelsScreen.U.s(BotConfigJson.get(data, "api.baseUrl")).trim();
        } else if (ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            followChat = ModelsScreen.U.truthy(BotConfigJson.get(data, "memory.useChatModel"));
            providerId = ModelsScreen.U.s(BotConfigJson.get(data, "memory.provider")).trim();
            model = ModelsScreen.U.s(BotConfigJson.get(data, "memory.model")).trim();
        } else if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            enabled = ModelsScreen.U.truthy(BotConfigJson.get(data, "imageGen.enabled"));
            baseUrl = ModelsScreen.U.s(BotConfigJson.get(data, "imageGen.baseUrl")).trim();
            model = ModelsScreen.U.s(BotConfigJson.get(data, "imageGen.model")).trim();
        } else if (ModelsScreen.U.ROLE_ASR.equals(role)) {
            enabled = ModelsScreen.U.truthy(BotConfigJson.get(data, "asr.enabled"));
            provider = ModelsScreen.U.s(BotConfigJson.get(data, "asr.provider")).trim();
            baseUrl = ModelsScreen.U.s(BotConfigJson.get(data, "asr.baseUrl")).trim();
            model = ModelsScreen.U.s(BotConfigJson.get(data, "asr.model")).trim();
        } else {
            enabled = ModelsScreen.U.truthy(BotConfigJson.get(data, "tts.enabled"));
            provider = ModelsScreen.U.s(BotConfigJson.get(data, "tts.provider")).trim();
            baseUrl = ModelsScreen.U.s(BotConfigJson.get(data, "tts.baseUrl")).trim();
            model = ModelsScreen.U.s(BotConfigJson.get(data, "tts.model")).trim();
        }
        loaded = true;
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
        col.addView(header("选择模型 · " + ModelsScreen.U.roleLabel(role)), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView sub = Ui.text(activity, subtitle(), Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        col.addView(channelCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(modelCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        if (hasOwnKey()) col.addView(keyCard(), mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

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

    private String subtitle() {
        if (ModelsScreen.U.ROLE_CHAT.equals(role)) {
            return "聊天用渠道的地址和 Key";
        }
        if (ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            return "记忆整理用哪个模型";
        }
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            return "留空 = 跟聊天同一家"
                    + "";
        }
        if (ModelsScreen.U.ROLE_ASR.equals(role)) {
            return "语音转文字";
        }
        return "文字转语音";
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

    // ---------------------------------------------------------------- 渠道 / 服务

    private View channelCard() {
        Card c = cardShell("渠道", null);
        LinearLayout holder = c.body;

        if (ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            holder.addView(ModelsScreen.W.switchRow(activity, t, "跟随聊天主模型",
                    "开启后跟聊天模型一致",
                    followChat, new BotConfigToggle.OnChange() {
                        @Override
                        public void onChanged(boolean on) {
                            followChat = on;
                            renderPage();
                        }
                    }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            if (!followChat) holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        }

        if (!ModelsScreen.U.ROLE_MEMORY.equals(role) || !followChat) {
            holder.addView(ModelsScreen.W.row(activity, t, channelTitle(), channelValue(), true,
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            askChannel();
                        }
                    }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        if (needsAddress()) {
            holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
            holder.addView(ModelsScreen.W.row(activity, t, "服务地址（Base URL）", addressValue(), true,
                    new View.OnClickListener() {
                        @Override
                        public void onClick(View v) {
                            askAddress();
                        }
                    }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        if (needsEnable()) {
            holder.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
            holder.addView(ModelsScreen.W.switchRow(activity, t, "启用这个用途",
                    "关掉不会清空已填内容",
                    enabled, new BotConfigToggle.OnChange() {
                        @Override
                        public void onChanged(boolean on) {
                            enabled = on;
                            renderPage();
                        }
                    }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        }

        TextView note = Ui.text(activity, channelNote(), Theme.T_CAP, t.textTertiary);
        note.setLineSpacing(dp(3), 1f);
        holder.addView(note, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return c.view;
    }

    private boolean needsEnable() {
        return ModelsScreen.U.ROLE_IMAGE.equals(role)
                || ModelsScreen.U.ROLE_ASR.equals(role)
                || ModelsScreen.U.ROLE_TTS.equals(role);
    }

    private boolean needsAddress() {
        return needsEnable();
    }

    private String channelTitle() {
        if (ModelsScreen.U.ROLE_CHAT.equals(role) || ModelsScreen.U.ROLE_MEMORY.equals(role)) return "渠道";
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) return "图片服务";
        if (ModelsScreen.U.ROLE_ASR.equals(role)) return "识别服务";
        return "合成服务";
    }

    private String channelValue() {
        if (ModelsScreen.U.ROLE_CHAT.equals(role) || ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            if (providerId.length() == 0) return "未选择";
            return ModelsScreen.U.providerName(data, providerId);
        }
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            if (baseUrl.length() == 0) return "跟聊天模型同域";
            List<Map<String, Object>> all = ModelsScreen.U.providerList(data);
            for (int i = 0; i < all.size(); i++) {
                String u = ModelsScreen.U.providerBaseUrl(all.get(i));
                if (u.length() > 0 && ModelsScreen.U.hostOf(u).equals(ModelsScreen.U.hostOf(baseUrl))) {
                    String n = ModelsScreen.U.s(all.get(i).get("displayName")).trim();
                    return n.length() == 0 ? ModelsScreen.U.hostOf(baseUrl) : n;
                }
            }
            return ModelsScreen.U.hostOf(baseUrl);
        }
        String[][] table = ModelsScreen.U.ROLE_ASR.equals(role) ? ASR_SERVICES : TTS_SERVICES;
        for (int i = 0; i < table.length; i++) {
            if (table[i][2].equals(provider) && sameHost(table[i][3], baseUrl)) return table[i][1];
        }
        return ModelsScreen.U.ROLE_ASR.equals(role)
                ? ModelsScreen.U.asrLabel(provider) : ModelsScreen.U.ttsLabel(provider);
    }

    private static boolean sameHost(String a, String b) {
        return ModelsScreen.U.hostOf(a).equals(ModelsScreen.U.hostOf(b));
    }

    private String addressValue() {
        if (baseUrl.length() == 0) return "未填（留空 = 用服务默认 / 跟聊天同域）";
        return baseUrl;
    }

    private String channelNote() {
        if (ModelsScreen.U.ROLE_CHAT.equals(role)) {
            return "先去「渠道」建一个";
        }
        if (ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            return "用渠道的地址和 Key";
        }
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            return "留空 = 跟聊天同一家；填别家地址要单独填 Key"
                    + "";
        }
        if (ModelsScreen.U.ROLE_ASR.equals(role)) {
            return "OpenAI 兼容服务填到 /v1；本机 whisper 不用 Key"
                    + "";
        }
        return "OpenAI 兼容服务填到 /v1"
                + "靠路径区分，切换服务时别只改域名。";
    }

    private void askChannel() {
        if (ModelsScreen.U.ROLE_CHAT.equals(role) || ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            List<Map<String, Object>> providers = ModelsScreen.U.providerList(data);
            ArrayList<String> labels = new ArrayList<String>();
            ArrayList<String> values = new ArrayList<String>();
            labels.add("不使用（清空这个用途的渠道）");
            values.add("");
            for (int i = 0; i < providers.size(); i++) {
                String id = ModelsScreen.U.s(providers.get(i).get("id")).trim();
                String name = ModelsScreen.U.s(providers.get(i).get("displayName")).trim();
                String host = ModelsScreen.U.hostOf(ModelsScreen.U.providerBaseUrl(providers.get(i)));
                labels.add((name.length() == 0 ? id : name) + (host.length() == 0 ? "" : ("  ·  " + host)));
                values.add(id);
            }
            ModelsScreen.W.chooseDialog(activity, t, "选择渠道",
                    "要新建渠道回上一页",
                    labels.toArray(new String[0]), values.toArray(new String[0]), providerId,
                    new ModelsScreen.W.TextCb() {
                        @Override
                        public void onText(String text) {
                            providerId = text == null ? "" : text;
                            if (providerId.length() > 0) {
                                Map<String, Object> p = ModelsScreen.U.providerById(data, providerId);
                                if (p != null) {
                                    baseUrl = ModelsScreen.U.providerBaseUrl(p);
                                    baseUrlTouched = true;
                                    if (model.length() == 0) {
                                        List<String> ms = ModelsScreen.U.providerModels(p);
                                        if (!ms.isEmpty()) model = ms.get(0);
                                    }
                                }
                            }
                            renderPage();
                        }
                    });
            return;
        }

        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            List<Map<String, Object>> providers = ModelsScreen.U.providerList(data);
            ArrayList<String> labels = new ArrayList<String>();
            ArrayList<String> values = new ArrayList<String>();
            labels.add("跟聊天模型同域（留空地址，复用聊天 Key）");
            values.add("");
            for (int i = 0; i < providers.size(); i++) {
                String id = ModelsScreen.U.s(providers.get(i).get("id")).trim();
                String name = ModelsScreen.U.s(providers.get(i).get("displayName")).trim();
                String host = ModelsScreen.U.hostOf(ModelsScreen.U.providerBaseUrl(providers.get(i)));
                labels.add((name.length() == 0 ? id : name) + (host.length() == 0 ? "" : ("  ·  " + host)));
                values.add("prov:" + id);
            }
            labels.add("自定义地址（下面自己填）");
            values.add("custom");
            ModelsScreen.W.chooseDialog(activity, t, "图片服务",
                    "走 OpenAI 兼容的 /images/generations",
                    labels.toArray(new String[0]), values.toArray(new String[0]), "",
                    new ModelsScreen.W.TextCb() {
                        @Override
                        public void onText(String text) {
                            String v = text == null ? "" : text;
                            if (v.length() == 0) {
                                baseUrl = "";
                            } else if (v.startsWith("prov:")) {
                                Map<String, Object> p = ModelsScreen.U.providerById(data, v.substring(5));
                                if (p != null) baseUrl = ModelsScreen.U.providerBaseUrl(p);
                            }
                            renderPage();
                        }
                    });
            return;
        }

        String[][] table = ModelsScreen.U.ROLE_ASR.equals(role) ? ASR_SERVICES : TTS_SERVICES;
        ArrayList<String> labels = new ArrayList<String>();
        ArrayList<String> values = new ArrayList<String>();
        for (int i = 0; i < table.length; i++) {
            labels.add(table[i][1]);
            values.add(table[i][0]);
        }
        ModelsScreen.W.chooseDialog(activity, t, channelTitle() + " 预设",
                "选中后预填地址",
                labels.toArray(new String[0]), values.toArray(new String[0]), "",
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        String id = text == null ? "" : text;
                        String[][] tb = ModelsScreen.U.ROLE_ASR.equals(role) ? ASR_SERVICES : TTS_SERVICES;
                        for (int i = 0; i < tb.length; i++) {
                            if (!tb[i][0].equals(id)) continue;
                            provider = tb[i][2];
                            baseUrl = tb[i][3];
                            if (model.length() == 0 && tb[i][4].length() > 0) {
                                model = tb[i][4].split(",")[0].trim();
                            }
                            break;
                        }
                        renderPage();
                    }
                });
    }

    private void askAddress() {
        ModelsScreen.W.textDialog(activity, t, "服务地址",
                ModelsScreen.U.ROLE_IMAGE.equals(role)
                        ? "留空 = 用聊天那家的 Key"
                        : "填到 /v1 那一层",
                baseUrl, InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text == null || text.trim().length() == 0) return null; // 允许清空
                        if (ModelsScreen.U.hostOf(text).length() == 0) return "看不懂这个地址：" + text;
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        baseUrl = text;
                        baseUrlTouched = true;
                        renderPage();
                    }
                });
    }

    // ---------------------------------------------------------------- 模型

    private View modelCard() {
        Card c = cardShell("模型", "也可以直接手输");
        LinearLayout holder = c.body;

        holder.addView(ModelsScreen.W.row(activity, t, "当前模型",
                model.length() == 0 ? "未选择" : model, true, new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        askModel();
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (needsEnable()) {
            TextView note = Ui.text(activity,
                    "语音模型和聊天不是一套"
                            + "照服务商文档填。",
                    Theme.T_CAP, t.textTertiary);
            note.setLineSpacing(dp(3), 1f);
            holder.addView(note, mt(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return c.view;
    }

    private List<String> candidateModels() {
        ArrayList<String> out = new ArrayList<String>();
        if (!needsEnable()) {
            Map<String, Object> p = ModelsScreen.U.providerById(data, providerId);
            out.addAll(ModelsScreen.U.providerModels(p));
            return out;
        }
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            List<Map<String, Object>> all = ModelsScreen.U.providerList(data);
            String host = ModelsScreen.U.hostOf(baseUrl);
            for (int i = 0; i < all.size(); i++) {
                String u = ModelsScreen.U.providerBaseUrl(all.get(i));
                if (u.length() == 0 || !ModelsScreen.U.hostOf(u).equals(host)) continue;
                List<String> ms = ModelsScreen.U.providerModels(all.get(i));
                for (int k = 0; k < ms.size(); k++) if (!out.contains(ms.get(k))) out.add(ms.get(k));
            }
            return out;
        }
        String[][] table = ModelsScreen.U.ROLE_ASR.equals(role) ? ASR_SERVICES : TTS_SERVICES;
        for (int i = 0; i < table.length; i++) {
            if (!table[i][2].equals(provider) || !sameHost(table[i][3], baseUrl)) continue;
            if (table[i][4].length() == 0) continue;
            String[] parts = table[i][4].split(",");
            for (int k = 0; k < parts.length; k++) {
                String m = parts[k].trim();
                if (m.length() > 0 && !out.contains(m)) out.add(m);
            }
        }
        return out;
    }

    private void askModel() {
        final List<String> candidates = candidateModels();
        ArrayList<String> labels = new ArrayList<String>();
        ArrayList<String> values = new ArrayList<String>();
        for (int i = 0; i < candidates.size(); i++) {
            labels.add(candidates.get(i));
            values.add(candidates.get(i));
        }
        labels.add("手动输入模型 id…");
        values.add("manual:");
        ModelsScreen.W.chooseDialog(activity, t, "选择模型",
                candidates.isEmpty() ? "这个渠道还没有模型列表，直接手输吧。" : "列表来自渠道的 models[]。",
                labels.toArray(new String[0]), values.toArray(new String[0]), model,
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        if ("manual:".equals(text)) {
                            ModelsScreen.W.textDialog(activity, t, "模型 id",
                                    "原样发给服务商的 model 字段，别带空格。",
                                    model, InputType.TYPE_CLASS_TEXT, false,
                                    new ModelsScreen.W.Check() {
                                        @Override
                                        public String check(String s) {
                                            if (s == null || s.length() == 0) return "模型 id 不能为空";
                                            if (s.indexOf(' ') >= 0) return "模型 id 里不能有空格";
                                            return null;
                                        }
                                    },
                                    new ModelsScreen.W.TextCb() {
                                        @Override
                                        public void onText(String s) {
                                            model = s;
                                            renderPage();
                                        }
                                    });
                            return;
                        }
                        model = text == null ? "" : text;
                        renderPage();
                    }
                });
    }

    // ---------------------------------------------------------------- Key（只给 image / asr / tts）

    private boolean hasOwnKey() {
        if (!needsEnable()) return false;
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) return baseUrl.length() > 0; // 留空时复用聊天 Key
        if (ModelsScreen.U.ROLE_ASR.equals(role) && "local".equals(provider)) return false; // 本机不要 Key
        return true;
    }

    private View keyCard() {
        Card c = cardShell("API Key（写入式，永不回显）",
                "只显示有没有，不显示内容");
        LinearLayout holder = c.body;

        holder.addView(ModelsScreen.W.row(activity, t, "这个用途的 Key",
                keyPresent() ? "已配置（点这里替换）" : "未配置（点这里填写）", true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        askKey();
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView tip = Ui.text(activity, keyPathNote(), Theme.T_CAP, t.textTertiary);
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

    private String keyPathNote() {
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            return "存到 imageGen.keys[" + ModelsScreen.U.hostOf(baseUrl) + "]（按主机名分开存）";
        }
        if (ModelsScreen.U.ROLE_ASR.equals(role)) {
            return "存到 asr.keys[" + asrSlot() + "].apiKey（按服务分开存）";
        }
        return "存到 tts.keys[" + ttsServiceId() + "]（按服务预设 id 存，不是按地址）。";
    }

    private boolean keyPresent() {
        if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            return ModelsScreen.U.imageKeyPresent(data, ModelsScreen.U.hostOf(baseUrl));
        }
        if (ModelsScreen.U.ROLE_ASR.equals(role)) {
            return ModelsScreen.U.asrKeyPresent(data, asrSlot());
        }
        return ModelsScreen.U.ttsKeyPresent(data, ttsServiceId());
    }

    private void askKey() {
        ModelsScreen.W.textDialog(activity, t, "填写这个用途的 API Key",
                "保存后写入，内容不回显"
                        + "本页永远不显示已存的 Key。",
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

    /** ASR 凭据槽位：OpenAI 兼容 = {@code openai|主机名}，其余 = provider 名。 */
    private String asrSlot() {
        return asrSlotOf(provider, baseUrl);
    }

    /**
     * 槽位口径的纯函数版：{@link ModelsScreen} 语音卡里的「识别 Key」行与本页共用这一份，
     * 否则同一个 Key 会在两页写成两个槽（运行端只认其中一个）。
     */
    static String asrSlotOf(String provider, String baseUrl) {
        String p = provider == null ? "" : provider.trim();
        if ("openai".equals(p)) return "openai|" + ModelsScreen.U.hostOf(baseUrl);
        return p;
    }

    /**
     * TTS 的 Key 归属：先按地址认服务（火山 v1 与豆包 2.0 同域名，要靠路径区分），
     * 地址认不出再按 provider 认（表里 id 与 provider 同名的那些，例如 OpenAI 兼容自建），
     * 最后才落到 {@code custom} —— 与运行端 {@code ttsServiceOf}/{@code ttsKeyFor} 同一口径。
     * <p>注意顺序：{@code provider=openai} 的自建地址会认成 {@code openai} 而不是 {@code custom}
     * （表里有 id 为 openai 的一行）；{@code custom} 只属于「provider 不在表里」的情形。
     */
    private String ttsServiceId() {
        return ttsServiceIdOf(provider, baseUrl);
    }

    /** 纯函数版：{@link ModelsScreen} 的「合成 Key」行与本页共用（同一份 TTS 服务表，同一口径）。 */
    static String ttsServiceIdOf(String provider, String baseUrl) {
        String p = provider == null ? "" : provider.trim();
        String url = baseUrl == null ? "" : baseUrl;
        String host = ModelsScreen.U.hostOf(url);
        if (host.length() > 0) {
            for (int i = 0; i < TTS_SERVICES.length; i++) {
                if (TTS_SERVICES[i][3].length() == 0) continue;
                if (!ModelsScreen.U.hostOf(TTS_SERVICES[i][3]).equals(host)) continue;
                if ("openspeech.bytedance.com".equals(host)) {
                    String lower = url.toLowerCase(Locale.US);
                    if (lower.indexOf("/api/v3/tts") >= 0) return "doubao";
                    if (lower.indexOf("/api/v1/tts") >= 0) return "volc";
                }
                return TTS_SERVICES[i][0];
            }
        }
        for (int i = 0; i < TTS_SERVICES.length; i++) {
            if (TTS_SERVICES[i][0].equals(p) && !"custom".equals(p)) return p;
        }
        return "custom";
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

    // ---------------------------------------------------------------- 保存

    private void doSave() {
        Object working = BotConfigJson.deepCopy(data);

        if (ModelsScreen.U.ROLE_CHAT.equals(role)) {
            String pid = providerId == null ? "" : providerId;
            if (pid.length() == 0) {
                BotConfigJson.set(working, "api.provider", "");
                BotConfigJson.set(working, "api.model", "");
                if (baseUrlTouched) BotConfigJson.set(working, "api.baseUrl", "");
            } else if (model.length() == 0) {
                ModelsScreen.W.toast(activity, "先选一个模型（或手动填模型 id）");
                return;
            } else {
                BotConfigJson.set(working, "api.provider", pid);
                BotConfigJson.set(working, "api.model", model);
                if (baseUrlTouched) {
                    BotConfigJson.set(working, "api.baseUrl", baseUrl == null ? "" : baseUrl);
                }
            }
        } else if (ModelsScreen.U.ROLE_MEMORY.equals(role)) {
            BotConfigJson.set(working, "memory.useChatModel", Boolean.valueOf(followChat));
            if (!followChat) {
                BotConfigJson.set(working, "memory.provider", providerId == null ? "" : providerId);
                BotConfigJson.set(working, "memory.model", model == null ? "" : model);
            }
        } else if (ModelsScreen.U.ROLE_IMAGE.equals(role)) {
            BotConfigJson.set(working, "imageGen.enabled", Boolean.valueOf(enabled));
            BotConfigJson.set(working, "imageGen.baseUrl", baseUrl == null ? "" : baseUrl);
            BotConfigJson.set(working, "imageGen.model", model == null ? "" : model);
            if (keyInput != null && keyInput.length() > 0) {
                String host = ModelsScreen.U.hostOf(baseUrl);
                if (host.length() == 0) {
                    ModelsScreen.W.toast(activity, "地址留空时用聊天那把 Key");
                    return;
                }
                ModelsScreen.U.putImageKey(working, host, keyInput);
            }
        } else if (ModelsScreen.U.ROLE_ASR.equals(role)) {
            BotConfigJson.set(working, "asr.enabled", Boolean.valueOf(enabled));
            BotConfigJson.set(working, "asr.provider", provider == null ? "" : provider);
            BotConfigJson.set(working, "asr.baseUrl", baseUrl == null ? "" : baseUrl);
            BotConfigJson.set(working, "asr.model", model == null ? "" : model);
            if (keyInput != null && keyInput.length() > 0) {
                ModelsScreen.U.putAsrKey(working, asrSlot(), keyInput);
            }
        } else {
            BotConfigJson.set(working, "tts.enabled", Boolean.valueOf(enabled));
            BotConfigJson.set(working, "tts.provider", provider == null ? "" : provider);
            BotConfigJson.set(working, "tts.baseUrl", baseUrl == null ? "" : baseUrl);
            BotConfigJson.set(working, "tts.model", model == null ? "" : model);
            if (keyInput != null && keyInput.length() > 0) {
                ModelsScreen.U.putTtsKey(working, ttsServiceId(), keyInput);
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
            ModelsScreen.W.toast(activity, "保存失败，改动还在");
            return;
        }
        data = working;
        boolean wroteKey = keyInput != null && keyInput.length() > 0;
        keyInput = null;
        ModelsScreen.W.toast(activity, "已保存" + (wroteKey ? "（Key 已更新）" : ""));
        shell.handleBack();
    }

    // ---------------------------------------------------------------- 错误页 / 杂项

    private View errorPage(String msg) {
        LinearLayout col = Ui.column(activity);
        col.addView(header("选择模型"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
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
