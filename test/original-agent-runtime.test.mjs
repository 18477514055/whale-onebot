import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { startOriginalAgentRuntime } from '../src/host/original-agent-runtime.mjs';
import { originalBusinessSettingsMatch } from '../src/host/original-agent-config.mjs';

async function fixture(t, mode = 'healthy') {
  const root = fs.mkdtempSync(path.resolve('.tmp/original-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir=path.join(root,'data'), homeDir=path.join(root,'home');
  fs.mkdirSync(dataDir); fs.mkdirSync(homeDir); fs.mkdirSync(path.join(homeDir,'tmp'));
  const reservation=net.createServer(); await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
  const config={server:{host:'127.0.0.1',port:1234,token:''},onebot:{wsUrl:'ws://127.0.0.1:9',httpUrl:'http://127.0.0.1:9',accessToken:'',httpAccessToken:'',catchupReplyWindowMs:12345},
    api:{baseUrl:'https://opencode.ai/inference/go/openai/v1',apiKey:'',model:'synthetic-model',timeout:60000,extraBody:{}},
    runtime:{mode:'active',paused:false},allow:{groups:[20001,20002],private:[30001]},
    proactive:{enabled:true},timeControl:{enabled:true},store:{groupSliderPos:{20001:17,20002:83}},persona:'SYNTHETIC'};
  fs.writeFileSync(path.join(dataDir,'config.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(dataDir,'messages.sqlite'),'SYNTHETIC_SENTINEL_NOT_SQLITE');
  const preloadPath=path.join(root,'preload.mjs'),appEntry=path.join(root,'fixture.mjs');
  fs.writeFileSync(preloadPath,'// synthetic preload\n');
  fs.writeFileSync(appEntry,`import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
    const cfg=JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR,'config.json')));
    fs.writeFileSync(path.join(process.env.QQ_AGENT_DATA_DIR,'env-flags.json'),JSON.stringify({
      armed:process.env.WHALE_ORIGINAL_AGENT==='1',keyInherited:!!process.env.SYNTHETIC_PARENT_KEY,
      model:cfg.api.model,base:cfg.api.baseUrl,mode:cfg.runtime.mode,paused:cfg.runtime.paused}));
    ${mode === 'exit' ? 'process.exit(7);' : ''}
    const server=http.createServer((req,res)=>{fs.appendFileSync(path.join(process.env.QQ_AGENT_DATA_DIR,'routes.log'),req.method+' '+req.url+'\\n');res.end('ok');});
    server.listen(cfg.server.port,'127.0.0.1');
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `);
  return {root,dataDir,homeDir,logDir:root,preloadPath,appEntry,config,consolePort:port,
    onebot:{port:45671,wsPort:45672,token:'synthetic-onebot-token'},onebotSha256:'a'.repeat(64),
    modelBase:'http://127.0.0.1:45673/v1',modelRelay:'synthetic-relay-token',startupTimeoutMs:10000};
}

test('normal actual child startup preserves business settings and only requests health', async t=>{
  const f=await fixture(t), updates=[];
  process.env.SYNTHETIC_PARENT_KEY='SYNTHETIC_NOT_A_REAL_KEY';
  t.after(()=>delete process.env.SYNTHETIC_PARENT_KEY);
  const runtime=await startOriginalAgentRuntime({...f,publish:value=>updates.push(value)});
  try {
    assert.equal(runtime.businessSettingsPreserved,true);
    const configured=JSON.parse(fs.readFileSync(path.join(f.dataDir,'config.json')));
    assert(originalBusinessSettingsMatch(f.config,configured));
    assert.deepEqual(configured.allow,f.config.allow); assert.deepEqual(configured.store,f.config.store);
    assert.equal(fs.readFileSync(path.join(f.dataDir,'messages.sqlite'),'utf8'),'SYNTHETIC_SENTINEL_NOT_SQLITE');
    const env=JSON.parse(fs.readFileSync(path.join(f.dataDir,'env-flags.json')));
    assert.deepEqual(env,{armed:true,keyInherited:false,model:'synthetic-model',base:f.config.api.baseUrl,mode:'active',paused:false});
    assert.match(fs.readFileSync(path.join(f.dataDir,'routes.log'),'utf8'),/^(GET \/healthz\n)+$/);
    assert.equal(updates.at(-1).stage,'ready-original-rules');
  } finally { await runtime.stop(); }
  if (process.platform === 'win32') assert.equal((await runtime.exited).signal,'SIGTERM');
  else { assert.equal((await runtime.exited).signal,null); assert.equal((await runtime.exited).code,0); }
  assert.equal(await runtime.stop(),await runtime.exited);
});

test('original paused/observe state is not activated by normal launcher',async t=>{
  const f=await fixture(t); f.config.runtime={mode:'observe',paused:true};
  fs.writeFileSync(path.join(f.dataDir,'config.json'),JSON.stringify(f.config));
  const runtime=await startOriginalAgentRuntime(f);
  try { assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir,'env-flags.json'))).paused,true); }
  finally { await runtime.stop(); }
});

test('normal startup failure is observed and not automatically retried',async t=>{
  const f=await fixture(t,'exit');
  await assert.rejects(startOriginalAgentRuntime(f),/AGENT_START_EXIT/);
  assert.equal(fs.readFileSync(path.join(f.logDir,'agent-stderr.log'),'utf8'),'');
});

test('aborted startup does not rewrite config or start a process',async t=>{
  const f=await fixture(t),abort=new AbortController();abort.abort();
  const bytes=fs.readFileSync(path.join(f.dataDir,'config.json'));
  await assert.rejects(startOriginalAgentRuntime({...f,signal:abort.signal}));
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'config.json')),bytes);
  assert(!fs.existsSync(path.join(f.dataDir,'env-flags.json')));
});
