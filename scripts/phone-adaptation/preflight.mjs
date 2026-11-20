#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBaseline, validateSnapshot, validateFacts, inspectFixedArtifacts, buildReport } from './core.mjs';
import { readJson, publicError, fail } from './safe-files.mjs';
import { LIMITS } from './constants.mjs';

export const HELP = `Offline phone adaptation preflight (Node24; no device connection)
  node scripts/phone-adaptation/preflight.mjs
  node scripts/phone-adaptation/preflight.mjs --inspect-fixed-artifacts
  node scripts/phone-adaptation/preflight.mjs --with-facts
  node preflight.mjs --snapshot [--with-facts]    (prepared tool-only bundle)

--with-facts reads ONLY inputs/device-facts.json next to this tool.
No arbitrary paths, environment dumps, external commands, target imports or network.
Exit 2 = valid report with deployment BLOCKED/NOT_PROVEN (expected).
Exit 1 = invalid/changed/missing input; diagnostic contains safe error code only.
Exit 0 = help only; this tool cannot authorize deployment.
`;

export function main(args = process.argv.slice(2), { toolRoot = path.dirname(fileURLToPath(import.meta.url)), output = console.log } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { output(HELP); return 0; }
    const allowed = new Set(['--snapshot', '--with-facts', '--inspect-fixed-artifacts']);
    if (args.some(arg => !allowed.has(arg)) || new Set(args).size !== args.length ||
        (args.includes('--snapshot') && args.includes('--inspect-fixed-artifacts'))) fail('INVALID_ARGUMENTS');
    const snapshot = args.includes('--snapshot');
    const projectRoot = path.resolve(toolRoot, '../..');
    const baseline = snapshot ? validateSnapshot(readJson(toolRoot, 'baseline.snapshot.json', LIMITS.json).value) : loadBaseline(projectRoot);
    const facts = args.includes('--with-facts') ? validateFacts(readJson(toolRoot, 'inputs/device-facts.json', 8192).value) : null;
    const artifacts = args.includes('--inspect-fixed-artifacts') ? inspectFixedArtifacts(projectRoot, baseline) : null;
    output(JSON.stringify(buildReport({ baseline, facts, artifacts, snapshot }), null, 2));
    return 2;
  } catch (error) { output(JSON.stringify(publicError(error))); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
