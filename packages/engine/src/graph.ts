/** Engine-facing graph shape: the resolved semantic content of a workflow
 *  document (ARCHITECTURE §4), stripped of layout and metadata. */

export interface EngineNodeSpec {
  id: string;
  type: string;
  version: number;
  /** Params this instance exposes as input ports (§5.1, ADR-0017). Carried
   *  from the document verbatim; `resolvePromotions` turns it into ports. */
  promoted?: string[];
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

/**
 * The one document → graph mapping.
 *
 * There used to be three hand-written copies of this — two in the CLI (`run`
 * and `doctor`) and one in the app's store — which is how `archspace doctor`
 * and `archspace run` come to disagree about the same file. `EngineNodeSpec`'s
 * extra properties are structurally permitted, so a copy that forgot a field
 * type-checks, passes every test, and validates a graph the engine then
 * executes differently. One function, imported by all three.
 *
 * Typed against the shape rather than importing `@archspace/document`: the
 * engine does not depend on the document package and must not start, since
 * everything below the shell has to run from a graph a caller built by hand
 * (ADR-0013).
 */
export function toEngineGraph(doc: {
  nodes: readonly {
    id: string;
    type: string;
    version: number;
    promoted?: string[];
    config?: Record<string, unknown>;
  }[];
  edges: readonly { from: { node: string; port: string }; to: { node: string; port: string } }[];
}): EngineGraph {
  return {
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      version: n.version,
      ...(n.promoted !== undefined && n.promoted.length > 0 ? { promoted: [...n.promoted] } : {}),
      config: n.config ?? {},
    })),
    edges: doc.edges.map((e) => ({ from: { ...e.from }, to: { ...e.to } })),
  };
}
