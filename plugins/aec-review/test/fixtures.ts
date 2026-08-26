/**
 * Upstream fixtures for the aec-review suite.
 *
 * Every review here is run against output the real @archspace/nodes-core nodes
 * actually produced — brief → program → plan → BIM, and site → massing → grid.
 * Hand-writing a FloorPlanResult literal would have been shorter and is
 * rejected: it would let the reviews keep passing against a plan shape the
 * generators no longer emit, which is the failure mode these suites exist to
 * catch. The plugin depending on nodes-core is the legal direction of the
 * ADR-0008 boundary; the reverse is what must never happen.
 */
import { createMemoryAssetStore, type MemoryAssetStore, type Value } from '@archspace/node-sdk';
import { runNode } from '@archspace/node-sdk/testkit';
import {
  generateBimModelNode,
  generateFloorPlanNode,
  generateMassingNode,
  generateStructuralGridNode,
  projectBriefNode,
  siteConstraintsNode,
  spaceProgramNode,
} from '@archspace/nodes-core';
import type {
  BimModelSummary,
  FloorPlanResult,
  MassingResult,
  SiteConstraints,
  StructuralGridResult,
} from '@archspace/nodes-core/shapes';

/**
 * A one-storey, seven-room, six-door scheme. The default brief is a six-storey
 * 48 × 32 m block whose reviews run to hundreds of findings — true to life,
 * useless for an assertion that names a number. This site is small enough that
 * every finding of every review can be enumerated, and still a real generated
 * plan rather than a fixture literal.
 */
export const SMALL_BRIEF: Record<string, unknown> = {
  floors: 1,
  site_width_m: 20,
  site_depth_m: 12,
  target_gross_area_m2: 150,
};

export interface PlanFixture {
  assets: MemoryAssetStore;
  /** Wire values, ready to hand straight to a review node's inputs. */
  briefValue: Value;
  planValue: Value;
  bimSummaryValue: Value;
  modelValue: Value;
  /** The same values as typed views, for computing expectations. */
  plan: FloorPlanResult;
  bimSummary: BimModelSummary;
}

/** Run brief → program → floor plan → BIM model, sharing one asset store. */
export async function buildPlan(
  briefParams: Record<string, unknown> = {},
  planParams: Record<string, unknown> = {},
): Promise<PlanFixture> {
  const assets = createMemoryAssetStore();
  const brief = await runNode(projectBriefNode, { params: briefParams, assets });
  const program = await runNode(spaceProgramNode, { inputs: { brief: brief.outputs.brief }, assets });
  const plan = await runNode(generateFloorPlanNode, {
    params: { mock_latency_ms: 0, ...planParams },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
    assets,
  });
  const bim = await runNode(generateBimModelNode, {
    params: { mock_latency_ms: 0 },
    inputs: { floor_plan: plan.outputs.floor_plan },
    assets,
  });
  return {
    assets,
    briefValue: brief.outputs.brief,
    planValue: plan.outputs.floor_plan,
    bimSummaryValue: bim.outputs.summary,
    modelValue: bim.outputs.model,
    plan: plan.outputs.floor_plan as unknown as FloorPlanResult,
    bimSummary: bim.outputs.summary as unknown as BimModelSummary,
  };
}

export interface SiteFixture {
  constraintsValue: Value;
  massingValue: Value;
  constraints: SiteConstraints;
  massing: MassingResult;
}

/**
 * Run site constraints → massing. `wireConstraintsToMassing: false` lets the
 * massing be generated from the brief alone, which is how a footprint that
 * breaks the setbacks is produced without faking one.
 */
export async function buildSite(
  briefValue: Value,
  constraintsParams: Record<string, unknown> = {},
  options: { wireConstraintsToMassing?: boolean } = {},
): Promise<SiteFixture> {
  const constraints = await runNode(siteConstraintsNode, {
    params: constraintsParams,
    inputs: { brief: briefValue },
  });
  const massing = await runNode(generateMassingNode, {
    params: { mock_latency_ms: 0 },
    inputs: {
      brief: briefValue,
      constraints:
        options.wireConstraintsToMassing === false ? undefined : constraints.outputs.constraints,
    },
  });
  return {
    constraintsValue: constraints.outputs.constraints,
    massingValue: massing.outputs.massing,
    constraints: constraints.outputs.constraints as unknown as SiteConstraints,
    massing: massing.outputs.massing as unknown as MassingResult,
  };
}

export interface GridFixture {
  gridValue: Value;
  grid: StructuralGridResult;
}

/** Lay a structural grid over a generated plan. */
export async function buildGrid(
  planValue: Value,
  gridParams: Record<string, unknown> = {},
): Promise<GridFixture> {
  const grid = await runNode(generateStructuralGridNode, {
    params: { mock_latency_ms: 0, ...gridParams },
    inputs: { floor_plan: planValue },
  });
  return {
    gridValue: grid.outputs.grid,
    grid: grid.outputs.grid as unknown as StructuralGridResult,
  };
}
