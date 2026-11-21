package com.whaleonebot.ui;

import android.app.Dialog;
import android.text.InputType;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static android.view.ViewGroup.LayoutParams.MATCH_PARENT;
import static android.view.ViewGroup.LayoutParams.WRAP_CONTENT;

/**
 * 「知识库」页：我们自己的多库知识库（{@code knowledge-lib}）。
 *
 * <p><b>它和作者那套的区别</b>（用户 2026-11-18 要求只保留我们这套）：
 * 作者的 {@code knowledge.*} 是「单目录 + 只读 .md/.txt + 纯关键词 + 16MB 上限」的轻量库，控制台里有开关；
 * 我们用 {@code agent/data/knowledge-lib}：多库、按 lib 分域、{@code index.sqlite} 里存向量 + 关键词混合检索，
 * 体量以 GB 计。两者<b>并存</b>，但面板只暴露我们这套（作者那组已在
 * {@link BotConfigSchema#visible} 里撤下）。
 *
 * <p><b>本页读写哪三样东西</b>（全在 App 私有目录里，不经 proot，改完立刻生效）：
 * <ol>
 *   <li>{@code agent/data/knowledge-lib/libraries.json} —— 资料库清单（名称 / 目录 / 后缀 / 启用 / 说明）。
 *       运行端每次检索都重读它（{@code features/knowledge-lib.js} 的 {@code loadLibraries} 无缓存），
 *       所以开关与新建<b>不需要重启</b>。</li>
 *   <li>{@code agent/data/knowledge-lib/stats.json} —— 每个库已索引多少段，只读展示。
 *       这份是运行端（{@code android/container-bot.mjs}）在启动时写的一次性统计；没有就显示「未索引」。</li>
 *   <li>{@code agent/home/.hindsight/profiles/ecnu.env} —— 向量模型的地址 / 模型 / 密钥。
 *       {@code ecnuConfig()} 每次都重读这个文件（{@code readEnvFile} + {@code process.env} 覆盖），
 *       所以改完<b>下一次检索就生效</b>，不用重启。</li>
 * </ol>
 *
 * <p><b>为什么向量模型写在 env 文件里，而不是写 config.json</b>：{@code ecnuConfig()} 的取值链是
 * <i>env 文件 / process.env → 缺 key 时回落 {@code config.providers[QQ_MEMORY_EMBED_PROVIDER]} +
 * {@code providerKeys[...]}</i>。回落只能挑一个写死在进程环境里的 provider id，改它得重启；
 * 而 env 文件里的三项优先级最高且随时重读 —— 这是唯一「改完立刻生效」的落点。
 *
 * <p><b>密钥纪律</b>：Key 只能写、永远不回显（只显示「已配置 / 未配置」），也不进日志。
 */
final class KnowledgeScreen extends Screen {

    // ---------------------------------------------------------------- 常量

    private static final String K_BASE = "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL";
    private static final String K_KEY = "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY";
    private static final String K_MODEL = "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL";

    /** 记忆库召回用的重排模型（`src/memory/memory-vec.js` 的 rerank 一路）。 */
    private static final String R_BASE = "HINDSIGHT_API_RERANKER_BASE_URL";
    private static final String R_KEY = "HINDSIGHT_API_RERANKER_API_KEY";
    private static final String R_MODEL = "HINDSIGHT_API_RERANKER_MODEL";

    /** 运行端 {@code ecnuConfig()} 里的兜底：没有 env 时用的渠道与模型。 */
    private static final String DEFAULT_PROVIDER = "custom_siliconflow";
    private static final String DEFAULT_MODEL = "BAAI/bge-m3";
    private static final String DEFAULT_RERANK_MODEL = "BAAI/bge-reranker-v2-m3";

    /**
     * 「怎么装一个知识库」的简短说明（浮层用，纯文本、一行一句）。
     *
     * <p>★ 只讲三步：放进容器目录 → 面板新建资料库填目录 → 需要时重建索引。
     * 完整的来龙去脉（三种传文件方式、编码、体量上限、常见问题）在
     * {@code docs/knowledge-base-user-guide.md}，这里刻意不长篇大论。
     */
    private static final String KB_GUIDE =
            "① 将 .md / .txt（UTF-8）放到容器目录：\n"
            + "   /agent/data/knowledge-inbox/库名/\n"
            + "② 点「新建资料库」，填名称、上述目录与后缀（默认 .md,.txt）。\n"
            + "③ 显示「未索引」表示尚未建索引，暂不可检索。\n"
            + "④ 增改语料或更换向量模型后需重建索引。";

    private static final String CUSTOM = "\u0000custom";

    // ---------------------------------------------------------------- 状态

    private FrameLayout body;

    /** config.json 树（只读：渠道清单 + providerKeys 是否有值）。 */
    private Object config;
    /** libraries.json 树；改完就地重画。 */
    private Object libs;
    /** stats.json 里的 {@code chunks}；null = 还没有统计。 */
    private Map<String, Object> stats;
    /** stats.json 里的 {@code memory.impressions}：记忆库里存了多少条印象（-1 = 未知）。 */
    private int memoryImpressions = -1;

    private String problem;

    KnowledgeScreen(AppShell shell) {
        super(shell);
    }

    // ================================================================ 骨架

    @Override
    void build() {
        root.removeAllViews();
        body = new FrameLayout(activity);
        body.setClipChildren(false);
        body.setClipToPadding(false);
        root.addView(body, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
        loadAll();
        render();
    }

    private void render() {
        if (body == null) return;
        body.removeAllViews();
        body.addView(page(), new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
    }

    private void loadAll() {
        problem = null;
        config = null;
        libs = null;
        stats = null;

        BotConfigHost cfg = configHost();
        if (cfg != null) {
            String txt = null;
            try {
                txt = cfg.loadConfigJson();
            } catch (Throwable ignored) {
                // 读不到配置不影响本页主体（资料库与向量模型都在文件里）
            }
            if (txt != null && txt.trim().length() > 0) {
                try {
                    Object tree = BotConfigJson.parse(txt);
                    if (BotConfigJson.asObject(tree) != null) config = tree;
                } catch (Throwable ignored) {
                    // 配置坏了：渠道清单退化成空，本页仍可用
                }
            }
        }

        String libText = readText(libsFile());
        if (libText == null) {
            problem = "读不到资料库清单（容器还没起过？）";
        } else {
            try {
                libs = BotConfigJson.parse(libText);
            } catch (Throwable th) {
                problem = "资料库清单不是合法 JSON";
            }
        }
        if (libs != null && BotConfigJson.asObject(libs) == null) {
            problem = "资料库清单根节点不是对象";
            libs = null;
        }

        String statsText = readText(statsFile());
        if (statsText != null) {
            try {
                Object tree = BotConfigJson.parse(statsText);
                stats = BotConfigJson.asObject(BotConfigJson.get(tree, "chunks"));
                double n = BotConfigJson.numOf(BotConfigJson.get(tree, "memory.impressions"));
                if (!Double.isNaN(n)) memoryImpressions = (int) n;
            } catch (Throwable ignored) {
                stats = null;
            }
        }
    }

    /** 重排模型的副标题：带上记忆库里已存的印象条数（统计不到就只说用途）。 */
    private String rerankSubtitle() {
        return memoryImpressions >= 0
                ? "记忆召回排序用 · 已有 " + memoryImpressions + " 条印象"
                : "记忆召回排序用";
    }

    private BotConfigHost configHost() {
        if (shell.activity instanceof BotConfigHost) return (BotConfigHost) shell.activity;
        return null;
    }

    // ================================================================ 文件

    private File dataDir() {
        return new File(new File(activity.getFilesDir(), "rootfs/agent/data"), "");
    }

    private File libsFile() {
        return new File(new File(dataDir(), "knowledge-lib"), "libraries.json");
    }

    private File statsFile() {
        return new File(new File(dataDir(), "knowledge-lib"), "stats.json");
    }

    private File envFile() {
        File dir = new File(new File(new File(activity.getFilesDir(), "rootfs/agent/home"),
                ".hindsight"), "profiles");
        return new File(dir, "ecnu.env");
    }

    private static String readText(File f) {
        if (f == null || !f.isFile()) return null;
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 16 * 1024 * 1024) break;
            }
            String s = new String(out.toByteArray(), "UTF-8");
            return s.length() > 0 && s.charAt(0) == '\uFEFF' ? s.substring(1) : s;
        } catch (Throwable th) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                    // 关不掉也不影响读到的内容
                }
            }
        }
    }

    /** 写文本：先写临时文件再原子替换，中途失败不会把清单写坏。 */
    private static boolean writeText(File f, String text) {
        if (f == null || text == null) return false;
        try {
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return false;
            File tmp = new File(dir, f.getName() + ".next");
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(text.getBytes("UTF-8"));
                out.getFD().sync();
            } finally {
                out.close();
            }
            if (!tmp.renameTo(f)) {
                FileOutputStream direct = new FileOutputStream(f);
                try {
                    direct.write(text.getBytes("UTF-8"));
                } finally {
                    direct.close();
                }
                tmp.delete();
            }
            return true;
        } catch (Throwable th) {
            return false;
        }
    }

    // ================================================================ 页面

    private ScrollView page() {
        LinearLayout col = Ui.column(activity);
        col.addView(header("知识库"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView sub = Ui.text(activity, "资料库只在模型主动查的时候才检索", Theme.T_CAP, t.textSecondary);
        sub.setLineSpacing(dp(3), 1f);
        col.addView(sub, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        col.addView(librariesCard(), marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S3)));
        col.addView(modelCard(EMBED, "向量模型", "知识库与记忆库共用", "换模型要重建索引"),
                marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        col.addView(modelCard(RERANK, "重排模型", rerankSubtitle(), null),
                marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        scroll.setClipChildren(false);
        scroll.setVerticalScrollBarEnabled(false);
        col.setPadding(dp(Theme.S4), dp(Theme.S3 + 4), dp(Theme.S4), dp(Theme.S4));
        scroll.addView(col, new LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        return scroll;
    }

    /** 卡片外壳：返回 body 供往里加行。 */
    private static final class Card {
        final FrameLayout view;
        final LinearLayout body;

        Card(FrameLayout view, LinearLayout body) {
            this.view = view;
            this.body = body;
        }
    }

    private Card card(String title, String subtitle) {
        FrameLayout card = Ui.card(activity, t);
        LinearLayout box = ModelsScreen.W.box(activity);
        card.addView(box, new FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT));
        box.addView(Ui.strong(activity, title, Theme.T_CARD, t.textPrimary),
                Ui.llp(WRAP_CONTENT, WRAP_CONTENT));
        if (subtitle != null && subtitle.length() > 0) {
            TextView s = Ui.text(activity, subtitle, Theme.T_CAP, t.textSecondary);
            s.setLineSpacing(dp(2), 1f);
            box.addView(s, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));
        }
        LinearLayout holder = Ui.column(activity);
        box.addView(holder, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        return new Card(card, holder);
    }

    private static LinearLayout.LayoutParams marginTop(LinearLayout.LayoutParams lp, int top) {
        lp.topMargin = top;
        return lp;
    }

    // ---------------------------------------------------------------- 资料库

    private View librariesCard() {
        Card c = card("资料库", null);

        Map<String, Object> libMap = libMap();
        List<String> ids = new ArrayList<String>(libMap.keySet());
        if (ids.isEmpty()) {
            TextView empty = Ui.text(activity,
                    problem == null ? "还没有资料库，点下面新建一个。" : problem,
                    Theme.T_CAP, t.textSecondary);
            empty.setLineSpacing(dp(3), 1f);
            c.body.addView(empty, Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        } else {
            for (int i = 0; i < ids.size(); i++) {
                if (i > 0) c.body.addView(ModelsScreen.W.divider(activity, t),
                        Ui.llp(MATCH_PARENT, dp(1)));
                c.body.addView(libraryRow(ids.get(i), BotConfigJson.asObject(libMap.get(ids.get(i)))),
                        Ui.llp(MATCH_PARENT, WRAP_CONTENT));
            }
        }

        TextView add = Ui.button(activity, t, "新建资料库", false);
        add.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                newLibraryDialog();
            }
        });
        c.body.addView(add, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        // 「怎么装一个知识库」：本页没有上传入口，新用户第一次来必然卡在"文件怎么进来"。
        // 这里只给一段最短说明（三步），细节推给 docs 里的用户指南 —— 别把浮层写成文档。
        TextView howTo = Ui.button(activity, t, "怎么装一个知识库", false);
        howTo.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ModelsScreen.W.infoDialog(activity, t, "怎么装一个知识库", KB_GUIDE);
            }
        });
        c.body.addView(howTo, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));
        return c.view;
    }

    private View libraryRow(final String id, final Map<String, Object> lib) {
        String name = lib == null ? id : ModelsScreen.U.s(lib.get("name")).trim();
        if (name.length() == 0) name = id;
        boolean on = lib == null || !"false".equals(ModelsScreen.U.s(lib.get("enabled")).trim());
        int dirs = lib == null ? 0 : sizeOf(lib.get("dirs"));

        StringBuilder v = new StringBuilder();
        v.append(on ? "已启用" : "已停用");
        if (dirs > 0) v.append(" · ").append(dirs).append(" 个目录");
        Object n = stats == null ? null : stats.get(id);
        if (n != null) {
            v.append(" · ").append((int) BotConfigJson.numOf(n)).append(" 段");
        } else if (dirs > 0) {
            v.append(" · 未索引");
        }
        return ModelsScreen.W.row(activity, t, name, v.toString(), true, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                libraryDialog(id);
            }
        });
    }

    private void libraryDialog(final String id) {
        final Map<String, Object> libMap = libMap();
        final Map<String, Object> lib = BotConfigJson.asObject(libMap.get(id));
        if (lib == null) return;

        final Dialog dlg = ModelsScreen.W.dialog(activity);
        if (dlg == null) return;

        LinearLayout box = ModelsScreen.W.box(activity);
        String name = ModelsScreen.U.s(lib.get("name")).trim();
        box.addView(ModelsScreen.W.title(activity, t, name.length() == 0 ? id : name),
                Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        TextView idText = Ui.text(activity, id, Theme.T_CAP, t.textTertiary);
        box.addView(idText, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        String note = ModelsScreen.U.s(lib.get("note")).trim();
        if (note.length() > 0) {
            TextView noteView = ModelsScreen.W.note(activity, t, note);
            noteView.setMaxLines(8);
            box.addView(noteView, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        List<Object> dirs = BotConfigJson.asArray(lib.get("dirs"));
        if (dirs != null && dirs.size() > 0) {
            TextView dirsView = Ui.mono(activity, Theme.T_CAP, t.textSecondary);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < dirs.size(); i++) {
                if (i > 0) sb.append('\n');
                sb.append(ModelsScreen.U.s(dirs.get(i)));
            }
            dirsView.setText(sb.toString());
            dirsView.setLineSpacing(dp(3), 1f);
            box.addView(dirsView, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        final boolean on = !"false".equals(ModelsScreen.U.s(lib.get("enabled")).trim());
        LinearLayout switchRow = ModelsScreen.W.switchRow(activity, t, "启用",
                null, on, new BotConfigToggle.OnChange() {
                    @Override
                    public void onChanged(boolean now) {
                        lib.put("enabled", Boolean.valueOf(now));
                        if (saveLibraries()) {
                            ModelsScreen.W.toast(activity, now ? "已启用" : "已停用");
                        }
                        dlg.dismiss();
                        loadAll();
                        render();
                    }
                });
        box.addView(switchRow, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        LinearLayout bar = Ui.row(activity);
        TextView remove = Ui.button(activity, t, "删除", false);
        remove.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
                ModelsScreen.W.confirmDialog(activity, t, "删除资料库？",
                        "只从清单里移除，index.sqlite 里的旧条目不动。",
                        "删除", new Runnable() {
                            @Override
                            public void run() {
                                libMap.remove(id);
                                if (saveLibraries()) {
                                    ModelsScreen.W.toast(activity, "已删除");
                                }
                                loadAll();
                                render();
                            }
                        });
            }
        });
        TextView close = Ui.button(activity, t, "完成", true);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dlg.dismiss();
            }
        });
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        rlp.weight = 1f;
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, WRAP_CONTENT);
        clp.weight = 1f;
        clp.leftMargin = dp(Theme.S1);
        bar.addView(remove, rlp);
        bar.addView(close, clp);
        box.addView(bar, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ModelsScreen.W.show(dlg, activity, t, box);
    }

    /** 新建：名称 + 目录（一行一个）+ 后缀。三段都在同一个浮层里，不串行弹三次。 */
    private void newLibraryDialog() {
        final Dialog dlg = ModelsScreen.W.dialog(activity);
        if (dlg == null) return;

        LinearLayout box = ModelsScreen.W.box(activity);
        box.addView(ModelsScreen.W.title(activity, t, "新建资料库"), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        TextView nameLabel = Ui.text(activity, "名称", Theme.T_CAP, t.textSecondary);
        box.addView(nameLabel, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        final EditText name = ModelsScreen.W.input(activity, t, InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES, "如 群星", false);
        box.addView(name, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        TextView dirLabel = Ui.text(activity, "目录（一行一个，容器里的绝对路径）", Theme.T_CAP, t.textSecondary);
        box.addView(dirLabel, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        final EditText dirs = ModelsScreen.W.input(activity, t, InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE, "/agent/data/knowledge-inbox/xxx", true);
        dirs.setMinLines(3);
        box.addView(dirs, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        TextView extLabel = Ui.text(activity, "后缀", Theme.T_CAP, t.textSecondary);
        box.addView(extLabel, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        final EditText exts = ModelsScreen.W.input(activity, t, InputType.TYPE_CLASS_TEXT,
                ".md,.txt", false);
        exts.setText(".md,.txt");
        box.addView(exts, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(4)));

        final TextView err = ModelsScreen.W.errPill(activity, t);
        box.addView(err, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S1)));

        LinearLayout bar = ModelsScreen.W.buttonBar(dlg, t, activity, new Runnable() {
            @Override
            public void run() {
                String nm = textOf(name);
                if (nm.length() == 0) {
                    ModelsScreen.W.showError(err, "名称不能为空");
                    return;
                }
                List<String> paths = splitList(textOf(dirs));
                if (paths.isEmpty()) {
                    ModelsScreen.W.showError(err, "至少要填一个目录");
                    return;
                }
                for (int i = 0; i < paths.size(); i++) {
                    if (!paths.get(i).startsWith("/")) {
                        ModelsScreen.W.showError(err, "目录要写容器里的绝对路径（以 / 开头）");
                        return;
                    }
                }
                List<String> suffixes = splitList(textOf(exts));
                if (suffixes.isEmpty()) suffixes.add(".md");

                Map<String, Object> libMap = libMap();
                String id = newId(nm, libMap);
                LinkedHashMap<String, Object> lib = new LinkedHashMap<String, Object>();
                lib.put("name", nm);
                lib.put("dirs", new ArrayList<Object>(paths));
                lib.put("exts", new ArrayList<Object>(suffixes));
                lib.put("enabled", Boolean.TRUE);
                lib.put("note", "");
                libMap.put(id, lib);

                if (!saveLibraries()) {
                    ModelsScreen.W.showError(err, "写入清单失败");
                    return;
                }
                dlg.dismiss();
                ModelsScreen.W.toast(activity, "已新建 · 还得建一次索引才能检索");
                loadAll();
                render();
            }
        });
        box.addView(bar, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));

        ModelsScreen.W.show(dlg, activity, t, box);
    }

    // ---------------------------------------------------------------- 向量 / 重排模型
    //
    // 知识库（knowledge-lib）与记忆库（memory-vec）读的是**同一个** ecnu.env，但用的变量不同：
    //   向量：HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL / _API_KEY / _MODEL（默认 BAAI/bge-m3）
    //   重排：HINDSIGHT_API_RERANKER_BASE_URL / _API_KEY / _MODEL（默认 BAAI/bge-reranker-v2-m3）
    // 记忆库只在「召回某人的印象」时请求重排；重排的 base/key 缺省时跟向量模型用同一份
    // （memory-vec.js: `rerankBase = rerankBase || p.base` / `rerankKey = rerankKey || key`）。

    /** 一类模型（向量 / 重排）在 env 文件里的三个键 + 默认模型名。 */
    private static final class Vars {
        final String baseKey;
        final String keyKey;
        final String modelKey;
        final String defaultModel;

        Vars(String baseKey, String keyKey, String modelKey, String defaultModel) {
            this.baseKey = baseKey;
            this.keyKey = keyKey;
            this.modelKey = modelKey;
            this.defaultModel = defaultModel;
        }
    }

    private static final Vars EMBED = new Vars(K_BASE, K_KEY, K_MODEL, DEFAULT_MODEL);
    private static final Vars RERANK = new Vars(R_BASE, R_KEY, R_MODEL, DEFAULT_RERANK_MODEL);

    private View modelCard(final Vars v, String title, String subtitle, String footer) {
        Card c = card(title, subtitle);

        Map<String, String> env = readEnv(envFile());

        String envBase = envValue(env, v.baseKey);
        String envModel = envValue(env, v.modelKey);
        boolean envKey = envValue(env, v.keyKey).length() > 0;

        String providerId = providerOfBase(envBase);
        String providerLabel;
        if (providerId.length() > 0) {
            providerLabel = ModelsScreen.U.providerName(config, providerId) + "（" + providerId + "）";
        } else if (envBase.length() > 0) {
            providerLabel = envBase;                                  // 自定义地址
        } else {
            // 什么都没配：显示运行端真正会用的兜底渠道（它按 provider id 回落）
            providerLabel = ModelsScreen.U.providerName(config, DEFAULT_PROVIDER)
                    + "（" + DEFAULT_PROVIDER + "）";
        }

        String model = envModel.length() == 0 ? v.defaultModel : envModel;

        boolean fallbackKey = envBase.length() == 0
                && ModelsScreen.U.providerKeyPresent(config, DEFAULT_PROVIDER);
        boolean embedKeyPresent = envValue(env, K_KEY).length() > 0
                || ModelsScreen.U.providerKeyPresent(config, DEFAULT_PROVIDER);
        // 重排的 base/key 缺省时会**跟随向量模型**（memory-vec.js: rerankKey = rerankKey || key），
        // 所以它的密钥行有三种状态，不能笼统写成「已配置」。
        String keyText;
        if (v == RERANK) {
            keyText = envKey ? "已配置（点这里替换）"
                    : (embedKeyPresent ? "跟随向量模型" : "未配置（点这里填写）");
        } else {
            keyText = (envKey || fallbackKey) ? "已配置（点这里替换）" : "未配置（点这里填写）";
        }

        c.body.addView(ModelsScreen.W.row(activity, t, "提供方", providerLabel, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View x) {
                        pickProvider(v);
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        c.body.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        c.body.addView(ModelsScreen.W.row(activity, t, "模型", model, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View x) {
                        editModel(v);
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));
        c.body.addView(ModelsScreen.W.divider(activity, t), Ui.llp(MATCH_PARENT, dp(1)));
        c.body.addView(ModelsScreen.W.row(activity, t, "密钥", keyText, true,
                new View.OnClickListener() {
                    @Override
                    public void onClick(View x) {
                        editKey(v);
                    }
                }), Ui.llp(MATCH_PARENT, WRAP_CONTENT));

        if (footer != null && footer.length() > 0) {
            TextView note = Ui.text(activity, footer, Theme.T_CAP, t.textTertiary);
            note.setLineSpacing(dp(3), 1f);
            c.body.addView(note, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }

        if (envValue(env, v.baseKey).length() > 0 || envValue(env, v.keyKey).length() > 0
                || envValue(env, v.modelKey).length() > 0) {
            TextView reset = Ui.button(activity, t, "恢复跟随渠道", false);
            reset.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View x) {
                    if (clearVars(v)) {
                        ModelsScreen.W.toast(activity, "已恢复跟随渠道");
                    } else {
                        ModelsScreen.W.toast(activity, "写入失败");
                    }
                    render();
                }
            });
            c.body.addView(reset, marginTop(Ui.llp(MATCH_PARENT, WRAP_CONTENT), dp(Theme.S2)));
        }
        return c.view;
    }

    /** 从渠道清单里挑一个（地址自动带过来）；最后一项是自定义地址。 */
    private void pickProvider(final Vars v) {
        List<Map<String, Object>> providers = ModelsScreen.U.providerList(config);
        final List<String> ids = new ArrayList<String>();
        List<String> labels = new ArrayList<String>();
        for (int i = 0; i < providers.size(); i++) {
            Map<String, Object> p = providers.get(i);
            String id = ModelsScreen.U.s(p.get("id")).trim();
            if (id.length() == 0) continue;
            String name = ModelsScreen.U.s(p.get("displayName")).trim();
            String base = ModelsScreen.U.providerBaseUrl(p);
            ids.add(id);
            labels.add((name.length() == 0 ? id : name) + " · " + base);
        }
        ids.add(CUSTOM);
        labels.add("自定义地址…");

        ModelsScreen.W.chooseDialog(activity, t, "用哪个渠道", null,
                labels.toArray(new String[0]), ids.toArray(new String[0]), null,
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String value) {
                        if (CUSTOM.equals(value)) {
                            askCustomBase(v);
                            return;
                        }
                        applyProvider(v, value);
                    }
                });
    }

    private void askCustomBase(final Vars v) {
        Map<String, String> env = readEnv(envFile());
        ModelsScreen.W.textDialog(activity, t, "接口地址", "填到 /v1",
                envValue(env, v.baseKey), InputType.TYPE_CLASS_TEXT, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text.length() == 0) return "地址不能为空（不想改就点取消）";
                        if (!text.startsWith("http")) return "要以 http(s):// 开头";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        Map<String, String> env2 = readEnv(envFile());
                        String model = envValue(env2, v.modelKey);
                        String key = envValue(env2, v.keyKey);
                        if (saveVars(v, text, model.length() == 0 ? v.defaultModel : model, key)) {
                            ModelsScreen.W.toast(activity, "已保存");
                        } else {
                            ModelsScreen.W.toast(activity, "保存失败");
                        }
                        render();
                    }
                });
    }

    /** 选中某个渠道：把它的地址与 Key 落进 env 文件（Key 不回显、只搬位置）。 */
    private void applyProvider(final Vars v, final String id) {
        Map<String, Object> p = ModelsScreen.U.providerById(config, id);
        String base = ModelsScreen.U.providerBaseUrl(p);
        if (base.length() == 0) {
            ModelsScreen.W.toast(activity, "这个渠道没填地址");
            return;
        }
        Map<String, String> env = readEnv(envFile());
        String model = envValue(env, v.modelKey);
        String key = envValue(env, v.keyKey);
        if (key.length() == 0) key = providerKeyOf(id);
        boolean ok = saveVars(v, base, model.length() == 0 ? v.defaultModel : model, key);
        if (!ok) {
            ModelsScreen.W.toast(activity, "保存失败");
        } else if (key.length() == 0) {
            ModelsScreen.W.toast(activity, "已保存 · 这个渠道还没有 Key，点「密钥」填一把");
        } else {
            ModelsScreen.W.toast(activity, "已保存");
        }
        render();
    }

    private void editModel(final Vars v) {
        Map<String, String> env = readEnv(envFile());
        String cur = envValue(env, v.modelKey);
        ModelsScreen.W.textDialog(activity, t, "模型名称", "如 " + v.defaultModel,
                cur.length() == 0 ? v.defaultModel : cur, InputType.TYPE_CLASS_TEXT, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text.length() == 0) return "模型名不能为空（不想改就点取消）";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        Map<String, String> env2 = readEnv(envFile());
                        String base = envValue(env2, v.baseKey);
                        String key = envValue(env2, v.keyKey);
                        if (base.length() == 0) {
                            // 还没定过渠道：用兜底渠道的地址，避免只写半份配置
                            base = ModelsScreen.U.providerBaseUrl(
                                    ModelsScreen.U.providerById(config, DEFAULT_PROVIDER));
                            if (key.length() == 0) key = providerKeyOf(DEFAULT_PROVIDER);
                        }
                        if (saveVars(v, base, text, key)) {
                            ModelsScreen.W.toast(activity, "已保存");
                        } else {
                            ModelsScreen.W.toast(activity, "保存失败");
                        }
                        render();
                    }
                });
    }

    private void editKey(final Vars v) {
        ModelsScreen.W.textDialog(activity, t, "填写密钥", "保存后写入，永不回显", "",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, false,
                new ModelsScreen.W.Check() {
                    @Override
                    public String check(String text) {
                        if (text.length() == 0) return "密钥不能为空（不想改就点取消）";
                        return null;
                    }
                },
                new ModelsScreen.W.TextCb() {
                    @Override
                    public void onText(String text) {
                        Map<String, String> env = readEnv(envFile());
                        String base = envValue(env, v.baseKey);
                        String model = envValue(env, v.modelKey);
                        if (base.length() == 0) {
                            base = ModelsScreen.U.providerBaseUrl(
                                    ModelsScreen.U.providerById(config, DEFAULT_PROVIDER));
                        }
                        if (base.length() == 0) {
                            ModelsScreen.W.toast(activity, "先选一个提供方");
                            return;
                        }
                        if (saveVars(v, base, model.length() == 0 ? v.defaultModel : model, text)) {
                            ModelsScreen.W.toast(activity, "已保存");
                        } else {
                            ModelsScreen.W.toast(activity, "保存失败");
                        }
                        render();
                    }
                });
    }

    // ================================================================ 读写实现

    private Map<String, Object> libMap() {
        if (libs == null) {
            LinkedHashMap<String, Object> root = new LinkedHashMap<String, Object>();
            root.put("version", Integer.valueOf(1));
            root.put("libraries", new LinkedHashMap<String, Object>());
            libs = root;
        }
        Map<String, Object> m = BotConfigJson.asObject(BotConfigJson.get(libs, "libraries"));
        if (m == null) {
            m = new LinkedHashMap<String, Object>();
            BotConfigJson.set(libs, "libraries", m);
        }
        return m;
    }

    private boolean saveLibraries() {
        if (libs == null) return false;
        Map<String, Object> root = BotConfigJson.asObject(libs);
        if (root == null) return false;
        if (!root.containsKey("version")) root.put("version", Integer.valueOf(1));
        boolean ok = writeText(libsFile(), BotConfigJson.write(libs) + "\n");
        if (!ok) ModelsScreen.W.toast(activity, "写入清单失败");
        return ok;
    }

    /** 写这一类模型的三个 env 键，保留文件里别的键（向量与重排互不覆盖）。 */
    private boolean saveVars(Vars v, String base, String model, String key) {
        File f = envFile();
        LinkedHashMap<String, String> env = readEnv(f);
        env.remove(v.baseKey);
        env.remove(v.modelKey);
        env.remove(v.keyKey);
        putIfAny(env, v.baseKey, base);
        putIfAny(env, v.modelKey, model);
        putIfAny(env, v.keyKey, key);
        return flushEnv(f, env);
    }

    /** 只清掉这一类模型的三个键；都清空了就把文件删掉（回到跟随渠道）。 */
    private boolean clearVars(Vars v) {
        File f = envFile();
        LinkedHashMap<String, String> env = readEnv(f);
        env.remove(v.baseKey);
        env.remove(v.modelKey);
        env.remove(v.keyKey);
        return flushEnv(f, env);
    }

    private boolean flushEnv(File f, LinkedHashMap<String, String> env) {
        if (env.isEmpty()) {
            f.delete();
            return !f.isFile();
        }
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : env.entrySet()) {
            sb.append(e.getKey()).append('=').append(e.getValue() == null ? "" : e.getValue())
                    .append('\n');
        }
        boolean ok = writeText(f, sb.toString());
        if (ok) {
            // 密钥文件只留给自己读写（与运行端其它凭据文件同口径）
            try {
                f.setReadable(true, true);
                f.setWritable(true, true);
            } catch (Throwable ignored) {
                // 个别 ROM 不支持 owner-only，退化成默认权限也不影响功能
            }
        }
        return ok;
    }

    private static void putIfAny(LinkedHashMap<String, String> env, String k, String v) {
        if (v == null) return;
        String s = v.trim();
        if (s.length() == 0) return;
        env.put(k, s);
    }

    /** 读 env 文件（{@code KEY=VALUE}，容忍引号与注释）。 */
    private static LinkedHashMap<String, String> readEnv(File f) {
        LinkedHashMap<String, String> out = new LinkedHashMap<String, String>();
        String text = readText(f);
        if (text == null) return out;
        String[] lines = text.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.length() == 0 || line.startsWith("#")) continue;
            int eq = line.indexOf('=');
            if (eq <= 0) continue;
            String k = line.substring(0, eq).trim();
            String v = line.substring(eq + 1).trim();
            if (v.length() >= 2
                    && ((v.charAt(0) == '"' && v.charAt(v.length() - 1) == '"')
                    || (v.charAt(0) == '\'' && v.charAt(v.length() - 1) == '\''))) {
                v = v.substring(1, v.length() - 1);
            }
            out.put(k, v);
        }
        return out;
    }

    private static String envValue(Map<String, String> env, String key) {
        String v = env == null ? null : env.get(key);
        return v == null ? "" : v.trim();
    }

    /** 反向找：这个地址属于哪个渠道（比地址时忽略末尾斜杠）。 */
    private String providerOfBase(String base) {
        if (base == null || base.length() == 0) return "";
        String want = trimSlash(base);
        List<Map<String, Object>> providers = ModelsScreen.U.providerList(config);
        for (int i = 0; i < providers.size(); i++) {
            Map<String, Object> p = providers.get(i);
            String b = ModelsScreen.U.providerBaseUrl(p);
            if (b.length() == 0) continue;
            if (trimSlash(b).equalsIgnoreCase(want)) return ModelsScreen.U.s(p.get("id")).trim();
        }
        return "";
    }

    private static String trimSlash(String s) {
        String v = s == null ? "" : s.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    /** 渠道自己的 Key（顶层 providerKeys[id]）；没有就空串。值不落地、不打印。 */
    private String providerKeyOf(String id) {
        if (id == null || id.length() == 0 || config == null) return "";
        return ModelsScreen.U.s(BotConfigJson.get(config, "providerKeys." + id)).trim();
    }

    private static int sizeOf(Object v) {
        List<Object> list = BotConfigJson.asArray(v);
        return list == null ? 0 : list.size();
    }

    private static String textOf(EditText e) {
        CharSequence cs = e == null ? null : e.getText();
        return cs == null ? "" : cs.toString().trim();
    }

    /** 按换行 / 逗号 / 分号切开，去掉空白项。 */
    private static List<String> splitList(String text) {
        List<String> out = new ArrayList<String>();
        if (text == null) return out;
        String[] parts = text.split("[\\n,;，；]");
        for (int i = 0; i < parts.length; i++) {
            String s = parts[i].trim();
            if (s.length() > 0) out.add(s);
        }
        return out;
    }

    /** 资料库 id：能用英文就用名字，否则 lib+时间戳；重名加后缀。 */
    private static String newId(String name, Map<String, Object> existing) {
        String slug = name.toLowerCase(Locale.US).replaceAll("[^a-z0-9_-]+", "");
        String base = slug.length() >= 2 && slug.length() <= 32
                ? slug : ("lib" + (System.currentTimeMillis() % 1000000L));
        String id = base;
        int n = 2;
        while (existing.containsKey(id)) {
            id = base + "-" + n;
            n++;
        }
        return id;
    }
}
