import type { JSX } from 'react';
import type { JsonSchemaProperty } from '@archspace/node-sdk';

/**
 * One JSON-Schema-driven form control (§5: inspector forms are generated
 * from the manifest's params schema — no custom node UIs in v1).
 */
export function ParamField(props: {
  name: string;
  schema: JsonSchemaProperty;
  value: unknown;
  onChange(value: unknown): void;
}) {
  const { name, schema, value, onChange } = props;
  const label = schema.title ?? name;
  const ui = schema['x-archspace'];

  let control: JSX.Element;

  if (Array.isArray(schema.enum)) {
    control = (
      <select
        className="field-input"
        value={String(value ?? schema.default ?? '')}
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
        value={value === undefined || value === null ? String(schema.default ?? '') : String(value)}
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
        value={String(value ?? schema.default ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (schema.type === 'string') {
    control = (
      <input
        className="field-input"
        type="text"
        placeholder={ui?.placeholder}
        value={String(value ?? schema.default ?? '')}
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
