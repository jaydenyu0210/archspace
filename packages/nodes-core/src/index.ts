/**
 * @archspace/nodes-core — the built-in node set.
 *
 * Two namespaces live here:
 *
 *   aec.*  concept-design nodes (plan → generate → modify → report). The
 *          generate/modify nodes are deterministic mocks standing in for real
 *          generative backends; their output shapes (shapes.ts) are the
 *          contract a real backend must return, and every such manifest says
 *          so in its description.
 *   ai.*   provider-agnostic model calls built on ctx.ai (ARCHITECTURE §10).
 *          These are NOT mocks: they reach whichever provider the user's model
 *          profile names, and fail with a clear message when none is bound.
 *
 * The `aec.review.*` discipline reviews deliberately do NOT live here — they
 * ship as a first-party out-of-process plugin (plugins/aec-review), which is
 * how the plugin boundary earns its keep (ARCHITECTURE §8.2).
 */
import type { NodeModule, NodeRegistry } from '@archspace/node-sdk';

import { adjacencyMatrixNode } from './adjacency-matrix.js';
import { applyPlanFixesNode } from './apply-plan-fixes.js';
import { compareReviewsNode } from './compare-reviews.js';
import { exportDxfNode } from './export-dxf.js';
import { exportTableCsvNode } from './export-csv.js';
import { generateBimModelNode } from './bim-model.js';
import { generateComplianceReportNode } from './compliance-report.js';
import { generateFloorPlanNode } from './floor-plan.js';
import { generateMassingNode } from './massing.js';
import { generateRoomScheduleNode } from './room-schedule.js';
import { generateStructuralGridNode } from './structural-grid.js';
import { parkingEstimateNode } from './parking-estimate.js';
import { projectBriefNode } from './project-brief.js';
import { siteConstraintsNode } from './site-constraints.js';
import { spaceProgramNode } from './space-program.js';

import { aiGenerateTextNode } from './ai-generate-text.js';
import { aiGenerateObjectNode } from './ai-generate-object.js';
import { aiExtractTableNode } from './ai-extract-table.js';
import { aiEmbedNode } from './ai-embed.js';

export * from './shapes.js';

export { adjacencyMatrixNode, type AdjacencyMatrixParams } from './adjacency-matrix.js';
export { applyPlanFixesNode, type ApplyPlanFixesParams } from './apply-plan-fixes.js';
export { compareReviewsNode, type CompareReviewsParams } from './compare-reviews.js';
export { exportDxfNode, type ExportDxfParams } from './export-dxf.js';
export { exportTableCsvNode, type ExportTableCsvParams } from './export-csv.js';
export { generateBimModelNode, type GenerateBimModelParams } from './bim-model.js';
export { generateComplianceReportNode, type GenerateComplianceReportParams } from './compliance-report.js';
export { generateFloorPlanNode, type GenerateFloorPlanParams } from './floor-plan.js';
export { generateMassingNode, type GenerateMassingParams } from './massing.js';
export { generateRoomScheduleNode, type GenerateRoomScheduleParams } from './room-schedule.js';
export { generateStructuralGridNode, type GenerateStructuralGridParams } from './structural-grid.js';
export { parkingEstimateNode, type ParkingEstimateParams } from './parking-estimate.js';
export { projectBriefNode, type ProjectBriefParams } from './project-brief.js';
export { siteConstraintsNode, type SiteConstraintsParams } from './site-constraints.js';
export { spaceProgramNode, type SpaceProgramParams } from './space-program.js';

export { aiGenerateTextNode, type AiGenerateTextParams } from './ai-generate-text.js';
export { aiGenerateObjectNode, type AiGenerateObjectParams } from './ai-generate-object.js';
export { aiExtractTableNode, type AiExtractTableParams } from './ai-extract-table.js';
export { aiEmbedNode, type AiEmbedParams } from './ai-embed.js';

/** The deterministic `aec.*` design nodes. No network, no model, no keys. */
const AEC_NODES: readonly NodeModule<unknown>[] = [
  projectBriefNode,
  siteConstraintsNode,
  spaceProgramNode,
  adjacencyMatrixNode,
  parkingEstimateNode,
  generateMassingNode,
  generateFloorPlanNode,
  generateStructuralGridNode,
  generateBimModelNode,
  applyPlanFixesNode,
  generateRoomScheduleNode,
  exportTableCsvNode,
  exportDxfNode,
  compareReviewsNode,
  generateComplianceReportNode,
] as NodeModule<unknown>[];

/** The `ai.*` nodes. These call real providers through ctx.ai (§10). */
const AI_NODES: readonly NodeModule<unknown>[] = [
  aiGenerateTextNode,
  aiGenerateObjectNode,
  aiExtractTableNode,
  aiEmbedNode,
] as NodeModule<unknown>[];

/** Every built-in node type id, for tests and docs. */
export function coreNodeTypes(): string[] {
  return [...AEC_NODES, ...AI_NODES].map((m) => m.manifest.type).sort();
}

/** Register every built-in node on the given registry. */
export function registerCoreNodes(registry: NodeRegistry): void {
  for (const mod of [...AEC_NODES, ...AI_NODES]) {
    registry.register(mod);
  }
}
