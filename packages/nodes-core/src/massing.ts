/**
 * aec.generate_massing — MOCK of a generative massing backend.
 *
 * Resolves the brief and the zoning envelope into a storey-by-storey building
 * volume. Every dimension is computed from the ACTUAL buildable envelope and
 * the brief's target area, so changing the site, the setbacks or the target
 * genuinely changes the massing. The seeded PRNG only supplies ±2 % dimensional
 * jitter, so a different seed is a visibly different but equally valid scheme.
 * The MassingResult shape (shapes.ts) is the contract a real backend must
 * return; swapping one in is a change inside execute() only.
 *
 * Geometry is metres, site-local, origin at the buildable envelope's corner.
 * Polygons are closed rings (the last vertex joins the first implicitly) and
 * every areaM2 is the shoelace area of the ring actually emitted.
 */
import type { NodeModule, Value } from '@archspace/node-sdk';
import type {
  MassingResult,
  MassingStorey,
  MassingStrategy,
  ProjectBrief,
  SiteConstraints,
  TableValue,
} from './shapes.js';
import { hex8, mulberry32, requireInput, round2, round3, sleep, toValue } from './util.js';

export interface GenerateMassingParams {
  strategy: MassingStrategy;
  seed: number;
  floor_to_floor_m: number;
  mock_latency_ms: number;
}

/** Daylight-driven maximum depth of a floor plate lit from both sides. */
const DAYLIGHT_DEPTH_M = 18;

/** Fraction of the podium footprint the tower keeps above level 1. */
const TOWER_FOOTPRINT_FRACTION = 0.55;

/** One storey outline plus the facade length that actually wraps it. */
interface Shape {
  polygon: [number, number][];
  widthM: number;
  depthM: number;
  areaM2: number;
  /** Facade length: the ring perimeter, plus the courtyard face where present. */
  perimeterM: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Signed-area shoelace, absolute value — the area of the ring as emitted. */
function shoelaceAreaM2(polygon: [number, number][]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

function ringPerimeterM(polygon: [number, number][]): number {
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

function roundPolygon(polygon: [number, number][]): [number, number][] {
  return polygon.map(([x, y]): [number, number] => [round2(x), round2(y)]);
}

/** A rectangle anchored at the envelope corner. */
function rect(x0: number, y0: number, w: number, d: number): [number, number][] {
  return [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + d],
    [x0, y0 + d],
  ];
}

function shapeFromRing(
  polygon: [number, number][],
  widthM: number,
  depthM: number,
  perimeterM?: number,
): Shape {
  const ring = roundPolygon(polygon);
  return {
    polygon: ring,
    widthM: round2(widthM),
    depthM: round2(depthM),
    areaM2: round2(shoelaceAreaM2(ring)),
    perimeterM: round2(perimeterM ?? ringPerimeterM(ring)),
  };
}

/**
 * The four strategies. `targetFootprintM2` is already clamped to the envelope;
 * `jitter` returns ±2 % and `shrink` returns −2 %..0 % (used where a dimension
 * fills the envelope and must not grow past it).
 */
function buildShape(
  strategy: MassingStrategy,
  envW: number,
  envD: number,
  targetFootprintM2: number,
  jitter: () => number,
  shrink: () => number,
): Shape {
  switch (strategy) {
    case 'bar': {
      // A slab no deeper than daylight allows, widened to reach the target.
      const depthM = clamp(DAYLIGHT_DEPTH_M * jitter(), 0, envD);
      const widthM = depthM > 0 ? clamp(targetFootprintM2 / depthM, 0, envW) : 0;
      return shapeFromRing(rect(0, 0, widthM, depthM), widthM, depthM);
    }

    case 'courtyard': {
      // An outer rectangle filling the envelope with a centred rectangular
      // void. The void is cut into the ring itself (outer boundary, a slit, the
      // void traversed the other way round), so the shoelace area of the
      // emitted polygon IS the ring area — never the outer area.
      const outerW = clamp(envW * shrink(), 0, envW);
      const outerD = clamp(envD * shrink(), 0, envD);
      const outerArea = outerW * outerD;
      const voidArea = outerArea - targetFootprintM2;
      if (voidArea <= 0 || outerArea <= 0) {
        // The target fills the envelope: no courtyard fits, emit the rectangle.
        return shapeFromRing(rect(0, 0, outerW, outerD), outerW, outerD);
      }
      const scale = Math.sqrt(voidArea / outerArea);
      const voidW = clamp(outerW * scale * jitter(), 0.5, outerW * 0.9);
      const voidD = clamp(voidArea / voidW, 0.5, outerD * 0.9);
      const vx0 = round2((outerW - voidW) / 2);
      const vy0 = round2((outerD - voidD) / 2);
      const vx1 = round2(vx0 + voidW);
      const vy1 = round2(vy0 + voidD);
      const ring: [number, number][] = [
        [0, 0],
        [outerW, 0],
        [outerW, outerD],
        [0, outerD],
        [0, vy0], // back down the left edge to the slit
        [vx0, vy0], // slit inward to the void
        [vx0, vy1], // the void, traversed against the outer ring
        [vx1, vy1],
        [vx1, vy0],
        [vx0, vy0],
        [0, vy0], // slit back out; the ring closes to [0, 0]
      ];
      // Facade wraps the outside AND the courtyard; the zero-width slit does not.
      const perimeterM = 2 * (outerW + outerD) + 2 * (vx1 - vx0 + (vy1 - vy0));
      return shapeFromRing(ring, outerW, outerD, perimeterM);
    }

    case 'l_shape': {
      // Two arms of one daylight-deep thickness in a corner of the envelope,
      // scaled to the target; when that hits the envelope the arms thicken.
      const armM = Math.min(DAYLIGHT_DEPTH_M * jitter(), Math.min(envW, envD));
      let widthM = envW;
      let depthM = envD;
      let thicknessM = armM;
      if (armM > 0) {
        // area = t · (W + D − t); scale W and D together to hit the target.
        const k = clamp((targetFootprintM2 / armM + armM) / (envW + envD), 0, 1);
        widthM = envW * k;
        depthM = envD * k;
        const span = widthM + depthM;
        if (k >= 1) {
          const disc = Math.max(0, span * span - 4 * Math.min(targetFootprintM2, widthM * depthM));
          thicknessM = (span - Math.sqrt(disc)) / 2;
        }
        thicknessM = clamp(thicknessM, 0, Math.min(widthM, depthM));
      } else {
        thicknessM = 0;
      }
      const t = thicknessM;
      const ring: [number, number][] = [
        [0, 0],
        [widthM, 0],
        [widthM, t],
        [t, t],
        [t, depthM],
        [0, depthM],
      ];
      return shapeFromRing(ring, widthM, depthM);
    }

    case 'tower_podium': {
      // The podium fills the envelope; the tower above it is handled by the
      // caller, which scales this footprint down and centres it.
      const widthM = clamp(envW * shrink(), 0, envW);
      const depthM = clamp(envD * shrink(), 0, envD);
      return shapeFromRing(rect(0, 0, widthM, depthM), widthM, depthM);
    }
  }
}

/** The tower plate: TOWER_FOOTPRINT_FRACTION of the podium, centred on it. */
function centredTower(podium: Shape): Shape {
  const scale = Math.sqrt(TOWER_FOOTPRINT_FRACTION);
  const widthM = podium.widthM * scale;
  const depthM = podium.depthM * scale;
  const x0 = (podium.widthM - widthM) / 2;
  const y0 = (podium.depthM - depthM) / 2;
  return shapeFromRing(rect(x0, y0, widthM, depthM), widthM, depthM);
}

export const generateMassingNode: NodeModule<GenerateMassingParams> = {
  manifest: {
    type: 'aec.generate_massing',
    version: 1,
    label: 'Generate Massing',
    description:
      'Mock generative massing: resolves the brief and zoning envelope into a storey-by-storey building volume.',
    category: 'Generate',
    keywords: ['massing', 'volume', 'envelope', 'generative', 'mock'],
    caching: 'never',
    lane: 'ai',
    params: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          title: 'Strategy',
          enum: ['bar', 'courtyard', 'l_shape', 'tower_podium'],
          default: 'bar',
        },
        seed: { type: 'integer', title: 'Seed', default: 7, minimum: 0 },
        floor_to_floor_m: {
          type: 'number',
          title: 'Floor to floor (m)',
          default: 3.5,
          minimum: 2.4,
          maximum: 6,
        },
        mock_latency_ms: {
          type: 'integer',
          title: 'Mock latency (ms)',
          default: 900,
          minimum: 0,
        },
      },
    },
    inputs: [
      { id: 'brief', type: 'json', label: 'Brief', required: true },
      { id: 'constraints', type: 'json', label: 'Constraints', required: false },
    ],
    outputs: [
      { id: 'massing', type: 'json', label: 'Massing' },
      { id: 'storeys', type: 'table', label: 'Storeys' },
    ],
  },

  async execute(ctx, inputs, params) {
    const brief = requireInput<ProjectBrief>(inputs, 'brief', 'aec.generate_massing');
    const constraints = inputs.constraints as unknown as SiteConstraints | undefined;

    // Without zoning constraints the whole site is buildable.
    const envW = constraints ? constraints.buildable.widthM : brief.site.widthM;
    const envD = constraints ? constraints.buildable.depthM : brief.site.depthM;
    const envelopeAreaM2 = round2(envW * envD);
    const lotAreaM2 = constraints ? constraints.lot.areaM2 : brief.site.areaM2;
    if (!constraints) {
      ctx.log('info', 'no site constraints wired — massing uses the whole site as its envelope');
    }

    // Zoning caps the storey count; the brief only asks.
    let storeyCount = Math.max(1, Math.floor(brief.floors));
    if (constraints && storeyCount > constraints.limits.maxStoreys) {
      ctx.log(
        'warn',
        `brief asks for ${brief.floors} storeys but zoning district ${constraints.zoningDistrict} ` +
          `caps the site at ${constraints.limits.maxStoreys} — massing built to ` +
          `${constraints.limits.maxStoreys} storeys.`,
      );
      storeyCount = constraints.limits.maxStoreys;
    }

    ctx.progress(0.1, `resolving a ${round2(envW)} × ${round2(envD)} m envelope`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    const rng = mulberry32(params.seed);
    const massingId = `mass_${hex8(rng)}`;
    const jitter = (): number => 0.98 + rng() * 0.04; // ±2 %
    const shrink = (): number => 0.98 + rng() * 0.02; // −2 %..0 %, never past the envelope

    const targetFootprintM2 = clamp(brief.targetGrossAreaM2 / storeyCount, 0, envelopeAreaM2);
    const base = buildShape(params.strategy, envW, envD, targetFootprintM2, jitter, shrink);
    const tower = params.strategy === 'tower_podium' ? centredTower(base) : null;

    ctx.progress(0.5, `stacking ${storeyCount} storeys as a ${params.strategy} scheme`);
    await sleep(params.mock_latency_ms / 3, ctx.signal);

    const storeys: MassingStorey[] = [];
    for (let level = 0; level < storeyCount; level++) {
      // tower_podium: levels 0–1 are the podium, levels 2+ the tower plate.
      const shape = tower !== null && level >= 2 ? tower : base;
      storeys.push({
        level,
        elevationM: round2(level * params.floor_to_floor_m),
        heightM: round2(params.floor_to_floor_m),
        areaM2: shape.areaM2,
        polygon: shape.polygon,
      });
    }

    const grossAreaM2 = round2(storeys.reduce((sum, s) => sum + s.areaM2, 0));
    const heightM = round2(storeyCount * params.floor_to_floor_m);
    const footprintAreaM2 = base.areaM2;
    const facadeAreaM2 = round2(base.perimeterM * heightM);
    const volumeM3 = footprintAreaM2 * heightM;

    await sleep(params.mock_latency_ms / 3, ctx.signal);
    ctx.progress(1, 'massing complete');

    // A brief that does not fit its envelope is reported, never thrown:
    // aec.zoning_review is where the overage becomes a finding.
    if (grossAreaM2 + 0.5 < brief.targetGrossAreaM2) {
      ctx.log(
        'info',
        `the brief's ${brief.targetGrossAreaM2} m² target does not fit the buildable envelope: ` +
          `${storeyCount} storeys × ${footprintAreaM2} m² deliver ${grossAreaM2} m².`,
      );
    }
    if (constraints && grossAreaM2 > constraints.maxGrossAreaM2 + 0.5) {
      ctx.log(
        'info',
        `massing gross area ${grossAreaM2} m² exceeds the zoning ceiling of ` +
          `${constraints.maxGrossAreaM2} m² — aec.zoning_review will report the overage.`,
      );
    }

    const result: MassingResult = {
      massingId,
      generator: { name: 'mock-massing', version: '1.0.0', seed: params.seed },
      units: 'm',
      strategy: params.strategy,
      footprint: {
        widthM: base.widthM,
        depthM: base.depthM,
        areaM2: footprintAreaM2,
        polygon: base.polygon,
      },
      storeys,
      metrics: {
        grossAreaM2,
        heightM,
        far: lotAreaM2 > 0 ? round3(grossAreaM2 / lotAreaM2) : 0,
        lotCoveragePct: lotAreaM2 > 0 ? round2((footprintAreaM2 / lotAreaM2) * 100) : 0,
        facadeAreaM2,
        surfaceToVolumeRatio:
          volumeM3 > 0 ? round3((facadeAreaM2 + 2 * footprintAreaM2) / volumeM3) : 0,
      },
    };

    const storeysTable: TableValue = {
      columns: [
        { id: 'level', label: 'Level' },
        { id: 'elevation_m', label: 'Elevation (m)' },
        { id: 'area_m2', label: 'Area (m²)' },
        { id: 'height_m', label: 'Height (m)' },
        { id: 'points', label: 'Vertices' },
      ],
      rows: storeys.map(
        (s): Record<string, Value> => ({
          level: s.level,
          elevation_m: s.elevationM,
          area_m2: s.areaM2,
          height_m: s.heightM,
          points: s.polygon.length,
        }),
      ),
    };

    return { massing: toValue(result), storeys: toValue(storeysTable) };
  },
};
