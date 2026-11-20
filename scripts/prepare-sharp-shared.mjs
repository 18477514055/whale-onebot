// Optional shared Windows/WSL workspace preparation. Normal single-platform npm ci is sufficient.
// Archives must first be acquired with npm pack --ignore-scripts; their lockfile integrity is mandatory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const hash=(p,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(fs.readFileSync(p)).digest(encoding);
function directory(p){if(!fs.existsSync(p))fs.mkdirSync(p);assert(fs.lstatSync(p).isDirectory()&&!fs.lstatSync(p).isSymbolicLink());assert.equal(fs.realpathSync(p),p);}
for(const p of ['node_modules','node_modules/@img','.tmp','evidence'])directory(path.join(root,p));
const records=[];
for(const [name,version,filename]of [
  ['@img/sharp-linux-x64','0.35.5','img-sharp-linux-x64-0.35.5.tgz'],
  ['@img/sharp-libvips-linux-x64','1.3.4','img-sharp-libvips-linux-x64-1.3.4.tgz'],
]){
  const expected=lock.packages['node_modules/'+name];assert.equal(expected.version,version);
  const archive=path.join(root,'.tools/sharp-linux-packages',filename);
  assert.equal('sha512-'+hash(archive,'sha512','base64'),expected.integrity);
  const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:1024*1024});assert.equal(listing.status,0);
  const entries=listing.stdout.trim().split(/\r?\n/);assert(entries.length>0&&entries.length<100);
  assert(entries.every(e=>e.startsWith('package/')&&!/[\\:]/.test(e)&&!e.split('/').includes('..')));
  const verbose=spawnSync('tar',['-tvzf',archive],{encoding:'utf8',maxBuffer:1024*1024});assert.equal(verbose.status,0);
  assert(verbose.stdout.trim().split(/\r?\n/).every(line=>['-','d'].includes(line[0])),'Archive links or special files rejected');
  const stage=fs.mkdtempSync(path.join(root,'.tmp/sharp-platform-'));
  const unpack=spawnSync('tar',['-xzf',archive,'--strip-components=1','-C',stage],{encoding:'utf8'});assert.equal(unpack.status,0,unpack.stderr);
  const pkg=JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8'));assert.equal(pkg.name,name);assert.equal(pkg.version,version);
  const files=entries.filter(e=>!e.endsWith('/')).map(e=>e.slice('package/'.length));
  const target=path.join(root,'node_modules',name);
  if(fs.existsSync(target)){
    directory(target);
    for(const file of files){assert(fs.lstatSync(path.join(target,file)).isFile());assert.equal(hash(path.join(target,file)),hash(path.join(stage,file)));}
    assert(fs.realpathSync(stage).startsWith(fs.realpathSync(path.join(root,'.tmp'))+path.sep));fs.rmSync(stage,{recursive:true});
  }else fs.renameSync(stage,target);
  records.push({name,version,license:pkg.license,archive:path.relative(root,archive).split(path.sep).join('/'),integrity:expected.integrity,
    files:files.map(file=>({path:file,sha256:hash(path.join(target,file))}))});
}
const report={at:new Date().toISOString(),purpose:'Add lockfile-verified Linux optional packages without pruning Windows packages',installScriptsExecuted:false,records};
const destination=path.join(root,'evidence/sharp-shared-install.json');
const existing=fs.lstatSync(destination,{throwIfNoEntry:false});
if(existing){assert(existing.isFile()&&!existing.isSymbolicLink()&&existing.nlink===1);assert.equal(fs.realpathSync(destination),destination);}
fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({verifiedPackages:records.map(r=>({name:r.name,version:r.version,files:r.files.length})),installScriptsExecuted:false}));
