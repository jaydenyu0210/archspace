/**
 * Result shapes for the aec.* concept-design nodes.
 *
 * The generate/review nodes in this package are MOCKS standing in for real
 * generative and review backends. The output shapes below are the contract:
 * they are structured exactly as a real integration would return them, so a
 * later real backend is a substitution inside execute(), never a port/shape
 * rewrite.
 */
import type { Value } from '@archspace/node-sdk';

/** A `table` wire value (ARCHITECTURE §6.1). */
export interface TableColumn {
  id: string;
  label?: string;
}

/** A `table` wire value (ARCHITECTURE §6.1). */
export interface TableValue {
  columns: TableColumn[];
  rows: Record<string, Value>[];
}

/** Output of aec.project_brief — the brief every downstream node consumes. */
export interface ProjectBrief {
  projectName: string;
  buildingType: 'office' | 'residential' | 'school' | 'mixed_use';
  code: { jurisdiction: 'IBC'; version: string }; // e.g. version "IBC 2024"
  site: { widthM: number; depthM: number; areaM2: number };
  floors: number;
  targetGrossAreaM2: number;
  occupancyClass: string;
  notes: string;
}

/** Output of aec.space_program (`summary` port). */
export interface SpaceProgramSummary {
  netAreaM2: number;
  circulationAreaM2: number;
  grossAreaM2: number;
  efficiency: number;
  spaceCount: number;
  perLevel: { level: number; areaM2: number; occupantLoad: number }[];
}

/**
 * Output of aec.generate_floor_plan. MOCK CONTRACT: a real generative layout
 * backend must return this shape.
 */
export interface FloorPlanResult {
  planId: string; // "plan_" + 8 hex derived from the seed (never Date.now)
  generator: { name: 'mock-floorplan'; version: string; seed: number };
  units: 'mm';
  site: { widthMm: number; depthMm: number };
  levels: FloorPlanLevel[];
  metrics: { grossAreaM2: number; netAreaM2: number; efficiency: number };
}

/** One storey of a FloorPlanResult. A real backend must return this shape. */
export interface FloorPlanLevel {
  level: number; // 0-based storey index
  elevationMm: number;
  rooms: PlanRoom[]; // includes one 'circulation' corridor room per level
  walls: PlanWall[];
  doors: PlanDoor[];
  exits: PlanExit[]; // stair/exit locations
}

/** A room in a floor plan level. A real backend must return this shape. */
export interface PlanRoom {
  id: string;
  spaceId: string | null;
  name: string;
  function: string;
  polygon: [number, number][];
  areaM2: number;
}

/** A wall segment. A real backend must return this shape. */
export interface PlanWall {
  id: string;
  start: [number, number];
  end: [number, number];
  thicknessMm: number;
  kind: 'exterior' | 'interior';
}

/** A door. A real backend must return this shape. */
export interface PlanDoor {
  id: string;
  roomId: string;
  position: [number, number];
  widthMm: number;
}

/** A stair/exit location. A real backend must return this shape. */
export interface PlanExit {
  id: string;
  kind: 'stair' | 'door';
  position: [number, number];
}

/**
 * Output of aec.generate_bim_model (`summary` port). MOCK CONTRACT: a real
 * BIM authoring backend must return this shape alongside the IFC asset.
 */
export interface BimModelSummary {
  schema: 'IFC4';
  generator: { name: 'mock-bim'; version: string };
  storeys: number;
  elementCounts: Record<string, number>; // { IfcSpace: 24, IfcWall: 96, ... }
  spaces: { roomId: string; guid: string; name: string; level: number }[];
  doors: { doorId: string; guid: string; level: number }[];
}

// ---------------------------------------------------------------------------
// Review vocabulary — shared by every node in the Review category
// ---------------------------------------------------------------------------

/**
 * Which rule set produced a finding. Every review node stamps its own; the
 * merge node emits 'merged'. Keeping one vocabulary is what lets findings from
 * four different reviewers flow into one merge, one filter, one fixer and one
 * report without any consumer special-casing the producer.
 */
export type ReviewDiscipline =
  | 'code'
  | 'accessibility'
  | 'zoning'
  | 'structural'
  | 'energy'
  | 'merged';

export type FindingSeverity = 'advisory' | 'warning' | 'violation';

/**
 * One finding from any review node. A real review backend must return this
 * shape: a rule id, a severity, a message quoting measured vs required values,
 * and the element ids (plus IFC GUIDs when a model was supplied) the finding
 * is anchored to.
 */
export interface ReviewFinding {
  id: string; // "f_001"…
  ruleId: string; // "IBC-1010.1.1"
  title: string;
  severity: FindingSeverity;
  message: string; // concrete: names rooms/doors and measured vs required values
  level: number | null;
  elementIds: string[]; // plan ids
  elementGuids: string[]; // IFC guids when available
  /** Set by every review node in this package. Optional so that findings
   *  authored against the original single-discipline shape still typecheck. */
  discipline?: ReviewDiscipline;
}

export interface ReviewSummary {
  checked: number;
  passed: number;
  advisories: number;
  warnings: number;
  violations: number;
}

/**
 * The result every review node emits on its `result` port. MOCK CONTRACT: a
 * real review engine must return this shape.
 */
export interface ReviewResult {
  reviewId: string;
  discipline: ReviewDiscipline;
  engine: { name: string; version: string };
  /** The rule set checked against — "IBC" 2024, "ANSI A117.1" 2017, … */
  standard: { name: string; version: string };
  summary: ReviewSummary;
  findings: ReviewFinding[];
}

/**
 * Output of aec.code_compliance_review (`result` port). A ReviewResult that
 * additionally keeps the `code` field it shipped with, so documents and
 * consumers written against the original shape keep working.
 */
export interface ComplianceReviewResult extends ReviewResult {
  discipline: 'code';
  engine: { name: 'mock-code-review'; version: string };
  code: { jurisdiction: 'IBC'; version: string };
}

/** The original name for a finding, kept as an alias of the shared shape. */
export type ComplianceFinding = ReviewFinding;

/** One contributing review inside a merged result. */
export interface MergedReviewSource {
  reviewId: string;
  discipline: ReviewDiscipline;
  standard: { name: string; version: string };
  summary: ReviewSummary;
}

/** Output of aec.merge_findings (`result` port). */
export interface MergedReviewResult extends ReviewResult {
  discipline: 'merged';
  sources: MergedReviewSource[];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Output of aec.site_constraints — the zoning envelope a scheme has to fit
 * inside. MOCK CONTRACT: a real jurisdiction/GIS lookup must return this shape.
 */
export interface SiteConstraints {
  jurisdiction: string;
  zoningDistrict: string;
  lot: { widthM: number; depthM: number; areaM2: number };
  setbacksM: { front: number; rear: number; side: number };
  limits: {
    maxHeightM: number;
    maxStoreys: number;
    maxFar: number; // floor area ratio
    maxLotCoveragePct: number;
    minParkingPer100M2: number;
  };
  /** The lot minus its setbacks — the footprint a massing may occupy. */
  buildable: { widthM: number; depthM: number; areaM2: number };
  /** The binding gross-area ceiling: the lesser of the FAR and coverage caps. */
  maxGrossAreaM2: number;
  notes: string[];
}

/**
 * Output of aec.parking_estimate (`estimate` port). This node is the worked
 * example in docs/creating-nodes.md — deliberately the smallest thing that is
 * still a real node.
 */
export interface ParkingEstimate {
  grossAreaM2: number;
  ratioPer100M2: number;
  ratioSource: 'param' | 'constraints' | 'default';
  spaces: { total: number; standard: number; accessible: number; evReady: number };
  areaM2: number;
  /** Parking area as a share of the building's gross area. */
  areaRatio: number;
}

/** One desired adjacency between two space functions. */
export interface AdjacencyRequirement {
  from: string;
  to: string;
  weight: 'required' | 'preferred' | 'avoid';
  maxDistanceM: number | null;
  rationale: string;
}

/** Output of aec.adjacency_matrix (`adjacency` port). */
export interface AdjacencyMatrixResult {
  buildingType: string;
  functions: string[];
  requirements: AdjacencyRequirement[];
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export type MassingStrategy = 'bar' | 'courtyard' | 'l_shape' | 'tower_podium';

/** One storey of a massing scheme. Polygons are metres, site-local. */
export interface MassingStorey {
  level: number;
  elevationM: number;
  heightM: number;
  areaM2: number;
  polygon: [number, number][];
}

/**
 * Output of aec.generate_massing. MOCK CONTRACT: a real massing/generative
 * design backend must return this shape.
 */
export interface MassingResult {
  massingId: string; // "mass_" + 8 hex derived from the seed
  generator: { name: 'mock-massing'; version: string; seed: number };
  units: 'm';
  strategy: MassingStrategy;
  footprint: { widthM: number; depthM: number; areaM2: number; polygon: [number, number][] };
  storeys: MassingStorey[];
  metrics: {
    grossAreaM2: number;
    heightM: number;
    far: number;
    lotCoveragePct: number;
    facadeAreaM2: number;
    surfaceToVolumeRatio: number;
  };
}

export type StructuralSystem = 'steel_frame' | 'concrete_flat_slab' | 'timber_clt';

/** A structural grid line — "A", "B" on x; "1", "2" on y. */
export interface GridLine {
  id: string;
  axis: 'x' | 'y';
  positionMm: number;
}

export interface GridColumn {
  id: string;
  gridRef: string; // "B-3" — the intersection this column sits on
  position: [number, number];
  sizeMm: { width: number; depth: number };
  levels: number[];
}

export interface GridBeam {
  id: string;
  start: [number, number];
  end: [number, number];
  level: number;
  spanMm: number;
  depthMm: number;
}

/**
 * Output of aec.generate_structural_grid. MOCK CONTRACT: a real structural
 * layout backend must return this shape.
 */
export interface StructuralGridResult {
  gridId: string;
  generator: { name: 'mock-structure'; version: string; seed: number };
  units: 'mm';
  system: StructuralSystem;
  bay: { widthMm: number; depthMm: number };
  gridLines: GridLine[];
  columns: GridColumn[];
  beams: GridBeam[];
  metrics: {
    columnCount: number;
    beamCount: number;
    maxSpanMm: number;
    slabDepthMm: number;
    steelTonnes: number;
    embodiedCarbonKgCo2e: number;
  };
}

/**
 * Output of aec.energy_performance_review (`metrics` port). MOCK CONTRACT: a
 * real energy simulation backend must return this shape alongside its findings.
 */
export interface EnergyMetrics {
  euiKwhM2Yr: number;
  targetEuiKwhM2Yr: number;
  windowToWallRatio: number;
  envelopeAreaM2: number;
  conditionedAreaM2: number;
  loads: { heatingKw: number; coolingKw: number; lightingKw: number; equipmentKw: number };
  annualEnergyKwh: number;
  carbonKgCo2eYr: number;
  /** End-use split; fractions sum to 1. */
  byEndUse: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------

export type PlanFixAction = 'widen_door' | 'widen_corridor' | 'add_exit' | 'enlarge_room';

/** One change aec.apply_plan_fixes made to the plan. */
export interface PlanChange {
  id: string; // "chg_001"…
  findingId: string;
  ruleId: string;
  action: PlanFixAction;
  targetId: string; // the plan element that changed
  level: number | null;
  before: Value;
  after: Value;
  description: string;
}

/** A finding the fixer could not resolve — surfaced, never silently dropped. */
export interface UnresolvedFinding {
  findingId: string;
  ruleId: string;
  severity: FindingSeverity;
  reason: string;
}

/**
 * Output of aec.apply_plan_fixes (`change_log` port). MOCK CONTRACT: a real
 * design-assistant backend must return the revised model plus this changeset —
 * including what it declined to touch.
 */
export interface PlanFixResult {
  fixId: string;
  fixer: { name: 'mock-plan-fixer'; version: string };
  basePlanId: string;
  revisedPlanId: string;
  applied: PlanChange[];
  unresolved: UnresolvedFinding[];
  summary: { requested: number; applied: number; unresolved: number };
}

export type ProgramAdjustStrategy = 'scale_area' | 'trim_function' | 'rebalance_levels';

export interface ProgramFunctionDelta {
  function: string;
  beforeAreaM2: number;
  afterAreaM2: number;
  deltaM2: number;
  beforeSpaces: number;
  afterSpaces: number;
}

/** Output of aec.adjust_program (`adjustment` port). */
export interface ProgramAdjustmentResult {
  strategy: ProgramAdjustStrategy;
  targetGrossAreaM2: number;
  beforeGrossAreaM2: number;
  afterGrossAreaM2: number;
  deltaM2: number;
  deltaPct: number;
  byFunction: ProgramFunctionDelta[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** One row of the schedule aec.generate_room_schedule produces. */
export interface RoomScheduleRow {
  roomId: string;
  number: string; // "02-14" — level-prefixed room number
  name: string;
  function: string;
  level: number;
  areaM2: number;
  occupantLoad: number;
  finishFloor: string;
  finishCeiling: string;
  guid: string | null; // IFC GUID when a BIM summary was supplied
}

/** Output of aec.generate_room_schedule (`summary` port). */
export interface RoomScheduleSummary {
  scheduleId: string;
  rowCount: number;
  totalAreaM2: number;
  byLevel: { level: number; rooms: number; areaM2: number }[];
  byFunction: { function: string; rooms: number; areaM2: number }[];
}

export type ComparisonVerdict = 'improved' | 'regressed' | 'unchanged' | 'mixed';

/**
 * Output of aec.compare_reviews (`comparison` port) — what a re-review actually
 * changed. Findings are matched across the two reviews by identity
 * (ruleId + level + sorted elementIds), never by finding id, because ids are
 * assigned per review run.
 */
export interface ReviewComparisonResult {
  comparisonId: string;
  before: { reviewId: string; discipline: ReviewDiscipline; summary: ReviewSummary };
  after: { reviewId: string; discipline: ReviewDiscipline; summary: ReviewSummary };
  resolved: ReviewFinding[]; // present before, gone after
  introduced: ReviewFinding[]; // absent before, present after
  persisting: ReviewFinding[]; // present in both
  delta: { violations: number; warnings: number; advisories: number };
  verdict: ComparisonVerdict;
}
