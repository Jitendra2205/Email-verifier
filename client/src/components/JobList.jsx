import React from 'react';
import { JOB_STATUS_LABEL, formatDateTime, formatNumber } from '../format.js';

export default function JobList({ jobs, activeId, onOpen, onNew }) {
  return (
    <aside className="sidebar">
      <button className="primary block" onClick={onNew}>+ New verification</button>

      <h3 className="sidebar-title">Recent jobs</h3>
      {jobs.length === 0 && <p className="muted small">Nothing yet. Upload a list to start.</p>}

      <ul className="job-list">
        {jobs.map((job) => {
          const pct = job.counts?.total
            ? Math.round(((job.counts.processed || 0) / job.counts.total) * 100)
            : 0;
          return (
            <li key={job.id}>
              <button
                className={`job-item${job.id === activeId ? ' active' : ''}`}
                onClick={() => onOpen(job.id)}
              >
                <span className="job-name" title={job.filename}>{job.filename}</span>
                <span className="job-meta">
                  <span className={`chip small ${job.status}`}>
                    {JOB_STATUS_LABEL[job.status] || job.status}
                  </span>
                  {job.counts?.total > 0 && (
                    <span className="muted small">
                      {job.status === 'done' ? formatNumber(job.counts.total) + ' rows' : pct + '%'}
                    </span>
                  )}
                </span>
                <span className="muted small">{formatDateTime(job.createdAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
