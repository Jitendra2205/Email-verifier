// Job persistence, backed by SQLite.
//
// Everything about a job lives in the database: metadata, the encrypted raw
// upload, every contact row and every verification reason. Deleting a job is one
// cascading DELETE, and the retention sweep cannot leave orphans behind.
//
// Personal fields (email address, suggested correction) are AES-256-GCM
// ciphertext in their columns. Everything the database needs to index on —
// domain, segment, status, score — is stored in the clear, which is what makes
// counting and filtering a query rather than a full decrypt-and-scan.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, DATA_DIR } from './config.js';
import { db, reclaimSpace } from './db.js';
import { blindIndex, decrypt, encrypt, randomId } from './crypto.js';
import { log } from './logger.js';
import { REASON_CODES, maskToReasons, reasonBit, reasonsToMask } from './verify/index.js';

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ---------------------------------------------------------------- statements --
// Prepared once; better-sqlite3 caches the compiled plan for the process.
const S = {
  insertJob: db.prepare(`
    INSERT INTO jobs (id, owner, filename_enc, size_bytes, status, created_at, updated_at,
                      expires_at, chunk_size, format)
    VALUES (@id, @owner, @filename_enc, @size_bytes, @status, @created_at, @updated_at,
            @expires_at, @chunk_size, @format)`),

  updateJob: db.prepare(`
    UPDATE jobs SET
      status = @status, error = @error, updated_at = @updated_at, expires_at = @expires_at,
      started_at = @started_at, finished_at = @finished_at,
      headers_json = @headers_json, mapping_json = @mapping_json,
      chunk_count = @chunk_count, cursor = @cursor, raw_blocks = @raw_blocks,
      smtp_probe = @smtp_probe, ms_per_row = @ms_per_row,
      total_rows = @total_rows, blank_rows = @blank_rows,
      doc_qualification = @doc_qualification
    WHERE id = @id`),

  selectJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
  selectJobsByOwner: db.prepare('SELECT * FROM jobs WHERE owner = ? ORDER BY created_at DESC'),
  selectAllJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC'),
  selectExpired: db.prepare('SELECT id FROM jobs WHERE expires_at < ?'),
  deleteJob: db.prepare('DELETE FROM jobs WHERE id = ?'),

  insertRawBlock: db.prepare('INSERT INTO raw_blocks (job_id, idx, data) VALUES (?, ?, ?)'),
  selectRawBlock: db.prepare('SELECT data FROM raw_blocks WHERE job_id = ? AND idx = ?'),
  deleteRawBlocks: db.prepare('DELETE FROM raw_blocks WHERE job_id = ?'),

  insertRow: db.prepare(`
    INSERT INTO job_rows (job_id, row_number, chunk_index, email_enc, email_hash,
                          domain, qualification, duplicate)
    VALUES (@job_id, @row_number, @chunk_index, @email_enc, @email_hash,
            @domain, @qualification, @duplicate)`),

  selectChunk: db.prepare(`
    SELECT row_number, email_enc, qualification, duplicate
    FROM job_rows WHERE job_id = ? AND chunk_index = ? ORDER BY row_number`),

  updateRowResult: db.prepare(`
    UPDATE job_rows SET status = @status, score = @score, domain = @domain,
                        suggestion_enc = @suggestion_enc, reasons_mask = @reasons_mask
    WHERE job_id = @job_id AND row_number = @row_number`),

  countByStatus: db.prepare(`
    SELECT status, COUNT(*) c FROM job_rows
    WHERE job_id = ? AND status IS NOT NULL GROUP BY status`),
  countBySegment: db.prepare(`
    SELECT qualification, status, COUNT(*) c FROM job_rows
    WHERE job_id = ? AND status IS NOT NULL GROUP BY qualification, status`),
  countCleanValid: db.prepare(`
    SELECT COUNT(*) c FROM job_rows
    WHERE job_id = ? AND status = 'valid' AND duplicate = 0`),
  countDuplicates: db.prepare(`
    SELECT COUNT(*) c FROM job_rows
    WHERE job_id = ? AND duplicate = 1 AND status IS NOT NULL`),
  // Every reason count in a single scan. Cheaper than the normalised table this
  // replaced, which needed two indexes of its own to be usable at all.
  countReasons: db.prepare(`
    SELECT ${REASON_CODES.map((code, i) => `SUM(CASE WHEN reasons_mask & ${2 ** i} THEN 1 ELSE 0 END) "${code}"`).join(', ')}
    FROM job_rows WHERE job_id = ? AND status IS NOT NULL`),
};

// ------------------------------------------------------------------- mapping --
function rowToJob(r) {
  if (!r) return null;
  return {
    id: r.id,
    owner: r.owner,
    filename: decrypt(r.filename_enc),
    sizeBytes: r.size_bytes,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    headers: JSON.parse(r.headers_json),
    mapping: JSON.parse(r.mapping_json),
    chunkSize: r.chunk_size,
    chunkCount: r.chunk_count,
    cursor: r.cursor,
    rawBlocks: r.raw_blocks,
    smtpProbe: Boolean(r.smtp_probe),
    format: r.format || 'csv',
    docQualification: r.doc_qualification || null,
    msPerRow: r.ms_per_row,
    totalRows: r.total_rows,
    blankRows: r.blank_rows,
  };
}

export function emptyCounts() {
  return {
    total: 0, processed: 0,
    valid: 0, risky: 0, invalid: 0, disposable: 0,
    cleanValid: 0, duplicates: 0, blankRows: 0,
    bySegment: {},
    byReason: {},
  };
}

// ---------------------------------------------------------------------- jobs --
export async function createJob({ filename, sizeBytes, owner, format = 'csv' }) {
  const id = randomId(9);
  const now = Date.now();
  S.insertJob.run({
    id,
    owner,
    filename_enc: encrypt(String(filename || 'upload.csv')),
    size_bytes: sizeBytes || 0,
    status: 'awaiting_mapping',
    created_at: now,
    updated_at: now,
    expires_at: now + config.retentionDays * 86_400_000,
    chunk_size: config.chunkSize,
    format,
  });
  return loadJob(id);
}

export async function saveJob(job) {
  job.updatedAt = Date.now();
  S.updateJob.run({
    id: job.id,
    status: job.status,
    error: job.error ?? null,
    updated_at: job.updatedAt,
    expires_at: job.expiresAt,
    started_at: job.startedAt ?? null,
    finished_at: job.finishedAt ?? null,
    headers_json: JSON.stringify(job.headers || []),
    mapping_json: JSON.stringify(job.mapping || {}),
    chunk_count: job.chunkCount || 0,
    cursor: job.cursor || 0,
    raw_blocks: job.rawBlocks || 0,
    smtp_probe: job.smtpProbe ? 1 : 0,
    ms_per_row: job.msPerRow ?? null,
    total_rows: job.totalRows || 0,
    blank_rows: job.blankRows || 0,
    doc_qualification: job.docQualification ?? null,
  });
  return job;
}

export async function loadJob(id) {
  if (!/^[a-f0-9]{18}$/.test(String(id))) return null;
  return rowToJob(S.selectJob.get(id));
}

export async function listJobs(owner) {
  const rows = owner === undefined ? S.selectAllJobs.all() : S.selectJobsByOwner.all(owner);
  return rows.map(rowToJob);
}

export async function deleteJob(id) {
  liveCounts.delete(id);
  S.deleteJob.run(id); // cascades to raw_blocks and job_rows
  reclaimSpace();
  log.info('job deleted', { jobId: id });
}

// --------------------------------------------------------------- raw upload --
export function storeRawBlock(jobId, index, ciphertext) {
  S.insertRawBlock.run(jobId, index, ciphertext);
}

export function readRawBlock(jobId, index) {
  const row = S.selectRawBlock.get(jobId, index);
  return row ? row.data : null;
}

export function deleteRawBlocks(jobId) {
  S.deleteRawBlocks.run(jobId);
  reclaimSpace();
}

// ------------------------------------------------------------ ingested rows --
/** Insert one ingest batch. Wrapped in a transaction — far faster than loose inserts. */
export const insertSourceRows = db.transaction((jobId, chunkIndex, rows) => {
  for (const row of rows) {
    S.insertRow.run({
      job_id: jobId,
      row_number: row.rowNumber,
      chunk_index: chunkIndex,
      email_enc: encrypt(row.email),
      email_hash: blindIndex(row.email),
      domain: '',
      qualification: row.qualification || 'Other',
      duplicate: row.duplicate ? 1 : 0,
    });
  }
});

/** The rows the runner still has to verify, for one chunk. */
export function readSourceChunk(jobId, chunkIndex) {
  return S.selectChunk.all(jobId, chunkIndex).map((r) => ({
    rowNumber: r.row_number,
    email: decrypt(r.email_enc),
    qualification: r.qualification,
    duplicate: Boolean(r.duplicate),
  }));
}

/** Commit one chunk's verification results. */
export const writeChunkResults = db.transaction((jobId, results) => {
  for (const r of results) {
    S.updateRowResult.run({
      job_id: jobId,
      row_number: r.rowNumber,
      status: r.status,
      score: r.score,
      domain: r.domain || '',
      suggestion_enc: r.suggestion ? encrypt(r.suggestion) : null,
      // Assignment, not accumulation — re-verifying a chunk after a crash
      // overwrites the mask instead of doubling its reasons up.
      reasons_mask: reasonsToMask(r.reasons),
    });
  }
});

// -------------------------------------------------------------------- counts --
// Materialised, not recomputed on demand.
//
// The aggregates are correct as pure SQL, and that is how they are defined
// below — but measured on a 156K-row job a full recompute costs ~800ms, and the
// progress stream wants counts several times a second. So they are maintained
// incrementally from each chunk's own results (O(chunk), no scan) and written
// to jobs.counts_json, with a full SQL recompute at the three points where an
// incremental tally could drift: first load, resume, and completion.
const liveCounts = new Map(); // jobId -> counts

const persistCounts = db.prepare('UPDATE jobs SET counts_json = ? WHERE id = ?');

/** The authoritative aggregate, straight from SQL. */
export function recomputeCounts(jobId) {
  const job = S.selectJob.get(jobId);
  const counts = emptyCounts();
  if (!job) return counts;

  counts.total = job.total_rows;
  counts.blankRows = job.blank_rows;

  for (const { status, c } of S.countByStatus.all(jobId)) {
    counts[status] = c;
    counts.processed += c;
  }
  counts.cleanValid = S.countCleanValid.get(jobId).c;
  counts.duplicates = S.countDuplicates.get(jobId).c;

  for (const { qualification, status, c } of S.countBySegment.all(jobId)) {
    if (!counts.bySegment[qualification]) {
      counts.bySegment[qualification] = { total: 0, valid: 0, risky: 0, invalid: 0, disposable: 0 };
    }
    counts.bySegment[qualification].total += c;
    counts.bySegment[qualification][status] += c;
  }
  const reasonRow = S.countReasons.get(jobId) || {};
  for (const code of REASON_CODES) {
    if (reasonRow[code]) counts.byReason[code] = reasonRow[code];
  }

  liveCounts.set(jobId, counts);
  persistCounts.run(JSON.stringify(counts), jobId);
  return counts;
}

export function jobCounts(jobId) {
  const live = liveCounts.get(jobId);
  if (live) return live;

  const job = S.selectJob.get(jobId);
  if (!job) return emptyCounts();
  if (job.counts_json) {
    const counts = JSON.parse(job.counts_json);
    // total/blankRows live on the job row and can change after ingest.
    counts.total = job.total_rows;
    counts.blankRows = job.blank_rows;
    liveCounts.set(jobId, counts);
    return counts;
  }
  return recomputeCounts(jobId);
}

/** Fold one chunk's results into the materialised counts. */
export function applyResultsDelta(jobId, results) {
  const counts = jobCounts(jobId);
  for (const r of results) {
    counts.processed++;
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.duplicate) counts.duplicates++;
    if (r.status === 'valid' && !r.duplicate) counts.cleanValid++;

    const seg = r.qualification || 'Other';
    if (!counts.bySegment[seg]) {
      counts.bySegment[seg] = { total: 0, valid: 0, risky: 0, invalid: 0, disposable: 0 };
    }
    counts.bySegment[seg].total++;
    counts.bySegment[seg][r.status]++;

    for (const reason of r.reasons || []) {
      counts.byReason[reason] = (counts.byReason[reason] || 0) + 1;
    }
  }
  liveCounts.set(jobId, counts);
  return counts;
}

/** Persist the materialised counts alongside the runner's chunk checkpoint. */
export function flushCounts(jobId) {
  const counts = liveCounts.get(jobId);
  if (counts) persistCounts.run(JSON.stringify(counts), jobId);
}

export function invalidateCounts(jobId) {
  liveCounts.delete(jobId);
}

// ------------------------------------------------------------------ querying --
/**
 * Build the WHERE clause shared by the results table and the exports.
 * Everything except a substring email search is pushed into SQL.
 */
function buildFilter(jobId, { status, segment, reason, search }) {
  const where = ['r.job_id = ?', 'r.status IS NOT NULL'];
  const params = [jobId];

  if (status && status !== 'all') { where.push('r.status = ?'); params.push(status); }
  if (segment && segment !== 'all') { where.push('r.qualification = ?'); params.push(segment); }
  if (reason) {
    // Unindexed by design: a bit test costs no storage and is applied only to
    // rows the indexed filters have already selected.
    where.push('(r.reasons_mask & ?) != 0');
    params.push(reasonBit(reason));
  }

  // Search strategy, cheapest first:
  //   * a complete address -> blind-index equality: an index hit, no decryption
  //   * anything else      -> decrypt-scan, but only over rows the other
  //                           filters have already narrowed down
  const term = String(search || '').trim().toLowerCase();
  let scan = null;
  if (term) {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(term)) {
      where.push('r.email_hash = ?');
      params.push(blindIndex(term));
    } else {
      scan = term;
    }
  }
  return { sql: where.join(' AND '), params, scan };
}

/** Upper bound on rows decrypted to answer one substring search. */
const SCAN_LIMIT = 30000;

function hydrate(r) {
  return {
    rowNumber: r.row_number,
    email: decrypt(r.email_enc),
    domain: r.domain,
    qualification: r.qualification,
    duplicate: Boolean(r.duplicate),
    status: r.status,
    score: r.score,
    reasons: maskToReasons(r.reasons_mask),
    suggestion: r.suggestion_enc ? decrypt(r.suggestion_enc) : undefined,
  };
}

/** Filtered, paginated view for the dashboard. */
export function queryResults(job, { status, segment, search, reason, page = 1, pageSize = 50 }) {
  const { sql, params, scan } = buildFilter(job.id, { status, segment, reason, search });
  const offset = (page - 1) * pageSize;

  if (!scan) {
    // Fully answerable in SQL: count and page without touching any ciphertext.
    const matched = db.prepare(`SELECT COUNT(*) c FROM job_rows r WHERE ${sql}`).get(...params).c;
    const rows = db.prepare(`
      SELECT r.* FROM job_rows r
      WHERE ${sql} ORDER BY r.row_number LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
      .map(hydrate);
    return { rows, matched, page, pageSize, pages: Math.max(1, Math.ceil(matched / pageSize)) };
  }

  // Substring search is the one thing SQL cannot do against an encrypted
  // column, so it runs as a streaming decrypt-scan over the candidates the
  // other filters have already narrowed.
  //
  // Bounded on purpose: decrypting a whole 156K-row job measured ~5s, far too
  // slow for a search box. Stopping at SCAN_LIMIT keeps the worst case near a
  // second and the response says the count is a lower bound. Adding a status
  // or segment filter shrinks the candidate set below the limit anyway.
  const statement = db.prepare(`
    SELECT r.* FROM job_rows r
    WHERE ${sql} ORDER BY r.row_number`);

  const rows = [];
  let matched = 0;
  let scanned = 0;
  let truncated = false;
  for (const raw of statement.iterate(...params)) {
    if (++scanned > SCAN_LIMIT) { truncated = true; break; }
    // The domain is stored in the clear, so test it before paying to decrypt.
    const hit = String(raw.domain).includes(scan)
      || decrypt(raw.email_enc).toLowerCase().includes(scan);
    if (!hit) continue;
    if (matched >= offset && rows.length < pageSize) rows.push(hydrate(raw));
    matched++;
  }
  return {
    rows, matched, truncated, page, pageSize,
    pages: Math.max(1, Math.ceil(matched / pageSize)),
  };
}

/** Every verified row, in file order — used by the exports. */
export function* iterateResults(job, { validOnly = false } = {}) {
  const extra = validOnly ? "AND r.status = 'valid' AND r.duplicate = 0" : '';
  const statement = db.prepare(`
    SELECT r.* FROM job_rows r
    WHERE r.job_id = ? AND r.status IS NOT NULL ${extra}
    ORDER BY r.row_number`);
  for (const raw of statement.iterate(job.id)) yield hydrate(raw);
}

// ----------------------------------------------------------------- retention --
export async function sweepExpired() {
  const expired = S.selectExpired.all(Date.now());
  for (const { id } of expired) await deleteJob(id);

  // Orphaned plaintext uploads (a crash between multer writing the temp file and
  // us encrypting it) are shredded too.
  try {
    for (const name of await fs.readdir(UPLOAD_DIR)) {
      const file = path.join(UPLOAD_DIR, name);
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs > 5 * 60_000) await fs.rm(file, { force: true });
    }
  } catch { /* upload dir may not exist yet */ }

  if (expired.length) log.info('retention sweep removed jobs', { removed: expired.length });
  return expired.length;
}

/** Throw away every row of a job, keeping the job itself. Used to recover a half-finished ingest. */
export function deleteJobRows(jobId) {
  db.prepare('DELETE FROM job_rows WHERE job_id = ?').run(jobId);
  liveCounts.delete(jobId);
  reclaimSpace();
}

/**
 * Seed an empty tally for a job that has not verified anything yet.
 *
 * Cheaper than recomputeCounts, which scans the whole table even when every
 * status is still NULL — at 156K rows that scan cost ~800ms of blocked event
 * loop right at the moment the run starts.
 */
export function seedCounts(jobId) {
  const job = S.selectJob.get(jobId);
  const counts = emptyCounts();
  if (job) { counts.total = job.total_rows; counts.blankRows = job.blank_rows; }
  liveCounts.set(jobId, counts);
  return counts;
}
