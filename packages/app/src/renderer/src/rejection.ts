/**
 * Turning a refused run into something the reader can act on
 * (ARCHITECTURE §7.1, §8 / ADR-0008).
 *
 * The engine's validation messages are precise and, on their own, a dead end.
 * A first launch opens the bundled example, the user presses Run, and gets:
 *
 *     Run refused: node "n_r9t3kv" has unknown type "aec.review.code_compliance"
 *
 * which is true and tells them nothing. The type is unknown because the plugin
 * that provides it ships with the app and has not been consented to yet — a
 * decision that is two clicks away in Settings → Plugins, and which nothing on
 * screen connects to what just failed. The CLI already learned this lesson and
 * says "re-run with --trust-plugin"; this is the same fix for the app.
 *
 * The rule is narrow on purpose. It only speaks up when it can name a plugin
 * that is actually installed and actually explains the missing type; anything
 * else falls through to the engine's own wording rather than guessing. A hint
 * that is sometimes wrong is worse than no hint, because it sends people to a
 * screen where nothing they do helps.
 *
 * Pure and DOM-free so it can be unit-tested in plain Node, for the same reason
 * `drift.ts` is: the interesting behaviour is the mapping, and it should not
 * need a window to check.
 */
import type { ValidationIssue } from '@archspace/engine';
import type { InstalledPluginInfo } from '@archspace/plugin-host';

/** The part of a canvas node this needs. `AppNode` satisfies it. */
export interface TypedNode {
  id: string;
  data: { typeId: string };
}

/** Does `typeId` live in this plugin's declared namespace? */
function providesType(plugin: InstalledPluginInfo, typeId: string): boolean {
  const ns = plugin.manifest.namespace;
  return ns !== '' && typeId.startsWith(`${ns}.`);
}

/**
 * Why a plugin that is present cannot supply its nodes, phrased as the next
 * thing to do. Returns null when the plugin is loaded — then the missing type
 * is not this plugin's fault and saying so would mislead.
 */
function pluginAdvice(plugin: InstalledPluginInfo): string | null {
  const name = plugin.manifest.displayName || plugin.id;
  switch (plugin.state) {
    case 'needs-consent':
      return `The “${name}” plugin provides that node type and is installed, but has not been enabled yet. Open Settings → Plugins to review what it asks for and turn it on.`;
    case 'disabled':
      return `The “${name}” plugin provides that node type and is switched off. Turn it back on in Settings → Plugins.`;
    case 'failed':
      return `The “${name}” plugin provides that node type but failed to load${plugin.error !== undefined ? `: ${sentence(plugin.error)}` : '.'} See Settings → Plugins.`;
    case 'incompatible':
      return `The “${name}” plugin provides that node type but was built for a different engine version. See Settings → Plugins.`;
    case 'loaded':
      return null;
  }
}

/**
 * End a quoted fragment so the sentence after it does not run on.
 *
 * A plugin's own error text is interpolated mid-sentence and then followed by
 * "See Settings → Plugins." — with no separator, that read "failed to load:
 * boom See Settings → Plugins." Adding a full stop unconditionally is the other
 * half of the bug, because plenty of errors already end in one.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The message to show when the engine refuses a run.
 *
 * `issues` is the engine's verdict, `nodes` the current canvas (to map a failing
 * node id to its type without parsing the message text), and `plugins` the
 * installed set as the engine last reported it.
 */
export function explainRejection(
  issues: readonly ValidationIssue[],
  nodes: readonly TypedNode[],
  plugins: readonly InstalledPluginInfo[],
): string {
  const base = issues[0]?.message ?? 'validation failed';

  for (const issue of issues) {
    if (issue.code !== 'unknown-type' || issue.nodeId === undefined) continue;
    const typeId = nodes.find((n) => n.id === issue.nodeId)?.data.typeId;
    if (typeId === undefined) continue;
    const plugin = plugins.find((p) => providesType(p, typeId));
    if (plugin === undefined) continue;
    const advice = pluginAdvice(plugin);
    if (advice !== null) return `${base}. ${advice}`;
  }

  return base;
}
