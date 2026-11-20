package com.whaleonebot.ui;

/** The installer and UI use the same offline-capable JSON implementation. */
public final class InstallerJson {
  private InstallerJson() {}

  public static Object parse(String text) {
    return BotConfigJson.parse(text);
  }

  public static String write(Object tree) {
    return BotConfigJson.write(tree);
  }
}
