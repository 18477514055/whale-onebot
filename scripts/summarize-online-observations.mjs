import fs from 'node:fs';
import { OnlineObservation } from '../src/host/online-observation.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || !/^\d{1,6}$/.test(args[0]))
  throw new Error('Usage: node scripts/summarize-online-observations.mjs <maxGapMs> <classified-observations.jsonl>');
const maxBytes = 4 * 1024 * 1024;
const fd = fs.openSync(args[1], fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
const input = Buffer.alloc(maxBytes + 1);
let size = 0;
try {
  if (!fs.fstatSync(fd).isFile()) throw new Error('Observation input must be a regular file');
  while (size < input.length) {
    const read = fs.readSync(fd, input, size, input.length - size, null);
    if (read === 0) break;
    size += read;
  }
} finally {
  fs.closeSync(fd);
}
if (size === 0 || size > maxBytes) throw new Error('Observation input outside supported size');
const observations = new OnlineObservation({ maxGapMs: Number(args[0]) });
const lines = input.toString('utf8', 0, size).trimEnd().split('\n');
for (let i = 0; i < lines.length; i++) {
  try {
    const observation = JSON.parse(lines[i]);
    const keys = Object.keys(observation).sort().join(',');
    if (keys !== 'atMs,generation,kind') throw new Error('Unexpected fields');
    observations.record(observation);
  } catch {
    throw new Error(`Invalid observation at line ${i + 1}`);
  }
}
console.log(JSON.stringify(observations.summarize(), null, 2));
