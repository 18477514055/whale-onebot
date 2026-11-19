package com.whaleonebot.ui;

/**
 * 运行端（容器里的 agent 业务程序）配置的读写通道。
 *
 * <p>面板只做三件事：把 {@link #loadConfigJson()} 给的 JSON 文本解析成树 → 让用户改其中若干个
 * 叶子 → 把整棵树重新序列化后交给 {@link #saveConfigJson(String)}。文件在容器里的哪一层、
 * 用不用 proot、走不走 shell，全由宿主决定，面板一概不碰。
 *
 * <p>线程约定：四个方法都会被 <b>UI 线程</b>直接调用。宿主如果读文件要几百毫秒，
 * 请自己缓存文本（例如容器启动后读一次），不要在方法里做长阻塞 —— 面板没有自己的后台线程。
 */
public interface BotConfigHost {

    /** 读当前配置的 JSON 文本；读不到返回 null。可能几百 KB。 */
    String loadConfigJson();

    /** 把整份 JSON 写回（我已经保证只在你点保存时调用）。成功返回 true。 */
    boolean saveConfigJson(String json);

    /** 运行端是否在线（决定面板里"需要重启生效"的提示）。 */
    boolean botRunning();

    /** 提示（Toast）。 */
    void toast(String msg);
}
