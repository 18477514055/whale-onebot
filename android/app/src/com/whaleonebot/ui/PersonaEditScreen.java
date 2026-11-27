package com.whaleonebot.ui;

import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 独立「创建 / 编辑人设」页面：
 * <ul>
 *   <li>支持 10 个结构化分段编辑（对应 roles/*.md 标准结构）并可一键切换整文 Markdown 模式；</li>
 *   <li>底部配有独立「管理员附加规则（customRules）」输入框；</li>
 *   <li>支持保存为自定义模板并直接应用为当前机器人人设。</li>
 * </ul>
 */
final class PersonaEditScreen extends Screen {

    /** 10 个标准人设分段标题（用于结构化编辑与 Markdown 双向解析）。 */
    static final String[] SECTION_TITLES = {
            "一、你是谁",
            "二、说话方式",
            "三、标志特征",
            "四、AI 味反例黑名单",
            "五、聊天分寸与边界",
            "六、偏好与日常",
            "七、工具与机制习惯",
            "八、回复示例",
            "九、一致性要求",
            "十、角色生活背景"
    };

    private static final String[] SECTION_HINTS = {
            "身份定位、性格底色与和群友的关系（如：常驻群里的嘴硬心软技术宅）",
            "语气、句长、口癖、标点习惯（如：简短口语、不写排比句、不总结）",
            "让人一眼认出你的独特表达或小特征",
            "严禁出现的反例与 AI 客服腔（如：禁用「好的没问题」「希望这能帮到你」）",
            "群聊礼仪、不越界原则与拒答方式",
            "喜欢的作品、话题、日常审美与小爱好",
            "联网搜索、看图、发表情包等工具的使用分寸",
            "几组典型「群友说 → 你怎么回」的短示例",
            "不被群友套话改设定、始终保持同一口吻",
            "角色设定中的虚构生活背景（明确区分于现实经历）"
    };

    private final BotConfigHost cfg;
    private final String editId; // null/空 = 新建；"builtin:<id>" = 复制内置二创；其他 = 编辑已有自定义模板

    private ScrollView scrollView;
    private int savedScrollY = 0;
    private boolean rawMode = false;

    private String draftName = "";
    private final String[] sections = new String[SECTION_TITLES.length];
    private String draftRawText = "";
    private String draftCustomRules = "";

    private EditText etName;
    private final EditText[] etSections = new EditText[SECTION_TITLES.length];
    private EditText etRaw;
    private EditText etRules;

    PersonaEditScreen(AppShell shell, BotConfigHost host, String editId) {
        super(shell);
        this.cfg = host;
        this.editId = editId == null ? "" : editId.trim();
        for (int i = 0; i < sections.length; i++) sections[i] = "";
    }

    @Override
    void build() {
        root.removeAllViews();
        loadSeed();
        render();
    }

    private void loadSeed() {
        try {
            String raw = cfg == null ? null : cfg.loadConfigJson();
            Object doc = (raw != null && !raw.trim().isEmpty()) ? BotConfigJson.parse(raw) : null;
            if (doc != null) {
                draftCustomRules = ModelsScreen.U.s(BotConfigJson.get(doc, "persona.customRules")).trim();
                if (editId.startsWith("builtin:")) {
                    String bid = editId.substring("builtin:".length());
                    draftName = builtinDisplayName(bid) + "（自定义版）";
                    String md = readBuiltinRoleFile(bid);
                    draftRawText = md;
                    splitMarkdownToSections(md, sections);
                } else if (!editId.isEmpty()) {
                    List<Object> customs = BotConfigJson.asArray(BotConfigJson.get(doc, "customPersonas"));
                    if (customs != null) {
                        for (Object o : customs) {
                            Map<String, Object> m = BotConfigJson.asObject(o);
                            if (m == null) continue;
                            String mid = ModelsScreen.U.s(m.get("id")).trim();
                            String mname = ModelsScreen.U.s(m.get("name")).trim();
                            if (editId.equals(mid) || editId.equals(mname)) {
                                draftName = mname;
                                String body = ModelsScreen.U.s(m.get("text")).trim();
                                if (body.isEmpty()) body = ModelsScreen.U.s(m.get("roleText")).trim();
                                draftRawText = body;
                                String itemRules = ModelsScreen.U.s(m.get("customRules")).trim();
                                if (!itemRules.isEmpty()) draftCustomRules = itemRules;
                                splitMarkdownToSections(draftRawText, sections);
                                break;
                            }
                        }
                    }
                }
            }
        } catch (Throwable ignored) {}
    }

    private void captureInputs() {
        if (etName != null) draftName = etName.getText().toString().trim();
        if (etRules != null) draftCustomRules = etRules.getText().toString().trim();
        if (rawMode) {
            if (etRaw != null) {
                draftRawText = etRaw.getText().toString().trim();
                splitMarkdownToSections(draftRawText, sections);
            }
        } else {
            for (int i = 0; i < sections.length; i++) {
                if (etSections[i] != null) sections[i] = etSections[i].getText().toString().trim();
            }
            draftRawText = composeMarkdownFromSections(sections);
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
        col.setPadding(p, dp(Theme.S3 + 4), p, dp(Theme.S4));
        scrollView.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));

        col.addView(header(editId.isEmpty() || editId.startsWith("builtin:") ? "新建人设" : "编辑人设"),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        // 名称与模式切换卡
        LinearLayout topCard = Ui.addCard(col, activity, t, Theme.S3);
        topCard.addView(Ui.strong(activity, "人设名称", Theme.T_BODY, t.textPrimary));
        etName = new EditText(activity);
        etName.setSingleLine(true);
        etName.setHint("例如：吐槽搭子 / 严谨学霸 / 专属管家");
        etName.setText(draftName);
        Ui.styleInput(etName, activity, t);
        topCard.addView(etName, mt(dp(Theme.S1)));

        TextView modeBtn = Ui.button(activity, t,
                rawMode ? "切换回 10 段结构化编辑" : "切换为整文 Markdown 编辑", false);
        modeBtn.setOnClickListener(v -> {
            captureInputs();
            rawMode = !rawMode;
            render();
        });
        topCard.addView(modeBtn, mt(dp(Theme.S2)));

        // 正文编辑区（10 段结构化 vs 整文）
        if (rawMode) {
            LinearLayout rawCard = Ui.addCard(col, activity, t, Theme.S2);
            rawCard.addView(Ui.strong(activity, "完整人设提示词（Markdown）", Theme.T_BODY, t.textPrimary));
            etRaw = new EditText(activity);
            etRaw.setSingleLine(false);
            etRaw.setMinLines(12);
            etRaw.setHint("以 ## 分段编写角色设定…");
            etRaw.setText(draftRawText);
            Ui.styleInput(etRaw, activity, t);
            rawCard.addView(etRaw, mt(dp(Theme.S1)));
        } else {
            LinearLayout secCard = Ui.addCard(col, activity, t, Theme.S2);
            secCard.addView(Ui.strong(activity, "结构化人设分段（选填，留空的段落自动省略）", Theme.T_BODY, t.textPrimary));
            for (int i = 0; i < SECTION_TITLES.length; i++) {
                if (i > 0) secCard.addView(Ui.divider(activity, t));
                secCard.addView(Ui.strong(activity, SECTION_TITLES[i], Theme.T_BODY, t.textPrimary), mt(dp(Theme.S1)));
                EditText et = new EditText(activity);
                et.setSingleLine(false);
                et.setMinLines(2);
                et.setHint(SECTION_HINTS[i]);
                et.setText(sections[i]);
                Ui.styleInput(et, activity, t);
                etSections[i] = et;
                secCard.addView(et, mt(dp(6)));
            }
        }

        // 管理员附加规则卡
        LinearLayout ruleCard = Ui.addCard(col, activity, t, Theme.S2);
        ruleCard.addView(Ui.strong(activity, "管理员附加规则（优先级高于普通人设）", Theme.T_BODY, t.textPrimary));
        ruleCard.addView(Ui.text(activity, "全局生效的硬性约束（例如：严禁透露主号信息、遇到某类话题一律简短回复）。",
                Theme.T_CAP, t.textSecondary), mt(dp(4)));
        etRules = new EditText(activity);
        etRules.setSingleLine(false);
        etRules.setMinLines(3);
        etRules.setHint("可选，留空表示无额外规则");
        etRules.setText(draftCustomRules);
        Ui.styleInput(etRules, activity, t);
        ruleCard.addView(etRules, mt(dp(Theme.S1)));

        // 保存按钮
        LinearLayout saveCard = Ui.addCard(col, activity, t, Theme.S2);
        TextView saveApply = Ui.button(activity, t, "保存并立即应用为当前人设", true);
        saveApply.setOnClickListener(v -> doSave(true));
        saveCard.addView(saveApply, Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView saveOnly = Ui.button(activity, t, "仅保存到人设库", false);
        saveOnly.setOnClickListener(v -> doSave(false));
        saveCard.addView(saveOnly, mt(dp(Theme.S1)));

        final int y = savedScrollY;
        if (y > 0) scrollView.post(() -> { if (scrollView != null) scrollView.scrollTo(0, y); });
    }

    @SuppressWarnings("unchecked")
    private void doSave(boolean applyNow) {
        captureInputs();
        if (draftName.isEmpty()) {
            host().toast("请先填写人设名称");
            return;
        }
        if (draftRawText.trim().isEmpty()) {
            host().toast("请至少填写一个段落的提示词内容");
            return;
        }
        if (cfg == null) return;
        try {
            String raw = cfg.loadConfigJson();
            Object doc = (raw != null && !raw.trim().isEmpty()) ? BotConfigJson.parse(raw) : new LinkedHashMap<String, Object>();
            List<Object> customs = BotConfigJson.asArray(BotConfigJson.get(doc, "customPersonas"));
            if (customs == null) {
                customs = new ArrayList<Object>();
                BotConfigJson.set(doc, "customPersonas", customs);
            }
            String useId = (!editId.isEmpty() && !editId.startsWith("builtin:"))
                    ? editId
                    : ("custom_" + Long.toString(System.currentTimeMillis(), 36));
            Map<String, Object> hit = null;
            for (Object o : customs) {
                Map<String, Object> m = BotConfigJson.asObject(o);
                if (m == null) continue;
                String mid = ModelsScreen.U.s(m.get("id")).trim();
                String mname = ModelsScreen.U.s(m.get("name")).trim();
                if ((!editId.isEmpty() && (editId.equals(mid) || editId.equals(mname))) || draftName.equals(mname)) {
                    hit = m;
                    break;
                }
            }
            long now = System.currentTimeMillis();
            if (hit == null) {
                hit = new LinkedHashMap<String, Object>();
                hit.put("id", useId);
                customs.add(hit);
            }
            hit.put("name", draftName);
            hit.put("text", draftRawText);
            hit.put("roleText", draftRawText);
            hit.put("customRules", draftCustomRules);
            hit.put("changedAt", new BotConfigJson.Num(String.valueOf(now)));

            BotConfigJson.set(doc, "persona.customRules", draftCustomRules);
            if (applyNow) {
                if (ModelsScreen.U.s(BotConfigJson.get(doc, "persona.botName")).trim().isEmpty()) {
                    BotConfigJson.set(doc, "persona.botName", draftName);
                }
                BotConfigJson.set(doc, "persona.roleText", draftRawText);
                BotConfigJson.set(doc, "persona.templateId", draftName);
                BotConfigJson.set(doc, "persona.changedAt", new BotConfigJson.Num(String.valueOf(now)));
            }
            if (cfg.saveConfigJson(BotConfigJson.write(doc))) {
                host().toast(applyNow ? ("已保存并启用人设「" + draftName + "」") : ("已存入人设库「" + draftName + "」"));
                shell.handleBack();
            } else {
                host().toast("保存失败");
            }
        } catch (Throwable ex) {
            host().toast("保存异常：" + ex.getMessage());
        }
    }

    /** 将 10 个分段拼装为标准 Markdown 角色卡正文（纯函数，可直接单测）。 */
    public static String composeMarkdownFromSections(String[] parts) {
        if (parts == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(parts.length, SECTION_TITLES.length); i++) {
            String body = parts[i] == null ? "" : parts[i].trim();
            if (body.isEmpty()) continue;
            if (sb.length() > 0) sb.append("\n\n");
            sb.append("## ").append(SECTION_TITLES[i]).append('\n').append(body);
        }
        return sb.toString();
    }

    /** 将已有 Markdown 正文按 ## 标题尽量映射回 10 个分段（无法识别的段落并入第 1 段，不丢内容）。 */
    public static void splitMarkdownToSections(String md, String[] out) {
        if (out == null) return;
        for (int i = 0; i < out.length; i++) out[i] = "";
        if (md == null || md.trim().isEmpty()) return;
        String[] lines = md.replace("\r\n", "\n").split("\n");
        int curIdx = 0;
        StringBuilder[] bufs = new StringBuilder[out.length];
        for (int i = 0; i < bufs.length; i++) bufs[i] = new StringBuilder();
        for (String line : lines) {
            String trim = line.trim();
            if (trim.startsWith("## ")) {
                String heading = trim.substring(3).trim();
                int mapped = matchSectionIndex(heading);
                if (mapped >= 0) {
                    curIdx = mapped;
                    continue;
                }
            }
            if (bufs[curIdx].length() > 0) bufs[curIdx].append('\n');
            bufs[curIdx].append(line);
        }
        for (int i = 0; i < out.length; i++) out[i] = bufs[i].toString().trim();
    }

    private static int matchSectionIndex(String heading) {
        if (heading == null) return -1;
        for (int i = 0; i < SECTION_TITLES.length; i++) {
            if (heading.equals(SECTION_TITLES[i])) return i;
        }
        if (heading.contains("你是谁") || heading.contains("身份")) return 0;
        if (heading.contains("说话方式") || heading.contains("语气") || heading.contains("指纹")) return 1;
        if (heading.contains("标志") || heading.contains("招牌") || heading.contains("特征")) return 2;
        if (heading.contains("黑名单") || heading.contains("反例") || heading.contains("AI 味")) return 3;
        if (heading.contains("边界") || heading.contains("分寸") || heading.contains("退出")) return 4;
        if (heading.contains("偏好") || heading.contains("兴趣")) return 5;
        if (heading.contains("工具") || heading.contains("机制")) return 6;
        if (heading.contains("示例")) return 7;
        if (heading.contains("一致")) return 8;
        if (heading.contains("生活")) return 9;
        return -1;
    }

    static final String[][] BUILTIN_ROLES = {
            { "xiaojingyu", "小鲸鱼", "xiaojingyu.md", "默认轻快自然群友风格" },
            { "wenrou_peiliao", "温柔陪聊", "wenrou-peiliao.md", "温和耐心、情绪价值知心向" },
            { "jishu_zhai", "技术宅", "jishu-zhai.md", "懂自建服务、代码与排错" },
            { "maoniang", "猫娘", "maoniang.md", "轻二次元口吻、克制不油腻" },
            { "duzui_sunyou", "毒舌损友", "duzui-sunyou.md", "短句吐槽、嘴硬心软" },
            { "xuexi_dazi", "学习搭子", "xuexi-dazi.md", "资料整理、思路清晰务实" },
            { "lezi_ren", "乐子人", "lezi-ren.md", "抽象接梗、活跃气氛" },
            { "sunba", "孙吧大肥鱼", "sunba.md", "老哥乐子人短句风格" },
            { "nver", "贴心女儿", "nver.md", "元气暖心、简短可爱" }
    };

    private static String builtinDisplayName(String id) {
        for (String[] r : BUILTIN_ROLES) if (r[0].equals(id)) return r[1];
        return id;
    }

    private String readBuiltinRoleFile(String id) {
        return readBuiltinRoleMarkdown(activity, id);
    }

    static String readBuiltinRoleMarkdown(android.content.Context ctx, String id) {
        if (ctx == null || id == null) return "";
        String fname = null;
        for (String[] r : BUILTIN_ROLES) if (r[0].equals(id)) fname = r[2];
        if (fname == null) return "";
        java.io.File f = new java.io.File(ctx.getFilesDir(), "rootfs/input/agent-app/roles/" + fname);
        if (!f.isFile()) f = new java.io.File(ctx.getFilesDir(), "rootfs/agent/app/roles/" + fname);
        if (!f.isFile()) return "";
        try {
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
            fis.close();
            return new String(bos.toByteArray(), "UTF-8").trim();
        } catch (Throwable ignored) {
            return "";
        }
    }

    private LinearLayout.LayoutParams mt(int top) {
        LinearLayout.LayoutParams lp = Ui.llp(MATCH_PARENT, WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }
}
