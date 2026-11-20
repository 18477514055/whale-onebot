export const abi=1, platform='bilibili';
// No QQ-only operations in the Bilibili model's tool catalog. Platform extensions
// are discovered separately from this binding's own OneBot service and explicit grants.
const shared = new Set(['send_message','finish','get_recent_messages','get_message_detail','memory_append','memory_query','memory_remove','knowledge_search','dice','web_search','web_fetch','report_feedback','meme_lookup','meme_remember','skill_list','skill_use']);
export const allowsBuiltin = name => shared.has(name);
export {standaloneInstance} from './standalone.js';
export {biliRuntimeToolDefs as toolDefs,parseBiliToolGrants as parseToolGrants} from './tool-defs.js';
import {withBiliAccountGuard} from '../../onebot/local-account-guard.js';
import {requireBindingEndpoints} from '../../core/platform-endpoints.js';
export function createClient({Transport,ActionError,instance,options}) {
  requireBindingEndpoints();
  const Guard=withBiliAccountGuard(Transport,ActionError,instance?.selfId);
  const client=new Guard(options);
  Object.defineProperty(client,'skipQqCatalog',{value:true});
  return client;
}
