// Chunked background job runner.
//
// Requirements this satisfies:
//   * 250K rows must not block an HTTP request or the UI — processing happens
//     off the request cycle and progress is streamed.
//   * Resumable — a row with a NULL status has not been verified yet, so the
//     work remaining is a property of the data, not of any in-memory state.
//     `job.cursor` is just the chunk index to restart from.
//
// Counts are maintained incrementally from each chunk's results. A run that
// starts at chunk 0 counts every row exactly once, so that tally is exact. A
// resume is the case that can drift — it re-verifies the chunk that was in
// flight when the previous process died — so a resume, and only a resume, pays
// for a full SQL recompute at both ends of the run.
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { mapLimit } from './limiter.js';
import { log } from './logger.js';
import { verifyOne } from './verify/index.js';
import { isDocumentFormat } from './formats/index.js';
import {
  applyResultsDelta, flushCounts, jobCounts, loadJob, readSourceChunk, recomputeCounts, seedCounts,
  saveJob, writeChunkResults,
} from './store.js';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

const controls = new Map(); // jobId -> { pause, cancel, running, abort }

function control(jobId) {
  if (!controls.has(jobId)) {
    controls.set(jobId, { pause: false, cancel: false, running: false, abort: new AbortController() });
  }
  return controls.get(jobId);
}

/** Hand control back to the event loop so pending I/O (the HTTP server) can run. */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

export function isRunning(jobId) {
  return Boolean(controls.get(jobId)?.running);
}

/**
 * @param {object} job
 * @param {number} inFlight rows finished in the current chunk but not yet
 *   committed. Lets the bar move smoothly instead of jumping once per chunk,
 *   which at chunk=1000 would mean a visibly frozen UI.
 */
export function publicProgress(job, inFlight = 0) {
  const counts = jobCounts(job.id);
  // Take the total from the job record rather than the cached tally: during
  // ingest it climbs with every batch, and the tally is only refreshed when
  // rows are verified.
  const total = job.totalRows || counts.total || 0;
  counts.total = total;
  const processed = Math.min(total, (counts.processed || 0) + inFlight);
  const pct = total ? Math.min(100, (processed / total) * 100) : 0;
  const etaMs = job.msPerRow && processed < total
    ? Math.round(job.msPerRow * (total - processed))
    : null;
  return {
    id: job.id,
    status: job.status,
    processed,
    total,
    percent: Number(pct.toFixed(2)),
    etaMs,
    rowsPerSecond: job.msPerRow ? Number((1000 / job.msPerRow).toFixed(1)) : null,
    counts,
    error: job.error,
    updatedAt: job.updatedAt,
  };
}

export function emitProgress(job, inFlight = 0) {
  const payload = publicProgress(job, inFlight);
  jobEvents.emit('progress', payload);
  jobEvents.emit(`progress:${job.id}`, payload);
}

/** Read the encrypted upload back as a single Buffer (spreadsheets and documents). */
async function readWholeUpload(job, { createDecryptedBlockStream, readRawBlock }) {
  const stream = createDecryptedBlockStream((i) => readRawBlock(job.id, i), job.rawBlocks || 0);
  const parts = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/**
 * Produce normalised row batches from whatever the upload happens to be.
 *
 * CSV/TSV/text stream through the parser and never sit in memory. Excel and
 * documents cannot: their libraries need the whole file at once, which is why
 * those formats carry a tighter size cap.
 */
async function ingestByFormat(job, mapping, onBatch, deps) {
  const { createDecryptedBlockStream, readRawBlock, streamMappedRows,
    streamSpreadsheetRows, extractDocumentRows } = deps;

  if (isDocumentFormat(job.format)) {
    const buffer = await readWholeUpload(job, deps);
    const { rows, duplicates } = await extractDocumentRows(buffer, job.format, job.docQualification);
    for (let i = 0; i < rows.length; i += config.chunkSize) {
      await onBatch(rows.slice(i, i + config.chunkSize));
    }
    return {
      total: rows.length,
      duplicates,
      blank: 0,
      uniqueEmails: rows.length,
    };
  }

  if (job.format === 'xlsx') {
    const buffer = await readWholeUpload(job, deps);
    return streamSpreadsheetRows(buffer, mapping, onBatch);
  }

  const source = createDecryptedBlockStream((i) => readRawBlock(job.id, i), job.rawBlocks || 0);
  return streamMappedRows(source, mapping, onBatch);
}

/**
 * Read the encrypted upload into normalised rows, in the background.
 *
 * Ingest is not instant — at 250K rows it is tens of seconds of parsing and
 * per-row encryption — so it must not happen inside the HTTP request any more
 * than verification does. The route returns as soon as this is scheduled and
 * the client follows the same progress stream it uses for the run itself.
 */
export async function startIngest(jobId, mapping, deps) {
  const { createDecryptedBlockStream, readRawBlock, deleteRawBlocks, insertSourceRows,
    streamMappedRows, streamSpreadsheetRows, extractDocumentRows } = deps;

  const job = await loadJob(jobId);
  if (!job) return;

  let chunkIndex = 0;
  let lastEmit = 0;
  try {
    // Every format converges on the same callback: hand over a batch of
    // normalised rows, and everything downstream is identical. Only the way
    // batches are produced differs.
    const onBatch = (batch) => {
      insertSourceRows(jobId, chunkIndex, batch);
      chunkIndex++;
      // Surface the row count as it climbs so "Reading file" isn't a dead wait.
      job.totalRows += batch.length;
      const now = Date.now();
      if (now - lastEmit > 400) {
        lastEmit = now;
        // Persist as well as emit: a client that is polling rather than on the
        // SSE stream reads this straight back out of the database.
        saveJob(job).catch(() => {});
        emitProgress(job);
      }
    };

    const summary = await ingestByFormat(job, mapping, onBatch, {
      createDecryptedBlockStream, readRawBlock, streamMappedRows,
      streamSpreadsheetRows, extractDocumentRows,
    });

    job.chunkCount = chunkIndex;
    job.totalRows = summary.total;
    job.blankRows = summary.blank;
    job.cursor = 0;
    deleteRawBlocks(jobId);
    job.rawBlocks = 0;

    if (summary.total === 0) {
      job.status = 'failed';
      job.error = isDocumentFormat(job.format)
        ? 'No email addresses could be extracted from that document.'
        : 'No usable rows — every row had an empty email column.';
      await saveJob(job);
      emitProgress(job);
      return;
    }

    job.status = 'queued';
    await saveJob(job);
    log.info('job ingested', {
      jobId, rows: summary.total, unique: summary.uniqueEmails,
      duplicates: summary.duplicates, blank: summary.blank, chunks: chunkIndex,
    });
    emitProgress(job);
    await startJob(jobId);
  } catch (err) {
    deleteRawBlocks(jobId);
    const current = (await loadJob(jobId)) || job;
    current.rawBlocks = 0;
    current.status = 'failed';
    current.error = 'Failed to read the file: ' + String(err?.message || 'unknown error').slice(0, 200);
    await saveJob(current);
    emitProgress(current);
    log.error('ingest failed', { jobId, error: err });
  }
}

/**
 * Start (or resume) processing. Returns immediately; work continues in the
 * background. Safe to call twice — the second call is a no-op.
 */
export async function startJob(jobId) {
  const ctl = control(jobId);
  if (ctl.running) return;
  ctl.pause = false;
  ctl.cancel = false;
  ctl.abort = new AbortController();
  ctl.running = true;
  process.nextTick(() => runLoop(jobId).catch((err) => {
    log.error('job loop crashed', { jobId, error: err });
  }));
}

export function pauseJob(jobId) {
  const ctl = control(jobId);
  ctl.pause = true;
  ctl.abort.abort();
}

export function cancelJob(jobId) {
  const ctl = control(jobId);
  ctl.cancel = true;
  ctl.abort.abort();
}

async function runLoop(jobId) {
  const ctl = control(jobId);
  let job = await loadJob(jobId);
  if (!job) { ctl.running = false; return; }

  job.status = 'running';
  job.error = null;
  if (!job.startedAt) job.startedAt = Date.now();
  await saveJob(job);

  // Start from an authoritative tally. On a resume the previous process may
  // have died between committing a chunk and persisting its counts, so the
  // stored numbers can be behind — or, if the interrupted chunk is re-verified,
  // ahead; one scan removes both possibilities. A job starting from chunk 0 has
  // nothing to count yet, so it skips the scan entirely.
  const wasResume = job.cursor > 0;
  if (wasResume) recomputeCounts(jobId); else seedCounts(jobId);

  emitProgress(job);
  log.info('job started', { jobId, fromChunk: job.cursor, chunks: job.chunkCount });

  // Rolling throughput estimate, weighted to recent chunks so the ETA reacts to
  // a slow stretch (a domain being throttled) instead of averaging it away.
  let msPerRow = job.msPerRow;
  let lastCheckpoint = Date.now();
  let checkpointCursor = job.cursor;

  /**
   * Persist the resume cursor. A failure here is logged and swallowed: the row
   * results are already committed, so a missed checkpoint costs at most a
   * re-verified chunk on resume. Aborting the run instead would be a far worse
   * outcome for a transient write hiccup.
   */
  const checkpoint = async (current) => {
    try {
      await saveJob(current);
    } catch (err) {
      log.warn('checkpoint write failed — continuing', { jobId, code: err?.code || 'unknown' });
    }
  };

  try {
    while (job.cursor < job.chunkCount) {
      if (ctl.cancel) {
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        await saveJob(job);
        emitProgress(job);
        log.info('job cancelled', { jobId, atChunk: job.cursor });
        return;
      }
      if (ctl.pause) {
        job.status = 'paused';
        await saveJob(job);
        emitProgress(job);
        log.info('job paused', { jobId, atChunk: job.cursor });
        return;
      }

      const started = Date.now();
      const rows = readSourceChunk(jobId, job.cursor);

      let doneInChunk = 0;
      let lastTick = 0;
      const tick = () => {
        doneInChunk++;
        // Throttled: one SSE frame per row would be its own denial of service.
        const now = Date.now();
        if (now - lastTick > 250) { lastTick = now; emitProgress(job, doneInChunk); }
      };

      // Concurrency within a chunk is bounded by the DNS gate anyway; this just
      // keeps enough work in flight to saturate it.
      const results = await mapLimit(rows, config.dns.concurrency, async (row) => {
        try {
          const out = await verifyOne(row, { signal: ctl.abort.signal });
          tick();
          // Once the domain cache is warm, verifyOne resolves without touching
          // the network, so `await` only ever yields to the microtask queue —
          // and the event loop's I/O phase never runs. The whole job then
          // executes in one long tick and the HTTP server stops answering.
          // A periodic macrotask yield is what keeps the API alive mid-run.
          if (doneInChunk % 100 === 0) await yieldToEventLoop();
          return out;
        } catch (err) {
          if (ctl.pause || ctl.cancel) throw err;
          log.warn('row verification failed', { jobId, code: err?.code || 'unknown' });
          tick();
          return {
            rowNumber: row.rowNumber,
            email: row.email,
            domain: '',
            qualification: row.qualification || 'Other',
            duplicate: Boolean(row.duplicate),
            status: 'risky',
            score: 30,
            reasons: ['domain_unresolved'],
          };
        }
      });

      writeChunkResults(jobId, results);
      applyResultsDelta(jobId, results);
      job.cursor++;
      // The chunk commit is a synchronous SQLite transaction; yield after it too.
      await yieldToEventLoop();

      const elapsed = Date.now() - started;
      if (rows.length) {
        const sample = elapsed / rows.length;
        msPerRow = msPerRow == null ? sample : msPerRow * 0.7 + sample * 0.3;
        job.msPerRow = Number(msPerRow.toFixed(3));
      }

      // Checkpoint throttling. Persisting after every chunk is ~150 writes per
      // second at full speed. Checkpointing at most every 500ms (or every 10
      // chunks) bounds the redo-on-crash to about a second of work.
      const dueByTime = Date.now() - lastCheckpoint > 500;
      const dueByChunks = job.cursor - checkpointCursor >= 10;
      if (dueByTime || dueByChunks || job.cursor >= job.chunkCount) {
        await checkpoint(job);
        flushCounts(jobId);
        lastCheckpoint = Date.now();
        checkpointCursor = job.cursor;
      }
      emitProgress(job);
    }

    job.status = 'done';
    job.finishedAt = Date.now();
    await saveJob(job);
    // A run that started at chunk 0 counted every row exactly once, so its
    // incremental tally is already exact. Only a resume can have double-counted
    // the chunk that was in flight when the previous process died, and only
    // that case pays for the full recompute.
    const counts = wasResume ? recomputeCounts(jobId) : (flushCounts(jobId), jobCounts(jobId));
    emitProgress(job);
    log.info('job finished', {
      jobId,
      rows: counts.processed,
      valid: counts.valid,
      risky: counts.risky,
      invalid: counts.invalid,
      disposable: counts.disposable,
      seconds: Math.round(((job.finishedAt - job.startedAt) || 0) / 1000),
    });
  } catch (err) {
    if (ctl.pause || ctl.cancel) {
      job = (await loadJob(jobId)) || job;
      job.status = ctl.cancel ? 'cancelled' : 'paused';
      await saveJob(job);
      emitProgress(job);
      return;
    }
    const current = (await loadJob(jobId)) || job;
    current.status = 'failed';
    current.error = err?.message ? String(err.message).slice(0, 300) : 'Unknown error';
    await saveJob(current);
    emitProgress(current);
    log.error('job failed', { jobId, error: err });
  } finally {
    ctl.running = false;
  }
}

/**
 * On boot, any job the database still thinks is running was interrupted by a
 * restart. Mark it paused rather than failed — every verified row is already
 * committed, so resuming loses nothing.
 */
export async function recoverInterruptedJobs(jobs, { discardPartialIngest } = {}) {
  for (const job of jobs) {
    if (job.status === 'running') {
      job.status = 'paused';
      job.error = null;
      await saveJob(job);
      log.info('recovered interrupted job as paused', { jobId: job.id, atChunk: job.cursor });
      continue;
    }
    if (job.status === 'ingesting') {
      // A half-read file would give wrong totals. The encrypted upload is still
      // in the database, so throw away the partial rows and send the job back to
      // the mapping step rather than stranding it as failed.
      discardPartialIngest?.(job.id);
      const recoverable = job.rawBlocks > 0;
      job.status = recoverable ? 'awaiting_mapping' : 'failed';
      job.error = recoverable ? null : 'Interrupted while reading the file. Re-upload to retry.';
      job.chunkCount = 0;
      job.cursor = 0;
      job.totalRows = 0;
      await saveJob(job);
      log.info('recovered interrupted ingest', { jobId: job.id, status: job.status });
    }
  }
}
