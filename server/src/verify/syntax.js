// Layer 1 — syntax validation. No network, runs on every row first so that
// malformed addresses never reach the DNS or SMTP layers.
import { DOMAIN_TYPOS } from './lists.js';

// A pragmatic reading of RFC 5322's addr-spec: the dot-atom local part plus
// quoted strings, and a domain of LDH labels. Deliberately does NOT accept the
// full grammar (comments, folding whitespace, IP-literal domains) — those are
// legal but are never real marketing contacts, and accepting them costs more in
// false "valid" than it saves.
const DOT_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const DOMAIN = `${LABEL}(?:\\.${LABEL})*\\.[A-Za-z]{2,63}`;
const ADDR_SPEC = new RegExp(`^(?:${DOT_ATOM}|${QUOTED})@(?:${DOMAIN})$`);

/**
 * Normalise an address for verification and de-duplication.
 * The domain is lowercased (DNS is case-insensitive); the local part's case is
 * preserved in the output because it is technically significant, but a
 * lowercased form is used as the dedupe key.
 */
export function normalizeEmail(raw) {
  // Only surrounding whitespace and display-name wrappers are stripped.
  // Internal whitespace is left in place on purpose: collapsing it would turn
  // "jane doe@firm.com" into a different, valid-looking address rather than
  // reporting the row as malformed.
  const trimmed = String(raw ?? '').replace(/^[\s<'"]+|[\s>'"]+$/g, '');
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return { email: trimmed, local: '', domain: '' };
  return {
    email: trimmed.slice(0, at) + '@' + trimmed.slice(at + 1).toLowerCase(),
    local: trimmed.slice(0, at),
    domain: trimmed.slice(at + 1).toLowerCase().replace(/\.$/, ''),
  };
}

/**
 * @returns {{ok: boolean, code?: string, detail?: string, suggestion?: string}}
 */
export function checkSyntax(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, code: 'empty', detail: 'No address in this row' };
  if (value.length > 254) return { ok: false, code: 'too_long', detail: 'Address exceeds 254 characters' };
  if ((value.match(/@/g) || []).length !== 1) {
    return { ok: false, code: 'at_count', detail: 'Address must contain exactly one @' };
  }

  const { email, local, domain } = normalizeEmail(value);
  if (!local || !domain) return { ok: false, code: 'malformed', detail: 'Missing local part or domain' };
  if (local.length > 64) return { ok: false, code: 'local_too_long', detail: 'Local part exceeds 64 characters' };
  if (domain.length > 253) return { ok: false, code: 'domain_too_long', detail: 'Domain exceeds 253 characters' };
  if (domain.includes('..') || local.includes('..')) {
    return { ok: false, code: 'consecutive_dots', detail: 'Consecutive dots are not allowed' };
  }
  if (!domain.includes('.')) return { ok: false, code: 'no_tld', detail: 'Domain has no top-level domain' };
  if (/[^\x20-\x7E]/.test(value)) {
    return { ok: false, code: 'non_ascii', detail: 'Address contains non-ASCII characters' };
  }
  if (!ADDR_SPEC.test(email)) return { ok: false, code: 'regex', detail: 'Not a valid RFC 5322 address' };

  const suggestion = DOMAIN_TYPOS.get(domain);
  return suggestion
    ? { ok: true, suggestion: `${local}@${suggestion}` }
    : { ok: true };
}
