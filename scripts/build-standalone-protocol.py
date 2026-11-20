"""Build the Node protocol source ZIP from an explicitly selected clean source export. No publishing."""
import argparse, hashlib,json,zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();root=a.source.resolve(strict=True)
files=[root/x for x in ('LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','docs/protocol-api.md','scripts/bili-action-catalog.mjs')]
files+=sorted(i for i in (root/'src').rglob('*') if i.is_file() and i.suffix in ('.mjs','.cc','.h'))
if not files or not all((root/x).is_file() for x in ('src/cli.mjs','src/platforms/bilibili/cli.mjs')):p.error('incomplete protocol export')
a.out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(a.out,'x') as z:
 for f in files:
  if f.resolve()!=f or not f.is_file():raise ValueError('missing or redirected input')
  data=f.read_bytes();name=f.relative_to(root).as_posix()
  if name=='package.json':
   doc=json.loads(data);doc['scripts']={k:v for k,v in doc['scripts'].items() if k in ('start','start:bili','catalog:bili')};data=(json.dumps(doc,indent=2)+'\n').encode()
  i=zipfile.ZipInfo(name,(2020,1,1,0,0,0));i.external_attr=0o100644<<16;z.writestr(i,data,compress_type=zipfile.ZIP_DEFLATED)
 z.writestr('DEPLOY.txt','Node >=24. Install exact dependencies: npm ci --ignore-scripts. Offline transport: set WHALE_ONEBOT_TOKEN then npm start. Offline catalog: npm run catalog:bili. Platform provider and credentials are separate requirements. No APK, robot core, native QQ client, user profiles or data included.\n')
print(json.dumps({'asset':a.out.name,'bytes':a.out.stat().st_size,'sha256':hashlib.sha256(a.out.read_bytes()).hexdigest()}))
