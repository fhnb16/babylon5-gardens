/* ═══════════════════════════════════════════════════════════════════════════
   Public API of our WebGPU path tracer (PT-P4) — mirrors js/pathtrace.js
   (three-gpu-pathtracer adapter) names and semantics, so app/photo-mode.ts,
   app/loop.ts and app/ui/settings.ts can switch with few changes:

     pt                      state object (active, ready, build, buildMs,
                             paused, samples, error, …)
     startPath(scene, camera, opts) → Promise<boolean>
     pathStep() → progress 0…1      call once per animation frame (sync; a GPU
                             step runs in the background, ≤ budgetMs per submit)
     stopPath()  pathCameraMoved(camera?)  pathLabel()
     setNoiseTarget(pct)  samplesNeeded()  noiseNow()
     setPathScale(v)  setPaused(on)  pathPaused()  pathClock(tick?)

   Differences (by design):
     • the scene is a core SceneDesc (buildScene output) or an already uploaded
       GpuScene, the camera a STATION-frame pose (stationPose() converts the
       app's world camera: the world group is rotated by rotZ);
     • output goes to its OWN canvas (WebGPU context, ACES 'aces-three'
       presenter with the raster's exposure) — an overlay over the WebGL
       canvas until the WebGPU raster lands (createOverlayCanvas());
     • noiseNow() is MEASURED: 95th percentile of 16×16 tile relative errors
       (convergence.ts half buffer), not 100/√spp; converged tiles stop being
       sampled; samplesNeeded() = ceil(1e4/noise²) is the per-pixel CAP;
     • setPaused(true) = "pause with cleaning": accumulation stops and the
       à-trous denoiser (denoise.ts) output is shown; cleanPath('oidn') runs
       Open Image Denoise when a loader was configured (oidn.ts).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { CameraPose } from '../core/camera/flight.ts';
import { fromAxisAngle, multiply } from '../core/math/quat.ts';
import type { LightingState, SceneDesc } from '../core/scene/types.ts';
import { RASTER_TONE_EXPOSURE, tracerLightingAt } from './config.ts';
import { CONVERGENCE, convergenceProgress, samplesForNoise } from './convergence.ts';
import { createAtrousDenoiser, type AtrousDenoiser, type AtrousOptions } from './denoise.ts';
import { adoptDevice, createDevice, type PtDevice } from './device.ts';
import { createIntegrator, type Integrator, type IntegratorOptions, type StepResult } from './integrator.ts';
import { createOidnDenoiser, type OidnDenoiser, type OidnOptions } from './oidn.ts';
import type { SamplerName } from './sampler.ts';
import { uploadSceneDesc, type GpuScene, type UploadOptions } from './scene-upload.ts';
import { createPresenter, type PresentOptions, type Presenter } from './three-interop.ts';
import { createBvhPool } from './bvh/pool.ts';

/** API defaults (tracer-only knobs; the app's CONFIG.PATH supplies noise / scale). */
export const PT_API = {
  /** GPU time per submit (ms) — keeps the page responsive */
  budgetMs: 30,
  /** js/config.js CONFIG.PATH.noise */
  noise: CONVERGENCE.defaultNoise,
  /** trace resolution = canvas size × scale */
  scale: 1,
  maxDepth: 6,
  /** firefly clamp of indirect contributions (scene radiance units, 0 = off) */
  clampIndirect: 16,
  /** path regularization (biased; 0 = off) — see DECISIONS.md PT-P4 */
  regularize: 0,
  /** app/boot.ts PerspectiveCamera fov */
  fovY: 62,
  tone: 'aces-three' as NonNullable<PresentOptions['mode']>
} as const;

export interface PathCamera {
  /** station-frame pose (stationPose() from the app's world camera) */
  pose: CameraPose;
  /** vertical fov, degrees (three PerspectiveCamera.fov) */
  fovY?: number;
}

export interface StartPathOptions {
  /** WebGPU canvas the presenter draws into (createOverlayCanvas() for an overlay over the app canvas) */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Shared-device HDR sink. The canvas then supplies dimensions only. */
  presentHdr?: (texture: GPUTexture, exposureMultiplier: number) => void;
  /** lighting: a LightingState or a phase number (tracerLightingAt); default DAY */
  lighting?: LightingState | number;
  /** device to use (shared with three later); default: a cached createDevice() */
  device?: PtDevice | GPUDevice;
  /** trace resolution = canvas size × scale (default PT_API.scale) */
  scale?: number;
  /** presenter exposure multiplier on top of the raster's 1.22 (default 1) */
  exposure?: number;
  tone?: PresentOptions['mode'];
  budgetMs?: number;
  maxDepth?: number;
  clampIndirect?: number;
  regularize?: number;
  sampler?: SamplerName;
  /** texture pixel source for the scene upload (app/workers/texturePool) */
  images?: UploadOptions['images'];
  /** status text callback (legacy onPhase) */
  onPhase?: (text: string) => void;
  /** Open Image Denoise (lazy): loader + weights URL */
  oidn?: OidnOptions;
  atrous?: AtrousOptions;
  log?: (line: string) => void;
}

/** Legacy-compatible state (js/pathtrace.js `pt`) + measured convergence. */
export const pt = {
  active: false,
  ready: false,
  /** 0 = scene upload / kernels, 1 = ready */
  build: 0,
  buildMs: 0,
  /** the BVH is built off the main thread (scene-upload worker) */
  threaded: true,
  paused: false,
  /** mean samples per pixel */
  samples: 0,
  error: null as string | null,
  /** measured noise (%) — noiseNow() */
  noise: 100,
  /** every tile converged or capped */
  done: false,
  /** what the canvas shows */
  showing: 'raw' as 'raw' | 'atrous' | 'oidn',
  /** last step / denoise timings */
  lastStepMs: 0,
  denoiseMs: 0,
  activeTiles: 0,
  device: '' as string
};

/* ─── module state ────────────────────────────────────────────────────────── */

let cachedDevice: PtDevice | null = null;
let dev: PtDevice | null = null;
let gpuScene: GpuScene | null = null;
let ownScene = false;
let integ: Integrator | null = null;
let presenter: Presenter | null = null;
let atrous: AtrousDenoiser | null = null;
let oidn: OidnDenoiser | null = null;
let oidnLoading: Promise<OidnDenoiser | null> | null = null;
let inflight: Promise<StepResult | null> | null = null;
let startOpts: StartPathOptions | null = null;
let camNow: PathCamera | null = null;
let lightingNow: LightingState | null = null;
let starting = false;
let noiseTarget: number = PT_API.noise;
let scaleWanted = 0;
let generation = 0;
let cleanRequest = 0;
let cleaning: Promise<boolean> | null = null;
let building: Promise<void> | null = null;

const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

/** Station-frame camera pose from the app's world-frame camera (world = Rz(rotZ) · station). */
export function stationPose(pos: ArrayLike<number>, quat: ArrayLike<number>, rotZ: number): CameraPose {
  const c = Math.cos(-rotZ), s = Math.sin(-rotZ);
  const qz = fromAxisAngle([0, 0, 1], -rotZ);
  const q = multiply(qz, [quat[0], quat[1], quat[2], quat[3]]);
  return { pos: [c * pos[0] - s * pos[1], s * pos[0] + c * pos[1], pos[2]], quat: q };
}

/** A fixed full-viewport WebGPU canvas over the page (pointer events pass through). */
export function createOverlayCanvas(parent: HTMLElement = document.body, zIndex = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'b5-pt-overlay';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: String(zIndex) });
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  c.width = Math.max(8, Math.round(innerWidth * dpr));
  c.height = Math.max(8, Math.round(innerHeight * dpr));
  parent.appendChild(c);
  return c;
}

function lightingOf(l: LightingState | number | undefined): LightingState {
  if (l === undefined) return tracerLightingAt(0);
  return typeof l === 'number' ? tracerLightingAt(l) : l;
}

function traceSize(): [number, number] {
  const c = startOpts!.canvas;
  const s = scaleWanted || startOpts!.scale || PT_API.scale;
  return [Math.max(8, Math.round(c.width * s)), Math.max(8, Math.round(c.height * s))];
}

async function buildIntegrator(): Promise<void> {
  const gen = generation;
  const o = startOpts!;
  const [w, h] = traceSize();
  const io: IntegratorOptions = {
    width: w, height: h,
    maxDepth: o.maxDepth ?? PT_API.maxDepth,
    clampIndirect: o.clampIndirect ?? PT_API.clampIndirect,
    regularize: o.regularize ?? PT_API.regularize,
    ...(o.sampler ? { sampler: o.sampler } : {}),
    toneExposure: RASTER_TONE_EXPOSURE * (o.exposure ?? 1)
  };
  const next = await createIntegrator(dev!.device, gpuScene!, io);
  if (generation !== gen) { next.dispose(); return; }
  atrous?.dispose(); atrous = null;
  oidn?.dispose(); oidn = null; oidnLoading = null;
  integ?.dispose();
  integ = next;
  integ.setLighting(lightingNow!);
  integ.setCamera(camNow!.pose, camNow!.fovY ?? PT_API.fovY, w / h);
  applyAdaptive();
  await integ.lightsReady();
}

function applyAdaptive(): void {
  integ?.setAdaptive({ target: noiseTarget / 100, capSpp: samplesNeeded() });
  pt.done = false;
}

function present(): void {
  if (!integ) return;
  const tex = pt.showing === 'oidn' && oidn ? oidn.output : pt.showing === 'atrous' && atrous ? atrous.output : integ.output;
  const exposure = startOpts?.exposure ?? 1;
  if (startOpts?.presentHdr) startOpts.presentHdr(tex, exposure);
  else presenter?.present(tex, { exposure: RASTER_TONE_EXPOSURE * exposure, mode: startOpts?.tone ?? PT_API.tone });
}

/** Re-present the accumulated image with a new display exposure. */
export function setPathExposure(exposure: number): void {
  if (!startOpts || startOpts.exposure === exposure) return;
  startOpts = { ...startOpts, exposure };
  if (pt.samples > 0) present();
}

function fail(e: unknown): void {
  pt.error = String(e instanceof Error ? e.message : e);
  console.error('[pt]', e);
  cleanup();
  pt.active = false;
  pt.ready = false;
}

function cleanup(): void {
  generation++;
  cleanRequest++;
  oidn?.cancel();
  const retired = { atrous, oidn: oidnLoading, integ, scene: ownScene ? gpuScene : null };
  // GPU steps and OIDN may enqueue more work after an await. Retire their
  // resources once those operations have finished, even on a quick restart.
  void Promise.allSettled([inflight, cleaning, building]).then(() => {
    retired.atrous?.dispose();
    void retired.oidn?.then(loaded => loaded?.dispose());
    retired.integ?.dispose();
    retired.scene?.destroy();
  });
  atrous = null; oidn = null; oidnLoading = null; integ = null;
  presenter?.destroy(); presenter = null;
  gpuScene = null;
  inflight = null; cleaning = null; building = null;
  startOpts = null;
}

/** Start path tracing. Resolves false (pt.error set) when the device / scene cannot run it. */
export async function startPath(scene: SceneDesc | GpuScene, camera: PathCamera, opts: StartPathOptions): Promise<boolean> {
  if (pt.active || starting) return true;
  starting = true;
  const gen = ++generation;
  pt.error = null; pt.build = 0; pt.samples = 0; pt.ready = false; pt.done = false; pt.noise = 100; pt.showing = 'raw'; pt.paused = false;
  startOpts = opts;
  camNow = camera;
  lightingNow = lightingOf(opts.lighting);
  const t0 = now();
  try {
    opts.onPhase?.('WebGPU: устройство…');
    let device: PtDevice;
    if (opts.device) {
      device = 'device' in opts.device ? opts.device : adoptDevice(opts.device);
    } else {
      if (!cachedDevice || cachedDevice.isLost()) cachedDevice = await createDevice();
      device = cachedDevice;
    }
    if (gen !== generation) return false;
    dev = device;
    pt.device = dev.info.description || dev.info.vendor;
    pt.active = true;
    if ('traversal' in scene) {
      gpuScene = scene;
      ownScene = false;
    } else {
      opts.onPhase?.('загрузка сцены и дерева обхода…');
      const pool = createBvhPool();
      pt.threaded = pool.threaded;
      let uploaded: GpuScene;
      try {
        uploaded = await uploadSceneDesc(dev.device, scene, { pool, images: opts.images, state: lightingNow, log: opts.log });
      } finally { pool.terminate(); }
      if (gen !== generation) { uploaded.destroy(); return false; }
      gpuScene = uploaded;
      ownScene = true;
    }
    pt.build = 0.5;
    opts.onPhase?.('компиляция ядер…');
    if (!opts.presentHdr) presenter = createPresenter(dev.device, opts.canvas);
    await (building = buildIntegrator());
    if (gen !== generation) return false;
    pt.build = 1;
    pt.buildMs = Math.round(now() - t0);
    pt.ready = true;
    starting = false;
    pathClock('start');
    return true;
  } catch (e) {
    if (gen !== generation) return false;
    starting = false;
    fail(e);
    return false;
  }
}

/** The camera moved (or pass the new one): accumulation restarts. */
export function pathCameraMoved(camera?: PathCamera): void {
  if (camera) camNow = camera;
  if (!pt.active || !pt.ready || !integ || !camNow) return;
  const it = integ;
  const run = () => {
    if (!integ || it !== integ || !camNow) return;
    integ.setCamera(camNow.pose, camNow.fovY ?? PT_API.fovY, integ.width / integ.height);
    applyAdaptive();
    pt.samples = 0; pt.noise = 100; pt.showing = 'raw';
  };
  if (inflight) void inflight.then(run); else run();
}

/** New lighting (phase number or state): accumulation restarts. */
export function setPathLighting(l: LightingState | number): void {
  lightingNow = lightingOf(l);
  cleanRequest++;
  oidn?.cancel();
  if (!integ) return;
  const it = integ;
  const run = () => {
    if (it !== integ) return;
    it.setLighting(lightingNow!); applyAdaptive(); pt.samples = 0; pt.noise = 100; pt.showing = 'raw';
  };
  if (inflight) void inflight.then(run); else run();
}

/** Progress 0…1 towards the noise target (≤ the spp cap). */
function progress(): number {
  return convergenceProgress(pt.noise / 100, noiseTarget / 100, pt.samples, samplesNeeded(), pt.done);
}

/**
 * One accumulation tick (call every animation frame). Starts a GPU step in
 * the background when none is running; presents when it finishes. Returns
 * the progress 0…1 (legacy: samples / samplesNeeded).
 */
export function pathStep(): number {
  if (!pt.active || !pt.ready || !integ) return 0;
  const [width, height] = traceSize();
  if (width !== integ.width || height !== integ.height) {
    setPathScale(scaleWanted);
    return 0;
  }
  if (pt.paused || pt.done) return progress();
  if (!inflight) {
    const gen = generation;
    const it = integ;
    inflight = it.step(startOpts?.budgetMs ?? PT_API.budgetMs).then((r) => {
      if (gen !== generation || it !== integ) return null;
      pt.samples = r.spp;
      pt.lastStepMs = r.ms;
      const c = r.convergence ?? it.convergence;
      if (c) {
        pt.noise = Number.isFinite(c.noise) ? c.noise * 100 : 100;
        pt.activeTiles = c.active.length;
      }
      pt.done = r.done || (c?.done ?? false);
      if (r.waves > 0) present();
      return r;
    }).catch((e) => { if (gen === generation) fail(e); return null; })
      .finally(() => { if (gen === generation) inflight = null; });
  }
  return progress();
}

/** Resolves when the running GPU step (if any) finished (tests, screenshots). */
export async function pathIdle(): Promise<void> {
  while (inflight) await inflight;
}

export function stopPath(): void {
  cleanup();
  pt.active = false; pt.ready = false; pt.build = 0; pt.samples = 0;
  pt.buildMs = 0; pt.error = null; pt.paused = false; pt.done = false; pt.noise = 100; pt.showing = 'raw';
  starting = false;
}

/** Target noise in percent (legacy setNoiseTarget); the spp cap follows. */
export function setNoiseTarget(pct: number): void {
  noiseTarget = pct > 0 ? pct : PT_API.noise;
  if (integ) {
    const run = () => applyAdaptive();
    if (inflight) void inflight.then(run); else run();
  }
}

/** Per-pixel sample CAP for the current target: ceil(1e4 / noise²). */
export function samplesNeeded(): number {
  return samplesForNoise(noiseTarget);
}

/** Measured noise in percent (95th-percentile tile error; 100 before the first estimate). */
export function noiseNow(): number {
  return pt.samples > 0 ? pt.noise : 100;
}

/** Trace resolution as a fraction of the canvas; restarts the accumulation (new buffers). */
export function setPathScale(v: number): void {
  scaleWanted = v > 0 ? v : 0;
  if (!integ || !pt.ready) return;
  const gen = generation;
  cleanRequest++;
  oidn?.cancel();
  pt.ready = false;
  const run = async () => {
    await Promise.all([pathIdle(), cleaning]);
    if (gen !== generation) return;
    try {
      await (building = buildIntegrator());
      if (gen !== generation) return;
      pt.samples = 0; pt.noise = 100; pt.showing = 'raw';
      pt.paused = false;
      pt.ready = true;
    } catch (e) { if (gen === generation) fail(e); }
  };
  void run();
}

/** Pause with cleaning: accumulation stops and the à-trous result is shown; false resumes. */
export function setPaused(on: boolean, mode: 'atrous' | 'oidn' = 'atrous'): boolean {
  pt.paused = !!on;
  pathClock(pt.paused ? 'pause' : 'resume');
  if (pt.paused) {
    const clean = cleanPath(mode);
    const request = cleanRequest;
    void clean.then(ok => {
      if (!ok && mode === 'oidn' && pt.paused && request === cleanRequest) void cleanPath('atrous');
    });
  } else showRaw();
  return pt.paused;
}

export function pathPaused(): boolean {
  return pt.paused;
}

/**
 * Denoise the current accumulation and show it: 'atrous' (preview, ~ms) or
 * 'oidn' (Open Image Denoise, lazily loaded — needs opts.oidn). Resolves
 * true when the image was cleaned.
 */
export function cleanPath(mode: 'atrous' | 'oidn' = 'atrous'): Promise<boolean> {
  const request = ++cleanRequest;
  const previous = cleaning;
  const task = (async () => {
    if (previous) await previous;
    if (request !== cleanRequest) return false;
    return runClean(mode, request);
  })();
  cleaning = task;
  void task.finally(() => { if (cleaning === task) cleaning = null; });
  return task;
}

async function runClean(mode: 'atrous' | 'oidn', request: number): Promise<boolean> {
  if (!integ || !dev) return false;
  const it = integ;
  const gen = generation;
  await pathIdle();
  if (it !== integ || request !== cleanRequest) return false;
  try {
    if (mode === 'oidn') {
      if (!startOpts?.oidn) return false;
      oidnLoading ??= createOidnDenoiser(dev.device, it.width, it.height, startOpts.oidn).catch((e) => {
        console.warn('[pt] OIDN unavailable:', e);
        return null;
      });
      const loaded = await oidnLoading;
      if (!loaded) return false;
      if (it !== integ || gen !== generation) return false;
      oidn = loaded;
      if (request !== cleanRequest) return false;
      pt.denoiseMs = await oidn.denoise(it.output, it.aovs.albedo, it.aovs.normal);
    } else {
      atrous ??= createAtrousDenoiser(dev.device, it.width, it.height, it.buffers, startOpts?.atrous);
      pt.denoiseMs = await atrous.run();
    }
    if (it !== integ || gen !== generation || request !== cleanRequest) return false;
    pt.showing = mode;
    present();
    return true;
  } catch (e) {
    if (request === cleanRequest) console.warn('[pt] denoise failed:', e);
    return false;
  }
}

/** Show the raw accumulation again (after cleanPath). */
export function showRaw(): void {
  cleanRequest++;
  oidn?.cancel();
  pt.showing = 'raw';
  present();
}

/* Run time; pause stops the clock (legacy pathClock). */
let runMs = 0, runFrom = 0;

export function pathClock(tick?: 'start' | 'pause' | 'resume'): number {
  const t = now();
  if (tick === 'start') { runMs = 0; runFrom = t; return 0; }
  if (tick === 'pause') { if (runFrom) runMs += t - runFrom; runFrom = 0; return runMs; }
  if (tick === 'resume') { runFrom = t; return runMs; }
  return runMs + (runFrom ? t - runFrom : 0);
}

/** Status line (Russian, like js/pathtrace.js pathLabel). */
export function pathLabel(): string {
  if (pt.error) return `путь недоступен · ${pt.error}`;
  if (!pt.ready) return pt.build > 0 ? `подготовка · ${(pt.build * 100) | 0}%` : 'загрузка сцены и дерева обхода…';
  const spp = pt.samples < 10 ? pt.samples.toFixed(1) : String(pt.samples | 0);
  if (pt.paused) return `пауза · выборок ${spp} · картинка очищена`;
  const built = pt.buildMs ? ` · подготовка ${(pt.buildMs / 1000).toFixed(1)} с` : '';
  const n = noiseNow();
  return pt.done
    ? `готово · шум ${n.toFixed(1)}% · ${spp} выборок${built}`
    : `путь · шум ${n.toFixed(1)}% из ${noiseTarget}% · выборок ${spp}${built}`;
}

/** The integrator / presenter of the running session (tests, three composite later). */
export function pathInternals(): { integrator: Integrator | null; device: PtDevice | null; atrous: AtrousDenoiser | null; oidn: OidnDenoiser | null } {
  return { integrator: integ, device: dev, atrous, oidn };
}

/** Present now and encode the canvas as an image in the same task (screenshots of the WebGPU overlay). */
export function pathSnapshot(type = 'image/png'): Promise<Blob | null> {
  present();
  const c = startOpts?.canvas;
  if (!c) return Promise.resolve(null);
  if ('convertToBlob' in c) return c.convertToBlob({ type });
  return new Promise((resolve) => (c as HTMLCanvasElement).toBlob(resolve, type));
}
