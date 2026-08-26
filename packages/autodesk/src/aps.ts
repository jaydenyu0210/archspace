/**
 * The Autodesk Platform Services seam.
 *
 * There is no APS implementation in Archspace: no registered application, no
 * OAuth flow, no Design Automation pipeline, no GraphQL client. This module
 * exists so that the *shape* of those calls is agreed and named — and so that
 * anything reaching for them fails loudly, with the capability id, the reason
 * and the repo path of the empty seam, instead of getting a plausible-looking
 * stub. A mock here would be indistinguishable from a working integration at
 * every call site, which is exactly the outcome the product forbids.
 *
 * The methods throw synchronously rather than returning a rejected promise.
 * That is deliberate: a forgotten `await` on a rejected promise becomes an
 * unhandled rejection somewhere else entirely, while a synchronous throw
 * surfaces at the line that made the wrong assumption. The declared
 * `Promise<never>` return type still type-checks for `await`ing callers.
 */
import { capabilityById } from './capabilities.js';

export class UnimplementedCapabilityError extends Error {
  readonly capabilityId: string;
  readonly reason: string;
  /** Repo path of the seam, repeated on the error so a log line is enough. */
  readonly seam: string;

  constructor(capabilityId: string, reason: string, seam: string) {
    super(
      `Autodesk capability "${capabilityId}" is not implemented in Archspace. ${reason} Seam: ${seam}`,
    );
    this.name = 'UnimplementedCapabilityError';
    this.capabilityId = capabilityId;
    this.reason = reason;
    this.seam = seam;
  }
}

/**
 * Build the error from the capability table, so the message a user sees is the
 * same text the settings panel and docs/autodesk-revit.md show. If the table
 * ever loses the row, the error says that too rather than inventing a reason.
 */
function unimplemented(capabilityId: string): never {
  const cap = capabilityById(capabilityId);
  throw new UnimplementedCapabilityError(
    capabilityId,
    cap?.unimplementedReason ??
      'No capability record exists for this id, which is itself a bug — the seam is declared nowhere.',
    cap?.seam ?? 'packages/autodesk/src/aps.ts',
  );
}

/** The APS seam. Every method throws UnimplementedCapabilityError today. */
export interface ApsClient {
  authenticate(): Promise<never>;
  queryAecDataModel(query: string): Promise<never>;
  startDesignAutomationWorkItem(spec: unknown): Promise<never>;
  translateModelDerivative(urn: string): Promise<never>;
}

export interface ApsClientOptions {
  /** APS regional endpoint the future client would target ("US", "EMEA", …). */
  region?: string;
}

/**
 * Returns a client whose every method throws. `region` is accepted so callers
 * can wire configuration now and not have to change shape later; nothing reads
 * it, and the error says so rather than letting the option imply a connection.
 */
export function createApsClient(opts: ApsClientOptions = {}): ApsClient {
  const region = opts.region ?? 'US';
  void region; // Recorded for the future client; deliberately unused today.
  return {
    authenticate: () => unimplemented('aps-oauth'),
    queryAecDataModel: (_query: string) => unimplemented('aps-aec-data-model'),
    startDesignAutomationWorkItem: (_spec: unknown) =>
      unimplemented('aps-design-automation-revit'),
    translateModelDerivative: (_urn: string) => unimplemented('aps-model-derivative'),
  };
}
