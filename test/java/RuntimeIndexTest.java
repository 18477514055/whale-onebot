import com.whaleonebot.ui.*;

import java.io.File;
import java.lang.reflect.Method;

/**
 * RuntimeIndexLogic 的主机侧断言（纯 JDK，不碰 Android 运行时）。
 *
 * 编译：javac -encoding UTF-8 -d <out> BotConfigJson.java RuntimeIndexLogic.java RuntimeIndexTest.java
 * 运行：java -cp <out> RuntimeIndexTest
 *
 * 为什么要有它：索引挑哪一条运行端去下载，纯逻辑却不能只靠"编译过"就算数 ——
 * 版本比较和 minApp 过滤一错，用户就会下到跑不动的包。
 */
public final class RuntimeIndexTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Class<?> logic = Class.forName("com.whaleonebot.ui.RuntimeIndexLogic");
        Method select = logic.getDeclaredMethod("select", String.class, int.class);
        Method cmp = logic.getDeclaredMethod("compareVersion", String.class, String.class);
        select.setAccessible(true);
        cmp.setAccessible(true);

        // ---- 版本比较
        eq("1.0.10 > 1.0.9", 1, (Integer) cmp.invoke(null, "1.0.10", "1.0.9"));
        eq("1.2 = 1.2.0", 0, (Integer) cmp.invoke(null, "1.2", "1.2.0"));
        eq("1.0.0 < 1.0.1", -1, (Integer) cmp.invoke(null, "1.0.0", "1.0.1"));
        eq("10 > 9", 1, (Integer) cmp.invoke(null, "10", "9"));
        eq("1.0.1-beta 视为 1.0.1", 0, (Integer) cmp.invoke(null, "1.0.1-beta", "1.0.1"));

        // ---- 空 / 坏索引
        eq("空串 → null", null, select.invoke(null, "", 1));
        eq("坏 JSON → null", null, select.invoke(null, "{not json", 1));
        eq("无 entries → null", null, select.invoke(null, "{\"schemaVersion\":1}", 1));
        eq("entries 空数组 → null", null, select.invoke(null, "{\"entries\":[]}", 1));

        // ---- 挑最大版本
        String idx = "{\"entries\":["
                + "{\"version\":\"1.0.0\",\"url\":\"https://e/1.0.0.zip\",\"bytes\":10},"
                + "{\"version\":\"1.0.2\",\"url\":\"https://e/1.0.2.zip\",\"bytes\":12},"
                + "{\"version\":\"1.0.1\",\"url\":\"https://e/1.0.1.zip\",\"bytes\":11}]}";
        Object best = select.invoke(null, idx, 1);
        eq("挑最大版本 → 1.0.2", "1.0.2", field(best, "version"));
        eq("bytes 一并带出 → 12", 12L, field(best, "bytes"));

        // ---- minApp 过滤
        String idx2 = "{\"entries\":["
                + "{\"version\":\"2.0.0\",\"url\":\"https://e/2.zip\",\"bytes\":20,\"minApp\":500},"
                + "{\"version\":\"1.5.0\",\"url\":\"https://e/1.5.zip\",\"bytes\":15,\"minApp\":100}]}";
        eq("minApp 太高被跳过 → 1.5.0", "1.5.0", field(select.invoke(null, idx2, 101), "version"));
        eq("App 足够新则取 2.0.0", "2.0.0", field(select.invoke(null, idx2, 500), "version"));
        eq("appVersionCode=0 不做过滤 → 2.0.0", "2.0.0", field(select.invoke(null, idx2, 0), "version"));

        // ---- 非 http / 缺 version 被丢掉
        String idx3 = "{\"entries\":["
                + "{\"version\":\"9.9.9\",\"url\":\"ftp://e/x.zip\"},"
                + "{\"url\":\"https://e/noversion.zip\"},"
                + "{\"version\":\"1.0.0\",\"url\":\"https://e/ok.zip\",\"bytes\":1}]}";
        eq("只剩合法那条 → 1.0.0", "1.0.0", field(select.invoke(null, idx3, 1), "version"));

        // ---- 全被过滤 → null（调用方要退回内置常量）
        String idx4 = "{\"entries\":[{\"version\":\"2.0.0\",\"url\":\"https://e/2.zip\",\"minApp\":900}]}";
        eq("全被过滤 → null", null, select.invoke(null, idx4, 1));

        System.out.println("RuntimeIndexTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) System.exit(1);
    }

    private static Object field(Object o, String name) throws Exception {
        if (o == null) return null;
        java.lang.reflect.Field f = o.getClass().getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
    }

    private static void eq(String label, Object want, Object got) {
        boolean ok = want == null ? got == null : want.equals(got);
        if (ok) {
            pass++;
            System.out.println("PASS  " + label);
        } else {
            fail++;
            System.out.println("FAIL  " + label + "  want=" + want + " got=" + got);
        }
    }
}
