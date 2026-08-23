import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSyntax, normalizeEmail } from '../src/verify/syntax.js';
import { sanitizeCell, csvLine, normalizeQualification, suggestMapping } from '../src/csv.js';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../src/crypto.js';
import { pseudonymize } from '../src/logger.js';
import { createRateLimiter, mapLimit } from '../src/limiter.js';

test('syntax accepts ordinary professional addresses', () => {
  for (const email of [
    'jane.doe@deloitte.com',
    'j.doe+cpe@kpmg.co.uk',
    "o'brien@firm.com",
    'first_last@sub.domain.example.org',
  ]) {
    assert.equal(checkSyntax(email).ok, true, email);
  }
});

test('syntax rejects the malformed shapes that show up in real lists', () => {
  const cases = {
    '': 'empty',
    'not-an-email': 'at_count',
    '@nodomain.com': 'malformed',
    'missing@tld': 'no_tld',
    'double@@at.com': 'at_count',
    'trailing.dot.@firm.com': 'regex',
    '.leading@firm.com': 'regex',
    'unicode.tést@firm.com': 'non_ascii',
    'spaces in@address.com': 'regex',
  };
  for (const [input, code] of Object.entries(cases)) {
    const result = checkSyntax(input);
    assert.equal(result.ok, false, `${input} should fail`);
    assert.equal(result.code, code, `${input} → ${result.code}`);
  }
});

test('syntax enforces the RFC length limits', () => {
  assert.equal(checkSyntax('a'.repeat(65) + '@firm.com').code, 'local_too_long');
  assert.equal(checkSyntax('a'.repeat(250) + '@' + 'b'.repeat(60) + '.com').code, 'too_long');
});

test('normalizeEmail lowercases the domain and unwraps display names', () => {
  assert.equal(normalizeEmail('  <Jane.Doe@DELOITTE.com> ').email, 'Jane.Doe@deloitte.com');
  assert.equal(normalizeEmail('Jane@Firm.COM').domain, 'firm.com');
});

test('syntax suggests a correction for common domain typos', () => {
  assert.equal(checkSyntax('jane@gmial.com').suggestion, 'jane@gmail.com');
});

test('CSV export neutralises formula injection', () => {
  assert.equal(sanitizeCell('=cmd|\' /C calc\'!A0'), "'=cmd|' /C calc'!A0");
  assert.equal(sanitizeCell('+SUM(1+1)'), "'+SUM(1+1)");
  assert.equal(sanitizeCell('-2+3'), "'-2+3");
  assert.equal(sanitizeCell('@import'), "'@import");
  assert.equal(sanitizeCell('\tTAB'), "'\tTAB");
  assert.equal(sanitizeCell('jane@firm.com'), 'jane@firm.com');
  assert.equal(sanitizeCell(''), '');
});

test('csvLine quotes separators and escapes quotes', () => {
  assert.equal(csvLine(['a,b', 'say "hi"']), '"a,b","say ""hi"""\r\n');
});

test('qualification values collapse onto the reporting segments', () => {
  assert.equal(normalizeQualification('CPA'), 'CPA');
  assert.equal(normalizeQualification('Certified Public Accountant'), 'CPA');
  assert.equal(normalizeQualification('Enrolled Agent'), 'EA');
  assert.equal(normalizeQualification('EA'), 'EA');
  assert.equal(normalizeQualification('SHRM-CP'), 'HR Professional');
  assert.equal(normalizeQualification('HR Manager'), 'HR Professional');
  assert.equal(normalizeQualification('Bookkeeper'), 'Other');
  assert.equal(normalizeQualification(''), 'Other');
});

test('column mapping is suggested from common header spellings', () => {
  const mapping = suggestMapping(['Full Name', 'Email Address', 'Qualification', 'Source']);
  assert.equal(mapping.email, 'Email Address');
  assert.equal(mapping.qualification, 'Qualification');
  assert.equal(mapping.name, 'Full Name');
});

test('encryption round-trips and rejects tampering', () => {
  const blob = encrypt('jane.doe@deloitte.com');
  assert.notEqual(blob.toString('utf8'), 'jane.doe@deloitte.com');
  assert.equal(decrypt(blob), 'jane.doe@deloitte.com');
  blob[blob.length - 1] ^= 0xff;
  assert.throws(() => decrypt(blob));
});

test('password hashing verifies the right password only', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('log pseudonyms are stable per address and reveal nothing', () => {
  const a = pseudonymize('jane.doe@deloitte.com');
  assert.equal(a, pseudonymize('JANE.DOE@deloitte.com'));
  assert.notEqual(a, pseudonymize('john.doe@deloitte.com'));
  assert.match(a, /^em_[a-f0-9]{10}$/);
});

test('rate limiter caps a key at the configured rate', () => {
  const limiter = createRateLimiter({ perMinute: 3 });
  assert.equal(limiter.tryTake('firm.com'), true);
  assert.equal(limiter.tryTake('firm.com'), true);
  assert.equal(limiter.tryTake('firm.com'), true);
  assert.equal(limiter.tryTake('firm.com'), false);
  assert.equal(limiter.tryTake('other.com'), true, 'limits are per key');
  assert.ok(limiter.retryAfterMs('firm.com') > 0);
});

test('mapLimit preserves order and bounds concurrency', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});
