/* ═══════════════════════════════════════════════════════════════════════════
   Wavefront-lite path tracer integrator (PT M1).

   One WAVE = N paths, one sample each, over the pixel range
   [waveStart, waveStart + N) mod pixels (N ≤ pixels, so a pixel appears at
   most once per wave → accumulation without float atomics). Per wave:

     k_raygen                      camera rays (station frame), path state, queue A
     for bounce b = 0 … maxDepth:
       k_intersect  (B5)           closest hit of the queued rays (indirect for b > 0)
       k_shade                     emission, AOVs, tube NEE → shadow queue, BSDF
                                   sample → extension queue (compacted, atomics)
       k_args                      swap queues, write indirect dispatch args
       k_shadow     (B5)           any-hit of the shadow queue          ┐ b < maxDepth
       k_shadow_resolve            unoccluded NEE → path radiance       ┘
     k_accumulate                  path radiance → pixel accumulation
   k_resolve (once per step)       accumulation → rgba16float output

   Everything after k_raygen is GPU-driven (indirect dispatch), so a step
   records waves without any readback; one compute pass per submit, timed
   with timestamp-query when available (else submit → onSubmittedWorkDone
   latency). The number of waves (and the wave size while it is smaller than
   a frame) adapts so that one submit stays under ~40 ms of GPU time.

   Seam with U3 (DECISIONS.md "M1 interface"): k_shade includes
   "surface.wgsl" (b5_surface) and binds its resources as group 2;
   createIntegrator() takes U3's scene-upload.ts GpuScene directly. Scenes
   without U3 resources (furnace / tests) use wgsl/surface_stub.wgsl (Lambert,
   constant albedo / emission) behind the same function.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { CameraPose } from '../core/camera/flight.ts';
import { exposureFromEv100 } from '../core/lighting/phases.ts';
import { rotateVec3 } from '../core/math/quat.ts';
import type { EmitterDesc, LightingState, Linear3 } from '../core/scene/types.ts';
import { AOV_FORMATS } from '../core/shading/contracts.ts';
import { VIS_CAMERA, VIS_INDIRECT, VIS_SHADOW } from './bvh/layout.ts';
import { BUFFER, MAP, STAGE, TEXTURE } from './gpu-flags.ts';
import {
  buildKernelSource, compileShader, createKernels, dispatchSize,
  type KernelDefines, type PtKernels, type WgslSources
} from './kernels.ts';
import { DBG_BYTES, HIT_BYTES, PARAMS_BYTES, PARAMS_W, RAY_BYTES } from './rays.ts';
import { surfaceBindGroupLayoutEntries, surfaceSources, type GpuScene as UploadedScene } from './scene-upload.ts';
import { WGSL_SOURCES } from './wgsl/index.ts';
import camera from './wgsl/camera.wgsl?raw';
import kAccumulate from './wgsl/k_accumulate.wgsl?raw';
import kArgs from './wgsl/k_args.wgsl?raw';
import kRaygen from './wgsl/k_raygen.wgsl?raw';
import kResolve from './wgsl/k_resolve.wgsl?raw';
import kShade from './wgsl/k_shade.wgsl?raw';
import kShadowResolve from './wgsl/k_shadow_resolve.wgsl?raw';
import ptState from './wgsl/pt_state.wgsl?raw';
import sampling from './wgsl/sampling.wgsl?raw';
import surfaceStub from './wgsl/surface_stub.wgsl?raw';
import lightTube from './wgsl/light_tube.wgsl?raw';
import lightTree from './wgsl/light_tree.wgsl?raw';
import bsdfStd from './wgsl/bsdf_std.wgsl?raw';
import bsdfGlass from './wgsl/bsdf_glass.wgsl?raw';
import bsdfWater from './wgsl/bsdf_water.wgsl?raw';
import bsdf from './wgsl/bsdf.wgsl?raw';
import traverseTr from './wgsl/traverse_tr.wgsl?raw';
import kShadowTr from './wgsl/k_shadow_tr.wgsl?raw';
import kLightpower from './wgsl/k_lightpower.wgsl?raw';
import kTilestats from './wgsl/k_tilestats.wgsl?raw';
import { LIGHT_MODE, TUBE_MODE, emitWgslPtConfig } from './config.ts';
import { emitWgslLights, type LightList, type PackedLights } from './lights/light-data.ts';
import { packLightsAsync } from './lights/pack-async.ts';
import { preparedLightList } from './scene-upload.ts';
import { SAMPLER_MODE, type SamplerName } from './sampler.ts';
import {
  CONVERGENCE, TILE_STATS_FLOATS, calibrateStats, noiseCalibration, selectActiveTiles, tileGrid, type ConvergenceSummary, type TileGrid
} from './convergence.ts';

/* ─── layouts (mirror of wgsl/pt_state.wgsl) ──────────────────────────────── */

export const FRAME_BYTES = 176;
/** one frame uniform per wave, dynamic offset (minUniformBufferOffsetAlignment ≤ 256) */
export const FRAME_SLOT = 256;
export const FRAME_OFFSETS = {
  camPos: 0, waveStart: 12, camRight: 16, waveSize: 28, camUp: 32, pixels: 44, camFwd: 48, width: 60,
  tubeLe: 64, height: 76, tubeR: 80, tubeZ0: 84, tubeLen: 88, tubeOn: 92,
  maxDepth: 96, rrDepth: 100, clampInd: 104, flags: 108,
  coneSpread: 112, maxDim: 116, capacity: 120, salt: 124,
  rayEps: 128, diffuseSpread: 132, shadowEps: 136, minAlpha: 140,
  tubeMode: 144, lightMode: 148, tubeLum: 152, regK: 156,
  tilesX: 160, activeSlots: 164, toneExp: 168, convEps: 172
} as const;
export const FRAME_FLAG_AOV = 1;
export const FRAME_FLAG_JITTER = 2;
/** Owen-scrambled Sobol sampler (else PCG) */
export const FRAME_FLAG_SOBOL = 4;
/** adaptive: paths map onto the active tile list */
export const FRAME_FLAG_TILES = 8;

export const PATH_BYTES = 128;
export const PATH_OFFSETS = {
  o: 0, coneW: 12, d: 16, coneS: 28, thr: 32, pixel: 44, L: 48, rng: 60,
  sL: 64, depth: 76, pdf: 80, sample: 84, flags: 88, aux: 92, pp: 96, alb: 108, pn: 112, nrm: 124
} as const;

/** queue control words (B5_Q_* in pt_state.wgsl) */
export const Q = { count: 0, next: 1, shadow: 2, shadowLive: 3, parity: 4, bounce: 5, rays: 6, shadows: 7 } as const;
export const Q_CTL_WORDS = 16;
/** byte size of the queues buffer: control words + 3 index regions */
export const queuesBytes = (capacity: number): number => (Q_CTL_WORDS + 3 * capacity) * 4;
/** indirect args: [rays x, y, z, shadows x, y, z] */
export const ARGS_BYTES = 24;
export const ARGS_RAYS_OFFSET = 0;
export const ARGS_SHADOW_OFFSET = 12;
/** frame slots = max waves per submit */
export const MAX_WAVES_PER_SUBMIT = 16;
/** timestamp queries of a profiled step (2 per dispatch) */
export const PROFILE_QUERIES = 4096;
/** path capacity granularity: keeps the shadow-ray region of the rays buffer 256-byte aligned */
export const CAPACITY_ALIGN = 64;

/** Integrator knobs (no magic numbers in code — everything tunable lives here). */
export const INTEGRATOR_DEFAULTS = {
  maxDepth: 6,
  rrDepth: 3,
  /** firefly clamp of indirect contributions (max component, scene radiance units); 0 = off */
  clampIndirect: 16,
  /** path state capacity (a wave never exceeds it nor the pixel count). 2^18 paths: full-frame waves are
      split into partial ones (each submit stays ≤ maxSubmitMs at any resolution) and the path / ray /
      hit buffers stay ≈ 60 MB — with 2^20 they were evicted to system memory on an 8 GB GPU that also
      ran another CUDA process (raygen 500× slower); throughput is the same within a few % */
  maxPaths: 1 << 18,
  workgroupSize: 64,
  /** origin offset along the geometric normal, × (1 + max |p|) */
  rayEps: 2e-5,
  /** shadow ray tmax = distance · (1 − shadowEps) */
  shadowEps: 1e-3,
  /** ray-cone spread after a diffuse bounce (rad) */
  diffuseSpread: 0.25,
  /** GGX roughness floor (three r187 MeshStandardMaterial: 0.045) */
  minRoughness: 0.045,
  /** GPU time per submit (ms) */
  maxSubmitMs: 40,
  /** paths of the very first (calibration) submit, as a fraction of the pixels */
  firstStepFraction: 0.25,
  /** EMA weight of a new ms-per-path measurement */
  costEma: 0.5,
  /** fraction of the budget the cost model aims at (GPU time per path varies between waves / views) */
  budgetSafety: 0.85,
  tubeMode: 'equiangular' as TubeModeName,
  lightMode: 'tree' as LightModeName,
  /** sampler (sampler.ts): Owen-scrambled Sobol; 'pcg' = the M1 stream */
  sampler: 'sobol' as SamplerName,
  /**
   * Path regularization k (k_shade): at vertex depth ≥ 1, roughness = max(own, k × roughness of the
   * previous non-delta vertex). BIASED: glossy-after-rough chains (caustics seen via a rough bounce,
   * e.g. water / metal lit by light that already scattered off a rough surface) get blurrier and
   * dimmer peaks; energy is approximately kept (the GGX lobe only widens). Measured on view 0 DAY
   * @16 spp with k = 0.5: noise 27.8 → 26.7–27.4 %, mean luminance −0.00…−0.03 % — the station
   * has few glossy chains, so it is off by default (0 = unbiased); the photo-mode API can enable it.
   * Fireflies are also handled by clampIndirect (biased the same way: it clips energy).
   */
  regularize: 0
} as const;

export type TubeModeName = keyof typeof TUBE_MODE;
export type LightModeName = keyof typeof LIGHT_MODE;

export interface FrameParams {
  camPos: ArrayLike<number>;
  camRight: ArrayLike<number>;
  camUp: ArrayLike<number>;
  camFwd: ArrayLike<number>;
  waveStart: number;
  waveSize: number;
  width: number;
  height: number;
  tube: TubeEmitter | null;
  tubeLe: ArrayLike<number>;
  maxDepth: number;
  rrDepth: number;
  clampInd: number;
  flags: number;
  coneSpread: number;
  maxDim: number;
  capacity: number;
  salt: number;
  rayEps: number;
  diffuseSpread: number;
  shadowEps: number;
  minAlpha: number;
  /** TUBE_MODE (config.ts) */
  tubeMode: number;
  /** LIGHT_MODE (config.ts); none when there are no triangle lights */
  lightMode: number;
  /** path regularization k (0 = off) */
  regK: number;
  /** convergence tiles per row */
  tilesX: number;
  /** FRAME_FLAG_TILES: active tiles × tile² path slots */
  activeSlots: number;
  /** k_tilestats tonemap-weighting exposure and display-space ε */
  toneExp: number;
  convEps: number;
}

/** Serialize one frame uniform at byteOffset (little-endian, pt_state.wgsl B5Frame). */
export function writeFrame(buf: ArrayBuffer, byteOffset: number, f: FrameParams): void {
  const v = new DataView(buf, byteOffset, FRAME_BYTES);
  const O = FRAME_OFFSETS;
  const v3 = (o: number, a: ArrayLike<number>) => { v.setFloat32(o, a[0], true); v.setFloat32(o + 4, a[1], true); v.setFloat32(o + 8, a[2], true); };
  const u = (o: number, x: number) => v.setUint32(o, x >>> 0, true);
  const fl = (o: number, x: number) => v.setFloat32(o, x, true);
  v3(O.camPos, f.camPos); u(O.waveStart, f.waveStart);
  v3(O.camRight, f.camRight); u(O.waveSize, f.waveSize);
  v3(O.camUp, f.camUp); u(O.pixels, f.width * f.height);
  v3(O.camFwd, f.camFwd); u(O.width, f.width);
  v3(O.tubeLe, f.tubeLe); u(O.height, f.height);
  fl(O.tubeR, f.tube?.radius ?? 0); fl(O.tubeZ0, f.tube?.z0 ?? 0); fl(O.tubeLen, f.tube?.length ?? 0); u(O.tubeOn, f.tube ? 1 : 0);
  u(O.maxDepth, f.maxDepth); u(O.rrDepth, f.rrDepth); fl(O.clampInd, f.clampInd); u(O.flags, f.flags);
  fl(O.coneSpread, f.coneSpread); u(O.maxDim, f.maxDim); u(O.capacity, f.capacity); u(O.salt, f.salt);
  fl(O.rayEps, f.rayEps); fl(O.diffuseSpread, f.diffuseSpread); fl(O.shadowEps, f.shadowEps); fl(O.minAlpha, f.minAlpha);
  u(O.tubeMode, f.tubeMode); u(O.lightMode, f.lightMode);
  fl(O.tubeLum, 0.2126 * f.tubeLe[0] + 0.7152 * f.tubeLe[1] + 0.0722 * f.tubeLe[2]); fl(O.regK, f.regK);
  u(O.tilesX, f.tilesX); u(O.activeSlots, f.activeSlots); fl(O.toneExp, f.toneExp); fl(O.convEps, f.convEps);
}

/* ─── camera (station frame, three PerspectiveCamera conventions) ─────────── */

export interface CameraBasis {
  pos: [number, number, number];
  /** unit forward (camera −Z) */
  fwd: [number, number, number];
  /** unit right × tan(fovY/2) × aspect */
  right: [number, number, number];
  /** unit up × tan(fovY/2) */
  up: [number, number, number];
  /** pixel cone spread angle for `height` rows (rad) */
  tanHalf: number;
}

/** Basis of a pinhole camera from a station-frame pose; fovY in DEGREES (three). */
export function cameraBasis(pose: CameraPose, fovY: number, aspect: number): CameraBasis {
  const t = Math.tan((fovY * Math.PI) / 360);
  const r = rotateVec3(pose.quat, [1, 0, 0], [0, 0, 0]);
  const u = rotateVec3(pose.quat, [0, 1, 0], [0, 0, 0]);
  const f = rotateVec3(pose.quat, [0, 0, -1], [0, 0, 0]);
  return {
    pos: [pose.pos[0], pose.pos[1], pose.pos[2]],
    fwd: [f[0], f[1], f[2]],
    right: [r[0] * t * aspect, r[1] * t * aspect, r[2] * t * aspect],
    up: [u[0] * t, u[1] * t, u[2] * t],
    tanHalf: t
  };
}

/** CPU mirror of camera.wgsl b5_camera_dir: px/py continuous pixel coords, row 0 at the top. */
export function cameraRayDir(b: CameraBasis, px: number, py: number, width: number, height: number): [number, number, number] {
  const sx = (px / width) * 2 - 1, sy = 1 - (py / height) * 2;
  const x = b.fwd[0] + b.right[0] * sx + b.up[0] * sy;
  const y = b.fwd[1] + b.right[1] * sx + b.up[1] * sy;
  const z = b.fwd[2] + b.right[2] * sx + b.up[2] * sy;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/* ─── queue / wave planning (CPU mirrors, tested in Node) ─────────────────── */

/** k_args.wgsl b5_split: workgroups for `count` invocations, 2-D beyond maxDim (count 0 → 0 groups). */
export function argsSplit(count: number, wg: number, maxDim: number): [number, number, number] {
  const groups = Math.ceil(count / wg);
  if (groups <= maxDim) return [groups, 1, 1];
  const y = Math.ceil(groups / maxDim);
  return [Math.ceil(groups / y), y, 1];
}

/** Path capacity for a resolution: min(pixels, maxPaths) rounded UP to CAPACITY_ALIGN. */
export function pathCapacity(pixels: number, maxPaths: number): number {
  const n = Math.max(1, Math.min(pixels, maxPaths));
  return Math.ceil(n / CAPACITY_ALIGN) * CAPACITY_ALIGN;
}

/**
 * Split `paths` into waves: each ≤ min(capacity, pixels), at most maxWaves
 * waves (the total is trimmed to fit). Returns the wave sizes.
 */
export function planWaves(paths: number, capacity: number, pixels: number, maxWaves = MAX_WAVES_PER_SUBMIT): number[] {
  const n = Math.min(capacity, pixels);
  const total = Math.max(1, Math.min(Math.floor(paths), n * maxWaves));
  const out: number[] = [];
  for (let left = total; left > 0; left -= n) out.push(Math.min(n, left));
  return out;
}

/** Paths for the next submit from the measured cost (ms per path) and the budget. */
export function pathsForBudget(budgetMs: number, msPerPath: number | null, pixels: number, firstFraction: number): number {
  if (!msPerPath || !(msPerPath > 0)) return Math.max(1, Math.round(pixels * firstFraction));
  return Math.max(1, Math.floor(budgetMs / msPerPath));
}

/**
 * Per-region cost model of the waves (PT-W4a). Waves sweep the pixel range,
 * and the GPU cost per path differs a lot between image regions (sky-like
 * tube views vs. the floor with many bounces), so one global ms-per-path
 * overshoots the submit budget when a wave enters an expensive region. The
 * pixel range is split into COST_REGIONS buckets with their own ms-per-path
 * (unknown buckets use the mean of the known ones).
 */
export const COST_REGIONS = 32;

export interface CostModel {
  /** ms per path per region, 0 = unknown */
  cost: Float64Array;
}

export function createCostModel(): CostModel {
  return { cost: new Float64Array(COST_REGIONS) };
}

function regionCost(m: CostModel, r: number): number {
  if (m.cost[r] > 0) return m.cost[r];
  let s = 0, n = 0;
  for (const c of m.cost) if (c > 0) { s += c; n++; }
  return n ? s / n : 0;
}

/** Estimated GPU ms of the paths [start, start + n) (mod pixels); 0 when nothing is known yet. */
export function estimateMs(m: CostModel, start: number, n: number, pixels: number): number {
  let ms = 0, g = start % pixels, left = n;
  while (left > 0) {
    const r = Math.min(COST_REGIONS - 1, Math.floor((g * COST_REGIONS) / pixels));
    const end = Math.min(pixels, Math.floor(((r + 1) * pixels) / COST_REGIONS));
    const k = Math.max(1, Math.min(left, end - g));
    ms += k * regionCost(m, r);
    left -= k;
    g = (g + k) % pixels;
  }
  return ms;
}

/**
 * Waves for one submit from `start`: each ≤ min(capacity, pixels), as many
 * paths as the cost model fits into budgetMs (the last wave is partial), at
 * most maxWaves; with no cost known yet: firstPaths.
 */
export function planWavesByCost(
  m: CostModel, start: number, budgetMs: number, capacity: number, pixels: number, firstPaths: number,
  maxWaves = MAX_WAVES_PER_SUBMIT
): number[] {
  const n = Math.min(capacity, pixels);
  if (estimateMs(m, start, 1, pixels) <= 0) return planWaves(firstPaths, capacity, pixels, maxWaves);
  const out: number[] = [];
  let ms = 0, s = start;
  while (out.length < maxWaves) {
    const full = estimateMs(m, s, n, pixels);
    if (ms + full <= budgetMs) { out.push(n); ms += full; s += n; continue; }
    /* partial wave: bisect the size that still fits */
    let lo = 0, hi = n;
    while (hi - lo > CAPACITY_ALIGN) {
      const mid = (lo + hi) >> 1;
      if (ms + estimateMs(m, s, mid, pixels) <= budgetMs) lo = mid; else hi = mid;
    }
    if (lo > 0) out.push(lo);
    break;
  }
  if (!out.length) out.push(CAPACITY_ALIGN > n ? n : CAPACITY_ALIGN);
  return out;
}

/** Every known region cost → their mean (the wave mapping changed, e.g. a new active tile list). */
export function flattenCostModel(m: CostModel): void {
  let s = 0, n = 0;
  for (const c of m.cost) if (c > 0) { s += c; n++; }
  m.cost.fill(n ? s / n : 0);
}

/**
 * Path slots [start, start + n) (mod active × tile²) of the active tile list
 * that land inside the image (k_raygen b5_slot_pixel; edge tiles are partial).
 */
export function validSlots(active: ArrayLike<number>, start: number, n: number, width: number, height: number, tile = 16): number {
  const per = tile * tile, slots = active.length * per;
  if (!slots) return 0;
  const tilesX = Math.ceil(width / tile);
  let s = start % slots, left = n, valid = 0;
  while (left > 0) {
    const t = active[Math.floor(s / per)];
    const cw = Math.min(tile, width - (t % tilesX) * tile), rh = Math.min(tile, height - Math.floor(t / tilesX) * tile);
    const l0 = s % per, k = Math.min(left, per - l0);
    if (cw === tile && rh === tile) valid += k;
    else for (let l = l0; l < l0 + k; l++) if (l % tile < cw && Math.floor(l / tile) < rh) valid++;
    left -= k;
    s = (s + k) % slots;
  }
  return valid;
}

/** Fold a measured submit (waves from `start`, total ms) into the regions it covered. */
export function updateCostModel(m: CostModel, start: number, waves: readonly number[], ms: number, pixels: number, ema: number): void {
  const total = waves.reduce((a, b) => a + b, 0);
  const predicted = estimateMs(m, start, total, pixels);
  const flat = ms / total;
  const ratio = predicted > 0 ? ms / predicted : 0;
  const touched = new Set<number>();
  let g = start % pixels;
  for (let left = total; left > 0;) {
    const r = Math.min(COST_REGIONS - 1, Math.floor((g * COST_REGIONS) / pixels));
    const end = Math.min(pixels, Math.floor(((r + 1) * pixels) / COST_REGIONS));
    const k = Math.max(1, Math.min(left, end - g));
    touched.add(r);
    left -= k;
    g = (g + k) % pixels;
  }
  for (const r of touched) {
    const measured = ratio > 0 && m.cost[r] > 0 ? m.cost[r] * ratio : ratio > 0 ? regionCost(m, r) * ratio : flat;
    m.cost[r] = m.cost[r] > 0 ? m.cost[r] * (1 - ema) + measured * ema : measured;
  }
}

/* ─── emitters / lighting ─────────────────────────────────────────────────── */

export interface TubeEmitter {
  radius: number;
  length: number;
  z0: number;
}

export function tubeFromEmitters(emitters: readonly EmitterDesc[] | undefined): TubeEmitter | null {
  const t = emitters?.find((e) => e.kind === 'tube');
  return t && t.kind === 'tube' ? { radius: t.radius, length: t.length, z0: t.z0 } : null;
}

/**
 * Tube radiance in scene radiance units (DECISIONS.md: nits × exposure, so
 * the output feeds the tonemap near 1.0): tubeColor × tubeNits × exposure(ev100).
 */
export function tubeRadiance(state: LightingState): Linear3 {
  const k = state.phys.tubeNits * exposureFromEv100(state.phys.ev100);
  const c = state.phys.tubeColor;
  return [c[0] * k, c[1] * k, c[2] * k];
}

/* ─── public API ──────────────────────────────────────────────────────────── */

/** Group-2 resources of surface.wgsl (U3's scene-upload.ts) and the sources to compile. */
export interface SurfaceBinding {
  /** WGSL sources merged into the kernel map; must contain 'surface.wgsl' (+ its includes).
      Absent: the Lambert stub (wgsl/surface_stub.wgsl) */
  sources?: WgslSources;
  layoutEntries?: GPUBindGroupLayoutEntry[];
  bindGroup?: GPUBindGroup;
  defines?: KernelDefines;
}

/** What the integrator needs from the uploaded scene. */
export interface IntegratorScene {
  nodes: GPUBuffer;
  tris: GPUBuffer;
  instances: GPUBuffer;
  /** debug counters (B5_DBG); created if absent */
  dbg?: GPUBuffer;
  tlasRoot: number;
  surface?: SurfaceBinding;
  /** EmitterDesc list (the 'tube' entry drives NEE) or an explicit tube; null = no tube */
  emitters?: readonly EmitterDesc[];
  tube?: TubeEmitter | null;
  /** palette update of the surface resources (U3), called by setLighting */
  setLighting?(state: LightingState): void;
  /** emissive-triangle lights (needs the real surface: their power comes from k_lightpower) */
  lights?: LightList | null;
}

export interface IntegratorOptions {
  width: number;
  height: number;
  maxDepth?: number;
  rrDepth?: number;
  clampIndirect?: number;
  maxPaths?: number;
  workgroupSize?: number;
  /** GGX specular lobe (false = pure Lambert, furnace test) */
  specular?: boolean;
  jitter?: boolean;
  aov?: boolean;
  /** sampler salt (different noise per run) */
  salt?: number;
  /** WGSL sources (Node: pathtracer/test/wgsl-fs.ts); default: Vite ?raw bundle */
  sources?: WgslSources;
  /** extra loader defines for every integrator kernel */
  defines?: KernelDefines;
  /** colour output (rgba16float, STORAGE_BINDING), e.g. a three StorageTexture; created if absent */
  output?: GPUTexture;
  maxSubmitMs?: number;
  /** use timestamp-query (default: when the device has the feature) */
  timestamps?: boolean;
  /** overrides of INTEGRATOR_DEFAULTS */
  rayEps?: number;
  shadowEps?: number;
  diffuseSpread?: number;
  minRoughness?: number;
  /** tube NEE strategy (default equiangular) */
  tubeMode?: TubeModeName;
  /** emissive-triangle light selection (default tree) */
  lightMode?: LightModeName;
  /** light tree / alias build off the main thread (default: when Worker exists) */
  lightWorker?: boolean;
  /** time every dispatch separately (timestamp-query; slower) → StepResult.profile */
  profile?: boolean;
  /** sampler (default Owen-scrambled Sobol) */
  sampler?: SamplerName;
  /** path regularization k (default 0 = off) */
  regularize?: number;
  /** convergence statistics: tonemap-weighting exposure / display-space ε (convergence.ts CONVERGENCE) */
  toneExposure?: number;
  convEpsilon?: number;
  /** factor on the measured tile errors (default: convergence.ts noiseCalibration(sampler)) */
  noiseCalibration?: number;
}

/** Adaptive sampling (convergence.ts): stop per 16×16 tile at 	arget relative error or capSpp. */
export interface AdaptiveOptions {
  /** target relative error per tile (fraction: 0.03 = 3 %) */
  target: number;
  /** per-pixel spp cap (js/pathtrace.js samplesNeeded) */
  capSpp: number;
  /** no tile retires before this many spp (default CONVERGENCE.minSpp) */
  minSpp?: number;
}

/** Light structures of the last rebuild (HUD / tests). */
export interface LightStats {
  lights: number;
  active: number;
  nodes: number;
  totalPhi: number;
  powerMs: number;
  buildMs: number;
  /** per-light phi (k_lightpower readback) */
  phi: Float32Array;
  packed: PackedLights | null;
}

export interface StepResult {
  /** mean samples per pixel accumulated so far */
  spp: number;
  /** GPU time of this submit (timestamp-query) or submit→done latency, ms */
  ms: number;
  timer: 'timestamp-query' | 'wall-clock';
  paths: number;
  waves: number;
  /** extension + shadow rays traced in this submit */
  rays: number;
  shadowRays: number;
  mraysPerSec: number;
  /** opts.profile: GPU ms per kernel name, summed over the step */
  profile?: Record<string, number>;
  /** convergence after this step (adaptive mode or when statistics ran), else null */
  convergence: ConvergenceSummary | null;
  /** adaptive: every tile converged or capped — nothing was traced */
  done: boolean;
}

export interface IntegratorAovs {
  albedo: GPUTexture;
  normal: GPUTexture;
  depth: GPUTexture;
}

export interface Integrator {
  width: number;
  height: number;
  capacity: number;
  setCamera(stationPose: CameraPose, fovY: number, aspect: number): void;
  setLighting(state: LightingState): void;
  /** override the tube radiance (scene units) — analytic test scenes */
  setTubeRadiance(Le: Linear3): void;
  /** clear the accumulation (camera/lighting changes reset automatically) */
  reset(): void;
  /** new sampler salt (independent noise) + reset */
  setSalt(salt: number): void;
  /** render for about budgetMs of GPU time (≤ maxSubmitMs) in ONE submit, then resolve */
  step(budgetMs: number): Promise<StepResult>;
  /** accumulated samples per pixel */
  readonly spp: number;
  output: GPUTexture;
  aovs: IntegratorAovs;
  /** sum (rgb) and sample count (a) per pixel — tests / probes */
  readAccumulation(): Promise<Float32Array>;
  /** even-sample luminance sums per pixel (convergence half buffer) */
  readHalf(): Promise<Float32Array>;
  /** last tile statistics (TILE_STATS_FLOATS per tile; error column calibrated), null before the first */
  readonly tileStats: Float32Array | null;
  /** adaptive sampling on (target / cap) or off (null = whole frame, statistics only on demand) */
  setAdaptive(a: AdaptiveOptions | null): void;
  readonly adaptive: AdaptiveOptions | null;
  /** last convergence summary (adaptive), null before the first statistics */
  readonly convergence: ConvergenceSummary | null;
  /** run k_tilestats now (outside step) and return the summary for  (default: the adaptive options) */
  measure(a?: AdaptiveOptions): Promise<ConvergenceSummary>;
  /** accumulation buffers (vec4 rgb+count, f32 half, 2 × vec4 AOV per pixel) — denoiser / tests */
  buffers: { accum: GPUBuffer; half: GPUBuffer; aov: GPUBuffer };
  tiles: TileGrid;
  compileMs: number;
  /** resolves when the light structures of the current lighting are built (step() awaits it too) */
  lightsReady(): Promise<LightStats | null>;
  /** rebuild light power / tree (e.g. after GpuScene.updateDynamics moved emitters) */
  updateLights(list?: LightList | null): Promise<LightStats | null>;
  dispose(): void;
}

/** Default WGSL source map: B5 traversal files + integrator files (+ U3 surface when registered). */
export function integratorSources(extra: WgslSources = {}): Record<string, string> {
  const base: Record<string, string> = {
    ...WGSL_SOURCES,
    'sampling.wgsl': sampling,
    'camera.wgsl': camera,
    'pt_state.wgsl': ptState,
    'k_raygen.wgsl': kRaygen,
    'k_shade.wgsl': kShade,
    'k_args.wgsl': kArgs,
    'k_shadow_resolve.wgsl': kShadowResolve,
    'k_accumulate.wgsl': kAccumulate,
    'k_resolve.wgsl': kResolve,
    'surface_stub.wgsl': surfaceStub,
    'light_tube.wgsl': lightTube,
    'light_tree.wgsl': lightTree,
    'bsdf_std.wgsl': bsdfStd,
    'bsdf_glass.wgsl': bsdfGlass,
    'bsdf_water.wgsl': bsdfWater,
    'bsdf.wgsl': bsdf,
    'traverse_tr.wgsl': traverseTr,
    'k_shadow_tr.wgsl': kShadowTr,
    'k_lightpower.wgsl': kLightpower,
    'k_tilestats.wgsl': kTilestats,
    ...integratorGeneratedSources()
  };
  return { ...base, ...extra };
}

/** Generated includes of the integrator (pure; Node tests merge them with the fs sources). */
export function integratorGeneratedSources(): Record<string, string> {
  return { 'pt_config.gen.wgsl': emitWgslPtConfig(), 'lights.gen.wgsl': emitWgslLights() };
}

export const INTEGRATOR_KERNELS = {
  raygen: { file: 'k_raygen.wgsl', entryPoint: 'b5_k_raygen', wg: true },
  shade: { file: 'k_shade.wgsl', entryPoint: 'b5_k_shade', wg: true },
  args: { file: 'k_args.wgsl', entryPoint: 'b5_k_args', wg: true },
  shadowTr: { file: 'k_shadow_tr.wgsl', entryPoint: 'b5_k_shadow_tr', wg: true },
  shadowResolve: { file: 'k_shadow_resolve.wgsl', entryPoint: 'b5_k_shadow_resolve', wg: true },
  accumulate: { file: 'k_accumulate.wgsl', entryPoint: 'b5_k_accumulate', wg: true },
  resolve: { file: 'k_resolve.wgsl', entryPoint: 'b5_k_resolve', wg: false },
  lightPower: { file: 'k_lightpower.wgsl', entryPoint: 'b5_k_lightpower', wg: true },
  tileStats: { file: 'k_tilestats.wgsl', entryPoint: 'b5_k_tilestats', wg: false }
} as const;
export type IntegratorKernel = keyof typeof INTEGRATOR_KERNELS;

/** Stub-surface defines (surface_stub.wgsl) */
export const STUB_DEFINES: KernelDefines = { B5_STUB_ALBEDO: 0.5, B5_STUB_EMISSION: 0 };

type Entry = GPUBindGroupLayoutEntry;
const C = STAGE.COMPUTE;
const uni = (binding: number, dyn = false): Entry => ({ binding, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: dyn } });
const rw = (binding: number): Entry => ({ binding, visibility: C, buffer: { type: 'storage' } });
const ro = (binding: number): Entry => ({ binding, visibility: C, buffer: { type: 'read-only-storage' } });
const st = (binding: number, format: GPUTextureFormat): Entry =>
  ({ binding, visibility: C, storageTexture: { access: 'write-only', format, viewDimension: '2d' } });

/** U3's uploaded scene (scene-upload.ts GpuScene) → what the integrator binds. */
export function integratorSceneFromUpload(gs: UploadedScene): IntegratorScene {
  return {
    nodes: gs.traversal.nodes,
    tris: gs.traversal.tris,
    instances: gs.traversal.instances,
    dbg: gs.traversal.dbg,
    tlasRoot: gs.tlasRoot,
    surface: { sources: surfaceSources(), layoutEntries: surfaceBindGroupLayoutEntries, bindGroup: gs.surfaceBindGroup },
    emitters: gs.prepared.scene.emitters,
    setLighting: (state) => gs.setFrame(state),
    lights: preparedLightList(gs.prepared)
  };
}

const isUploaded = (s: IntegratorScene | UploadedScene): s is UploadedScene => 'traversal' in s && 'surfaceBindGroup' in s;

export async function createIntegrator(
  device: GPUDevice, gpuScene: IntegratorScene | UploadedScene, opts: IntegratorOptions
): Promise<Integrator> {
  const scene = isUploaded(gpuScene) ? integratorSceneFromUpload(gpuScene) : gpuScene;
  const D = INTEGRATOR_DEFAULTS;
  const width = opts.width, height = opts.height, pixels = width * height;
  const maxDepth = opts.maxDepth ?? D.maxDepth;
  const wg = opts.workgroupSize ?? D.workgroupSize;
  const capacity = pathCapacity(pixels, opts.maxPaths ?? D.maxPaths);
  const maxDim = device.limits.maxComputeWorkgroupsPerDimension;
  const useTs = (opts.timestamps ?? true) && device.features.has('timestamp-query');
  const maxSubmitMs = opts.maxSubmitMs ?? D.maxSubmitMs;
  const tube = scene.tube !== undefined ? scene.tube : tubeFromEmitters(scene.emitters);

  /* sources: surface.wgsl = U3's (scene.surface.sources) or the stub */
  const base = integratorSources(opts.sources ?? {});
  const sources: WgslSources = scene.surface?.sources
    ? { ...base, ...scene.surface.sources }
    : { ...base, 'surface.wgsl': base['surface_stub.wgsl'] };
  const defines: KernelDefines = {
    B5_SPECULAR: opts.specular ?? true,
    ...STUB_DEFINES,
    ...scene.surface?.defines,
    ...opts.defines
  };

  const t0 = performance.now();
  const kernels: PtKernels = await createKernels(device, sources, { workgroupSize: wg, defines });

  /* ── buffers ── */
  const owned: { destroy(): void }[] = [];
  const mk = (label: string, size: number, usage: number) => {
    const b = device.createBuffer({ label: `b5 pt ${label}`, size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    owned.push(b);
    return b;
  };
  const S = BUFFER.STORAGE;
  const frameBuf = mk('frame', FRAME_SLOT * MAX_WAVES_PER_SUBMIT, BUFFER.UNIFORM | BUFFER.COPY_DST);
  const paths = mk('paths', capacity * PATH_BYTES, S);
  const rays = mk('rays', 2 * capacity * RAY_BYTES, S);
  const hits = mk('hits', capacity * HIT_BYTES, S);
  const occluded = mk('occluded', capacity * 4, S);
  const queues = mk('queues', queuesBytes(capacity), S | BUFFER.COPY_DST | BUFFER.COPY_SRC);
  const args = mk('args', ARGS_BYTES, S | BUFFER.INDIRECT);
  const accum = mk('accum', pixels * 16, S | BUFFER.COPY_DST | BUFFER.COPY_SRC);
  /* convergence: even-sample luminance per pixel, AOV sums, tile statistics, active tile list */
  const half = mk('half', pixels * 4, S | BUFFER.COPY_DST | BUFFER.COPY_SRC);
  const aovAcc = mk('aov accum', pixels * 32, S | BUFFER.COPY_DST | BUFFER.COPY_SRC);
  const grid = tileGrid(width, height);
  const tileStatsBuf = mk('tile stats', grid.count * TILE_STATS_FLOATS * 4, S | BUFFER.COPY_SRC);
  const tileStaging = mk('tile stats staging', grid.count * TILE_STATS_FLOATS * 4, BUFFER.MAP_READ | BUFFER.COPY_DST);
  const activeBuf = mk('active tiles', grid.count * 4, S | BUFFER.COPY_DST);
  const dbg = scene.dbg ?? mk('dbg', DBG_BYTES, S | BUFFER.COPY_DST | BUFFER.COPY_SRC);
  const params = (label: string, mask: number) => {
    const b = mk(`params ${label}`, PARAMS_BYTES, BUFFER.UNIFORM | BUFFER.COPY_DST);
    const p = new Uint32Array(PARAMS_BYTES / 4);
    p[PARAMS_W.count] = capacity; // indirect dispatch pads to the workgroup: guard = capacity
    p[PARAMS_W.mask] = mask;
    p[PARAMS_W.root] = scene.tlasRoot;
    p[PARAMS_W.mode] = 0;
    device.queue.writeBuffer(b, 0, p);
    return b;
  };
  const paramsCam = params('camera', VIS_CAMERA);
  const paramsInd = params('indirect', VIS_INDIRECT);
  const paramsShadow = params('shadow', VIS_SHADOW);

  const texUsage = TEXTURE.STORAGE_BINDING | TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_SRC;
  const mkTex = (label: string, format: GPUTextureFormat) => {
    const t = device.createTexture({ label: `b5 pt ${label}`, size: [width, height], format, usage: texUsage });
    owned.push(t);
    return t;
  };
  const output = opts.output ?? mkTex('color', AOV_FORMATS.color);
  const aovs: IntegratorAovs = {
    albedo: mkTex('aov albedo', AOV_FORMATS.albedo),
    normal: mkTex('aov normal', AOV_FORMATS.normal),
    depth: mkTex('aov depth', AOV_FORMATS.depth)
  };

  /* ── layouts ── */
  const bgl = (label: string, entries: Entry[]) => device.createBindGroupLayout({ label: `b5 pt ${label}`, entries });
  const empty = bgl('empty', []);
  const emptyBg = device.createBindGroup({ layout: empty, entries: [] });
  const g1: Record<IntegratorKernel, GPUBindGroupLayout> = {
    raygen: bgl('raygen', [uni(0, true), rw(1), rw(2), rw(3), ro(4), ro(5)]),
    shade: bgl('shade', [uni(0, true), rw(1), ro(2), rw(3), rw(4), ro(5)]),
    args: bgl('args', [uni(0, true), rw(1), rw(2)]),
    shadowTr: kernels.ioLayout,
    lightPower: bgl('light power', [ro(0), rw(1), uni(2)]),
    shadowResolve: bgl('shadow resolve', [uni(0, true), rw(1), rw(2), ro(3)]),
    accumulate: bgl('accumulate', [uni(0, true), ro(1), rw(2), rw(3), rw(4)]),
    resolve: bgl('resolve', [uni(0, true), ro(1), st(2, AOV_FORMATS.color), ro(3),
      st(4, AOV_FORMATS.albedo), st(5, AOV_FORMATS.normal), st(6, AOV_FORMATS.depth)]),
    tileStats: bgl('tile stats', [uni(0, true), ro(1), ro(2), rw(3)])
  };
  /* k_shade group 0: only what b5_surface reads (tris, instances) — keeps the
     per-stage storage-buffer count within limits next to U3's group 2 */
  const shadeG0 = bgl('shade scene', [ro(1), ro(2)]);
  const surfLayout = bgl('surface', scene.surface?.layoutEntries ?? []);
  const surfBg = scene.surface?.bindGroup ?? device.createBindGroup({ layout: surfLayout, entries: [] });

  const groupsOf = (k: IntegratorKernel): GPUBindGroupLayout[] =>
    k === 'shade' || k === 'lightPower' ? [shadeG0, g1[k], surfLayout]
      : k === 'shadowTr' ? [kernels.sceneLayout, kernels.ioLayout, surfLayout] : [empty, g1[k]];

  const names = Object.keys(INTEGRATOR_KERNELS) as IntegratorKernel[];
  const modules: GPUShaderModule[] = [];
  for (const k of names) {
    const def = INTEGRATOR_KERNELS[k];
    modules.push(await compileShader(device, def.file, buildKernelSource(def.file, sources, kernels.defines)));
  }
  const pipes = await Promise.all(names.map((k, i) => {
    const def = INTEGRATOR_KERNELS[k];
    return device.createComputePipelineAsync({
      label: def.entryPoint,
      layout: device.createPipelineLayout({ label: `b5 pt ${k}`, bindGroupLayouts: groupsOf(k) }),
      compute: { module: modules[i], entryPoint: def.entryPoint, ...(def.wg ? { constants: { B5_WG_SIZE: wg } } : {}) }
    });
  }));
  const pipe = Object.fromEntries(names.map((k, i) => [k, pipes[i]])) as Record<IntegratorKernel, GPUComputePipeline>;
  const compileMs = performance.now() - t0;

  /* ── bind groups ── */
  const frameRes = { buffer: frameBuf, offset: 0, size: FRAME_BYTES };
  const bg = (label: string, layout: GPUBindGroupLayout, res: GPUBindingResource[]) => device.createBindGroup({
    label: `b5 pt ${label}`, layout, entries: res.map((resource, binding) => ({ binding, resource }))
  });
  const raysExt = { buffer: rays, offset: 0, size: capacity * RAY_BYTES };
  const raysShadow = { buffer: rays, offset: capacity * RAY_BYTES, size: capacity * RAY_BYTES };
  const sceneBg = bg('scene', kernels.sceneLayout, [{ buffer: scene.nodes }, { buffer: scene.tris }, { buffer: scene.instances }, { buffer: dbg }]);
  const shadeSceneBg = device.createBindGroup({
    label: 'b5 pt shade scene', layout: shadeG0,
    entries: [{ binding: 1, resource: { buffer: scene.tris } }, { binding: 2, resource: { buffer: scene.instances } }]
  });
  const ioCam = bg('io camera', kernels.ioLayout, [{ buffer: paramsCam }, raysExt, { buffer: hits }]);
  const ioInd = bg('io indirect', kernels.ioLayout, [{ buffer: paramsInd }, raysExt, { buffer: hits }]);
  const ioShadow = bg('io shadow', kernels.ioLayout, [{ buffer: paramsShadow }, raysShadow, { buffer: occluded }]);
  /* light data (light-data.ts layout); grown on demand, the shade bind group follows */
  let ldata = device.createBuffer({ label: 'b5 pt light data', size: 64, usage: S | BUFFER.COPY_DST });
  const shadeBg = () => bg('shade', g1.shade, [frameRes, { buffer: paths }, { buffer: hits }, { buffer: queues }, { buffer: rays }, { buffer: ldata }]);
  const B: Record<Exclude<IntegratorKernel, 'lightPower'>, GPUBindGroup> = {
    raygen: bg('raygen', g1.raygen, [frameRes, { buffer: paths }, { buffer: queues }, { buffer: rays }, { buffer: accum }, { buffer: activeBuf }]),
    shade: shadeBg(),
    shadowTr: ioShadow,
    args: bg('args', g1.args, [frameRes, { buffer: queues }, { buffer: args }]),
    shadowResolve: bg('shadow resolve', g1.shadowResolve, [frameRes, { buffer: paths }, { buffer: queues }, { buffer: occluded }]),
    accumulate: bg('accumulate', g1.accumulate, [frameRes, { buffer: paths }, { buffer: accum }, { buffer: half }, { buffer: aovAcc }]),
    resolve: bg('resolve', g1.resolve, [frameRes, { buffer: accum }, output.createView(), { buffer: aovAcc },
      aovs.albedo.createView(), aovs.normal.createView(), aovs.depth.createView()]),
    tileStats: bg('tile stats', g1.tileStats, [frameRes, { buffer: accum }, { buffer: half }, { buffer: tileStatsBuf }])
  };

  /* ── timing ── */
  const qs = useTs ? device.createQuerySet({ label: 'b5 pt timestamps', type: 'timestamp', count: 2 }) : null;
  if (qs) owned.push(qs);
  const tsResolve = useTs ? mk('ts resolve', 16, BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC) : null;
  /* staging: [0, 16) timestamps, [16, 24) ray statistics */
  const staging = mk('staging', 32, BUFFER.MAP_READ | BUFFER.COPY_DST);
  /* per-dispatch profiling (opts.profile) */
  const pqs = opts.profile && device.features.has('timestamp-query')
    ? device.createQuerySet({ label: 'b5 pt profile', type: 'timestamp', count: PROFILE_QUERIES }) : null;
  if (pqs) owned.push(pqs);
  const pResolve = pqs ? mk('profile resolve', PROFILE_QUERIES * 8, BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC) : null;
  const pStaging = pqs ? mk('profile staging', PROFILE_QUERIES * 8, BUFFER.MAP_READ | BUFFER.COPY_DST) : null;

  /* ── state ── */
  let cam: CameraBasis = cameraBasis({ pos: [0, -40, 0], quat: [0, 0, 0, 1] }, 60, width / height);
  let tubeLe: Linear3 = [0, 0, 0];
  let waveStart = 0;
  let totalPaths = 0;
  const cost = createCostModel();
  let busy = false;
  let disposed = false;
  /* emissive-triangle lights: built asynchronously after every lighting change */
  const lightMode = LIGHT_MODE[opts.lightMode ?? D.lightMode];
  let lightList: LightList | null = scene.lights ?? null;
  let lightsLive = false;
  let lightStats: LightStats | null = null;
  let lightsPending: Promise<LightStats | null> = Promise.resolve(null);
  let lightGen = 0;
  let salt = opts.salt ?? 0;
  const baseFlags = ((opts.aov ?? true) ? FRAME_FLAG_AOV : 0) | ((opts.jitter ?? true) ? FRAME_FLAG_JITTER : 0) |
    (SAMPLER_MODE[opts.sampler ?? D.sampler] === SAMPLER_MODE.sobol ? FRAME_FLAG_SOBOL : 0);
  /* adaptive sampling: active tile list (all tiles = whole-frame mapping) */
  let adaptive: AdaptiveOptions | null = null;
  let active: Uint32Array = Uint32Array.from({ length: grid.count }, (_, i) => i);
  let tilesMode = false;
  let summary: ConvergenceSummary | null = null;
  let lastStats: Float32Array | null = null;
  let stepsSinceStats = 0;
  /** path slots of the wave mapping: pixels (whole frame) or active tiles × tile² */
  const domain = () => (tilesMode ? active.length * CONVERGENCE.tile * CONVERGENCE.tile : pixels);
  const toneExp = opts.toneExposure ?? CONVERGENCE.toneExposure;
  const convEps = opts.convEpsilon ?? CONVERGENCE.epsilon;
  /** measured → calibrated tile error (Sobol half-buffer estimates are conservative) */
  const calib = opts.noiseCalibration ?? noiseCalibration(opts.sampler ?? D.sampler);

  const frameFor = (ws: number, n: number): FrameParams => ({
    camPos: cam.pos, camRight: cam.right, camUp: cam.up, camFwd: cam.fwd,
    waveStart: ws, waveSize: n, width, height, tube, tubeLe,
    maxDepth, rrDepth: opts.rrDepth ?? D.rrDepth, clampInd: opts.clampIndirect ?? D.clampIndirect,
    coneSpread: (2 * cam.tanHalf) / height, maxDim, capacity, salt,
    rayEps: opts.rayEps ?? D.rayEps, diffuseSpread: opts.diffuseSpread ?? D.diffuseSpread,
    shadowEps: opts.shadowEps ?? D.shadowEps, minAlpha: (opts.minRoughness ?? D.minRoughness) ** 2,
    tubeMode: TUBE_MODE[opts.tubeMode ?? D.tubeMode], lightMode: lightsLive ? lightMode : LIGHT_MODE.none,
    flags: baseFlags | (tilesMode ? FRAME_FLAG_TILES : 0),
    regK: opts.regularize ?? D.regularize, tilesX: grid.tilesX, activeSlots: tilesMode ? domain() : 0, toneExp, convEps
  });

  function setActive(list: Uint32Array): void {
    const all = list.length === grid.count;
    if (all && !tilesMode) return;
    const prevDomain = domain();
    active = list;
    tilesMode = !all;
    if (list.length) device.queue.writeBuffer(activeBuf, 0, list);
    if (domain() !== prevDomain) {
      waveStart = 0;
      flattenCostModel(cost); // per-region costs belonged to the previous mapping
    }
  }

  function reset(): void {
    waveStart = 0;
    totalPaths = 0;
    summary = null;
    lastStats = null;
    stepsSinceStats = 0;
    setActive(Uint32Array.from({ length: grid.count }, (_, i) => i));
    const enc = device.createCommandEncoder({ label: 'b5 pt reset' });
    enc.clearBuffer(accum);
    enc.clearBuffer(half);
    enc.clearBuffer(aovAcc);
    device.queue.submit([enc.finish()]);
  }

  function encodeTileStats(pass: GPUComputePassEncoder): void {
    pass.setPipeline(pipe.tileStats);
    pass.setBindGroup(0, emptyBg);
    pass.setBindGroup(1, B.tileStats, [0]);
    pass.dispatchWorkgroups(grid.tilesX, grid.tilesY);
  }

  async function readStats(): Promise<Float32Array> {
    await tileStaging.mapAsync(MAP.READ);
    const s = new Float32Array(tileStaging.getMappedRange().slice(0));
    tileStaging.unmap();
    return s;
  }

  function applyStats(raw: Float32Array): void {
    const stats = calibrateStats(raw, calib);
    lastStats = stats;
    if (!adaptive) return;
    /* retired tiles keep their statistics (they are no longer sampled), so a fresh
       selection keeps them retired — and brings them back if the target got stricter */
    summary = selectActiveTiles(stats, adaptive);
    setActive(summary.active);
  }

  /* Dispatch recording: one shared compute pass (normal), or one pass per
     dispatch with timestamps (opts.profile → StepResult.profile). */
  type Open = (name: string) => GPUComputePassEncoder;
  function encodeWave(open: Open, close: () => void, slot: number, n: number): void {
    const off = [slot * FRAME_SLOT];
    const [gx, gy] = dispatchSize(n, wg, maxDim);
    let pass = open('raygen');
    pass.setPipeline(pipe.raygen);
    pass.setBindGroup(0, emptyBg);
    pass.setBindGroup(1, B.raygen, off);
    pass.dispatchWorkgroups(gx, gy);
    close();
    for (let b = 0; b <= maxDepth; b++) {
      const direct = b === 0;
      pass = open('intersect');
      pass.setPipeline(kernels.pipelines.intersect);
      pass.setBindGroup(0, sceneBg);
      pass.setBindGroup(1, direct ? ioCam : ioInd);
      if (direct) pass.dispatchWorkgroups(gx, gy);
      else pass.dispatchWorkgroupsIndirect(args, ARGS_RAYS_OFFSET);
      close();

      pass = open('shade');
      pass.setPipeline(pipe.shade);
      pass.setBindGroup(0, shadeSceneBg);
      pass.setBindGroup(1, B.shade, off);
      pass.setBindGroup(2, surfBg);
      if (direct) pass.dispatchWorkgroups(gx, gy);
      else pass.dispatchWorkgroupsIndirect(args, ARGS_RAYS_OFFSET);
      close();

      if (b === maxDepth) break; // the last vertex only collects emission
      pass = open('args');
      pass.setPipeline(pipe.args);
      pass.setBindGroup(0, emptyBg);
      pass.setBindGroup(1, B.args, off);
      pass.dispatchWorkgroups(1);
      close();

      if (tube || lightsLive) {
        pass = open('shadow');
        pass.setPipeline(pipe.shadowTr);
        pass.setBindGroup(0, sceneBg);
        pass.setBindGroup(1, ioShadow);
        pass.setBindGroup(2, surfBg);
        pass.dispatchWorkgroupsIndirect(args, ARGS_SHADOW_OFFSET);
        close();

        pass = open('shadowResolve');
        pass.setPipeline(pipe.shadowResolve);
        pass.setBindGroup(0, emptyBg);
        pass.setBindGroup(1, B.shadowResolve, off);
        pass.dispatchWorkgroupsIndirect(args, ARGS_SHADOW_OFFSET);
        close();
      }
    }
    pass = open('accumulate');
    pass.setPipeline(pipe.accumulate);
    pass.setBindGroup(0, emptyBg);
    pass.setBindGroup(1, B.accumulate, off);
    pass.dispatchWorkgroups(gx, gy);
    close();
  }
  /* k_lightpower (GPU, same surface code as shading) → phi per light →
     alias table + light BVH (CPU, worker) → light data buffer */
  async function rebuildLights(list: LightList | null): Promise<LightStats | null> {
    const gen = ++lightGen;
    if (!list || list.count === 0 || lightMode === LIGHT_MODE.none || !scene.surface?.sources) {
      lightsLive = false;
      lightStats = null;
      return null;
    }
    const t0 = performance.now();
    const n = list.count;
    const rows = new ArrayBuffer(n * 48);
    const RF = new Float32Array(rows), RU = new Uint32Array(rows);
    for (let i = 0; i < n; i++) {
      for (let v = 0; v < 3; v++) RF.set(list.verts.subarray(i * 9 + v * 3, i * 9 + v * 3 + 3), i * 12 + v * 4);
      RU[i * 12 + 3] = list.inst[i];
      RU[i * 12 + 7] = list.tri[i];
    }
    const tmp: GPUBuffer[] = [];
    const tb = (size: number, usage: number) => { const b = device.createBuffer({ label: 'b5 pt light power', size: Math.max(16, size), usage }); tmp.push(b); return b; };
    const rowsBuf = tb(rows.byteLength, S | BUFFER.COPY_DST);
    const outBuf = tb(n * 4, S | BUFFER.COPY_SRC);
    const prm = tb(16, BUFFER.UNIFORM | BUFFER.COPY_DST);
    const rb = tb(n * 4, BUFFER.MAP_READ | BUFFER.COPY_DST);
    device.queue.writeBuffer(rowsBuf, 0, rows);
    device.queue.writeBuffer(prm, 0, new Uint32Array([n, 0, 0, 0]));
    const lpBg = bg('light power', g1.lightPower, [{ buffer: rowsBuf }, { buffer: outBuf }, { buffer: prm }]);
    const enc = device.createCommandEncoder({ label: 'b5 pt light power' });
    const pass = enc.beginComputePass({ label: 'b5 pt light power' });
    pass.setPipeline(pipe.lightPower);
    pass.setBindGroup(0, shadeSceneBg);
    pass.setBindGroup(1, lpBg);
    pass.setBindGroup(2, surfBg);
    const [gx, gy] = dispatchSize(n, wg, maxDim);
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, rb, 0, n * 4);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(MAP.READ);
    const phi = new Float32Array(rb.getMappedRange().slice(0, n * 4));
    rb.unmap();
    for (const b of tmp) b.destroy();
    const powerMs = performance.now() - t0;
    const packed = await packLightsAsync(list, phi, opts.lightWorker ?? true);
    if (gen !== lightGen || disposed) return lightStats; // superseded by a newer lighting
    if (packed.data.byteLength > ldata.size) {
      ldata.destroy();
      ldata = device.createBuffer({ label: 'b5 pt light data', size: Math.ceil(packed.data.byteLength / 256) * 256, usage: S | BUFFER.COPY_DST });
      B.shade = shadeBg();
    }
    device.queue.writeBuffer(ldata, 0, packed.data);
    lightsLive = packed.active > 0;
    lightStats = {
      lights: n, active: packed.active, nodes: packed.nNodes, totalPhi: packed.totalPhi,
      powerMs, buildMs: packed.buildMs, phi, packed
    };
    return lightStats;
  }

  async function step(budgetMs: number): Promise<StepResult> {
    if (disposed) throw new Error('integrator disposed');
    if (busy) throw new Error('integrator.step() is already running (await the previous step)');
    busy = true;
    try {
      await lightsPending;
      const dom = domain();
      if (dom === 0) {
        /* adaptive: every tile converged or capped */
        return {
          spp: totalPaths / pixels, ms: 0, timer: 'wall-clock', paths: 0, waves: 0, rays: 0, shadowRays: 0, mraysPerSec: 0,
          convergence: summary, done: true
        };
      }
      const budget = Math.max(1, Math.min(budgetMs, maxSubmitMs)) * D.budgetSafety;
      /* waves sized by the per-region cost model (a wave entering an expensive part of the image must not blow the budget) */
      const waves = planWavesByCost(cost, waveStart, budget, capacity, dom, Math.max(1, Math.round(dom * D.firstStepFraction)));
      const runStats = adaptive !== null && ++stepsSinceStats >= CONVERGENCE.statsEverySteps;
      const frames = new ArrayBuffer(FRAME_SLOT * waves.length);
      let ws = waveStart;
      waves.forEach((n, i) => { writeFrame(frames, i * FRAME_SLOT, frameFor(ws, n)); ws += n; });
      device.queue.writeBuffer(frameBuf, 0, frames);
      device.queue.writeBuffer(queues, Q.rays * 4, new Uint32Array(2));

      const enc = device.createCommandEncoder({ label: 'b5 pt step' });
      let pass: GPUComputePassEncoder;
      const names: string[] = [];
      if (pqs) {
        /* profile: one timed pass per dispatch */
        let cur: GPUComputePassEncoder | null = null;
        const open = (name: string) => {
          const k = names.length;
          names.push(name);
          if (2 * k + 1 >= PROFILE_QUERIES) throw new Error('profile: too many dispatches in one step');
          cur = enc.beginComputePass({ label: name, timestampWrites: { querySet: pqs, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } });
          return cur;
        };
        waves.forEach((n, i) => encodeWave(open, () => cur!.end(), i, n));
        pass = open('resolve');
      } else {
        pass = enc.beginComputePass({
          label: 'b5 pt waves',
          ...(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {})
        });
        const p = pass;
        waves.forEach((n, i) => encodeWave(() => p, () => {}, i, n));
      }
      pass.setPipeline(pipe.resolve);
      pass.setBindGroup(0, emptyBg);
      pass.setBindGroup(1, B.resolve, [0]);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      if (runStats) encodeTileStats(pass);
      pass.end();
      if (runStats) enc.copyBufferToBuffer(tileStatsBuf, 0, tileStaging, 0, tileStaging.size);
      if (pqs && pResolve && pStaging) {
        enc.resolveQuerySet(pqs, 0, 2 * names.length, pResolve, 0);
        enc.copyBufferToBuffer(pResolve, 0, pStaging, 0, 16 * names.length);
      }
      if (qs && tsResolve) {
        enc.resolveQuerySet(qs, 0, 2, tsResolve, 0);
        enc.copyBufferToBuffer(tsResolve, 0, staging, 0, 16);
      }
      enc.copyBufferToBuffer(queues, Q.rays * 4, staging, 16, 8);
      const tw = performance.now();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      const wallMs = performance.now() - tw;
      await staging.mapAsync(MAP.READ);
      const raw = staging.getMappedRange().slice(0);
      staging.unmap();
      const stats = new Uint32Array(raw, 16, 2);
      let ms = wallMs;
      let timer: StepResult['timer'] = 'wall-clock';
      if (qs) {
        const t = new BigUint64Array(raw, 0, 2);
        const gpu = Number(t[1] - t[0]) / 1e6;
        if (gpu > 0 && gpu < 60_000) { ms = gpu; timer = 'timestamp-query'; }
      }
      const paths = waves.reduce((a, n) => a + n, 0);
      totalPaths += tilesMode ? validSlots(active, waveStart, paths, width, height) : paths;
      updateCostModel(cost, waveStart, waves, ms, dom, D.costEma);
      waveStart = ws % dom;
      if (runStats) {
        stepsSinceStats = 0;
        applyStats(await readStats());
      }
      const rays = stats[0], shadowRays = stats[1];
      let profile: Record<string, number> | undefined;
      if (pqs && pStaging) {
        await pStaging.mapAsync(MAP.READ, 0, 16 * names.length);
        const t = new BigUint64Array(pStaging.getMappedRange(0, 16 * names.length).slice(0));
        pStaging.unmap();
        profile = {};
        names.forEach((nm, k) => { profile![nm] = (profile![nm] ?? 0) + Number(t[2 * k + 1] - t[2 * k]) / 1e6; });
        ms = Object.values(profile).reduce((a, b) => a + b, 0);
        timer = 'timestamp-query';
      }
      return {
        spp: totalPaths / pixels, ms, timer, paths, waves: waves.length,
        rays, shadowRays, mraysPerSec: (rays + shadowRays) / (ms * 1e3), profile,
        convergence: runStats ? summary : null, done: domain() === 0
      };
    } finally {
      busy = false;
    }
  }

  async function readAccumulation(): Promise<Float32Array> {
    const size = pixels * 16;
    const rb = device.createBuffer({ size, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(accum, 0, rb, 0, size);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(MAP.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    rb.destroy();
    return out;
  }

  async function readBuffer(buf: GPUBuffer): Promise<Float32Array> {
    const rb = device.createBuffer({ size: buf.size, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, rb, 0, buf.size);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(MAP.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    rb.destroy();
    return out;
  }

  async function measure(a?: AdaptiveOptions): Promise<ConvergenceSummary> {
    if (busy) throw new Error('integrator.measure() during step(): await the step first');
    const enc = device.createCommandEncoder({ label: 'b5 pt tile stats' });
    /* the frame uniform of slot 0 must exist: write one for an empty wave */
    const fr = new ArrayBuffer(FRAME_SLOT);
    writeFrame(fr, 0, frameFor(0, 0));
    device.queue.writeBuffer(frameBuf, 0, fr);
    const pass = enc.beginComputePass({ label: 'b5 pt tile stats' });
    encodeTileStats(pass);
    pass.end();
    enc.copyBufferToBuffer(tileStatsBuf, 0, tileStaging, 0, tileStaging.size);
    device.queue.submit([enc.finish()]);
    const stats = calibrateStats(await readStats(), calib);
    lastStats = stats;
    const o = a ?? adaptive ?? { target: CONVERGENCE.defaultNoise / 100, capSpp: Infinity };
    return selectActiveTiles(stats, o);
  }

  reset();
  return {
    width, height, capacity, output, aovs, compileMs,
    buffers: { accum, half, aov: aovAcc },
    tiles: grid,
    get spp() { return totalPaths / pixels; },
    get tileStats() { return lastStats; },
    get adaptive() { return adaptive; },
    get convergence() { return summary; },
    setAdaptive(a) {
      adaptive = a ? { ...a } : null;
      if (!adaptive) setActive(Uint32Array.from({ length: grid.count }, (_, i) => i));
      else if (lastStats) applyStats(lastStats);
    },
    measure,
    readHalf: () => readBuffer(half),
    setCamera(pose, fovY, aspect) {
      cam = cameraBasis(pose, fovY, aspect);
      cost.cost.fill(0); // per-region costs belong to the view
      reset();
    },
    setTubeRadiance(Le) {
      tubeLe = [Le[0], Le[1], Le[2]];
      reset();
    },
    setLighting(state) {
      tubeLe = tube ? tubeRadiance(state) : [0, 0, 0];
      scene.setLighting?.(state);
      reset();
      lightsPending = rebuildLights(lightList);
    },
    reset,
    setSalt(s) {
      salt = s >>> 0;
      reset();
    },
    step,
    readAccumulation,
    lightsReady: () => lightsPending,
    updateLights(list) {
      if (list !== undefined) lightList = list;
      lightsPending = rebuildLights(lightList).then((s) => { reset(); return s; });
      return lightsPending;
    },
    dispose() {
      disposed = true;
      ldata.destroy();
      for (const o of owned) if (o !== output || !opts.output) o.destroy();
    }
  };
}

/** Wave size the integrator would use (exported for tests / HUD). */
export function waveLimit(width: number, height: number, maxPaths: number = INTEGRATOR_DEFAULTS.maxPaths): number {
  return Math.min(pathCapacity(width * height, maxPaths), width * height);
}
