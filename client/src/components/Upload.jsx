import React, { useRef, useState } from 'react';
import { formatBytes, formatNumber } from '../format.js';

export default function Upload({ api, meta, onUploaded }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const inputRef = useRef(null);

  const accepted = meta?.acceptedExtensions ?? ['.csv', '.tsv', '.txt', '.xlsx', '.docx', '.pdf'];

  async function handleFile(file) {
    if (!file) return;
    setError(null);
    const ext = /\.[^.]+$/.exec(file.name.toLowerCase())?.[0];
    if (!ext || !accepted.includes(ext)) {
      setError(`Unsupported file type. Accepted: ${accepted.join(', ')}`);
      return;
    }
    setProgress(0);
    try {
      const payload = await api.upload(file, setProgress);
      onUploaded(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Upload contact list</h2>
          <p className="muted">
            CSV, TSV or Excel with an email column and a qualification column — or a
            Word/PDF document to scan for addresses. Up to{' '}
            {formatNumber(meta?.maxRows ?? 500000)} rows / {meta?.maxUploadMb ?? 200} MB
            ({meta?.maxBufferedUploadMb ?? 25} MB for Excel, Word and PDF).
          </p>
        </div>
      </header>

      <div
        className={`dropzone${dragging ? ' dragging' : ''}${progress != null ? ' busy' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => progress == null && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accepted.join(',')}
          hidden
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {progress == null ? (
          <>
            <strong>Drop a file here</strong>
            <span className="muted">or click to choose one</span>
            <span className="muted small">{accepted.join('  ·  ')}</span>
          </>
        ) : (
          <>
            <strong>Uploading… {Math.round(progress * 100)}%</strong>
            <div className="bar"><div className="bar-fill" style={{ width: `${progress * 100}%` }} /></div>
          </>
        )}
      </div>

      {error && <div className="alert bad" role="alert">{error}</div>}

      <div className="notice">
        <h3>What this tool does — and doesn&apos;t</h3>
        <p>
          Every address goes through syntax validation, an MX lookup on its domain,
          a disposable-provider check, and role-account detection. What it does{' '}
          <em>not</em> do by default is open an SMTP connection to each mail server
          and ask whether the mailbox exists.
        </p>
        <p>
          That is deliberate. At {formatNumber(250000)} addresses, SMTP probing gets
          the sending IP blocklisted, and the big providers (Gmail, Outlook, Yahoo)
          do not answer truthfully anyway. So results come back as a{' '}
          <strong>confidence-scored status</strong>, not a binary claim of
          deliverability the tool cannot actually make.
        </p>
        <p className="muted small">
          Uploads are encrypted at rest and auto-delete after{' '}
          {meta?.retentionDays ?? 7} days. Email addresses never appear in server logs.
        </p>
      </div>
    </section>
  );
}

export function UploadSummary({ file }) {
  if (!file) return null;
  return <span className="muted">{file.name} · {formatBytes(file.size)}</span>;
}
