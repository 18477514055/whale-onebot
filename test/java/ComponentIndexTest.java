import com.whaleonebot.install.ComponentIndex;

/** [layer: shell-android] v2 部件索引的纯逻辑测试（不碰 Android、不联网）。 */
public final class ComponentIndexTest {

    private static int pass = 0;

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError("FAIL: " + what);
        pass++;
    }

    private static final String V2 = "{"
            + "\"schemaVersion\":2,\"abi\":1,\"current\":\"1.1.8\","
            + "\"releases\":[{\"version\":\"1.1.8\",\"catalogUrl\":\"https://github.com/o/r/releases/download/v1.1.8/catalog.json\","
            + "\"catalogSha256\":\"" + "a".repeat(64) + "\",\"environment\":{\"version\":\"1.1.8\",\"file\":\"env-1.1.8.tar.gz\","
            + "\"sha256\":\"" + "b".repeat(64) + "\",\"bytes\":123,\"format\":\"ustar-gzip\","
            + "\"url\":\"https://github.com/o/r/releases/download/v1.1.8/env-1.1.8.tar.gz\"}}],"
            + "\"components\":{"
            + "\"environment\":[{\"version\":\"1.1.8\",\"file\":\"env-1.1.8.tar.gz\",\"sha256\":\"" + "b".repeat(64) + "\",\"bytes\":123,"
            + "\"url\":\"https://github.com/o/r/releases/download/v1.1.8/env-1.1.8.tar.gz\"}],"
            + "\"core\":[{\"version\":\"1.1.8\",\"file\":\"bot-core-1.1.8.zip\",\"sha256\":\"" + "c".repeat(64) + "\",\"bytes\":10,"
            + "\"url\":\"https://github.com/o/r/releases/download/v1.1.8/bot-core-1.1.8.zip\"}],"
            + "\"plugins\":{\"qq\":[{\"version\":\"1.1.8\",\"file\":\"bot-qq-1.1.8.zip\",\"sha256\":\"" + "d".repeat(64) + "\",\"bytes\":11,"
            + "\"url\":\"https://github.com/o/r/releases/download/v1.1.8/bot-qq-1.1.8.zip\"}],"
            + "\"bilibili\":[{\"version\":\"1.1.8\",\"file\":\"bad.zip\",\"sha256\":\"not-a-sha\",\"bytes\":1}]},"
            + "\"backends\":{\"qq\":[{\"version\":\"1.2.0-beta.1\",\"file\":\"platform-qq.zip\",\"sha256\":\"" + "e".repeat(64) + "\",\"bytes\":12}],"
            + "\"bilibili\":[]},"
            + "\"desktopProtocol\":[{\"version\":\"1.2.0-beta.1\",\"file\":\"desk.zip\",\"sha256\":\"" + "f".repeat(64) + "\",\"bytes\":13}]"
            + "}}";

    private static final String V1 = "{"
            + "\"schemaVersion\":1,\"abi\":1,\"current\":\"1.1.8\","
            + "\"releases\":[{\"version\":\"1.1.8\",\"catalogUrl\":\"https://github.com/o/r/releases/download/v1.1.8/catalog.json\","
            + "\"environment\":{\"version\":\"1.1.8\",\"file\":\"env-1.1.8.tar.gz\",\"sha256\":\"" + "b".repeat(64) + "\",\"bytes\":123,"
            + "\"url\":\"https://github.com/o/r/releases/download/v1.1.8/env-1.1.8.tar.gz\"}}]}";

    public static void main(String[] args) throws Exception {
        ComponentIndex v2 = ComponentIndex.of(V2);
        check(v2.schemaVersion() == 2, "v2 schemaVersion");
        check(v2.group(ComponentIndex.GROUP_ENVIRONMENT).size() == 1, "v2 environment 1 条");
        check(v2.group(ComponentIndex.GROUP_CORE).size() == 1, "v2 core 1 条");
        check(v2.group(ComponentIndex.GROUP_PLUGIN).size() == 1, "v2 plugin 1 条（sha256 非法那条被丢掉）");
        check(v2.group(ComponentIndex.GROUP_BACKEND).size() == 1, "v2 backend 1 条（bilibili 空数组不产出条目）");
        check(v2.group(ComponentIndex.GROUP_DESKTOP).size() == 1, "v2 desktop 1 条");
        check(v2.all().size() == 5, "v2 合计 5 条");

        ComponentIndex.Entry core = v2.pick(ComponentIndex.GROUP_CORE, "", null);
        check(core != null && "1.1.8".equals(core.version), "pick core 最新");
        check("内置核心".equals(core.title()), "core 标题");
        check(core.published(), "core 有下载地址");

        ComponentIndex.Entry qq = v2.pick(ComponentIndex.GROUP_PLUGIN, "qq", null);
        check(qq != null && "平台插件 · qq".equals(qq.title()), "plugin qq 可按 id 取到");

        ComponentIndex.Entry be = v2.pick(ComponentIndex.GROUP_BACKEND, "qq", "1.2.0-beta.1");
        check(be != null && !be.published(), "backend 无 url ⇒ published()=false");

        check(v2.pick(ComponentIndex.GROUP_CORE, "", "9.9.9") == null, "指定不存在的版本取不到");

        ComponentIndex v1 = ComponentIndex.of(V1);
        check(v1.schemaVersion() == 1, "v1 schemaVersion");
        check(v1.group(ComponentIndex.GROUP_ENVIRONMENT).size() == 1, "v1 退回 releases[].environment");
        check(v1.group(ComponentIndex.GROUP_CORE).isEmpty(), "v1 不编造 core");

        check(ComponentIndex.compare("1.2.0", "1.2.0-beta.1") > 0, "正式版 > 预发布");
        check(ComponentIndex.compare("1.2.0-beta.2", "1.2.0-beta.1") > 0, "beta.2 > beta.1");
        check(ComponentIndex.compare("1.2.0-beta.1", "1.1.8") > 0, "1.2.0-beta.1 > 1.1.8");
        check(ComponentIndex.compare("1.10.0", "1.9.9") > 0, "按数字比而不是按字符串比");
        check(ComponentIndex.compare("1.1.8", "1.1.8") == 0, "相等");

        java.util.List<String> avail = java.util.Arrays.asList("1.0.0", "1.1.8");
        java.util.List<String> coreOrder = java.util.Arrays.asList("1.1.8");
        check("1.1.8".equals(ComponentIndex.defaultRelease("1.1.8", avail, coreOrder)), "defaultRelease: declared hit");
        check("1.1.8".equals(ComponentIndex.defaultRelease("1.2.11", avail, coreOrder)), "defaultRelease: app version falls back to newest core");
        check("1.0.0".equals(ComponentIndex.defaultRelease("9.9.9", avail, java.util.Arrays.asList("7.7.7"))), "defaultRelease: unknown core order falls back to first available");
        boolean rejected = false;
        try {
          ComponentIndex.defaultRelease("9.9.9", avail, new java.util.ArrayList<String>());
        } catch (java.io.IOException expected) {
          rejected = true;
        }
        check(rejected, "defaultRelease: v1 style empty coreOrder rejects unknown current");

        System.out.println("ComponentIndexTest: " + pass + " checks PASS");
    }
}