// Excel, Word and PDF ingestion.
//
// Fixtures are generated here rather than committed: a checked-in .xlsx/.docx
// is an opaque binary nobody can review in a diff, and building them in the
// test makes the expected content obvious.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import {
  ACCEPTED_EXTENSIONS, detectFormat, isBufferedFormat, isDocumentFormat, isTabularFormat,
} from '../src/formats/index.js';
import { inspectSpreadsheet, streamSpreadsheetRows } from '../src/formats/spreadsheet.js';
import {
  extractDocumentRows, extractEmailsFromText, inspectDocument,
} from '../src/formats/document.js';

let dir;
test.before(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ev-formats-')); });
test.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

// ------------------------------------------------------------------ fixtures --
async function makeXlsx(name, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Contacts');
  for (const row of rows) sheet.addRow(row);
  const file = path.join(dir, name);
  await workbook.xlsx.writeFile(file);
  return file;
}

async function makeDocx(name, paragraphs) {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

/** A minimal one-page PDF with real text-drawing operators. */
function makePdf(name, lines) {
  const esc = (s) => s.replace(/([()\\])/g, '\\$1');
  const ops = lines
    .map((l, i) => `BT /F1 12 Tf 50 ${740 - i * 22} Td (${esc(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += i === 3
      ? `4 0 obj\n<< /Length ${ops.length} >>\nstream\n${ops}\nendstream\nendobj\n`
      : `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, pdf, 'latin1');
  return file;
}

// ----------------------------------------------------------------- detection --
test('format detection maps extensions and rejects everything else', () => {
  assert.equal(detectFormat('list.csv'), 'csv');
  assert.equal(detectFormat('LIST.XLSX'), 'xlsx', 'case-insensitive');
  assert.equal(detectFormat('report.pdf'), 'pdf');
  assert.equal(detectFormat('notes.docx'), 'docx');
  assert.equal(detectFormat('photo.png'), null);
  assert.equal(detectFormat('noextension'), null);
  // Legacy binary .xls is deliberately unsupported — see formats/index.js.
  assert.equal(detectFormat('old.xls'), null);
});

test('formats are classified into the right pipelines', () => {
  assert.ok(isTabularFormat('csv') && isTabularFormat('xlsx'));
  assert.ok(isDocumentFormat('pdf') && isDocumentFormat('docx'));
  assert.ok(!isDocumentFormat('csv'));
  // CSV streams; the rest must be buffered whole, hence the tighter size cap.
  assert.ok(!isBufferedFormat('csv') && !isBufferedFormat('tsv'));
  assert.ok(isBufferedFormat('xlsx') && isBufferedFormat('docx') && isBufferedFormat('pdf'));
  assert.deepEqual(ACCEPTED_EXTENSIONS, ['.csv', '.tsv', '.txt', '.xlsx', '.docx', '.pdf']);
});

// ------------------------------------------------------------------- Excel ----
test('Excel headers and preview match the CSV inspect shape', async () => {
  const file = await makeXlsx('ok.xlsx', [
    ['Full Name', 'Email Address', 'Qualification'],
    ['Jane Doe', 'jane.doe@kpmg.com', 'CPA'],
    ['Bob Smith', 'bob.smith@deloitte.com', 'Enrolled Agent'],
  ]);
  const { headers, preview } = await inspectSpreadsheet(file);
  assert.deepEqual(headers, ['Full Name', 'Email Address', 'Qualification']);
  assert.equal(preview.length, 2);
  assert.equal(preview[0]['Email Address'], 'jane.doe@kpmg.com');
});

test('Excel rows normalise, de-duplicate and segment exactly like CSV', async () => {
  const file = await makeXlsx('rows.xlsx', [
    ['Name', 'Email', 'Qualification'],
    ['A', 'jane@firm.com', 'Certified Public Accountant'],
    ['B', '', 'EA'],                    // blank email -> skipped
    ['C', 'JANE@FIRM.COM', 'CPA'],      // duplicate, case-insensitive
    ['D', 'bob@firm.com', 'SHRM-CP'],
    ['E', 'eve@firm.com', 'Bookkeeper'],
  ]);
  const rows = [];
  const summary = await streamSpreadsheetRows(
    fs.readFileSync(file),
    { email: 'Email', qualification: 'Qualification', name: 'Name' },
    (batch) => { rows.push(...batch); },
  );

  assert.equal(summary.total, 4, 'blank row excluded');
  assert.equal(summary.blank, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.uniqueEmails, 3);
  assert.deepEqual(rows.map((r) => r.qualification), ['CPA', 'CPA', 'HR Professional', 'Other']);
  assert.equal(rows[1].duplicate, true);
  assert.equal(rows[0].duplicate, false);
});

test('Excel formula and numeric cells read as their displayed value', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('S');
  sheet.addRow(['Email', 'Qualification', 'Code']);
  sheet.addRow([{ formula: 'CONCATENATE("a","@x.com")', result: 'a@x.com' }, 'CPA', 12345]);
  const file = path.join(dir, 'formula.xlsx');
  await workbook.xlsx.writeFile(file);

  const rows = [];
  await streamSpreadsheetRows(
    fs.readFileSync(file),
    { email: 'Email', qualification: 'Qualification' },
    (b) => { rows.push(...b); },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'a@x.com', 'formula result, not the formula text');
});

test('Excel batches at the requested size', async () => {
  const data = [['Email', 'Qualification']];
  for (let i = 0; i < 25; i++) data.push([`u${i}@firm.com`, 'CPA']);
  const file = await makeXlsx('chunky.xlsx', data);

  const sizes = [];
  await streamSpreadsheetRows(
    fs.readFileSync(file),
    { email: 'Email', qualification: 'Qualification' },
    (b) => { sizes.push(b.length); },
    { batchSize: 10 },
  );
  assert.deepEqual(sizes, [10, 10, 5]);
});

// --------------------------------------------------------------- text scan ----
test('the text scanner finds addresses in prose and leaves punctuation behind', () => {
  const cases = {
    'write to jane@kpmg.com.': ['jane@kpmg.com'],
    'contact (bob@pwc.com) today': ['bob@pwc.com'],
    'a@x.com; b@y.com; c@z.com': ['a@x.com', 'b@y.com', 'c@z.com'],
    'Jane Doe <jane.doe@ey.com>': ['jane.doe@ey.com'],
    'a@x.com, b@y.com': ['a@x.com', 'b@y.com'],
    'email: first.last+tag@sub.firm.co.uk!': ['first.last+tag@sub.firm.co.uk'],
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.deepEqual(extractEmailsFromText(text).emails, expected, text);
  }
});

test('the text scanner ignores things that only look like addresses', () => {
  // No TLD, so not an address — this is the case that would otherwise flood a
  // document scan with false positives from ordinary prose.
  assert.deepEqual(extractEmailsFromText('accounting@work is a place').emails, []);
  assert.deepEqual(extractEmailsFromText('no addresses at all here').emails, []);
  assert.deepEqual(extractEmailsFromText('').emails, []);
  assert.deepEqual(extractEmailsFromText(null).emails, []);
});

test('a repeated address in prose is one contact, not a duplicate row', () => {
  const { emails, duplicates } = extractEmailsFromText(
    'Mail jane@kpmg.com. Later: JANE@KPMG.COM. Also jane@kpmg.com again.',
  );
  assert.deepEqual(emails, ['jane@kpmg.com'], 'first spelling kept');
  assert.equal(duplicates, 2, 'repeat mentions counted but not emitted');
});

// ---------------------------------------------------------------- documents ---
const DOC_LINES = [
  'Attendee list for the Q3 CPE webinar.',
  'Please contact jane.doe@kpmg.com for the recording.',
  'Billing questions go to billing@deloitte.com, or bob.smith@pwc.com.',
  'Reach Sarah (sarah.patel@grantthornton.com) with any issues.',
  'Duplicate mention: jane.doe@kpmg.com again.',
];
const DOC_EXPECTED = [
  'jane.doe@kpmg.com',
  'billing@deloitte.com',
  'bob.smith@pwc.com',
  'sarah.patel@grantthornton.com',
];

test('Word documents yield their addresses in order', async () => {
  const file = await makeDocx('doc.docx', DOC_LINES);
  const result = await inspectDocument(fs.readFileSync(file), 'docx');
  assert.equal(result.hasText, true);
  assert.deepEqual(result.emails, DOC_EXPECTED);
  assert.equal(result.duplicates, 1);
});

test('PDF documents yield their addresses in order', async () => {
  const file = makePdf('doc.pdf', DOC_LINES);
  const result = await inspectDocument(fs.readFileSync(file), 'pdf');
  assert.equal(result.hasText, true);
  assert.deepEqual(result.emails, DOC_EXPECTED);
  assert.equal(result.duplicates, 1);
});

test('every address from a document takes the chosen qualification', async () => {
  const file = await makeDocx('seg.docx', DOC_LINES);
  const { rows } = await extractDocumentRows(fs.readFileSync(file), 'docx', 'HR Professional');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.qualification === 'HR Professional'));
  // Rows must be shaped exactly like tabular ones — nothing downstream should
  // be able to tell where they came from.
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['duplicate', 'email', 'name', 'qualification', 'qualificationRaw', 'rowNumber']);
  assert.deepEqual(rows.map((r) => r.rowNumber), [1, 2, 3, 4]);
  assert.ok(rows.every((r) => r.duplicate === false));
});

test('a document with text but no addresses reports zero, not an error', async () => {
  const file = makePdf('empty.pdf', ['Quarterly report.', 'No contact details here.']);
  const result = await inspectDocument(fs.readFileSync(file), 'pdf');
  assert.equal(result.hasText, true, 'text was readable...');
  assert.equal(result.totalFound, 0, '...it just had no addresses');
});

test('an unreadable document rejects rather than returning nothing', async () => {
  const junk = Buffer.from('this is not a pdf at all');
  await assert.rejects(() => inspectDocument(junk, 'pdf'));
  await assert.rejects(() => inspectDocument(junk, 'docx'));
  await assert.rejects(() => inspectDocument(junk, 'nonsense'), /Unsupported document format/);
});
