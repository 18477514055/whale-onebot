package com.whaleonebot.ui;

/**
 * 设计令牌：全项目唯一的颜色 / 尺寸 / 字号真源。
 *
 * <p>概念：一块安静的仪表盘浮在暮色里。三档斜向渐变做底，玻璃卡片靠阴影抬起，
 * 全局只有一枚信号色承载所有「活着」的状态，数字与日志走等宽。
 *
 * <p>体系：
 * <ul>
 *   <li>间距 8 / 12 / 16 / 24 dp</li>
 *   <li>圆角 14 / 16 / 20 / 24 dp</li>
 *   <li>字阶 22 / 18 / 14 / 12 / 11 sp</li>
 * </ul>
 *
 * <p>字段在类初始化时写入一次，之后全项目只读。页面里不允许出现散落的硬编码色值。
 */
final class Theme {

    // ---------------------------------------------------------------- 间距

    static final int S1 = 8;
    static final int S2 = 12;
    static final int S3 = 16;
    static final int S4 = 24;

    // ---------------------------------------------------------------- 圆角

    static final int R_CARD = 24;
    static final int R_PANEL = 20;
    static final int R_BTN = 16;
    static final int R_TILE = 16;
    static final int R_PILL = 999;

    // ---------------------------------------------------------------- 字阶

    /** 页面标题 */
    static final int T_TITLE = 22;
    /** 卡片标题 */
    static final int T_CARD = 18;
    /** 正文 / 按钮 */
    static final int T_BODY = 14;
    /** 注脚 */
    static final int T_CAP = 12;
    /** 等宽日志 */
    static final int T_MONO = 11;

    /** 最小触控边长 */
    static final int TOUCH = 48;

    // ---------------------------------------------------------------- 主题

    final String id;
    final String name;
    final String desc;
    final boolean dark;

    /** 背景渐变三档（斜向） */
    int g0, g1, g2;
    /** 三级文字色 */
    int textPrimary, textSecondary, textTertiary;
    /** 玻璃卡片：填充 + 极淡描边 */
    int cardFill, cardStroke;
    /** 唯一信号色 */
    int accent, onAccent;
    /**
     * accent 的高对比变体：信号色的淡底（芯片、胶囊）上写字必须用它，
     * 直接用 accent 只有 4.2:1，过不了 AA（已按 WCAG 逐对算过）。
     */
    int toneStrong;
    /** 次级按钮（描边型） */
    int ghostFill, ghostStroke, ghostText;
    /** 自定义图片背景上的压暗层 */
    int scrimTop, scrimBottom;

    /** 二维码必须印在白纸上，扫码器才认 */
    final int qrPaper = 0xFFFFFFFF;

    /** 白纸上打印的墨色。纸永远是白的，所以它不随主题走。 */
    final int qrInk = 0xFF6E665C;

    /** 日志是终端黑，六套主题共用一块，不随主题漂移。 */
    final int logFill = 0xCC0B0F14;
    final int logStroke = 0x1FFFFFFF;
    final int logText = 0xFF9EC9C0;

    /**
     * 投影色。**不要用纯黑**：纯黑投在深色渐变上会渲染成一层灰雾，
     * 这正是「阴影很刻意」的来源。这里取渐变中段压暗后的同色系深色，
     * 并带一点 alpha，投出来只是背景的轻微加深，边缘干净。
     */
    int shadowColor = 0x59000000;

    private Theme(String id, String name, String desc, boolean dark) {
        this.id = id;
        this.name = name;
        this.desc = desc;
        this.dark = dark;

        // 兜底（各 preset 会用 ink/signal/glass 覆盖）
        textPrimary = 0xFFFFFFFF;
        textSecondary = 0xFFC9CDD2;
        textTertiary = 0xFFAFB8C0;
        toneStrong = 0xFFFFFFFF;
        ghostText = textPrimary;

        if (dark) {
            cardFill = 0x14FFFFFF;
            cardStroke = 0x2EFFFFFF;
            ghostFill = 0x1AFFFFFF;
            ghostStroke = 0x33FFFFFF;
            scrimTop = 0x5900070B;
            scrimBottom = 0xCC00070B;
        } else {
            // 浅色主题：白玻璃 + 柔阴影就够了，不画白描边（在白底上看不见，只会脏）
            cardFill = 0xD9FFFFFF;
            cardStroke = 0x00000000;
            ghostFill = 0x1A1B1714;
            ghostStroke = 0x261B1714;
            scrimTop = 0x59FFFDF8;
            scrimBottom = 0xD9FFFDF8;
        }
    }

    private Theme grad(int a, int b, int c) {
        g0 = a;
        g1 = b;
        g2 = c;
        // 投影取渐变中段压暗，带 alpha —— 同色系、只加深一点，不发灰
        shadowColor = withAlpha(mix(b, 0xFF000000, 0.55f), dark ? 0x59 : 0x4D);
        return this;
    }

    /** 通道线性插值（t=0 取 a，t=1 取 b）。令牌层保持无 Android 依赖，所以自带一份。 */
    private static int mix(int a, int b, float t) {
        float it = 1f - t;
        int aa = (a >>> 24) & 0xFF, ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
        int ba = (b >>> 24) & 0xFF, br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
        int oa = (int) (aa * it + ba * t + 0.5f);
        int or = (int) (ar * it + br * t + 0.5f);
        int og = (int) (ag * it + bg * t + 0.5f);
        int ob = (int) (ab * it + bb * t + 0.5f);
        return (oa << 24) | (or << 16) | (og << 8) | ob;
    }

    private static int withAlpha(int color, int alpha) {
        return (alpha << 24) | (color & 0x00FFFFFF);
    }

    private Theme ink(int primary, int secondary, int tertiary) {
        textPrimary = primary;
        textSecondary = secondary;
        textTertiary = tertiary;
        ghostText = primary;
        return this;
    }

    private Theme signal(int fill, int on, int strong) {
        accent = fill;
        onAccent = on;
        toneStrong = strong;
        return this;
    }

    private Theme glass(int fill, int stroke) {
        cardFill = fill;
        cardStroke = stroke;
        return this;
    }

    // ---------------------------------------------------------------- 预置主题

    static final Theme[] ALL;

    static {
        ALL = new Theme[]{
                new Theme("abyss", "深海", "冷调青蓝，最安静的一套", true)
                        .grad(0xFF0A1B26, 0xFF123A4A, 0xFF0B2430)
                        .ink(0xFFF2F8F9, 0xFFA9C2C9, 0xFFAFBFC6)
                        .signal(0xFF5FE0C4, 0xFF06231F, 0xFF93EBD8)
                        .glass(0x14FFFFFF, 0x2EFFFFFF),

                new Theme("dusk", "暮山", "紫灰压着一点暖橘", true)
                        .grad(0xFF1F1734, 0xFF43264A, 0xFF2A1A33)
                        .ink(0xFFF6F0F7, 0xFFC6B4CE, 0xFFC4B8CC)
                        .signal(0xFFFFB27C, 0xFF2A1408, 0xFFFFCFA9)
                        .glass(0x16FFFFFF, 0x30FFFFFF),

                new Theme("tundra", "苔原", "苔绿与松林，偏静", true)
                        .grad(0xFF101D17, 0xFF1D3527, 0xFF13241B)
                        .ink(0xFFF0F6F1, 0xFFB3CAB9, 0xFFA8BCAF)
                        .signal(0xFFB6E38A, 0xFF132605, 0xFFC9EEA6)
                        .glass(0x14FFFFFF, 0x2CFFFFFF),

                new Theme("ember", "琥珀", "暖褐底，夜里不刺眼", true)
                        .grad(0xFF241407, 0xFF44290F, 0xFF2E1E0B)
                        .ink(0xFFF9F1E5, 0xFFD3B697, 0xFFCBB8A5)
                        .signal(0xFFFFC46B, 0xFF2E1B05, 0xFFFFD391)
                        .glass(0x18FFFFFF, 0x33FFFFFF),

                new Theme("ink", "墨夜", "接近纯黑的极简", true)
                        .grad(0xFF07080B, 0xFF141822, 0xFF090B10)
                        .ink(0xFFEEF2F8, 0xFFA5AEC0, 0xFF949CAC)
                        .signal(0xFF8FB8FF, 0xFF08131F, 0xFFA8C6FF)
                        .glass(0x12FFFFFF, 0x2AFFFFFF),

                new Theme("dawn", "晨纸", "浅色纸感，白天看得清", false)
                        .grad(0xFFFDF7EE, 0xFFEDE4F2, 0xFFE8EEF6)
                        .ink(0xFF1B1714, 0xFF4E463F, 0xFF665D56)
                        .signal(0xFF0F766E, 0xFFFFFFFF, 0xFF0C665F)
                        .glass(0xD9FFFFFF, 0x00000000)
        };
    }

    static Theme byId(String id) {
        if (id != null) {
            for (int i = 0; i < ALL.length; i++) {
                if (ALL[i].id.equals(id)) return ALL[i];
            }
        }
        return ALL[0];
    }
}
