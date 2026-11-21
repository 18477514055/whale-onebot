import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { biliRuntimeToolDefs } from '../input/agent-app/src/tools/bili-runtime-tools.js';
import { createAgentOneBotClient } from '../input/agent-app/src/onebot/onebot.js';
import { toOpenAiTools, executeTool } from '../input/agent-app/src/tools/tools.js';
import { createTransport } from '../src/transport/index.mjs';

const selection = { bili_get_self_profile: {}, bili_update_signature: { sign: 'string' } };
const env = { WHALE_AGENT_PLATFORM: 'bilibili', WHALE_BILI_AGENT_TOOLS: JSON.stringify(selection) };
const turn = { kind: 'private', proactive: false };
const invoke = (defs, client, name, args = {}) => executeTool(defs, { onebot: client }, name, JSON.stringify(args));

test('no discovery or Bili tools for default, QQ, group, or autonomous turns', async () => {
  const client = { skipQqCatalog: true, call: assert.fail };
  for (const [c,t,e] of [[client,turn,{}],[client,turn,{...env,WHALE_AGENT_PLATFORM:'qq'}],[{},turn,env],
    [client,{kind:'group'},env],[client,{...turn,proactive:true},env]]) assert.deepEqual(await biliRuntimeToolDefs(c,t,e), []);
});

test('fail closed on bad grants and missing or failing policy discovery', async () => {
  const calls = [];
  const client = { skipQqCatalog: true, async call(name) { calls.push(name); throw Error('SECRET_FIXTURE'); } };
  for (const grant of ['*','{"send_private_msg":{}}','{"bili_bad":{"endpoint":"string"}}','{"bili_bad":{"cookie":"string"}}']) {
    const defs = await biliRuntimeToolDefs(client,turn,{...env,WHALE_BILI_AGENT_TOOLS:grant});
    assert.deepEqual(defs.map(x=>x.name), ['bili_list_tools']);
    assert.equal((await invoke(defs,client,'bili_list_tools')).isError,true);
  }
  assert.deepEqual(calls, []);
  const defs = await biliRuntimeToolDefs(client,turn,env);
  const error = await invoke(defs,client,'bili_list_tools');
  assert.ok(error.isError); assert.doesNotMatch(error.content,/SECRET_FIXTURE/);
  assert.deepEqual(calls,['get_supported_actions']);
  client.call = async n => n === 'get_supported_actions' ? ['bili_action_catalog', ...Object.keys(selection)] :
    [{name:'bili_get_self_profile'}, {name:'bili_update_signature',write:false,params:['other']}];
  assert.deepEqual((await biliRuntimeToolDefs(client,turn,env)).map(d=>d.name), ['bili_list_tools']);
});

test('closed nested dynamic grants accept an image reference and vote, never override transport', async () => {
  const name = 'bili_dynamic_create', sent = [];
  const client = {skipQqCatalog:true, async call(action,params) {
    if (action === 'get_supported_actions') return ['bili_action_catalog',name];
    if (action === 'bili_action_catalog') return [{name, write:true, params:['text','images','vote']}];
    sent.push(structuredClone(params)); return {};
  }};
  const fields = {text:'string',images:[{url:'bili_image_ref',width:'integer',height:'integer'}],vote:{id:'string',title:'string'}};
  const defs = await biliRuntimeToolDefs(client,turn,{...env,WHALE_BILI_AGENT_WRITES:'1',WHALE_BILI_AGENT_TOOLS:JSON.stringify({[name]:fields})});
  const image = {url:'https://i0.hdslb.com/bfs/new_dyn/a123.png',width:1,height:2}; // inert reference; never fetched
  const args = {text:'offline',images:[image],vote:{id:'5',title:'choose'}};
  assert.equal(toOpenAiTools(defs).at(-1).function.parameters.properties.images.items.additionalProperties,false);
  for (const params of [{images:[{...image,headers:{}}]}, {vote:{id:'5',host:'bad'}}, {images:[{...image,url:'https://example.invalid/a.png'}]},
    {images:[{...image,url:image.url+'?access_token=fixture'}]}, {images:[{...image,width:'1'}]}]) assert.ok((await invoke(defs,client,name,params)).isError);
  assert.equal((await invoke(defs,client,name,args)).isError,false);
  assert.ok((await invoke(defs,client,name,{vote:{title:'choose',id:'5'},images:[image],text:'offline'})).isError);
  assert.deepEqual(sent,[args]);
});

test('OpenAI tool schemas and actual agent dispatch use guarded local HTTP; never replay unknown', { timeout: 10000 }, async t => {
  const selfId = 612304, calls = [], token = randomUUID();
  const success = data => ({ status:'ok', retcode:0, data });
  const server = await createTransport({ token, events: new EventEmitter(), heartbeatMs:0, dispatch: async ({action,params}) => {
    calls.push({ action, params });
    if (action === 'get_login_info') return success({user_id:selfId,platform:'bilibili'});
    if (action === 'get_supported_actions') return success(['bili_action_catalog',...Object.keys(selection),'not_granted']);
    if (action === 'bili_action_catalog') return success([{name:'bili_get_self_profile',write:false},
      {name:'bili_update_signature',write:true,params:['sign']},{name:'bili_absent',write:false}]);
    if (action === 'bili_get_self_profile') return success({name:'fixture',deep:{bili_jct:'SECRET_FIXTURE'}, note:'SESSDATA=SECRET_FIXTURE;'});
    if (action === 'bili_update_signature' && params.sign === 'unknown') return {status:'failed',retcode:1504,data:null,wording:'SECRET_FIXTURE'};
    if (action === 'bili_update_signature' && params.sign === 'denied') return {status:'failed',retcode:1403,data:null,wording:'SECRET_FIXTURE'};
    if (action === 'bili_update_signature') return success({accepted:true});
    return {status:'failed',retcode:1404,data:null};
  }});
  const route = { WHALE_ONEBOT_HTTP_URL:`http://127.0.0.1:${server.address.port}`, WHALE_ONEBOT_WS_URL:`ws://127.0.0.1:${server.wsAddress.port}/`, WHALE_ONEBOT_TOKEN:token };
  const previous = Object.fromEntries(Object.keys(route).map(k=>[k,process.env[k]]));
  Object.assign(process.env,route);
  const agent = createAgentOneBotClient({selfId},{heartbeat:'off'});
  t.after(async () => { agent.close(); await server.close(); for(const [k,v] of Object.entries(previous)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } });
  const connected = new Promise(ok => agent.onStatus(s=>{if(s.connected) ok();}));
  await agent.connect(); await connected;
  const read = await biliRuntimeToolDefs(agent,turn,env);
  assert.deepEqual(toOpenAiTools(read).map(d=>d.function.name),['bili_list_tools','bili_get_self_profile']);
  assert.ok((await invoke(read,agent,'bili_update_signature',{sign:'not dispatched'})).isError);
  const profile = await invoke(read,agent,'bili_get_self_profile'); assert.equal(profile.isError,false);
  assert.match(profile.content,/fixture/); assert.doesNotMatch(profile.content,/SECRET_FIXTURE|bili_jct/);
  const defs = await biliRuntimeToolDefs(agent,turn,{...env,WHALE_BILI_AGENT_WRITES:'1'});
  const schema = toOpenAiTools(defs).at(-1).function;
  assert.equal(schema.name,'bili_update_signature'); assert.deepEqual(schema.parameters.properties,{sign:{type:'string'}});
  assert.equal(schema.parameters.additionalProperties,false);
  assert.deepEqual(JSON.parse((await invoke(defs,agent,'bili_list_tools')).content).map(x=>x.write),[false,true]);
  for (const args of [{url:'http://example.invalid'},{sign:{foo:'bar'}}]) assert.ok((await invoke(defs,agent,schema.name,args)).isError);
  const unknown = await invoke(defs,agent,schema.name,{sign:'unknown'});
  assert.ok(unknown.isError); assert.match(unknown.content,/未知/); assert.doesNotMatch(unknown.content,/SECRET_FIXTURE/);
  assert.ok((await invoke(defs,agent,schema.name,{sign:'unknown'})).isError);
  const denied = await invoke(defs,agent,schema.name,{sign:'denied'}); assert.ok(denied.isError); assert.match(denied.content,/1403/); assert.doesNotMatch(denied.content,/SECRET_FIXTURE/);
  assert.equal((await invoke(defs,agent,schema.name,{sign:'other'})).isError,false);
  assert.deepEqual(calls.filter(c=>c.action===schema.name).map(c=>c.params),[{sign:'unknown'},{sign:'denied'},{sign:'other'}]);
});
