/**
 * ai.extract_table — prose in, a `table` value out, through one
 * schema-constrained model call (ARCHITECTURE §10 / ADR-0010).
 *
 * This is the node ADR-0010's Consequences section is describing when it says
 * structured output "becomes the workhorse for AI→`table`/`json` port flows".
 * The unstructured half of a project — a code letter, a consultant's report, a
 * pasted spec — is exactly what the deterministic `aec.*` nodes cannot read,
 * and a `table` is exactly what the rest of this package already speaks. Like
 * its siblings it is NOT a mock: it reaches whichever provider this machine's
 * model profile names, through `ctx.ai`, and never learns which one that was.
 *
 * The output is a TableValue exactly as shapes.ts declares it — `columns`
 * ({ id, label }) and `rows` (Record<string, Value>) — so it flows straight
 * into `aec.export_table_csv` with no adapter. Two properties make that flow
 * lossless rather than merely type-correct: every row carries a key for every
 * declared column, so the exporter's `table.columns.map((c) => row[c.id])`
 * projection never hits its "column the row does not carry" path by accident;
 * and a cell the source does not state is `null`, which `cellText` already
 * renders as an empty CSV field. "Not stated" and "empty" are the same thing
 * in a spreadsheet, and this is the one place they are allowed to converge.
 *
 * Columns are declared in the form, one per line, `id | Label | type`. The
 * rejected alternative was inferring columns from the model's own answer:
 * it would make the node's output ports unpredictable from the document,
 * which is the property that lets the app validate a graph without running it
 * (§5.2), and it would let a re-run silently rename a column another node
 * reads. The columns are the contract; the model fills them in.
 *
 * The schema built from those columns is the *only* channel that states the
 * shape — the prompt does not repeat it. Every column is `required` and every
 * column's type admits `null`: required-but-nullable is how plain JSON Schema
 * says "answer for every column, and say null where the source does not state
 * it". Optional properties were rejected because an omitted key and an
 * unreadable cell would then be indistinguishable, and one of those two is a
 * model doing its job.
 *
 * Honest failure, in three tiers. An unbound profile throws out of `ctx.ai`
 * with a message that already names the settings location; there is no
 * try/catch here, so it reaches the user intact and keeps the gateway's own
 * transient marking for the engine's retry policy (§7.5). A structurally wrong
 * answer — no `rows` array, or a row that is not an object — is raised through
 * `ctx.retryable`, because re-sampling is precisely the remedy. A cell that
 * does not match its declared type is neither: it becomes `null` and is
 * counted in a warning, because one unparseable cell is not a reason to throw
 * away 200 good rows. What never happens is an empty table standing in for a
 * failed call.
 *
 * Caching: 'never' — the contract's default, and deliberate (§5.2: purity is
 * opt-in). Extraction feels deterministic, which is exactly what makes 'pure'
 * tempting and wrong: the same page extracted twice can differ in a cell, the
 * memo key (§7.3) hashes params and input hashes but cannot see which provider
 * the profile name resolved to, and cache entries are valid forever by
 * construction. That is the reasoning ADR-0009 §4 used to refuse MCP's
 * advisory `readOnlyHint`, and it applies harder here: a stale table is a
 * schedule someone builds on.
 */
import type { AiGateway, JsonSchemaObject, NodeModule, Value } from '@archspace/node-sdk';
import {
  composeUserPrompt,
  describeProfile,
  MODEL_PROFILE_PARAM,
  requestedProfile,
} from './ai-common.js';
import type { TableValue } from './shapes.js';
import { requireInput, toValue } from './util.js';

export interface AiExtractTableParams {
  profile: string;
  columns: string;
  instructions: string;
  max_rows: number;
}

/** What a cell may hold. The three scalar port primitives, nothing else: a
 *  nested object in a table cell is a different node's problem. */
type CellType = 'text' | 'number' | 'boolean';

interface ExtractColumn {
  id: string;
  label: string;
  type: CellType;
}

/** The same identifier rule the rest of the system uses for ids (§5.2, §6). */
const COLUMN_ID = /^[a-z][a-z0-9_]*$/;

const CELL_TYPES: readonly string[] = ['text', 'number', 'boolean'];

/** Cell type → JSON Schema type. Every column also admits null (see header). */
const SCHEMA_TYPE: Record<CellType, string> = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
};

/**
 * The node's own system message, not a param. What this node promises — every
 * declared column answered, nothing invented, source order preserved — is part
 * of its contract, and a user who wants to own the system message entirely has
 * `ai.generate_text` for that. Domain guidance goes in the `instructions`
 * param, which is appended above the source.
 */
const SYSTEM = [
  'You extract tabular data from documents.',
  'Use only what the source states: never infer, complete or invent a value.',
  'Return null for any cell the source does not state.',
  'Emit one row per record the source actually contains, in the order they appear.',
].join(' ');

const DEFAULT_COLUMNS = `room_number | Room number | text
name        | Name        | text
area_m2     | Area (m²)   | number`;

/** "area_m2" → "Area m2" — a label for a column that did not name one. */
function labelFor(id: string): string {
  const words = id.split('_').filter((w) => w !== '');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * Parse the column spec. Every malformed line is an error naming the line —
 * never a skipped column, because a silently dropped column is a column of
 * nulls downstream and nothing on screen says why.
 */
function parseColumns(spec: string): ExtractColumn[] {
  const columns: ExtractColumn[] = [];
  const seen = new Set<string>();
  const lines = spec.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const at = `ai.extract_table: columns line ${i + 1} ("${line}")`;

    const fields = line.split('|').map((f) => f.trim());
    if (fields.length > 3) {
      throw new Error(`${at} — expected at most "id | Label | type", got ${fields.length} fields`);
    }
    const [id, label = '', type = ''] = fields;
    if (!COLUMN_ID.test(id)) {
      throw new Error(
        `${at} — "${id}" is not a valid column id: lowercase letters, digits and "_", starting with a letter`,
      );
    }
    if (seen.has(id)) throw new Error(`${at} — column "${id}" is declared twice`);
    if (type !== '' && !CELL_TYPES.includes(type)) {
      throw new Error(`${at} — unknown column type "${type}"; expected ${CELL_TYPES.join(', ')}`);
    }

    seen.add(id);
    columns.push({
      id,
      label: label === '' ? labelFor(id) : label,
      type: type === '' ? 'text' : (type as CellType),
    });
  }

  if (columns.length === 0) {
    throw new Error('ai.extract_table: no columns declared — a table needs at least one column');
  }
  return columns;
}

/**
 * The extraction schema. `rows` is wrapped in an object because
 * `generateObject` is contracted to return one (a bare array is not a
 * JsonSchemaObject); `maxItems` states the row cap where the provider can act
 * on it, and execute() still truncates afterwards because a schema is a
 * constraint we ask for, not one we are owed.
 */
function buildSchema(columns: readonly ExtractColumn[], maxRows: number): JsonSchemaObject {
  const cells: Record<string, unknown> = {};
  for (const column of columns) {
    cells[column.id] = {
      type: [SCHEMA_TYPE[column.type], 'null'],
      description: column.label,
    };
  }
  return {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: 'One entry per record stated in the source, in source order.',
        maxItems: maxRows,
        items: {
          type: 'object',
          properties: cells,
          required: columns.map((c) => c.id),
          additionalProperties: false,
        },
      },
    },
    required: ['rows'],
    additionalProperties: false,
  };
}

/**
 * Every JSON object inside a `Value` is a `Record<string, Value>` by
 * construction — this is the one place that fact is written down, so the
 * shaping loop below reads cells without a cast of its own.
 */
function asObject(v: Value): Record<string, Value> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, Value>)
    : null;
}

/** A value described the way an error message should describe it. */
function describeKind(v: Value | undefined): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

/**
 * One cell, read against its declared type. `null` is a first-class answer
 * ("the source does not state it"), which is why a successful read and an
 * empty cell are different results here: only the failures are counted.
 *
 * Numbers and booleans arriving as text are accepted — that is the same
 * lossless direction the engine's own coercion table already allows between
 * ports (§6.2), and models quote numbers constantly. A non-finite number is
 * rejected outright: §6.1 stops NaN and ±Inf at the wire boundary, and a
 * table cell is a wire value.
 */
function readCell(raw: Value | undefined, type: CellType): { read: true; value: Value } | { read: false } {
  if (raw === undefined || raw === null) return { read: true, value: null };

  switch (type) {
    case 'text':
      if (typeof raw === 'string') return { read: true, value: raw };
      if (typeof raw === 'number' && Number.isFinite(raw)) return { read: true, value: String(raw) };
      if (typeof raw === 'boolean') return { read: true, value: String(raw) };
      return { read: false };
    case 'number': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? { read: true, value: raw } : { read: false };
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim());
        if (Number.isFinite(n)) return { read: true, value: n };
      }
      return { read: false };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { read: true, value: raw };
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'true') return { read: true, value: true };
        if (s === 'false') return { read: true, value: false };
      }
      return { read: false };
    }
  }
}

export const aiExtractTableNode: NodeModule<AiExtractTableParams> = {
  manifest: {
    type: 'ai.extract_table',
    version: 1,
    label: 'Extract Table',
    description:
      'Extracts the columns you declare out of unstructured text into a table, via one schema-constrained model call. Cells the source does not state come back empty, never invented.',
    category: 'AI',
    keywords: ['ai', 'llm', 'extract', 'table', 'parse', 'structured'],
    // See the header: extraction only looks deterministic, and a stale table
    // is a schedule someone builds on.
    caching: 'never',
    lane: 'ai',
    // Nothing: `ctx.ai` is unconditional (§5.2) and the gateway holds the
    // keys, so no 'net' and no secret. Stated rather than omitted because an
    // AI node is where a reader would reasonably wonder.
    permissions: [],
    params: {
      type: 'object',
      properties: {
        profile: MODEL_PROFILE_PARAM,
        columns: {
          type: 'string',
          title: 'Columns',
          description:
            'One column per line: "id | Label | type". Label defaults to the id, type defaults to text (text, number, boolean).',
          default: DEFAULT_COLUMNS,
          'x-archspace': { widget: 'textarea', rows: 8 },
        },
        instructions: {
          type: 'string',
          title: 'Instructions',
          description:
            'Optional guidance placed above the source — which part of the document to read, how to treat repeats.',
          default: '',
          'x-archspace': {
            widget: 'textarea',
            rows: 4,
            placeholder: 'Only the rooms in the fire-rated core. Ignore the revision history.',
          },
        },
        max_rows: {
          type: 'integer',
          title: 'Maximum rows',
          description: 'Row cap, asked for in the schema and enforced on the answer.',
          default: 200,
          minimum: 1,
          maximum: 2000,
        },
      },
    },
    // `text`, not `json`: json would accept anything by widening (§6.2) and
    // this node would quietly stringify a wired model or table into a prompt.
    // A text port makes the caller decide how their data becomes prose —
    // which is what `ai.generate_text` is for.
    inputs: [{ id: 'source', type: 'text', label: 'Source', required: true }],
    outputs: [
      { id: 'table', type: 'table', label: 'Table' },
      { id: 'row_count', type: 'number', label: 'Row count' },
    ],
  },

  async execute(ctx, inputs, params) {
    const columns = parseColumns(params.columns);
    const source = requireInput<string>(inputs, 'source', 'ai.extract_table');
    if (source.trim() === '') {
      throw new Error('ai.extract_table: the source text is empty — there is nothing to extract');
    }

    const profile = requestedProfile(params.profile);
    ctx.progress(0.05, `extracting ${columns.length} column(s)`);
    ctx.progress(0.15, `calling ${describeProfile(profile)}`);

    // Naming the gateway's own inline request type keeps this call in step
    // with the contract instead of restating it. `signal` is the whole of
    // cancellation: an abort tears the provider call down mid-flight (§7.4).
    const request: Parameters<AiGateway['generateObject']>[0] = {
      schema: buildSchema(columns, params.max_rows),
      system: SYSTEM,
      prompt: composeUserPrompt(params.instructions, source, 'Source'),
      signal: ctx.signal,
      ...(profile !== undefined ? { profile } : {}),
    };
    const { object } = await ctx.ai.generateObject(request);

    const answer = asObject(object);
    const returned = answer === null ? undefined : answer.rows;
    if (!Array.isArray(returned)) {
      throw ctx.retryable(
        new Error(`ai.extract_table: the model returned ${describeKind(returned)} for "rows", not an array`),
      );
    }

    ctx.progress(0.8, `shaping ${returned.length} row(s)`);
    const kept = returned.slice(0, params.max_rows);
    if (kept.length < returned.length) {
      ctx.log(
        'warn',
        `the model returned ${returned.length} rows against a ${params.max_rows}-row cap — keeping the first ${kept.length}`,
      );
    }

    let unreadable = 0;
    const rows: Record<string, Value>[] = [];
    for (let i = 0; i < kept.length; i++) {
      const raw = asObject(kept[i]);
      if (raw === null) {
        throw ctx.retryable(
          new Error(`ai.extract_table: row ${i + 1} came back as ${describeKind(kept[i])}, not an object`),
        );
      }
      // Every declared column, every row — see the header: this is what makes
      // the table export losslessly.
      const row: Record<string, Value> = {};
      for (const column of columns) {
        const cell = readCell(raw[column.id], column.type);
        if (!cell.read) unreadable++;
        row[column.id] = cell.read ? cell.value : null;
      }
      rows.push(row);
    }

    if (unreadable > 0) {
      ctx.log(
        'warn',
        `${unreadable} cell(s) did not match their declared column type and were left empty`,
      );
    }
    if (rows.length === 0) {
      // A real answer — the source states no rows — and not the same thing as
      // a failed call, which threw above. Said out loud so it is not read as
      // a broken wire.
      ctx.log('warn', 'the model found no rows in the source');
    }

    const table: TableValue = {
      columns: columns.map((c) => ({ id: c.id, label: c.label })),
      rows,
    };
    ctx.progress(1, `extracted ${rows.length} row(s)`);
    return { table: toValue(table), row_count: rows.length };
  },
};
