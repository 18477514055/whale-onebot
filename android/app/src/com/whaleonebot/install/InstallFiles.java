package com.whaleonebot.install;

import com.whaleonebot.ui.InstallerJson;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/**
 * All installer paths are rooted in the private canonical files directory, never external storage.
 */
final class InstallFiles {
  static final int MODULE_LIMIT = 32 << 20, META_LIMIT = 1 << 20;

  static void require(boolean condition, String message) throws IOException {
    if (!condition) throw new IOException(message);
  }

  static File child(File root, String name) throws IOException {
    require(!name.isEmpty() && !new File(name).isAbsolute(), "Invalid private path");
    File f = new File(root, name).getAbsoluteFile();
    require(
        f.getCanonicalFile().equals(f) && f.toPath().startsWith(root.toPath()),
        "Noncanonical or linked private path");
    return f;
  }

  static void mkdir(File dir) throws IOException {
    require(
        dir.isDirectory() || dir.mkdirs() || dir.isDirectory(), "Cannot create private directory");
  }

  static String sha(String s) throws IOException {
    require(s.matches("[a-f0-9]{64}"), "Invalid SHA-256 pin");
    return s;
  }

  static String tag(String s) throws IOException {
    require(s.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}"), "Invalid release identifier");
    return s;
  }

  static String hash(MessageDigest d) {
    char[] out = new char[64];
    byte[] b = d.digest();
    String digits = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
      out[2 * i] = digits.charAt((b[i] & 255) >>> 4);
      out[2 * i + 1] = digits.charAt(b[i] & 15);
    }
    return new String(out);
  }

  static MessageDigest digest() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (Exception e) {
      throw new AssertionError(e);
    }
  }

  static String hash(File f) throws IOException {
    MessageDigest d = digest();
    try (InputStream in = new FileInputStream(f)) {
      byte[] buf = new byte[65536];
      int n;
      while ((n = in.read(buf)) != -1) d.update(buf, 0, n);
    }
    return hash(d);
  }

  static byte[] read(InputStream in, int limit) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] b = new byte[8192];
    int n;
    while ((n = in.read(b)) != -1) {
      require(out.size() + n <= limit, "Metadata exceeds limit");
      out.write(b, 0, n);
    }
    return out.toByteArray();
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> obj(Object o) throws IOException {
    require(o instanceof Map, "Expected JSON object");
    return (Map<String, Object>) o;
  }

  static Map<String, Object> parse(byte[] b) throws IOException {
    return obj(InstallerJson.parse(new String(b, StandardCharsets.UTF_8)));
  }

  static Map<String, Object> json(File f) throws IOException {
    try (InputStream in = new FileInputStream(f)) {
      return parse(read(in, META_LIMIT));
    }
  }

  static String str(Map<String, Object> m, String k) throws IOException {
    Object v = m.get(k);
    require(v instanceof String, "Missing field: " + k);
    return (String) v;
  }

  static long num(Map<String, Object> m, String k) throws IOException {
    try {
      return Long.parseLong(String.valueOf(m.get(k)));
    } catch (NumberFormatException e) {
      throw new IOException("Invalid integer: " + k);
    }
  }

  static List<?> list(Map<String, Object> m, String k) throws IOException {
    Object v = m.get(k);
    require(v instanceof List, "Missing array: " + k);
    return (List<?>) v;
  }

  static void atomic(File f, byte[] b) throws IOException {
    mkdir(f.getParentFile());
    File tmp = File.createTempFile(".write-", ".tmp", f.getParentFile());
    try {
      try (FileOutputStream out = new FileOutputStream(tmp)) {
        out.write(b);
        out.getFD().sync();
      }
      move(tmp, f);
    } finally {
      tmp.delete();
    }
  }

  static void save(File f, Map<String, Object> m) throws IOException {
    atomic(f, InstallerJson.write(m).getBytes(StandardCharsets.UTF_8));
  }

  static void move(File src, File dst) throws IOException {
    Files.move(
        src.toPath(),
        dst.toPath(),
        StandardCopyOption.ATOMIC_MOVE,
        StandardCopyOption.REPLACE_EXISTING);
  }

  static void erase(File f) throws IOException {
    if (Files.isDirectory(f.toPath(), LinkOption.NOFOLLOW_LINKS)) {
      File[] kids = f.listFiles();
      require(kids != null, "Unreadable directory");
      for (File kid : kids) erase(kid);
    }
    Files.deleteIfExists(f.toPath());
  }
}
