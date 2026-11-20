// Static inspection only. GNU ar/tar/readelf/objdump are the parsers.
// Never invokes the package, its scripts, wrapper.node, ldd or a dynamic loader.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const arm64 = process.argv[2] === '--arm64';
if (process.argv.length !== (arm64 ? 4 : 2)) throw new Error('Usage: inspect-linux-abi.mjs [--arm64 <local archive>]');
const toolsRoot = path.join(project, '.tools');
const archive = arm64 ? path.resolve(process.argv[3]) : path.join(toolsRoot, 'qq-linux-inspection', 'QQ_3.2.35_261103_amd64_01.deb');
if (arm64 && (path.dirname(path.dirname(archive)) !== toolsRoot || !/^qq-linux-arm64-[a-f0-9]{32}$/.test(path.basename(path.dirname(archive))) ||
    path.basename(archive) !== 'qq-arm64-complete.deb' || fs.realpathSync(archive) !== archive)) throw new Error('Expected a local ARM64 archive');
const sampleRoot = arm64 ? fs.mkdtempSync(path.join(toolsRoot, 'qq-linux-arm64-inspection-')) : path.dirname(archive);
const nodeFile = path.join(toolsRoot, `node-v24.20.0-linux-${arm64 ? 'arm64' : 'x64'}`, 'bin', 'node');
const expectedBytes = arm64 ? 208717176 : 188287504;
const expectedSha256 = arm64 ? undefined : '7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac';
const source = `https://qqdl.gtimg.cn/qqfile/qqntv2/9.9.37/release/816b3c79/QQ_3.2.35_261103_${arm64 ? 'arm64' : 'amd64'}_01.deb`;
const reference = 'https://github.com/NapukettoDev/NapukettoQQ/blob/f20ed97c136e055cbe13c77545b976bfbd14e6d3/packages/loader/qq-releases.json';
const commands = [];
function linuxPath(value) {
  if (process.platform === 'linux') return value;
  if (!/^[A-Za-z]:\\/.test(value)) throw new Error('Expected absolute Windows path');
  return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}`;
}
function run(program, args, options = {}) {
  const invocation = process.platform === 'win32' ? ['wsl.exe', ['-d', 'Debian', '--', 'env', 'LC_ALL=C', program, ...args]] : [program, args];
  const record = { program: invocation[0], args: invocation[1], stdoutFile: options.outputFile ? path.relative(project, options.outputFile).replaceAll('\\','/') : null };
  commands.push(record);
  let outputFd;
  if (options.outputFile) {
    if (fs.existsSync(options.outputFile) && fs.lstatSync(options.outputFile).isSymbolicLink()) throw new Error('Refusing linked extraction destination');
    outputFd = fs.openSync(options.outputFile, 'w');
  }
  let result;
  try { result = spawnSync(invocation[0], invocation[1], { encoding: 'utf8', stdio: outputFd === undefined ? 'pipe' : ['ignore', outputFd, 'pipe'], maxBuffer: 128 * 1024 * 1024, timeout: 240000, env: { ...process.env, LC_ALL: 'C' } }); }
  finally { if (outputFd !== undefined) fs.closeSync(outputFd); }
  record.status = result.status;
  record.stderr = result.stderr;
  if (result.error || result.status !== 0) throw new Error(`Static tool failed: ${program}; status=${result.status}; ${String(result.stderr).slice(0,1000)}`);
  return result.stdout;
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function save(name, data) {
  const destination = path.join(sampleRoot, name);
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Refusing linked evidence destination');
  fs.writeFileSync(destination, data);
}
function symbols(raw) {
  const rows = [];
  let declared;
  for (const line of raw.split('\n')) {
    const table = line.match(/^Symbol table '\.dynsym' contains (\d+) entries:/);
    if (table) declared = Number(table[1]);
    if (!/^\s*\d+:/.test(line)) continue;
    const fields = line.match(/^\s*(\d+):\s+([0-9a-fA-F]+)\s+(\S+)\s+(.+?)\s+(GLOBAL|LOCAL|WEAK|UNIQUE|<OS specific>:\s+\d+)\s+(DEFAULT|INTERNAL|HIDDEN|PROTECTED)\s+(\S+)(?:\s+(\S+))?/);
    if (!fields) throw new Error('Unexpected GNU readelf symbol row');
    const name = fields[8] ?? '';
    rows.push({ index: Number(fields[1]), value: fields[2], size: fields[3], type: fields[4], binding: fields[5], visibility: fields[6], section: fields[7], name, baseName: name.split('@')[0] });
  }
  if (!declared || rows.length !== declared) throw new Error('Incomplete GNU dynamic symbol output');
  return rows;
}

if (fs.realpathSync(sampleRoot) !== sampleRoot) throw new Error('Research directory must be physical');
if (fs.statSync(archive).size !== expectedBytes) throw new Error('Official package is incomplete or has unexpected length');
const archiveDigest = await digest(archive);
if (expectedSha256 && archiveDigest !== expectedSha256) throw new Error('Official package digest differs from fixed manifest');
const packagePath = linuxPath(archive);
const arMembers = run('ar', ['t', packagePath]);
save('ar-members.txt', arMembers);
if (!arMembers.split(/\r?\n/).includes('data.tar.xz')) throw new Error('Expected Debian data archive missing');
// Direct tool arguments avoid Windows -> WSL shell quoting. Intermediate data
// archive is analysis-only and removed once GNU tar completes extraction.
const dataArchive = path.join(sampleRoot, 'data.tar.xz');
run('ar', ['p', packagePath, 'data.tar.xz'], { outputFile: dataArchive });
const listing = run('tar', ['--list', '--xz', '--verbose', '--file=' + linuxPath(dataArchive)]);
save('package-listing.txt', listing);
const wrapperMember = './opt/QQ/resources/app/wrapper.node';
const matching = listing.split('\n').filter(line => line.endsWith(' ' + wrapperMember));
if (matching.length !== 1 || matching[0][0] !== '-') throw new Error('Expected exactly one regular wrapper member');
const wrapper = path.join(sampleRoot, 'wrapper.node');
run('tar', ['--extract', '--xz', '--to-stdout', '--file=' + linuxPath(dataArchive), '--', wrapperMember], { outputFile: wrapper });
fs.unlinkSync(dataArchive);
const wrapperPath = linuxPath(wrapper), nodePath = linuxPath(nodeFile);
const raw = {};
for (const [label, target] of [['wrapper', wrapperPath], ['node', nodePath]]) {
  raw[label] = {};
  for (const [kind, args] of [['header', ['--file-header']], ['dynamic', ['--dynamic']], ['dynsym', ['--dyn-syms', '--wide']], ['versions', ['--version-info', '--wide']]]) {
    raw[label][kind] = run('readelf', [...args, target]);
    save(`${label}-${kind}.txt`, raw[label][kind]);
  }
}
const machine = arm64 ? 'AArch64' : 'Advanced Micro Devices X86-64';
for (const target of [raw.wrapper, raw.node]) {
  if (!new RegExp(`Machine:\\s+${machine}`, 'm').test(target.header)) throw new Error('Unexpected ELF machine');
}
let objdump, objdumpSymbols;
if (!arm64) {
  objdump = run('objdump', ['-p', wrapperPath]);
  save('wrapper-objdump-private.txt', objdump);
  objdumpSymbols = run('objdump', ['-T', wrapperPath]);
  save('wrapper-objdump-dynsym.txt', objdumpSymbols);
}
const wrapperSymbols = symbols(raw.wrapper.dynsym), nodeSymbols = symbols(raw.node.dynsym);
const undefinedSymbols = wrapperSymbols.filter(row => row.section === 'UND' && row.name);
if (objdumpSymbols) {
  const objdumpUndefined = objdumpSymbols.split('\n').filter(line => line.includes('*UND*')).map(line => line.trim().split(/\s+/).at(-1)).sort();
  if (JSON.stringify(objdumpUndefined) !== JSON.stringify(undefinedSymbols.map(row => row.baseName).sort())) throw new Error('GNU readelf and objdump disagree on undefined symbol names');
}
const nodeExports = nodeSymbols.filter(row => row.section !== 'UND' && row.name && ['GLOBAL', 'WEAK', 'UNIQUE'].includes(row.binding) && ['DEFAULT', 'PROTECTED'].includes(row.visibility));
const exportsByBase = new Map();
for (const row of nodeExports) { const list = exportsByBase.get(row.baseName) ?? []; list.push(row.name); exportsByBase.set(row.baseName, list); }
const matches = undefinedSymbols.map(row => {
  const candidates = exportsByBase.get(row.baseName) ?? [];
  const requirement = row.name.includes('@') ? row.name.split('@').pop() : null;
  const satisfied = candidates.some(name => requirement ? name.split('@').pop() === requirement : (!name.includes('@') || name.includes('@@')));
  return { ...row, nodeCandidates: candidates, providedByNodeSymbolTable: satisfied };
});
const hostCandidates = matches.filter(row => /^(?:napi_|node_api_|uv_|qq_|_ZN4node|_ZN2v8)/.test(row.baseName));
const needed = [...raw.wrapper.dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(x => x[1]);
if (objdump) {
  const objdumpNeeded = [...objdump.matchAll(/^\s+NEEDED\s+(\S+)\s*$/gm)].map(x => x[1]);
  if (JSON.stringify(needed) !== JSON.stringify(objdumpNeeded)) throw new Error('GNU readelf and objdump disagree on dependencies');
}
const runpath = [...raw.wrapper.dynamic.matchAll(/\((?:RUNPATH|RPATH)\).*?\[([^\]]+)\]/g)].map(x => x[1]);
const rawHashes = {};
for (const filename of fs.readdirSync(sampleRoot).filter(name => name.endsWith('.txt'))) rawHashes[filename] = await digest(path.join(sampleRoot, filename));
const report = {
  schema: 1, observedAt: new Date().toISOString(), mode: 'static-only-no-target-execution', machine,
  archive: { source, bytes: expectedBytes, sha256: archiveDigest, expectedSha256Source: arm64 ? null : reference },
  wrapper: { archiveMember: wrapperMember, bytes: fs.statSync(wrapper).size, sha256: await digest(wrapper), needed, runpath, dynamicSymbolCount: wrapperSymbols.length, undefinedCount: undefinedSymbols.length },
  node: { path: path.relative(project, nodeFile).replaceAll('\\','/'), sha256: await digest(nodeFile), bytes: fs.statSync(nodeFile).size, dynamicSymbolCount: nodeSymbols.length, exportedCount: nodeExports.length },
  comparison: { readelfObjdumpUndefinedNamesAgree: arm64 ? null : true, readelfObjdumpDependenciesAgree: arm64 ? null : true, providedByNodeCount: matches.filter(x=>x.providedByNodeSymbolTable).length, notProvidedByNodeCount: matches.filter(x=>!x.providedByNodeSymbolTable).length, hostCandidatePrefixHeuristic: 'napi_|node_api_|uv_|qq_|_ZN4node|_ZN2v8', hostCandidates, undefinedSymbols: matches },
  tools: { readelf: run('readelf', ['--version']).split('\n')[0], objdump: arm64 ? null : run('objdump', ['--version']).split('\n')[0], ar: run('ar', ['--version']).split('\n')[0], tar: run('tar', ['--version']).split('\n')[0] },
  rawEvidenceDirectory: path.relative(project, sampleRoot).replaceAll('\\', '/'), rawEvidenceSha256: rawHashes, commands,
  limitations: ['No package installation, maintainer script, QQ, native module or dynamic loader was executed.', 'Not provided by Node does not imply unresolved at runtime: system and packaged libraries may export the symbol.', 'Host candidate selection is a name-prefix heuristic; all undefined symbols remain included.', 'No recursive dependency resolution, full native ABI semantics, runtime relocation, authenticated identity or online behavior is proved.', 'Tencent binaries remain local analysis dependencies and are excluded from product distribution.'],
};
fs.writeFileSync(path.join(project, 'evidence', arm64 ? 'native-abi-linux-arm64.json' : 'native-abi-linux.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ wrapper: report.wrapper, node: report.node, tools: report.tools, providedByNode: report.comparison.providedByNodeCount, hostCandidates: hostCandidates.length, hostNotProvided: hostCandidates.filter(x=>!x.providedByNodeSymbolTable).map(x=>x.name) }, null, 2));
