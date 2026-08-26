/**
 * Shared pipeline runner for the nodes-core test suite: brief → program → plan
 * → bim → report, with a hand-authored review FIXTURE standing where the review
 * node used to run.
 *
 * The review step is a fixture, not a node run, because `aec.review.*` ships in
 * plugins/aec-review (ADR-0008) and nodes-core must never import a plugin — that
 * inversion is the exact thing the plugin boundary exists to forbid. The
 * alternative we rejected was importing the review node back across the
 * boundary: besides inverting the dependency, it would break this suite wherever
 * that plugin is not installed, and it would let a tweak to the plugin's mock
 * heuristics silently rewrite the input `aec.generate_compliance_report` is
 * being tested against.
 *
 * Writing the fixture out by hand is the better design on its own terms. The
 * report node depends on a ReviewResult contract (../src/shapes.ts), and that
 * contract was previously implicit — inherited from whatever the review mock
 * happened to emit. Stating it literally pins it: the report suite now names the
 * findings, severities and counts it renders from, and a change to the contract
 * shows up here as an edit rather than as a mystery diff downstream.
 */
import { createMemoryAssetStore, type MemoryAssetStore } from '@archspace/node-sdk';
import { runNode, type RunNodeResult } from '@archspace/node-sdk/testkit';
import {
  generateBimModelNode,
  generateComplianceReportNode,
  generateFloorPlanNode,
  projectBriefNode,
  spaceProgramNode,
  type ComplianceReviewResult,
  type FindingSeverity,
  type ReviewFinding,
} from '../src/index.js';
import { toValue } from '../src/util.js';

/**
 * What a test may vary on the review fixture. `summary` is deliberately not
 * settable: it is derived below, so no caller can desynchronise the counts from
 * the findings they asked for — a review result whose summary contradicts its
 * findings is not a case the report node is ever expected to survive.
 */
export interface ReviewFixtureOverrides {
  findings?: ReviewFinding[];
  /** Checks the engine claims to have run; `passed` is this minus the findings. */
  checked?: number;
  codeVersion?: string;
}

/** Total checks the default fixture claims — comfortably more than it fails. */
const DEFAULT_CHECKED = 42;

/**
 * The default findings: two violations under distinct rule ids, two warnings,
 * one advisory. Deliberately spread across every severity and across levels
 * (plus one level-less advisory) so the report node's severity sectioning, its
 * `(level n)` suffix and its rule-id listing are all exercised by one run.
 *
 * Messages quote measured vs required values and name plan elements, because
 * that is what shapes.ts requires of a real review backend — a fixture that
 * cut corners here would stop being the contract it claims to document.
 * Freshly built per call: a fixture shared by reference could be mutated by one
 * test and silently poison the next.
 */
function defaultFindings(): ReviewFinding[] {
  return [
    {
      id: 'f_001',
      ruleId: 'IBC-1010.1.1',
      title: 'Door clear width',
      severity: 'violation',
      message:
        'Egress door d_0_03 (room r_0_02 "Open Office A") on level 0 has a clear width of 800 mm; at least 813 mm is required.',
      level: 0,
      discipline: 'code',
      elementIds: ['d_0_03'],
      // Literal 22-char IFC GlobalIds, as a real review anchors findings to.
      elementGuids: ['2mK9x$Qb1Lp7Rv3Nd0Wf5H'],
    },
    {
      id: 'f_002',
      ruleId: 'IBC-1020.3',
      title: 'Corridor width',
      severity: 'violation',
      message:
        'Corridor r_1_00 on level 1 is 1000 mm wide; corridors serving an occupant load of 84 (≥ 50) require at least 1120 mm.',
      level: 1,
      discipline: 'code',
      elementIds: ['r_1_00'],
      elementGuids: ['0Jt4C_yS8Mn2Pk6Bq9Xz1D'],
    },
    {
      id: 'f_003',
      ruleId: 'IBC-1010.1.1',
      title: 'Door clear width',
      severity: 'warning',
      message:
        'Egress door d_1_01 (room r_1_04 "Meeting Room 3") on level 1 has a clear width of 900 mm; 914 mm is recommended for accessible egress.',
      level: 1,
      discipline: 'code',
      elementIds: ['d_1_01'],
      elementGuids: ['7Vw1Ge5$Ad3Uh8Ty2Fs6Nq'],
    },
    {
      id: 'f_004',
      ruleId: 'IBC-1017.2',
      title: 'Exit access travel distance',
      severity: 'warning',
      message:
        'Room r_2_05 "Open Office C" on level 2 is 68.4 m from the nearest exit; distances over 61 m warrant sprinkler confirmation.',
      level: 2,
      discipline: 'code',
      elementIds: ['r_2_05'],
      elementGuids: ['4Rb8Zk0Lm6Cw2Jp9Hx3Vt5'],
    },
    {
      id: 'f_005',
      ruleId: 'AEC-EFF-1',
      title: 'Low plan efficiency',
      severity: 'advisory',
      message:
        'Plan efficiency is 0.58 net-to-gross (below 0.6); consider tightening circulation.',
      level: null,
      discipline: 'code',
      elementIds: [],
      elementGuids: [],
    },
  ];
}

/**
 * The review result the report node is fed. Typed `ComplianceReviewResult`
 * rather than the bare `ReviewResult` because the report node reads `code`
 * for the version it prints, so the `code`-discipline shape is the contract
 * actually in play here.
 */
export function reviewFixture(overrides: ReviewFixtureOverrides = {}): ComplianceReviewResult {
  const findings = overrides.findings ?? defaultFindings();
  const checked = overrides.checked ?? DEFAULT_CHECKED;
  const codeVersion = overrides.codeVersion ?? 'IBC 2024';
  const count = (severity: FindingSeverity): number =>
    findings.filter((f) => f.severity === severity).length;

  return {
    reviewId: 'rev_5f3a91c0',
    discipline: 'code',
    engine: { name: 'mock-code-review', version: '1.0.0' },
    standard: { name: 'IBC', version: codeVersion },
    code: { jurisdiction: 'IBC', version: codeVersion },
    summary: {
      checked,
      passed: checked - findings.length,
      advisories: count('advisory'),
      warnings: count('warning'),
      violations: count('violation'),
    },
    findings,
  };
}

export interface PipelineOverrides {
  brief?: Record<string, unknown>;
  program?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  bim?: Record<string, unknown>;
  /** Vary the review fixture — the one step that is data, not a node run. */
  review?: ReviewFixtureOverrides;
  report?: Record<string, unknown>;
}

export interface PipelineRun {
  assets: MemoryAssetStore;
  brief: RunNodeResult<unknown>;
  program: RunNodeResult<unknown>;
  plan: RunNodeResult<unknown>;
  bim: RunNodeResult<unknown>;
  /** The fixture handed to the report node. Not a node result: see the header. */
  review: ComplianceReviewResult;
  report: RunNodeResult<unknown>;
}

/** Run the five-node pipeline, wiring each node's outputs downstream. */
export async function runPipeline(overrides: PipelineOverrides = {}): Promise<PipelineRun> {
  const assets = createMemoryAssetStore();

  const brief = await runNode(projectBriefNode, { params: overrides.brief, assets });
  const program = await runNode(spaceProgramNode, {
    params: overrides.program,
    inputs: { brief: brief.outputs.brief },
    assets,
  });
  const plan = await runNode(generateFloorPlanNode, {
    params: { mock_latency_ms: 0, ...overrides.plan },
    inputs: { brief: brief.outputs.brief, program: program.outputs.program },
    assets,
  });
  const bim = await runNode(generateBimModelNode, {
    params: { mock_latency_ms: 0, ...overrides.bim },
    inputs: { floor_plan: plan.outputs.floor_plan },
    assets,
  });
  const review = reviewFixture(overrides.review);
  const report = await runNode(generateComplianceReportNode, {
    params: { mock_latency_ms: 0, ...overrides.report },
    inputs: { brief: brief.outputs.brief, review: toValue(review) },
    assets,
  });

  return { assets, brief, program, plan, bim, review, report };
}
