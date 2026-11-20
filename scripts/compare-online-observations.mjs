import fs from 'node:fs';
import { compareOnlineWindows, compareOnlineWindowSeries } from '../src/host/compare-online-windows.mjs';

const paths = process.argv.slice(2);
const series = paths[0] === '--series';
if (series) paths.shift();
if (paths.length < 2 || paths.length > (series ? 32 : 2))
  throw new Error('Usage: compare-online-observations.mjs <whale-window.json> <napcat-window.json> | --series <window.json> <window.json> [...]');
const windows = paths.map(file => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    const { size } = stat;
    if (!stat.isFile() || size < 2 || size > 4 * 1024 * 1024)
      throw new Error('Expected a bounded observation file');
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== size) throw new Error('Observation file changed while reading');
    return JSON.parse(bytes.toString('utf8', 0, size));
  } finally {
    fs.closeSync(fd);
  }
});
console.log(JSON.stringify(series ? compareOnlineWindowSeries(windows) : compareOnlineWindows(...windows), null, 2));
