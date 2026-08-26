/**
 * The vocabulary of the Autodesk capability map.
 *
 * These types exist so that a capability cannot be described without saying
 * three uncomfortable things out loud: which channel actually carries it, what
 * the user has to own or run before it works, and — for anything we have not
 * built — where the empty seam lives in this repo. `CapabilityEvidence` is the
 * load-bearing one: every claim carries the URL it came from plus
 * `directlyVerified`, which is false whenever the research could not retrieve
 * the page (autodesk.com answers the researcher's fetcher with HTTP 403, so
 * several Revit claims rest on search-result excerpts only). An unverified
 * claim must stay unverified all the way to the screen.
 *
 * Types live in their own module because both the capability table and the
 * source catalogue need them, and neither should have to import the other.
 */

export type CapabilityStatus =
  /** Works today from this app, on some platform. */
  | 'available'
  /** Real, but the server side needs Windows + Revit. */
  | 'available-windows-only'
  /** Real over MCP, but someone must run the agent. */
  | 'requires-remote-agent'
  /** Seam exists; no implementation ships. */
  | 'not-implemented';

export type CapabilityChannel = 'mcp' | 'aps-rest' | 'aps-graphql' | 'revit-addin' | 'none';

export interface CapabilityEvidence {
  claim: string;
  source: string;
  /** False when the research could not retrieve the page directly (403 etc.). */
  directlyVerified: boolean;
  note?: string;
}

export interface AutodeskCapability {
  id: string;
  title: string;
  summary: string;
  status: CapabilityStatus;
  channel: CapabilityChannel;
  access: 'none' | 'read' | 'read-export' | 'read-write';
  /** Where the capability's *server side* has to run — not where this app runs.
   *  A remote Autodesk or APS endpoint is 'cloud'; anything hosting a live
   *  Revit/AutoCAD session is 'windows'. */
  platforms: ('windows' | 'macos' | 'linux' | 'cloud')[];
  /** What the user must supply/run. Rendered as a checklist in the UI. */
  requires: string[];
  /** Present iff status === 'not-implemented'. Says what is missing and why. */
  unimplementedReason?: string;
  /** Present iff status === 'not-implemented'. Where the seam lives in this repo. */
  seam?: string;
  evidence: CapabilityEvidence[];
}
