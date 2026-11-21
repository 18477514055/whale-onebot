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
    private static final String[] SUPPORTED = {P_QQ, P_BILIBILI};

    public static final class Binding {
        public final String id, platform, accountId, memoryMode, httpUrl, wsUrl, peerId;
        Binding(String id,String platform,String accountId,String mode,String http,String ws) { this(id,platform,accountId,mode,http,ws,""); }
        Binding(String id, String platform, String accountId, String mode, String http, String ws, String peerId) {
            this.peerId = peerId;
            this.id = id; this.platform = platform; this.accountId = accountId;
            this.memoryMode = mode; this.httpUrl = http; this.wsUrl = ws;
        }
        public boolean localQQ() {
            if(!P_QQ.equals(platform)||!accountId.isEmpty()||!httpUrl.isEmpty()||!wsUrl.isEmpty())return false;
            Bot owner=BotRegistry.get("whale-1");return legacyQQ(owner)&&owner.bindings.contains(this);
        }
        public String label() {
            if(localQQ())return "QQ  本机账号";
            return PLATFORM_LABEL(platform) + "  " + (accountId.isEmpty() ? "待登录" : accountId);
        }
        public boolean hostedBili() { return P_BILIBILI.equals(platform) && !accountId.isEmpty() && httpUrl.isEmpty() && wsUrl.isEmpty(); }
        public String detail() {
            if(localQQ())return "本机协议端  /  连接状态见启动页";
            return ("isolated".equals(memoryMode) ? "独立记忆与知识库" : "共享本机器人记忆与知识库")
                + "  /  " + (hostedBili() ? "本机协议端" : httpUrl.isEmpty() || wsUrl.isEmpty() ? "待配置" : "已配置");
        }
    }

    static void syncPlatforms(Bot b) {
        b.bindings.removeIf(v -> !b.platforms.contains(v.platform));
        for (String p : b.platforms) {
            boolean found = false;
            for (Binding v : b.bindings) if (p.equals(v.platform)) found = true;
            if (!found) b.bindings.add(new Binding("initial-" + p, p, "", "shared", "", ""));
        }
    }

    public static boolean legacyQQ(Bot b) {
        if (b == null || !b.enabled || !"whale-1".equals(b.id) || !KIND_BUILTIN.equals(b.runtimeKind)) return false;
        boolean found=false;
        for (Binding v : b.bindings) {
            if (P_BILIBILI.equals(v.platform)) continue;
            if (found || !P_QQ.equals(v.platform) || !v.accountId.isEmpty() || !v.httpUrl.isEmpty() || !v.wsUrl.isEmpty()) return false;
            found=true;
        }
        return found;
    }

    static synchronized boolean changeLink(Bot bot,RuntimeUiLink remove,RuntimeUiLink add){
        if(bot==null || get(bot.id)!=bot || !KIND_CUSTOM.equals(bot.runtimeKind))return false;
        List<RuntimeUiLink> previous=new ArrayList<>(bot.runtimeUi);
        if(remove!=null && !bot.runtimeUi.remove(remove))return false;
        if(add!=null){if(bot.runtimeUi.size()>=16)return false;bot.runtimeUi.add(add);}
        if(persist())return true;bot.runtimeUi.clear();bot.runtimeUi.addAll(previous);return false;
    }

    static boolean endpoint(String value, String scheme) {
        try {
            java.net.URI u = new java.net.URI(value);
            return value.matches(scheme + "://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/?") && u.getPort() > 0 && u.getPort() <= 65535 && u.getPort() != 80;
        } catch (Exception ex) { return false; }
    }

    private static boolean portConflict(Binding a, Binding b) {
        for (String left : Arrays.asList(a.httpUrl,a.wsUrl)) for (String right : Arrays.asList(b.httpUrl,b.wsUrl)) {
            try { int p=java.net.URI.create(left).getPort(); if(p>0 && p==java.net.URI.create(right).getPort()) return true; }
            catch(IllegalArgumentException ignored) { /* invalid legacy endpoints will not launch */ }
        }
        return false;
    }

    public static synchronized boolean platformEnabled(String id,String platform){Bot b=get(id);return b!=null&&b.platforms.contains(platform)&&b.activePlatforms.contains(platform);}
    static synchronized boolean setPlatformEnabled(String id,String platform,boolean on){
        Bot b=get(id);if(!writable||b==null||!b.platforms.contains(platform))return false;
        if(b.activePlatforms.contains(platform)==on)return true;
        if(on)b.activePlatforms.add(platform);else b.activePlatforms.remove(platform);
        if(persist())return true;if(on)b.activePlatforms.remove(platform);else b.activePlatforms.add(platform);return false;
    }
    /** Add an unassigned login slot only; never re-sync or recreate existing bindings. */
    static synchronized boolean addPlatform(String botId,String coreId,String platform){
        Bot b=get(botId);CoreInventory.Instance c=CORES.get(coreId);
        if(!writable||b==null||c==null||!coreId.equals(b.coreInstanceId)||!botId.equals(c.ownerId)||!PLATFORM_SUPPORTED(platform)||!c.platforms.contains(platform)||b.platforms.contains(platform)||b.bindings.size()>=32)return false;
        Binding slot=new Binding("b-"+java.util.UUID.randomUUID(),platform,"","shared","","");
        long oldTime=b.updatedAt;boolean wasActive=b.activePlatforms.remove(platform);
        b.platforms.add(platform);b.bindings.add(slot);b.updatedAt=System.currentTimeMillis();
        if(persist())return true;b.platforms.remove(platform);b.bindings.remove(slot);b.updatedAt=oldTime;if(wasActive)b.activePlatforms.add(platform);return false;
    }
    public interface NewSession { void save() throws Exception; void discard() throws Exception; }
    /** Commit a verified first login to the exact pending slot, or to a new slot reserved by this attempt. */
    public static synchronized String enrollBili(String botId,String slot,boolean newSlot,String uid,NewSession session){
        Bot b=get(botId);if(b==null||!b.enabled||!KIND_BUILTIN.equals(b.runtimeKind)||!b.platforms.contains(P_BILIBILI)||slot==null||!slot.matches("[A-Za-z0-9_-]{1,64}")||uid==null||!uid.matches("[1-9][0-9]{0,15}")||Long.parseLong(uid)>9007199254740991L||session==null)return "invalid_selection";
        Binding before=null;for(Binding v:b.bindings)if(slot.equals(v.id))before=v;
        if(newSlot ? before!=null||b.bindings.size()>=32 : before==null||!P_BILIBILI.equals(before.platform)||!before.accountId.isEmpty()||!before.httpUrl.isEmpty()||!before.wsUrl.isEmpty())return "slot_changed";
        for(Bot other:BOTS)for(Binding v:other.bindings)if(P_BILIBILI.equals(v.platform)&&uid.equals(v.accountId))return "already_bound";
        Binding next=new Binding(slot,P_BILIBILI,uid,before==null?"shared":before.memoryMode,"","","");
        try{session.save();}catch(Exception e){return "session_save_failed";}
        boolean firstEnabled=b.activePlatforms.add(P_BILIBILI);
        if(changeBinding(b,before,next)==null)return null;
        if(firstEnabled)b.activePlatforms.remove(P_BILIBILI);
        try{session.discard();}catch(Exception e){return "session_cleanup_failed";}return "binding_save_failed";
    }
    static synchronized String changeBinding(Bot b, Binding before, Binding after) {
        if (b == null || get(b.id) != b || (before != null && !b.bindings.contains(before))) return "绑定已变化，请返回重试";
        if(after==null && before==null)return "请选择绑定";
        if(after!=null && !coreForBot(b.id).platforms.contains(after.platform))return "核心不支持此平台";
        if (after != null) {
            if (!PLATFORM_SUPPORTED(after.platform) || !after.accountId.matches("[1-9][0-9]{0,15}") || Long.parseLong(after.accountId)>9007199254740991L) return "请输入有效的平台账号数字 ID（不超过 9007199254740991）";
            if (!after.peerId.isEmpty() && (!after.hostedBili() || !after.peerId.matches("[1-9][0-9]{0,15}") || Long.parseLong(after.peerId)>9007199254740991L || after.accountId.equals(after.peerId))) return "私信对端必须是与本人不同的有效 UID";
            if (before==null && b.bindings.size()>=32) return "每台机器人最多绑定 32 个账号";
            if (!(after.hostedBili() && KIND_BUILTIN.equals(b.runtimeKind)) && (!endpoint(after.httpUrl, "http") || !endpoint(after.wsUrl, "ws"))) return "请填写本机 127.0.0.1 的 HTTP 和 WS 地址及端口，不含凭据、查询或片段";
            if (!"shared".equals(after.memoryMode) && !"isolated".equals(after.memoryMode)) return "请选择记忆模式";
            for (Bot bot : BOTS) for (Binding v : bot.bindings) {
                if (v == before) continue;
                if (v.platform.equals(after.platform) && v.accountId.equals(after.accountId)) return "这个平台账号已有绑定";
                if (portConflict(v,after)) return "协议端口已被其他绑定使用，请为每个账号配置独立的监听端口";
            }
        }
        List<Binding> old = b.bindings; List<String> oldPs = b.platforms; long oldTime = b.updatedAt;
        b.bindings = new ArrayList<>(old);
        if (before == null) b.bindings.add(after);
        else if (after == null) b.bindings.remove(before);
        else b.bindings.set(b.bindings.indexOf(before), after);
        b.platforms = new ArrayList<>();
        for (Binding v : b.bindings) if (!b.platforms.contains(v.platform)) b.platforms.add(v.platform);
        b.updatedAt = System.currentTimeMillis();
        if (persist()) return null;
        b.bindings = old; b.platforms = oldPs; b.updatedAt = oldTime;
        return "无法保存绑定，请检查本机存储后重试";
    }

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
        final java.util.Set<String> activePlatforms = new java.util.LinkedHashSet<>();
        public List<Binding> bindings = new ArrayList<>();
        final List<RuntimeUiLink> runtimeUi = new ArrayList<>();
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

        public final String coreInstanceId;
        public Bot() {this("");}
        Bot(String coreInstanceId){this.coreInstanceId=coreInstanceId;}

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

    private static final java.util.LinkedHashMap<String,CoreInventory.Instance> CORES=new java.util.LinkedHashMap<>();
    private static boolean writable;
    private BotRegistry() {}

    /** Empty installs remain empty. Existing registry owners are projected in place, without IO on init. */
    public static synchronized void init(File dir) {
        storeDir=dir;BOTS.clear();CORES.clear();writable=dir!=null;
        if(dir==null)return;
        File file=new File(dir,BotStore.FILE_NAME);
        if(!file.exists())return;
        try {BotStore.load(file,BOTS,CORES);sortByCreatedAt();}
        catch(Exception ex){BOTS.clear();CORES.clear();writable=false;} // Don't clobber corrupt/future registries.
    }
    private static boolean persist(){return writable && BotStore.save(new File(storeDir,BotStore.FILE_NAME),BOTS,CORES.values());}
    private static CoreInventory.Instance current(CoreInventory.Instance c){
        if(c==null || c.legacy || !KIND_BUILTIN.equals(c.kind))return c;
        String v=CoreInventory.activeVersion(storeDir,c.id);return v==null || v.equals(c.version)?c:c.withVersion(v);
    }
    public static synchronized List<CoreInventory.Instance> cores(){List<CoreInventory.Instance> rows=new ArrayList<>();for(CoreInventory.Instance c:CORES.values())rows.add(current(c));return rows;}
    public static synchronized CoreInventory.Instance coreForBot(String id){Bot b=get(id);return b==null?null:current(CORES.get(b.coreInstanceId));}
    public static synchronized CoreInventory.Instance importDescriptor(String json){return insert(CoreInventory.parseDescriptor(json));}
    public static synchronized CoreInventory.Instance registerBuiltin(String id,String version){
        CoreInventory.Instance c=CoreInventory.builtin(id,version);
        if(!CoreInventory.hasReceipt(storeDir,id,version))throw new IllegalArgumentException("Missing committed core receipt");
        return insert(c);
    }
    private static CoreInventory.Instance insert(CoreInventory.Instance c){
        if(!writable || CORES.containsKey(c.id) || CORES.size()>=1024)throw new IllegalStateException("Cannot register instance");
        CORES.put(c.id,c);if(persist())return c;CORES.remove(c.id);throw new IllegalStateException("Registry write failed");
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

    // ---------------------------------------------------------------- 查询

    /** 全部机器人（含停用），按 createdAt 升序。返回副本，调用方改不到内部列表。 */
    public static synchronized List<Bot> list() {
        return new ArrayList<Bot>(BOTS);
    }

    /** 按 id 取；不存在返回 null。 */
    public static synchronized Bot get(String id) {
        if (id == null) return null;
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (b.id != null && b.id.equals(id)) return b;
        }
        return null;
    }

    /** 第一个可用机器人（优先 enabled，其次第一个）；列表为空返回 null，调用方要判空。 */
    public static synchronized Bot primary() {
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (b.enabled && b.id != null) return b;
        }
        return BOTS.isEmpty() ? null : BOTS.get(0);
    }

    /** 某平台上的全部机器人（含停用）—— 多机器人 / 多平台的查询入口。 */
    public static synchronized List<Bot> forPlatform(String platformId) {
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

    /** Compatibility entry point: the reference must now identify an existing, explicitly chosen core. */
    public static synchronized Bot create(String name,String persona,String kind,String ref,List<String> platforms){
        CoreInventory.Instance c=CORES.get(ref);return c!=null && c.kind.equals(kind)?createOnCore(ref,name,persona,platforms):null;
    }
    public interface BeforeCreate {void prepare(String plannedBotId) throws java.io.IOException;}
    public static synchronized Bot createOnCore(String id,String name,String persona,List<String> platforms){return createOnCore(id,name,persona,platforms,null);}
    public static synchronized Bot createOnCore(String id,String name,String persona,List<String> platforms,BeforeCreate prepare){
        return allocate(id,name,persona,platforms,null,prepare);
    }
    /** Restore only local slot identities and their sharing modes; never restore accounts, peers or endpoints. */
    public static synchronized Bot restoreOnCore(String id,String name,String persona,List<String> platforms,List<String[]> slots,BeforeCreate prepare){
        CoreInventory.Instance c=CORES.get(id);
        if(c==null || !KIND_BUILTIN.equals(c.kind) || slots==null || slots.size()>32 || platforms==null)return null;
        List<Binding> restored=new ArrayList<>();java.util.Set<String> ids=new java.util.HashSet<>(), covered=new java.util.HashSet<>();
        for(String[] row:slots){
            if(row==null || row.length!=3)return null;
            String key=row[0],platform=row[1],mode=row[2];
            if(key==null || !key.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}") || !ids.add(key) || !platforms.contains(platform)
                    || !("shared".equals(mode) || "isolated".equals(mode)))return null;
            restored.add(new Binding(key,platform,"",mode,"","",""));covered.add(platform);
        }
        if(!covered.containsAll(platforms))return null;
        return allocate(id,name,persona,platforms,restored,prepare);
    }
    static synchronized String nameProblem(String name,String exceptId){
        String n=name==null?"":name.trim();
        if(n.isEmpty())return "请填写机器人名称";
        if(n.length()>NAME_MAX)return "名称过长";
        for(Bot other:BOTS)if(!other.id.equals(exceptId)&&other.name!=null&&n.equalsIgnoreCase(other.name.trim()))return "已有同名机器人";
        return null;
    }
    static synchronized String rename(String id,String name){
        Bot b=get(id);if(!writable||b==null)return "无法保存名称";
        String problem=nameProblem(name,id);if(problem!=null)return problem;
        String old=b.name;long at=b.updatedAt;b.name=name.trim();b.updatedAt=System.currentTimeMillis();
        if(persist())return null;b.name=old;b.updatedAt=at;return "无法保存名称";
    }
    private static Bot allocate(String id,String name,String persona,List<String> platforms,List<Binding> restored,BeforeCreate prepare){
        CoreInventory.Instance c=CORES.get(id);
        if(!writable || c==null || c.legacy || !c.ownerId.isEmpty() || name==null || name.trim().isEmpty() || platforms==null || platforms.isEmpty() || !c.platforms.containsAll(platforms))return null;
        if(prepare==null && new File(storeDir,"rootfs/opt/whale/instance-data/.maintenance-"+id).exists())return null;
        String display=truncate(name.trim());
        if(restored==null){if(nameProblem(name,null)!=null)return null;}
        else if(nameProblem(display,null)!=null){
            for(int i=2;;i++){String suffix=" ("+i+")";int end=Math.min(display.length(),NAME_MAX-suffix.length());if(end>0&&Character.isHighSurrogate(display.charAt(end-1)))end--;String candidate=display.substring(0,end)+suffix;if(nameProblem(candidate,null)==null){display=candidate;break;}}
        }
        String version=c.version;
        if(KIND_BUILTIN.equals(c.kind)){version=CoreInventory.activeVersion(storeDir,id);if(version==null)return null;}
        Bot b=new Bot(id);b.id="bot-"+java.util.UUID.randomUUID();b.name=display;b.persona=persona==null?"":persona;
        b.platforms=sanitizePlatforms(platforms);if(restored==null)syncPlatforms(b);else b.bindings.addAll(restored);b.runtimeKind=c.kind;b.runtimeRef=version;b.runtimeUi.addAll(c.pages);
        b.createdAt=b.updatedAt=System.currentTimeMillis();
        if(prepare!=null)try{prepare.prepare(b.id);}catch(java.io.IOException e){return null;}
        if(CORES.get(id)!=c)return null;
        CORES.put(id,c.owned(b.id));BOTS.add(b);if(persist())return b;
        BOTS.remove(b);CORES.put(id,c);return null;
    }
    /** Metadata commit; caller coordinates quiesce, scoped reset and rollback under the same monitor. */
    public static synchronized boolean releaseOwner(String id,String expectedBotId){
        CoreInventory.Instance c=CORES.get(id);Bot b=get(expectedBotId);
        if(!writable || c==null || c.legacy || !KIND_BUILTIN.equals(c.kind) || b==null || !c.ownerId.equals(b.id) || !id.equals(b.coreInstanceId))return false;
        int i=BOTS.indexOf(b);BOTS.remove(i);CORES.put(id,c.owned(""));if(persist())return true;
        CORES.put(id,c);BOTS.add(i,b);return false;
    }

    /**
     * 保存改动并落盘。
     *
     * <p><b>就地更新</b>：把 {@code bot} 的字段拷进注册表里那个同 id 的实例，
     * 这样界面手里已经拿着的引用不会变成「孤儿」（列表/详情页不用重新取）。
     *
     * @return false 表示 id 不存在、名字为空或平台集合为空（未保存）
     */
    public static synchronized boolean update(Bot bot) {
        if (bot == null || bot.id == null) return false;
        Bot cur = get(bot.id);
        if (cur == null) return false;
        CoreInventory.Instance c=coreForBot(cur.id);
        if(c==null || !c.kind.equals(bot.runtimeKind) || (!bot.coreInstanceId.isEmpty() && !cur.coreInstanceId.equals(bot.coreInstanceId)))return false;
        String n = bot.name == null ? "" : bot.name.trim();
        if (n.length() == 0) return false;
        List<String> ps = sanitizePlatforms(bot.platforms);
        if (!c.platforms.containsAll(ps)) return false;

        cur.name = truncate(n);
        cur.persona = bot.persona == null ? "" : bot.persona;
        cur.platforms = ps;
        syncPlatforms(cur);
        cur.runtimeKind = KIND_CUSTOM.equals(bot.runtimeKind) ? KIND_CUSTOM : KIND_BUILTIN;
        cur.runtimeRef = bot.runtimeRef == null ? "" : bot.runtimeRef.trim();
        cur.enabled = bot.enabled;
        cur.updatedAt = System.currentTimeMillis();
        return persist();
    }

    /** Deleting a row would circumvent explicit release/reset. */
    @Deprecated public static boolean remove(String id){return false;}

    // ---------------------------------------------------------------- 状态回填（不落盘）

    /**
     * 旧 QQ 面板的全局登录状态只能回填旧版单账号机器人。
     * 新绑定的连接事实来自独立的身份核验；绝不向同平台其他机器人广播。
     *
     * @param account 已登录账号；未登录传 null。本类只存不打印。
     */
    public static synchronized void report(String platformId, boolean running, String account) {
        String acc = (account == null || account.length() == 0) ? null : account;
        for (int i = 0; i < BOTS.size(); i++) {
            Bot b = BOTS.get(i);
            if (!P_QQ.equals(platformId) || !legacyQQ(b)) continue;
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
