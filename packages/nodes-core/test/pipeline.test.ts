/** Registration, end-to-end typing, and determinism of the aec.* pipeline. */
import { describe, expect, it } from 'vitest';
import { createNodeRegistry, type AssetRef, type NodeModule } from '@archspace/node-sdk';
import { isValueOfType } from '@archspace/types';
import {
  codeComplianceReviewNode,
  generateBimModelNode,
  generateComplianceReportNode,
  generateFloorPlanNode,
  projectBriefNode,
  registerCoreNodes,
  spaceProgramNode,
  type FloorPlanResult,
} from '../src/index.js';
import { runPipeline, type PipelineRun } from './helpers.js';

const SIX_TYPES = [
  'aec.code_compliance_review',
  'aec.generate_bim_model',
  'aec.generate_compliance_report',
  'aec.generate_floor_plan',
  'aec.project_brief',
  'aec.space_program',
];

describe('registerCoreNodes', () => {
  it('registers exactly the six aec node types with valid manifests', () => {
    const registry = createNodeRegistry();
    // The registry itself enforces manifest validity (port types parse,
    // unique ids, valid versions) — registration throwing would fail here.
    registerCoreNodes(registry);
    expect(registry.manifests().map((m) => m.type).sort()).toEqual(SIX_TYPES);
    for (const type of SIX_TYPES) expect(registry.has(type)).toBe(true);
  });

  it('runs end-to-end with default params and every output conforms to its port type', async () => {
    const run = await runPipeline();
    const cases: [NodeModule<never> | NodeModule<unknown>, keyof PipelineRun][] = [
      [projectBriefNode as NodeModule<unknown>, 'brief'],
      [spaceProgramNode as NodeModule<unknown>, 'program'],
      [generateFloorPlanNode as NodeModule<unknown>, 'plan'],
      [generateBimModelNode as NodeModule<unknown>, 'bim'],
      [codeComplianceReviewNode as NodeModule<unknown>, 'review'],
      [generateComplianceReportNode as NodeModule<unknown>, 'report'],
    ];
    for (const [mod, key] of cases) {
      const outputs = (run[key] as { outputs: Record<string, unknown> }).outputs;
      for (const port of mod.manifest.outputs) {
        expect(
          isValueOfType(outputs[port.id], port.type),
          `${mod.manifest.type}.${port.id} conforms to ${port.type}`,
        ).toBe(true);
      }
    }
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
    expect(b.review.outputs).toEqual(a.review.outputs);
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
