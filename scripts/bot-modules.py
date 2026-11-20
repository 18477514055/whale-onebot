"""Build and install pinned, source-only built-in bot modules. Python 3.12+, stdlib."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import zipfile

REPO = Path(__file__).resolve().parents[1]
APP = REPO / 'input/agent-app'
IDS = ('core', 'qq', 'bilibili')
ABI = 1
LIMIT = 32 << 20
MODULES = 'src/platform-modules/'
TREES = {'src': {'.js', '.mjs'}, 'schemas': {'.json'}, 'skills': {'.md', '.json'},
         'roles': {'.md', '.json'}, 'ui': {'.html', '.css', '.js', '.svg', '.md'}}
SINGLE = {'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'prices.json'}


def check(ok, message):
    if not ok:
        raise ValueError(message)


def dump(obj):
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def digest(b):
    return hashlib.sha256(b).hexdigest()


def regular(path, limit=LIMIT):
    s = path.lstat()
    check(stat.S_ISREG(s.st_mode) and not linked(path) and s.st_size <= limit, 'unsafe or oversized file: ' + path.name)
    return path.read_bytes()


def linked(p):
    return p.is_symlink() or p.is_junction()


def safedirs(p):
    for d in [*reversed(p.parents), p]:
        check(not linked(d) and (not d.exists() or d.is_dir()), 'unsafe directory: ' + str(d))


def safe_name(name):
    for part in name.split('/'):
        check(re.fullmatch(r'[\w.-]+', part) and not part.startswith('.') and not part.endswith('.')
              and not re.fullmatch(r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part), 'unsafe path: ' + name)


def scope(mid, name):
    safe_name(name)
    if any(p.lower() in {'node_modules','sessions','data','logs','backups','cache','home'} for p in name.split('/')[:-1]):
        return False
    if mid != 'core':
        return name.startswith(MODULES + mid + '/') and (Path(name).suffix in {'.js', '.mjs', '.json', '.md'} or name.endswith('/LICENSE'))
    return name in SINGLE or ('/' in name and not name.casefold().startswith(MODULES) and Path(name).suffix in TREES.get(name.split('/')[0], set()))


def meta(mid, version):
    check(mid in IDS and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', version), 'invalid id/version')
    return dict(schemaVersion=1, id=mid, version=version, abi=ABI, requiresCoreAbi=None if mid == 'core' else ABI,
                kind='core' if mid == 'core' else 'platform-plugin')


def sources(mid):
    files = {}
    def visit(d):
        safedirs(d)
        for p in sorted(d.iterdir()):
            name = p.relative_to(APP).as_posix()
            if mid == 'core' and name == MODULES.rstrip('/'):
                continue
            check(not linked(p), 'linked build input: ' + name)
            if p.is_dir():
                visit(p)
            elif scope(mid, name):
                files[name] = regular(p)
    if mid == 'core':
        for tree in sorted(TREES):
            visit(APP / tree)
        files['prices.json'] = regular(APP / 'prices.json')
        pkg = json.loads(regular(APP / 'package.json'))
        files['package.json'] = dump({k: pkg[k] for k in ('name', 'version', 'type', 'engines', 'dependencies', 'license')})
    else:
        visit(APP / MODULES / mid)
    prefix = '' if mid == 'core' else MODULES + mid + '/'
    files[prefix+'LICENSE'] = regular(REPO/'third-party/qq-agent-plus/LICENSE')
    files[prefix+'THIRD_PARTY_NOTICES.md'] = regular(REPO/'THIRD_PARTY_NOTICES.md')
    check(b'Copyright (c) 2026 Kondius' in files[prefix+'LICENSE'], 'upstream attribution missing')
    check(('src/core/platform-modules.js' if mid == 'core' else prefix+'index.mjs') in files, 'module entry missing: ' + mid)
    for name, b in files.items():
        check(scope(mid, name) and b'\0' not in b and len(b) <= LIMIT, 'not allowed as text source: ' + name)
        b.decode('utf-8')
    return files


def build(out, version, modules, overrides, source_provider=sources):
    versions = dict.fromkeys(modules, version)
    for spec in overrides:
        mid, sep, tag = spec.partition('=')
        check(sep and mid in versions, 'expected --module-version selected-id=version')
        versions[mid] = tag
    safedirs(out)
    out.mkdir(parents=True, exist_ok=False)
    artifacts = []
    for mid in modules:
        version = versions[mid]
        m = meta(mid, version)
        files = source_provider(mid)
        manifest = dump(dict(**m, files={k:digest(v) for k,v in files.items()}))
        filename = 'bot-{}-{}.zip'.format(mid, version)
        with zipfile.ZipFile(out/filename, 'x') as z:
            for name, b in sorted({'manifest.json': manifest, **{'payload/'+k:v for k,v in files.items()}}.items()):
                i = zipfile.ZipInfo(name, (2000,1,1,0,0,0)); i.create_system = 3
                i.external_attr = (stat.S_IFREG | 0o644) << 16
                z.writestr(i, b, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        b = regular(out/filename)
        artifacts.append(dict(**m, file=filename, bytes=len(b), sha256=digest(b), manifestSha256=digest(manifest)))
    catalog = dump(dict(schemaVersion=1, abi=ABI, artifacts=artifacts))
    (out/'catalog.json').write_bytes(catalog)
    return dict(catalog=str(out/'catalog.json'), pin=digest(catalog), artifacts=artifacts)


def catalog_rows(path, pin):
    safedirs(path.parent)
    data = regular(path, 64<<10)
    check(digest(data) == pin, 'catalog pin mismatch')
    c = json.loads(data)
    check(c['schemaVersion'] == 1 and c['abi'] == ABI, 'catalog ABI mismatch')
    rows = {}
    for r in c['artifacts']:
        mid = r['id']; expected = meta(mid, r['version'])
        check(mid not in rows and r['file'] == 'bot-{}-{}.zip'.format(mid,r['version']) and
              r.keys() == expected.keys() | {'file','bytes','sha256','manifestSha256'} and
              all(r[k] == v for k,v in expected.items()) and 0 < r['bytes'] <= LIMIT and
              all(re.fullmatch('[0-9a-f]{64}', r[k]) for k in ('sha256','manifestSha256')), 'invalid catalog artifact')
        rows[mid] = r
    return rows


def filemap(r, manifest):
    check(digest(manifest) == r['manifestSha256'], 'manifest pin mismatch')
    m = json.loads(manifest); files = m.pop('files')
    check(m == meta(r['id'],r['version']) and isinstance(files,dict) and 0 < len(files) < 4096, 'invalid manifest')
    check(len(set(k.casefold() for k in files)) == len(files), 'case-colliding paths')
    for name, sha in files.items():
        check(scope(r['id'],name) and re.fullmatch('[0-9a-f]{64}',sha), 'invalid manifest file: ' + name)
    return files


def unpack(cache, r):
    raw = regular(cache/r['file'])
    check(len(raw) == r['bytes'] and digest(raw) == r['sha256'], 'archive pin mismatch: ' + r['id'])
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries = z.infolist()
        check(len(entries) < 4097 and sum(e.file_size for e in entries) <= LIMIT and
              len(set(z.namelist())) == len(entries) and all(stat.S_ISREG(e.external_attr >> 16) and
              e.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED) and not e.flag_bits & 1 for e in entries), 'invalid ZIP entries')
        manifest = z.read('manifest.json'); files = filemap(r,manifest)
        check(set(z.namelist()) == {'manifest.json'} | {'payload/'+k for k in files}, 'unexpected ZIP member')
        payload = {}
        for name, sha in files.items():
            b = z.read('payload/'+name); b.decode('utf-8')
            check(digest(b) == sha and b'\0' not in b, 'payload mismatch: ' + name)
            payload[name] = b
    return manifest,payload


def target(app, mid):
    return app if mid == 'core' else app / MODULES / mid


def installed(app, r):
    directory = target(app,r['id']); safedirs(directory)
    if not directory.exists():
        return False
    check(json.loads(regular(directory/'.bot-module.json', 4096)) == r, 'existing installation differs; refusing replacement: ' + r['id'])
    files = filemap(r,regular(directory/'.bot-manifest.json', 1<<20))
    for name, sha in files.items():
        p = app/name; safedirs(p.parent)
        check(digest(regular(p)) == sha, 'installed file changed: ' + name)
    return True


def apply(args, write):
    safe_name(args.bot)
    check(re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}',args.bot), 'invalid bot id')
    result = dict(bot=args.bot, runtime=args.runtime, required=[], missing=[], downloads=[], downloadBytes=0, installed=[])
    if args.runtime == 'custom':
        return result
    check(args.catalog and args.pin, 'built-in modules require --catalog and --pin')
    path = Path(args.catalog).absolute(); rows = catalog_rows(path,args.pin)
    needed = ['core'] + [k for k in IDS[1:] if k in args.platform]; result['required'] = needed
    app = Path(args.store).absolute() / args.bot / 'agent-app'
    for mid in needed:
        check(mid in rows, 'artifact not in pinned catalog: ' + mid)
        if not installed(app,rows[mid]):
            result['missing'].append(mid)
            result['downloads'].append(rows[mid])
            result['downloadBytes'] += rows[mid]['bytes']
    if not write or not result['missing']:
        return result
    # Verify every requested ZIP before changing the store. No ZIP extraction or lifecycle scripts.
    pending = {mid:unpack(path.parent,rows[mid]) for mid in result['missing']}
    app.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=app.parent, prefix='.bot-stage-') as temp:
        stage = Path(temp)/'agent-app'
        for mid,(manifest,payload) in pending.items():
            for name,b in payload.items():
                p = stage/name; p.parent.mkdir(parents=True,exist_ok=True)
                with p.open('xb') as f: f.write(b)
            d = target(stage,mid); (d/'.bot-manifest.json').write_bytes(manifest); (d/'.bot-module.json').write_bytes(dump(rows[mid]))
        if 'core' in pending:
            stage.rename(app)  # first install; plugins (if selected) appear with core
        else:
            for mid in pending:
                dst = target(app,mid); safedirs(dst.parent); dst.parent.mkdir(parents=True, exist_ok=True)
                check(not dst.exists(), 'plugin installed concurrently'); target(stage,mid).rename(dst)
    result['installed'] = list(pending)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='cmd',required=True)
    b = sub.add_parser('build'); b.add_argument('--out',required=True); b.add_argument('--version',required=True)
    b.add_argument('--module-version',action='append',default=[],metavar='ID=VERSION',help='Override one artifact version (repeatable)')
    b.add_argument('--module',choices=IDS,action='append',help='Repeatable; default: all three artifacts')
    for cmd in ('plan','install'):
        a = sub.add_parser(cmd); a.add_argument('--store',required=True); a.add_argument('--bot',required=True)
        a.add_argument('--runtime',choices=('builtin','custom'),default='builtin'); a.add_argument('--platform',choices=IDS[1:],action='append',default=[])
        a.add_argument('--catalog'); a.add_argument('--pin')
    args = p.parse_args()
    res = build(Path(args.out).absolute(),args.version,list(dict.fromkeys(args.module or IDS)), args.module_version) if args.cmd=='build' else apply(args,args.cmd=='install')
    print(json.dumps(res,ensure_ascii=True,indent=2))


if __name__ == '__main__':
    try: main()
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile) as e:
        sys.exit('bot-modules: ' + str(e))
