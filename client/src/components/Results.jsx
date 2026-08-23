import React, { useEffect, useMemo, useState } from 'react';
import { STATUS_META, STATUS_ORDER, formatNumber, formatPercent } from '../format.js';

const SEGMENTS = ['CPA', 'EA', 'HR Professional', 'Other'];

export default function Results({ api, meta, job, counts }) {
  const [filters, setFilters] = useState({ status: 'all', segment: 'all', search: '', reason: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const processed = counts?.processed || 0;

  // Debounce the search box; everything else fires immediately.
  useEffect(() => {
    let cancelled = false;
    const delay = filters.search ? 250 : 0;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api.results(job.id, { ...filters, page, pageSize: 50 });
        if (!cancelled) { setData(result); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, job.id, filters, page, processed]);

  useEffect(() => { setPage(1); }, [filters]);

  const segmentRows = useMemo(() => {
    const bySegment = counts?.bySegment || {};
    const names = [...new Set([...SEGMENTS, ...Object.keys(bySegment)])];
    return names
      .map((name) => ({ name, ...(bySegment[name] || { total: 0, valid: 0, risky: 0, invalid: 0, disposable: 0 }) }))
      .filter((r) => r.total > 0);
  }, [counts]);

  const topReasons = useMemo(() => {
    const entries = Object.entries(counts?.byReason || {})
      .filter(([code]) => code !== 'smtp_not_run')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    return entries;
  }, [counts]);

  if (processed === 0) {
    return (
      <section className="panel">
        <div className="empty">
          <strong>No results yet.</strong>
          <span className="muted">Rows appear here as each chunk finishes — you don&apos;t have to wait for the whole run.</span>
        </div>
      </section>
    );
  }

  // The clean export is Valid AND non-duplicate, so it is smaller than the
  // Valid count whenever the source file repeats an address. Older jobs
  // predate this counter, hence the fallback.
  const cleanCount = counts.cleanValid ?? counts.valid ?? 0;

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2>Results</h2>
            <p className="muted">
              {formatNumber(processed)} rows verified
              {counts.duplicates > 0 && <> · {formatNumber(counts.duplicates)} duplicate rows flagged</>}
              {counts.blankRows > 0 && <> · {formatNumber(counts.blankRows)} blank rows skipped</>}
            </p>
          </div>
          <div className="head-actions">
            <a className="button ghost" href={api.exportUrl(job.id, 'full')} download>Export full results</a>
            <a className="button primary" href={api.exportUrl(job.id, 'clean')} download>
              Export clean send-list ({formatNumber(cleanCount)})
            </a>
          </div>
        </header>

        <div className="stat-row">
          {STATUS_ORDER.map((key) => {
            const value = counts[key] || 0;
            return (
              <button
                key={key}
                className={`stat ${STATUS_META[key].tone}${filters.status === key ? ' selected' : ''}`}
                onClick={() => setFilters((f) => ({ ...f, status: f.status === key ? 'all' : key }))}
                title={STATUS_META[key].blurb}
              >
                <span className="stat-value">{formatNumber(value)}</span>
                <span className="stat-label">{STATUS_META[key].label}</span>
                <span className="stat-pct">{formatPercent(value, processed)}</span>
              </button>
            );
          })}
        </div>

        <div className="legend">
          <p>
            <span className="dot warn" /> <strong>Risky is not an error state.</strong>{' '}
            {STATUS_META.risky.blurb}
          </p>
          {!meta?.smtpProbeAvailable && (
            <p className="muted small">
              Mailbox-level SMTP verification was not performed on this run, so no
              address here is claimed to be confirmed-deliverable — only
              confirmed-well-formed on a domain that accepts mail.
            </p>
          )}
        </div>
      </section>

      <section className="panel">
        <h3 className="section-title">By qualification segment</h3>
        <div className="table-scroll">
          <table className="data segments">
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Total</th>
                {STATUS_ORDER.map((s) => <th key={s} className="num">{STATUS_META[s].label}</th>)}
                <th className="num">Valid rate</th>
              </tr>
            </thead>
            <tbody>
              {segmentRows.map((row) => (
                <tr key={row.name}>
                  <td>
                    <button
                      className="linkish"
                      onClick={() => setFilters((f) => ({ ...f, segment: f.segment === row.name ? 'all' : row.name }))}
                    >
                      {row.name}
                    </button>
                  </td>
                  <td className="num">{formatNumber(row.total)}</td>
                  {STATUS_ORDER.map((s) => (
                    <td key={s} className="num">{formatNumber(row[s] || 0)}</td>
                  ))}
                  <td className="num strong">{formatPercent(row.valid || 0, row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {topReasons.length > 0 && (
          <>
            <h3 className="section-title">Why rows were flagged</h3>
            <div className="reason-chips">
              {topReasons.map(([code, count]) => (
                <button
                  key={code}
                  className={`reason-chip${filters.reason === code ? ' selected' : ''}`}
                  onClick={() => setFilters((f) => ({ ...f, reason: f.reason === code ? '' : code }))}
                >
                  {meta?.reasonLabels?.[code] || code}
                  <span className="count">{formatNumber(count)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h3 className="section-title flush">Address detail</h3>
          <div className="filters">
            <input
              type="search"
              placeholder="Search addresses…"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            />
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="all">All statuses</option>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
            <select value={filters.segment} onChange={(e) => setFilters((f) => ({ ...f, segment: e.target.value }))}>
              <option value="all">All segments</option>
              {segmentRows.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
            {(filters.reason || filters.status !== 'all' || filters.segment !== 'all' || filters.search) && (
              <button
                className="ghost"
                onClick={() => setFilters({ status: 'all', segment: 'all', search: '', reason: '' })}
              >
                Clear
              </button>
            )}
          </div>
        </header>

        {error && <div className="alert bad">{error}</div>}

        {data && data.matched === 0 && !loading ? (
          <div className="empty">
            <strong>No rows match these filters.</strong>
            <span className="muted">Clear a filter, or search for a different address.</span>
          </div>
        ) : (
          <>
            <div className={`table-scroll${loading ? ' loading' : ''}`}>
              <table className="data results">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Segment</th>
                    <th>Status</th>
                    <th className="num">Confidence</th>
                    <th>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.rows || []).map((row) => (
                    <tr
                      key={`${row.rowNumber}-${row.email}`}
                      className={expanded === row.rowNumber ? 'expanded' : ''}
                      onClick={() => setExpanded(expanded === row.rowNumber ? null : row.rowNumber)}
                    >
                      <td className="mono">
                        {row.email}
                        {row.duplicate && <span className="tag">dup</span>}
                      </td>
                      <td>{row.qualification}</td>
                      <td><span className={`pill ${STATUS_META[row.status].tone}`}>{STATUS_META[row.status].label}</span></td>
                      <td className="num">
                        <span className="score">
                          <span className="score-bar" style={{ width: `${row.score}%` }} />
                          <span className="score-num">{row.score}</span>
                        </span>
                      </td>
                      <td className="signals">
                        {(row.reasonLabels || []).length
                          ? (row.reasonLabels || []).join(' · ')
                          : <span className="muted">No flags</span>}
                        {row.suggestion && (
                          <div className="suggestion">Did you mean <span className="mono">{row.suggestion}</span>?</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <span className="muted">
                {data?.truncated ? 'first ' : ''}
                {formatNumber(data?.matched || 0)} matching {data?.matched === 1 ? 'row' : 'rows'}
                {data?.truncated && ' — add a status or segment filter to search the rest'}
                {loading && ' · loading…'}
              </span>
              <div className="pager-buttons">
                <button className="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <span className="muted">Page {page} of {formatNumber(data?.pages || 1)}</span>
                <button
                  className="ghost"
                  disabled={!data || page >= data.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
