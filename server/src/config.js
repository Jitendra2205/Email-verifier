import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const SERVER_ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(SERVER_ROOT, 'data');

// Minimal .env loader (no dependency). Values already in the real environment win.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'jobs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

// Persist a generated data key on first boot so restarts can still read old jobs.
function resolveDataKey() {
  const fromEnv = process.env.DATA_ENCRYPTION_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    }
    return buf;
  }
  const keyFile = path.join(DATA_DIR, '.datakey');
  if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  return key;
}

/**
 * Hard cut-off for a shared demo instance.
 *
 * `ACCESS_EXPIRES_AT` is an ISO-8601 timestamp. Past it the whole application
 * refuses service — no login, no API, no export — and the retention sweep
 * deletes every job. This exists so "the link expires in 48 hours" is enforced
 * by the server rather than being a promise in a document; a demo URL handed to
 * an outside reviewer should stop working on its own, without anyone having to
 * remember to shut it down.
 */
function resolveAccessExpiry() {
  const raw = process.env.ACCESS_EXPIRES_AT;
  if (!raw) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) {
    throw new Error(`ACCESS_EXPIRES_AT is not a valid ISO-8601 timestamp: ${raw}`);
  }
  return at;
}

export const config = {
  port: num('PORT', 4310),
  nodeEnv: process.env.NODE_ENV || 'development',
  accessExpiresAt: resolveAccessExpiry(),

  auth: {
    user: process.env.AUTH_USER || 'marketing',
    passwordHash: process.env.AUTH_PASSWORD_HASH || '',
    // Dev-only fallback so the app is runnable straight after clone.
    devPassword: process.env.AUTH_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    sessionTtlMs: num('SESSION_TTL_HOURS', 12) * 3600_000,
  },

  dataKey: resolveDataKey(),
  retentionDays: num('RETENTION_DAYS', 7),

  chunkSize: num('CHUNK_SIZE', 1000),
  maxUploadBytes: num('MAX_UPLOAD_MB', 200) * 1024 * 1024,
  // Excel, Word and PDF must be held in memory to parse — none of their
  // libraries offer a row-streaming reader over a buffer. A 200 MB workbook
  // would expand to several times that as parsed objects and could take the
  // process down, so buffered formats get their own, much lower ceiling.
  // CSV/TSV keep the full limit because they genuinely stream.
  maxBufferedUploadBytes: num('MAX_BUFFERED_UPLOAD_MB', 25) * 1024 * 1024,
  maxRows: num('MAX_ROWS', 500_000),

  dns: {
    concurrency: num('DNS_CONCURRENCY', 40),
    timeoutMs: num('DNS_TIMEOUT_MS', 5000),
    perDomainPerMinute: num('DOMAIN_LOOKUPS_PER_MINUTE', 20),
    cacheTtlMs: num('DNS_CACHE_TTL_MINUTES', 720) * 60_000,
  },

  smtp: {
    enabled: bool('SMTP_PROBE_ENABLED', false),
    // Configurable so the probe logic can be exercised against a local mock
    // server in tests instead of sending traffic to real third-party MTAs.
    port: num('SMTP_PORT', 25),
    from: process.env.SMTP_PROBE_FROM || 'verify@example.com',
    helo: process.env.SMTP_PROBE_HELO || 'verifier.example.com',
    perDomainPerMinute: num('SMTP_PROBES_PER_DOMAIN_PER_MINUTE', 3),
    concurrency: num('SMTP_CONCURRENCY', 8),
    timeoutMs: num('SMTP_TIMEOUT_MS', 8000),
  },

  rateLimit: {
    loginPerMinute: num('LOGIN_ATTEMPTS_PER_MINUTE', 10),
    uploadsPerHour: num('UPLOADS_PER_HOUR', 20),
    apiPerMinute: num('API_REQUESTS_PER_MINUTE', 600),
  },
};
