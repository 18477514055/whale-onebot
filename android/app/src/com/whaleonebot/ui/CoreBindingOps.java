package com.whaleonebot.ui;

import com.whaleonebot.ContainerService;
import com.whaleonebot.install.CoreInstaller;

/** [layer: shell-android] 核心绑定维护操作（移除确认已统一改用 PromptSheet）。 */
final class CoreBindingOps {
    static void reconcile(java.io.File files, CoreInventory.Instance core) throws Exception {
        if (core == null || !CoreManagerScreen.managed(core)) return;
        String pending = CoreInstaller.pendingMaintenance(files, core.id);
        if ("qq".equals(pending) || "bilibili".equals(pending)) {
            CoreInventory.Instance now = CoreManagerScreen.find(core.id);
            if (now == null || !core.ownerId.equals(now.ownerId)) throw new IllegalStateException("OWNER_CHANGED");
            BotRegistry.Bot live = BotRegistry.get(now.ownerId);
            CoreInstaller.recoverReset(files, core.id, live == null || !live.serves(pending));
        }
    }

    static void remove(Screen s, BotRegistry.Bot bot, BotRegistry.Binding b, Runnable done) {
        CoreInventory.Instance core = BotRegistry.coreForBot(bot.id);
        boolean same = false;
        for (BotRegistry.Binding row : bot.bindings) {
            if (row != b && row.platform.equals(b.platform)) same = true;
        }
        final boolean uninstall = !same && core != null && CoreManagerScreen.managed(core);
        PromptSheet.confirm(
                s.activity, s.t,
                "移除「" + b.label() + "」？",
                (uninstall ? "这是本实例最后一个该平台账号，将一并卸载平台插件。" : "将解除此账号绑定。")
                        + "协议端登录、共享记忆及知识库保留。",
                "移除", () -> new Thread(() -> {
                    try {
                        reconcile(s.activity.getFilesDir(), core);
                        if (core != null && CoreManagerScreen.managed(core)) {
                            ContainerService.stopInstalledBinding(bot.id, b.id);
                        }
                        Runnable commit = () -> {
                            String error = BotRegistry.changeBinding(bot, b, null);
                            if (error != null) throw new IllegalStateException(error);
                        };
                        if (uninstall) CoreInstaller.removePlatform(s.activity.getFilesDir(), core.id, b.platform, commit);
                        else commit.run();
                        s.activity.runOnUiThread(() -> { s.host().toast("已移除绑定"); done.run(); });
                    } catch (Exception ex) {
                        android.util.Log.w("WhaleEnv", "移除绑定失败: " + b.id, ex);
                        s.activity.runOnUiThread(() -> s.host().toast("未能移除，请检查实例状态后重试"));
                    }
                }, "binding-maintenance").start(),
                null, null, "取消");
    }
}
