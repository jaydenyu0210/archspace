/**
 * The canonical form of a node entry's `promoted:` list (ARCHITECTURE §4.2
 * rule 1, ADR-0017).
 *
 * Its own leaf module for the same reason `edge`, `requires` and `yaml-util`
 * are: `extract`, `emit` and `save` all need it, and any of those three
 * importing another would close a cycle. It imports nothing.
 *
 * Sorted and deduped, because the field is a set and a set has one written
 * form. The sorting is not cosmetic — it is what makes rule 3's byte-identical
 * no-op save survive a hand-edited file. `saveWorkflow` re-extracts the CST it
 * is about to patch to get its diff baseline, so a file containing
 * `promoted: [b, a]` yields `['a','b']` on both sides of the comparison, the
 * diff is empty, and the human's order is left exactly as they typed it. It is
 * rewritten only when the promotions themselves change — which is the same
 * promise `save.ts` makes about key order, kept by a different mechanism.
 *
 * The alternative — preserving document order — was rejected because it makes
 * `[a, b]` and `[b, a]` two documents where the product means one, and every
 * comparison downstream (the save diff, the property suite's `normalizeDoc`,
 * an equality check in a test) would have to decide independently whether
 * order matters. `requires:` is the house precedent and it sorts.
 */

/** Sorted, deduped, and `undefined` when there is nothing to write. */
export function canonicalPromoted(names: readonly string[] | undefined): string[] | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const out = [...new Set(names)].sort();
  return out.length > 0 ? out : undefined;
}

/**
 * Element-wise equality, treating absent and empty as the same thing.
 *
 * A node that promotes nothing has no line, so `undefined` and `[]` must not
 * read as a change worth rewriting the file for. Deliberately not `!==`: two
 * arrays with equal contents are different objects, and a reference test would
 * rewrite the line on every save and break the no-op-save property.
 */
export function samePromoted(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((name, i) => name === y[i]);
}
