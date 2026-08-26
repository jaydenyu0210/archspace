/**
 * The drift rule (ADR-0009 §5), and specifically the three cases that must NOT
 * be reported as drift. Getting those wrong is the failure that matters: a flag
 * that lights up whenever a server is offline is a flag users learn to ignore,
 * and then the one real schema change goes unreviewed too.
 */
import { describe, expect, it } from 'vitest';
import { driftedNodeIds, isNodeDrifted, type DriftableNode } from '../src/renderer/src/drift';

const node = (id: string, typeId: string, schemaHash?: string): DriftableNode => ({
  id,
  data: { typeId, ...(schemaHash !== undefined ? { schemaHash } : {}) },
});

describe('isNodeDrifted', () => {
  it('flags a node whose pinned schema has moved', () => {
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_old'), { 'mcp.formats.convert': 'h_new' })).toBe(true);
  });

  it('does not flag a node whose pinned schema still matches', () => {
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_same'), { 'mcp.formats.convert': 'h_same' })).toBe(false);
  });

  it('does not flag a node with no pinned hash', () => {
    // Pre-dates pinning, or is not an MCP node at all. Adopting the live hash
    // as a baseline here would manufacture agreement rather than detect it.
    expect(isNodeDrifted(node('n1', 'aec.project_brief'), { 'aec.project_brief': 'h_live' })).toBe(false);
  });

  it('does not flag a node whose server is simply not connected', () => {
    // No live hash for the type. That is reachability, which the MCP panel
    // reports — flagging it here would light up a whole document whenever a
    // server was offline.
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_old'), {})).toBe(false);
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_old'), { 'mcp.other.tool': 'h_x' })).toBe(false);
  });

  it('does not flag anything before the engine has reported', () => {
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_old'), {})).toBe(false);
  });

  it('clears once the pin is updated to the live schema', () => {
    const live = { 'mcp.formats.convert': 'h_new' };
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_old'), live)).toBe(true);
    // Re-saving re-pins, which is the documented way a user accepts a change.
    expect(isNodeDrifted(node('n1', 'mcp.formats.convert', 'h_new'), live)).toBe(false);
  });
});

describe('driftedNodeIds', () => {
  it('returns exactly the drifted ids from a mixed graph', () => {
    const nodes = [
      node('n_drift', 'mcp.formats.convert', 'h_old'),
      node('n_same', 'mcp.formats.convert', 'h_new'),
      node('n_unpinned', 'mcp.formats.convert'),
      node('n_core', 'aec.project_brief'),
      node('n_offline', 'mcp.gone.tool', 'h_whatever'),
    ];
    const drifted = driftedNodeIds(nodes, { 'mcp.formats.convert': 'h_new' });

    expect([...drifted]).toEqual(['n_drift']);
    // Stated explicitly: the graph is not empty and the others were genuinely
    // considered, so this is not passing by examining nothing.
    expect(nodes).toHaveLength(5);
    expect(drifted.has('n_same')).toBe(false);
    expect(drifted.has('n_unpinned')).toBe(false);
    expect(drifted.has('n_offline')).toBe(false);
  });

  it('is empty for an empty graph and for an empty hash map', () => {
    expect(driftedNodeIds([], { 'mcp.a.b': 'h' }).size).toBe(0);
    expect(driftedNodeIds([node('n1', 'mcp.a.b', 'h_old')], {}).size).toBe(0);
  });

  it('agrees with isNodeDrifted for every node it is given', () => {
    const live = { 'mcp.formats.convert': 'h_new', 'mcp.other.tool': 'h_o' };
    const nodes = [
      node('a', 'mcp.formats.convert', 'h_old'),
      node('b', 'mcp.formats.convert', 'h_new'),
      node('c', 'mcp.other.tool', 'h_old'),
      node('d', 'mcp.absent.tool', 'h_old'),
      node('e', 'core.thing'),
    ];
    const drifted = driftedNodeIds(nodes, live);
    for (const n of nodes) {
      expect(drifted.has(n.id), n.id).toBe(isNodeDrifted(n, live));
    }
  });
});
