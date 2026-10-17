import { parseCsv } from './csv';

export type CellValue = string | number | boolean | Date | null | undefined;

/** Convert one spreadsheet cell to text. Excel dates arrive as UTC-midnight Date objects. */
export function cellToText(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

export function isExcelFile(name: string): boolean {
  return /\.xlsx$/i.test(name);
}

export class SpreadsheetReadError extends Error {}

/**
 * Read a CSV or .xlsx file into rows of text. The Excel reader is loaded
 * only when an Excel file is picked, so it doesn't slow the app down.
 */
export async function readSpreadsheetFile(file: File): Promise<{ rows: string[][]; text: string | null }> {
  if (isExcelFile(file.name)) {
    try {
      const { readSheet } = await import('read-excel-file/browser');
      // Keep numbers as their exact text so money is never squeezed through floating point.
      const data = await readSheet(file, { parseNumber: (s: string) => s });
      return { rows: (data as CellValue[][]).map((r) => r.map(cellToText)), text: null };
    } catch {
      throw new SpreadsheetReadError('This Excel file couldn’t be read. Try saving it as .xlsx again, or export it as CSV.');
    }
  }
  if (/\.xls$/i.test(file.name)) {
    throw new SpreadsheetReadError('Older .xls files aren’t supported. Save it as .xlsx or CSV and try again.');
  }
  const text = await file.text();
  return { rows: parseCsv(text), text };
}
