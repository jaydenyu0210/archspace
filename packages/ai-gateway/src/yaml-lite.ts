/**
 * A deliberately tiny YAML block-subset reader/writer, used only for `ai.yaml`.
 *
 * Why not the `yaml` package, which the workflow document and `mcp.yaml` both
 * use? Because this package's dependency set is fixed (`ai` + two providers)
 * and `ai.yaml` is a flat, machine-local settings file: a list of profiles with
 * string fields. The subset below covers exactly that — block mappings, block
 * sequences, plain and quoted scalars, comments — and *refuses* everything else
 * (flow collections, block scalars, anchors, multi-document streams) with a
 * located error rather than guessing. A silent misparse of a settings file is
 * far worse than a loud "line 7: unsupported"; parseAiConfig turns the refusal
 * into a ConfigIssue and leaves the user's file untouched.
 *
 * The writer emits the same subset, so serialize → parse is a round trip.
 */

export type YamlValue =
  | null
  | boolean
  | number
  | string
  | YamlValue[]
  | { [key: string]: YamlValue | undefined };

export class YamlSubsetError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlSubsetError';
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface Ln {
  indent: number;
  text: string;
  line: number;
}

interface Cursor {
  i: number;
}

/** Strip a trailing `# comment`, honouring quotes so a `#` inside a value lives. */
function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ')) return text.slice(0, i);
  }
  return text;
}

function scan(text: string): Ln[] {
  const out: Ln[] = [];
  const raw = text.split(/\r?\n/);
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n] ?? '';
    const lineNo = n + 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes('\t')) {
      throw new YamlSubsetError('tabs are not valid YAML indentation', lineNo);
    }
    if (line.startsWith('---') || line.startsWith('...')) {
      throw new YamlSubsetError('multi-document streams are not supported here', lineNo);
    }
    const body = stripComment(line.slice(indent)).trimEnd();
    if (body === '') continue;
    out.push({ indent, text: body, line: lineNo });
  }
  return out;
}

/** Index of the `:` that separates a mapping key from its value, or -1. */
function keyColon(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || text[i + 1] === ' ')) return i;
  }
  return -1;
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

function unquote(text: string, line: number): string {
  const quote = text[0];
  if (quote === "'") {
    if (!text.endsWith("'") || text.length < 2) throw new YamlSubsetError('unterminated quote', line);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (!text.endsWith('"') || text.length < 2) throw new YamlSubsetError('unterminated quote', line);
  let out = '';
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'u': {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlSubsetError('bad \\u escape', line);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new YamlSubsetError(`unsupported escape "\\${next ?? ''}"`, line);
    }
  }
  return out;
}

const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

function parseScalar(text: string, line: number): YamlValue {
  if (text === '') return null;
  const first = text[0];
  if (first === '"' || first === "'") return unquote(text, line);
  if (first === '|' || first === '>') {
    throw new YamlSubsetError('block scalars are not supported here', line);
  }
  if (first === '&' || first === '*') {
    throw new YamlSubsetError('anchors and aliases are not supported here', line);
  }
  if (first === '[' || first === '{') {
    if (text === '[]') return [];
    if (text === '{}') return {};
    throw new YamlSubsetError('flow collections are not supported here', line);
  }
  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (NUMBER.test(text)) return Number(text);
  return text;
}

function parseBlock(lns: Ln[], cur: Cursor, indent: number): YamlValue {
  const head = lns[cur.i];
  if (head === undefined) return null;
  return isSequenceItem(head.text) ? parseSequence(lns, cur, indent) : parseMapping(lns, cur, indent);
}

function parseMapping(lns: Ln[], cur: Cursor, indent: number): YamlValue {
  const out: Record<string, YamlValue> = {};
  while (cur.i < lns.length) {
    const ln = lns[cur.i] as Ln;
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlSubsetError('unexpected indentation', ln.line);
    if (isSequenceItem(ln.text)) throw new YamlSubsetError('expected "key: value", found a list item', ln.line);
    const colon = keyColon(ln.text);
    if (colon === -1) throw new YamlSubsetError(`expected "key: value", found "${ln.text}"`, ln.line);
    const rawKey = ln.text.slice(0, colon).trim();
    const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? unquote(rawKey, ln.line) : rawKey;
    if (key === '') throw new YamlSubsetError('empty mapping key', ln.line);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlSubsetError(`duplicate key "${key}"`, ln.line);
    }
    const rest = ln.text.slice(colon + 1).trim();
    cur.i++;
    if (rest !== '') {
      out[key] = parseScalar(rest, ln.line);
      continue;
    }
    const next = lns[cur.i];
    if (next !== undefined && next.indent > indent) {
      out[key] = parseBlock(lns, cur, next.indent);
    } else if (next !== undefined && next.indent === indent && isSequenceItem(next.text)) {
      // The common `key:` / `- item` style, where the list is not indented.
      out[key] = parseSequence(lns, cur, indent);
    } else {
      out[key] = null;
    }
  }
  return out;
}

function parseSequence(lns: Ln[], cur: Cursor, indent: number): YamlValue {
  const out: YamlValue[] = [];
  while (cur.i < lns.length) {
    const ln = lns[cur.i] as Ln;
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlSubsetError('unexpected indentation', ln.line);
    if (!isSequenceItem(ln.text)) break;
    const rest = ln.text.slice(1).replace(/^ +/, '');
    if (rest === '') {
      cur.i++;
      const next = lns[cur.i];
      out.push(next !== undefined && next.indent > indent ? parseBlock(lns, cur, next.indent) : null);
      continue;
    }
    if (keyColon(rest) !== -1) {
      // `- key: value`: the item is a mapping whose first key sits where `rest`
      // starts, so rewrite this line at that indent and read it as a mapping.
      const itemIndent = indent + (ln.text.length - rest.length);
      lns[cur.i] = { indent: itemIndent, text: rest, line: ln.line };
      out.push(parseMapping(lns, cur, itemIndent));
      continue;
    }
    cur.i++;
    out.push(parseScalar(rest, ln.line));
  }
  return out;
}

/** Parse the supported subset. Throws YamlSubsetError with a line number. */
export function parseYamlSubset(text: string): YamlValue {
  const lns = scan(text);
  if (lns.length === 0) return null;
  const cur: Cursor = { i: 0 };
  const first = lns[0] as Ln;
  const value = parseBlock(lns, cur, first.indent);
  if (cur.i < lns.length) {
    throw new YamlSubsetError('unexpected content', (lns[cur.i] as Ln).line);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const PLAIN_SAFE = /^[A-Za-z_][A-Za-z0-9_ .:/@+-]*$/;

function needsQuotes(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (s.includes('\n') || s.includes('#') || s.includes(': ') || s.endsWith(':')) return true;
  if (!PLAIN_SAFE.test(s)) return true;
  // A plain scalar that would read back as a non-string must be quoted.
  return NUMBER.test(s) || ['true', 'false', 'null', '~', 'True', 'False', 'Null'].includes(s);
}

function emitScalar(v: null | boolean | number | string): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('cannot serialize a non-finite number');
    return String(v);
  }
  return needsQuotes(v) ? JSON.stringify(v) : v;
}

function isContainer(v: YamlValue): v is YamlValue[] | { [key: string]: YamlValue | undefined } {
  return typeof v === 'object' && v !== null;
}

function entriesOf(v: { [key: string]: YamlValue | undefined }): [string, YamlValue][] {
  return Object.entries(v).filter((e): e is [string, YamlValue] => e[1] !== undefined);
}

function isEmptyContainer(v: YamlValue): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (isContainer(v)) return entriesOf(v).length === 0;
  return false;
}

function emitBlock(value: YamlValue, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length > 0) {
        // A nested list gets its own block: inlining it after "- " would emit
        // "- - x", which this reader would take for the string "- x".
        out.push(`${pad}-`);
        emitBlock(item, indent + 2, out);
      } else if (isContainer(item) && !isEmptyContainer(item)) {
        const sub: string[] = [];
        emitBlock(item, indent + 2, sub);
        const head = sub[0] as string;
        out.push(`${pad}- ${head.slice(indent + 2)}`);
        out.push(...sub.slice(1));
      } else if (isContainer(item)) {
        out.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
      } else {
        out.push(`${pad}- ${emitScalar(item)}`);
      }
    }
    return;
  }
  if (isContainer(value)) {
    for (const [key, v] of entriesOf(value)) {
      const k = needsQuotes(key) ? JSON.stringify(key) : key;
      if (isContainer(v) && !isEmptyContainer(v)) {
        out.push(`${pad}${k}:`);
        emitBlock(v, indent + 2, out);
      } else if (isContainer(v)) {
        out.push(`${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}`);
      } else {
        out.push(`${pad}${k}: ${emitScalar(v)}`);
      }
    }
    return;
  }
  out.push(`${pad}${emitScalar(value)}`);
}

/** Emit the supported subset. LF endings, one trailing newline, no tabs. */
export function emitYamlSubset(value: YamlValue): string {
  const out: string[] = [];
  emitBlock(value, 0, out);
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
