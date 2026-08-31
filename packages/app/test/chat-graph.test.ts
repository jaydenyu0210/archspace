/**
 * The graph the design chat runs.
 *
 * The panel promises "text in, model out" and shows nothing in between, which
 * makes this the only place the chain is written down. If an edge here is
 * wrong the chat does not draw a wrong building — it produces nothing, and the
 * panel reports whichever node was left without an input. So the shape is
 * pinned: the same four nodes, the same four edges, and the description
 * reaching the one node that reads it.
 */
import { describe, expect, it } from 'vitest';
import type { EngineEdgeSpec } from '@archspace/engine';
import { BIM_NODE, buildChatGraph, describeModel, CHAT_NODES } from '../src/renderer/src/chat-graph.js';

/** The engine's own `edgeLabel`, restated rather than exported for one test. */
const label = (e: EngineEdgeSpec): string => `${e.from.node}.${e.from.port} -> ${e.to.node}.${e.to.port}`;

describe('buildChatGraph', () => {
  it('wires text → brief → program → plan → model', () => {
    const graph = buildChatGraph('A four-storey library.');

    expect(graph.nodes.map((n) => n.type)).toEqual([
      'aec.brief_from_text',
      'aec.space_program',
      'aec.generate_floor_plan',
      'aec.generate_bim_model',
    ]);
    expect(graph.edges.map(label)).toEqual([
      'chat_brief.brief -> chat_program.brief',
      'chat_brief.brief -> chat_plan.brief',
      'chat_program.program -> chat_plan.program',
      'chat_plan.floor_plan -> chat_bim.floor_plan',
    ]);
  });

  it('puts the description on the only node that reads one', () => {
    const graph = buildChatGraph('A six-storey office on a 48 by 32 m plot.');
    const brief = graph.nodes.find((n) => n.id === CHAT_NODES.brief);

    expect(brief?.config?.['description']).toBe('A six-storey office on a 48 by 32 m plot.');
    // And nothing else carries a copy that could drift from it.
    for (const node of graph.nodes.filter((n) => n.id !== CHAT_NODES.brief)) {
      expect(JSON.stringify(node.config ?? {})).not.toContain('six-storey');
    }
  });

  it('names the node the panel reads its result out of', () => {
    // The panel looks under `run.previews[BIM_NODE]`, so the id it asks for
    // and the id it reads have to be the same one.
    const graph = buildChatGraph('x');
    expect(graph.nodes.some((n) => n.id === BIM_NODE)).toBe(true);
    expect(graph.edges.some((e) => e.to.node === BIM_NODE)).toBe(true);
  });

  it('leaves the layout on auto, so the chat is not a special case', () => {
    // A chat that forced `mock` would quietly be a worse product than the
    // canvas; one that forced `ai` would fail where the canvas degrades.
    const plan = buildChatGraph('x').nodes.find((n) => n.id === CHAT_NODES.plan);
    expect(plan?.config?.['backend']).toBe('auto');
  });

  it('drops the simulated latency the canvas nodes use for pacing', () => {
    for (const node of buildChatGraph('x').nodes) {
      const latency = node.config?.['mock_latency_ms'];
      if (latency !== undefined) expect(latency).toBe(0);
    }
  });

  it('passes a named profile down to both nodes that call a model', () => {
    const graph = buildChatGraph('x', 'fast');
    expect(graph.nodes.find((n) => n.id === CHAT_NODES.brief)?.config?.['profile']).toBe('fast');
    expect(graph.nodes.find((n) => n.id === CHAT_NODES.plan)?.config?.['profile']).toBe('fast');
  });
});

describe('describeModel', () => {
  it('reports the writer\'s own counts rather than recounting', () => {
    expect(
      describeModel({ storeys: 4, elementCounts: { IfcSpace: 28, IfcWall: 112, IfcDoor: 27 } }),
    ).toBe('4 storeys · 28 spaces · 112 walls · 27 doors');
  });

  it('says storey, not storeys, for one', () => {
    expect(describeModel({ storeys: 1, elementCounts: { IfcSpace: 5, IfcWall: 20, IfcDoor: 4 } })).toMatch(
      /^1 storey ·/,
    );
  });

  it('returns null rather than inventing a line for a shape it does not know', () => {
    expect(describeModel(null)).toBeNull();
    expect(describeModel('a model')).toBeNull();
    expect(describeModel({ storeys: 3 })).toBeNull();
  });
});
