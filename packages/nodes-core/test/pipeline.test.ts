/**
 * Registration, end-to-end typing, and determinism of the built-in node set —
 * and the load-bearing negative: `registerCoreNodes` must register no
 * `aec.review.*` type, because those ship in plugins/aec-review (ADR-0008).
 */
import { describe, expect, it } from 'vitest';
import { createNodeRegistry, type AssetRef, type NodeModule } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import { isValueOfType } from '@archspace/types';
import {
  coreNodeTypes,
  generateBimModelNode,
  generateComplianceReportNode,
  generateFloorPlanNode,
  projectBriefNode,
  registerCoreNodes,
  spaceProgramNode,
  type FloorPlanResult,
} from '../src/index.js';
import { toValue } from '../src/util.js';
import { reviewFixture, runPipeline } from './helpers.js';

/** The id the review node carried before it moved out of this package. */
const PRE_MOVE_REVIEW_TYPE = 'aec.code_compliance_review';

describe('registerCoreNodes', () => {
  it('registers exactly the node types coreNodeTypes() advertises, with valid manifests', () => {
    const registry = createNodeRegistry();
    // The registry itself enforces manifest validity (port types parse,
    // unique ids, valid versions) — registration throwing would fail here.
    registerCoreNodes(registry);
    // Asserted against coreNodeTypes() rather than a literal list: a duplicated
    // literal here was already wrong once (it still named the moved review node
    // and predated the ai.* set), and a copy of the roster is a copy that rots.
    const types = coreNodeTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(registry.manifests().map((m) => m.type).sort()).toEqual(types);
    for (const type of types) expect(registry.has(type)).toBe(true);
  });

  it('registers no aec.review.* type — the review discipline ships as a plugin', () => {
    const registry = createNodeRegistry();
    registerCoreNodes(registry);

    const registered = registry.manifests().map((m) => m.type);
    // Assert the registry is actually populated first. Without this the
    // filters below are satisfied by an empty registry, which would make the
    // one test guarding the plugin boundary pass in precisely the situation
    // where registration had broken entirely.
    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toContain('aec.generate_floor_plan');
    expect(registered.filter((t) => t.startsWith('aec.review.'))).toEqual([]);
    expect(coreNodeTypes().filter((t) => t.startsWith('aec.review.'))).toEqual([]);
    // Named explicitly: re-adding either the plugin's id or the pre-move one
    // would put nodes-core back on the wrong side of the boundary.
    expect(registry.has('aec.review.code_compliance')).toBe(false);
    expect(registry.has(PRE_MOVE_REVIEW_TYPE)).toBe(false);
  });

  it('runs end-to-end with default params and every output conforms to its port type', async () => {
    const run = await runPipeline();
    const cases: [NodeModule<never> | NodeModule<unknown>, RunNodeResult<unknown>][] = [
      [projectBriefNode as NodeModule<unknown>, run.brief],
      [spaceProgramNode as NodeModule<unknown>, run.program],
      [generateFloorPlanNode as NodeModule<unknown>, run.plan],
      [generateBimModelNode as NodeModule<unknown>, run.bim],
      [generateComplianceReportNode as NodeModule<unknown>, run.report],
    ];
    for (const [mod, result] of cases) {
      for (const port of mod.manifest.outputs) {
        expect(
          isValueOfType(result.outputs[port.id], port.type),
          `${mod.manifest.type}.${port.id} conforms to ${port.type}`,
        ).toBe(true);
      }
    }
  });
});

describe('input immutability', () => {
  it('the report node does not mutate the review it was handed', async () => {
    // Comparing the review across two runs cannot catch this — each run builds
    // a fresh fixture, so a mutation in the first is invisible in the second.
    // The only way to see it is to hold one object across the call.
    const review = reviewFixture();
    const before = JSON.stringify(review);

    const brief = await runNode(projectBriefNode, {});
    await runNode(generateComplianceReportNode, {
      params: { mock_latency_ms: 0 },
      inputs: { brief: brief.outputs.brief, review: toValue(review) },
    });

    // A node that edits its input corrupts every other consumer of that wire,
    // and the engine hands the same value to each downstream node (§7.2).
    expect(JSON.stringify(review)).toBe(before);
  });
});

describe('determinism', () => {
  it('identical params ⇒ deep-equal outputs, identical IFC bytes, identical GUIDs', async () => {
    const a = await runPipeline();
    const b = await runPipeline();

    expect(b.brief.outputs).toEqual(a.brief.outputs);
    expect(b.program.outputs).toEqual(a.program.outputs);
    expect(b.plan.outputs).toEqual(a.plan.outputs);
    expect(b.bim.outputs).toEqual(a.bim.outputs); // covers the GUIDs in summary
    expect(b.report.outputs).toEqual(a.report.outputs);

    const refA = a.bim.outputs.model as AssetRef;
    const refB = b.bim.outputs.model as AssetRef;
    expect(refB.hash).toBe(refA.hash);
    const bytesA = await a.assets.bytes(refA);
    const bytesB = await b.assets.bytes(refB);
    expect(Buffer.from(bytesB).equals(Buffer.from(bytesA))).toBe(true);
  });

  it('a different seed produces a different planId', async () => {
    const a = await runPipeline();
    const c = await runPipeline({ plan: { seed: 8 } });
    const planA = a.plan.outputs.floor_plan as unknown as FloorPlanResult;
    const planC = c.plan.outputs.floor_plan as unknown as FloorPlanResult;
    expect(planA.planId).toMatch(/^plan_[0-9a-f]{8}$/);
    expect(planC.planId).toMatch(/^plan_[0-9a-f]{8}$/);
    expect(planC.planId).not.toBe(planA.planId);
  });
});
