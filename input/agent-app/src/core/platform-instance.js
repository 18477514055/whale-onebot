import fs from 'node:fs';
import path from 'node:path';
import { loadPlatformModule } from './platform-modules.js';
import { managedInstance } from './managed-binding.js';

// Check module availability and storage ownership before the application opens any database.
export function agentInstance(env=process.env) {
  const adapter=loadPlatformModule(env.WHALE_AGENT_PLATFORM || 'qq');
  if (env.QQ_AGENT_BINDING_ID) return managedInstance(env);
  if (env.QQ_AGENT_DATA_DIR && fs.existsSync(path.join(env.QQ_AGENT_DATA_DIR,'.whale-binding'))) throw Error('Managed worker data cannot be opened by a standalone worker');
  return adapter.standaloneInstance(env);
}
