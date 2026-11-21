"""JVM verification of the Android clean USTAR installer; all fixtures stay under .tmp."""
from pathlib import Path
import hashlib, io, subprocess, tarfile, tempfile, unittest
ROOT=Path(__file__).resolve().parents[1]
class EnvironmentInstall(unittest.TestCase):
 def test_transaction(self):
  (ROOT/'.tmp').mkdir(exist_ok=True)
  with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as work:
   w=Path(work); java=w/'Probe.java'; java.write_text('import com.whaleonebot.ManagedEnvironment; import java.io.*; class Probe {public static void main(String[] a)throws Exception{ File f=new File(a[0]);ManagedEnvironment.prepare(f,new File(a[1]),a[2]);if(!ManagedEnvironment.ready(f,a[2]))throw new IOException();}}',encoding='utf-8');subprocess.run(['javac','-d',work,str(ROOT/'android/app/src/com/whaleonebot/ManagedEnvironment.java'),str(java)],check=True)
   def archive(name,extra=None):
    p=w/(name+'.tgz')
    with tarfile.open(p,'w:gz',format=tarfile.USTAR_FORMAT) as tar:
     for s in ['bin/bash','usr/bin/node','usr/bin/env']:
      i=tarfile.TarInfo(s);i.mode=0o755;i.size=4;tar.addfile(i,io.BytesIO(b'test'))
     if extra: tar.addfile(extra)
    return p,hashlib.sha256(p.read_bytes()).hexdigest()
   def attempt(f,p,sha):return subprocess.run(['java','-cp',work,'Probe',str(f),str(p),sha],capture_output=True).returncode
   f=w/'files';f.mkdir();p,h=archive('good');self.assertNotEqual(attempt(f,p,'0'*64),0);self.assertEqual(list(f.iterdir()),[])
   for name in ['../escape','/outside']:
    q,x=archive('invalid',tarfile.TarInfo(name));self.assertNotEqual(attempt(f,q,x),0);self.assertEqual(list(f.iterdir()),[])
   sy=tarfile.TarInfo('link');sy.type=tarfile.SYMTYPE;sy.linkname='usr/bin/node';q,x=archive('link',sy);self.assertNotEqual(attempt(f,q,x),0)
   self.assertEqual(attempt(f,p,h),0);self.assertEqual(attempt(f,p,h),0);self.assertNotEqual(attempt(f,q,x),0);self.assertEqual((f/'rootfs/bin/bash').read_bytes(),b'test')
if __name__=='__main__':unittest.main()
