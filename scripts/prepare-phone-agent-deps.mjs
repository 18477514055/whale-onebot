import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(process.platform,'linux');
const root='/mnt/d/qq-onebot',source=process.argv[2];
assert(typeof source==='string' && source.startsWith(root+'/.tmp/phone-agent-current-') && path.basename(source)==='app');
const work=fs.mkdtempSync(root+'/.tmp/phone-agent-deps-');
const app=path.join(work,'app');fs.mkdirSync(app);fs.mkdirSync(path.join(work,'home'));fs.mkdirSync(path.join(work,'cache'));
const inputs=[];
const packageBytes=fs.readFileSync(path.join(source,'package.json'));
const pkg=JSON.parse(packageBytes);
inputs.push({name:'phone-app/package.json',sha256:createHash('sha256').update(packageBytes).digest('hex')});
let lock,dependencyPolicy;
if(fs.existsSync(path.join(source,'package-lock.json'))){
  const bytes=fs.readFileSync(path.join(source,'package-lock.json'));lock=JSON.parse(bytes);
  inputs.push({name:'phone-app/package-lock.json',sha256:createHash('sha256').update(bytes).digest('hex')});
  dependencyPolicy='phone-root-lock';
}else{
  const bytes=fs.readFileSync(root+'/.tmp/phone-agent-dependency-lock-20261115.json');lock=JSON.parse(bytes);
  inputs.push({name:'phone-installed-hidden-lock',sha256:createHash('sha256').update(bytes).digest('hex')});
  // Phone deployment has no root lock; preserve its actually installed versions,
  // not newer ranges in its app manifest. These are only runtime setup metadata.
  for(const name of Object.keys(pkg.dependencies)){
    const installed=lock.packages['node_modules/'+name];assert(installed&&typeof installed.version==='string');
    pkg.dependencies[name]=installed.version;
  }
  delete pkg.devDependencies;delete pkg.scripts;
  lock.name=pkg.name;lock.version=pkg.version;lock.packages['']={name:pkg.name,version:pkg.version,
    license:pkg.license,dependencies:pkg.dependencies,engines:pkg.engines};
  dependencyPolicy='exact-versions-from-current-phone-installed-lock';
}
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify(pkg,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(app,'package-lock.json'),JSON.stringify(lock,null,2)+'\n',{flag:'wx'});
const userconfig=path.join(work,'npmrc'),globalconfig=path.join(work,'npm-globalrc');
fs.writeFileSync(userconfig,'',{flag:'wx'});fs.writeFileSync(globalconfig,'',{flag:'wx'});
const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
console.log(JSON.stringify({status:'installing-new-linux-dependencies',work,inputs}));
const result=spawnSync(process.execPath,[npm,'ci','--omit=dev','--ignore-scripts','--bin-links=false','--no-audit','--no-fund'],{
  cwd:app,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:path.join(work,'home'),LANG:'C.UTF-8',
    npm_config_userconfig:userconfig,npm_config_globalconfig:globalconfig,npm_config_cache:path.join(work,'cache'),npm_config_registry:'https://registry.npmjs.org/'},
  timeout:180000,encoding:'utf8',maxBuffer:1048576});
const report={at:new Date().toISOString(),passed:result.status===0,work,app,inputs,dependencyPolicy,runtimeDependencyVersions:pkg.dependencies,status:result.status,signal:result.signal,
  stdout:result.stdout,stderr:result.stderr,phoneDependenciesReused:false,installScriptsExecuted:false};
const output=path.join(root,`evidence/phone-agent-current-linux-deps-${path.basename(work)}-20261115.json`);
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...report,output}));
if(!report.passed)process.exitCode=1;
