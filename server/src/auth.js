// Authentication gate.
//
// The PRD is explicit that this must never be a public unauthenticated
// endpoint. Every /api route except /api/health and /api/session is behind
// requireAuth, and the static client is served but is useless without a session.
import crypto from 'node:crypto';
import { config } from './config.js';
import { verifyPassword, hashPassword } from './crypto.js';
import { createRateLimiter } from './limiter.js';
import { log } from './logger.js';

const COOKIE = 'ev_session';
const loginLimiter = createRateLimiter({ perMinute: config.rateLimit.loginPerMinute });

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.auth.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', config.auth.sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function checkCredentials(user, password) {
  if (!user || !password) return false;
  const userOk = user.length === config.auth.user.length
    && crypto.timingSafeEqual(Buffer.from(user), Buffer.from(config.auth.user));

  let passOk = false;
  if (config.auth.passwordHash) {
    passOk = verifyPassword(password, config.auth.passwordHash);
  } else if (config.auth.devPassword) {
    const a = Buffer.from(password);
    const b = Buffer.from(config.auth.devPassword);
    passOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  // Both checks always run so the response time doesn't leak which one failed.
  return userOk && passOk;
}

export function issueSession(res, user) {
  const token = sign({ u: user, exp: Date.now() + config.auth.sessionTtlMs });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production',
    maxAge: config.auth.sessionTtlMs,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function currentUser(req) {
  const payload = unsign(readCookie(req, COOKIE));
  return payload?.u || null;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  req.user = user;
  next();
}

/** Brute-force protection on the login endpoint, keyed by client IP. */
export function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  if (!loginLimiter.tryTake(key)) {
    log.warn('login rate limit hit', { ip: key });
    return res.status(429).json({ error: 'Too many login attempts. Wait a minute and try again.' });
  }
  next();
}

/**
 * Generic per-user+IP limiter for the write-heavy endpoints.
 * `max` is a count per `windowMs`, not a per-minute rate — the window is what
 * varies between endpoints (uploads are hourly, ordinary API calls per minute).
 */
export function rateLimit({ max, windowMs = 60_000, message }) {
  const limiter = createRateLimiter({ perMinute: max, windowMs });
  return (req, res, next) => {
    const key = `${req.user || 'anon'}:${req.ip || 'unknown'}`;
    if (!limiter.tryTake(key)) {
      const retryAfter = Math.ceil(limiter.retryAfterMs(key) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || 'Rate limit exceeded', retryAfter });
    }
    next();
  };
}

export function authConfigWarning() {
  if (config.auth.passwordHash) return null;
  if (config.auth.devPassword) {
    return 'AUTH_PASSWORD is set in plaintext. Use AUTH_PASSWORD_HASH before deploying.';
  }
  return 'No AUTH_PASSWORD_HASH or AUTH_PASSWORD configured — login is impossible. Run: npm start -- --hash "your password"';
}

export { hashPassword };
