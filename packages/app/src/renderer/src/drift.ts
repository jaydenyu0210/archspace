/**
 * Tool-schema drift: which nodes were authored against a schema the server no
 * longer serves (ARCHITECTURE §9 / ADR-0009 §5).
 *
 * ADR-0009 decision 5 chose "detected, not absorbed": a node pins the hash of
 * the tool schema it was written against, and a live mismatch flags it for
 * review rather than silently re-mapping it. Re-mapping would be a guess about
 * what the user meant by parameters they filled in against a different shape,
 * and the app is not entitled to make it.
 *
 * This lives outside `store.ts` for one reason: `store.ts` imports
 * `@xyflow/react` for value, which drags a browser-shaped dependency into
 * anything that touches it. The rule here is pure — two strings and a
 * comparison — so keeping it here lets it be tested in plain Node with no DOM,
 * which is the difference between this being covered and not. `DriftableNode`
 * is structural for the same reason: `AppNode` satisfies it without this file
 * ever naming React Flow's `Node` type.
 */

/** The only part of a node this comparison needs. `AppNode` satisfies it. */
export interface DriftableNode {
  id: string;
  data: { typeId: string; schemaHash?: string };
}

/**
 * True when `node` pins a schema that the live one has moved away from.
 *
 * Three cases deliberately do NOT count as drift:
 *
 *  - **No pinned hash.** The node predates pinning, or is not an MCP node.
 *    There is no baseline, and adopting today's schema as one would
 *    manufacture agreement rather than detect it.
 *  - **No live hash for the type.** The server is not connected right now.
 *    That is a reachability problem the MCP settings panel already reports;
 *    treating it as drift would light up every node in a document whenever a
 *    server was merely offline, which trains users to ignore the flag.
 *  - **Equal hashes**, obviously — including when the user re-saves to accept
 *    a new schema, which re-pins and clears the flag.
 */
export function isNodeDrifted(node: DriftableNode, schemaHashes: Record<string, string>): boolean {
  const pinned = node.data.schemaHash;
  if (pinned === undefined) return false;
  const live = schemaHashes[node.data.typeId];
  return live !== undefined && live !== pinned;
}

/** Every drifted node in one pass, for callers rendering a whole graph. */
export function driftedNodeIds(
  nodes: readonly DriftableNode[],
  schemaHashes: Record<string, string>,
): Set<string> {
  const drifted = new Set<string>();
  for (const node of nodes) {
    if (isNodeDrifted(node, schemaHashes)) drifted.add(node.id);
  }
  return drifted;
}
