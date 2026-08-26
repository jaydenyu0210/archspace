import type { JSX } from 'react';
import type { JsonSchemaProperty } from '@archspace/node-sdk';

/**
 * One JSON-Schema-driven form control (§5: inspector forms are generated
 * from the manifest's params schema — no custom node UIs in v1).
 *
 * Every control below is for a PRIMITIVE. A param's value is `unknown` and the
 * document is hand-editable, so it can hold an object or a list — and feeding
 * one to a text input used to render it as "[object Object]", which is not
 * merely ugly: the control is editable, so the first keystroke wrote that
 * literal string back through `onChange` and the user's structured value was
 * gone, permanently, on the next save. A control that cannot represent its
 * value must not pretend to; `structuredValue` below refuses instead.
 */

/**
 * Can any control here round-trip this value without losing it?
 *
 * A type predicate rather than a boolean, so the controls below are *provably*
 * handling a primitive rather than merely believed to be — the compiler and
 * the lint rule both narrow on it, which is what stops the next control added
 * to this file from quietly reintroducing the bug.
 */
function isEditablePrimitive(value: unknown): value is string | number | boolean | null | undefined {
  return value === undefined || value === null
    || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
export function ParamField(props: {
  name: string;
  schema: JsonSchemaProperty;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const { name, schema, value, onChange } = props;
  const label = schema.title ?? name;
  const ui = schema['x-archspace'];

  // The schema's own default is `unknown` too, and a manifest is free to
  // declare a non-primitive one. It cannot seed any control here, so it is
  // narrowed once rather than at four call sites.
  const fallback = isEditablePrimitive(schema.default) ? schema.default : undefined;

  let control: JSX.Element;

  if (!isEditablePrimitive(value)) {
    // Shown, not edited, and shown as what it actually is. The alternative —
    // an editable control seeded with a lossy rendering — is how the value
    // gets destroyed by someone who only meant to look at it.
    return (
      <div className="field">
        <label className="field-label">{label}</label>
        <pre className="field-input field-textarea mono field-structured">{JSON.stringify(value, null, 2)}</pre>
        <div className="field-desc">
          This parameter holds structured data, which this form cannot edit without
          replacing it. Edit it in the workflow file, or wire it from another node.
        </div>
      </div>
    );
  }

  if (Array.isArray(schema.enum)) {
    control = (
      <select
        className="field-input"
        value={String(value ?? fallback ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {schema.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {String(opt)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === 'boolean') {
    control = (
      <label className="field-toggle">
        <input
          type="checkbox"
          checked={Boolean(value ?? schema.default ?? false)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{Boolean(value ?? schema.default ?? false) ? 'on' : 'off'}</span>
      </label>
    );
  } else if (schema.type === 'number' || schema.type === 'integer') {
    control = (
      <input
        className="field-input mono"
        type="number"
        value={value === undefined || value === null ? String(fallback ?? '') : String(value)}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        onChange={(e) => {
          const n = e.target.value === '' ? undefined : Number(e.target.value);
          if (n === undefined || Number.isFinite(n)) {
            onChange(n === undefined ? schema.default : schema.type === 'integer' ? Math.round(n) : n);
          }
        }}
      />
    );
  } else if (schema.type === 'string' && ui?.widget === 'textarea') {
    control = (
      <textarea
        className="field-input field-textarea"
        rows={ui.rows ?? 4}
        placeholder={ui.placeholder}
        value={String(value ?? fallback ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (schema.type === 'string') {
    control = (
      <input
        className="field-input"
        type="text"
        placeholder={ui?.placeholder}
        value={String(value ?? fallback ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    control = <div className="field-unsupported">Unsupported param type: {String(schema.type)}</div>;
  }

  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {control}
      {schema.description && <div className="field-desc">{schema.description}</div>}
    </div>
  );
}
