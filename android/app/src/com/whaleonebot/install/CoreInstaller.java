package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import android.content.Context;
import com.whaleonebot.ManagedEnvironment;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Blocking APIs except checkAuto. Never starts/stops a process or opens an account/session. */
public final class CoreInstaller {
  public interface Progress {
    void update(String item, long bytes, long total);
  }

  interface Environment {
    boolean ready(File f, String sha);

    void prepare(File f, File archive, String sha) throws Exception;
  }

  private final File files;
  private final ReleaseCache cache;
  private final Environment environment;
  private final Map<String, Map<String, Object>> releases = new LinkedHashMap<>();
  private final String current;

  public static CoreInstaller open(Context ctx) throws Exception {
    Map<String, Object> pin;
    try (InputStream in = ctx.getAssets().open("core-release-pin.json")) {
      pin = parse(read(in, 4096));
    }
    ReleaseCache.Transport transport = u -> (HttpURLConnection) u.openConnection();
    pin = SignedChannel.resolve(ctx.getFilesDir(), pin, transport);
    return new CoreInstaller(
        ctx.getFilesDir(),
        str(pin, "url"),
        str(pin, "sha256"),
        transport,
        new Environment() {
          public boolean ready(File f, String s) {
            return ManagedEnvironment.ready(f, s);
          }

          public void prepare(File f, File a, String s) throws Exception {
            ManagedEnvironment.prepare(f, a, s);
          }
        });
  }

  CoreInstaller(File dir, String url, String pin, ReleaseCache.Transport transport, Environment env)
      throws Exception {
    files = dir.getCanonicalFile();
    cache = new ReleaseCache(files, transport);
    environment = env;
    Map<String, Object> index = json(cache.get("release-index", url, pin, -1, META_LIMIT, null));
    require(
        num(index, "schemaVersion") == 1 && num(index, "abi") == 1, "Unsupported release index");
    current = tag(str(index, "current"));
    List<?> rows = list(index, "releases");
    require(!rows.isEmpty() && rows.size() <= 128, "Invalid release count");
    for (Object val : rows) {
      Map<String, Object> r = obj(val);
      String v = tag(str(r, "version"));
      ReleaseCache.origin(str(r, "catalogUrl"));
      sha(str(r, "catalogSha256"));
      require(releases.put(v, r) == null, "Duplicate release version");
    }
    require(releases.containsKey(current), "Unknown default release");
  }

  public String current() {
    return current;
  }

  private Map<String, Object> row(String version) throws IOException {
    Map<String, Object> r = releases.get(version);
    require(r != null, "Unknown release");
    return r;
  }

  private boolean compatible(Map<String, Object> r) throws IOException {
    return (!r.containsKey("abi") || num(r, "abi") == 1)
        && (!r.containsKey("dataSchema") || num(r, "dataSchema") == 1);
  }

  public List<String> versions(boolean compatibleOnly) throws IOException {
    List<String> out = new ArrayList<>();
    for (Map.Entry<String, Map<String, Object>> e : releases.entrySet())
      if (!compatibleOnly || compatible(e.getValue())) out.add(e.getKey());
    return out;
  }

  private Map<String, Object> env(Map<String, Object> r) throws IOException {
    Map<String, Object> e = obj(r.get("environment"));
    String url = str(e, "url"), file = str(e, "file");
    ReleaseCache.origin(url);
    require(
        url.endsWith("/" + file)
            && file.matches("whale-environment-arm64-[A-Za-z0-9._-]+\\.tar\\.gz")
            && str(e, "format").equals("ustar-gzip")
            && num(e, "bytes") > 0
            && num(e, "bytes") <= 4L << 30,
        "Invalid shared environment");
    sha(str(e, "sha256"));
    return e;
  }

  private Map<String, Map<String, Object>> catalog(Map<String, Object> r) throws IOException {
    require(compatible(r), "版本不兼容；请先备份，不可直接切换");
    Map<String, Object> c =
        json(
            cache.get(
                "catalog", str(r, "catalogUrl"), str(r, "catalogSha256"), -1, META_LIMIT, null));
    require(num(c, "schemaVersion") == 1 && num(c, "abi") == 1, "Unsupported catalog ABI");
    Map<String, Map<String, Object>> rows = new LinkedHashMap<>();
    for (Object val : list(c, "artifacts")) {
      Map<String, Object> a = obj(val);
      ModuleArchive.row(a);
      require(rows.put(str(a, "id"), a) == null, "Duplicate module");
    }
    return rows;
  }

  private static List<String> platforms(List<String> in) throws IOException {
    Set<String> out = new LinkedHashSet<>();
    for (String s : in) {
      require(s != null && ModuleArchive.known(s), "Unknown platform");
      if (!s.equals("core")) out.add(s);
    }
    return new ArrayList<>(out);
  }

  public long downloadBytes(String version, List<String> selected) throws Exception {
    Map<String, Object> r = row(version), e = env(r);
    Map<String, Map<String, Object>> rows = catalog(r);
    String hash = str(e, "sha256");
    long total =
        environment.ready(envHome(files, hash), hash) || cache.valid(hash, num(e, "bytes"))
            ? 0
            : num(e, "bytes");
    List<String> ids = platforms(selected);
    ids.add("core");
    for (String id : ids) {
      Map<String, Object> a = rows.get(id);
      if (a == null && !id.equals("core"))
        continue; // Report unavailable plugins individually at install time.
      require(a != null, "No release asset for " + id);
      if (!cache.valid(str(a, "sha256"), num(a, "bytes"))) total += num(a, "bytes");
    }
    return total;
  }

  private static File instance(File files, String id) throws IOException {
    require(
        id != null && id.matches("[a-z][a-z0-9-]{0,63}") && !id.equals("whale-1"),
        "Invalid managed instance id");
    return child(files.getCanonicalFile(), "core-instances/" + id);
  }

  private static File state(File home) throws IOException {
    return child(home, "active.json");
  }

  private static File generation(File home, String slot) throws IOException {
    require(
        slot.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"),
        "Invalid generation pointer");
    return child(home, "generations/" + slot);
  }

  private static Map<String, Object> meta(File gen) throws IOException {
    return json(child(gen, "generation.json"));
  }

  private static List<String> selected(Map<String, Object> m) throws IOException {
    List<String> list = new ArrayList<>();
    for (Object id : list(m, "platforms")) {
      require(id instanceof String, "Invalid installed platform");
      list.add((String) id);
    }
    return platforms(list);
  }

  private static File gen(File home, Map<String, Object> s, String key) throws IOException {
    return generation(home, str(s, key));
  }

  private static File app(File gen) throws IOException {
    File a = child(gen, "agent-app");
    require(child(a, ".bot-module.json").isFile(), "Core receipt missing");
    return a;
  }

  public static File active(File files, String id) throws IOException {
    File home = instance(files, id);
    return app(gen(home, json(state(home)), "current"));
  }

  private static File envHome(File files, String hash) throws IOException {
    return child(files.getCanonicalFile(), "core-environments/" + sha(hash));
  }

  public static File environmentRoot(File files, String id) throws IOException {
    return environmentForApp(files, active(files, id));
  }

  public static File environmentForApp(File files, File versionedApp) throws IOException {
    File base = child(files.getCanonicalFile(), "core-instances");
    File a = versionedApp.getCanonicalFile();
    require(
        a.equals(versionedApp.getAbsoluteFile()) && a.toPath().startsWith(base.toPath()),
        "Unmanaged app path");
    java.nio.file.Path rel = base.toPath().relativize(a.toPath());
    require(
        rel.getNameCount() == 4
            && rel.getName(1).toString().equals("generations")
            && rel.getName(3).toString().equals("agent-app"),
        "Invalid instance path");
    File g = generation(instance(files, rel.getName(0).toString()), rel.getName(2).toString());
    require(app(g).equals(a), "Unknown app generation");
    String hash = str(meta(g), "environment");
    File home = envHome(files, hash);
    require(ManagedEnvironment.ready(home, hash), "Missing managed environment");
    return child(home, "rootfs");
  }

  public static String release(File files, String id) throws IOException {
    File home = instance(files, id), g = gen(home, json(state(home)), "current");
    app(g);
    return str(meta(g), "version");
  }

  public static boolean acceptsPortableV1(File files, String id) throws IOException {
    File home = instance(files, id), g = gen(home, json(state(home)), "current");
    Map<String, Object> m = meta(g), r = json(child(app(g), ".bot-module.json"));
    ModuleArchive.row(r);
    return "core".equals(str(r, "id")) && num(m, "abi") == 1 && num(m, "dataSchema") == 1;
  }

  private static final Object[] locks = new Object[32];

  static {
    for (int i = 0; i < locks.length; i++) locks[i] = new Object();
  }

  private static Object lock(File home) {
    return locks[home.hashCode() & 31];
  }

  private static Map<String, Object> metadata(String version, String env, List<String> platforms) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("version", version);
    m.put("abi", 1);
    m.put("dataSchema", 1);
    m.put("environment", env);
    m.put("platforms", platforms);
    return m;
  }

  private static String newGeneration(File home) throws IOException {
    String slot = UUID.randomUUID().toString();
    File g = generation(home, slot);
    mkdir(g.getParentFile());
    require(g.mkdir(), "Cannot allocate generation");
    return slot;
  }

  private void extract(
      Map<String, Object> r, Map<String, Object> a, String id, File target, Progress p)
      throws IOException {
    require(a != null, "No release asset for " + id);
    String base = str(r, "catalogUrl");
    File zip =
        cache.get(
            id,
            base.substring(0, base.lastIndexOf('/') + 1) + str(a, "file"),
            str(a, "sha256"),
            num(a, "bytes"),
            MODULE_LIMIT,
            p);
    ModuleArchive.unpack(zip, a, target);
  }

  /**
   * Existing unchanged modules remain verified and reusable, including when the network is
   * unavailable.
   */
  public Map<String, String> install(
      String id, String version, List<String> wanted, boolean stage, Progress p) throws Exception {
    File home = instance(files, id);
    synchronized (lock(home)) {
      writable(home);
      Map<String, Object> r = row(version), e = env(r);
      Map<String, Map<String, Object>> rows = catalog(r);
      String envHash = str(e, "sha256");
      List<String> requested = platforms(wanted);
      Map<String, Object> s = state(home).isFile() ? json(state(home)) : new LinkedHashMap<>();
      File old = s.containsKey("current") ? gen(home, s, "current") : null;
      Map<String, Object> oldMeta = old == null ? new LinkedHashMap<>() : meta(old);
      boolean same = old != null && version.equals(str(oldMeta, "version"));
      List<String> had = old == null ? new ArrayList<>() : selected(oldMeta);
      require(old == null || same || stage, "Version changes may only be staged for next start");
      File envHome = envHome(files, envHash);
      if (!environment.ready(envHome, envHash)) {
        File archive =
            cache.get("environment", str(e, "url"), envHash, num(e, "bytes"), 4L << 30, p);
        mkdir(envHome);
        environment.prepare(envHome, archive, envHash);
        require(environment.ready(envHome, envHash), "Shared environment not ready");
      }
      Map<String, String> missing = new LinkedHashMap<>();
      if (same
          && new HashSet<>(requested).equals(new HashSet<>(had))
          && !s.containsKey("pending")) {
        verify(old);
        return missing;
      }
      // Same-release additions are monotonic. Do not copy, replace, or even open the existing
      // core/peer payload on retry.
      if (same && !stage && !s.containsKey("pending") && requested.containsAll(had)) {
        File activeApp = app(old);
        for (String platform : requested)
          if (!had.contains(platform)) {
            File tmp = java.nio.file.Files.createTempDirectory(home.toPath(), ".add-").toFile();
            try {
              File destination = ModuleArchive.dir(activeApp, platform);
              Map<String, Object> artifact = rows.get(platform);
              require(artifact != null, "No release asset for " + platform);
              if (destination.exists()) {
                // An interruption between directory rename and metadata commit leaves a complete,
                // verifiable module.
                ModuleArchive.verify(activeApp, platform, null);
                require(
                    str(json(child(destination, ".bot-module.json")), "sha256")
                        .equals(str(artifact, "sha256")),
                    "Unexpected installed plugin");
              } else {
                extract(r, artifact, platform, tmp, p);
                mkdir(destination.getParentFile());
                move(ModuleArchive.dir(tmp, platform), destination);
              }
              List<String> nextSelected = new ArrayList<>(had);
              nextSelected.add(platform);
              save(child(old, "generation.json"), metadata(version, envHash, nextSelected));
              had = nextSelected;
            } catch (IOException ex) {
              missing.put(platform, ex.getMessage());
            } finally {
              erase(tmp);
            }
          }
        return missing;
      }
      String next = newGeneration(home);
      File g = generation(home, next), a = child(g, "agent-app");
      boolean committed = false;
      try {
        if (same) ModuleArchive.verify(app(old), "core", a);
        else extract(r, rows.get("core"), "core", a, p);
        List<String> installed = new ArrayList<>();
        for (String platform : requested) {
          try {
            if (same && had.contains(platform)) ModuleArchive.verify(app(old), platform, a);
            else extract(r, rows.get(platform), platform, a, p);
            installed.add(platform);
          } catch (IOException ex) {
            File partial = ModuleArchive.dir(a, platform);
            erase(partial);
            missing.put(platform, ex.getMessage());
          }
        }
        // Never trade a functioning platform for a failed update. Initial/added plugins can be
        // retried individually.
        for (String hadId : had) if (missing.containsKey(hadId)) return missing;
        if (same && new HashSet<>(installed).equals(new HashSet<>(had)) && !missing.isEmpty())
          return missing;
        save(child(g, "generation.json"), metadata(version, envHash, installed));
        if (stage && old != null) s.put("pending", next);
        else {
          if (old != null) s.put("previous", s.get("current"));
          s.remove("pending");
          s.put("current", next);
        }
        save(state(home), s);
        committed = true;
        return missing;
      } finally {
        if (!committed) erase(g);
      }
    }
  }

  /** The release key selects a catalog; the displayed value is the plugin's own version. */
  public Map<String, String> pluginVersions(String platform, boolean compatibleOnly)
      throws IOException {
    require(ModuleArchive.known(platform) && !platform.equals("core"), "Invalid plugin");
    Map<String, String> out = new LinkedHashMap<>();
    for (String v : versions(false)) {
      Map<String, Object> r = row(v);
      if (!compatible(r)) {
        if (!compatibleOnly) out.put(v, v + " (不兼容)");
        continue;
      }
      Map<String, Object> a = catalog(r).get(platform);
      if (a != null && !out.containsValue(str(a, "version"))) out.put(v, str(a, "version"));
    }
    return out;
  }

  public void stagePlugin(String id, String platform, String pluginRelease, Progress p)
      throws Exception {
    require(ModuleArchive.known(platform) && !platform.equals("core"), "Invalid plugin");
    File home = instance(files, id);
    synchronized (lock(home)) {
      writable(home);
      Map<String, Object> s = json(state(home));
      File base = gen(home, s, s.containsKey("pending") ? "pending" : "current");
      Map<String, Object> m = meta(base);
      List<String> keep = selected(m);
      require(keep.contains(platform), "Plugin is not installed for this instance");
      Map<String, Object> r = row(pluginRelease), artifact = catalog(r).get(platform);
      require(artifact != null, "No release asset for " + platform);
      String slot = newGeneration(home);
      File g = generation(home, slot), a = child(g, "agent-app");
      boolean committed = false;
      try {
        ModuleArchive.verify(app(base), "core", a);
        for (String other : keep)
          if (!other.equals(platform)) ModuleArchive.verify(app(base), other, a);
        extract(r, artifact, platform, a, p);
        save(child(g, "generation.json"), m);
        s.put("pending", slot);
        save(state(home), s);
        committed = true;
      } finally {
        if (!committed) erase(g);
      }
    }
  }

  private static void verify(File g) throws IOException {
    File a = app(g);
    ModuleArchive.verify(a, "core", null);
    for (String id : selected(meta(g))) ModuleArchive.verify(a, id, null);
  }

  public static File onNormalStart(File files, String id) throws IOException {
    File home = instance(files, id);
    synchronized (lock(home)) {
      writable(home);
      Map<String, Object> s = json(state(home));
      boolean switching = s.containsKey("pending");
      File g = gen(home, s, switching ? "pending" : "current");
      verify(g);
      environmentForApp(files, app(g));
      if (switching) {
        s.put("previous", s.get("current"));
        s.put("current", s.remove("pending"));
        save(state(home), s);
      }
      return app(g);
    }
  }

  public static void rollback(File files, String id) throws IOException {
    File home = instance(files, id);
    synchronized (lock(home)) {
      writable(home);
      Map<String, Object> s = json(state(home));
      require(s.containsKey("previous"), "无可安全回退的版本，请先备份");
      File previous = gen(home, s, "previous"), current = gen(home, s, "current");
      Map<String, Object> prior = meta(previous), now = meta(current);
      require(
          num(prior, "dataSchema") == num(now, "dataSchema")
              && num(prior, "abi") == num(now, "abi")
              && new HashSet<>(selected(prior)).equals(new HashSet<>(selected(now))),
          "数据或平台不兼容，请先备份");
      environmentForApp(files, app(previous));
      verify(previous);
      s.put("pending", s.get("previous"));
      save(state(home), s);
    }
  }

  private static File journal(File home) throws IOException {
    return child(home, "maintenance-journal.json");
  }

  private static void writable(File home) throws IOException {
    require(!journal(home).exists(), "请先恢复此核心未完成的维护操作");
  }

  private static void purgeOthers(File keep) {
    File[] dirs = keep.getParentFile().listFiles();
    if (dirs != null)
      for (File d : dirs)
        if (!d.equals(keep))
          try {
            erase(d);
          } catch (IOException ignored) {
            /* GC cannot turn committed metadata into a failed owner transaction. */
          }
  }

  public static String pendingMaintenance(File files, String id) throws IOException {
    File j = journal(instance(files, id));
    return j.exists() ? str(json(j), "operation") : "";
  }

  public static void recoverReset(File files, String id, boolean ownerCommitSucceeded)
      throws Exception {
    File home = instance(files, id);
    synchronized (lock(home)) {
      File j = journal(home);
      if (!j.exists()) return;
      Map<String, Object> m = json(j);
      Map<String, Object> chosen = obj(m.get(ownerCommitSucceeded ? "fresh" : "before"));
      File keep = gen(home, chosen, "current");
      verify(keep);
      save(state(home), chosen);
      if (ownerCommitSucceeded && str(m, "operation").equals("reset")) purgeOthers(keep);
      if (!ownerCommitSucceeded) erase(gen(home, obj(m.get("fresh")), "current"));
      java.nio.file.Files.delete(j.toPath());
    }
  }

  private static void localChange(File files, String id, String removed, Runnable commit)
      throws Exception {
    File home = instance(files, id);
    synchronized (lock(home)) {
      writable(home);
      Map<String, Object> before = json(state(home));
      File current = gen(home, before, "current");
      Map<String, Object> m = meta(current);
      List<String> keep = selected(m);
      if (removed == null) keep.clear();
      else {
        require(ModuleArchive.known(removed) && !removed.equals("core"), "Invalid platform");
        keep.remove(removed);
      }
      String slot = newGeneration(home);
      File g = generation(home, slot), a = child(g, "agent-app"), j = journal(home);
      try {
        ModuleArchive.verify(app(current), "core", a);
        for (String k : keep) ModuleArchive.verify(app(current), k, a);
        save(child(g, "generation.json"), metadata(str(m, "version"), str(m, "environment"), keep));
        Map<String, Object> fresh = new LinkedHashMap<>();
        fresh.put("current", slot);
        Map<String, Object> recovery = new LinkedHashMap<>();
        recovery.put("before", before);
        recovery.put("fresh", fresh);
        recovery.put("operation", removed == null ? "reset" : removed);
        save(j, recovery);
        save(state(home), fresh);
        try {
          commit.run();
        } catch (RuntimeException ex) {
          recoverReset(files, id, false);
          throw ex;
        }
      } catch (Exception ex) {
        if (!j.exists()) erase(g);
        throw ex;
      }
      if (removed == null) purgeOthers(g);
      // If cleanup is interrupted, the durable journal and registry ownership decide recovery, not
      // timestamps.
      j.delete();
    }
  }

  public static void reset(File files, String id, Runnable commitOwner) throws Exception {
    localChange(files, id, null, Objects.requireNonNull(commitOwner));
  }

  public static void removePlatform(File files, String id, String platform, Runnable commitBinding)
      throws Exception {
    localChange(files, id, Objects.requireNonNull(platform), Objects.requireNonNull(commitBinding));
  }

  public static boolean auto(File files) {
    try {
      return child(files.getCanonicalFile(), "core-auto-stage.enabled").isFile();
    } catch (IOException e) {
      return false;
    }
  }

  public static void setAuto(File files, boolean enabled) throws IOException {
    File f = child(files.getCanonicalFile(), "core-auto-stage.enabled");
    if (enabled) atomic(f, new byte[] {1});
    else java.nio.file.Files.deleteIfExists(f.toPath());
  }

  private static final AtomicBoolean scanning = new AtomicBoolean();

  public static void checkAuto(Context ctx) {
    Context app = ctx.getApplicationContext();
    if (!auto(app.getFilesDir()) || !scanning.compareAndSet(false, true)) return;
    new Thread(
            () -> {
              try {
                open(app).autoStage();
              } catch (Exception ex) {
                android.util.Log.w("CoreInstaller", "Automatic release check unavailable");
              } finally {
                scanning.set(false);
              }
            },
            "core-update-check")
        .start();
  }

  void autoStage() throws Exception {
    if (!auto(files)) return;
    File root = child(files, "core-instances");
    File[] homes = root.listFiles();
    if (homes == null) return;
    for (File home : homes) {
      if (!auto(files)) return;
      try {
        synchronized (lock(home)) {
          if (!state(home).isFile())
            continue; // A failed first download is not an installed instance.
          writable(home);
          Map<String, Object> s = json(state(home));
          if (s.containsKey("pending")) continue;
          File g = gen(home, s, "current");
          Map<String, Object> m = meta(g);
          if (!compatible(row(current))) continue;
          if (!current.equals(str(m, "version"))) {
            install(home.getName(), current, selected(m), true, null);
          } else {
            Map<String, Map<String, Object>> latest = catalog(row(current));
            for (String platform : selected(m)) {
              Map<String, Object> available = latest.get(platform);
              Map<String, Object> installed =
                  json(child(ModuleArchive.dir(app(g), platform), ".bot-module.json"));
              if (available != null && !str(available, "sha256").equals(str(installed, "sha256")))
                stagePlugin(home.getName(), platform, current, null);
            }
          }
        }
      } catch (Exception ex) {
        android.util.Log.w("CoreInstaller", "Instance update not staged");
      }
    }
  }
}
