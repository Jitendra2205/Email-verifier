import React from 'react';
import { JOB_STATUS_LABEL, formatDuration, formatNumber, relativeExpiry } from '../format.js';

export default function Progress({ job, progress, onPause, onResume, onCancel, onDelete, busy }) {
  const status = progress?.status || job.status;
  const total = progress?.total ?? job.counts?.total ?? 0;
  const processed = progress?.processed ?? 0;
  const percent = progress?.percent ?? 0;
  const active = status === 'running';
  const finished = status === 'done';
  const ingesting = status === 'ingesting';

  return (
    <section className={`panel progress-panel ${status}`}>
      <header className="panel-head">
        <div>
          <h2>{job.filename}</h2>
          <p className="muted">
            <span className={`chip ${status}`}>{JOB_STATUS_LABEL[status] || status}</span>
            {' '}{formatNumber(processed)} of {formatNumber(total)} rows
            {job.smtpProbe && <> · <span className="chip warn">SMTP probing on</span></>}
            {' · '}{relativeExpiry(job.expiresAt)}
          </p>
        </div>
        <div className="head-actions">
          {active && <button className="ghost" onClick={onPause} disabled={busy}>Pause</button>}
          {(status === 'paused' || status === 'queued' || status === 'failed') && (
            <button className="primary" onClick={onResume} disabled={busy}>
              {job.cursor > 0 ? 'Resume' : 'Start'}
            </button>
          )}
          {(active || status === 'paused') && (
            <button className="ghost danger" onClick={onCancel} disabled={busy}>Cancel</button>
          )}
          <button className="ghost danger" onClick={onDelete} disabled={busy}>Delete</button>
        </div>
      </header>

      {ingesting && (
        <div className="alert">
          <strong>Reading the file…</strong>{' '}
          {formatNumber(total)} rows read so far. Verification starts automatically when
          this finishes — you can leave this page.
        </div>
      )}

      {status !== 'awaiting_mapping' && !ingesting && (
        <>
          <div className="bar tall">
            <div className={`bar-fill ${active ? 'animated' : ''}`} style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-meta">
            <span><strong>{percent.toFixed(1)}%</strong></span>
            <span>
              {active && progress?.rowsPerSecond
                ? `${formatNumber(progress.rowsPerSecond)} rows/sec`
                : finished
                  ? `finished in ${formatDuration((job.finishedAt || 0) - (job.startedAt || 0))}`
                  : '—'}
            </span>
            <span>
              {active && progress?.etaMs != null
                ? `~${formatDuration(progress.etaMs)} remaining`
                : status === 'paused'
                  ? `paused at chunk ${job.cursor} of ${job.chunkCount} — resumable`
                  : ''}
            </span>
          </div>
        </>
      )}

      {status === 'failed' && (
        <div className="alert bad">
          <strong>Job failed.</strong> {job.error || 'Unknown error.'}{' '}
          {job.cursor > 0 && <>Work up to row {formatNumber(job.cursor * job.chunkSize)} is saved — resuming picks up from there.</>}
        </div>
      )}
      {status === 'cancelled' && (
        <div className="alert warn">
          Cancelled at {formatNumber(processed)} rows. Results processed so far are still exportable.
        </div>
      )}
      {status === 'paused' && (
        <div className="alert">
          Paused. You can close this tab — the job state is stored server-side and
          resuming continues from row {formatNumber(job.cursor * job.chunkSize)}.
        </div>
      )}
    </section>
  );
}
