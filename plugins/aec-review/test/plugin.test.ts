/**
 * Pins the plugin boundary itself: the seven aec.review.* nodes register with
 * valid manifests under the namespace archspace-plugin.json declares, every
 * output inhabits its declared port type, nodes-core no longer carries any of
 * them, and identical inputs give byte-identical outputs.
 */
import { describe, expect, it } from 'vitest';
import { createNodeRegistry, type NodeModule, type Outputs, type Value } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import { registerCoreNodes } from '@archspace/nodes-core';
import type { ComplianceReviewResult } from '@archspace/nodes-core/shapes';
import pluginManifest from '../archspace-plugin.json';
import {
  accessibilityReviewNode,
  codeComplianceReviewNode,
  energyPerformanceReviewNode,
  filterFindingsNode,
  mergeFindingsNode,
  nodes,
  structuralReviewNode,
  zoningReviewNode,
} from '../src/index.js';
import defaultExport from '../src/index.js';
import { buildGrid, buildPlan, buildSite, SMALL_BRIEF } from './fixtures.js';
import { portTypeMismatches, unknownOutputPortTypes } from './port-types.js';

const SEVEN_TYPES = [
  'aec.review.accessibility',
  'aec.review.code_compliance',
  'aec.review.energy_performance',
  'aec.review.filter_findings',
  'aec.review.merge_findings',
  'aec.review.structural',
  'aec.review.zoning',
];

/** Port ids are snake_case by convention (node-sdk PortDecl). */
const PORT_ID = /^[a-z][a-z0-9_]*$/;

interface EveryNodeRun {
  pairs: [NodeModule<unknown>, Outputs][];
  outputsByType: Record<string, Outputs>;
}

/**
 * Drive all seven nodes once over one generated scheme, fanning the five
 * reviews into the merge and then the filter — the shape a real run takes.
 */
async function runEveryNode(): Promise<EveryNodeRun> {
  const fixture = await buildPlan(SMALL_BRIEF);
  const site = await buildSite(fixture.briefValue);
  const grid = await buildGrid(fixture.planValue);

  const code = await runNode(codeComplianceReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: {
      floor_plan: fixture.planValue,
      bim_summary: fixture.bimSummaryValue,
      model: fixture.modelValue,
    },
    assets: fixture.assets,
  });
  const accessibility = await runNode(accessibilityReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: { floor_plan: fixture.planValue, bim_summary: fixture.bimSummaryValue },
    assets: fixture.assets,
  });
  const zoning = await runNode(zoningReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: {
      constraints: site.constraintsValue,
      massing: site.massingValue,
      brief: fixture.briefValue,
    },
  });
  const structural = await runNode(structuralReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: { grid: grid.gridValue, floor_plan: fixture.planValue },
  });
  const energy = await runNode(energyPerformanceReviewNode, {
    params: { mock_latency_ms: 0 },
    inputs: { floor_plan: fixture.planValue, massing: site.massingValue },
  });
  const reviews: Value = [
    code.outputs.result,
    accessibility.outputs.result,
    zoning.outputs.result,
    structural.outputs.result,
    energy.outputs.result,
  ];
  const merged = await runNode(mergeFindingsNode, { inputs: { reviews } });
  const filtered = await runNode(filterFindingsNode, { inputs: { review: merged.outputs.result } });

  const pairs: [NodeModule<unknown>, Outputs][] = [
    [codeComplianceReviewNode as NodeModule<unknown>, code.outputs],
    [accessibilityReviewNode as NodeModule<unknown>, accessibility.outputs],
    [zoningReviewNode as NodeModule<unknown>, zoning.outputs],
    [structuralReviewNode as NodeModule<unknown>, structural.outputs],
    [energyPerformanceReviewNode as NodeModule<unknown>, energy.outputs],
    [mergeFindingsNode as NodeModule<unknown>, merged.outputs],
    [filterFindingsNode as NodeModule<unknown>, filtered.outputs],
  ];
  const outputsByType: Record<string, Outputs> = {};
  for (const [mod, outputs] of pairs) outputsByType[mod.manifest.type] = outputs;
  return { pairs, outputsByType };
}

describe('plugin entry point', () => {
  it('exports exactly the seven aec.review.* nodes, as `nodes` and as default', () => {
    expect(nodes.map((mod) => mod.manifest.type).sort()).toEqual(SEVEN_TYPES);
    expect(defaultExport).toBe(nodes);
  });

  it('registers every node — the registry is what validates the manifests', () => {
    const registry = createNodeRegistry();
    // register() enforces the type-id grammar, unique port ids per side,
    // positive integer versions and parseable port types; a bad manifest
    // throws here rather than reaching the engine.
    for (const mod of nodes) registry.register(mod);
    expect(registry.manifests().map((m) => m.type).sort()).toEqual(SEVEN_TYPES);
    for (const type of SEVEN_TYPES) expect(registry.has(type)).toBe(true);
  });

  it('keeps every node type inside the namespace archspace-plugin.json declares', () => {
    expect(pluginManifest.namespace).toBe('aec.review');
    for (const mod of nodes) {
      expect(mod.manifest.type.startsWith(`${pluginManifest.namespace}.`)).toBe(true);
    }
  });

  it('declares a manifest the loader and the UI can both use', () => {
    for (const mod of nodes) {
      const m = mod.manifest;
      expect(m.version, m.type).toBe(1);
      expect(m.label.length, m.type).toBeGreaterThan(0);
      expect(m.description.length, m.type).toBeGreaterThan(0);
      expect(m.category, m.type).toBe('Review');
      expect(m.params.type, m.type).toBe('object');
      expect(m.outputs.length, m.type).toBeGreaterThan(0);
      for (const port of [...m.inputs, ...m.outputs]) {
        expect(port.id, `${m.type}.${port.id}`).toMatch(PORT_ID);
        expect(port.label, `${m.type}.${port.id}`).toBeTruthy();
      }
    }
  });

  it('puts the five mock engines on the ai lane and the two fan-in nodes on cpu', () => {
    // The lane and the caching mode are the two things the scheduler reads off
    // a manifest, so they are pinned per node rather than as a loose set: a
    // review engine that claimed `pure` would be cached across runs it must
    // not be, and a fan-in that claimed `ai` would queue behind model calls.
    const expected: Record<string, { lane: string; caching: string }> = {
      'aec.review.code_compliance': { lane: 'ai', caching: 'never' },
      'aec.review.accessibility': { lane: 'ai', caching: 'never' },
      'aec.review.zoning': { lane: 'ai', caching: 'never' },
      'aec.review.structural': { lane: 'ai', caching: 'never' },
      'aec.review.energy_performance': { lane: 'ai', caching: 'never' },
      'aec.review.filter_findings': { lane: 'cpu', caching: 'pure' },
      'aec.review.merge_findings': { lane: 'cpu', caching: 'pure' },
    };
    for (const mod of nodes) {
      expect({ lane: mod.manifest.lane, caching: mod.manifest.caching }, mod.manifest.type).toEqual(
        expected[mod.manifest.type],
      );
    }
  });

  it('leaves no aec.review.* node behind in nodes-core (ADR-0008)', () => {
    const registry = createNodeRegistry();
    registerCoreNodes(registry);
    const coreTypes = registry.manifests().map((m) => m.type);
    expect(coreTypes.filter((type) => type.startsWith('aec.review.'))).toEqual([]);
    // The compliance review moved AND was renamed; the old id must be gone
    // from nodes-core rather than aliased there.
    expect(coreTypes).not.toContain('aec.code_compliance_review');
    expect(codeComplianceReviewNode.manifest.type).toBe('aec.review.code_compliance');
  });
});

describe('output port types', () => {
  it('models every output port type the plugin declares', () => {
    // If this fails the conformance assertion below has gone blind — see the
    // header of port-types.ts.
    for (const mod of nodes) expect(unknownOutputPortTypes(mod), mod.manifest.type).toEqual([]);
  });

  it('emits every declared output, each inhabiting its declared type', async () => {
    const { pairs } = await runEveryNode();
    expect(pairs).toHaveLength(SEVEN_TYPES.length);
    for (const [mod, outputs] of pairs) {
      expect(portTypeMismatches(mod, outputs)).toEqual([]);
      // No node may smuggle an undeclared output onto the wire.
      expect(Object.keys(outputs).sort()).toEqual(mod.manifest.outputs.map((p) => p.id).sort());
    }
  });
});

describe('determinism', () => {
  it('gives byte-identical outputs for identical inputs across every node', async () => {
    const first = await runEveryNode();
    const second = await runEveryNode();
    for (const type of SEVEN_TYPES) {
      // Byte-identical, not merely deep-equal: these are deterministic mock
      // engines, so key order and number formatting must match too — that is
      // what lets the engine cache and diff runs by content hash.
      expect(JSON.stringify(second.outputsByType[type]), type).toBe(
        JSON.stringify(first.outputsByType[type]),
      );
    }
  });

  it('derives the review id from the plan, so a different seed gives a different id', async () => {
    const a = await buildPlan(SMALL_BRIEF);
    const b = await buildPlan(SMALL_BRIEF, { seed: 99 });
    expect(b.plan.planId).not.toBe(a.plan.planId);

    const run = async (fixture: Awaited<ReturnType<typeof buildPlan>>): Promise<string> => {
      const review = await runNode(codeComplianceReviewNode, {
        params: { mock_latency_ms: 0 },
        inputs: { floor_plan: fixture.planValue, bim_summary: fixture.bimSummaryValue },
        assets: fixture.assets,
      });
      const result = review.outputs.result as unknown as ComplianceReviewResult;
      expect(result.reviewId).toMatch(/^rev_[0-9a-f]{8}$/);
      return result.reviewId;
    };
    expect(await run(b)).not.toBe(await run(a));
  });
});
