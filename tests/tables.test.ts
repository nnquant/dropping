// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { formatCell, isNumericColumn, parseDelimited, readParquetPreview, TABLE_ROW_LIMIT } from '../src/tables';

describe('delimited text', () => {
  it('handles BOM, quotes, escaped quotes, CRLF and embedded newlines', () => {
    const table = parseDelimited('﻿name,note,value\r\n"Smith, J","said ""hi""",1.5\r\nLee,"two\nlines",\r\n', ',', false);
    expect(table.columns).toEqual(['name', 'note', 'value']);
    expect(table.rows).toEqual([['Smith, J', 'said "hi"', '1.5'], ['Lee', 'two\nlines', '']]);
    expect(table.totalRows).toBe(2);
  });

  it('drops the cut-off last record of a truncated preview and names missing headers', () => {
    const table = parseDelimited('a\tb\n1\t2\t3\n4\t5\n6\t', '\t', true);
    expect(table.columns).toEqual(['a', 'b', '列 3']);
    expect(table.rows).toEqual([['1', '2', '3'], ['4', '5']]);
  });

  it('limits rendered rows but keeps the parsed total', () => {
    const lines = ['n', ...Array.from({ length: TABLE_ROW_LIMIT + 5 }, (_, index) => String(index))].join('\n');
    const table = parseDelimited(lines, ',', false);
    expect(table.shownRows).toBe(TABLE_ROW_LIMIT);
    expect(table.totalRows).toBe(TABLE_ROW_LIMIT + 5);
  });
});

describe('parquet', () => {
  it('reads the schema, the row count and only the leading rows through range requests', async () => {
    const count = TABLE_ROW_LIMIT + 500;
    const buffer = parquetWriteBuffer({
      columnData: [
        { name: 'symbol', data: Array.from({ length: count }, (_, index) => `S${index}`) },
        { name: 'close', data: Array.from({ length: count }, (_, index) => index % 7 === 0 ? null : index / 4) },
        { name: 'volume', data: Array.from({ length: count }, (_, index) => BigInt(index * 100)) },
      ],
    });
    const requests: [number, number][] = [];
    const table = await readParquetPreview(async (offset, length) => {
      requests.push([offset, length]);
      return buffer.slice(offset, offset + length);
    }, buffer.byteLength);
    expect(table.columns).toEqual(['symbol', 'close', 'volume']);
    expect(table.totalRows).toBe(count);
    expect(table.shownRows).toBe(TABLE_ROW_LIMIT);
    expect(table.rows[1]).toEqual(['S1', 0.25, 100n]);
    expect(table.rows[0][1]).toBeNull();
    expect(requests.every(([offset, length]) => offset >= 0 && offset + length <= buffer.byteLength)).toBe(true);
  });

  it('rejects files that are not parquet', async () => {
    const bytes = new TextEncoder().encode('not a parquet file at all').buffer;
    await expect(readParquetPreview(async (offset, length) => bytes.slice(offset, offset + length), bytes.byteLength)).rejects.toThrow();
  });
});

describe('cells', () => {
  it('formats values for display and detects numeric columns', () => {
    expect(formatCell(12n)).toBe('12');
    expect(formatCell(new Date(2026, 9, 3))).toBe('2026-10-03');
    expect(formatCell(new Date(2026, 9, 3, 9, 30, 5))).toBe('2026-10-03 09:30:05');
    expect(formatCell(new Uint8Array(4))).toBe('<4 bytes>');
    expect(formatCell({ id: 1n, tags: ['a'] })).toBe('{"id":"1","tags":["a"]}');
    expect(isNumericColumn([['1.5'], [''], ['-2e3'], [null]], 0)).toBe(true);
    expect(isNumericColumn([['1'], ['n/a']], 0)).toBe(false);
  });
});
