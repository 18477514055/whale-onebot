"""Offline black-box tests of the release builder and per-bot installer."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT/'scripts/bot-modules.py'


def cli(*args, error=None):
    res = subprocess.run([sys.executable, '-B', CLI, *args],capture_output=True,text=True)
    if error:
        assert res.returncode and error in res.stderr, (res.stdout,res.stderr)
        return
    assert not res.returncode, res.stderr
    return json.loads(res.stdout)


def tree(p):
    return {x.relative_to(p).as_posix():(hashlib.sha256(x.read_bytes()).hexdigest(),x.stat().st_mtime_ns)
            for x in p.rglob('*') if x.is_file()}


def probe(app, expected):
    code = """import {loadPlatformModule as get} from './src/core/platform-modules.js';
let ids=[]; for(const id of ['qq','bilibili']) {try {const m=get(id); if(m.platform!==id || m.abi!==1 || typeof m.createClient!=='function') throw Error('ABI mismatch'); ids.push(id)}catch(e){if(e.code!=='PLATFORM_MODULE_MISSING')throw e}} console.log(JSON.stringify(ids));"""
    res = subprocess.run(['node','--input-type=module','-e',code],cwd=app,text=True,capture_output=True)
    assert not res.returncode,res.stderr
    assert json.loads(res.stdout)==expected,(res.stdout,expected)


class BotModules(unittest.TestCase):
    def test_distribution(self):
        with tempfile.TemporaryDirectory() as temp:
            t=Path(temp); cache=t/'cache'; store=t/'bots'
            one=cli('build','--out',t/'one','--version','1.0.0','--module','core')
            all_=cli('build','--out',cache,'--version','1.0.0','--module-version','bilibili=1.1.0')
            self.assertEqual(one['artifacts'],all_['artifacts'][:1]); self.assertEqual(sorted(x.name for x in (t/'one').iterdir()), ['bot-core-1.0.0.zip','catalog.json'])
            with zipfile.ZipFile(cache/'bot-core-1.0.0.zip') as z:
                names=z.namelist()
                self.assertFalse(any('/platform-modules/' in n or '/node_modules/' in n or '/data/' in n or n.endswith(('.png','.node','.wasm','.so','.exe','.dll')) for n in names))
                self.assertNotIn('scripts',json.loads(z.read('payload/package.json')))
            a=store/'a/agent-app'; b=store/'b/agent-app'
            def run(cmd='install',bot='a',platform=(),pin=None,error=None):
                opts=[s for k in platform for s in ('--platform',k)]
                return cli(cmd,'--catalog',all_['catalog'],'--pin',pin or all_['pin'],'--store',store,'--bot',bot,*opts,error=error)
            self.assertEqual(run('plan')['missing'],['core']); self.assertFalse(store.exists())
            self.assertEqual(run()['installed'],['core']); probe(a,[]); old=tree(a)
            self.assertEqual(run(platform=['qq'])['installed'],['qq']); probe(a,['qq'])
            self.assertEqual(run(bot='b',platform=['bilibili'])['installed'],['core','bilibili']); probe(b,['bilibili']); other=tree(b)
            keep=tree(a)
            # Previously installed archives need not even exist in cache for an incremental install.
            (cache/'bot-core-1.0.0.zip').rename(t/'parked-core.zip'); (cache/'bot-qq-1.0.0.zip').rename(t/'parked-qq.zip')
            self.assertEqual(run(platform=['qq','bilibili'])['installed'],['bilibili']); probe(a,['qq','bilibili']); probe(b,['bilibili'])
            after=tree(a); self.assertTrue(all(after[k]==v for k,v in old.items())); self.assertTrue(all(after[k]==v for k,v in keep.items())); self.assertEqual(tree(b),other)
            self.assertEqual(run(platform=['qq','bilibili'])['installed'],[])
            self.assertEqual(cli('install','--runtime','custom','--store',store,'--bot','outside','--platform','qq')['required'],[])
            self.assertFalse((store/'outside').exists()); run(pin='0'*64,error='catalog pin mismatch')
            # Even a pinned catalog cannot opt this installer into an unsupported plugin ABI.
            c = json.loads(Path(all_['catalog']).read_bytes()); c['artifacts'][2]['requiresCoreAbi'] = 99
            wrong = json.dumps(c).encode(); bad = cache/'wrong-catalog.json'; bad.write_bytes(wrong)
            cli('install','--store',store,'--bot','wrong','--platform','bilibili','--catalog',bad,'--pin',hashlib.sha256(wrong).hexdigest(),error='invalid catalog artifact')
            self.assertFalse((store/'wrong').exists())
            with (a/'prices.json').open('ab') as f:f.write(b' ')
            run(error='installed file changed')
            with (cache/'bot-bilibili-1.1.0.zip').open('ab') as f:f.write(b'x')
            (t/'parked-core.zip').rename(cache/'bot-core-1.0.0.zip')
            run(bot='fresh',platform=['bilibili'],error='archive pin mismatch'); self.assertFalse((store/'fresh').exists())
            print('PASS: core only; A +QQ; B +Bilibili alone; A +Bilibili (no core/QQ ZIP or rewrites); B unchanged; custom empty; tamper rejected')


if __name__=='__main__': unittest.main()
