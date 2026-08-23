import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Papa from 'papaparse';
import { config } from './config.js';

export const EXPECTED_FIELDS = [
  { key: 'email', label: 'Email address', required: true, aliases: ['email', 'e-mail', 'email address', 'emailaddress', 'mail', 'email_address', 'work email', 'primary email'] },
  { key: 'qualification', label: 'Qualification / segment', required: true, aliases: ['qualification', 'segment', 'designation', 'credential', 'title', 'profession', 'qualifications', 'category'] },
  { key: 'name', label: 'Name (optional)', required: false, aliases: ['name', 'full name', 'fullname', 'contact name', 'first name', 'firstname'] },
];

export const QUALIFICATIONS = ['CPA', 'EA', 'HR Professional', 'Other'];

/** Map a free-text qualification value onto the four reporting segments. */
export function normalizeQualification(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Other';
  const lower = v.toLowerCase();
  if (/\bcpa\b|certified public accountant/.test(lower)) return 'CPA';
  if (/\bea\b|enrolled agent/.test(lower)) return 'EA';
  if (/\bhr\b|human resource|people ops|chro|shrm/.test(lower)) return 'HR Professional';
  return 'Other';
}

/** Suggest a column mapping from the file's own headers. */
export function suggestMapping(headers) {
  const mapping = {};
  const used = new Set();
  for (const field of EXPECTED_FIELDS) {
    const match = headers.find((h) => {
      const norm = String(h).trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');
      return !used.has(h) && field.aliases.includes(norm);
    });
    if (match) { mapping[field.key] = match; used.add(match); }
  }
  return mapping;
}

/**
 * Read headers plus a handful of rows so the mapping UI has something to show.
 *
 * Only the first HEAD_BYTES of the file are read — enough for the header row
 * and a preview, bounded regardless of whether the upload is 200 KB or 200 MB.
 * Parsing a string (rather than streaming with `step`) is what makes the header
 * row available even when the file has no data rows at all: PapaParse does not
 * populate `meta.fields` in its `complete` callback when streaming.
 */
const HEAD_BYTES = 64 * 1024;

export async function inspectCsv(filePath, previewRows = 5) {
  const handle = await fsp.open(filePath, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    head = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }

  // Drop a trailing partial line so a row sliced mid-field isn't shown as data.
  const lastBreak = head.lastIndexOf('\n');
  if (head.length === HEAD_BYTES && lastBreak > 0) head = head.slice(0, lastBreak);

  const result = Papa.parse(head, {
    header: true,
    skipEmptyLines: 'greedy',
    preview: previewRows + 1,
  });

  const headers = (result.meta?.fields || [])
    .map((h) => String(h).trim())
    .filter((h) => h !== '');

  return { headers, preview: result.data.slice(0, previewRows) };
}

/**
 * Normalise one tabular record against a column mapping: blank-check,
 * duplicate detection and qualification normalisation.
 *
 * Shared between the CSV/TSV streaming parser and the Excel row iterator
 * (`mapRowsToBatches` below) so both sources behave identically — the only
 * difference between them is how records are produced, not how they are
 * turned into a verification row.
 *
 * @returns the row to enqueue, or `null` for a blank email (caller counts it).
 */
export function normalizeRecord(record, mapping, rowNumber, seen) {
  const rawEmail = String(record[mapping.email] ?? '').trim();
  if (!rawEmail) return null;

  const key = rawEmail.toLowerCase();
  const duplicate = seen.has(key);
  if (!duplicate) seen.add(key);

  return {
    rowNumber,
    email: rawEmail,
    name: mapping.name ? String(record[mapping.name] ?? '').trim() : '',
    qualificationRaw: mapping.qualification ? String(record[mapping.qualification] ?? '').trim() : '',
    qualification: normalizeQualification(mapping.qualification ? record[mapping.qualification] : ''),
    duplicate,
  };
}

/**
 * Stream CSV/TSV rows, apply the mapping, normalise, de-duplicate and hand
 * batches to `onBatch`. Never materialises the whole file in memory.
 *
 * @param {string|import('node:stream').Readable} source a file path, or a
 *   readable stream (which is how the encrypted upload is fed back in).
 */
export function streamMappedRows(source, mapping, onBatch, { batchSize = config.chunkSize } = {}) {
  return new Promise((resolve, reject) => {
    const seen = new Set();
    let batch = [];
    let rowNumber = 0;
    let total = 0;
    let duplicates = 0;
    let blank = 0;
    let pending = Promise.resolve();
    let failed = null;

    const flush = (parser) => {
      const toWrite = batch;
      batch = [];
      parser.pause();
      pending = pending
        .then(() => onBatch(toWrite))
        .then(() => parser.resume())
        .catch((err) => { failed = err; parser.abort(); });
    };

    const stream = typeof source === 'string'
      ? fs.createReadStream(source, { encoding: 'utf8' })
      : source.setEncoding('utf8');

    Papa.parse(stream, {
      header: true,
      skipEmptyLines: 'greedy',
      step: (result, parser) => {
        if (failed) return;
        rowNumber++;
        if (total >= config.maxRows) { parser.abort(); return; }

        const row = normalizeRecord(result.data, mapping, rowNumber, seen);
        if (!row) { blank++; return; }
        if (row.duplicate) duplicates++;

        total++;
        batch.push(row);
        if (batch.length >= batchSize) flush(parser);
      },
      complete: () => {
        pending
          .then(() => (batch.length ? onBatch(batch) : null))
          .then(() => (failed ? reject(failed) : resolve({ total, duplicates, blank, uniqueEmails: seen.size })))
          .catch(reject);
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Same contract as `streamMappedRows`, for a source that is already an
 * in-memory array of plain objects (an Excel sheet's rows). Excel workbooks
 * are read fully into memory by the library regardless, so there is no stream
 * to back-pressure — batches are simply awaited in order.
 */
export async function mapRowsToBatches(records, mapping, onBatch, { batchSize = config.chunkSize } = {}) {
  const seen = new Set();
  let batch = [];
  let rowNumber = 0;
  let total = 0;
  let duplicates = 0;
  let blank = 0;

  for (const record of records) {
    rowNumber++;
    if (total >= config.maxRows) break;

    const row = normalizeRecord(record, mapping, rowNumber, seen);
    if (!row) { blank++; continue; }
    if (row.duplicate) duplicates++;

    total++;
    batch.push(row);
    if (batch.length >= batchSize) { await onBatch(batch); batch = []; }
  }
  if (batch.length) await onBatch(batch);
  return { total, duplicates, blank, uniqueEmails: seen.size };
}

/**
 * Neutralise CSV formula injection.
 *
 * A cell beginning with = + - @ (or a leading tab / CR, which Excel strips
 * before evaluating) is executed as a formula when the exported file is opened.
 * Prefixing with an apostrophe forces Excel, LibreOffice and Sheets to treat the
 * value as text, and the apostrophe is not part of the stored value.
 */
export function sanitizeCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return s;
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

function quote(value) {
  const s = sanitizeCell(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values) {
  return values.map(quote).join(',') + '\r\n';
}
