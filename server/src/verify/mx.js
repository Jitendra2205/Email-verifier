// Layer 2 — domain validity via MX lookup.
//
// This is the single biggest performance and safety win in the whole pipeline:
// 250K rows typically collapse to a few thousand unique domains, so the cache
// hit rate is enormous and the number of actual DNS queries stays small.
import dns from 'node:dns/promises';
import { Resolver } from 'node:dns/promises';
import { config } from '../config.js';
import { createRateLimiter, createSemaphore } from '../limiter.js';
import { log } from '../logger.js';

const resolver = new Resolver({ timeout: config.dns.timeoutMs, tries: 2 });

const cache = new Map(); // domain -> { result, expires }
const inflight = new Map(); // domain -> Promise (collapses a burst of identical lookups)
const domainLimiter = createRateLimiter({ perMinute: config.dns.perDomainPerMinute });
const gate = createSemaphore(config.dns.concurrency);

const stats = { queries: 0, cacheHits: 0, throttleWaits: 0 };
export function dnsStats() {
  return { ...stats, cachedDomains: cache.size };
}

// A domain that resolves to A/AAAA but has no MX can still receive mail via the
// implicit-MX rule (RFC 5321 §5.1), so it counts as deliverable-capable but is
// a weaker signal than a real MX record.
async function lookupOnce(domain) {
  try {
    const records = await resolver.resolveMx(domain);
    const hosts = records
      .filter((r) => r.exchange && r.exchange !== '.')
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase());
    if (hosts.length > 0) return { status: 'mx', hosts };
    return await implicitMx(domain);
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return await implicitMx(domain);
    if (code === 'ETIMEOUT' || code === 'ESERVFAIL' || code === 'ECONNREFUSED') {
      return { status: 'unknown', hosts: [], error: code };
    }
    log.warn('dns lookup failed', { domain, code: code || 'unknown' });
    return { status: 'unknown', hosts: [], error: code || 'unknown' };
  }
}

async function implicitMx(domain) {
  try {
    const addrs = await resolver.resolve4(domain).catch(() => resolver.resolve6(domain));
    if (addrs && addrs.length) return { status: 'implicit', hosts: [domain] };
  } catch { /* fall through to no_mx */ }
  return { status: 'none', hosts: [] };
}

/**
 * @returns {Promise<{status:'mx'|'implicit'|'none'|'unknown', hosts:string[], error?:string, cached?:boolean}>}
 */
export async function resolveDomain(domain, { signal } = {}) {
  if (!domain) return { status: 'none', hosts: [] };

  const hit = cache.get(domain);
  if (hit && hit.expires > Date.now()) {
    stats.cacheHits++;
    return { ...hit.result, cached: true };
  }
  if (inflight.has(domain)) return inflight.get(domain);

  const promise = (async () => {
    // Throttle per domain even for DNS. Recursive resolvers cache aggressively,
    // but a burst of thousands of queries for one domain is still a red flag.
    if (domainLimiter.retryAfterMs(domain) > 0) stats.throttleWaits++;
    await domainLimiter.take(domain, { signal });

    const release = await gate.acquire();
    try {
      stats.queries++;
      const result = await lookupOnce(domain);
      // Cache negatives for a shorter window — a domain's MX may have just been
      // provisioned, and we would rather re-check than permanently reject it.
      const ttl = result.status === 'unknown'
        ? Math.min(config.dns.cacheTtlMs, 5 * 60_000)
        : config.dns.cacheTtlMs;
      cache.set(domain, { result, expires: Date.now() + ttl });
      return result;
    } finally {
      release();
      inflight.delete(domain);
    }
  })();

  inflight.set(domain, promise);
  return promise;
}

export function primeDomainCache(entries) {
  for (const [domain, result] of entries) {
    cache.set(domain, { result, expires: Date.now() + config.dns.cacheTtlMs });
  }
}

export function exportDomainCache() {
  const out = [];
  const now = Date.now();
  for (const [domain, v] of cache) if (v.expires > now) out.push([domain, v.result]);
  return out;
}

// Prefer the OS resolvers, but fall back to public resolvers if none are
// configured (common in slim containers) so lookups don't silently all fail.
try {
  const servers = dns.getServers?.() ?? [];
  if (!servers.length) resolver.setServers(['1.1.1.1', '8.8.8.8']);
} catch { /* keep defaults */ }
