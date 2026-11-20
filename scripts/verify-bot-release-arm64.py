"""Linux/WSL root only: run actual pinned local release files inside a throwaway ARM64 guest; no mounts/network/phone."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import zipfile


def run(assets,pin):
    if os.name!='nt' and os.getuid()!=0: raise SystemExit('Use a disposable local Linux/WSL root session for chroot')
    index=(assets/'release-index.json').read_bytes();assert hashlib.sha256(index).hexdigest()==pin
    index=json.loads(index);row=next(r for r in index['releases'] if r['version']==index['current']);env=row['environment']
    catalog=(assets/'catalog.json').read_bytes();assert hashlib.sha256(catalog).hexdigest()==row['catalogSha256'];catalog=json.loads(catalog)
    tar=assets/env['file'];qemu=Path('/usr/bin/qemu-aarch64-static');assert (os.name=='nt' or qemu.is_file()) and tar.stat().st_size==env['bytes']
    with tar.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==env['sha256']
    with tempfile.TemporaryDirectory(prefix='whale-arm64-') as td:
        root=Path(td); seen=set()
        def destination(base,name):
            assert name and all(c not in ('','.','..') for c in name.split('/')) and '\\' not in name
            p=base/name;assert root in p.parents and p not in seen;seen.add(p);p.parent.mkdir(exist_ok=True,parents=True);return p
        with tarfile.open(tar,'r:gz') as t:
            for e in t:
                assert not e.pax_headers and e.mode & 0o7000==0;p=destination(root,e.name)
                if e.isdir():p.mkdir(exist_ok=True)
                else:
                    assert e.isfile()
                    with p.open('xb') as out:shutil.copyfileobj(t.extractfile(e),out)
                    p.chmod(e.mode & 0o755)
        app=root/'opt/whale/instance-app';ids=set()
        for m in catalog['artifacts']:
            archive=assets/m['file'];assert m['id'] not in ids;ids.add(m['id']);assert hashlib.sha256(archive.read_bytes()).hexdigest()==m['sha256']
            with zipfile.ZipFile(archive) as z:
                manifest=z.read('manifest.json');assert hashlib.sha256(manifest).hexdigest()==m['manifestSha256']
                for name,h in json.loads(manifest)['files'].items():
                    b=z.read('payload/'+name);assert hashlib.sha256(b).hexdigest()==h
                    with destination(app,name).open('xb') as f:f.write(b)
        assert ids=={'core','qq','bilibili'}
        if os.name=='nt':
            wsl=['wsl.exe','-d','Debian','-u','root','--exec']; guest_root=subprocess.check_output([*wsl,'wslpath','-u',str(root)],text=True).strip(); assert guest_root.startswith('/mnt/')
            subprocess.run([*wsl,'cp','/usr/bin/qemu-aarch64-static',guest_root+'/test-qemu'],check=True)
        else:
            wsl=[];guest_root=str(root);shutil.copyfile(qemu,root/'test-qemu');(root/'test-qemu').chmod(0o755)
        (root/'opt/whale/probe.mjs').write_text('''import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite'; import {loadPlatformModule} from './instance-app/src/core/platform-modules.js';
import {startBiliService} from './bili-protocol/src/platforms/bilibili/service.mjs';
const db=new DatabaseSync(':memory:');assert.equal(db.prepare('select 6*7 as n').get().n,42);db.close();
for (const id of ['qq','bilibili'])assert.equal(loadPlatformModule(id).platform,id);
for (const id of ['jce','node-html-parser','ws','undici','silk-wasm'])await import(id);
assert.equal(typeof startBiliService,'function');assert.equal(process.arch,'arm64');
console.log(JSON.stringify({node:process.version,arch:process.arch,sqlite:true,npmImports:5,modules:['qq','bilibili'],independentProtocol:true}));''')
        for exe,args in [('/bin/bash',['-c','printf "ARM64 bash %s\\n" "$BASH_VERSION"']),('/usr/bin/env',['--version']),('/usr/bin/node',['/opt/whale/probe.mjs'])]:
            subprocess.run([*wsl,'/usr/bin/env','-i','PATH=/usr/sbin:/usr/bin:/bin','HOME=/root','LANG=C','/usr/sbin/chroot',guest_root,'/test-qemu',exe,*args],check=True,timeout=120)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--assets',required=True,type=Path);p.add_argument('--pin',required=True);a=p.parse_args();run(a.assets.resolve(),a.pin)
