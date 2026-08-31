/**
 * The graph behind the design chat: a description in, an IFC model out.
 *
 * The chat panel is not a second engine. It builds one ordinary `EngineGraph`
 * and runs it down the same MessagePort the canvas uses, so a chat run is a
 * workflow run in every respect the engine can see — same nodes, same
 * validation, same events, same asset store. What the chat removes is the
 * WIRING, not the machinery: four nodes and four edges that were identical
 * every time somebody wanted a building from a sentence.
 *
 * **Why the floor plan is still in here.** The panel promises "text in, model
 * out" and shows nothing between, but `aec.generate_bim_model` takes a
 * `floor_plan` and nothing else — the IFC's storeys, spaces, walls and doors
 * are all derived from plan geometry. Asking a model for that geometry
 * directly is the one thing this repo has consistently refused: a
 * `FloorPlanResult` is ~95 KB and some five thousand numbers under invariants
 * nothing validates, and a model's answer parses, renders, and is wrong in
 * ways only an IFC viewer reveals. So the plan step stays, computed by code
 * from a parti a model chose, and the user simply never has to draw the wire.
 *
 * Pure on purpose — no React, no store, no engine client — so
 * `test/chat-graph.test.ts` can pin the shape under plain node, the same
 * reason `plan-geometry.ts` and `ai-groups.ts` live outside their components.
 */
import type { EngineGraph } from '@archspace/engine';

/**
 * Stable node ids, not generated ones.
 *
 * The panel reads its result out of `run.previews[BIM_NODE]` after the run
 * finishes, so the id it looks under has to be the id it asked for. They are
 * prefixed to be unmistakable in a run log next to a canvas node's `n_k3v9qp`.
 */
export const CHAT_NODES = {
  brief: 'chat_brief',
  program: 'chat_program',
  plan: 'chat_plan',
  bim: 'chat_bim',
} as const;

/** Where the IFC comes out. The panel previews and saves this node's asset. */
export const BIM_NODE = CHAT_NODES.bim;

/**
 * Build the fixed chain for one description.
 *
 * `mock_latency_ms: 0` throughout: the pacing those params simulate is a
 * demonstration aid on the canvas, and in a chat it is just the answer
 * arriving late. The model call is the only wait worth having.
 */
export function buildChatGraph(description: string, profile = ''): EngineGraph {
  return {
    nodes: [
      {
        id: CHAT_NODES.brief,
        type: 'aec.brief_from_text',
        version: 1,
        config: { description, profile },
      },
      { id: CHAT_NODES.program, type: 'aec.space_program', version: 1, config: {} },
      {
        id: CHAT_NODES.plan,
        type: 'aec.generate_floor_plan',
        version: 1,
        // `auto`, so the parti comes from a model when one is bound and from
        // the deterministic layout when it is not — the same contract the
        // canvas node has, not a special case for the chat.
        config: { backend: 'auto', profile, mock_latency_ms: 0 },
      },
      {
        id: CHAT_NODES.bim,
        type: 'aec.generate_bim_model',
        version: 1,
        config: { mock_latency_ms: 0 },
      },
    ],
    edges: [
      { from: { node: CHAT_NODES.brief, port: 'brief' }, to: { node: CHAT_NODES.program, port: 'brief' } },
      { from: { node: CHAT_NODES.brief, port: 'brief' }, to: { node: CHAT_NODES.plan, port: 'brief' } },
      { from: { node: CHAT_NODES.program, port: 'program' }, to: { node: CHAT_NODES.plan, port: 'program' } },
      { from: { node: CHAT_NODES.plan, port: 'floor_plan' }, to: { node: CHAT_NODES.bim, port: 'floor_plan' } },
    ],
  };
}

/**
 * A one-line summary of what a finished run produced, for the transcript.
 *
 * Reads the BIM node's own `summary` output rather than counting anything
 * itself: that value is what the writer recorded, and a second count computed
 * here could disagree with it.
 */
export function describeModel(summary: unknown): string | null {
  if (typeof summary !== 'object' || summary === null) return null;
  const rec = summary as Record<string, unknown>;
  const storeys = typeof rec['storeys'] === 'number' ? rec['storeys'] : null;
  const counts = rec['elementCounts'];
  if (storeys === null || typeof counts !== 'object' || counts === null) return null;
  const c = counts as Record<string, unknown>;
  const n = (key: string): number => (typeof c[key] === 'number' ? c[key] : 0);
  return `${storeys} storey${storeys === 1 ? '' : 's'} · ${n('IfcSpace')} spaces · ${n('IfcWall')} walls · ${n('IfcDoor')} doors`;
}
