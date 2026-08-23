// Layer 6 (optional, off by default) — SMTP RCPT TO probe, plus the catch-all
// detection from layer 5 which can only be done honestly over SMTP.
//
// Why this is opt-in and never decisive:
//   * Gmail, Outlook and Yahoo do not return truthful RCPT responses — they
//     accept-then-bounce, so a 250 here means nothing.
//   * Catch-all domains (very common in corporate mail) accept every recipient,
//     producing false positives at scale.
//   * Probing at 250K volume from one IP is itself spam-defence-triggering
//     behaviour and can get the IP blocklisted.
//   * Port 25 outbound is blocked by most cloud and residential providers, so
//     in many deployments this layer simply cannot run.
//
// Therefore: a probe result can downgrade confidence or add a reason, but it can
// never on its own move a row to Invalid.
import net from 'node:net';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { createRateLimiter, createSemaphore } from '../limiter.js';
import { log } from '../logger.js';

const probeLimiter = createRateLimiter({ perMinute: config.smtp.perDomainPerMinute });
const gate = createSemaphore(config.smtp.concurrency);
const catchAllCache = new Map(); // domain -> 'yes' | 'no' | 'unknown'
const catchAllInflight = new Map();

const stats = { sessions: 0, blocked: 0, timeouts: 0 };
export function smtpStats() { return { ...stats, catchAllChecked: catchAllCache.size }; }

/** One SMTP conversation; asks about several recipients over the same connection. */
function smtpSession(host, recipients) {
  return new Promise((resolve) => {
    const answers = new Map();
    let stage = 'greet';
    let queue = [...recipients];
    let current = null;
    let buffer = '';
    let settled = false;

    const socket = net.createConnection({ host, port: config.smtp.port });
    socket.setEncoding('utf8');
    socket.setTimeout(config.smtp.timeoutMs);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve({ answers, error });
    };

    const send = (line) => socket.write(line + '\r\n');

    const nextRecipient = () => {
      current = queue.shift();
      if (!current) { stage = 'quit'; send('QUIT'); finish(null); return; }
      stage = 'rcpt';
      send(`RCPT TO:<${current}>`);
    };

    socket.on('connect', () => { stats.sessions++; });
    socket.on('timeout', () => { stats.timeouts++; finish('timeout'); });
    socket.on('error', (err) => finish(err.code || 'socket_error'));
    socket.on('close', () => finish(null));

    socket.on('data', (chunk) => {
      buffer += chunk;
      // SMTP multi-line replies use "250-" for continuation, "250 " for the last line.
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue;
        const code = parseInt(line.slice(0, 3), 10);
        handle(code, line);
        if (settled) return;
      }
    });

    function handle(code, line) {
      switch (stage) {
        case 'greet':
          if (code !== 220) return finish(`greeting_${code}`);
          stage = 'ehlo';
          send(`EHLO ${config.smtp.helo}`);
          return;
        case 'ehlo':
          if (code !== 250) return finish(`ehlo_${code}`);
          stage = 'mail';
          send(`MAIL FROM:<${config.smtp.from}>`);
          return;
        case 'mail':
          if (code !== 250) return finish(`mailfrom_${code}`);
          return nextRecipient();
        case 'rcpt': {
          const verdict = code >= 200 && code < 300 ? 'accepted'
            : code >= 500 && code < 600 ? 'rejected'
            : 'deferred';
          answers.set(current, { verdict, code, message: line.slice(4, 120) });
          // A 4xx or an anti-abuse block mid-session means the rest of this
          // session's answers would be meaningless — stop rather than push.
          if (verdict === 'deferred' && (code === 421 || code === 450 || code === 451)) {
            stats.blocked++;
            return finish(`throttled_${code}`);
          }
          return nextRecipient();
        }
        default:
          return;
      }
    }
  });
}

/**
 * Is this domain a catch-all? Probes one address that cannot plausibly exist.
 * Cached per domain — this is asked once no matter how many rows share the domain.
 */
export async function detectCatchAll(domain, hosts, { signal } = {}) {
  if (!config.smtp.enabled || !hosts?.length) return 'unknown';
  if (catchAllCache.has(domain)) return catchAllCache.get(domain);
  if (catchAllInflight.has(domain)) return catchAllInflight.get(domain);

  const promise = (async () => {
    const probe = `no-such-user-${crypto.randomBytes(8).toString('hex')}@${domain}`;
    const { verdict } = await probeRecipients(domain, hosts, [probe], { signal });
    const answer = verdict.get(probe)?.verdict;
    const result = answer === 'accepted' ? 'yes' : answer === 'rejected' ? 'no' : 'unknown';
    catchAllCache.set(domain, result);
    catchAllInflight.delete(domain);
    log.info('catch-all probe', { domain, result });
    return result;
  })();

  catchAllInflight.set(domain, promise);
  return promise;
}

/** Probe one or more recipients at a domain, respecting the per-domain rate limit. */
export async function probeRecipients(domain, hosts, recipients, { signal } = {}) {
  if (!config.smtp.enabled) return { verdict: new Map(), error: 'disabled' };
  await probeLimiter.take(domain, { signal });
  const release = await gate.acquire();
  try {
    for (const host of hosts.slice(0, 2)) {
      const { answers, error } = await smtpSession(host, recipients);
      if (answers.size > 0) return { verdict: answers, error: error || null };
      if (error === 'ECONNREFUSED' || error === 'ETIMEDOUT' || error === 'timeout') continue;
      return { verdict: answers, error };
    }
    return { verdict: new Map(), error: 'unreachable' };
  } finally {
    release();
  }
}

export function smtpEnabled() { return config.smtp.enabled; }
