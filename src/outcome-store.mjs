import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// A new-project-only crash latch. No messages, targets, tokens or native tickets.
// Presence of pending.json prevents writes after a process crash. It is not a
// delivery queue: this file must never drive an automatic retry.
export class OutcomeStore {
  constructor(projectRoot, instance = randomUUID(), options = {}) {
    // boot = 本进程这次启动的标识，写进每条 pending 记录：
    // 它让「下一次启动」能区分「这是我自己进程内的未知」还是「上一个进程遗留的未知」。
    this.boot = randomUUID();
    this.orphaned = null;
    // adoptForeign=true：把「别的进程写的 pending」隔离留证并开闸。
    //   默认 false 保持旧语义（重启后继续冻结，fail closed）——
    //   只有我们的机器人进程显式开启，因为「重启打断在途发送」在生产上是常态，
    //   永久冻结会让机器人静默（用户 2026-11-18 反复报告的问题）。
    this.adoptForeign = options.adoptForeign === true;
    if(typeof projectRoot!=='string'||!path.isAbsolute(projectRoot))throw new TypeError('Absolute project root required');
    const root=fs.realpathSync(projectRoot);
    if(path.basename(root).toLowerCase()!=='qq-onebot')throw new Error('Dedicated qq-onebot project required');
    this.root=root;
    this.dir=path.join(root,'runtime','outcomes');
    for(const dir of [path.join(root,'runtime'),this.dir]){
      if(!fs.existsSync(dir))fs.mkdirSync(dir,{mode:0o700});
      const stat=fs.lstatSync(dir);
      if(stat.isSymbolicLink()||!stat.isDirectory()||fs.realpathSync(dir)!==dir)throw new Error('Outcome path must be a physical project directory');
    }
    this.file=path.join(this.dir,'pending.json');
    this.lock=path.join(this.dir,'owner.lock');
    this.lockFd=fs.openSync(this.lock,'wx',0o600);
    this.closed=false;
    try {
      fs.writeFileSync(this.lockFd,JSON.stringify({pid:process.pid,instance}));fs.fsyncSync(this.lockFd);
      this.pending=fs.existsSync(this.file);
      if(this.pending){
        const st=fs.lstatSync(this.file);
        if(st.isSymbolicLink()||!st.isFile()||st.size>4096)throw new Error('Invalid outcome latch');
        // An unreadable/corrupt latch is still blocked, never interpreted as clear.
        try {this.record=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.record={state:'unreadable'};}
        // ★ 关键修复（2026-11-18）：pending 记录若不是**本进程**写的，它只能来自上一次运行
        //   （重启/重装打断在途发送时最常见）。那种"未知"在本次会话里**无法对账**，
        //   留着它只会把写闸永久关死 ⇒ 机器人静默（用户反复遇到的"更新完一会儿就不说话了"）。
        //   正确做法：把它隔离成 pending.orphaned-*.json 留证，闸打开，并在 status 里报数量。
        //   注意：只隔离**别的进程**写的记录；本进程自己写的那条仍然照旧冻结（fail closed 不变）。
        const foreign = this.adoptForeign && this.record && this.record.boot !== this.boot;
        if (foreign) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const target = path.join(this.dir, 'pending.orphaned-' + stamp + '.json');
          try { fs.renameSync(this.file, target); } catch { try { fs.copyFileSync(this.file, target); fs.unlinkSync(this.file); } catch {} }
          this.orphaned = { action: this.record.action ?? null, state: this.record.state ?? null,
            time: this.record.time ?? null, file: path.basename(target) };
          this.pending = false;
          this.record = undefined;
        }
      }
    }catch(error){fs.closeSync(this.lockFd);fs.unlinkSync(this.lock);throw error;}
  }
  // 把当前未决记录挪成留证文件并解冻。
  // ★ 2026-11-19 用户口径：外发优先。上一次「结果未知」不该阻止下一条发送 ——
  //   记录留成 pending.<tag>-*.json 供人工查看，写闸不关。
  #retire(tag){
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const target=path.join(this.dir,`pending.${tag}-${stamp}.json`);
    try{fs.renameSync(this.file,target);}
    catch{try{fs.copyFileSync(this.file,target);fs.unlinkSync(this.file);}catch{}}
    this.pending=false;this.record=undefined;
    return path.basename(target);
  }
  begin(action) {
    if(this.closed)throw new Error('Outcome store closed');
    // 上一次的记录没回收时不再抛错拒绝：隔离留证后继续发。
    if(this.pending)this.retired=this.#retire('superseded');
    if(typeof action!=='string'||!/^[a-z_]+$/.test(action))throw new TypeError('Invalid action');
    const record={version:1,operation:randomUUID(),boot:this.boot,action,state:'submitted_or_pending',time:new Date().toISOString()};
    const fd=fs.openSync(this.file,'wx',0o600);
    // The directory entry now exists even if data write, sync or close fails.
    // Keep it as evidence and block reuse by this store as well as its successor.
    this.pending=true;this.record=record;
    try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  confirmed() {
    if(this.closed)throw new Error('Outcome store closed');
    if(this.pending)fs.unlinkSync(this.file);
    this.pending=false;this.record=undefined;
  }
  // Operator-initiated reconciliation: deliberately drop an unresolved record.
  // Never called automatically and never followed by a resend; the caller has
  // been told the delivery state is unknown and has decided to clear it.
  discard(reason) {
    if(this.closed)throw new Error('Outcome store closed');
    const previous=this.record?{action:this.record.action,state:this.record.state,time:this.record.time}:null;
    if(this.pending)fs.unlinkSync(this.file);
    this.pending=false;this.record=undefined;
    return { cleared: previous!==null, previous, reason: typeof reason==='string'?reason.slice(0,120):'' };
  }
  close(){if(this.closed)return;this.closed=true;fs.closeSync(this.lockFd);fs.unlinkSync(this.lock);}
}

// Called by the parent only after observing the exit of its own child.
export function releaseExitedChildLock(projectRoot, pid, instance) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof instance !== 'string')
    throw new TypeError('Expected the identity of an exited child');
  const root = fs.realpathSync(projectRoot);
  if (path.basename(root).toLowerCase() !== 'qq-onebot') throw new Error('Dedicated qq-onebot project required');
  const lock = path.join(root, 'runtime', 'outcomes', 'owner.lock');
  const state = fs.lstatSync(lock, { throwIfNoEntry: false });
  if (!state) return;
  if (!state.isFile() || state.nlink !== 1 || state.size > 4096 || fs.realpathSync(lock) !== lock)
    throw new Error('Invalid OneBot owner lock');
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
  if (owner.pid === pid && owner.instance === instance) fs.unlinkSync(lock);
}
