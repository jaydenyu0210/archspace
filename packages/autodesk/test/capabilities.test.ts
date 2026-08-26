/**
 * The capability table is a claim about the world, so this suite treats it as
 * evidence rather than as data (ADR-0001; research docs/research/ecosystem.md
 * §1–§3; ADR-0013 for why it is a headless unit suite and not an E2E check).
 *
 * The failure this package exists to prevent is a seam quietly presenting
 * itself as a feature. The table is the last place that failure can be caught
 * cheaply: packages/app renders these rows verbatim into the settings panel,
 * and docs/autodesk-revit.md renders them into the documentation, so a row
 * that overstates itself becomes a promise on two screens at once with nobody
 * in between. Hence the assertions below are mostly *integrity* properties —
 * no dangling citation, no unverified claim promoted to verified, no seam
 * pointing at a file that does not exist, nothing usable on macOS that is not
 * an MCP client path — rather than snapshots of the prose, which would go
 * green on any edit that kept the shape and changed the meaning.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTODESK_CAPABILITIES,
  SOURCES,
  capabilityById,
  createApsClient,
  resolveCapability,
  type AutodeskCapability,
} from '../src/index.js';

const REPO_ROOT = new URL('../../../', import.meta.url);
const SOURCE_URLS = new Map(Object.entries(SOURCES).map(([id, record]) => [record.url, { id, record }]));

const byId = (id: string): AutodeskCapability => {
  const cap = capabilityById(id);
  if (!cap) throw new Error(`no capability "${id}" — fix the test or the table, but say which`);
  return cap;
};

const notImplemented = AUTODESK_CAPABILITIES.filter((c) => c.status === 'not-implemented');
const implemented = AUTODESK_CAPABILITIES.filter((c) => c.status !== 'not-implemented');

describe('the table as a whole', () => {
  it('has unique ids', () => {
    const ids = AUTODESK_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size, `duplicate id in ${ids.join(', ')}`).toBe(ids.length);
  });

  it('still matches the count its own file comment states', () => {
    // capabilities.ts opens with "Six of its eleven entries are
    // not-implemented". That sentence is the first thing a reader believes and
    // the last thing anyone remembers to update; pin it here so adding a row
    // forces the header to be re-read rather than silently outgrown.
    expect(AUTODESK_CAPABILITIES).toHaveLength(11);
    expect(notImplemented).toHaveLength(6);
  });

  it('never describes a capability without saying what the user must supply', () => {
    for (const cap of AUTODESK_CAPABILITIES) {
      expect(cap.requires.length, cap.id).toBeGreaterThan(0);
      expect(cap.evidence.length, cap.id).toBeGreaterThan(0);
      expect(cap.platforms.length, cap.id).toBeGreaterThan(0);
    }
  });
});

describe('citations', () => {
  it('cites no source that is not in the catalogue', () => {
    // A dangling citation is worse than none: it renders as a link the reader
    // trusts, next to a claim nobody can trace back.
    for (const cap of AUTODESK_CAPABILITIES) {
      for (const ev of cap.evidence) {
        expect(SOURCE_URLS.has(ev.source), `${cap.id} cites uncatalogued ${ev.source}`).toBe(true);
      }
    }
  });

  it('never promotes an unverified source to verified at the call site', () => {
    // The whole reason `cite()` reads the flag from SOURCES instead of taking
    // it as an argument. This asserts the property that construction is meant
    // to guarantee, so that a future hand-built evidence object — or a
    // "temporary" override — is caught rather than trusted.
    for (const cap of AUTODESK_CAPABILITIES) {
      for (const ev of cap.evidence) {
        const entry = SOURCE_URLS.get(ev.source)!;
        expect(ev.directlyVerified, `${cap.id} → ${entry.id}`).toBe(entry.record.directlyVerified);
        // The retrieval story travels with the claim all the way to the screen.
        expect(ev.note, `${cap.id} → ${entry.id}`).toContain(entry.record.retrieval);
      }
    }
  });

  it('leaves no catalogued source uncited', () => {
    // Dead catalogue rows rot: nobody re-checks a URL that nothing depends on,
    // and the next author cites it believing the flag was recently reviewed.
    const cited = new Set(AUTODESK_CAPABILITIES.flatMap((c) => c.evidence.map((e) => e.source)));
    const orphans = Object.entries(SOURCES)
      .filter(([, record]) => !cited.has(record.url))
      .map(([id]) => id);
    expect(orphans).toEqual([]);
  });

  it('rests every working capability on at least one page somebody actually read', () => {
    // autodesk.com answers the researcher's fetcher with 403 (research §0), so
    // "we have a URL" is not the same as "we read it". A capability we tell the
    // user works must not stand entirely on search-result excerpts.
    for (const cap of implemented) {
      expect(cap.evidence.some((e) => e.directlyVerified), cap.id).toBe(true);
    }
  });

  it('keeps the Revit 2027 executable path marked as the excerpt it is', () => {
    // The specific warning capabilities.ts opens with. This claim drives the
    // preset defaults in presets.ts, so if it is ever quietly upgraded, a
    // search-result excerpt becomes a documented fact in the settings panel.
    const support = byId('revit-2027-mcp').evidence.find((e) =>
      e.source.includes('Usage-of-Revit-2027-MCP-Server'),
    );
    expect(support).toBeDefined();
    expect(support!.directlyVerified).toBe(false);
    expect(support!.note).toContain('NOT DIRECTLY VERIFIED');
    expect(support!.claim).toContain('RevitMCPServer.exe');
  });
});

describe('unimplemented seams', () => {
  it('says what is missing and where, and only for rows that are missing something', () => {
    // Both directions. A `not-implemented` row without a seam is an apology
    // with no address; a working row *with* one is a leftover that makes a
    // shipped capability read as unfinished.
    for (const cap of AUTODESK_CAPABILITIES) {
      const shouldExplain = cap.status === 'not-implemented';
      expect(typeof cap.unimplementedReason === 'string', cap.id).toBe(shouldExplain);
      expect(typeof cap.seam === 'string', cap.id).toBe(shouldExplain);
    }
  });

  it('names a seam file that exists in this repository', () => {
    // The error a user sees quotes this path. A stale one turns a precise
    // "here is the empty seam" into a wild-goose chase, which is exactly the
    // credibility this package is spending.
    for (const cap of notImplemented) {
      const path = /^(\S+\.ts)/.exec(cap.seam!)?.[1];
      expect(path, `${cap.id} seam does not start with a repo path: ${cap.seam}`).toBeDefined();
      expect(path!.startsWith('packages/autodesk/'), cap.id).toBe(true);
      expect(existsSync(fileURLToPath(new URL(path!, REPO_ROOT))), `${cap.id} → ${path}`).toBe(true);
    }
  });

  it('names an APS method that still exists on the client', () => {
    // Renaming `queryAecDataModel` without touching the table would leave the
    // error message pointing at a method that is gone — the failure mode where
    // the honesty machinery itself starts lying.
    const client = createApsClient() as unknown as Record<string, unknown>;
    for (const cap of notImplemented) {
      const method = /createApsClient\(\)\.(\w+)\(\)/.exec(cap.seam!)?.[1];
      if (method === undefined) continue;
      expect(typeof client[method], `${cap.id} seam names ${method}()`).toBe('function');
    }
  });

  it('gives a reason long enough to act on', () => {
    for (const cap of notImplemented) {
      // Not a length fetish: the rule from the file header is that a seam says
      // what is missing *and why*, and no single clause has ever managed both.
      expect(cap.unimplementedReason!.length, cap.id).toBeGreaterThan(80);
    }
  });
});

describe('capabilityById', () => {
  it('round-trips every row', () => {
    for (const cap of AUTODESK_CAPABILITIES) {
      expect(capabilityById(cap.id)).toBe(cap);
    }
  });

  it('returns undefined for an id that is not in the table', () => {
    // Deliberately not a throw: the caller that matters is aps.ts's
    // `unimplemented()`, which turns a miss into an error saying the row is
    // absent — a better message than a lookup failure could ever be.
    expect(capabilityById('revit-does-everything')).toBeUndefined();
    expect(capabilityById('')).toBeUndefined();
  });
});

describe('resolveCapability', () => {
  const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];

  it('never throws — it is a question the settings panel asks about every row', () => {
    // Worth stating explicitly, because the seam story elsewhere in this
    // package *is* a throw (aps.ts). The split is deliberate: describing a
    // capability must always succeed, and only *calling* an unbuilt one fails.
    for (const cap of AUTODESK_CAPABILITIES) {
      for (const platform of platforms) {
        expect(() => resolveCapability(cap, platform)).not.toThrow();
        expect(resolveCapability(cap, platform).reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks a not-implemented seam unusable on every platform, with its reason and address', () => {
    for (const cap of notImplemented) {
      for (const platform of platforms) {
        const resolved = resolveCapability(cap, platform);
        expect(resolved.usableHere, `${cap.id} on ${platform}`).toBe(false);
        expect(resolved.reason).toContain(cap.unimplementedReason);
        expect(resolved.reason).toContain(cap.seam);
      }
    }
  });

  it('gates the Windows-only servers off macOS and Linux, and points at the way round', () => {
    const revit2027 = byId('revit-2027-mcp');
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const resolved = resolveCapability(revit2027, platform);
      expect(resolved.usableHere).toBe(false);
      expect(resolved.reason).toContain('Windows');
      expect(resolved.reason).toContain('MCP Streamable HTTP');
    }
    expect(resolveCapability(revit2027, 'win32').usableHere).toBe(true);
  });

  it('treats a remote agent as usable from macOS while denying that we are the Revit side', () => {
    // The single most misreadable row in the table: usable from a Mac, yet the
    // Revit half runs on somebody else's Windows machine and Archspace never
    // ships it (ADR-0001 decision 3). The reason string carries that caveat, so
    // assert the caveat and not just the boolean.
    const resolved = resolveCapability(byId('revit-remote-agent'), 'darwin');
    expect(resolved.usableHere).toBe(true);
    expect(resolved.reason).toContain('macOS');
    expect(resolved.reason).toContain('Windows machine');
    expect(resolved.reason).toMatch(/client/);
  });

  it('names the host platform in plain language rather than a Node constant', () => {
    const help = byId('autodesk-product-help-mcp');
    expect(resolveCapability(help, 'darwin').reason).toContain('macOS');
    expect(resolveCapability(help, 'win32').reason).toContain('Windows');
    expect(resolveCapability(help, 'linux').reason).toContain('Linux');
    // An unlisted platform degrades to its own name instead of "undefined".
    expect(resolveCapability(help, 'freebsd').reason).toContain('freebsd');
  });
});

describe('the macOS promise (research §3)', () => {
  it('offers nothing on macOS except an MCP client path', () => {
    // The load-bearing assertion of the whole package. Revit, AutoCAD, the
    // Revit API, pyRevit and every local Revit MCP server are Windows-bound;
    // APS is real but unbuilt. So on a Mac the only capabilities that may
    // resolve as usable are MCP ones — remote, over the network, with us as
    // the client. Anything else appearing here means macOS users are being
    // shown something that cannot work.
    const usable = AUTODESK_CAPABILITIES.filter((c) => resolveCapability(c, 'darwin').usableHere);
    expect(usable.map((c) => c.id)).toEqual(['autodesk-product-help-mcp', 'revit-remote-agent']);
    for (const cap of usable) {
      expect(cap.channel, cap.id).toBe('mcp');
    }
  });

  it('promises no live Revit session on macOS at all', () => {
    // Stated separately from the list above because it is the sentence a
    // reader takes away: nothing that touches a running Revit is usable here.
    const windowsBound = AUTODESK_CAPABILITIES.filter((c) => c.status === 'available-windows-only');
    expect(windowsBound.length).toBeGreaterThan(0);
    for (const cap of windowsBound) {
      expect(cap.platforms, cap.id).toEqual(['windows']);
      expect(resolveCapability(cap, 'darwin').usableHere, cap.id).toBe(false);
    }
  });

  it('never marks a plain-`available` capability as needing Windows', () => {
    // `available` means "works today from this app, on some platform". If such
    // a row also listed Windows as its server side, `resolveCapability` would
    // report it usable on a Mac while the thing it needs runs nowhere near one.
    for (const cap of AUTODESK_CAPABILITIES.filter((c) => c.status === 'available')) {
      expect(cap.platforms, cap.id).not.toContain('windows');
    }
  });
});
