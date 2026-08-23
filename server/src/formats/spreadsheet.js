// Excel (.xlsx) support, via `exceljs`.
//
// Deliberately not the `xlsx` (SheetJS) package: its npm release carries an
// unpatched high-severity prototype-pollution/ReDoS CVE — SheetJS only ships
// the fix through their own CDN, outside the npm audit trail. Not something to
// point at files uploaded by anyone with access to this tool. `exceljs` is
// actively maintained on npm and audits clean.
//
// Only the first worksheet is read. A multi-tab workbook where the contact
// list isn't on the first sheet is a real but rare case — flagged in the
// README rather than solved here.
import ExcelJS from 'exceljs';
import { mapRowsToBatches } from '../csv.js';

function cellText(cell) {
  if (cell == null) return '';
  // A formula cell exposes its computed value under `.result`; a hyperlink
  // cell exposes the visible label under `.text`. Anything else is a plain
  // scalar (string, number, Date, boolean) and stringifies directly.
  if (typeof cell === 'object') {
    if ('result' in cell) return String(cell.result ?? '');
    if ('text' in cell) return String(cell.text ?? '');
    if (cell instanceof Date) return cell.toISOString();
    return '';
  }
  return String(cell);
}

/** First worksheet's rows as arrays of trimmed cell text, header row included at index 0. */
async function readSheetRows(workbook) {
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // `row.values` is 1-indexed with a hole at index 0 — drop it so column 0
    // in our arrays lines up with column A.
    rows.push(row.values.slice(1).map((v) => cellText(v).trim()));
  });
  return rows;
}

/** Headers plus a preview, in the same shape `inspectCsv` returns. */
export async function inspectSpreadsheet(filePath, previewRows = 5) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const rows = await readSheetRows(workbook);

  const headerRow = rows[0] || [];
  const headers = headerRow.map((h) => String(h).trim()).filter((h) => h !== '');
  if (!headers.length) return { headers: [], preview: [] };

  const preview = rows.slice(1, previewRows + 1).map((cells) => (
    Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))
  ));

  return { headers, preview };
}

/**
 * Read every row of a workbook buffer and hand mapped batches to `onBatch`.
 * The whole workbook is parsed into memory up front — `exceljs` has no
 * row-streaming reader for a Buffer source, which is why spreadsheet uploads
 * are capped tighter than CSV (see `MAX_DOCUMENT_MB`).
 */
export async function streamSpreadsheetRows(buffer, mapping, onBatch, options) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const rows = await readSheetRows(workbook);

  const headerRow = rows[0] || [];
  const headers = headerRow.map((h) => String(h).trim());
  const records = rows.slice(1).map((cells) => (
    Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))
  ));

  return mapRowsToBatches(records, mapping, onBatch, options);
}
