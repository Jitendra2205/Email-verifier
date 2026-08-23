// Word (.docx) and PDF support — unstructured documents.
//
// These have no columns. A newsletter PDF, a conference attendee list exported
// to Word, a signed agreement — the addresses are scattered through prose. So
// instead of mapping columns, the text is extracted and scanned for anything
// address-shaped, and the marketer picks a single qualification that applies to
// every address found in that document.
//
// Extraction is text-only on purpose. Scanned/image PDFs yield nothing, and no
// OCR is attempted: silently returning zero addresses from a 40-page scan is
// better than a slow, wrong guess, and the UI says explicitly when a document
// produced no addresses.
import path from 'node:path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { normalizeQualification } from '../csv.js';
import { config } from '../config.js';

// Where pdf.js should find its bundled fonts. Two Windows-specific traps here:
// the value must end in a forward slash (pdf.js validates for '/', so a path
// ending in a backslash is rejected outright), and it must be a plain path
// rather than a file:// URL (the Node font loader reads it from disk directly).
// Resolving the package keeps this correct wherever node_modules ends up.
const require = createRequire(import.meta.url);
const STANDARD_FONT_DIR = path
  .join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')
  .replace(/\\/g, '/') + '/';

/**
 * Addresses as they appear in running text.
 *
 * Deliberately stricter than the RFC 5322 validator in `verify/syntax.js`: this
 * is a *finder*, not a validator. Being permissive here means pulling in
 * surrounding punctuation and prose, so it only matches the conservative shape
 * and lets the verification pipeline make the real judgement afterwards.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/g;

/** Trailing punctuation that reads as part of the sentence, not the address. */
function trimTrailingPunctuation(candidate) {
  return candidate.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * Pull every address-shaped string out of a blob of text, in order of
 * appearance, de-duplicated case-insensitively but keeping the first spelling.
 */
export function extractEmailsFromText(text) {
  const found = [];
  const seen = new Set();
  let duplicates = 0;

  for (const raw of String(text || '').matchAll(EMAIL_IN_TEXT)) {
    const candidate = trimTrailingPunctuation(raw[0]);
    if (!candidate.includes('@')) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    found.push(candidate);
    if (found.length >= config.maxRows) break;
  }
  return { emails: found, duplicates };
}

async function extractDocxText(buffer) {
  // extractRawText ignores styling and returns the document's plain text,
  // which is all we need — we are looking for addresses, not formatting.
  const { value } = await mammoth.extractRawText({ buffer });
  return value || '';
}

async function extractPdfText(buffer) {
  // pdfjs-dist is imported lazily: it is the heaviest dependency here and most
  // uploads are not PDFs, so it should not cost anything on server boot.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // A malicious PDF must not be able to reach the network or execute anything.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // Point at the fonts bundled in the package rather than pdf.js's default
    // CDN URL: no outbound request, which the CSP posture requires anyway.
    standardFontDataUrl: STANDARD_FONT_DIR,
  });
  const doc = await task.promise;
  try {
    const parts = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // Join with spaces, not '': pdf.js emits positioned runs, and
      // concatenating them directly can fuse a name onto the next address.
      parts.push(content.items.map((item) => item.str ?? '').join(' '));
      page.cleanup();
    }
    return parts.join('\n');
  } finally {
    // destroy() is on the loading task; the document proxy only has cleanup().
    await task.destroy();
  }
}

/** @returns {Promise<string>} the document's plain text */
export async function extractDocumentText(buffer, format) {
  if (format === 'docx') return extractDocxText(buffer);
  if (format === 'pdf') return extractPdfText(buffer);
  throw new Error(`Unsupported document format: ${format}`);
}

/**
 * Extract addresses from a document and shape them like verification rows, so
 * the rest of the pipeline cannot tell where they came from.
 *
 * @param {Buffer} buffer
 * @param {'docx'|'pdf'} format
 * @param {string} qualification the segment chosen for this whole document
 */
export async function extractDocumentRows(buffer, format, qualification) {
  const text = await extractDocumentText(buffer, format);
  const { emails, duplicates } = extractEmailsFromText(text);
  const segment = normalizeQualification(qualification);

  return {
    rows: emails.map((email, i) => ({
      rowNumber: i + 1,
      email,
      name: '',
      qualificationRaw: qualification || '',
      qualification: segment,
      // Repeat occurrences are dropped during extraction rather than flagged:
      // in prose the same address appearing twice is one contact mentioned
      // twice, not two list entries, so there is no row to mark.
      duplicate: false,
    })),
    duplicates,
  };
}

/** Preview shown on the confirm screen, in the same shape the mapping UI uses. */
export async function inspectDocument(buffer, format, previewCount = 5) {
  const text = await extractDocumentText(buffer, format);
  const { emails, duplicates } = extractEmailsFromText(text);
  return {
    emails,
    duplicates,
    preview: emails.slice(0, previewCount),
    totalFound: emails.length,
    hasText: text.trim().length > 0,
  };
}
