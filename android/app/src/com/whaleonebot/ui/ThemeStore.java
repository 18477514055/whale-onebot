package com.whaleonebot.ui;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 主题与自定义背景的持久化。
 *
 * <p>主题 id 存在 SharedPreferences；自定义背景被复制进 App 私有目录
 * {@code getFilesDir()/ui/background.png}，此后不再持有 content:// Uri
 * （Uri 授权会随进程重启失效，必须转存）。
 */
final class ThemeStore {

    private static final String PREFS = "whaleonebot.ui";
    private static final String K_THEME = "theme";
    private static final String K_CUSTOM = "bg.custom";

    /** 转存时长边上限：再大的手机屏也用不着更清楚，但解码开销/内存差别很大。 */
    private static final int MAX_SIDE = 1920;

    private final SharedPreferences sp;
    private final File dir;
    private final File bg;

    private String themeId;
    private boolean custom;

    ThemeStore(Activity a) {
        sp = a.getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
        dir = new File(a.getFilesDir(), "ui");
        bg = new File(dir, "background.png");
        themeId = sp.getString(K_THEME, Theme.ALL[0].id);
        custom = sp.getBoolean(K_CUSTOM, false);
        if (custom && !bg.isFile()) {
            // 文件被清掉了（清数据/重装），状态跟着回退，别让界面撒谎。
            custom = false;
            sp.edit().putBoolean(K_CUSTOM, false).apply();
        }
    }

    Theme theme() {
        return Theme.byId(themeId);
    }

    void setTheme(String id) {
        themeId = Theme.byId(id).id;
        sp.edit().putString(K_THEME, themeId).apply();
    }

    boolean hasCustomBg() {
        return custom && bg.isFile();
    }

    void clearCustomBg() {
        custom = false;
        sp.edit().putBoolean(K_CUSTOM, false).apply();
        //noinspection ResultOfMethodCallIgnored
        bg.delete();
    }

    /**
     * 把选中的图片降采样后转存为 background.png。
     * 全程同步执行（一次性操作），调用方负责先把 UI 状态提示好。
     */
    void importBackground(ContentResolver cr, Uri uri) throws IOException {
        BitmapFactory.Options probe = new BitmapFactory.Options();
        probe.inJustDecodeBounds = true;
        InputStream in = cr.openInputStream(uri);
        if (in == null) throw new IOException("无法打开图片");
        try {
            BitmapFactory.decodeStream(in, null, probe);
        } finally {
            in.close();
        }
        if (probe.outWidth <= 0 || probe.outHeight <= 0) throw new IOException("不是可识别的图片");

        int sample = 1;
        int longest = Math.max(probe.outWidth, probe.outHeight);
        while (sample < 8 && longest / (sample * 2) >= MAX_SIDE) sample *= 2;

        BitmapFactory.Options opt = new BitmapFactory.Options();
        opt.inSampleSize = sample;
        opt.inPreferredConfig = Bitmap.Config.ARGB_8888;
        in = cr.openInputStream(uri);
        if (in == null) throw new IOException("无法打开图片");
        Bitmap bmp;
        try {
            bmp = BitmapFactory.decodeStream(in, null, opt);
        } finally {
            in.close();
        }
        if (bmp == null) throw new IOException("图片解码失败");

        int degrees = exifDegrees(cr, uri);
        if (degrees != 0) {
            Matrix m = new Matrix();
            m.postRotate(degrees);
            Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (rotated != bmp) bmp.recycle();
            bmp = rotated;
        }

        if (!dir.isDirectory() && !dir.mkdirs()) {
            bmp.recycle();
            throw new IOException("无法创建目录");
        }

        File tmp = new File(dir, "background.tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            if (!bmp.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new IOException("编码失败");
        } finally {
            out.close();
            bmp.recycle();
        }
        //noinspection ResultOfMethodCallIgnored
        bg.delete();
        if (!tmp.renameTo(bg)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("写入失败");
        }
        custom = true;
        sp.edit().putBoolean(K_CUSTOM, true).apply();
    }

    /** 按目标尺寸降采样解码；拿不到就返回 null（界面自己回落到渐变）。 */
    Bitmap loadBackground(int targetW, int targetH) {
        if (!hasCustomBg()) return null;
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(bg.getAbsolutePath(), probe);
            if (probe.outWidth <= 0 || probe.outHeight <= 0) return null;

            int tw = Math.max(1, targetW);
            int th = Math.max(1, targetH);
            int sample = 1;
            while (sample < 8
                    && probe.outWidth / (sample * 2) >= tw
                    && probe.outHeight / (sample * 2) >= th) {
                sample *= 2;
            }
            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inSampleSize = sample;
            opt.inPreferredConfig = Bitmap.Config.ARGB_8888;
            return BitmapFactory.decodeFile(bg.getAbsolutePath(), opt);
        } catch (Throwable t) {
            return null;
        }
    }

    private static int exifDegrees(ContentResolver cr, Uri uri) {
        InputStream in = null;
        try {
            in = cr.openInputStream(uri);
            if (in == null) return 0;
            ExifInterface ex = new ExifInterface(in);
            int o = ex.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            if (o == ExifInterface.ORIENTATION_ROTATE_90) return 90;
            if (o == ExifInterface.ORIENTATION_ROTATE_180) return 180;
            if (o == ExifInterface.ORIENTATION_ROTATE_270) return 270;
        } catch (Throwable ignored) {
            // PNG 之类没有 EXIF，按正常方向处理即可
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Throwable ignored) {
                }
            }
        }
        return 0;
    }
}
