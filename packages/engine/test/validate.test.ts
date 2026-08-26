/** Required assertion 10: every §6.2/§7.1 refusal carries the right code, and
 *  startRun refuses to start. */
import { describe, expect, it } from 'vitest';
import { GraphValidationError, createVirtualScheduler, startRun, validateGraph } from '../src/index.js';
import { edge, graph, mod, nodeSpec, probe, recorder, reg, source } from './helpers.js';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('validateGraph', () => {
  it('rejects unknown node types with unknown-type', () => {
    const issues = validateGraph(graph([nodeSpec('a', 'test.nope')]), reg());
    expect(codes(issues)).toContain('unknown-type');
    expect(issues[0].message).toContain('"a"');
    expect(issues[0].message).toContain('test.nope');
  });

  it('rejects version mismatches with version-mismatch', () => {
    const src = source('test.src', 'text');
    const issues = validateGraph(graph([{ id: 'a', type: 'test.src', version: 2 }]), reg(src.module));
    expect(codes(issues)).toEqual(['version-mismatch']);
    expect(issues[0].message).toContain('test.src@2');
  });

  it('rejects duplicate node ids', () => {
    const src = source('test.src', 'text');
    const issues = validateGraph(graph([nodeSpec('a', 'test.src'), nodeSpec('a', 'test.src')]), reg(src.module));
    expect(codes(issues)).toContain('duplicate-node');
  });

  it('rejects cycles, naming the nodes involved', () => {
    const pipe = mod({
      type: 'test.pipe',
      inputs: [{ id: 'in', type: 'json', required: false }],
      outputs: [{ id: 'out', type: 'json' }],
      execute: async () => ({ out: null }),
    });
    const g = graph(
      [nodeSpec('a', 'test.pipe'), nodeSpec('b', 'test.pipe')],
      [edge('a.out', 'b.in'), edge('b.out', 'a.in')],
    );
    const issues = validateGraph(g, reg(pipe));
    const cycle = issues.find((i) => i.code === 'cycle');
    expect(cycle).toBeDefined();
    expect(cycle!.message).toContain('a');
    expect(cycle!.message).toContain('b');
  });

  it('rejects a self-loop as a cycle', () => {
    const pipe = mod({
      type: 'test.pipe',
      inputs: [{ id: 'in', type: 'json', required: false }],
      outputs: [{ id: 'out', type: 'json' }],
      execute: async () => ({ out: null }),
    });
    const issues = validateGraph(graph([nodeSpec('a', 'test.pipe')], [edge('a.out', 'a.in')]), reg(pipe));
    expect(codes(issues)).toContain('cycle');
  });

  it('rejects edges referencing unknown nodes and ports with bad-edge', () => {
    const src = source('test.src', 'text');
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const g = graph(
      [nodeSpec('a', 'test.src'), nodeSpec('b', 'test.rec')],
      [edge('ghost.out', 'b.in'), edge('a.nope', 'b.in'), edge('a.out', 'b.nope')],
    );
    const issues = validateGraph(g, reg(src.module, rec.module));
    const badEdges = issues.filter((i) => i.code === 'bad-edge');
    expect(badEdges).toHaveLength(3);
    expect(badEdges[0].message).toContain('unknown node "ghost"');
    expect(badEdges[1].message).toContain('unknown output port "nope"');
    expect(badEdges[2].message).toContain('unknown input port "nope"');
  });

  it('rejects multiple edges into a non-variadic input with multi-edge', () => {
    const src = source('test.src', 'text');
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const g = graph(
      [nodeSpec('a', 'test.src'), nodeSpec('b', 'test.src'), nodeSpec('c', 'test.rec')],
      [edge('a.out', 'c.in'), edge('b.out', 'c.in')],
    );
    const issues = validateGraph(g, reg(src.module, rec.module));
    expect(codes(issues)).toContain('multi-edge');
  });

  it('allows multiple edges into a variadic input', () => {
    const src = source('test.src', 'text');
    const rec = recorder('test.rec', [{ id: 'items', type: 'text', variadic: true }]);
    const g = graph(
      [nodeSpec('a', 'test.src'), nodeSpec('b', 'test.src'), nodeSpec('c', 'test.rec')],
      [edge('a.out', 'c.items'), edge('b.out', 'c.items')],
    );
    expect(validateGraph(g, reg(src.module, rec.module))).toEqual([]);
  });

  it('rejects incompatible port types with type-mismatch, including the reason', () => {
    const src = source('test.src', 'number');
    const rec = recorder('test.rec', [{ id: 'in', type: 'boolean' }]);
    const g = graph([nodeSpec('a', 'test.src'), nodeSpec('b', 'test.rec')], [edge('a.out', 'b.in')]);
    const issues = validateGraph(g, reg(src.module, rec.module));
    expect(codes(issues)).toEqual(['type-mismatch']);
    expect(issues[0].message).toContain('number does not connect to boolean');
  });

  it('accepts unchecked (any) connections as legal', () => {
    const src = source('test.src', 'any');
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const g = graph([nodeSpec('a', 'test.src'), nodeSpec('b', 'test.rec')], [edge('a.out', 'b.in')]);
    expect(validateGraph(g, reg(src.module, rec.module))).toEqual([]);
  });

  it('rejects an unconnected required input with missing-input', () => {
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const issues = validateGraph(graph([nodeSpec('b', 'test.rec')]), reg(rec.module));
    expect(codes(issues)).toEqual(['missing-input']);
    expect(issues[0].message).toContain('"in"');
    expect(issues[0].message).toContain('"b"');
  });

  it('accepts an unconnected optional input', () => {
    const rec = recorder('test.rec', [{ id: 'in', type: 'text', required: false }]);
    expect(validateGraph(graph([nodeSpec('b', 'test.rec')]), reg(rec.module))).toEqual([]);
  });
});

describe('startRun validation gate', () => {
  it('throws GraphValidationError carrying the issues', () => {
    const vs = createVirtualScheduler();
    const g = graph([nodeSpec('a', 'test.nope')]);
    try {
      startRun(g, { registry: reg(), scheduler: vs.hooks });
      expect.unreachable('startRun should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphValidationError);
      expect(codes((err as GraphValidationError).issues)).toContain('unknown-type');
    }
  });

  it('throws unknown-target for a target id not in the graph', () => {
    const vs = createVirtualScheduler();
    const src = source('test.src', 'text');
    const g = graph([nodeSpec('a', 'test.src', { value: 'x' })]);
    try {
      startRun(g, { registry: reg(src.module), scheduler: vs.hooks, targets: ['zzz'] });
      expect.unreachable('startRun should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphValidationError);
      const issues = (err as GraphValidationError).issues;
      expect(codes(issues)).toContain('unknown-target');
      expect(issues.find((i) => i.code === 'unknown-target')!.message).toContain('"zzz"');
    }
  });

  it('does not throw on a valid graph', async () => {
    const vs = createVirtualScheduler();
    const src = source('test.src', 'text');
    const handle = startRun(graph([nodeSpec('a', 'test.src', { value: 'x' })]), {
      registry: reg(src.module),
      scheduler: vs.hooks,
    });
    const result = await handle.done;
    expect(result.status).toBe('succeeded');
  });

  it('probe module used elsewhere validates cleanly end to end', () => {
    const src = source('test.src', 'number');
    const double = probe('test.double', 'number', 'number', (v) => (v as number) * 2);
    const g = graph([nodeSpec('a', 'test.src'), nodeSpec('b', 'test.double')], [edge('a.out', 'b.in')]);
    expect(validateGraph(g, reg(src.module, double.module))).toEqual([]);
  });
});
