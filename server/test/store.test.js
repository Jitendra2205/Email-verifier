// Database-level tests: schema, encryption at rest, querying, and the
// resume/counting contract.
//
// Each run gets its own database file, so these never touch real job data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_FILE = path.join(os.tmpdir(), `ev-store-test-${process.pid}.db`);
process.env.DB_FILE = DB_FILE;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-store-'));

const store = await import('../src/store.js');
const { db, dbStats } = await import('../src/db.js');

test.after(() => {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_FILE + suffix, { force: true });
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function makeRows(from, to, chunkIndex) {
  const rows = [];
  for (let i = from; i < to; i++) {
    rows.push({
      rowNumber: i,
      email: `person${i}@firm${i % 3}.example`,
      qualification: ['CPA', 'EA', 'HR Professional'][i % 3],
      duplicate: i % 10 === 0,
      chunkIndex,
    });
  }
  return rows;
}

function resultsFor(rows) {
  return rows.map((r) => ({
    rowNumber: r.rowNumber,
    email: r.email,
    domain: r.email.split('@')[1],
    qualification: r.qualification,
    duplicate: r.duplicate,
    status: r.rowNumber % 4 === 0 ? 'invalid' : 'valid',
    score: r.rowNumber % 4 === 0 ? 0 : 90,
    reasons: r.rowNumber % 4 === 0 ? ['domain_no_mail'] : ['smtp_not_run'],
    suggestion: r.rowNumber === 1 ? 'fixed@firm1.example' : undefined,
  }));
}

async function seedJob({ chunks = 3, chunkSize = 50 } = {}) {
  const job = await store.createJob({ filename: 'list.csv', sizeBytes: 100, owner: 'tester' });
  for (let c = 0; c < chunks; c++) {
    store.insertSourceRows(job.id, c, makeRows(c * chunkSize, (c + 1) * chunkSize, c));
  }
  job.chunkCount = chunks;
  job.totalRows = chunks * chunkSize;
  await store.saveJob(job);
  return job;
}

test('the schema migrates to the current version on a fresh database', () => {
  const stats = dbStats();
  assert.ok(stats.schemaVersion >= 4, `schema version was ${stats.schemaVersion}`);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('email addresses are ciphertext in the table, not plaintext', async () => {
  const job = await seedJob({ chunks: 1, chunkSize: 5 });
  const raw = db.prepare('SELECT email_enc, domain FROM job_rows WHERE job_id = ? LIMIT 1').get(job.id);
  assert.ok(Buffer.isBuffer(raw.email_enc));
  assert.ok(!raw.email_enc.toString('latin1').includes('@'), 'address must not be readable in the column');
  // The domain stays in the clear on purpose — it is what the aggregates index.
  assert.equal(raw.domain, '');
  const [row] = store.readSourceChunk(job.id, 0);
  assert.match(row.email, /^person0@firm0\.example$/, 'round-trips through decryption');
});

test('the job filename is encrypted too', async () => {
  const job = await store.createJob({ filename: 'acme-partners.csv', sizeBytes: 1, owner: 'tester' });
  const raw = db.prepare('SELECT filename_enc FROM jobs WHERE id = ?').get(job.id);
  assert.ok(!raw.filename_enc.toString('latin1').includes('acme'));
  assert.equal((await store.loadJob(job.id)).filename, 'acme-partners.csv');
});

test('counts aggregate correctly across chunks', async () => {
  const job = await seedJob({ chunks: 3, chunkSize: 50 });
  store.seedCounts(job.id);
  for (let c = 0; c < 3; c++) {
    const rows = store.readSourceChunk(job.id, c).map((r) => ({ ...r, chunkIndex: c }));
    const results = resultsFor(rows);
    store.writeChunkResults(job.id, results);
    store.applyResultsDelta(job.id, results);
  }
  const incremental = store.jobCounts(job.id);
  const authoritative = store.recomputeCounts(job.id);

  assert.equal(incremental.processed, 150);
  assert.equal(incremental.valid + incremental.invalid, 150);
  // The incremental tally and the SQL aggregate must agree exactly — that is
  // the whole premise of maintaining counts outside the database.
  for (const key of ['processed', 'valid', 'invalid', 'risky', 'disposable', 'cleanValid', 'duplicates']) {
    assert.equal(incremental[key], authoritative[key], `${key} drifted`);
  }
  assert.deepEqual(incremental.bySegment, authoritative.bySegment);
  assert.deepEqual(incremental.byReason, authoritative.byReason);
});

test('re-verifying a chunk does not double-count — the resume contract', async () => {
  const job = await seedJob({ chunks: 3, chunkSize: 50 });
  store.seedCounts(job.id);

  const commit = (c) => {
    const rows = store.readSourceChunk(job.id, c);
    const results = resultsFor(rows);
    store.writeChunkResults(job.id, results);
    store.applyResultsDelta(job.id, results);
  };
  commit(0);
  commit(1);

  // Simulate the crash-and-resume case: chunk 1 is replayed because the cursor
  // checkpoint never made it to disk.
  commit(1);
  const drifted = store.jobCounts(job.id);
  assert.equal(drifted.processed, 150, 'the incremental tally over-counts, as expected');

  // ...which is exactly why a resume recomputes from SQL before continuing.
  const corrected = store.recomputeCounts(job.id);
  assert.equal(corrected.processed, 100, 'SQL sees 100 distinct verified rows');
  assert.equal(corrected.valid + corrected.invalid, 100);
});

test('unverified rows are the resumable remainder', async () => {
  const job = await seedJob({ chunks: 4, chunkSize: 25 });
  const rows = store.readSourceChunk(job.id, 0);
  const results = resultsFor(rows);
  store.writeChunkResults(job.id, results);

  const pending = db.prepare(
    'SELECT COUNT(*) c FROM job_rows WHERE job_id = ? AND status IS NULL').get(job.id).c;
  assert.equal(pending, 75, 'three of four chunks still to do');
});

test('reasons survive as a bitmask and drive filtering', async () => {
  const job = await seedJob({ chunks: 1, chunkSize: 20 });
  const rows = store.readSourceChunk(job.id, 0);
  const results = resultsFor(rows);
  store.writeChunkResults(job.id, results);
  store.recomputeCounts(job.id);

  const page = store.queryResults(job, { reason: 'domain_no_mail', page: 1, pageSize: 50 });
  assert.ok(page.matched > 0);
  for (const row of page.rows) assert.ok(row.reasons.includes('domain_no_mail'));

  const counts = store.jobCounts(job.id);
  assert.equal(counts.byReason.domain_no_mail, page.matched);
});

test('an unregistered reason code is rejected rather than silently dropped', async () => {
  const { reasonsToMask } = await import('../src/verify/index.js');
  assert.throws(() => reasonsToMask(['not_a_real_reason']), /Unregistered reason code/);
});

test('filters and pagination are consistent', async () => {
  const job = await seedJob({ chunks: 2, chunkSize: 60 });
  for (let c = 0; c < 2; c++) store.writeChunkResults(job.id, resultsFor(store.readSourceChunk(job.id, c)));
  store.recomputeCounts(job.id);

  const all = store.queryResults(job, { page: 1, pageSize: 1000 });
  const valid = store.queryResults(job, { status: 'valid', page: 1, pageSize: 1000 });
  const invalid = store.queryResults(job, { status: 'invalid', page: 1, pageSize: 1000 });
  assert.equal(valid.matched + invalid.matched, all.matched);

  const p1 = store.queryResults(job, { page: 1, pageSize: 10 });
  const p2 = store.queryResults(job, { page: 2, pageSize: 10 });
  assert.equal(p1.rows.length, 10);
  assert.equal(p2.rows.length, 10);
  assert.notEqual(p1.rows[0].rowNumber, p2.rows[0].rowNumber, 'pages must not overlap');
  assert.equal(p1.pages, Math.ceil(all.matched / 10));
});

test('exact-address search matches without decrypting every row', async () => {
  const job = await seedJob({ chunks: 1, chunkSize: 30 });
  store.writeChunkResults(job.id, resultsFor(store.readSourceChunk(job.id, 0)));
  const hit = store.queryResults(job, { search: 'person7@firm1.example', page: 1, pageSize: 10 });
  assert.equal(hit.matched, 1);
  assert.equal(hit.rows[0].email, 'person7@firm1.example');

  const miss = store.queryResults(job, { search: 'nobody@nowhere.example', page: 1, pageSize: 10 });
  assert.equal(miss.matched, 0);
});

test('substring search finds partial local parts', async () => {
  const job = await seedJob({ chunks: 1, chunkSize: 30 });
  store.writeChunkResults(job.id, resultsFor(store.readSourceChunk(job.id, 0)));
  const hit = store.queryResults(job, { search: 'person1', page: 1, pageSize: 100 });
  assert.ok(hit.matched >= 2, `expected several matches, got ${hit.matched}`);
  for (const row of hit.rows) assert.ok(row.email.includes('person1'));
});

test('the clean export is Valid and non-duplicate only', async () => {
  const job = await seedJob({ chunks: 2, chunkSize: 50 });
  for (let c = 0; c < 2; c++) store.writeChunkResults(job.id, resultsFor(store.readSourceChunk(job.id, c)));
  const counts = store.recomputeCounts(job.id);

  const clean = [...store.iterateResults(job, { validOnly: true })];
  assert.equal(clean.length, counts.cleanValid, 'the advertised count matches the export');
  for (const row of clean) {
    assert.equal(row.status, 'valid');
    assert.equal(row.duplicate, false);
  }
  const full = [...store.iterateResults(job)];
  assert.equal(full.length, counts.processed);
});

test('deleting a job removes its rows and raw upload blocks', async () => {
  const job = await seedJob({ chunks: 1, chunkSize: 20 });
  store.storeRawBlock(job.id, 0, Buffer.from('ciphertext'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM raw_blocks WHERE job_id = ?').get(job.id).c, 1);

  await store.deleteJob(job.id);
  assert.equal(await store.loadJob(job.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM job_rows WHERE job_id = ?').get(job.id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM raw_blocks WHERE job_id = ?').get(job.id).c, 0);
});

test('retention sweep deletes only expired jobs', async () => {
  const keep = await seedJob({ chunks: 1, chunkSize: 5 });
  const drop = await seedJob({ chunks: 1, chunkSize: 5 });
  drop.expiresAt = Date.now() - 1000;
  await store.saveJob(drop);

  await store.sweepExpired();
  assert.equal(await store.loadJob(drop.id), null, 'expired job removed');
  assert.ok(await store.loadJob(keep.id), 'live job kept');
});

test('jobs are scoped to their owner', async () => {
  const mine = await store.createJob({ filename: 'a.csv', sizeBytes: 1, owner: 'alice' });
  await store.createJob({ filename: 'b.csv', sizeBytes: 1, owner: 'bob' });
  const alices = await store.listJobs('alice');
  assert.ok(alices.every((j) => j.owner === 'alice'));
  assert.ok(alices.some((j) => j.id === mine.id));
  assert.ok((await store.listJobs()).length > alices.length, 'no owner returns every job');
});
