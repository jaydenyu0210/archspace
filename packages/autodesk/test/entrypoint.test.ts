/**
 * The barrel is a contract, not a convenience (ARCHITECTURE §3.4).
 *
 * package.json declares `"exports": { ".": "./src/index.ts" }`, and four files
 * outside this package import through it: packages/app/src/main/index.ts
 * (AUTODESK_CAPABILITIES, revitPresets), packages/app/src/shared/protocol.ts
 * (AutodeskCapability, McpServerPreset — types, so a missing one fails only at
 * typecheck), and both engine hosts, packages/app/src/engine-child/index.ts and
 * packages/cli/src/runtime.ts (mcpSupportCheck). This suite fails if any of
 * those five runtime names stops being exported, because the failure mode it
 * guards against actually happened: the entrypoint did not exist at all, every
 * `import … from '@archspace/autodesk'` in the repo was broken, and nothing in
 * this package noticed — it had no tests to notice with.
 *
 * Asserting the list here rather than in an integration test is deliberate: an
 * integration test would only catch it once the app is wired up and running,
 * which on macOS is exactly the path that cannot be exercised in CI (ADR-0013:
 * no Windows and no Revit in CI). A `vitest run` in this package catches it in
 * milliseconds instead.
 */
import { describe, expect, it } from 'vitest';
import * as autodesk from '../src/index.js';

/** Exactly the runtime names imported from '@archspace/autodesk' elsewhere in
 *  the repo, each with the importer that would break. Types are checked by
 *  `tsc`, not here. */
const CONSUMED: Record<string, string> = {
  AUTODESK_CAPABILITIES: 'packages/app/src/main/index.ts',
  revitPresets: 'packages/app/src/main/index.ts',
  mcpSupportCheck: 'packages/app/src/engine-child/index.ts, packages/cli/src/runtime.ts',
};

describe('the declared entrypoint', () => {
  it('exports every runtime name the rest of the repo imports', () => {
    for (const [name, importer] of Object.entries(CONSUMED)) {
      expect(autodesk, `${name} is imported by ${importer}`).toHaveProperty(name);
    }
  });

  it('exports the package’s own vocabulary, so nothing has to reach past the barrel', () => {
    // Deep imports would defeat the boundary: `capabilityById` reaching into
    // './capabilities.js' from packages/app is how a second, friendlier copy of
    // these facts gets written. Everything a consumer could legitimately want
    // is here.
    for (const name of [
      'capabilityById',
      'resolveCapability',
      'SOURCES',
      'cite',
      'createApsClient',
      'UnimplementedCapabilityError',
      'autodeskNodeModules',
    ]) {
      expect(autodesk).toHaveProperty(name);
    }
  });

  it('exports nothing else', () => {
    // A closed list, checked in the direction people forget. The package's job
    // is to be the boundary on what Archspace claims about Autodesk; a symbol
    // that leaks out here is a claim nobody reviewed. Adding an export is
    // fine — updating this list is the review.
    expect(Object.keys(autodesk).sort()).toEqual([
      'AUTODESK_CAPABILITIES',
      'SOURCES',
      'UnimplementedCapabilityError',
      'autodeskNodeModules',
      'capabilityById',
      'cite',
      'createApsClient',
      'mcpSupportCheck',
      'resolveCapability',
      'revitPresets',
    ]);
  });
});
