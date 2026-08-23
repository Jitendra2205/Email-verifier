import React, { useMemo, useState } from 'react';
import { formatBytes } from '../format.js';

export default function Mapping({ api, meta, upload, onStarted, onCancel }) {
  const { job, headers, preview, suggestedMapping } = upload;
  const [mapping, setMapping] = useState(() => ({ ...suggestedMapping }));
  const [smtpProbe, setSmtpProbe] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const fields = meta?.expectedFields ?? [];
  const missing = useMemo(
    () => fields.filter((f) => f.required && !mapping[f.key]),
    [fields, mapping],
  );

  const previewColumns = useMemo(() => {
    const chosen = ['email', 'qualification', 'name']
      .map((key) => mapping[key])
      .filter(Boolean);
    return chosen.length ? chosen : headers.slice(0, 4);
  }, [mapping, headers]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setMapping(job.id, mapping, smtpProbe);
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
          <h2>Map your columns</h2>
          <p className="muted">
            {job.filename} · {formatBytes(job.sizeBytes)} · {headers.length} columns detected
          </p>
        </div>
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </header>

      {missing.length > 0 && (
        <div className="alert warn">
          Couldn&apos;t match {missing.map((f) => f.label).join(' and ')} automatically.
          Pick the right column below.
        </div>
      )}

      <div className="mapping-grid">
        {fields.map((field) => (
          <label key={field.key} className="mapping-row">
            <span className="mapping-label">
              {field.label}
              {field.required && <em className="req"> required</em>}
            </span>
            <select
              value={mapping[field.key] || ''}
              onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value })}
            >
              <option value="">— not mapped —</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
        ))}
      </div>

      <h3 className="section-title">Preview</h3>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>{previewColumns.map((c) => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {preview.map((row, i) => (
              <tr key={i}>
                {previewColumns.map((c) => <td key={c}>{String(row[c] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="notice compact">
        <p className="muted small">
          Qualification values are normalised into CPA / EA / HR Professional / Other
          for the segment breakdown. Anything unrecognised falls into Other — the
          original value is kept in the full export.
        </p>
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
        <button className="primary" onClick={confirm} disabled={busy || missing.length > 0}>
          {busy ? 'Reading file…' : 'Confirm & start verification'}
        </button>
      </div>
    </section>
  );
}
