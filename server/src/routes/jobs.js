import express from 'express';
import multer from 'multer';
import fsp from 'node:fs/promises';
import { config } from '../config.js';
import { createDecryptedBlockStream, encryptFileToBlocks, randomId, shred } from '../crypto.js';
import { log } from '../logger.js';
import { rateLimit } from '../auth.js';
import {
  EXPECTED_FIELDS, QUALIFICATIONS, csvLine, inspectCsv, streamMappedRows, suggestMapping,
} from '../csv.js';
import {
  ACCEPTED_EXTENSIONS, FORMAT_LABELS, detectFormat, isBufferedFormat, isDocumentFormat,
} from '../formats/index.js';
import { inspectSpreadsheet, streamSpreadsheetRows } from '../formats/spreadsheet.js';
import { extractDocumentRows, inspectDocument } from '../formats/document.js';
import {
  UPLOAD_DIR, createJob, deleteJob, deleteRawBlocks, insertSourceRows, iterateResults,
  jobCounts, listJobs, loadJob, queryResults, readRawBlock, saveJob, storeRawBlock,
} from '../store.js';
import {
  cancelJob, isRunning, jobEvents, pauseJob, publicProgress, startIngest, startJob,
} from '../runner.js';
import { REASON_LABELS, describeReason, pipelineStats } from '../verify/index.js';

export const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    // The stored name is random and extension-less on purpose — the uploader
    // does not get to choose a path or a type. Format comes from detectFormat.
    filename: (_req, _file, cb) => cb(null, `${randomId(12)}.upload`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (detectFormat(file.originalname)) return cb(null, true);
    cb(new Error(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`));
  },
});

/** Job view safe to send to the client. */
function jobView(job) {
  return {
    id: job.id,
    filename: job.filename,
    sizeBytes: job.sizeBytes,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    headers: job.headers,
    mapping: job.mapping,
    chunkSize: job.chunkSize,
    chunkCount: job.chunkCount,
    cursor: job.cursor,
    counts: jobCounts(job.id),
    smtpProbe: job.smtpProbe,
    running: isRunning(job.id),
    progress: publicProgress(job),
  };
}

async function getOwnedJob(req, res) {
  const job = await loadJob(req.params.id);
  if (!job || job.owner !== req.user) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

// ---------------------------------------------------------------- meta ------
router.get('/meta', (_req, res) => {
  res.json({
    expectedFields: EXPECTED_FIELDS.map(({ key, label, required }) => ({ key, label, required })),
    qualifications: QUALIFICATIONS,
    reasonLabels: REASON_LABELS,
    retentionDays: config.retentionDays,
    chunkSize: config.chunkSize,
    maxRows: config.maxRows,
    maxUploadMb: Math.round(config.maxUploadBytes / (1024 * 1024)),
    maxBufferedUploadMb: Math.round(config.maxBufferedUploadBytes / (1024 * 1024)),
    acceptedExtensions: ACCEPTED_EXTENSIONS,
    formatLabels: FORMAT_LABELS,
    smtpProbeAvailable: config.smtp.enabled,
    perDomainLookupsPerMinute: config.dns.perDomainPerMinute,
    engine: pipelineStats(),
  });
});

// -------------------------------------------------------------- upload ------
router.post(
  '/jobs',
  rateLimit({ max: config.rateLimit.uploadsPerHour, windowMs: 3600_000, message: 'Upload rate limit reached. Try again later.' }),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB limit`
          : err.message || 'Upload failed';
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const format = detectFormat(req.file.originalname);
    if (!format) {
      await shred(req.file.path);
      return res.status(400).json({ error: `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}` });
    }

    // multer's own limit is the CSV ceiling; buffered formats are stricter and
    // can only be checked once we know the format, which is after the write.
    if (isBufferedFormat(format) && req.file.size > config.maxBufferedUploadBytes) {
      await shred(req.file.path);
      const limitMb = Math.round(config.maxBufferedUploadBytes / (1024 * 1024));
      return res.status(400).json({
        error: `${FORMAT_LABELS[format]} uploads are limited to ${limitMb} MB because they must be parsed in memory. Export to CSV for larger lists.`,
      });
    }

    // Inspect before storing anything, so a file we cannot read never becomes a
    // job the user has to clean up.
    let inspection;
    try {
      if (isDocumentFormat(format)) {
        inspection = await inspectDocument(await fsp.readFile(req.file.path), format);
      } else if (format === 'xlsx') {
        inspection = await inspectSpreadsheet(req.file.path);
      } else {
        inspection = await inspectCsv(req.file.path);
      }
    } catch (err) {
      await shred(req.file.path);
      log.warn('upload inspect failed', { format, code: err?.code || 'parse_error' });
      return res.status(400).json({
        error: format === 'xlsx'
          ? 'Could not read that workbook. Re-save it as .xlsx and try again.'
          : isDocumentFormat(format)
            ? `Could not read that ${FORMAT_LABELS[format]}. It may be corrupt or password-protected.`
            : 'Could not read that file as CSV. Check the delimiter and encoding.',
      });
    }

    // Documents and spreadsheets fail in different ways, so they get different
    // messages rather than one generic "bad file".
    if (isDocumentFormat(format)) {
      if (!inspection.hasText) {
        await shred(req.file.path);
        return res.status(400).json({
          error: `That ${FORMAT_LABELS[format]} has no readable text — a scanned or image-only document. This tool does not run OCR.`,
        });
      }
      if (!inspection.totalFound) {
        await shred(req.file.path);
        return res.status(400).json({
          error: `No email addresses found in that ${FORMAT_LABELS[format]}.`,
        });
      }
    } else {
      if (!inspection.headers.length) {
        await shred(req.file.path);
        return res.status(400).json({ error: 'The file has no header row. Add a header row naming each column.' });
      }
      if (!inspection.preview.length) {
        await shred(req.file.path);
        return res.status(400).json({ error: 'The file has headers but no data rows.' });
      }
    }

    const job = await createJob({
      filename: req.file.originalname || 'upload',
      sizeBytes: req.file.size,
      owner: req.user,
      format,
    });
    // Get the plaintext off disk immediately. The upload is encrypted into the
    // database and the multer temp file is shredded straight away, so the window
    // in which an unencrypted copy of the contact list exists is milliseconds —
    // not however long the user spends on the mapping screen.
    try {
      job.rawBlocks = await encryptFileToBlocks(req.file.path, (i, ciphertext) => storeRawBlock(job.id, i, ciphertext));
    } catch (err) {
      await shred(req.file.path);
      await deleteJob(job.id);
      log.error('failed to secure upload', { jobId: job.id, error: err });
      return res.status(500).json({ error: 'Could not store the upload securely. Nothing was saved.' });
    } finally {
      await shred(req.file.path);
    }

    if (isDocumentFormat(format)) {
      await saveJob(job);
      log.info('document uploaded and encrypted', {
        jobId: job.id, format, bytes: req.file.size,
        addressesFound: inspection.totalFound, blocks: job.rawBlocks,
      });
      return res.status(201).json({
        job: jobView(job),
        format,
        formatLabel: FORMAT_LABELS[format],
        // No columns to map — the client asks for one qualification instead.
        documentExtraction: {
          totalFound: inspection.totalFound,
          repeatsDropped: inspection.duplicates,
          preview: inspection.preview,
        },
      });
    }

    job.headers = inspection.headers;
    const suggested = suggestMapping(inspection.headers);
    job.mapping = suggested;
    await saveJob(job);

    log.info('file uploaded and encrypted', {
      jobId: job.id, format, bytes: req.file.size,
      columns: inspection.headers.length, blocks: job.rawBlocks,
    });

    const missing = EXPECTED_FIELDS.filter((f) => f.required && !suggested[f.key]).map((f) => f.key);
    res.status(201).json({
      job: jobView(job),
      format,
      formatLabel: FORMAT_LABELS[format],
      headers: inspection.headers,
      preview: inspection.preview,
      suggestedMapping: suggested,
      missingRequired: missing,
    });
  },
);

// ------------------------------------------------------------- mapping ------
router.post('/jobs/:id/mapping', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  if (job.status !== 'awaiting_mapping') {
    return res.status(409).json({ error: 'This job has already been ingested.' });
  }

  const isDocument = isDocumentFormat(job.format);
  let mapping = {};

  if (isDocument) {
    // A document has no columns; the client sends one qualification instead,
    // which is applied to every address extracted from it.
    const qualification = String(req.body?.qualification || '').trim();
    if (!QUALIFICATIONS.includes(qualification)) {
      return res.status(400).json({
        error: `Choose a qualification for this document: ${QUALIFICATIONS.join(', ')}.`,
      });
    }
    job.docQualification = qualification;
  } else {
    mapping = req.body?.mapping || {};
    const missing = EXPECTED_FIELDS
      .filter((f) => f.required && !mapping[f.key])
      .map((f) => f.label);
    if (missing.length) {
      return res.status(400).json({ error: `Map a column for: ${missing.join(', ')}` });
    }
    for (const column of Object.values(mapping)) {
      if (column && !job.headers.includes(column)) {
        return res.status(400).json({ error: `Column "${String(column).slice(0, 60)}" is not in this file.` });
      }
    }
  }

  job.mapping = mapping;
  job.smtpProbe = Boolean(req.body?.smtpProbe) && config.smtp.enabled;
  job.status = 'ingesting';
  job.totalRows = 0;
  await saveJob(job);

  // Reading a 250K-row upload is tens of seconds of parsing and per-row
  // encryption — the same reason verification is backgrounded applies here.
  // Answer the request first, then ingest; the client watches the job's
  // existing progress stream and sees the row count climb.
  res.status(202).json({ job: jobView(job) });

  startIngest(job.id, mapping, {
    createDecryptedBlockStream, readRawBlock, deleteRawBlocks, insertSourceRows,
    streamMappedRows, streamSpreadsheetRows, extractDocumentRows,
  }).catch((err) => log.error('ingest scheduling failed', { jobId: job.id, error: err }));
});

// ------------------------------------------------------------ lifecycle -----
router.post('/jobs/:id/start', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  if (!['queued', 'paused', 'failed'].includes(job.status)) {
    return res.status(409).json({ error: `Cannot start a job that is ${job.status}.` });
  }
  await startJob(job.id);
  res.json({ job: jobView(await loadJob(job.id)) });
});

router.post('/jobs/:id/pause', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  pauseJob(job.id);
  res.json({ ok: true });
});

router.post('/jobs/:id/cancel', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  cancelJob(job.id);
  res.json({ ok: true });
});

router.delete('/jobs/:id', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  cancelJob(job.id);
  // One cascading DELETE takes the job, its rows, its reasons and any raw blocks.
  await deleteJob(job.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- read ------
router.get('/jobs', async (req, res) => {
  const jobs = await listJobs(req.user);
  res.json({ jobs: jobs.map(jobView) });
});

router.get('/jobs/:id', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  res.json({ job: jobView(job) });
});

router.get('/jobs/:id/progress', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  res.json(publicProgress(job));
});

/** Server-sent events so the progress bar updates without polling. */
router.get('/jobs/:id/events', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify(publicProgress(job))}\n\n`);

  const onProgress = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  jobEvents.on(`progress:${job.id}`, onProgress);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    jobEvents.off(`progress:${job.id}`, onProgress);
  });
});

router.get('/jobs/:id/results', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
  const result = await queryResults(job, {
    status: req.query.status,
    segment: req.query.segment,
    reason: req.query.reason,
    search: req.query.search,
    page,
    pageSize,
  });
  res.json({
    ...result,
    rows: result.rows.map((r) => ({ ...r, reasonLabels: (r.reasons || []).map(describeReason) })),
  });
});

// -------------------------------------------------------------- export ------
router.get('/jobs/:id/export', async (req, res) => {
  const job = await getOwnedJob(req, res);
  if (!job) return;

  const type = req.query.type === 'clean' ? 'clean' : 'full';
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(job.filename || 'list').replace(/[^\w.-]+/g, '_').replace(/\.csv$/i, '');
  const filename = `${safeName}-${type === 'clean' ? 'clean-send-list' : 'full-results'}-${stamp}.csv`;

  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });

  const header = type === 'clean'
    ? ['email', 'qualification', 'confidence_score']
    : ['row', 'email', 'qualification', 'status', 'confidence_score', 'duplicate', 'domain', 'reasons', 'suggested_correction'];
  res.write(csvLine(header));

  let written = 0;
  // The clean list is Valid only and drops duplicate occurrences so the same
  // person is not mailed twice. That filter is pushed into SQL rather than
  // applied row-by-row here.
  for (const row of iterateResults(job, { validOnly: type === 'clean' })) {
    if (type === 'clean') {
      res.write(csvLine([row.email, row.qualification, row.score]));
    } else {
      res.write(csvLine([
        row.rowNumber ?? '',
        row.email,
        row.qualification,
        row.status,
        row.score,
        row.duplicate ? 'yes' : 'no',
        row.domain,
        (row.reasons || []).map(describeReason).join('; '),
        row.suggestion || '',
      ]));
    }
    written++;
  }

  log.info('export streamed', { jobId: job.id, type, rows: written });
  res.end();
});
