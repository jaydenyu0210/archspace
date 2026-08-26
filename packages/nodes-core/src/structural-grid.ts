/**
 * aec.generate_structural_grid — MOCK of a structural layout backend.
 * A column grid is laid over the ACTUAL site the floor plan reports, framed
 * with beams per storey, and the frame is quantified (steel, slab, embodied
 * carbon) from that geometry — so changing the bays, the system or the plan
 * genuinely changes every number downstream. The StructuralGridResult shape
 * (shapes.ts) is the contract a real layout backend must return; swapping one
 * in is a change inside execute() only.
 *
 * Mock layout: grid lines every bay_width_mm on x and bay_depth_mm on y, with
 * a final line at the site edge whenever the last bay is a remainder; a column
 * on every intersection, carried by every level of the plan; beams between
 * adjacent columns along both axes on every level. The seeded PRNG is used
 * only for the grid id and ±1 % column-size jitter.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  FloorPlanResult,
  GridBeam,
  GridColumn,
  GridLine,
  StructuralGridResult,
  StructuralSystem,
  TableValue,
} from './shapes.js';
import { fnv1a, hex8, mulberry32, requireInput, round2, sleep, toValue } from './util.js';

export interface GenerateStructuralGridParams {
  system: StructuralSystem;
  bay_width_mm: number;
  bay_depth_mm: number;
  seed: number;
  mock_latency_ms: number;
}

/**
 * Per-system framing rules. Every figure is a concept-stage rule of thumb, and
 * every one of them is applied to the measured span — never to a constant.
 */
interface SystemRules {
  /** Beam depth = span / beamSpanRatio. */
  beamSpanRatio: number;
  /** Slab / deck / panel depth = maxSpan / slabSpanRatio. */
  slabSpanRatio: number;
  /** Structural steel per column per storey, tonnes. */
  columnTonnes: number;
  /** Structural steel per beam, tonnes. */
  beamTonnes: number;
  /** Column section range (square), mm. */
  minColumnMm: number;
  maxColumnMm: number;
  /** kg CO₂e per tonne of steel — 0 where the carbon is slab-driven. */
  carbonPerTonne: number;
  /** kg CO₂e per m³ of slab volume — negative where the material sequesters. */
  carbonPerSlabM3: number;
}

const SYSTEMS: Record<StructuralSystem, SystemRules> = {
  // Composite steel frame: beams at span/20 under a metal-deck slab at
  // span/50. Steel tonnage is the whole frame, at 1850 kg CO₂e per tonne.
  steel_frame: {
    beamSpanRatio: 20,
    slabSpanRatio: 50,
    columnTonnes: 0.85,
    beamTonnes: 0.42,
    minColumnMm: 300,
    maxColumnMm: 450,
    carbonPerTonne: 1850,
    carbonPerSlabM3: 0,
  },
  // Concrete flat slab: slab at span/28, band beams at span/24. The steel
  // figure is reinforcement only — ~14 % of the steel-frame factors — and the
  // carbon is the concrete itself at 120 kg CO₂e per m³.
  concrete_flat_slab: {
    beamSpanRatio: 24,
    slabSpanRatio: 28,
    columnTonnes: 0.12,
    beamTonnes: 0.06,
    minColumnMm: 400,
    maxColumnMm: 600,
    carbonPerTonne: 0,
    carbonPerSlabM3: 120,
  },
  // Timber CLT: glulam beams at span/22 under CLT panels at span/30. The steel
  // figure is connectors and fixings only — ~5 % of the steel-frame factors —
  // and the panel volume SEQUESTRES carbon at 450 kg CO₂e per m³, so the
  // embodied-carbon metric legitimately comes out negative.
  timber_clt: {
    beamSpanRatio: 22,
    slabSpanRatio: 30,
    columnTonnes: 0.04,
    beamTonnes: 0.02,
    minColumnMm: 400,
    maxColumnMm: 500,
    carbonPerTonne: 0,
    carbonPerSlabM3: -450,
  },
};

/**
 * Column sizing runs off an axial-load proxy: tributary area × storeys carried,
 * in m²·storeys. 40 m²·storeys (a corner column of a single-storey remainder
 * bay) sits at the bottom of the system's section range; 700 m²·storeys (a
 * 15 m interior bay carrying a dozen floors) sits at the top.
 */
const LOAD_INDEX_MIN = 40;
const LOAD_INDEX_MAX = 700;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Round to the nearest 25 mm — the granularity beams and slabs are drawn at. */
function round25(n: number): number {
  return Math.round(n / 25) * 25;
}

/** Round to the nearest 5 mm — fine enough to show the ±1 % column jitter. */
function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

/**
 * Grid-line positions along one axis: 0, spacing, 2·spacing … strictly inside
 * the site, plus a final line on the site edge (so a remainder bay is framed
 * rather than dropped, and an exact fit adds no duplicate line).
 */
function axisPositions(sizeMm: number, spacingMm: number): number[] {
  const positions = [0];
  for (let p = spacingMm; p < sizeMm; p += spacingMm) positions.push(p);
  positions.push(sizeMm);
  return positions;
}

/** Spreadsheet-style line ids: A, B … Z, AA, AB … */
function xLineId(index: number): string {
  let id = '';
  for (let i = index; i >= 0; i = Math.floor(i / 26) - 1) {
    id = String.fromCharCode(65 + (i % 26)) + id;
  }
  return id;
}

/**
 * Tributary half-bay either side of a grid position — the real load path, so
 * edge and corner columns come out smaller than interior ones.
 */
function tributaryMm(positions: number[], i: number): number {
  const before = i > 0 ? (positions[i] - positions[i - 1]) / 2 : 0;
  const after = i < positions.length - 1 ? (positions[i + 1] - positions[i]) / 2 : 0;
  return before + after;
}

export const generateStructuralGridNode: NodeModule<GenerateStructuralGridParams> = {
  manifest: {
    type: 'aec.generate_structural_grid',
    version: 1,
    label: 'Generate Structural Grid',
    description:
      'Mock structural layout backend: lays a column grid and framing over the generated floor plan and estimates the frame.',
    category: 'Generate',
    keywords: ['structure', 'grid', 'columns', 'beams', 'framing', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        system: {
          type: 'string',
          title: 'Structural system',
          enum: ['steel_frame', 'concrete_flat_slab', 'timber_clt'],
          default: 'steel_frame',
        },
        bay_width_mm: {
          type: 'integer',
          title: 'Bay width (mm)',
          default: 7500,
          minimum: 3000,
          maximum: 15000,
        },
        bay_depth_mm: {
          type: 'integer',
          title: 'Bay depth (mm)',
          default: 7500,
          minimum: 3000,
          maximum: 15000,
        },
        seed: { type: 'integer', title: 'Seed', default: 7, minimum: 0 },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 800,
          minimum: 0,
        },
      },
    },
    inputs: [{ id: 'floor_plan', type: 'json', label: 'Floor plan', required: true }],
    outputs: [
      { id: 'grid', type: 'json', label: 'Grid' },
      { id: 'columns', type: 'table', label: 'Columns' },
    ],
  },

  async execute(ctx, inputs, params) {
    const plan = requireInput<FloorPlanResult>(inputs, 'floor_plan', 'aec.generate_structural_grid');
    if (plan.levels.length === 0) {
      throw new Error(
        'aec.generate_structural_grid: the floor plan has no levels; there is nothing to frame.',
      );
    }

    const rules = SYSTEMS[params.system];
    if (!rules) {
      throw new Error(`aec.generate_structural_grid: unknown system "${String(params.system)}"`);
    }

    // The grid is laid in the plan's own coordinates (mm, site-local origin).
    const siteWidthMm = plan.site.widthMm;
    const siteDepthMm = plan.site.depthMm;
    const levelIndices = plan.levels.map((l) => l.level);
    const levelCount = levelIndices.length;

    // Seeded from the plan and the seed param: same plan + seed ⇒ same grid id
    // and the same jitter sequence, always.
    const rng = mulberry32(fnv1a(`${plan.planId}:${params.seed}`));
    const gridId = `grid_${hex8(rng)}`;

    ctx.progress(0.15, 'laying grid lines');
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    const xs = axisPositions(siteWidthMm, params.bay_width_mm);
    const ys = axisPositions(siteDepthMm, params.bay_depth_mm);
    const gridLines: GridLine[] = [
      ...xs.map((positionMm, i): GridLine => ({ id: xLineId(i), axis: 'x', positionMm })),
      ...ys.map((positionMm, i): GridLine => ({ id: String(i + 1), axis: 'y', positionMm })),
    ];

    // One column on every intersection, carried by every level of the plan.
    const columns: GridColumn[] = [];
    for (let ix = 0; ix < xs.length; ix++) {
      for (let iy = 0; iy < ys.length; iy++) {
        // Axial-load proxy: the column's own tributary area × storeys above.
        const tribM2 = (tributaryMm(xs, ix) * tributaryMm(ys, iy)) / 1e6;
        const loadIndex = tribM2 * levelCount;
        const t = clamp(
          (loadIndex - LOAD_INDEX_MIN) / (LOAD_INDEX_MAX - LOAD_INDEX_MIN),
          0,
          1,
        );
        const nominalMm = rules.minColumnMm + t * (rules.maxColumnMm - rules.minColumnMm);
        const jitter = 0.99 + rng() * 0.02; // ±1 %, seeded — the only randomness
        const sizeMm = round5(
          clamp(nominalMm * jitter, rules.minColumnMm, rules.maxColumnMm),
        );
        columns.push({
          id: `c_${String(columns.length + 1).padStart(3, '0')}`,
          gridRef: `${xLineId(ix)}-${String(iy + 1)}`,
          position: [xs[ix], ys[iy]],
          sizeMm: { width: sizeMm, depth: sizeMm },
          levels: [...levelIndices],
        });
      }
    }

    ctx.progress(0.55, `placing ${columns.length} columns`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // Beams between adjacent columns along both axes, on every level.
    const beams: GridBeam[] = [];
    for (const level of levelIndices) {
      let n = 0;
      const addBeam = (start: [number, number], end: [number, number]): void => {
        const spanMm = Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]);
        beams.push({
          id: `b_${level}_${String(++n).padStart(3, '0')}`,
          start,
          end,
          level,
          spanMm,
          depthMm: round25(spanMm / rules.beamSpanRatio),
        });
      };
      for (let iy = 0; iy < ys.length; iy++) {
        for (let ix = 0; ix < xs.length - 1; ix++) {
          addBeam([xs[ix], ys[iy]], [xs[ix + 1], ys[iy]]);
        }
      }
      for (let ix = 0; ix < xs.length; ix++) {
        for (let iy = 0; iy < ys.length - 1; iy++) {
          addBeam([xs[ix], ys[iy]], [xs[ix], ys[iy + 1]]);
        }
      }
    }

    ctx.progress(0.85, `framing ${beams.length} beams`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    // Metrics, all from the geometry just generated.
    const maxSpanMm = beams.reduce((max, b) => (b.spanMm > max ? b.spanMm : max), 0);
    const slabDepthMm = round25(maxSpanMm / rules.slabSpanRatio);
    const steelTonnes = round2(
      columns.length * levelCount * rules.columnTonnes + beams.length * rules.beamTonnes,
    );
    // Slab volume = the full floor plate, at the slab depth, on every level.
    const slabVolumeM3 = ((siteWidthMm / 1000) * (siteDepthMm / 1000) * slabDepthMm * levelCount) / 1000;
    const embodiedCarbonKgCo2e = round2(
      steelTonnes * rules.carbonPerTonne + slabVolumeM3 * rules.carbonPerSlabM3,
    );

    const result: StructuralGridResult = {
      gridId,
      generator: { name: 'mock-structure', version: '1.0.0', seed: params.seed },
      units: 'mm',
      system: params.system,
      bay: { widthMm: params.bay_width_mm, depthMm: params.bay_depth_mm },
      gridLines,
      columns,
      beams,
      metrics: {
        columnCount: columns.length,
        beamCount: beams.length,
        maxSpanMm,
        slabDepthMm,
        steelTonnes,
        embodiedCarbonKgCo2e,
      },
    };

    const columnsTable: TableValue = {
      columns: [
        { id: 'id', label: 'ID' },
        { id: 'grid_ref', label: 'Grid ref' },
        { id: 'x_mm', label: 'X (mm)' },
        { id: 'y_mm', label: 'Y (mm)' },
        { id: 'size_mm', label: 'Size (mm)' },
        { id: 'levels', label: 'Levels' },
      ],
      rows: columns.map(
        (c): Record<string, Value> => ({
          id: c.id,
          grid_ref: c.gridRef,
          x_mm: c.position[0],
          y_mm: c.position[1],
          size_mm: `${c.sizeMm.width} × ${c.sizeMm.depth}`,
          levels: c.levels.length,
        }),
      ),
    };

    ctx.progress(1, 'structural grid complete');

    return { grid: toValue(result), columns: toValue(columnsTable) };
  },
};
