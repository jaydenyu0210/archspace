/** Required assertion 9: input assembly — coercion, lift, variadic order,
 *  runtime-checked `any` edges, optional inputs. */
import { describe, expect, it } from 'vitest';
import { createVirtualScheduler, startRun } from '../src/index.js';
import { edge, eventsOf, finish, graph, nodeSpec, ofType, recorder, reg, source } from './helpers.js';

describe('input assembly', () => {
  it('coerces number → text: the receiver gets the string', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.num', 'number', 'never');
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const g = graph([nodeSpec('a', 'test.num', { value: 42 }), nodeSpec('b', 'test.rec')], [edge('a.out', 'b.in')]);

    const result = await finish(vs, startRun(g, { registry: reg(src.module, rec.module), scheduler: vs.hooks, runId: 'r1' }));

    expect(result.status).toBe('succeeded');
    expect(rec.seen).toEqual([{ in: '42' }]);
  });

  it('lifts text → list<text>: the receiver gets a one-element list', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.txt', 'text', 'never');
    const rec = recorder('test.rec', [{ id: 'in', type: 'list<text>' }]);
    const g = graph([nodeSpec('a', 'test.txt', { value: 'hi' }), nodeSpec('b', 'test.rec')], [edge('a.out', 'b.in')]);

    const result = await finish(vs, startRun(g, { registry: reg(src.module, rec.module), scheduler: vs.hooks, runId: 'r1' }));

    expect(result.status).toBe('succeeded');
    expect(rec.seen).toEqual([{ in: ['hi'] }]);
  });

  it('delivers variadic inputs in graph-edge order', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.txt', 'text', 'never');
    const rec = recorder('test.rec', [{ id: 'items', type: 'text', variadic: true }]);
    const nodes = [
      nodeSpec('a', 'test.txt', { value: 'x' }),
      nodeSpec('b', 'test.txt', { value: 'y' }),
      nodeSpec('c', 'test.txt', { value: 'z' }),
      nodeSpec('r', 'test.rec'),
    ];
    // Edge order deliberately differs from node order: c, a, b.
    const g = graph(nodes, [edge('c.out', 'r.items'), edge('a.out', 'r.items'), edge('b.out', 'r.items')]);

    const result = await finish(vs, startRun(g, { registry: reg(src.module, rec.module), scheduler: vs.hooks, runId: 'r1' }));

    expect(result.status).toBe('succeeded');
    expect(rec.seen).toEqual([{ items: ['z', 'x', 'y'] }]);
  });

  it('fails the RECEIVING node with invalid-input when an any edge delivers a type-violating value', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.any', 'any', 'never');
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const g = graph([nodeSpec('a', 'test.any', { value: 123 }), nodeSpec('b', 'test.rec')], [edge('a.out', 'b.in')]);
    const handle = startRun(g, { registry: reg(src.module, rec.module), scheduler: vs.hooks, runId: 'r1' });
    const events = eventsOf(handle);

    const result = await finish(vs, handle);

    expect(result.status).toBe('partial'); // sender succeeded, receiver failed
    const failed = ofType(events, 'node:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].nodeId).toBe('b');
    expect(failed[0].kind).toBe('invalid-input');
    expect(failed[0].willRetry).toBe(false);
    expect(failed[0].message).toContain('a.out -> b.in'); // names the edge
    expect(failed[0].message).toContain('"text"'); // names the expected type
    expect(failed[0].message).toContain('123'); // says what arrived
    expect(rec.seen).toHaveLength(0); // the receiver's execute never ran
  });

  it('accepts a conforming value through an any edge', async () => {
    const vs = createVirtualScheduler(1);
    const src = source('test.any', 'any', 'never');
    const rec = recorder('test.rec', [{ id: 'in', type: 'text' }]);
    const g = graph([nodeSpec('a', 'test.any', { value: 'legit' }), nodeSpec('b', 'test.rec')], [edge('a.out', 'b.in')]);

    const result = await finish(vs, startRun(g, { registry: reg(src.module, rec.module), scheduler: vs.hooks, runId: 'r1' }));

    expect(result.status).toBe('succeeded');
    expect(rec.seen).toEqual([{ in: 'legit' }]);
  });

  it('delivers undefined for optional unconnected inputs', async () => {
    const vs = createVirtualScheduler(1);
    const rec = recorder('test.rec', [
      { id: 'maybe', type: 'text', required: false },
      { id: 'many', type: 'text', variadic: true, required: false },
    ]);
    const g = graph([nodeSpec('r', 'test.rec')]);

    const result = await finish(vs, startRun(g, { registry: reg(rec.module), scheduler: vs.hooks, runId: 'r1' }));

    expect(result.status).toBe('succeeded');
    expect(rec.seen).toEqual([{ maybe: undefined, many: undefined }]);
  });
});
