// PII-safe logger.
//
// Requirement from the PRD: raw email addresses must never reach application
// logs. Rather than trusting every call site to remember that, every value that
// passes through here is scrubbed: anything shaped like an email is replaced
// with a stable, salted hash prefix so you can still correlate two log lines
// about the same address without being able to read it.
import crypto from 'node:crypto';

const SALT = crypto.randomBytes(16);
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function pseudonymize(email) {
  return 'em_' + crypto.createHash('sha256').update(SALT).update(String(email).toLowerCase()).digest('hex').slice(0, 10);
}

function scrubString(s) {
  return s.replace(EMAIL_RE, (m) => pseudonymize(m));
}

function scrub(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return scrubString(value.stack || value.message);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Belt and braces: never log these keys regardless of their content.
      // A plain number under one of these keys is an aggregate count, not
      // contact data, so it survives — aggregates are the whole point of
      // these logs, and a count cannot identify anyone.
      if (/^(email|emails|address|rows|records|sample|password|token|cookie)$/i.test(k)
        && typeof v !== 'number') {
        out[k] = '[redacted]';
      } else {
        out[k] = scrub(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function emit(level, msg, meta) {
  const line = { t: new Date().toISOString(), level, msg: scrubString(String(msg)) };
  if (meta !== undefined) line.meta = scrub(meta);
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const log = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  debug: (msg, meta) => { if (process.env.DEBUG) emit('debug', msg, meta); },
};
