// Never initialize an agent profile if a test discovery tool executes this fixture.
if (!process.send || process.env.ROBOT_MEMORY_TEST !== '1') process.exit(0);
const { getConfig } = await import('../../input/agent-app/src/core/config.js');
const { MemoryStore } = await import('../../input/agent-app/src/memory/memory-global.js');
const { writeKnowledgeFile,searchKnowledge,deleteKnowledgeFile } = await import('../../input/agent-app/src/knowledge/store.js');
const { notePersonaInteraction,personaStateSnapshot } = await import('../../input/agent-app/src/core/persona-state.js');
globalThis.fetch = () => { throw Error('Offline fixture forbids network'); };
const config = getConfig();
config.knowledge.enabled = true;
config.humanize.enabled = true;
config.humanize.personaState.enabled = true;
const memory = new MemoryStore();
const chat = 'private:42', persona = { templateId:'example' };
const fs = await import('node:fs'); const path = await import('node:path');
const libraries = await import('../../input/agent-app/src/features/knowledge-lib.js');
const data=process.env.QQ_AGENT_DATA_DIR, corpus=path.join(process.env.QQ_AGENT_DURABLE_DIR,'corpus','test');
let snapshot;
const ops = {
  legacySearch(id){return memory.search(chat,'saffron',{userId:id}).results;},
  catalogSnapshot(){snapshot=libraries.loadLibraries(data);},
  saveStale(){return libraries.saveLibraries(data,snapshot);},
  async libraryBuild(){
    fs.mkdirSync(corpus,{recursive:true}); fs.writeFileSync(path.join(corpus,'manual.txt'),'saffron anthology');
    const libs=libraries.loadLibraries(data); libs.manual={dirs:[corpus],name:'Manual'}; libraries.saveLibraries(data,libs);
    return libraries.buildIndex(data,'manual');
  },
  async libraryFail(){fs.writeFileSync(path.join(corpus,'manual.txt'),'uncommitted');return libraries.buildIndex(data,'manual',{onProgress(){throw Error('fixture interruption');}});},
  async libraryCrash(){return libraries.buildIndex(data,'manual',{onProgress(){process.exit(73);}});},
  async libraryRead(){return (await libraries.search(data,'saffron')).results;},
  badCorpus(){const libs=libraries.loadLibraries(data); libs.wrong={dirs:[data]}; libraries.saveLibraries(data,libs);},
  put() {
    memory.append(chat,'memberImpression','cobalt hiking',{userId:'42',target:'Walker'});
    memory.noteInteraction('42');
    notePersonaInteraction(persona);
    memory.setHandoff(chat, {topic:'local only'},{lastReply:'secret transcript'});
    return writeKnowledgeFile('guide.md','saffron manual');
  },
  append([prefix,n]) {
    for(let i=0;i<n;i++) { memory.append(chat,'memberImpression',`${prefix} ${i}`,{userId:'42',target:'Walker'}); memory.noteInteraction('42'); }
  },
  read() {
    return { person:memory.getMember(chat,'42'),recall:memory.query(chat).memberImpression, search:memory.search(chat,'hiking').results,
      hits:searchKnowledge('saffron').results, persona:personaStateSnapshot(persona).lastInteractionAt,
      handoff:memory.getHandoff(chat) };
  },
  strict() { config.memory.visibility.mode='perChat'; return memory.query(chat).memberImpression; },
  drop() { return deleteKnowledgeFile('guide.md'); }
};
process.on('message', async ({op,args})=>{
  try { process.send({value:(await ops[op](args)) ?? null}); } catch(e) { process.send({error:e.stack}); }
});
process.send({ready:true});
