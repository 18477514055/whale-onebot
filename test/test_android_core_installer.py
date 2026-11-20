"""Compile the production Android installer against offline shims; exercise real loopback HTTP and real release ZIPs."""
import argparse
import io
import gzip
import tarfile
import zipfile
import functools
import hashlib
import http.server
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
JAVA = ROOT/'android/app/src/com/whaleonebot'
MOD = runpy.run_path(str(ROOT/'scripts/bot-modules.py'))
BASE = 'https://github.com/18477514055/whale-onebot/releases/download/'


def environment(version):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as z:
        for path in ('bin/bash','usr/bin/node','usr/bin/env'):
            e=tarfile.TarInfo(path);e.mode=0o755;data=('fixture executable placeholder '+version).encode();e.size=len(data);z.addfile(e,io.BytesIO(data))
    return gzip.compress(out.getvalue(),mtime=0)


def run(candidate=None):
    with tempfile.TemporaryDirectory() as tmp:
        t=Path(tmp); assets=t/'assets'; classes=t/'classes'; classes.mkdir();assets.mkdir(); rows=[]; expected=0
        for ver in ('1.0.0','1.1.0'):
            d=assets/('v'+ver); result=MOD['build'](d, ver, MOD['IDS'], []); fn=f'whale-environment-arm64-{ver}.tar.gz'; env=environment(ver); (d/fn).write_bytes(env)
            rows.append(dict(version=ver,catalogUrl=BASE+d.name+'/catalog.json',catalogSha256=result['pin'],environment=dict(file=fn,version=ver,url=BASE+d.name+'/'+fn,format='ustar-gzip',sha256=hashlib.sha256(env).hexdigest(),bytes=len(env))))
            if ver=='1.0.0':expected=sum(a['bytes'] for a in result['artifacts'])+len(env)
        rows.append(dict(rows[-1],version='2.0.0',abi=2)); index=assets/'v1.1.0/release-index.json'; index.write_text(json.dumps(dict(schemaVersion=1,abi=1,current='1.1.0',releases=rows)),encoding='utf8'); pin=hashlib.sha256(index.read_bytes()).hexdigest()
        shims={'android/content/Context.java':'package android.content; public abstract class Context {public abstract android.content.res.AssetManager getAssets(); public abstract java.io.File getFilesDir();public abstract Context getApplicationContext();}',
               'android/content/res/AssetManager.java':'package android.content.res; public abstract class AssetManager {public abstract java.io.InputStream open(String name) throws java.io.IOException;}',
               'android/util/Log.java':'package android.util; public class Log {public static int w(String tag,String msg){System.err.println(msg);return 0;}}'}
        src=[]
        for path,text in shims.items():
            p=t/'shim'/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text,encoding='utf8');src.append(p)
        subprocess.run(['javac','--release','8','-encoding','UTF-8','-Xlint:-options','-d',classes,*src,JAVA/'ManagedEnvironment.java',*sorted((JAVA/'install').glob('*.java')),JAVA/'ui/BotConfigJson.java',JAVA/'ui/InstallerJson.java',ROOT/'android/tests/CoreInstallerTest.java'],check=True)
        # A benign extra member and a non-regular attribute must not be accepted as valid source archives.
        for name,mode in [('extra-member.zip',0o100644),('special-member.zip',0o120777)]:
            source=assets/'v1.0.0/bot-qq-1.0.0.zip'
            with zipfile.ZipFile(source) as z, zipfile.ZipFile(assets/name,'x') as bad:
                for info in z.infolist():bad.writestr(info,z.read(info))
                item=zipfile.ZipInfo('README.invalid');item.create_system=3;item.external_attr=mode<<16;bad.writestr(item,b'ordinary fixture text')
        candidate_args=[]
        if candidate:
            package=Path(candidate).resolve(strict=True); pin_asset=json.loads((ROOT/'android/app/assets/core-release-pin.json').read_bytes()); candidate_args=[pin_asset['url'],pin_asset['sha256']]; release_path=pin_asset['url'].removeprefix(BASE).split('/')[0]
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
            def translate_path(self,path):
                if candidate and path.startswith('/'+release_path+'/'):
                    name=path.rsplit('/',1)[-1];return str(package/name) if name and name==Path(name).name else str(t/'unavailable')
                return super().translate_path(path)
        with http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(assets))) as server:
            worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
            try:subprocess.run(['java','-cp',classes,'com.whaleonebot.install.CoreInstallerTest',str(t/'files'),str(server.server_port),pin,str(expected),str(assets),*candidate_args],check=True,timeout=180)
            finally:server.shutdown();worker.join()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--candidate',help='local release assets matching the APK bootstrap pin, served only on loopback');run(p.parse_args().candidate)
