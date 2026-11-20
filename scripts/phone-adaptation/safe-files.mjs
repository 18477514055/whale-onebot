import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class PreflightError extends Error {
  constructor(code) { super(code); this.name = 'PreflightError'; this.code = code; }
}
export function fail(code) { throw new PreflightError(code); }
export function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

// Reject every link/junction ancestor, not just the final file. No recursive
// enumeration and no traversal into a supplied root before it has been checked.
// These checks are not a replacement for an OS sandbox against concurrent hostile
// renames (especially on Windows, where O_NOFOLLOW is unavailable).
export function physicalPath(root, relative, { directory = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f\x7f]/.test(p)) ||
      path.isAbsolute(relative)) fail('UNSAFE_PATH');
  const base = path.resolve(root), target = path.resolve(base, ...relative.split('/'));
  if (!path.relative(base, target) || path.relative(base, target).startsWith('..') ||
      path.isAbsolute(path.relative(base, target))) fail('UNSAFE_PATH');
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) fail('LINK_REJECTED');
    if (i < parts.length - 1 && !info.isDirectory()) fail('UNSAFE_PATH');
    if (i === parts.length - 1 && (directory ? !info.isDirectory() : !info.isFile())) fail('NOT_REGULAR');
  }
  if (path.relative(target, fs.realpathSync(target)) !== '') fail('PHYSICAL_PATH_MISMATCH');
  return target;
}

export function readPhysical(root, relative, maxBytes) {
  const target = physicalPath(root, relative);
  const before = fs.lstatSync(target);
  if (before.nlink !== 1) fail('HARDLINK_REJECTED');
  if (before.size > maxBytes) fail('INPUT_TOO_LARGE');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) fail('INPUT_CHANGED');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('INPUT_CHANGED');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('INPUT_CHANGED');
    // Recheck the path after reading. Concurrent privileged mutation is not a
    // supported threat model; never claim these checks establish UID isolation.
    physicalPath(root, relative);
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function readJson(root, relative, maxBytes) {
  const bytes = readPhysical(root, relative, maxBytes);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON');
  return { value, sha256: digest(bytes) };
}
export function publicError(error) {
  return { schema: 1, status: 'FAILED', code: error instanceof PreflightError ? error.code : 'INPUT_IO_OR_INTERNAL_ERROR',
    deviceConnected: false, targetExecuted: false };
}
