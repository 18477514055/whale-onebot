package com.whaleonebot.ui;

/** Only the built-in runtime owns native panels. Other runtimes supply at most declarative links. */
final class RuntimeSurfaces {
    static boolean builtin(BotRegistry.Bot owner){return owner!=null && BotRegistry.KIND_BUILTIN.equals(owner.runtimeKind);}
}
