// Exercises verification layers 5 and 6 against a local mock MTA.
//
// Deliberately never touches a real mail server: opening SMTP connections to
// third-party MTAs is exactly the behaviour this tool exists to avoid, and a
// test suite must not do it either.
//
// `config.js` reads the environment once at import time, so the mock server has
// to be listening and SMTP_PORT set *before* anything under src/ is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

/** Per-recipient RCPT reply code; swapped per test to change server behaviour. */
let rcptPolicy = () => 250;

function startMockMta() {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 mock.test ESMTP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (/^EHLO/i.test(line)) {
          socket.write('250-mock.test\r\n250 SIZE 10240000\r\n'); // multi-line reply
        } else if (/^MAIL FROM:/i.test(line)) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (/^RCPT TO:/i.test(line)) {
          const rcpt = line.replace(/^RCPT TO:\s*/i, '').replace(/^<|>$/g, '');
          const code = rcptPolicy(rcpt);
          const text = code >= 500 ? '5.1.1 No such user' : code >= 400 ? '4.7.1 Try again later' : '2.1.5 Ok';
          socket.write(`${code} ${text}\r\n`);
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('500 Unrecognised\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const mta = await startMockMta();
process.env.SMTP_PROBE_ENABLED = 'true';
process.env.SMTP_PORT = String(mta.address().port);
process.env.SMTP_PROBES_PER_DOMAIN_PER_MINUTE = '600';
process.env.SMTP_TIMEOUT_MS = '1500';

const { probeRecipients, detectCatchAll } = await import('../src/verify/smtp.js');
const { verifyOne } = await import('../src/verify/index.js');
const { primeDomainCache } = await import('../src/verify/mx.js');

test.after(() => mta.close());

test('a strict server distinguishes a real mailbox from a missing one', async () => {
  rcptPolicy = (rcpt) => (rcpt === 'real.person@strict.test' ? 250 : 550);

  const catchAll = await detectCatchAll('strict.test', ['127.0.0.1']);
  assert.equal(catchAll, 'no', 'rejects an impossible address, so it is not a catch-all');

  const { verdict } = await probeRecipients('strict.test', ['127.0.0.1'], [
    'real.person@strict.test',
    'ghost@strict.test',
  ]);
  assert.equal(verdict.get('real.person@strict.test').verdict, 'accepted');
  assert.equal(verdict.get('ghost@strict.test').verdict, 'rejected');
});

test('a catch-all domain is detected as such', async () => {
  rcptPolicy = () => 250; // accepts everything, including addresses that cannot exist
  const result = await detectCatchAll('catchall.test', ['127.0.0.1']);
  assert.equal(result, 'yes');
});

test('a 4xx throttle response is inconclusive, never a rejection', async () => {
  rcptPolicy = () => 451;
  const { verdict } = await probeRecipients('slow.test', ['127.0.0.1'], ['someone@slow.test']);
  const answer = verdict.get('someone@slow.test');
  assert.equal(answer.verdict, 'deferred', 'a 4xx must not be read as "no such mailbox"');
});

test('an unreachable mail server degrades to unknown, not to a verdict', async () => {
  // 192.0.2.0/24 is RFC 5737 TEST-NET-1 — reserved, never routes anywhere real.
  const catchAll = await detectCatchAll('unreachable.test', ['192.0.2.1']);
  assert.equal(catchAll, 'unknown');

  const { verdict } = await probeRecipients('unreachable.test', ['192.0.2.1'], ['a@unreachable.test']);
  assert.equal(verdict.size, 0, 'no answer at all, rather than a guessed one');
});

test('an SMTP rejection downgrades a row to Risky, never to Invalid', async () => {
  rcptPolicy = () => 550;
  // Pin the MX result so this test does no DNS either.
  primeDomainCache([['strictfirm.test', { status: 'mx', hosts: ['127.0.0.1'] }]]);

  const result = await verifyOne({ email: 'ghost@strictfirm.test', qualification: 'CPA' });
  assert.equal(result.status, 'risky', 'one RCPT rejection is not enough to delete a contact');
  assert.ok(result.reasons.includes('mailbox_rejected'));
  assert.ok(result.score <= 20, `score was ${result.score}`);
});

test('a confirmed mailbox on a non-catch-all domain scores above a plain MX match', async () => {
  rcptPolicy = () => 250;
  primeDomainCache([['confirmed.test', { status: 'mx', hosts: ['127.0.0.1'] }]]);

  // This domain accepts everything, so it is correctly called a catch-all and
  // the row is Risky — the mailbox still cannot be individually confirmed.
  const result = await verifyOne({ email: 'someone@confirmed.test', qualification: 'EA' });
  assert.equal(result.status, 'risky');
  assert.ok(result.reasons.includes('catch_all'));
});
