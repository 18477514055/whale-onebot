import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readSourceArchive } from './lib/source-archive.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['src','test','scripts','docs','experiments','evidence','README.md','AGENTS.md','admin-change-log.md','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','.gitignore'];
// Explicit distribution allowlist: never package runtime, .tmp, node_modules,
// downloaded runtimes, existing QQ artifacts or external file contents.
const sourceExtensions=new Set(['.mjs','.js','.c','.cc','.h','.java','.xml','.ps1','.sh','.py','.md','.json','.tap','.txt','.map','.def']);
const check=dir=>{for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const name=path.join(dir,item.name);if(item.isSymbolicLink())throw new Error('Symlink rejected');if(item.isDirectory())check(name);else{
 if(!item.isFile()||!sourceExtensions.has(path.extname(name)))throw new Error('Unexpected source artifact');
 const fd=fs.openSync(path.join(root,name),'r'),prefix=Buffer.alloc(4);try{fs.readSync(fd,prefix,0,4,0);}finally{fs.closeSync(fd);}
 if(prefix.subarray(0,2).toString()==='MZ'||prefix.toString('hex')==='7f454c46')throw new Error('Native binary rejected from source archive');
}}};
for(const dir of ['src','test','scripts','docs','experiments','evidence'])check(dir);
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
const filename='whale-onebot-0.1.0.tar.gz';
const output=path.join(root,'dist',filename);
const result=spawnSync('tar',['-czf',output,'-C',root,...files],{encoding:'utf8'});
if(result.status!==0)throw new Error('Source packaging failed');
// Read the archive's strict UTF-8 headers, not locale-dependent tar listing text.
const entries=readSourceArchive(output).map(entry=>entry.name);
if(entries.some(x=>/^(runtime|data|logs|\.tmp|\.tools|node_modules)\//.test(x)||x.includes('..')||/\.(dll|node|exe|sqlite|db|o|a|lib|dylib|deb|so(?:\.\d+)*)$/i.test(x)))throw new Error('Unexpected archive content');
const report={file:filename,sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex'),bytes:fs.statSync(output).size,entries:entries.length,containsNativeBinaries:false,containsExistingData:false};
fs.writeFileSync(path.join(root,'dist','manifest.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
