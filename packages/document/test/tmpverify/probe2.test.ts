import { describe, it } from 'vitest';
import { parseWorkflow } from '../../src/parse.js';

const mk = (body: string) => `archspace: 1\nkind: workflow\n${body}`;

describe('probe2', () => {
  it('bare meta / layout / requires are non-fatal', () => {
    const cases: Record<string, string> = {
      'bare meta': mk('meta:\nnodes: []\nedges: []\n'),
      'bare layout': mk('meta:\n  name: D\nnodes: []\nedges: []\nlayout:\n'),
      'bare requires': mk('meta:\n  name: D\nrequires:\nnodes: []\nedges: []\n'),
      'edges omitted entirely': mk('meta:\n  name: D\nnodes: []\n'),
      'bare edges': mk('meta:\n  name: D\nnodes: []\nedges:\n'),
      'bare nodes': mk('meta:\n  name: D\nnodes:\nedges: []\n'),
      'edges: ~': mk('meta:\n  name: D\nnodes: []\nedges: ~\n'),
      'edges: null': mk('meta:\n  name: D\nnodes: []\nedges: null\n'),
    };
    for (const [k, v] of Object.entries(cases)) {
      const r = parseWorkflow(v);
      console.log(k, '-> ok=', r.ok, r.ok ? '' : JSON.stringify(r.issues.filter((i) => i.severity === 'error')));
    }
  });
});
