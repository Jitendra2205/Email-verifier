import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT } from './config.js';
import { log } from './logger.js';
import {
  authConfigWarning, checkCredentials, clearSession, currentUser, hashPassword,
  issueSession, loginRateLimit, rateLimit, requireAuth,
} from './auth.js';
import { deleteJobRows, listJobs, sweepExpired } from './store.js';
import { dbStats } from './db.js';
import { migrateFileStore } from './migrate-filestore.js';
import { recoverInterruptedJobs } from './runner.js';
import { router as jobsRouter } from './routes/jobs.js';

// `npm start -- --hash "password"` prints a hash to paste into .env.
// It is printed once to stdout and never stored or logged by the app.
const hashFlag = process.argv.indexOf('--hash');
if (hashFlag !== -1) {
  const password = process.argv[hashFlag + 1];
  if (!password) {
    process.stderr.write('Usage: npm start -- --hash "your password"\n');
    process.exit(1);
  }
  process.stdout.write(`AUTH_PASSWORD_HASH=${hashPassword(password)}\n`);
  process.exit(0);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    // No external origins at all: the contact list must never leave this server
    // as a side effect of loading the page (no CDN, no analytics, no fonts).
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
      "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  });
  if (config.nodeEnv === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Same-origin enforcement for state-changing requests. Combined with the
// SameSite=Strict session cookie this closes off CSRF without a token dance.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // curl / same-origin form posts
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (new URL(origin).host !== host) {
      return res.status(403).json({ error: 'Cross-origin request refused' });
    }
  } catch {
    return res.status(403).json({ error: 'Bad Origin header' });
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

/**
 * Hard expiry for a shared demo instance.
 *
 * Placed above every route including auth, so an expired link cannot be used
 * even with valid credentials or a session cookie issued earlier. /api/health
 * stays reachable so a host's health check does not flap the container.
 */
export function accessExpired() {
  return config.accessExpiresAt != null && Date.now() > config.accessExpiresAt;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    expired: accessExpired(),
  });
});

app.use((req, res, next) => {
  if (!accessExpired()) return next();
  if (req.path === '/api/health') return next();
  const message = 'This demo link has expired. Contact Jitendra Singh for a fresh link.';
  if (req.path.startsWith('/api/')) {
    return res.status(410).json({ error: message, expired: true });
  }
  return res.status(410).type('text/plain').send(message);
});

app.get('/api/session', (req, res) => {
  const user = currentUser(req);
  res.json({
    authenticated: Boolean(user),
    user,
    // Surfaced so the UI can warn before the link dies mid-review.
    accessExpiresAt: config.accessExpiresAt,
  });
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const { user, password } = req.body || {};
  if (!checkCredentials(String(user || ''), String(password || ''))) {
    log.warn('failed login', { ip: req.ip, user: String(user || '').slice(0, 40) });
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  issueSession(res, String(user));
  log.info('login succeeded', { user: String(user) });
  // Same shape as /api/session: the client seeds its state straight from this
  // response, so leaving the expiry out here hid the countdown until reload.
  res.json({
    authenticated: true,
    user: String(user),
    accessExpiresAt: config.accessExpiresAt,
  });
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.use('/api', requireAuth, rateLimit({
  max: config.rateLimit.apiPerMinute,
  message: 'Slow down — too many requests.',
}), jobsRouter);

// Static client (built by Vite). In dev the Vite server proxies /api here instead.
const clientDist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('Client bundle not built. Run `npm run build`, or use `npm run dev` for the dev server.');
  });
}

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler: log the scrubbed error, return an opaque message. Stack traces
// can contain row data, so they never go to the client.
app.use((err, req, res, _next) => {
  log.error('unhandled request error', { path: req.path, method: req.method, error: err });
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong. The job was not lost — reload and check its status.' });
});

async function boot() {
  const warning = authConfigWarning();
  if (warning) log.warn(warning);

  // Pick up any jobs written by the pre-database version before doing anything
  // else, so they take part in recovery and retention like everything else.
  await migrateFileStore();

  await sweepExpired();
  setInterval(() => { sweepExpired().catch((err) => log.error('retention sweep failed', { error: err })); }, 3600_000).unref();

  // Any job still marked running belongs to a previous process — make it resumable.
  await recoverInterruptedJobs(await listJobs(), { discardPartialIngest: deleteJobRows });

  const stats = dbStats();
  app.listen(config.port, () => {
    log.info('email verifier listening', {
      port: config.port,
      env: config.nodeEnv,
      retentionDays: config.retentionDays,
      smtpProbe: config.smtp.enabled,
      clientBundle: fs.existsSync(clientDist),
      dbSchema: stats.schemaVersion,
      dbJobs: stats.jobs,
      dbRows: stats.rows,
    });
  });
}

boot().catch((err) => {
  log.error('boot failed', { error: err });
  process.exit(1);
});
