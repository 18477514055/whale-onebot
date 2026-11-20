import fs from 'node:fs';
import path from 'node:path';
export const abi=1, platform='qq';
export function standaloneInstance(env) {
  if (env.QQ_AGENT_DATA_DIR && fs.existsSync(path.join(env.QQ_AGENT_DATA_DIR,'.whale-bili-instance'))) throw Error('Bilibili data directory cannot be opened as QQ');
  return null;
}
export * as faces from './face-catalog.js';
import {withExplicitQqGuard,withLocalAccountGuard} from '../../onebot/local-account-guard.js';
import {requireBindingEndpoints} from '../../core/platform-endpoints.js';
export function createClient({Transport,ActionError,LegacyClient,instance,options}) {
  if(!instance && LegacyClient) return new LegacyClient(options);
  if(instance) requireBindingEndpoints();
  const Guard=instance ? withExplicitQqGuard(Transport,ActionError,instance.selfId) : withLocalAccountGuard(Transport,ActionError);
  return new Guard(options);
}
export function toolDefs() { return []; } // v11 builtins provided by the historical engine
