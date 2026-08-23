// SQLite persistence layer.
//
// Why SQLite and not Postgres: the PRD allows either, and at this scale the
// deciding factor is operational. SQLite needs no server, so the tool runs from
// a clone and deploys as a single container with a mounted volume. Everything
// below is written in portable SQL against a thin driver surface, so swapping in
// Postgres is a driver change plus the two dialect notes marked SQLITE-SPECIFIC.
//
// What is encrypted: email addresses and the suggested-correction column are
// AES-256-GCM ciphertext, because SQLite has no native at-rest encryption and
// those are the only genuinely personal fields. Domain, segment, status and
// score stay in the clear so the database can actually do its job — index,
// filter and aggregate. A row of {domain, qualification, status} identifies
// nobody; the same row with the local part would.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, config } from './config.js';
import { log } from './logger.js';
import { reasonsToMask } from './verify/index.js';

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'verifier.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);

// WAL is what lets the dashboard read results while the runner is still writing
// them — without it every progress poll would contend with the write lock.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
// Raw uploads are stored as blobs and deleted after ingest; incremental vacuum
// lets that space be reclaimed without a full rewrite of the file.
db.pragma('auto_vacuum = INCREMENTAL');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -32000'); // 32 MB page cache

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up: `
      CREATE TABLE jobs (
        id            TEXT PRIMARY KEY,
        owner         TEXT    NOT NULL,
        filename_enc  BLOB    NOT NULL,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        status        TEXT    NOT NULL,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        started_at    INTEGER,
        finished_at   INTEGER,
        headers_json  TEXT    NOT NULL DEFAULT '[]',
        mapping_json  TEXT    NOT NULL DEFAULT '{}',
        chunk_size    INTEGER NOT NULL,
        chunk_count   INTEGER NOT NULL DEFAULT 0,
        cursor        INTEGER NOT NULL DEFAULT 0,
        raw_blocks    INTEGER NOT NULL DEFAULT 0,
        smtp_probe    INTEGER NOT NULL DEFAULT 0,
        ms_per_row    REAL,
        total_rows    INTEGER NOT NULL DEFAULT 0,
        blank_rows    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_jobs_owner   ON jobs(owner, created_at DESC);
      CREATE INDEX idx_jobs_expires ON jobs(expires_at);

      -- The encrypted upload, before ingest normalises it. Held here rather than
      -- on disk so deleting a job is a single cascading DELETE with no orphans.
      CREATE TABLE raw_blocks (
        job_id TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        idx    INTEGER NOT NULL,
        data   BLOB    NOT NULL,
        PRIMARY KEY (job_id, idx)
      );

      -- One row per contact. status IS NULL means "ingested, not yet verified",
      -- which is what makes the run resumable without a separate queue table.
      CREATE TABLE job_rows (
        job_id         TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        row_number     INTEGER NOT NULL,
        chunk_index    INTEGER NOT NULL,
        email_enc      BLOB    NOT NULL,
        email_hash     BLOB    NOT NULL,
        domain         TEXT    NOT NULL DEFAULT '',
        qualification  TEXT    NOT NULL DEFAULT 'Other',
        duplicate      INTEGER NOT NULL DEFAULT 0,
        status         TEXT,
        score          INTEGER,
        suggestion_enc BLOB,
        PRIMARY KEY (job_id, row_number)
      );
      CREATE INDEX idx_rows_chunk  ON job_rows(job_id, chunk_index);
      CREATE INDEX idx_rows_status ON job_rows(job_id, status);
      CREATE INDEX idx_rows_seg    ON job_rows(job_id, qualification, status);
      CREATE INDEX idx_rows_hash   ON job_rows(job_id, email_hash);
      CREATE INDEX idx_rows_domain ON job_rows(job_id, domain);

      -- Normalised so reason counts and reason filtering are index lookups
      -- rather than a LIKE over a JSON blob.
      CREATE TABLE row_reasons (
        job_id     TEXT    NOT NULL,
        row_number INTEGER NOT NULL,
        reason     TEXT    NOT NULL,
        PRIMARY KEY (job_id, row_number, reason),
        FOREIGN KEY (job_id, row_number) REFERENCES job_rows(job_id, row_number) ON DELETE CASCADE
      );
      CREATE INDEX idx_reasons ON row_reasons(job_id, reason);
    `,
  },
];

MIGRATIONS.push({
  version: 2,
  name: 'reasons as a bitmask',
  // Measured on a 182K-row database: row_reasons plus its two indexes was 43%
  // of the whole file, and idx_rows_domain was never chosen by the planner
  // because domain matching happens during the decrypt-scan, not in SQL.
  up: 'ALTER TABLE job_rows ADD COLUMN reasons_mask INTEGER NOT NULL DEFAULT 0;',
  run: (conn) => {
    // Fold the normalised rows into the new column before dropping them.
    const rows = conn.prepare(`
      SELECT job_id, row_number, group_concat(reason, '|') reasons
      FROM row_reasons GROUP BY job_id, row_number`).all();
    const update = conn.prepare(
      'UPDATE job_rows SET reasons_mask = ? WHERE job_id = ? AND row_number = ?');
    for (const r of rows) {
      update.run(reasonsToMask(r.reasons.split('|')), r.job_id, r.row_number);
    }
    conn.exec('DROP INDEX IF EXISTS idx_reasons; DROP TABLE IF EXISTS row_reasons;');
    conn.exec('DROP INDEX IF EXISTS idx_rows_domain;');
    if (rows.length) log.info('folded reasons into bitmask', { rows: rows.length });
  },
  vacuumAfter: true,
});

MIGRATIONS.push({
  version: 3,
  name: 'materialised counts',
  // Recomputing the dashboard aggregates cost ~800ms on a 156K-row job, and the
  // progress stream asked for them several times a second. They are now
  // maintained incrementally and recomputed from SQL only at points where drift
  // is possible (load, resume, finish).
  up: 'ALTER TABLE jobs ADD COLUMN counts_json TEXT;',
});

MIGRATIONS.push({
  version: 4,
  name: 'drop the blind-index B-tree',
  // The blind index made exact-address search an index hit, but its keys are by
  // construction random, so every insert was a random B-tree write: measured at
  // 12.4s of a 22.7s ingest on 156K rows, plus 8.5MB of storage.
  //
  // The email_hash column stays. Exact search now scans it — but comparing
  // 16 bytes per row is far cheaper than decrypting each address, so the
  // feature keeps its real benefit (no decryption) without the write cost.
  up: 'DROP INDEX IF EXISTS idx_rows_hash;',
  vacuumAfter: true,
});

MIGRATIONS.push({
  version: 5,
  name: 'upload format',
  // Uploads are no longer CSV-only. The ingest step reads the stored raw blocks
  // long after the request that uploaded them is gone, so it needs to know how
  // to parse them. `doc_qualification` holds the single segment chosen for a
  // Word/PDF upload, which has no qualification column to map.
  //
  // Existing rows default to 'csv', which is what they all are.
  up: `
    ALTER TABLE jobs ADD COLUMN format TEXT NOT NULL DEFAULT 'csv';
    ALTER TABLE jobs ADD COLUMN doc_qualification TEXT;
  `,
});

function currentVersion() {
  return db.pragma('user_version', { simple: true });
}

export function migrate() {
  const from = currentVersion();
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (!pending.length) return from;

  for (const migration of pending) {
    db.transaction(() => {
      if (migration.up) db.exec(migration.up);
      if (migration.run) migration.run(db);
      // SQLITE-SPECIFIC: user_version pragma as the schema version register.
      // Postgres would use a schema_migrations table instead.
      db.pragma(`user_version = ${migration.version}`);
    })();
    log.info('database migration applied', { version: migration.version, name: migration.name });
    // VACUUM cannot run inside a transaction, hence after the commit.
    if (migration.vacuumAfter) {
      db.exec('VACUUM');
      log.info('database vacuumed after migration', { version: migration.version });
    }
  }
  return currentVersion();
}

/** Fold the write-ahead log back into the main file and truncate it. */
export function checkpoint() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log.warn('wal checkpoint failed', { code: err?.code || 'unknown' });
  }
}

/** Reclaim pages freed by deleted jobs, a bounded amount at a time. */
export function reclaimSpace(pages = 512) {
  try {
    db.pragma(`incremental_vacuum(${pages})`);
  } catch (err) {
    log.warn('incremental vacuum failed', { code: err?.code || 'unknown' });
  }
}

export function dbStats() {
  const pageSize = db.pragma('page_size', { simple: true });
  const pageCount = db.pragma('page_count', { simple: true });
  const freePages = db.pragma('freelist_count', { simple: true });
  return {
    file: DB_FILE,
    schemaVersion: currentVersion(),
    sizeBytes: pageSize * pageCount,
    freeBytes: pageSize * freePages,
    jobs: db.prepare('SELECT COUNT(*) c FROM jobs').get().c,
    rows: db.prepare('SELECT COUNT(*) c FROM job_rows').get().c,
  };
}

export function closeDb() {
  try { db.close(); } catch { /* already closed */ }
}

process.on('exit', closeDb);

migrate();

log.info('database ready', {
  schemaVersion: currentVersion(),
  walMode: db.pragma('journal_mode', { simple: true }),
});

export { DB_FILE, config };
