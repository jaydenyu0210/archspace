import { describe, expect, it } from 'vitest';
import { deriveRequires } from '../src/index.js';
import type { DocNode } from '../src/index.js';

const node = (id: string, type: string, config: Record<string, unknown> = {}): DocNode => ({
  id,
  type,
  version: 1,
  config,
});

describe('deriveRequires', () => {
  it('mcp.<server>.<tool> contributes the server name', () => {
    expect(deriveRequires([node('n_a', 'mcp.revit.query_model')])).toEqual({
      mcp: ['revit'],
      ai: [],
      plugins: [],
    });
  });

  it('ai.* contributes config.profile ?? "default"', () => {
    expect(deriveRequires([node('n_a', 'ai.generate_text')])).toEqual({
      mcp: [],
      ai: ['default'],
      plugins: [],
    });
    expect(deriveRequires([node('n_a', 'ai.generate_text', { profile: 'fast' })])).toEqual({
      mcp: [],
      ai: ['fast'],
      plugins: [],
    });
  });

  it('non-reserved first segments are plugin namespaces', () => {
    expect(deriveRequires([node('n_a', 'acme.pointcloud.load')])).toEqual({
      mcp: [],
      ai: [],
      plugins: ['acme'],
    });
  });

  it('reserved first segments (core, ai, mcp, aec) are not plugins', () => {
    expect(deriveRequires([node('n_a', 'aec.project_brief')])).toEqual({
      mcp: [],
      ai: [],
      plugins: [],
    });
    expect(
      deriveRequires([
        node('n_a', 'core.note'),
        node('n_b', 'mcp.tekla.export'),
        node('n_c', 'ai.generate_text', { profile: 'default' }),
      ]),
    ).toEqual({ mcp: ['tekla'], ai: ['default'], plugins: [] });
  });

  it('sorts and dedupes each list', () => {
    const r = deriveRequires([
      node('n_a', 'mcp.tekla.export'),
      node('n_b', 'mcp.revit.query_model'),
      node('n_c', 'mcp.revit.set_params'),
      node('n_d', 'ai.generate_text', { profile: 'fast' }),
      node('n_e', 'ai.generate_text'),
      node('n_f', 'ai.classify'),
      node('n_g', 'zeta.thing'),
      node('n_h', 'acme.pointcloud.load'),
      node('n_i', 'acme.mesh.decimate'),
    ]);
    expect(r).toEqual({
      mcp: ['revit', 'tekla'],
      ai: ['default', 'fast'],
      plugins: ['acme', 'zeta'],
    });
  });

  it('empty node list derives empty requires', () => {
    expect(deriveRequires([])).toEqual({ mcp: [], ai: [], plugins: [] });
  });
});
