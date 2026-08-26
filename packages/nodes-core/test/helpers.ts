/** Shared pipeline runner for the nodes-core test suite. */
import { createMemoryAssetStore, type MemoryAssetStore } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import {
  codeComplianceReviewNode,
  generateBimModelNode,
  generateComplianceReportNode,
  generateFloorPlanNode,
  projectBriefNode,
  spaceProgramNode,
} from '../src/index.js';

export interface PipelineOverrides {
  brief?: Record<string, unknown>;
  program?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  bim?: Record<string, unknown>;
  review?: Record<string, unknown>;
  report?: Record<string, unknown>;
}

export interface PipelineRun {
  assets: MemoryAssetStore;
  brief: RunNodeResult<unknown>;
  program: RunNodeResult<unknown>;
  plan: RunNodeResult<unknown>;
  bim: RunNodeResult<unknown>;
  review: RunNodeResult<unknown>;
  report: RunNodeResult<unknown>;
}

/** Run the full six-node pipeline, wiring each node's outputs downstream. */
export async function runPipeline(overrides: PipelineOverrides = {}): Promise<PipelineRun> {
  const assets = createMemoryAssetStore();

  const brief = await runNode(projectBriefNode, { params: overrides.brief, assets });
  const program = await runNode(spaceProgramNode, {
    params: overrides.program,
    inputs: { brief: brief.outputs.brief },
    assets,
  });
  const plan = await runNode(generateFloorPlanNode, {
    params: { mock_latency_ms: 0, ...overrides.plan },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
    assets,
  });
  const bim = await runNode(generateBimModelNode, {
    params: { mock_latency_ms: 0, ...overrides.bim },
    inputs: { floor_plan: plan.outputs.floor_plan },
    assets,
  });
  const review = await runNode(codeComplianceReviewNode, {
    params: { mock_latency_ms: 0, ...overrides.review },
    inputs: {
      floor_plan: plan.outputs.floor_plan,
      bim_summary: bim.outputs.summary,
      model: bim.outputs.model,
    },
    assets,
  });
  const report = await runNode(generateComplianceReportNode, {
    params: { mock_latency_ms: 0, ...overrides.report },
    inputs: { brief: brief.outputs.brief, review: review.outputs.result },
    assets,
  });

  return { assets, brief, program, plan, bim, review, report };
}
