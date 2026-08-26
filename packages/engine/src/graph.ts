/** Engine-facing graph shape: the resolved semantic content of a workflow
 *  document (ARCHITECTURE §4), stripped of layout and metadata. */

export interface EngineNodeSpec {
  id: string;
  type: string;
  version: number;
  config?: Record<string, unknown>;
}

export interface EngineEdgeSpec {
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface EngineGraph {
  nodes: EngineNodeSpec[];
  edges: EngineEdgeSpec[];
}

export function edgeLabel(e: EngineEdgeSpec): string {
  return `${e.from.node}.${e.from.port} -> ${e.to.node}.${e.to.port}`;
}
