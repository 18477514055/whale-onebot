import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectPE } from './inspect-pe.mjs';

// Static bytes and GNU objdump only. Never load the inspected module.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = 'D:/QQ-Agent/pc-bot-shell/versions/9.9.33-52230/QQNT.dll';
const expected = 'f6f35b8517da5c38ace8d4b6abad1abed42f61c8e706d23192a22d91c7620e59';
const bytes = fs.readFileSync(source);
const pe = inspectPE(bytes);
if (pe.sha256 !== expected || pe.machine !== '0x8664' || pe.format !== 'PE32+') throw new Error('Unreviewed input version');
const peOffset = bytes.readUInt32LE(0x3c), optional = peOffset + 24;
const rva = bytes.readUInt32LE(optional + 112 + 3 * 8);
const size = bytes.readUInt32LE(optional + 112 + 3 * 8 + 4);
function locate(address, length) {
  const section = pe.sections.find(s => address >= s.rva && address + length <= s.rva + s.rawSize);
  if (!section || length < 1) throw new Error('Unmapped file-backed range');
  return section.rawOffset + address - section.rva;
}
if (!size || size % 12 || size > 12_000_000) throw new Error('Unexpected exception directory');
const table = locate(rva, size), functions = [];
for (let off = table; off < table + size; off += 12) {
  const begin = bytes.readUInt32LE(off), end = bytes.readUInt32LE(off + 4), unwind = bytes.readUInt32LE(off + 8);
  if (begin >= end || (functions.length && begin < functions.at(-1).begin)) throw new Error('Invalid runtime function ordering');
  locate(begin, end - begin); locate(unwind, 4);
  functions.push({ begin, end, unwind });
}
const names = new Map(pe.exports.entries.flatMap(entry => entry.names.map(n => [n.name, entry])));
const addressNames = new Map(pe.exports.entries.map(e => [e.addressRva, e.names.map(n => n.name)]));
const wanted = ['?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z', 'qq_magic_napi_register'];
const base = BigInt(pe.imageBase), hex = n => `0x${n.toString(16)}`;
const out = path.join(root, '.tmp', 'native-exports');
fs.mkdirSync(out, { recursive: true });
const reports = [];
for (const name of wanted) {
  const entry = names.get(name);
  if (!entry || entry.kind !== 'address') throw new Error('Missing direct function export');
  const matches = functions.filter(f => entry.addressRva >= f.begin && entry.addressRva < f.end);
  if (matches.length !== 1 || matches[0].begin !== entry.addressRva) throw new Error('Uncertain export boundary');
  const fn = matches[0];
  if (fn.end - fn.begin > 4096) throw new Error('Unexpected function extent');
  const args = ['-d', 'Debian', '--exec', 'objdump', '-d', `--start-address=${hex(base + BigInt(fn.begin))}`, `--stop-address=${hex(base + BigInt(fn.end))}`, '/mnt/d/QQ-Agent/pc-bot-shell/versions/9.9.33-52230/QQNT.dll'];
  const result = spawnSync('wsl', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || !result.stdout.includes('pei-x86-64')) throw new Error('Independent disassembly failed');
  const label = name === 'qq_magic_napi_register' ? 'registration' : 'environment-stopping';
  fs.writeFileSync(path.join(out, label + '.txt'), result.stdout);
  const targets = [...result.stdout.matchAll(/\b(?:call|jmp)\s+(?:0x)?([0-9a-f]+)\b/gi)].map(m => {
    const va = BigInt('0x' + m[1]), relative = Number(va - base);
    return { va: hex(va), exportNames: addressNames.get(relative) ?? [] };
  });
  reports.push({ name, ordinal: entry.ordinal, beginRva: fn.begin, endRva: fn.end, bytes: fn.end - fn.begin,
    beginVa: hex(base + BigInt(fn.begin)), endVa: hex(base + BigInt(fn.end)), unwindRva: fn.unwind,
    functionSha256: createHash('sha256').update(bytes.subarray(locate(fn.begin, fn.end - fn.begin), locate(fn.begin, fn.end - fn.begin) + fn.end - fn.begin)).digest('hex'),
    independentCommand: ['wsl', ...args], directBranchTargets: targets,
    disassemblySha256: createHash('sha256').update(result.stdout).digest('hex') });
}
const report = { at: new Date().toISOString(), source, sha256: pe.sha256, imageBase: pe.imageBase,
  method: 'Original PE export + x64 exception table parser; bounded independent GNU objdump; no target execution',
  exceptionEntries: functions.length, functions: reports,
  limits: ['Static control flow only', 'QQ environment field offset must not be used for stock Node', 'No QQ native loading or account access', 'REA provider decompilation timed out; no decompilation result used'] };
fs.writeFileSync(path.join(root, 'evidence', 'native-exports.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
