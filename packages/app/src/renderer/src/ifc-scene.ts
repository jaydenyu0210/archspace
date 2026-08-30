/**
 * IFC bytes → renderable triangle groups (ADR-0003 / ARCHITECTURE §3.3).
 *
 * The 3D panel's claims all originate here, so this module is pure on
 * purpose: no three.js, no React, no DOM — it takes an initialized web-ifc
 * API and bytes, and returns plain typed arrays. That is what lets
 * `test/ifc-scene.test.ts` run it under node against the real
 * `aec.generate_bim_model` output using web-ifc's independent node build —
 * the automated descendant of ADR-0016's IfcOpenShell verification, which
 * proved the geometry by parsing the file with something that did not write
 * it. The alternative — building three.js meshes straight off the stream in
 * the component — was rejected because it would leave every geometric claim
 * testable only through a launched Electron window (ADR-0013 wants the
 * falsifiable part headless).
 *
 * Grouping: one merged group per (category × storey) rather than one mesh per
 * product. The shipped example alone is 948 products; 948 draw calls in an
 * execution-panel preview is an easy way to make node inspection feel broken,
 * while ~20 merged groups render instantly and still support the two filters
 * the UI offers (storey isolation, space visibility). Per-product selection is
 * deliberately not a feature yet, so nothing is lost by merging.
 *
 * Units and axes, carefully — MEASURED from 0.0.77's output, not assumed:
 * the FILE is millimetres and Z-up (its IFCSIUNIT; ifc.ts's rule), but
 * web-ifc bakes both the unit conversion and a Z-up → Y-up axis change into
 * every placement transform, so the geometry this module emits is in the
 * glTF/three.js convention: METRES, +Y height, world z = −(plan y). A 75 mm
 * half-thickness arrives as 0.075, a storey-1 wall centre at y = 5.0. The
 * viewer therefore uses three's default up-vector untouched. Attribute
 * values read off lines (a storey's Elevation) are NOT converted and stay in
 * file units; they are used for ordering and labels only, never mixed into
 * geometry — 0.0.77 exposes no scaling-factor API that would let us convert
 * them honestly.
 */
import {
  IFCBUILDINGSTOREY,
  IFCDOOR,
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCSPACE,
  IFCWALL,
  type IfcAPI,
} from 'web-ifc';

export type IfcCategory = 'wall' | 'door' | 'space' | 'other';

/** One merged, transform-applied triangle batch the viewer can draw as-is. */
export interface IfcSceneGroup {
  category: IfcCategory;
  /** Index into `storeys`, or null when the file names no containing storey. */
  storey: number | null;
  /** xyz triplets — metres, Y-up (see header), placements already applied. */
  positions: Float32Array;
  /** Unit normals, parallel to `positions`. */
  normals: Float32Array;
  indices: Uint32Array;
  /** Products that contributed at least one triangle to this group. */
  productCount: number;
}

export interface IfcStorey {
  name: string;
  /** In the FILE's own length unit (see header) — ordering and labels only. */
  elevation: number;
}

/** What the panel shows and captions — every number here is load-bearing. */
export interface IfcSceneData {
  groups: IfcSceneGroup[];
  /** Sorted by elevation; group.storey indexes into this. */
  storeys: IfcStorey[];
  /**
   * Products DRAWN, by category — not entities in the file. The writer emits
   * a null representation for degenerate inputs (a zero-length wall, a
   * two-point room), so these can honestly be lower than the summary port's
   * entity counts, and the caption must not pretend otherwise.
   */
  counts: Record<IfcCategory, number>;
  /** Axis-aligned bounds over every drawn vertex; null when nothing rendered. */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** The two switches the panel exposes. */
export interface IfcViewFilter {
  /** Isolate one storey by index, or null for the whole building. */
  storey: number | null;
  showSpaces: boolean;
}

/**
 * web-ifc's `GetLine` is typed `any`; these two narrow the only shapes read
 * from it. A malformed line yields null and the product simply lands in the
 * "no storey" bucket — a viewer must tolerate a strange file, not throw at it.
 */
function refValue(v: unknown): number | null {
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const inner = (v as { value: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  return null;
}

function attrValue(v: unknown): string | number | null {
  if (typeof v === 'object' && v !== null && 'value' in v) {
    const inner = (v as { value: unknown }).value;
    if (typeof inner === 'string' || typeof inner === 'number') return inner;
  }
  return null;
}

/** Read one relationship line's from/to refs, tolerating malformed lines. */
function relation(
  api: IfcAPI,
  modelID: number,
  relId: number,
  fromAttr: string,
  toAttr: string,
): { from: number | null; to: number[] } {
  const line: unknown = api.GetLine(modelID, relId);
  if (typeof line !== 'object' || line === null) return { from: null, to: [] };
  const rec = line as Record<string, unknown>;
  const related = rec[toAttr];
  const to = Array.isArray(related)
    ? related.map(refValue).filter((v): v is number => v !== null)
    : [];
  return { from: refValue(rec[fromAttr]), to };
}

/**
 * Storeys plus a product → storey-index map, walked from the file's own
 * relationships rather than taken from the summary port. The summary would be
 * easier, but it describes what the writer MEANT; the viewer's whole job is
 * to show what the file SAYS (the ADR-0016 lesson), so the spatial tree is
 * read the way any other IFC consumer would read it: walls and doors via
 * IfcRelContainedInSpatialStructure, spaces via IfcRelAggregates — the WR41
 * split the writer itself observes. Both maps tolerate a storey with no
 * relationships at all, which the writer produces for an empty storey.
 */
function readStoreys(
  api: IfcAPI,
  modelID: number,
): { storeys: IfcStorey[]; storeyOf: Map<number, number> } {
  const ids = api.GetLineIDsWithType(modelID, IFCBUILDINGSTOREY);
  const raw: { id: number; name: string | null; elevation: number }[] = [];
  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    const line: unknown = api.GetLine(modelID, id);
    const rec = typeof line === 'object' && line !== null ? (line as Record<string, unknown>) : {};
    const name = attrValue(rec['Name']);
    const elevation = attrValue(rec['Elevation']);
    raw.push({
      id,
      name: typeof name === 'string' ? name : null,
      elevation: typeof elevation === 'number' ? elevation : 0,
    });
  }
  // By elevation, not file order: the index doubles as "how many storeys are
  // below me", which is what a person means by a storey number.
  raw.sort((a, b) => a.elevation - b.elevation);

  const indexOfStorey = new Map<number, number>(raw.map((s, i) => [s.id, i]));
  const storeyOf = new Map<number, number>();
  const record = (structure: number | null, products: number[]): void => {
    if (structure === null) return;
    const index = indexOfStorey.get(structure);
    if (index === undefined) return; // contained in the site/building, not a storey
    for (const p of products) storeyOf.set(p, index);
  };

  const contained = api.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < contained.size(); i++) {
    const rel = relation(api, modelID, contained.get(i), 'RelatingStructure', 'RelatedElements');
    record(rel.from, rel.to);
  }
  const aggregates = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  for (let i = 0; i < aggregates.size(); i++) {
    const rel = relation(api, modelID, aggregates.get(i), 'RelatingObject', 'RelatedObjects');
    record(rel.from, rel.to);
  }

  return {
    storeys: raw.map((s, i) => ({ name: s.name ?? `Storey ${i + 1}`, elevation: s.elevation })),
    storeyOf,
  };
}

/** Ids of every entity of `type`, subtypes included, as a Set. */
function idsOfType(api: IfcAPI, modelID: number, type: number): Set<number> {
  // includeInherited: the mock writer emits exactly IFCWALL/IFCDOOR/IFCSPACE,
  // but a real backend will emit subtypes (IfcWallStandardCase), and a viewer
  // that silently rendered those in the "other" colour would look wrong in a
  // way nobody would trace here.
  const ids = api.GetLineIDsWithType(modelID, type, true);
  const out = new Set<number>();
  for (let i = 0; i < ids.size(); i++) out.add(ids.get(i));
  return out;
}

/** Mutable accumulator for one (category × storey) batch. */
interface GroupBuild {
  category: IfcCategory;
  storey: number | null;
  positions: number[];
  normals: number[];
  indices: number[];
  products: Set<number>;
}

const CATEGORY_ORDER: Record<IfcCategory, number> = { wall: 0, door: 1, space: 2, other: 3 };

/**
 * Parse a model and merge its placed geometry into per-(category × storey)
 * groups. The caller owns the api's lifecycle; the model opened here is
 * closed before returning, success or throw, because the wasm heap does not
 * garbage-collect and a leaked model survives for the whole session.
 */
export function buildIfcScene(api: IfcAPI, bytes: Uint8Array): IfcSceneData {
  const modelID = api.OpenModel(bytes);
  try {
    const { storeys, storeyOf } = readStoreys(api, modelID);
    const walls = idsOfType(api, modelID, IFCWALL);
    const doors = idsOfType(api, modelID, IFCDOOR);
    const spaces = idsOfType(api, modelID, IFCSPACE);
    const categoryOf = (id: number): IfcCategory =>
      walls.has(id) ? 'wall' : doors.has(id) ? 'door' : spaces.has(id) ? 'space' : 'other';

    const builds = new Map<string, GroupBuild>();
    let min: [number, number, number] | null = null;
    let max: [number, number, number] | null = null;

    // Two passes, deduplicated: StreamAllMeshes deliberately skips IfcSpace
    // (and openings) because most consumers want the built fabric, so spaces
    // are streamed explicitly — they are half of what this panel is FOR. The
    // `seen` guard exists because that skip is web-ifc behaviour, not
    // contract; a version that started including spaces in the first pass
    // would otherwise draw every room volume twice.
    const seen = new Set<number>();
    const absorb = (mesh: Parameters<Parameters<IfcAPI['StreamAllMeshes']>[1]>[0]): void => {
      if (seen.has(mesh.expressID)) return;
      seen.add(mesh.expressID);
      const category = categoryOf(mesh.expressID);
      const storey = storeyOf.get(mesh.expressID) ?? null;
      const key = `${category}:${storey ?? 'none'}`;
      let build = builds.get(key);
      if (build === undefined) {
        build = { category, storey, positions: [], normals: [], indices: [], products: new Set() };
        builds.set(key, build);
      }

      for (let g = 0; g < mesh.geometries.size(); g++) {
        const placed = mesh.geometries.get(g);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        // GetVertexArray/GetIndexArray return views into the wasm heap, which
        // the next allocation may move — every value is copied out inside this
        // callback, never referenced after it.
        const verts = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
        geometry.delete();
        if (indices.length === 0) continue;

        // web-ifc's flatTransformation is column-major, matching what
        // three.js's Matrix4.fromArray would consume.
        const m = placed.flatTransformation;
        const base = build.positions.length / 3;

        // Interleaved x,y,z,nx,ny,nz. Normals go through the rotation part
        // only and are renormalized, which is exact for the rigid placements
        // this writer emits and an accepted approximation for a scaling one
        // (a true inverse-transpose is not worth carrying until some real
        // backend produces a scaled placement to look at).
        for (let v = 0; v + 5 < verts.length; v += 6) {
          const x = verts[v], y = verts[v + 1], z = verts[v + 2];
          const px = m[0] * x + m[4] * y + m[8] * z + m[12];
          const py = m[1] * x + m[5] * y + m[9] * z + m[13];
          const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
          build.positions.push(px, py, pz);

          const nx = verts[v + 3], ny = verts[v + 4], nz = verts[v + 5];
          const rx = m[0] * nx + m[4] * ny + m[8] * nz;
          const ry = m[1] * nx + m[5] * ny + m[9] * nz;
          const rz = m[2] * nx + m[6] * ny + m[10] * nz;
          const len = Math.hypot(rx, ry, rz) || 1;
          build.normals.push(rx / len, ry / len, rz / len);

          if (min === null || max === null) {
            min = [px, py, pz];
            max = [px, py, pz];
          } else {
            if (px < min[0]) min[0] = px; else if (px > max[0]) max[0] = px;
            if (py < min[1]) min[1] = py; else if (py > max[1]) max[1] = py;
            if (pz < min[2]) min[2] = pz; else if (pz > max[2]) max[2] = pz;
          }
        }
        for (let i = 0; i < indices.length; i++) build.indices.push(base + indices[i]);
        build.products.add(mesh.expressID);
      }
    };
    api.StreamAllMeshes(modelID, absorb);
    api.StreamAllMeshesWithTypes(modelID, [IFCSPACE], absorb);

    const groups = [...builds.values()]
      .filter((b) => b.indices.length > 0)
      .sort((a, b) =>
        (a.storey ?? -1) - (b.storey ?? -1) || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category],
      )
      .map((b) => ({
        category: b.category,
        storey: b.storey,
        positions: Float32Array.from(b.positions),
        normals: Float32Array.from(b.normals),
        indices: Uint32Array.from(b.indices),
        productCount: b.products.size,
      }));

    const counts: Record<IfcCategory, number> = { wall: 0, door: 0, space: 0, other: 0 };
    for (const g of groups) counts[g.category] += g.productCount;

    return {
      groups,
      storeys,
      counts,
      bounds: min !== null && max !== null ? { min, max } : null,
    };
  } finally {
    api.CloseModel(modelID);
  }
}

/**
 * Whether a group is drawn under the panel's current filter.
 *
 * Spaces are a visibility class of their own because they are solid
 * room-filling volumes: with them opaque, 159 boxes hide every wall and door
 * in the shipped example, so the panel defaults them off and renders them
 * translucent when on. A group with no known storey stays visible under
 * storey isolation — hiding it in EVERY storey view would make it invisible
 * everywhere, which for an object the file failed to place is the opposite of
 * what a viewer is for.
 */
export function groupVisible(group: IfcSceneGroup, filter: IfcViewFilter): boolean {
  if (group.category === 'space' && !filter.showSpaces) return false;
  if (filter.storey !== null && group.storey !== null && group.storey !== filter.storey) return false;
  return true;
}

/**
 * Camera placement that guarantees the whole model is in frame: distance puts
 * the bounding sphere inside the NARROWER of the two view angles, so a flat
 * wide building does not clip in a squat panel. Pure math, tested headlessly —
 * a wrong answer here is "the model opens half off screen", which a smoke
 * test cannot cheaply see.
 */
export function cameraFrame(
  bounds: NonNullable<IfcSceneData['bounds']>,
  fovYRadians: number,
  aspect: number,
): { center: [number, number, number]; distance: number } {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const radius =
    Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ) / 2 || 1;
  const fovX = 2 * Math.atan(Math.tan(fovYRadians / 2) * aspect);
  const halfFov = Math.min(fovYRadians, fovX) / 2;
  return { center, distance: radius / Math.sin(halfFov) };
}
