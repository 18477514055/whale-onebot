#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, runMonitor } from './drop-monitor-io.mjs';

// Only the project containing THIS script is eligible. No caller-supplied root,
// process ID, health URL, profile, command, credential or control input.
try {
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '24')
    throw new Error('MONITOR_LINUX_NODE24_REQUIRED');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (await fs.realpath(root) !== root || path.basename(root) !== 'qq-onebot')
    throw new Error('MONITOR_PROJECT_REQUIRED');
  const options = parseOptions(process.argv.slice(2), root);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const final = await runMonitor({ root, ...options, signal: controller.signal,
      onSample: sample => process.stdout.write(JSON.stringify(sample) + '\n') });
    if (final.terminalCode === 'BINDING_REJECTED') process.exitCode = 2;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
} catch {
  // Never print exception text, argv, responses, paths, environment or credentials.
  process.stderr.write('MONITOR_SETUP_OR_IO_FAILED\n');
  process.exitCode = 2;
}
