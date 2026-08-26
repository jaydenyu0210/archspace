/**
 * Shared ground for the ai.* nodes (ARCHITECTURE §10 / ADR-0010).
 *
 * The three ai.* nodes make the same three decisions: which model profile to
 * ask for, how a `json` context port becomes prompt text, and what an empty
 * form field means. They are made once, here, because they are user-visible —
 * if `ai.generate_text` and `ai.generate_object` rendered the same wired table
 * differently, one graph would send two different prompts and nothing on
 * screen would explain why.
 *
 * Rejected alternative: a `makeAiNode()` factory that also builds the
 * manifest. It would hide the manifest, and the manifest is precisely the half
 * of a node the app reads *without executing it* — palette, generated form,
 * document validation and cache key all come from it (§5.2). Every sibling in
 * this package spells its manifest out in full; so do these.
 *
 * Nothing here — and nothing in the three nodes — imports
 * @archspace/ai-gateway or names a provider. They see `ctx.ai` and nothing
 * else. That is ADR-0010's whole point: it is what lets one document run on a
 * cloud model here and a local one on the next desk.
 */
import type { JsonSchemaProperty, Value } from '@archspace/node-sdk';

/**
 * The `profile` param, identical in all three ai.* manifests.
 *
 * Deliberately NOT `promotable`. `requires.ai` is derived statically from each
 * node's `config.profile` when a document is saved (§4.2 rule 7) — it is what
 * lets a reviewer or CI see what a workflow needs without loading a node
 * registry. A profile arriving on a wire would make that derived block a lie,
 * and a requirement that is sometimes wrong is worse than no requirement.
 */
export const MODEL_PROFILE_PARAM: JsonSchemaProperty = {
  type: 'string',
  title: 'Model profile',
  description:
    'A named profile from Settings → AI model profiles. Workflows travel by profile name, never by provider: "default" is whatever this machine binds it to. Leave empty to use this machine\'s configured default.',
  default: 'default',
  'x-archspace': { placeholder: 'default' },
};

/**
 * The profile to put in the request, or `undefined` to let the gateway apply
 * the default this machine configured. An empty field means "you choose",
 * which is not the same as the profile literally named "default" — a user may
 * well have made `work` their default.
 */
export function requestedProfile(raw: string): string | undefined {
  const name = raw.trim();
  return name === '' ? undefined : name;
}

/** How a profile reads in a log or progress line. */
export function describeProfile(profile: string | undefined): string {
  return profile === undefined ? "this machine's default profile" : `profile "${profile}"`;
}

/**
 * A `json` context port rendered as prompt text.
 *
 * A string goes through verbatim: a wired report is prose, and JSON.stringify
 * would hand the model a quoted blob full of \n escapes. Everything else is
 * pretty-printed JSON — readable to a model and lossless, which matters most
 * for a wired `table`, where keeping the column ids is what makes "the
 * area_m2 column" a phrase the model can act on.
 */
export function renderContext(value: Value): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * The single user turn: what the form said, then what the graph wired in,
 * under a heading so the model can tell the instruction from the material.
 *
 * Either half may be absent — a node whose prompt lives entirely upstream is a
 * legitimate graph — but a node where *both* are empty is a request that
 * spends the user's tokens on nothing, and each caller rejects that case
 * before it reaches a provider.
 */
export function composeUserPrompt(
  prompt: string,
  context: Value | undefined,
  heading = 'Context',
): string {
  const written = prompt.trim();
  if (context === undefined || context === null) return written;
  const wired = renderContext(context).trim();
  if (wired === '') return written;
  if (written === '') return wired;
  return `${written}\n\n# ${heading}\n\n${wired}`;
}
