/**
 * The 3D IFC preview panel (ADR-0003 / ARCHITECTURE §3.3) — an `asset<ifc>`
 * output, drawn.
 *
 * Before this, inspecting the BIM node showed a card with a hash and a Save
 * button: the geometry ADR-0016 went to such lengths to make real was visible
 * only by round-tripping through an external viewer. This panel closes that
 * loop in-app — same drafting-table palette, same storey-switcher vocabulary
 * as PlanView, so plan and model read as two projections of one thing.
 *
 * Division of labour: everything falsifiable — parsing, grouping, transforms,
 * camera fit — lives in `ifc-scene.ts`, pure and node-tested. This component
 * owns only what needs a DOM: the byte fetch over the bridge, the wasm
 * bootstrap, and the three.js lifecycle. That split is the ADR-0013 rule that
 * pushed `drift.ts` out of `store.ts`, applied on day one instead of after
 * the fact.
 *
 * The wasm ships INLINED as a data: URI (`virtual:web-ifc-wasm`, emitted by
 * the plugin in electron.vite.config.ts), because the packaged app is
 * `loadFile`'d from file:// where Chromium's fetch() refuses wasm URLs
 * outright — a failure dev mode (http) never shows. A data: URI takes the
 * same fetch path successfully under both origins, so dev and packaged
 * builds exercise one code path instead of two. Cost: ~1.7 MB of base64 in
 * the bundle, decoded once per session; `check-bundle.mjs` asserts it
 * survived the build, since only a launched window would ever notice it
 * missing.
 *
 * Parsing runs synchronously on the UI thread. At the shipped example's size
 * (~500 KB, ~100 ms) that is imperceptible; at MAX_VIEWER_ASSET_BYTES it
 * would not be, and the escape hatch recorded here is a worker — not a lower
 * ceiling, which would just trade a stall for a refusal.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IfcAPI } from 'web-ifc';
import wasmDataUri from 'virtual:web-ifc-wasm';
import type { AssetRef } from '@archspace/node-sdk';
import {
  buildIfcScene,
  cameraFrame,
  groupVisible,
  type IfcCategory,
  type IfcSceneData,
  type IfcSceneGroup,
  type IfcViewFilter,
} from '../ifc-scene';

/**
 * One wasm bootstrap per session, shared by every mount. A failed Init is
 * forgotten rather than cached, so a transient failure does not condemn every
 * later preview to the same error message.
 */
let apiPromise: Promise<IfcAPI> | null = null;
function ifcApi(): Promise<IfcAPI> {
  apiPromise ??= (async () => {
    const api = new IfcAPI();
    // forceSingleThread: the -mt build needs crossOriginIsolation, which a
    // file://-loaded window never has; nothing here needs threads anyway.
    await api.Init(
      (path, prefix) => (path.endsWith('.wasm') ? wasmDataUri : prefix + path),
      true,
    );
    return api;
  })().catch((err: unknown) => {
    apiPromise = null;
    throw err;
  });
  return apiPromise;
}

/**
 * Parsed scenes keyed by content hash. The hash IS the content (the store is
 * content-addressed), so an entry can never go stale — eviction exists only
 * to bound memory, and re-inspecting the node a user just left stays free.
 * Kept usable across engine restarts on purpose: the bytes die with the
 * engine child, but a scene already parsed from them is still true.
 */
const sceneCache = new Map<string, IfcSceneData>();
const SCENE_CACHE_MAX = 4;
function rememberScene(hash: string, scene: IfcSceneData): void {
  sceneCache.delete(hash);
  sceneCache.set(hash, scene);
  for (const key of sceneCache.keys()) {
    if (sceneCache.size <= SCENE_CACHE_MAX) break;
    sceneCache.delete(key);
  }
}

type ViewState =
  | { t: 'loading' }
  | { t: 'error'; message: string }
  | { t: 'ready'; scene: IfcSceneData };

/** Drafting-table palette, by category — the file itself carries no styles
 *  (the mock writer emits none; ADR-0016 leaves materials to a real backend),
 *  so colour is the viewer's editorial choice: walls in the neutral ink the
 *  plan draws them in, doors in drafting orange, spaces in translucent
 *  blueprint blue. Mirrors PlanView's colour vocabulary deliberately. */
function materialFor(category: IfcCategory): THREE.Material {
  switch (category) {
    case 'wall':
      return new THREE.MeshLambertMaterial({ color: 0x8b95a3, side: THREE.DoubleSide });
    case 'door':
      // Doors are free-standing solids overlapping their walls (the writer
      // cuts no openings), so coplanar faces are expected; the polygon offset
      // pulls them in front instead of letting them shimmer.
      return new THREE.MeshLambertMaterial({
        color: 0xff8a3d,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
    case 'space':
      return new THREE.MeshLambertMaterial({
        color: 0x4cc2ff,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    case 'other':
      return new THREE.MeshLambertMaterial({ color: 0x6b7684, side: THREE.DoubleSide });
  }
}

export function IfcView({ asset }: { asset: AssetRef }) {
  const [state, setState] = useState<ViewState>({ t: 'loading' });
  const [filter, setFilter] = useState<IfcViewFilter>({ storey: null, showSpaces: false });
  const mountRef = useRef<HTMLDivElement>(null);
  const drawnRef = useRef<{ mesh: THREE.Mesh; group: IfcSceneGroup }[]>([]);
  const redrawRef = useRef<() => void>(() => {});
  // The scene effect reads the filter through a ref so that changing a filter
  // never tears the whole WebGL world down — only the visibility effect below
  // depends on it.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const cached = sceneCache.get(asset.hash);
      if (cached !== undefined) {
        setState({ t: 'ready', scene: cached });
        return;
      }
      setState({ t: 'loading' });
      const result = await window.archspace.readAsset(asset);
      if (cancelled) return;
      if (!result.ok) {
        setState({ t: 'error', message: result.error });
        return;
      }
      try {
        const api = await ifcApi();
        if (cancelled) return;
        const scene = buildIfcScene(api, result.bytes);
        rememberScene(asset.hash, scene);
        if (!cancelled) setState({ t: 'ready', scene });
      } catch (err) {
        if (!cancelled) {
          setState({
            t: 'error',
            message: `Could not parse ${asset.name ?? 'the model'}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // Keyed on the content hash, not the ref object: every run event delivers
    // a fresh AssetRef identity, and the hash is the only part that IS the
    // content.
  }, [asset.hash]);

  // The three.js world — built once per parsed scene, torn down fully on the
  // way out. Everything allocated here is disposed here: WebGL resources do
  // not garbage-collect, and an execution panel that leaks a context per node
  // inspection runs the browser out of contexts within a session.
  useEffect(() => {
    if (state.t !== 'ready') return;
    const el = mountRef.current;
    if (el === null) return;
    const { scene: data } = state;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
      setState({
        t: 'error',
        message: `3D preview unavailable — no WebGL context: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);

    const world = new THREE.Scene();
    world.add(new THREE.HemisphereLight(0xbfd4e6, 0x11151a, 1.1));

    const bounds: NonNullable<IfcSceneData['bounds']> =
      data.bounds ?? { min: [0, 0, 0], max: [1, 1, 1] };
    const radius =
      Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) / 2 || 1;

    // Frustum scaled off the model, not hard-coded — geometry arrives in
    // web-ifc's normalized metres (ifc-scene.ts header), and a fixed near/far
    // pair would either clip a campus or z-fight a closet.
    const camera = new THREE.PerspectiveCamera(50, 1, Math.max(0.02, radius / 500), radius * 40);
    // No up-vector fiddling: web-ifc already emits Y-up (ifc-scene.ts header).

    const frame = cameraFrame(bounds, (camera.fov * Math.PI) / 180, 1);
    const center = new THREE.Vector3(...frame.center);
    // From the south-west and above — the orientation an architect sketches.
    // In this space plan-south is +z, height is +y.
    const direction = new THREE.Vector3(-0.55, 0.55, 0.75).normalize();
    camera.position.copy(center.clone().addScaledVector(direction, frame.distance));

    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.copy(center.clone().addScaledVector(new THREE.Vector3(0.4, 1, 0.7), radius * 2));
    sun.target.position.copy(center);
    world.add(sun, sun.target);

    drawnRef.current = data.groups.map((group) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(group.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(group.indices, 1));
      const mesh = new THREE.Mesh(geometry, materialFor(group.category));
      mesh.visible = groupVisible(group, filterRef.current);
      world.add(mesh);
      return { mesh, group };
    });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();

    // Drawn on demand — controls change, resize, filter — never on a loop.
    // A preview panel animating nothing at 60fps is a laptop fan on idle.
    const redraw = (): void => renderer.render(world, camera);
    redrawRef.current = redraw;
    controls.addEventListener('change', redraw);

    const resize = (): void => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      redraw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    return () => {
      observer.disconnect();
      controls.removeEventListener('change', redraw);
      controls.dispose();
      for (const { mesh } of drawnRef.current) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      drawnRef.current = [];
      redrawRef.current = () => {};
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [state]);

  // Filters flip mesh visibility in place — no geometry rebuild, no reparse.
  useEffect(() => {
    for (const { mesh, group } of drawnRef.current) {
      mesh.visible = groupVisible(group, filter);
    }
    redrawRef.current();
  }, [filter]);

  const scene = state.t === 'ready' ? state.scene : null;
  const counts = scene?.counts;

  return (
    <div className="ifc-view">
      {scene !== null && (
        <div className="ifc-toolbar">
          {scene.storeys.length > 1 && (
            /* A labelled group of toggles, not a tablist — same reasoning as
               PlanView: claiming a half-implemented ARIA pattern is worse for
               a screen reader than claiming none. */
            <div className="ifc-storeys" role="group" aria-label="Storey">
              <button
                type="button"
                className={`ifc-storey${filter.storey === null ? ' is-current' : ''}`}
                aria-pressed={filter.storey === null}
                onClick={() => setFilter((f) => ({ ...f, storey: null }))}
              >
                All
              </button>
              {scene.storeys.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  className={`ifc-storey${filter.storey === i ? ' is-current' : ''}`}
                  aria-pressed={filter.storey === i}
                  onClick={() => setFilter((f) => ({ ...f, storey: f.storey === i ? null : i }))}
                  title={s.name}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          <span className="ifc-spacer" />
          <button
            type="button"
            className={`ifc-storey${filter.showSpaces ? ' is-current' : ''}`}
            aria-pressed={filter.showSpaces}
            onClick={() => setFilter((f) => ({ ...f, showSpaces: !f.showSpaces }))}
            title="Show room volumes (translucent)"
          >
            Spaces
          </button>
        </div>
      )}
      {state.t === 'loading' && <div className="panel-hint">Reading model…</div>}
      {state.t === 'error' && <div className="ifc-error">{state.message}</div>}
      <div ref={mountRef} className="ifc-canvas" hidden={state.t !== 'ready'} />
      {scene !== null && counts !== undefined && (
        <div className="ifc-caption mono">
          {counts.wall} walls · {counts.door} doors · {counts.space} spaces
          {counts.other > 0 ? ` · ${counts.other} other` : ''} · {scene.storeys.length}{' '}
          {scene.storeys.length === 1 ? 'storey' : 'storeys'}
          {scene.bounds === null && <span className="plan-note"> — no drawable geometry</span>}
        </div>
      )}
    </div>
  );
}
