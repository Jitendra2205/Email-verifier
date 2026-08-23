// One-shot import of jobs created before the SQLite store existed.
//
// The old layout was data/jobs/<id>/{meta.enc, source/N.enc, results/N.enc}.
// Rather than stranding anyone's in-flight work behind a deploy, this reads
// those encrypted chunk files with the same data key and replays them into the
// database, then removes the directory. It is a no-op once nothing is left.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { decrypt, blindIndex, encrypt } from './crypto.js';
import { REASON_CODES, reasonsToMask } from './verify/index.js';
import { log } from './logger.js';

const LEGACY_JOBS_DIR = path.join(DATA_DIR, 'jobs');

async function readEncryptedJson(file) {
  return JSON.parse(decrypt(await fs.readFile(file)));
}

async function readEncryptedRows(file) {
  const text = decrypt(await fs.readFile(file));
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const insertJob = db.prepare(`
  INSERT OR IGNORE INTO jobs (id, owner, filename_enc, size_bytes, status, error, created_at,
    updated_at, expires_at, started_at, finished_at, headers_json, mapping_json, chunk_size,
    chunk_count, cursor, raw_blocks, smtp_probe, ms_per_row, total_rows, blank_rows)
  VALUES (@id, @owner, @filename_enc, @size_bytes, @status, @error, @created_at,
    @updated_at, @expires_at, @started_at, @finished_at, @headers_json, @mapping_json, @chunk_size,
    @chunk_count, @cursor, 0, @smtp_probe, @ms_per_row, @total_rows, @blank_rows)`);

const insertRow = db.prepare(`
  INSERT OR IGNORE INTO job_rows (job_id, row_number, chunk_index, email_enc, email_hash,
    domain, qualification, duplicate, status, score, suggestion_enc, reasons_mask)
  VALUES (@job_id, @row_number, @chunk_index, @email_enc, @email_hash,
    @domain, @qualification, @duplicate, @status, @score, @suggestion_enc, @reasons_mask)`);

const KNOWN_REASONS = new Set(REASON_CODES);

/**
 * A legacy job may carry a reason code that has since been retired. Drop those
 * rather than aborting the whole import over one unrecognised string.
 */
function safeMask(reasons) {
  const all = reasons || [];
  const known = all.filter((r) => KNOWN_REASONS.has(r));
  if (known.length !== all.length) {
    log.warn('legacy row had unrecognised reason codes', { dropped: all.length - known.length });
  }
  return reasonsToMask(known);
}

const importJob = db.transaction((meta, chunks) => {
  insertJob.run({
    id: meta.id,
    owner: meta.owner || 'unknown',
    filename_enc: encrypt(String(meta.filename || 'upload.csv')),
    size_bytes: meta.sizeBytes || 0,
    status: meta.status === 'running' ? 'paused' : (meta.status || 'done'),
    error: meta.error ?? null,
    created_at: meta.createdAt || Date.now(),
    updated_at: meta.updatedAt || Date.now(),
    expires_at: meta.expiresAt || Date.now() + 86_400_000,
    started_at: meta.startedAt ?? null,
    finished_at: meta.finishedAt ?? null,
    headers_json: JSON.stringify(meta.headers || []),
    mapping_json: JSON.stringify(meta.mapping || {}),
    chunk_size: meta.chunkSize || 1000,
    chunk_count: meta.chunkCount || 0,
    cursor: meta.cursor || 0,
    smtp_probe: meta.smtpProbe ? 1 : 0,
    ms_per_row: meta.msPerRow ?? null,
    total_rows: meta.counts?.total || 0,
    blank_rows: meta.counts?.blankRows || 0,
  });

  for (const { index, sourceRows, resultRows } of chunks) {
    const byRowNumber = new Map(resultRows.map((r) => [r.rowNumber, r]));
    // Prefer the source rows (they cover unverified chunks too); overlay results.
    const base = sourceRows.length ? sourceRows : resultRows;
    for (const row of base) {
      const result = byRowNumber.get(row.rowNumber);
      insertRow.run({
        job_id: meta.id,
        row_number: row.rowNumber,
        chunk_index: index,
        email_enc: encrypt(row.email),
        email_hash: blindIndex(row.email),
        domain: result?.domain || '',
        qualification: row.qualification || result?.qualification || 'Other',
        duplicate: (row.duplicate ?? result?.duplicate) ? 1 : 0,
        status: result?.status ?? null,
        score: result?.score ?? null,
        suggestion_enc: result?.suggestion ? encrypt(result.suggestion) : null,
        reasons_mask: safeMask(result?.reasons),
      });
    }
  }
});

async function readChunks(dir, meta) {
  const chunks = [];
  for (let i = 0; i < (meta.chunkCount || 0); i++) {
    let sourceRows = [];
    let resultRows = [];
    try { sourceRows = await readEncryptedRows(path.join(dir, 'source', `${i}.enc`)); } catch { /* gone */ }
    try { resultRows = await readEncryptedRows(path.join(dir, 'results', `${i}.enc`)); } catch { /* not yet verified */ }
    if (sourceRows.length || resultRows.length) chunks.push({ index: i, sourceRows, resultRows });
  }
  return chunks;
}

/** @returns {Promise<number>} jobs imported */
export async function migrateFileStore() {
  let entries;
  try {
    entries = await fs.readdir(LEGACY_JOBS_DIR, { withFileTypes: true });
  } catch {
    return 0; // no legacy directory at all
  }

  let imported = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{18}$/.test(entry.name)) continue;
    const dir = path.join(LEGACY_JOBS_DIR, entry.name);
    try {
      const meta = await readEncryptedJson(path.join(dir, 'meta.enc'));
      importJob(meta, await readChunks(dir, meta));
      await fs.rm(dir, { recursive: true, force: true });
      imported++;
      log.info('migrated legacy job into database', { jobId: meta.id, chunks: meta.chunkCount });
    } catch (err) {
      // A job we cannot read is left in place rather than deleted — it may be
      // encrypted under a key this process does not have.
      log.warn('could not migrate legacy job', { jobId: entry.name, code: err?.code || 'unreadable' });
    }
  }

  // Remove the directory once it holds nothing but leftovers we already handled.
  try {
    const remaining = await fs.readdir(LEGACY_JOBS_DIR);
    if (remaining.length === 0) await fs.rm(LEGACY_JOBS_DIR, { recursive: true, force: true });
  } catch { /* already gone */ }

  if (imported) log.info('legacy file store migration complete', { imported });
  return imported;
}
