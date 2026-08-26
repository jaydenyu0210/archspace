/**
 * The proof that the boundary carries real work: **the shipped first-party
 * plugin loads through a real `PluginHost`, and one of its nodes executes in
 * another OS process and returns the right answer** (ARCHITECTURE §8.2,
 * ADR-0008 §5, §16 M6).
 *
 * `aec.review.*` was moved out of `nodes-core` into `plugins/aec-review` to
 * keep the boundary honest — "if the boundary can't carry our own flagship
 * domain feature, it's decoration" (§8.2). Without this file that move is
 * unfalsifiable: every other test in this package drives fixture plugins the
 * test itself wrote, so the whole node set could quietly stop loading and the
 * suite would stay green. This is the test that fails if the plugin is bypassed,
 * unbuilt, renamed, or silently reabsorbed into the engine.
 *
 * Three things are deliberate:
 *
 *  - **The real directory, not a copy.** `bundledDirs` is the repo's `plugins/`,
 *    the same path `packages/cli`'s `workspacePluginsDir` and the unpackaged app
 *    hand the host. A copied fixture would pass while the shipped plugin was
 *    broken. It reads `dist/index.js`, so `pnpm --filter
 *    @archspace/plugin-aec-review build` must precede `pnpm test` — which is
 *    exactly the order CI runs them in.
 *  - **Nothing here imports the plugin.** `plugin-host` does not depend on
 *    `@archspace/plugin-aec-review` and must not (§3.4); the node types, the
 *    param schema and the result shape all arrive over the wire, so the
 *    expected shape is spelled out locally. If they had to agree by import,
 *    this test would prove nothing about the RPC.
 *  - **`filter_findings` is the node under execution** because it is `caching:
 *    'pure'` with no mock latency: the assertion is about the wire, not about a
 *    review engine, and a pure function makes "the answer came back correct"
 *    an exact claim rather than a smoke test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runNode } from '@archspace/node-sdk/testkit';
import type { Value } from '@archspace/node-sdk';
import { createPluginHost, type ExecMessage, type PluginHost } from '../src/index.js';
import { cleanupTempDirs, tempDir } from './helpers.js';
import { BUNDLED_PLUGINS_DIR, CHILD_ENTRY, recordingSpawn, stubCapabilities } from './host-fixtures.js';

/** The node set the move relocated. Spelled out, not derived: this list *is*
 *  the deliverable, so a node quietly disappearing must red the suite. */
const AEC_REVIEW_NODE_TYPES = [
  'aec.review.accessibility',
  'aec.review.code_compliance',
  'aec.review.energy_performance',
  'aec.review.filter_findings',
  'aec.review.merge_findings',
  'aec.review.structural',
  'aec.review.zoning',
];

/** What `aec.review.filter_findings` promises to return, as this side of the
 *  wire understands it (`ReviewResult` in `@archspace/nodes-core/shapes` —
 *  restated rather than imported, see the header). */
interface WireFinding {
  id: string;
  ruleId: string;
  severity: string;
  discipline?: string;
}
interface WireReview {
  reviewId: string;
  discipline: string;
  engine: { name: string; version: string };
  standard: { name: string; version: string };
  summary: { checked: number; passed: number; advisories: number; warnings: number; violations: number };
  findings: WireFinding[];
}

/** A four-finding review across two disciplines and all three severities, so a
 *  single filter run exercises every branch the node has. */
const REVIEW: Value = {
  reviewId: 'rev_fixture',
  discipline: 'code',
  engine: { name: 'mock-code-review', version: '1.0.0' },
  standard: { name: 'IBC', version: 'IBC 2024' },
  summary: { checked: 10, passed: 6, advisories: 1, warnings: 1, violations: 2 },
  findings: [
    {
      id: 'f_001',
      ruleId: 'ANSI-404.2.3',
      title: 'Manoeuvring clearance',
      severity: 'violation',
      message: 'Door d_02 has 900 mm of latch-side clearance; 1065 mm is required.',
      level: 2,
      discipline: 'accessibility',
      elementIds: ['d_02'],
      elementGuids: [],
    },
    {
      id: 'f_002',
      ruleId: 'IBC-1010.1.1',
      title: 'Door clear width',
      severity: 'violation',
      message: 'Egress door d_01 has a clear width of 760 mm; at least 813 mm is required.',
      level: 1,
      discipline: 'code',
      elementIds: ['d_01'],
      elementGuids: [],
    },
    {
      id: 'f_003',
      ruleId: 'IBC-1017.2',
      title: 'Exit access travel distance',
      severity: 'warning',
      message: 'Room r_04 is 74.1 m from the nearest exit; distances over 61 m warrant sprinkler confirmation.',
      level: 1,
      discipline: 'code',
      elementIds: ['r_04'],
      elementGuids: [],
    },
    {
      id: 'f_004',
      ruleId: 'AEC-EFF-1',
      title: 'Low plan efficiency',
      severity: 'advisory',
      message: 'Plan efficiency is 0.54 net-to-gross (below 0.6).',
      level: null,
      discipline: 'code',
      elementIds: [],
      elementGuids: [],
    },
  ],
};

let host: PluginHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  await cleanupTempDirs();
});

describe('the first-party aec-review plugin, through a real host', () => {
  it('loads out of process and contributes all seven aec.review.* node types', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();

    host = createPluginHost({
      bundledDirs: [BUNDLED_PLUGINS_DIR],
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: { 'aec-review': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities().capabilities,
    });

    const plugins = await host.discover();
    const plugin = plugins.find((p) => p.id === 'aec-review');
    expect(plugin, `no plugin found in ${BUNDLED_PLUGINS_DIR}`).toBeDefined();
    expect(plugin!.error).toBeUndefined();
    expect(plugin!.state).toBe('loaded');
    expect(plugin!.source).toBe('bundled');
    expect(plugin!.manifest.namespace).toBe('aec.review');

    // The whole node set, and it needs no capability at all — the review nodes
    // are mocks over pure computation (§8.2's "declared inputs/params" row).
    expect(plugin!.nodeTypes.slice().sort()).toEqual(AEC_REVIEW_NODE_TYPES);
    expect(plugin!.manifest.permissions).toEqual([]);

    // One process for the package, not one per node (ADR-0008 §1).
    expect(processes).toHaveLength(1);
    const pid = processes[0].pid;
    expect(pid).toBeDefined();
    expect(pid).not.toBe(process.pid);
    // Signal 0 asks the OS whether that pid exists rather than asking our own
    // bookkeeping — the difference between "a process is running" and "we
    // recorded a number".
    expect(() => process.kill(pid!, 0)).not.toThrow();

    // The palette is fed from the same place, so a node the host lists but
    // cannot offer would be a lie the UI would repeat.
    expect(
      host
        .nodeModules()
        .map((mod) => mod.manifest.type)
        .sort(),
    ).toEqual(AEC_REVIEW_NODE_TYPES);
  }, 60_000);

  it('executes aec.review.filter_findings in the child process and returns the right answer', async () => {
    const userDir = await tempDir();
    const { spawn, processes } = recordingSpawn();

    host = createPluginHost({
      bundledDirs: [BUNDLED_PLUGINS_DIR],
      userDir,
      childEntry: CHILD_ENTRY,
      spawn,
      consent: { 'aec-review': { enabled: true, permissions: [] } },
      capabilities: stubCapabilities().capabilities,
    });
    await host.discover();

    const filter = host.nodeModules().find((mod) => mod.manifest.type === 'aec.review.filter_findings');
    expect(filter).toBeDefined();

    // The param schema crossed the wire intact, which is what lets the testkit
    // (and the inspector form) apply defaults for the keys we do not set.
    expect(filter!.manifest.caching).toBe('pure');
    expect(filter!.manifest.params.properties?.include_advisories.default).toBe(false);
    expect(filter!.manifest.inputs.map((port) => port.id)).toEqual(['review']);

    const run = await runNode(filter!, {
      inputs: { review: REVIEW },
      params: { disciplines: 'code', renumber: true },
    });

    expect(run.outputs.kept_count).toBe(2);
    expect(run.outputs.dropped_count).toBe(2);

    const result = run.outputs.result as unknown as WireReview;
    // Kept: the two `code` findings that are not advisories. Dropped: the
    // accessibility violation and the advisory.
    expect(result.findings.map((f) => f.ruleId)).toEqual(['IBC-1010.1.1', 'IBC-1017.2']);
    // `renumber: true` reassigns f_001… over the kept set, so the ids differ
    // from the ones that went in — a value the child computed, not an echo.
    expect(result.findings.map((f) => f.id)).toEqual(['f_001', 'f_002']);
    // The summary is recomputed to agree with the findings beside it.
    expect(result.summary).toEqual({ checked: 10, passed: 8, advisories: 0, warnings: 1, violations: 1 });
    // …and the review's identity is carried through untouched.
    expect(result.reviewId).toBe('rev_fixture');
    expect(result.discipline).toBe('code');
    expect(result.standard).toEqual({ name: 'IBC', version: 'IBC 2024' });

    // Progress travels back over the same wire and is attributed to this exec.
    expect(run.progress.at(-1)).toEqual({ fraction: 1, message: 'kept 2 of 4 finding(s)' });

    // Finally: it really did cross a process boundary. The exec left the host
    // as an RPC message aimed at a child with a different pid — if the plugin
    // were ever loaded in-process, none of this would exist.
    expect(processes).toHaveLength(1);
    expect(processes[0].pid).not.toBe(process.pid);
    const execs = processes[0].sent.filter((message): message is ExecMessage => message.t === 'exec');
    expect(execs.map((message) => message.nodeType)).toEqual(['aec.review.filter_findings']);
  }, 60_000);
});
