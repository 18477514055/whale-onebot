package com.whaleonebot.ui;

/** Presentation must never promote configuration, process existence or another account's proof to a connection. */
final class BindingPresentation {
    private BindingPresentation() {}
    static boolean connected(BotRegistry.Binding binding,String process,String rowId,String platform,String account,String state) {
        return "running".equals(process) && "verified".equals(state) && !binding.accountId.isEmpty()
            && binding.id.equals(rowId) && binding.platform.equals(platform) && binding.accountId.equals(account);
    }
}
