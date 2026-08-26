/**
 * The node registry this package does NOT have.
 *
 * `@archspace/autodesk` ships zero NodeModules, on purpose. Everything Autodesk
 * that actually works arrives as MCP tools — the host generates one node per
 * tool of a connected server (ARCHITECTURE §9.3) — and everything that does not
 * work must not be reachable from the canvas at all. An `autodesk.*` node whose
 * execute() threw would still show up in the palette, be wired into a workflow
 * and be saved into a document: a seam masquerading as a feature.
 *
 * This function exists so that "no nodes" is an explicit, testable export
 * rather than an absence someone later fills in by accident.
 */
import type { NodeModule } from '@archspace/node-sdk';

/** Always empty. See the file comment before changing that. */
export function autodeskNodeModules(): NodeModule[] {
  return [];
}
