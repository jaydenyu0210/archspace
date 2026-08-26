/** Output previews (ARCHITECTURE §7.6): computed engine-side, size-capped,
 *  so the renderer/CLI never touch raw bulk data. */
import { isAssetRef, type AssetRef, type NodeManifest, type Outputs, type Value } from '@archspace/node-sdk';
import { isValueOfType, parsePortType } from '@archspace/types';

export type ValuePreview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'json'; json: string; truncated: boolean } // pretty-printed, 2-space
  | { kind: 'table'; columns: { id: string; label?: string }[]; rows: Record<string, Value>[]; totalRows: number }
  | { kind: 'asset'; ref: AssetRef }
  | { kind: 'empty' };

export interface OutputPreview {
  port: string;
  type: string;
  preview: ValuePreview;
}

const TEXT_CAP = 16_000;
const TABLE_ROW_CAP = 50;

export function previewValue(portType: string, value: Value | undefined): ValuePreview {
  if (value === null || value === undefined) return { kind: 'empty' };
  if (isAssetRef(value)) return { kind: 'asset', ref: value };

  const parsed = parsePortType(portType);
  if (parsed?.kind === 'primitive' && parsed.name === 'text' && typeof value === 'string') {
    return { kind: 'text', text: value.slice(0, TEXT_CAP), truncated: value.length > TEXT_CAP };
  }
  if (parsed?.kind === 'primitive' && parsed.name === 'table' && isValueOfType(value, 'table')) {
    const table = value as { columns: { id: string; label?: string }[]; rows: Record<string, Value>[] };
    return {
      kind: 'table',
      columns: table.columns.map((c) => ({ id: c.id, ...(c.label !== undefined ? { label: c.label } : {}) })),
      rows: table.rows.slice(0, TABLE_ROW_CAP),
      totalRows: table.rows.length,
    };
  }
  const json = JSON.stringify(value, null, 2) ?? 'null';
  return { kind: 'json', json: json.slice(0, TEXT_CAP), truncated: json.length > TEXT_CAP };
}

export function outputPreviews(manifest: NodeManifest, outputs: Outputs): OutputPreview[] {
  return manifest.outputs.map((port) => ({
    port: port.id,
    type: port.type,
    preview: previewValue(port.type, outputs[port.id]),
  }));
}
