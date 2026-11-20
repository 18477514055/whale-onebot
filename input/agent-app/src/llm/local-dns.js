// [LOCAL-ONLY] DNS resilience for Termux's slow system-resolver fallback.
// Upstream safe-fetch remains responsible for validating ALL addresses and pinning requests.
import dns from 'node:dns';
import net from 'node:net';

export const LOCAL_DNS_POLICY = Object.freeze({
  timeoutMs: 12000,
  cacheTtlMs: 5 * 60 * 1000,
  cacheLimit: 500,
  fallbackTimeoutMs: 4500,
  fallbackServers: Object.freeze(['223.5.5.5', '119.29.29.29', '1.1.1.1'])
});

function bounded(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error('DNS 解析超时'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function validAddresses(addresses) {
  if (!Array.isArray(addresses) || !addresses.length) throw new Error('域名没有解析结果');
  // Never silently discard an invalid/private result: the caller must reject the whole set.
  return addresses.map((entry) => {
    const family = net.isIP(String(entry?.address || ''));
    if (!family) throw new Error('DNS 返回了无效地址');
    return { address: String(entry.address), family };
  });
}

/** Dependencies are injectable only through this module API for deterministic offline tests. */
export function createLocalDnsLookup({
  lookup = dns.promises.lookup,
  resolverFactory = () => new dns.Resolver({ timeout: 4000, tries: 1 }),
  now = Date.now,
  policy = LOCAL_DNS_POLICY
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const clone = (entries) => entries.map((entry) => ({ ...entry }));

  async function fallback(hostname) {
    for (const server of policy.fallbackServers) {
      const resolver = resolverFactory();
      try {
        resolver.setServers([server]);
        const addresses = await bounded(new Promise((resolve, reject) => {
          resolver.resolve4(hostname, (error, values) => {
            if (error) reject(error);
            else resolve((values || []).map((address) => ({ address, family: 4 })));
          });
        }), policy.fallbackTimeoutMs, () => resolver.cancel?.());
        return validAddresses(addresses);
      } catch {
        // Failed lookups are not cached; a different resolver may still succeed.
      } finally {
        resolver.cancel?.();
      }
    }
    return null;
  }

  async function resolve(hostname) {
    let addresses;
    try {
      addresses = validAddresses(await bounded(
        Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
        policy.timeoutMs
      ));
    } catch (originalError) {
      addresses = await fallback(hostname);
      if (!addresses) throw originalError;
    }
    // Cache DNS results, not a policy decision. Upstream rechecks private/fake-IP policy on every use.
    if (cache.size >= policy.cacheLimit && !cache.has(hostname)) cache.delete(cache.keys().next().value);
    cache.set(hostname, { at: now(), addresses: clone(addresses) });
    return addresses;
  }

  return async function localDnsLookup(hostname) {
    const key = String(hostname || '').toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < policy.cacheTtlMs) return clone(hit.addresses);
    if (hit) cache.delete(key);
    if (!inFlight.has(key)) {
      const pending = resolve(key).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return clone(await inFlight.get(key));
  };
}
