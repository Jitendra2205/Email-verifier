import React, { useState } from 'react';
import { formatBytes, formatNumber } from '../format.js';

/**
 * Confirm step for Word/PDF uploads.
 *
 * A document has no columns to map, so this replaces the mapping screen: it
 * shows what was extracted and asks for the one qualification that applies to
 * every address in the file.
 */
export default function DocumentConfirm({ api, meta, upload, onStarted, onCancel }) {
  const { job, formatLabel, documentExtraction } = upload;
  const { totalFound, repeatsDropped, preview } = documentExtraction;

  const qualifications = meta?.qualifications ?? ['CPA', 'EA', 'HR Professional', 'Other'];
  const [qualification, setQualification] = useState('');
  const [smtpProbe, setSmtpProbe] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setDocumentQualification(job.id, qualification, smtpProbe);
      onStarted(result.job);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Confirm extracted addresses</h2>
          <p className="muted">
            {job.filename} · {formatBytes(job.sizeBytes)} · {formatLabel}
          </p>
        </div>
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </header>

      <div className="stat-row">
        <div className="stat good">
          <span className="stat-value">{formatNumber(totalFound)}</span>
          <span className="stat-label">Addresses found</span>
        </div>
        {repeatsDropped > 0 && (
          <div className="stat muted">
            <span className="stat-value">{formatNumber(repeatsDropped)}</span>
            <span className="stat-label">Repeat mentions merged</span>
          </div>
        )}
      </div>

      <h3 className="section-title">First few</h3>
      <div className="table-scroll">
        <table className="data">
          <thead><tr><th>Email</th></tr></thead>
          <tbody>
            {preview.map((email) => (
              <tr key={email}><td className="mono">{email}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="notice compact">
        <p className="muted small">
          Addresses were scanned out of the document&apos;s text, so there are no
          columns to map. The same address appearing more than once is treated as
          one contact, not a duplicate row.
        </p>
      </div>

      <h3 className="section-title">Qualification for this document</h3>
      <div className="mapping-grid">
        <label className="mapping-row">
          <span className="mapping-label">
            Applies to all {formatNumber(totalFound)} addresses
            <em className="req"> required</em>
          </span>
          <select value={qualification} onChange={(e) => setQualification(e.target.value)}>
            <option value="">— choose a segment —</option>
            {qualifications.map((q) => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
      </div>

      {meta?.smtpProbeAvailable && (
        <label className="checkbox-row">
          <input type="checkbox" checked={smtpProbe} onChange={(e) => setSmtpProbe(e.target.checked)} />
          <span>
            <strong>Also run throttled SMTP mailbox probes</strong>
            <span className="muted small block">
              Adds catch-all detection and a per-mailbox RCPT check, rate-limited to{' '}
              {meta?.perDomainLookupsPerMinute ?? 20} lookups per domain per minute. This
              opens real connections to recipient mail servers and carries a genuine
              sender-reputation risk at full volume. A probe result never marks an
              address Invalid on its own.
            </span>
          </span>
        </label>
      )}

      {error && <div className="alert bad" role="alert">{error}</div>}

      <div className="actions">
        <button className="primary" onClick={confirm} disabled={busy || !qualification}>
          {busy ? 'Starting…' : `Verify ${formatNumber(totalFound)} addresses`}
        </button>
      </div>
    </section>
  );
}
