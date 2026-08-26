/**
 * The citation catalogue: every URL this package is allowed to cite, together
 * with whether the research could actually read the page.
 *
 * Why a catalogue instead of inline URLs: `directlyVerified` is a property of
 * the *source*, not of the claim, so the same page must never be marked
 * verified in one capability and unverified in another. Recording it once makes
 * that impossible, and `cite()` is the only way to build a CapabilityEvidence —
 * so no evidence entry can exist without a catalogued source.
 *
 * The flags come from docs/research/ecosystem.md and nothing else. The rule
 * applied: `directlyVerified: true` only where the research states it retrieved
 * that page (help.autodesk.com, the APS blog, modelcontextprotocol.io, the
 * GitHub API); `false` for every page that returned 403 to the fetcher, and for
 * every page the research reached only through search-result excerpts or named
 * without recording a retrieval. Upgrading a flag requires new research, not a
 * better mood.
 */
import type { CapabilityEvidence } from './model.js';

export interface SourceRecord {
  url: string;
  /** True only where docs/research/ecosystem.md records retrieving this page. */
  directlyVerified: boolean;
  /** How the research reached it — shown next to the link in the UI and docs. */
  retrieval: string;
}

export type SourceId =
  | 'adsk-mcp-portal'
  | 'revit-2027-whats-new'
  | 'revit-mcp-blog'
  | 'revit-mcp-support-article'
  | 'bim-chapters'
  | 'aps-mcp-blog'
  | 'aps-aec-data-model'
  | 'aps-design-automation-guide'
  | 'aps-design-automation-restrictions'
  | 'aps-ssa-guide'
  | 'aps-portal'
  | 'revit-api-overview'
  | 'revit-system-requirements'
  | 'revit-virtualization'
  | 'mcp-transports'
  | 'mcp-authorization'
  | 'gh-revit-mcp-archived'
  | 'gh-mcp-servers-for-revit'
  | 'gh-ludattilo-revit-mcp'
  | 'gh-demolinator-revit-mcp'
  | 'gh-pyrevit';

export const SOURCES: Readonly<Record<SourceId, SourceRecord>> = {
  'adsk-mcp-portal': {
    url: 'https://help.autodesk.com/view/ADSKMCP/ENU/',
    directlyVerified: true,
    retrieval:
      'Portal index retrieved 2026-08-24. Its per-server detail pages are rendered client-side and returned 404 to the fetcher, so no tool-by-tool list came from here.',
  },
  'revit-2027-whats-new': {
    url: 'https://help.autodesk.com/cloudhelp/2027/ENU/Revit-WhatsNew/files/GUID-97697CBF-0E11-484E-96E5-4277E3E8D61F.htm',
    directlyVerified: true,
    retrieval: 'Retrieved 2026-08-24.',
  },
  'revit-mcp-blog': {
    url: 'https://www.autodesk.com/blogs/aec/2026/06/17/revit-public-mcp-server/',
    directlyVerified: false,
    retrieval:
      'autodesk.com returned HTTP 403 (Akamai) to the fetcher. The URL and the announcement date come from search results; the page itself was never read.',
  },
  'revit-mcp-support-article': {
    url: 'https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Usage-of-Revit-2027-MCP-Server.html',
    directlyVerified: false,
    retrieval:
      'HTTP 403. Everything attributed to it — the server executable path, the stdio transport, the Claude Desktop/Cursor auto-configuration — comes from search-result excerpts of the article.',
  },
  'bim-chapters': {
    url: 'https://bimchapters.blogspot.com/2026/04/revit-mcp-public-server-tech-preview.html',
    directlyVerified: true,
    retrieval:
      'Retrieved 2026-08-24, but it is a secondary source: an independent blog (Steve Stafford), not Autodesk.',
  },
  'aps-mcp-blog': {
    url: 'https://aps.autodesk.com/blog/building-custom-mcp-servers-autodesk-platform-services',
    directlyVerified: true,
    retrieval: 'Fully retrieved 2026-08-24.',
  },
  'aps-aec-data-model': {
    url: 'https://aps.autodesk.com/autodesk-aec-data-model-api',
    directlyVerified: false,
    retrieval:
      'Named as the product page in research §2.5; the research records no direct retrieval of it.',
  },
  'aps-design-automation-guide': {
    url: 'https://aps.autodesk.com/en/docs/design-automation/v3/developers_guide/',
    directlyVerified: false,
    retrieval: 'Reached through search results (research §2.4), not read directly.',
  },
  'aps-design-automation-restrictions': {
    url: 'https://aps.autodesk.com/en/docs/design-automation/v3/developers_guide/restrictions',
    directlyVerified: false,
    retrieval: 'Known only through a search-result excerpt of the official docs (research §2.4).',
  },
  'aps-ssa-guide': {
    url: 'https://aps.autodesk.com/en/docs/ssa/v1/developers_guide/overview/',
    directlyVerified: false,
    retrieval: 'Linked from the APS MCP blog post; the research records no direct retrieval.',
  },
  'aps-portal': {
    url: 'https://aps.autodesk.com/',
    directlyVerified: false,
    retrieval:
      'The APS developer portal root. Used where research §2.5 names an API without citing a specific page — the entry point to find the real documentation, not evidence for any detail.',
  },
  'revit-api-overview': {
    url: 'https://aps.autodesk.com/developer/overview/revit-api',
    directlyVerified: true,
    retrieval:
      'Retrieved 2026-08-24. Confirms the .NET add-in model exists; carries little further detail.',
  },
  'revit-system-requirements': {
    url: 'https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/System-requirements-for-Revit-2025-products.html',
    directlyVerified: false,
    retrieval: 'HTTP 403 to the fetcher; corroborated only by search-result excerpts.',
  },
  'revit-virtualization': {
    url: 'https://help.autodesk.com/cloudhelp/2026/ENU/Revit-Installation/files/GUID-2EF1661C-5A8D-41AC-A28F-9678DDF545CA.htm',
    directlyVerified: true,
    retrieval: 'Retrieved 2026-08-24.',
  },
  'mcp-transports': {
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports',
    directlyVerified: true,
    retrieval: 'Fully retrieved 2026-08-24 (MCP specification 2025-11-25).',
  },
  'mcp-authorization': {
    url: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization',
    directlyVerified: true,
    retrieval: 'Fully retrieved 2026-08-24 (MCP specification 2025-11-25).',
  },
  'gh-revit-mcp-archived': {
    url: 'https://github.com/mcp-servers-for-revit/revit-mcp',
    directlyVerified: true,
    retrieval: 'License and archive status read from the GitHub API 2026-08-24.',
  },
  'gh-mcp-servers-for-revit': {
    url: 'https://github.com/mcp-servers-for-revit/mcp-servers-for-revit',
    directlyVerified: true,
    retrieval:
      'License and last-push date read from the GitHub API 2026-08-24. Tool counts are the repo’s own self-description and were not verified.',
  },
  'gh-ludattilo-revit-mcp': {
    url: 'https://github.com/LuDattilo/revit-mcp-server',
    directlyVerified: true,
    retrieval:
      'License and last-push date read from the GitHub API 2026-08-24. Tool counts and version coverage are the repo’s own self-description and were not verified.',
  },
  'gh-demolinator-revit-mcp': {
    url: 'https://github.com/Demolinator/revit-mcp-server',
    directlyVerified: true,
    retrieval:
      'License and last-push date read from the GitHub API 2026-08-24. Tool counts and version coverage are the repo’s own self-description and were not verified.',
  },
  'gh-pyrevit': {
    url: 'https://github.com/pyrevitlabs/pyRevit',
    directlyVerified: true,
    retrieval: 'License (GPL-3.0) and activity read from the GitHub API 2026-08-24.',
  },
};

/**
 * Build one evidence entry. The verification flag is taken from the catalogue,
 * never from the caller, which is the whole point: a claim cannot be promoted
 * to "verified" at the call site.
 */
export function cite(source: SourceId, claim: string, note?: string): CapabilityEvidence {
  const record = SOURCES[source];
  return {
    claim,
    source: record.url,
    directlyVerified: record.directlyVerified,
    note: note ? `${note} ${record.retrieval}` : record.retrieval,
  };
}
