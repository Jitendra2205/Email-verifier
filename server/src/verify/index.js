// The verification pipeline: runs the layers cheapest-and-safest first and
// collapses their signals into one of four statuses plus a confidence score.
//
// The four-status model is the core product decision. A binary valid/invalid
// flag would either throw away deliverable contacts or quietly include ones
// that will bounce; "Risky" names the real category — addresses we genuinely
// cannot confirm at mailbox level — instead of pretending it doesn't exist.
import { checkSyntax, normalizeEmail } from './syntax.js';
import { resolveDomain, dnsStats } from './mx.js';
import { detectCatchAll, probeRecipients, smtpEnabled, smtpStats } from './smtp.js';
import { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS, FREE_MAIL_DOMAINS } from './lists.js';

export const STATUSES = ['valid', 'risky', 'invalid', 'disposable'];

export const REASON_LABELS = {
  syntax_empty: 'No address in this row',
  syntax_at_count: 'Address must contain exactly one @',
  syntax_too_long: 'Address is longer than 254 characters',
  syntax_local_too_long: 'Local part is longer than 64 characters',
  syntax_domain_too_long: 'Domain is longer than 253 characters',
  syntax_consecutive_dots: 'Address contains consecutive dots',
  syntax_no_tld: 'Domain has no top-level domain',
  syntax_non_ascii: 'Address contains non-ASCII characters',
  syntax_malformed: 'Missing local part or domain',
  syntax_regex: 'Not a valid RFC 5322 address',
  domain_no_mail: 'Domain cannot receive mail (no MX and no A record)',
  domain_unresolved: 'DNS lookup did not complete — domain status unknown',
  implicit_mx: 'No MX record; mail would fall back to the domain A record',
  disposable: 'Disposable / temporary mailbox provider',
  role_account: 'Shared role inbox, not an individual',
  free_mail: 'Consumer mailbox provider, not a corporate domain',
  catch_all: 'Domain accepts all recipients — the mailbox itself cannot be confirmed',
  mailbox_confirmed: 'Mail server accepted this specific recipient',
  mailbox_rejected: 'Mail server rejected this recipient',
  smtp_inconclusive: 'SMTP probe did not give a usable answer',
  smtp_not_run: 'Mailbox-level SMTP check not performed',
  duplicate: 'Duplicate of an earlier row in this file',
};

export function describeReason(code) {
  return REASON_LABELS[code] || code;
}

/**
 * Stable bit positions for the reason codes.
 *
 * A row's reasons are stored as a single integer bitmask rather than a row per
 * reason: with ~22 possible codes and 250K rows, the normalised table and its
 * indexes cost more than the rest of the database put together.
 *
 * APPEND ONLY. A code's index is its bit position and is persisted in every
 * row — reordering or removing an entry silently rewrites the meaning of
 * existing data. Retire a code by leaving its slot in place.
 */
export const REASON_CODES = [
  'syntax_empty',
  'syntax_at_count',
  'syntax_too_long',
  'syntax_local_too_long',
  'syntax_domain_too_long',
  'syntax_consecutive_dots',
  'syntax_no_tld',
  'syntax_non_ascii',
  'syntax_malformed',
  'syntax_regex',
  'domain_no_mail',
  'domain_unresolved',
  'implicit_mx',
  'disposable',
  'role_account',
  'free_mail',
  'catch_all',
  'mailbox_confirmed',
  'mailbox_rejected',
  'smtp_inconclusive',
  'smtp_not_run',
  'duplicate',
];

const REASON_BIT = new Map(REASON_CODES.map((code, i) => [code, 2 ** i]));

export function reasonsToMask(reasons = []) {
  let mask = 0;
  for (const reason of reasons) {
    const bit = REASON_BIT.get(reason);
    // An unknown code means someone added a reason without registering it
    // above. Dropping it loses a signal, so make the mistake loud.
    if (bit === undefined) throw new Error(`Unregistered reason code: ${reason}`);
    mask += bit;
  }
  return mask;
}

export function maskToReasons(mask = 0) {
  const out = [];
  for (let i = 0; i < REASON_CODES.length; i++) {
    if (mask & (2 ** i)) out.push(REASON_CODES[i]);
  }
  return out;
}

export function reasonBit(code) {
  return REASON_BIT.get(code) ?? 0;
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

/**
 * Verify one address.
 *
 * @param {{email: string, qualification?: string, duplicate?: boolean}} row
 * @returns {Promise<{email:string,domain:string,status:string,score:number,reasons:string[],suggestion?:string,duplicate:boolean}>}
 */
export async function verifyOne(row, { signal } = {}) {
  const raw = row.email;
  const { email, local, domain } = normalizeEmail(raw);

  // Flagged up front so it survives every early return below — a duplicate that
  // is also invalid must still be findable by the "duplicate" filter.
  const reasons = row.duplicate ? ['duplicate'] : [];

  const base = {
    email: email || String(raw ?? '').trim(),
    domain,
    qualification: row.qualification || '',
    duplicate: Boolean(row.duplicate),
    rowNumber: row.rowNumber,
  };

  // ---- Layer 1: syntax -----------------------------------------------------
  const syntax = checkSyntax(raw);
  if (!syntax.ok) {
    return { ...base, status: 'invalid', score: 0, reasons: [...reasons, `syntax_${syntax.code}`] };
  }
  const suggestion = syntax.suggestion;

  // ---- Layer 3: disposable (list lookup, cheaper than DNS) -----------------
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ...base, status: 'disposable', score: 5, reasons: [...reasons, 'disposable'], suggestion };
  }

  // ---- Layer 2: domain validity -------------------------------------------
  const mx = await resolveDomain(domain, { signal });
  if (mx.status === 'none') {
    return { ...base, status: 'invalid', score: 0, reasons: [...reasons, 'domain_no_mail'], suggestion };
  }
  if (mx.status === 'unknown') {
    return { ...base, status: 'risky', score: 40, reasons: [...reasons, 'domain_unresolved'], suggestion };
  }

  let score = 90;
  if (mx.status === 'implicit') { score -= 15; reasons.push('implicit_mx'); }

  // ---- Layer 4: role account (flag, never reject) --------------------------
  const isRole = ROLE_LOCAL_PARTS.has(local.toLowerCase());
  if (isRole) reasons.push('role_account');

  if (FREE_MAIL_DOMAINS.has(domain)) { score -= 8; reasons.push('free_mail'); }


  // ---- Layers 5 & 6: catch-all + RCPT probe (opt-in) -----------------------
  let catchAll = 'unknown';
  let mailbox = null;
  if (smtpEnabled()) {
    catchAll = await detectCatchAll(domain, mx.hosts, { signal });
    if (catchAll === 'no') {
      const { verdict } = await probeRecipients(domain, mx.hosts, [email], { signal });
      mailbox = verdict.get(email)?.verdict ?? null;
    }
  } else {
    reasons.push('smtp_not_run');
  }

  let status = 'valid';

  if (catchAll === 'yes') {
    reasons.push('catch_all');
    score = Math.min(score, 55);
    status = 'risky';
  } else if (mailbox === 'accepted') {
    reasons.push('mailbox_confirmed');
    score = Math.min(100, score + 8);
  } else if (mailbox === 'rejected') {
    // Deliberately Risky, not Invalid: a single RCPT rejection is not a
    // trustworthy enough signal to delete a contact from the database.
    reasons.push('mailbox_rejected');
    score = Math.min(score, 20);
    status = 'risky';
  } else if (mailbox === 'deferred') {
    reasons.push('smtp_inconclusive');
    score -= 5;
  }

  // Role accounts are valid mail but low-value for a personalised campaign, so
  // they are surfaced as Risky for the marketer to decide on — not dropped.
  if (isRole && status === 'valid') {
    status = 'risky';
    score = Math.min(score, 60);
  }

  return { ...base, status, score: clamp(score), reasons, suggestion };
}

export function pipelineStats() {
  return { dns: dnsStats(), smtp: smtpStats(), smtpEnabled: smtpEnabled() };
}
