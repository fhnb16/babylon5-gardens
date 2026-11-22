/* ═══════════════════════════════════════════════════════════════════════════
   tools/core-world.html — the world as the app builds it (buildScene() →
   backends/three createThreeWorld, textures from the worker pool, lighting
   from core lightingAt) with the minimal legacy renderer setup (no post
   chain, no UI). tests/browser/core-world.spec.ts compares it with the
   reference images of the pre-v2.12.0 legacy world (tests/browser/ref/).

   ?view=N&phase=P&quality=Q   (P: number or DAY|DUSK|NIGHT)
   &renderer=webgpu|webgl2|classic   renderer flavour (default classic) via
                               backends/three/renderer.ts createRenderer —
                               the same factory the app uses; webgpu/webgl2
                               render the node materials (materials/node.ts)
   &mirror=M                   override the water-mirror strength
   &off=normal                 drop the hull normal map (bisecting aid)
   &hide=role,role             hide objects by role prefix (bisecting aid)

   Camera exactly like the app's instant teleport goTo(i, true) with station
   rotation 0: tpVec(pos), stationUp, aimAt(look), syncFromCamera. Time is
   frozen at 0 (uTime, beacon flicker), so frames are deterministic.

   window.__coreWorld = { done, error?, mode, renderer, buildMs, show(view, phase), bench(n) };
   show() re-aims, re-lights and renders without rebuilding (browser test);
   bench(n) renders n frames back to back, waits for the GPU and returns ms
   per frame (tests/browser/renderer.spec.ts perf line).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { CONFIG as RAW_CONFIG } from '../js/config.js';
import { stationUp, syncFromCamera, tpVec, aimAt } from '../js/controls.js';
import { buildScene, defaultParams } from '../core/scene/build.ts';
import { lightingAt } from '../core/lighting/phases.ts';
import type { QualityId } from '../core/scene/types.ts';
import { createThreeWorld, type ThreeWorld } from '../backends/three/adapt/sceneGraph.ts';
import { createRenderer, parseRendererMode, type B5Renderer, type RendererInfo } from '../backends/three/renderer.ts';
import { createTexturePool } from '../app/workers/texturePool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONFIG: any = RAW_CONFIG;

interface Api {
  done: boolean;
  error?: string;
  mode: string;
  renderer: RendererInfo;
  buildMs: number;
  show(view: number, phase: number): Promise<void>;
  bench(frames: number): Promise<number>;
}
declare global { interface Window { __coreWorld?: Partial<Api> } }

const qs = new URLSearchParams(location.search);
const QUALITY = (['LOW', 'HIGH', 'ULTRAM', 'ULTRA'].includes(qs.get('quality') || '') ? qs.get('quality') : 'HIGH') as QualityId;
const PHASE_NAMES: Record<string, number> = { DAY: 0, DUSK: 1, NIGHT: 2 };
const parsePhase = (s: string | null): number => {
  if (!s) return 0;
  const up = s.toUpperCase();
  return up in PHASE_NAMES ? PHASE_NAMES[up] : Number(s) || 0;
};

/* ─── legacy renderer setup (app/boot.ts, minus the post chain) ─── */
const MODE = parseRendererMode(qs.get('renderer')) ?? 'classic';
let b5: B5Renderer;
/** the legacy renderer exposure (app/boot.ts) */
const EXPOSURE = 1.22;
async function initRenderer(): Promise<B5Renderer> {
  const r = await createRenderer({ mode: MODE, antialias: true });
  const renderer = r.renderer;
  if (r.isNode) {
    /* classic DIRECT-render semantics on the node path: the materials tone-map,
       encode and fog themselves (ThreeWorldOptions.output 'display'); the canvas
       receives their values unchanged */
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
  } else {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
  }
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  document.body.appendChild(renderer.domElement);
  return r;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, CONFIG.FAR);

/** app goTo(i, true) with the station at rotation 0 */
function placeCamera(view: number, station: THREE.Object3D): void {
  const tp = CONFIG.TP[((view % CONFIG.TP.length) + CONFIG.TP.length) % CONFIG.TP.length];
  station.updateMatrixWorld(true);
  const up = new THREE.Vector3();
  camera.position.copy(station.localToWorld(tpVec(tp.pos).clone()));
  stationUp(camera.position, up);
  aimAt(camera.position, station.localToWorld(tpVec(tp.look).clone()), up, camera.quaternion);
  syncFromCamera(camera);
  camera.updateMatrixWorld(true);
}

const frame = (): Promise<void> => new Promise(r => requestAnimationFrame(() => r()));
async function present(): Promise<void> {
  for (let i = 0; i < 3; i++) { b5.renderer.render(scene, camera); await frame(); }
}

/** n frames back to back, then wait for the GPU: ms per frame */
async function bench(n: number): Promise<number> {
  const r = b5.renderer;
  const sync = async (): Promise<void> => {
    if (b5.isNode) {
      const be = (r as unknown as { backend: { device?: GPUDevice; gl?: WebGL2RenderingContext } }).backend;
      if (be.device) await be.device.queue.onSubmittedWorkDone();
      else if (be.gl) be.gl.readPixels(0, 0, 1, 1, be.gl.RGBA, be.gl.UNSIGNED_BYTE, new Uint8Array(4));
    } else {
      const gl = (r as THREE.WebGLRenderer).getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
  };
  r.render(scene, camera);
  await sync();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) r.render(scene, camera);
  await sync();
  return (performance.now() - t0) / n;
}

async function startCore(): Promise<(view: number, phase: number) => Promise<void>> {
  b5 = await initRenderer();
  api.renderer = b5.info;
  const desc = buildScene(defaultParams(QUALITY));
  const pool = createTexturePool();
  const mirror = qs.get('mirror');
  const world: ThreeWorld = createThreeWorld(desc, b5.renderer, {
    scene, textures: 'pool', pool, ...(mirror !== null ? { mirror: Number(mirror) } : {}),
    ...(b5.isNode ? { output: { mode: 'display' as const, exposure: EXPOSURE } } : {})
  });
  await world.ready;
  pool.dispose();
  const hide = (qs.get('hide') || '').split(',').filter(Boolean);
  for (const [role, list] of world.objects) {
    if (hide.some(h => role === h || role.startsWith(h + '.'))) for (const o of list) o.visible = false;
  }
  if (qs.get('off') === 'normal') {
    const hull = world.materials.get('w.hull') as THREE.MeshStandardMaterial;
    hull.normalMap = null;
    hull.needsUpdate = true;
  }
  /* debugging aid: the live objects (console / ad-hoc probes) */
  (window as unknown as { __coreWorldDebug?: unknown }).__coreWorldDebug = { THREE, scene, camera, world, renderer: b5.renderer };
  return async (view, phase) => {
    placeCamera(view, world.stationGroup);
    world.applyLighting(lightingAt(phase));
    world.update(0, camera);
    await present();
  };
}

/* ═══════════════════════ boot ═══════════════════════ */
const api: Partial<Api> = { done: false, mode: 'core', bench };
window.__coreWorld = api;
(async () => {
  try {
    const t0 = performance.now();
    const show = await startCore();
    api.buildMs = performance.now() - t0;
    api.show = show;
    await show(Number(qs.get('view') || 0), parsePhase(qs.get('phase')));
    api.done = true;
  } catch (e) {
    console.error(e);
    api.error = String((e as Error)?.stack || e);
    const m = document.getElementById('msg');
    if (m) m.textContent = api.error;
  }
})();
