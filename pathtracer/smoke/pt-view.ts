/* ═══════════════════════════════════════════════════════════════════════════
   PT M1 viewer (pt-view.html): the real station rendered progressively by
   our path tracer, standalone (no three):
     buildScene(seed 1337) → scene-upload.ts (U3) → integrator.ts → presenter.
   ?scene=furnace renders the furnace check instead: a closed capped cylinder,
   every wall Lambert ρ with emission Le (stub surface) → mean radiance must
   be Le / (1 − ρ).
   Results go to window.__ptView for Playwright (tests/browser/pt-view.spec.ts).

   Exposure: emission is already in scene radiance = nits ×
   exposureFromEv100(phys.ev100) (DECISIONS.md M1), so the presenter applies
   only the ?exposure multiplier (default 1) before ACES.
   ═══════════════════════════════════════════════════════════════════════════ */
import { aimAt, viewPose } from '../../core/camera/flight.ts';
import { mulberry32 } from '../../core/rng.ts';
import { CORE_CONFIG } from '../../core/config/index.ts';
import { lightingAt } from '../../core/lighting/phases.ts';
import { RASTER_TONE_EXPOSURE, tracerLightingAt } from '../config.ts';
import { buildScene, defaultParams } from '../../core/scene/build.ts';
import type { QualityId } from '../../core/scene/types.ts';
import { INST_EMISSIVE, VIS_ALL, buildPackedBlas, packScene } from '../bvh/index.ts';
import { createDevice, describeDevice } from '../device.ts';
import { uploadScene } from '../gpu-scene.ts';
import {
  cameraBasis, cameraRayDir, createIntegrator, type Integrator, type IntegratorScene, type LightModeName, type StepResult,
  type TubeModeName
} from '../integrator.ts';
import { furnaceRadiance, refRadiance } from '../integrator-ref.ts';
import { createSceneLayout, type PtKernels } from '../kernels.ts';
import { preparedLightList, uploadSceneDesc } from '../scene-upload.ts';
import { createPresenter } from '../three-interop.ts';

/** app/boot.ts PerspectiveCamera vertical fov (degrees) */
const DEFAULT_FOV = 62;
const BASE_W = 960, BASE_H = 540;
const SEED = 1337;
/** furnace: albedo, emission, cylinder radius / length, segments */
const FURNACE = { albedo: 0.5, Le: 1, R: 10, H: 20, seg: 96, maxDepth: 64 };
/** tube scene: emitter radius / length / start, radiance, camera, CPU reference paths */
const TUBE_SCENE = {
  r: 0.5, len: 16, z0: -8, Le: 10,
  eye: [4, -6, -7] as [number, number, number], target: [0, 0, 2] as [number, number, number],
  refSamples: 400_000, refSeed: 99
};

export interface PtViewState {
  done: boolean;
  error?: string;
  log: string[];
  device?: string;
  scene?: string;
  width?: number;
  height?: number;
  sppTarget?: number;
  spp?: number;
  steps?: number;
  /** wall time from the first step to spp ≥ target */
  timeToTargetMs?: number;
  /** summed GPU (or latency) time of all steps */
  gpuMs?: number;
  /** total rays / total GPU time */
  mraysPerSec?: number;
  msPerWaveAvg?: number;
  /** largest GPU time of one submit after the first (calibration) step, ms */
  maxSubmitMs?: number;
  profile?: Record<string, number>;
  /** ?noise=1: relative rms noise of the luminance at sppTarget */
  noise?: { relRms: number; meanLum: number; spp: number };
  lights?: { lights: number; active: number; nodes: number; totalPhi: number; powerMs: number; buildMs: number };
  phys?: { tubeNits: number; ev100: number };
  timer?: string;
  compileMs?: number;
  uploadMs?: number;
  stats?: Record<string, unknown>;
  /** accumulation statistics */
  image?: { meanRgb: number[]; meanLum: number; nonFinite: number; black: number; pixels: number; minW: number; maxW: number };
  /** furnace (analytic) / tube scene (CPU reference ± refStderr) check */
  furnace?: { expected: number; mean: number; relErr: number; refStderr: number };
  gpuErrors: string[];
  deviceLost?: string;
}

declare global {
  interface Window { __ptView?: PtViewState }
}

const state: PtViewState = { done: false, log: [], gpuErrors: [] };
window.__ptView = state;

const logEl = document.getElementById('log')!;
const hudEl = document.getElementById('hud')!;
const statusEl = document.getElementById('status')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;

function log(line: string): void {
  state.log.push(line);
  logEl.textContent += line + '\n';
  console.log('[pt-view] ' + line);
}

/** Closed capped cylinder around Z (walls + two cap fans). */
function cappedCylinder(R: number, H: number, seg: number): { pos: Float32Array; idx: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(R * Math.sin(a), R * Math.cos(a), -H / 2, R * Math.sin(a), R * Math.cos(a), H / 2);
  }
  for (let i = 0; i < seg; i++) {
    const a = 2 * i, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const c0 = pos.length / 3; pos.push(0, 0, -H / 2);
  const c1 = pos.length / 3; pos.push(0, 0, H / 2);
  for (let i = 0; i < seg; i++) {
    idx.push(c0, 2 * i, 2 * i + 2);
    idx.push(c1, 2 * i + 3, 2 * i + 1);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

/** Open cylinder around Z (the tube emitter's lateral surface), z ∈ [z0, z0 + len]. */
function openTube(r: number, len: number, z0: number, seg: number): { pos: Float32Array; idx: Uint32Array } {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(r * Math.sin(a), r * Math.cos(a), z0, r * Math.sin(a), r * Math.cos(a), z0 + len);
  }
  for (let i = 0; i < seg; i++) {
    const a = 2 * i, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const sceneKind = q.get('scene') ?? 'station';
  const res = num('res', 1);
  const width = Math.max(8, Math.round(BASE_W * res)), height = Math.max(8, Math.round(BASE_H * res));
  const sppTarget = num('spp', 64);
  const budget = num('budget', 40);
  /* default: the raster's renderer exposure + three's ACES curve, so the image compares with tools/core-world.html */
  const exposure = num('exposure', RASTER_TONE_EXPOSURE);
  const tone = (q.get('tone') ?? 'aces-three') as 'aces' | 'aces-three' | 'linear';
  const tubeMode = (q.get('tube') ?? 'equiangular') as TubeModeName;
  const lightMode = (q.get('lights') ?? 'tree') as LightModeName;
  const fov = num('fov', DEFAULT_FOV);
  canvas.width = width;
  canvas.height = height;
  Object.assign(state, { scene: sceneKind, width, height, sppTarget });

  if (!navigator.gpu) throw new Error('navigator.gpu is undefined: WebGPU is not available in this browser');
  const pt = await createDevice();
  state.device = describeDevice(pt);
  log(`device: ${state.device}`);
  pt.onError((e) => { state.gpuErrors.push(e.message); log(`GPU ERROR: ${e.message}`); });
  pt.onLost((info) => { state.deviceLost = `${info.reason}: ${info.message}`; log(`DEVICE LOST: ${state.deviceLost}`); });
  const device = pt.device;
  device.pushErrorScope('validation');

  let integrator: Integrator;
  let expected = 0, refStderr = 0;
  const tu = performance.now();
  if (sceneKind === 'furnace') {
    const F = FURNACE;
    const m = cappedCylinder(F.R, F.H, F.seg);
    const packed = packScene([buildPackedBlas(m.pos, m.idx)], [{ count: 1, blas: 0, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }]);
    const gs = uploadScene(device, { sceneLayout: createSceneLayout(device) } as unknown as PtKernels, packed);
    const scene: IntegratorScene = { nodes: gs.nodes, tris: gs.tris, instances: gs.instances, dbg: gs.dbg, tlasRoot: gs.tlasRoot, tube: null };
    integrator = await createIntegrator(device, scene, {
      width, height, maxDepth: num('depth', F.maxDepth), clampIndirect: 0, specular: false,
      defines: { B5_STUB_ALBEDO: F.albedo, B5_STUB_EMISSION: F.Le }
    });
    // camera inside, looking along the axis at a slant
    const pos: [number, number, number] = [3, -2, -6];
    integrator.setCamera({ pos, quat: [0, 0, 0, 1] }, fov, width / height);
    expected = furnaceRadiance(F.Le, F.albedo);
    log(`furnace: capped cylinder R ${F.R} H ${F.H}, ρ = ${F.albedo}, Le = ${F.Le} → expected ${expected}`);
  } else if (sceneKind === 'tube') {
    /* closed Lambert cylinder lit only by an axis tube (NEE + MIS + shadow rays) vs integrator-ref.ts */
    const F = FURNACE, T = TUBE_SCENE;
    const m = cappedCylinder(F.R, F.H, F.seg);
    const t = openTube(T.r, T.len, T.z0, F.seg);
    const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const packed = packScene([buildPackedBlas(m.pos, m.idx), buildPackedBlas(t.pos, t.idx)], [
      { count: 1, blas: 0, matrices: I },
      { count: 1, blas: 1, matrices: I, flags: VIS_ALL | INST_EMISSIVE, tint: new Float32Array([T.Le, T.Le, T.Le]) }
    ]);
    const gs = uploadScene(device, { sceneLayout: createSceneLayout(device) } as unknown as PtKernels, packed);
    const depth = num('depth', 6);
    integrator = await createIntegrator(device, {
      nodes: gs.nodes, tris: gs.tris, instances: gs.instances, dbg: gs.dbg, tlasRoot: gs.tlasRoot,
      tube: { radius: T.r, length: T.len, z0: T.z0 }
    }, {
      width, height, maxDepth: depth, clampIndirect: 0, specular: false, tubeMode,
      defines: { B5_STUB_ALBEDO: F.albedo, B5_STUB_EMISSION: 0 }
    });
    integrator.setTubeRadiance([T.Le, T.Le, T.Le]);
    const pose = { pos: T.eye, quat: aimAt(T.eye, T.target, [0, 0, 1]) };
    integrator.setCamera(pose, fov, width / height);
    /* CPU reference: mean over the image plane of the same estimator */
    const tr = performance.now();
    const b = cameraBasis(pose, fov, width / height);
    const rnd = mulberry32(T.refSeed);
    const sc = { R: F.R, H: F.H, albedo: F.albedo, Le: 0, tube: { radius: T.r, length: T.len, z0: T.z0, Le: T.Le } };
    let s = 0, s2 = 0;
    for (let i = 0; i < T.refSamples; i++) {
      const d = cameraRayDir(b, rnd() * width, rnd() * height, width, height);
      const v = refRadiance(sc, T.eye, d, rnd, { maxDepth: depth, rrDepth: 3 });
      s += v; s2 += v * v;
    }
    const mean = s / T.refSamples;
    refStderr = Math.sqrt(Math.max(0, s2 / T.refSamples - mean * mean) / T.refSamples);
    expected = mean;
    log(`tube scene: CPU reference ${mean.toFixed(5)} ± ${refStderr.toFixed(5)} (${T.refSamples} paths, ${(performance.now() - tr).toFixed(0)} ms)`);
  } else {
    const quality = (q.get('quality') ?? 'HIGH') as QualityId;
    const view = num('view', 0);
    const phase = num('phase', 0);
    const ts = performance.now();
    const desc = buildScene({ ...defaultParams(quality), seed: SEED });
    log(`buildScene(seed ${SEED}, ${quality}) in ${(performance.now() - ts).toFixed(0)} ms`);
    const gs = await uploadSceneDesc(device, desc, { log });
    state.stats = gs.stats as unknown as Record<string, unknown>;
    const scene: IntegratorScene | typeof gs = q.get('stub') === '1'
      ? { nodes: gs.traversal.nodes, tris: gs.traversal.tris, instances: gs.traversal.instances, dbg: gs.traversal.dbg, tlasRoot: gs.tlasRoot, emitters: desc.emitters }
      : gs;
    integrator = await createIntegrator(device, scene, { width, height, maxDepth: num('depth', 6), tubeMode, lightMode, profile: q.get('profile') === '1',
      ...(q.has('paths') ? { maxPaths: num('paths', 0) } : {}),
      ...(q.has('clamp') ? { clampIndirect: num('clamp', 0) } : {}),
      ...(q.has('spread') ? { diffuseSpread: num('spread', 0) } : {}) });
    const tp = CORE_CONFIG.TP[view % CORE_CONFIG.TP.length];
    const pose = viewPose(tp.pos, tp.look); // station frame (rotZ = 0)
    integrator.setCamera(pose, fov, width / height);
    /* calibrated tracer palette (pathtracer/config.ts PHYS_OVERRIDE); ?phys=core = CORE_CONFIG.PHYS */
    const st = q.get('phys') === 'core' ? lightingAt(phase) : tracerLightingAt(phase);
    state.phys = { tubeNits: st.phys.tubeNits, ev100: st.phys.ev100 };
    /* experiments: ?tubescale=k scales the tube luminance (0 = triangle lights only) */
    if (q.has('tubescale')) st.phys.tubeNits *= num('tubescale', 1);
    integrator.setLighting(st);
    if (q.has('lightroles')) {
      /* experiments: emissive-triangle lights of the listed roles only (prefix match) */
      const want = (q.get('lightroles') ?? '').split(',');
      const full = preparedLightList(gs.prepared);
      const keep = (inst: number) => gs.roles.some((r) => want.some((w) => r.role.startsWith(w)) && inst >= r.first && inst < r.first + r.count);
      const inst = full.inst.map((k) => (k !== 0xffffffff && keep(k) ? k : 0xffffffff));
      await integrator.updateLights({ ...full, inst });
    }
    const ls = await integrator.lightsReady();
    if (ls) {
      state.lights = { lights: ls.lights, active: ls.active, nodes: ls.nodes, totalPhi: ls.totalPhi, powerMs: ls.powerMs, buildMs: ls.buildMs };
      log(`lights: ${ls.lights} emissive triangles (${ls.active} with power), tree ${ls.nodes} nodes, Σphi ${ls.totalPhi.toExponential(3)}; ` +
        `k_lightpower ${ls.powerMs.toFixed(0)} ms, tree+alias ${ls.buildMs.toFixed(0)} ms`);
    }
    log(`view ${view} "${tp.name}" pos [${tp.pos}] look [${tp.look}], phase ${phase} (EV100 ${st.phys.ev100.toFixed(2)}, tube ${st.phys.tubeNits.toFixed(0)} nits)`);
  }
  state.uploadMs = performance.now() - tu;
  state.compileMs = integrator.compileMs;
  log(`scene + integrator ready in ${state.uploadMs.toFixed(0)} ms (kernels ${integrator.compileMs.toFixed(0)} ms), ` +
    `${width}×${height}, path capacity ${integrator.capacity}`);

  const presenter = createPresenter(device, canvas);
  const t0 = performance.now();
  let steps = 0, gpuMs = 0, rays = 0, waves = 0, maxSubmitMs = 0;
  const prof: Record<string, number> = {};
  let last: StepResult | null = null;
  while (integrator.spp < sppTarget) {
    last = await integrator.step(budget);
    steps++;
    if (steps > 1) maxSubmitMs = Math.max(maxSubmitMs, last.ms);
    for (const [k, v] of Object.entries(last.profile ?? {})) prof[k] = (prof[k] ?? 0) + v;
    gpuMs += last.ms;
    rays += last.rays + last.shadowRays;
    waves += last.waves;
    presenter.present(integrator.output, { exposure, mode: tone });
    hudEl.textContent = `${sceneKind} ${width}×${height}  spp ${last.spp.toFixed(2)} / ${sppTarget}\n` +
      `${(last.ms / last.waves).toFixed(1)} ms/wave (${last.waves} waves, ${last.ms.toFixed(1)} ms submit, ${last.timer})\n` +
      `${last.mraysPerSec.toFixed(0)} Mrays/s`;
    if (state.deviceLost) throw new Error(`device lost: ${state.deviceLost}`);
    if (steps > 100000) throw new Error('too many steps');
  }
  state.timeToTargetMs = performance.now() - t0;
  state.spp = integrator.spp;
  state.steps = steps;
  state.gpuMs = gpuMs;
  state.mraysPerSec = rays / (gpuMs * 1e3);
  state.msPerWaveAvg = gpuMs / waves;
  state.maxSubmitMs = maxSubmitMs;
  if (Object.keys(prof).length) {
    state.profile = prof;
    log('profile (GPU ms per kernel, all steps): ' + Object.entries(prof).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
  }
  state.timer = last?.timer;
  await device.queue.onSubmittedWorkDone();

  /* image statistics from the accumulation */
  const acc = await integrator.readAccumulation();
  const n = width * height;
  let r = 0, g = 0, b = 0, nonFinite = 0, black = 0, minW = Infinity, maxW = 0;
  for (let i = 0; i < n; i++) {
    const w = acc[i * 4 + 3];
    minW = Math.min(minW, w); maxW = Math.max(maxW, w);
    const cr = acc[i * 4] / w, cg = acc[i * 4 + 1] / w, cb = acc[i * 4 + 2] / w;
    if (!Number.isFinite(cr + cg + cb)) { nonFinite++; continue; }
    if (cr + cg + cb <= 0) black++;
    r += cr; g += cg; b += cb;
  }
  const meanRgb = [r / n, g / n, b / n];
  const meanLum = 0.2126 * meanRgb[0] + 0.7152 * meanRgb[1] + 0.0722 * meanRgb[2];
  state.image = { meanRgb, meanLum, nonFinite, black, pixels: n, minW, maxW };
  if (sceneKind === 'furnace' || sceneKind === 'tube') {
    const mean = (meanRgb[0] + meanRgb[1] + meanRgb[2]) / 3;
    state.furnace = { expected, mean, relErr: mean / expected - 1, refStderr };
    log(`${sceneKind}: GPU mean ${mean.toFixed(5)} vs ${expected.toFixed(5)} (${(state.furnace.relErr * 100).toFixed(3)} %)`);
  }
  /* ?noise=1: a second, independent render (other sampler salt) to the same
     spp; per-pixel luminance noise = rms(a − b)/√2, relative to the mean */
  if (q.get('noise') === '1') {
    const lumAt = (A: Float32Array, i: number) => (0.2126 * A[i * 4] + 0.7152 * A[i * 4 + 1] + 0.0722 * A[i * 4 + 2]) / A[i * 4 + 3];
    const tn = performance.now();
    integrator.setSalt(0x9e3779b9);
    while (integrator.spp < sppTarget) await integrator.step(budget);
    const acc2 = await integrator.readAccumulation();
    let d2 = 0, m = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const a = lumAt(acc, i), b2 = lumAt(acc2, i);
      if (!Number.isFinite(a + b2)) continue;
      d2 += (a - b2) ** 2; m += (a + b2) / 2; cnt++;
    }
    state.noise = { relRms: Math.sqrt(d2 / cnt / 2) / (m / cnt), meanLum: m / cnt, spp: sppTarget };
    log(`noise: relative rms ${(state.noise.relRms * 100).toFixed(2)} % at ${sppTarget} spp (tube ${tubeMode}, lights ${lightMode}; ${(performance.now() - tn).toFixed(0)} ms)`);
  }
  const verr = await device.popErrorScope();
  if (verr) state.gpuErrors.push(`validation: ${verr.message}`);
  log(`${state.spp.toFixed(2)} spp in ${state.timeToTargetMs.toFixed(0)} ms (${steps} steps, ${waves} waves, GPU ${gpuMs.toFixed(0)} ms, ` +
    `${state.msPerWaveAvg.toFixed(1)} ms/wave, ${state.mraysPerSec.toFixed(0)} Mrays/s [${state.timer}]); ` +
    `mean rgb ${meanRgb.map((x) => x.toFixed(4)).join(' ')}, black ${black}, non-finite ${nonFinite}, samples/pixel ${minW}..${maxW}`);
  statusEl.textContent = state.gpuErrors.length ? 'FAIL — GPU errors' : 'DONE';
  statusEl.className = state.gpuErrors.length ? 'fail' : 'pass';
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  state.error = msg;
  statusEl.textContent = 'FAIL — ' + msg;
  statusEl.className = 'fail';
  log('ERROR ' + msg);
}).finally(() => {
  state.done = true;
});
