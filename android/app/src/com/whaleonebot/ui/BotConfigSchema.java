package com.whaleonebot.ui;

/**
 * 运行端配置面板的「目录」：分组 → 小节 → 字段。
 *
 * <p>这里只有数据，没有一行视图代码。每一项都对应 {@code /agent/data/config.json} 里的一条
 * 真实路径；标签、说明、取值范围来自运行端自带的网页控制台，逐条抄的，不是猜的：
 *
 * <ul>
 *   <li>{@code app/ui/pages/settings.js} —— 白名单、消息类型、记忆、拟人化</li>
 *   <li>{@code app/ui/pages/chat.js} —— 对话模式、发送保护、主动开话题、表情包</li>
 *   <li>{@code app/ui/pages/persona.js} —— 人格与角色</li>
 *   <li>{@code app/ui/pages/moments.js} —— 群游戏、定时提醒</li>
 *   <li>{@code app/ui/pages/settings-extensions.js} —— 知识库、MCP、群管理</li>
 *   <li>{@code app/ui/pages/platform.js} —— 插件宿主资源上限</li>
 *   <li>{@code app/ui/pages/living-memory.js} —— 长期记忆</li>
 *   <li>{@code src/core/config-legacy.js} —— 默认值与 clamp 区间（网页没写的上下限）</li>
 * </ul>
 *
 * <p><b>密钥类字段一条都不在这里</b>（{@code apiKey / token / secret / password / providerKeys}）。
 * 面板还有一道 {@link BotConfigJson#isSecret(String)} 兜底过滤，双保险。
 *
 * <p>2026-11-18 扩充：新增 {@link #MAP} 类型（键值映射，如「群号 → 回复概率」），
 * 并按 {@code 开发期的面板覆盖记录（本机 _notes）} §6 补齐模型接口、平台能力、
 * 日报与动态、语音、协议端连接、Web 搜索、试点功能等组。所有新增路径都逐条比对过活配置快照
 * （{@code .tmp/phone-agent-runtime-6g9XJC/data/config.json}），快照里不存在的路径一条都没写。
 */
final class BotConfigSchema {

    private BotConfigSchema() {
    }

    // ---------------------------------------------------------------- 字段类型

    static final int BOOL = 1;
    /** 整数。显示值 = 存储值 / factor（毫秒↔分钟/秒的换算都走它）。 */
    static final int INT = 2;
    /** 小数。{@code probability} 这类 0~1 的值用 factor = 0.01 显示成百分数。 */
    static final int DEC = 3;
    /** 单行文本。 */
    static final int TEXT = 4;
    /** 多行文本。 */
    static final int MULTI = 5;
    /** 字符串数组（增删改）。 */
    static final int LIST = 6;
    /** 枚举：只能取 {@link Field#values} 里的值。 */
    static final int ENUM = 7;
    /** 键值映射：群号 → 百分比 这类。界面上是可增删改的行列表。 */
    static final int MAP = 8;

    // ---------------------------------------------------------------- 数据结构

    static final class Field {
        final String path;
        final String label;
        final String hint;
        final String placeholder;
        final int type;
        /** 显示值 = 存储值 / factor。0 视为 1。 */
        final double factor;
        final boolean hasRange;
        final double min;
        final double max;
        final int maxChars;
        final String[] values;
        final String[] valueLabels;
        /** 配置里没有这个键时界面上的默认值（运行端的实际默认）。 */
        final boolean defBool;
        /** {@link #MAP} 的键列提示，如「群号」；其它类型为 null。 */
        final String mapKeyLabel;
        /** {@link #MAP} 的值列提示，如「回复概率 %」；其它类型为 null。 */
        final String mapValueLabel;
        /** {@link #MAP}：true = 值按 JSON 数字写回，false = 按字符串写回。 */
        final boolean mapValueNum;

        Field(int type, String path, String label, String hint, String placeholder,
              double factor, boolean hasRange, double min, double max, int maxChars,
              String[] values, String[] valueLabels, boolean defBool) {
            this(type, path, label, hint, placeholder, factor, hasRange, min, max, maxChars,
                    values, valueLabels, defBool, null, null, false);
        }

        /** MAP 用的重载：多三个列描述。老的 13 参构造签名一个字都没动。 */
        Field(int type, String path, String label, String hint, String placeholder,
              double factor, boolean hasRange, double min, double max, int maxChars,
              String[] values, String[] valueLabels, boolean defBool,
              String mapKeyLabel, String mapValueLabel, boolean mapValueNum) {
            this.type = type;
            this.path = path;
            this.label = label;
            this.hint = hint;
            this.placeholder = placeholder;
            this.factor = factor <= 0 ? 1 : factor;
            this.hasRange = hasRange;
            this.min = min;
            this.max = max;
            this.maxChars = maxChars;
            this.values = values;
            this.valueLabels = valueLabels;
            this.defBool = defBool;
            this.mapKeyLabel = mapKeyLabel;
            this.mapValueLabel = mapValueLabel;
            this.mapValueNum = mapValueNum;
        }

        boolean isMap() {
            return type == MAP;
        }
    }

    static final class Section {
        final String title;
        final String note;
        final Field[] fields;

        Section(String title, String note, Field[] fields) {
            this.title = title;
            this.note = note;
            this.fields = fields;
        }

        int size() {
            return fields == null ? 0 : fields.length;
        }
    }

    static final class Group {
        final String title;
        final String desc;
        final int icon;
        final Section[] sections;

        Group(String title, String desc, int icon, Section[] sections) {
            this.title = title;
            this.desc = desc;
            this.icon = icon;
            this.sections = sections;
        }

        int fieldCount() {
            int n = 0;
            for (int i = 0; i < sections.length; i++) n += sections[i].size();
            return n;
        }
    }

    // ---------------------------------------------------------------- 构造助手

    private static Field b(String path, String label, String hint, boolean def) {
        return new Field(BOOL, path, label, hint, null, 1, false, 0, 0, 0, null, null, def);
    }

    private static Field i(String path, String label, String hint, double min, double max, double factor) {
        return new Field(INT, path, label, hint, null, factor, true, min, max, 0, null, null, false);
    }

    private static Field d(String path, String label, String hint, double min, double max, double factor) {
        return new Field(DEC, path, label, hint, null, factor, true, min, max, 0, null, null, false);
    }

    private static Field s(String path, String label, String hint, String placeholder) {
        return new Field(TEXT, path, label, hint, placeholder, 1, false, 0, 0, 0, null, null, false);
    }

    private static Field m(String path, String label, String hint, int maxChars) {
        return new Field(MULTI, path, label, hint, null, 1, false, 0, 0, maxChars, null, null, false);
    }

    private static Field list(String path, String label, String hint, String placeholder) {
        return new Field(LIST, path, label, hint, placeholder, 1, false, 0, 0, 0, null, null, false);
    }

    private static Field e(String path, String label, String hint,
                           String[] values, String[] labels) {
        return new Field(ENUM, path, label, hint, null, 1, false, 0, 0, 0, values, labels, false);
    }

    /**
     * 键值映射。值列的原样写回：本类<b>不做</b> factor 换算
     * （{@code store.groupSliderPos} 存的本来就是 0~100 的百分比）。
     */
    private static Field map(String path, String label, String hint,
                             String keyLabel, String valueLabel, boolean valueNum) {
        return new Field(MAP, path, label, hint, null, 1, false, 0, 0, 0, null, null, false,
                keyLabel, valueLabel, valueNum);
    }

    private static String[] arr(String... v) {
        return v;
    }

    private static Section sec(String title, String note, Field... fields) {
        // 用户 2026-11-18：分节说明整段不显示（只有字段级的「范围 / 单位」短提示保留）。
        return new Section(title, "", fields);
    }

    // ---------------------------------------------------------------- 分组

    static final Group[] GROUPS;

    static {
        Group[] all = new Group[]{

                // -------------------------------------------------- 1 白名单 / 黑名单
                new Group("白名单 / 黑名单",
                        "谁能跟机器人说话：群号与私聊 QQ 的两张放行清单，外加一份优先的黑名单。",
                        IconView.CHECK,
                        new Section[]{
                                sec("会话放行",
                                        "白名单为空时机器人不会在任何群聊/私聊内运行 —— 这是运行端的硬规则。",
                                        list("allow.groups", "允许的群号",
                                                "一行一个群号。控制台的「从 QQ 账号直接勾选」在手机端没有，手工填号即可。",
                                                "1054041195"),
                                        list("allow.private", "允许的 QQ（私聊）",
                                                "一行一个 QQ 号。私聊不在这里的人，机器人不会回。",
                                                "3318263635"),
                                        b("allowAllWhenEmpty", "白名单留空时允许所有会话",
                                                "默认关。打开后白名单留空 = 不限制任何会话（不建议）。", false)),
                                sec("黑名单（优先于白名单）",
                                        "deny 优先：同一个会话既在白名单又在黑名单里，按禁止处理。",
                                        list("deny.groups", "禁止的群号", "一行一个群号。", null),
                                        list("deny.private", "禁止的 QQ", "一行一个 QQ 号。", null))
                        }),

                // -------------------------------------------------- 2 人格与角色
                new Group("人格与角色",
                        "机器人是谁：名字、交流策略、参与度，以及角色设定原文与附加规则。",
                        IconView.CHAT,
                        new Section[]{
                                sec("身份",
                                        "机器人名字是账号名字，不随角色卡切换；群里显示的是「群内展示名」或 QQ 群名片。",
                                        s("persona.botName", "机器人名字",
                                                "账号名字，不随角色卡切换。留空会被运行端填回默认值。", "小鲸鱼"),
                                        s("persona.selfNickname", "群内展示名（可选）",
                                                "留空则用 QQ 群名片。", null),
                                        e("persona.behaviorProfile", "交流策略",
                                                "「原版群友」允许装傻、随口应付；「自然可靠」不装傻、说话有据；"
                                                        + "「角色卡优先」把语气、口吻、节奏完全交给角色设定。",
                                                arr("legacy", "grounded", "card"),
                                                arr("原版群友", "自然可靠", "角色卡优先")),
                                        e("persona.participation", "参与度",
                                                "安静 / 普通 / 活跃。角色卡优先档只决定开口频率，不规定语气。",
                                                arr("low", "medium", "high"),
                                                arr("安静型", "普通群友", "活跃型"))),
                                sec("角色设定",
                                        "这一节就是要保存的原文：改一个字会解除与内置卡的绑定，正文从此归你自己管。",
                                        m("persona.roleText", "角色设定（原文）",
                                                "例如：你是运维群里的老油条……", 0),
                                        m("persona.customRules", "管理员附加规则（可选）",
                                                "附加给模型的规则，优先级高于角色设定。", 0)),
                                sec("拟人化·消息形态",
                                        "只管气泡怎么切，不改内容与语气。关掉「拆条」后长回复就是一条。",
                                        b("humanize.shape.enabled", "把长回复拆成几条气泡",
                                                "默认开。按语义断成 2~3 条，比一条长段更像人在打字。", true),
                                        i("humanize.shape.maxBubbles", "一次最多拆成几条",
                                                "默认 3。拆太多像刷屏，建议 2~4。", 1, 8, 1),
                                        i("humanize.shape.maxChars", "单条气泡最大字数",
                                                "默认 60。超过就断到下一条；设太小会让一句话被切碎。", 20, 2000, 1)),
                                sec("拟人化·小动作（表情 / 拍一拍 / 语音 / 回应）",
                                        "这是「动作」的独立闸门与冷却，只在闲聊场景用；技术、严肃话题不动。要先把上面的「启用拟人化表达」打开。",
                                        b("humanize.actions.enabled", "允许主动做小动作",
                                                "默认开。关掉后只发文字。", true),
                                        i("humanize.actions.maxPerRun", "每轮最多做几次动作",
                                                "默认 4。一轮回复里最多发几个表情/拍几下。", 0, 10, 1),
                                        i("humanize.actions.stickerCooldownMs", "两次发表情的间隔（秒）",
                                                "默认 60 秒。同一会话里的最短间隔，防连发。", 0, 3600, 1000),
                                        i("humanize.actions.pokeCooldownMs", "两次拍一拍的间隔（秒）",
                                                "默认 300 秒（5 分钟）。", 0, 3600, 1000),
                                        i("humanize.actions.voiceCooldownMs", "两次发语音的间隔（秒）",
                                                "默认 600 秒（10 分钟）。要先在「语音（ASR / TTS）」里配好语音合成。", 0, 3600, 1000),
                                        i("humanize.actions.reactCooldownMs", "两次贴表情回应的间隔（秒）",
                                                "默认 30 秒。指给别人消息贴 👍 这类回应，不是发图。", 0, 3600, 1000)),
                                sec("作息与省 token",
                                        "「休息时段」喂给心情/状态链路：到点它显得更疲惫、话更短，不是停机。跨夜照写，例如 23:30 ~ 07:00。",
                                        s("humanize.personaState.sleepStart", "休息开始（HH:MM）",
                                                "24 小时制，例如 23:30。默认 00:00。", "23:30"),
                                        s("humanize.personaState.sleepEnd", "休息结束（HH:MM）",
                                                "24 小时制，例如 07:00。默认 07:00。", "07:00"),
                                        e("tokenSaver.mode", "省 token 强度",
                                                "轻度或明显压缩历史条数与单轮 token；默认关闭。",
                                                arr("off", "balanced", "aggressive"),
                                                arr("关闭（完全按设置）", "省（轻度压缩）", "很省（明显压缩）")))
                        }),

                // -------------------------------------------------- 3 回复与发送
                new Group("回复与发送",
                        "什么时候回、回多快、一次发几条，以及拟人化表达的全部开关。",
                        IconView.CHAT,
                        new Section[]{
                                sec("对话模式",
                                        "三种模式共用下面这套参数，群聊只是选择用哪一种。",
                                        e("conversation.mode", "对话模式",
                                                "传统触发 / 参与者续接 / 完整生命周期。",
                                                arr("legacy", "threaded", "lifecycle"),
                                                arr("传统触发", "参与者续接", "完整生命周期")),
                                        b("conversation.unifiedMode", "所有群聊统一使用默认模式",
                                                "关掉后可以按群覆盖，但按群覆盖的编辑在手机端没有（控制台才能改）。", true),
                                        i("conversation.continuationWindowMs", "确定性续接窗口（秒）",
                                                "机器人发言后，为当前参与者保留多久的续接窗口。", 10, 1800, 1000),
                                        i("conversation.threadTtlMs", "线程空闲过期（分钟）",
                                                "超过这个时间没消息，线程作废。", 5, 1440, 60000),
                                        i("conversation.continuationContextCount", "续接读取历史条数",
                                                "续接那一轮读多少条历史。", 1, 500, 1),
                                        i("conversation.silentIdleMs", "监听空闲结束（分钟）",
                                                "完整生命周期：安静多久算监听结束。", 1, 60, 60000),
                                        i("conversation.activeIdleMs", "活跃空闲结束（分钟）",
                                                "完整生命周期：活跃多久后转安静。", 1, 120, 60000),
                                        i("conversation.hardLifetimeMs", "生命周期硬上限（分钟）",
                                                "一轮生命周期最长多久，到点换代。", 5, 240, 60000),
                                        i("conversation.rolloverArmedMs", "硬上限后待续接（分钟）",
                                                "换代后还能被续接的窗口。", 1, 60, 60000),
                                        i("conversation.lifecycleContextCount", "首次读取历史条数",
                                                "生命周期开始时读多少条历史。", 1, 500, 1),
                                        i("conversation.maxTranscriptChars", "追加上下文兜底（字符）",
                                                "上下文正文的绝对上限（字符）。", 20000, 1000000, 1),
                                        i("conversation.lifecycleRolloverInputTokens", "换代前输入 token 上限",
                                                "累计输入到这么多 token 就换代（把上下文重开一份）。默认 12 万；"
                                                        + "调小更省钱、它更容易忘细节。", 10000, 2000000, 1)),
                                sec("运行节奏",
                                        null,
                                        i("wakeDelayMinMs", "未思考等待最短值（毫秒）",
                                                "收到消息后随机等待的下界（防秒回）。", 0, 20000, 1),
                                        i("wakeDelayMaxMs", "未思考等待最长值（毫秒）",
                                                "随机等待的上界。", 0, 20000, 1),
                                        i("drainDelayMs", "批次间隔（毫秒）",
                                                "上一轮结束到下一轮处理的间隔。", 0, 600000, 1),
                                        i("maxConcurrentRuns", "同时处理几个会话",
                                                "并发上限，和内存/费用直接相关。", 1, 8, 1)),
                                sec("发送保护",
                                        "QQ 侧有频率限制，这几个数是防止刷屏与风控的主要闸门。",
                                        i("send.minGapMs", "相邻消息最小间隔（毫秒）", null, 200, 60000, 1),
                                        i("send.maxGapMs", "最大间隔（毫秒）", null, 500, 120000, 1),
                                        i("send.byLengthMs", "按字数附加间隔（毫秒/字）", null, 0, 1000, 1),
                                        i("send.maxPerMinute", "每分钟最多发送", null, 1, 1000, 1),
                                        i("send.maxPerHour", "每小时最多发送", null, 1, 10000, 1),
                                        i("send.hardSplitAt", "QQ 硬限制切分长度（0 = 不切）",
                                                "超长文本按这个长度切成多条。", 0, 10000, 1),
                                        b("send.typingIndicator", "发送前显示「正在输入」",
                                                "私聊里更像真人；群聊不显示。", true),
                                        b("send.queueWhenLimited", "触发限流时排队而不是丢弃",
                                                "关掉后超限的消息会被直接丢掉。", true),
                                        i("send.maxQueueWaitMs", "排队最长等待（毫秒）",
                                                "排队超时就不再发，避免回十分钟前的话。", 0, 600000, 1)),
                                sec("回复行为",
                                        null,
                                        b("conversation.replyGuardEnabled", "该回却没发时自动纠正一次",
                                                "只在模型写了正文却没调用发送工具时触发，会多跑一次模型。私聊 / 被 @ / 引用 / 点名。", true),
                                        b("conversation.pokeReplyEnabled", "拍一拍机器人时按直接互动回复",
                                                "必回、即时处理（跳过随机概率）。要么这个开，要么「戳一戳」那一组的反拍开。", true),
                                        i("conversation.mentionCooldownSec", "群聊被 @ 最小回复间隔（秒，0 = 不限制）",
                                                "仅对群聊生效（不影响私聊），按群独立计时。默认 60 秒：窗口内只回复第 1 次 @，其余 @ 照常完整入库供机器人知晓，可在「按群设置」里逐群覆盖。",
                                                0, 3600, 1),
                                        i("conversation.pokeCooldownSec", "群聊被戳一戳最小回复间隔（秒，0 = 不限制）",
                                                "仅对群聊生效（不影响私聊），按群独立计时。默认 60 秒：窗口内只把第 1 次戳一戳触发回复，其余照常入库留痕，可在「按群设置」里逐群覆盖。",
                                                0, 3600, 1)),
                                sec("拟人化表达（实验性）",
                                        "只影响发送时机与措辞，不改变角色设定。延迟仅作用于本轮第一条气泡，暂停或中止会立即取消等待。",
                                        b("humanize.enabled", "启用拟人化表达与助手腔过滤", null, false),
                                        e("humanize.preset", "风格预设", null,
                                                arr("natural", "active", "quiet", "companion"),
                                                arr("自然", "活跃", "安静", "陪聊")),
                                        b("humanize.replyDelay.enabled", "发送前按字数延迟",
                                                "私聊会先显示「正在输入」。默认建议从 0.5–2 秒开始观察。", true),
                                        i("humanize.replyDelay.minMs", "最短等待（毫秒）", null, 0, 30000, 1),
                                        i("humanize.replyDelay.maxMs", "最长等待（毫秒）", null, 0, 30000, 1),
                                        i("humanize.replyDelay.perCharMs", "每字增加（毫秒）", null, 0, 200, 1),
                                        i("humanize.replyDelay.capMs", "等待封顶（毫秒）", null, 0, 30000, 1),
                                        b("humanize.antiAi.enabled", "过滤助手式自指与客服收尾语", null, true),
                                        b("humanize.antiAi.blockSevere", "检测到明显的助手自指/免责时，要求重写一次", null, true),
                                        b("humanize.personaState.enabled", "状态（精力/心情/当前活动）影响语气",
                                                "同一人设跨群共享。关闭后上游那套状态链路整条不跑。", true),
                                        b("humanize.relationship.enabled", "记录与每个人的互动关系",
                                                "仅对已有人物印象的人生效。", true),
                                        e("humanize.memeUse.level", "梗密度（闲聊里的网络梗）",
                                                "只影响闲聊；技术、学习、情绪严肃场景仍不用梗。",
                                                arr("off", "light", "normal", "heavy"),
                                                arr("关闭：不主动用梗", "克制：只接对方用过的梗",
                                                        "正常：贴合时用一次", "活跃：闲聊里更主动")),
                                        b("humanize.respectPersonaCard", "角色卡优先时不覆盖角色语气（推荐）", null, true)),
                                sec("存储与上下文",
                                        "控制消息留存、磁盘上限与每轮读取条数。",
                                        i("store.maxMessagesPerChat", "每个会话保留消息条数（0 = 不限）",
                                                "默认 0（不限）。长期跑下来磁盘会一直长，建议按需设个数（例如 5000）。",
                                                0, 1000000, 1),
                                        i("store.retentionDays", "消息保留天数（0 = 不过期）",
                                                "超期自动删。默认 0。", 0, 3650, 1),
                                        i("store.keepSessionFiles", "保留多少个历史会话文件",
                                                "每轮对话落一个文件，多了先删最老的。默认 2000。", 0, 100000, 1),
                                        i("store.sessionPersistMs", "会话落盘间隔（秒）",
                                                "默认 10 秒。调小更抗突然断电，但更费 IO。", 1, 600, 1000),
                                        i("store.sessionCompressAfterDays", "多少天后压缩归档会话（天）",
                                                "默认 30。0 = 不压缩。", 0, 3650, 1),
                                        i("store.sessionMaxTotalMb", "会话文件总量上限（MB）",
                                                "默认 1024（1 GB）。超了先删最老的。", 16, 65536, 1),
                                        e("store.sqliteSynchronous", "数据库落盘强度",
                                                "FULL 最稳（默认）；NORMAL 更快但掉电可能丢最近几条。",
                                                arr("FULL", "NORMAL"),
                                                arr("FULL：最稳（默认）", "NORMAL：更快，可能丢最近几条")),
                                        i("store.pastStateMaxChars", "「之前的状态」字符上限",
                                                "拼进提示词的历史状态正文上限。默认 24000，越大越费 token。",
                                                0, 200000, 1),
                                        i("store.batchLimit", "一轮最多领取多少条未读",
                                                "运行端自己夹在 1~100。默认 100；只能往小改，改大没效果。", 1, 100, 1),
                                        i("store.batchMaxChars", "一轮领取的正文总字符上限",
                                                "默认 32000。超过就只取前面的，防一次塞爆上下文。", 1000, 200000, 1),
                                        b("store.contextLayering.enabled", "按层级裁剪上下文（老消息先压成摘要）",
                                                "默认开。关掉后按固定条数读取，更费 token。", true),
                                        i("store.contextLayering.maxHistoryMessages", "分层后最多带多少条历史原文",
                                                "默认 24。", 0, 500, 1),
                                        i("store.contextLayering.maxHistoryChars", "分层后历史原文字符上限",
                                                "默认 8000。", 0, 200000, 1),
                                        i("store.atCount", "被 @ 时读多少条已读",
                                                "被 @ 时读取的历史条数，默认 300。", 0, 1000, 1),
                                        i("store.keywordCount", "命中关键词时读多少条已读",
                                                "默认 100。同上会被分级/省 token 再夹。", 0, 1000, 1),
                                        i("store.randomCount", "按概率回应时读多少条已读",
                                                "默认 60。只有走「按概率」这条判定时才用。", 0, 1000, 1),
                                        i("store.allCount", "全响应 / 失败重试时读多少条已读",
                                                "默认 300。它是多个分支的兜底条数，调大对上下文影响最大。", 0, 1000, 1),
                                        i("store.contextSliderPos", "台词量概率（全局 0~100）",
                                                "全局回复概率：0 只回 @ 与关键词，100 每条都回。",
                                                0, 100, 1),
                                        i("store.contextTier", "档位（由概率推导，1~4）",
                                                "由概率自动推导（1~4），手改会在保存时被覆盖。",
                                                1, 4, 1),
                                        i("store.randomPercent", "概率回应的百分比（自动推导）",
                                                "由「台词量概率」自动推导，手改会被覆盖。", 0, 100, 1),
                                        list("store.keywords", "关键词（命中后必回）",
                                                "一行一个词。命中即必回，不看概率；黑名单优先，命中黑名单的消息不入库。",
                                                "作业"),
                                        list("store.blacklistKeywords", "黑名单关键词（命中后不回复）",
                                                "一行一个词。优先级最高：既不入库也不回。", "广告")),
                        }),

                // -------------------------------------------------- 4 主动发言
                new Group("主动发言",
                        "会话冷场后自己开话题：范围、节奏、概率，以及补话与自安排唤醒。",
                        IconView.DOT,
                        new Section[]{
                                sec("开关与范围",
                                        "群聊沿用「群白名单」、私聊沿用「私聊白名单」（deny 优先）。两个范围都不勾就不主动开口。",
                                        b("proactive.enabled", "会话安静时按概率发起话题", null, false),
                                        b("proactive.groupEnabled", "群聊（独立节奏，按群白名单）", null, true),
                                        b("proactive.privateEnabled", "私聊（独立节奏，按私聊白名单）",
                                                "默认关：主动私聊是直接打扰。", false),
                                        e("proactive.scopeMode", "判定方式",
                                                "「共用一次机会」= 每轮在所有群里挑一个、所有私聊里挑一个。",
                                                arr("shared", "perChat"),
                                                arr("群聊/私聊各共用一次机会", "每个群/私聊独立判定")),
                                        i("proactive.perChatMaxPerTick", "独立模式每轮最多开口",
                                                "只有选「每个群/私聊独立判定」时才生效。", 1, 10, 1)),
                                sec("节奏与概率",
                                        "检查间隔是随机区间的上下界；安静判定至少 5 分钟。",
                                        i("proactive.checkIntervalMinMs", "检查间隔下限（分钟）", null, 1, 1440, 60000),
                                        i("proactive.checkIntervalMaxMs", "检查间隔上限（分钟）", null, 2, 1440, 60000),
                                        i("proactive.idleThresholdMs", "安静判定（分钟）",
                                                "会话静默多久才算冷场（至少 5 分钟）。", 5, 1440, 60000),
                                        d("proactive.probability", "触发概率（%）",
                                                "每次检查到这个概率就开口。0 = 永不开。", 0, 100, 0.01)),
                                sec("补话与自安排",
                                        "这两条是独立开关，不跟随上面的总开关 —— 想彻底安静就把三个都关掉。",
                                        b("proactive.followUpEnabled", "发言后无人回应时，稍后补一句", null, true),
                                        i("proactive.followUpDelayMinutes", "补话基准延迟（分钟）",
                                                "实际会再加 0–2 分钟抖动。", 0, 240, 1),
                                        i("proactive.followUpCooldownMinutes", "同一会话两次补话最小间隔（分钟）", null, 0, 1440, 1),
                                        b("proactive.selfWakeEnabled", "允许模型给自己安排稍后的主动发言",
                                                "对应 schedule_wake 工具。", true)),
                                sec("自主节奏（pacing）",
                                        "群聊攒一会儿再统一回复，私聊始终即时。",
                                        b("pacing.enabled", "启用自主节奏", "默认关。开了以后群聊回复会明显变慢、但更像「刚看到」。", false),
                                        e("pacing.scope", "作用于哪些会话",
                                                "群聊（默认）或全部 —— 但私聊里永远即时回复，运行端写死了。",
                                                arr("group", "all"),
                                                arr("只群聊（默认）", "全部（私聊仍然即时）")),
                                        b("pacing.instantOnMention", "被 @ 时立刻处理（不等节奏）",
                                                "默认开。关掉后被 @ 也要排队等，不建议。", true),
                                        i("pacing.defaultWakeMinutes", "默认最长等多久（分钟）",
                                                "默认 20。会在这个值与下面的区间内取一个。", 1, 1440, 1),
                                        i("pacing.minWakeMinutes", "最短等待（分钟）",
                                                "默认 5，运行端硬下限 1 分钟。", 1, 1440, 1),
                                        i("pacing.maxSilenceMinutes", "最长静默（分钟）",
                                                "默认 45。再久也要醒一次。", 1, 1440, 1)),
                                sec("每群回复概率",
                                        "按群覆盖回复概率（0~100）；关闭「共用同一概率」后生效。",
                                        e("store.sliderMode", "台词量语义（固定值，别改）",
                                                "运行端固定语义标记，请勿修改。",
                                                arr("probability"),
                                                arr("按概率（新版语义）")),
                                        b("store.unifiedTier", "所有会话共用同一个回复概率",
                                                "默认开；关闭后下方「每群回复概率」生效。", true),
                                        map("store.groupSliderPos", "每群回复概率",
                                                "0~100，100 = 该群每条都回。没列出的群走上面的默认值。保存即生效。",
                                                "群号", "概率 %", true))
                        }),

                // -------------------------------------------------- 5 群游戏
                new Group("群游戏",
                        "数字炸弹 / 谁是卧底 / 狼人杀：允许哪些群、哪几种游戏、一局多久。",
                        IconView.BOX,
                        new Section[]{
                                sec("开关与范围",
                                        "需要私聊发词的游戏（卧底 / 狼人杀）必须先有私聊通道：加进私聊白名单，或打开下面的「游戏期间私聊豁免」。",
                                        b("groupGame.enabled", "启用群游戏", null, false),
                                        list("groupGame.chats", "允许开局的群",
                                                "一行一个「group:群号」（注意前缀）。留空 = 任何群都不开局。",
                                                "group:1054041195"),
                                        list("groupGame.games", "允许的游戏",
                                                "一行一个 id：number-bomb（数字炸弹）/ undercover（谁是卧底）/ werewolf（狼人杀，6~9 人）。",
                                                "werewolf"),
                                        b("groupGame.allowPrivateInvite", "允许私聊发词/身份",
                                                "谁是卧底与狼人杀都必需；只发给报名/在册的人，失败不重试。", false),
                                        b("groupGame.allowGamePrivateDm", "游戏期间私聊豁免",
                                                "只对局内玩家；默认关。", false)),
                                sec("对局参数",
                                        "讨论时长与单回合超时小于 30 秒时按 30 秒生效（0 = 用插件默认）。",
                                        i("groupGame.recruitSeconds", "开局报名时长（秒）",
                                                "0 = 不报名，直接按最近发言者发牌。", 0, 300, 1),
                                        i("groupGame.discussSeconds", "白天讨论时长（秒）",
                                                "0 = 插件默认 120。", 0, 600, 1),
                                        i("groupGame.roundSeconds", "单回合超时（秒）",
                                                "0 = 插件默认。", 0, 600, 1),
                                        i("groupGame.maxPlayers", "每局人数上限", null, 2, 30, 1),
                                        i("groupGame.maxDurationMin", "单局时长上限（分钟）", null, 5, 180, 1),
                                        i("groupGame.dailyLimitPerChat", "每群每天最多开局数", null, 1, 50, 1),
                                        b("groupGame.revealWords", "结算时公开词与身份",
                                                "关掉只公布胜方。", true))
                        }),

                // -------------------------------------------------- 6 表情包
                new Group("表情包",
                        "收藏表情同步、自动收藏的限频与判定标准，以及发送时用表情的积极程度。",
                        IconView.IMAGE,
                        new Section[]{
                                sec("收藏",
                                        "全局与每会话两道闸；控制台里手动添加表情不受这两项影响。",
                                        b("sticker.enabled", "启用表情包（收藏表情同步 + 发送工具）", null, false),
                                        b("sticker.collectEnabled", "允许机器人自己收藏表情包",
                                                "关掉后不再自动收，也不会在聊天里主动收；手动添加不受影响。", true),
                                        b("sticker.autoCollect", "别人发来的表情包自动进库",
                                                "同图只存一次，另受下面的每小时上限限频。", true),
                                        i("sticker.maxCollectPerHour", "每小时最多收藏（张）",
                                                "全局上限，1–60。", 1, 60, 1),
                                        i("sticker.maxCollectPerHourPerChat", "每个会话每小时最多收藏（张）", null, 1, 60, 1),
                                        m("sticker.collectCriteria", "收藏的判定标准（留空 = 内置默认）",
                                                "只写「收什么 / 不收什么」；身份那句由代码补在前面。超 2000 字判定时只取前 2000。",
                                                2000)),
                                sec("使用",
                                        null,
                                        i("sticker.promptMaxStickers", "系统提示里的表情清单条数",
                                                "列给模型看的表情条数，1–60；条数越多越费 token。", 1, 60, 1),
                                        e("sticker.encourage", "发表情包的积极程度",
                                                "这是「引导」不是「强制」，模型仍会自行判断时机。",
                                                arr("0", "1", "2", "3"),
                                                arr("0 · 不鼓励（只在很贴切时偶尔用）",
                                                        "1 · 偶尔（合适时配一张）",
                                                        "2 · 较积极（优先考虑配图）",
                                                        "3 · 很积极（表情包爱好者）")))
                        }),

                // -------------------------------------------------- 7 知识库
                new Group("知识库",
                        "轻量本地知识库：只读 .md / .txt，按关键词检索，不接 embedding。",
                        IconView.BOX,
                        new Section[]{
                                sec("检索参数",
                                        "把群规 / FAQ / 手册放进目录，模型就能用 knowledge_search 检索并带来源回答。不是完整 RAG：没有向量检索，也不解析 PDF/DOCX。",
                                        b("knowledge.enabled", "启用本地知识库", null, false),
                                        s("knowledge.dir", "目录（留空 = data/knowledge）",
                                                "相对路径按运行端数据目录算。", "data/knowledge"),
                                        i("knowledge.maxResults", "最多返回片段", null, 1, 10, 1),
                                        i("knowledge.chunkChars", "切片大小（字符）", null, 200, 4000, 1),
                                        i("knowledge.overlapChars", "切片重叠（字符）", null, 0, 2000, 1))
                        }),

                // -------------------------------------------------- 8 记忆
                new Group("记忆",
                        "人物印象的整理与可见性，以及长期记忆（livingMemory）的召回与提炼。",
                        IconView.TUNE,
                        new Section[]{
                                sec("印象与整理",
                                        "条数超过阈值且距上次整理超过冷却时间后，才会在运行结束后后台整理。",
                                        b("memory.consolidateEnabled", "启用记忆自动整理", null, true),
                                        i("memory.consolidateMinIntervalMs", "整理冷却时间（分钟）",
                                                "默认 6 小时。", 30, 2880, 60000),
                                        b("memory.handoffEnabled", "允许模型自动写「会话交接」",
                                                "下次唤醒时带上。", true),
                                        b("memory.useChatModel", "使用与聊天机器人相同的模型",
                                                "关掉后要另选一个专用模型（见下一节的 provider / model）。", true),
                                        i("memory.maxImpressionsPerPerson", "每人最多保留印象（条）",
                                                "5–200；控制台手写的印象永远保留，不会被这个上限删掉。", 5, 200, 1),
                                        i("memory.impressionRetentionDays", "自动印象保留（天）",
                                                "0 = 不按时间过期；可设 1–3650。手写印象不受影响。", 0, 3650, 1)),
                                sec("可见性与共享",
                                        "「仅本会话」后，模型在群里只看得到这个群里观察到的印象；控制台人物记忆页仍可查全部。",
                                        e("memory.visibility.mode", "记忆可见性", null,
                                                arr("global", "perChat"),
                                                arr("全局（默认）：所有会话的印象都注入",
                                                        "仅本会话：只注入来源含当前会话的印象")),
                                        b("memory.visibility.hidePrivateInGroup", "群聊里隐藏「私聊来源」的印象", null, false),
                                        b("memory.privateSharedContext", "所有私聊共用最近消息与交接",
                                                "打开后不同好友的上下文会混在一起、更费 token，也可能把 A 的话带到 B。", false),
                                        b("memory.crossScopeSharedContext", "群聊与私聊共用最近上下文",
                                                "隐私边界最大、也更费 token。打开这个后上面的「所有私聊共用」已被包含。", false)),
                                sec("长期记忆（livingMemory）",
                                        "关闭后不写入、不召回；影子模式先记录召回结果，确认质量后再改成注入。",
                                        b("livingMemory.enabled", "启用长期记忆", null, false),
                                        e("livingMemory.mode", "运行模式", null,
                                                arr("shadow", "active"),
                                                arr("影子：只记录，不注入", "注入：回复前召回")),
                                        i("livingMemory.maxRecallItems", "每轮最多召回（条）", null, 1, 16, 1),
                                        i("livingMemory.maxInjectChars", "注入上限（字符）", null, 300, 8000, 1),
                                        i("livingMemory.recallTimeoutMs", "召回等待上限（毫秒）",
                                                "超时就当没召回，不拖慢回复。", 300, 5000, 1),
                                        i("livingMemory.captureMinMessages", "自动总结阈值（回合）", null, 2, 60, 1),
                                        b("livingMemory.shadowSemantic", "影子模式也跑语义召回",
                                                "会调用 Embedding，关掉可省成本。", false),
                                        b("livingMemory.allowPrivate", "允许私聊自动记忆",
                                                "默认只记群聊，避免把私聊内容带进其他会话。", false),
                                        b("livingMemory.allowGlobal", "允许管理员全局知识",
                                                "新增 owner-global 范围，只给管理员本人使用。", false),
                                        i("livingMemory.turnRetentionDays", "来源回合保留（天）", null, 1, 365, 1),
                                        list("livingMemory.groups", "启用的群号（留空 = 所有群）",
                                                "一行一个群号，不带 group: 前缀。", "123456")),
                                sec("情节记忆与主动回忆",
                                        "「情节记忆」按天把发生过的事记成事件（不是人物印象）；「主动回忆」在回复前抽查几条相关往事。"
                                                + "两者都吃 token 与数据库，先小规模观察再放大。",
                                        s("memory.provider", "专用记忆模型的提供商",
                                                "关掉上面的「使用与聊天相同的模型」才生效。留空 = 沿用主模型。", null),
                                        s("memory.model", "专用记忆模型 id",
                                                "例如 deepseek-v4-flash。只影响记忆整理，不影响聊天。", null),
                                        b("memory.episodic.enabled", "启用情节记忆（按天的「发生过什么」）",
                                                "关闭只影响情节记忆，人物印象照常。", false),
                                        i("memory.episodic.minNewMessages", "至少积累多少条新消息才整理一次",
                                                "太小会频繁调用模型，太大事件会漏。", 1, 500, 1),
                                        i("memory.episodic.windowMaxMessages", "整理窗口最多取多少条消息",
                                                "单次整理的输入上限。", 10, 2000, 1),
                                        i("memory.episodic.retentionDays", "情节事件保留天数",
                                                "超期的事件会被清理；0 视作不清理。", 0, 3650, 1),
                                        i("memory.episodic.injectMaxItems", "每轮最多注入几件往事",
                                                "默认很少；调大会明显占用上下文，也更费 token。", 0, 20, 1),
                                        i("memory.episodic.injectMaxChars", "注入往事的字符上限",
                                                "和上一项一起夹住注入体积。", 0, 4000, 1),
                                        b("memory.proactiveRecall.enabled", "回复前主动回忆相关往事",
                                                "与情节记忆配合；关掉后只在被问到时才查。", false),
                                        i("memory.proactiveRecall.maxPeople", "一次最多回忆几个人",
                                                "只在群聊里多人同时在场时才用得上。", 0, 20, 1),
                                        i("memory.proactiveRecall.maxItemsPerPerson", "每个人最多几条",
                                                "每个在场的人最多带几条往事；和上一项一起夹住总量。", 0, 20, 1),
                                        i("memory.proactiveRecall.maxChars", "主动回忆的字符上限",
                                                "超了就截断，避免抢走正文的上下文预算。", 0, 8000, 1))
                        }),

                // -------------------------------------------------- 9 提醒
                new Group("提醒",
                        "群友说「明天 9 点提醒我交作业」时把提醒落盘，到点用自己的口吻说出来。",
                        IconView.DOT,
                        new Section[]{
                                sec("开关",
                                        "限制（运行端写死，面板不提供）：单条 ≤200 字、最多设到 30 天后、单会话待触发 10 条 / 全局 50 条、离线导致迟到超 12 小时作废不补发。",
                                        b("reminders.enabled", "启用定时提醒",
                                                "关掉后不再接受新提醒、到点也不派发；已存数据保留，重新打开继续用。", true))
                        }),

                // -------------------------------------------------- 10 心情引擎
                new Group("心情引擎",
                        "三源驱动的心情（事件 / 亲密度 / 钟点），会直接约束「这一轮最多说几句」与语气。",
                        IconView.DOT,
                        new Section[]{
                                sec("开关",
                                        "关掉后提示词里不再出现「你此刻的状态」整段，行为与未启用时逐字一致。",
                                        b("moodEngine.enabled", "启用心情引擎", null, true),
                                        b("moodEngine.perChat", "每个群/私聊各记一份心情",
                                                "⚠ 这一项在运行端源码里没有任何代码读取（配置里存在但未接线），改了不会有可见效果。", true),
                                        b("moodEngine.affectParticipation", "心情影响参与意愿",
                                                "⚠ 同样未被代码读取：实际生效的是 mood-engine 内部写死的疲惫/烦躁降权系数。", true))
                        }),

                // -------------------------------------------------- 11 戳一戳
                new Group("戳一戳",
                        "被拍时直接反拍回去（不经过模型）—— 省钱也防刷屏，因为不会触发一轮完整推理。",
                        IconView.DOT,
                        new Section[]{
                                sec("反拍",
                                        "只处理「拍的是机器人」的 poke 事件；反拍失败会退回给模型照常处理，不会让消息被吞掉。",
                                        b("pokeAuto.enabled", "被拍一次就反拍回去",
                                                "默认开。关掉后拍一拍走「回复行为」里的 pokeReplyEnabled。", true),
                                        i("pokeAuto.cooldownMs", "同一会话反拍冷却（秒）",
                                                "冷却期内只反拍一次，一群人连拍不会变成机器人疯狂反拍。0 = 不冷却。", 0, 3600, 1000),
                                        b("pokeAuto.groups", "群聊里生效", null, true),
                                        b("pokeAuto.privateChat", "私聊里生效", null, true))
                        }),

                // -------------------------------------------------- 12 消息类型
                new Group("消息类型",
                        "按类型决定机器人读不读这类内容。关掉只是不让内容进提示词/不进模型，相关工具会从工具表里摘掉。",
                        IconView.IMAGE,
                        new Section[]{
                                sec("入站内容",
                                        "这些开关叠加在「模型能不能看图」之上：模型本身不支持图片时，开了也没意义。",
                                        b("messageTypes.expandForward", "自动展开合并转发 / 聊天记录卡片",
                                                "关掉后正文只留一行占位符；被 @ 的那条仍然自动展开。", true),
                                        b("messageTypes.videoFrames", "查看视频画面（抽 4 帧拼 2×2）",
                                                "关掉后视频只剩声音。", true),
                                        b("messageTypes.images", "查看消息里的图片与表情包",
                                                "关掉后提示词改成「看不到图片内容」；不影响表情包的自动收藏。", true),
                                        b("messageTypes.stickers", "查看表情库里没备注的图",
                                                "按备注名发送表情不受影响。", true),
                                        i("messageTypes.enrichTimeoutMs", "入站富化总预算（毫秒）",
                                                "解析引用/@昵称/合并转发的总预算，200–15000。超时按占位符落库。", 200, 15000, 1))
                        }),

                // -------------------------------------------------- 13 插件与 MCP
                new Group("插件与 MCP",
                        "第三方插件进程的资源/网络边界，以及 MCP 总开关。",
                        IconView.TUNE,
                        new Section[]{
                                sec("插件",
                                        "总开关关着 = 一个插件都不加载；装上 ≠ 授权，授权是下面这份显式清单。",
                                        b("plugins.enabled", "启用插件功能", null, false),
                                        list("plugins.enabledIds", "允许运行的插件 id",
                                                "一行一个 id；空 = 一个都不跑。清单之外的插件即使装了也不会加载。",
                                                "bilibili"),
                                        b("plugins.lazy", "空闲时卸载插件",
                                                "默认开，省内存。", true),
                                        i("plugins.idleMinutes", "空闲多久后卸载（分钟）", null, 1, 1440, 1),
                                        e("plugins.toolMounting", "插件工具怎么交给模型",
                                                "meta 只挂一个 plugin_call（省提示词）；direct 是每个工具各挂一个（老行为）。",
                                                arr("meta", "direct"),
                                                arr("meta：只挂 plugin_call", "direct：每个工具各挂一个"))),
                                sec("资源与网络边界",
                                        "内存上限是 V8 堆上限，不是 RSS；两个网络隔离项都只影响插件进程。Windows / macOS 没有网络命名空间，打开「要求网络隔离」等于禁用全部插件。",
                                        i("plugins.limits.memoryMb", "单个插件内存上限（MB）", null, 32, 1024, 1),
                                        i("plugins.limits.callsPerMinute", "单个插件每分钟最多调用（次）", null, 10, 1000, 1),
                                        i("plugins.limits.concurrency", "单个插件并发调用上限", null, 1, 32, 1),
                                        i("plugins.limits.diskMb", "插件数据磁盘上限（MB）", null, 8, 4096, 1),
                                        i("plugins.limits.totalMemoryMb", "全部插件总内存上限（MB，0=不限）",
                                                "按运行中插件 RSS 总和算；Linux 才有可靠读数。", 0, 8192, 1),
                                        b("plugins.networkIsolation", "能隔离就把插件放进无网络命名空间",
                                                "联网只能走宿主代理。", true),
                                        b("plugins.requireNetworkIsolation", "要求网络隔离，做不到就拒绝加载",
                                                "在 Windows / macOS 上等于禁用全部插件。", false)),
                                sec("MCP",
                                        "手机端只给总开关：server 列表里有命令、环境变量与令牌，不允许在这里编辑（要在控制台或配置文件里改）。",
                                        b("mcp.enabled", "启用 MCP", null, false))
                        }),

                // -------------------------------------------------- 14 内容审核
                new Group("内容审核",
                        "群管理动作（禁言 / 踢人 / 撤回 / 设管理员）：只对全局管理员开放，且必须是本批次最后一条发言。",
                        IconView.CHECK,
                        new Section[]{
                                sec("群管理工具",
                                        "关掉总开关或某一项后，对应工具会从模型的工具表里摘除，模型看不到也不会调用。不能对自己或管理员执行。",
                                        b("moderation.enabled", "允许群管理工具", null, true),
                                        b("moderation.actions.ban", "禁言 / 解禁", null, true),
                                        b("moderation.actions.kick", "移出群", null, true),
                                        b("moderation.actions.recall", "撤回消息", null, true),
                                        b("moderation.actions.admin", "设置 / 取消管理员", null, true),
                                        list("moderation.groups", "只在哪些群生效",
                                                "一行一个群号；留空 = 所有允许的群。", "433397830"))
                        }),

                // -------------------------------------------------- 15 模型与接口
                new Group("模型与接口",
                        "接口地址、模型与预算设置；Key 请在「模型与 Key」页修改。",
                        IconView.TUNE,
                        new Section[]{
                                sec("接口与模型",
                                        "地址和模型 id 填错会让这一轮直接报错，改完先发一条消息试试；都在运行端日志里能看到原因。",
                                        s("api.baseUrl", "接口地址（OpenAI 兼容）",
                                                "例如 https://api.deepseek.com/v1。换中转站/自建网关就改这里，"
                                                        + "地址末尾通常要带 /v1。", "https://api.deepseek.com/v1"),
                                        s("api.model", "模型 id",
                                                "例如 deepseek-v4-flash。填错会 404；改完立即生效。", "deepseek-v4-flash"),
                                        s("api.provider", "提供商 id（可选）",
                                                "多提供商目录里的选中项。一般留空 = 按地址自动判断；不知道就别填。", null),
                                        d("api.temperature", "随机性（temperature）",
                                                "0~2，越大越发散。默认 0.8；群聊陪聊建议 0.7~1.0，太大会胡说。", 0, 2, 1),
                                        i("api.maxRounds", "一轮最多调用工具几次",
                                                "默认 12。调大更能扛多步工具链，也更容易烧钱；调小可能话没说完就断。", 1, 50, 1),
                                        i("api.maxRunTokens", "单轮输出 token 上限",
                                                "默认 160000。超了会被截断（回复突然断在半句就是它）。", 256, 2000000, 1),
                                        i("api.contextWindowTokens", "上下文窗口（token）",
                                                "默认 1000000。填得比模型真实窗口大不会报错，但历史会先被压缩。",
                                                4096, 4000000, 1),
                                        b("api.vision", "模型能看图",
                                                "默认开。模型不支持图片时关掉它，免得图片白占上下文。", true),
                                        i("api.timeoutMs", "单次请求超时（毫秒）",
                                                "默认 60000（1 分钟）。网络差就调大。", 1000, 600000, 1),
                                        i("api.runTimeoutMs", "整轮超时（毫秒）",
                                                "默认 180000（3 分钟）。包含多次工具调用。", 10000, 3600000, 1),
                                        b("api.fallback.enabled", "主模型失败时切备用模型",
                                                "默认关。备用接口与模型在下面两项。", false),
                                        s("api.fallback.baseUrl", "备用接口地址",
                                                "留空 = 沿用主接口地址。", null),
                                        s("api.fallback.model", "备用模型 id",
                                                "主模型报错（限流/宕机）时用它。留空 = 不切。", null),
                                        b("api.fallbackToCurrentModel", "价格表查不到当前模型时按当前模型估价",
                                                "默认开。关掉会让成本显示变成 0（不是省钱，只是不显示）。", true),
                                        b("api.budget.enabled", "启用每日预算",
                                                "默认关。按估算花费算，不是运营商账单。", false),
                                        d("api.budget.dailyYuan", "每天预算（元）",
                                                "默认 20。0 或不填 = 不限制（运行端把非正数当不限）。", 0, 100000, 1),
                                        e("api.budget.onExceed", "超预算后怎么办",
                                                "「降级」= 只在被 @ 时回（默认）；「封锁」= 到第二天前完全不运行。",
                                                arr("degrade", "block"),
                                                arr("降级：只回应 @", "封锁：不再运行")),
                                        b("api.budget.notify", "超预算时提示一句",
                                                "默认开。", true)),
                                sec("成本与预算",
                                        "成本显示只是估算：单价来自官方价目表或你手填的兜底价。这几项只影响「花了多少钱」的估算，不影响模型行为。",
                                        e("api.costMode", "计价方式",
                                                "官方价（默认）/ 按官方价乘折扣 / 按月付。选错只会让成本显示不准。",
                                                arr("official", "multiplier", "subscription"),
                                                arr("官方价", "官方价 × 折扣", "按月付（订阅制）")),
                                        b("api.useOfficialPrice", "用官方价目表估价",
                                                "默认开。关掉后改用下面的兜底单价（适合自建/中转站）。", true),
                                        d("api.priceInputPerM", "兜底输入单价（元/百万 token）",
                                                "只有关掉官方价时才用。默认 0。", 0, 100000, 1),
                                        d("api.priceOutputPerM", "兜底输出单价（元/百万 token）",
                                                "只有关掉官方价时才用。默认 0。", 0, 100000, 1),
                                        d("api.priceCachedPerM", "兜底命中缓存单价（元/百万 token）",
                                                "只有关掉官方价时才用。默认 0。", 0, 100000, 1),
                                        s("api.priceRemoteUrl", "远程价目表地址（可选）",
                                                "留空 = 只用运行端内置的价目表。填了会去拉一份 JSON。", null),
                                        d("api.costMultiplier", "计价折扣系数",
                                                "「按官方价 × 折扣」模式下生效：0.5 = 按半价估。默认 1。", 0.01, 100, 1),
                                        d("api.costMonthlyFee", "月费（元）",
                                                "「按月付」模式下把所有调用都折算成这个月费。默认 0。", 0, 100000, 1))
                        }),

                // -------------------------------------------------- 16 平台行为（QQ 侧）
                new Group("平台行为（QQ 侧）",
                        "机器人能对 QQ 做哪些「动作」：贴表情、改资料、发文件、看相册。"
                                + "关掉一项就少一份被风控/被举报的风险，但也少一点「像真人」。",
                        IconView.CHECK,
                        new Section[]{
                                sec("消息与互动",
                                        "这几个是纯 QQ 侧能力，跟模型能力无关；关掉后对应工具直接从工具表里消失。",
                                        b("platform.reactions", "允许贴「表情回应」",
                                                "给别人的消息贴 👍 这类回应（不是发表情包）。默认开。", true),
                                        b("platform.reactionsWrite", "把贴过的回应写进本地库",
                                                "关掉仍能贴，只是不记录（少占磁盘）。默认开。", true),
                                        b("platform.qqVoice", "允许收发 QQ 语音",
                                                "需要「语音（ASR / TTS）」配好；关掉后语音消息只当文件。", true),
                                        s("platform.qqVoiceCharacter", "语音音色 id",
                                                "NapCat 侧的语音角色 id。留空 = 默认音色；乱填会导致发语音失败。", null),
                                        b("platform.readReceipts", "发已读回执",
                                                "让对方看到「已读」。默认关：开了更像真人，也更容易让人发现是机器人。", false),
                                        b("platform.forwardCards", "允许发合并转发 / 聊天记录卡片",
                                                "默认开。关掉后只能一条条发。", true)),
                                sec("资料与说说",
                                        "改资料、改备注、换头像是风控最敏感的一类动作，默认全部偏保守。",
                                        b("platform.profileWrites", "允许改自己的资料（签名等）", "默认开。", true),
                                        b("platform.remarkWrites", "允许给好友 / 群改备注", "默认开。", true),
                                        b("platform.avatarWrites", "允许换头像", "默认关。频繁换头像容易被判异常。", false),
                                        b("platform.nicknameWrites", "允许改昵称", "默认关。", false),
                                        b("platform.albumRead", "允许看说说相册 / 图片", "默认开。", true),
                                        b("platform.albumWrites", "允许往说说相册写内容", "默认开。", true),
                                        b("platform.albumUpload", "允许上传图片到相册", "默认关。", false)),
                                sec("文件与群工具",
                                        null,
                                        b("platform.groupTools", "群工具总闸", "群公告 / 群文件 / 群管理这类群侧工具。默认开。", true),
                                        b("platform.groupWrites", "允许改群设置", "改群名、群公告等写操作。默认开。", true),
                                        b("platform.groupFiles", "允许读群文件列表 / 下载", "默认开。", true),
                                        b("platform.groupFileSend", "允许往群里发文件", "默认开。", true),
                                        b("platform.privateFileSend", "允许私聊发文件", "默认关。", false),
                                        i("platform.privateFileMaxKiB", "私聊单文件大小上限（KiB）",
                                                "默认 64 KiB。填太大 QQ 侧也会拒；按需放宽。", 1, 102400, 1),
                                        b("platform.ocr", "允许对图片做文字识别",
                                                "把图里的字读出来给模型。默认开；关掉后图片只能看（模型支持的话）。", true)),
                                sec("每小时 / 每天配额",
                                        "所有写动作都按这几个数限频。设成 0 通常等于「这条路径全禁」，不是「不限」—— 宁小勿大可先小后调。",
                                        i("platform.quotas.reactionsPerHour", "每小时最多贴几次表情回应", "默认 10。", 0, 1000, 1),
                                        i("platform.quotas.profilePerDay", "每天最多改几次资料", "默认 1。", 0, 100, 1),
                                        i("platform.quotas.remarksPerDay", "每天最多改几次备注", "默认 1。", 0, 100, 1),
                                        i("platform.quotas.avatarsPerWeek", "每周最多换几次头像", "默认 1。", 0, 100, 1),
                                        i("platform.quotas.albumWritesPerHour", "每小时最多写几次说说", "默认 5。", 0, 1000, 1),
                                        i("platform.quotas.privateFilesPerDay", "每天最多私聊发几个文件", "默认 10。", 0, 1000, 1))
                        }),

                // -------------------------------------------------- 17 日报与动态
                new Group("日报与动态",
                        "定时说说、群日报、管理简报与动态互动。",
                        IconView.DOT,
                        new Section[]{
                                sec("每日动态（说说）",
                                        "到点把这一天群里的见闻写成一条说说。hour / minute 是本地时区的 24 小时制；"
                                                + "「自动发布」关着就只生成草稿，要去控制台手动发。",
                                        b("dailyMoments.enabled", "启用每日动态",
                                                "默认关。开了还要定时间、并且最好先开着「只生成草稿」看质量。", false),
                                        e("dailyMoments.source", "素材来源",
                                                "只用自己的观察（默认）/ 只读指定群 / 两者混着用。",
                                                arr("self", "group", "mixed"),
                                                arr("自己的观察（默认）", "只读群聊素材", "两者混合")),
                                        b("dailyMoments.useLifeFeed", "允许用「见闻」抓来的素材",
                                                "默认关。开了内容更丰富，但可能引到外部信息（有编造风险，运行端会过滤）。", false),
                                        i("dailyMoments.hour", "几点发（小时，0~23）",
                                                "默认 23 点。24 小时制。", 0, 23, 1),
                                        i("dailyMoments.minute", "几分发（0~59）", "默认 30 分。", 0, 59, 1),
                                        i("dailyMoments.intervalDays", "每几天发一条（天）",
                                                "默认 1 = 每天。2 = 隔天。", 1, 30, 1),
                                        b("dailyMoments.startupCatchup", "启动时补发错过的那一条",
                                                "默认开。关掉后，App 重启错过的时间点就不再补。", true),
                                        i("dailyMoments.minMessagesPerGroup", "每个群至少有多少条才配当素材",
                                                "默认 3。冷群会被跳过，避免写出空话。", 0, 1000, 1),
                                        i("dailyMoments.maxGroups", "最多读几个群", "默认 12。", 1, 200, 1),
                                        i("dailyMoments.maxMessagesPerGroup", "每个群最多读多少条消息",
                                                "默认 80。调大更全面也更费 token。", 1, 2000, 1),
                                        i("dailyMoments.maxPromptChars", "拼给模型的总字符上限",
                                                "默认 120000。超了就截断最早的消息。", 1000, 1000000, 1),
                                        b("dailyMoments.allowImages", "允许配图", "默认开。", true),
                                        i("dailyMoments.maxImages", "一条最多几张图", "默认 1。", 0, 9, 1),
                                        b("dailyMoments.autoPublish", "到点自动发布（关 = 只生成草稿）",
                                                "默认关。第一次用建议先看草稿质量再打开。", false),
                                        e("dailyMoments.visibility", "说说可见范围",
                                                "默认「好友」。选「仅自己」等于只存档不发出去。",
                                                arr("1", "4", "64"),
                                                arr("所有人", "好友（默认）", "仅自己")),
                                        list("dailyMoments.targetUins", "指定发给谁（可选）",
                                                "一行一个 QQ/群号 uin。留空 = 按上面的素材来源与可见范围走。", null),
                                        i("dailyMoments.maxResearchCalls", "一次最多联网查几次",
                                                "默认 4。要配好「Web 搜索」才有用；0 = 不让它查。", 0, 20, 1),
                                        i("dailyMoments.maxRounds", "一次最多跑几轮",
                                                "默认 8。多轮能写得更细，也更费钱。", 1, 30, 1)),
                                sec("群日报 / 管理简报",
                                        "time 用 24 小时制 HH:MM（例如 09:30），不是滑块。"
                                                + "「群日报」发到群里，「管理简报」发给管理员本人。",
                                        b("groupDigest.enabled", "启用群日报",
                                                "默认关。开了要确认下面的群号清单不为空，否则不会发到任何地方。", false),
                                        s("groupDigest.time", "每天几点发（HH:MM）",
                                                "24 小时制，默认 09:30。格式必须是 09:30 这样，写错运行端会退回默认。", "09:30"),
                                        i("groupDigest.maxChars", "日报最大字数", "默认 300。", 50, 4000, 1),
                                        list("groupDigest.chats", "发到哪些群",
                                                "一行一个群号。留空 = 所有允许的群。", "1054041195"),
                                        b("adminBriefing.enabled", "启用管理简报",
                                                "默认关。不开它也会在异常时走「事件报告」那条链路。", false),
                                        s("adminBriefing.time", "每天几点发（HH:MM）",
                                                "24 小时制，默认 09:30。", "09:30"),
                                        i("adminBriefing.maxChars", "简报最大字数", "默认 300。", 50, 4000, 1),
                                        list("adminBriefing.chats", "简报目标（群号 / QQ）",
                                                "一行一个。留空 = 只发给管理员本人。", null)),
                                sec("朋友圈互动（有风险）",
                                        "⚠ 自动点赞/评论他人说说，高频有风控风险，默认关闭。",
                                        b("qzoneInteractions.enabled", "允许它去互动别人的说说",
                                                "默认关。这是本面板里风险最高的一项，先在测试号上观察。", false),
                                        b("qzoneInteractions.allowLikes", "允许点赞", "默认开（但总闸关着）。", true),
                                        b("qzoneInteractions.allowComments", "允许评论", "默认开（总闸关着时无效）。", true),
                                        b("qzoneInteractions.allowReplies", "允许回复别人对它的评论", "默认开。", true),
                                        i("qzoneInteractions.maxLikesPerRun", "一次最多点几个赞", "默认 3。", 0, 50, 1),
                                        i("qzoneInteractions.maxCommentsPerRun", "一次最多评论几条", "默认 2。", 0, 50, 1),
                                        i("qzoneInteractions.maxRepliesPerRun", "一次最多回复几条", "默认 5。", 0, 50, 1),
                                        i("qzoneInteractions.feedIntervalMinutes", "刷说说的间隔（分钟）",
                                                "默认 60。调小会更频繁地看动态。", 1, 1440, 1),
                                        i("qzoneInteractions.replyIntervalMinutes", "查回复的间隔（分钟）",
                                                "默认 5。", 1, 1440, 1),
                                        i("qzoneInteractions.feedFetchCount", "每次拉多少条说说",
                                                "默认 30。", 1, 200, 1),
                                        i("qzoneInteractions.ownPostCount", "读自己多少条说说当上下文",
                                                "默认 10。", 0, 100, 1),
                                        i("qzoneInteractions.maxAgeHours", "只互动多少小时内的说说",
                                                "默认 72（3 天）。太久以前的说说别去翻。", 1, 720, 1),
                                        i("qzoneInteractions.maxBatchItems", "一次处理多少条候选",
                                                "默认 20。", 1, 200, 1),
                                        i("qzoneInteractions.commentMaxChars", "评论字数上限", "默认 60。", 1, 500, 1),
                                        i("qzoneInteractions.replyMaxChars", "回复字数上限", "默认 60。", 1, 500, 1),
                                        i("qzoneInteractions.actionDelayMinMs", "动作之间最短间隔（毫秒）",
                                                "默认 700。太短像脚本。", 0, 60000, 1),
                                        i("qzoneInteractions.actionDelayMaxMs", "动作之间最长间隔（毫秒）",
                                                "默认 1800。两者之间随机取。", 0, 60000, 1),
                                        i("qzoneInteractions.maxDecisionRounds", "一次决策最多让模型想几轮",
                                                "默认 3。", 1, 10, 1),
                                        b("qzoneInteractions.startupCatchup", "启动时补看错过的动态",
                                                "默认关。开了启动那一刻可能连点一串赞。", false)),
                                sec("见闻（lifeFeed）",
                                        "从 RSS / 网页抓「有趣的事」讲给群里听，也喂给每日动态。"
                                                + "抓取源用下面的 rssUrls；「只允许手动分享」时模型不会自己发。",
                                        b("lifeFeed.enabled", "启用见闻",
                                                "默认关。打开后它会定时联网抓内容 —— 需要能联网，且会产生抓取流量。", false),
                                        e("lifeFeed.shareMode", "分享方式",
                                                "自动 = 主动轮次里它可以自己决定分享（默认）；手动 = 只能从控制台触发。",
                                                arr("auto", "manual"),
                                                arr("自动（主动轮次可自己发）", "手动（只能控制台触发）")),
                                        i("lifeFeed.forageIntervalMinutes", "多久去抓一次（分钟）",
                                                "默认 360（6 小时）。", 5, 10080, 1),
                                        i("lifeFeed.maxOffersPerDay", "每天最多主动讲几次", "默认 2。", 0, 50, 1),
                                        i("lifeFeed.maxPicksPerDay", "每天最多挑出几条候选", "默认 10。", 0, 200, 1),
                                        i("lifeFeed.maxPerForage", "每次抓取最多挑几条", "默认 30。", 1, 200, 1),
                                        i("lifeFeed.maxCandidates", "候选池最多存几条", "默认 200。", 1, 2000, 1),
                                        i("lifeFeed.rssPerForage", "每次最多读几个 RSS 源", "默认 10。", 1, 100, 1),
                                        i("lifeFeed.cooldownDays", "同一内容多少天内不重复讲（天）",
                                                "默认 7。", 0, 365, 1),
                                        i("lifeFeed.minDurationSec", "只看多长的内容（时长下限，秒）",
                                                "默认 60。只对带时长来源（视频/播客）有效。", 0, 86400, 1),
                                        i("lifeFeed.maxDurationSec", "时长上限（秒）",
                                                "默认 3600（1 小时）。太长的不抓。", 1, 86400, 1),
                                        list("lifeFeed.rssUrls", "RSS 源地址",
                                                "一行一个 http(s) 地址。留空 = 不用 RSS。", "https://example.com/feed.xml"),
                                        list("lifeFeed.sources", "其它抓取源（标识）",
                                                "一行一个来源标识（如 bilibili / zhihu）。不确定就别填。", null),
                                        list("lifeFeed.shareGroups", "分享到哪些会话",
                                                "一行一个「group:群号」或「private:QQ」。留空 = 不主动分享。", "group:1054041195"),
                                        list("lifeFeed.groups", "见闻只在这些群生效",
                                                "一行一个群号；留空 = 所有允许的群。", null),
                                        list("lifeFeed.extraKeywords", "额外感兴趣的关键词",
                                                "一行一个。命中就更容易被挑中。", "航天"),
                                        list("lifeFeed.excludeKeywords", "排除关键词",
                                                "一行一个。命中直接丢弃（避雷用）。", "娱乐八卦"),
                                        b("lifeFeed.graduated", "试验期结束标记（别动）",
                                                "运行端用它标记「这个功能已经转正」，手改会让新旧配置迁移走另一条分支。", false))
                        }),

                // -------------------------------------------------- 18 语音（ASR / TTS）
                new Group("语音（ASR / TTS）",
                        "语音转文字与语音合成的服务、模型及音色设置。",
                        IconView.MUSIC,
                        new Section[]{
                                sec("语音转文字（ASR）",
                                        "群里有人发语音、模型想看内容时才会用。provider 选 local 就是本机 whisper（零 Key，但要装模型文件）。",
                                        b("asr.enabled", "启用语音转文字", "默认开。关掉后语音只按「[语音]」占位。", true),
                                        e("asr.provider", "用哪家做转写",
                                                "openai（兼容接口，默认）/ volc·aliyun·baidu·tencent·iflytek（各家官方接口）/ local（本机 whisper）。",
                                                arr("openai", "volc", "aliyun", "baidu", "tencent", "iflytek", "local"),
                                                arr("OpenAI 兼容", "火山引擎", "阿里云", "百度", "腾讯", "讯飞", "本机 whisper")),
                                        s("asr.baseUrl", "接口地址",
                                                "openai 兼容网关的地址，例如 https://api.siliconflow.cn/v1。选 local 时不用填。",
                                                "https://api.siliconflow.cn/v1"),
                                        s("asr.model", "模型 id",
                                                "例如 FunAudioLLM/SenseVoiceSmall。留空 = 用该家的默认模型。", null),
                                        s("asr.language", "语言（可选）",
                                                "例如 zh / en。留空 = 自动判断（有的供应商不支持自动）。", "zh"),
                                        s("asr.appId", "应用 AppID（部分供应商要）",
                                                "火山/讯飞这类要 appId 的才填；OpenAI 兼容不用。", null),
                                        i("asr.maxPerHour", "每小时最多转写几次",
                                                "默认 12。防有人连发语音把额度刷光。", 0, 1000, 1),
                                        i("asr.maxPerHourPerChat", "每个会话每小时最多几次", "默认 4。", 0, 1000, 1),
                                        s("asr.localBin", "本机 whisper 可执行文件（local 用）",
                                                "留空 = 从 PATH 里找 whisper-cli / whisper-cpp / main。", null),
                                        s("asr.localModel", "本机 whisper 模型文件路径（local 用）",
                                                "例如 /data/asr/ggml-base.bin。留空 = 找标准位置里的 ggml-*.bin。", null)),
                                sec("语音合成（TTS）",
                                        "模型主动发语音时用。provider 决定走哪套接口；speed / gain 是音色微调。"
                                                + "手机上听不到没关系，发出去的是语音文件。",
                                        b("tts.enabled", "启用语音合成", "默认关。开了还要在「拟人化·小动作」里放行发语音。", false),
                                        e("tts.provider", "用哪家做合成",
                                                "openai 兼容 / 火山（volc、volcengine）/ 豆包 / MiniMax / 小米。",
                                                arr("openai", "volc", "volcengine", "doubao", "minimax", "mimo"),
                                                arr("OpenAI 兼容", "火山引擎", "火山引擎（同义）", "豆包语音 2.0", "MiniMax", "小米")),
                                        s("tts.baseUrl", "接口地址",
                                                "留空 = 用该供应商的默认地址。", null),
                                        s("tts.model", "模型 id", "例如 tts-1。留空 = 默认模型。", null),
                                        s("tts.voice", "音色 id",
                                                "各家的音色名（例如 alloy / zh_female_xxx）。填错会合成失败。", null),
                                        s("tts.format", "输出格式",
                                                "默认 mp3。常见还可填 wav / ogg / pcm，具体看供应商支持。", "mp3"),
                                        d("tts.speed", "语速倍率",
                                                "1 = 原速（默认）。0.5 慢一半，2 快一倍；太极端会被供应商截断。", 0.5, 2, 1),
                                        d("tts.gain", "音量增益（dB）",
                                                "默认 0。正数更大声，负数更小；超过 ±10 容易削波。", -20, 20, 1),
                                        i("tts.timeoutMs", "合成超时（毫秒）",
                                                "默认 30000。超时就当这次不发语音。", 1000, 120000, 1),
                                        s("tts.appId", "应用 AppID（火山等要）", "只有火山/豆包这类要 appId 的才填。", null),
                                        s("tts.cluster", "集群 cluster（火山要）", "火山语音的集群名，例如 volcano_tts。", null),
                                        s("tts.resourceId", "资源 id（火山要）", "例如 seed-tts-1.0。", null),
                                        s("tts.groupId", "groupId（MiniMax 要）", "MiniMax 语音的 groupId。", null),
                                        s("tts.director", "导演提示（可选）",
                                                "给合成器的风格提示词（部分供应商支持），例如「温柔一点、语速偏慢」。", null))
                        }),

                // -------------------------------------------------- 19 协议端连接
                new Group("协议端连接",
                        "运行端连接协议端的地址与心跳，修改后需重启运行端。",
                        IconView.PLAY,
                        new Section[]{
                                sec("地址与心跳",
                                        "两个地址都指向协议端：wsUrl 走 WebSocket（收消息），httpUrl 走 HTTP（调接口）。"
                                                + "手机上一个 App 同时跑协议端与运行端时，通常是 127.0.0.1。",
                                        s("onebot.wsUrl", "WebSocket 地址",
                                                "例如 ws://127.0.0.1:3001。改完重启运行端；改动期间消息会丢。",
                                                "ws://127.0.0.1:3001"),
                                        s("onebot.httpUrl", "HTTP 接口地址",
                                                "例如 http://127.0.0.1:3000。改完重启运行端。", "http://127.0.0.1:3000"),
                                        s("onebot.wsHeartbeat", "心跳间隔",
                                                "填 auto = 由协议端协商（默认）；也可填毫秒数（字符串）。填错会导致连接反复重连。", "auto"),
                                        i("onebot.catchupReplyWindowMs", "断线补收窗口（分钟）",
                                                "默认 30 分钟：重连后只补这段时间内、机器人被 @/引用过的旧消息。调大更连贯也更费钱。",
                                                0, 1440, 60000),
                                        i("onebot.catchupHistoryCount", "重连时最多补看多少条历史",
                                                "默认 100。", 0, 1000, 1),
                                        i("onebot.textTimeoutMs", "单条动作超时（毫秒）",
                                                "单次 OneBot 动作超时（毫秒），默认 120000；勿调过小。",
                                                5000, 600000, 1000))
                        }),

                // -------------------------------------------------- 20 Web 搜索
                new Group("Web 搜索",
                        "联网搜索引擎、返回条数与多源聚合设置。",
                        IconView.TV,
                        new Section[]{
                                sec("总开关与默认引擎",
                                        "需配置对应引擎 Key，未配时回退网页抓取。",
                                        b("webSearch.enabled", "启用联网搜索", "默认开。关掉后模型完全不能上网。", true),
                                        s("webSearch.provider", "默认搜索引擎",
                                                "默认 bing。可填 deepseek / zhipu / bocha / baidu / metaso / doubao / tavily 等"
                                                        + "（必须是已配 Key 的那家）。", "bing"),
                                        s("webSearch.searchUrl", "无需 Key 时的搜索页地址",
                                                "默认 https://cn.bing.com/search。它只抓搜索结果页，质量比 API 差。",
                                                "https://cn.bing.com/search"),
                                        i("webSearch.maxResults", "每次默认返回几条", "默认 6。条数越多越费 token。", 1, 20, 1),
                                        list("webSearch.smart.order", "智能搜索的引擎优先级（可选）",
                                                "一行一个引擎名，按顺序尝试。留空 = 用运行端内置顺序。", "bing"),
                                        i("webSearch.aggregate.count", "聚合模式每源取几条", "默认 4。", 1, 20, 1),
                                        list("webSearch.aggregate.sources", "聚合模式用哪些源",
                                                "一行一个引擎名。留空 = 不聚合（只用一个引擎）。", "bing")),
                                sec("各引擎条数 / 型号",
                                        "这些只在对应引擎被选中时生效。条数越大越费 token；型号填错会报错退回默认。",
                                        s("webSearch.deepseek.model", "DeepSeek 搜索模型",
                                                "默认 deepseek-v4-flash。", "deepseek-v4-flash"),
                                        i("webSearch.deepseek.count", "DeepSeek 每次几条", "默认 10。", 1, 30, 1),
                                        s("webSearch.zhipu.engine", "智谱搜索档位",
                                                "默认 search_std；也可 search_pro 这类档位（按账号权限）。", "search_std"),
                                        i("webSearch.zhipu.count", "智谱每次几条", "默认 10。", 1, 30, 1),
                                        i("webSearch.bocha.count", "博查每次几条", "默认 10。", 1, 30, 1),
                                        i("webSearch.baidu.count", "百度每次几条", "默认 6。", 1, 30, 1),
                                        i("webSearch.metaso.count", "秘塔每次几条", "默认 6。", 1, 30, 1),
                                        i("webSearch.doubao.count", "豆包每次几条", "默认 6。", 1, 30, 1),
                                        i("webSearch.tavily.count", "Tavily 每次几条", "默认 5。", 1, 30, 1),
                                        s("webSearch.tavily.searchDepth", "Tavily 搜索深度",
                                                "默认 basic（便宜快）；advanced 更全但更慢更贵。", "basic"))
                        }),

                // -------------------------------------------------- 21 试点功能
                new Group("试点功能",
                        "还在试跑的三条链路：加好友、事件报告、群内黑话。默认值偏保守，关掉不影响正常聊天。",
                        IconView.DOT,
                        new Section[]{
                                sec("好友申请与好友提议",
                                        "「自动通过好友申请」要谨慎：通过后对方就能私聊它，而私聊还要过「私聊白名单」那一关。",
                                        b("identityPilot.enabled", "启用身份类试点", "总闸。关掉后下面两项都不生效。默认开。", true),
                                        b("identityPilot.incomingFriendRequest.enabled", "自动处理别人发来的好友申请",
                                                "默认开。不开的话申请会一直挂着，要人工去 QQ 处理。", true),
                                        b("identityPilot.incomingFriendRequest.autoWhitelist", "通过后自动加进私聊白名单",
                                                "默认开。⚠ 打开等于新好友可以直接私聊它。", true),
                                        i("identityPilot.incomingFriendRequest.maxPending", "最多挂多少条待处理申请",
                                                "默认 50。超了就不再处理新的。", 1, 500, 1),
                                        b("identityPilot.friendProposal.enabled", "允许它主动提议加某人为好友",
                                                "默认关。开了会由模型判断「聊得不错」再提议（不是直接加）。", false),
                                        i("identityPilot.friendProposal.minMessageCount", "至少聊过多少条才可能提议",
                                                "默认 50。调小会更早提议，也更容易打扰人。", 1, 5000, 1),
                                        i("identityPilot.friendProposal.cooldownDays", "同一人两次提议至少隔几天",
                                                "默认 30。", 0, 365, 1),
                                        i("identityPilot.friendProposal.maxPending", "最多同时挂几条约待确认",
                                                "默认 10。", 1, 100, 1),
                                        d("identityPilot.friendProposal.triggered.probability", "触发概率（%）",
                                                "默认 5%。调大更容易弹提议。", 0, 100, 0.01),
                                        i("identityPilot.friendProposal.triggered.scoreThreshold", "评分门槛（0~100）",
                                                "默认 70。它会给每个候选人打分（质量/兴趣/互惠/稳定），达到门槛才提议。", 0, 100, 1)),
                                sec("事件报告",
                                        "把运行中的异常（限流、协议端掉线、写操作失败）整理成报告，别让它们静默失败。",
                                        b("incidentPilot.enabled", "启用事件报告", "默认开。", true),
                                        b("incidentPilot.notifyWarnings", "有警告时也提示", "默认开。关掉只报错误。", true),
                                        i("incidentPilot.duplicateWindowMinutes", "同一问题多久内算重复（分钟）",
                                                "默认 10。窗口内合并成一条，防刷屏。", 0, 1440, 1),
                                        b("incidentPilot.unknownWritesBlockChat", "遇到未知的写操作失败就停聊",
                                                "默认关。打开会更安全，但一次偶发失败就可能让它不说话。", false),
                                        i("incidentPilot.retentionDays", "事件记录保留天数", "默认 90。", 1, 3650, 1)),
                                sec("群内黑话",
                                        "收集群里特有的梗与缩写，让措辞更像群友。默认关：开着会把群里的说法记下来。",
                                        b("slangPilot.enabled", "启用群内黑话收集", "默认关。想看效果先小范围开一个群。", false))
                        }),

                // -------------------------------------------------- 22 运行端更新与控制台界面
                // ★ 原则 P6（2026-11-19）：内置机器人是我们自己的产品，**不跟随上游自动升级**。
                //   但更新入口**保留**（用户要求），只是**指向我们自己的仓库**，永远不指上游。
                //   容器每次启动会把 repository 强制改回我们自己的地址（见 container-bot.mjs），
                //   所以这里改了也拉不到别处去。
                new Group("运行端更新与控制台界面",
                        "更新只从**本项目自己的仓库**拉，永远不会去作者的上游仓库。"
                                + "另一块是运行端自带网页控制台的显示项，与 QQ 聊天无关。",
                        IconView.TUNE,
                        new Section[]{
                                sec("运行端更新（只指向本项目仓库）",
                                        "这里拉的是**我们维护的内置机器人**，不是上游原版。"
                                                + "手机上升级会替换运行端文件，失败可能把运行端搞坏：升级前先备份 config.json。",
                                        b("autoUpdate.enabled", "启用自动更新", "默认关。开着也只从下面的仓库拉。", false),
                                        s("autoUpdate.repository", "仓库地址（本项目自己）",
                                                "默认指向本项目的公开仓库；容器启动时会强制写回该地址，改了也不生效。",
                                                "https://github.com/18477514055/whale-onebot.git"),
                                        s("autoUpdate.branch", "分支", "默认 main。", "main"),
                                        i("autoUpdate.intervalHours", "检查间隔（小时）", "默认 6。", 1, 720, 1),
                                        s("autoUpdate.ownerUin", "通知给哪个 QQ（可选）",
                                                "填 QQ 号，更新结果会私聊告诉它。留空 = 不通知。", null)),
                                sec("网页控制台界面",
                                        "这两项只影响浏览器里那个网页控制台（不是手机 App）。手机 App 有自己的主题设置。",
                                        b("ui.showVision", "模型目录里显示「能不能看图」徽标",
                                                "默认开。", true),
                                        i("ui.refreshMs", "控制台自动刷新间隔（毫秒）",
                                                "默认 15000（15 秒），运行端夹在 ≥1000。调小更实时，但更费流量/电。", 1000, 600000, 1))
                        })
        };
        GROUPS = visible(all);
    }

    /**
     * 用户 2026-11-18 要求先下掉的两组（实现留着，随时能放回来）：
     * <ul>
     *   <li><b>戳一戳</b>：反拍在非 hook 前提下做不到，留着是个半残功能，先删。</li>
     *   <li><b>知识库（作者实现）</b>：我们改成自己的知识库（带向量模型），作者那套不再暴露。</li>
     * </ul>
     */
    private static Group[] visible(Group[] all) {
        java.util.ArrayList<Group> out = new java.util.ArrayList<Group>();
        for (int i = 0; i < all.length; i++) {
            String title = all[i] == null ? "" : all[i].title;
            if (title == null) title = "";
            if (title.startsWith("戳一戳")) continue;
            // 「知识库」组：作者那套轻量库（knowledge.*）不再暴露，字段全部收进我们自己的
            // 「知识库」页（{@link KnowledgeScreen}），这一组只留一张入口卡。
            if (title.startsWith("知识库")) {
                out.add(new Group("知识库", null, all[i].icon, new Section[0]));
                continue;
            }
            // 「模型与接口」组：字段全部收进「模型与 Key」页（用户 2026-11-18：两处重复，合成一页）。
            // 这一组只留一张入口卡，所以把 sections 清空。
            if (title.startsWith("模型与接口")) {
                out.add(new Group(all[i].title, null, all[i].icon, new Section[0]));
                continue;
            }
            // ★ 用户 2026-11-18：「把所有非必要解释文本都去掉，先看没文字的样子，不懂再加。」
            //   列表卡上那一整段整段的组说明正是最典型的一类 —— 一律不显示（字段级说明另有
            //   HINT_MAX_CHARS 那道闸）。标题 + 项数徽标已经说清这一组是什么。
            out.add(new Group(all[i].title, null, all[i].icon, all[i].sections));
        }
        return out.toArray(new Group[0]);
    }

    /** 面板上一共能编辑多少项（用于列表页与报告）。 */
    static int totalFieldCount() {
        int n = 0;
        for (int i = 0; i < GROUPS.length; i++) n += GROUPS[i].fieldCount();
        return n;
    }
}
