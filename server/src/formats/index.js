// Format detection for uploads.
//
// CSV/TSV/plain-text stay on the existing column-mapped pipeline unchanged —
// including .txt, deliberately: a .txt file could be a delimited export or
// free prose, and there is no reliable way to tell those apart from the
// extension alone. Treating .txt as tabular (as it always has been here) avoids
// a fragile auto-detection heuristic and does not regress anything.
//
// Excel workbooks are tabular too (same email + qualification column mapping,
// just read from a sheet instead of parsed CSV text). Word and PDF documents
// have no column structure at all — they are scanned for anything that looks
// like an email address, and the marketer picks one qualification that applies
// to every address found in that document.
const TABULAR = new Set(['csv', 'tsv', 'txt', 'xlsx']);
const DOCUMENT = new Set(['docx', 'pdf']);

// Legacy binary .xls (pre-2007 BIFF format) is deliberately not supported. The
// only maintained npm library that reads it is `xlsx` (SheetJS), which carries
// an unpatched high-severity prototype-pollution/ReDoS CVE on the public
// registry — not something to point at untrusted uploads. `.xlsx` covers the
// overwhelming majority of "Excel file" cases in practice.
const EXT_TO_FORMAT = {
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.txt': 'txt',
  '.xlsx': 'xlsx',
  '.docx': 'docx',
  '.pdf': 'pdf',
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXT_TO_FORMAT);

export function detectFormat(filename) {
  const match = /\.[^.]+$/.exec(String(filename || '').toLowerCase());
  return match ? EXT_TO_FORMAT[match[0]] || null : null;
}

export function isTabularFormat(format) {
  return TABULAR.has(format);
}

export function isDocumentFormat(format) {
  return DOCUMENT.has(format);
}

/** Formats that must be fully buffered in memory to parse (not streamed line by line). */
export function isBufferedFormat(format) {
  return format === 'xlsx' || format === 'docx' || format === 'pdf';
}

export const FORMAT_LABELS = {
  csv: 'CSV', tsv: 'TSV', txt: 'Text', xlsx: 'Excel',
  docx: 'Word document', pdf: 'PDF document',
};
