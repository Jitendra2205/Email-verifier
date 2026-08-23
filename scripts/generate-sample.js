#!/usr/bin/env node
// Generates a realistic test list: a mix of live corporate domains, consumer
// mailboxes, disposable providers, malformed addresses, role accounts,
// duplicates, dead domains and a CSV-injection payload.
//
//   node scripts/generate-sample.js [rows] [outfile]
import fs from 'node:fs';
import path from 'node:path';

const rows = Number(process.argv[2]) || 3000;
const outFile = process.argv[3] || path.join(process.cwd(), 'sample', `sample-${rows}.csv`);

// Real domains that resolve and accept mail — these should come back Valid.
const CORPORATE = [
  'deloitte.com', 'kpmg.com', 'pwc.com', 'ey.com', 'grantthornton.com', 'bdo.com',
  'rsmus.com', 'crowe.com', 'aicpa.org', 'adp.com', 'paychex.com', 'intuit.com',
  'workday.com', 'sap.com', 'oracle.com', 'microsoft.com', 'salesforce.com',
  'thomsonreuters.com', 'wolterskluwer.com', 'shrm.org', 'cbiz.com', 'moss-adams.com',
];
const CONSUMER = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com'];
const DISPOSABLE = ['mailinator.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com', '10minutemail.com', 'sharklasers.com', 'temp-mail.org'];
// Domains that will not resolve — these should come back Invalid.
const DEAD = ['thisdomaindoesnotexist-cpa-xyz.com', 'no-such-firm-abc123.net', 'defunct-accounting-llp.example'];
const ROLES = ['info', 'support', 'admin', 'hr', 'billing', 'sales', 'noreply', 'careers'];
const FIRST = ['james', 'mary', 'robert', 'patricia', 'john', 'jennifer', 'michael', 'linda', 'david', 'elizabeth', 'william', 'barbara', 'richard', 'susan', 'joseph', 'jessica', 'thomas', 'sarah', 'chris', 'karen', 'priya', 'wei', 'amara', 'diego'];
const LAST = ['smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez', 'hernandez', 'lopez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'patel', 'nguyen', 'okafor'];
const QUALS = ['CPA', 'CPA', 'CPA', 'EA', 'EA', 'HR Professional', 'HR Professional', 'Enrolled Agent', 'Certified Public Accountant', 'SHRM-CP', 'Bookkeeper', ''];
const TYPOS = ['gmial.com', 'gmail.co', 'yahooo.com', 'hotmial.com', 'outlok.com'];

let seed = 20260822;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const MALFORMED = [
  'not-an-email', 'missing@tld', '@nodomain.com', 'spaces in@address.com',
  'double@@at.com', 'trailing.dot.@firm.com', '.leading@firm.com',
  'unicode.tést@firm.com', 'no-at-sign.firm.com', 'a'.repeat(70) + '@firm.com',
];

function makeRow(i) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const name = `${first[0].toUpperCase()}${first.slice(1)} ${last[0].toUpperCase()}${last.slice(1)}`;
  const qualification = pick(QUALS);
  const roll = rnd();
  let email;

  if (roll < 0.58) {
    email = `${first}.${last}${i % 7 === 0 ? i : ''}@${pick(CORPORATE)}`;
  } else if (roll < 0.75) {
    email = `${first}${last}${Math.floor(rnd() * 90 + 10)}@${pick(CONSUMER)}`;
  } else if (roll < 0.82) {
    email = `${pick(ROLES)}@${pick(CORPORATE)}`;
  } else if (roll < 0.89) {
    email = `${first}.${last}@${pick(DISPOSABLE)}`;
  } else if (roll < 0.94) {
    email = `${first}.${last}@${pick(DEAD)}`;
  } else if (roll < 0.98) {
    email = pick(MALFORMED);
  } else {
    email = `${first}.${last}@${pick(TYPOS)}`;
  }

  return { name, email, qualification };
}

function quote(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const out = fs.createWriteStream(outFile, { encoding: 'utf8' });
out.write('Full Name,Email Address,Qualification,Source\r\n');

const generated = [];
for (let i = 0; i < rows; i++) {
  const row = makeRow(i);
  generated.push(row);
  // ~4% duplicates, drawn from rows already written.
  if (generated.length > 20 && rnd() < 0.04) {
    const dupe = generated[Math.floor(rnd() * generated.length)];
    out.write([dupe.name, dupe.email, dupe.qualification, 'webinar-2025'].map(quote).join(',') + '\r\n');
  }
  // A blank-email row every so often, to exercise the skip path.
  if (rnd() < 0.01) out.write([row.name, '', row.qualification, 'import'].map(quote).join(',') + '\r\n');
  out.write([row.name, row.email, row.qualification, 'webinar-2025'].map(quote).join(',') + '\r\n');
}

// CSV formula-injection payloads: these must come back apostrophe-prefixed in
// the export, not as live formulas.
out.write(['=cmd|\' /C calc\'!A0', 'evil@mailinator.com', '+SUM(1+1)', '@import'].map(quote).join(',') + '\r\n');
out.write(['-2+3', 'formula.test@deloitte.com', '=1+1', 'import'].map(quote).join(',') + '\r\n');

out.end(() => {
  const { size } = fs.statSync(outFile);
  process.stdout.write(`Wrote ${outFile} (${(size / 1024).toFixed(0)} KB)\n`);
});
