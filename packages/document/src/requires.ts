import type { DocNode, WorkflowRequires } from './types.js';

/**
 * First dot-segments that the app itself owns, and which therefore never name
 * a plugin on their own: `core` and `ai` are built-in nodes, `mcp` is a
 * generated server tool, `aec` is the built-in design set.
 */
const RESERVED_NAMESPACES = new Set(['core', 'ai', 'mcp', 'aec']);

export interface DeriveRequiresOptions {
  /**
   * Namespace → plugin name, for the plugins installed on this machine.
   *
   * A plugin owns a namespace of any depth, so a node type alone cannot say
   * which plugin (if any) provides it: `aec.review.zoning` belongs to the
   * `aec-review` plugin, while `aec.project_brief` is built in. Passing the
   * installed set makes the derivation exact; without it, the heuristic below
   * applies, which is correct for the reserved namespaces and for
   * conventional single-segment plugin namespaces.
   *
   * Matching is longest-prefix-first, so a plugin may own a namespace nested
   * inside another plugin's.
   */
  pluginNamespaces?: Record<string, string>;
}

/**
 * Derive the `requires:` block from the node list.
 *
 * Derivation rule, keyed on each node's `type`:
 *   - `mcp.<server>.<tool>` → `<server>` is a logical MCP server name →
 *     `requires.mcp`;
 *   - `ai.*` → the node's `config.profile ?? "default"` is a model profile
 *     name → `requires.ai`;
 *   - a type under an installed plugin's namespace → that plugin's name →
 *     `requires.plugins`;
 *   - otherwise, a first segment outside the reserved set {core, ai, mcp, aec}
 *     is taken as a plugin namespace → `requires.plugins`.
 * Each list is sorted and deduped.
 *
 * `requires:` is recomputed from `nodes` on every emit/save; a parsed
 * document's own `requires:` values are only a parse artifact and are never
 * used for output (ARCHITECTURE §4.2 rule 7).
 */
export function deriveRequires(nodes: DocNode[], options: DeriveRequiresOptions = {}): WorkflowRequires {
  const mcp = new Set<string>();
  const ai = new Set<string>();
  const plugins = new Set<string>();

  // Longest namespace first: a nested plugin namespace must win over the
  // shorter one it sits inside.
  const namespaces = Object.entries(options.pluginNamespaces ?? {}).sort(
    (a, b) => b[0].length - a[0].length,
  );

  for (const node of nodes) {
    const segments = node.type.split('.');
    const first = segments[0];
    if (first === 'mcp') {
      if (segments.length > 1 && segments[1] !== '') mcp.add(segments[1]);
    } else if (first === 'ai') {
      // Only a string names a profile. `config` is Record<string, unknown>
      // and hand-editable, so anything else — a mapping a user mistyped, a
      // number — used to reach `String()` and put a value like
      // "[object Object]" into the requires block of the SAVED document,
      // where it would then be reported as a requirement this machine does
      // not satisfy. A malformed profile is treated as absent, which is the
      // same thing the gateway does with it.
      const profile = node.config?.['profile'];
      ai.add(typeof profile === 'string' && profile.trim() !== '' ? profile : 'default');
    }

    const owner = namespaces.find(([ns]) => node.type.startsWith(`${ns}.`));
    if (owner !== undefined) {
      plugins.add(owner[1]);
    } else if (first !== '' && !RESERVED_NAMESPACES.has(first)) {
      plugins.add(first);
    }
  }
  return { mcp: [...mcp].sort(), ai: [...ai].sort(), plugins: [...plugins].sort() };
}
