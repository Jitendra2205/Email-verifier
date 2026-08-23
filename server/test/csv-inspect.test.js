import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inspectCsv, streamMappedRows } from '../src/csv.js';

let dir;
test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ev-csv-'));
});
test.after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name, content) {
  const file = path.join(dir, name);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

test('inspectCsv reads headers and a bounded preview', async () => {
  const file = await write('ok.csv', 'Full Name,Email Address,Qualification\r\nA,a@firm.com,CPA\r\nB,b@firm.com,EA\r\n');
  const { headers, preview } = await inspectCsv(file);
  assert.deepEqual(headers, ['Full Name', 'Email Address', 'Qualification']);
  assert.equal(preview.length, 2);
  assert.equal(preview[0]['Email Address'], 'a@firm.com');
});

test('inspectCsv reports headers for a file with no data rows', async () => {
  // Regression: PapaParse's streaming `step` never fires here, which used to
  // make a header-only file look like it had no header row at all.
  const file = await write('headers-only.csv', 'Name,Email\r\n');
  const { headers, preview } = await inspectCsv(file);
  assert.deepEqual(headers, ['Name', 'Email']);
  assert.equal(preview.length, 0);
});

test('inspectCsv reports no headers for a truly empty file', async () => {
  const file = await write('empty.csv', '');
  const { headers, preview } = await inspectCsv(file);
  assert.deepEqual(headers, []);
  assert.equal(preview.length, 0);
});

test('inspectCsv caps the preview at the requested number of rows', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => `N${i},u${i}@firm.com,CPA`).join('\r\n');
  const file = await write('many.csv', `Name,Email,Qualification\r\n${rows}\r\n`);
  const { preview } = await inspectCsv(file, 5);
  assert.equal(preview.length, 5);
});

test('streamMappedRows normalises, segments, de-duplicates and skips blanks', async () => {
  const file = await write('rows.csv', [
    'Name,Email,Qualification',
    'A,jane@firm.com,Certified Public Accountant',
    'B,,EA',                       // blank email -> skipped
    'C,JANE@FIRM.COM,CPA',         // duplicate (case-insensitive) -> flagged
    'D,bob@firm.com,SHRM-CP',
    'E,eve@firm.com,Bookkeeper',
  ].join('\r\n') + '\r\n');

  const batches = [];
  const summary = await streamMappedRows(
    file,
    { email: 'Email', qualification: 'Qualification', name: 'Name' },
    (batch) => { batches.push(...batch); },
    { batchSize: 2 },
  );

  assert.equal(summary.total, 4, 'blank row excluded from the total');
  assert.equal(summary.blank, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.uniqueEmails, 3);

  assert.deepEqual(batches.map((r) => r.qualification), ['CPA', 'CPA', 'HR Professional', 'Other']);
  assert.equal(batches[1].duplicate, true, 'second occurrence flagged');
  assert.equal(batches[0].duplicate, false, 'first occurrence not flagged');
});

test('streamMappedRows chunks at the requested batch size', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => `u${i}@firm.com,CPA`).join('\r\n');
  const file = await write('chunky.csv', `Email,Qualification\r\n${rows}\r\n`);
  const sizes = [];
  await streamMappedRows(file, { email: 'Email', qualification: 'Qualification' },
    (batch) => { sizes.push(batch.length); }, { batchSize: 10 });
  assert.deepEqual(sizes, [10, 10, 5]);
});
