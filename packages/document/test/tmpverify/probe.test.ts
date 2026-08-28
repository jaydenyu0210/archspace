import { describe, it } from 'vitest';
import { parseWorkflow } from '../../src/parse.js';
import YAML from 'yaml';

const base = `archspace: 1
kind: workflow
meta:
  name: Demo
nodes:
  - id: n_aaaaaa
    type: core.x
    version: 1
    config: {}
edges:
layout:
  n_aaaaaa: { x: 0, y: 0 }
`;

describe('probe', () => {
  it('empty edges key', () => {
    console.log('YAML.parse ->', JSON.stringify(YAML.parse(base)));
    const r = parseWorkflow(base);
    console.log('RESULT ok=', r.ok);
    console.log('ISSUES', JSON.stringify(r.issues, null, 1));
  });

  it('empty nodes key', () => {
    const t = `archspace: 1
kind: workflow
meta:
  name: Demo
nodes:
edges:
`;
    const r = parseWorkflow(t);
    console.log('NODES-EMPTY ok=', r.ok, JSON.stringify(r.issues));
  });

  it('explicit empty list', () => {
    const t = base.replace('edges:\n', 'edges: []\n');
    const r = parseWorkflow(t);
    console.log('EXPLICIT ok=', r.ok, JSON.stringify(r.issues));
  });
});
