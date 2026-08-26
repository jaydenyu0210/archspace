/**
 * aec.export_table_csv — writes any table to a CSV asset in the
 * content-addressed store.
 *
 * Pure and instant (no mock latency). Serialization follows RFC 4180 for
 * quoting; the only deliberate departure is the line ending: LF, never CRLF,
 * matching every other text artefact this project writes (the IFC SPF model,
 * the markdown reports). Same table + same params ⇒ same bytes ⇒ same content
 * hash, which is what makes the CAS deduplicate repeat exports.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type { TableValue } from './shapes.js';
import { requireInput } from './util.js';

export interface ExportTableCsvParams {
  file_name: string;
  delimiter: 'comma' | 'semicolon' | 'tab';
  include_header: boolean;
}

const DELIMITERS: Record<ExportTableCsvParams['delimiter'], string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
};

/**
 * One cell as text. Strings go through verbatim (quoting happens later);
 * numbers and booleans use their canonical JS text; null/undefined are an
 * empty cell; objects and arrays — including AssetRefs — become compact JSON
 * so no information is silently dropped.
 */
function cellText(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    default:
      return JSON.stringify(v) ?? '';
  }
}

/** RFC 4180 quoting: quote when the field holds the delimiter, a double quote,
 *  CR or LF; embedded double quotes are doubled. */
function quote(field: string, delimiter: string): string {
  const needsQuotes =
    field.includes(delimiter) || field.includes('"') || field.includes('\n') || field.includes('\r');
  return needsQuotes ? `"${field.replace(/"/g, '""')}"` : field;
}

export const exportTableCsvNode: NodeModule<ExportTableCsvParams> = {
  manifest: {
    type: 'aec.export_table_csv',
    version: 1,
    label: 'Export Table to CSV',
    description: 'Writes any table to a CSV asset in the content-addressed store.',
    category: 'Report',
    keywords: ['csv', 'export', 'table', 'asset'],
    caching: 'pure',
    lane: 'io',
    params: {
      type: 'object',
      properties: {
        file_name: {
          type: 'string',
          title: 'File name',
          default: 'export.csv',
        },
        delimiter: {
          type: 'string',
          title: 'Delimiter',
          enum: ['comma', 'semicolon', 'tab'],
          default: 'comma',
        },
        include_header: {
          type: 'boolean',
          title: 'Include header row',
          description: 'Write the column labels as the first line.',
          default: true,
        },
      },
    },
    inputs: [{ id: 'table', type: 'table', label: 'Table', required: true }],
    outputs: [
      { id: 'csv', type: 'asset<csv>', label: 'CSV' },
      { id: 'row_count', type: 'number', label: 'Row count' },
    ],
  },

  async execute(ctx, inputs, params) {
    const table = requireInput<TableValue>(inputs, 'table', 'aec.export_table_csv');
    const delimiter = DELIMITERS[params.delimiter];

    const lines: string[] = [];
    if (params.include_header) {
      lines.push(table.columns.map((c) => quote(c.label ?? c.id, delimiter)).join(delimiter));
    }
    for (const row of table.rows) {
      // Cells in column order; a column the row does not carry is an empty cell.
      lines.push(table.columns.map((c) => quote(cellText(row[c.id]), delimiter)).join(delimiter));
    }

    // LF line endings plus a trailing newline, so the file ends on a record
    // boundary and `wc -l` counts records. A file with no lines at all (no
    // header, no rows) stays genuinely empty rather than holding a stray "\n".
    const csv = lines.length === 0 ? '' : `${lines.join('\n')}\n`;

    const ref = await ctx.assets.put(new TextEncoder().encode(csv), {
      mediaType: 'text/csv',
      format: 'csv',
      name: params.file_name,
    });
    ctx.log('info', `wrote ${table.rows.length} row(s) to ${params.file_name}`, { bytes: ref.size });

    return { csv: ref, row_count: table.rows.length };
  },
};
