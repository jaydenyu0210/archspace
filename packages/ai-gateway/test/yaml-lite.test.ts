/**
 * Pins the YAML *subset* `ai.yaml` is written in — and, just as much, what that
 * subset **refuses**.
 *
 * `yaml-lite` exists because this package's dependency set is fixed (`ai` plus
 * two providers) while `ai.yaml` is a flat, machine-local settings file. The
 * bargain that makes a hand-rolled parser acceptable is stated in its header: it
 * accepts block mappings, block sequences, plain and quoted scalars and
 * comments, and it *refuses everything else with a located error rather than
 * guessing*. A silent misparse of a settings file is far worse than a loud
 * "line 7: unsupported" — a guessed value is a workflow quietly pointed at the
 * wrong endpoint.
 *
 * So the refusals below are not negative-space padding; they are the feature.
 * Each asserts that an unsupported construct produces a `YamlSubsetError` at
 * the right line, which is what `parseAiConfig` turns into a ConfigIssue while
 * leaving the user's file untouched.
 *
 * The writer is pinned against the reader: this is the only parser that will
 * ever read what it emits, so emit → parse is the property that matters, and
 * the quoting rules exist to keep it true (`"12"` must not read back as `12`).
 *
 * The module is deliberately not exported from the barrel — publishing a second
 * YAML parser beside the document package's would invite callers to pick the
 * wrong one — so this file imports it by path, on purpose.
 */
import { describe, expect, it } from 'vitest';
import { YamlSubsetError, emitYamlSubset, parseYamlSubset, type YamlValue } from '../src/yaml-lite.js';

/** Parse and report the located message, so refusals read as data. */
function refusal(text: string): string {
  try {
    parseYamlSubset(text);
    throw new Error('the parser accepted input it should have refused');
  } catch (err) {
    expect(err).toBeInstanceOf(YamlSubsetError);
    return (err as YamlSubsetError).message;
  }
}

describe('what the subset accepts', () => {
  it('block mappings, nested to any depth', () => {
    expect(parseYamlSubset('a:\n  b:\n    c: 1\n')).toEqual({ a: { b: { c: 1 } } });
  });

  it('block sequences, indented or not', () => {
    expect(parseYamlSubset('a:\n  - x\n  - y\n')).toEqual({ a: ['x', 'y'] });
    // The common `key:` / `- item` style, where the list is not indented.
    expect(parseYamlSubset('a:\n- x\n- y\n')).toEqual({ a: ['x', 'y'] });
  });

  it('a sequence of mappings — the shape every profile list has', () => {
    expect(parseYamlSubset('profiles:\n  - name: a\n    model: m\n  - name: b\n')).toEqual({
      profiles: [{ name: 'a', model: 'm' }, { name: 'b' }],
    });
  });

  it('a document that is a sequence at the top level', () => {
    expect(parseYamlSubset('- a\n- b\n')).toEqual(['a', 'b']);
  });

  it('the scalar types a settings file needs, and nothing more', () => {
    expect(parseYamlSubset('n: 1\nf: 1.5e2\nz: -0\nt: true\nF: False\nu: ~\nnl: null\ns: hello world\n')).toEqual({
      n: 1,
      f: 150,
      z: -0,
      t: true,
      F: false,
      u: null,
      nl: null,
      s: 'hello world',
    });
  });

  it('leaves a zero-padded number a string, because it is one', () => {
    // A port or a version like `007` is not the number 7, and JSON.stringify of
    // a misparsed one would silently rewrite the user's file.
    expect(parseYamlSubset('v: 007\n')).toEqual({ v: '007' });
  });

  it('a key with no value at all', () => {
    expect(parseYamlSubset('a:\nb: 1\n')).toEqual({ a: null, b: 1 });
  });

  it('quoted scalars, with the escapes a settings file can need', () => {
    expect(parseYamlSubset('a: "x\\ny"\n')).toEqual({ a: 'x\ny' });
    expect(parseYamlSubset("b: 'it''s'\n")).toEqual({ b: "it's" });
    expect(parseYamlSubset('c: "\\u0041\\t\\\\"\n')).toEqual({ c: 'A\t\\' });
    expect(parseYamlSubset('"a b": 1\n')).toEqual({ 'a b': 1 });
  });

  it('empty flow collections, the one flow syntax with an unambiguous reading', () => {
    expect(parseYamlSubset('a: []\nb: {}\n')).toEqual({ a: [], b: {} });
  });

  it('a URL, whose colons are not key separators', () => {
    // Only a colon followed by a space (or end of line) separates a key, which
    // is what lets `baseUrl` be written plain.
    expect(parseYamlSubset('baseUrl: http://localhost:11434/v1\n')).toEqual({
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('comments — whole-line, trailing, and not the ones inside a value', () => {
    expect(parseYamlSubset('# header\na: 1 # trailing\n\nb: two\n')).toEqual({ a: 1, b: 'two' });
    // A `#` that is not preceded by a space is part of the value.
    expect(parseYamlSubset('a: b#c\n')).toEqual({ a: 'b#c' });
    expect(parseYamlSubset('a: "d # e"\n')).toEqual({ a: 'd # e' });
  });

  it('CRLF endings and a file that is only comments', () => {
    expect(parseYamlSubset('a: 1\r\nb: 2\r\n')).toEqual({ a: 1, b: 2 });
    expect(parseYamlSubset('# nothing here\n')).toBeNull();
    expect(parseYamlSubset('')).toBeNull();
  });
});

describe('what the subset refuses, and where', () => {
  it.each([
    ['flow collections', 'a: [1, 2]\n', 'line 1: flow collections are not supported here'],
    ['flow mappings', 'a: {b: 1}\n', 'line 1: flow collections are not supported here'],
    ['block scalars', 'a: |\n  text\n', 'line 1: block scalars are not supported here'],
    ['folded scalars', 'a: >\n  text\n', 'line 1: block scalars are not supported here'],
    ['anchors', 'a: &anchor 1\n', 'line 1: anchors and aliases are not supported here'],
    ['aliases', 'a: *anchor\n', 'line 1: anchors and aliases are not supported here'],
    ['multi-document streams', '---\na: 1\n', 'line 1: multi-document streams are not supported here'],
    ['tabs for indentation', 'a:\n\t- x\n', 'line 2: tabs are not valid YAML indentation'],
  ])('refuses %s with a line number', (_label, text, message) => {
    expect(refusal(text)).toBe(message);
  });

  it('refuses a duplicate key rather than silently keeping one of them', () => {
    // Last-wins is a defensible YAML reading, but on a settings file it means
    // the user edited a line that has no effect and nothing said so.
    expect(refusal('a: 1\na: 2\n')).toBe('line 2: duplicate key "a"');
  });

  it('refuses indentation it cannot place', () => {
    expect(refusal('a: 1\n  b: 2\n')).toBe('line 2: unexpected indentation');
  });

  it('refuses a list item where a mapping key belongs, and the reverse', () => {
    expect(refusal('a: 1\n- b\n')).toBe('line 2: expected "key: value", found a list item');
    expect(refusal('hello\n')).toBe('line 1: expected "key: value", found "hello"');
  });

  it('refuses an unterminated or badly escaped quoted scalar', () => {
    expect(refusal('a: "x\n')).toBe('line 1: unterminated quote');
    expect(refusal("a: 'x\n")).toBe('line 1: unterminated quote');
    expect(refusal('a: "\\uZZZZ"\n')).toBe('line 1: bad \\u escape');
    expect(refusal('a: "\\q"\n')).toBe('line 1: unsupported escape "\\q"');
  });

  it('reports the line the problem is on, not the line it noticed', () => {
    const text = ['# settings', '', 'defaultProfile: local', 'profiles:', '  - name: local', '    model: [a]', ''].join('\n');
    expect(refusal(text)).toBe('line 6: flow collections are not supported here');
  });

  it('carries the line as data, not only in the message', () => {
    try {
      parseYamlSubset('a: 1\na: 2\n');
      expect.unreachable('the parser accepted a duplicate key');
    } catch (err) {
      expect(err).toBeInstanceOf(YamlSubsetError);
      expect((err as YamlSubsetError).name).toBe('YamlSubsetError');
      expect((err as YamlSubsetError).line).toBe(2);
    }
  });
});

describe('the writer emits what this reader reads', () => {
  const roundTrip = (value: YamlValue): YamlValue => parseYamlSubset(emitYamlSubset(value));

  it('round trips the shape ai.yaml actually has', () => {
    const value: YamlValue = {
      defaultProfile: 'local',
      profiles: [
        { name: 'default', provider: 'anthropic', model: 'claude-opus-5', apiKeyRef: 'ai.anthropic.api_key' },
        { name: 'local', provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', headers: { 'X-Team': 'aec' } },
      ],
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it('quotes anything that would read back as a different type', () => {
    // The rule that makes the round trip true rather than usually true.
    const value: YamlValue = { a: '12', b: 'true', c: 'null', d: '~', e: '1.5' };
    expect(emitYamlSubset(value)).toBe('a: "12"\nb: "true"\nc: "null"\nd: "~"\ne: "1.5"\n');
    expect(roundTrip(value)).toEqual(value);
  });

  it('quotes strings whose punctuation would change the parse', () => {
    const value: YamlValue = { a: '', b: ' padded ', c: 'has: colon', d: 'ends:', e: '# hash', f: 'two\nlines' };
    expect(roundTrip(value)).toEqual(value);
  });

  it('leaves an ordinary value plain, so the file stays readable by hand', () => {
    expect(emitYamlSubset({ model: 'claude-opus-5', baseUrl: 'http://localhost:11434/v1' })).toBe(
      'model: claude-opus-5\nbaseUrl: http://localhost:11434/v1\n',
    );
  });

  it('gives a nested list its own block rather than emitting "- - x"', () => {
    // Inlined, this would read back as the string "- x".
    const value: YamlValue = { rows: [['a', 'b'], ['c']] };
    expect(emitYamlSubset(value)).toBe('rows:\n  -\n    - a\n    - b\n  -\n    - c\n');
    expect(roundTrip(value)).toEqual(value);
  });

  it('writes empty containers in the one flow form the reader accepts', () => {
    const value: YamlValue = { list: [], map: {}, nothing: null };
    expect(emitYamlSubset(value)).toBe('list: []\nmap: {}\nnothing: null\n');
    expect(roundTrip(value)).toEqual(value);
  });

  it('drops undefined properties instead of writing them as null', () => {
    expect(emitYamlSubset({ a: 1, b: undefined })).toBe('a: 1\n');
  });

  it('emits nothing for an empty document', () => {
    expect(emitYamlSubset({})).toBe('');
    expect(emitYamlSubset([])).toBe('');
  });

  it('refuses to write a number YAML cannot carry', () => {
    // NaN and Infinity have no YAML 1.2 core-schema spelling this reader
    // accepts, so writing one would produce a file we could not read back.
    expect(() => emitYamlSubset({ a: Number.NaN })).toThrow(TypeError);
    expect(() => emitYamlSubset({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('ends every document with exactly one newline', () => {
    const text = emitYamlSubset({ a: 1, b: { c: 2 } });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});
