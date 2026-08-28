/** Pre-run hard validation (ARCHITECTURE §6.2 checkpoint three + §7.1). */
import type { NodeManifest, NodeRegistry, PortDecl } from '@archspace/node-sdk';
import { resolvePromotions } from '@archspace/node-sdk/promotion';
import { assignable } from '@archspace/types';
import { edgeLabel, type EngineEdgeSpec, type EngineGraph, type EngineNodeSpec } from './graph.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string; // 'unknown-type' | 'version-mismatch' | 'cycle' | 'bad-edge' | 'bad-promotion' | 'type-mismatch' | 'missing-input' | 'multi-edge' | 'unknown-target' | 'duplicate-node'
  message: string;
  nodeId?: string;
  edge?: EngineEdgeSpec;
}

export class GraphValidationError extends Error {
  issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    const errors = issues.filter((i) => i.severity === 'error');
    super(`graph validation failed with ${errors.length} error(s): ${errors.map((i) => i.code).join(', ')}`);
    this.name = 'GraphValidationError';
    this.issues = issues;
  }
}

// NUL separates the two halves because it is the one character a node or port
// id can never contain, so `split` below is an exact inverse of this join —
// a ':' or '/' would collide the moment an id contained one.
const portKey = (node: string, port: string) => `${node}\u0000${port}`;

export function validateGraph(graph: EngineGraph, registry: NodeRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const specById = new Map<string, EngineNodeSpec>();
  const manifestById = new Map<string, NodeManifest>();
  // The EFFECTIVE input ports per node: declared inputs plus promoted params
  // (§5.1, ADR-0017). Derived once per node and read everywhere below, because
  // a graph that validates against one port list and executes against another
  // is the failure this whole design exists to prevent — `startRun` resolves
  // promotions from the same `(manifest, promoted)` pair for the same reason.
  const inputsById = new Map<string, PortDecl[]>();
  const inputPort = (nodeId: string, portId: string): PortDecl | undefined =>
    inputsById.get(nodeId)?.find((p) => p.id === portId);

  // Nodes: duplicates, unknown types, version pins.
  for (const node of graph.nodes) {
    if (specById.has(node.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-node',
        message: `duplicate node id "${node.id}"`,
        nodeId: node.id,
      });
      continue;
    }
    specById.set(node.id, node);
    const mod = registry.get(node.type);
    if (!mod) {
      issues.push({
        severity: 'error',
        code: 'unknown-type',
        message: `node "${node.id}" has unknown type "${node.type}"`,
        nodeId: node.id,
      });
      continue;
    }
    if (mod.manifest.version !== node.version) {
      issues.push({
        severity: 'error',
        code: 'version-mismatch',
        message:
          `node "${node.id}" pins ${node.type}@${node.version} but the registry provides ` +
          `version ${mod.manifest.version} (no migration in this build)`,
        nodeId: node.id,
      });
      continue; // the pinned contract is unknown — skip port-level checks for this node
    }
    manifestById.set(node.id, mod.manifest);
    const resolved = resolvePromotions(mod.manifest, node.promoted);
    inputsById.set(node.id, resolved.inputs);
    for (const issue of resolved.issues) {
      issues.push({
        severity: 'error',
        code: 'bad-promotion',
        message: `node "${node.id}": ${issue.message}`,
        nodeId: node.id,
      });
    }
  }

  // Edges: endpoint resolution, port existence, type compatibility.
  const edgesInto = new Map<string, EngineEdgeSpec[]>();
  for (const edge of graph.edges) {
    const label = edgeLabel(edge);
    const fromSpec = specById.get(edge.from.node);
    const toSpec = specById.get(edge.to.node);
    if (!fromSpec) {
      issues.push({
        severity: 'error',
        code: 'bad-edge',
        message: `edge ${label} references unknown node "${edge.from.node}"`,
        edge,
      });
    }
    if (!toSpec) {
      issues.push({
        severity: 'error',
        code: 'bad-edge',
        message: `edge ${label} references unknown node "${edge.to.node}"`,
        edge,
      });
    }
    const fromManifest = fromSpec ? manifestById.get(fromSpec.id) : undefined;
    const toManifest = toSpec ? manifestById.get(toSpec.id) : undefined;
    const fromPort = fromManifest?.outputs.find((p) => p.id === edge.from.port);
    const toPort = toSpec ? inputPort(toSpec.id, edge.to.port) : undefined;
    if (fromManifest && !fromPort) {
      issues.push({
        severity: 'error',
        code: 'bad-edge',
        message: `edge ${label} references unknown output port "${edge.from.port}" on node "${edge.from.node}"`,
        edge,
      });
    }
    if (toManifest && !toPort) {
      // Say which mistake it is. An edge into a name that is a *param* on the
      // target is the commonest hand-edit and the commonest merge casualty:
      // the promotion is one line away, and "unknown input port" is a dead end
      // in front of a one-line fix.
      const param = toManifest.params.properties?.[edge.to.port];
      const promotable = param?.['x-archspace']?.promotable === true;
      issues.push({
        severity: 'error',
        code: 'bad-edge',
        message: promotable
          ? `edge ${label}: "${edge.to.port}" is a promotable param on ${toManifest.type}@${toManifest.version}, ` +
            `not yet an input port — add it to that node's "promoted:" list to expose it`
          : param !== undefined
            ? `edge ${label}: "${edge.to.port}" is a param on ${toManifest.type}@${toManifest.version} but is not ` +
              `promotable, so it cannot be wired; set it in the node's config instead`
            : `edge ${label} references unknown input port "${edge.to.port}" on node "${edge.to.node}"`,
        edge,
      });
    }
    // Recorded whether or not the port resolved. Gating this on `toPort` meant
    // a mistyped port name produced its accurate `bad-edge` AND a second,
    // false `missing-input` — because the required-input sweep below then saw
    // no incoming edge for a port the user had, in fact, wired. Two errors for
    // one mistake, one of them accusing innocent work.
    if (toSpec) {
      const key = portKey(edge.to.node, edge.to.port);
      const list = edgesInto.get(key) ?? [];
      list.push(edge);
      edgesInto.set(key, list);
    }
    if (fromPort && toPort) {
      const a = assignable(fromPort.type, toPort.type);
      if (!a.ok) {
        issues.push({
          severity: 'error',
          code: 'type-mismatch',
          message: `edge ${label}: ${a.reason}`,
          edge,
        });
      }
    }
  }

  // Multiple edges into a non-variadic input: one source of truth per input.
  for (const [key, list] of edgesInto) {
    if (list.length <= 1) continue;
    const [nodeId, portId] = key.split('\u0000');
    const port = inputPort(nodeId, portId);
    if (port && !port.variadic) {
      issues.push({
        severity: 'error',
        code: 'multi-edge',
        message: `input "${portId}" on node "${nodeId}" has ${list.length} incoming edges but is not variadic`,
        nodeId,
        edge: list[1],
      });
    }
  }

  // Required inputs must be wired. A PROMOTED input never lands here: it is
  // always `required: false`, because the configured param (or its schema
  // default) is the value it falls back to — the seam this comment used to
  // describe as "params are defaults-only in this build" (ADR-0017).
  for (const node of graph.nodes) {
    const manifest = manifestById.get(node.id);
    if (!manifest || specById.get(node.id) !== node) continue;
    // Effective inputs, so a promoted port is never "required" — a promoted
    // param has its configured value or its schema default behind it, which is
    // exactly what "a wired value overrides the configured one" means.
    for (const port of inputsById.get(node.id) ?? manifest.inputs) {
      if (port.required === false) continue;
      if ((edgesInto.get(portKey(node.id, port.id)) ?? []).length === 0) {
        issues.push({
          severity: 'error',
          code: 'missing-input',
          message: `required input "${port.id}" on node "${node.id}" has no incoming edge`,
          nodeId: node.id,
        });
      }
    }
  }

  // Cycles: DAG only (ADR-0007).
  for (const cycle of findCycles(graph, specById)) {
    issues.push({
      severity: 'error',
      code: 'cycle',
      message: `graph contains a cycle involving: ${cycle.join(' -> ')} -> ${cycle[0]}`,
      nodeId: cycle[0],
    });
  }

  return issues;
}

/** Tarjan SCC — every component with >1 node (or a self-loop) is a cycle. */
function findCycles(graph: EngineGraph, specById: Map<string, EngineNodeSpec>): string[][] {
  const out = new Map<string, string[]>();
  const selfLoops = new Set<string>();
  for (const edge of graph.edges) {
    if (!specById.has(edge.from.node) || !specById.has(edge.to.node)) continue;
    if (edge.from.node === edge.to.node) selfLoops.add(edge.from.node);
    const list = out.get(edge.from.node) ?? [];
    list.push(edge.to.node);
    out.set(edge.from.node, list);
  }

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function strongconnect(v: string): void {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1 || selfLoops.has(v)) cycles.push(component.reverse());
    }
  }

  for (const id of specById.keys()) {
    if (!idx.has(id)) strongconnect(id);
  }
  return cycles;
}
