export const STATUS_META = {
  valid: {
    label: 'Valid',
    tone: 'good',
    blurb: 'Syntax is correct, the domain accepts mail, and nothing flagged it. Safe to send.',
  },
  risky: {
    label: 'Risky',
    tone: 'warn',
    blurb: 'A real category, not an error. The address is well-formed and the domain works, but the mailbox itself cannot be confirmed — catch-all domains, shared role inboxes, and DNS timeouts land here. Send in a smaller warm-up batch, or hold.',
  },
  invalid: {
    label: 'Invalid',
    tone: 'bad',
    blurb: 'Failed syntax or the domain cannot receive mail at all. Suppress these.',
  },
  disposable: {
    label: 'Disposable',
    tone: 'muted',
    blurb: 'A temporary / throwaway mailbox provider. Deliverable today, gone tomorrow — not worth the reputation risk.',
  },
};

export const STATUS_ORDER = ['valid', 'risky', 'invalid', 'disposable'];

export function formatNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n || 0));
}

export function formatPercent(part, total) {
  if (!total) return '0%';
  const pct = (part / total) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function relativeExpiry(ts) {
  if (!ts) return '—';
  const days = Math.ceil((ts - Date.now()) / 86_400_000);
  if (days <= 0) return 'expiring now';
  return `auto-deletes in ${days} day${days === 1 ? '' : 's'}`;
}

/** "expires in 41h", for the shared-demo countdown in the header. */
export function formatExpiry(at) {
  if (!at) return null;
  const ms = at - Date.now();
  if (ms <= 0) return 'link expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `link expires in ${hours}h`;
  return `link expires in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

export const JOB_STATUS_LABEL = {
  awaiting_mapping: 'Needs column mapping',
  ingesting: 'Reading file',
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  done: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
