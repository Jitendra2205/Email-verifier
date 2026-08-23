// The hard cut-off for a shared demo instance.
//
// These run the real HTTP server as a child process with ACCESS_EXPIRES_AT set,
// because the point of the feature is that the *whole app* refuses service —
// unit-testing the predicate alone would prove nothing about the middleware
// ordering, which is where the interesting failure lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const PASSWORD = 'expiry-test-password';

/** Boot a server on an ephemeral port with the given extra environment. */
async function startServer(extraEnv) {
  const port = 4400 + Math.floor(Math.random() * 400);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-expiry-'));
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DB_FILE: path.join(dataDir, 'test.db'),
      AUTH_USER: 'marketing',
      AUTH_PASSWORD: PASSWORD,
      AUTH_PASSWORD_HASH: '',
      SESSION_SECRET: 'test-secret-for-expiry-suite',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    base,
    async stop() {
      child.kill('SIGKILL');
      await new Promise((r) => child.on('exit', r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function login(base) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'marketing', password: PASSWORD }),
  });
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, cookies };
}

test('with no expiry configured the app behaves normally', async () => {
  const server = await startServer({});
  try {
    const { status, cookies } = await login(server.base);
    assert.equal(status, 200);
    const jobs = await fetch(`${server.base}/api/jobs`, { headers: { cookie: cookies } });
    assert.equal(jobs.status, 200);
  } finally {
    await server.stop();
  }
});

test('a future expiry is reported to the client but does not block access', async () => {
  const at = new Date(Date.now() + 48 * 3600_000).toISOString();
  const server = await startServer({ ACCESS_EXPIRES_AT: at });
  try {
    const { status, cookies } = await login(server.base);
    assert.equal(status, 200);

    const session = await (await fetch(`${server.base}/api/session`, { headers: { cookie: cookies } })).json();
    assert.equal(session.authenticated, true);
    assert.equal(session.accessExpiresAt, Date.parse(at), 'the UI needs this to show a countdown');

    // The login response must carry it too: the client seeds its session state
    // from that response, so omitting it hid the countdown until a reload.
    const loginBody = await (await fetch(`${server.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'marketing', password: PASSWORD }),
    })).json();
    assert.equal(loginBody.accessExpiresAt, Date.parse(at));

    const jobs = await fetch(`${server.base}/api/jobs`, { headers: { cookie: cookies } });
    assert.equal(jobs.status, 200);
  } finally {
    await server.stop();
  }
});

test('past the expiry the whole app returns 410, including login', async () => {
  const server = await startServer({ ACCESS_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() });
  try {
    const { status } = await login(server.base);
    assert.equal(status, 410, 'correct credentials must not get in after expiry');

    for (const route of ['/api/jobs', '/api/meta', '/api/session']) {
      const res = await fetch(`${server.base}${route}`);
      assert.equal(res.status, 410, `${route} should be gone`);
      const body = await res.json();
      assert.match(body.error, /expired/i);
      assert.equal(body.expired, true);
    }

    // The SPA itself is gone too, so a reviewer sees a plain explanation
    // rather than an app shell that cannot talk to its API.
    const page = await fetch(`${server.base}/`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /expired/i);
  } finally {
    await server.stop();
  }
});

test('a session issued before expiry stops working after it', async () => {
  // The window has to outlast server boot (migrations, WAL setup) or the link
  // is already dead by the time we can log in — boot measured ~3s, so 10s.
  const expiresAt = Date.now() + 10_000;
  const server = await startServer({ ACCESS_EXPIRES_AT: new Date(expiresAt).toISOString() });
  try {
    const { status, cookies } = await login(server.base);
    assert.equal(status, 200, 'logged in while the link was still live');

    const before = await fetch(`${server.base}/api/jobs`, { headers: { cookie: cookies } });
    assert.equal(before.status, 200);

    // Wait on the real deadline rather than a fixed sleep, so a slow boot
    // cannot turn this into a flaky test.
    await new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 500));

    const after = await fetch(`${server.base}/api/jobs`, { headers: { cookie: cookies } });
    assert.equal(after.status, 410, 'an already-issued cookie must not outlive the link');
  } finally {
    await server.stop();
  }
});

test('health stays up after expiry so a host health check does not flap', async () => {
  const server = await startServer({ ACCESS_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() });
  try {
    const res = await fetch(`${server.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.expired, true, 'but it reports the expiry');
  } finally {
    await server.stop();
  }
});

test('a malformed ACCESS_EXPIRES_AT stops the server rather than defaulting open', async () => {
  // Failing closed matters: a typo in the timestamp must not silently produce a
  // demo link that never expires.
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ACCESS_EXPIRES_AT: 'next tuesday', PORT: '4399' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.notEqual(code, 0, 'server must refuse to boot');
  assert.match(stderr, /ACCESS_EXPIRES_AT/);
});
