/**
 * @archspace/autodesk — everything this app is allowed to claim about Revit,
 * gathered behind one boundary (ADR-0001; ARCHITECTURE §9, §15; research
 * docs/research/ecosystem.md §1–§3).
 *
 * ADR-0001 decided that Revit is reached *exclusively* as a remote MCP server
 * and that Archspace never links Revit code. That decision only survives
 * contact with a growing codebase if the Autodesk-shaped knowledge sits
 * somewhere a reviewer can read end to end: the capability table (what is
 * real), the source catalogue (how we know it, and how well), the MCP presets
 * (how a user binds the real ones), the APS seam (what we did not build), and
 * an empty node registry (what must never reach the canvas). This file is that
 * boundary — the rest of the repo imports from here and nowhere deeper, so
 * "does Archspace integrate with Revit?" has exactly one place to be answered.
 *
 * The re-exports are enumerated instead of `export *`. A forwarding barrel
 * makes the boundary invisible: the next internal helper — a half-written APS
 * request builder, say — would become public surface the moment it was
 * written, in the one package whose whole job is to not overstate what exists.
 * Enumerating costs a line per symbol and turns "is this a promise we are
 * making?" into a reviewable question.
 */

/** The vocabulary. `CapabilityEvidence` carries `directlyVerified` all the way
 *  to the screen, so the renderer needs the type, not just the data. */
export type {
  AutodeskCapability,
  CapabilityChannel,
  CapabilityEvidence,
  CapabilityStatus,
} from './model.js';

/** The table itself, plus the only two supported ways to read it. Consumers
 *  must not re-derive "is this usable here?" — `resolveCapability` is the
 *  single implementation of that judgement (packages/app renders its reason
 *  verbatim). */
export { AUTODESK_CAPABILITIES, capabilityById, resolveCapability } from './capabilities.js';

/** The citation catalogue. Exported because the settings panel and
 *  docs/autodesk-revit.md show *how* each claim was reached next to the link,
 *  and because `cite` is by construction the only way to build a
 *  CapabilityEvidence — an invariant that would end at this boundary if
 *  callers outside the package had to hand-build evidence objects instead. */
export { SOURCES, cite } from './sources.js';
export type { SourceId, SourceRecord } from './sources.js';

/** Presets are templates for mcp.yaml (ARCHITECTURE §9.1), never connections;
 *  `mcpSupportCheck` is the independent platform gate both engine hosts install
 *  on `createMcpHost` so a Windows-only stdio server reports a real reason
 *  instead of a spawn error. */
export { mcpSupportCheck, revitPresets } from './presets.js';
export type { McpServerPreset } from './presets.js';

/** The APS seam. Exported so that reaching for an unbuilt integration is a
 *  named, catchable failure carrying the capability id and the repo path of
 *  the empty seam — the alternative, leaving it unexported, would just push
 *  callers into inventing their own stub. */
export { UnimplementedCapabilityError, createApsClient } from './aps.js';
export type { ApsClient, ApsClientOptions } from './aps.js';

/** Always empty, and exported *because* it is empty: "this package contributes
 *  no nodes" is then an assertion a test can hold, rather than an absence a
 *  future author fills in without noticing. See nodes.ts before changing it. */
export { autodeskNodeModules } from './nodes.js';
