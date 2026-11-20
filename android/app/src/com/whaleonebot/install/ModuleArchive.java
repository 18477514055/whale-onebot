package com.whaleonebot.install;

import static com.whaleonebot.install.InstallFiles.*;

import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/**
 * Module ZIPs are data: never interpret archive paths as shell commands or extract archive links.
 */
final class ModuleArchive {
  static final String PLUG = "src/platform-modules/";

  static boolean known(String id) {
    return id.equals("core") || id.equals("bilibili") || id.equals("qq");
  }

  static File dir(File app, String id) throws IOException {
    return id.equals("core") ? app : child(app, PLUG + id);
  }

  static void row(Map<String, Object> r) throws IOException {
    String id = str(r, "id"), v = tag(str(r, "version"));
    boolean core = id.equals("core");
    require(
        known(id)
            && num(r, "schemaVersion") == 1
            && num(r, "abi") == 1
            && (core
                ? "null".equals(String.valueOf(r.get("requiresCoreAbi")))
                : num(r, "requiresCoreAbi") == 1)
            && str(r, "kind").equals(core ? "core" : "platform-plugin"),
        "Incompatible module");
    require(
        str(r, "file").equals("bot-" + id + "-" + v + ".zip")
            && num(r, "bytes") > 0
            && num(r, "bytes") <= MODULE_LIMIT,
        "Invalid module asset");
    sha(str(r, "sha256"));
    sha(str(r, "manifestSha256"));
  }

  static void scope(String id, String name) throws IOException {
    require(
        name.length() < 420 && name.matches("[\\p{L}\\p{N}_-][\\p{L}\\p{N}_./-]*"),
        "Invalid payload path");
    for (String part : name.split("/", -1))
      require(
          !part.isEmpty()
              && !part.startsWith(".")
              && !part.endsWith(".")
              && !part.matches("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?")
              && !part.matches("(?i)(node_modules|sessions|data|logs|backups|cache|home)"),
          "Unsafe payload path");
    boolean ok =
        id.equals("core")
            ? (!name.toLowerCase(Locale.ROOT).startsWith(PLUG)
                && (name.matches("LICENSE|THIRD_PARTY_NOTICES\\.md|package\\.json|prices\\.json")
                    || name.matches(
                        "src/.+\\.(js|mjs)|schemas/.+\\.json|(skills|roles)/.+\\.(md|json)|ui/.+\\.(html|css|js|svg|md)")))
            : name.startsWith(PLUG + id + "/")
                && (name.matches(".+\\.(js|mjs|json|md)") || name.endsWith("/LICENSE"));
    require(ok, "Module cannot own this payload path");
  }

  static int u16(byte[] b, int at) {
    return (b[at] & 255) | ((b[at + 1] & 255) << 8);
  }

  static long u32(byte[] b, int at) {
    return u16(b, at) | ((long) u16(b, at + 2) << 16);
  }

  // The packer emits regular Unix files and no ZIP comments/ZIP64/multi-disk records. ZipEntry
  // hides the mode.
  static void checkCentral(File file) throws IOException {
    try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
      long end = in.length() - 22;
      require(end >= 0, "Short ZIP");
      in.seek(end);
      byte[] e = new byte[22];
      in.readFully(e);
      int count = u16(e, 10);
      long pos = u32(e, 16);
      require(
          u32(e, 0) == 0x06054b50
              && u32(e, 4) == 0
              && u16(e, 8) == count
              && u16(e, 20) == 0
              && count > 1
              && count <= 4096
              && pos + u32(e, 12) == end,
          "Invalid ZIP directory");
      in.seek(pos);
      byte[] h = new byte[46];
      for (int i = 0; i < count; i++) {
        in.readFully(h);
        int mode = u16(h, 40), method = u16(h, 10);
        require(
            u32(h, 0) == 0x02014b50
                && (mode & 0170000) == 0100000
                && (u16(h, 8) & 1) == 0
                && (method == 0 || method == 8),
            "Non-regular ZIP member");
        in.seek(in.getFilePointer() + u16(h, 28) + u16(h, 30) + u16(h, 32));
      }
      require(in.getFilePointer() == end, "Invalid ZIP bounds");
    }
  }

  static Map<String, Object> filemap(Map<String, Object> r, byte[] raw) throws IOException {
    MessageDigest d = digest();
    d.update(raw);
    require(hash(d).equals(str(r, "manifestSha256")), "Manifest digest mismatch");
    Map<String, Object> m = parse(raw);
    for (String k :
        Arrays.asList("id", "version", "abi", "kind", "requiresCoreAbi", "schemaVersion"))
      require(
          String.valueOf(m.get(k)).equals(String.valueOf(r.get(k))),
          "Manifest differs from catalog");
    Map<String, Object> files = obj(m.get("files"));
    String id = str(r, "id");
    require(
        !files.isEmpty()
            && files.size() < 4096
            && files.containsKey(
                id.equals("core") ? "src/core/platform-modules.js" : PLUG + id + "/index.mjs"),
        "Incomplete module manifest");
    Set<String> names = new HashSet<>();
    for (String n : files.keySet()) {
      scope(id, n);
      sha(str(files, n));
      require(names.add(n.toLowerCase(Locale.ROOT)), "Case-colliding payload");
    }
    return files;
  }

  static void unpack(File zip, Map<String, Object> r, File app) throws IOException {
    checkCentral(zip);
    try (ZipFile z = new ZipFile(zip)) {
      ZipEntry manifest = z.getEntry("manifest.json");
      require(manifest != null, "Missing module manifest");
      byte[] raw;
      try (InputStream in = z.getInputStream(manifest)) {
        raw = read(in, META_LIMIT);
      }
      Map<String, Object> files = filemap(r, raw);
      require(z.size() == files.size() + 1, "Unexpected ZIP member");
      Set<String> seen = new HashSet<>();
      int remaining = MODULE_LIMIT;
      for (Enumeration<? extends ZipEntry> es = z.entries(); es.hasMoreElements(); ) {
        ZipEntry e = es.nextElement();
        String entry = e.getName();
        require(seen.add(entry) && !e.isDirectory(), "Duplicate/invalid ZIP member");
        if (entry.equals("manifest.json")) continue;
        require(
            entry.startsWith("payload/") && files.containsKey(entry.substring(8)),
            "Unlisted ZIP member");
        String n = entry.substring(8);
        File f = child(app, n);
        require(
            !f.exists() && e.getSize() >= 0 && e.getSize() <= remaining,
            "Oversized or conflicting ZIP member");
        mkdir(f.getParentFile());
        MessageDigest d = digest();
        int count = 0;
        try (InputStream in = z.getInputStream(e);
            OutputStream out =
                Files.newOutputStream(f.toPath(), java.nio.file.StandardOpenOption.CREATE_NEW)) {
          byte[] b = new byte[32768];
          int len;
          while ((len = in.read(b)) != -1) {
            count += len;
            require(count <= remaining && count <= e.getSize(), "ZIP expansion limit");
            d.update(b, 0, len);
            out.write(b, 0, len);
          }
        }
        remaining -= count;
        require(count == e.getSize() && hash(d).equals(str(files, n)), "Payload digest mismatch");
      }
      File receipt = dir(app, str(r, "id"));
      atomic(child(receipt, ".bot-manifest.json"), raw);
      save(child(receipt, ".bot-module.json"), r);
    }
  }

  /** Verify every payload byte and optionally copy to another, physically separate generation. */
  static void verify(File app, String id, File target) throws IOException {
    File root = dir(app, id);
    Map<String, Object> r = json(child(root, ".bot-module.json"));
    row(r);
    require(str(r, "id").equals(id), "Wrong module receipt");
    byte[] raw;
    try (InputStream in = new FileInputStream(child(root, ".bot-manifest.json"))) {
      raw = read(in, META_LIMIT);
    }
    Map<String, Object> files = filemap(r, raw);
    for (String n : files.keySet()) {
      File f = child(app, n);
      require(
          f.isFile() && f.length() <= MODULE_LIMIT && hash(f).equals(str(files, n)),
          "Installed payload changed");
      if (target != null) {
        File dest = child(target, n);
        mkdir(dest.getParentFile());
        Files.copy(f.toPath(), dest.toPath());
      }
    }
    if (target != null) {
      File d = dir(target, id);
      atomic(child(d, ".bot-manifest.json"), raw);
      save(child(d, ".bot-module.json"), r);
    }
  }
}
