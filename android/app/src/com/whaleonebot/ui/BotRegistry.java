package com.whaleonebot.ui;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * 机器人注册表 —— <b>平台之上多出来的那一层</b>，也是机器人本体的唯一真源。
 *
 * <p>关系是<b>多对多</b>：
 * <pre>
 *   平台 qq      ──┐                 ┌── 机器人 A（只做 QQ）
 *   平台 douyin  ──┼── 机器人 A/B ───┤
 *   平台 bilibili                 └── 机器人 B（QQ + 抖音）
 * </pre>
 *
 * <p><b>边界（重要）</b>：机器人体内只放<b>与平台无关</b>的字段（名字、人设、运行端、平台集合）。
 * QQ 号 / token / 白名单群 / 模型 Key / 回复节奏这些属于<b>平台运行端配置</b>，不进这里
 * —— 否则「一个机器人管两个平台」时两边的字段会互相污染（见产品规格 §4）。
 *
 * <p><b>持久化</b>：{@link #init(File)} 由 {@code MainActivity} 在启动时调用一次，
 * 之后增删改都会落盘到 {@code bots.json}（原子写、解析失败不崩，见 {@link BotStore}）。
 * 运行状态（是否运行中、登录了哪个账号）仍由界面每秒通过 {@link #report} 喂进来，
 * <b>不落盘</b>。
 *
 * <p>本类刻意<b>不依赖 Android</b>（没有 import android.*），因此可以在桌面 JVM 上直接跑测试。
 */
public final class BotRegistry {

    // ---------------------------------------------------------------- 平台标识（合同 §1）
    // id 是全项目统一的稳定串（小写英文），显示名一律走 PLATFORM_LABEL()。

    public static final String P_QQ = "qq";
    public static final String P_DOUYIN = "douyin";
    public static final String P_BILIBILI = "bilibili";
    public static final String P_XIAOHEIHE = "xiaoheihe";

    /** 全部平台 id，<b>有序</b>（与首页四张平台卡的顺序一致）。 */
    public static final List<String> PLATFORMS = Collections.unmodifiableList(
            Arrays.asList(P_QQ, P_DOUYIN, P_BILIBILI, P_XIAOHEIHE));

    /** V1 真正接通的平台。以后接通抖音/bilibili，往这里加一项即可，界面自动跟着变。 */
    private static final String[] SUPPORTED = {P_QQ};

    /** 平台显示名。未知 id 原样返回（不吞数据，界面上至少能看出是什么）。 */
    public static String PLATFORM_LABEL(String platformId) {
        if (P_QQ.equals(platformId)) return "QQ";
        if (P_DOUYIN.equals(platformId)) return "抖音";
        if (P_BILIBILI.equals(platformId)) return "bilibili";
        if (P_XIAOHEIHE.equals(platformId)) return "小黑盒";
        return platformId == null ? "" : platformId;
    }

    /** 这个平台在 V1 是否能真的接（首页/详情页/选择器据此显示「可勾」或「未接入」）。 */
    public static boolean PLATFORM_SUPPORTED(String platformId) {
        for (int i = 0; i < SUPPORTED.length; i++) {
            if (SUPPORTED[i].equals(platformId)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- 运行端类型

    public static final String KIND_BUILTIN = "builtin";
    public static final String KIND_CUSTOM = "custom";

    /** 运行端类型的中文名：内置机器人 / 自定义机器人。 */
    public static String RUNTIME_KIND_LABEL(String runtimeKind) {
        if (KIND_CUSTOM.equals(runtimeKind)) return "自定义机器人";
        return "内置机器人";
    }

    // ---------------------------------------------------------------- 机器人模型（合同 §2）

    /**
     * 一个机器人 = 与平台无关的那部分（名字 / 人设 / 运行端 / 平台集合 / 时间戳）。
     *
     * <p><b>先按合同公开字段</b>，界面与创建向导直接读写它们（T2 的向导先拼一个
     * {@code new Bot()}，再交给 {@link BotRegistry#create} / {@link BotRegistry#update}）。
     * {@link #running} 与 {@link #account} 是运行期状态，不落盘。
     */
    public static final class Bot {
        /** 稳定主键（"whale-1"、"bot-2"…），用户不可改。 */
        public String id;
        /** 名字（非空）。 */
        public String name;
        /** 人设 / 角色设定原文（可空，长文本）。 */
        public String persona;
        /** 平台 id 集合，至少 1 个。 */
        public List<String> platforms = new ArrayList<String>();
        /** "builtin" | "custom"。 */
        public String runtimeKind = KIND_BUILTIN;
        /** builtin：版本号/tag；custom：仓库地址。 */
        public String runtimeRef = "";
        /** 总开关，默认 true。 */
        public boolean enabled = true;
        public long createdAt;
        public long updatedAt;

        /** 运行状态摘要用的两个事实，由界面层每秒喂进来（不落盘）。 */
        boolean running;
        String account;

        public Bot() {
        }

        /** 这个机器人是否接入某个平台。 */
        public boolean serves(String platformId) {
            if (platformId == null) return false;
            List<String> ps = platforms;
            if (ps == null) return false;
            return ps.contains(platformId);
        }

        /** 挂上一个平台（幂等）。 */
        public void bind(String platformId) {
            if (platformId == null || platformId.length() == 0) return;
            if (platforms == null) platforms = new ArrayList<String>();
            if (!platforms.contains(platformId)) platforms.add(platformId);
        }

        /** "QQ" / "QQ · 抖音" —— 卡片副标题的前半段。 */
        public String platformSummary() {
            List<String> ps = platforms;
            if (ps == null || ps.isEmpty()) return "未绑定平台";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < ps.size(); i++) {
                if (i > 0) sb.append(" · ");
                sb.append(PLATFORM_LABEL(ps.get(i)));
            }
            return sb.length() == 0 ? "未绑定平台" : sb.toString();
        }

        /** 运行端类型的中文名。 */
        public String runtimeLabel() {
            return RUNTIME_KIND_LABEL(runtimeKind);
        }

        /** 状态摘要：「运行中 · 已登录 <账号>」这类，只描述当前这一秒的事实。 */
        public String statusSummary() {
            boolean logged = account != null && account.length() > 0;
            if (!running) {
                return logged ? ("已停止 · 上次 " + account) : "已停止";
            }
            return logged ? ("运行中 · 已登录 " + account) : "运行中 · 未登录";
        }
    }

    // ---------------------------------------------------------------- 内存数据

    /** 内部列表，始终按 createdAt 升序（Collections.sort 稳定，同毫秒内保持插入顺序）。 */
    private static final List<Bot> BOTS = new ArrayList<Bot>();

    /** bots.json 所在目录；null 表示 {@link #init(File)} 还没被调用（只在内存里跑）。 */
    private static File storeDir;

    /** init 是否已跑过。跑过之后就不再「自动补默认机器人」，否则删空机器人会删不掉。 */
    private static boolean inited;

    private BotRegistry() {
    }

    // ---------------------------------------------------------------- 初始化与持久化

    /**
     * 启动时调用一次（{@code MainActivity} 传 {@code getFilesDir()}）。
     *
     * <p>三种情况的处理：
     * <ul>
     *   <li>文件不存在（首次启动）⇒ 建默认机器人 whale-1，并立刻落盘；</li>
     *   <li>文件有效（哪怕是空的 bots 数组）⇒ 原样采用，<b>不</b>强塞默认机器人
     *       —— 用户把机器人删光了就该看到空态引导；</li>
     *   <li>文件损坏 / 读不出 ⇒ <b>不崩</b>，内存里回退到默认机器人，
     *       并且<b>不覆盖</b>那个坏文件（留着以后人工排查）。</li>
     * </ul>
     *
     * <p>可重复调用（幂等）：每次都重新读一遍文件。
     */
    public static void init(File dir) {
        storeDir = dir;
        inited = true;

        List<Bot> loaded = null;
        if (dir != null) {
            try {
                loaded = BotStore.load(new File(dir, BotStore.FILE_NAME));
            } catch (Throwable ignored) {
                loaded = null; // BotStore 自己已经兜了异常，这里再兜一层：启动流程绝不能因为注册表崩
            }
        }

        BOTS.clear();
        if (loaded != null) {
            for (int i = 0; i < loaded.size(); i++) {
                Bot b = loaded.get(i);
                if (b == null || b.id == null) continue;
                BOTS.add(b);
            }
            sortByCreatedAt();
            return;
        }

        // 读不出来：回退默认机器人（内存里），坏文件保持原样。
        BOTS.add(defaultBot());
        boolean fileMissing = dir == null || !new File(dir, BotStore.FILE_NAME).isFile();
        if (fileMissing) persist(); // 首次启动才落地；损坏的文件不要被默认数据覆盖
    }

    /** 默认机器人：whale-1 / Whale OneBot / [qq] / builtin（合同 §2 指定的回退值）。 */
    private static Bot defaultBot() {
        long now = System.currentTimeMillis();
        Bot b = new Bot();
        b.id = "whale-1";
        b.name = "Whale OneBot";
        b.persona = "";
        b.platforms = new ArrayList<String>();
        b.platforms.add(P_QQ);
        b.runtimeKind = KIND_BUILTIN;
        b.runtimeRef = "";
        b.enabled = true;
        b.createdAt = now;
        b.updatedAt = now;
        return b;
    }

    /** 落盘。没有 init 过（storeDir == null）时只留在内存里，返回 false。 */
    private static boolean persist() {
        if (storeDir == null) return false;
        try {
            return BotStore.save(new File(storeDir, BotStore.FILE_NAME), BOTS);
        } catch (Throwable t) {
            return false; // 落盘失败不许让界面崩：内存里的改动仍然生效
        }
    }

    private static void sortByCreatedAt() {
        Collections.sort(BOTS, new Comparator<Bot>() {
            @Override
            public int compare(Bot a, Bot b) {
                long x = a == null ? 0L : a.createdAt;
                long y = b == null ? 0L : b.createdAt;
                return x < y ? -1 : (x > y ? 1 : 0);
            }
        });
    }

    /** init 没跑过时（例如测试/异常启动）也别让界面拿到空列表。 */
    private static void ensureSeeded() {
        if (inited || !BOTS.isEmpty()) return;
        BOTS.add(defaultBot());
    }

    // ---------------------------------------------------------------- 查询

    /** 全部机器人（含停用），按 createdAt 升序。返回副本，调用方改不到内部列表。 */
    public static List<Bot> list() {
        ensureSeeded();
        return new ArrayList<Bot>(BOTS);
    }

    /** 按 id 取；不存在返回 null。 */
    public static Bot get(String id) {
        ensureSeeded();
        if (id == null) return null;
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (b.id != null && b.id.equals(id)) return b;
        }
        return null;
    }

    /** 第一个可用机器人（优先 enabled，其次第一个）；列表为空返回 null，调用方要判空。 */
    public static Bot primary() {
        ensureSeeded();
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (b.enabled && b.id != null) return b;
        }
        return BOTS.isEmpty() ? null : BOTS.get(0);
    }

    /** 某平台上的全部机器人（含停用）—— 多机器人 / 多平台的查询入口。 */
    public static List<Bot> forPlatform(String platformId) {
        ensureSeeded();
        List<Bot> out = new ArrayList<Bot>();
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (b.serves(platformId)) out.add(b);
        }
        return out;
    }

    // ---------------------------------------------------------------- 增 / 改 / 删（都会落盘）

    /** 名字长度上限（字符数）。超长截断而不是拒绝，校验让向导页去做。 */
    public static final int NAME_MAX = 40;

    /**
     * 新建机器人并落盘。
     *
     * <p>id 由本类生成：第一个是 {@code whale-1}，之后是 {@code bot-2}、{@code bot-3}…
     * （扫现有 id 的数字尾巴取最大值 +1，绝不碰撞）。
     *
     * @return 新建的机器人；名字为空或平台集合为空时<b>不保存</b>，返回 null
     *         （校验交给向导页，向导页也必须先校验，见合同 §5-T2）
     */
    public static Bot create(String name, String persona, String runtimeKind,
                             String runtimeRef, List<String> platforms) {
        String n = name == null ? "" : name.trim();
        if (n.length() == 0) return null;
        List<String> ps = sanitizePlatforms(platforms);
        if (ps.isEmpty()) return null;

        long now = System.currentTimeMillis();
        Bot b = new Bot();
        b.id = nextId();
        b.name = truncate(n);
        b.persona = persona == null ? "" : persona;
        b.platforms = ps;
        b.runtimeKind = KIND_CUSTOM.equals(runtimeKind) ? KIND_CUSTOM : KIND_BUILTIN;
        b.runtimeRef = runtimeRef == null ? "" : runtimeRef.trim();
        b.enabled = true;
        b.createdAt = now;
        b.updatedAt = now;
        BOTS.add(b);
        sortByCreatedAt();
        persist();
        return b;
    }

    /**
     * 保存改动并落盘。
     *
     * <p><b>就地更新</b>：把 {@code bot} 的字段拷进注册表里那个同 id 的实例，
     * 这样界面手里已经拿着的引用不会变成「孤儿」（列表/详情页不用重新取）。
     *
     * @return false 表示 id 不存在、名字为空或平台集合为空（未保存）
     */
    public static boolean update(Bot bot) {
        if (bot == null || bot.id == null) return false;
        Bot cur = get(bot.id);
        if (cur == null) return false;
        String n = bot.name == null ? "" : bot.name.trim();
        if (n.length() == 0) return false;
        List<String> ps = sanitizePlatforms(bot.platforms);
        if (ps.isEmpty()) return false;

        cur.name = truncate(n);
        cur.persona = bot.persona == null ? "" : bot.persona;
        cur.platforms = ps;
        cur.runtimeKind = KIND_CUSTOM.equals(bot.runtimeKind) ? KIND_CUSTOM : KIND_BUILTIN;
        cur.runtimeRef = bot.runtimeRef == null ? "" : bot.runtimeRef.trim();
        cur.enabled = bot.enabled;
        cur.updatedAt = System.currentTimeMillis();
        persist();
        return true;
    }

    /** 删除并落盘。id 不存在返回 false。 */
    public static boolean remove(String id) {
        if (id == null) return false;
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (b.id != null && b.id.equals(id)) {
                BOTS.remove(i);
                persist();
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 状态回填（不落盘）

    /**
     * 界面层把真实状态喂进来（QqScreen / BotDetailScreen 每秒调一次）。
     * 所有服务该平台的机器人一起更新 —— 这样「一个平台多个机器人」时也成立。
     *
     * @param account 已登录账号；未登录传 null。本类只存不打印。
     */
    public static void report(String platformId, boolean running, String account) {
        String acc = (account == null || account.length() == 0) ? null : account;
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (!b.serves(platformId)) continue;
            b.running = running;
            b.account = acc;
        }
    }

    // ---------------------------------------------------------------- 内部工具

    /** 只留 PLATFORMS 里认识的 id，去重，并按 PLATFORMS 的顺序排（界面顺序才稳定）。 */
    private static List<String> sanitizePlatforms(List<String> in) {
        List<String> out = new ArrayList<String>();
        if (in == null) return out;
        for (int i = 0; i < PLATFORMS.size(); i++) {
            String p = PLATFORMS.get(i);
            if (in.contains(p)) out.add(p);
        }
        return out;
    }

    private static String truncate(String s) {
        if (s == null) return "";
        return s.length() <= NAME_MAX ? s : s.substring(0, NAME_MAX);
    }

    /** 生成一个没被占用的 id：第一个是 whale-1，之后 bot-(最大数字尾巴+1)。 */
    private static String nextId() {
        if (BOTS.isEmpty()) return "whale-1";
        int max = 0;
        for (int i = 0; i < BOTS.size(); i++) {
            int n = trailingNumber(BOTS.get(i).id);
            if (n > max) max = n;
        }
        int n = max + 1;
        String id = "bot-" + n;
        while (get(id) != null) {
            n++;
            id = "bot-" + n;
        }
        return id;
    }

    private static int trailingNumber(String s) {
        if (s == null) return 0;
        int i = s.length();
        while (i > 0 && Character.isDigit(s.charAt(i - 1))) i--;
        if (i == s.length()) return 0;
        try {
            return Integer.parseInt(s.substring(i));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // ---------------------------------------------------------------- 兼容旧调用（不要在新代码里用）

    /** @deprecated 旧名，等价于 {@link #get(String)}。 */
    @Deprecated
    static Bot byId(String id) {
        return get(id);
    }

    /** @deprecated 旧名，等价于 {@link #PLATFORM_SUPPORTED(String)}。 */
    @Deprecated
    static boolean isSupported(String platformId) {
        return PLATFORM_SUPPORTED(platformId);
    }

    /** @deprecated 旧名，等价于 {@link #list()}。 */
    @Deprecated
    static List<Bot> all() {
        return list();
    }
}
