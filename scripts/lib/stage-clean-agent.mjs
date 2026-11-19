import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DIRECTORIES = Object.freeze(['src', 'roles', 'ui']);
const REQUIRED_FILES = Object.freeze(['package.json', 'package-lock.json', 'LICENSE']);
export const STAGE_CLEAN_AGENT_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 10000,
  maxDepth: 64,
});
const DENIED_DIRECTORY = /^(?:\.git|\.tmp|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.config|\.cache|node_modules|data|config|database|databases|sessions?|storages?|credentials?|secrets?|logs?|history|backups?|historical)(?:$|[._-])/i;
const DENIED_FILE = /(?:^\.env|^\.(?:npmrc|yarnrc|netrc|pypirc|htpasswd)(?:$|[.-])|\.(?:sqlite\d*(?:-(?:wal|shm|journal))?|db\d*(?:-(?:wal|shm|journal))?|wal|shm|pem|key|p12|pfx|crt|cer|der|jks|keystore|exe|dll|so|dylib|node|asar|zip|tar|gz|bak|old|backup)$|^(?:id_rsa|id_ed25519)(?:$|[._-])|^(?:credentials?|secrets?|cookies?|tokens?|passwords?)$|^(?:config(?:uration)?|data|databases?|accounts?|sessions?|credentials?|secrets?|cookies?|tokens?|passwords?)(?:[._-].*)?\.(?:json5?|jsonl|ndjson|ya?ml|toml|ini|conf)$)/i;
const DENIED_HISTORY_INSTANCE = /^(?:history|chat[._-]history|messages?|transcripts?|conversations?|chat[._-]?logs?)(?:[._-].*)?\.(?:json5?|jsonl|ndjson|sqlite\d*|db\d*|txt)$/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const samePath = (a, b) => path.relative(a, b) === '';
const fingerprint = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const identity = stat => [stat.dev, stat.ino, stat.mode].join(':');

/**
 * Synchronous, source-only copy. Never imports, executes or installs source code.
 * All three source directories and all three root files are mandatory.
 * appRoot is an explicitly supplied read-only source (it may be
 * outside projectRoot); outputDir must be inside projectRoot/.tmp.
 * Only allowlisted source directories are enumerated, never the source root.
 * Errors expose a fixed code plus an optional allowlist-relative filename only.
 * Failed runs deliberately retain their newly-created partial directories as
 * evidence: no recursive deletion can touch a directory somebody else swapped.
 * Checks detect observed path/content changes; as with portable node:fs pathname
 * APIs, this is not a sandbox against a privileged concurrent filesystem attacker.
 */
export function stageCleanAgent({ projectRoot, appRoot, outputDir } = {}) {
  let createdOutput = false;
  const directoryPins = new Map();
  const fail = (code, file) => {
    const error = new Error(file ? `${code}: ${file}` : code);
    error.code = code;
    if (file) error.file = file;
    error.evidenceRetained = createdOutput;
    throw error;
  };
  const safeName = name => typeof name === 'string' && name !== '.' && name !== '..'
    && !/[\\/:\x00-\x1f\x7f]/u.test(name) && !/[. ]$/u.test(name);
  const normalize = value => {
    if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) fail('STAGE_INVALID_ARGUMENT');
    return path.resolve(value);
  };
  const metadata = (absolute, file) => {
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink()) fail('STAGE_LINK', file);
    if (!samePath(fs.realpathSync.native(absolute), absolute)) fail('STAGE_PHYSICAL_PATH', file);
    const after = fs.lstatSync(absolute, { bigint: true });
    // Ancestor timestamps can change when another owned staging/test directory
    // is created alongside us. Pin directory identity here, not its contents;
    // visitDirectory/verify separately guard directories actually enumerated.
    const stable = stat.isDirectory() ? identity : fingerprint;
    if (stable(after) !== stable(stat)) fail('STAGE_CHANGED', file);
    if (stat.isDirectory()) {
      if (directoryPins.has(absolute) && directoryPins.get(absolute) !== identity(stat)) fail('STAGE_DIRECTORY_CHANGED', file);
      directoryPins.set(absolute, identity(stat));
    }
    return stat;
  };
  // Ancestors are metadata-only checks; no directory enumeration or file reads.
  const chain = (absolute, file) => {
    const root = path.parse(absolute).root;
    let current = root;
    let stat = metadata(current, file);
    if (!stat.isDirectory()) fail('STAGE_DIRECTORY_REQUIRED', file);
    for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      stat = metadata(current, file);
      if (!stat.isDirectory()) fail('STAGE_DIRECTORY_REQUIRED', file);
    }
    return stat;
  };
  const fileStat = (absolute, file) => {
    chain(path.dirname(absolute), file);
    const stat = metadata(absolute, file);
    if (!stat.isFile()) fail('STAGE_FILE_REQUIRED', file);
    if (stat.nlink !== 1n) fail('STAGE_HARDLINK', file);
    if (stat.size > BigInt(STAGE_CLEAN_AGENT_LIMITS.maxFileBytes)) fail('STAGE_FILE_LIMIT', file);
    return stat;
  };
  const readStable = (absolute, file, remainingBytes = STAGE_CLEAN_AGENT_LIMITS.maxFileBytes) => {
    const before = fileStat(absolute, file);
    if (before.size > BigInt(remainingBytes)) fail('STAGE_TOTAL_LIMIT', file);
    let fd;
    try {
      fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd, { bigint: true });
      if (fingerprint(opened) !== fingerprint(before) || !opened.isFile() || opened.nlink !== 1n) fail('STAGE_CHANGED', file);
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (count === 0) fail('STAGE_CHANGED', file);
        offset += count;
      }
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail('STAGE_CHANGED', file);
      if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== fingerprint(before)
        || fingerprint(fileStat(absolute, file)) !== fingerprint(before)) fail('STAGE_CHANGED', file);
      return { bytes, stat: before };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  const checkEntry = (name, directory, file) => {
    if (!safeName(name)) fail('STAGE_UNSAFE_NAME');
    if (DENIED_FILE.test(name) || DENIED_HISTORY_INSTANCE.test(name)
      || (directory && DENIED_DIRECTORY.test(name))) fail('STAGE_FORBIDDEN_ENTRY', file);
  };
  const sourceSnapshot = root => {
    const files = [];
    const directories = [];
    let entries = 0;
    let totalBytes = 0;
    const countEntry = file => { if (++entries > STAGE_CLEAN_AGENT_LIMITS.maxEntries) fail('STAGE_ENTRY_LIMIT', file); };
    const visitFile = file => {
      countEntry(file);
      const { bytes, stat } = readStable(path.join(root, ...file.split('/')), file, STAGE_CLEAN_AGENT_LIMITS.maxTotalBytes - totalBytes);
      totalBytes += bytes.length;
      if (totalBytes > STAGE_CLEAN_AGENT_LIMITS.maxTotalBytes) fail('STAGE_TOTAL_LIMIT', file);
      files.push({ path: file, bytes: bytes.length, sha256: sha256(bytes), fingerprint: fingerprint(stat), content: bytes });
    };
    const visitDirectory = (file, depth) => {
      countEntry(file);
      if (depth > STAGE_CLEAN_AGENT_LIMITS.maxDepth) fail('STAGE_DEPTH_LIMIT', file);
      const absolute = path.join(root, ...file.split('/'));
      const before = chain(absolute, file);
      const names = fs.readdirSync(absolute).sort(compare);
      if (entries + names.length > STAGE_CLEAN_AGENT_LIMITS.maxEntries) fail('STAGE_ENTRY_LIMIT', file);
      directories.push({ path: file, fingerprint: fingerprint(before), names });
      for (const name of names) {
        checkEntry(name, false, safeName(name) ? `${file}/${name}` : undefined);
        const child = `${file}/${name}`;
        const stat = metadata(path.join(absolute, name), child);
        if (stat.isDirectory()) {
          checkEntry(name, true, child);
          visitDirectory(child, depth + 1);
        }
        else if (stat.isFile()) visitFile(child);
        else fail('STAGE_SPECIAL_FILE', child);
      }
      if (fingerprint(chain(absolute, file)) !== fingerprint(before)) fail('STAGE_CHANGED', file);
    };
    for (const directory of DIRECTORIES) visitDirectory(directory, 1);
    for (const file of REQUIRED_FILES) visitFile(file);
    files.sort((a, b) => compare(a.path, b.path));
    directories.sort((a, b) => compare(a.path, b.path));
    return { files, directories, totalBytes };
  };
  const descriptor = snapshot => JSON.stringify({
    files: snapshot.files.map(({ content, ...file }) => file), directories: snapshot.directories,
  });
  try {
    const project = normalize(projectRoot);
    const source = normalize(appRoot);
    const output = normalize(outputDir);
    if (!inside(path.join(project, '.tmp'), output)) fail('STAGE_OUTPUT_OUTSIDE_TMP');
    for (const directory of DIRECTORIES) {
      const tree = path.join(source, directory);
      if (samePath(tree, output) || inside(tree, output)) fail('STAGE_SOURCE_OUTPUT_OVERLAP');
    }
    chain(project);
    const sourceIdentity = identity(chain(source));
    // Check the output's existing parent chain before reading any source bytes.
    const components = path.relative(project, output).split(path.sep);
    let current = project;
    let missing = false;
    for (const component of components) {
      current = path.join(current, component);
      if (missing) continue;
      try {
        const stat = metadata(current);
        if (samePath(current, output)) fail('STAGE_OUTPUT_EXISTS');
        if (!stat.isDirectory()) fail('STAGE_DIRECTORY_REQUIRED');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true;
      }
    }
    const snapshot = sourceSnapshot(source);
    const publicFiles = snapshot.files.map(({ path: file, bytes, sha256: hash }) => ({ path: file, bytes, sha256: hash }));
    const sourceHash = sha256(JSON.stringify(publicFiles));
    const manifest = {
      schemaVersion: 1,
      source: {
        kind: 'allowlisted-source-only', directories: [...DIRECTORIES], requiredFiles: [...REQUIRED_FILES],
        oldDataInputs: 'none', dependenciesCopied: false, sourceExecuted: false,
      },
      files: publicFiles, sourceHash, filesCount: publicFiles.length, totalBytes: snapshot.totalBytes,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > STAGE_CLEAN_AGENT_LIMITS.maxFileBytes) fail('STAGE_MANIFEST_LIMIT');
    const ownedDirectories = new Map();
    current = project;
    for (const component of components) {
      chain(current);
      current = path.join(current, component);
      try {
        const stat = metadata(current);
        if (samePath(current, output)) fail('STAGE_OUTPUT_EXISTS');
        if (!stat.isDirectory()) fail('STAGE_DIRECTORY_REQUIRED');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        chain(path.dirname(current));
        fs.mkdirSync(current, { mode: 0o700 });
        if (samePath(current, output)) createdOutput = true;
        const stat = chain(current);
        ownedDirectories.set(current, identity(stat));
      }
    }
    const outputIdentity = identity(chain(output));
    const checkOutput = absolute => {
      chain(absolute);
      if (identity(chain(output)) !== outputIdentity) fail('STAGE_TARGET_CHANGED');
      for (const [directory, expected] of ownedDirectories) {
        if (identity(chain(directory)) !== expected) fail('STAGE_TARGET_CHANGED');
      }
    };
    for (const directory of [...snapshot.directories].sort((a, b) => a.path.split('/').length - b.path.split('/').length || compare(a.path, b.path))) {
      const absolute = path.join(output, ...directory.path.split('/'));
      checkOutput(path.dirname(absolute));
      fs.mkdirSync(absolute, { mode: 0o700 });
      ownedDirectories.set(absolute, identity(chain(absolute, directory.path)));
    }
    const writeExclusive = (file, bytes) => {
      const absolute = path.join(output, ...file.split('/'));
      checkOutput(path.dirname(absolute));
      let fd;
      try {
        fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n) fail('STAGE_TARGET_CHANGED', file);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count === 0) fail('STAGE_TARGET_CHANGED', file);
          offset += count;
        }
        fs.fsyncSync(fd);
        const after = fs.fstatSync(fd, { bigint: true });
        if (after.nlink !== 1n || identity(after) !== identity(before) || after.size !== BigInt(bytes.length)) fail('STAGE_TARGET_CHANGED', file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      checkOutput(path.dirname(absolute));
      const actual = readStable(absolute, file).bytes;
      if (!actual.equals(bytes)) fail('STAGE_TARGET_CHANGED', file);
    };
    for (const file of snapshot.files) writeExclusive(file.path, file.content);
    writeExclusive('staging-manifest.json', manifestBytes);
    const next = sourceSnapshot(source);
    if (identity(chain(source)) !== sourceIdentity || descriptor(next) !== descriptor(snapshot)) fail('STAGE_SOURCE_CHANGED');
    const expectedFiles = new Map([...snapshot.files.map(file => [file.path, file.content]), ['staging-manifest.json', manifestBytes]]);
    const expectedDirectories = new Set(snapshot.directories.map(directory => directory.path));
    const seenFiles = new Set();
    const seenDirectories = new Set();
    const verify = (absolute, relative = '') => {
      checkOutput(absolute);
      const before = chain(absolute, relative || undefined);
      const names = fs.readdirSync(absolute).sort(compare);
      for (const name of names) {
        if (!safeName(name)) fail('STAGE_TARGET_EXTRA');
        const file = relative ? `${relative}/${name}` : name;
        const child = path.join(absolute, name);
        const stat = metadata(child, file);
        if (stat.isDirectory()) {
          if (!expectedDirectories.has(file)) fail('STAGE_TARGET_EXTRA', file);
          seenDirectories.add(file);
          verify(child, file);
        } else {
          if (!expectedFiles.has(file)) fail('STAGE_TARGET_EXTRA', file);
          const actual = readStable(child, file).bytes;
          if (!actual.equals(expectedFiles.get(file))) fail('STAGE_TARGET_CHANGED', file);
          seenFiles.add(file);
        }
      }
      if (fingerprint(chain(absolute)) !== fingerprint(before)) fail('STAGE_TARGET_CHANGED');
    };
    verify(output);
    if (seenFiles.size !== expectedFiles.size || seenDirectories.size !== expectedDirectories.size) fail('STAGE_TARGET_MISSING');
    checkOutput(output);
    return { outputDir: output, manifest, filesCount: manifest.filesCount, totalBytes: manifest.totalBytes, sourceHash, verified: true };
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('STAGE_')) throw error;
    // Never leak native errors: they often contain absolute paths or user data.
    fail(error?.code === 'ENOENT' ? 'STAGE_REQUIRED_PATH_MISSING' : error?.code === 'EEXIST' ? 'STAGE_OUTPUT_CONFLICT' : 'STAGE_IO');
  }
}
