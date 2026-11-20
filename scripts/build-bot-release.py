"""Assemble local release assets, never publish or execute package lifecycle scripts."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shutil
import stat
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MOD = runpy.run_path(str(ROOT/'scripts/bot-modules.py'))
dump, digest, check, safedirs = (MOD[k] for k in ('dump','digest','check','safedirs'))
NODE_VER = '24.20.0'
NODE_HASH = '5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7'
NODE_URL = f'https://nodejs.org/dist/v{NODE_VER}/node-v{NODE_VER}-linux-arm64.tar.xz'
BASE = 'https://github.com/18477514055/whale-onebot/releases/download/'
LOCK = ROOT/'scripts/release-inputs/npm-arm64.lock.json'
TAG = r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?'


def version(s):
    check(isinstance(s,str) and re.fullmatch(TAG,s), 'invalid release version'); return s


def sibling(v,f): return BASE+'v'+version(v)+'/'+f


def sha_file(p):
    with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()


def safe(p):
    check(p and len(p)<240 and p.isascii() and not any(x in p for x in ('\\',':','\0')) and
          all(x not in ('','.','..') and all(32<=ord(c)<127 for c in x) for x in p.split('/')), 'unsafe tar path: '+repr(p))
    return p


def regular(p,limit=160<<20):
    safedirs(p.parent)
    check(not MOD['linked'](p) and stat.S_ISREG(p.lstat().st_mode) and p.stat().st_size<=limit,'invalid input: '+p.name)
    return p.read_bytes()


def locked_packages():
    for row in json.loads(regular(LOCK)):
        name=row['name'];v=row['version']; check(re.fullmatch('[a-z0-9-]+',name) and re.fullmatch(TAG,v),'invalid npm identity')
        check(row['url']==f'https://registry.npmjs.org/{name}/-/{name}-{v}.tgz' and
              re.fullmatch(r'(?:bili-protocol/)?(?:node_modules/[a-z0-9-]+/)*node_modules/'+name,row['path']),'invalid npm lock')
        h=base64.b64decode(row['integrity'].removeprefix('sha512-'),validate=True);check(len(h)==64,'expected npm SHA512');yield row,h.hex()


def fill_cache(out):
    safedirs(out);out.mkdir(exist_ok=True,parents=True)
    for row,h in locked_packages():
        p=out/(h+'.tgz')
        if p.exists(): b=regular(p)
        else:
            with urllib.request.urlopen(row['url'],timeout=45) as stream:
                check(stream.url==row['url'],'unexpected registry redirect'); b=stream.read(32<<20)
        check(hashlib.sha512(b).hexdigest()==h,'npm integrity mismatch')
        if not p.exists():
            with p.open('xb') as f:f.write(b)


def npm_entries(cache, add):
    for row,h in locked_packages():
        raw=regular(cache/(h+'.tgz')); check(hashlib.sha512(raw).hexdigest()==h,'npm integrity mismatch: '+row['name'])
        prefix='opt/whale/'+row['path']; license_files=[]
        with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as t:
            entries=t.getmembers();check(len(entries)<4096 and sum(x.size for x in entries)<64<<20,'npm package exceeds limits')
            pkg=json.loads(t.extractfile('package/package.json').read());check(pkg['name']==row['name'] and pkg['version']==row['version'],'wrong npm package')
            for e in entries:
                if e.isdir(): continue
                check(e.isfile() and e.name.startswith('package/'),'non-file npm payload')
                rel=safe(e.name[8:]);parts=rel.lower().split('/')
                if any(s.startswith('.') or s in {'test','tests','coverage','.github'} for s in parts): continue
                if parts[-1].startswith(('license','copying','notice')):license_files.append(rel)
                add(prefix+'/'+rel,t.extractfile(e).read())
        if row['name']=='silk-wasm':
            for notice in ['notice-silk-codec.txt','notice-silk-sdk.txt']:
                add(prefix+'/'+notice,regular(ROOT/'scripts/release-inputs'/notice))
        if not license_files:
            expected={'jce':'MIT','boolbase':'ISC'}.get(row['name'])
            check(expected and expected==pkg.get('license'),'missing package license: '+row['name'])
            add(prefix+'/LICENSE-NOTICE.txt',regular(ROOT/'scripts/release-inputs'/('notice-'+row['name']+'.txt')))


def environment(out,v,node,cache,debian,manifest,pin,bili_root,bili_manifest,bili_pin):
    """Accept only an explicitly pinned curated Debian subset, never an imported rootfs."""
    v=version(v);spec=regular(manifest);check(digest(spec)==pin,'Debian evidence pin mismatch');spec=json.loads(spec)
    check(isinstance(spec.get('sources'),(dict,list)) and spec['sources'],'missing Debian source evidence')
    files=spec['files']; required={'bin/bash','usr/bin/env','lib/ld-linux-aarch64.so.1'}
    check(required<=files.keys(),'incomplete Debian subset'); check(any('copyright' in k or 'license' in k.lower() for k in files),'missing Debian notices')
    for k in files:
        safe(k);check(k in {'bin/bash','bin/sh','usr/bin/bash','usr/bin/env','usr/bin/sleep','etc/ssl/certs/ca-certificates.crt'} or k.startswith(('lib/','usr/lib/','usr/share/doc/','usr/share/common-licenses/','usr/share/whale/','opt/whale/licenses/')),'unexpected Debian path: '+k)
    check(sha_file(node)==NODE_HASH,'Node official tarball hash mismatch');safedirs(out.parent)
    dirs=set();seen=set();parents=set();sources=[]
    with out.open('xb') as f, gzip.GzipFile(filename='',fileobj=f,mode='wb',mtime=0,compresslevel=6) as gz, tarfile.open(fileobj=gz,mode='w|',format=tarfile.USTAR_FORMAT) as tar:
        def ent(name,b=None,mode=0o644):
            safe(name);case=name.casefold();check(case not in seen,'duplicate input: '+name);seen.add(case)
            e=tarfile.TarInfo(name);e.mode=mode;e.mtime=0
            if b is None:e.type=tarfile.DIRTYPE;tar.addfile(e)
            else:e.size=len(b);tar.addfile(e,io.BytesIO(b))
        def mkdir(name):
            if not name or name in dirs:return
            mkdir(name.rpartition('/')[0]);ent(name,None,0o755);dirs.add(name)
        def add(name,b,mode=0o644):
            mkdir(name.rpartition('/')[0]);ent(name,b,mode)
        for d in ('root','dev','proc','sys','tmp','opt/whale/instance-app','opt/whale/instance-state','opt/whale/host-adapter','opt/whale/instances','agent/data'): mkdir(d)
        for k,sha in sorted(files.items()):
            b=regular(debian/k);check(digest(b)==sha,'Debian staged content differs: '+k);add(k,b,0o755 if b.startswith(b'\x7fELF') else 0o644)
        with tarfile.open(node,'r:xz') as t:
            prefix=f'node-v{NODE_VER}-linux-arm64/'
            for name,dst in [('bin/node','usr/bin/node'),('LICENSE','usr/share/doc/node/LICENSE')]:
                e=t.getmember(prefix+name);check(e.isfile(),'invalid Node archive');b=t.extractfile(e).read()
                if name=='bin/node':check(b[:4]==b'\x7fELF' and int.from_bytes(b[18:20],'little')==183,'expected arm64 ELF')
                add(dst,b,0o755 if name=='bin/node' else 0o644)
        npm_entries(cache,add)
        proof=regular(bili_manifest);check(digest(proof)==bili_pin,'Bili source review pin mismatch'); reviewed=json.loads(proof)['files']; sources=sorted(reviewed)
        check({'src/platforms/bilibili/service.mjs','src/platforms/bilibili/authorized-client.mjs','src/segments.mjs','src/transport/server.mjs','LICENSE','THIRD_PARTY_NOTICES.md'}<=reviewed.keys(),'incomplete reviewed Bili adapter')
        for name in sources:
            safe(name);check(name in {'src/segments.mjs','src/transport/server.mjs','LICENSE','THIRD_PARTY_NOTICES.md'} or name.startswith('src/platforms/bilibili/') and name.endswith('.mjs'),'unexpected Bili source'); data=regular(bili_root/name);check(digest(data)==reviewed[name],'Bili source changed: '+name)
            add('opt/whale/bili-protocol/'+name,data)
        add('opt/whale/bili-protocol/package.json', dump({'name':'whale-bili-protocol','license':'MIT','type':'module','dependencies':{'ws':'8.18.3'}}))
        add('usr/share/doc/whale-environment/sources.json',dump({'version':v,'arch':'linux-arm64','debianManifestSha256':pin,'debian':spec['sources'],'node':{'version':NODE_VER,'url':NODE_URL,'sha256':NODE_HASH},'npm':[r for r,h in locked_packages()],'protocolSources':sources}))
    return dict(version=v,file=out.name,bytes=out.stat().st_size,sha256=sha_file(out),format='ustar-gzip')


def history(path,pin):
    if not path:return []
    data=regular(path,128<<10);check(digest(data)==pin,'previous index pin mismatch');c=json.loads(data)
    check(c['schemaVersion']==1 and c['abi']==1 and 0<len(c['releases'])<100,'unexpected previous index')
    ids=set()
    for r in c['releases']:
        v=version(r['version']);e=r['environment'];check(v not in ids and r['catalogUrl']==sibling(v,'catalog.json') and
            re.fullmatch('[0-9a-f]{64}',r['catalogSha256']) and re.fullmatch('[0-9a-f]{64}',e['sha256']) and
            e['file']==f"whale-environment-arm64-{version(e['version'])}.tar.gz" and e['url']==sibling(v,e['file']) and
            e['format']=='ustar-gzip' and 0<e['bytes']<(2<<30),'invalid previous release');ids.add(v)
    check(c['current'] in ids,'invalid previous current version');return c['releases']


def reviewed_selector(app,manifest,pin):
    raw=regular(manifest,2<<20);check(digest(raw)==pin,'public app manifest pin mismatch')
    doc=json.loads(raw); approved=doc['files'];check(isinstance(approved,dict) and 0<len(approved)<4096,'invalid reviewed file list')
    modules={i:{} for i in MOD['IDS']}
    for name,h in approved.items():
        owners=[mid for mid in modules if MOD['scope'](mid,name)];check(len(owners)==1,'reviewed app path outside module schema: '+name)
        data=regular(app/name,32<<20);check(digest(data)==h and b'\0' not in data,'public app bytes differ: '+name);data.decode('utf8')
        if name=='package.json':
            pkg=json.loads(data);data=dump({k:pkg[k] for k in ('name','version','type','engines','dependencies','license')})
        modules[owners[0]][name]=data
    core=modules['core'];check({'LICENSE','THIRD_PARTY_NOTICES.md','src/core/platform-modules.js','src/binding-supervisor.mjs','src/server.js','package.json'}<=core.keys(),'missing reviewed core entry/attribution')
    check(b'Copyright (c) 2026 Kondius' in core['LICENSE'],'upstream attribution missing')
    for mid in MOD['IDS'][1:]:
        prefix=f'src/platform-modules/{mid}/';check(prefix+'index.mjs' in modules[mid],'missing reviewed plugin entry')
        for k in ('LICENSE','THIRD_PARTY_NOTICES.md'):modules[mid].setdefault(prefix+k,core[k])
    return modules.__getitem__


def corresponding(assets,sidecar,pin,spec):
    check(sha_file(sidecar)==pin,'corresponding-source pin mismatch')
    required={x['url'].rsplit('/',1)[-1]:x['sha256'] for p in spec['sources'] for x in p['correspondingSource']};seen=set()
    with tarfile.open(sidecar,'r:') as t:
        for e in t:
            safe(e.name);check(e.isfile() and e.name not in seen,'unsafe corresponding-source member');seen.add(e.name)
            if e.name.startswith('source/'):
                check(hashlib.file_digest(t.extractfile(e),'sha256').hexdigest()==required.pop(e.name[7:]),'invalid source member hash')
            else:check(e.name in {'InRelease','Packages.xz','Release.verified','Sources.xz','build.py','manifest.json'},'unexpected source sidecar member')
    check(not required,'missing corresponding sources');shutil.copyfile(sidecar,assets/'debian-arm64-corresponding-source.tar')


def build(a):
    out=Path(a.out).absolute();safedirs(out);check(not out.exists(),'new release directory required');v=version(a.version)
    prev=history(Path(a.previous).absolute() if a.previous else None,a.previous_pin);check(v not in {x['version'] for x in prev},'immutable release already exists')
    out.parent.mkdir(exist_ok=True,parents=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as stage:
        app=Path(a.app).absolute();check(app.resolve()!=MOD['APP'].resolve(),'private upstream source tree cannot be a release input')
        selector=reviewed_selector(app,Path(a.app_manifest).absolute(),a.app_pin)
        assets=Path(stage)/'assets';c=MOD['build'](assets,v,MOD['IDS'],[],selector)
        spec=json.loads(regular(Path(a.debian_manifest).absolute()));corresponding(assets,Path(a.source_tar).absolute(),a.source_pin,spec)
        env=environment(assets/f'whale-environment-arm64-{v}.tar.gz',v,Path(a.node).absolute(),Path(a.npm_cache).absolute(),Path(a.debian_root).absolute(),Path(a.debian_manifest).absolute(),a.debian_pin,Path(a.bili_root).absolute(),Path(a.bili_manifest).absolute(),a.bili_pin)
        env['url']=sibling(v,env['file']);row=dict(version=v,catalogUrl=sibling(v,'catalog.json'),catalogSha256=c['pin'],environment=env)
        index=dump(dict(schemaVersion=1,abi=1,current=v,releases=[row,*prev]));pin=dict(url=sibling(v,'release-index.json'),sha256=digest(index))
        (assets/'release-index.json').write_bytes(index);(assets/'core-release-pin.json').write_bytes(dump(pin))
        hashes={p.name:sha_file(p) for p in sorted(assets.iterdir())};(assets/'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for n,h in hashes.items()),encoding='ascii',newline='\n');assets.rename(out)
    print(json.dumps({'out':str(out),'pin':pin,'environment':env,'current':v,'releases':1+len(prev)},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='cmd',required=True)
    p=sub.add_parser('fetch-npm',help='explicit optional official npm fetch into digest-addressed cache');p.add_argument('--out',required=True)
    p=sub.add_parser('build');
    for k in ('out','version','node','npm-cache','debian-root','debian-manifest','debian-pin','source-tar','source-pin','app','app-manifest','app-pin','bili-root','bili-manifest','bili-pin'):p.add_argument('--'+k,required=True)
    p.add_argument('--previous');p.add_argument('--previous-pin');a=parser.parse_args()
    if a.cmd=='fetch-npm':fill_cache(Path(a.out).absolute())
    else:build(a)
