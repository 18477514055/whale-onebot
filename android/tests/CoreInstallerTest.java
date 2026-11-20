package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import java.io.*;
import java.net.*;
import java.nio.file.Files;
import java.util.*;

/**
 * A loopback fixture maps canonical HTTPS URLs at the connection boundary, never adds a production
 * origin override.
 */
public final class CoreInstallerTest {
  static void ok(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }

  interface Action {
    void run() throws Exception;
  }

  static void rejects(Action action, String why) throws Exception {
    try {
      action.run();
      throw new AssertionError(why);
    } catch (IOException | IllegalArgumentException expected) {
    }
  }

  static byte[] signed(java.security.KeyPair k, String url, String pin, long seq, long expiry)
      throws Exception {
    String body =
        "{\"sequence\":"
            + seq
            + ",\"expires\":"
            + expiry
            + ",\"url\":\""
            + url
            + "\",\"sha256\":\""
            + pin
            + "\"}";
    byte[] payload = body.getBytes("UTF-8");
    java.security.Signature sig = java.security.Signature.getInstance("SHA256withRSA");
    sig.initSign(k.getPrivate());
    sig.update(payload);
    String json =
        "{\"payload\":\""
            + Base64.getEncoder().encodeToString(payload)
            + "\",\"signature\":\""
            + Base64.getEncoder().encodeToString(sig.sign())
            + "\"}";
    return json.getBytes("UTF-8");
  }

  static void channel(
      File files, File assets, ReleaseCache.Transport host, String index, String pin)
      throws Exception {
    java.security.KeyPairGenerator gen = java.security.KeyPairGenerator.getInstance("RSA");
    gen.initialize(3072);
    java.security.KeyPair keys = gen.generateKeyPair();
    String pub = Base64.getEncoder().encodeToString(keys.getPublic().getEncoded());
    Map<String, Object> bootstrap = new HashMap<>();
    bootstrap.put("channelPublicKey", pub);
    bootstrap.put("minSequence", 1);
    long now = System.currentTimeMillis() / 1000;
    File local = new File(assets, "core-channel-v1/channel.json");
    atomic(local, signed(keys, index, pin, 4, now + 3600));
    Map<String, Object> pick = SignedChannel.resolve(files, bootstrap, host);
    ok(num(pick, "sequence") == 4, "signed pointer");
    File saved = new File(files, "core-release-cache/channel.json");
    ok(saved.setLastModified((now - 7200) * 1000), "age fixture");
    atomic(local, signed(keys, index, pin, 3, now + 3600));
    rejects(() -> SignedChannel.resolve(files, bootstrap, host), "signed rollback");
    atomic(local, signed(keys, index, pin, 5, now - 1));
    rejects(() -> SignedChannel.resolve(files, bootstrap, host), "expired pointer");
    byte[] forged = signed(keys, index, pin, 6, now + 3600);
    String env = new String(forged, "UTF-8");
    int at = env.indexOf("\"signature\":\"") + 13;
    forged[at] = (byte) (forged[at] == 'a' ? 'b' : 'a');
    atomic(local, forged);
    rejects(() -> SignedChannel.resolve(files, bootstrap, host), "forged pointer");
  }

  public static void main(String[] args) throws Exception {
    File files = new File(args[0]).getCanonicalFile();
    int port = Integer.parseInt(args[1]);
    String pin = args[2], index = ReleaseCache.ORIGIN + "v1.1.0/release-index.json";
    long expected = Long.parseLong(args[3]);
    File assets = new File(args[4]);
    List<String> both = Arrays.asList("qq", "bilibili");
    int[] gets = {0}, prepared = {0};
    boolean[] offline = {false}, denyBili = {true};
    ReleaseCache.Transport host =
        u -> {
          ok(u.toString().startsWith(ReleaseCache.ORIGIN), "origin");
          if (offline[0]) throw new IOException("offline");
          gets[0]++;
          String rel = u.toString().substring(ReleaseCache.ORIGIN.length());
          if (denyBili[0] && rel.contains("bot-bilibili")) rel = "missing.zip";
          return (HttpURLConnection)
              new URL("http://127.0.0.1:" + port + "/" + rel).openConnection();
        };
    CoreInstaller.Environment environment =
        new CoreInstaller.Environment() {
          public boolean ready(File f, String h) {
            return com.whaleonebot.ManagedEnvironment.ready(f, h);
          }

          public void prepare(File f, File a, String h) throws IOException {
            com.whaleonebot.ManagedEnvironment.prepare(f, a, h);
            prepared[0]++;
          }
        };
    if (args.length > 5) {
      String candidateIndex = args[5];
      String candidatePin = args[6];
      denyBili[0] = false;
      CoreInstaller real =
          new CoreInstaller(files, candidateIndex, candidatePin, host, environment);
      long total = real.downloadBytes(real.current(), both);
      ok(
          real.install("core-candidate", real.current(), both, false, null).isEmpty(),
          "actual candidate platform download");
      ok(
          CoreInstaller.onNormalStart(files, "core-candidate").isDirectory() && prepared[0] == 1,
          "actual candidate environment/launch verification");
      System.out.println(
          "PASS: local release candidate bytes="
              + total
              + " env + core + independent QQ/Bilibili receipts; not Android/ARM execution");
      return;
    }
    File legacy = new File(files, "rootfs/legacy-marker");
    atomic(legacy, new byte[] {17});
    channel(files, assets, host, index, pin);
    rejects(
        () -> new CoreInstaller(files, index, pin.replaceAll(".", "0"), host, environment),
        "bad index pin accepted");
    rejects(
        () -> ReleaseCache.origin("https://github.com/other/project/releases/download/v1/core.zip"),
        "other origin");
    rejects(
        () -> ReleaseCache.redirect(new URL(index), "https://example.org/file"),
        "untrusted redirect");
    rejects(() -> ModuleArchive.scope("core", "src/../ignored.js"), "unsafe path");
    rejects(
        () -> ModuleArchive.scope("qq", "src/platform-modules/bilibili/index.mjs"),
        "plugin boundary");
    CoreInstaller i = new CoreInstaller(files, index, pin, host, environment);
    ok(i.versions(true).size() == 2 && i.versions(false).size() == 3, "compatibility filter");
    ok(i.downloadBytes("1.0.0", both) == expected, "first download total");
    Map<String, Object> qqRow =
        obj(list(json(new File(assets, "v1.0.0/catalog.json")), "artifacts").get(1));
    rejects(
        () -> ModuleArchive.checkCentral(new File(assets, "special-member.zip")),
        "non-regular ZIP member");
    rejects(
        () ->
            ModuleArchive.unpack(
                new File(assets, "extra-member.zip"), qqRow, new File(files, "bad-stage")),
        "unlisted ZIP member");
    File sourceCore = new File(assets, "v1.0.0/bot-core-1.0.0.zip");
    byte[] good = Files.readAllBytes(sourceCore.toPath()), changed = good.clone();
    changed[changed.length / 2] ^= 1;
    Files.write(sourceCore.toPath(), changed);
    rejects(
        () -> i.install("core-bad", "1.0.0", both, false, null), "streamed ZIP digest mismatch");
    ok(!new File(files, "core-instances/core-bad/active.json").exists(), "invalid ZIP committed");
    Files.write(sourceCore.toPath(), good);
    ok(!CoreInstaller.auto(files), "notify only by default");
    Map<String, String> failures = i.install("core-a", "1.0.0", both, false, null);
    ok(failures.size() == 1 && failures.containsKey("bilibili"), "partial platform failure");
    File a = CoreInstaller.active(files, "core-a");
    ok(
        ModuleArchive.dir(a, "qq").isDirectory() && !ModuleArchive.dir(a, "bilibili").exists(),
        "QQ remains usable");
    denyBili[0] = false;
    int before = gets[0];
    ok(i.install("core-a", "1.0.0", both, false, null).isEmpty(), "retry");
    ok(gets[0] == before + 1, "retry fetches missing plugin only");
    a = CoreInstaller.active(files, "core-a");
    ok(i.downloadBytes("1.0.0", both) == 0, "cached bytes");
    before = gets[0];
    offline[0] = true;
    CoreInstaller reopened = new CoreInstaller(files, index, pin, host, environment);
    reopened.install("core-b", "1.0.0", Collections.singletonList("qq"), false, null);
    reopened.install("core-c", "1.0.0", Collections.singletonList("bilibili"), false, null);
    ok(
        gets[0] == before && prepared[0] == 1,
        "three instances one shared verified environment and cache");
    File b = CoreInstaller.active(files, "core-b"), c = CoreInstaller.active(files, "core-c");
    ok(
        !a.equals(b)
            && !b.equals(c)
            && !ModuleArchive.dir(b, "bilibili").exists()
            && !ModuleArchive.dir(c, "qq").exists(),
        "independent physical slots");
    File original = a;
    try {
      CoreInstaller.reset(
          files,
          "core-a",
          () -> {
            throw new IllegalStateException("cancel");
          });
      throw new AssertionError("callback failure ignored");
    } catch (IllegalStateException expectedCancel) {
    }
    ok(
        CoreInstaller.active(files, "core-a").equals(original),
        "failed reset retained exact pointer");
    class InterruptedProcess extends Error {
      private static final long serialVersionUID = 1L;
    }
    try {
      CoreInstaller.reset(
          files,
          "core-a",
          () -> {
            throw new InterruptedProcess();
          });
      throw new AssertionError("unreached");
    } catch (InterruptedProcess interrupted) {
    }
    ok(CoreInstaller.pendingMaintenance(files, "core-a").equals("reset"), "crash journal retained");
    rejects(() -> CoreInstaller.onNormalStart(files, "core-a"), "incomplete maintenance start");
    CoreInstaller.recoverReset(files, "core-a", false);
    ok(
        CoreInstaller.active(files, "core-a").equals(original),
        "owner-not-committed restart restores old generation");
    CoreInstaller.removePlatform(files, "core-a", "qq", () -> {});
    ok(
        !ModuleArchive.dir(CoreInstaller.active(files, "core-a"), "qq").exists()
            && ModuleArchive.dir(b, "qq").isDirectory(),
        "targeted platform removal");
    CoreInstaller.reset(files, "core-a", () -> {});
    ok(
        !ModuleArchive.dir(CoreInstaller.active(files, "core-a"), "bilibili").exists()
            && CoreInstaller.active(files, "core-b").equals(b)
            && CoreInstaller.active(files, "core-c").equals(c),
        "isolated release");
    offline[0] = false;
    ok(i.pluginVersions("qq", true).size() == 2, "independent plugin version history");
    i.stagePlugin("core-b", "qq", "1.1.0", null);
    ok(
        CoreInstaller.active(files, "core-b").equals(b),
        "plugin update did not switch running path");
    File updated = CoreInstaller.onNormalStart(files, "core-b");
    ok(
        str(json(new File(ModuleArchive.dir(updated, "qq"), ".bot-module.json")), "version")
                .equals("1.1.0")
            && CoreInstaller.release(files, "core-b").equals("1.0.0"),
        "plugin upgraded without upgrading core");
    CoreInstaller.rollback(files, "core-b");
    ok(
        CoreInstaller.active(files, "core-b").equals(updated)
            && CoreInstaller.onNormalStart(files, "core-b").equals(b),
        "rollback applied only on normal start");
    rejects(() -> i.install("core-b", "2.0.0", both, true, null), "incompatible install");
    CoreInstaller.setAuto(files, true);
    i.autoStage();
    ok(CoreInstaller.active(files, "core-c").equals(c), "auto stage preserves active path");
    File switched = CoreInstaller.onNormalStart(files, "core-c");
    ok(
        !switched.equals(c) && CoreInstaller.release(files, "core-c").equals("1.1.0"),
        "auto stage applied on next normal start");
    CoreInstaller.setAuto(files, false);
    File newEnv = CoreInstaller.environmentRoot(files, "core-c"),
        oldEnv = CoreInstaller.environmentForApp(files, c);
    ok(
        !oldEnv.equals(newEnv)
            && oldEnv.isDirectory()
            && newEnv.isDirectory()
            && Files.readAllBytes(legacy.toPath())[0] == 17,
        "side-by-side environments without touching legacy");
    CoreInstaller.rollback(files, "core-c");
    ok(
        CoreInstaller.onNormalStart(files, "core-c").equals(c)
            && CoreInstaller.environmentRoot(files, "core-c").equals(oldEnv),
        "rollback reselects previous environment");
    CoreInstaller.rollback(files, "core-c");
    ok(CoreInstaller.onNormalStart(files, "core-c").equals(switched), "forward after rollback");
    File corrupt = new File(switched, "src/core/platform-modules.js");
    Files.write(corrupt.toPath(), new byte[] {7});
    rejects(() -> CoreInstaller.onNormalStart(files, "core-c"), "modified installed payload");
    System.out.println(
        "PASS: pinned loopback releases, partial retry, three isolated instances, cache-only"
            + " reopen, callback rollback, local reset/removal, plugin-only upgrade, staged"
            + " rollback, compatibility/auto, tamper rejection");
  }
}
