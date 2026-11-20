// Worker-side adapters, not protocol servers. No discovery from manifests or arbitrary paths.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const entries = new Map(['qq','bilibili'].map(p=>[p,`../platform-modules/${p}/index.mjs`]));
const cache=new Map();
export function loadPlatformModule(platform) {
  if (!entries.has(platform)) throw Error('Unsupported worker platform');
  if (!cache.has(platform)) {
    const entry=entries.get(platform);
    if (!existsSync(new URL(entry,import.meta.url))) throw Object.assign(Error(`Install the ${platform} runtime module`),{code:'PLATFORM_MODULE_MISSING'});
    const adapter=require(entry);
    if (adapter.abi!==1 || adapter.platform!==platform || typeof adapter.createClient!=='function' || typeof adapter.toolDefs!=='function' || typeof adapter.standaloneInstance!=='function') throw Error(`Incompatible ${platform} runtime module`);
    cache.set(platform,adapter);
  }
  return cache.get(platform);
}
export function activePlatformModule() { return loadPlatformModule(process.env.WHALE_AGENT_PLATFORM || 'qq'); }
