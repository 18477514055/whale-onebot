// Compatibility API. The Bilibili capability schema and implementation live in its optional module.
import {loadPlatformModule} from '../core/platform-modules.js';
export const parseBiliToolGrants=raw=>loadPlatformModule('bilibili').parseToolGrants(raw);
export async function biliRuntimeToolDefs(client,ctx,env=process.env) {
  if (env.WHALE_AGENT_PLATFORM !== 'bilibili') return [];
  return loadPlatformModule('bilibili').toolDefs(client,ctx,env);
}
