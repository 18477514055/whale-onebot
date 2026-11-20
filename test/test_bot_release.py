"""Offline: python -B test/test_bot_release.py [--assets PATH --pin SHA256]."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import tarfile
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
M=runpy.run_path(str(ROOT/'scripts/build-bot-release.py'))


def audit(folder,pin):
    index=folder/'release-index.json'; rows=M['history'](index,pin); c=json.loads(index.read_bytes());v=c['current'];r=next(r for r in rows if r['version']==v)
    assert json.loads((folder/'core-release-pin.json').read_bytes())==dict(url=M['sibling'](v,'release-index.json'),sha256=pin)
    mods=M['MOD'];records=mods['catalog_rows'](folder/'catalog.json',r['catalogSha256']); assert set(records)==set(mods['IDS'])
    for x in records.values():mods['unpack'](folder,x)
    env=r['environment'];tar=folder/env['file']; assert tar.stat().st_size==env['bytes'] and M['sha_file'](tar)==env['sha256']
    names=set()
    with tarfile.open(tar,'r:gz') as t:
        for e in t:
            assert (e.isfile() or e.isdir()) and not e.pax_headers and M['safe'](e.name) and e.name.casefold() not in names
            names.add(e.name.casefold()); parts=e.name.lower().split('/')
            assert all(p not in parts for p in ('qqnt','wrapper.node','sessions','device-ids','onebot-token.secret','.ssh','.git'))
            if e.name in ('usr/bin/node','bin/bash','usr/bin/env'):
                elf=t.extractfile(e).read(20);assert e.mode & 0o111 and elf[:4]==b'\x7fELF' and int.from_bytes(elf[18:20],'little')==183
        for required in ('bin/bash','usr/bin/env','usr/bin/node','lib/ld-linux-aarch64.so.1','opt/whale/instance-app','opt/whale/bili-protocol/src/platforms/bilibili/service.mjs','opt/whale/node_modules/jce/jce.js','usr/share/doc/node/license','usr/share/doc/whale-environment/sources.json'):assert required in names,required
    print(f'PASS pinned current {v}; {len(rows)} history row(s); {len(records)} ZIPs; {len(names)} environment entries; {env["bytes"]} bytes')


class Release(unittest.TestCase):
    def test_history_trust(self):
        with tempfile.TemporaryDirectory() as d:
            old=Path(d)/'release-index.json';v='1.0.0';file='whale-environment-arm64-1.0.0.tar.gz';row=dict(version=v,catalogUrl=M['sibling'](v,'catalog.json'),catalogSha256='f'*64,environment=dict(file=file,version=v,url=M['sibling'](v,file),bytes=1,sha256='e'*64,format='ustar-gzip'))
            doc=dict(schemaVersion=1,abi=1,current=v,releases=[row]);old.write_bytes(M['dump'](doc));pin=M['sha_file'](old)
            self.assertEqual(M['history'](old,pin),[row]); self.assertRaisesRegex(ValueError,'pin mismatch',M['history'],old,'0'*64)
            row['catalogUrl']='https://elsewhere.invalid/catalog.json';old.write_bytes(M['dump'](doc));self.assertRaisesRegex(ValueError,'invalid previous release',M['history'],old,M['sha_file'](old))
    def test_reviewed_input_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            d=Path(temp);app=d/'reviewed';app.mkdir();p=d/'approved.json'
            p.write_bytes(M['dump']({'schemaVersion':1,'files':{'src/a.js':'0'*64}}));(app/'src').mkdir();(app/'src/a.js').write_bytes(b'changed');pin=M['sha_file'](p)
            self.assertRaisesRegex(ValueError,'manifest pin mismatch',M['reviewed_selector'],app,p,'0'*64)
            self.assertRaisesRegex(ValueError,'app bytes differ',M['reviewed_selector'],app,p,pin)
            p.write_bytes(M['dump']({'schemaVersion':1,'files':{'data/config.json':'0'*64}}));self.assertRaisesRegex(ValueError,'outside module schema',M['reviewed_selector'],app,p,M['sha_file'](p))
    def test_inputs(self):
        packages=list(M['locked_packages']());self.assertEqual(len(packages),16);self.assertEqual(len({r['path'] for r,h in packages}),16)
        for path in ('../opt/a','/usr/bin/env','a\\b','a//b','x:stream'):self.assertRaises(ValueError,M['safe'],path)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--assets',type=Path);p.add_argument('--pin');a=p.parse_args()
    if a.assets:audit(a.assets.resolve(),a.pin)
    unittest.main(argv=['unittest'])
