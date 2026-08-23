async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  session: () => request('/api/session'),
  login: (user, password) => request('/api/login', { method: 'POST', body: JSON.stringify({ user, password }) }),
  logout: () => request('/api/logout', { method: 'POST' }),

  meta: () => request('/api/meta'),
  jobs: () => request('/api/jobs'),
  job: (id) => request(`/api/jobs/${id}`),

  upload: (file, onProgress) => new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/jobs');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — connection lost'));
    xhr.send(form);
  }),

  setMapping: (id, mapping, smtpProbe) =>
    request(`/api/jobs/${id}/mapping`, { method: 'POST', body: JSON.stringify({ mapping, smtpProbe }) }),

  // Word/PDF uploads have no columns; the same endpoint takes one qualification
  // that applies to every address extracted from the document.
  setDocumentQualification: (id, qualification, smtpProbe) =>
    request(`/api/jobs/${id}/mapping`, { method: 'POST', body: JSON.stringify({ qualification, smtpProbe }) }),

  start: (id) => request(`/api/jobs/${id}/start`, { method: 'POST' }),
  pause: (id) => request(`/api/jobs/${id}/pause`, { method: 'POST' }),
  cancel: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  remove: (id) => request(`/api/jobs/${id}`, { method: 'DELETE' }),

  results: (id, params) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== 'all'),
    );
    return request(`/api/jobs/${id}/results?${qs}`);
  },

  exportUrl: (id, type) => `/api/jobs/${id}/export?type=${type}`,

  /**
   * Live progress: server-sent events where they work, polling where they don't.
   *
   * The fallback is driven by a silence watchdog, not just `onerror`. A
   * buffering reverse proxy — Cloudflare tunnels and default nginx both do this
   * — accepts the connection, returns 200, and then holds every frame. There is
   * no error to react to, just silence, which left the progress bar frozen at
   * "Reading file 0 of 0" while the job ran to completion behind it.
   *
   * The server emits a frame immediately on connect, so a healthy stream always
   * speaks well inside the window; staying quiet past it means the transport is
   * not usable and polling takes over.
   */
  subscribeProgress(id, onUpdate) {
    const POLL_MS = 1500;
    const SSE_SILENCE_MS = 4000;

    let stopped = false;
    let source = null;
    let poll = null;
    let watchdog = null;

    const tick = () => request(`/api/jobs/${id}/progress`).then(onUpdate).catch(() => {});

    const startPolling = () => {
      if (stopped || poll) return;
      // The stream is not delivering, so stop holding it open.
      if (source) { source.close(); source = null; }
      clearTimeout(watchdog);
      poll = setInterval(tick, POLL_MS);
      tick();
    };

    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(startPolling, SSE_SILENCE_MS);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      source = new EventSource(`/api/jobs/${id}/events`);
      source.onmessage = (event) => {
        armWatchdog();
        try { onUpdate(JSON.parse(event.data)); } catch { /* keepalive comment */ }
      };
      source.onerror = startPolling;
      armWatchdog();
    }

    return () => {
      stopped = true;
      clearTimeout(watchdog);
      if (poll) clearInterval(poll);
      if (source) source.close();
    };
  },
};
