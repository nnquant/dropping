import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

export type TablePreview = { columns: string[]; rows: unknown[][]; totalRows: number; shownRows: number };

/** Rows rendered in a preview; enough to inspect a file without stalling the table. */
export const TABLE_ROW_LIMIT = 1000;

/** RFC 4180 style parser: quoted fields, escaped quotes, CRLF and embedded newlines. */
export function parseDelimited(text: string, delimiter: string, partial: boolean): TablePreview {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const push = () => { record.push(field); field = ''; };
  const finish = () => { push(); records.push(record); record = []; };
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) push();
    else if (char === '\n' || char === '\r') {
      finish();
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else field += char;
  }
  // A truncated preview may end mid-record, so its last line is dropped.
  if (!partial && (field !== '' || record.length > 0)) finish();
  const [header = [], ...body] = records.filter(row => row.length > 1 || row[0] !== '');
  const width = Math.max(header.length, ...body.slice(0, TABLE_ROW_LIMIT).map(row => row.length));
  const columns = Array.from({ length: width }, (_, column) => header[column] ?? `列 ${column + 1}`);
  const rows = body.slice(0, TABLE_ROW_LIMIT);
  return { columns, rows, totalRows: body.length, shownRows: rows.length };
}

export type RangeReader = (offset: number, length: number) => Promise<ArrayBuffer>;

/** Reads the footer and only the leading rows of a Parquet file through byte-range requests. */
export async function readParquetPreview(read: RangeReader, byteLength: number): Promise<TablePreview> {
  const file = { byteLength, slice: (start: number, end = byteLength) => read(start, end - start) };
  const metadata = await parquetMetadataAsync(file);
  const columns = parquetSchema(metadata).children.map(child => child.element.name);
  const totalRows = Number(metadata.num_rows);
  const objects = await parquetReadObjects({ file, metadata, rowEnd: Math.min(TABLE_ROW_LIMIT, totalRows), compressors });
  const rows = objects.map(row => columns.map(column => row[column]));
  return { columns, rows, totalRows, shownRows: rows.length };
}

const pad = (value: number) => String(value).padStart(2, '0');
const jsonValue = (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) return 'Invalid Date';
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    return time === '00:00:00' ? date : `${date} ${time}`;
  }
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  try {
    const text = JSON.stringify(value, jsonValue);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch { return String(value); }
}

const numeric = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?%?$/;
export function isNumericColumn(rows: unknown[][], column: number) {
  let seen = false;
  for (const row of rows) {
    const value = row[column];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number' || typeof value === 'bigint' || (typeof value === 'string' && numeric.test(value.trim()))) seen = true;
    else return false;
  }
  return seen;
}
