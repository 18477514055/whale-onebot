package com.whaleonebot.remote;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * [layer: shell-android] 纯 Java 轻量 QR Code 解码器（零 Gradle、零 GMS/MLKit 依赖，支持版本 1–40）。
 *
 * <p>针对手机拍手机屏幕（亮屏 + 暗边框 + 摩尔纹 + 倾斜 + 失焦）做专项强化：
 * <ol>
 *   <li>积分图 Bradley-Roth 大窗口自适应二值化（彻底解决亮屏/暗边框反色问题），并执行中心取景框裁剪 + 多敏感度 + Otsu 全局阈值多轮解码；</li>
 *   <li>定位块 1:1:3:1:1 水平/垂直/对角线三向交叉核验，按模块一致性与直角几何打分排序；</li>
 *   <li>对齐块水平 + 垂直双向定位中心，消除右下角透视偏移；</li>
 *   <li>单点采样 + 5 点中心多数投票回退 + BCH(15,5) 格式纠错 + GF(256) Reed-Solomon 纠错。</li>
 * </ol>
 */
public final class QrDecoder {

    /** 带诊断信息的解码结果，方便相机界面提示「已检测到轮廓，请微调距离/对焦」。 */
    public static final class DecodeResult {
        public final String text;
        public final int maxFindersSeen;

        public DecodeResult(String text, int maxFindersSeen) {
            this.text = text;
            this.maxFindersSeen = maxFindersSeen;
        }
    }

    private static final int[] FORMAT_BITS = {
            0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
            0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976,
            0x1689, 0x13BE, 0x1CE7, 0x19D0, 0x0762, 0x0255, 0x0D0C, 0x083B,
            0x355F, 0x3068, 0x3F31, 0x3A06, 0x24B4, 0x2183, 0x2EDA, 0x2BED
    };
    // format index -> (ecLevel 0=M,1=L,2=H,3=Q -> 映射到标准索引 0=L,1=M,2=Q,3=H)
    private static final int[] FORMAT_EC_MAP = {1, 0, 3, 2};

    private static final String ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

    private static final byte[][] ECC_PER_BLOCK = {
            {-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30},
            {-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28},
            {-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30},
            {-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30}
    };

    private static final byte[][] NUM_BLOCKS = {
            {-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25},
            {-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49},
            {-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68},
            {-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81}
    };

    private static final int[] GF_EXP = new int[512];
    private static final int[] GF_LOG = new int[256];

    static {
        int x = 1;
        for (int i = 0; i < 255; i++) {
            GF_EXP[i] = x;
            GF_LOG[x] = i;
            x <<= 1;
            if ((x & 0x100) != 0) x ^= 0x11D;
        }
        for (int i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    }

    private QrDecoder() {
    }

    /** 解码灰度图像缓冲（每像素 1 字节 0..255，如 Camera2 YUV_420_888 的 Y 平面）；未检测到返回 null。 */
    public static String decodeLuma(byte[] luma, int width, int height) {
        return decodeLumaWithDiag(luma, width, height).text;
    }

    /** 带诊断计数的多轮灰度解码（先扫中心取景框，再扫全帧与不同光照阈值）。 */
    public static DecodeResult decodeLumaWithDiag(byte[] luma, int width, int height) {
        if (luma == null || width < 21 || height < 21 || luma.length < width * height) {
            return new DecodeResult(null, 0);
        }
        int bestFinders = 0;

        // 1) 若画面较大，优先裁剪中心 75% 取景框区域（避开桌面/边框干扰，速度更快）
        if (width >= 360 && height >= 360) {
            int cw = (width * 3) / 4;
            int ch = (height * 3) / 4;
            int ox = (width - cw) / 2;
            int oy = (height - ch) / 2;
            byte[] crop = cropLuma(luma, width, ox, oy, cw, ch);
            int[] cropSat = buildIntegral(crop, cw, ch);
            int rCrop = Math.max(14, Math.min(cw, ch) / 14);
            DecodeResult r1 = runAdaptivePass(crop, cropSat, cw, ch, rCrop, 10);
            if (r1.text != null) return r1;
            if (r1.maxFindersSeen > bestFinders) bestFinders = r1.maxFindersSeen;

            // 过曝/反光亮屏：用更低对比敏感度 + 更小局部窗口再试一次
            DecodeResult r2 = runAdaptivePass(crop, cropSat, cw, ch, Math.max(10, rCrop / 2), 5);
            if (r2.text != null) return r2;
            if (r2.maxFindersSeen > bestFinders) bestFinders = r2.maxFindersSeen;
        }

        // 2) 全帧积分图多档自适应阈值（覆盖近距大码、偏心摆放与暗光环境）
        int[] fullSat = buildIntegral(luma, width, height);
        int rFull = Math.max(14, Math.min(width, height) / 14);
        DecodeResult f1 = runAdaptivePass(luma, fullSat, width, height, rFull, 10);
        if (f1.text != null) return f1;
        if (f1.maxFindersSeen > bestFinders) bestFinders = f1.maxFindersSeen;

        DecodeResult f2 = runAdaptivePass(luma, fullSat, width, height, Math.max(20, rFull * 2), 6);
        if (f2.text != null) return f2;
        if (f2.maxFindersSeen > bestFinders) bestFinders = f2.maxFindersSeen;

        // 3) 全局 Otsu 阈值（对相册清晰截图与高对比白纸码极快且精准）
        boolean[] otsuBits = binarizeOtsu(luma, width, height);
        DecodeResult f3 = decodeBinaryWithDiag(otsuBits, width, height);
        if (f3.text != null) return f3;
        if (f3.maxFindersSeen > bestFinders) bestFinders = f3.maxFindersSeen;

        return new DecodeResult(null, bestFinders);
    }

    /** 解码 ARGB_8888 像素数组（供相册 Bitmap 或桌面单测直接调用）。 */
    public static String decodeArgb(int[] argb, int width, int height) {
        if (argb == null || width < 21 || height < 21 || argb.length < width * height) return null;
        byte[] luma = new byte[width * height];
        for (int i = 0; i < luma.length; i++) {
            int p = argb[i];
            int r = (p >>> 16) & 0xFF;
            int g = (p >>> 8) & 0xFF;
            int b = p & 0xFF;
            luma[i] = (byte) ((306 * r + 601 * g + 117 * b) >>> 10);
        }
        return decodeLuma(luma, width, height);
    }

    /** 直接解码标准模块矩阵（true=黑，false=白；供单测和采样后复用）。 */
    public static String decodeMatrix(boolean[][] modules) {
        if (modules == null || modules.length < 21 || (modules.length - 17) % 4 != 0) return null;
        String s = tryDecodeMatrix(modules);
        if (s != null) return s;
        int n = modules.length;
        boolean[][] trans = new boolean[n][n];
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) trans[x][y] = modules[y][x];
        }
        return tryDecodeMatrix(trans);
    }

    // ------------------------------------------------------------------ 1. 积分图 Bradley-Roth 与 Otsu 二值化

    private static byte[] cropLuma(byte[] src, int srcW, int ox, int oy, int cw, int ch) {
        byte[] out = new byte[cw * ch];
        for (int y = 0; y < ch; y++) {
            System.arraycopy(src, (oy + y) * srcW + ox, out, y * cw, cw);
        }
        return out;
    }

    private static int[] buildIntegral(byte[] luma, int w, int h) {
        int stride = w + 1;
        int[] sat = new int[(h + 1) * stride];
        for (int y = 0; y < h; y++) {
            int rowSum = 0;
            int srcRow = y * w;
            int dstRow = (y + 1) * stride;
            int prevRow = y * stride;
            for (int x = 0; x < w; x++) {
                rowSum += (luma[srcRow + x] & 0xFF);
                sat[dstRow + x + 1] = sat[prevRow + x + 1] + rowSum;
            }
        }
        return sat;
    }

    private static DecodeResult runAdaptivePass(byte[] luma, int[] sat, int w, int h, int radius, int pct) {
        boolean[] bits = binarizeBradley(luma, sat, w, h, radius, pct);
        return decodeBinaryWithDiag(bits, w, heightOf(bits, w, h));
    }

    private static int heightOf(boolean[] bits, int w, int h) {
        return h;
    }

    private static boolean[] binarizeBradley(byte[] luma, int[] sat, int w, int h, int radius, int pct) {
        boolean[] out = new boolean[w * h];
        int stride = w + 1;
        int factor = 100 - pct;
        for (int y = 0; y < h; y++) {
            int y1 = Math.max(0, y - radius);
            int y2 = Math.min(h - 1, y + radius);
            int r1 = y1 * stride;
            int r2 = (y2 + 1) * stride;
            int rowOff = y * w;
            int dy = y2 - y1 + 1;
            for (int x = 0; x < w; x++) {
                int x1 = Math.max(0, x - radius);
                int x2 = Math.min(w - 1, x + radius);
                int cnt = dy * (x2 - x1 + 1);
                int sum = sat[r2 + x2 + 1] - sat[r1 + x2 + 1] - sat[r2 + x1] + sat[r1 + x1];
                int pix = luma[rowOff + x] & 0xFF;
                out[rowOff + x] = (long) pix * cnt * 100L < (long) sum * factor;
            }
        }
        return out;
    }

    private static boolean[] binarizeOtsu(byte[] luma, int w, int h) {
        int[] hist = new int[256];
        int total = w * h;
        for (int i = 0; i < total; i++) hist[luma[i] & 0xFF]++;
        long sumAll = 0;
        for (int i = 0; i < 256; i++) sumAll += (long) i * hist[i];
        long sumB = 0;
        int wB = 0;
        double maxVar = -1.0;
        int thresh = 128;
        for (int t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB == 0) continue;
            int wF = total - wB;
            if (wF == 0) break;
            sumB += (long) t * hist[t];
            double mB = (double) sumB / wB;
            double mF = (double) (sumAll - sumB) / wF;
            double diff = mB - mF;
            double between = (double) wB * (double) wF * diff * diff;
            if (between > maxVar) {
                maxVar = between;
                thresh = t;
            }
        }
        boolean[] out = new boolean[total];
        for (int i = 0; i < total; i++) out[i] = (luma[i] & 0xFF) <= thresh;
        return out;
    }

    // ------------------------------------------------------------------ 2. 定位块三向核验与透视采样

    private static final class Finder {
        float x, y, moduleSize;
        int count;

        Finder(float x, float y, float moduleSize) {
            this.x = x;
            this.y = y;
            this.moduleSize = moduleSize;
            this.count = 1;
        }

        boolean aboutEquals(float mod, float cy, float cx) {
            if (Math.abs(cy - y) <= mod * 1.2f && Math.abs(cx - x) <= mod * 1.2f) {
                float d = Math.abs(mod - moduleSize);
                return d <= 1.2f || d <= moduleSize * 0.6f;
            }
            return false;
        }

        void combine(float cy, float cx, float mod) {
            int nc = count + 1;
            x = (count * x + cx) / nc;
            y = (count * y + cy) / nc;
            moduleSize = (count * moduleSize + mod) / nc;
            count = nc;
        }
    }

    private static final class Triplet {
        final Finder bl, tl, tr;
        final float score;

        Triplet(Finder bl, Finder tl, Finder tr, float score) {
            this.bl = bl;
            this.tl = tl;
            this.tr = tr;
            this.score = score;
        }
    }

    private static DecodeResult decodeBinaryWithDiag(boolean[] bits, int w, int h) {
        List<Finder> found = findFinders(bits, w, h);
        int seen = Math.min(3, found.size());
        if (found.size() < 3) return new DecodeResult(null, seen);

        Collections.sort(found, new Comparator<Finder>() {
            @Override
            public int compare(Finder a, Finder b) {
                return Integer.compare(b.count, a.count);
            }
        });
        int limit = Math.min(found.size(), 18);
        List<Triplet> triplets = new ArrayList<Triplet>();
        for (int i = 0; i < limit; i++) {
            for (int j = i + 1; j < limit; j++) {
                for (int k = j + 1; k < limit; k++) {
                    Finder f0 = found.get(i), f1 = found.get(j), f2 = found.get(k);
                    float maxM = Math.max(f0.moduleSize, Math.max(f1.moduleSize, f2.moduleSize));
                    float minM = Math.min(f0.moduleSize, Math.min(f1.moduleSize, f2.moduleSize));
                    if (minM < 1.0f || maxM / minM > 1.75f) continue;
                    Finder[] tri = orderThree(f0, f1, f2);
                    if (tri == null) continue;
                    // 按模块尺寸一致性 + 两直角边等长性 + 命中权重综合排序
                    float leg1 = dist(tri[1], tri[0]);
                    float leg2 = dist(tri[1], tri[2]);
                    float diag = dist(tri[0], tri[2]);
                    float idealDiag = (float) Math.sqrt(leg1 * leg1 + leg2 * leg2);
                    float angleErr = Math.abs(diag - idealDiag) / Math.max(1f, idealDiag);
                    if (angleErr > 0.28f) continue;
                    float legErr = Math.abs(leg1 - leg2) / Math.max(leg1, leg2);
                    float modErr = (maxM - minM) / maxM;
                    float countBonus = 1.0f / (1.0f + f0.count + f1.count + f2.count);
                    float score = angleErr * 2.5f + legErr * 2.0f + modErr * 1.5f + countBonus;
                    triplets.add(new Triplet(tri[0], tri[1], tri[2], score));
                }
            }
        }
        Collections.sort(triplets, new Comparator<Triplet>() {
            @Override
            public int compare(Triplet a, Triplet b) {
                return Float.compare(a.score, b.score);
            }
        });
        int maxTries = Math.min(triplets.size(), 24);
        for (int i = 0; i < maxTries; i++) {
            Triplet tr = triplets.get(i);
            String decoded = sampleAndDecode(bits, w, h, tr.bl, tr.tl, tr.tr);
            if (decoded != null) return new DecodeResult(decoded, 3);
        }
        return new DecodeResult(null, seen);
    }

    private static List<Finder> findFinders(boolean[] bits, int w, int h) {
        List<Finder> list = new ArrayList<Finder>();
        int step = Math.max(1, Math.min(3, h / 180));
        int[] state = new int[5];
        for (int y = step - 1; y < h; y += step) {
            Arrays.fill(state, 0);
            int cur = 0;
            int row = y * w;
            for (int x = 0; x < w; x++) {
                if (bits[row + x]) {
                    if ((cur & 1) == 1) cur++;
                    state[cur]++;
                } else {
                    if ((cur & 1) == 0) {
                        if (cur == 4) {
                            if (foundRatio(state) && confirmCenter(bits, w, h, state, y, x, list)) {
                                cur = 0;
                                Arrays.fill(state, 0);
                            } else {
                                state[0] = state[2];
                                state[1] = state[3];
                                state[2] = state[4];
                                state[3] = 1;
                                state[4] = 0;
                                cur = 3;
                            }
                        } else {
                            state[++cur]++;
                        }
                    } else {
                        state[cur]++;
                    }
                }
            }
            if (foundRatio(state)) {
                confirmCenter(bits, w, h, state, y, w, list);
            }
        }
        return list;
    }

    private static boolean foundRatio(int[] s) {
        int total = s[0] + s[1] + s[2] + s[3] + s[4];
        if (total < 7) return false;
        float mod = total / 7.0f;
        float maxVar = mod * 0.62f;
        return Math.abs(mod - s[0]) < maxVar
                && Math.abs(mod - s[1]) < maxVar
                && Math.abs(3.0f * mod - s[2]) < 3.0f * maxVar
                && Math.abs(mod - s[3]) < maxVar
                && Math.abs(mod - s[4]) < maxVar;
    }

    private static float centerFromEnd(int[] s, int end) {
        return (end - s[4] - s[3]) - s[2] / 2.0f;
    }

    private static boolean confirmCenter(boolean[] bits, int w, int h, int[] s, int row, int endX, List<Finder> list) {
        int total = s[0] + s[1] + s[2] + s[3] + s[4];
        float cx = centerFromEnd(s, endX);
        float cy = crossCheckVertical(bits, w, h, row, (int) cx, s[2], total);
        if (Float.isNaN(cy)) return false;
        cx = crossCheckHorizontal(bits, w, h, (int) cx, (int) cy, s[2], total);
        if (Float.isNaN(cx)) return false;
        if (!crossCheckDiagonal(bits, w, h, (int) cy, (int) cx)) return false;
        float mod = total / 7.0f;
        for (Finder f : list) {
            if (f.aboutEquals(mod, cy, cx)) {
                f.combine(cy, cx, mod);
                return true;
            }
        }
        list.add(new Finder(cx, cy, mod));
        return true;
    }

    private static float crossCheckVertical(boolean[] bits, int w, int h, int startY, int cx, int maxCount, int origTotal) {
        if (cx < 0 || cx >= w) return Float.NaN;
        int[] s = new int[5];
        int i = startY;
        while (i >= 0 && bits[i * w + cx]) { s[2]++; i--; }
        if (i < 0) return Float.NaN;
        while (i >= 0 && !bits[i * w + cx] && s[1] <= maxCount) { s[1]++; i--; }
        if (i < 0 || s[1] > maxCount) return Float.NaN;
        while (i >= 0 && bits[i * w + cx] && s[0] <= maxCount) { s[0]++; i--; }
        if (s[0] > maxCount) return Float.NaN;

        i = startY + 1;
        while (i < h && bits[i * w + cx]) { s[2]++; i++; }
        if (i == h) return Float.NaN;
        while (i < h && !bits[i * w + cx] && s[3] < maxCount) { s[3]++; i++; }
        if (i == h || s[3] >= maxCount) return Float.NaN;
        while (i < h && bits[i * w + cx] && s[4] < maxCount) { s[4]++; i++; }
        if (s[4] >= maxCount) return Float.NaN;

        int total = s[0] + s[1] + s[2] + s[3] + s[4];
        if (5 * Math.abs(total - origTotal) >= 2 * origTotal) return Float.NaN;
        return foundRatio(s) ? centerFromEnd(s, i) : Float.NaN;
    }

    private static float crossCheckHorizontal(boolean[] bits, int w, int h, int startX, int cy, int maxCount, int origTotal) {
        if (cy < 0 || cy >= h) return Float.NaN;
        int[] s = new int[5];
        int row = cy * w;
        int i = startX;
        while (i >= 0 && bits[row + i]) { s[2]++; i--; }
        if (i < 0) return Float.NaN;
        while (i >= 0 && !bits[row + i] && s[1] <= maxCount) { s[1]++; i--; }
        if (i < 0 || s[1] > maxCount) return Float.NaN;
        while (i >= 0 && bits[row + i] && s[0] <= maxCount) { s[0]++; i--; }
        if (s[0] > maxCount) return Float.NaN;

        i = startX + 1;
        while (i < w && bits[row + i]) { s[2]++; i++; }
        if (i == w) return Float.NaN;
        while (i < w && !bits[row + i] && s[3] < maxCount) { s[3]++; i++; }
        if (i == w || s[3] >= maxCount) return Float.NaN;
        while (i < w && bits[row + i] && s[4] < maxCount) { s[4]++; i++; }
        if (s[4] >= maxCount) return Float.NaN;

        int total = s[0] + s[1] + s[2] + s[3] + s[4];
        if (5 * Math.abs(total - origTotal) >= 2 * origTotal) return Float.NaN;
        return foundRatio(s) ? centerFromEnd(s, i) : Float.NaN;
    }

    /** 45° 对角线交叉核验：过滤手机屏幕文字/UI 边框的假阳性定位块。 */
    private static boolean crossCheckDiagonal(boolean[] bits, int w, int h, int cy, int cx) {
        int[] s = new int[5];
        int i = 0;
        while (cy >= i && cx >= i && bits[(cy - i) * w + (cx - i)]) { s[2]++; i++; }
        if (s[2] == 0) return false;
        while (cy >= i && cx >= i && !bits[(cy - i) * w + (cx - i)]) { s[1]++; i++; }
        if (s[1] == 0) return false;
        while (cy >= i && cx >= i && bits[(cy - i) * w + (cx - i)]) { s[0]++; i++; }
        if (s[0] == 0) return false;

        i = 1;
        while (cy + i < h && cx + i < w && bits[(cy + i) * w + (cx + i)]) { s[2]++; i++; }
        while (cy + i < h && cx + i < w && !bits[(cy + i) * w + (cx + i)]) { s[3]++; i++; }
        if (s[3] == 0) return false;
        while (cy + i < h && cx + i < w && bits[(cy + i) * w + (cx + i)]) { s[4]++; i++; }
        if (s[4] == 0) return false;
        return foundRatio(s);
    }

    /** 确定 [bottomLeft, topLeft, topRight] 顺序。 */
    private static Finder[] orderThree(Finder p0, Finder p1, Finder p2) {
        float d01 = dist(p0, p1), d12 = dist(p1, p2), d02 = dist(p0, p2);
        Finder a, b, c;
        if (d12 >= d01 && d12 >= d02) { b = p0; a = p1; c = p2; }
        else if (d02 >= d12 && d02 >= d01) { b = p1; a = p0; c = p2; }
        else { b = p2; a = p0; c = p1; }
        float cross = (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x);
        if (cross < 0) {
            Finder tmp = a;
            a = c;
            c = tmp;
        }
        float leg1 = dist(b, a), leg2 = dist(b, c);
        if (leg1 < 10 || leg2 < 10) return null;
        float ratio = leg1 / leg2;
        if (ratio < 0.65f || ratio > 1.55f) return null;
        return new Finder[]{a, b, c};
    }

    private static float dist(Finder a, Finder b) {
        float dx = a.x - b.x, dy = a.y - b.y;
        return (float) Math.sqrt(dx * dx + dy * dy);
    }

    private static String sampleAndDecode(boolean[] bits, int w, int h, Finder bl, Finder tl, Finder tr) {
        float mod = (bl.moduleSize + tl.moduleSize + tr.moduleSize) / 3.0f;
        if (mod < 1.0f) return null;
        int est = Math.round((dist(tl, tr) + dist(tl, bl)) / (2.0f * mod)) + 7;
        int baseDim = ((est - 17 + 2) / 4) * 4 + 17;
        int[] candidates = {baseDim, baseDim - 4, baseDim + 4, baseDim - 8, baseDim + 8};
        for (int dim : candidates) {
            if (dim < 21 || dim > 177) continue;
            float brX = tr.x - tl.x + bl.x;
            float brY = tr.y - tl.y + bl.y;
            float dstBR = dim - 3.5f;
            if (dim >= 25) {
                float estAlignX = tl.x + (tr.x - tl.x) * (dim - 10.0f) / (dim - 7.0f)
                        + (bl.x - tl.x) * (dim - 10.0f) / (dim - 7.0f);
                float estAlignY = tl.y + (tr.y - tl.y) * (dim - 10.0f) / (dim - 7.0f)
                        + (bl.y - tl.y) * (dim - 10.0f) / (dim - 7.0f);
                float[] align = findAlignment(bits, w, h, estAlignX, estAlignY, mod);
                if (align != null) {
                    String r = trySampleQuad(bits, w, h, dim,
                            3.5f, 3.5f, dim - 3.5f, 3.5f, dim - 6.5f, dim - 6.5f, 3.5f, dim - 3.5f,
                            tl.x, tl.y, tr.x, tr.y, align[0], align[1], bl.x, bl.y);
                    if (r != null) return r;
                }
            }
            String r = trySampleQuad(bits, w, h, dim,
                    3.5f, 3.5f, dstBR, 3.5f, dstBR, dstBR, 3.5f, dstBR,
                    tl.x, tl.y, tr.x, tr.y, brX, brY, bl.x, bl.y);
            if (r != null) return r;
        }
        return null;
    }

    private static String trySampleQuad(boolean[] bits, int w, int h, int dim,
                                        float x0, float y0, float x1, float y1,
                                        float x2, float y2, float x3, float y3,
                                        float xp0, float yp0, float xp1, float yp1,
                                        float xp2, float yp2, float xp3, float yp3) {
        double[] t = quadToQuad(x0, y0, x1, y1, x2, y2, x3, y3, xp0, yp0, xp1, yp1, xp2, yp2, xp3, yp3);
        String r1 = decodeMatrix(sampleMatrix(bits, w, h, dim, t, false));
        if (r1 != null) return r1;
        // 5 点多数投票采样回退：应对屏幕摩尔纹与轻微透视漂移
        return decodeMatrix(sampleMatrix(bits, w, h, dim, t, true));
    }

    /** 寻找右下对齐块并做垂直交叉核验，返回精确中心 (ax, ay) 而非上边缘。 */
    private static float[] findAlignment(boolean[] bits, int w, int h, float cx, float cy, float mod) {
        int rad = Math.max(5, Math.round(mod * 4.5f));
        int x0 = Math.max(0, Math.round(cx) - rad);
        int x1 = Math.min(w - 1, Math.round(cx) + rad);
        int y0 = Math.max(0, Math.round(cy) - rad);
        int y1 = Math.min(h - 1, Math.round(cy) + rad);
        int[] s = new int[3];
        int midY = (y0 + y1) / 2;
        for (int off = 0; off <= (y1 - y0); off++) {
            int y = midY + ((off & 1) == 0 ? (off / 2) : -(off + 1) / 2);
            if (y < y0 || y > y1) continue;
            Arrays.fill(s, 0);
            int cur = 0;
            int row = y * w;
            for (int x = x0; x <= x1; x++) {
                boolean b = bits[row + x];
                if (b) {
                    if (cur == 1) cur = 2;
                    s[cur]++;
                } else {
                    if (cur == 0) {
                        if (s[0] > 0) { cur = 1; s[1] = 1; }
                    } else if (cur == 1) {
                        s[1]++;
                    } else {
                        if (alignRatio(s, mod)) {
                            float ax = x - s[2] - s[1] / 2.0f;
                            float ay = crossCheckAlignmentVertical(bits, w, h, y, Math.round(ax), mod);
                            if (!Float.isNaN(ay) && Math.abs(ax - cx) <= rad && Math.abs(ay - cy) <= rad) {
                                return new float[]{ax, ay};
                            }
                        }
                        s[0] = s[2];
                        s[1] = 1;
                        s[2] = 0;
                        cur = 1;
                    }
                }
            }
        }
        return null;
    }

    private static float crossCheckAlignmentVertical(boolean[] bits, int w, int h, int startY, int cx, float mod) {
        if (cx < 0 || cx >= w) return Float.NaN;
        int maxCount = Math.max(3, Math.round(mod * 2.5f));
        int[] s = new int[3];
        int i = startY;
        while (i >= 0 && bits[i * w + cx] && s[1] <= maxCount) { s[1]++; i--; }
        if (i < 0 || s[1] > maxCount) return Float.NaN;
        while (i >= 0 && !bits[i * w + cx] && s[0] <= maxCount) { s[0]++; i--; }
        if (s[0] == 0 || s[0] > maxCount) return Float.NaN;
        i = startY + 1;
        while (i < h && bits[i * w + cx] && s[1] <= maxCount) { s[1]++; i++; }
        if (i == h || s[1] > maxCount) return Float.NaN;
        while (i < h && !bits[i * w + cx] && s[2] <= maxCount) { s[2]++; i++; }
        if (s[2] == 0 || s[2] > maxCount) return Float.NaN;
        // 确认外框为黑色
        if (i < h && !bits[i * w + cx]) return Float.NaN;
        return alignRatio(s, mod) ? (i - s[2] - s[1] / 2.0f) : Float.NaN;
    }

    private static boolean alignRatio(int[] s, float mod) {
        float maxVar = mod * 0.7f;
        return Math.abs(mod - s[0]) < maxVar && Math.abs(mod - s[1]) < maxVar && Math.abs(mod - s[2]) < maxVar;
    }

    private static boolean[][] sampleMatrix(boolean[] bits, int w, int h, int dim, double[] t, boolean vote5) {
        boolean[][] out = new boolean[dim][dim];
        double[] ox = vote5 ? new double[]{0.5, 0.34, 0.66, 0.5, 0.5} : new double[]{0.5};
        double[] oy = vote5 ? new double[]{0.5, 0.5, 0.5, 0.34, 0.66} : new double[]{0.5};
        int threshold = vote5 ? 3 : 1;
        for (int y = 0; y < dim; y++) {
            for (int x = 0; x < dim; x++) {
                int dark = 0;
                for (int k = 0; k < ox.length; k++) {
                    double xx = x + ox[k];
                    double yy = y + oy[k];
                    double den = t[2] * xx + t[5] * yy + t[8];
                    if (Math.abs(den) < 1e-9) continue;
                    int ix = (int) Math.floor((t[0] * xx + t[3] * yy + t[6]) / den);
                    int iy = (int) Math.floor((t[1] * xx + t[4] * yy + t[7]) / den);
                    if (ix >= 0 && ix < w && iy >= 0 && iy < h && bits[iy * w + ix]) dark++;
                }
                out[y][x] = dark >= threshold;
            }
        }
        return out;
    }

    private static double[] squareToQuad(double x0, double y0, double x1, double y1,
                                         double x2, double y2, double x3, double y3) {
        double dx3 = x0 - x1 + x2 - x3;
        double dy3 = y0 - y1 + y2 - y3;
        if (dx3 == 0.0 && dy3 == 0.0) {
            return new double[]{x1 - x0, y1 - y0, 0, x2 - x1, y2 - y1, 0, x0, y0, 1};
        }
        double dx1 = x1 - x2, dx2 = x3 - x2;
        double dy1 = y1 - y2, dy2 = y3 - y2;
        double den = dx1 * dy2 - dx2 * dy1;
        double a13 = (dx3 * dy2 - dx2 * dy3) / den;
        double a23 = (dx1 * dy3 - dx3 * dy1) / den;
        return new double[]{
                x1 - x0 + a13 * x1, y1 - y0 + a13 * y1, a13,
                x3 - x0 + a23 * x3, y3 - y0 + a23 * y3, a23,
                x0, y0, 1.0
        };
    }

    private static double[] adjoint(double[] m) {
        return new double[]{
                m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
                m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
                m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]
        };
    }

    private static double[] mul3(double[] a, double[] b) {
        double[] c = new double[9];
        for (int col = 0; col < 3; col++) {
            for (int row = 0; row < 3; row++) {
                c[col * 3 + row] = a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2];
            }
        }
        return c;
    }

    private static double[] quadToQuad(double x0, double y0, double x1, double y1,
                                       double x2, double y2, double x3, double y3,
                                       double xp0, double yp0, double xp1, double yp1,
                                       double xp2, double yp2, double xp3, double yp3) {
        double[] qToS = adjoint(squareToQuad(x0, y0, x1, y1, x2, y2, x3, y3));
        double[] sToP = squareToQuad(xp0, yp0, xp1, yp1, xp2, yp2, xp3, yp3);
        return mul3(sToP, qToS);
    }

    // ------------------------------------------------------------------ 3. 格式/版本解调 + RS 纠错 + 位流解析

    private static String tryDecodeMatrix(boolean[][] m) {
        int dim = m.length;
        int ver = (dim - 17) / 4;
        if (ver < 1 || ver > 40) return null;

        int fmt1 = 0;
        for (int i = 0; i <= 5; i++) fmt1 = (fmt1 << 1) | (m[8][i] ? 1 : 0);
        fmt1 = (fmt1 << 1) | (m[8][7] ? 1 : 0);
        fmt1 = (fmt1 << 1) | (m[8][8] ? 1 : 0);
        fmt1 = (fmt1 << 1) | (m[7][8] ? 1 : 0);
        for (int i = 5; i >= 0; i--) fmt1 = (fmt1 << 1) | (m[i][8] ? 1 : 0);

        int fmt2 = 0;
        for (int i = dim - 1; i >= dim - 7; i--) fmt2 = (fmt2 << 1) | (m[i][8] ? 1 : 0);
        for (int i = dim - 8; i < dim; i++) fmt2 = (fmt2 << 1) | (m[8][i] ? 1 : 0);

        int bestIdx = -1, bestDist = 4;
        for (int i = 0; i < FORMAT_BITS.length; i++) {
            int d1 = Integer.bitCount(fmt1 ^ FORMAT_BITS[i]);
            int d2 = Integer.bitCount(fmt2 ^ FORMAT_BITS[i]);
            int d = Math.min(d1, d2);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) return null;
        int ecLevel = FORMAT_EC_MAP[(bestIdx >>> 3) & 3];
        int mask = bestIdx & 7;

        boolean[][] func = functionMask(ver, dim);
        byte[] raw = readCodewords(m, func, dim, mask);
        int totalCodewords = raw.length;
        int numBlocks = NUM_BLOCKS[ecLevel][ver] & 0xFF;
        int eccPerBlock = ECC_PER_BLOCK[ecLevel][ver] & 0xFF;
        int numShortBlocks = numBlocks - (totalCodewords % numBlocks);
        int shortBlockLen = totalCodewords / numBlocks;

        byte[][] blocks = new byte[numBlocks][];
        for (int i = 0; i < numBlocks; i++) {
            blocks[i] = new byte[shortBlockLen + (i < numShortBlocks ? 0 : 1)];
        }
        int shortDataLen = shortBlockLen - eccPerBlock;
        int k = 0;
        for (int i = 0; i < shortDataLen; i++) {
            for (int b = 0; b < numBlocks; b++) blocks[b][i] = raw[k++];
        }
        for (int b = numShortBlocks; b < numBlocks; b++) blocks[b][shortDataLen] = raw[k++];
        for (int i = 0; i < eccPerBlock; i++) {
            for (int b = 0; b < numBlocks; b++) {
                blocks[b][(b < numShortBlocks ? shortDataLen : shortDataLen + 1) + i] = raw[k++];
            }
        }

        byte[] data = new byte[totalCodewords - numBlocks * eccPerBlock];
        int pos = 0;
        for (int b = 0; b < numBlocks; b++) {
            if (!rsDecode(blocks[b], eccPerBlock)) return null;
            int dataLen = blocks[b].length - eccPerBlock;
            System.arraycopy(blocks[b], 0, data, pos, dataLen);
            pos += dataLen;
        }
        return parseBitStream(data, ver);
    }

    private static boolean[][] functionMask(int ver, int dim) {
        boolean[][] f = new boolean[dim][dim];
        markRect(f, 0, 0, 9, 9);
        markRect(f, dim - 8, 0, 8, 9);
        markRect(f, 0, dim - 8, 9, 8);
        for (int i = 0; i < dim; i++) {
            f[6][i] = true;
            f[i][6] = true;
        }
        int[] pos = alignmentPositions(ver);
        for (int i = 0; i < pos.length; i++) {
            for (int j = 0; j < pos.length; j++) {
                if ((i == 0 && j == 0) || (i == 0 && j == pos.length - 1) || (i == pos.length - 1 && j == 0)) continue;
                markRect(f, pos[i] - 2, pos[j] - 2, 5, 5);
            }
        }
        if (ver >= 7) {
            markRect(f, dim - 11, 0, 3, 6);
            markRect(f, 0, dim - 11, 6, 3);
        }
        return f;
    }

    private static void markRect(boolean[][] f, int x0, int y0, int w, int h) {
        for (int y = y0; y < y0 + h; y++) {
            for (int x = x0; x < x0 + w; x++) {
                if (y >= 0 && y < f.length && x >= 0 && x < f.length) f[y][x] = true;
            }
        }
    }

    private static int[] alignmentPositions(int ver) {
        if (ver == 1) return new int[0];
        int num = ver / 7 + 2;
        int step = (ver == 32) ? 26 : ((ver * 4 + num * 2 + 1) / (num * 2 - 2)) * 2;
        int[] out = new int[num];
        out[0] = 6;
        for (int i = num - 1, pos = ver * 4 + 10; i >= 1; i--, pos -= step) out[i] = pos;
        return out;
    }

    private static byte[] readCodewords(boolean[][] m, boolean[][] func, int dim, int mask) {
        int rawBits = 0;
        for (int y = 0; y < dim; y++) {
            for (int x = 0; x < dim; x++) if (!func[y][x]) rawBits++;
        }
        byte[] out = new byte[rawBits / 8];
        int byteIdx = 0, bitBuf = 0, bitCnt = 0;
        boolean up = true;
        for (int right = dim - 1; right >= 1; right -= 2) {
            if (right == 6) right = 5;
            for (int vert = 0; vert < dim; vert++) {
                int y = up ? (dim - 1 - vert) : vert;
                for (int j = 0; j < 2; j++) {
                    int x = right - j;
                    if (func[y][x]) continue;
                    boolean bit = m[y][x] ^ maskBit(mask, x, y);
                    bitBuf = (bitBuf << 1) | (bit ? 1 : 0);
                    if (++bitCnt == 8) {
                        if (byteIdx < out.length) out[byteIdx++] = (byte) bitBuf;
                        bitBuf = 0;
                        bitCnt = 0;
                    }
                }
            }
            up = !up;
        }
        return out;
    }

    private static boolean maskBit(int mask, int x, int y) {
        switch (mask) {
            case 0: return ((x + y) & 1) == 0;
            case 1: return (y & 1) == 0;
            case 2: return x % 3 == 0;
            case 3: return (x + y) % 3 == 0;
            case 4: return ((y / 2 + x / 3) & 1) == 0;
            case 5: return (x * y) % 2 + (x * y) % 3 == 0;
            case 6: return (((x * y) % 2 + (x * y) % 3) & 1) == 0;
            case 7: return (((x + y) % 2 + (x * y) % 3) & 1) == 0;
            default: return false;
        }
    }

    // ------------------------------------------------------------------ 4. Reed-Solomon GF(256) 纠错

    private static int gfMul(int a, int b) {
        if (a == 0 || b == 0) return 0;
        return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    private static int gfInv(int a) {
        if (a == 0) throw new ArithmeticException("gfInv(0)");
        return GF_EXP[255 - GF_LOG[a]];
    }

    private static boolean rsDecode(byte[] cw, int nsym) {
        int[] syn = new int[nsym];
        boolean hasErr = false;
        for (int i = 0; i < nsym; i++) {
            int eval = 0;
            int root = GF_EXP[i];
            for (byte b : cw) eval = gfMul(eval, root) ^ (b & 0xFF);
            syn[i] = eval;
            if (eval != 0) hasErr = true;
        }
        if (!hasErr) return true;

        int[] C = new int[nsym + 1];
        int[] B = new int[nsym + 1];
        C[0] = 1;
        B[0] = 1;
        int L = 0, m = 1, bVal = 1;
        for (int n = 0; n < nsym; n++) {
            int d = syn[n];
            for (int i = 1; i <= L; i++) d ^= gfMul(C[i], syn[n - i]);
            if (d == 0) {
                m++;
            } else {
                int[] T = C.clone();
                int coef = gfMul(d, gfInv(bVal));
                for (int i = 0; i + m <= nsym; i++) {
                    C[i + m] ^= gfMul(coef, B[i]);
                }
                if (2 * L <= n) {
                    L = n + 1 - L;
                    B = T;
                    bVal = d;
                    m = 1;
                } else {
                    m++;
                }
            }
        }
        if (L > nsym / 2) return false;

        List<Integer> errPos = new ArrayList<Integer>();
        List<Integer> errXInv = new ArrayList<Integer>();
        for (int i = 0; i < cw.length; i++) {
            int xInv = GF_EXP[(255 - i) % 255];
            int val = C[0];
            int pow = xInv;
            for (int j = 1; j <= L; j++) {
                val ^= gfMul(C[j], pow);
                pow = gfMul(pow, xInv);
            }
            if (val == 0) {
                errPos.add(cw.length - 1 - i);
                errXInv.add(xInv);
            }
        }
        if (errPos.size() != L) return false;

        int[] omega = new int[nsym];
        for (int i = 0; i < nsym; i++) {
            int sum = 0;
            for (int j = 0; j <= Math.min(i, L); j++) {
                sum ^= gfMul(C[j], syn[i - j]);
            }
            omega[i] = sum;
        }
        for (int idx = 0; idx < L; idx++) {
            int xInv = errXInv.get(idx);
            int num = 0, pow = 1;
            for (int i = 0; i < nsym; i++) {
                num ^= gfMul(omega[i], pow);
                pow = gfMul(pow, xInv);
            }
            int den = 0;
            int xInv2 = gfMul(xInv, xInv);
            int pOdd = 1;
            for (int i = 1; i <= L; i += 2) {
                den ^= gfMul(C[i], pOdd);
                pOdd = gfMul(pOdd, xInv2);
            }
            if (den == 0) return false;
            int mag = gfMul(num, gfInv(den));
            cw[errPos.get(idx)] ^= (byte) mag;
        }
        for (int i = 0; i < nsym; i++) {
            int eval = 0, root = GF_EXP[i];
            for (byte b : cw) eval = gfMul(eval, root) ^ (b & 0xFF);
            if (eval != 0) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ 5. 位流解码

    private static String parseBitStream(byte[] data, int ver) {
        BitReader br = new BitReader(data);
        StringBuilder out = new StringBuilder();
        while (br.available() >= 4) {
            int mode = br.read(4);
            if (mode == 0) break;
            if (mode == 7) {
                int b1 = br.read(8);
                if ((b1 & 0x80) != 0) {
                    if ((b1 & 0xC0) == 0x80) br.read(8);
                    else br.read(16);
                }
                continue;
            }
            int cbits = charCountBits(mode, ver);
            if (cbits <= 0 || br.available() < cbits) return null;
            int count = br.read(cbits);
            if (mode == 1) {
                while (count >= 3) {
                    if (br.available() < 10) return null;
                    int v = br.read(10);
                    if (v >= 1000) return null;
                    out.append((char) ('0' + v / 100)).append((char) ('0' + (v / 10) % 10)).append((char) ('0' + v % 10));
                    count -= 3;
                }
                if (count == 2) {
                    if (br.available() < 7) return null;
                    int v = br.read(7);
                    if (v >= 100) return null;
                    out.append((char) ('0' + v / 10)).append((char) ('0' + v % 10));
                } else if (count == 1) {
                    if (br.available() < 4) return null;
                    int v = br.read(4);
                    if (v >= 10) return null;
                    out.append((char) ('0' + v));
                }
            } else if (mode == 2) {
                while (count >= 2) {
                    if (br.available() < 11) return null;
                    int v = br.read(11);
                    if (v / 45 >= ALNUM.length()) return null;
                    out.append(ALNUM.charAt(v / 45)).append(ALNUM.charAt(v % 45));
                    count -= 2;
                }
                if (count == 1) {
                    if (br.available() < 6) return null;
                    int v = br.read(6);
                    if (v >= ALNUM.length()) return null;
                    out.append(ALNUM.charAt(v));
                }
            } else if (mode == 4) {
                if (br.available() < count * 8) return null;
                byte[] buf = new byte[count];
                for (int i = 0; i < count; i++) buf[i] = (byte) br.read(8);
                out.append(new String(buf, StandardCharsets.UTF_8));
            } else {
                return null;
            }
        }
        return out.length() == 0 ? null : out.toString();
    }

    private static int charCountBits(int mode, int ver) {
        int tier = ver <= 9 ? 0 : (ver <= 26 ? 1 : 2);
        switch (mode) {
            case 1: return new int[]{10, 12, 14}[tier];
            case 2: return new int[]{9, 11, 13}[tier];
            case 4: return new int[]{8, 16, 16}[tier];
            default: return -1;
        }
    }

    private static final class BitReader {
        private final byte[] data;
        private int bitPos = 0;

        BitReader(byte[] data) { this.data = data; }

        int available() { return data.length * 8 - bitPos; }

        int read(int n) {
            int val = 0;
            for (int i = 0; i < n; i++) {
                int b = (data[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1;
                val = (val << 1) | b;
                bitPos++;
            }
            return val;
        }
    }
}
