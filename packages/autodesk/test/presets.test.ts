/**
 * Presets are templates for mcp.yaml, and a template that cannot be saved is a
 * bug (ARCHITECTURE §9.1 / ADR-0009 decision 1).
 *
 * The presets exist because binding an MCP server by hand means knowing a
 * transport, an executable path or an endpoint, an auth mode and a timeout —
 * five chances to get it wrong before anything can even fail informatively. So
 * the central assertion here is a round trip through the *real* validator:
 * every preset, once its declared placeholders are filled, must survive
 * `serializeMcpConfig` → `parseMcpConfig` with zero issues and come back
 * unchanged. Re-implementing the validation rules in this file would assert
 * that the presets match our idea of mcp.yaml; going through @archspace/mcp-host
 * asserts they match the file the app actually writes and re-reads.
 *
 * The second theme is the one the presets file calls its honesty rule: a preset
 * is a template, never a connection. Nothing is enabled, every machine-specific
 * value is either a declared placeholder or a default the user is told to
 * confirm, and no preset may advertise itself as available while the capability
 * table or the platform gate says otherwise. Those three could drift apart
 * silently — they are three different files — so they are cross-checked here
 * rather than each trusted on its own.
 */
import { describe, expect, it } from 'vitest';
import { parseMcpConfig, serializeMcpConfig, type McpServerConfig } from '@archspace/mcp-host';
import {
  SOURCES,
  capabilityById,
  mcpSupportCheck,
  resolveCapability,
  revitPresets,
  type McpServerPreset,
} from '../src/index.js';

/** The marker src/presets.ts writes into every value the user must replace. */
const TODO = '<replace me>';

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];

/** Realistic values for the two placeholder shapes the presets actually use. */
const FILLINGS: Record<string, string> = {
  'binding.url': 'https://revit-agent.office.example:8443/mcp',
  'binding.command.0': 'C:\\Program Files\\Example\\RevitMcpBridge.exe',
};

/** Dotted paths of every string in a config still carrying the TODO marker. */
function todoPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return value.includes(TODO) ? [prefix] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => todoPaths(item, `${prefix}.${i}`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, v]) => todoPaths(v, prefix ? `${prefix}.${key}` : key));
  }
  return [];
}

/** Write `value` at a dotted path, reporting whether the target already existed
 *  — a placeholder pointing at a field that is not there is itself the bug. */
function setPath(config: McpServerConfig, path: string, value: string): boolean {
  const segments = path.split('.');
  let cursor: unknown = config;
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== 'object' || cursor === null) return false;
  const leaf = segments[segments.length - 1];
  const target = cursor as Record<string, unknown>;
  const existed = typeof target[leaf] === 'string';
  target[leaf] = value;
  return existed;
}

/** A preset with every declared placeholder filled in — what the user ends up
 *  saving, and therefore what the validator has to accept. */
function filled(preset: McpServerPreset): McpServerConfig {
  const config = structuredClone(preset.config);
  for (const placeholder of preset.placeholders) {
    const value = FILLINGS[placeholder.path];
    expect(value, `no test filling for placeholder path ${placeholder.path}`).toBeDefined();
    expect(setPath(config, placeholder.path, value), `${preset.id}: ${placeholder.path} is not a field of the config`).toBe(true);
  }
  return config;
}

describe('presets round-trip through the mcp.yaml validator', () => {
  it('accepts every filled preset, with no issues at all', () => {
    // All of them in one document, keyed by logical name — the shape a user
    // actually ends up with, which also proves the logical names are legal
    // mcp.yaml keys (the parser drops anything that is not).
    const presets = revitPresets('win32');
    const servers: Record<string, McpServerConfig> = {};
    for (const preset of presets) servers[preset.logicalName] = filled(preset);

    const text = serializeMcpConfig({ servers });
    const { config, issues } = parseMcpConfig(text);

    expect(issues).toEqual([]);
    expect(Object.keys(config.servers).sort()).toEqual(Object.keys(servers).sort());
  });

  it('brings every preset back structurally unchanged', () => {
    // Not just "parses" — the binding the user saved is the binding the host
    // will dial. A field silently dropped in serialization (a timeout, a
    // concurrency cap) would change behaviour with nothing to show for it.
    for (const preset of revitPresets('win32')) {
      const original = filled(preset);
      const { config } = parseMcpConfig(serializeMcpConfig({ servers: { [preset.logicalName]: original } }));
      expect(config.servers[preset.logicalName], preset.id).toEqual(original);
    }
  });

  it('refuses an unfilled preset loudly, at the field the user has to fix', () => {
    // The other half of the contract, and the reason nothing ships enabled: a
    // half-filled preset must fail at save time with a named field, not at
    // first demand with a spawn error or a DNS failure.
    const help = revitPresets('darwin').find((p) => p.id === 'autodesk-product-help')!;
    const { config, issues } = parseMcpConfig(
      serializeMcpConfig({ servers: { [help.logicalName]: help.config } }),
    );
    // The path is the flat mcp.yaml one (`servers.<name>.url`), not the nested
    // in-memory one — this is the string a user reads in the settings panel.
    const refusal = issues.find((i) => i.severity === 'error' && i.path === `servers.${help.logicalName}.url`);
    expect(refusal, JSON.stringify(issues)).toBeDefined();
    expect(refusal!.message).toContain(TODO);
    // And the binding is dropped rather than half-kept: one malformed server
    // costs the user that server, never the rest of the file.
    expect(config.servers[help.logicalName]).toBeUndefined();
  });
});

describe('a preset is a template, not a connection', () => {
  const presets = revitPresets('win32');

  it('enables nothing', () => {
    for (const preset of presets) expect(preset.config.enabled, preset.id).toBe(false);
  });

  it('declares every value the user still has to replace', () => {
    // The exception is deliberate and narrow: a preset that is unavailable even
    // on Windows is permanently blocked (the archived community server), and
    // there is nothing for the user to fill in because they must not use it at
    // all. Every other TODO must be a declared placeholder with a hint.
    let markersSeen = 0;
    for (const preset of presets) {
      const outstanding = todoPaths(preset.config);
      markersSeen += outstanding.length;
      if (outstanding.length === 0) continue;
      if (!preset.availability.available) {
        expect(preset.availability.reason, preset.id).toBeTruthy();
        continue;
      }
      const declared = new Set(preset.placeholders.map((p) => p.path));
      for (const path of outstanding) {
        expect(declared.has(path), `${preset.id}: ${path} is unfilled but undeclared`).toBe(true);
      }
    }
    // Guards the marker itself: if TODO changed, the loop above would pass
    // vacuously and this file would stop testing anything.
    expect(markersSeen).toBeGreaterThan(0);
  });

  it('points every placeholder at a field that exists, and explains it', () => {
    for (const preset of presets) {
      for (const placeholder of preset.placeholders) {
        expect(setPath(structuredClone(preset.config), placeholder.path, 'x'), `${preset.id}: ${placeholder.path}`).toBe(true);
        expect(placeholder.label.length, `${preset.id}: ${placeholder.path}`).toBeGreaterThan(0);
        // The hint is where the uncertainty lives — an unread support article,
        // a repo you have to build yourself. A blank one is a silent default.
        expect(placeholder.hint.length, `${preset.id}: ${placeholder.path}`).toBeGreaterThan(40);
      }
    }
  });

  it('stores no secret by value', () => {
    // ARCHITECTURE §6.1/§11: a bearer token lives in the keychain and the
    // config names its key. mcp.yaml is hand-editable and sits next to a
    // project; a preset that pre-filled a header would teach the opposite.
    for (const preset of presets) {
      const binding = preset.config.binding;
      if (binding.transport !== 'http') continue;
      expect(binding.headers, preset.id).toBeUndefined();
      if (binding.auth === 'bearer') expect(binding.bearerTokenRef, preset.id).toBeTruthy();
    }
  });

  it('hands out fresh, mutable copies so one caller cannot poison the next', () => {
    // The app calls revitPresets() per IPC request and the renderer edits what
    // it gets back. Shared seed objects would let one settings panel edit
    // rewrite the preset catalogue for the whole process.
    const first = revitPresets('darwin');
    const second = revitPresets('darwin');
    expect(first[0].config).not.toBe(second[0].config);
    first[0].config.enabled = true;
    first[0].placeholders.length = 0;
    expect(revitPresets('darwin')[0].config.enabled).toBe(false);
    expect(revitPresets('darwin')[0].placeholders.length).toBeGreaterThan(0);
  });
});

describe('presets agree with the capability table and the platform gate', () => {
  it('names a capability that exists, with unique ids and logical names', () => {
    const presets = revitPresets('darwin');
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    expect(new Set(presets.map((p) => p.logicalName)).size).toBe(presets.length);
    for (const preset of presets) {
      expect(capabilityById(preset.capabilityId), `${preset.id} → ${preset.capabilityId}`).toBeDefined();
    }
  });

  it('never offers a preset its capability says is unusable here', () => {
    // Availability is derived from resolveCapability, never restated — this is
    // the assertion that keeps that true as either file changes.
    for (const platform of PLATFORMS) {
      for (const preset of revitPresets(platform)) {
        if (!preset.availability.available) continue;
        const cap = capabilityById(preset.capabilityId)!;
        expect(resolveCapability(cap, platform).usableHere, `${preset.id} on ${platform}`).toBe(true);
      }
    }
  });

  it('never offers a preset the platform gate would refuse', () => {
    // Two independent gates, one answer. If they disagree the user gets a
    // preset that installs cleanly and then reports "unsupported" on connect —
    // the confusing failure `mcpSupportCheck` exists to eliminate.
    for (const platform of PLATFORMS) {
      const check = mcpSupportCheck(platform);
      for (const preset of revitPresets(platform)) {
        if (!preset.availability.available) continue;
        expect(check(preset.logicalName, preset.config), `${preset.id} on ${platform}`).toBeUndefined();
      }
    }
  });

  it('offers exactly the two remote HTTP presets on macOS', () => {
    // The macOS story in one assertion: documentation search, and a remote
    // agent you run yourself. Everything else on this list needs a live Revit
    // or AutoCAD session, which needs Windows (research §3).
    const available = revitPresets('darwin').filter((p) => p.availability.available);
    expect(available.map((p) => p.id)).toEqual(['autodesk-product-help', 'revit-agent']);
    for (const preset of available) expect(preset.config.binding.transport).toBe('http');
  });

  it('refuses every stdio preset on macOS, and says where to go instead', () => {
    const check = mcpSupportCheck('darwin');
    const stdioPresets = revitPresets('darwin').filter((p) => p.config.binding.transport === 'stdio');
    expect(stdioPresets.length).toBeGreaterThan(0);
    for (const preset of stdioPresets) {
      expect(preset.availability.available, preset.id).toBe(false);
      expect(preset.availability.reason, preset.id).toBeTruthy();
      expect(check(preset.logicalName, preset.config), preset.id).toBeTypeOf('string');
    }
  });

  it('opens everything except the archived server on Windows', () => {
    const blocked = revitPresets('win32').filter((p) => !p.availability.available);
    expect(blocked.map((p) => p.id)).toEqual(['revit-mcp-archived']);
    // Archived is a fact about maintenance, not about platforms, so it must
    // outrank the platform answer everywhere — including on the platform where
    // the thing would technically run.
    expect(blocked[0].availability.reason).toContain('Archived');
    expect(blocked[0].availability.reason).toContain('mcp-servers-for-revit');
    for (const platform of PLATFORMS) {
      const archived = revitPresets(platform).find((p) => p.id === 'revit-mcp-archived')!;
      expect(archived.availability.available, platform).toBe(false);
    }
  });

  it('orders the list so what works everywhere comes first and the archived one last', () => {
    // presets.ts calls the order deliberate; a settings panel renders it as
    // given, so the order is UI, not incidental.
    const presets = revitPresets('darwin');
    expect(presets[0].config.binding.transport).toBe('http');
    expect(presets[1].config.binding.transport).toBe('http');
    expect(presets[presets.length - 1].id).toBe('revit-mcp-archived');
  });
});

describe('preset evidence obeys the same citation rules as the capability table', () => {
  const catalogue = new Map(Object.values(SOURCES).map((record) => [record.url, record]));

  it('cites only catalogued sources, with the catalogue’s own verification flag', () => {
    // Presets are rendered with their evidence next to them; an unverified
    // claim must not become verified just because it is one file further from
    // the research.
    for (const preset of revitPresets('win32')) {
      expect(preset.evidence.length, preset.id).toBeGreaterThan(0);
      for (const ev of preset.evidence) {
        const record = catalogue.get(ev.source);
        expect(record, `${preset.id} cites uncatalogued ${ev.source}`).toBeDefined();
        expect(ev.directlyVerified, `${preset.id} → ${ev.source}`).toBe(record!.directlyVerified);
      }
    }
  });

  it('keeps the Revit 2027 preset’s defaults marked unverified', () => {
    // Both the executable path and the stdio transport in this preset come
    // from search excerpts of a page that returned 403. The preset ships them
    // as a default *to confirm*; the moment that caveat drops, a guess becomes
    // documentation.
    const preset = revitPresets('win32').find((p) => p.id === 'revit-2027-official')!;
    const excerpt = preset.evidence.find((e) => e.source.includes('Usage-of-Revit-2027-MCP-Server'))!;
    expect(excerpt.directlyVerified).toBe(false);
    expect(excerpt.note).toContain('NOT DIRECTLY VERIFIED');
    expect(preset.placeholders.map((p) => p.path)).toContain('binding.command.0');
  });
});
