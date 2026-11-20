#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUNDLE_FILES, LIMITS } from './constants.mjs';
import { loadBaseline } from './core.mjs';
import { readPhysical, physicalPath, digest, publicError, fail } from './safe-files.mjs';

// Original-source allowlist only, never recursively copy a project/tree. The
// resulting folder is a portable preflight kit, NOT an APK/QQ/OneBot runtime.
export function prepare({ toolRoot = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const baseline = loadBaseline(path.resolve(toolRoot, '../..'));
  const files = BUNDLE_FILES.map(name => ({ name, bytes: readPhysical(toolRoot, name, LIMITS.json) }));
  files.push({ name: 'baseline.snapshot.json', bytes: Buffer.from(JSON.stringify(baseline, null, 2) + '\n') });
  // Validate ancestors without creating any output until inputs are fully read.
  physicalPath(toolRoot, 'preflight.mjs');
  const parent = path.join(toolRoot, 'prepared');
  try { fs.mkdirSync(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  physicalPath(toolRoot, 'prepared', { directory: true });
  const destination = fs.mkdtempSync(path.join(parent, 'bundle-'));
  physicalPath(toolRoot, `prepared/${path.basename(destination)}`, { directory: true });
  const manifest = { schema: 1, kind: 'tool-only-no-runtime-no-secrets', targetExecuted: false,
    deployable: false, containsQq: false, containsNode: false, containsBusinessData: false,
    integrityScope: 'local-content-digests-not-signatures',
    files: files.map(({ name, bytes }) => ({ name, bytes: bytes.length, sha256: digest(bytes) })) };
  for (const file of [...files, { name: 'bundle.manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }]) {
    // All names are constants, destination is fresh, and clobber is forbidden.
    physicalPath(toolRoot, `prepared/${path.basename(destination)}`, { directory: true });
    fs.writeFileSync(path.join(destination, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    if (digest(readPhysical(destination, file.name, LIMITS.json)) !== digest(file.bytes)) fail('BUNDLE_READBACK_FAILED');
  }
  return { schema: 1, status: 'PREPARED_TOOL_ONLY', deploymentAllowed: false,
    directory: `scripts/phone-adaptation/prepared/${path.basename(destination)}`,
    fileCount: files.length + 1, deviceConnected: false, targetExecuted: false };
}
export function main(args = process.argv.slice(2), output = console.log) {
  try {
    if (args.length) fail('INVALID_ARGUMENTS');
    output(JSON.stringify(prepare(), null, 2)); return 0;
  } catch (error) { output(JSON.stringify(publicError(error))); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
