import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { formatExpiry } from './format.js';
import Login from './components/Login.jsx';
import Upload from './components/Upload.jsx';
import Mapping from './components/Mapping.jsx';
import DocumentConfirm from './components/DocumentConfirm.jsx';
import Progress from './components/Progress.jsx';
import Results from './components/Results.jsx';
import JobList from './components/JobList.jsx';

const TERMINAL = ['done', 'failed', 'cancelled'];

export default function App() {
  const [session, setSession] = useState({ loading: true, authenticated: false, user: null });
  const [meta, setMeta] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [view, setView] = useState({ name: 'upload' }); // upload | mapping | job
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  // ---- session -------------------------------------------------------------
  useEffect(() => {
    api.session()
      .then((s) => setSession({ loading: false, ...s }))
      .catch(() => setSession({ loading: false, authenticated: false, user: null }));
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const { jobs: list } = await api.jobs();
      setJobs(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (!session.authenticated) return;
    api.meta().then(setMeta).catch(() => {});
    refreshJobs().then((list) => {
      // Deep-link support: #/job/<id> so a running job survives a page reload.
      const match = window.location.hash.match(/^#\/job\/([a-f0-9]{18})$/);
      const target = match && list.find((j) => j.id === match[1]);
      if (target) openJob(target.id);
    });
  }, [session.authenticated, refreshJobs]);

  // ---- live progress -------------------------------------------------------
  useEffect(() => {
    if (!job || view.name !== 'job') return undefined;

    // A finished job emits nothing further, so seed from its snapshot rather
    // than opening a stream. `job.progress` is a snapshot taken when the job
    // object was fetched, so it must never overwrite a *live* value we already
    // hold for this same job — doing so is what used to leave a completed run
    // frozen on "Reading file 0 of 0".
    if (TERMINAL.includes(job.status)) {
      setProgress((current) => (current && current.id === job.id ? current : job.progress));
      return undefined;
    }

    let unsubscribe = null;
    let closed = false;
    const close = () => { if (!closed) { closed = true; unsubscribe?.(); } };

    unsubscribe = api.subscribeProgress(job.id, (update) => {
      setProgress(update);
      setJob((current) => (current && current.id === update.id
        ? { ...current, status: update.status, counts: update.counts, error: update.error }
        : current));
      if (TERMINAL.includes(update.status)) {
        // Replace both halves from the server so the final numbers and the
        // final status come from the same read.
        api.job(update.id)
          .then(({ job: fresh }) => { setJob(fresh); setProgress(fresh.progress); })
          .catch(() => {});
        refreshJobs();
        close();
      }
    });
    if (closed) unsubscribe();
    return close;
    // `job.status` is deliberately not a dependency: the stream already carries
    // every status change, and re-subscribing on each one tore the connection
    // down mid-transition and dropped the events that followed.
  }, [job?.id, view.name, refreshJobs]);

  // Keep the sidebar counts moving while a job runs.
  useEffect(() => {
    if (!session.authenticated) return undefined;
    const timer = setInterval(refreshJobs, 10_000);
    return () => clearInterval(timer);
  }, [session.authenticated, refreshJobs]);

  // ---- actions -------------------------------------------------------------
  async function openJob(id) {
    setBanner(null);
    try {
      const { job: fresh } = await api.job(id);
      setJob(fresh);
      setProgress(fresh.progress);
      setView(fresh.status === 'awaiting_mapping' ? { name: 'upload' } : { name: 'job' });
      window.location.hash = `#/job/${id}`;
    } catch (err) {
      setBanner({ tone: 'bad', text: err.message });
    }
  }

  function goToUpload() {
    setJob(null);
    setProgress(null);
    setBanner(null);
    setView({ name: 'upload' });
    window.location.hash = '';
  }

  async function withBusy(fn, successText) {
    setBusy(true);
    setBanner(null);
    try {
      await fn();
      if (successText) setBanner({ tone: 'ok', text: successText });
    } catch (err) {
      setBanner({ tone: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!job) return;
    const ok = window.confirm(
      `Permanently delete "${job.filename}" and all of its results? This cannot be undone.`,
    );
    if (!ok) return;
    await withBusy(async () => {
      await api.remove(job.id);
      await refreshJobs();
      goToUpload();
    });
  }

  if (session.loading) {
    return <div className="boot">Loading…</div>;
  }
  if (!session.authenticated) {
    return <Login api={api} onSuccess={(s) => setSession({ loading: false, ...s })} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <strong>Email Verifier</strong>
            <span className="muted small block brand-sub">mycpe ONE · marketing ops</span>
          </div>
        </div>
        <div className="topbar-right">
          {session.accessExpiresAt && (
            <span className="chip warn" title={new Date(session.accessExpiresAt).toLocaleString()}>
              {formatExpiry(session.accessExpiresAt)}
            </span>
          )}
          {meta && (
            <span className="muted small topbar-meta">
              Retention {meta.retentionDays}d · SMTP probing{' '}
              {meta.smtpProbeAvailable ? 'available' : 'disabled'}
            </span>
          )}
          <span className="muted small topbar-user">{session.user}</span>
          <button
            className="ghost"
            onClick={() => api.logout().then(() => setSession({ loading: false, authenticated: false, user: null }))}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="layout">
        <JobList jobs={jobs} activeId={job?.id} onOpen={openJob} onNew={goToUpload} />

        <main className="content">
          {banner && <div className={`alert ${banner.tone}`}>{banner.text}</div>}

          {view.name === 'upload' && (
            <Upload
              api={api}
              meta={meta}
              onUploaded={(payload) => {
                setView({ name: 'mapping', upload: payload });
                refreshJobs();
              }}
            />
          )}

          {view.name === 'mapping' && (
            // A Word/PDF upload has no columns, so it gets a confirm step
            // instead of the column-mapping grid.
            React.createElement(
              view.upload.documentExtraction ? DocumentConfirm : Mapping,
              {
                api,
                meta,
                upload: view.upload,
                onCancel: goToUpload,
                onStarted: (started) => {
                  setJob(started);
                  setProgress(started.progress);
                  setView({ name: 'job' });
                  window.location.hash = `#/job/${started.id}`;
                  refreshJobs();
                },
              },
            )
          )}

          {view.name === 'job' && job && (
            <>
              <Progress
                job={job}
                progress={progress}
                busy={busy}
                onPause={() => withBusy(() => api.pause(job.id))}
                onResume={() => withBusy(async () => {
                  await api.start(job.id);
                  const { job: fresh } = await api.job(job.id);
                  setJob(fresh);
                })}
                onCancel={() => withBusy(() => api.cancel(job.id))}
                onDelete={handleDelete}
              />
              <Results api={api} meta={meta} job={job} counts={progress?.counts || job.counts} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
