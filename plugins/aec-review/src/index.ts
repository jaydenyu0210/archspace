/**
 * Plugin entry point — the shape the Archspace plugin loader expects
 * (ARCHITECTURE §8.2): a module whose default export (or named `nodes`
 * export) is an array of NodeModule.
 *
 * This is a FIRST-PARTY plugin that is nevertheless a real one. It is loaded
 * out of process through the same manifest, consent and RPC path a third-party
 * plugin takes, with no privileged shortcut — which is the only way to know
 * the boundary carries real work (ARCHITECTURE §8.2, ADR-0008).
 *
 * Every node here is a MOCK of a discipline-review engine. The output shapes
 * (ReviewResult / ReviewFinding, re-used from @archspace/nodes-core/shapes)
 * are the contract a real review backend must satisfy, and each manifest
 * description says so where a user can read it.
 */
import type { NodeModule } from '@archspace/node-sdk';
import { accessibilityReviewNode } from './accessibility-review.js';
import { codeComplianceReviewNode } from './compliance-review.js';
import { energyPerformanceReviewNode } from './energy-review.js';
import { filterFindingsNode } from './filter-findings.js';
import { mergeFindingsNode } from './merge-findings.js';
import { structuralReviewNode } from './structural-review.js';
import { zoningReviewNode } from './zoning-review.js';

export { accessibilityReviewNode, type AccessibilityReviewParams } from './accessibility-review.js';
export { codeComplianceReviewNode, type CodeComplianceReviewParams } from './compliance-review.js';
export { energyPerformanceReviewNode, type EnergyPerformanceReviewParams } from './energy-review.js';
export { filterFindingsNode, type FilterFindingsParams } from './filter-findings.js';
export { mergeFindingsNode, type MergeFindingsParams } from './merge-findings.js';
export { structuralReviewNode, type StructuralReviewParams } from './structural-review.js';
export { zoningReviewNode, type ZoningReviewParams } from './zoning-review.js';

export const nodes: NodeModule<unknown>[] = [
  codeComplianceReviewNode,
  accessibilityReviewNode,
  zoningReviewNode,
  structuralReviewNode,
  energyPerformanceReviewNode,
  filterFindingsNode,
  mergeFindingsNode,
] as NodeModule<unknown>[];

export default nodes;
