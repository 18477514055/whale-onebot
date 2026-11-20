import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

assert.equal(process.platform, 'win32');
const existing = process.argv[2];
assert(process.argv.length <= 3);
const root = path.resolve(import.meta.dirname, '..');
const program = readFileSync(path.join(root, 'experiments/phone-agent-snapshot.py')).toString('base64');
const destination = existing ?? execFileSync('wsl.exe', ['-d', 'Debian', '--', 'sh', '-c',
  'umask 077; mkdir -p "$HOME/qq-onebot-lab" && mktemp -d "$HOME/qq-onebot-lab/phone-agent-XXXXXXXX"'],
{ encoding: 'utf8', timeout: 15000 }).trim();
assert.match(destination, /^\/home\/[a-z0-9_-]+\/qq-onebot-lab\/phone-agent-[a-z0-9]+$/i);

const dependencyDir = destination + '/portable-dependencies';
if (existing) execFileSync('wsl.exe', ['-d', 'Debian', '--', 'install', '-d', '-m', '700', dependencyDir], { timeout: 15000 });
const phoneCommand = existing
  ? 'cd "$HOME/qqagent/app/node_modules" && tar -cf - boolbase css-select css-what dom-serializer domelementtype domhandler domutils entities jce node-html-parser nth-check silk-wasm sqlite-vec undici ws'
  : `echo ${program} | base64 -d | python3 -`;
const ssh = spawn('ssh.exe', ['-T', '-i', 'D:/QQ-Agent/phone-deploy/ssh/phone_key', '-p', '8022',
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', 'u0_a254@100.75.35.64',
  phoneCommand], { stdio: ['ignore', 'pipe', 'pipe'] });
const tar = spawn('wsl.exe', ['-d', 'Debian', '--', 'tar', '--extract', '--file=-',
  '--no-same-owner', '--no-same-permissions', '--directory', existing ? dependencyDir : destination],
{ stdio: ['pipe', 'ignore', 'pipe'] });

function wait(child, label) {
  return new Promise((resolve, reject) => {
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code ?? signal}`));
    });
  });
}

const deadline = setTimeout(() => { ssh.kill(); tar.kill(); }, 15 * 60 * 1000);
console.log(JSON.stringify({ destination, status: 'copying' }));
try {
  await Promise.all([wait(ssh, 'Phone snapshot'), wait(tar, 'WSL extraction'), pipeline(ssh.stdout, tar.stdin)]);
  if (existing) {
    console.log(JSON.stringify({ dependenciesCopied: true }));
  } else {
    const linuxNode = '/mnt/d/qq-onebot/.tools/node-v24.20.0-linux-x64/bin/node';
    const verify = '/mnt/d/qq-onebot/experiments/verify-phone-agent-snapshot.mjs';
    process.stdout.write(execFileSync('wsl.exe', ['-d', 'Debian', '--', linuxNode, verify, destination],
      { encoding: 'utf8', timeout: 120000 }));
  }
} finally {
  clearTimeout(deadline);
  if (ssh.exitCode === null) ssh.kill();
  if (tar.exitCode === null) tar.kill();
}
